import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projects, researchAttempts, topics, users } from "../src/server/db/schema";
import { runSearchPhase } from "../src/server/engine/acquisition-phases";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import {
  readJobBudgetReserved,
  reserveJobBudget,
  settleJobBudgetReservation,
} from "../src/server/engine/budget-reservation";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { runResearchController, type WorkExecutor } from "../src/server/engine/controller";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { calculateMaxAuthorizedCostMicro, type ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError, type EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { ComponentTarget, ExtractedFact, FetchedDocument, ModelUsage } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// BUDGET SETTLEMENT V1 (D-173) — A COMPLETED MODEL CALL IS ACCOUNTED AT ITS
// ACTUAL COST, NOT AT ITS THEORETICAL MAXIMUM.
//
// The defect, measured on the first Jito Research (job b817eb99,
// 2026-10-11): every extraction call reserved the profile maximum (55,680
// micro-USD) and the reservation stayed at that figure after the provider
// had answered and billed 4–25 k. Thirty-four completed calls therefore
// held 1,893,120 of a 2,000,000 budget while 370,296 had been spent, and the
// last component (DURABILITY_BASIS) was refused MODEL_COST_BUDGET_EXHAUSTED.
//
// What must hold, and is pinned below:
//   * the hard cap is still enforced against the live counter by one atomic
//     conditional UPDATE per admission — concurrent calls cannot over-admit;
//   * a completed call with priceable usage settles DOWN to its actual cost,
//     never up, never below zero;
//   * a call that never answered (transient failure), a truncated output, an
//     unsupported billing category or a refused reservation settles nothing;
//   * real exhaustion still refuses deterministically;
//   * the phased SEARCH proposer settles under the same rule;
//   * research_attempts.completed_at is the wall-clock completion, not the
//     run's logical clock.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-10-11T00:00:00Z");
const FRAGMENT = "the protocol fee accrues directly to the treasury contract";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
// 8_000 × 1 + 1_536 × 5 = 15_680 micro-USD — the per-call reservation.
const MAX_MICRO = calculateMaxAuthorizedCostMicro(COST);
// What every fixture call "actually" costs: 800 × 1 + 40 × 5 = 1_000.
const USAGE: ModelUsage = { inputTokens: 800, outputTokens: 40 };
const ACTUAL_MICRO = USAGE.inputTokens * COST.inputPriceMicroUsdPerToken + USAGE.outputTokens * COST.outputPriceMicroUsdPerToken;

const ITEM_1: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};
const ITEM_2: ComponentWorkItem = { ...ITEM_1, step: 2, stepName: "Flow Path", component: "FLOW_PATH" };

async function makeJob(opts: { plan?: boolean } = {}) {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("settle");
  const name = "Settle Project";
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  if (opts.plan) await runMemoryPlanningStage(ctx.db, job.id);
  return { jobId: job.id, project: { id: project.id, name, slug, ticker: null as string | null } };
}

async function reservedMicro(jobId: string): Promise<number> {
  return (await readJobBudgetReserved(ctx.db, jobId))!.modelCostMicro;
}

const ctxFor = (jobId: string, maxModelCostMicro = 10_000_000) => ({
  jobId,
  attemptNumber: 1,
  isRecoveryAttempt: false,
  budget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro },
});

function docFor(url: string, projectName: string): FetchedDocument {
  const text = `${projectName}: ${FRAGMENT}. Details for ${url}.`;
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}`,
    fetchedAt: NOW,
    byteLength: text.length,
  };
}

function factFor(target: ComponentTarget): ExtractedFact {
  return {
    step: target.step,
    component: target.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: FRAGMENT,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove distribution",
    relationship: "SUPPORTS",
  };
}

const urlsFor = (n: number) => Array.from({ length: n }, (_, i) => `https://docs.settle.test/page-${i + 1}`);

// An extractor that answers every call with one traceable fact and reports
// the SAME usage the way the live adapter does — through the per-call sink.
function usageReportingExtractor(
  usage: ModelUsage = USAGE,
  before?: (callIndex: number, input: Parameters<EvidenceExtractor["extract"]>[0]) => void,
): EvidenceExtractor & { calls: { n: number } } {
  const calls = { n: 0 };
  return {
    name: "fixture-usage",
    calls,
    async extract(input) {
      calls.n += 1;
      before?.(calls.n, input);
      input.onUsage?.(usage);
      return [factFor(input.target)];
    },
  };
}

function executorWith(
  project: { id: string; name: string; slug: string; ticker: string | null },
  roles: { queryProposer?: QueryProposer; searchGateway?: SearchGateway; contentFetcher?: ContentFetcher; evidenceExtractor?: EvidenceExtractor },
  docs = 1,
) {
  const urls = urlsFor(docs);
  return createS4WorkExecutor({
    db: ctx.db,
    project,
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: roles.queryProposer ?? { name: "fixture", async proposeQueries() { return ["q"]; } },
    searchGateway: roles.searchGateway ?? { name: "fixture", async search() { return urls.map((url) => ({ url, title: null, snippet: null })); } },
    contentFetcher: roles.contentFetcher ?? { name: "fixture", async fetch(url: string) { return docFor(url, project.name); } },
    evidenceExtractor: roles.evidenceExtractor ?? usageReportingExtractor(),
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

describe("1. the primitive — settleJobBudgetReservation releases reserved − actual, downward only, never below zero", () => {
  it("a completed call settles to its actual cost; an exact or over-budget actual releases nothing", async () => {
    const { jobId } = await makeJob();
    expect(await reserveJobBudget(ctx.db, jobId, "modelCostMicro", MAX_MICRO, 10 * MAX_MICRO)).toBe(true);
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO);

    expect(await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", MAX_MICRO, ACTUAL_MICRO)).toEqual({ released: MAX_MICRO - ACTUAL_MICRO });
    expect(await reservedMicro(jobId)).toBe(ACTUAL_MICRO);

    // actual == reserved: nothing to release.
    expect(await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", ACTUAL_MICRO, ACTUAL_MICRO)).toEqual({ released: 0 });
    // actual > reserved: never adjusted upward, nothing released (D-090).
    expect(await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", ACTUAL_MICRO, ACTUAL_MICRO + 500)).toEqual({ released: 0 });
    expect(await reservedMicro(jobId)).toBe(ACTUAL_MICRO);
  });

  it("the counter can never be driven below zero: a release larger than the counter is refused whole", async () => {
    const { jobId } = await makeJob();
    expect(await reserveJobBudget(ctx.db, jobId, "modelCostMicro", 1_000, 10 * MAX_MICRO)).toBe(true);
    expect(await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", MAX_MICRO, 0)).toEqual({ released: 0 });
    expect(await reservedMicro(jobId)).toBe(1_000);
  });

  it("a fractional actual rounds UP before settling; non-finite input settles nothing", async () => {
    const { jobId } = await makeJob();
    expect(await reserveJobBudget(ctx.db, jobId, "modelCostMicro", 1_000, 10 * MAX_MICRO)).toBe(true);
    expect(await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", 1_000, 10.2)).toEqual({ released: 989 });
    expect(await reservedMicro(jobId)).toBe(11);
    expect(await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", Number.NaN, 0)).toEqual({ released: 0 });
    expect(await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", 11, Number.POSITIVE_INFINITY)).toEqual({ released: 0 });
    expect(await reservedMicro(jobId)).toBe(11);
  });
});

describe("2. the hard cap under concurrency — in-flight exposure never exceeds the ceiling, settlement frees room", () => {
  it("30 concurrent reserve → hold → settle cycles against a two-call ceiling: never more than two in flight, every admitted call settles", async () => {
    const { jobId } = await makeJob();
    const ceiling = 2 * MAX_MICRO;
    let held = 0;
    let maxHeld = 0;
    let admitted = 0;
    let refused = 0;
    const cycle = async () => {
      const ok = await reserveJobBudget(ctx.db, jobId, "modelCostMicro", MAX_MICRO, ceiling);
      if (!ok) {
        refused += 1;
        return;
      }
      admitted += 1;
      held += 1;
      maxHeld = Math.max(maxHeld, held);
      await new Promise((r) => setTimeout(r, 5));
      held -= 1;
      await settleJobBudgetReservation(ctx.db, jobId, "modelCostMicro", MAX_MICRO, ACTUAL_MICRO);
    };
    await Promise.all(Array.from({ length: 30 }, cycle));
    // The ceiling is a hard bound on EXPOSURE: while two calls hold their
    // maximum, a third is refused — the admission is one conditional
    // UPDATE against the live counter, so no interleaving can over-admit.
    expect(maxHeld).toBeLessThanOrEqual(2);
    expect(admitted).toBeGreaterThanOrEqual(2);
    expect(admitted + refused).toBe(30);
    // Settlement is what makes room for the later calls, and after every
    // call has answered the counter is exactly the actual spend.
    expect(await reservedMicro(jobId)).toBe(admitted * ACTUAL_MICRO);
    expect(admitted * ACTUAL_MICRO).toBeLessThanOrEqual(ceiling);
  });
});

describe("3. the executor — the Jito shape no longer ends BUDGET_EXHAUSTED with the budget unspent", () => {
  it("two components × five documents under a cap the AUTHORIZED maxima would exceed: both succeed, and the counter is the actual spend", async () => {
    const { jobId, project } = await makeJob();
    // Pre-settlement accounting: proposer + 5 extractions per component =
    // 6 × 15_680 = 94_080 held per component, 188_160 for two — the second
    // component's first extraction (125_440) would have been refused under a
    // 120_000 cap. Actual spend is 2 × (proposer max 15_680 — the fixture
    // proposer reports no usage — + 5 × 1_000) = 41_360.
    const cap = 120_000;
    expect(2 * 6 * MAX_MICRO).toBeGreaterThan(cap);
    const extractor = usageReportingExtractor();
    const executor = executorWith(project, { evidenceExtractor: extractor }, 5);

    const first = await executor.execute(ITEM_1, ctxFor(jobId, cap));
    expect(first.status).toBe("SUCCEEDED");
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO + 5 * ACTUAL_MICRO);

    const second = await executor.execute(ITEM_2, ctxFor(jobId, cap));
    expect(second.status).toBe("SUCCEEDED");
    expect(extractor.calls.n).toBe(10);
    expect(await reservedMicro(jobId)).toBe(2 * (MAX_MICRO + 5 * ACTUAL_MICRO));
  });

  it("real exhaustion still refuses deterministically: a cap with room for one settled call and nothing more throws at the second reservation", async () => {
    const { jobId, project } = await makeJob();
    // proposer max + one extraction max fits; after the extraction settles
    // to 1_000 the counter is 16_680, and the second document's 15_680 would
    // reach 32_360 > 31_360 — refused, thrown, exactly one extraction call.
    const cap = 2 * MAX_MICRO;
    const extractor = usageReportingExtractor();
    const executor = executorWith(project, { evidenceExtractor: extractor }, 2);
    await expect(executor.execute(ITEM_1, ctxFor(jobId, cap))).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(extractor.calls.n).toBe(1);
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO + ACTUAL_MICRO);
  });

  it("a transient failure before the answer keeps its full reservation; only the attempt that answered settles", async () => {
    const { jobId, project } = await makeJob();
    const calls = { n: 0 };
    const extractor: EvidenceExtractor = {
      name: "fixture-transient-then-ok",
      async extract(input) {
        calls.n += 1;
        if (calls.n === 1) throw new EvidenceExtractorUnavailableError("generation failed: PROVIDER_SERVER_ERROR:503", true, "PROVIDER_SERVER_ERROR", 503);
        input.onUsage?.(USAGE);
        return [factFor(input.target)];
      },
    };
    const result = await executorWith(project, { evidenceExtractor: extractor }, 1).execute(ITEM_1, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(calls.n).toBe(2);
    // proposer max + attempt 1 (failed, "not a free retry") + attempt 2 settled.
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO + MAX_MICRO + ACTUAL_MICRO);
  });

  it("a truncated output keeps its full reservation (no usage is captured); the COMPACT retry settles on its own", async () => {
    const { jobId, project } = await makeJob();
    const modes: string[] = [];
    const extractor: EvidenceExtractor = {
      name: "fixture-truncated-then-compact",
      async extract(input) {
        modes.push(input.mode ?? "FULL");
        if (modes.length === 1) throw new EvidenceExtractorUnavailableError("model output truncated (max_tokens)", false, "MAX_TOKENS_TRUNCATED");
        input.onUsage?.(USAGE);
        return [factFor(input.target)];
      },
    };
    const result = await executorWith(project, { evidenceExtractor: extractor }, 1).execute(ITEM_1, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(modes).toEqual(["FULL", "COMPACT"]);
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO + MAX_MICRO + ACTUAL_MICRO);
  });

  it("an unsupported billing category is never priced, so it is never settled: the maximum stays", async () => {
    const { jobId, project } = await makeJob();
    const extractor = usageReportingExtractor({ ...USAGE, unsupportedBillingUsage: true });
    const result = await executorWith(project, { evidenceExtractor: extractor }, 1).execute(ITEM_1, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO + MAX_MICRO);
  });

  it("a call that answered but whose output could not be read still settles — the provider billed it", async () => {
    const { jobId, project } = await makeJob();
    const extractor: EvidenceExtractor = {
      name: "fixture-bad-json",
      async extract(input) {
        input.onUsage?.(USAGE);
        throw new EvidenceExtractorUnavailableError("model output is not valid JSON", false, "OUTPUT_NOT_JSON");
      },
    };
    const result = await executorWith(project, { evidenceExtractor: extractor }, 1).execute(ITEM_1, ctxFor(jobId));
    expect(result.status).toBe("FAILED");
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO + ACTUAL_MICRO);
  });

  it("fixtures that report no usage are untouched: the pre-settlement accounting is byte-identical", async () => {
    const { jobId, project } = await makeJob();
    const silent: EvidenceExtractor = { name: "fixture-silent", async extract(input) { return [factFor(input.target)]; } };
    const result = await executorWith(project, { evidenceExtractor: silent }, 3).execute(ITEM_1, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(await reservedMicro(jobId)).toBe(MAX_MICRO + 3 * MAX_MICRO);
  });
});

describe("4. the phased SEARCH phase — the proposer's reservation settles under the same rule", () => {
  it("every metered proposer call settles to its reported usage; the trace row keeps the authorized maximum beside the actual", async () => {
    const { jobId, project } = await makeJob({ plan: true });
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: "docs.settle.test", pathPrefix: "/page" });
    if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
    const { view } = await loadJobContractView(ctx.db, jobId);
    const proposerUsage: ModelUsage = { inputTokens: 600, outputTokens: 25 }; // 600 + 125 = 725
    const proposerActual = 600 * COST.inputPriceMicroUsdPerToken + 25 * COST.outputPriceMicroUsdPerToken;
    const search = await runSearchPhase({
      db: ctx.db,
      jobId,
      items: view.workQueue,
      target: (item) => ({
        step: item.step,
        stepName: item.stepName,
        component: item.component,
        projectId: project.id,
        projectName: project.name,
        projectSlug: project.slug,
      }),
      queryProposer: { name: "fixture", async proposeQueries() { return ["q-alpha"]; } },
      searchGateway: { name: "fixture", async search() { return [{ url: "https://docs.settle.test/page-1", title: null, snippet: null }]; } },
      maxSearchQueries: 12,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 2,
      maxModelCostMicro: 10_000_000,
      projectId: project.id,
      queryProposerCostProfile: COST,
      readProposerUsage: () => proposerUsage,
    });
    expect(search.proposerCalls).toBeGreaterThan(0);
    expect(search.proposerReservedMicro).toBe(search.proposerCalls * MAX_MICRO);
    expect(await reservedMicro(jobId)).toBe(search.proposerCalls * proposerActual);
  });
});

describe("5. research_attempts.completed_at is the moment the attempt finished, not the run's logical clock", () => {
  it("three attempts run one after another carry three distinct, increasing completion times, each after its own creation", async () => {
    const { jobId } = await makeJob({ plan: true });
    const { view } = await loadJobContractView(ctx.db, jobId);
    const items = view.workQueue.slice(0, 3);
    const slowExecutor: WorkExecutor = {
      async execute() {
        await new Promise((r) => setTimeout(r, 25));
        return { status: "SUCCEEDED", reason: "fixture" };
      },
    };
    const logicalNow = new Date("2026-08-21T00:00:00Z");
    const result = await runResearchController({ db: ctx.db, jobId, view: { ...view, workQueue: items }, executor: slowExecutor, now: logicalNow });
    expect(result.attemptsThisRun).toBe(3);
    const rows = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId))
      .orderBy(asc(researchAttempts.createdAt));
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.completedAt).not.toBeNull();
      expect(row.completedAt!.getTime()).not.toBe(logicalNow.getTime());
      // Written by this process after the executor returned, while
      // created_at is the database default at claim time: completion can
      // never precede creation (a small clock tolerance between the two
      // writers is allowed, the 25 ms of work is not).
      expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime() - 5);
    }
    const completed = rows.map((r) => r.completedAt!.getTime());
    expect(completed[1]).toBeGreaterThan(completed[0]);
    expect(completed[2]).toBeGreaterThan(completed[1]);
  });
});
