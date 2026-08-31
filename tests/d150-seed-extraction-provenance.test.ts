import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  loadFetchTargets,
  prepareExtractionReplayFetcher,
  prepareExtractionReplaySearch,
  runFetchPhase,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { ComponentTarget, FetchedDocument } from "../src/server/engine/providers/types";
import { isReplayProvider } from "../src/server/engine/providers/types";
import { supersedeProjectMemoryItem } from "../src/server/memory/lifecycle";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-150 — A CURATED DOCUMENT MUST REACH THE COMPONENT IT WAS APPROVED FOR.
//
// D-148 put human-approved resources into acquisition; extraction replay
// (D-141) builds each component's corpus from CANDIDATE_RETURNED rows, and
// a seeded resource has none — no search ever returned it. So on the first
// live run both authoritative documents were fetched, sealed with full
// OFFICIAL_DOCS authority, and then shown to nobody: seven extraction model
// calls read only the social corpus and produced zero Evidence.
//
// The association is now persisted AT SELECTION TIME as a fact about the
// run, so extraction never has to ask what memory says today.

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

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

async function makeProject(prefix = "/docs") {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("d150");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D150 Fixture", status: "ACTIVE_CORE" })
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
    pathPrefix: prefix,
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
  const r = await registerSourceResource(ctx.db, { projectSlug: slug, url, componentKeys: components }, vocabulary);
  if (!r.ok) throw new Error("register failed: " + r.refusal + " " + r.detail);
  return r;
}

function doc(url: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText: "Protocol fees buy back the token; bought tokens are held.",
    contentHash: "sha256:fixture",
    fetchedAt: new Date("2026-08-31T00:00:00Z"),
    byteLength: 400,
  };
}

function fixtureFetcher(calls: { urls: string[] }): ContentFetcher {
  return {
    name: "safe-http",
    async fetch(url) {
      calls.urls.push(url);
      return doc(url);
    },
  };
}

async function seedSearch(
  project: { id: string; name: string; slug: string },
  jobId: string,
  urls: string[],
) {
  const items = await workItems(jobId);
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: items.slice(0, 1),
    target: (item: ComponentWorkItem): ComponentTarget => ({
      step: item.step,
      stepName: item.stepName,
      component: item.component,
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
    maxResultsPerQuery: 10,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });
}

// The corpus a component would actually receive at EXTRACTING.
async function corpusFor(jobId: string, item: { step: number; component: string }): Promise<string[]> {
  const gateway = await prepareExtractionReplaySearch(ctx.db, jobId);
  const results = await gateway.search(
    "anything",
    { step: item.step, stepName: "s", component: item.component, projectId: "p", projectName: "n", projectSlug: "s" },
    { maxResults: 50 },
  );
  return results.map((r: { url: string }) => r.url);
}

async function provenanceRows(jobId: string) {
  const rows = await ctx.db
    .select({
      operationType: researchTraceEvents.operationType,
      providerName: researchTraceEvents.providerName,
      patternStep: researchTraceEvents.patternStep,
      component: researchTraceEvents.component,
      targetRef: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
  return rows.filter((r) => r.operationType === "SOURCE_RESOURCE_SELECTED");
}

async function sourceOpens(jobId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: researchJobs.sourceOpensReserved })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row?.n ?? 0;
}

describe("D-150 — seeded documents reach their approved components", () => {
  it("TEST 1: a seeded resource search never returned enters its component's corpus", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const target = items[0];
    const url = `https://${project.host}/docs/spec.md`;
    await register(project.slug, url, [target.component]);

    await seedSearch(project, jobId, ["https://elsewhere.test/article"]);
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets).toContain(url);

    const corpus = await corpusFor(jobId, target);
    expect(corpus).toContain(url);
  });

  it("TEST 2: multi-component coverage — one target, one open, both corpora", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const [c1, c2] = items;
    const url = `https://${project.host}/docs/multi.md`;
    await register(project.slug, url, [c1.component, c2.component]);

    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    // ONE acquisition target for the url, whatever its coverage.
    expect(targets.filter((t) => t === url)).toHaveLength(1);

    expect(await corpusFor(jobId, c1)).toContain(url);
    expect(await corpusFor(jobId, c2)).toContain(url);

    // One url, two component associations — the provenance is per pair.
    const prov = await provenanceRows(jobId);
    expect(prov.filter((r) => r.targetRef === url)).toHaveLength(2);

    // And one real acquisition spends exactly one source open.
    const calls = { urls: [] as string[] };
    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });
    expect(calls.urls.filter((u) => u === url)).toHaveLength(1);
    expect(await sourceOpens(jobId)).toBe(1);
  });

  it("TEST 3: no component leakage", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const [c1, c2] = items;
    const url = `https://${project.host}/docs/only-c1.md`;
    await register(project.slug, url, [c1.component]);

    await loadFetchTargets(ctx.db, jobId, project.id);
    expect(await corpusFor(jobId, c1)).toContain(url);
    expect(await corpusFor(jobId, c2)).not.toContain(url);
  });

  it("TEST 4: provenance is intersected with the job boundary", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const inBoundary = [items[0].component, items[1].component];
    const outside = [...vocabulary].filter((c) => !items.some((i) => i.component === c));
    const url = `https://${project.host}/docs/wide.md`;
    await register(project.slug, url, [...inBoundary, ...outside.slice(0, 1)]);

    await loadFetchTargets(ctx.db, jobId, project.id);
    const prov = await provenanceRows(jobId);
    const recorded = prov.filter((r) => r.targetRef === url).map((r) => r.component);
    for (const c of inBoundary) expect(recorded).toContain(c);
    // A component outside this job's boundary is never recorded.
    for (const c of outside.slice(0, 1)) expect(recorded).not.toContain(c);
  });

  it("TEST 5: search + resource dedup, provenance still distinguishable", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const [c1, c2] = items;
    const url = `https://${project.host}/docs/both.md`;
    await register(project.slug, url, [c1.component, c2.component]);

    // Search returns the SAME canonical url for c1.
    await seedSearch(project, jobId, [url]);
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets.filter((t) => t === url)).toHaveLength(1);

    expect((await corpusFor(jobId, c1)).filter((u) => u === url)).toHaveLength(1);
    expect((await corpusFor(jobId, c2)).filter((u) => u === url)).toHaveLength(1);

    // Both provenances persist and stay separable in the trace.
    const all = await ctx.db
      .select({ op: researchTraceEvents.operationType, ref: researchTraceEvents.targetRef })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    const forUrl = all.filter((r) => r.ref === url);
    expect(forUrl.some((r) => r.op === "CANDIDATE_RETURNED")).toBe(true);
    expect(forUrl.some((r) => r.op === "SOURCE_RESOURCE_SELECTED")).toBe(true);

    const calls = { urls: [] as string[] };
    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });
    expect(calls.urls.filter((u) => u === url)).toHaveLength(1);
  });

  it("TEST 6: search analytics is not forged", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/curated.md`;
    await register(project.slug, url, [items[0].component]);

    // No search at all in this job.
    await loadFetchTargets(ctx.db, jobId, project.id);

    const rows = await ctx.db
      .select({ op: researchTraceEvents.operationType, ref: researchTraceEvents.targetRef })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    // The curated url must NEVER be recorded as something a search returned.
    expect(rows.filter((r) => r.ref === url && r.op === "CANDIDATE_RETURNED")).toHaveLength(0);
    expect(rows.filter((r) => r.ref === url && r.op === "SOURCE_RESOURCE_SELECTED").length).toBeGreaterThan(0);
  });

  it("TEST 7: memory changed after planning does not rewrite the run", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const target = items[0];
    const url = `https://${project.host}/docs/frozen.md`;
    const reg = await register(project.slug, url, [target.component]);

    await loadFetchTargets(ctx.db, jobId, project.id);
    expect(await corpusFor(jobId, target)).toContain(url);

    // The resource is withdrawn AFTER selection.
    const replacement = await register(project.slug, `https://${project.host}/docs/other.md`, [
      target.component,
    ]);
    await supersedeProjectMemoryItem(ctx.db, reg.itemId, replacement.itemId);

    // The already-planned run still replays what it selected: extraction
    // reads persisted run provenance, never today's memory.
    expect(await corpusFor(jobId, target)).toContain(url);
  });

  it("TEST 8: authority changed after acquisition does not mutate the sealed document", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/sealed.md`;
    await register(project.slug, url, [items[0].component]);

    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher({ urls: [] }),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });

    const before = await prepareExtractionReplayFetcher(ctx.db, jobId);
    expect(before.documentCount).toBeGreaterThan(0);

    // Withdraw the ROUTE that granted the class.
    const successor = await confirmSourceRoute(ctx.db, {
      projectSlug: project.slug,
      domain: project.host,
      pathPrefix: "/elsewhere",
    });
    if (!successor.ok) throw new Error("successor fixture failed");
    await supersedeProjectMemoryItem(ctx.db, project.routeId, successor.itemId);

    // The acquired document keeps the authority sealed at acquisition time.
    const [row] = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId))
      .limit(1);
    expect(row).toBeDefined();
    const after = await prepareExtractionReplayFetcher(ctx.db, jobId);
    expect(after.documentCount).toBe(before.documentCount);
  });

  it("TEST 9: a seed whose acquisition failed manufactures nothing", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/broken.md`;
    await register(project.slug, url, [items[0].component]);

    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: {
        name: "safe-http",
        async fetch() {
          throw new Error("transport died");
        },
      },
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });

    // Provenance exists (it was selected)...
    expect((await provenanceRows(jobId)).length).toBeGreaterThan(0);
    // ...but no document exists, so the replay fetcher refuses the url.
    const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
    expect(replay.documentCount).toBe(0);
    await expect(replay.fetcher.fetch(url)).rejects.toThrow();
  });

  it("TEST 10: extraction replay performs no live acquisition", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/replayed.md`;
    await register(project.slug, url, [items[0].component]);
    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher({ urls: [] }),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });

    const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
    // Declared replay, so D-137 charges it nothing...
    expect(isReplayProvider(replay.fetcher)).toBe(true);
    // ...and it serves the acquired document without any network.
    const served = await replay.fetcher.fetch(url);
    expect(served.finalUrl).toBe(url);
    // Anything not acquired for this job is refused, never fetched live.
    await expect(replay.fetcher.fetch("https://elsewhere.test/never")).rejects.toThrow();

    const gateway = await prepareExtractionReplaySearch(ctx.db, jobId);
    expect(isReplayProvider(gateway)).toBe(true);
  });

  it("TEST 11: the ordinary search-provenance path is unchanged", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const searchUrl = "https://elsewhere.test/found-by-search";

    // No resource registered at all.
    await seedSearch(project, jobId, [searchUrl]);
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets).toContain(searchUrl);
    expect(await provenanceRows(jobId)).toHaveLength(0);

    const corpus = await corpusFor(jobId, items[0]);
    expect(corpus).toContain(searchUrl);
  });

  it("TEST 12: provenance grants no authority and establishes nothing", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/no-authority.md`;
    await register(project.slug, url, [items[0].component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // The provenance row carries a component and a url — and nothing that
    // could be mistaken for a class, an officiality or an outcome.
    const prov = await provenanceRows(jobId);
    expect(prov.length).toBeGreaterThan(0);
    for (const row of prov) {
      expect(row.providerName).toBe("source-resource");
      expect(JSON.stringify(row)).not.toContain("OFFICIAL_DOCS");
      expect(JSON.stringify(row)).not.toContain("CONFIRMED");
    }
    // Selecting a resource creates no Evidence by itself.
    const [counts] = await ctx.db
      .select({ n: researchJobs.sourceOpensReserved })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    expect(counts.n).toBe(0);
  });

  it("redelivery does not double the provenance", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/idempotent.md`;
    await register(project.slug, url, [items[0].component]);

    await loadFetchTargets(ctx.db, jobId, project.id);
    const first = (await provenanceRows(jobId)).length;
    await loadFetchTargets(ctx.db, jobId, project.id);
    expect((await provenanceRows(jobId)).length).toBe(first);
  });
});
