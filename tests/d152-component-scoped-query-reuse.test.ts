import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { loadAcquisitionLedger, planQueries } from "../src/server/engine/acquisition-ledger";
import {
  loadFetchTargets,
  prepareExtractionReplaySearch,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ComponentTarget } from "../src/server/engine/providers/types";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-152 — THE SAME QUERY ASKED BY TWO COMPONENTS IS TWO DIFFERENT FACTS.
//
// Reuse was keyed on the canonical query string alone. Several components
// legitimately propose the same query, so the first component to run it
// handed its candidate list to every later one — and, worse, those later
// components then skipped the search gateway entirely, which is where D-151's
// seed-first ordering lives. An approved SOURCE_RESOURCE could therefore be
// selected, fetched and sealed with full authority and still reach no
// component, exactly as before that ordering rule existed.
//
// Measured in the live Raydium trace: `site:solscan.io <mint>` was proposed by
// steps 1, 5 and 6. Step 1 ran it and wrote SEARCH_EXECUTED +
// CANDIDATE_RETURNED; steps 2, 4, 5 and 6 wrote no SEARCH_EXECUTED row at all
// and went straight to extraction on step 1's urls.

let ctx: TestContext;
let vocabulary: Set<string>;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  vocabulary = await loadActivePatternComponents(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

// The production per-query search-result cap (s4-executor.ts). Mirrored so
// this suite fails if the fix ever comes to depend on raising it.
const MAX_RESULTS = 5;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

async function makeProject() {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("d152");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D152 Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("identity fixture failed");
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: host,
    pathPrefix: "/docs",
  });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  return { id: project.id, slug, name: project.name, host };
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
      originalQuestion: "q",
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

async function workItems(jobId: string): Promise<ComponentWorkItem[]> {
  const { view } = await loadJobContractView(ctx.db, jobId);
  return view.workQueue;
}

async function register(slug: string, url: string, components: string[]) {
  const r = await registerSourceResource(
    ctx.db,
    { projectSlug: slug, url, componentKeys: components },
    vocabulary,
  );
  if (!r.ok) throw new Error("register failed: " + r.refusal + " " + r.detail);
  return r;
}

// Runs a real SEARCH phase for ONE work item with ONE fixed query, so the
// resulting SEARCH_EXECUTED / CANDIDATE_RETURNED rows carry that component's
// step and component exactly as production writes them.
async function searchFor(
  project: { id: string; name: string; slug: string },
  jobId: string,
  item: ComponentWorkItem,
  query: string,
  urls: string[],
) {
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: [item],
    target: (i: ComponentWorkItem): ComponentTarget => ({
      step: i.step,
      stepName: i.stepName,
      component: i.component,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
    }),
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries() {
        return [query];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search() {
        return urls.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
    maxResultsPerQuery: 10,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });
}

async function searchQueriesReserved(jobId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: researchJobs.searchQueriesReserved })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row?.n ?? 0;
}

async function traceOps(jobId: string) {
  return ctx.db
    .select({
      op: researchTraceEvents.operationType,
      step: researchTraceEvents.patternStep,
      component: researchTraceEvents.component,
      ref: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
}

// What the extraction gateway would serve one component, under the
// PRODUCTION cap.
async function served(
  jobId: string,
  item: { step: number; component: string },
  query: string,
): Promise<string[]> {
  const gateway = await prepareExtractionReplaySearch(ctx.db, jobId);
  const results = await gateway.search(
    query,
    {
      step: item.step,
      stepName: "s",
      component: item.component,
      projectId: "p",
      projectName: "n",
      projectSlug: "s",
    },
    { maxResults: MAX_RESULTS },
  );
  return results.map((r: { url: string }) => r.url);
}

const SHARED_QUERY = "site:explorer.test token accounts";

describe("D-152 — query reuse is scoped to the component that did the work", () => {
  it("TEST 1: one component's candidates never become another component's", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1, c2] = await workItems(jobId);
    const c1Urls = ["https://a.test/1", "https://a.test/2"];

    // c1 runs the shared query; c2 has never run anything.
    await searchFor(project, jobId, c1, SHARED_QUERY, c1Urls);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);

    const forC1 = planQueries([SHARED_QUERY], ledger, {
      step: c1.step,
      component: c1.component,
    })[0];
    const forC2 = planQueries([SHARED_QUERY], ledger, {
      step: c2.step,
      component: c2.component,
    })[0];

    // c1 reuses its own work and needs no new search.
    expect(forC1.needsSearch).toBe(false);
    expect([...forC1.knownCandidates]).toEqual(c1Urls);

    // c2 is offered NOTHING as its own — the leak is closed at the source.
    expect(forC2.knownCandidates).toEqual([]);
    // It still knows the query was paid for, which is a budget fact and not
    // a corpus fact.
    expect(forC2.alreadyPaid).toBe(true);
    expect([...forC2.jobWideCandidates]).toEqual(c1Urls);
  });

  it("TEST 1b: the reused-query path now asks the gateway instead of bypassing it", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1, c2] = await workItems(jobId);
    await searchFor(project, jobId, c1, SHARED_QUERY, ["https://a.test/1"]);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);

    // A component that has not run the query must SEARCH — which, with the
    // extraction replay gateway, means going through the seed-first builder.
    // This is the property the bug destroyed: c2 used to skip it entirely.
    const entry = planQueries([SHARED_QUERY], ledger, {
      step: c2.step,
      component: c2.component,
    })[0];
    expect(entry.needsSearch).toBe(true);
  });

  it("TEST 2 + 3: an approved resource survives on the reused-query path, first", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1, c2] = await workItems(jobId);

    // c1 saturates the shared query with more candidates than the cap.
    const c1Urls = Array.from({ length: MAX_RESULTS + 1 }, (_, i) => `https://a.test/${i + 1}`);
    await searchFor(project, jobId, c1, SHARED_QUERY, c1Urls);

    // c2 has an approved resource and has never run the query itself.
    const url = `https://${project.host}/docs/approved.md`;
    await register(project.slug, url, [c2.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // Under the SAME cap, c2's corpus leads with the approved resource and
    // contains none of c1's candidates.
    const corpus = await served(jobId, c2, SHARED_QUERY);
    expect(corpus[0]).toBe(url);
    for (const leaked of c1Urls) expect(corpus).not.toContain(leaked);

    // And c1's own corpus is untouched by c2's resource.
    const c1Corpus = await served(jobId, c1, SHARED_QUERY);
    expect(c1Corpus).not.toContain(url);
    expect(c1Corpus).toEqual(c1Urls.slice(0, MAX_RESULTS));
  });

  it("TEST 3b: ordering stays resource → exact query → rest of the component's corpus", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1] = await workItems(jobId);
    const ownUrls = Array.from({ length: MAX_RESULTS }, (_, i) => `https://own.test/${i + 1}`);
    await searchFor(project, jobId, c1, SHARED_QUERY, ownUrls);

    const url = `https://${project.host}/docs/approved.md`;
    await register(project.slug, url, [c1.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const corpus = await served(jobId, c1, SHARED_QUERY);
    // D-151's rule, unchanged, under the unchanged cap: the resource first,
    // then the exact query's own candidates, one of which is displaced.
    expect(corpus).toEqual([url, ...ownUrls.slice(0, MAX_RESULTS - 1)]);
  });

  it("TEST 4: with no approved resource, search-only behaviour is unchanged", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1] = await workItems(jobId);
    const ownUrls = Array.from({ length: MAX_RESULTS + 2 }, (_, i) => `https://own.test/${i + 1}`);
    await searchFor(project, jobId, c1, SHARED_QUERY, ownUrls);
    await loadFetchTargets(ctx.db, jobId, project.id);

    expect(await served(jobId, c1, SHARED_QUERY)).toEqual(ownUrls.slice(0, MAX_RESULTS));
  });

  it("TEST 5: no cross-project leakage", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const jobA = await makeJob(projectA.id);
    const jobB = await makeJob(projectB.id);
    const [a1] = await workItems(jobA);
    const [b1] = await workItems(jobB);

    await searchFor(projectA, jobA, a1, SHARED_QUERY, ["https://a-only.test/1"]);
    const resourceB = `https://${projectB.host}/docs/b.md`;
    await register(projectB.slug, resourceB, [b1.component]);
    await loadFetchTargets(ctx.db, jobB, projectB.id);

    // Every ledger and every corpus is scoped to ONE job, so project A's
    // candidates cannot appear in project B's research at all.
    const corpusB = await served(jobB, b1, SHARED_QUERY);
    expect(corpusB).not.toContain("https://a-only.test/1");
    expect(corpusB).toContain(resourceB);

    const ledgerB = await loadAcquisitionLedger(ctx.db, jobB);
    expect(ledgerB.executedQueries.size).toBe(0);
    expect(
      planQueries([SHARED_QUERY], ledgerB, { step: b1.step, component: b1.component })[0]
        .alreadyPaid,
    ).toBe(false);
  });

  it("TEST 6: dedup still holds — within an attempt, and across both provenances", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1] = await workItems(jobId);
    const url = `https://${project.host}/docs/both.md`;
    // Search returns the approved url too.
    await searchFor(project, jobId, c1, SHARED_QUERY, [url, "https://own.test/1"]);
    await register(project.slug, url, [c1.component]);
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);

    // One acquisition target, one corpus entry — reached both ways.
    expect(targets.filter((t) => t === url)).toHaveLength(1);
    const corpus = await served(jobId, c1, SHARED_QUERY);
    expect(corpus.filter((u) => u === url)).toHaveLength(1);

    // And a query repeated within one plan is planned once.
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(
      planQueries([SHARED_QUERY, SHARED_QUERY], ledger, {
        step: c1.step,
        component: c1.component,
      }),
    ).toHaveLength(1);
  });

  it("TEST 8: no extra search budget is spent when another component already paid", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1, c2] = await workItems(jobId);

    await searchFor(project, jobId, c1, SHARED_QUERY, ["https://a.test/1"]);
    const afterFirst = await searchQueriesReserved(jobId);
    expect(afterFirst).toBe(1);

    // c2 proposes the SAME query against a live (metered) gateway. The unit
    // was already spent, so it is not spent again — the budget behaviour that
    // existed before D-152 is preserved exactly.
    await searchFor(project, jobId, c2, SHARED_QUERY, ["https://a.test/1"]);
    expect(await searchQueriesReserved(jobId)).toBe(afterFirst);

    // The urls are still acquirable job-wide...
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets).toContain("https://a.test/1");

    // ...but they were never recorded as c2's discovery, so they cannot
    // become c2's extraction corpus.
    const rows = await traceOps(jobId);
    const c2Candidates = rows.filter(
      (r) =>
        r.op === "CANDIDATE_RETURNED" &&
        r.step === c2.step &&
        r.component === c2.component,
    );
    expect(c2Candidates).toHaveLength(0);
    expect(await served(jobId, c2, SHARED_QUERY)).toEqual([]);
  });

  it("TEST 7: a replay never forges search provenance for a curated url", async () => {
    const { readFileSync } = await import("node:fs");
    const { isReplayProvider } = await import("../src/server/engine/providers/types");

    // Routing every component through the gateway is what makes this
    // reachable: a replay gateway serves the approved SOURCE_RESOURCE first,
    // and the executor used to record everything a search returned as
    // CANDIDATE_RETURNED. That row means "a search returned this", so writing
    // it for a curated url would forge precisely the event D-150 refused to
    // forge — the trace would lose the difference between a discovered
    // candidate and an approved one.
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1] = await workItems(jobId);
    const url = `https://${project.host}/docs/approved.md`;
    await register(project.slug, url, [c1.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const gateway = await prepareExtractionReplaySearch(ctx.db, jobId);
    // The gateway declares itself a replay, which is the switch the executor
    // reads — it discovers nothing and is metered nothing (D-137).
    expect(isReplayProvider(gateway)).toBe(true);
    expect((await served(jobId, c1, SHARED_QUERY))[0]).toBe(url);

    // So the discovery row is written only on the metered path.
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(executor).toMatch(
      /if \(searchMetered\) \{\s*await recordTraceEvent\(deps\.db, \{[\s\S]*?operationType: "CANDIDATE_RETURNED"/,
    );
    expect(executor).toContain("if (wasDuplicate && searchMetered) {");

    // And the curated url still carries only its own provenance.
    const rows = await traceOps(jobId);
    expect(rows.filter((r) => r.ref === url && r.op === "CANDIDATE_RETURNED")).toHaveLength(0);
    expect(
      rows.filter((r) => r.ref === url && r.op === "SOURCE_RESOURCE_SELECTED").length,
    ).toBeGreaterThan(0);
  });

  it("TEST 8b: caps and the seed cap are untouched by this change", async () => {
    const { readFileSync } = await import("node:fs");
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(executor).toContain("const MAX_SEARCH_RESULTS_PER_QUERY = 5;");
    expect(executor).toContain("const MAX_QUERIES_PER_ATTEMPT = 3;");
    expect(executor).toContain("const MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT = 6;");
    const resource = readFileSync("src/server/memory/source-resource.ts", "utf-8");
    expect(resource).toContain("MAX_SOURCE_RESOURCE_SEEDS = 3");
  });
});
