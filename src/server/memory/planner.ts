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

function effectiveStaleAfterMs(
  hit: RetrievalHit,
  config: Pick<ProductConfig, "memory_stale_after_days">,
): number {
  // Полная длительность интервала (MEDIUM-1): stale_after — произвольный
  // Postgres interval (часы/дни/месяцы), не только целые дни.
  if (hit.staleAfterSeconds != null) return hit.staleAfterSeconds * 1000;
  return (
    config.memory_stale_after_days[hit.freshnessClass] * 24 * 60 * 60 * 1000
  );
}

// REUSE DOES NOT OVERRIDE FRESHNESS (§4.4) — единственное место, где это
// решается, чистая функция времени и конфига, без места для интерпретации.
export function isStale(
  hit: RetrievalHit,
  now: Date,
  config: ProductConfig,
): boolean {
  const ms = effectiveStaleAfterMs(hit, config);
  const ageMs = now.getTime() - hit.verifiedAt.getTime();
  return ageMs > ms;
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

// Годна ли запись, чтобы В ПРИНЦИПЕ участвовать в закрытии компонента —
// health='OK' (D-059: QUESTIONABLE/REVERIFY/STALE отправляют на reverify,
// но не закрывают шаг сами; DEPRECATED уже отфильтрован retrieval-gateway,
// но планировщик не полагается на это молча — фильтр повторён здесь для
// случаев, когда hits собраны напрямую, в обход gateway, например в тестах).
function isHealthOk(hit: RetrievalHit): boolean {
  return hit.health === "OK";
}

interface ComponentOutcome {
  component: string;
  status: "SATISFIED" | "UNSATISFIED" | "MISSING" | "CONTRADICTED";
  satisfyingHits: RetrievalHit[];
  coveringHits: RetrievalHit[];
  contradictingMemoryIds: string[];
}

// Раскладка одного компонента шага (D-060, D-062, D-059). Компонент —
// единица закрытия, не сам шаг: шаг ALREADY_SATISFIED только когда ВСЕ его
// requiredComponents SATISFIED.
function evaluateComponent(
  component: string,
  hits: RetrievalHit[],
  now: Date,
  config: ProductConfig,
): ComponentOutcome {
  // DEPRECATED уже не должен доходить сюда через gateway, но исключается
  // явно на случай прямой сборки hits (D-059: «исключается из retrieval
  // полностью» — планировщик не должен уметь его закрыть даже при обходе).
  const coveringHits = hits.filter((h) => h.health !== "DEPRECATED");
  if (coveringHits.length === 0) {
    return {
      component,
      status: "MISSING",
      satisfyingHits: [],
      coveringHits: [],
      contradictingMemoryIds: [],
    };
  }

  const okHits = coveringHits.filter(isHealthOk);
  const freshEnoughOk = okHits.filter(
    (h) =>
      !isStale(h, now, config) &&
      h.confidence >= config.memory_min_confidence_reuse,
  );

  // D-062: контрадикция решается ТОЛЬКО по machine-readable mechanism_state,
  // никогда по семантике свободного текста statement.
  const distinctMechanismStates = new Set(
    freshEnoughOk
      .map((h) => h.mechanismState)
      .filter((v): v is string => v != null),
  );
  if (distinctMechanismStates.size > 1) {
    return {
      component,
      status: "CONTRADICTED",
      satisfyingHits: [],
      coveringHits,
      contradictingMemoryIds: freshEnoughOk
        .filter((h) => h.mechanismState != null)
        .map((h) => h.memoryId),
    };
  }

  if (freshEnoughOk.length > 0) {
    return {
      component,
      status: "SATISFIED",
      satisfyingHits: freshEnoughOk,
      coveringHits,
      contradictingMemoryIds: [],
    };
  }

  return {
    component,
    status: "UNSATISFIED",
    satisfyingHits: [],
    coveringHits,
    contradictingMemoryIds: [],
  };
}

export function planResearch(input: PlanInput): PlanResult {
  const {
    memoryEnabled,
    hits,
    pattern,
    capabilityAtStart,
    budgetAtStart,
    config,
    now,
  } = input;

  const hitsByStepComponent = new Map<number, Map<string, RetrievalHit[]>>();
  if (memoryEnabled) {
    for (const hit of hits) {
      const byComponent =
        hitsByStepComponent.get(hit.patternStep) ??
        new Map<string, RetrievalHit[]>();
      const list = byComponent.get(hit.component) ?? [];
      list.push(hit);
      byComponent.set(hit.component, list);
      hitsByStepComponent.set(hit.patternStep, byComponent);
    }
  }

  const stepDecisions: StepDecision[] = pattern.steps.map((step) => {
    const byComponent =
      hitsByStepComponent.get(step.step) ?? new Map<string, RetrievalHit[]>();
    const outcomes = step.requiredComponents.map((component) =>
      evaluateComponent(
        component,
        byComponent.get(component) ?? [],
        now,
        config,
      ),
    );

    const anyCoverage = outcomes.some((o) => o.status !== "MISSING");
    if (!anyCoverage) {
      return {
        step: step.step,
        stepName: step.name,
        decision: "MISSING",
        reason: memoryEnabled
          ? `no active memory for any required component of this step (${step.requiredComponents.join(", ")})`
          : "memory disabled for this run (memory_enabled=false)",
        memoryIds: [],
      };
    }

    const allSatisfied = outcomes.every((o) => o.status === "SATISFIED");
    if (allSatisfied) {
      const memoryIds = [
        ...new Set(
          outcomes.flatMap((o) => o.satisfyingHits.map((h) => h.memoryId)),
        ),
      ];
      return {
        step: step.step,
        stepName: step.name,
        decision: "ALREADY_SATISFIED",
        reason: `all required components covered by active, fresh, sufficiently confident memory (${step.requiredComponents.join(", ")})`,
        memoryIds,
      };
    }

    // Частичное или испорченное покрытие (D-060 partial coverage, D-062
    // contradiction, D-059 non-OK health) — всё сводится к REQUIRED_FRESH,
    // с именованием причины по каждому непокрытому/спорному компоненту.
    const missingComponents = outcomes
      .filter((o) => o.status === "MISSING")
      .map((o) => o.component);
    const unsatisfiedComponents = outcomes
      .filter((o) => o.status === "UNSATISFIED")
      .map((o) => o.component);
    const contradicted = outcomes.filter((o) => o.status === "CONTRADICTED");

    const reasonParts: string[] = [];
    if (missingComponents.length > 0) {
      reasonParts.push(`missing components: ${missingComponents.join(", ")}`);
    }
    if (unsatisfiedComponents.length > 0) {
      reasonParts.push(
        `components covered but not reusable (stale/unhealthy/below confidence threshold): ${unsatisfiedComponents.join(", ")}`,
      );
    }
    if (contradicted.length > 0) {
      reasonParts.push(
        `CONTRADICTED components (conflicting mechanism_state among ACTIVE memory): ${contradicted
          .map((o) => `${o.component} [${o.contradictingMemoryIds.join(", ")}]`)
          .join("; ")}`,
      );
    }

    const memoryIds = [
      ...new Set(
        outcomes.flatMap((o) =>
          o.status === "CONTRADICTED"
            ? o.contradictingMemoryIds
            : o.coveringHits.map((h) => h.memoryId),
        ),
      ),
    ];

    return {
      step: step.step,
      stepName: step.name,
      decision: "REQUIRED_FRESH",
      reason: `partial or unsafe component coverage — ${reasonParts.join("; ")}`,
      memoryIds,
    };
  });

  const satisfied = stepDecisions.filter(
    (d) => d.decision === "ALREADY_SATISFIED",
  );
  const requiredFresh = stepDecisions.filter(
    (d) => d.decision === "REQUIRED_FRESH",
  );
  const missing = stepDecisions.filter((d) => d.decision === "MISSING");

  // D-058: производный режим определяется наличием MISSING/REQUIRED_FRESH
  // шагов, а НЕ количеством уже закрытых. FRESH_RESEARCH не означает
  // «выбросить память и переисследовать все 8 шагов» — already_satisfied_steps
  // остаются закрытыми независимо от режима (см. reusableEvidence ниже,
  // который строится от satisfied, а не от mode).
  const desiredMode: ResearchCapability =
    missing.length > 0
      ? "FRESH_RESEARCH"
      : requiredFresh.length > 0
        ? "TARGETED_REFRESH"
        : "MEMORY";

  const capabilityCeilingHit =
    CAPABILITY_RANK[desiredMode] > CAPABILITY_RANK[capabilityAtStart];
  const mode: ResearchCapability = capabilityCeilingHit
    ? capabilityAtStart
    : desiredMode;

  const reusableEvidence = satisfied.flatMap((d) => {
    const byComponent =
      hitsByStepComponent.get(d.step) ?? new Map<string, RetrievalHit[]>();
    const stepHits = [...byComponent.values()]
      .flat()
      .filter((h) => d.memoryIds.includes(h.memoryId));
    return stepHits.map((h) => ({
      memoryId: h.memoryId,
      step: h.patternStep,
      component: h.component,
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
    stopConditions.push(
      "sufficient verified memory covers all steps — no fresh research needed",
    );
  }
  const excludedScope: string[] = [];
  if (capabilityCeilingHit) {
    const note = `capability ceiling reached: plan would need ${desiredMode}, entitlement allows only ${capabilityAtStart}`;
    stopConditions.push(note);
    // Заполняется ВСЕГДА для заблокированной работы, независимо от того,
    // сколько шагов уже закрыто (D-058 regression: DEMO + 1 satisfied +
    // 7 MISSING всё ещё обязан упереться в потолок capability).
    for (const d of [...requiredFresh, ...missing]) {
      excludedScope.push(
        `step ${d.step} (${d.stepName}): not researched — ${note}`,
      );
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
  const memoryUsed =
    memoryEnabled && satisfied.length + requiredFresh.length > 0;

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
