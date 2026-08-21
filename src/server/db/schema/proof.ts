import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { projects, topics } from "./catalog";
import {
  evidenceRelationship,
  freshnessClass,
  proofVerificationStatus,
  proofVisibility,
  sourceHealth,
  sourceType,
  verdict,
} from "./enums";
import { users } from "./identity";
import { researchJobs } from "./research";

export const proofs = pgTable(
  "proofs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "restrict" }),
    // Приватность по умолчанию; значения PUBLIC не существует (v1).
    visibility: proofVisibility("visibility").notNull().default("PRIVATE"),
    verdict: verdict("verdict").notNull(),
    confidence: smallint("confidence").notNull(),
    // 7-слойная структура LOCKED §7, включая обязательный блок
    // «Что может изменить вывод».
    layers: jsonb("layers").notNull(),
    researchCutoff: timestamp("research_cutoff", { withTimezone: true }),
    // D-041: гейтит промоушен в ACTIVE-память (Фаза 5), а не появление
    // кандидата (D-023) — извлечение и промоушен остаются разными порогами.
    // Выставляется контролируемым скриптом владельца/админа (D-055).
    verificationStatus: proofVerificationStatus("verification_status")
      .notNull()
      .default("DRAFT"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Ровно один Proof на job: ретрай воркера не создаёт второй.
    uniqueIndex("uq_proofs_research_job").on(t.researchJobId),
    check("ck_proofs_confidence", sql`${t.confidence} BETWEEN 0 AND 100`),
    // Без индексов измерение Memory OFF/ON недостоверно — seq scan,
    // не качество памяти, объяснял бы разницу (phase-5-plan.md §1.2).
    index("ix_proofs_project_topic").on(t.projectId, t.topicId),
    index("ix_proofs_owner").on(t.ownerUserId),
  ],
);

// Общесистемные источники: НЕ user-owned, переживают удаление пользователя.
// Мутабельны (health-статус) — неизменяемый снимок момента исследования
// живёт в evidence.
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  url: text("url").notNull(),
  urlHash: text("url_hash").notNull().unique(),
  publisher: text("publisher"),
  sourceType: sourceType("source_type").notNull().default("OTHER"),
  health: sourceHealth("health").notNull().default("UNKNOWN"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    proofId: uuid("proof_id")
      .notNull()
      .references(() => proofs.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    relationship: evidenceRelationship("relationship").notNull(),
    fragment: text("fragment").notNull(), // оригинал, не переводится
    summary: text("summary"), // локализуемое краткое описание
    doesNotProve: text("does_not_prove"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    dataAsOf: timestamp("data_as_of", { withTimezone: true }),
    // Канонический словарь (D-044): LOW_CHANGE/MEDIUM_CHANGE/HIGH_CHANGE —
    // приведено миграцией 0006 с прежнего текстового CHECK ('LOW'/'MEDIUM'/
    // 'HIGH_CHANGE'), пока таблица пуста, до того как память заведёт
    // третью версию словаря (phase-5-plan.md §5.3).
    freshnessClass: freshnessClass("freshness_class"),
    // Неизменяемый provenance момента исследования: Proof навсегда ссылается
    // на то, что ARI видел тогда, даже если источник изменится.
    retrievedUrl: text("retrieved_url").notNull(),
    contentHash: text("content_hash").notNull(),
    snapshotRef: text("snapshot_ref"), // наполнение — с Фазы 6
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_evidence_proof").on(t.proofId),
    index("ix_evidence_source").on(t.sourceId),
  ],
);

export const proofGaps = pgTable(
  "proof_gaps",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    proofId: uuid("proof_id")
      .notNull()
      .references(() => proofs.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    kind: text("kind"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ix_proof_gaps_proof").on(t.proofId)],
);
