import type { ResearchBoundaryContract } from "./contract";

// Blind Evaluator (phase-5-plan.md §7.5, D-049, corrected by D-063). Судит
// КАЧЕСТВО плана, не зная, ПОЧЕМУ каждый шаг был так решён — включено ли
// это переиспользование памяти (reason/memoryIds/memory-derived текст) или
// свежий поиск. Это НЕ заявка на то, что судья не знает, был ли ВООБЩЕ
// включён memory_enabled=ON/OFF для прогона — OFF vs ON остаётся
// количественным сравнением (evaluation.ts), не слепым. research_plans.
// memory_used — отдельная колонка БД, сюда никогда не передаётся.

export interface BlindStepView {
  step: number;
  stepName: string;
  // Только ЧТО решено, не ПОЧЕМУ (reason и memoryIds выдали бы, что это
  // память — "active memory covers…" / "stale…" вслепую недопустимо).
  covered: boolean;
  needsFreshEvidence: boolean;
}

export interface BlindContractView {
  patternVersion: number;
  coveredSteps: number[];
  needsFreshEvidenceSteps: number[];
  missingSteps: number[];
  excludedScopeCount: number;
  stopConditionsCount: number;
  researchBudget: ResearchBoundaryContract["researchBudget"];
  stepDecisions: BlindStepView[];
  // noveltyState остаётся — это оценка полноты покрытия задачи, а не
  // «была ли использована память» (оценщик видит РЕЗУЛЬТАТ, не причину).
  noveltyState: ResearchBoundaryContract["noveltyState"];
}

export function stripForBlindEvaluation(
  contract: ResearchBoundaryContract,
): BlindContractView {
  return {
    patternVersion: contract.patternVersion,
    coveredSteps: [...contract.alreadySatisfiedSteps].sort((a, b) => a - b),
    needsFreshEvidenceSteps: [...contract.requiredFreshEvidence].sort(
      (a, b) => a - b,
    ),
    missingSteps: [...contract.missingSteps].sort((a, b) => a - b),
    excludedScopeCount: contract.excludedScope.length,
    stopConditionsCount: contract.stopConditions.length,
    // knownInformation НАМЕРЕННО удалено (D-063/MEDIUM-3): это дословный
    // текст statement из памяти — сам его состав/формулировка выдаёт
    // происхождение шага так же, как reason/memoryIds.
    researchBudget: contract.researchBudget,
    stepDecisions: contract.stepDecisions.map((d) => ({
      step: d.step,
      stepName: d.stepName,
      covered: d.decision === "ALREADY_SATISFIED",
      needsFreshEvidence: d.decision === "REQUIRED_FRESH",
    })),
    noveltyState: contract.noveltyState,
  };
}
