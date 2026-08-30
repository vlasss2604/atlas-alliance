import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  acquiredDocuments,
  projects,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import { runFetchPhase, runSearchPhase } from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import {
  RenderedDocsError,
  __setRenderedDocsFetcher,
  renderedDocsAvailable,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import type {
  RenderedDocsFetcher,
  RenderedDocument,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import type { RendererSelfTestResult } from "../src/server/engine/providers/rendered-docs-isolated";
import type { ComponentTarget, FetchedDocument } from "../src/server/engine/providers/types";
import {
  RENDERED_DOCS_ENV,
  RendererCapabilityUnavailableError,
  installFetchRendererCapability,
  uninstallRendererCapability,
} from "../src/server/jobs/renderer-capability";
import type { PhaseCapability } from "../src/server/jobs/worker-capabilities";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-146 SLICE 2 — ISOLATED_RENDER BECOMES A REAL PRODUCTION CAPABILITY.
//
// Slice 1 built the chain and left its third strategy inert. These tests
// cover the two things that changes: WHO installs a renderer (only the
// FETCH role, only on an explicit declaration, only after the browser has
// been proven to start), and whether the chain can CONTINUE into a
// strategy that became available after an earlier delivery already spent
// the ones before it.
//
// No browser is started here. The isolated renderer is reached through
// its existing seams, so every decision above is exercised without a
// Chromium process — which is also what makes these tests honest about
// ordering: a fixture self-test can be made to fail on demand, and a real
// one cannot.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  __setRenderedDocsFetcher(null);
  await ctx.close();
});

afterEach(() => {
  __setRenderedDocsFetcher(null);
  delete process.env[RENDERED_DOCS_ENV];
});

const HOST = "docs.example-project.test";
const TARGET = `https://${HOST}/mechanism/page`;
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

const FETCH_ROLE: ReadonlySet<PhaseCapability> = new Set(["FETCH"]);
const SEARCH_ROLE: ReadonlySet<PhaseCapability> = new Set(["SEARCH_EXTRACT"]);

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

function okSelfTest(): RendererSelfTestResult {
  return {
    ok: true,
    browserVersion: "fixture/1.0",
    reason: null,
    diagnostic: null,
    proxyDenials: null,
    durationMs: 5,
  };
}

function failedSelfTest(): RendererSelfTestResult {
  return {
    ok: false,
    browserVersion: null,
    reason: "BROWSER_LAUNCH_FAILED",
    diagnostic: "EXECUTABLE_NOT_FOUND",
    proxyDenials: null,
    durationMs: 5,
  };
}

function doc(url: string, over: Partial<FetchedDocument> = {}): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "Protocol fees are used to buy back the token and hold it.",
    contentHash: "sha256:fixture",
    fetchedAt: new Date("2026-08-30T00:00:00Z"),
    byteLength: 400,
    ...over,
  };
}

function renderedDoc(url: string): RenderedDocument {
  return {
    ...doc(url, { normalizedText: "Rendered: protocol fees buy back the token." }),
    renderMode: "RENDERED",
    rendererName: "fixture-renderer",
    rendererVersion: "1",
    browserVersion: "fixture",
    confirmedRouteDomain: HOST,
    matchedPathPrefix: "/mechanism",
    staticTextLength: 0,
    renderedTextLength: 42,
    rawHtmlHash: "sha256:raw",
    blockedRequestCount: 0,
    renderDurationMs: 1,
  } as RenderedDocument;
}

function fixtureRenderer(
  calls: { n: number; urls: string[] },
  fail?: RenderedDocsError,
): RenderedDocsFetcher {
  return {
    name: "fixture-renderer",
    version: "1",
    async render(url: string) {
      calls.n += 1;
      calls.urls.push(url);
      if (fail) throw fail;
      return renderedDoc(url);
    },
  };
}

// Installs a renderer through the PRODUCTION installer — the same call
// startWorker() makes — with the browser itself replaced by a fixture.
// Everything the installer decides (role, flag, self-test, ordering) is
// therefore real.
async function installFixtureRenderer(calls: { n: number; urls: string[] }, fail?: RenderedDocsError) {
  process.env[RENDERED_DOCS_ENV] = "1";
  return installFetchRendererCapability({
    capabilities: FETCH_ROLE,
    selfTest: async () => okSelfTest(),
    create: () => fixtureRenderer(calls, fail),
  });
}

function scriptedFetcher(script: {
  onDefault: () => FetchedDocument | never;
  onText?: () => FetchedDocument | never;
  calls?: { n: number; prefs: string[]; urls: string[] };
}): ContentFetcher {
  return {
    name: "safe-http",
    async fetch(url, opts) {
      const pref = opts?.acceptPreference ?? "DEFAULT";
      script.calls?.prefs.push(pref);
      script.calls?.urls.push(url);
      if (script.calls) script.calls.n += 1;
      return pref === "TEXT_REPRESENTATION" && script.onText
        ? script.onText()
        : script.onDefault();
    },
  };
}

async function makeProject(opts: { confirmDocs?: boolean } = {}) {
  const slug = uniq("d146s2");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D146 Slice2 Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("fixture identity failed");
  if (opts.confirmDocs) {
    const confirmed = await confirmSourceRoute(ctx.db, {
      projectSlug: slug,
      domain: HOST,
      pathPrefix: "/mechanism",
    });
    if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, {
      routeId: confirmed.itemId,
      routeClass: "OFFICIAL_DOCS",
    });
    if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  }
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

async function seedTargets(projectOpts: { confirmDocs?: boolean } = {}, urls: string[] = [TARGET]) {
  const project = await makeProject(projectOpts);
  const jobId = await makeJob(project.id);
  const { view } = await loadJobContractView(ctx.db, jobId);
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue.slice(0, 1),
    target: targetFor(project),
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
  return { project, jobId };
}

async function fetchPhase(project: { id: string }, jobId: string, fetcher: ContentFetcher) {
  return runFetchPhase({
    db: ctx.db,
    jobId,
    projectId: project.id,
    contentFetcher: fetcher,
    maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
  });
}

async function sourceOpens(jobId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: researchJobs.sourceOpensReserved })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row?.n ?? 0;
}

const networkError = () => {
  throw new ContentFetchError("NETWORK_ERROR", "read ECONNRESET", TARGET);
};

// ---------------------------------------------------------------- A
describe("A. FETCH role, renderer flag OFF", () => {
  it("installs nothing, starts no browser, and leaves the other two strategies alone", async () => {
    delete process.env[RENDERED_DOCS_ENV];
    let selfTests = 0;
    let created = 0;
    const result = await installFetchRendererCapability({
      capabilities: FETCH_ROLE,
      selfTest: async () => {
        selfTests += 1;
        return okSelfTest();
      },
      create: () => {
        created += 1;
        return fixtureRenderer({ n: 0, urls: [] });
      },
    });

    expect(result.outcome).toBe("NOT_ENABLED");
    expect(result.selfTest).toBeNull();
    // The whole renderer lifecycle is untouched: no self-test means no
    // browser was launched even to check.
    expect(selfTests).toBe(0);
    expect(created).toBe(0);
    expect(renderedDocsAvailable()).toBe(false);
  });

  it("still acquires through DIRECT_HTTP with no renderer present", async () => {
    delete process.env[RENDERED_DOCS_ENV];
    await installFetchRendererCapability({ capabilities: FETCH_ROLE });

    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const out = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: () => doc(TARGET), calls }),
    );

    expect(out.sealedDocumentIds).toHaveLength(1);
    expect(calls.prefs).toEqual(["DEFAULT"]);
    expect(await sourceOpens(jobId)).toBe(1);
  });

  it("negotiation remains available without a renderer", async () => {
    delete process.env[RENDERED_DOCS_ENV];
    await installFetchRendererCapability({ capabilities: FETCH_ROLE });

    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: networkError, onText: () => doc(TARGET), calls }),
    );

    expect(calls.prefs).toEqual(["DEFAULT", "TEXT_REPRESENTATION"]);
    expect(await sourceOpens(jobId)).toBe(2);
  });
});

// ---------------------------------------------------------------- B
describe("B. FETCH role, flag ON, self-test succeeds", () => {
  it("runs the self-test BEFORE exposing the capability, then installs exactly one", async () => {
    process.env[RENDERED_DOCS_ENV] = "1";
    const order: string[] = [];
    const result = await installFetchRendererCapability({
      capabilities: FETCH_ROLE,
      selfTest: async () => {
        // The capability must not be reachable while the browser is still
        // unproven — otherwise a FETCHING message picked up during startup
        // could reach a renderer that was about to fail to launch.
        order.push("selfTest:available=" + renderedDocsAvailable());
        return okSelfTest();
      },
      create: () => {
        order.push("create");
        return fixtureRenderer({ n: 0, urls: [] });
      },
    });

    expect(result.outcome).toBe("INSTALLED");
    expect(order).toEqual(["selfTest:available=false", "create"]);
    expect(result.selfTest?.ok).toBe(true);
    expect(result.selfTest?.browserVersion).toBe("fixture/1.0");
    expect(renderedDocsAvailable()).toBe(true);
  });

  it("makes the phased chain able to resolve the renderer", async () => {
    const calls = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(calls);

    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const out = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: networkError, onText: networkError }),
    );

    expect(calls.n).toBe(1);
    expect(out.sealedDocumentIds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- C
describe("C. FETCH role, flag ON, self-test FAILS", () => {
  it("fails startup closed rather than degrading to a quiet direct-only mode", async () => {
    process.env[RENDERED_DOCS_ENV] = "1";
    let created = 0;
    const installs: (unknown | null)[] = [];

    await expect(
      installFetchRendererCapability({
        capabilities: FETCH_ROLE,
        selfTest: async () => failedSelfTest(),
        create: () => {
          created += 1;
          return fixtureRenderer({ n: 0, urls: [] });
        },
        install: (f) => installs.push(f),
      }),
    ).rejects.toBeInstanceOf(RendererCapabilityUnavailableError);

    // No renderer was ever constructed, and the only install call was the
    // cleanup one — startup leaves nothing half-installed behind.
    expect(created).toBe(0);
    expect(installs).toEqual([null]);
    expect(renderedDocsAvailable()).toBe(false);
  });

  it("carries the self-test's own closed reason and no raw browser text", async () => {
    process.env[RENDERED_DOCS_ENV] = "1";
    let err: RendererCapabilityUnavailableError | null = null;
    try {
      await installFetchRendererCapability({
        capabilities: FETCH_ROLE,
        selfTest: async () => failedSelfTest(),
      });
    } catch (e) {
      err = e as RendererCapabilityUnavailableError;
    }

    expect(err).toBeInstanceOf(RendererCapabilityUnavailableError);
    if (!err) throw new Error("unreachable");
    expect(err.reason).toBe("BROWSER_LAUNCH_FAILED");
    expect(err.diagnostic).toBe("EXECUTABLE_NOT_FOUND");
    // The operator sees a category, never a stack or a message from the
    // child process.
    expect(err.message).not.toMatch(/at |\n\s+at/);
  });

  it("writes no research trace: no research attempt occurred", async () => {
    const { jobId } = await seedTargets({ confirmDocs: true });
    const before = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));

    process.env[RENDERED_DOCS_ENV] = "1";
    await installFetchRendererCapability({
      capabilities: FETCH_ROLE,
      selfTest: async () => failedSelfTest(),
    }).catch(() => undefined);

    const after = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    expect(after.length).toBe(before.length);
  });
});

// ---------------------------------------------------------------- D
describe("D. SEARCH_EXTRACT role", () => {
  it("never installs a renderer or runs a self-test, even with the flag set", async () => {
    process.env[RENDERED_DOCS_ENV] = "1";
    let selfTests = 0;
    let created = 0;
    const result = await installFetchRendererCapability({
      capabilities: SEARCH_ROLE,
      selfTest: async () => {
        selfTests += 1;
        return okSelfTest();
      },
      create: () => {
        created += 1;
        return fixtureRenderer({ n: 0, urls: [] });
      },
    });

    // The flag is not the licence; the ROLE is. D-136's separation of
    // external reach survives renderer enablement.
    expect(result.outcome).toBe("NOT_FETCH_ROLE");
    expect(selfTests).toBe(0);
    expect(created).toBe(0);
    expect(renderedDocsAvailable()).toBe(false);
  });

  it("a process with no declared capability at all installs nothing", async () => {
    process.env[RENDERED_DOCS_ENV] = "1";
    const result = await installFetchRendererCapability({
      capabilities: new Set<PhaseCapability>(),
      selfTest: async () => okSelfTest(),
    });
    expect(result.outcome).toBe("NOT_FETCH_ROLE");
    expect(renderedDocsAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------- E
describe("E. lifecycle and shutdown", () => {
  it("installs one capability object and closes it exactly once", async () => {
    process.env[RENDERED_DOCS_ENV] = "1";
    let created = 0;
    const installs: (unknown | null)[] = [];
    const install = (f: unknown | null) => installs.push(f);

    await installFetchRendererCapability({
      capabilities: FETCH_ROLE,
      selfTest: async () => okSelfTest(),
      create: () => {
        created += 1;
        return fixtureRenderer({ n: 0, urls: [] });
      },
      install: install as (f: RenderedDocsFetcher | null) => void,
    });
    expect(created).toBe(1);
    expect(installs.length).toBe(1);

    uninstallRendererCapability(install as (f: RenderedDocsFetcher | null) => void);
    expect(installs.length).toBe(2);
    expect(installs[1]).toBeNull();
  });

  it("after shutdown the capability is no longer reachable", async () => {
    const calls = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(calls);
    expect(renderedDocsAvailable()).toBe(true);

    uninstallRendererCapability();
    expect(renderedDocsAvailable()).toBe(false);

    // Idempotent: a supervisor sending both SIGINT and SIGTERM must not
    // turn teardown into an error.
    uninstallRendererCapability();
    expect(renderedDocsAvailable()).toBe(false);
  });

  it("many renders reuse the one installed capability — no per-URL install", async () => {
    const calls = { n: 0, urls: [] as string[] };
    let created = 0;
    process.env[RENDERED_DOCS_ENV] = "1";
    await installFetchRendererCapability({
      capabilities: FETCH_ROLE,
      selfTest: async () => okSelfTest(),
      create: () => {
        created += 1;
        return fixtureRenderer(calls);
      },
    });

    const urls = [TARGET, `https://${HOST}/mechanism/b`, `https://${HOST}/mechanism/c`];
    const { project, jobId } = await seedTargets({ confirmDocs: true }, urls);
    await fetchPhase(project, jobId, scriptedFetcher({ onDefault: networkError, onText: networkError }));

    // Three renders, one installed capability. (Process isolation per
    // render is the renderer's own security model and is unchanged: each
    // render spawns and tears down its own child and proxy.)
    expect(calls.n).toBe(3);
    expect(created).toBe(1);
  });

  it("the worker guards teardown against a second signal", () => {
    // The guard lives in startWorker(), which owns the signal handlers.
    const src = readFileSync("src/server/jobs/worker.ts", "utf-8");
    expect(src).toMatch(/if \(shuttingDown\) return;/);
    expect(src).toMatch(/uninstallRendererCapability\(\)/);
  });
});

// ---------------------------------------------------------------- F
describe("F. the real phased chain with a production-installed renderer", () => {
  it("DIRECT fails, NEGOTIATION fails, RENDER succeeds: one sealed document, 3 opens", async () => {
    const calls = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(calls);

    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const fetchCalls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const out = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: networkError, onText: networkError, calls: fetchCalls }),
    );

    expect(fetchCalls.prefs).toEqual(["DEFAULT", "TEXT_REPRESENTATION"]);
    expect(calls.n).toBe(1);
    expect(out.sealedDocumentIds).toHaveLength(1);
    expect(out.strategyAttempts.map((s) => s.strategy)).toEqual([
      "DIRECT_HTTP",
      "CONTENT_NEGOTIATION",
      "ISOLATED_RENDER",
    ]);

    const docs = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(docs.length).toBe(1);
    expect(docs[0].acquisitionStrategy).toBe("ISOLATED_RENDER");
    expect(docs[0].renderMode).toBe("RENDERED");
    // Three real external attempts, three reservations — the renderer is
    // metered on the same axis as the other two, with no new budget.
    expect(await sourceOpens(jobId)).toBe(3);
  });

  it("a rendered document does not promote authority", async () => {
    const calls = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(calls);

    const { project, jobId } = await seedTargets({ confirmDocs: true });
    await fetchPhase(project, jobId, scriptedFetcher({ onDefault: networkError, onText: networkError }));

    const [row] = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    // The route was already CONFIRMED/OFFICIAL_DOCS before the render —
    // that is what made the render eligible. Rendering neither raised nor
    // lowered it: transport is provenance, never authority.
    const authority = row.authority as { officiality: string; routeClass: string | null };
    expect(authority.officiality).toBe("CONFIRMED");
    expect(authority.routeClass).toBe("OFFICIAL_DOCS");
    expect(row.admission).toBe("PRODUCT_ACQUISITION");
  });
});

// ---------------------------------------------------------------- G
describe("G. security stop with the renderer installed", () => {
  for (const reason of ["BLOCKED_ADDRESS", "REDIRECT_TARGET_BLOCKED"] as const) {
    it(`${reason} never reaches the renderer, even though one is available`, async () => {
      const calls = { n: 0, urls: [] as string[] };
      await installFixtureRenderer(calls);

      const { project, jobId } = await seedTargets({ confirmDocs: true });
      const fetchCalls = { n: 0, prefs: [] as string[], urls: [] as string[] };
      const out = await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError(reason, "blocked", TARGET);
          },
          // Would succeed if it were ever asked. It is not asked.
          onText: () => doc(TARGET),
          calls: fetchCalls,
        }),
      );

      expect(calls.n).toBe(0);
      expect(fetchCalls.n).toBe(1);
      expect(out.sealedDocumentIds).toEqual([]);
      // Exactly one attempt, exactly one reservation: a security refusal
      // buys no second opinion from a browser.
      expect(await sourceOpens(jobId)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------- H
describe("H. route gate", () => {
  it("an unconfirmed route is never rendered, however available the renderer is", async () => {
    const calls = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(calls);

    // No confirmed source route for this project.
    const { project, jobId } = await seedTargets({ confirmDocs: false });
    const out = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: networkError, onText: networkError }),
    );

    expect(calls.n).toBe(0);
    expect(out.sealedDocumentIds).toEqual([]);
    // Two transport attempts, no render.
    expect(await sourceOpens(jobId)).toBe(2);
  });
});

// ---------------------------------------------------------------- I
describe("I. render cap in a production-enabled configuration", () => {
  it("stops at four renders per job and redelivery does not reset it", async () => {
    const calls = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(calls);

    const urls = Array.from({ length: 5 }, (_, i) => `https://${HOST}/mechanism/p${i}`);
    const { project, jobId } = await seedTargets({ confirmDocs: true }, urls);
    const fetcher = scriptedFetcher({ onDefault: networkError, onText: networkError });

    await fetchPhase(project, jobId, fetcher);
    expect(calls.n).toBe(4);

    // A redelivery reads the ceiling from persisted trace, not memory.
    await fetchPhase(project, jobId, fetcher);
    expect(calls.n).toBe(4);
  });
});

// ---------------------------------------------------------------- J
describe("J. CRITICAL — a strategy that becomes available after an earlier delivery", () => {
  it("continues into ISOLATED_RENDER without repeating or re-paying for the first two", async () => {
    // DELIVERY 1 — no renderer installed at all.
    expect(renderedDocsAvailable()).toBe(false);
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const first = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const out1 = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: networkError, onText: networkError, calls: first }),
    );

    expect(first.prefs).toEqual(["DEFAULT", "TEXT_REPRESENTATION"]);
    expect(await sourceOpens(jobId)).toBe(2);
    // The url is NOT exhausted: a strategy it is owed has never run.
    expect(out1.exhaustedUrls).toEqual([]);
    expect(out1.failedUrls).toEqual([TARGET]);

    // DELIVERY 2 — the renderer is now a real capability of this worker.
    const renders = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(renders);

    const second = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const out2 = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: networkError, onText: networkError, calls: second }),
    );

    // Neither previously-attempted strategy runs again...
    expect(second.n).toBe(0);
    // ...only the one that never ran.
    expect(renders.n).toBe(1);
    expect(renders.urls).toEqual([TARGET]);
    expect(out2.strategyAttempts.map((s) => s.strategy)).toEqual(["ISOLATED_RENDER"]);
    // Exactly one NEW reservation: 2 + 1, never 2 + 3.
    expect(await sourceOpens(jobId)).toBe(3);
    // And it seals exactly one document.
    expect(out2.sealedDocumentIds).toHaveLength(1);
    const docs = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(docs.length).toBe(1);
    expect(docs[0].acquisitionStrategy).toBe("ISOLATED_RENDER");
  });

  it("once every owed strategy has been attempted, the url IS exhausted", async () => {
    const renders = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(renders, new RenderedDocsError("DOCUMENT_NOT_READY"));

    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const fetcher = scriptedFetcher({ onDefault: networkError, onText: networkError });
    await fetchPhase(project, jobId, fetcher);
    expect(renders.n).toBe(1);

    // A third delivery has nothing left to try, and says so rather than
    // silently re-running anything.
    const out = await fetchPhase(project, jobId, fetcher);
    expect(out.exhaustedUrls).toEqual([TARGET]);
    expect(out.strategyAttempts).toEqual([]);
    expect(renders.n).toBe(1);
    expect(await sourceOpens(jobId)).toBe(3);
  });

  it("a persisted HTTP_ERROR does not earn a render on a later delivery", async () => {
    // The status is deliberately not persisted (D-143 stores the category
    // alone), and a category cannot tell 403 from 404. Reconstruction is
    // therefore fail-closed: a refusal-render is earned inside the
    // delivery that actually saw the refusal.
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const fetcher = scriptedFetcher({
      onDefault: () => {
        throw new ContentFetchError("HTTP_ERROR", "refused", TARGET, 403);
      },
    });

    // Delivery 1 with no renderer: DIRECT fails 403, render is planned
    // but unavailable.
    await fetchPhase(project, jobId, fetcher);
    expect(await sourceOpens(jobId)).toBe(1);

    // Delivery 2 with a renderer: nothing is re-planned from the bare
    // category.
    const renders = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(renders);
    const out = await fetchPhase(project, jobId, fetcher);

    expect(renders.n).toBe(0);
    expect(out.exhaustedUrls).toEqual([TARGET]);
    expect(await sourceOpens(jobId)).toBe(1);
  });
});

// ---------------------------------------------------------------- K
describe("K. diagnostics", () => {
  it("a renderer failure persists its closed category and no raw message", async () => {
    const calls = { n: 0, urls: [] as string[] };
    await installFixtureRenderer(calls, new RenderedDocsError("NAVIGATION_FAILED"));

    const { project, jobId } = await seedTargets({ confirmDocs: true });
    await fetchPhase(project, jobId, scriptedFetcher({ onDefault: networkError, onText: networkError }));

    const failures = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    const renderFailure = failures.find(
      (r) => r.operationType === "FETCH_FAILED" && r.providerName === "isolated-render",
    );
    expect(renderFailure).toBeDefined();
    expect(renderFailure?.reasonCode).toBe("PROVIDER_ERROR");
    expect(renderFailure?.diagnosticCode).toBe("NAVIGATION_FAILED");

    for (const row of failures) {
      const blob = JSON.stringify(row);
      expect(blob).not.toMatch(/ECONNRESET|stack|Error:|at Object\./);
    }
  });
});

// ---------------------------------------------------------------- L
// Executable code only. The doc comments in these modules deliberately
// NAME the things that must never be consulted ("not VPN state, not DNS,
// not a reachability probe") — that prose is the rule being recorded, and
// a check that punished it would push the reasoning out of the file. What
// must be absent is any such IDENTIFIER in the code itself.
function codeOf(file: string): string {
  return readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("L. project independence", () => {
  it("neither the capability module nor the probe names a project, vendor or network", () => {
    const banned = [
      /raydium/i,
      /pump[_.]?fun/i,
      /mintlify/i,
      /cloudflare/i,
      /mantaray/i,
      /\bvpn\b/i,
      /solana/i,
    ];
    for (const file of ["src/server/jobs/renderer-capability.ts", "scripts/renderer-probe.ts"]) {
      const src = codeOf(file);
      for (const pattern of banned) {
        expect(src, `${file} must not mention ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("the capability decision reads only the role and the flag", () => {
    const src = codeOf("src/server/jobs/renderer-capability.ts");
    // No environment sniffing of any kind in the decision path.
    expect(src).not.toMatch(/\bdns\b|lookup\(|resolve4|reachab|isBlockedIp|net\.connect/i);
    expect(src).toContain("RENDERED_DOCS_ENABLED");
    expect(src).toContain('workerServesPhase(deps.capabilities, "FETCHING")');
  });

  it("the probe writes nothing and never enters research", () => {
    const src = codeOf("scripts/renderer-probe.ts");
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|persistAcquiredDocument|recordTraceEvent/);
    // The pool is closed before the render begins.
    expect(src.indexOf("await pool.end()")).toBeLessThan(src.indexOf(".render(url"));
  });
});
