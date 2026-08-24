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
  researchAttemptStatus,
  traceBudgetAxis,
  traceOperationType,
  traceProviderKind,
  traceReasonCode,
  traceStatus,
} from "./enums";
import { researchJobs } from "./research";
import { sources } from "./proof";

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
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    // The canonical URI's shared identity row.
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
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
    // Replaying the identical observation within one job is a no-op rather
    // than a duplicate row — same discipline as evidence.extraction_unit_key.
    uniqueIndex("uq_onchain_artifacts_job_artifact").on(t.researchJobId, t.artifactHash),
  ],
);
