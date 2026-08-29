import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  projects,
  proofs,
  researchAttempts,
  researchJobs,
  topics,
  users,
} from "../src/server/db/schema";
import {
  prepareExtractionReplayFetcher,
  prepareExtractionReplayProposer,
  prepareExtractionReplaySearch,
  runFetchPhase,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import { replayContentFetcher } from "../src/server/engine/acquired-documents";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import {
  isReplayProvider,
  PROVIDER_METERING,
  type ComponentTarget,
  type ExtractedFact,
  type FetchedDocument,
} from "../src/server/engine/providers/types";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-137 — REPLAY-AWARE BUDGET METERING.
//
// The research-job budget measures REAL external capability consumption.
// A provider that serves already-persisted results performs none, so it
// must not consume that capability's budget a second time. The default
// stays expensive: only an explicit, typed "REPLAY" is free.
//
// Everything here is offline. The point of the round is accounting, so
// almost every assertion is about a counter.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const DOC_URL = "https://docs.example-project.test/mechanism";
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

function fixtureDoc(url: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText:
      "Protocol fees are used to buy back the token, and bought-back tokens are held at a public address.",
    contentHash: "sha256:fixture",
    fetchedAt: new Date("2026-08-29T00:00:00Z"),
    byteLength: 120,
  };
}

function validFact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 6,
    component: "DESTINATION",
    statement: "Bought-back tokens are held at a public address.",
    supportFragment: "bought-back tokens are held at a public address",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not establish that any buyback executed",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
    ...over,
  };
}

// LIVE fixtures — none of them declares metering, so all of them are
// charged. That absence is the point: a provider written without any
// thought about D-137 behaves exactly as it did before D-137.
function liveProposer(queries: string[], calls = { n: 0 }): QueryProposer & { calls: { n: number } } {
  return {
    name: "live-proposer",
    calls,
    async proposeQueries() {
      calls.n += 1;
      return queries;
    },
  };
}

function liveSearch(byQuery: Record<string, string[]>, calls = { n: 0 }): SearchGateway & { calls: { n: number } } {
  return {
    name: "live-search",
    calls,
    async search(query: string) {
      calls.n += 1;
      return (byQuery[query] ?? []).map((url) => ({ url, title: null, snippet: null }));
    },
  };
}

function liveFetcher(calls = { n: 0, urls: [] as string[] }): ContentFetcher & { calls: { n: number; urls: string[] } } {
  return {
    name: "live-transport",
    calls,
    async fetch(url: string) {
      calls.n += 1;
      calls.urls.push(url);
      return fixtureDoc(url);
    },
  };
}

// A wrapper that COUNTS a replay provider without hiding what it is. The
// declaration has to be carried across deliberately — a wrapper that drops
// it is charged, which is the fail-closed direction.
function countingReplayFetcher(inner: ContentFetcher, calls: { n: number; urls: string[] }): ContentFetcher {
  return {
    name: inner.name,
    metering: inner.metering,
    async fetch(url: string) {
      calls.n += 1;
      calls.urls.push(url);
      return inner.fetch(url);
    },
  };
}

async function makeClassifiedProject() {
  const slug = uniq("d137");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D137 Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("fixture identity failed");
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: "docs.example-project.test",
    pathPrefix: "/mechanism",
  });
  if (!confirmed.ok) throw new Error("fixture route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("fixture route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function counters(jobId: string) {
  const [row] = await ctx.db
    .select({
      searchQueries: researchJobs.searchQueriesReserved,
      sourceOpens: researchJobs.sourceOpensReserved,
      modelCostMicro: researchJobs.modelCostMicroReserved,
    })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row;
}

async function attemptsFor(jobId: string) {
  return ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
}

function targetFor(project: { id: string; name: string; slug: string }) {
  return (item: ComponentWorkItem): ComponentTarget => ({
    step: item.step,
    stepName: item.stepName,
    component: item.component,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });
}

// Runs SEARCHING and FETCHING with LIVE fixtures, exactly as the phased
// worker does, and reports what those phases really cost.
async function runLivePhases(jobId: string, project: { id: string; name: string; slug: string }) {
  const { job, view } = await loadJobContractView(ctx.db, jobId);
  const budget = job.budgetAtStart as { maxSearchQueries: number; maxSourceOpens: number };
  const searchCalls = { n: 0 };
  const fetchCalls = { n: 0, urls: [] as string[] };
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue,
    target: targetFor(project),
    queryProposer: liveProposer(["q-alpha"]),
    searchGateway: liveSearch({ "q-alpha": [DOC_URL] }, searchCalls),
    maxSearchQueries: budget.maxSearchQueries,
    maxResultsPerQuery: 5,
    maxQueriesPerComponent: 2,
  });
  await runFetchPhase({
    db: ctx.db,
    jobId,
    projectId: project.id,
    contentFetcher: liveFetcher(fetchCalls),
    maxSourceOpens: budget.maxSourceOpens,
  });
  return { searchCalls, fetchCalls };
}

async function runReplayExtraction(
  jobId: string,
  project: { id: string; name: string; slug: string },
  opts: { fetcher?: ContentFetcher; extractCalls?: { n: number } } = {},
) {
  const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
  const extractCalls = opts.extractCalls ?? { n: 0 };
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
    searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
    contentFetcher: opts.fetcher ?? replay.fetcher,
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract() {
        extractCalls.n += 1;
        return [validFact()];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: "DOCUMENTARY_ONLY",
  });
  return { result: await runS4ResearchJob(ctx.db, jobId, executor, new Date()), extractCalls };
}

describe("D-137 §1 — the metering contract itself (items 8, 9)", () => {
  it("8/9. the default is chargeable, and only an explicit typed REPLAY is free", () => {
    expect([...PROVIDER_METERING]).toEqual(["LIVE", "REPLAY"]);

    // Absence charges. This is the case that matters: every provider
    // written before D-137 says nothing, and must keep costing money.
    expect(isReplayProvider({ name: "x" } as ContentFetcher)).toBe(false);
    expect(isReplayProvider(undefined)).toBe(false);
    expect(isReplayProvider(null)).toBe(false);
    expect(isReplayProvider({ metering: "LIVE" })).toBe(false);

    // Only the exact value opts out. Anything else — a typo, a truthy
    // value, a lookalike — is billable.
    expect(isReplayProvider({ metering: "REPLAY" })).toBe(true);
    for (const wrong of ["replay", "Replay", "FREE", "TRUE", "", " REPLAY"]) {
      expect(isReplayProvider({ metering: wrong } as never), `"${wrong}" must not opt out`).toBe(false);
    }
    expect(isReplayProvider({ metering: true } as never)).toBe(false);
    expect(isReplayProvider({ metering: 1 } as never)).toBe(false);
  });

  it("every replay provider in the codebase declares itself, and no live one does", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);

    const { fetcher } = await prepareExtractionReplayFetcher(ctx.db, jobId);
    expect(isReplayProvider(fetcher)).toBe(true);
    expect(isReplayProvider(await prepareExtractionReplaySearch(ctx.db, jobId))).toBe(true);
    expect(isReplayProvider(await prepareExtractionReplayProposer(ctx.db, jobId))).toBe(true);
    // D-128's single-document replay too — it was always network-
    // impossible; now the accounting says so as well.
    expect(isReplayProvider(replayContentFetcher(fixtureDoc(DOC_URL)))).toBe(true);

    // The live fixtures say nothing at all, and are therefore charged.
    expect(isReplayProvider(liveProposer([]))).toBe(false);
    expect(isReplayProvider(liveSearch({}))).toBe(false);
    expect(isReplayProvider(liveFetcher())).toBe(false);
  });

  it("a wrapper that drops the declaration is charged — fail closed, not fail convenient", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);
    const { fetcher } = await prepareExtractionReplayFetcher(ctx.db, jobId);

    // Wrapping without carrying `metering` produces a provider that says
    // nothing about itself, so it is billable. A wrapper cannot silently
    // inherit a discount.
    const naive: ContentFetcher = { name: fetcher.name, fetch: (u) => fetcher.fetch(u) };
    expect(isReplayProvider(naive)).toBe(false);
    // Carrying it deliberately keeps the discount.
    const careful = countingReplayFetcher(fetcher, { n: 0, urls: [] });
    expect(isReplayProvider(careful)).toBe(true);
  });
});

describe("D-137 §2 — live work is still charged (items 1, 3, 5, 7)", () => {
  it("1/3/5. the live phases charge exactly what they really called", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    expect(await counters(jobId)).toEqual({ searchQueries: 0, sourceOpens: 0, modelCostMicro: 0 });

    const { searchCalls, fetchCalls } = await runLivePhases(jobId, project);
    const after = await counters(jobId);
    // One reserved unit per real external call. Not a proxy, not an
    // estimate — the same number the fixture counted.
    expect(after.searchQueries).toBe(searchCalls.n);
    expect(after.sourceOpens).toBe(fetchCalls.n);
    expect(searchCalls.n).toBeGreaterThan(0);
    expect(fetchCalls.n).toBeGreaterThan(0);
  });

  it("7. a live extractor is still charged its model budget in EXTRACTING", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);
    const before = await counters(jobId);

    const { extractCalls } = await runReplayExtraction(jobId, project);
    const after = await counters(jobId);

    // Extraction is REAL model work and pays for it. D-137 did not make
    // EXTRACTING globally free.
    expect(extractCalls.n).toBeGreaterThan(0);
    expect(after.modelCostMicro).toBeGreaterThan(before.modelCostMicro);
  });

  it("the single-process path is metered exactly as before: every fixture provider is charged", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    const searchCalls = { n: 0 };
    const fetchCalls = { n: 0, urls: [] as string[] };
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
      queryProposer: liveProposer(["q-alpha"]),
      searchGateway: liveSearch({ "q-alpha": [DOC_URL] }, searchCalls),
      contentFetcher: liveFetcher(fetchCalls),
      evidenceExtractor: { name: "fixture-extractor", async extract() { return [validFact()]; } },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobId, executor, new Date());

    const after = await counters(jobId);
    // Every real call is on the meter, and nothing else is.
    expect(after.searchQueries).toBe(searchCalls.n);
    expect(after.sourceOpens).toBe(fetchCalls.n);
    expect(after.modelCostMicro).toBeGreaterThan(0);
  });
});

describe("D-137 §3 — replayed work is not charged twice (items 2, 4, 6, 10)", () => {
  it("2/4/6. EXTRACTING over replay providers adds nothing to the acquisition axes", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);
    const before = await counters(jobId);

    const replayFetchCalls = { n: 0, urls: [] as string[] };
    const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
    await runReplayExtraction(jobId, project, {
      fetcher: countingReplayFetcher(replay.fetcher, replayFetchCalls),
    });
    const after = await counters(jobId);

    // THE decision, in three numbers: the replay providers were used —
    // really used, the counter proves it — and cost nothing.
    expect(replayFetchCalls.n).toBeGreaterThan(0);
    expect(after.searchQueries).toBe(before.searchQueries);
    expect(after.sourceOpens).toBe(before.sourceOpens);

    // The proposer axis is shared with the extractor, so it cannot be
    // compared as a whole. What can be checked exactly: no MODEL_CALL
    // row was written for the replay proposer at any cost.
    const proposerRows = await ctx.db.execute(
      sql`SELECT coalesce(sum(budget_amount), 0)::int AS total
          FROM research_trace_events
          WHERE research_job_id = ${jobId}
            AND provider_kind = 'QUERY_PROPOSE'
            AND provider_name = 'query-replay'`,
    );
    expect((proposerRows.rows[0] as { total: number }).total).toBe(0);
  });

  it("10. replaying the same work again still costs nothing", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);
    const before = await counters(jobId);

    await runReplayExtraction(jobId, project);
    const afterFirst = await counters(jobId);
    await runReplayExtraction(jobId, project);
    const afterSecond = await counters(jobId);

    expect(afterFirst.searchQueries).toBe(before.searchQueries);
    expect(afterFirst.sourceOpens).toBe(before.sourceOpens);
    expect(afterSecond.searchQueries).toBe(before.searchQueries);
    expect(afterSecond.sourceOpens).toBe(before.sourceOpens);
  });

  it("D-128's resumed single-document path is no longer charged for a sealed document", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);
    const before = await counters(jobId);

    const replayFetchCalls = { n: 0, urls: [] as string[] };
    await runReplayExtraction(jobId, project, {
      fetcher: countingReplayFetcher(replayContentFetcher(fixtureDoc(DOC_URL)), replayFetchCalls),
    });

    expect(replayFetchCalls.n).toBeGreaterThan(0);
    expect((await counters(jobId)).sourceOpens).toBe(before.sourceOpens);
  });
});

describe("D-137 §4 — equivalence and non-drift (items 11, 12, 13, 18)", () => {
  it("18. the phased path charges only real external work, and never more than single-process", async () => {
    // A — single process, live providers throughout.
    const projectA = await makeClassifiedProject();
    const jobA = await makeJob(projectA.id);
    const searchA = { n: 0 };
    const fetchA = { n: 0, urls: [] as string[] };
    const executorA = createS4WorkExecutor({
      db: ctx.db,
      project: { id: projectA.id, name: projectA.name, slug: projectA.slug, ticker: null },
      queryProposer: liveProposer(["q-alpha"]),
      searchGateway: liveSearch({ "q-alpha": [DOC_URL] }, searchA),
      contentFetcher: liveFetcher(fetchA),
      evidenceExtractor: { name: "fixture-extractor", async extract() { return [validFact()]; } },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobA, executorA, new Date());
    const a = await counters(jobA);

    // B — the same deterministic work, phased across queues.
    const projectB = await makeClassifiedProject();
    const jobB = await makeJob(projectB.id);
    const { searchCalls: searchB, fetchCalls: fetchB } = await runLivePhases(jobB, projectB);
    const beforeExtractionB = await counters(jobB);
    await runReplayExtraction(jobB, projectB);
    const b = await counters(jobB);

    // Crossing queues adds ZERO. This is the whole claim.
    expect(b.searchQueries).toBe(beforeExtractionB.searchQueries);
    expect(b.sourceOpens).toBe(beforeExtractionB.sourceOpens);

    // And every unit B did charge corresponds to one real external call.
    expect(b.searchQueries).toBe(searchB.n);
    expect(b.sourceOpens).toBe(fetchB.n);

    // Both paths reached the same kind of result...
    const [proofA] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobA));
    const [proofB] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobB));
    expect(proofA).toBeTruthy();
    expect(proofB).toBeTruthy();

    // ...and the phased one never cost MORE than the single-process one
    // for it. (It legitimately costs less: it opens each document once
    // and replays it, where the single-process path re-opens per
    // component. Phasing may save real calls; it must never invent them.)
    expect(b.searchQueries).toBeLessThanOrEqual(a.searchQueries);
    expect(b.sourceOpens).toBeLessThanOrEqual(a.sourceOpens);
    expect(searchA.n).toBeGreaterThan(0);
    expect(fetchA.n).toBeGreaterThan(0);
  });

  it("12/13. attempt numbering and the recovery pool are untouched by the accounting change", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);
    await runReplayExtraction(jobId, project);

    const attempts = await attemptsFor(jobId);
    expect(attempts.length).toBeGreaterThan(0);
    // Every component attempt is still a FIRST attempt — which is exactly
    // the statement that no recovery step was consumed.
    for (const a of attempts) expect(a.attemptNumber).toBe(1);
    expect(attempts.filter((a) => a.attemptNumber > 1)).toHaveLength(0);
  });

  it("11. per-attempt spend rows tell the truth: a replayed attempt spent nothing external", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runLivePhases(jobId, project);
    await runReplayExtraction(jobId, project);

    const attempts = await attemptsFor(jobId);
    // The per-attempt record is not merely "not over-charged" — it is
    // zero on both acquisition axes, because the attempt made no search
    // call and opened no source.
    for (const a of attempts) {
      expect(a.searchQueriesSpent).toBe(0);
      expect(a.sourceOpensSpent).toBe(0);
    }
    // Model spend is NOT zero: the extractor really ran.
    expect(attempts.some((a) => a.modelCostMicroSpent > 0)).toBe(true);
  });
});

describe("D-137 §5 — boundaries (items 19, 20)", () => {
  it("19/20. metering is declared by providers, not inferred from network, role or project", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/server/engine/providers/types.ts",
      "src/server/engine/acquisition-phases.ts",
      "src/server/jobs/worker-capabilities.ts",
    ];
    const forbidden = ["mantaray", "vpn", "proxy", "region", "country", "raydium", "pump_fun"];
    for (const file of files) {
      const code = (await readFile(file, "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const word of forbidden) {
        expect(code, `${file} must not name ${word}`).not.toContain(word);
      }
    }

    // And the decision function reads exactly one field — no instanceof,
    // no class name, no file name, no phase, no role.
    const src = await readFile("src/server/engine/providers/types.ts", "utf-8");
    const fn = src.slice(src.indexOf("export function isReplayProvider"));
    expect(fn).toContain('provider?.metering === "REPLAY"');
    expect(fn).not.toContain("instanceof");
    expect(fn).not.toContain("constructor");
    expect(fn).not.toContain("acquisitionPhase");
  });

  it("the executor decides metering only from the provider it was given", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/s4-executor.ts", "utf-8");
    for (const call of [
      "isReplayProvider(queryProposer)",
      "isReplayProvider(searchGateway)",
      "isReplayProvider(contentFetcher)",
    ]) {
      expect(src).toContain(call);
    }
    expect(src).not.toContain("acquisitionPhase");
    expect(src).not.toContain("workerServesPhase");
  });
});
