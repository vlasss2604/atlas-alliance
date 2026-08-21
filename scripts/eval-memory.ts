// npm run eval:memory — permanent Phase 5 acceptance/evaluation CLI
// (testing infrastructure, not a product feature, no architecture change).
//
// Runs the approved 8 golden-set scenarios (src/server/memory/golden-
// scenarios.ts — the SAME list tests/phase5-evaluation.test.ts uses) through
// the real pipeline (createResearchJob -> runMemoryPlanningStage) with
// memory_enabled OFF and ON against identical inputs, and prints a
// human-readable comparison per scenario. All numbers come from actual
// planner output (src/server/memory/planner.ts via evaluation.ts) — this
// script contains no planning logic of its own, only formatting.
//
// Each run gets a fresh, isolated database (drop schema -> migrate -> seed)
// so it is safe to re-run repeatedly without manual SQL or cleanup. Override
// the target with EVAL_DATABASE_URL if you don't want the default
// atlas_eval database.

import { eq } from "drizzle-orm";
import { Client } from "pg";

import { topics } from "../src/server/db/schema";
import { stripForBlindEvaluation } from "../src/server/memory/blind";
import {
  aggregateGoldenResults,
  fetchProvenanceByMemoryId,
  runGoldenScenario,
  type ScenarioResult,
} from "../src/server/memory/evaluation";
import { GOLDEN_SCENARIOS } from "../src/server/memory/golden-scenarios";
// setupTestDatabase reads TEST_DATABASE_URL into a module-level constant at
// import time — a static top-of-file import would evaluate it (via import
// hoisting) BEFORE we get to set the env var below. Dynamic import, inside
// main(), guarantees our assignment runs first every time.
type TestContext = Awaited<ReturnType<typeof import("../tests/phase1-setup").setupTestDatabase>>;

const line = (ch = "-") => ch.repeat(78);

// First run on a machine won't have atlas_eval yet — "usable without manual
// SQL" means this script provisions it itself rather than telling the owner
// to run `createdb`. Connects to the server's `postgres` maintenance DB,
// creates the target if missing, ignores "already exists" on repeat runs.
async function ensureDatabaseExists(dbUrl: string): Promise<void> {
  const url = new URL(dbUrl);
  const dbName = url.pathname.replace(/^\//, "");
  const maintenanceUrl = new URL(dbUrl);
  maintenanceUrl.pathname = "/postgres";
  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`Created database ${dbName}.`);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "42P04") throw e; // 42P04 = duplicate_database — already exists, fine
  } finally {
    await client.end();
  }
}

function fmtSteps(steps: number[]): string {
  return steps.length ? steps.join(", ") : "(none)";
}

// D-066: метрика может быть не определена для сценария (пустое ожидаемое
// или пустое предсказанное множество) — печатаем это честно, а не 1.
function fmtMetric(value: number | null, why: string): string {
  return value === null ? `n/a (${why})` : String(value);
}

async function printScenario(db: TestContext["db"], result: ScenarioResult): Promise<void> {
  console.log(line("="));
  console.log(`SCENARIO: ${result.scenario}  [angle: ${result.angle}]`);
  if (result.metricValidationOnly) {
    console.log(
      "  [METRIC SELF-CHECK — deliberately unsafe seed; EXCLUDED from the acceptance aggregate;\n" +
        "   a NON-zero false reuse count here is the expected, correct outcome (D-061)]",
    );
  }
  console.log(line());
  console.log(`Memory OFF mode : ${result.modeOff}`);
  console.log(`Memory ON  mode : ${result.modeOn}`);
  console.log(
    `Capability ceiling: ${result.capabilityCeilingHit ? `HIT — ${result.capabilityCeilingNote}` : "not hit"}`,
  );
  // D-061: счёт по шагам против независимой контрольной истины
  // (reusable/invalidReason в сценарии), не против правил планировщика.
  console.log(
    `False reuse: ${result.falseReuseStepCount}/${result.satisfiedStepCount} satisfied steps relied on memory the ground truth marks NOT reusable${
      result.falseReuseStepCount === 0 ? "  [OK]" : result.metricValidationOnly ? "  [expected for this self-check]" : "  [!!]"
    }`,
  );
  for (const d of result.falseReuseDetails) {
    console.log(
      `  step ${d.step}: unsafe element(s) ${d.memoryIds.join(", ")} — ground truth: ${d.invalidReasons.join(", ")}`,
    );
  }
  console.log("");
  console.log(`Already satisfied steps (ON): ${fmtSteps(result.contractOn.alreadySatisfiedSteps)}`);
  console.log(`Refreshed steps (ON)        : ${fmtSteps(result.contractOn.requiredFreshEvidence)}`);
  console.log(`Missing steps (ON)          : ${fmtSteps(result.contractOn.missingSteps)}`);
  console.log(
    `Already satisfied steps (OFF): ${fmtSteps(result.contractOff.alreadySatisfiedSteps)}  (must always be none — memory was not consulted)`,
  );
  console.log("");

  const nonMissing = result.contractOn.stepDecisions.filter((d) => d.decision !== "MISSING");
  if (nonMissing.length > 0) {
    console.log("Why each reused/refreshed step was classified that way:");
    for (const d of nonMissing) {
      console.log(`  step ${d.step} (${d.stepName}) -> ${d.decision}`);
      console.log(`    reason: ${d.reason}`);
      if (d.memoryIds.length > 0) {
        console.log(`    memory: ${d.memoryIds.join(", ")}`);
      }
    }
  }

  if (result.contractOn.reusableEvidence.length > 0) {
    console.log("");
    console.log("Provenance behind reused evidence:");
    const provenance = await fetchProvenanceByMemoryId(
      db,
      result.contractOn.reusableEvidence.map((e) => e.memoryId),
    );
    for (const e of result.contractOn.reusableEvidence) {
      console.log(`  [step ${e.step}] ${e.claimKey} (confidence ${e.confidence}%) — memoryId ${e.memoryId}`);
      const prov = provenance.get(e.memoryId) ?? [];
      if (prov.length === 0) {
        console.log("    (no provenance row recorded)");
      }
      for (const p of prov) {
        console.log(`    source: ${p.retrievedUrl}  (${p.contentHash})`);
      }
    }
  }

  console.log("");
  console.log(
    `recall=${fmtMetric(result.recall, "no expected positives")}  precision=${fmtMetric(result.precision, "nothing predicted positive")}  noise_rate=${result.noiseRate}  search_delta=${result.searchDelta}`,
  );
  if (result.noFalsePositives !== null) {
    console.log(
      `negative-safety (no false positives): ${result.noFalsePositives ? "PASS" : "FAIL"}  — negative scenario, recall/precision are undefined here by design (D-066)`,
    );
  }

  // Слепой вид — что увидел бы Blind Evaluator (D-049, §7.5): без memoryId,
  // без "почему" (никаких упоминаний памяти/свежести), только результат.
  const blind = stripForBlindEvaluation(result.contractOn);
  console.log("");
  console.log(
    `Blind view (what a Blind Evaluator would see): covered=${fmtSteps(blind.coveredSteps)} needsFresh=${fmtSteps(blind.needsFreshEvidenceSteps)} missing=${fmtSteps(blind.missingSteps)} novelty=${blind.noveltyState}`,
  );
  console.log("");
}

async function main() {
  const dbUrl = process.env.EVAL_DATABASE_URL ?? "postgres://atlas:atlas@localhost:5432/atlas_eval";
  process.env.TEST_DATABASE_URL = dbUrl;
  const { setupTestDatabase } = await import("../tests/phase1-setup");

  console.log(`Connecting to ${dbUrl} (fresh schema each run)...`);
  await ensureDatabaseExists(dbUrl);
  const ctx = await setupTestDatabase();
  try {
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));

    const results: ScenarioResult[] = [];
    for (const scenario of GOLDEN_SCENARIOS) {
      const result = await runGoldenScenario(ctx.db, ctx.boss, topic.id, scenario);
      results.push(result);
      await printScenario(ctx.db, result);
    }

    const agg = aggregateGoldenResults(results);
    const selfChecks = results.filter((r) => r.metricValidationOnly);
    console.log(line("="));
    console.log("AGGREGATE (Memory ON vs OFF, controlled acceptance set)");
    console.log(line());
    console.log(`acceptance scenarios : ${agg.scenarioCount}  (+${selfChecks.length} metric self-check, excluded)`);
    // D-066: усреднение только там, где метрика определена; знаменатель
    // предъявляется рядом со значением — никакого завышения синтетическими 1.
    console.log(`mean recall          : ${fmtMetric(agg.meanRecall, "no scenario had expected positives")}  (over ${agg.recallDefinedCount} scenarios where recall is defined)`);
    console.log(`mean precision       : ${fmtMetric(agg.meanPrecision, "no scenario predicted positives")}  (over ${agg.precisionDefinedCount} scenarios where precision is defined)`);
    console.log(`negative safety      : ${fmtMetric(agg.noFalsePositiveRate, "no negative scenarios")}  (share of ${agg.negativeScenarioCount} negative-only scenarios with NO false positives)`);
    console.log(`mean noise_rate      : ${agg.meanNoiseRate}`);
    console.log(`false_reuse_rate     : ${agg.falseReuseRate}  (${agg.falseReuseStepCount}/${agg.satisfiedStepCount} satisfied steps)  ${agg.falseReuseRate === 0 ? "[acceptance condition MET]" : "[!! BLOCKS PHASE 5 ACCEPTANCE]"}`);
    console.log(`total steps skipped  : ${agg.totalStepsSkipped}`);
    console.log(`total steps refreshed: ${agg.totalStepsRefreshed}`);
    console.log(`mean search_delta    : ${agg.meanSearchDelta}`);
    if (selfChecks.length > 0) {
      console.log(line());
      console.log("METRIC SELF-CHECK (D-061): can false_reuse_rate become non-zero?");
      for (const r of selfChecks) {
        const detected = r.falseReuseStepCount > 0;
        console.log(
          `  ${r.scenario}: ${r.falseReuseStepCount}/${r.satisfiedStepCount} unsafe steps detected  ${detected ? "[metric CAN detect unsafe reuse — self-check PASS]" : "[!! metric failed to detect deliberate unsafe reuse]"}`,
        );
      }
    }
    console.log(line("="));
    console.log("");
    console.log(
      'Owner question to answer per scenario above: "Did Atlas research differently\n' +
        'because it remembered, and was that difference justified?" — the OFF/ON mode\n' +
        "line, the satisfied/refreshed/missing step lists, and the reason text per step\n" +
        "are the evidence; the blind view shows what a judge without that context sees.",
    );
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
