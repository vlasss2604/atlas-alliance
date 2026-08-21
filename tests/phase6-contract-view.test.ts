import { describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import {
  PATTERN_V1_CONTENT,
  requiredComponentsForStep,
} from "../src/server/domain/pattern";
import {
  buildContractView,
  ContractDerivationMismatchError,
  ContractInvalidError,
} from "../src/server/engine/contract-view";
import { planResearch } from "../src/server/memory/planner";
import type { ResearchBoundaryContract } from "../src/server/memory/contract";
import type { RetrievalHit } from "../src/server/memory/retrieval-gateway";

// Phase 6, S0 — ContractView tests (phase-6-plan.md §19 S0: unit tests on
// frozen Phase 5 contracts, no network, no model). Reuses the exact
// fixture shape phase5-planner.test.ts uses, so these are genuinely the
// frozen Phase 5 output, not a hand-rolled approximation of it.

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
function hit(
  overrides: Partial<RetrievalHit> & Pick<RetrievalHit, "patternStep">,
): RetrievalHit {
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

function fullCoverageHits(confidence = 95): RetrievalHit[] {
  return PATTERN_V1_CONTENT.steps.flatMap((s) =>
    requiredComponentsForStep(PATTERN_V1_CONTENT, s.step).map((component) =>
      hit({ patternStep: s.step, component, confidence }),
    ),
  );
}

const budget = DEFAULT_PRODUCT_CONFIG.budget_core;

function plan(
  hits: RetrievalHit[],
  overrides: Partial<Parameters<typeof planResearch>[0]> = {},
) {
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

describe("Фаза 6, S0 — ContractView (типизированная проекция над Boundary Contract)", () => {
  it("1. смешанный шаг: SATISFIED + REQUIRED_FRESH-компонент — один переиспользуется, другой в очереди", () => {
    // Шаг 3 требует MECHANISM_SPEC + GOVERNANCE_BASIS (D-060). Здесь
    // MECHANISM_SPEC свежо покрыт, GOVERNANCE_BASIS — ниже порога
    // уверенности (unusable), не отсутствует вовсе.
    const r = plan([
      hit({ patternStep: 3, component: "MECHANISM_SPEC", confidence: 95 }),
      hit({ patternStep: 3, component: "GOVERNANCE_BASIS", confidence: 10 }),
    ]);
    const step3 = r.contract.stepDecisions.find((d) => d.step === 3)!;
    expect(step3.decision).toBe("REQUIRED_FRESH");

    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });

    expect(
      view.reused.some((c) => c.step === 3 && c.component === "MECHANISM_SPEC"),
    ).toBe(true);
    expect(
      view.workQueue.some(
        (c) =>
          c.step === 3 &&
          c.component === "GOVERNANCE_BASIS" &&
          c.state === "UNUSABLE",
      ),
    ).toBe(true);
    // Закрытый компонент НЕ попадает в очередь работы даже внутри
    // REQUIRED_FRESH шага (D-072).
    expect(
      view.workQueue.some(
        (c) => c.step === 3 && c.component === "MECHANISM_SPEC",
      ),
    ).toBe(false);
  });

  it("2. смешанный шаг: SATISFIED + компонент вовсе без памяти (NO_MEMORY)", () => {
    const r = plan([
      hit({ patternStep: 3, component: "MECHANISM_SPEC", confidence: 95 }),
    ]);
    const step3 = r.contract.stepDecisions.find((d) => d.step === 3)!;
    expect(step3.decision).toBe("REQUIRED_FRESH");

    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });

    expect(view.reused).toEqual([
      { step: 3, component: "MECHANISM_SPEC", memoryIds: expect.any(Array) },
    ]);
    const govItem = view.workQueue.find(
      (c) => c.step === 3 && c.component === "GOVERNANCE_BASIS",
    );
    expect(govItem?.state).toBe("NO_MEMORY");
  });

  it("3. excludedScope enforced: потолок capability исключает КОМПОНЕНТЫ незакрытых шагов из очереди", () => {
    // DEMO: capabilityAtStart=TARGETED_REFRESH, ничего не найдено ->
    // desiredMode=FRESH_RESEARCH -> потолок сработал.
    const r = plan([], {
      capabilityAtStart: "TARGETED_REFRESH",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
    });
    expect(r.capabilityCeilingHit).toBe(true);

    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "TARGETED_REFRESH",
    });

    expect(view.capabilityCeilingHit).toBe(true);
    expect(view.workQueue.length).toBe(0); // ничто не исполняется за потолком
    expect(view.excludedComponents.length).toBeGreaterThan(0);
    // Каждый компонент каждого незакрытого шага учтён как исключённый.
    const totalRequiredComponents = PATTERN_V1_CONTENT.steps.reduce(
      (n, s) =>
        n + requiredComponentsForStep(PATTERN_V1_CONTENT, s.step).length,
      0,
    );
    expect(view.excludedComponents.length).toBe(totalRequiredComponents);
  });

  it("4. бюджет сохраняется побайтово — S0 не пересчитывает researchBudget", () => {
    const r = plan(fullCoverageHits());
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    expect(view.researchBudget).toEqual(r.contract.researchBudget);
    expect(view.researchBudget).toBe(r.contract.researchBudget); // тот же объект, не копия/пересчёт
  });

  it("5. derivation mismatch: расхождение excludedScope с независимо выведенной областью — жёсткий отказ", () => {
    const r = plan([], {
      capabilityAtStart: "TARGETED_REFRESH",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
    });
    // Портим контракт вручную — ровно то, что могло бы произойти при
    // недоверенном/десинхронизированном источнике данных.
    const corrupted: ResearchBoundaryContract = {
      ...r.contract,
      excludedScope: r.contract.excludedScope.slice(0, -1), // на одну запись меньше, чем должно быть
    };
    expect(() =>
      buildContractView({
        contract: corrupted,
        mode: r.mode,
        capabilityAtStart: "TARGETED_REFRESH",
      }),
    ).toThrow(ContractDerivationMismatchError);
  });

  it("5a. derivation mismatch: mode не совпадает с независимо выведенным режимом", () => {
    const r = plan([hit({ patternStep: 1, confidence: 95 })]); // 1 закрыт, 7 MISSING -> FRESH_RESEARCH
    expect(r.mode).toBe("FRESH_RESEARCH");
    expect(() =>
      buildContractView({
        contract: r.contract,
        mode: "TARGETED_REFRESH", // подложный/рассинхронизированный mode
        capabilityAtStart: "FRESH_RESEARCH",
      }),
    ).toThrow(ContractDerivationMismatchError);
  });

  it("6. patternVersion расходится с активным Pattern — CONTRACT_INVALID, отдельно от derivation mismatch", () => {
    const r = plan(fullCoverageHits());
    expect(() =>
      buildContractView({
        contract: r.contract,
        mode: r.mode,
        capabilityAtStart: "FRESH_RESEARCH",
        activePatternVersion: 2, // контракт всегда версии 1
      }),
    ).toThrow(ContractInvalidError);
  });

  it("7. никакого случайного расширения на уровне шага: пометка REQUIRED_FRESH не переисследует уже SATISFIED-компонент", () => {
    // Синтетический (не из planner.ts) контракт: шаг помечен REQUIRED_FRESH,
    // но единственный его компонент несёт state=SATISFIED — некорректная,
    // но теоретически возможная десинхронизация. ContractView обязан
    // доверять КОМПОНЕНТУ, а не ярлыку шага, и не добавлять его в работу.
    const r = plan(fullCoverageHits());
    const tampered: ResearchBoundaryContract = {
      ...r.contract,
      stepDecisions: r.contract.stepDecisions.map((d) =>
        d.step === 7 ? { ...d, decision: "REQUIRED_FRESH" as const } : d,
      ),
    };
    const view = buildContractView({
      contract: tampered,
      // Пересчитанный desiredMode после порчи шага 7 (missing=0,
      // requiredFresh=1) — тест изолирует именно КОМПОНЕНТНОЕ доверие,
      // а не ловит несвязанный mode-mismatch.
      mode: "TARGETED_REFRESH",
      capabilityAtStart: "FRESH_RESEARCH",
    });
    expect(view.workQueue.some((c) => c.step === 7)).toBe(false);
    expect(
      view.reused.some((c) => c.step === 7 && c.component === "NET_EFFECT"),
    ).toBe(true);
  });

  it("8. полностью покрытая память: workQueue пуст, всё в reused, capabilityCeilingHit=false", () => {
    const r = plan(fullCoverageHits());
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    expect(view.workQueue).toEqual([]);
    expect(view.excludedComponents).toEqual([]);
    expect(view.capabilityCeilingHit).toBe(false);
    const totalRequiredComponents = PATTERN_V1_CONTENT.steps.reduce(
      (n, s) =>
        n + requiredComponentsForStep(PATTERN_V1_CONTENT, s.step).length,
      0,
    );
    expect(view.reused.length).toBe(totalRequiredComponents);
  });

  it("9. stopConditions типизируются, не парсятся регулярками из очереди работы", () => {
    const r = plan([], {
      capabilityAtStart: "TARGETED_REFRESH",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
    });
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "TARGETED_REFRESH",
    });
    expect(
      view.stopConditions.some((s) => s.kind === "CAPABILITY_CEILING"),
    ).toBe(true);
  });

  it("10. пустая память, FRESH_RESEARCH, CORE (без потолка): вся работа в очереди, ничего не исключено", () => {
    const r = plan([]); // capabilityAtStart=FRESH_RESEARCH (default), потолок не давит
    expect(r.capabilityCeilingHit).toBe(false);
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    const totalRequiredComponents = PATTERN_V1_CONTENT.steps.reduce(
      (n, s) =>
        n + requiredComponentsForStep(PATTERN_V1_CONTENT, s.step).length,
      0,
    );
    expect(view.workQueue.length).toBe(totalRequiredComponents);
    expect(view.excludedComponents).toEqual([]);
  });
});
