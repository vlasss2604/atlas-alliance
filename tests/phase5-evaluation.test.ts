import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { topics } from "../src/server/db/schema";
import { stripForBlindEvaluation } from "../src/server/memory/blind";
import {
  aggregateGoldenResults,
  runGoldenScenario,
  type GoldenScenario,
} from "../src/server/memory/evaluation";
import { GOLDEN_SCENARIOS as SCENARIOS } from "../src/server/memory/golden-scenarios";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

const NOW = new Date();
const FRESH = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);

let ctx: TestContext;
let topicId: string;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  const [t] = await ctx.db
    .select()
    .from(topics)
    .where(eq(topics.isActive, true));
  topicId = t.id;
});

afterAll(async () => {
  await ctx.close();
});

describe("Фаза 5 — Golden set: Memory OFF vs ON (chunk H, скорректировано D-066)", () => {
  it("20. все углы приёмки: recall/precision корректны там, где определены; noFalsePositive для negative-only", async () => {
    for (const scenario of SCENARIOS) {
      const result = await runGoldenScenario(
        ctx.db,
        ctx.boss,
        topicId,
        scenario,
      );
      if (scenario.expectedSatisfiedSteps.length === 0) {
        // D-066: пустое ожидаемое множество -> recall/precision НЕ
        // определены (не подменяются синтетической единицей); проверяем
        // отдельную метрику "не было ложного срабатывания".
        expect(result.recall, `${scenario.name}: recall`).toBeUndefined();
        expect(
          result.noFalsePositive,
          `${scenario.name}: noFalsePositive`,
        ).toBe(true);
      } else {
        expect(result.recall, `${scenario.name}: recall`).toBe(1);
        expect(result.precision, `${scenario.name}: precision`).toBe(1);
      }
      expect(result.noiseRate, `${scenario.name}: noise`).toBe(0);
      expect(
        [...result.contractOn.alreadySatisfiedSteps].sort((a, b) => a - b),
        scenario.name,
      ).toEqual(scenario.expectedSatisfiedSteps);
    }
  });

  it("21. false_reuse_rate = 0 на всём контролируемом наборе (условие приёмки, D-049/D-061)", async () => {
    const results = [];
    for (const scenario of SCENARIOS) {
      results.push(
        await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario),
      );
    }
    const agg = aggregateGoldenResults(results);
    expect(agg.falseReuseRate).toBe(0);
    expect(agg.scenarioCount).toBe(SCENARIOS.length);
  });

  it("21a. D-061: false_reuse_rate способен стать ненулевым при намеренно небезопасном reuse (контролируемый, ВНЕ acceptance-набора)", async () => {
    // Ground truth (reusable:false) НЕЗАВИСИМА от того, что решит
    // планировщик: этот факт структурно ЗАКРОЕТ шаг (health OK, свежий,
    // confidence выше порога) — метрика обязана поймать это как false
    // reuse именно потому, что независимая истина сценария так решила,
    // а не потому, что реализация "думает" иначе. Не входит в
    // GOLDEN_SCENARIOS, чтобы не портить false_reuse_rate=0 официального
    // acceptance-прогона (D-061 явно требует отдельного контролируемого теста).
    const unsafeScenario: GoldenScenario = {
      name: "D-061 controlled unsafe reuse (not part of acceptance set)",
      angle: "false_reuse",
      capability: "FRESH_RESEARCH",
      statementQuery: "deliberately unsafe reuse probe",
      seedFacts: [
        {
          patternStep: 2,
          component: "FLOW_PATH",
          claimKey: "unsafe_but_structurally_valid",
          statement:
            "structurally satisfies the step but ground truth marks it unsafe",
          freshnessClass: "LOW_CHANGE",
          verifiedAt: FRESH,
          confidence: 75,
          promote: true,
          reusable: false,
          invalidReason: "LOW_CONFIDENCE",
        },
      ],
      expectedSatisfiedSteps: [2],
    };
    const result = await runGoldenScenario(
      ctx.db,
      ctx.boss,
      topicId,
      unsafeScenario,
    );
    expect(result.contractOn.alreadySatisfiedSteps).toEqual([2]);
    expect(result.falseReuseStepCount).toBeGreaterThan(0);
    expect(result.falseReuseDetails[0]?.reasons).toContain("LOW_CONFIDENCE");
    const agg = aggregateGoldenResults([result]);
    expect(agg.falseReuseRate).toBeGreaterThan(0);
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
