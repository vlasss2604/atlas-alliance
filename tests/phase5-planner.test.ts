import { describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import { planResearch } from "../src/server/memory/planner";
import type { RetrievalHit } from "../src/server/memory/retrieval-gateway";

const NOW = new Date("2026-08-21T00:00:00Z");

function hit(overrides: Partial<RetrievalHit> & Pick<RetrievalHit, "patternStep">): RetrievalHit {
  return {
    memoryId: `mem_${overrides.patternStep}_${Math.random().toString(36).slice(2, 6)}`,
    claimKey: `claim_${overrides.patternStep}`,
    statement: `statement for step ${overrides.patternStep}`,
    mechanismState: null,
    freshnessClass: "MEDIUM_CHANGE",
    verifiedAt: NOW,
    dataAsOf: null,
    staleAfterDays: null,
    confidence: 90,
    matchedVia: "ontology",
    ...overrides,
  };
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
    expect(r.contract.stepDecisions.every((d) => d.decision === "MISSING")).toBe(true);
  });

  it("2. все 8 шагов свежо и уверенно покрыты: MEMORY, novelty=KNOWN, стоп-условие есть", () => {
    const hits = PATTERN_V1_CONTENT.steps.map((s) => hit({ patternStep: s.step, confidence: 95 }));
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
        hit({ patternStep: 5, freshnessClass: "HIGH_CHANGE", verifiedAt: staleDate, confidence: 99 }),
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

  it("5. частичное покрытие: TARGETED_REFRESH, novelty=PARTIALLY_KNOWN", () => {
    const r = planResearch({
      memoryEnabled: true,
      hits: [hit({ patternStep: 1, confidence: 95 }), hit({ patternStep: 2, confidence: 95 })],
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(r.mode).toBe("TARGETED_REFRESH");
    expect(r.contract.noveltyState).toBe("PARTIALLY_KNOWN");
    expect(r.contract.alreadySatisfiedSteps).toEqual([1, 2]);
    expect(r.contract.missingSteps.length).toBe(6);
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
    expect(r.contract.stopConditions.some((s) => s.includes("capability ceiling"))).toBe(true);
    expect(r.contract.excludedScope.length).toBeGreaterThan(0);
  });

  it("7. потолок не срабатывает, когда desired mode уже внутри потолка", () => {
    const r = planResearch({
      memoryEnabled: true,
      hits: PATTERN_V1_CONTENT.steps.map((s) => hit({ patternStep: s.step, confidence: 95 })),
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
      hits: PATTERN_V1_CONTENT.steps.map((s) => hit({ patternStep: s.step, confidence: 95 })),
      pattern: PATTERN_V1_CONTENT,
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: budget,
      config: DEFAULT_PRODUCT_CONFIG,
      now: NOW,
    });
    expect(full.contract.researchBudget.maxSearchQueries).toBeLessThan(
      empty.contract.researchBudget.maxSearchQueries,
    );
    expect(empty.contract.researchBudget.maxSearchQueries).toBe(budget.maxSearchQueries);
  });
});
