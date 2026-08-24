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
  evidenceDirectness,
  evidenceEntityBinding,
  evidenceOfficiality,
  evidenceRelationship,
  evidenceSourceClass,
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    // D-088: носитель составного FK evidence_proof_same_job_fk (0009) —
    // без него «Proof чужого job'а» запрещал бы только код, не БД.
    uniqueIndex("uq_proofs_id_job").on(t.id, t.researchJobId),
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
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  url: text("url").notNull(),
  urlHash: text("url_hash").notNull().unique(),
  title: text("title"), // Фаза 6 (§6.3 item 4) — заголовок документа, справочно
  publisher: text("publisher"),
  sourceType: sourceType("source_type").notNull().default("OTHER"),
  health: sourceHealth("health").notNull().default("UNKNOWN"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Фаза 6 (D-088, phase-6-plan.md §6.2–6.3a): Evidence рождается ДО Proof —
// канонический цикл Research Job -> Source -> Evidence -> сопоставление ->
// Proof. Владение — две координаты, обе проверяются БД:
//   JOB_ONLY     research_job_id заполнен, proof_id NULL
//   PROOF_BOUND  оба заполнены, proof_id — Proof ТОГО ЖЕ job'а (составной FK)
// ORPHAN структурно невозможен: research_job_id NOT NULL.
export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // R-2 fix (Phase 6 S0-S3 final review): a compatibility discriminator
    // — NOT a new research/product semantic state — separating legacy
    // Phase 1-5 Evidence (version 1, migrated in by 0009's backfill,
    // where the five classification fields below are honestly NULL)
    // from Evidence written under the Phase 6 contract (version 2, where
    // those same fields are structurally required — see the CHECK below).
    // NOT NULL with a version-2 default: every row a caller inserts from
    // here on declares itself version 2 unless the migration's own
    // backfill (run once, before the anti-bypass trigger below existed)
    // set it to 1. The trigger installed in 0009 is what actually
    // forbids a new row from claiming version 1, or an existing version-2
    // row from being downgraded — this column alone is not the
    // enforcement, only the label the enforcement reads.
    evidenceContractVersion: smallint("evidence_contract_version")
      .notNull()
      .default(2),
    // Evidence существует независимо от Proof (D-088) — единственная
    // обязательная привязка. NOT NULL — не проекция удобства, а инвариант:
    // без него состояние ORPHAN становится представимым.
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    // Nullable (D-088): доказательство может существовать до/без Proof
    // (BUDGET_LIMIT_REACHED, FAILED, отмена — канон §46). Составной FK
    // ниже — единственный способ ограничить непустое значение job'ом
    // ЭТОЙ ЖЕ строки; здесь остаётся только "какая-то" ссылка на proofs.id.
    proofId: uuid("proof_id"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    // Сопоставление с контрактом (§6.2): без пары (step, component)
    // Evidence нельзя приписать к работе ContractView/контроллера.
    // Nullable (Phase 6 S0-S3 review fix package, migration 0009):
    // строки, созданные ДО этой миграции (Phase 1-5 Evidence), не несут
    // этого значения и не могут детерминированно его получить — обратно
    // совместимая ступенчатая схема, а не изобретённое значение по
    // умолчанию. Каждая строка, записанная production-кодом Фазы 6,
    // всегда заполняет оба поля — nullable ослабляет только тип колонки,
    // не инвариант записи.
    patternStep: smallint("pattern_step"),
    component: text("component"),
    relationship: evidenceRelationship("relationship").notNull(),
    // Правило достаточности опирается на прямоту, а не на количество
    // источников (§9, §11.2) — у извлечения всегда есть мнение, КРОМЕ
    // унаследованных строк Phase 1-5 (см. patternStep выше) — nullable по
    // той же причине.
    directness: evidenceDirectness("directness"),
    fragment: text("fragment").notNull(), // оригинал, не переводится
    summary: text("summary"), // локализуемое краткое описание
    doesNotProve: text("does_not_prove"),
    // Текущее состояние — машиночитаемо (CHECK 2 atlas-core, тот же
    // словарь, что уже несёт research_memory.mechanism_state); нет
    // enum-а нарочно — словарь Pattern-специфичен и живёт в CORE, не в
    // структуре БД (тот же выбор, что для research_memory).
    mechanismState: text("mechanism_state"),
    // fees / issuance / treasury / collateral_return — структурно, не в
    // прозе (CHECK 3 atlas-core).
    valueSource: text("value_source"),
    // Nullable по той же причине, что patternStep выше — Phase 1-5
    // Evidence не несёт этих значений.
    sourceClass: evidenceSourceClass("source_class"),
    officiality: evidenceOfficiality("officiality"),
    // D-134 — Axis C, independent of sourceClass/officiality: for
    // ONCHAIN_VERIFIABLE evidence only, whether the URL is deterministically
    // attributable to the project's confirmed (chain, tokenAddress). NULL
    // for every other class (axis not applicable) — never part of the v2
    // completeness CHECK below, since most evidence legitimately has no
    // on-chain identity to bind against.
    entityBinding: evidenceEntityBinding("entity_binding"),
    // Structured on-chain V1 (AMENDMENT B) — the retrieval artifact this
    // deterministic fact was derived from. NULL for every ordinary
    // fetched-document evidence row (the overwhelming majority), and for
    // those rows nothing about this column applies.
    //
    // MANY facts may reference ONE artifact: a single transaction read can
    // yield several burn facts, and they must share one stored retrieval
    // rather than duplicating provenance per row. The artifact table owns
    // chain position, provider, hashes and re-verification data; evidence
    // keeps its existing meaning untouched. Declared as a plain uuid with
    // the FK added in the migration, since onchain_artifacts lives in
    // engine.ts and importing it here would create a schema import cycle.
    onchainArtifactId: uuid("onchain_artifact_id"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    dataAsOf: timestamp("data_as_of", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Мост к кандидату памяти без повторного разбора (§6.2); nullable —
    // не каждое Evidence метит claim заранее известного словаря.
    claimKey: text("claim_key"),
    // Канонический словарь (D-044): LOW_CHANGE/MEDIUM_CHANGE/HIGH_CHANGE —
    // приведено миграцией 0006 с прежнего текстового CHECK ('LOW'/'MEDIUM'/
    // 'HIGH_CHANGE'), пока таблица пуста, до того как память заведёт
    // третью версию словаря (phase-5-plan.md §5.3).
    freshnessClass: freshnessClass("freshness_class"),
    // Неизменяемый provenance момента исследования: Proof навсегда ссылается
    // на то, что ARI видел тогда, даже если источник изменится. D-076:
    // без непустых retrieved_url + content_hash Evidence не существует —
    // CHECK ниже, не только NOT NULL (пустая строка иначе проходит).
    retrievedUrl: text("retrieved_url").notNull(),
    contentHash: text("content_hash").notNull(),
    snapshotRef: text("snapshot_ref"),
    // Фаза 6, S4 review fix (MEDIUM-1) — deterministic identity of ONE
    // extracted evidence UNIT: sha256(research_job_id|source_id|
    // pattern_step|component|normalized supportFragment), computed by
    // s4-executor.ts at insert time. NULL for anything not inserted
    // through that path (legacy rows, direct test inserts) — the partial
    // unique index below only constrains non-NULL values, so at-least-
    // once replay of the SAME extracted unit is idempotent
    // (onConflictDoNothing) without requiring every Evidence writer to
    // participate in this scheme.
    extractionUnitKey: text("extraction_unit_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_evidence_job").on(t.researchJobId),
    index("ix_evidence_job_step_component").on(
      t.researchJobId,
      t.patternStep,
      t.component,
    ),
    index("ix_evidence_proof").on(t.proofId),
    index("ix_evidence_source").on(t.sourceId),
    uniqueIndex("uq_evidence_extraction_unit_key")
      .on(t.extractionUnitKey)
      .where(sql`${t.extractionUnitKey} IS NOT NULL`),
    check("ck_evidence_pattern_step", sql`${t.patternStep} BETWEEN 1 AND 8`),
    check(
      "ck_evidence_provenance_nonempty",
      sql`length(${t.retrievedUrl}) > 0 AND length(${t.contentHash}) > 0`,
    ),
    // R-2 fix: version 1 (legacy, migrated in) may leave the five
    // classification fields NULL — they cannot be honestly recovered.
    // Version 2 (the Phase 6 contract) MUST have all five — the OR
    // short-circuits to true for any non-2 version, so this constraint
    // is a no-op for legacy rows and a hard requirement for new ones.
    check(
      "ck_evidence_contract_v2_complete",
      sql`${t.evidenceContractVersion} <> 2 OR (
        ${t.patternStep} IS NOT NULL
        AND ${t.component} IS NOT NULL
        AND ${t.directness} IS NOT NULL
        AND ${t.sourceClass} IS NOT NULL
        AND ${t.officiality} IS NOT NULL
      )`,
    ),
    // S4 NOTE-1 cheap hardening: without this, a legacy v1 row could be
    // hand-edited to an unsupported v3 (or any other value) and the
    // completeness CHECK above would simply never apply to it — a second,
    // silent way to dodge classification that isn't even the documented
    // v1 exemption. Purely additive range restriction, no new semantic
    // state: exactly the two contract versions that exist remain valid.
    check("ck_evidence_contract_version_known", sql`${t.evidenceContractVersion} IN (1, 2)`),
  ],
);

export const proofGaps = pgTable(
  "proof_gaps",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
