import {
  PATTERN_STEP_NAMES,
  requiredComponentsForStep,
  type PatternContent,
} from "../domain/pattern";
import type { JobBudgetConfig, ProductConfig } from "../config/product";
import type { ResearchCapability } from "../domain/types";
import type { RetrievalHit } from "./retrieval-gateway";
import type {
  ComponentDecision,
  ResearchBoundaryContract,
  StepDecision,
} from "./contract";

// Детерминированный планировщик (D-052, phase-5-plan.md §4). Чистая
// функция: раскладка памяти по шагам и компонентам решает код, не модель.
// Воспроизводимо, объяснимо (stepDecisions[].reason + components[]),
// не зависит от провайдера.

const CAPABILITY_RANK: Record<ResearchCapability, number> = {
  MEMORY: 0,
  TARGETED_REFRESH: 1,
  FRESH_RESEARCH: 2,
};

// MEDIUM-1: интервал считается целиком, в секундах. Фолбэк из конфига —
// ТОЛЬКО когда запись не несёт собственного stale_after (NULL); явно
// сохранённая политика записи никогда молча не подменяется.
function effectiveStaleAfterSeconds(
  hit: RetrievalHit,
  config: Pick<ProductConfig, "memory_stale_after_days">,
): number {
  return (
    hit.staleAfterSeconds ??
    config.memory_stale_after_days[hit.freshnessClass] * 24 * 60 * 60
  );
}

// REUSE DOES NOT OVERRIDE FRESHNESS (§4.4) — единственное место, где это
// решается, чистая функция времени и конфига, без места для интерпретации.
export function isStale(hit: RetrievalHit, now: Date, config: ProductConfig): boolean {
  const ageMs = now.getTime() - hit.verifiedAt.getTime();
  return ageMs > effectiveStaleAfterSeconds(hit, config) * 1000;
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

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

// Решение по одному компоненту шага (D-059, D-060, D-062).
// Закрывать компонент может только health='OK', свежая и достаточно
// уверенная память без конфликта mechanism_state; всё остальное —
// направляет перепроверку, но компонент не закрывает.
function decideComponent(
  component: string,
  stepHits: RetrievalHit[],
  now: Date,
  config: ProductConfig,
): ComponentDecision {
  const cHits = stepHits.filter((h) => h.component === component);
  if (cHits.length === 0) {
    return { component, state: "NO_MEMORY", blockers: [], memoryIds: [], conflictingMemoryIds: [] };
  }

  const reusable = cHits.filter(
    (h) =>
      h.health === "OK" &&
      !isStale(h, now, config) &&
      h.confidence >= config.memory_min_confidence_reuse,
  );

  if (reusable.length > 0) {
    // D-062: конфликт только среди записей, прошедших health и свежесть.
    // Обнаруживается конфликт СОСТОЯНИЙ (различный machine-readable
    // mechanism_state); расхождение свободного текста statement конфликтом
    // не считается (парафраз).
    const distinctStates = new Set(
      reusable
        .map((h) => h.mechanismState)
        .filter((s): s is string => s !== null),
    );
    if (distinctStates.size > 1) {
      return {
        component,
        state: "CONTRADICTED",
        blockers: [],
        memoryIds: unique(cHits.map((h) => h.memoryId)),
        conflictingMemoryIds: unique(
          reusable.filter((h) => h.mechanismState !== null).map((h) => h.memoryId),
        ),
      };
    }
    return {
      component,
      state: "SATISFIED",
      blockers: [],
      memoryIds: unique(reusable.map((h) => h.memoryId)),
      conflictingMemoryIds: [],
    };
  }

  // Память есть, но закрывать компонент не может — blockers объясняют
  // почему (аудируемость, D-052/D-061).
  const blockers = new Set<string>();
  for (const h of cHits) {
    if (h.health !== "OK") blockers.add(`HEALTH_${h.health}`);
    if (isStale(h, now, config)) blockers.add("STALE");
    if (h.confidence < config.memory_min_confidence_reuse) blockers.add("LOW_CONFIDENCE");
  }
  return {
    component,
    state: "UNUSABLE",
    blockers: [...blockers].sort(),
    memoryIds: unique(cHits.map((h) => h.memoryId)),
    conflictingMemoryIds: [],
  };
}

function describeComponentProblem(c: ComponentDecision): string {
  if (c.state === "NO_MEMORY") return `${c.component}: no memory`;
  if (c.state === "CONTRADICTED") {
    return `${c.component}: CONTRADICTED — active memory records disagree on mechanism_state (${c.conflictingMemoryIds.join(", ")})`;
  }
  return `${c.component}: unusable (${c.blockers.join(", ")})`;
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
    const required = requiredComponentsForStep(pattern, step.step);

    // Ни одна извлекаемая запись не касается шага — подлинно MISSING.
    // (DEPRECATED не доезжает сюда вовсе — исключён retrieval'ом, D-059:
    // шаг, чьё единственное знание признано неверным, становится MISSING.)
    if (stepHits.length === 0) {
      return {
        step: step.step,
        stepName: step.name,
        decision: "MISSING" as const,
        reason: memoryEnabled
          ? "no active memory for this step"
          : "memory disabled for this run (memory_enabled=false)",
        memoryIds: [],
        components: required.map((component) => ({
          component,
          state: "NO_MEMORY" as const,
          blockers: [],
          memoryIds: [],
          conflictingMemoryIds: [],
        })),
      };
    }

    const components = required.map((c) => decideComponent(c, stepHits, now, config));

    // D-060: шаг закрыт только когда КАЖДЫЙ его компонент покрыт пригодной
    // памятью. Частичное покрытие → REQUIRED_FRESH с перечислением
    // непокрытых/непригодных компонентов.
    if (components.every((c) => c.state === "SATISFIED")) {
      const ids = unique(components.flatMap((c) => c.memoryIds));
      const topConfidence = Math.max(
        ...stepHits.filter((h) => ids.includes(h.memoryId)).map((h) => h.confidence),
      );
      return {
        step: step.step,
        stepName: step.name,
        decision: "ALREADY_SATISFIED" as const,
        reason: `all required components (${required.join(", ")}) covered by healthy active memory (top confidence ${topConfidence}%, within freshness window)`,
        memoryIds: ids,
        components,
      };
    }

    const problems = components.filter((c) => c.state !== "SATISFIED");
    return {
      step: step.step,
      stepName: step.name,
      decision: "REQUIRED_FRESH" as const,
      reason: `memory informs this step but cannot satisfy it — ${problems.map(describeComponentProblem).join("; ")} — fresh verification required, memory guides where to look`,
      memoryIds: unique(stepHits.map((h) => h.memoryId)),
      components,
    };
  });

  const satisfied = stepDecisions.filter((d) => d.decision === "ALREADY_SATISFIED");
  const requiredFresh = stepDecisions.filter((d) => d.decision === "REQUIRED_FRESH");
  const missing = stepDecisions.filter((d) => d.decision === "MISSING");

  // D-058: режим выводится из наличия MISSING-шагов, а не из числа
  // закрытых. FRESH_RESEARCH описывает ТИП оставшейся работы (нужны новые
  // доказательства) и НЕ отменяет already_satisfied_steps — объём работы
  // описывает контракт (Research Boundary Contract), не режим.
  const desiredMode: ResearchCapability =
    missing.length > 0
      ? "FRESH_RESEARCH"
      : requiredFresh.length > 0
        ? "TARGETED_REFRESH"
        : "MEMORY";

  const capabilityCeilingHit = CAPABILITY_RANK[desiredMode] > CAPABILITY_RANK[capabilityAtStart];
  const mode: ResearchCapability = capabilityCeilingHit ? capabilityAtStart : desiredMode;

  const reusableEvidence = satisfied.flatMap((d) => {
    const stepHits = hitsByStep.get(d.step) ?? [];
    return d.components.flatMap((c) =>
      c.memoryIds.flatMap((id) => {
        const h = stepHits.find((sh) => sh.memoryId === id);
        return h
          ? [
              {
                memoryId: h.memoryId,
                step: h.patternStep,
                component: h.component,
                claimKey: h.claimKey,
                statement: h.statement,
                confidence: h.confidence,
              },
            ]
          : [];
      }),
    );
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
  // D-058: при зажатии потолком excludedScope и stopConditions заполняются
  // ВСЕГДА — независимо от того, 0, 1 или несколько шагов уже закрыты.
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
