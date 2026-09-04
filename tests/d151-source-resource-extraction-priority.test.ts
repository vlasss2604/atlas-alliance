import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { evidence, projects, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
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

// D-151 — AN APPROVED RESOURCE MUST SURVIVE THE CAP, NOT MERELY ENTER THE
// CORPUS.
//
// D-150 made a curated document VISIBLE to the component it was approved
// for. It did not make it survive: merged into one list behind every search
// candidate, the per-query search-result cap then cut it. On the first live
// Raydium run that happened in all five seeded slots — the resource sat at
// index >= the cap every time, so both official documents were selected
// first, opened first, sealed with full authority, and then read by nobody.
// Zero characters of either reached a model.
//
// The rule here is an ORDERING rule and nothing more: a resource a human
// approved FOR a component is served to that component ahead of anything a
// search returned, exactly as acquisition already prioritises it. It grants
// no authority, admits no url this job did not persist provenance for, and
// does not raise a single bound.

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

// The production per-query search-result cap (s4-executor.ts). Mirrored as
// a literal on purpose: this suite must fail if the fix ever depends on the
// cap being raised, which the brief forbids.
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
  const slug = uniq("d151");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D151 Fixture", status: "ACTIVE_CORE" })
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
  return { id: project.id, slug, name: project.name, host, routeId: classified.newItemId };
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

// Runs a real SEARCH phase for ONE work item, so the candidates carry
// genuine CANDIDATE_RETURNED provenance for that (step, component) — the
// same rows extraction replay reads in production.
async function searchFor(
  project: { id: string; name: string; slug: string },
  jobId: string,
  item: ComponentWorkItem,
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
      async proposeQueries(input) {
        return Array.from({ length: input.maxQueries }, (_, i) => `q-${i + 1}`);
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search() {
        return urls.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
    // Deliberately generous: the SEARCH phase must be able to DISCOVER more
    // candidates than the extraction cap can later serve. That gap is the
    // whole subject of this suite.
    maxResultsPerQuery: 10,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });
}

// Exactly what the extractor is offered for one component: the replay
// gateway under the PRODUCTION cap.
async function served(
  jobId: string,
  item: { step: number; component: string },
  query = "unrelated-query",
  maxResults = MAX_RESULTS,
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
    { maxResults },
  );
  return results.map((r: { url: string }) => r.url);
}

function searchUrls(host: string, n: number, tag: string): string[] {
  return Array.from({ length: n }, (_, i) => `https://elsewhere-${tag}.test/a${i + 1}?h=${host}`);
}

describe("D-151 — an approved resource outranks search candidates at extraction", () => {
  it("TEST 1: a saturated component still serves its approved resource", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [item] = await workItems(jobId);

    // (1) The component already has MORE search candidates than the cap.
    const candidates = searchUrls(project.host, MAX_RESULTS + 1, "t1");
    await searchFor(project, jobId, item, candidates);
    // (2) And an approved resource exists for it.
    const url = `https://${project.host}/docs/spec.md`;
    await register(project.slug, url, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const corpus = await served(jobId, item);
    // (3) It reaches the extractor, under the unchanged cap...
    expect(corpus).toContain(url);
    expect(corpus).toHaveLength(MAX_RESULTS);
    // ...ahead of every search candidate.
    expect(corpus[0]).toBe(url);
  });

  it("TEST 2: search candidates are displaced, never the resource", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [item] = await workItems(jobId);

    const candidates = searchUrls(project.host, MAX_RESULTS, "t2");
    await searchFor(project, jobId, item, candidates);
    const url = `https://${project.host}/docs/spec.md`;
    await register(project.slug, url, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // The exact-query path is the one that failed in production: with the
    // cap already filled by the query's own candidates, the resource used
    // to be unreachable no matter how the rest of the corpus was ordered.
    const corpus = await served(jobId, item, "q-1");
    expect(corpus).toHaveLength(MAX_RESULTS);
    // (4) Exactly one search candidate loses its seat — the last one.
    expect(corpus).toEqual([url, ...candidates.slice(0, MAX_RESULTS - 1)]);
    expect(corpus).not.toContain(candidates[MAX_RESULTS - 1]);
  });

  it("TEST 3: another component's resource does not leak in, even under the cap", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1, c2] = await workItems(jobId);

    const mine = `https://${project.host}/docs/for-c1.md`;
    await register(project.slug, mine, [c1.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // (5) Priority is per (step, component), never project-wide.
    expect(await served(jobId, c1)).toContain(mine);
    expect(await served(jobId, c2)).not.toContain(mine);
    expect(await served(jobId, c2)).toHaveLength(0);
  });

  it("TEST 4: with no resource, search-only behaviour is byte-identical", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [item] = await workItems(jobId);

    const candidates = searchUrls(project.host, MAX_RESULTS + 2, "t4");
    await searchFor(project, jobId, item, candidates);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // (6) The pre-D-151 contract: exact-query candidates first, in
    // discovery order, capped — unchanged when no resource exists.
    expect(await served(jobId, item, "q-1")).toEqual(candidates.slice(0, MAX_RESULTS));
    expect(await served(jobId, item)).toEqual(candidates.slice(0, MAX_RESULTS));
  });

  it("TEST 5: a url reached by both provenances takes exactly one seat", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [item] = await workItems(jobId);

    const url = `https://${project.host}/docs/both.md`;
    const others = searchUrls(project.host, MAX_RESULTS, "t5");
    // Search returns the approved url too.
    await searchFor(project, jobId, item, [url, ...others]);
    await register(project.slug, url, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const corpus = await served(jobId, item, "q-1");
    // (7) One entry, not two — the canonical dedup still holds, and the
    // duplicate does not cost a second seat.
    expect(corpus.filter((u) => u === url)).toHaveLength(1);
    expect(corpus).toHaveLength(MAX_RESULTS);
    expect(corpus).toEqual([url, ...others.slice(0, MAX_RESULTS - 1)]);
  });

  it("TEST 6: ordering is deterministic across independent preparations", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [item] = await workItems(jobId);

    await searchFor(project, jobId, item, searchUrls(project.host, MAX_RESULTS + 3, "t6"));
    const a = `https://${project.host}/docs/a.md`;
    const b = `https://${project.host}/docs/b.md`;
    await register(project.slug, a, [item.component]);
    await register(project.slug, b, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // (8) Same job, same query, same answer — every time. The corpus is
    // ordered by the trace's own monotonic sequence, so it is a function of
    // the job's history and not of physical row order.
    const runs = [
      await served(jobId, item, "q-1"),
      await served(jobId, item, "q-1"),
      await served(jobId, item, "q-1"),
    ];
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    // Both approved resources lead, in selection order.
    expect(runs[0].slice(0, 2)).toEqual([a, b]);
  });

  it("TEST 7: D-150 persisted provenance semantics are unchanged", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const [c1, c2] = items;

    const url = `https://${project.host}/docs/multi.md`;
    const outside = [...vocabulary].filter((c) => !items.some((i) => i.component === c));
    await register(project.slug, url, [c1.component, c2.component, ...outside.slice(0, 1)]);
    await searchFor(project, jobId, c1, searchUrls(project.host, 2, "t7"));
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);

    // (9) Still ONE acquisition target, whatever the coverage.
    expect(targets.filter((t) => t === url)).toHaveLength(1);

    const rows = await ctx.db
      .select({
        op: researchTraceEvents.operationType,
        providerName: researchTraceEvents.providerName,
        component: researchTraceEvents.component,
        ref: researchTraceEvents.targetRef,
      })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    const prov = rows.filter((r) => r.ref === url && r.op === "SOURCE_RESOURCE_SELECTED");
    // One row per (component) the resource was approved to serve IN THIS
    // job — the boundary intersection, not the whole coverage.
    expect(prov.map((r) => r.component).sort()).toEqual([c1.component, c2.component].sort());
    expect(new Set(prov.map((r) => r.providerName))).toEqual(new Set(["source-resource"]));
    // And search provenance is still never forged for a curated url.
    expect(rows.filter((r) => r.ref === url && r.op === "CANDIDATE_RETURNED")).toHaveLength(0);
  });

  it("TEST 8: priority grants no authority by itself", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [item] = await workItems(jobId);

    const url = `https://${project.host}/docs/spec.md`;
    await register(project.slug, url, [item.component]);
    await searchFor(project, jobId, item, searchUrls(project.host, 2, "t8"));
    await loadFetchTargets(ctx.db, jobId, project.id);

    const gateway = await prepareExtractionReplaySearch(ctx.db, jobId);
    const results = await gateway.search(
      "q-1",
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
    const first = results.find((r: { url: string }) => r.url === url);
    expect(first).toBeDefined();
    // (10) A prioritised entry is shaped EXACTLY like a search candidate:
    // being served first says "read this", never "this is authoritative".
    // Class and officiality are decided at acquisition by route
    // resolution, and admissibility downstream of that — nothing here.
    expect(Object.keys(first!).sort()).toEqual(["snippet", "title", "url"]);
    expect(first!.title).toBeNull();
    expect(first!.snippet).toBeNull();
    // Ordering creates no Evidence on its own.
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev).toHaveLength(0);
  });
});
