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
