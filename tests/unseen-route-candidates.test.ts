import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, projectMemoryItems, projects, sources, topics, users } from "../src/server/db/schema";
import { loadAcquisitionPlan } from "../src/server/engine/acquisition-plan";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { isUnrecognizedDomain, resolveSourceRoute } from "../src/server/engine/source-authority";
import {
  MAX_ROUTE_CANDIDATES_PER_JOB,
  MAX_ROUTE_CANDIDATE_URLS,
  observeSourceRouteCandidate,
  type RouteCandidateContent,
} from "../src/server/engine/source-route-candidates";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// UNSEEN PROJECT AUTHORITY BOOTSTRAP V1 — DISCOVERY != AUTHORITY.
//
// The first unseen validation (Morpho, job a34375ba) fetched the project's
// own documentation host, extracted from it, and — correctly — sealed
// everything SOCIAL / CLAIMED because no human had confirmed the host. What
// it did not do is leave the owner anything to confirm. The engine now
// records such a host as an OBSERVED SOURCE_ROUTE candidate. These tests
// pin, structurally, that the candidate is a note to a human and nothing
// else: it grants no officiality, no class, no admissibility, no verdict,
// and the only way out of OBSERVED is the existing owner workflow.
//
// Every host is a fixture host. No network, no model, no chain.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-12T00:00:00.000Z");

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

const FRAGMENT = "the protocol fee accrues directly to the treasury contract";

function fixtureHost(label: string): string {
  return `${label}.${uniq("u").replace(/_/g, "-")}.test`;
}

// A completely UNSEEN project: a catalog row and nothing else — no
// identity, no route, no resource, no alias. Exactly the Morpho shape.
async function makeUnseenProject() {
  const slug = uniq("unseen");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Unseen Fixture Protocol", status: "ACTIVE_CORE" })
    .returning();
  return { id: project.id, name: project.name, slug, ticker: null as string | null };
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

function docFor(requestedUrl: string, finalUrl: string, text: string): FetchedDocument {
  return {
    finalUrl,
    requestedUrl,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${finalUrl}`,
    fetchedAt: NOW,
    byteLength: text.length,
  };
}

function factFor(item: { step: number; component: string }): ExtractedFact {
  return {
    step: item.step,
    component: item.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: FRAGMENT,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
  };
}

// `served` maps a requested url to the url the transport LANDS on — equal
// for an ordinary page, different for a redirect. Every served document
// names the project, so containment passes and the candidate decision is
// made purely on authority grounds.
function fixtureFetcher(projectName: string, served: Record<string, string>): { fetcher: ContentFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: ContentFetcher = {
    name: "fixture-transport",
    async fetch(url: string) {
      calls.push(url);
      const finalUrl = served[url];
      if (!finalUrl) throw new ContentFetchError("HTTP_ERROR", "fixture: 404", url, 404);
      return docFor(url, finalUrl, `${projectName}: ${FRAGMENT}`);
    },
  };
  return { fetcher, calls };
}

interface RunOpts {
  project: { id: string; name: string; slug: string; ticker: string | null };
  jobId: string;
  item: ComponentWorkItem;
  searchResults: string[];
  served: Record<string, string>;
  maxSourceOpens?: number;
}

async function runOneComponent(opts: RunOpts) {
  const { fetcher, calls } = fixtureFetcher(opts.project.name, opts.served);
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: opts.project,
    queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-fees"]; } },
    searchGateway: {
      name: "fixture-search",
      async search() {
        return opts.searchResults.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: fetcher,
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        return [factFor(input.target)];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: "DOCUMENTARY_ONLY",
  });
  const result = await executor.execute(opts.item, {
    jobId: opts.jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 5, maxSourceOpens: opts.maxSourceOpens ?? 24, maxModelCostMicro: 5_000_000 },
  });
  return { result, calls };
}

async function routeRows(projectId: string) {
  return ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, projectId), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
}

async function observedCandidates(projectId: string) {
  return (await routeRows(projectId)).filter((r) => r.lifecycleState === "OBSERVED");
}

function contentOf(row: { content: unknown }): RouteCandidateContent {
  return row.content as RouteCandidateContent;
}

async function evidenceFor(jobId: string) {
  return ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
}

/* ------------------------------------------------------------------ */
/* 1. the unseen official-docs host becomes a candidate, and only that   */
/* ------------------------------------------------------------------ */

describe("1. an unseen project's documentation host is OBSERVED — and confers nothing", () => {
  it("one OBSERVED SOURCE_ROUTE for the exact host, with bounded provenance; Evidence stays SOCIAL/CLAIMED", async () => {
    const project = await makeUnseenProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const host = fixtureHost("docs");
    const url = `https://${host}/learn/fees`;

    const { result } = await runOneComponent({ project, jobId, item, searchResults: [url], served: { [url]: url } });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain(`SOURCE_ROUTE_CANDIDATE_OBSERVED:${host}`);

    const rows = await routeRows(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].lifecycleState).toBe("OBSERVED");
    expect(rows[0].sourceId).not.toBeNull();
    const content = contentOf(rows[0]);
    expect(content.domain).toBe(host);
    expect(content.observed.jobId).toBe(jobId);
    expect(content.observed.urls).toEqual([url]);
    expect(content.observed.evidenceCount).toBe(1);
    expect(content.observed.components).toEqual(["SOURCE_OF_VALUE"]);
    // No routeClass, no pathPrefix: the engine does not pre-decide either.
    expect(Object.keys(content).sort()).toEqual(["domain", "observed"]);

    const ev = await evidenceFor(jobId);
    expect(ev.length).toBeGreaterThan(0);
    for (const row of ev) {
      expect(row.sourceClass).toBe("SOCIAL");
      expect(row.officiality).toBe("CLAIMED");
    }

    // The authority consumers see nothing.
    const resolved = await resolveSourceRoute(ctx.db, project.id, url);
    expect(resolved).toEqual({ officiality: "CLAIMED", routeClass: null, observation: null, matchedPathPrefix: null });
    const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
    expect(plan.confirmedRouteDomainsByClass).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* 2. lookalike host                                                    */
/* ------------------------------------------------------------------ */

describe("2. a lookalike host is observed like any other host and stays CLAIMED", () => {
  it("observation is neutral; confirming the genuine host leaves the lookalike untouched", async () => {
    const project = await makeUnseenProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const genuine = fixtureHost("docs");
    const lookalike = genuine.replace("docs.", "docs-");
    const genuineUrl = `https://${genuine}/docs/fees`;
    const lookalikeUrl = `https://${lookalike}/docs/fees`;

    await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [genuineUrl, lookalikeUrl],
      served: { [genuineUrl]: genuineUrl, [lookalikeUrl]: lookalikeUrl },
    });
    const before = await observedCandidates(project.id);
    expect(before.map((r) => contentOf(r).domain).sort()).toEqual([genuine, lookalike].sort());

    // The human confirms the genuine host only, through the existing tool.
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: genuine, pathPrefix: "/docs" });
    expect(confirmed.ok).toBe(true);

    expect((await resolveSourceRoute(ctx.db, project.id, genuineUrl)).officiality).toBe("CONFIRMED");
    const stillClaimed = await resolveSourceRoute(ctx.db, project.id, lookalikeUrl);
    expect(stillClaimed.officiality).toBe("CLAIMED");
    expect(stillClaimed.routeClass).toBeNull();
    // The lookalike's candidate row is exactly where it was: OBSERVED.
    const lookalikeRow = (await routeRows(project.id)).find((r) => contentOf(r).domain === lookalike);
    expect(lookalikeRow?.lifecycleState).toBe("OBSERVED");
  });
});

/* ------------------------------------------------------------------ */
/* 3. third-party hosts                                                 */
/* ------------------------------------------------------------------ */

describe("3. third-party hosts never become authoritative", () => {
  it("an unrecognized third-party host may be observed but gains no class and no officiality", async () => {
    const project = await makeUnseenProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const thirdParty = fixtureHost("news");
    const url = `https://${thirdParty}/articles/what-is-unseen`;

    await runOneComponent({ project, jobId, item, searchResults: [url], served: { [url]: url } });
    const ev = await evidenceFor(jobId);
    expect(ev.every((r) => r.sourceClass === "SOCIAL" && r.officiality === "CLAIMED")).toBe(true);
    const rows = await routeRows(project.id);
    expect(rows.every((r) => r.lifecycleState === "OBSERVED")).toBe(true);
    expect(rows.every((r) => !("routeClass" in contentOf(r)))).toBe(true);
  });

  it("a host a code-owned list already recognizes (research media) is NOT a candidate", async () => {
    const project = await makeUnseenProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const url = "https://www.theblock.co/post/unseen-fixture-protocol-fees";

    await runOneComponent({ project, jobId, item, searchResults: [url], served: { [url]: url } });
    const ev = await evidenceFor(jobId);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((r) => r.sourceClass === "RESEARCH_MEDIA" && r.officiality === "CLAIMED")).toBe(true);
    expect(await routeRows(project.id)).toHaveLength(0);
    expect(isUnrecognizedDomain(url)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 4. root domain vs docs subdomain                                     */
/* ------------------------------------------------------------------ */

describe("4. a confirmed root domain confers nothing to its docs subdomain", () => {
  it("the docs host is still CLAIMED and still a separate candidate", async () => {
    const project = await makeUnseenProject();
    const root = fixtureHost("root").replace("root.", "");
    const docs = `docs.${root}`;
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: root, pathPrefix: "/" });
    expect(confirmed.ok).toBe(true);

    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const url = `https://${docs}/fees`;
    await runOneComponent({ project, jobId, item, searchResults: [url], served: { [url]: url } });

    expect((await resolveSourceRoute(ctx.db, project.id, `https://${root}/`)).officiality).toBe("CONFIRMED");
    const docsRoute = await resolveSourceRoute(ctx.db, project.id, url);
    expect(docsRoute.officiality).toBe("CLAIMED");
    expect(docsRoute.routeClass).toBeNull();
    const candidates = await observedCandidates(project.id);
    expect(candidates.map((r) => contentOf(r).domain)).toEqual([docs]);
    const ev = await evidenceFor(jobId);
    expect(ev.every((r) => r.sourceClass === "SOCIAL" && r.officiality === "CLAIMED")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. externally hosted documentation                                   */
/* ------------------------------------------------------------------ */

describe("5. externally hosted docs: a tenant subdomain is a candidate, the shared base never is", () => {
  it("project.gitbook.io is observed; gitbook.io is refused", async () => {
    const project = await makeUnseenProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const tenant = `${uniq("t").replace(/_/g, "-")}.gitbook.io`;
    const tenantUrl = `https://${tenant}/fees`;
    const baseUrl = "https://gitbook.io/unseen-fixture-protocol/fees";

    await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [tenantUrl, baseUrl],
      served: { [tenantUrl]: tenantUrl, [baseUrl]: baseUrl },
    });
    const ev = await evidenceFor(jobId);
    // Both documents were read; neither has authority.
    expect(new Set(ev.map((r) => r.retrievedUrl))).toEqual(new Set([tenantUrl, baseUrl]));
    expect(ev.every((r) => r.sourceClass === "SOCIAL" && r.officiality === "CLAIMED")).toBe(true);
    const candidates = await observedCandidates(project.id);
    expect(candidates.map((r) => contentOf(r).domain)).toEqual([tenant]);
    expect(isUnrecognizedDomain(baseUrl)).toBe(false);
    expect(isUnrecognizedDomain(tenantUrl)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 6. OBSERVED only -> still CLAIMED, still CLASS_NOT_ADMISSIBLE         */
/* ------------------------------------------------------------------ */

describe("6. with OBSERVED candidates present and no human act, nothing changes downstream", () => {
  it("a second Research on the same project is still CLAIMED / SOCIAL and S5 still excludes it", async () => {
    const project = await makeUnseenProject();
    const host = fixtureHost("docs");
    const url = `https://${host}/fees`;

    const first = await makeJob(project.id);
    await runOneComponent({ project, jobId: first, item: await workItem(first, "SOURCE_OF_VALUE"), searchResults: [url], served: { [url]: url } });
    expect(await observedCandidates(project.id)).toHaveLength(1);

    const second = await makeJob(project.id);
    const item = await workItem(second, "SOURCE_OF_VALUE");
    const { result } = await runOneComponent({ project, jobId: second, item, searchResults: [url], served: { [url]: url } });
    expect(result.status).toBe("SUCCEEDED");

    const ev = await evidenceFor(second);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((r) => r.sourceClass === "SOCIAL" && r.officiality === "CLAIMED")).toBe(true);
    const plan = await loadAcquisitionPlan(ctx.db, second, item.component, project.id);
    expect(plan.confirmedRouteDomainsByClass).toEqual({});

    const reconciled = await reconcileAndPersistComponent(ctx.db, second, item, NOW);
    expect(reconciled.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(reconciled.excludedEvidence.length).toBe(ev.length);
    expect(reconciled.excludedEvidence.every((e) => e.reason === "CLASS_NOT_ADMISSIBLE")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 7. redirects                                                         */
/* ------------------------------------------------------------------ */

describe("7. a redirect is observed where it LANDED, never where it was requested", () => {
  it("the candidate host is finalUrl's host only", async () => {
    const project = await makeUnseenProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const requestedHost = fixtureHost("old");
    const landedHost = fixtureHost("docs");
    const requested = `https://${requestedHost}/fees`;
    const landed = `https://${landedHost}/learn/fees`;

    await runOneComponent({ project, jobId, item, searchResults: [requested], served: { [requested]: landed } });
    const candidates = await observedCandidates(project.id);
    expect(candidates.map((r) => contentOf(r).domain)).toEqual([landedHost]);
    expect(contentOf(candidates[0]).observed.urls).toEqual([landed]);
    const ev = await evidenceFor(jobId);
    expect(ev.every((r) => r.retrievedUrl === landed)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 8. existing projects are untouched                                   */
/* ------------------------------------------------------------------ */

describe("8. a project with a confirmed, classified route behaves exactly as before", () => {
  it("OFFICIAL_DOCS / CONFIRMED Evidence, and no candidate row for the confirmed host", async () => {
    const project = await makeUnseenProject();
    const host = fixtureHost("docs");
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: host, pathPrefix: "/docs" });
    if (!confirmed.ok) throw new Error(confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error(classified.refusal);
    const rowsBefore = await routeRows(project.id);

    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const url = `https://${host}/docs/fees`;
    const { result } = await runOneComponent({ project, jobId, item, searchResults: [url], served: { [url]: url } });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).not.toContain("SOURCE_ROUTE_CANDIDATE");

    const ev = await evidenceFor(jobId);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((r) => r.sourceClass === "OFFICIAL_DOCS" && r.officiality === "CONFIRMED")).toBe(true);
    const rowsAfter = await routeRows(project.id);
    expect(rowsAfter.map((r) => [r.id, r.lifecycleState])).toEqual(rowsBefore.map((r) => [r.id, r.lifecycleState]));
    expect(await observedCandidates(project.id)).toHaveLength(0);
  });

  it("a host with a confirmed but UNCLASSIFIED route is also left alone (officiality is already a human's)", async () => {
    const project = await makeUnseenProject();
    const host = fixtureHost("docs");
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: host, pathPrefix: "/" });
    expect(confirmed.ok).toBe(true);
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const url = `https://${host}/fees`;
    await runOneComponent({ project, jobId, item, searchResults: [url], served: { [url]: url } });
    expect(await observedCandidates(project.id)).toHaveLength(0);
    const ev = await evidenceFor(jobId);
    expect(ev.every((r) => r.sourceClass === "SOCIAL" && r.officiality === "CONFIRMED")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 9. dedup                                                             */
/* ------------------------------------------------------------------ */

describe("9. one candidate per project + exact host", () => {
  it("two documents on one host in one run, then another job: still one row, provenance merged and bounded", async () => {
    const project = await makeUnseenProject();
    const host = fixtureHost("docs");
    const urls = Array.from({ length: MAX_ROUTE_CANDIDATE_URLS + 2 }, (_, i) => `https://${host}/page-${i}`);
    const served = Object.fromEntries(urls.map((u) => [u, u]));

    const first = await makeJob(project.id);
    await runOneComponent({ project, jobId: first, item: await workItem(first, "SOURCE_OF_VALUE"), searchResults: urls, served });
    let rows = await routeRows(project.id);
    expect(rows).toHaveLength(1);
    let content = contentOf(rows[0]);
    const opened = (await evidenceFor(first)).length;
    expect(content.observed.evidenceCount).toBe(opened);
    expect(content.observed.urls.length).toBe(Math.min(opened, MAX_ROUTE_CANDIDATE_URLS));
    expect(content.observed.jobId).toBe(first);

    const second = await makeJob(project.id);
    await runOneComponent({ project, jobId: second, item: await workItem(second, "MECHANISM_SPEC"), searchResults: [urls[0]], served });
    rows = await routeRows(project.id);
    expect(rows).toHaveLength(1);
    content = contentOf(rows[0]);
    expect(content.observed.jobId).toBe(first); // the first observer keeps the row
    expect(content.observed.components).toEqual(["MECHANISM_SPEC", "SOURCE_OF_VALUE"]);
    expect(content.observed.urls.length).toBeLessThanOrEqual(MAX_ROUTE_CANDIDATE_URLS);
    expect(content.observed.evidenceCount).toBeGreaterThan(opened);
    expect(rows[0].lifecycleState).toBe("OBSERVED");
  });
});

/* ------------------------------------------------------------------ */
/* 10. per-job cap                                                      */
/* ------------------------------------------------------------------ */

describe("10. a Research job creates at most MAX_ROUTE_CANDIDATES_PER_JOB candidates", () => {
  it("many distinct unrecognized hosts in one run -> the cap, and the cap is observed", async () => {
    const project = await makeUnseenProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const urls = Array.from({ length: MAX_ROUTE_CANDIDATES_PER_JOB + 4 }, (_, i) => `https://${fixtureHost(`h${i}`)}/fees`);
    const served = Object.fromEntries(urls.map((u) => [u, u]));

    const { result } = await runOneComponent({ project, jobId, item, searchResults: urls, served, maxSourceOpens: 24 });
    const distinctHostsRead = new Set((await evidenceFor(jobId)).map((r) => new URL(r.retrievedUrl).hostname)).size;
    const candidates = await observedCandidates(project.id);
    expect(candidates.length).toBe(Math.min(distinctHostsRead, MAX_ROUTE_CANDIDATES_PER_JOB));
    if (distinctHostsRead > MAX_ROUTE_CANDIDATES_PER_JOB) {
      expect(result.reason).toContain("SOURCE_ROUTE_CANDIDATE_CAP_REACHED");
    }
  });

  it("the cap counts rows CREATED by this job; the unit refuses the next new host directly", async () => {
    const project = await makeUnseenProject();
    const jobId = uniq("job-").replace(/_/g, "-");
    const [source] = await ctx.db
      .insert(sources)
      .values({ url: `https://${fixtureHost("s")}/x`, urlHash: uniq("hash"), sourceType: "OTHER" })
      .returning();
    const claimed = { officiality: "CLAIMED" as const, routeClass: null, observation: null, matchedPathPrefix: null };
    for (let i = 0; i < MAX_ROUTE_CANDIDATES_PER_JOB; i++) {
      const out = await observeSourceRouteCandidate(ctx.db, {
        projectId: project.id,
        jobId,
        sourceId: source.id,
        finalUrl: `https://${fixtureHost(`c${i}`)}/fees`,
        component: "SOURCE_OF_VALUE",
        evidenceCount: 1,
        route: claimed,
      });
      expect(out.outcome).toBe("OBSERVED");
    }
    const refused = await observeSourceRouteCandidate(ctx.db, {
      projectId: project.id,
      jobId,
      sourceId: source.id,
      finalUrl: `https://${fixtureHost("extra")}/fees`,
      component: "SOURCE_OF_VALUE",
      evidenceCount: 1,
      route: claimed,
    });
    expect(refused).toEqual({ outcome: "SKIPPED", reason: "CAP_REACHED", domain: expect.any(String) });
    expect(await observedCandidates(project.id)).toHaveLength(MAX_ROUTE_CANDIDATES_PER_JOB);
  });
});

/* ------------------------------------------------------------------ */
/* 11. the human closes the loop through the EXISTING tools             */
/* ------------------------------------------------------------------ */

describe("11. confirm + classify through the existing owner tools, then a fresh resolution is CONFIRMED", () => {
  it("the engine's OBSERVED row is never promoted; the owner's own row carries the authority", async () => {
    const project = await makeUnseenProject();
    const host = fixtureHost("docs");
    const url = `https://${host}/docs/fees`;

    const first = await makeJob(project.id);
    await runOneComponent({ project, jobId: first, item: await workItem(first, "SOURCE_OF_VALUE"), searchResults: [url], served: { [url]: url } });
    const [candidate] = await observedCandidates(project.id);
    expect(contentOf(candidate).domain).toBe(host);

    // The owner reads the candidate and decides — with the tools that
    // already exist, which are not refused by the OBSERVED row.
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: host, pathPrefix: "/docs" });
    if (!confirmed.ok) throw new Error(`${confirmed.refusal}: ${confirmed.detail}`);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error(`${classified.refusal}: ${classified.detail}`);

    const resolved = await resolveSourceRoute(ctx.db, project.id, url);
    expect(resolved.officiality).toBe("CONFIRMED");
    expect(resolved.routeClass).toBe("OFFICIAL_DOCS");
    expect(resolved.matchedPathPrefix).toBe("/docs");

    // The engine's candidate is exactly where it was.
    const [candidateAfter] = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.id, candidate.id));
    expect(candidateAfter.lifecycleState).toBe("OBSERVED");
    expect(candidateAfter.content).toEqual(candidate.content);

    // And the next Research inherits the human's authority, adding no candidate.
    const second = await makeJob(project.id);
    const item = await workItem(second, "SOURCE_OF_VALUE");
    const { result } = await runOneComponent({ project, jobId: second, item, searchResults: [url], served: { [url]: url } });
    expect(result.reason).not.toContain("SOURCE_ROUTE_CANDIDATE");
    const ev = await evidenceFor(second);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((r) => r.sourceClass === "OFFICIAL_DOCS" && r.officiality === "CONFIRMED")).toBe(true);
    expect(await observedCandidates(project.id)).toHaveLength(1);
    const plan = await loadAcquisitionPlan(ctx.db, second, item.component, project.id);
    expect(plan.confirmedRouteDomainsByClass).toEqual({ OFFICIAL_DOCS: [host] });
  });
});

/* ------------------------------------------------------------------ */
/* 12. structural: OBSERVED is invisible to authority, by construction   */
/* ------------------------------------------------------------------ */

describe("12. structural guarantees", () => {
  const candidates = readFileSync("src/server/engine/source-route-candidates.ts", "utf8");
  const authority = readFileSync("src/server/engine/source-authority.ts", "utf8");
  const plan = readFileSync("src/server/engine/acquisition-plan.ts", "utf8");

  it("the candidates module writes OBSERVED only and never touches the lifecycle, a class or a prefix", () => {
    expect(candidates).toContain('lifecycleState: "OBSERVED"');
    expect(candidates).not.toContain('"ACTIVE"');
    expect(candidates).not.toContain('"CANDIDATE"');
    expect(candidates).not.toContain("promoteProjectMemoryItem");
    expect(candidates).not.toContain("supersedeProjectMemoryItem");
    // Property WRITES, not prose: the module's own comment may name the
    // fields it refuses to set.
    expect(candidates).not.toContain("routeClass:");
    expect(candidates).not.toContain("pathPrefix:");
  });

  it("every authority consumer still reads ACTIVE rows only", () => {
    expect(authority).toContain('eq(projectMemoryItems.lifecycleState, "ACTIVE")');
    expect(authority).not.toContain('"OBSERVED"');
    expect(plan).toContain('eq(projectMemoryItems.lifecycleState, "ACTIVE")');
    expect(plan).not.toContain('"OBSERVED"');
  });

  it("isUnrecognizedDomain is a read of the existing lists: known platforms, testnets and shared bases are all false", () => {
    expect(isUnrecognizedDomain("https://etherscan.io/token/0xabc")).toBe(false);
    expect(isUnrecognizedDomain("https://x.com/project")).toBe(false);
    expect(isUnrecognizedDomain("https://dune.com/q/1")).toBe(false);
    expect(isUnrecognizedDomain("https://snapshot.org/#/space")).toBe(false);
    expect(isUnrecognizedDomain("https://www.coindesk.com/x")).toBe(false);
    expect(isUnrecognizedDomain("https://sepolia.etherscan.io/x")).toBe(false);
    expect(isUnrecognizedDomain("https://github.com/org/repo")).toBe(false);
    expect(isUnrecognizedDomain("https://medium.com/@someone")).toBe(false);
    expect(isUnrecognizedDomain("not a url")).toBe(false);
    expect(isUnrecognizedDomain("https://docs.some-protocol.test/fees")).toBe(true);
    expect(isUnrecognizedDomain("https://someone.github.io/docs")).toBe(true);
  });
});
