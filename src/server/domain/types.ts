// Доменные типы Фазы 1. Значения enum'ов живут в схеме БД (единственный
// источник); здесь — их TypeScript-представление для прикладного кода.

export type EntitlementLevel = "DEMO" | "ARI_CORE";

export type ResearchCapability = "MEMORY" | "TARGETED_REFRESH" | "FRESH_RESEARCH";

export type ResearchJobState =
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_CLARIFICATION"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "BUDGET_LIMIT_REACHED";

// Бюджет job — плоские целые числа (float запрещён; стоимость — в микро-USD).
export interface JobBudget {
  maxSearchQueries: number;
  maxSourceOpens: number;
  maxModelCostMicro: number;
  maxWallClockSec: number;
  reservedRecoverySteps: number;
}

// Снапшот entitlement в момент старта job (B1).
export interface EntitlementSnapshot {
  level: EntitlementLevel;
  capability: ResearchCapability;
  budget: JobBudget;
}
