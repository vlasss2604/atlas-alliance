import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import {
  __setRenderedDocsFetcher,
  type RenderedDocsFetcher,
  type RenderedDocument,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import type { FetchedDocument } from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// EVERY PAID DOCUMENTARY ATTEMPT SAYS SO.
//
// THE DEFECT. Documentary acquisition can spend a source open through four
// different paths, and only the first of them recorded an attempt:
//
//   DIRECT_HTTP          reserved -> FETCH_ATTEMPTED -> outcome      ✔
//   CONTENT_NEGOTIATION  reserved -> (nothing) -> outcome            ✘
//   ISOLATED_RENDER      reserved -> (nothing) -> (nothing)          ✘
//
// A live job proved the consequence: 23 successful reservations, but only
// 21 FETCH_ATTEMPTED rows. The two missing ones were a content negotiation
// and an isolated render of the same page — and the render was the open
// that produced the ONLY usable documentary evidence in the entire run.
// Spend could not be reconstructed from the attempt stream.
//
// THE ACCOUNTING WAS NEVER WRONG. No ceiling was exceeded and no budget was
// granted twice; the ledger and the trace simply disagreed about how many
// external actions had been paid for. What changes here is observability
// alone: one attempt row per successful reservation that proceeds to real
// network or browser work, carrying the strategy in providerName — the same
// identity the outcome rows already use.
//
// WHAT MUST NOT CHANGE, and every test below holds it: fallback ordering,
// the per-url fallback bound, budget behaviour, render eligibility, and what
// a rendered document produces.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setRenderedDocsFetcher(null);
});

const DOMAIN = "docs.fallback-parity.test";
const PREFIX = "/mechanism";
const TARGET = `https://${DOMAIN}${PREFIX}/page`;

const COST = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

const ITEM: ComponentWorkItem = {
  step: 3,
  stepName: "Mechanism Specification",
  component: "MECHANISM_SPEC",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

// Long enough that a successful static fetch is never upgraded to a render:
// the upgrade fires only on an SPA-shell-sized document.
const FULL_TEXT =
  "The mechanism is specified in the protocol documentation. ".repeat(40);

function rendered(url: string, text: string): RenderedDocument {
  return {
    ...doc(url, text),
    renderMode: "RENDERED",
    rendererName: "fixture-renderer",
    rendererVersion: "test",
    browserVersion: "test",
    confirmedRouteDomain: DOMAIN,
    matchedPathPrefix: PREFIX,
    staticTextLength: 0,
    renderedTextLength: text.length,
    rawHtmlHash: null,
    blockedRequestCount: 0,
    renderDurationMs: 1,
  };
}

function doc(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${uniq("c")}`,
    fetchedAt: new Date("2026-09-08T00:00:00Z"),
    byteLength: text.length,
  };
}

// NO CONFIRMED IDENTITY, deliberately: the job then plans no on-chain read,
// so every source open this test counts is a documentary one.
async function makeProject() {
  const slug = uniq("parity");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Fallback parity fixture", status: "ACTIVE_CORE" })
    .returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: DOMAIN, pathPrefix: PREFIX });
  if (!confirmed.ok) throw new Error(`route confirm failed: ${confirmed.refusal}`);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error(`route classify failed: ${classified.refusal}`);
  return { id: project.id, slug };
}

async function makeJob(projectId: string, slug: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "how is the mechanism specified?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "mechanism" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

interface RunOpts {
  // What the static/negotiated transport does, per call.
  fetch: (url: string, attempt: number) => Promise<FetchedDocument>;
  render?: RenderedDocsFetcher["render"];
  maxSourceOpens?: number;
}

async function run(opts: RunOpts) {
  const project = await makeProject();
  const jobId = await makeJob(project.id, project.slug);
  let fetchCalls = 0;
  let renderCalls = 0;

  if (opts.render) {
    __setRenderedDocsFetcher({
      name: "fixture-renderer",
      render: async (url, route) => {
        renderCalls += 1;
        return opts.render!(url, route);
      },
    } as RenderedDocsFetcher);
  }

  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, slug: project.slug, name: "Fallback parity fixture", ticker: null },
    queryProposer: { name: "fixture", async proposeQueries() { return ["q"]; } },
    searchGateway: {
      name: "fixture",
      async search() {
        return [{ url: TARGET, title: null, snippet: null }];
      },
    },
    contentFetcher: {
      name: "safe-http",
      async fetch(url: string) {
        fetchCalls += 1;
        return opts.fetch(url, fetchCalls);
      },
    },
    evidenceExtractor: { name: "fixture", async extract() { return []; } },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });

  const result = await executor.execute(ITEM, {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: {
      maxSearchQueries: 12,
      maxSourceOpens: opts.maxSourceOpens ?? 24,
      maxModelCostMicro: 2_000_000,
    },
    workQueueSize: 1,
    remainingComponents: 1,
    pendingComponents: [],
  });

  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const traces = await ctx.db
    .select()
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
  const attempts = traces
    .filter((t) => t.operationType === "FETCH_ATTEMPTED")
    .sort((a, b) => a.sequence - b.sequence);

  return {
    result,
    jobId,
    reserved: job!.sourceOpensReserved,
    attempts,
    attemptProviders: attempts.map((a) => a.providerName),
    fetchCalls,
    renderCalls,
    traces,
  };
}

const netError = () => {
  throw new ContentFetchError("NETWORK_ERROR", "read ECONNRESET", TARGET);
};

// ---------------------------------------------------------------------
describe("one paid documentary attempt, one attempt row", () => {
  it("1/7. direct fetch: one reservation, one FETCH_ATTEMPTED", async () => {
    const r = await run({ fetch: async (url) => doc(url, FULL_TEXT) });
    expect(r.fetchCalls).toBe(1);
    expect(r.reserved).toBe(1);
    expect(r.attempts).toHaveLength(1);
    expect(r.attemptProviders).toEqual(["safe-http"]);
  }, 120_000);

  it("2/7. direct failure then CONTENT_NEGOTIATION: two reservations, two rows", async () => {
    const r = await run({
      fetch: async (url, attempt) => (attempt === 1 ? netError() : doc(url, FULL_TEXT)),
    });
    expect(r.fetchCalls).toBe(2);
    expect(r.reserved).toBe(2);
    expect(r.attempts).toHaveLength(2);
    // The strategy is distinguishable from the row itself.
    expect(r.attemptProviders).toEqual(["safe-http", "content-negotiation"]);
  }, 120_000);

  it("3/7. direct + negotiation failure then ISOLATED_RENDER: three reservations, three rows", async () => {
    const r = await run({
      fetch: async () => netError(),
      render: async (url) => rendered(url, FULL_TEXT),
    });
    expect(r.fetchCalls).toBe(2);
    expect(r.renderCalls).toBe(1);
    expect(r.reserved).toBe(3);
    expect(r.attempts).toHaveLength(3);
    expect(r.attemptProviders).toEqual(["safe-http", "content-negotiation", "isolated-render"]);
  }, 120_000);

  it("7. the ledger and the documentary attempt trace agree on every path", async () => {
    const cases = [
      { name: "direct", opts: { fetch: async (u: string) => doc(u, FULL_TEXT) } },
      {
        name: "negotiated",
        opts: { fetch: async (u: string, n: number) => (n === 1 ? netError() : doc(u, FULL_TEXT)) },
      },
      {
        name: "rendered",
        opts: { fetch: async () => netError(), render: async (u: string) => rendered(u, FULL_TEXT) },
      },
    ];
    for (const c of cases) {
      const r = await run(c.opts as RunOpts);
      expect(r.attempts.length, c.name).toBe(r.reserved);
    }
  }, 180_000);
});

describe("what the new rows must NOT do", () => {
  it("4. a refused reservation produces no attempt row", async () => {
    // One open only: the direct fetch takes it, and the negotiation that
    // would follow is refused before any external work.
    const r = await run({ fetch: async () => netError(), maxSourceOpens: 1 });
    expect(r.reserved).toBe(1);
    expect(r.attempts).toHaveLength(1);
    expect(r.attemptProviders).toEqual(["safe-http"]);
    // Only the one call that was actually paid for happened.
    expect(r.fetchCalls).toBe(1);
    expect(r.renderCalls).toBe(0);
  }, 120_000);

  it("the initial safe-http fetch is not double-counted", async () => {
    const r = await run({ fetch: async (url) => doc(url, FULL_TEXT) });
    expect(r.attemptProviders.filter((p) => p === "safe-http")).toHaveLength(1);
  }, 120_000);
});

describe("5/6/8. behaviour around the new rows is unchanged", () => {
  it("5. a successful render still delivers its document", async () => {
    const r = await run({
      fetch: async () => netError(),
      render: async (url) => rendered(url, FULL_TEXT),
    });
    // The rendered document was acquired and the attempt reports it, exactly
    // as before this change.
    expect(r.renderCalls).toBe(1);
    expect(r.result.reason ?? "").toContain("DOCS_RENDERED_AFTER_FETCH_FAILURE");
  }, 120_000);

  it("6. a failed render keeps its existing failure semantics", async () => {
    const r = await run({
      fetch: async () => netError(),
      render: async () => {
        throw new Error("render exploded");
      },
    });
    // Still charged (the browser really was asked), still traced as an
    // attempt, and still an observation rather than an evidentiary claim.
    expect(r.reserved).toBe(3);
    expect(r.attempts).toHaveLength(3);
    expect(r.result.reason ?? "").toContain("DOCS_RENDER_AFTER_FETCH_FAILURE_FAILED");
    expect(r.result.status).not.toBe("SUCCEEDED");
  }, 120_000);

  it("8. fallback ordering and the per-url bound are untouched", async () => {
    const r = await run({ fetch: async () => netError(), render: async (u) => rendered(u, FULL_TEXT) });
    // DIRECT_HTTP, then CONTENT_NEGOTIATION, then ISOLATED_RENDER — and never
    // more than MAX_FALLBACK_ATTEMPTS_PER_URL (2) fallbacks for one url.
    expect(r.attemptProviders).toEqual(["safe-http", "content-negotiation", "isolated-render"]);
    expect(r.attemptProviders.length - 1).toBeLessThanOrEqual(2);
  }, 120_000);
});

describe("boundaries", () => {
  it("every sourceOpens reservation in the executor is followed by an attempt row", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/s4-executor.ts", "utf-8");
    // Counted from the CALLS, not from every mention of the axis name: the
    // file also names it in a comment, in two trace fields and in the
    // exhaustion error, none of which reserve anything.
    const lines = src.split("\n");
    const reservations: number[] = [];
    lines.forEach((line, i) => {
      // A CALL, not a comment about one, and not the exported definition.
      if (!line.includes("reserveJobBudget(") || line.trim().startsWith("//")) return;
      if (lines.slice(i, i + 7).join("\n").includes('"sourceOpens"')) reservations.push(i + 1);
    });
    const attemptRows = src.split('operationType: "FETCH_ATTEMPTED"').length - 1;
    // Five paid documentary paths — direct, negotiation, and three renders —
    // and one attempt row each.
    expect(reservations.length).toBe(5);
    expect(attemptRows).toBe(reservations.length);
  });

  it("the strategy names match the canonical acquisition vocabulary", async () => {
    const { readFile } = await import("node:fs/promises");
    const phases = await readFile("src/server/engine/acquisition-phases.ts", "utf-8");
    // No private vocabulary: the names written here are the ones the
    // phased path already records strategies under.
    expect(phases).toContain('CONTENT_NEGOTIATION: "content-negotiation"');
    expect(phases).toContain('ISOLATED_RENDER: "isolated-render"');
  });
});
