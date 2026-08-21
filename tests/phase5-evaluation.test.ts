import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { topics } from "../src/server/db/schema";
import { stripForBlindEvaluation } from "../src/server/memory/blind";
import {
  aggregateGoldenResults,
  runGoldenScenario,
  type GoldenScenario,
} from "../src/server/memory/evaluation";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

let ctx: TestContext;
let topicId: string;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  topicId = t.id;
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date();
const FRESH = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);
const STALE_HIGH_CHANGE = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000); // > default 3d stale_after

// Golden set — 8 углов из phase-5-plan.md §7.4. Память сеется нами, поэтому
// expectedSatisfiedSteps — известная заранее правда, а не догадка.
const SCENARIOS: GoldenScenario[] = [
  {
    name: "norm: свежее знание закрывает часть шагов",
    angle: "norm",
    capability: "FRESH_RESEARCH",
    statementQuery: "does protocol revenue reach token holders",
    seedFacts: [
      { patternStep: 1, claimKey: "economic_source", statement: "swap fee is the source", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true },
      { patternStep: 2, claimKey: "revenue_waterfall", statement: "fees flow to treasury first", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 92, promote: true },
      { patternStep: 3, claimKey: "allocation_mechanism", statement: "governance-approved buyback", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 90, promote: true },
    ],
    expectedSatisfiedSteps: [1, 2, 3],
  },
  {
    name: "completeness: памяти нет вовсе",
    angle: "completeness",
    capability: "FRESH_RESEARCH",
    statementQuery: "does protocol revenue reach token holders",
    seedFacts: [],
    expectedSatisfiedSteps: [],
  },
  {
    name: "freshness: динамический факт просрочен",
    angle: "freshness",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the buyback mechanism currently active",
    seedFacts: [
      { patternStep: 5, claimKey: "current_status", statement: "status checked long ago", freshnessClass: "HIGH_CHANGE", verifiedAt: STALE_HIGH_CHANGE, confidence: 99, promote: true },
    ],
    expectedSatisfiedSteps: [], // просрочен -> required_fresh, НЕ already_satisfied
  },
  {
    name: "sufficiency: всё свежо и покрыто",
    angle: "sufficiency",
    capability: "FRESH_RESEARCH",
    statementQuery: "full value capture review",
    seedFacts: Array.from({ length: 8 }, (_, i) => ({
      patternStep: i + 1,
      claimKey: `step_${i + 1}_claim`,
      statement: `verified fact for step ${i + 1}`,
      freshnessClass: "LOW_CHANGE" as const,
      verifiedAt: FRESH,
      confidence: 95,
      promote: true,
    })),
    expectedSatisfiedSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: "capability boundary: DEMO не получает FRESH_RESEARCH",
    angle: "capability_boundary",
    capability: "TARGETED_REFRESH",
    statementQuery: "brand new project, nothing known",
    seedFacts: [],
    expectedSatisfiedSteps: [],
  },
  {
    name: "wording: другая формулировка того же claim",
    angle: "wording",
    capability: "FRESH_RESEARCH",
    statementQuery: "does the project burn revenue into the token supply",
    seedFacts: [
      { patternStep: 7, claimKey: "net_token_effect", statement: "Half of protocol revenue is used to burn the token every epoch", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 88, promote: true },
    ],
    expectedSatisfiedSteps: [7],
  },
  {
    name: "поisoning: заведомо непроверенное знание не закрывает шаг",
    angle: "poisoning",
    capability: "FRESH_RESEARCH",
    statementQuery: "was the buyback actually executed",
    seedFacts: [
      { patternStep: 4, claimKey: "actual_execution", statement: "PLANTED: buyback executed (unverified)", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 99, promote: false },
    ],
    expectedSatisfiedSteps: [], // не промоутнут -> CANDIDATE -> невидим retrieval
  },
  {
    name: "чужой проект: память проекта A не закрывает шаг проекта B",
    angle: "cross_project",
    capability: "FRESH_RESEARCH",
    statementQuery: "durability of the mechanism",
    seedFacts: [],
    foreignProjectSeedFacts: [
      { patternStep: 8, claimKey: "durability", statement: "durable per foreign project's governance", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true },
    ],
    expectedSatisfiedSteps: [],
  },
];

describe("Фаза 5 — Golden set: Memory OFF vs ON (chunk H)", () => {
  it("20. все 8 углов приёмки: recall/precision/noise_rate по каждому сценарию корректны", async () => {
    for (const scenario of SCENARIOS) {
      const result = await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario);
      expect(result.recall, `${scenario.name}: recall`).toBe(1);
      expect(result.precision, `${scenario.name}: precision`).toBe(1);
      expect(result.noiseRate, `${scenario.name}: noise`).toBe(0);
      expect(
        [...result.contractOn.alreadySatisfiedSteps].sort((a, b) => a - b),
        scenario.name,
      ).toEqual(scenario.expectedSatisfiedSteps);
    }
  });

  it("21. false_reuse_rate = 0 на всём контролируемом наборе (условие приёмки, D-049)", async () => {
    const results = [];
    for (const scenario of SCENARIOS) {
      results.push(await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario));
    }
    const agg = aggregateGoldenResults(results);
    expect(agg.falseReuseRate).toBe(0);
    expect(agg.scenarioCount).toBe(SCENARIOS.length);
  });

  it("22. capability boundary: желаемый режим FRESH_RESEARCH зажат до TARGETED_REFRESH для DEMO", async () => {
    const scenario = SCENARIOS.find((s) => s.angle === "capability_boundary")!;
    const result = await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario);
    expect(result.modeOn).toBe("TARGETED_REFRESH");
  });

  it("23. sufficiency: полное покрытие даёт режим MEMORY", async () => {
    const scenario = SCENARIOS.find((s) => s.angle === "sufficiency")!;
    const result = await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario);
    expect(result.modeOn).toBe("MEMORY");
  });

  it("24. Memory OFF vs ON: план ON никогда не хуже плана OFF на своих же ожидаемых шагах (steps_skipped >= 0, no regression)", async () => {
    const scenario = SCENARIOS.find((s) => s.angle === "norm")!;
    const result = await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario);
    expect(result.contractOff.alreadySatisfiedSteps.length).toBe(0); // OFF никогда не переиспользует
    expect(result.stepsSkipped).toBe(3);
    expect(result.searchDelta).toBeGreaterThan(0); // ON планирует меньше поисков, чем OFF
  });

  it("25. Blind Evaluator: слепой вид не выдаёт memory_used и происхождение (reason/memoryIds)", async () => {
    const scenario = SCENARIOS.find((s) => s.angle === "norm")!;
    const result = await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario);
    const blind = stripForBlindEvaluation(result.contractOn);
    const serialized = JSON.stringify(blind);
    expect(serialized).not.toMatch(/memoryId/i);
    expect(serialized).not.toMatch(/active memory/i);
    expect(serialized).not.toMatch(/stale|reverif/i);
    // Судья видит РЕЗУЛЬТАТ (что покрыто), не ПРИЧИНУ.
    expect(blind.coveredSteps).toEqual([1, 2, 3]);
    expect(blind.stepDecisions.find((d) => d.step === 1)?.covered).toBe(true);
  });
});
