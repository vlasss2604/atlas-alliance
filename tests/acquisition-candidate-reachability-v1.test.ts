import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { explorerLocatorsForIdentity } from "../src/server/domain/project-identity";
import { loadAcquisitionLedger } from "../src/server/engine/acquisition-ledger";
import { loadFetchTargets } from "../src/server/engine/acquisition-phases";
import { loadAcquisitionPlan } from "../src/server/engine/acquisition-plan";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { componentAdmitsOnchainAcquisition } from "../src/server/engine/onchain-acquisition";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { __setOnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import {
  seedRoutedForComponent,
  selectApprovedSeedTargets,
} from "../src/server/engine/source-resource-seeds";
import { canonicalTargetRef, recordTraceEvent } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { supersedeProjectMemoryItem } from "../src/server/memory/lifecycle";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ACQUISITION CANDIDATE REACHABILITY ALIGNMENT V1.
//
// Two generic candidate-routing defects the clean Raydium validation run
// (job 5cc4a75a-…) left standing after it proved the research semantics
// and the source-open budget were not the bottleneck:
//
//   A  D-148 human-approved SOURCE_RESOURCE seeds were injected ONLY by the
//      phased FETCH path. The single-process executor built its candidate
//      set from search results alone, so an ACTIVE approved authoritative
//      document was structurally unreachable there unless search happened
//      to rediscover its exact url. SOURCE_RESOURCE_SELECTED on that run: 0.
//
//   B  D-133 explorer targeting was issued for every component whose
//      Pattern admits ONCHAIN_VERIFIABLE, including one the deterministic
//      adapter has NO intent for. Targeting said the chain establishes the
//      component; acquisition (correctly) said no on-chain path owns it;
//      six documentary opens paid for the disagreement.
//
// Nothing here raises a ceiling, refunds a unit, changes admission, changes
// authority, or names a project, chain, token or explorer in a rule. Every
// host below is a fixture host; the explorer hosts are the code-owned list
// source-authority.ts already classifies.

let ctx: TestContext;
let vocabulary: Set<string>;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  vocabulary = await loadActivePatternComponents(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setOnchainRetriever(null);
});

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const NOW = new Date("2026-09-11T00:00:00.000Z");

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

type Route = { prefix: string; routeClass?: "OFFICIAL_DOCS" | "GOVERNANCE" | "OFFICIAL_REPORT" };

// A project with a confirmed Solana identity and any number of confirmed
// routes on one fixture docs host. Hostname labels admit only [a-z0-9-].
async function makeProject(opts: { identity?: boolean; routes?: Route[] } = {}) {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("reach");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Reachability Fixture", status: "ACTIVE_CORE" })
    .returning();
  if (opts.identity !== false) {
    const identity = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
    if (!identity.ok) throw new Error("identity fixture failed");
  }
  const routeIds = new Map<string, string>();
  for (const route of opts.routes ?? [{ prefix: "/docs", routeClass: "OFFICIAL_DOCS" }]) {
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: route.prefix });
    if (!confirmed.ok) throw new Error(`confirm ${route.prefix} failed: ${confirmed.refusal}`);
    let id = confirmed.itemId;
    if (route.routeClass) {
      const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: route.routeClass });
      if (!classified.ok) throw new Error(`classify ${route.prefix} failed: ${classified.refusal}`);
      id = classified.newItemId;
    }
    routeIds.set(route.prefix, id);
  }
  return { id: project.id, name: project.name, slug, ticker: null as string | null, host, routeIds };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
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
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function workItem(jobId: string, component: string): Promise<ComponentWorkItem> {
  const { view } = await loadJobContractView(ctx.db, jobId);
  const item = view.workQueue.find((i) => i.component === component);
  if (!item) throw new Error(`fixture: ${component} is not in the work queue`);
  return item;
}

async function register(slug: string, url: string, components: string[]) {
  const r = await registerSourceResource(ctx.db, { projectSlug: slug, url, componentKeys: components }, vocabulary);
  if (!r.ok) throw new Error(`register failed: ${r.refusal} ${r.detail}`);
  return r;
}

async function trace(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

function docFor(url: string, text: string): FetchedDocument {
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

function factFor(item: { step: number; component: string }, fragment: string): ExtractedFact {
  return {
    step: item.step,
    component: item.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: fragment,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
  };
}

const FRAGMENT = "the protocol fee accrues directly to the treasury contract";

// The one transport the executor is given. In production this is the
// SSRF-safe fetcher; here it records every url that reaches it, which is
// the proof that a seed goes through the same door as everything else.
function countingFetcher(projectName: string, okUrls: string[]) {
  const calls: string[] = [];
  const byUrl = new Map(okUrls.map((url) => [url, docFor(url, `${projectName}: ${FRAGMENT}`)]));
  const fetcher: ContentFetcher = {
    name: "live-transport",
    async fetch(url: string) {
      calls.push(url);
      const doc = byUrl.get(url);
      if (!doc) throw new ContentFetchError("HTTP_ERROR", "fixture: 404", url, 404);
      return doc;
    },
  };
  return { fetcher, calls };
}

function installUnproductiveRetriever() {
  __setOnchainRetriever({
    name: "fixture-retriever",
    supports: () => true,
    retrieve: async () => {
      throw new Error("fixture: chain read produced nothing");
    },
  }, { chain: "solana", network: "mainnet" });
}

interface RunOpts {
  project: { id: string; name: string; slug: string; ticker: string | null };
  jobId: string;
  item: ComponentWorkItem;
  // What the search gateway returns for EVERY query.
  searchResults: string[];
  // Urls the transport serves successfully; everything else 404s.
  fetchable: string[];
  proposerQueries?: string[];
  retriever?: boolean;
  chainAcquisition?: "ENABLED" | "DOCUMENTARY_ONLY";
  maxSourceOpens?: number;
}

async function runOneComponent(opts: RunOpts) {
  if (opts.retriever) installUnproductiveRetriever();
  const { fetcher, calls } = countingFetcher(opts.project.name, opts.fetchable);
  const queries: string[] = [];
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: opts.project,
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries() {
        return opts.proposerQueries ?? ["q-fees", "q-treasury", "q-revenue"];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query: string) {
        queries.push(query);
        return opts.searchResults.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: fetcher,
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        return [factFor(input.target, FRAGMENT)];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: opts.chainAcquisition ?? "ENABLED",
  });
  const run = () =>
    executor.execute(opts.item, {
      jobId: opts.jobId,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: 5, maxSourceOpens: opts.maxSourceOpens ?? 24, maxModelCostMicro: 5_000_000 },
    });
  return { run, calls, queries };
}

function seedRows(rows: Awaited<ReturnType<typeof trace>>, url: string) {
  return rows.filter(
    (r) => r.operationType === "SOURCE_RESOURCE_SELECTED" && canonicalTargetRef(r.targetRef ?? "") === canonicalTargetRef(url),
  );
}

/* ------------------------------------------------------------------ */
/* A — approved seed injection is path-independent                      */
/* ------------------------------------------------------------------ */

describe("A — an ACTIVE approved SOURCE_RESOURCE is a single-process candidate", () => {
  it("A1: absent from every search result, the approved document is still opened and read", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const seed = `https://${project.host}/docs/fees.md`;
    const other = `https://${project.host}/other/page`;
    await register(project.slug, seed, [item.component]);

    const { run, calls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [other],
      fetchable: [seed, other],
    });
    const result = await run();

    // Reached, and reached through the ordinary transport.
    expect(calls).toContain(seed);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain("SOURCE_RESOURCE_SEED_ADMITTED");

    const rows = await trace(jobId);
    // The same provenance the phased path writes, on the same channel.
    const selected = seedRows(rows, seed).filter((r) => r.component === item.component && r.patternStep === item.step);
    expect(selected).toHaveLength(1);
    expect(selected[0].providerName).toBe("source-resource");
    // No forged discovery: a search never returned it and the trace says so.
    expect(rows.filter((r) => r.operationType === "CANDIDATE_RETURNED" && r.targetRef === seed)).toHaveLength(0);
    expect(rows.filter((r) => r.operationType === "FETCH_ATTEMPTED" && r.targetRef === seed)).toHaveLength(1);
    // And it produced Evidence for the component it was approved for.
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev.some((e) => e.component === item.component)).toBe(true);
  });

  it("A2: when search also returns it — canonical or not — it is one candidate and one open", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const seed = `https://${project.host}/docs/fees.md`;
    await register(project.slug, seed, [item.component]);

    // The exact url AND a trailing-slash variant of it, the way a search
    // provider may spell the same resource.
    const { run, calls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [seed, `${seed}/`],
      fetchable: [seed],
    });
    await run();

    const opened = calls.filter((u) => canonicalTargetRef(u) === canonicalTargetRef(seed));
    expect(opened).toHaveLength(1);
    const rows = await trace(jobId);
    expect(
      rows.filter((r) => r.operationType === "FETCH_ATTEMPTED" && canonicalTargetRef(r.targetRef ?? "") === canonicalTargetRef(seed)),
    ).toHaveLength(1);
  });

  it("A3a: a SUPERSEDED resource does not inject", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const seed = `https://${project.host}/docs/fees.md`;
    const registered = await register(project.slug, seed, [item.component]);
    // Superseded IN FAVOUR of a real replacement, the way the lifecycle is
    // meant to be used (same fixture shape as d148 TEST 6). The successor is
    // routed to a component this attempt does not run, so it cannot itself
    // be injected here and the scenario stays "the withdrawn seed alone".
    const replacement = await register(project.slug, `https://${project.host}/docs/fees.md?v=2`, ["MECHANISM_SPEC"]);
    await supersedeProjectMemoryItem(ctx.db, registered.itemId, replacement.itemId);

    const other = `https://${project.host}/other/page`;
    const { run, calls } = await runOneComponent({ project, jobId, item, searchResults: [other], fetchable: [seed, other] });
    await run();
    expect(calls).not.toContain(seed);
    expect(seedRows(await trace(jobId), seed)).toHaveLength(0);
  });

  it("A3b: a resource whose route stopped granting authority does not inject", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const seed = `https://${project.host}/docs/fees.md`;
    await register(project.slug, seed, [item.component]);
    // The approval outlives nothing: the classified route is withdrawn in
    // favour of a successor on another prefix (same fixture shape as d148
    // TEST 7), so /docs grants nothing and /docs/fees.md borrows nothing.
    const successor = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: project.host, pathPrefix: "/elsewhere" });
    if (!successor.ok) throw new Error("successor route fixture failed");
    await supersedeProjectMemoryItem(ctx.db, project.routeIds.get("/docs")!, successor.itemId);

    const other = `https://${project.host}/other/page`;
    const { run, calls } = await runOneComponent({ project, jobId, item, searchResults: [other], fetchable: [seed, other] });
    await run();
    expect(calls).not.toContain(seed);
    expect(seedRows(await trace(jobId), seed)).toHaveLength(0);
  });

  it("A3c: another project's resource does not inject", async () => {
    const owner = await makeProject();
    const stranger = await makeProject();
    const jobId = await makeJob(stranger.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const seed = `https://${owner.host}/docs/fees.md`;
    await register(owner.slug, seed, [item.component]);

    const other = `https://${stranger.host}/other/page`;
    const { run, calls } = await runOneComponent({ project: stranger, jobId, item, searchResults: [other], fetchable: [seed, other] });
    await run();
    expect(calls).not.toContain(seed);
    expect(seedRows(await trace(jobId), seed)).toHaveLength(0);
  });

  it("A3d: a component the resource is neither approved for nor admissible to does not receive it", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const approvedFor = await workItem(jobId, "SOURCE_OF_VALUE");
    // GOVERNANCE_BASIS admits GOVERNANCE only, so an OFFICIAL_DOCS resource
    // cannot be routed to it by D-156 either.
    const item = await workItem(jobId, "GOVERNANCE_BASIS");
    const seed = `https://${project.host}/docs/fees.md`;
    await register(project.slug, seed, [approvedFor.component]);

    const other = `https://${project.host}/other/page`;
    const { run, calls } = await runOneComponent({ project, jobId, item, searchResults: [other], fetchable: [seed, other] });
    await run();
    expect(calls).not.toContain(seed);
    // Provenance was written for the components it serves, and not for this one.
    const rows = seedRows(await trace(jobId), seed);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.component === item.component)).toHaveLength(0);
  });

  it("A4: a seed carries exactly the authority its approved route already gives — not more", async () => {
    // The same url, once reached by search (no resource) and once as a seed
    // (never searched). Authority is the resolver's answer at persist time
    // in both cases, so both Evidence rows must classify identically.
    const project = await makeProject();
    const url = `https://${project.host}/docs/fees.md`;
    const other = `https://${project.host}/other/page`;

    const viaSearchJob = await makeJob(project.id);
    const searchItem = await workItem(viaSearchJob, "SOURCE_OF_VALUE");
    const viaSearch = await runOneComponent({ project, jobId: viaSearchJob, item: searchItem, searchResults: [url], fetchable: [url] });
    await viaSearch.run();

    await register(project.slug, url, [searchItem.component]);
    const viaSeedJob = await makeJob(project.id);
    const seedItem = await workItem(viaSeedJob, "SOURCE_OF_VALUE");
    // Only the seed is servable here, so the Evidence compared is the seed's.
    const viaSeed = await runOneComponent({ project, jobId: viaSeedJob, item: seedItem, searchResults: [other], fetchable: [url] });
    await viaSeed.run();

    const classify = async (jobId: string) => {
      const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
      const own = rows.filter((e) => e.component === "SOURCE_OF_VALUE");
      expect(own.length).toBeGreaterThan(0);
      return [...new Set(own.map((e) => `${e.sourceClass}/${e.officiality}`))];
    };
    const fromSearch = await classify(viaSearchJob);
    const fromSeed = await classify(viaSeedJob);
    expect(fromSeed).toEqual(fromSearch);
    // And it is the stored route's class, not something stronger invented
    // for an approval.
    expect(fromSeed).toEqual(["OFFICIAL_DOCS/CONFIRMED"]);
    // The selection reports the same class the route resolver stated.
    const seeds = await selectApprovedSeedTargets(ctx.db, viaSeedJob, project.id);
    expect(seeds.map((s) => [s.canonicalUrl, s.routeClass])).toEqual([[url, "OFFICIAL_DOCS"]]);
  });

  it("A5a: a seed takes the ordinary source-open reservation and is refused with everything else", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const seed = `https://${project.host}/docs/fees.md`;
    await register(project.slug, seed, [item.component]);

    const { run, calls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [`https://${project.host}/other/page`],
      fetchable: [seed],
      maxSourceOpens: 0,
    });
    await expect(run()).rejects.toBeInstanceOf(BudgetExhaustedError);
    // Nothing was opened, and the refusal names the seed as the candidate
    // that could not be afforded — it was in the queue, and it paid like
    // any other url.
    expect(calls).toEqual([]);
    const rows = await trace(jobId);
    expect(
      rows.filter((r) => r.operationType === "CANDIDATE_SKIPPED_BUDGET" && r.targetRef === seed && r.reasonCode === "SOURCE_OPEN_BUDGET_EXHAUSTED"),
    ).toHaveLength(1);
  });

  it("A5b: a seed this job already proved dead is not re-opened", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const seed = `https://${project.host}/docs/fees.md`;
    await register(project.slug, seed, [item.component]);
    // Another component of this job already tried it and it failed.
    for (const operationType of ["FETCH_ATTEMPTED", "FETCH_FAILED"] as const) {
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType,
        providerKind: "FETCH",
        providerName: "safe-http",
        patternStep: 3,
        component: "MECHANISM_SPEC",
        targetRef: seed,
        status: operationType === "FETCH_FAILED" ? "FAILED" : "OK",
        reasonCode: operationType === "FETCH_FAILED" ? "PROVIDER_ERROR" : "NONE",
      });
    }
    const other = `https://${project.host}/other/page`;
    const { run, calls } = await runOneComponent({ project, jobId, item, searchResults: [other], fetchable: [seed, other] });
    const result = await run();
    expect(calls).not.toContain(seed);
    expect(result.reason).toContain("SKIPPED_KNOWN_DEAD_URL");
  });

  it("A5c: the seed cap and the per-attempt open cap are untouched", () => {
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(executor).toContain("const MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT = 6;");
    expect(executor).toContain("if (opensAttempted >= openAllowance) break;");
    const resource = readFileSync("src/server/memory/source-resource.ts", "utf-8");
    expect(resource).toContain("MAX_SOURCE_RESOURCE_SEEDS = 3");
  });

  it("A6a: both paths consume the ONE selection policy, and nothing else selects", () => {
    const phases = readFileSync("src/server/engine/acquisition-phases.ts", "utf-8");
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    const shared = readFileSync("src/server/engine/source-resource-seeds.ts", "utf-8");
    for (const src of [phases, executor]) {
      expect(src).toMatch(/import \{[^}]*selectApprovedSeedTargets[^}]*\} from "\.\/source-resource-seeds"/);
      expect(src).not.toContain("loadEligibleSourceResources");
      expect(src).not.toContain("SOURCE_RESOURCE_KIND");
    }
    // The policy itself is the pre-existing D-148 eligibility, D-156
    // routing and D-150 provenance — reused, not restated.
    expect(shared).toContain("loadEligibleSourceResourcesWithCoverage(db, projectId, needed)");
    expect(shared).toContain("componentsAdmittingClass(");
    expect(shared).toContain('operationType: "SOURCE_RESOURCE_SELECTED"');
    // It admits nothing into any set, opens nothing and reserves nothing.
    expect(shared).not.toContain("reserveJobBudget");
    expect(shared).not.toContain("fetch(");
  });

  it("A6b: for one job the phased target list and the executor admit the same seeds with the same provenance", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const sov = await workItem(jobId, "SOURCE_OF_VALUE");
    const dest = await workItem(jobId, "DESTINATION");
    const fees = `https://${project.host}/docs/fees.md`;
    const buybacks = `https://${project.host}/docs/buybacks.md`;
    await register(project.slug, fees, [sov.component]);
    await register(project.slug, buybacks, [dest.component]);

    // The phased path's list, seeds first.
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets.slice(0, 2)).toEqual([fees, buybacks]);
    const afterPhased = (await trace(jobId)).filter((r) => r.operationType === "SOURCE_RESOURCE_SELECTED");
    expect(afterPhased.length).toBeGreaterThan(0);

    // The executor's selection is the same function and sees the same rows.
    const seeds = await selectApprovedSeedTargets(ctx.db, jobId, project.id);
    expect(seeds.map((s) => s.canonicalUrl)).toEqual([fees, buybacks]);
    expect(seedRoutedForComponent(seeds[0], sov.step, sov.component)).toBe(true);
    expect(seedRoutedForComponent(seeds[1], dest.step, dest.component)).toBe(true);
    // Every routed pair is exactly a persisted provenance row, and asking
    // twice wrote nothing twice.
    const afterExecutor = (await trace(jobId)).filter((r) => r.operationType === "SOURCE_RESOURCE_SELECTED");
    expect(afterExecutor.map((r) => r.id).sort()).toEqual(afterPhased.map((r) => r.id).sort());
    const routed = seeds.flatMap((s) => s.routedFor.map((r) => `${r.step}:${r.component}:${s.canonicalUrl}`)).sort();
    const persisted = afterExecutor.map((r) => `${r.patternStep}:${r.component}:${r.targetRef}`).sort();
    expect(routed).toEqual(persisted);

    // And the ledger the executor ranks with reads them back as approvals.
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(ledger.sourceResourcesByComponent.get(`${sov.step}:${sov.component}`)).toContain(fees);
    expect(ledger.sourceResourcesByComponent.get(`${dest.step}:${dest.component}`)).toContain(buybacks);
  });
});

/* ------------------------------------------------------------------ */
/* A — structural replay of the persisted validation configuration      */
/* ------------------------------------------------------------------ */

describe("A — the persisted configuration shape, replayed structurally on a fixture host", () => {
  // The persisted project memory of the validation run, shape for shape:
  // two unclassified ACTIVE prefixes, two classified `.md` prefixes, an
  // identity, and two ACTIVE resources approved for the components that
  // failed. Only the host is a fixture; every path is the persisted one.
  const ROUTES: Route[] = [
    { prefix: "/ray/ray-buybacks" },
    { prefix: "/raydium/protocol/protocol-fees" },
    { prefix: "/ray/ray-buybacks.md", routeClass: "OFFICIAL_DOCS" },
    { prefix: "/ray/protocol-fees.md", routeClass: "OFFICIAL_DOCS" },
  ];

  async function persistedShape() {
    const project = await makeProject({ routes: ROUTES });
    const fees = `https://${project.host}/ray/protocol-fees.md`;
    const buybacks = `https://${project.host}/ray/ray-buybacks.md`;
    await register(project.slug, fees, ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE"]);
    await register(project.slug, buybacks, ["DESTINATION", "RECIPIENT"]);
    const jobId = await makeJob(project.id);
    // What the run's searches actually returned for SOURCE_OF_VALUE: only
    // explorer pages and unclassified sibling paths — never the `.md`.
    const searchResults = [
      `https://solscan.io/token/${MINT}`,
      `https://solscan.io/account/${MINT}`,
      `https://dev-v2.solscan.io/token/${MINT}`,
      "https://solscan.io/txs",
      `https://solana.fm/address/${MINT}`,
      `https://${project.host}/raydium/protocol/protocol-fees`,
      "https://defillama.com/protocol/fixture",
      `https://${project.host}/ray/protocol-fees`,
    ];
    return { project, jobId, fees, buybacks, searchResults };
  }

  it("protocol-fees.md is selected for SOURCE_OF_VALUE and is the first candidate opened", async () => {
    const { project, jobId, fees, buybacks, searchResults } = await persistedShape();
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const { run, calls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults,
      fetchable: [fees],
      retriever: true,
    });
    await run();
    // Reachable, and ahead of every explorer page and sibling path: its
    // resolved route class admits the component and it is approved.
    expect(calls[0]).toBe(fees);
    const rows = await trace(jobId);
    const selected = rows.filter((r) => r.operationType === "SOURCE_RESOURCE_SELECTED");
    expect(selected.some((r) => r.targetRef === fees && r.component === "SOURCE_OF_VALUE")).toBe(true);
    expect(selected.some((r) => r.targetRef === buybacks && r.component === "DESTINATION")).toBe(true);
    expect(selected.some((r) => r.targetRef === buybacks && r.component === "RECIPIENT")).toBe(true);
    // Nothing is claimed about what the document proves: this is candidate
    // reachability. The unclassified sibling stays exactly as it was.
    expect(rows.filter((r) => r.operationType === "CANDIDATE_RETURNED" && r.targetRef === fees)).toHaveLength(0);
  });

  it("ray-buybacks.md is selected for DESTINATION and opened while the explorer shells are not", async () => {
    const { project, jobId, buybacks, searchResults } = await persistedShape();
    const item = await workItem(jobId, "DESTINATION");
    const { run, calls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults,
      fetchable: [buybacks],
      retriever: true,
    });
    await run();
    expect(calls).toContain(buybacks);
    // DESTINATION's chain facts are the adapter's, and it could act here —
    // so the explorer shells search returned are not bought (post-Raydium
    // cleanup A), and the approved document is what is read.
    expect(calls.filter((u) => /solscan\.io|solana\.fm/.test(u))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* B — explorer targeting follows on-chain reachability                 */
/* ------------------------------------------------------------------ */

describe("B — D-133 explorer targeting is issued only where an on-chain path owns the fact", () => {
  it("B1: a component that admits the class but has no adapter intent gets no explorer-targeted query", async () => {
    // No classified route, so D-129 domain targeting cannot fire either:
    // the only targeting this component could receive is the explorer kind.
    const project = await makeProject({ routes: [] });
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
    // The premise of the defect: the class IS admitted and the identity IS
    // confirmed — targeting used to fire on those two alone.
    expect(plan.establishingClasses).toContain("ONCHAIN_VERIFIABLE");
    expect(plan.confirmedIdentity?.tokenAddress).toBe(MINT);
    expect(
      componentAdmitsOnchainAcquisition({
        component: item.component,
        establishingClasses: plan.establishingClasses,
        identity: plan.confirmedIdentity,
      }),
    ).toBe(false);
    expect(plan.onchainLocators).toEqual([]);

    const { run, queries } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [`https://${project.host}/docs/fees.md`],
      fetchable: [`https://${project.host}/docs/fees.md`],
      retriever: true,
    });
    await run();
    // No slot was rewritten into an explorer locator, and the model's own
    // queries — which targeting used to REPLACE — all ran.
    for (const locator of explorerLocatorsForIdentity(plan.confirmedIdentity!)) expect(queries).not.toContain(locator);
    expect(queries.filter((q) => q.startsWith("site:"))).toEqual([]);
    expect(queries).toEqual(["q-fees", "q-treasury", "q-revenue"]);
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "QUERY_PROPOSED" && (r.targetRef ?? "").startsWith("site:"))).toHaveLength(0);
  });

  it("B2: a component with a deterministic adapter intent still receives explorer targeting by confirmed address", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "DESTINATION");
    const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
    expect(
      componentAdmitsOnchainAcquisition({
        component: item.component,
        establishingClasses: plan.establishingClasses,
        identity: plan.confirmedIdentity,
      }),
    ).toBe(true);
    expect(plan.onchainLocators).toEqual(explorerLocatorsForIdentity(plan.confirmedIdentity!));
    expect(plan.onchainLocators.length).toBeGreaterThan(0);
    for (const locator of plan.onchainLocators) expect(locator).toMatch(new RegExp(`^site:\\S+ ${MINT}$`));

    const { run, queries } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [`https://${project.host}/docs/buybacks.md`],
      fetchable: [`https://${project.host}/docs/buybacks.md`],
      retriever: true,
    });
    await run();
    expect(queries.some((q) => q === plan.onchainLocators[0])).toBe(true);
  });

  it("B3: general search is not filtered — an explorer url it returns is still a candidate and still opened", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const explorer = `https://solscan.io/token/${MINT}`;
    const { run, calls, queries } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [explorer],
      fetchable: [explorer],
      retriever: true,
    });
    await run();
    // D-129 domain targeting at the project's own classified docs host is
    // untouched; what is absent is the explorer kind.
    expect(queries.filter((q) => q.includes(MINT))).toEqual([]);
    expect(queries.some((q) => q.startsWith(`site:${project.host} `))).toBe(true);
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "CANDIDATE_RETURNED" && r.targetRef === explorer).length).toBeGreaterThan(0);
    // No on-chain path owns this component's fact, so the acquisition-side
    // explorer rule does not apply and the page is bought as before.
    expect(calls).toContain(explorer);
  });

  it("B4: a human-approved explorer resource stays reachable, targeting or not", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const explorer = `https://solscan.io/account/${MINT}`;
    const docs = `https://${project.host}/docs/fees.md`;
    // This job's own approval provenance, exactly as the shared policy writes it.
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SOURCE_RESOURCE_SELECTED",
      providerKind: "FETCH",
      providerName: "source-resource",
      patternStep: item.step,
      component: item.component,
      targetRef: explorer,
      status: "OK",
    });
    const { run, calls, queries } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [docs, explorer],
      fetchable: [docs, explorer],
      retriever: true,
    });
    await run();
    expect(queries.filter((q) => q.includes(MINT))).toEqual([]);
    expect(calls).toContain(explorer);
  });

  it("B5: the rule names no project, chain, token or explorer, and restates no component map", () => {
    const src = readFileSync("src/server/engine/acquisition-plan.ts", "utf-8");
    const start = src.indexOf("function onchainLocatorsFor(");
    const end = src.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, end);
    expect(body).toContain("componentAdmitsOnchainAcquisition({ component, establishingClasses, identity })");
    expect(body).not.toMatch(/solscan|solana|etherscan|bscscan|raydium|pump|0x/i);
    // The code of the module (comments stripped) carries no component name
    // and no intent map: the only map is the adapter's own.
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toMatch(/SOURCE_OF_VALUE|DESTINATION|RECIPIENT|NET_EFFECT|EXECUTION_EVIDENCE|FLOW_PATH|CURRENT_STATE/);
    expect(code).not.toContain("INTENTS_BY_COMPONENT");
    expect(code).toMatch(/import \{ componentAdmitsOnchainAcquisition \} from "\.\/onchain-acquisition"/);
    // buildTargetedQueries itself is untouched: it still consumes whatever
    // locators the plan carries and decides nothing about components.
    const targeting = readFileSync("src/server/engine/acquisition-targeting.ts", "utf-8");
    expect(targeting).not.toContain("componentAdmitsOnchainAcquisition");
  });

  it("B6: over the whole work queue, targeting and acquisition answer from the same gate", async () => {
    const withIdentity = await makeProject();
    const jobId = await makeJob(withIdentity.id);
    const { view } = await loadJobContractView(ctx.db, jobId);
    expect(view.workQueue.length).toBeGreaterThan(0);
    let targeted = 0;
    for (const item of view.workQueue) {
      const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, withIdentity.id);
      const owns = componentAdmitsOnchainAcquisition({
        component: item.component,
        establishingClasses: plan.establishingClasses,
        identity: plan.confirmedIdentity,
      });
      expect(plan.onchainLocators.length > 0, item.component).toBe(owns);
      if (owns) targeted += 1;
    }
    // Both sides of the rule are exercised by the active Pattern.
    expect(targeted).toBeGreaterThan(0);
    expect(targeted).toBeLessThan(view.workQueue.length);

    // Without a confirmed identity nothing is targeted, exactly as before.
    const noIdentity = await makeProject({ identity: false });
    const bareJob = await makeJob(noIdentity.id);
    for (const item of (await loadJobContractView(ctx.db, bareJob)).view.workQueue) {
      const plan = await loadAcquisitionPlan(ctx.db, bareJob, item.component, noIdentity.id);
      expect(plan.onchainLocators).toEqual([]);
    }
  });
});
