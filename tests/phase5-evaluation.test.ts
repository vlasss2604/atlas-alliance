import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { topics } from "../src/server/db/schema";
import { stripForBlindEvaluation } from "../src/server/memory/blind";
import {
  aggregateGoldenResults,
  runGoldenScenario,
  type ScenarioResult,
} from "../src/server/memory/evaluation";
import { GOLDEN_SCENARIOS as SCENARIOS } from "../src/server/memory/golden-scenarios";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

let ctx: TestContext;
let topicId: string;

// Каждый сценарий прогоняется через реальный pipeline один раз; результаты
// разделяются тестами ниже (двойной прогон удлинял бы suite вдвое, не
// добавляя покрытия — сценарии изолированы по собственным проектам).
const resultByName = new Map<string, ScenarioResult>();
let allResults: ScenarioResult[] = [];

beforeAll(async () => {
  ctx = await setupTestDatabase();
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  topicId = t.id;
  for (const scenario of SCENARIOS) {
    const result = await runGoldenScenario(ctx.db, ctx.boss, topicId, scenario);
    resultByName.set(scenario.name, result);
  }
  allResults = [...resultByName.values()];
}, 240_000);

afterAll(async () => {
  await ctx.close();
});

function byAngle(angle: string): ScenarioResult[] {
  return allResults.filter((r) => r.angle === angle);
}

describe("Фаза 5 — Golden set: Memory OFF vs ON (chunk H)", () => {
  it("20. приёмочные углы: satisfied-шаги совпадают с объявленной истиной; метрики считаются только там, где определены (D-066)", () => {
    for (const scenario of SCENARIOS) {
      if (scenario.metricValidationOnly) continue; // проверяется тестом 27
      const result = resultByName.get(scenario.name)!;
      expect(
        [...result.contractOn.alreadySatisfiedSteps].sort((a, b) => a - b),
        scenario.name,
      ).toEqual(scenario.expectedSatisfiedSteps);
      if (scenario.expectedSatisfiedSteps.length > 0) {
        // Позитивный сценарий: recall/precision/noise определены.
        expect(result.recall, `${scenario.name}: recall`).toBe(1);
        expect(result.precision, `${scenario.name}: precision`).toBe(1);
        expect(result.noiseRate, `${scenario.name}: noise`).toBe(0);
        expect(result.noFalsePositives, scenario.name).toBeNull();
      } else {
        // Негативный сценарий: recall НЕ определён (пустое ожидаемое
        // множество), precision и noise_rate НЕ определены (пустое
        // предсказанное) — вместо синтетических 1/0 отдельная метрика
        // отсутствия ложных срабатываний.
        expect(result.recall, `${scenario.name}: recall must be undefined`).toBeNull();
        expect(result.precision, `${scenario.name}: precision must be undefined`).toBeNull();
        expect(result.noiseRate, `${scenario.name}: noise must be undefined`).toBeNull();
        expect(result.noFalsePositives, `${scenario.name}: negative safety`).toBe(true);
      }

      // Дополнительно объявленная истина по REQUIRED_FRESH/MISSING.
      if (scenario.expectedRequiredFreshSteps) {
        expect(
          [...result.contractOn.requiredFreshEvidence].sort((a, b) => a - b),
          `${scenario.name}: required_fresh`,
        ).toEqual(scenario.expectedRequiredFreshSteps);
      }
      if (scenario.expectedMissingSteps) {
        expect(
          [...result.contractOn.missingSteps].sort((a, b) => a - b),
          `${scenario.name}: missing`,
        ).toEqual(scenario.expectedMissingSteps);
      }
    }
  });

  it("21. false_reuse_rate = 0 на всём приёмочном наборе (условие приёмки, D-049/D-061)", () => {
    const agg = aggregateGoldenResults(allResults);
    expect(agg.falseReuseRate).toBe(0);
    expect(agg.falseReuseStepCount).toBe(0);
    // Агрегат считает только приёмочные сценарии; metric self-check
    // (unsafe reuse) исключён из него по построению.
    expect(agg.scenarioCount).toBe(SCENARIOS.filter((s) => !s.metricValidationOnly).length);
  });

  it("22. capability boundary: желаемый режим FRESH_RESEARCH зажат до TARGETED_REFRESH для DEMO", () => {
    const result = byAngle("capability_boundary")[0];
    expect(result.modeOn).toBe("TARGETED_REFRESH");
    expect(result.capabilityCeilingHit).toBe(true);
  });

  it("23. sufficiency: полное покрытие всех компонентов даёт режим MEMORY", () => {
    const result = byAngle("sufficiency")[0];
    expect(result.modeOn).toBe("MEMORY");
    expect(result.contractOn.stopConditions.length).toBeGreaterThan(0);
  });

  it("24. Memory OFF vs ON: план ON никогда не хуже плана OFF на своих же ожидаемых шагах (steps_skipped >= 0, no regression)", () => {
    const result = byAngle("norm")[0];
    expect(result.contractOff.alreadySatisfiedSteps.length).toBe(0); // OFF никогда не переиспользует
    expect(result.stepsSkipped).toBe(3);
    expect(result.searchDelta).toBeGreaterThan(0); // ON планирует меньше поисков, чем OFF
  });

  it("25. Blind Evaluator (D-063): слепой вид не выдаёт происхождение — ни reason/memoryIds, ни knownInformation с текстами памяти", () => {
    const result = byAngle("norm")[0];
    const blind = stripForBlindEvaluation(result.contractOn);
    const serialized = JSON.stringify(blind);
    expect(serialized).not.toMatch(/memoryId/i);
    expect(serialized).not.toMatch(/active memory/i);
    expect(serialized).not.toMatch(/stale|reverif/i);
    // D-063: knownInformation содержит ТЕКСТЫ памяти — происхождение
    // выдаётся прямо; из слепого вида исключается целиком.
    expect(serialized).not.toMatch(/knownInformation/);
    expect(serialized).not.toMatch(/swap fee is the source/); // statement памяти не утекает
    expect(serialized).not.toMatch(/component/i); // components несут memoryIds и причины
    // Судья видит РЕЗУЛЬТАТ (что покрыто), не ПРИЧИНУ.
    expect(blind.coveredSteps).toEqual([1, 2, 3]);
    expect(blind.stepDecisions.find((d) => d.step === 1)?.covered).toBe(true);
  });

  it("26. D-058 (обязательная регрессия HIGH-1): DEMO с 1 закрытым + 7 MISSING получает честную границу доступа", () => {
    const result = byAngle("mode_boundary")[0];
    expect(result.contractOn.alreadySatisfiedSteps).toEqual([1]);
    expect(result.contractOn.missingSteps.length).toBe(7);
    // Граница ОБЯЗАНА сработать (прежнее поведение: молчала — 0 записей).
    expect(result.capabilityCeilingHit).toBe(true);
    expect(result.capabilityCeilingNote).toContain("FRESH_RESEARCH");
    expect(result.modeOn).toBe("TARGETED_REFRESH"); // зажато потолком DEMO
    expect(result.contractOn.excludedScope.length).toBe(7); // все непокрытые шаги честно исключены
    expect(result.contractOn.stopConditions.length).toBeGreaterThan(0);
  });

  it("27. D-061: контролируемое небезопасное переиспользование ДОКАЗЫВАЕТ, что метрика может стать ненулевой", () => {
    const result = byAngle("unsafe_reuse")[0];
    // Планировщик по своим правилам закрыл шаг 1 (факт проходит фолбэк
    // LOW_CHANGE=180д), но контрольная истина знает: факт непригоден.
    expect(result.satisfiedStepCount).toBe(1);
    expect(result.falseReuseStepCount).toBe(1); // МЕТРИКА ЛОВИТ небезопасное переиспользование
    expect(result.falseReuseDetails[0].step).toBe(1);
    expect(result.falseReuseDetails[0].invalidReasons).toContain("STALE");
    // ...и приёмочный агрегат при этом остаётся нулевым: self-check не
    // размывает условие приёмки.
    const agg = aggregateGoldenResults(allResults);
    expect(agg.falseReuseRate).toBe(0);
  });

  it("28. D-059: QUESTIONABLE/REVERIFY/STALE направляют перепроверку (память видна плану), DEPRECATED даёт MISSING", () => {
    const healthResults = byAngle("health");
    expect(healthResults.length).toBe(4);
    for (const result of healthResults) {
      expect(result.contractOn.alreadySatisfiedSteps, result.scenario).toEqual([]);
    }
    const guided = healthResults.filter((r) => r.contractOn.requiredFreshEvidence.length > 0);
    expect(guided.length).toBe(3); // QUESTIONABLE, REVERIFY, STALE
    for (const result of guided) {
      const step = result.contractOn.requiredFreshEvidence[0];
      const decision = result.contractOn.stepDecisions.find((d) => d.step === step)!;
      // Память извлечена и направляет перепроверку — memoryIds непусты.
      expect(decision.memoryIds.length, result.scenario).toBeGreaterThan(0);
      expect(decision.components[0].blockers.join(","), result.scenario).toMatch(/HEALTH_/);
    }
    const deprecated = healthResults.find((r) => r.scenario.includes("DEPRECATED"))!;
    // DEPRECATED исключён из retrieval целиком -> шаг подлинно MISSING.
    expect(deprecated.contractOn.missingSteps).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(deprecated.contractOn.stepDecisions.every((d) => d.memoryIds.length === 0)).toBe(true);
  });

  it("29. D-062: противоречие mechanism_state оставляет шаг REQUIRED_FRESH с CONTRADICTED и предъявимыми memoryId", () => {
    const result = byAngle("contradiction")[0];
    expect(result.contractOn.alreadySatisfiedSteps).toEqual([]);
    expect(result.contractOn.requiredFreshEvidence).toEqual([5]);
    const step5 = result.contractOn.stepDecisions.find((d) => d.step === 5)!;
    expect(step5.reason).toContain("CONTRADICTED");
    const comp = step5.components.find((c) => c.component === "CURRENT_STATE")!;
    expect(comp.state).toBe("CONTRADICTED");
    expect(comp.conflictingMemoryIds.length).toBe(2); // оба конфликтующих ID предъявимы
  });

  it("30. D-060: частичное покрытие многокомпонентного шага не закрывает шаг; причина называет непокрытый компонент", () => {
    const result = byAngle("partial_component")[0];
    expect(result.contractOn.alreadySatisfiedSteps).toEqual([]);
    expect(result.contractOn.requiredFreshEvidence).toEqual([3, 6]);
    const step3 = result.contractOn.stepDecisions.find((d) => d.step === 3)!;
    expect(step3.reason).toContain("GOVERNANCE_BASIS");
    const step6 = result.contractOn.stepDecisions.find((d) => d.step === 6)!;
    expect(step6.reason).toContain("RECIPIENT");
  });

  it("31. MEDIUM-1: политика stale_after в часах и месяцах управляет свежестью, а не усекается в ноль", () => {
    const policies = byAngle("stale_policy");
    expect(policies.length).toBe(3);
    const fresh36h = policies.find((r) => r.scenario.includes("моложе"))!;
    expect(fresh36h.contractOn.alreadySatisfiedSteps).toEqual([5]); // 20h < 36h: свежа
    const stale36h = policies.find((r) => r.scenario.includes("старше"))!;
    expect(stale36h.contractOn.alreadySatisfiedSteps).toEqual([]); // 48h > 36h: просрочена
    expect(stale36h.contractOn.requiredFreshEvidence).toEqual([5]);
    const months = policies.find((r) => r.scenario.includes("3mo"))!;
    expect(months.contractOn.alreadySatisfiedSteps).toEqual([8]); // 30d < 3mo: свежа
  });

  it("32. D-066: агрегат математически честен — знаменатели предъявлены, негативные сценарии в отдельной метрике", () => {
    const agg = aggregateGoldenResults(allResults);
    const acceptance = SCENARIOS.filter((s) => !s.metricValidationOnly);
    const positive = acceptance.filter((s) => s.expectedSatisfiedSteps.length > 0);
    const negative = acceptance.filter((s) => s.expectedSatisfiedSteps.length === 0);
    // recall определён ровно там, где ожидаемое множество непусто;
    // precision/noise — где непусто предсказанное (здесь совпадает).
    expect(agg.recallDefinedCount).toBe(positive.length);
    expect(agg.noiseDefinedCount).toBe(positive.length);
    expect(agg.negativeScenarioCount).toBe(negative.length);
    expect(agg.meanRecall).toBe(1);
    expect(agg.meanPrecision).toBe(1);
    expect(agg.meanNoiseRate).toBe(0);
    expect(agg.noFalsePositiveRate).toBe(1); // ни один негативный сценарий не дал ложного срабатывания
    // Синтетические единицы за пустые сценарии агрегат больше не надувают:
    // средние считаются по определённым значениям, не по всем сценариям.
    expect(agg.recallDefinedCount).toBeLessThan(agg.scenarioCount);
  });

  it("34. D-058, средняя ветвь end-to-end: полное покрытие с одним просроченным шагом даёт режим TARGETED_REFRESH", () => {
    const result = allResults.find((r) => r.scenario.includes("targeted refresh"))!;
    expect(result.contractOn.missingSteps).toEqual([]);
    expect(result.contractOn.requiredFreshEvidence).toEqual([5]);
    // Режим выведен из памяти (не зажат потолком): missing=0, requiredFresh>0.
    expect(result.modeOn).toBe("TARGETED_REFRESH");
    expect(result.capabilityCeilingHit).toBe(false);
    expect(result.stepsSkipped).toBe(7);
  });

  it("33. D-060: claim_key не определяет валидность шага — факт закрывает только свой (step, component)", () => {
    const result = byAngle("component_mapping")[0];
    // claim_key 'economic_source' на шаге 8 закрывает ТОЛЬКО шаг 8.
    expect(result.contractOn.alreadySatisfiedSteps).toEqual([8]);
    expect(result.contractOn.missingSteps).toContain(1);
  });
});
