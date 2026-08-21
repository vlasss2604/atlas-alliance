import { pgEnum } from "drizzle-orm/pg-core";

// Все enum'ы — из phase-1-plan.md §3. Пользовательские тексты статусов —
// presentation layer; эти значения в UI не показываются.

export const entitlementLevel = pgEnum("entitlement_level", [
  "DEMO",
  "ARI_CORE",
]);

export const researchCapability = pgEnum("research_capability", [
  "MEMORY",
  "TARGETED_REFRESH",
  "FRESH_RESEARCH",
]);

export const subscriptionStatus = pgEnum("subscription_status", [
  "PENDING",
  "ACTIVE",
  "CANCEL_AT_PERIOD_END",
  "CANCELLED",
  "EXPIRED",
  "PAST_DUE",
]);

export const projectStatus = pgEnum("project_status", [
  "RESEARCHED_INTERNAL",
  "CANDIDATE",
  "ACTIVE_CORE",
  "UNPUBLISHED",
  "DEPRECATED",
]);

export const researchJobState = pgEnum("research_job_state", [
  "QUEUED",
  "RUNNING",
  "AWAITING_CLARIFICATION",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BUDGET_LIMIT_REACHED",
]);

export const interpreterStatus = pgEnum("interpreter_status", [
  "READY",
  "NEEDS_CLARIFICATION",
  "OUT_OF_SCOPE",
  "INVALID",
]);

export const verdict = pgEnum("verdict", [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "NOT_SUPPORTED",
  "INSUFFICIENT_EVIDENCE",
  "NOT_APPLICABLE",
]);

// Значения PUBLIC не существует — публичных Proof в v1 нет.
export const proofVisibility = pgEnum("proof_visibility", [
  "PRIVATE",
  "ADMIN_ONLY",
]);

export const quotaReservationState = pgEnum("quota_reservation_state", [
  "RESERVED",
  "CONSUMED",
  "RELEASED",
]);

export const evidenceRelationship = pgEnum("evidence_relationship", [
  "SUPPORTS",
  "CONTRADICTS",
  "CONTEXT",
  "LIMITS",
]);

export const sourceType = pgEnum("source_type", [
  "OFFICIAL_DOCS",
  "GOVERNANCE",
  "ONCHAIN",
  "SECURITY",
  "RESEARCH",
  "NEWS",
  "OTHER",
]);

export const sourceHealth = pgEnum("source_health", [
  "UNKNOWN",
  "OK",
  "BROKEN",
  "CHANGED",
]);

export const memoryStatus = pgEnum("memory_status", [
  "NOT_USED",
  "USED",
  "USED_AND_REVERIFIED",
]);

export const userRole = pgEnum("user_role", ["USER", "ADMIN"]);

// Фаза 5 (phase-5-plan.md §5). Lifecycle памяти — единственный барьер
// против отравления (D-025): переход в ACTIVE только человеком, прямая
// вставка ACTIVE отклоняется триггером (0006_research_memory.sql).
export const memoryLifecycleState = pgEnum("memory_lifecycle_state", [
  "OBSERVED",
  "CANDIDATE",
  "ACTIVE",
  "DEPRECATED",
  "SUPERSEDED",
]);

export const memoryHealth = pgEnum("memory_health", [
  "OK",
  "QUESTIONABLE",
  "REVERIFY",
  "STALE",
  "DEPRECATED",
]);

// Канонический словарь свежести (D-044): заменяет текстовый CHECK на
// evidence.freshness_class, приведённый той же миграцией.
export const freshnessClass = pgEnum("freshness_class", [
  "LOW_CHANGE",
  "MEDIUM_CHANGE",
  "HIGH_CHANGE",
]);

// D-041: VERIFIED гейтит промоушен в ACTIVE-память, а не появление кандидата.
export const proofVerificationStatus = pgEnum("proof_verification_status", [
  "DRAFT",
  "REVIEWED",
  "VERIFIED",
]);

export const projectMemoryKind = pgEnum("project_memory_kind", [
  "SOURCE_ROUTE",
  "USEFUL_QUERY",
  "FAILED_QUERY",
  "DEAD_END",
  "TERMINOLOGY",
  "METRIC_SEMANTICS",
  "FRESHNESS_NOTE",
  "CAVEAT",
]);

// Фаза 6 (phase-6-plan.md §6.2). Прямота доказательства — правило
// достаточности опирается на неё, а не на количество источников (§11.2).
export const evidenceDirectness = pgEnum("evidence_directness", [
  "DIRECT",
  "INDIRECT",
  "INFERRED",
]);

// Ось A авторитета источника — детерминирована из URL/типа (§7.2).
export const evidenceSourceClass = pgEnum("evidence_source_class", [
  "ONCHAIN_VERIFIABLE",
  "OFFICIAL_DOCS",
  "GOVERNANCE",
  "OFFICIAL_REPORT",
  "DATA_PROVIDER",
  "RESEARCH_MEDIA",
  "SOCIAL",
]);

// Ось B авторитета источника — подтверждён ли домен человеком (§7.2).
export const evidenceOfficiality = pgEnum("evidence_officiality", [
  "CONFIRMED",
  "CLAIMED",
]);

// Фаза 6, S3 (phase-6-plan.md §19 S3) — статус одной попытки исполнения
// по (job, step, component). Лексикон контроллера, не Evidence и не
// research_component_results (та таблица — задача сопоставления, S5).
export const researchAttemptStatus = pgEnum("research_attempt_status", [
  "STARTED",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
]);
