import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  acquiredDocuments,
  evidence,
  projects,
  proofs,
  researchJobs,
  researchPlans,
  topics,
  users,
} from "../src/server/db/schema";
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
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// SPEED + COST — THE PIPELINE TIMING MODEL.
//
// One "normal" Research driven through the REAL phased pipeline — the real
// search phase, the real fetch phase, the real replay providers, the real
// controller, S5–S8 — over fixture providers that (a) count every call and
// (b) sleep a MODELLED latency per call. The modelled latencies are
// deliberately conservative typical values, not measurements of any live
// provider; what this file measures faithfully is the STRUCTURE: how many
// calls happen, and how many of them are on the serial critical path.
//
//   PERF_SCALE=1     the measurement run (tens of seconds; prints a table)
//   PERF_SCALE unset a structural regression (latencies ~0; counts only)
//
// FASTER MUST NOT MEAN WEAKER: the counts asserted here are the contract
// every optimisation in this phase is measured against, and the Proof the
// run produces is compared by the normal suites, not here.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const SCALE = Number(process.env.PERF_SCALE ?? "0.005");
// Modelled per-call latencies (ms at SCALE=1). Conservative typical values.
const LAT = {
  proposer: 1500, // one Anthropic call per component
  search: 400, // one Brave call per query
  fetch: 800, // one HTTPS document fetch per unique url
  extract: 2500, // one Anthropic call per (component, document)
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.round(ms * SCALE)));

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const HOST = "docs.perf-model.test";
const SENTENCE = "Protocol fees are used to buy back the token and bought-back tokens are held at a public address.";
const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

// THE WORKLOAD. Ten components, two queries each, two candidate urls per
// query drawn from a pool of eight — so urls overlap across components and
// fetch-level dedup is exercised, exactly as real search results overlap.
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
  const slug = uniq("perf");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Perf Model", status: "ACTIVE_CORE" }).returning();
  const identity = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
  if (!identity.ok) throw new Error("identity failed");
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/mechanism" });
  if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "does revenue reach the token?",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
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

interface Counters {
  proposer: number;
  search: number;
  fetch: number;
  extract: number;
  fetchedUrls: string[];
  extractPairs: string[];
}

interface Timing {
  jobId: string;
  memoryPlanningMs: number;
  searchMs: number;
  fetchMs: number;
  extractMs: number;
  totalMs: number;
  counters: Counters;
  uniqueUrls: number;
  components: number;
}

export async function runModelledResearch(): Promise<Timing> {
  const counters: Counters = { proposer: 0, search: 0, fetch: 0, extract: 0, fetchedUrls: [], extractPairs: [] };
  const project = await makeClassifiedProject();
  const jobId = await makeJob(project.id);
  const target = (item: ComponentWorkItem): ComponentTarget => ({
    step: item.step,
    stepName: item.stepName,
    component: item.component,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });

  const t0 = performance.now();
  await runMemoryPlanningStage(ctx.db, jobId);
  const t1 = performance.now();

  const items = await workQueueFor(jobId);
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items,
    target,
    queryProposer: {
      name: "modelled-proposer",
      async proposeQueries(input) {
        counters.proposer += 1;
        await sleep(LAT.proposer);
        return queriesFor(input.target.component);
      },
    },
    searchGateway: {
      name: "modelled-search",
      async search(query) {
        counters.search += 1;
        await sleep(LAT.search);
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
  const t2 = performance.now();

  await runFetchPhase({
    db: ctx.db,
    jobId,
    projectId: project.id,
    contentFetcher: {
      name: "modelled-transport",
      async fetch(url: string) {
        counters.fetch += 1;
        counters.fetchedUrls.push(url);
        await sleep(LAT.fetch);
        return fixtureDoc(url);
      },
    },
    maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
  });
  const t3 = performance.now();

  const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
    searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
    contentFetcher: replay.fetcher,
    evidenceExtractor: {
      name: "modelled-extractor",
      async extract(input) {
        counters.extract += 1;
        counters.extractPairs.push(`${input.target.component}|${input.document.finalUrl}`);
        await sleep(LAT.extract);
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
  const t4 = performance.now();

  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  expect(proof, "the modelled run produced no Proof").toBeDefined();
  const docs = await ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId));
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
  expect(rows.length).toBeGreaterThan(0);

  return {
    jobId,
    memoryPlanningMs: t1 - t0,
    searchMs: t2 - t1,
    fetchMs: t3 - t2,
    extractMs: t4 - t3,
    totalMs: t4 - t0,
    counters,
    uniqueUrls: docs.length,
    components: items.length,
  };
}

function fmt(ms: number): string {
  return `${(ms / 1000 / SCALE).toFixed(1).padStart(7)} s (modelled)`;
}

describe("PIPELINE TIMING MODEL — one normal Research through the real phased pipeline", () => {
  it("measures the serial structure and pins the provider call counts", async () => {
    const t = await runModelledResearch();
    const c = t.counters;

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        `PIPELINE TIMING MODEL  (PERF_SCALE=${SCALE}; acquisition concurrency ${process.env.ATLAS_ACQUISITION_CONCURRENCY ?? "default 4"}, extraction concurrency ${process.env.ATLAS_EXTRACTION_CONCURRENCY ?? "default 1"}; modelled latencies proposer ${LAT.proposer}ms, search ${LAT.search}ms, fetch ${LAT.fetch}ms, extract ${LAT.extract}ms)`,
        `  components in work queue : ${t.components}`,
        `  memory planning          : ${fmt(t.memoryPlanningMs)}`,
        `  SEARCH phase             : ${fmt(t.searchMs)}   proposer calls ${c.proposer}, search calls ${c.search}`,
        `  FETCH phase              : ${fmt(t.fetchMs)}   fetch calls ${c.fetch}, unique urls ${t.uniqueUrls}`,
        `  EXTRACT + S5..S8         : ${fmt(t.extractMs)}   extract calls ${c.extract}`,
        `  TOTAL                    : ${fmt(t.totalMs)}`,
        "",
      ].join("\n"),
    );

    // THE STRUCTURAL CONTRACT — what any optimisation must preserve.
    // One proposer call per component; one search per query; one fetch per
    // unique url and never a repeat; one extraction per (component, document).
    // Route-aware reachability skips a component with no confirmed route
    // for its establishing classes BEFORE proposing (D-146), so the
    // proposer runs for a subset of the queue; two queries per proposed
    // component.
    expect(c.proposer).toBeGreaterThan(0);
    expect(c.proposer).toBeLessThanOrEqual(t.components);
    expect(c.search).toBe(c.proposer * 2);
    expect(c.fetch).toBe(t.uniqueUrls);
    expect(new Set(c.fetchedUrls).size).toBe(c.fetch);
    expect(new Set(c.extractPairs).size).toBe(c.extract);
    expect(c.extract).toBeGreaterThan(0);
  }, 600_000);
});

// FASTER MUST NOT MEAN WEAKER — THE EQUIVALENCE CONTRACT.
//
// The same modelled Research run with the acquisition loops SEQUENTIAL
// (ATLAS_ACQUISITION_CONCURRENCY=1, the pre-optimisation behaviour) and
// CONCURRENT (the default) must persist the identical research picture:
// the same provider call counts, the same evidence count, the same S5
// statuses and reason codes, the same S6 flow shapes, the same S7
// requirements, the same verdict and band, and the same trace counts per
// operation. Only wall-clock may differ.
describe("SEQUENTIAL == CONCURRENT — the optimisation changes the waiting, never the result", () => {
  it("two fresh projects, one sequential and one concurrent, persist the identical picture", async () => {
    // Both knobs: the default acquisition overlap AND the opt-in extraction
    // overlap, so the equivalence pin covers the whole machinery even while
    // extraction ships sequential.
    const prevA = process.env.ATLAS_ACQUISITION_CONCURRENCY;
    const prevE = process.env.ATLAS_EXTRACTION_CONCURRENCY;
    process.env.ATLAS_ACQUISITION_CONCURRENCY = "1";
    process.env.ATLAS_EXTRACTION_CONCURRENCY = "1";
    const serial = await runModelledResearch();
    process.env.ATLAS_ACQUISITION_CONCURRENCY = "4";
    process.env.ATLAS_EXTRACTION_CONCURRENCY = "4";
    const concurrent = await runModelledResearch();
    if (prevA === undefined) delete process.env.ATLAS_ACQUISITION_CONCURRENCY; else process.env.ATLAS_ACQUISITION_CONCURRENCY = prevA;
    if (prevE === undefined) delete process.env.ATLAS_EXTRACTION_CONCURRENCY; else process.env.ATLAS_EXTRACTION_CONCURRENCY = prevE;

    const picture = async (jobId: string) => {
      const { researchComponentResults, researchMechanismAssembly, researchClaimSupport, researchTraceEvents } = await import("../src/server/db/schema");
      const comps = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
      const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
      const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
      const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
      const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
      const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
      const traceCounts: Record<string, number> = {};
      for (const t of trace) traceCounts[`${t.operationType}:${t.status ?? ""}`] = (traceCounts[`${t.operationType}:${t.status ?? ""}`] ?? 0) + 1;
      const flows = ((asm?.flows ?? []) as unknown as { lineage: { component: string; evidenceIds: string[] }[]; lifecycle: string; attributes: unknown; gaps: { kind: string; component: string | null }[] }[])
        .map((f) => JSON.stringify({ lineage: f.lineage.map((s) => `${s.component}:${s.evidenceIds.length}`), lifecycle: f.lifecycle, attributes: f.attributes, gaps: f.gaps.map((g) => `${g.kind}@${g.component}`) }))
        .sort();
      return {
        s5: comps.map((c) => `${c.component}:${c.status}:${[...(c.reasonCodes as string[])].sort().join("|")}:${(c.supportingEvidenceIds as string[]).length}`).sort(),
        flows,
        requirements: ((claim?.requirementResults ?? []) as { requirementId: string; status: string; reasonCodes: string[] }[]).map((r) => `${r.requirementId}:${r.status}:${[...r.reasonCodes].sort().join("|")}`).sort(),
        claim: claim?.status ?? null,
        verdict: proof?.verdict ?? null,
        confidence: proof?.confidence ?? null,
        evidence: rows.length,
        traceCounts,
      };
    };
    const a = await picture(serial.jobId);
    const b = await picture(concurrent.jobId);

    expect(concurrent.counters.proposer).toBe(serial.counters.proposer);
    expect(concurrent.counters.search).toBe(serial.counters.search);
    expect(concurrent.counters.fetch).toBe(serial.counters.fetch);
    expect(concurrent.counters.extract).toBe(serial.counters.extract);
    expect([...concurrent.counters.fetchedUrls].sort()).toEqual([...serial.counters.fetchedUrls].sort());
    expect([...concurrent.counters.extractPairs].sort()).toEqual([...serial.counters.extractPairs].sort());
    expect(b).toEqual(a);
  }, 900_000);
});
