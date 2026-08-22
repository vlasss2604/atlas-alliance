import { sql } from "drizzle-orm";
import {
  boolean,
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

import { componentReconciliationStatus, researchAttemptStatus } from "./enums";
import { researchJobs } from "./research";

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
