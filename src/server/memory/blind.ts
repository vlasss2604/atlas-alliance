import type { ResearchBoundaryContract } from "./contract";

// Blind Evaluator (phase-5-plan.md §7.5, D-049). Судит, хороший ли это
// план — не зная, была ли включена память. Слепота — из контракта
// удаляются поля memory_used и происхождение шагов; research_plans.
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
  knownInformation: string[];
  researchBudget: ResearchBoundaryContract["researchBudget"];
  stepDecisions: BlindStepView[];
  // noveltyState остаётся — это оценка полноты покрытия задачи, а не
  // «была ли использована память» (оценщик видит РЕЗУЛЬТАТ, не причину).
  noveltyState: ResearchBoundaryContract["noveltyState"];
}

export function stripForBlindEvaluation(contract: ResearchBoundaryContract): BlindContractView {
  return {
    patternVersion: contract.patternVersion,
    coveredSteps: [...contract.alreadySatisfiedSteps].sort((a, b) => a - b),
    needsFreshEvidenceSteps: [...contract.requiredFreshEvidence].sort((a, b) => a - b),
    missingSteps: [...contract.missingSteps].sort((a, b) => a - b),
    excludedScopeCount: contract.excludedScope.length,
    stopConditionsCount: contract.stopConditions.length,
    // knownInformation — предметные утверждения (что известно), не
    // provenance ("откуда"): допустимо показать судье, что план ЗНАЕТ,
    // не выдавая, что это пришло из памяти, а не из свежего поиска.
    knownInformation: contract.knownInformation,
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
