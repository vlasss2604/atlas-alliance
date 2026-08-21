import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { topics } from "../src/server/db/schema";
import { stripForBlindEvaluation } from "../src/server/memory/blind";
import { aggregateGoldenResults, runGoldenScenario } from "../src/server/memory/evaluation";
import { GOLDEN_SCENARIOS as SCENARIOS } from "../src/server/memory/golden-scenarios";
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
