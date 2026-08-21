import { describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import { planResearch } from "../src/server/memory/planner";
import type { RetrievalHit } from "../src/server/memory/retrieval-gateway";

const NOW = new Date("2026-08-21T00:00:00Z");

function componentFor(patternStep: number): string {
  return PATTERN_V1_CONTENT.steps.find((s) => s.step === patternStep)!
    .requiredComponents[0];
}

function hit(
  overrides: Partial<RetrievalHit> & Pick<RetrievalHit, "patternStep">,
): RetrievalHit {
  return {
    memoryId: `mem_${overrides.patternStep}_${Math.random().toString(36).slice(2, 6)}`,
    component: componentFor(overrides.patternStep),
    claimKey: `claim_${overrides.patternStep}`,
    statement: `statement for step ${overrides.patternStep}`,
    mechanismState: null,
    freshnessClass: "MEDIUM_CHANGE",
    verifiedAt: NOW,
    dataAsOf: null,
    staleAfterSeconds: null,
    confidence: 90,
    health: "OK",
    matchedVia: "ontology",
    ...overrides,
  };
}

// Полное покрытие шага — по одному hit'у на КАЖДЫЙ requiredComponent (не
// только первый): шаги 3 и 6 требуют 2 компонента (D-060), одного hit'а
// недостаточно, чтобы стать ALREADY_SATISFIED.
function fullCoverageHits(confidence: number): RetrievalHit[] {
  return PATTERN_V1_CONTENT.steps.flatMap((s) =>
    s.requiredComponents.map((component) =>
      hit({ patternStep: s.step, component, confidence }),
    ),
  );
}

const budget = DEFAULT_PRODUCT_CONFIG.budget_core;

describe("Фаза 5 — deterministic planner (unit, без БД)", () => {
  it("1. память выключена: все шаги MISSING, FRESH_RESEARCH, memoryUsed=false", () => {
    const r = planResearch({
      memoryEnabled: false,
      hits: [hit({ patternStep: 1 })], // даже если бы что-то нашлось — не используется
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.contract.missingSteps.length).toBe(8);
    expect(r.mode).toBe("FRESH_RESEARCH");
    expect(r.memoryUsed).toBe(false);
    expect(
      r.contract.stepDecisions.every((d) => d.decision === "MISSING"),
    ).toBe(true);
  });

  it("2. все 8 шагов свежо и уверенно покрыты: MEMORY, novelty=KNOWN, стоп-условие есть", () => {
    const hits = fullCoverageHits(95);
    const r = planResearch({
      memoryEnabled: true,
      hits,
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.mode).toBe("MEMORY");
    expect(r.contract.noveltyState).toBe("KNOWN");
    expect(r.contract.alreadySatisfiedSteps.length).toBe(8);
    expect(r.contract.stopConditions.length).toBeGreaterThan(0);
    expect(r.memoryUsed).toBe(true);
  });

  it("3. REUSE DOES NOT OVERRIDE FRESHNESS: просроченный факт уходит в REQUIRED_FRESH, не ALREADY_SATISFIED", () => {
    const staleDate = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000); // за пределами HIGH_CHANGE и MEDIUM_CHANGE
    const r = planResearch({
      memoryEnabled: true,
      hits: [
        hit({
          patternStep: 5,
          freshnessClass: "HIGH_CHANGE",
          verifiedAt: staleDate,
          confidence: 99,
        }),
      ],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const step5 = r.contract.stepDecisions.find((d) => d.step === 5)!;
    expect(step5.decision).toBe("REQUIRED_FRESH");
    expect(r.contract.alreadySatisfiedSteps).not.toContain(5);
    expect(r.contract.requiredFreshEvidence).toContain(5);
    // Высокая уверенность НЕ спасает просроченный факт.
    expect(step5.reason).toMatch(/stale|reverif/i);
  });

  it("4. низкая уверенность ниже порога reuse тоже не закрывает шаг", () => {
    const r = planResearch({
      memoryEnabled: true,
      hits: [hit({ patternStep: 2, confidence: 10 })], // ниже memory_min_confidence_reuse (70)
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const step2 = r.contract.stepDecisions.find((d) => d.step === 2)!;
    expect(step2.decision).toBe("REQUIRED_FRESH");
  });

  it("5. частичное покрытие с оставшимися MISSING шагами: FRESH_RESEARCH (D-058), novelty=PARTIALLY_KNOWN", () => {
    // 2 шага закрыты, 6 остаются MISSING -> по D-058 это ВСЁ ЕЩЁ
    // FRESH_RESEARCH (не TARGETED_REFRESH): TARGETED_REFRESH требует ноль
    // MISSING, только REQUIRED_FRESH. already_satisfied_steps остаются
    // закрытыми независимо от режима — это и проверяем.
    const r = planResearch({
      memoryEnabled: true,
      hits: [
        hit({ patternStep: 1, confidence: 95 }),
        hit({ patternStep: 2, confidence: 95 }),
      ],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.mode).toBe("FRESH_RESEARCH");
    expect(r.contract.noveltyState).toBe("PARTIALLY_KNOWN");
    expect(r.contract.alreadySatisfiedSteps).toEqual([1, 2]);
    expect(r.contract.missingSteps.length).toBe(6);
  });

  it("5a. D-058: ноль MISSING, но есть REQUIRED_FRESH -> TARGETED_REFRESH, already_satisfied остаются закрытыми", () => {
    // Все 8 шагов покрыты памятью, но один компонент (CURRENT_STATE, шаг 5)
    // просрочен -> REQUIRED_FRESH. missing.length===0 -> TARGETED_REFRESH,
    // НЕ FRESH_RESEARCH — старый баг ("FRESH_RESEARCH означает выбросить
    // всю память") здесь бы ошибочно потребовал пересследовать все 8 шагов;
    // already_satisfied_steps (все, кроме 5) обязаны остаться закрытыми.
    const staleDate = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    const hits = fullCoverageHits(95).map((h) =>
      h.patternStep === 5 ? { ...h, freshnessClass: "HIGH_CHANGE" as const, verifiedAt: staleDate } : h,
    );
    const r = planResearch({
      memoryEnabled: true,
      hits,
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.contract.missingSteps.length).toBe(0);
    expect(r.contract.requiredFreshEvidence).toEqual([5]);
    expect(r.mode).toBe("TARGETED_REFRESH");
    expect(r.contract.alreadySatisfiedSteps.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7, 8]);
  });

  it("6. потолок capability_at_start не может быть превышен — честная граница, не имитация", () => {
    // Ничего не найдено -> desiredMode = FRESH_RESEARCH, но DEMO ограничен TARGETED_REFRESH.
    const r = planResearch({
      memoryEnabled: true,
      hits: [],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "TARGETED_REFRESH",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.desiredMode).toBe("FRESH_RESEARCH");
    expect(r.mode).toBe("TARGETED_REFRESH"); // зажато потолком
    expect(r.capabilityCeilingHit).toBe(true);
    expect(
      r.contract.stopConditions.some((s) => s.includes("capability ceiling")),
    ).toBe(true);
    expect(r.contract.excludedScope.length).toBeGreaterThan(0);
  });

  it("7. потолок не срабатывает, когда desired mode уже внутри потолка", () => {
    const r = planResearch({
      memoryEnabled: true,
      hits: fullCoverageHits(95),
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "MEMORY",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.capabilityCeilingHit).toBe(false);
    expect(r.mode).toBe("MEMORY");
  });

  it("8. объяснимость: каждый шаг несёт детерминированную причину и корректные memoryIds", () => {
    const h = hit({ patternStep: 4, confidence: 95 });
    const r = planResearch({
      memoryEnabled: true,
      hits: [h],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    for (const d of r.contract.stepDecisions) {
      expect(d.reason.length).toBeGreaterThan(0);
    }
    const step4 = r.contract.stepDecisions.find((d) => d.step === 4)!;
    expect(step4.memoryIds).toEqual([h.memoryId]);
    expect(r.contract.reusableEvidence[0].memoryId).toBe(h.memoryId);
  });

  it("9. бюджет — прогноз экономии, не хардкод: полностью покрытый план урезает бюджет сильнее частичного", () => {
    const empty = planResearch({
      memoryEnabled: true,
      hits: [],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const full = planResearch({
      memoryEnabled: true,
      hits: fullCoverageHits(95),
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(full.contract.researchBudget.maxSearchQueries).toBeLessThan(
      empty.contract.researchBudget.maxSearchQueries,
    );
    expect(empty.contract.researchBudget.maxSearchQueries).toBe(
      budget.maxSearchQueries,
    );
  });

  it("10. D-060: частичное покрытие многокомпонентного шага (3) — REQUIRED_FRESH, не ALREADY_SATISFIED", () => {
    const r = planResearch({
      memoryEnabled: true,
      // Только MECHANISM_SPEC покрыт, GOVERNANCE_BASIS — нет.
      hits: [
        hit({ patternStep: 3, component: "MECHANISM_SPEC", confidence: 95 }),
      ],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const step3 = r.contract.stepDecisions.find((d) => d.step === 3)!;
    expect(step3.decision).toBe("REQUIRED_FRESH");
    expect(step3.reason).toMatch(/GOVERNANCE_BASIS/);
    expect(r.contract.alreadySatisfiedSteps).not.toContain(3);
  });

  it("11. D-059: health не OK (QUESTIONABLE/REVERIFY/STALE) не закрывает шаг, но остаётся видимым (не MISSING)", () => {
    const r = planResearch({
      memoryEnabled: true,
      hits: [hit({ patternStep: 2, confidence: 95, health: "QUESTIONABLE" })],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const step2 = r.contract.stepDecisions.find((d) => d.step === 2)!;
    expect(step2.decision).toBe("REQUIRED_FRESH");
    expect(r.contract.missingSteps).not.toContain(2);
  });

  it("12. D-059: health DEPRECATED — планировщик не закрывает шаг этим hit'ом, даже если он как-то дошёл до входа", () => {
    const r = planResearch({
      memoryEnabled: true,
      hits: [hit({ patternStep: 2, confidence: 95, health: "DEPRECATED" })],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const step2 = r.contract.stepDecisions.find((d) => d.step === 2)!;
    expect(step2.decision).toBe("MISSING");
  });

  it("13. D-062: конфликтующий mechanism_state в одном компоненте — CONTRADICTED, REQUIRED_FRESH, memoryIds аудируемы", () => {
    const a = hit({
      patternStep: 3,
      component: "MECHANISM_SPEC",
      confidence: 95,
      mechanismState: "BUYBACK_ONLY",
    });
    const b = hit({
      patternStep: 3,
      component: "MECHANISM_SPEC",
      confidence: 95,
      mechanismState: "BUYBACK_AND_BURN",
    });
    const gov = hit({
      patternStep: 3,
      component: "GOVERNANCE_BASIS",
      confidence: 95,
    });
    const r = planResearch({
      memoryEnabled: true,
      hits: [a, b, gov],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const step3 = r.contract.stepDecisions.find((d) => d.step === 3)!;
    expect(step3.decision).toBe("REQUIRED_FRESH");
    expect(step3.reason).toMatch(/CONTRADICTED/);
    expect(step3.memoryIds).toEqual(
      expect.arrayContaining([a.memoryId, b.memoryId]),
    );
    expect(r.contract.alreadySatisfiedSteps).not.toContain(3);
  });

  it("14. D-058 regression: DEMO, 1 из 8 шагов закрыт, 7 MISSING — всё равно FRESH_RESEARCH и потолок", () => {
    const r = planResearch({
      memoryEnabled: true,
      hits: [hit({ patternStep: 1, confidence: 95 })],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "TARGETED_REFRESH", // DEMO
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.contract.alreadySatisfiedSteps).toEqual([1]);
    expect(r.contract.missingSteps.length).toBe(7);
    expect(r.desiredMode).toBe("FRESH_RESEARCH");
    expect(r.capabilityCeilingHit).toBe(true);
    expect(r.mode).toBe("TARGETED_REFRESH");
    // excludedScope обязан покрывать заблокированную работу независимо от
    // того, что шаг 1 уже закрыт (D-058 — старый баг требовал satisfied=0).
    expect(r.contract.excludedScope.length).toBe(7);
  });

  it("15. L-1: детерминированный tie-break по id при равной уверенности (планировщик — по позиции входа, gateway — ORDER BY … , id)", () => {
    // На уровне планировщика детерминизм для равного confidence проверяется
    // тем, что memoryIds сохраняют порядок входного массива hits — здесь
    // фиксируем этот контракт явно, чтобы регресс не прошёл незаметно.
    const a = hit({ patternStep: 1, confidence: 90, memoryId: "aaa" });
    const b = hit({ patternStep: 1, confidence: 90, memoryId: "bbb" });
    const r = planResearch({
      memoryEnabled: true,
      hits: [a, b],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    const step1 = r.contract.stepDecisions.find((d) => d.step === 1)!;
    expect(step1.memoryIds).toEqual(["aaa", "bbb"]);
  });
});
