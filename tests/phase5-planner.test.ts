import { describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import { PATTERN_V1_CONTENT, requiredComponentsForStep } from "../src/server/domain/pattern";
import { planResearch } from "../src/server/memory/planner";
import type { RetrievalHit } from "../src/server/memory/retrieval-gateway";

const NOW = new Date("2026-08-21T00:00:00Z");

const PRIMARY_COMPONENT: Record<number, string> = {
  1: "SOURCE_OF_VALUE",
  2: "FLOW_PATH",
  3: "MECHANISM_SPEC",
  4: "EXECUTION_EVIDENCE",
  5: "CURRENT_STATE",
  6: "DESTINATION",
  7: "NET_EFFECT",
  8: "DURABILITY_BASIS",
};

let hitSeq = 0;
function hit(overrides: Partial<RetrievalHit> & Pick<RetrievalHit, "patternStep">): RetrievalHit {
  hitSeq += 1;
  return {
    memoryId: `mem_${overrides.patternStep}_${hitSeq}`,
    component: PRIMARY_COMPONENT[overrides.patternStep],
    claimKey: `claim_${overrides.patternStep}`,
    statement: `statement for step ${overrides.patternStep}`,
    mechanismState: null,
    health: "OK",
    freshnessClass: "MEDIUM_CHANGE",
    verifiedAt: NOW,
    dataAsOf: null,
    staleAfterSeconds: null,
    confidence: 90,
    matchedVia: "ontology",
    ...overrides,
  };
}

// Полное покрытие по D-060: hit на КАЖДЫЙ компонент каждого шага
// (10 записей, а не 8 — шаги 3 и 6 многокомпонентны).
function fullCoverageHits(confidence = 95): RetrievalHit[] {
  return PATTERN_V1_CONTENT.steps.flatMap((s) =>
    requiredComponentsForStep(PATTERN_V1_CONTENT, s.step).map((component) =>
      hit({ patternStep: s.step, component, confidence }),
    ),
  );
}

const budget = DEFAULT_PRODUCT_CONFIG.budget_core;

function plan(hits: RetrievalHit[], overrides: Partial<Parameters<typeof planResearch>[0]> = {}) {
  return planResearch({
    memoryEnabled: true,
    hits,
    pattern: PATTERN_V1_CONTENT,
    capabilityAtStart: "FRESH_RESEARCH",
    budgetAtStart: budget,
    config: DEFAULT_PRODUCT_CONFIG,
    now: NOW,
    ...overrides,
  });
}

describe("Фаза 5 — deterministic planner (unit, без БД)", () => {
  it("1. память выключена: все шаги MISSING, FRESH_RESEARCH, memoryUsed=false", () => {
    const r = plan([hit({ patternStep: 1 })], { memoryEnabled: false });
    expect(r.contract.missingSteps.length).toBe(8);
    expect(r.mode).toBe("FRESH_RESEARCH");
    expect(r.memoryUsed).toBe(false);
    expect(r.contract.stepDecisions.every((d) => d.decision === "MISSING")).toBe(true);
  });

  it("2. все компоненты всех 8 шагов свежо и уверенно покрыты: MEMORY, novelty=KNOWN, стоп-условие есть", () => {
    const r = plan(fullCoverageHits());
    expect(r.mode).toBe("MEMORY");
    expect(r.contract.noveltyState).toBe("KNOWN");
    expect(r.contract.alreadySatisfiedSteps.length).toBe(8);
    expect(r.contract.stopConditions.length).toBeGreaterThan(0);
    expect(r.memoryUsed).toBe(true);
  });

  it("3. REUSE DOES NOT OVERRIDE FRESHNESS: просроченный факт уходит в REQUIRED_FRESH, не ALREADY_SATISFIED", () => {
    const staleDate = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000); // за пределами HIGH_CHANGE и MEDIUM_CHANGE
    const r = plan([
      hit({ patternStep: 5, freshnessClass: "HIGH_CHANGE", verifiedAt: staleDate, confidence: 99 }),
    ]);
    const step5 = r.contract.stepDecisions.find((d) => d.step === 5)!;
    expect(step5.decision).toBe("REQUIRED_FRESH");
    expect(r.contract.alreadySatisfiedSteps).not.toContain(5);
    expect(r.contract.requiredFreshEvidence).toContain(5);
    // Высокая уверенность НЕ спасает просроченный факт.
    expect(step5.reason).toMatch(/stale|reverif/i);
  });

  it("4. низкая уверенность ниже порога reuse тоже не закрывает шаг", () => {
    const r = plan([hit({ patternStep: 2, confidence: 10 })]); // ниже memory_min_confidence_reuse (70)
    const step2 = r.contract.stepDecisions.find((d) => d.step === 2)!;
    expect(step2.decision).toBe("REQUIRED_FRESH");
    expect(step2.components[0].blockers).toContain("LOW_CONFIDENCE");
  });

  it("5. частичное покрытие шагов: D-058 — оставшиеся MISSING дают FRESH_RESEARCH, novelty=PARTIALLY_KNOWN", () => {
    const r = plan([hit({ patternStep: 1, confidence: 95 }), hit({ patternStep: 2, confidence: 95 })]);
    // D-058: режим описывает ТИП оставшейся работы. 6 шагов подлинно
    // MISSING -> нужен FRESH_RESEARCH (прежняя логика давала TARGETED_REFRESH
    // от одного закрытого шага — ровно дефект HIGH-1).
    expect(r.desiredMode).toBe("FRESH_RESEARCH");
    expect(r.mode).toBe("FRESH_RESEARCH");
    expect(r.contract.noveltyState).toBe("PARTIALLY_KNOWN");
    // ...но закрытые шаги ОСТАЮТСЯ закрытыми: FRESH_RESEARCH не значит
    // «выбросить память» — объём работы описывает контракт.
    expect(r.contract.alreadySatisfiedSteps).toEqual([1, 2]);
    expect(r.contract.missingSteps.length).toBe(6);
  });

  it("6. потолок capability_at_start не может быть превышен — честная граница, не имитация", () => {
    // Ничего не найдено -> desiredMode = FRESH_RESEARCH, но DEMO ограничен TARGETED_REFRESH.
    const r = plan([], {
      capabilityAtStart: "TARGETED_REFRESH",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
    });
    expect(r.desiredMode).toBe("FRESH_RESEARCH");
    expect(r.mode).toBe("TARGETED_REFRESH"); // зажато потолком
    expect(r.capabilityCeilingHit).toBe(true);
    expect(r.contract.stopConditions.some((s) => s.includes("capability ceiling"))).toBe(true);
    expect(r.contract.excludedScope.length).toBeGreaterThan(0);
  });

  it("7. потолок не срабатывает, когда desired mode уже внутри потолка", () => {
    const r = plan(fullCoverageHits(), {
      capabilityAtStart: "MEMORY",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
    });
    expect(r.capabilityCeilingHit).toBe(false);
    expect(r.mode).toBe("MEMORY");
  });

  it("8. объяснимость: каждый шаг несёт детерминированную причину и корректные memoryIds", () => {
    const h = hit({ patternStep: 4, confidence: 95 });
    const r = plan([h]);
    for (const d of r.contract.stepDecisions) {
      expect(d.reason.length).toBeGreaterThan(0);
    }
    const step4 = r.contract.stepDecisions.find((d) => d.step === 4)!;
    expect(step4.memoryIds).toEqual([h.memoryId]);
    expect(r.contract.reusableEvidence[0].memoryId).toBe(h.memoryId);
    expect(r.contract.reusableEvidence[0].component).toBe("EXECUTION_EVIDENCE");
  });

  it("9. бюджет — прогноз экономии, не хардкод: полностью покрытый план урезает бюджет сильнее частичного", () => {
    const empty = plan([]);
    const full = plan(fullCoverageHits());
    expect(full.contract.researchBudget.maxSearchQueries).toBeLessThan(
      empty.contract.researchBudget.maxSearchQueries,
    );
    expect(empty.contract.researchBudget.maxSearchQueries).toBe(budget.maxSearchQueries);
  });

  it("10. D-058 (обязательная регрессия HIGH-1): DEMO, 1 закрыт + 7 MISSING -> граница доступа СРАБАТЫВАЕТ", () => {
    const r = plan([hit({ patternStep: 1, confidence: 95 })], {
      capabilityAtStart: "TARGETED_REFRESH", // потолок DEMO
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
    });
    expect(r.contract.alreadySatisfiedSteps).toEqual([1]);
    expect(r.contract.missingSteps.length).toBe(7);
    // Желаемый режим — FRESH_RESEARCH (есть подлинно MISSING шаги)...
    expect(r.desiredMode).toBe("FRESH_RESEARCH");
    // ...и потолок DEMO обязан сработать, а не молчать из-за одного
    // закрытого шага (прежнее поведение: TARGETED_REFRESH, 0 excludedScope).
    expect(r.capabilityCeilingHit).toBe(true);
    expect(r.mode).toBe("TARGETED_REFRESH");
    expect(r.contract.excludedScope.length).toBe(7); // все 7 непокрытых шагов честно исключены
    expect(r.contract.stopConditions.some((s) => s.includes("capability ceiling"))).toBe(true);
  });

  it("11. D-059: QUESTIONABLE/REVERIFY/STALE извлечены, направляют перепроверку, но шаг НЕ закрывают", () => {
    for (const health of ["QUESTIONABLE", "REVERIFY", "STALE"] as const) {
      const h = hit({ patternStep: 2, health, confidence: 95 });
      const r = plan([h]);
      const step2 = r.contract.stepDecisions.find((d) => d.step === 2)!;
      expect(step2.decision, health).toBe("REQUIRED_FRESH");
      expect(r.contract.alreadySatisfiedSteps, health).not.toContain(2);
      // Память видна плану (направляет перепроверку) — не выброшена.
      expect(step2.memoryIds, health).toContain(h.memoryId);
      expect(step2.components[0].blockers, health).toContain(`HEALTH_${health}`);
    }
  });

  it("12. D-059: непустое health != OK не создаёт ALREADY_SATISFIED даже при свежести и уверенности 99", () => {
    const r = plan([
      hit({ patternStep: 5, health: "STALE", confidence: 99, verifiedAt: NOW }),
    ]);
    expect(r.contract.alreadySatisfiedSteps).toEqual([]);
    expect(r.contract.requiredFreshEvidence).toEqual([5]);
  });

  it("13. D-062: конфликт mechanism_state внутри (шаг, компонент) -> REQUIRED_FRESH с CONTRADICTED и предъявимыми memoryId", () => {
    const a = hit({ patternStep: 5, mechanismState: "ACTIVE", confidence: 95 });
    const b = hit({ patternStep: 5, mechanismState: "PAUSED", confidence: 93 });
    const r = plan([a, b]);
    const step5 = r.contract.stepDecisions.find((d) => d.step === 5)!;
    expect(step5.decision).toBe("REQUIRED_FRESH");
    expect(step5.reason).toContain("CONTRADICTED");
    const comp = step5.components.find((c) => c.component === "CURRENT_STATE")!;
    expect(comp.state).toBe("CONTRADICTED");
    expect(comp.conflictingMemoryIds.sort()).toEqual([a.memoryId, b.memoryId].sort());
    expect(r.contract.alreadySatisfiedSteps).not.toContain(5);
  });

  it("14. D-062, граница правила: одинаковый mechanism_state и расхождение только текста — НЕ конфликт", () => {
    const a = hit({ patternStep: 5, mechanismState: "ACTIVE", statement: "mechanism is running", confidence: 95 });
    const b = hit({ patternStep: 5, mechanismState: "ACTIVE", statement: "the buyback machine operates", confidence: 93 });
    const r = plan([a, b]);
    const step5 = r.contract.stepDecisions.find((d) => d.step === 5)!;
    expect(step5.decision).toBe("ALREADY_SATISFIED"); // парафраз — не противоречие
  });

  it("15. D-062: просроченная запись не участвует в конфликте — health и свежесть фильтруются ДО проверки противоречия", () => {
    const staleDate = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    const fresh = hit({ patternStep: 5, mechanismState: "ACTIVE", confidence: 95 });
    const stale = hit({
      patternStep: 5,
      mechanismState: "PAUSED",
      freshnessClass: "HIGH_CHANGE",
      verifiedAt: staleDate,
      confidence: 95,
    });
    const r = plan([fresh, stale]);
    const step5 = r.contract.stepDecisions.find((d) => d.step === 5)!;
    // Конфликт образуют только «прочие равные» записи (прошедшие health и
    // свежесть) — устаревший PAUSED не отменяет свежий ACTIVE.
    expect(step5.decision).toBe("ALREADY_SATISFIED");
    expect(step5.components[0].conflictingMemoryIds).toEqual([]);
  });

  it("16. D-060: частичное покрытие многокомпонентного шага -> REQUIRED_FRESH с перечислением непокрытых компонентов", () => {
    const r = plan([
      hit({ patternStep: 3, component: "MECHANISM_SPEC", confidence: 95 }),
      hit({ patternStep: 6, component: "DESTINATION", confidence: 95 }),
    ]);
    const step3 = r.contract.stepDecisions.find((d) => d.step === 3)!;
    expect(step3.decision).toBe("REQUIRED_FRESH");
    expect(step3.reason).toContain("GOVERNANCE_BASIS");
    expect(step3.components.find((c) => c.component === "GOVERNANCE_BASIS")!.state).toBe("NO_MEMORY");
    expect(step3.components.find((c) => c.component === "MECHANISM_SPEC")!.state).toBe("SATISFIED");

    const step6 = r.contract.stepDecisions.find((d) => d.step === 6)!;
    expect(step6.decision).toBe("REQUIRED_FRESH");
    expect(step6.reason).toContain("RECIPIENT");
    expect(r.contract.alreadySatisfiedSteps).toEqual([]);
  });

  it("17. D-060: полное покрытие многокомпонентного шага обоими компонентами закрывает шаг", () => {
    const r = plan([
      hit({ patternStep: 3, component: "MECHANISM_SPEC", confidence: 95 }),
      hit({ patternStep: 3, component: "GOVERNANCE_BASIS", confidence: 92 }),
    ]);
    const step3 = r.contract.stepDecisions.find((d) => d.step === 3)!;
    expect(step3.decision).toBe("ALREADY_SATISFIED");
    expect(r.contract.alreadySatisfiedSteps).toEqual([3]);
    expect(r.contract.reusableEvidence.map((e) => e.component).sort()).toEqual([
      "GOVERNANCE_BASIS",
      "MECHANISM_SPEC",
    ]);
  });

  it("18. MEDIUM-1: политика '36 hours' считается целиком — запись 20 часов от роду свежа, 48 часов — просрочена", () => {
    const staleAfterSeconds = 36 * 60 * 60;
    const fresh20h = hit({
      patternStep: 5,
      verifiedAt: new Date(NOW.getTime() - 20 * 60 * 60 * 1000),
      staleAfterSeconds,
      freshnessClass: "LOW_CHANGE",
      confidence: 95,
    });
    const r1 = plan([fresh20h]);
    expect(r1.contract.alreadySatisfiedSteps).toEqual([5]);

    const stale48h = hit({
      patternStep: 5,
      verifiedAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
      staleAfterSeconds,
      // LOW_CHANGE фолбэк (180 дней) счёл бы её свежей — явная политика
      // записи не подменяется молча более щадящим конфигом.
      freshnessClass: "LOW_CHANGE",
      confidence: 95,
    });
    const r2 = plan([stale48h]);
    expect(r2.contract.alreadySatisfiedSteps).toEqual([]);
    expect(r2.contract.requiredFreshEvidence).toEqual([5]);
  });

  it("20. D-058, средняя ветвь: missing=0 и requiredFresh>0 -> TARGETED_REFRESH (выведен из памяти, не зажат потолком)", () => {
    // Канонический пример plan §4.3: всё покрыто, просрочен ТОЛЬКО
    // динамический шаг 5 — исследуется только он. Ни FRESH_RESEARCH
    // (MISSING-шагов нет), ни MEMORY (свежесть не отменяется
    // переиспользованием, D-057).
    const hits = fullCoverageHits().map((h) =>
      h.patternStep === 5
        ? {
            ...h,
            freshnessClass: "HIGH_CHANGE" as const,
            verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
          }
        : h,
    );
    const r = plan(hits);
    expect(r.contract.missingSteps).toEqual([]);
    expect(r.contract.requiredFreshEvidence).toEqual([5]);
    expect(r.contract.alreadySatisfiedSteps).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(r.desiredMode).toBe("TARGETED_REFRESH");
    expect(r.mode).toBe("TARGETED_REFRESH");
    expect(r.capabilityCeilingHit).toBe(false); // режим выведен памятью, потолок ни при чём
    expect(r.contract.noveltyState).toBe("PARTIALLY_KNOWN");
  });

  it("19. MEDIUM-1: политика '3 months' сохраняет смысл — запись 30 дней от роду с HIGH_CHANGE-классом свежа", () => {
    const r = plan([
      hit({
        patternStep: 8,
        verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
        staleAfterSeconds: 90 * 24 * 60 * 60, // '3 months' по правилам Postgres (30 дней/месяц)
        freshnessClass: "HIGH_CHANGE", // фолбэк класса — 3 дня; явная политика записи главнее
        confidence: 95,
      }),
    ]);
    expect(r.contract.alreadySatisfiedSteps).toEqual([8]);
  });
});
