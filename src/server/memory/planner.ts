import { PATTERN_STEP_NAMES, type PatternContent } from "../domain/pattern";
import type { JobBudgetConfig, ProductConfig } from "../config/product";
import type { ResearchCapability } from "../domain/types";
import type { RetrievalHit } from "./retrieval-gateway";
import type { ResearchBoundaryContract, StepDecision } from "./contract";

// Детерминированный планировщик (D-052, phase-5-plan.md §4). Чистая
// функция: раскладка памяти по шагам решает код, не модель. Воспроизводимо,
// объяснимо (stepDecisions[].reason), не зависит от провайдера.

const CAPABILITY_RANK: Record<ResearchCapability, number> = {
  MEMORY: 0,
  TARGETED_REFRESH: 1,
  FRESH_RESEARCH: 2,
};

function effectiveStaleAfterDays(
  hit: RetrievalHit,
  config: Pick<ProductConfig, "memory_stale_after_days">,
): number {
  return hit.staleAfterDays ?? config.memory_stale_after_days[hit.freshnessClass];
}

// REUSE DOES NOT OVERRIDE FRESHNESS (§4.4) — единственное место, где это
// решается, чистая функция времени и конфига, без места для интерпретации.
export function isStale(hit: RetrievalHit, now: Date, config: ProductConfig): boolean {
  const days = effectiveStaleAfterDays(hit, config);
  const ageMs = now.getTime() - hit.verifiedAt.getTime();
  return ageMs > days * 24 * 60 * 60 * 1000;
}

export interface PlanInput {
  memoryEnabled: boolean;
  hits: RetrievalHit[];
  pattern: PatternContent;
  capabilityAtStart: ResearchCapability;
  budgetAtStart: JobBudgetConfig;
  config: ProductConfig;
  now: Date;
}

export interface PlanResult {
  contract: ResearchBoundaryContract;
  mode: ResearchCapability;
  memoryUsed: boolean;
  desiredMode: ResearchCapability;
  capabilityCeilingHit: boolean;
}

export function planResearch(input: PlanInput): PlanResult {
  const { memoryEnabled, hits, pattern, capabilityAtStart, budgetAtStart, config, now } = input;

  const hitsByStep = new Map<number, RetrievalHit[]>();
  if (memoryEnabled) {
    for (const hit of hits) {
      const list = hitsByStep.get(hit.patternStep) ?? [];
      list.push(hit);
      hitsByStep.set(hit.patternStep, list);
    }
  }

  const stepDecisions: StepDecision[] = pattern.steps.map((step) => {
    const stepHits = hitsByStep.get(step.step) ?? [];
    if (stepHits.length === 0) {
      return {
        step: step.step,
        stepName: step.name,
        decision: "MISSING",
        reason: memoryEnabled
          ? "no active memory for this step"
          : "memory disabled for this run (memory_enabled=false)",
        memoryIds: [],
      };
    }
    const freshEnough = stepHits.filter(
      (h) => !isStale(h, now, config) && h.confidence >= config.memory_min_confidence_reuse,
    );
    if (freshEnough.length > 0) {
      return {
        step: step.step,
        stepName: step.name,
        decision: "ALREADY_SATISFIED",
        reason: `active memory covers this step (top confidence ${Math.max(...freshEnough.map((h) => h.confidence))}%, within freshness window)`,
        memoryIds: freshEnough.map((h) => h.memoryId),
      };
    }
    return {
      step: step.step,
      stepName: step.name,
      decision: "REQUIRED_FRESH",
      reason:
        "memory exists for this step but is stale or below the reuse confidence threshold — dynamic fact must be reverified, not assumed current",
      memoryIds: stepHits.map((h) => h.memoryId),
    };
  });

  const satisfied = stepDecisions.filter((d) => d.decision === "ALREADY_SATISFIED");
  const requiredFresh = stepDecisions.filter((d) => d.decision === "REQUIRED_FRESH");
  const missing = stepDecisions.filter((d) => d.decision === "MISSING");

  const desiredMode: ResearchCapability =
    satisfied.length === pattern.steps.length
      ? "MEMORY"
      : satisfied.length === 0 && requiredFresh.length === 0
        ? "FRESH_RESEARCH"
        : "TARGETED_REFRESH";

  const capabilityCeilingHit = CAPABILITY_RANK[desiredMode] > CAPABILITY_RANK[capabilityAtStart];
  const mode: ResearchCapability = capabilityCeilingHit ? capabilityAtStart : desiredMode;

  const reusableEvidence = satisfied.flatMap((d) => {
    const stepHits = (hitsByStep.get(d.step) ?? []).filter((h) => d.memoryIds.includes(h.memoryId));
    return stepHits.map((h) => ({
      memoryId: h.memoryId,
      step: h.patternStep,
      claimKey: h.claimKey,
      statement: h.statement,
      confidence: h.confidence,
    }));
  });

  const noveltyState =
    satisfied.length === pattern.steps.length
      ? "KNOWN"
      : satisfied.length === 0 && requiredFresh.length === 0
        ? "NOVEL"
        : "PARTIALLY_KNOWN";

  const stopConditions: string[] = [];
  if (mode === "MEMORY") {
    stopConditions.push("sufficient verified memory covers all steps — no fresh research needed");
  }
  const excludedScope: string[] = [];
  if (capabilityCeilingHit) {
    const note = `capability ceiling reached: plan would need ${desiredMode}, entitlement allows only ${capabilityAtStart}`;
    stopConditions.push(note);
    for (const d of [...requiredFresh, ...missing]) {
      excludedScope.push(`step ${d.step} (${d.stepName}): not researched — ${note}`);
    }
  }

  // Прогноз экономии, не факт (§7.1: «лишние поиски» — прогноз в Фазе 5,
  // факт — в Фазе 6). Пропорционально доле закрытых шагов, с нижним полом.
  const economyFactor = 1 - 0.5 * (satisfied.length / pattern.steps.length);
  const researchBudget: JobBudgetConfig = {
    ...budgetAtStart,
    maxSearchQueries: Math.max(
      budgetAtStart.reservedRecoverySteps,
      Math.round(budgetAtStart.maxSearchQueries * economyFactor),
    ),
    maxSourceOpens: Math.max(
      budgetAtStart.reservedRecoverySteps,
      Math.round(budgetAtStart.maxSourceOpens * economyFactor),
    ),
  };

  // "Использована" — память нашлась и повлияла на решение по хотя бы
  // одному шагу, реиспользован он или отправлен на reverify. Просроченный
  // факт не переиспользуется (REUSE DOES NOT OVERRIDE FRESHNESS), но он
  // всё равно СПРАВОЧНО повлиял на план — это и есть USED_AND_REVERIFIED,
  // а не «память вообще не смотрели».
  const memoryUsed = memoryEnabled && satisfied.length + requiredFresh.length > 0;

  const contract: ResearchBoundaryContract = {
    patternVersion: 1,
    alreadySatisfiedSteps: satisfied.map((d) => d.step),
    reusableEvidence,
    requiredFreshEvidence: requiredFresh.map((d) => d.step),
    missingSteps: missing.map((d) => d.step),
    excludedScope,
    stopConditions,
    knownInformation: reusableEvidence.map((e) => e.statement),
    researchBudget,
    noveltyState,
    stepDecisions,
  };

  return { contract, mode, memoryUsed, desiredMode, capabilityCeilingHit };
}

export { PATTERN_STEP_NAMES };
