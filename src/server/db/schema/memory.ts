import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  interval,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { projects, topics } from "./catalog";
import {
  freshnessClass,
  memoryHealth,
  memoryLifecycleState,
  projectMemoryKind,
  researchCapability,
} from "./enums";
import { users } from "./identity";
import { researchJobs } from "./research";
import { sources } from "./proof";

// Фаза 5 — Research Memory (phase-5-plan.md §5). Системное знание,
// отдельное от пользовательских Proof: без FK на users (D-048).
// Обезличивание — в момент промоушена, не при удалении аккаунта.

// FACT MEMORY — «что было истинно в момент времени» (§2.1). claim_key —
// ключ онтологии, тот же словарь, что использует Interpreter (§3.1):
// запись и запрос проходят через один словарь, векторы не нужны.
export const researchMemory = pgTable(
  "research_memory",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "restrict" }),
    patternStep: smallint("pattern_step").notNull(),
    claimKey: text("claim_key").notNull(),
    statement: text("statement").notNull(),
    mechanismState: text("mechanism_state"),
    freshnessClass: freshnessClass("freshness_class").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    dataAsOf: timestamp("data_as_of", { withTimezone: true }),
    // Политика свежести конкретного факта; сравнивается с verified_at/
    // data_as_of планировщиком (§4.4: REUSE DOES NOT OVERRIDE FRESHNESS).
    staleAfter: interval("stale_after"),
    confidence: smallint("confidence").notNull(),
    lifecycleState: memoryLifecycleState("lifecycle_state")
      .notNull()
      .default("OBSERVED"),
    health: memoryHealth("health").notNull().default("OK"),
    // Самоссылка — только lifecycle-указатель «старое заменено новым»,
    // не evidence-связь: память не может ссылаться на память как на
    // подтверждение (phase-5-plan.md §8, «самоподтверждение»).
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => researchMemory.id,
      { onDelete: "set null" },
    ),
    // NULL допустим (запись может остаться неповышенной навсегда); при
    // самом переходе в ACTIVE триггер требует значение (0006, guard).
    promotedBy: uuid("promoted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    // Откуда взялся кандидат: 'PROOF_TRACE' | 'ADMIN_SEED' | … — справочное.
    originKind: text("origin_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_research_memory_project_topic_step").on(
      t.projectId,
      t.topicId,
      t.patternStep,
    ),
    index("ix_research_memory_claim_key").on(t.claimKey),
    // Быстрый путь для планировщика: «что активно для этого проекта и шага».
    // Не уникален — несколько активных claim на один шаг допустимы.
    index("ix_research_memory_active_project_step")
      .on(t.projectId, t.patternStep)
      .where(sql`${t.lifecycleState} = 'ACTIVE'`),
    // Вторичный recall (§3.4.2): полнотекстовый поиск по statement,
    // 'simple'-конфигурация — контент смешан RU/EN, без языкового стемминга.
    index("ix_research_memory_statement_fts")
      .using("gin", sql`to_tsvector('simple', ${t.statement})`),
    // pg_trgm fallback для случаев, не покрытых claim_key/FTS.
    index("ix_research_memory_statement_trgm")
      .using("gin", sql`${t.statement} gin_trgm_ops`),
    check("ck_research_memory_pattern_step", sql`${t.patternStep} BETWEEN 1 AND 8`),
    check("ck_research_memory_confidence", sql`${t.confidence} BETWEEN 0 AND 100`),
  ],
);

// Происхождение системного знания — КОПИЯ на момент промоушена, не ссылка
// (§5.1: исправление дефекта плана). source_id указывает на системные
// sources (RESTRICT безопасен); origin_evidence_id — след БЕЗ FK: аудит,
// а не зависимость, чтобы удаление пользовательского evidence не блокировало
// удаление аккаунта.
export const researchMemoryProvenance = pgTable(
  "research_memory_provenance",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => researchMemory.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    retrievedUrl: text("retrieved_url").notNull(),
    contentHash: text("content_hash").notNull(),
    fragment: text("fragment"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    dataAsOf: timestamp("data_as_of", { withTimezone: true }),
    // Аудит-след БЕЗ внешнего ключа — намеренно (см. комментарий выше).
    originEvidenceId: uuid("origin_evidence_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ix_research_memory_provenance_memory").on(t.memoryId)],
);

// RESEARCH MEMORY — «как эффективно исследовать этот проект снова» (§2.1).
export const projectMemoryItems = pgTable(
  "project_memory_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    kind: projectMemoryKind("kind").notNull(),
    content: jsonb("content").notNull(),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "restrict",
    }),
    lifecycleState: memoryLifecycleState("lifecycle_state")
      .notNull()
      .default("OBSERVED"),
    health: memoryHealth("health").notNull().default("OK"),
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => projectMemoryItems.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_project_memory_items_project_kind").on(t.projectId, t.kind),
    index("ix_project_memory_items_active")
      .on(t.projectId)
      .where(sql`${t.lifecycleState} = 'ACTIVE'`),
  ],
);

// План — доказательство принципа «память меняет план» (§4.2, D-056).
// mode переиспользует research_capability (тот же словарь, что и
// capability_at_start job'а — сравнимы напрямую при enforcement потолка).
export const researchPlans = pgTable(
  "research_plans",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    mode: researchCapability("mode").notNull(),
    contract: jsonb("contract").notNull(),
    memoryUsed: boolean("memory_used").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_research_plans_job_version").on(t.researchJobId, t.version),
  ],
);

// Что вспомнили и что это изменило — сырьё оценки OFF vs ON (§7).
export const memoryRetrievals = pgTable(
  "memory_retrievals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => researchPlans.id, { onDelete: "cascade" }),
    queryKeys: jsonb("query_keys").notNull(),
    hits: jsonb("hits").notNull(),
    retrievedCount: integer("retrieved_count").notNull(),
    appliedCount: integer("applied_count").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ix_memory_retrievals_job").on(t.researchJobId)],
);
