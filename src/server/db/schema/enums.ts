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

// Phase 6, S5 (phase-6-s5-plan.md §3, D-092) — exactly four terminal
// reconciliation states. NOT_APPLICABLE is deliberately absent (Pattern v1
// has no optional component, D-022/D-095) — see the plan for why adding it
// here would become a place to hide missing evidence rather than report it
// honestly.
export const componentReconciliationStatus = pgEnum("component_reconciliation_status", [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
]);

// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) —
// operational trace vocabulary. This is TRACE, never Evidence and never
// a claim judgment: it records "what S4 did", not "what is true about
// the project" (§H, TRACE ≠ EVIDENCE). Closed by design — no free-text
// operation names.
export const traceOperationType = pgEnum("trace_operation_type", [
  "QUERY_PROPOSED",
  "SEARCH_EXECUTED",
  "CANDIDATE_RETURNED",
  "CANDIDATE_DEDUPED",
  "CANDIDATE_SKIPPED_BUDGET",
  "FETCH_ATTEMPTED",
  "FETCH_OK",
  "FETCH_FAILED",
  "EXTRACT_ATTEMPTED",
  "EXTRACT_OK",
  "EXTRACT_FAILED",
  "REJECTED_WRONG_PROJECT",
  "REJECTED_WRONG_COMPONENT",
  "REJECTED_NOT_TRACEABLE",
  // S10 (D-090 count-then-gate, live-provider-enablement.md): a model
  // generation call was never made — the QueryProposer role has no
  // pre-call ATTEMPTED/OK/FAILED triplet the way EXTRACT_* does
  // (EvidenceExtractor's existing EXTRACT_FAILED already carries the new
  // reason codes below for its own count-then-gate skip). Additive, not
  // a replacement for any existing operation.
  "MODEL_CALL_SKIPPED",
  // S10 acceptance closure (MEDIUM-1, D-119): the ONE dedicated audit row
  // per real external model-generation attempt (QueryProposer or
  // EvidenceExtractor) — carries actual_input_tokens/actual_output_tokens/
  // actual_cost_micro on success, null on failure. QUERY_PROPOSED (per
  // proposed query) and EXTRACT_OK (per admitted fact) no longer carry
  // duplicated usage — summing actual_cost_micro over MODEL_CALL_ATTEMPTED
  // rows alone gives the true cost, never an overstated multiple.
  "MODEL_CALL_ATTEMPTED",
]);

// Outcome of the ONE operation this row records — deliberately the same
// three-value vocabulary research_attempts/WorkExecutionResult already
// use (D-070 discipline: no parallel status vocabulary invented here).
export const traceStatus = pgEnum("trace_status", ["OK", "FAILED", "SKIPPED"]);

// Which of S4's four provider roles performed the operation, when the
// event is operation-level rather than job-level.
export const traceProviderKind = pgEnum("trace_provider_kind", [
  "QUERY_PROPOSE",
  "SEARCH",
  "FETCH",
  "EXTRACT",
]);

// Closed reason vocabulary — never a raw exception/provider-response
// string (§A/§M: a provider error containing a credential or secret must
// never leak into this field). PROVIDER_ERROR is the deliberate, single
// catch-all for "the provider call itself threw/failed" — the actual
// message is discarded, not laundered into a "safe-looking" code.
export const traceReasonCode = pgEnum("trace_reason_code", [
  "NONE",
  "ZERO_CANDIDATES",
  "DUPLICATE_URL",
  "SEARCH_QUERY_BUDGET_EXHAUSTED",
  "SOURCE_OPEN_BUDGET_EXHAUSTED",
  "MODEL_COST_BUDGET_EXHAUSTED",
  "PROVIDER_ERROR",
  "WRONG_PROJECT",
  "WRONG_COMPONENT",
  "NOT_TRACEABLE",
  // S10 (D-090 count-then-gate): distinguishes "the exact input token
  // count exceeded the approved role-specific ceiling" from "count_tokens
  // itself could not be obtained" — different capability-fatal-vs-local
  // classifications (see live-provider-enablement.md §5/§9). Neither is
  // ever a raw provider message — both are closed, code-authored codes.
  "MODEL_INPUT_OVERSIZED",
  "TOKEN_COUNT_UNAVAILABLE",
  // S10 acceptance closure (MEDIUM-2, D-119): the provider response
  // reported a billable usage category (cache_creation_input_tokens/
  // cache_read_input_tokens) that INTERNAL_ALPHA_V1's approved cost
  // profile cannot safely price (prompt caching is not used in S10) —
  // actual_cost_micro is left null rather than silently understated.
  "UNSUPPORTED_BILLING_USAGE",
]);

// The three existing authoritative budget axes (research_jobs.*Reserved,
// budget-reservation.ts) — trace never introduces a fourth.
export const traceBudgetAxis = pgEnum("trace_budget_axis", [
  "searchQueries",
  "sourceOpens",
  "modelCostMicro",
]);
