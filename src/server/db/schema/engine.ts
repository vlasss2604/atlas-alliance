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
