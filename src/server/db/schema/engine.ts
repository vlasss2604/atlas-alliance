import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { MechanismFlow, MechanismGap } from "../../engine/mechanism-assembler";
import type { ClaimReasonCode, ClaimRequirementResult, MechanismGapRef } from "../../engine/claim-evaluator";

import {
  componentReconciliationStatus,
  onchainArtifactOrigin,
  onchainDerivationMethod,
  onchainDerivedSubjectKind,
  researchAttemptStatus,
  traceBudgetAxis,
  traceOperationType,
  traceProviderKind,
  traceReasonCode,
  traceStatus,
} from "./enums";
import { researchJobs } from "./research";
import { evidence, sources } from "./proof";

// Фаза 6, S3 (phase-6-plan.md §19 S3, §6.3 item 5) — сырой журнал попыток
// исполнения контроллера: персист для idempotent-enough семантики и
// resume после рестарта воркера. НЕ Evidence (то — наблюдение о мире) и
// НЕ research_component_results (то — сопоставление, S5): это лог
// "что контроллер уже пытался сделать по этому (job, step, component)".
export const researchAttempts = pgTable(
  "research_attempts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    patternStep: smallint("pattern_step").notNull(),
    component: text("component").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: researchAttemptStatus("status").notNull().default("STARTED"),
    // Детерминированная причина остановки/пропуска этой попытки —
    // человекочитаемая строка кода (D-070), не свободный текст модели.
    reason: text("reason"),
    // Фаза 6, S4 (§13) — сколько этой ОДНОЙ попытки стоило по каждому
    // измерению бюджета job'а. Контроллер клэмпит то, что вернул executor,
    // к оставшейся ёмкости ПЕРЕД записью сюда (executor не может поднять
    // потолок, отчитавшись о большем) — см. controller.ts. Job-lifetime
    // расход — это SUM этих колонок по всем строкам job'а, тот же паттерн,
    // что recoveryAttemptsUsedLifetime (HIGH-1/R-1), не второй бюджет.
    searchQueriesSpent: integer("search_queries_spent").notNull().default(0),
    sourceOpensSpent: integer("source_opens_spent").notNull().default(0),
    modelCostMicroSpent: integer("model_cost_micro_spent").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // Идемпотентность: одна и та же (job, step, component, попытка №N) не
    // может быть заведена дважды — повторная доставка задачи контроллера
    // не плодит дублирующиеся попытки.
    uniqueIndex("uq_research_attempts_job_step_component_attempt").on(
      t.researchJobId,
      t.patternStep,
      t.component,
      t.attemptNumber,
    ),
    index("ix_research_attempts_job").on(t.researchJobId),
  ],
);

// Phase 6, S5 (phase-6-s5-plan.md §11.3, §17, D-092..D-096) — a DERIVED
// PROJECTION of `evidence`, never a second source of truth: deleting every
// row here and re-running reconciliation from the same (job, Pattern,
// Evidence) is required to reproduce byte-for-byte the same result
// (§11.3). Persisted so S6 can consume it without recomputing, and so
// audit can answer "which Evidence gave this state" — `evidence` remains
// the actual truth.
export const researchComponentResults = pgTable(
  "research_component_results",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    patternStep: smallint("pattern_step").notNull(),
    component: text("component").notNull(),
    status: componentReconciliationStatus("status").notNull(),
    // §10 closed dictionary — always a subset of ResultReasonCode; never a
    // raw/free string (item 13's discipline, reapplied here).
    reasonCodes: jsonb("reason_codes").notNull().default(sql`'[]'::jsonb`),
    supportingEvidenceIds: jsonb("supporting_evidence_ids").notNull().default(sql`'[]'::jsonb`),
    contradictingEvidenceIds: jsonb("contradicting_evidence_ids").notNull().default(sql`'[]'::jsonb`),
    // { evidenceId, reason }[] — §10 closed ExclusionReason dictionary.
    excludedEvidence: jsonb("excluded_evidence").notNull().default(sql`'[]'::jsonb`),
    // Normalized CORE CHECK 2 state (+ PAUSED), never the model's raw
    // string — §6.1.
    currentState: text("current_state"),
    temporalBasisField: text("temporal_basis_field"),
    temporalBasisAt: timestamp("temporal_basis_at", { withTimezone: true }),
    tokenStateMentions: jsonb("token_state_mentions").notNull().default(sql`'[]'::jsonb`),
    requiresFreshEvidence: boolean("requires_fresh_evidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // §11.3 — "one semantic row per (job, step, component)"; the upsert
    // target that makes replay idempotent rather than accumulating rows.
    uniqueIndex("uq_research_component_results_job_step_component").on(
      t.researchJobId,
      t.patternStep,
      t.component,
    ),
    index("ix_research_component_results_job").on(t.researchJobId),
  ],
);

// Phase 6, S6 (phase-6-s6-plan.md §20, D-103) — a DERIVED PROJECTION,
// same discipline as research_component_results above: deleting every row
// here and re-running assembleMechanism() from the same (Pattern,
// research_component_results, admitted Evidence) is required to reproduce
// a semantically identical result. Truth stays in research_component_results
// and evidence; this table exists so S7 (and audit) can read the assembled
// mechanism without recomputing it, and so a crash between S6 and S7 never
// requires re-running S4/S5 work.
//
// flows/unassignedGaps are jsonb, not relational columns (§20 п.4): no
// caller queries into nodes/edges/gaps individually — the one consumer
// reads the assembly whole — so a second family of tables would be
// unused normalization, not safety.
export const researchMechanismAssembly = pgTable(
  "research_mechanism_assembly",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    patternVersion: integer("pattern_version").notNull(),
    flows: jsonb("flows").notNull().$type<MechanismFlow[]>(),
    unassignedGaps: jsonb("unassigned_gaps").notNull().$type<MechanismGap[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // §20 — "one assembly per job and Pattern version"; the upsert target
    // that keeps replay idempotent rather than accumulating rows.
    uniqueIndex("uq_research_mechanism_assembly_job_pattern_version").on(
      t.researchJobId,
      t.patternVersion,
    ),
    index("ix_research_mechanism_assembly_job").on(t.researchJobId),
  ],
);

// Phase 6, S7 (phase-6-s7-plan.md §24, D-111) — a DERIVED PROJECTION,
// same discipline as research_component_results / research_mechanism_assembly:
// deleting every row here and re-running evaluateClaimSupport() from the
// same (IntentRequirementSet, MechanismAssemblyResult) is required to
// reproduce a semantically identical result. Truth stays in Pattern's
// intentRequirements CORE data and research_mechanism_assembly; this
// table exists so a claim-support read never needs to recompute it.
//
// requirement_set_version is part of the key (not just job+patternVersion)
// because a human can edit CORE intentRequirements without touching
// patternVersion (§24) — without this, an edited requirement set would
// silently keep serving the old projection as if it were current.
export const researchClaimSupport = pgTable(
  "research_claim_support",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    patternVersion: integer("pattern_version").notNull(),
    requirementSetVersion: integer("requirement_set_version").notNull(),
    intent: text("intent").notNull(),
    status: text("status").notNull(),
    reasonCodes: jsonb("reason_codes").notNull().$type<ClaimReasonCode[]>(),
    requirementResults: jsonb("requirement_results").notNull().$type<ClaimRequirementResult[]>(),
    contextGaps: jsonb("context_gaps").notNull().$type<MechanismGapRef[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // §24 — "one claim-support projection per job, Pattern version, and
    // requirement-set version"; the upsert target that keeps replay
    // idempotent rather than accumulating rows.
    uniqueIndex("uq_research_claim_support_job_pattern_reqset").on(
      t.researchJobId,
      t.patternVersion,
      t.requirementSetVersion,
    ),
    index("ix_research_claim_support_job").on(t.researchJobId),
  ],
);

// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) —
// append-only OPERATIONAL trace, never Evidence and never read by
// component-reconciliation-store/S5/S6/S7 (§H, TRACE ≠ EVIDENCE: no
// store in this codebase selects from this table except the read-only
// alpha-inspect script). Records "what S4 did" (a query was proposed, a
// search executed, a candidate deduped, a fetch failed, a fact rejected
// as the wrong component) — never "what is true about the project".
// Code discipline (not a DB trigger): this table is only ever INSERTed
// into, never UPDATEd or DELETEd — see trace-store.ts.
//
// source_id/evidence_id are plain nullable uuid columns, deliberately
// WITHOUT a foreign key — a trace event may reference the resulting
// source/evidence row for audit convenience (alpha-inspect linking), but
// this table must never become something S5/S6/S7 need to join against,
// and no FK is needed for that: the link is one-directional and
// best-effort, not a referential-integrity requirement.
export const researchTraceEvents = pgTable(
  "research_trace_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    researchAttemptId: uuid("research_attempt_id").references(() => researchAttempts.id, { onDelete: "set null" }),
    // Deterministic, gap-free ordering within one job — allocated
    // atomically via a job-row lock (trace-store.ts), the same discipline
    // controller.ts's claimAttempt already uses for research_attempts.
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    operationType: traceOperationType("operation_type").notNull(),
    providerKind: traceProviderKind("provider_kind"),
    // A bounded, human-identifiable provider label (e.g. a real
    // provider.name, or the explicit "non-live-fixture" identity) — never
    // a credential-bearing string (§C/§M).
    providerName: text("provider_name"),
    patternStep: smallint("pattern_step"),
    component: text("component"),
    // Bounded target reference (a query string or a URL) — Internal
    // Alpha explicitly allows this (§M); never a raw document body, raw
    // provider response, model chain-of-thought, or secret.
    targetRef: text("target_ref"),
    status: traceStatus("status").notNull(),
    // Closed vocabulary only (§A/§M) — never a raw exception/provider
    // message. "NONE" (not null) makes "no reason" and "reason omitted by
    // mistake" the same explicit, intentional value.
    reasonCode: traceReasonCode("reason_code").notNull().default("NONE"),
    sourceId: uuid("source_id"),
    evidenceId: uuid("evidence_id"),
    budgetAxis: traceBudgetAxis("budget_axis"),
    budgetAmount: integer("budget_amount"),
    // S10 (live-provider-enablement.md §7) — AUDIT ONLY, never a second
    // budget authority: the reservation counters on research_jobs remain
    // the sole execution ceiling (§7 of the S10 spec, explicit owner
    // instruction). Populated only for a live model call that actually
    // returned usage; null for every non-live/fixture/failed call.
    // Computed with the SAME approved role-specific ModelCostProfile
    // used to size the reservation — never a dynamic pricing lookup.
    // D-143 — CATEGORICAL FAILURE DIAGNOSTIC, audit only.
    //
    // reason_code answers "what kind of thing went wrong" in the closed
    // vocabulary the whole engine shares; PROVIDER_ERROR is deliberately
    // its single catch-all for "the provider call itself failed", and it
    // stays exactly that. This column answers the narrower question the
    // catch-all cannot: WHICH code-owned failure the provider classified.
    //
    // Written ONLY from a provider's own closed reason set (today:
    // CONTENT_FETCH_FAILURE_REASONS). Never a raw exception message,
    // never a stack, never a hostname, an IP, a DNS answer or any other
    // provider string — a real fetch failure carrying "read ECONNRESET"
    // records NETWORK_ERROR here and nothing else. The two-gate discipline
    // that guards every other sanitized field applies: the error class
    // vouches for the field existing, membership in the closed set
    // vouches for the value.
    //
    // Nullable and additive: every historical row keeps NULL, which reads
    // correctly as "this failure predates the diagnostic" rather than as
    // an absent failure. Never populated on a success row.
    diagnosticCode: text("diagnostic_code"),
    actualInputTokens: integer("actual_input_tokens"),
    actualOutputTokens: integer("actual_output_tokens"),
    actualCostMicro: integer("actual_cost_micro"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_research_trace_events_job_sequence").on(t.researchJobId, t.sequence),
    index("ix_research_trace_events_job").on(t.researchJobId),
    index("ix_research_trace_events_attempt").on(t.researchAttemptId),
    // §M — bounded target_ref: a generous but finite cap, defense in
    // depth against ever storing an unbounded document/response body.
    check("ck_research_trace_events_target_ref_len", sql`char_length(${t.targetRef}) <= 2048`),
  ],
);

// Structured on-chain retrieval artifacts (owner-approved V1, AMENDMENT B).
//
// WHY A SEPARATE TABLE, and why it does not hang off `sources`:
//
// `sources` is a GLOBAL row keyed by url_hash and reused across jobs and
// projects (see findOrCreateSource). A structured on-chain observation is
// the opposite: the canonical URI is stable ("total supply of this mint"),
// but every retrieval of it is a DIFFERENT point-in-time fact — different
// slot, different value, different response hash. Attaching provenance to
// the shared source row would either overwrite one job's observation with
// another's or make the row mean two things at once.
//
// The relationship the amendment asks for is therefore:
//
//   sources (canonical URI identity, shared)
//     -> onchain_artifacts (ONE row per retrieval, owns all provenance)
//        -> evidence.onchain_artifact_id (MANY deterministic facts)
//
// One retrieval is stored once; several facts (e.g. two burn instructions
// inside one transaction) reference it without duplicating provenance;
// and everything needed for later re-verification survives on the artifact
// rather than being smeared across evidence rows.
//
// Existing Evidence semantics are untouched: the only change to `evidence`
// is one NULLABLE foreign key, which no existing constraint reads.
export const onchainArtifacts = pgTable(
  "onchain_artifacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Which of the two provenance modes this row is in. Defaulting to
    // RESEARCH_JOB is the fail-closed choice: a writer that omits the
    // mode gets the one that REQUIRES a job and a source, so an omission
    // fails loudly rather than silently creating an unattached row.
    originKind: onchainArtifactOrigin("origin_kind").notNull().default("RESEARCH_JOB"),
    // Nullable ONLY for a standalone structured observation, and in that
    // mode it must be null — see ckOnchainArtifactsOrigin below. The two
    // modes are mutually exclusive, not a spectrum.
    researchJobId: uuid("research_job_id").references(() => researchJobs.id, {
      onDelete: "cascade",
    }),
    // The canonical URI's shared identity row. Same rule: present for a
    // job artifact, absent for a standalone one. A standalone read has no
    // document to point at, and inventing a sources row to say otherwise
    // is the lie this mode exists to avoid.
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "restrict" }),
    canonicalUri: text("canonical_uri").notNull(),
    // --- identity / subject (AMENDMENT C: anchor and subject stay distinct)
    chain: text("chain").notNull(),
    network: text("network").notNull(),
    projectAnchor: text("project_anchor").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subject: text("subject").notNull(),
    intentKind: text("intent_kind").notNull(),
    // --- chain position
    slot: bigint("slot", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }),
    blockHash: text("block_hash"),
    finality: text("finality").notNull(),
    transactionSignature: text("transaction_signature"),
    // --- retrieval
    retrievalMethod: text("retrieval_method").notNull(),
    providerId: text("provider_id").notNull(),
    providerMethod: text("provider_method").notNull(),
    // Addresses and bounded limits only — never a credential, never a URL.
    requestParams: jsonb("request_params").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    // --- integrity
    rawResponseHash: text("raw_response_hash").notNull(),
    artifactHash: text("artifact_hash").notNull(),
    // The canonical normalized result the facts quote from.
    normalizedResult: jsonb("normalized_result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_onchain_artifacts_job").on(t.researchJobId),
    index("ix_onchain_artifacts_uri").on(t.canonicalUri),
    // AN OBSERVATION IS NOT THE SAME THING AS ITS NORMALIZED VALUE.
    //
    // Identity used to be the content address alone, and that silently
    // collapsed two genuinely different chain observations whenever they
    // happened to report equal values:
    //
    //   slot 100: supply 1,000
    //   slot 200: supply 1,000        <- dropped, as if it never happened
    //
    // "Supply did not move between these two positions" is a finding, and
    // the record could not hold it. The defect is NOT specific to supply:
    // `artifact_hash` is sha256 of the NORMALIZED RESULT, and for the four
    // intent kinds whose slot arrives in the RPC context rather than in the
    // result body — TOKEN_SUPPLY, ACCOUNT_INFO, TOKEN_ACCOUNT_BALANCE and
    // TOKEN_ACCOUNTS_BY_OWNER — an unchanged reading at a later slot hashes
    // identically. SIGNATURES_FOR_ADDRESS and TRANSACTION_DETAIL carry their
    // slot inside the result, so they were never affected and are unchanged
    // by adding it here.
    //
    // Identity is therefore WHAT CAME BACK plus WHERE ON THE CHAIN it was
    // read: (artifact_hash, slot), scoped by origin mode. `artifact_hash`
    // keeps its existing and separate meaning — a content address of the
    // normalized result — and is not redefined to smuggle position into it.
    //
    // An exact retry stays idempotent: the same reading at the same slot is
    // the same observation however many times it is fetched, which is why
    // retrieved_at is deliberately NOT part of identity. A retry a second
    // later is not a new observation.
    uniqueIndex("uq_onchain_artifacts_job_observation").on(
      t.researchJobId,
      t.artifactHash,
      t.slot,
    ),
    // Postgres treats NULLs as distinct, so the index above constrains
    // nothing once the job id is null. The standalone mode needs the same
    // identity for the same reason — an owner-script re-observation at a
    // later slot is a second observation, not a repeat of the first.
    uniqueIndex("uq_onchain_artifacts_standalone_observation")
      .on(t.artifactHash, t.slot)
      .where(sql`${t.researchJobId} IS NULL`),
    // Every invalid combination of mode and links is unrepresentable,
    // rather than merely discouraged.
    check(
      "ck_onchain_artifacts_origin",
      sql`(${t.originKind} = 'RESEARCH_JOB' AND ${t.researchJobId} IS NOT NULL AND ${t.sourceId} IS NOT NULL)
        OR (${t.originKind} = 'STANDALONE_STRUCTURED_OBSERVATION' AND ${t.researchJobId} IS NULL AND ${t.sourceId} IS NULL)`,
    ),
    // ABSENCE OF A JOB IS NEVER ABSENCE OF PROVENANCE. Required of every
    // artifact in both modes — what an artifact has always had to carry,
    // now an invariant instead of a convention.
    check(
      "ck_onchain_artifacts_provenance_complete",
      sql`length(${t.canonicalUri}) > 0 AND length(${t.chain}) > 0 AND length(${t.network}) > 0
        AND length(${t.projectAnchor}) > 0 AND length(${t.subject}) > 0 AND length(${t.subjectKind}) > 0
        AND length(${t.intentKind}) > 0 AND length(${t.retrievalMethod}) > 0
        AND length(${t.providerId}) > 0 AND length(${t.providerMethod}) > 0
        AND length(${t.finality}) > 0 AND length(${t.rawResponseHash}) > 0
        AND length(${t.artifactHash}) > 0 AND ${t.slot} >= 0`,
    ),
  ],
);

// DERIVED ON-CHAIN SUBJECTS — technical provenance, never authority.
//
// A token account returned by getTokenAccountsByOwner is not stated by
// any document, so it can never be a documentary locator. It is also
// not arbitrary: a confirmed structured read bound its identity —
// parsed owner == the documented wallet, parsed mint == the confirmed
// project mint, program owner == an SPL Token program.
//
// A row here answers exactly one question: "why is this exact subject
// eligible for the next structured read?" It grants no source class, no
// officiality, no documentary authority and no economic role. That the
// account is called a burn address by a page is a DIFFERENT record with
// a different provenance, and the two must never be merged.
//
// Both lineage links — parent_subject and onchain_artifact_id — are
// re-validated when the gate reads this row, not trusted because the row
// exists. If the parent's documentary evidence goes away, the derived
// subject stops being eligible on the next read.
export const onchainDerivedSubjects = pgTable(
  "onchain_derived_subjects",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    onchainArtifactId: uuid("onchain_artifact_id")
      .notNull()
      .references(() => onchainArtifacts.id, { onDelete: "cascade" }),
    chain: text("chain").notNull(),
    network: text("network").notNull(),
    projectAnchor: text("project_anchor").notNull(),
    subject: text("subject").notNull(),
    subjectKind: onchainDerivedSubjectKind("subject_kind").notNull(),
    // The subject whose query returned this one.
    parentSubject: text("parent_subject").notNull(),
    derivationMethod: onchainDerivationMethod("derivation_method").notNull(),
    bindingStatus: text("binding_status").notNull(),
    observedSlot: bigint("observed_slot", { mode: "number" }).notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_onchain_derived_subject").on(t.subject),
    index("ix_onchain_derived_anchor_subject").on(t.projectAnchor, t.subject),
    index("ix_onchain_derived_parent").on(t.parentSubject),
    uniqueIndex("uq_onchain_derived_artifact_subject").on(t.onchainArtifactId, t.subject),
    // An unverified derived subject is not a weaker row — it is not a row.
    check("ck_onchain_derived_binding", sql`${t.bindingStatus} = 'CONFIRMED'`),
    check(
      "ck_onchain_derived_subject_shape",
      sql`${t.subject} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`,
    ),
    check(
      "ck_onchain_derived_parent_shape",
      sql`${t.parentSubject} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`,
    ),
    check(
      "ck_onchain_derived_anchor_shape",
      sql`${t.projectAnchor} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`,
    ),
    // A subject derived from itself is a loop, not a lineage.
    check("ck_onchain_derived_not_self", sql`${t.subject} <> ${t.parentSubject}`),
  ],
);

// OBSERVED TRANSACTION SIGNATURES — technical provenance, never execution.
//
// A signature returned by getSignaturesForAddress is not documentary
// evidence and must never be recorded as one. It is also not arbitrary: a
// confirmed structured read returned it for a subject that itself had
// provenance. Same shape as onchain_derived_subjects, same reason.
//
// It answers ONE question — why is this exact signature eligible for
// getTransaction — and confers nothing else. Being listed for an address
// does not say what the transaction did, which tokens moved, in which
// direction, or whether anything was burned. `err` is the RPC's own
// metadata; `memo` is SELECTION metadata, arbitrary text written by
// whoever signed, useful for choosing what to read and never proof of
// what executed.
export const onchainObservedSignatures = pgTable(
  "onchain_observed_signatures",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    onchainArtifactId: uuid("onchain_artifact_id")
      .notNull()
      .references(() => onchainArtifacts.id, { onDelete: "cascade" }),
    chain: text("chain").notNull(),
    network: text("network").notNull(),
    projectAnchor: text("project_anchor").notNull(),
    // The address whose signatures were requested.
    parentSubject: text("parent_subject").notNull(),
    signature: text("signature").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }),
    err: boolean("err").notNull(),
    memo: text("memo"),
    bindingStatus: text("binding_status").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_onchain_observed_sig_signature").on(t.signature),
    index("ix_onchain_observed_sig_anchor").on(t.projectAnchor, t.signature),
    index("ix_onchain_observed_sig_parent").on(t.parentSubject),
    uniqueIndex("uq_onchain_observed_sig_artifact_signature").on(t.onchainArtifactId, t.signature),
    check("ck_onchain_observed_sig_binding", sql`${t.bindingStatus} = 'CONFIRMED'`),
    // A complete base58 signature. A truncated display form is
    // unrepresentable at rest — the same discipline documentary locators use.
    check(
      "ck_onchain_observed_sig_shape",
      sql`${t.signature} ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'`,
    ),
    check(
      "ck_onchain_observed_sig_parent_shape",
      sql`${t.parentSubject} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`,
    ),
    check(
      "ck_onchain_observed_sig_anchor_shape",
      sql`${t.projectAnchor} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`,
    ),
  ],
);

// TWO-ENDPOINT PROVENANCE FOR A DERIVED INTERVAL FACT.
//
// THE SHAPE EVERY OTHER ON-CHAIN FACT HAS, AND WHY THIS ONE CANNOT.
// `evidence.onchain_artifact_id` records that a fact was derived from ONE
// artifact, and its own comment states the relation it was built for: many
// facts may reference one artifact. A TOTAL_SUPPLY_DELTA inverts that. It is
// established by a historical reading, a current reading and arithmetic, and
// by neither reading alone — so the singular pointer has no honest value and
// is left NULL for such a row.
//
// ESTABLISHING INPUTS ONLY, AND THE NAME SAYS SO. These are the operands of
// the arithmetic: FROM is t0, TO is t1, and the delta is true from those two
// alone. A burn whose slot lies inside the interval is NOT here — it did not
// establish the number, it only makes the interval interesting — and a table
// called "supporting artifacts" would eventually collect exactly that kind of
// contextual, causal-looking row. Whether a burn lies inside a delta's
// interval is a separate deterministic question, asked later, over two
// independent Evidence rows.
//
// The pair is structurally exactly two: the CHECK pins ordinal 0 to FROM and
// ordinal 1 to TO, and the two unique indexes forbid a second of either. A
// three-input derivation is not "unexpected" here, it is unrepresentable.
export const evidenceOnchainArtifactInputs = pgTable(
  "evidence_onchain_artifact_inputs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // CASCADE, matching evidenceDocumentaryLocators: an input has no meaning
    // without the fact it established, and it is not independent evidence.
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    ordinal: smallint("ordinal").notNull(),
    inputRole: text("input_role").notNull(),
    // RESTRICT, deliberately unlike evidence.onchain_artifact_id's SET NULL:
    // a delta whose endpoint observation was removed is not a fact that
    // should quietly lose a pointer, it is a fact that is no longer
    // established. The database refuses the deletion instead.
    onchainArtifactId: uuid("onchain_artifact_id")
      .notNull()
      .references(() => onchainArtifacts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_evidence_onchain_inputs_evidence").on(t.evidenceId),
    // So a future audit can ask from either end: which delta rests on this
    // observation, as well as which observations this delta rests on.
    index("ix_evidence_onchain_inputs_artifact").on(t.onchainArtifactId),
    uniqueIndex("uq_evidence_onchain_inputs_role").on(t.evidenceId, t.inputRole),
    uniqueIndex("uq_evidence_onchain_inputs_ordinal").on(t.evidenceId, t.ordinal),
    check(
      "ck_evidence_onchain_inputs_role",
      sql`(${t.ordinal} = 0 AND ${t.inputRole} = 'FROM') OR (${t.ordinal} = 1 AND ${t.inputRole} = 'TO')`,
    ),
  ],
);
