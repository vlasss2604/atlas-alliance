import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { acquiredDocuments, evidence, projects, proofs, researchAttempts, researchJobs, researchPlans, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { loadActivePatternVersion } from "../src/server/engine/active-pattern";
import {
  prepareExtractionReplayFetcher,
  prepareExtractionReplayProposer,
  prepareExtractionReplaySearch,
  runFetchPhase,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import { buildContractView, type ComponentWorkItem } from "../src/server/engine/contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ComponentTarget, ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { parseContract } from "../src/server/memory/contract";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// AAVE LIVE REGRESSION (job 2b0f00e4, 2026-09-19) — THE FIRST LIVE RESEARCH
// THROUGH THE PHASED PIPELINE EXTRACTED NOTHING.
//
// The persisted shape: the SEARCH phase spent all twelve units of the
// INTERNAL_ALPHA_V1 envelope across ten components (fair share, correct);
// the FETCH phase opened nineteen urls and sealed sixteen documents; then
// the EXTRACTING phase closed EVERY documentary component as
// SKIPPED / SEARCH_BUDGET_EXHAUSTED after a MODEL_CALL_SKIPPED
// (SEARCH_QUERY_BUDGET_EXHAUSTED) row — zero EXTRACT_ATTEMPTED rows, zero
// Evidence, a Proof with nothing documentary in it.
//
// The gap is generic and has nothing to do with Aave: bounded search
// finalization (9a483c5) read "component allowance is 0" as "the search
// axis is exhausted, close the component", and that reading was applied to
// the EXTRACTING replay, whose proposer, gateway and fetcher are replay
// providers that reserve nothing (D-137). Under a job whose OWN budget
// snapshot is the envelope the SEARCH phase spent to the last unit, the
// allowance at replay time is always 0 — so every phased live Research
// under INTERNAL_ALPHA_V1 would have ended the same way. The unphased
// executor (alpha-run) never showed it because there the metered gateway
// and the allowance move together.
//
// This suite reproduces the persisted shape on a generic fixture project
// and pins: (1) a replay is bounded by what was searched, never by what is
// left to search — every component the FETCH phase sealed documents for
// reaches extraction and persists Evidence; (2) the metered path keeps its
// bounded close exactly: with the axis spent and a real gateway, the
// component still closes SKIPPED / SEARCH_BUDGET_EXHAUSTED with no call.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const HOST = "docs.phased-regression.test";
const SENTENCE = "Protocol fees are used to buy back the token and bought-back tokens are held at a public address.";
const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
const URL_POOL = Array.from({ length: 8 }, (_, i) => `https://${HOST}/mechanism/page-${i}`);
function queriesFor(component: string): string[] {
  return [`${component} mechanism`, `${component} tokenomics`];
}
function urlsFor(query: string): string[] {
  let h = 0;
  for (const ch of query) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [URL_POOL[h % URL_POOL.length], URL_POOL[(h + 3) % URL_POOL.length]];
}
function fixtureDoc(url: string): FetchedDocument {
  const text = `${SENTENCE} Details for ${url}.`;
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText: text,
    contentHash: `sha256:${url}`,
    fetchedAt: new Date("2026-08-29T00:00:00Z"),
    byteLength: text.length,
  };
}

async function makeClassifiedProject() {
  const slug = uniq("phased");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Phased Regression", status: "ACTIVE_CORE" }).returning();
  const identity = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
  if (!identity.ok) throw new Error("identity failed");
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/mechanism" });
  if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}

// THE LIVE SHAPE: the job's own budget snapshot IS the envelope the phases
// spend — exactly what start-owner-alpha-research.ts records.
async function makeAlphaJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "does protocol revenue buy back the token, and where does it go?",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: { level: "ARI_CORE", capability: "FRESH_RESEARCH", budget: INTERNAL_ALPHA_V1 },
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

async function workQueueFor(jobId: string): Promise<ComponentWorkItem[]> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [planRow] = await ctx.db.select().from(researchPlans).where(eq(researchPlans.researchJobId, jobId)).orderBy(desc(researchPlans.version)).limit(1);
  const contract = parseContract(planRow.contract);
  const activePatternVersion = await loadActivePatternVersion(ctx.db, job.topicId!);
  return [...buildContractView({ contract, mode: planRow.mode, capabilityAtStart: job.capabilityAtStart, activePatternVersion: activePatternVersion! }).workQueue];
}

async function runPhased() {
  const counters = { proposer: 0, search: 0, fetch: 0, extract: 0 };
  const project = await makeClassifiedProject();
  const jobId = await makeAlphaJob(project.id);
  const target = (item: ComponentWorkItem): ComponentTarget => ({
    step: item.step,
    stepName: item.stepName,
    component: item.component,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });
  await runMemoryPlanningStage(ctx.db, jobId);
  const items = await workQueueFor(jobId);
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items,
    target,
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        counters.proposer += 1;
        return queriesFor(input.target.component);
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query) {
        counters.search += 1;
        return urlsFor(query).map((url) => ({ url, title: null, snippet: null }));
      },
    },
    maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
    maxResultsPerQuery: 5,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });
  await runFetchPhase({
    db: ctx.db,
    jobId,
    projectId: project.id,
    contentFetcher: {
      name: "fixture-transport",
      async fetch(url: string) {
        counters.fetch += 1;
        return fixtureDoc(url);
      },
    },
    maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
  });
  const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
    searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
    contentFetcher: replay.fetcher,
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        counters.extract += 1;
        const fact: ExtractedFact = {
          step: input.target.step,
          component: input.target.component,
          statement: SENTENCE,
          supportFragment: SENTENCE,
          mechanismState: null,
          directness: "DIRECT",
          publishedAt: null,
          doesNotProve: "does not establish that any buyback executed",
          relationship: "SUPPORTS",
          onchainLocator: null,
          onchainLocators: null,
        };
        return [fact];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: "DOCUMENTARY_ONLY",
  });
  await runS4ResearchJob(ctx.db, jobId, executor, new Date());
  return { jobId, counters, items };
}

describe("phased EXTRACTING replay under a spent search axis — the Aave live shape, generically", () => {
  it("the SEARCH phase spends the whole envelope, and the replay still extracts every sealed document: no component closes SEARCH_BUDGET_EXHAUSTED, Evidence and a Proof exist", async () => {
    const { jobId, counters, items } = await runPhased();

    // The persisted precondition of the live failure: the job's own axis is
    // spent to the last unit BEFORE extraction begins.
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.searchQueriesReserved).toBe(INTERNAL_ALPHA_V1.maxSearchQueries);
    expect(counters.search).toBe(INTERNAL_ALPHA_V1.maxSearchQueries);
    const docs = await ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(docs.length).toBeGreaterThan(0);

    // THE REGRESSION: with sealed documents waiting, the replay extracted.
    expect(counters.extract, "no extraction ran over the sealed documents").toBeGreaterThan(0);
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
    const extractAttempted = trace.filter((t) => t.operationType === "EXTRACT_ATTEMPTED");
    expect(extractAttempted.length).toBe(counters.extract);
    // Scoped to attempt rows: the SEARCH phase legitimately records the
    // same code (D-140 fair share) with no attempt, and that is not replay.
    const proposerSkippedForBudget = trace.filter(
      (t) =>
        t.researchAttemptId !== null &&
        t.operationType === "MODEL_CALL_SKIPPED" &&
        t.providerKind === "QUERY_PROPOSE" &&
        t.reasonCode === "SEARCH_QUERY_BUDGET_EXHAUSTED",
    );
    expect(proposerSkippedForBudget, "the replay proposer was skipped as if the axis bounded it").toEqual([]);

    // Every component the SEARCH phase searched for (and so the FETCH phase
    // sealed documents for) was extracted for, and none closed on the axis.
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBe(items.length);
    const closedOnAxis = attempts.filter((a) => a.reason?.startsWith("SEARCH_BUDGET_EXHAUSTED"));
    expect(closedOnAxis.map((a) => a.component), "components closed on a spent axis during replay").toEqual([]);
    const searchedComponents = new Set(trace.filter((t) => t.operationType === "SEARCH_EXECUTED" && t.status === "OK").map((t) => t.component));
    const extractedComponents = new Set(extractAttempted.map((t) => t.component));
    for (const c of searchedComponents) expect(extractedComponents.has(c!), `${c} was searched for but never extracted for`).toBe(true);

    // And the run persisted what it read.
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.length).toBeGreaterThan(0);
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof).toBeDefined();
    // Replay reserved nothing: the axis stands exactly where the SEARCH
    // phase left it.
    const [after] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(after.searchQueriesReserved).toBe(INTERNAL_ALPHA_V1.maxSearchQueries);
  }, 120_000);

  it("the METERED path is unchanged: with the axis already spent and a real gateway, a component still closes SKIPPED / SEARCH_BUDGET_EXHAUSTED and calls nothing", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeAlphaJob(project.id);
    await runMemoryPlanningStage(ctx.db, jobId);
    // Spend the axis exactly as the live job had it spent.
    await ctx.db.update(researchJobs).set({ searchQueriesReserved: INTERNAL_ALPHA_V1.maxSearchQueries }).where(eq(researchJobs.id, jobId));
    const calls = { proposer: 0, search: 0, fetch: 0, extract: 0 };
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
      queryProposer: {
        name: "fixture-proposer",
        async proposeQueries(input) {
          calls.proposer += 1;
          return queriesFor(input.target.component);
        },
      },
      searchGateway: {
        name: "fixture-search",
        async search(query) {
          calls.search += 1;
          return urlsFor(query).map((url) => ({ url, title: null, snippet: null }));
        },
      },
      contentFetcher: {
        name: "fixture-transport",
        async fetch(url: string) {
          calls.fetch += 1;
          return fixtureDoc(url);
        },
      },
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract() {
          calls.extract += 1;
          return [];
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobId, executor, new Date());
    expect(calls).toEqual({ proposer: 0, search: 0, fetch: 0, extract: 0 });
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) {
      expect(a.status).toBe("SKIPPED");
      expect(a.reason?.startsWith("SEARCH_BUDGET_EXHAUSTED")).toBe(true);
    }
    // Nothing was reserved by the bounded close either.
    const [after] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(after.searchQueriesReserved).toBe(INTERNAL_ALPHA_V1.maxSearchQueries);
  }, 120_000);
});
