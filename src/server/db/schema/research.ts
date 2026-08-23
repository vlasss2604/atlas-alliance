import { sql } from "drizzle-orm";
import {
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { projects, topics } from "./catalog";
import {
  entitlementLevel,
  interpreterStatus,
  memoryStatus,
  quotaReservationState,
  researchCapability,
  researchJobState,
} from "./enums";
import { users } from "./identity";

// ACTIVE_STATES = QUEUED, RUNNING, AWAITING_CLARIFICATION (phase-1-plan §4.3).
// Используется всеми инвариантами ниже; менять только вместе с планом.
export const ACTIVE_JOB_STATES = [
  "QUEUED",
  "RUNNING",
  "AWAITING_CLARIFICATION",
] as const;

const ACTIVE_STATES_SQL = sql`state IN ('QUEUED', 'RUNNING', 'AWAITING_CLARIFICATION')`;

export const researchJobs = pgTable(
  "research_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "restrict" }),
    state: researchJobState("state").notNull().default("QUEUED"),
    // 5 UI-стадий из LOCKED §9; внутренние подэтапы — журнал переходов.
    progressStage: smallint("progress_stage").notNull().default(1),
    memoryStatus: memoryStatus("memory_status").notNull().default("NOT_USED"),
    originalQuestion: text("original_question").notNull(),
    normalizedTask: jsonb("normalized_task"),
    normalizedTaskHash: text("normalized_task_hash").notNull(),
    // Снапшот entitlement в момент старта (B1): job доводится до конца,
    // даже если подписка истекла через минуту после запуска.
    entitlementAtStart: entitlementLevel("entitlement_at_start").notNull(),
    capabilityAtStart: researchCapability("capability_at_start").notNull(),
    budgetAtStart: jsonb("budget_at_start").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    clarificationAttempts: smallint("clarification_attempts")
      .notNull()
      .default(0),
    unread: boolean("unread").notNull().default(false),
    errorCode: text("error_code"),
    // First Real Run, Stage 1 (pipeline-integration-stage.md, D-113) —
    // WHY execution stopped, kept structurally separate from `state`
    // (execution result) and `error_code` (technical failure detail).
    // Reuses ControllerStopReason values where the terminal state came
    // from the engine (WORK_QUEUE_EXHAUSTED, BUDGET_EXHAUSTED,
    // CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK), plus a small closed set of
    // worker-level reasons for paths the controller never sees
    // (MEMORY_PLANNING_FAILED, SYSTEM_OR_PROVIDER_FAILURE, NOT_IMPLEMENTED
    // for any future eligibility gap). Never used to encode an
    // evidentiary conclusion — that lives only in research_claim_support.
    terminationReason: text("termination_reason"),
    // Фаза 6, S4 review fix (BLOCKER-2/HIGH-1) — job-lifetime ATOMIC
    // reservation counters for the three real dimensional ceilings
    // (real SearchGateway calls, real ContentFetcher opens, reserved
    // model cost), separate from and never conflated with the
    // ATTEMPT-COUNT gate in controller.ts (which stays keyed off the
    // same maxSearchQueries NUMBER for historical/S3-accepted reasons,
    // but counts a structurally different thing — attempts, not calls).
    // Each external action reserves its unit here via a single atomic
    // `UPDATE ... WHERE current + amount <= ceiling` BEFORE the call is
    // made (see budget-reservation.ts) — no DB lock is held across the
    // external call itself, and the reservation is never refunded on
    // failure ("not a free retry").
    searchQueriesReserved: integer("search_queries_reserved").notNull().default(0),
    sourceOpensReserved: integer("source_opens_reserved").notNull().default(0),
    modelCostMicroReserved: integer("model_cost_micro_reserved").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_research_jobs_idempotency").on(t.userId, t.idempotencyKey),
    // Dedupe одинаковых активных задач (B10). При действующем инварианте
    // «один активный job» избыточен, но остаётся на случай его снятия.
    uniqueIndex("uq_research_jobs_active_task")
      .on(t.userId, t.normalizedTaskHash)
      .where(ACTIVE_STATES_SQL),
    // Один активный job на пользователя — инвариант БД, не правило worker.
    // v1-ограничение; снимается одной миграцией при необходимости.
    uniqueIndex("uq_research_jobs_one_active")
      .on(t.userId)
      .where(ACTIVE_STATES_SQL),
    check(
      "ck_research_jobs_progress_stage",
      sql`${t.progressStage} BETWEEN 1 AND 5`,
    ),
    // Максимум 2 попытки уточнения (LOCKED §5) — лимит в самой БД.
    check(
      "ck_research_jobs_clarifications",
      sql`${t.clarificationAttempts} BETWEEN 0 AND 2`,
    ),
  ],
);

// Append-only журнал переходов. Заполняется ТРИГГЕРОМ при UPDATE state
// (см. миграцию 0001_state_machine.sql) — смена состояния без записи невозможна.
export const researchJobTransitions = pgTable("research_job_transitions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: uuid("job_id")
    .notNull()
    .references(() => researchJobs.id, { onDelete: "cascade" }),
  fromState: researchJobState("from_state").notNull(),
  toState: researchJobState("to_state").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
});

// Результат Question Interpreter. Существует ДО job: невалидный ввод
// не создаёт job и не трогает квоту (B3).
export const interpretations = pgTable(
  "interpretations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    researchJobId: uuid("research_job_id").references(() => researchJobs.id, {
      onDelete: "cascade",
    }),
    // Цепочка уточнений (phase-4-plan §3.3): попытка 1 — исходный вопрос,
    // попытки 2–3 — уточнения 1–2. Полная цепочка Original Question →
    // Interpreter Result восстановима (LOCKED §5).
    parentId: uuid("parent_id").references((): AnyPgColumn => interpretations.id, {
      onDelete: "cascade",
    }),
    originalQuestion: text("original_question").notNull(),
    // Ответ пользователя на clarification_question родителя (для attempt > 1).
    clarificationAnswer: text("clarification_answer"),
    status: interpreterStatus("status").notNull(),
    attempt: smallint("attempt").notNull().default(1),
    result: jsonb("result"),
    modelMeta: jsonb("model_meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("ck_interpretations_attempt", sql`${t.attempt} BETWEEN 1 AND 3`),
    // Один ребёнок на родителя: двойной clarify (double-tap, две вкладки)
    // не создаёт две ветки интерпретации — инвариант БД, не код (DoD-4).
    uniqueIndex("uq_interpretations_one_child")
      .on(t.parentId)
      .where(sql`parent_id IS NOT NULL`),
    index("ix_interpretations_user_created").on(t.userId, t.createdAt.desc()),
    // Retrieval-ключи планировщика Фазы 5 читаются отсюда по job'у
    // (phase-5-plan.md §5.2).
    index("ix_interpretations_research_job").on(t.researchJobId),
  ],
);

// Reservation model DEMO-квоты (LOCKED §2, B10).
// Admission: COUNT(RESERVED + CONSUMED) < limit. Использовано = COUNT(CONSUMED).
export const demoQuotaReservations = pgTable(
  "demo_quota_reservations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    state: quotaReservationState("state").notNull().default("RESERVED"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("uq_demo_quota_reservations_job").on(t.researchJobId)],
);
