import type { ResearchBoundaryContract } from "./contract";

// Blind Evaluator (phase-5-plan.md §7.5, D-063). Судит КАЧЕСТВО плана без
// утечки происхождения решений. Оценщик НЕ обязан не знать, была ли
// включена память (при memory_enabled=false все 8 шагов всегда MISSING —
// OFF-контракт опознаётся структурно, ревью MEDIUM-3); он обязан не знать,
// ОТКУДА взялось каждое решение по шагу. Пара OFF/ON остаётся
// количественным сравнением метрик, слепая оценка — сравнение ON-планов.
//
// Из вида удаляются: reason, memoryIds, memory_used (колонка БД, сюда
// не передаётся), components (несут memoryIds и причины), и
// knownInformation — оно содержит ТЕКСТЫ памяти и выдаёт происхождение
// прямо (memory-derived statement text).

export interface BlindStepView {
  step: number;
  stepName: string;
  // Только ЧТО решено, не ПОЧЕМУ (reason, memoryIds и components выдали бы
  // происхождение — "active memory covers…" / "stale…" вслепую недопустимо).
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

export function stripForBlindEvaluation(contract: ResearchBoundaryContract): BlindContractView {
  return {
    patternVersion: contract.patternVersion,
    coveredSteps: [...contract.alreadySatisfiedSteps].sort((a, b) => a - b),
    needsFreshEvidenceSteps: [...contract.requiredFreshEvidence].sort((a, b) => a - b),
    missingSteps: [...contract.missingSteps].sort((a, b) => a - b),
    excludedScopeCount: contract.excludedScope.length,
    stopConditionsCount: contract.stopConditions.length,
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
