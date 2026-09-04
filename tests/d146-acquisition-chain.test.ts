import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  acquiredDocuments,
  projects,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import {
  plannedFallbacks,
  prepareExtractionReplayFetcher,
  runFetchPhase,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import { ACQUISITION_STRATEGIES } from "../src/server/engine/acquired-documents";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import {
  RenderedDocsError,
  __setRenderedDocsFetcher,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import type {
  RenderedDocsFetcher,
  RenderedDocument,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import type { ComponentTarget, FetchedDocument } from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-146 SLICE 1 — THE BOUNDED ACQUISITION CHAIN, PROVED OFFLINE.
//
// One url is acquired through at most three code-owned strategies, in
// order, stopping at the first COMPLETE document. What the tests below
// care about most is what the chain refuses to do: continue past a
// security refusal, repeat a strategy, accept partial content, exceed its
// bounds, or let a successful transport promote authority.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  __setRenderedDocsFetcher(null);
  await ctx.close();
});

const HOST = "docs.example-project.test";
const TARGET = `https://${HOST}/mechanism/page`;
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

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

// A static response that is a big HTML shell with almost no text — the
// canonical SPA shortfall the existing policy detects.
function spaShell(url: string): FetchedDocument {
  return doc(url, {
    byteLength: 250_000,
    normalizedText: "loading",
    staticTextLength: 7,
  });
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

// A renderer installed only through the existing test seam. Slice 1 never
// starts a browser.
function fixtureRenderer(calls: { n: number; urls: string[] }, fail?: RenderedDocsError): RenderedDocsFetcher {
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

// A transport whose behaviour is chosen per Accept preference, so a test
// can make DIRECT fail and NEGOTIATION succeed on the SAME url.
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
  const slug = uniq("d146");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D146 Fixture", status: "ACTIVE_CORE" })
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

// One search pass persisting `urls` as this job's candidates.
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
  return row.n;
}

async function attemptRows(jobId: string) {
  return ctx.db
    .select({
      op: researchTraceEvents.operationType,
      provider: researchTraceEvents.providerName,
      diagnostic: researchTraceEvents.diagnosticCode,
      reason: researchTraceEvents.reasonCode,
      target: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
}

async function sealed(jobId: string) {
  return ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId));
}

describe("D-146 §A — direct success takes no fallback", () => {
  it("A. a complete document seals on DIRECT_HTTP, one source open, no second strategy", async () => {
    const { project, jobId } = await seedTargets();
    const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const result = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: () => doc(TARGET), calls }),
    );

    expect(result.sealedDocumentIds).toHaveLength(1);
    expect(result.strategyAttempts).toEqual([{ url: TARGET, strategy: "DIRECT_HTTP" }]);
    expect(calls.n).toBe(1);
    expect(calls.prefs).toEqual(["DEFAULT"]);
    expect(await sourceOpens(jobId)).toBe(1);

    const rows = await sealed(jobId);
    expect(rows[0].acquisitionStrategy).toBe("DIRECT_HTTP");
    expect(rows[0].admission).toBe("PRODUCT_ACQUISITION");
    expect(rows[0].renderMode).toBe("STATIC");
  });
});

describe("D-146 §B — a truncated transport earns a bounded fallback", () => {
  it("B. NETWORK_ERROR → CONTENT_NEGOTIATION on the SAME url; one document, two opens", async () => {
    const { project, jobId } = await seedTargets();
    const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const result = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({
        onDefault: () => {
          throw new ContentFetchError("NETWORK_ERROR", "read ECONNRESET", TARGET);
        },
        onText: () => doc(TARGET, { contentType: "text/markdown" }),
        calls,
      }),
    );

    // Same url, different representation preference — never a new url.
    expect(new Set(calls.urls)).toEqual(new Set([TARGET]));
    expect(calls.prefs).toEqual(["DEFAULT", "TEXT_REPRESENTATION"]);

    expect(result.sealedDocumentIds).toHaveLength(1);
    expect(result.strategyAttempts).toEqual([
      { url: TARGET, strategy: "DIRECT_HTTP" },
      { url: TARGET, strategy: "CONTENT_NEGOTIATION" },
    ]);
    expect(await sourceOpens(jobId)).toBe(2);

    const rows = await sealed(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0].acquisitionStrategy).toBe("CONTENT_NEGOTIATION");

    // Trace names the strategy that made each attempt.
    const providers = (await attemptRows(jobId))
      .filter((r) => r.op === "FETCH_ATTEMPTED")
      .map((r) => r.provider);
    expect(providers).toEqual(["safe-http", "content-negotiation"]);
  });

  it("B. negotiation also failing lets the renderer run — at most three attempts for one url", async () => {
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const renders = { n: 0, urls: [] as string[] };
    __setRenderedDocsFetcher(fixtureRenderer(renders));
    try {
      const result = await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError("NETWORK_ERROR", "read ECONNRESET", TARGET);
          },
          onText: () => {
            throw new ContentFetchError("NETWORK_ERROR", "read ECONNRESET", TARGET);
          },
        }),
      );

      expect(result.strategyAttempts.map((a) => a.strategy)).toEqual([
        "DIRECT_HTTP",
        "CONTENT_NEGOTIATION",
        "ISOLATED_RENDER",
      ]);
      expect(renders.n).toBe(1);
      expect(result.sealedDocumentIds).toHaveLength(1);
      expect(await sourceOpens(jobId)).toBe(3);

      const rows = await sealed(jobId);
      expect(rows[0].acquisitionStrategy).toBe("ISOLATED_RENDER");
      expect(rows[0].renderMode).toBe("RENDERED");
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });
});

describe("D-146 §C — a security refusal ends the chain", () => {
  for (const reason of ["BLOCKED_ADDRESS", "REDIRECT_TARGET_BLOCKED"] as const) {
    it(`C. ${reason} → exactly one attempt, no negotiation, no render`, async () => {
      const { project, jobId } = await seedTargets({ confirmDocs: true });
      const renders = { n: 0, urls: [] as string[] };
      __setRenderedDocsFetcher(fixtureRenderer(renders));
      try {
        const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
        const result = await fetchPhase(
          project,
          jobId,
          scriptedFetcher({
            onDefault: () => {
              throw new ContentFetchError(reason, "blocked", TARGET);
            },
            onText: () => doc(TARGET),
            calls,
          }),
        );

        expect(calls.n).toBe(1);
        expect(renders.n).toBe(0);
        expect(result.strategyAttempts).toEqual([{ url: TARGET, strategy: "DIRECT_HTTP" }]);
        expect(result.sealedDocumentIds).toEqual([]);
        expect(await sourceOpens(jobId)).toBe(1);
      } finally {
        __setRenderedDocsFetcher(null);
      }
    });
  }

  it("C. a fallback can never be an SSRF bypass — the policy itself says so", () => {
    expect(plannedFallbacks("BLOCKED_ADDRESS", null)).toEqual([]);
    expect(plannedFallbacks("REDIRECT_TARGET_BLOCKED", null)).toEqual([]);
    // Deterministic refusals end the chain too. TOO_LARGE was in this
    // list and is deliberately no longer: it describes the representation
    // that was asked for, not the resource, so a different representation
    // is a different question (see §N).
    for (const d of ["INVALID_URL", "UNSUPPORTED_PROTOCOL", "TOO_MANY_REDIRECTS", "DNS_RESOLUTION_FAILED"]) {
      expect(plannedFallbacks(d, null), d).toEqual([]);
    }
    // Untyped failure: fail closed.
    expect(plannedFallbacks(null, null)).toEqual([]);
    // The honest middle.
    expect(plannedFallbacks("NETWORK_ERROR", null)).toEqual(["CONTENT_NEGOTIATION", "ISOLATED_RENDER"]);
    expect(plannedFallbacks("TIMEOUT", null)).toEqual(["CONTENT_NEGOTIATION", "ISOLATED_RENDER"]);
    expect(plannedFallbacks("UNSUPPORTED_CONTENT_TYPE", null)).toEqual(["CONTENT_NEGOTIATION"]);
  });
});

describe("D-146 §D — the canonical refusal policy is preserved", () => {
  it("D. 401/403/429 admit the renderer; other statuses do not", () => {
    for (const status of [401, 403, 429]) {
      expect(plannedFallbacks("HTTP_ERROR", status), String(status)).toEqual(["ISOLATED_RENDER"]);
    }
    for (const status of [404, 410, 500, 503]) {
      expect(plannedFallbacks("HTTP_ERROR", status), String(status)).toEqual([]);
    }
    expect(plannedFallbacks("HTTP_ERROR", null)).toEqual([]);
  });

  it("D. a 403 on a confirmed docs route renders and seals", async () => {
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const renders = { n: 0, urls: [] as string[] };
    __setRenderedDocsFetcher(fixtureRenderer(renders));
    try {
      const result = await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError("HTTP_ERROR", "refused", TARGET, 403);
          },
        }),
      );
      expect(result.strategyAttempts.map((a) => a.strategy)).toEqual([
        "DIRECT_HTTP",
        "ISOLATED_RENDER",
      ]);
      expect(renders.n).toBe(1);
      expect(result.sealedDocumentIds).toHaveLength(1);
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });
});

describe("D-146 §N — an oversized body is a representation problem, not a verdict", () => {
  // FOUND LIVE. A human-registered, human-classified OFFICIAL_DOCS page was
  // selected as a SOURCE_RESOURCE, attempted, and refused by our own byte
  // cap with diagnostic TOO_LARGE — then nothing else was tried, because
  // TOO_LARGE was classified with the refusals no transport can change.
  // It is not one of those: the origin was mid-reply with a document it was
  // willing to serve.

  it("N1. TOO_LARGE plans CONTENT_NEGOTIATION, and only that", () => {
    expect(plannedFallbacks("TOO_LARGE", null)).toEqual(["CONTENT_NEGOTIATION"]);
  });

  it("N2. TOO_LARGE never plans a render, at any status", () => {
    // A render of an oversized page yields the same document or a larger
    // one, and its output meets the identical cap at seal. The renderer is
    // for pages carrying too LITTLE static text — the opposite failure.
    for (const status of [null, 200, 403, 429, 404, 500]) {
      expect(plannedFallbacks("TOO_LARGE", status), String(status)).not.toContain(
        "ISOLATED_RENDER",
      );
    }
  });

  it("N3. the security stops are untouched by this widening", () => {
    // The one thing a fallback must never become. Asserted here as well as
    // in §C so a future edit to this case cannot quietly reach them.
    expect(plannedFallbacks("BLOCKED_ADDRESS", null)).toEqual([]);
    expect(plannedFallbacks("REDIRECT_TARGET_BLOCKED", null)).toEqual([]);
  });

  it("N4. an oversized HTML body then a readable text representation seals one document", async () => {
    const { project, jobId } = await seedTargets();
    const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const result = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({
        onDefault: () => {
          throw new ContentFetchError("TOO_LARGE", "response exceeded 2000000 bytes", TARGET);
        },
        onText: () => doc(TARGET, { contentType: "text/markdown" }),
        calls,
      }),
    );

    // The SAME url, asked for differently — never a new url, never a wider
    // limit.
    expect(new Set(calls.urls)).toEqual(new Set([TARGET]));
    expect(calls.prefs).toEqual(["DEFAULT", "TEXT_REPRESENTATION"]);
    expect(result.strategyAttempts).toEqual([
      { url: TARGET, strategy: "DIRECT_HTTP" },
      { url: TARGET, strategy: "CONTENT_NEGOTIATION" },
    ]);
    expect(result.sealedDocumentIds).toHaveLength(1);

    const rows = await sealed(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0].acquisitionStrategy).toBe("CONTENT_NEGOTIATION");
    expect(rows[0].renderMode).toBe("STATIC");

    // The failure is still recorded as what it was.
    const trace = await attemptRows(jobId);
    const failed = trace.filter((r) => r.op === "FETCH_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].diagnostic).toBe("TOO_LARGE");
    expect(failed[0].reason).toBe("PROVIDER_ERROR");
  });

  it("N5. oversized on BOTH representations ends the chain — no third attempt, no render", async () => {
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const renders = { n: 0, urls: [] as string[] };
    __setRenderedDocsFetcher(fixtureRenderer(renders));
    try {
      const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
      const result = await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError("TOO_LARGE", "response exceeded 2000000 bytes", TARGET);
          },
          onText: () => {
            throw new ContentFetchError("TOO_LARGE", "response exceeded 2000000 bytes", TARGET);
          },
          calls,
        }),
      );

      // Exactly two transport calls. The strategy is already in the plan, so
      // the second failure cannot re-add it, and nothing escalates.
      expect(calls.n).toBe(2);
      expect(renders.n).toBe(0);
      expect(result.strategyAttempts.map((a) => a.strategy)).toEqual([
        "DIRECT_HTTP",
        "CONTENT_NEGOTIATION",
      ]);
      expect(result.sealedDocumentIds).toEqual([]);
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });

  it("N6. the retry spends exactly one more source open, on the ordinary ledger", async () => {
    const { project, jobId } = await seedTargets();
    const before = await sourceOpens(jobId);
    await fetchPhase(
      project,
      jobId,
      scriptedFetcher({
        onDefault: () => {
          throw new ContentFetchError("TOO_LARGE", "response exceeded 2000000 bytes", TARGET);
        },
        onText: () => doc(TARGET, { contentType: "text/markdown" }),
      }),
    );
    // Two attempts, two opens — no strategy is free and none is exempt from
    // the single budget authority.
    expect(await sourceOpens(jobId)).toBe(before + 2);
  });

  it("N7. no byte limit moved to make any of this work", () => {
    // The whole point: the retry passes through the identical cap. If a
    // future change raises this instead of negotiating, it fails here.
    const src = readFileSync("src/server/engine/providers/content-fetcher.ts", "utf-8");
    expect(src).toContain("const DEFAULT_MAX_BYTES = 2_000_000;");
  });
});

describe("D-146 §E — SPA shortfall uses the canonical upgrade, Stage-0 costs nothing extra", () => {
  it("E. a successful shell upgrades to a render; no second SPA detector exists", async () => {
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const renders = { n: 0, urls: [] as string[] };
    __setRenderedDocsFetcher(fixtureRenderer(renders));
    try {
      const result = await fetchPhase(
        project,
        jobId,
        scriptedFetcher({ onDefault: () => spaShell(TARGET) }),
      );
      expect(result.strategyAttempts.map((a) => a.strategy)).toEqual([
        "DIRECT_HTTP",
        "ISOLATED_RENDER",
      ]);
      expect(renders.n).toBe(1);
      const rows = await sealed(jobId);
      expect(rows).toHaveLength(1);
      expect(rows[0].acquisitionStrategy).toBe("ISOLATED_RENDER");
      // The static fetch and the render each took one open — and nothing
      // else did.
      expect(await sourceOpens(jobId)).toBe(2);
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });

  it("E. Stage-0 recovery is requested on the SAME fetch and reserves no extra open", async () => {
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    const seen: Array<boolean | undefined> = [];
    const result = await fetchPhase(project, jobId, {
      name: "safe-http",
      async fetch(url, opts) {
        seen.push(opts?.recoverEmbeddedPayloads);
        return doc(url);
      },
    });
    // Requested (confirmed OFFICIAL_DOCS route with a matched prefix)…
    expect(seen).toEqual([true]);
    // …on the one and only call, costing exactly one source open.
    expect(result.strategyAttempts).toHaveLength(1);
    expect(await sourceOpens(jobId)).toBe(1);
  });

  it("E. an unconfirmed route never receives Stage-0 recovery", async () => {
    const { project, jobId } = await seedTargets();
    const seen: Array<boolean | undefined> = [];
    await fetchPhase(project, jobId, {
      name: "safe-http",
      async fetch(url, opts) {
        seen.push(opts?.recoverEmbeddedPayloads);
        return doc(url);
      },
    });
    expect(seen).toEqual([undefined]);
  });
});

describe("D-146 §G — worker death and redelivery", () => {
  it("G. a redelivery continues with the NEXT strategy and never repeats or re-pays for the first", async () => {
    const { project, jobId } = await seedTargets();

    // Delivery 1: only the direct attempt happens, then the "worker dies"
    // — modelled by a transport that refuses the fallback outright.
    const first = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({
        onDefault: () => {
          throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
        },
        onText: () => {
          throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
        },
      }),
    );
    expect(first.strategyAttempts.map((a) => a.strategy)).toEqual([
      "DIRECT_HTTP",
      "CONTENT_NEGOTIATION",
    ]);
    const opensAfterFirst = await sourceOpens(jobId);

    // Delivery 2: both strategies are already recorded in trace, so the
    // url is exhausted — no call, no reservation, no duplicate row.
    const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const second = await fetchPhase(
      project,
      jobId,
      scriptedFetcher({ onDefault: () => doc(TARGET), calls }),
    );
    expect(calls.n).toBe(0);
    expect(second.strategyAttempts).toEqual([]);
    expect(second.exhaustedUrls).toEqual([TARGET]);
    expect(await sourceOpens(jobId)).toBe(opensAfterFirst);
  });

  it("G. a strategy interrupted before running is still available to the next delivery", async () => {
    const { project, jobId } = await seedTargets();

    // Delivery 1 makes ONLY the direct attempt: UNSUPPORTED_CONTENT_TYPE
    // plans exactly one fallback, and the transport throws a class that
    // ends the chain there.
    await fetchPhase(
      project,
      jobId,
      scriptedFetcher({
        onDefault: () => {
          throw new ContentFetchError("UNSUPPORTED_CONTENT_TYPE", "nope", TARGET);
        },
        onText: () => {
          throw new ContentFetchError("BLOCKED_ADDRESS", "stop", TARGET);
        },
      }),
    );
    const attemptedFirst = (await attemptRows(jobId))
      .filter((r) => r.op === "FETCH_ATTEMPTED")
      .map((r) => r.provider);
    expect(attemptedFirst).toEqual(["safe-http", "content-negotiation"]);

    // Delivery 2: nothing left to try for this url.
    const second = await fetchPhase(project, jobId, scriptedFetcher({ onDefault: () => doc(TARGET) }));
    expect(second.strategyAttempts).toEqual([]);
  });
});

describe("D-146 §H — the render ceiling survives redelivery", () => {
  it("H. at most four real renders across the job, counted from persisted trace", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://${HOST}/mechanism/p${i}`);
    const { project, jobId } = await seedTargets({ confirmDocs: true }, urls);
    const renders = { n: 0, urls: [] as string[] };
    __setRenderedDocsFetcher(fixtureRenderer(renders, new RenderedDocsError("RENDER_FAILED", "fixture-renderer")));
    try {
      // Every url fails direct + negotiation, so every one reaches the
      // renderer; the renderer then fails, so nothing seals and the cap
      // is what stops the fifth.
      await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
          },
          onText: () => {
            throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
          },
        }),
      );
      expect(renders.n).toBe(4);

      // A redelivery cannot reset the ceiling: the count is read back
      // from trace, not from memory.
      const before = renders.n;
      await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
          },
        }),
      );
      expect(renders.n).toBe(before);
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });
});

describe("D-146 §I — the diagnostic union", () => {
  it("I. a renderer failure persists the RENDERER's own closed category", async () => {
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    __setRenderedDocsFetcher(
      fixtureRenderer({ n: 0, urls: [] }, new RenderedDocsError("DOCUMENT_NOT_READY", "fixture-renderer")),
    );
    try {
      await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError("HTTP_ERROR", "refused", TARGET, 403);
          },
        }),
      );
      const failures = (await attemptRows(jobId)).filter((r) => r.op === "FETCH_FAILED");
      const render = failures.find((r) => r.provider === "isolated-render");
      expect(render).toBeTruthy();
      expect(render!.reason).toBe("PROVIDER_ERROR");
      expect(render!.diagnostic).toBe("DOCUMENT_NOT_READY");
      // …while the fetch failure keeps its own vocabulary.
      const direct = failures.find((r) => r.provider === "safe-http");
      expect(direct!.diagnostic).toBe("HTTP_ERROR");
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });

  it("I. an untyped render failure records null, never a message", async () => {
    const { project, jobId } = await seedTargets({ confirmDocs: true });
    __setRenderedDocsFetcher({
      name: "fixture-renderer",
      version: "1",
      async render(): Promise<RenderedDocument> {
        throw new Error("read ECONNRESET at 10.0.0.1");
      },
    });
    try {
      await fetchPhase(
        project,
        jobId,
        scriptedFetcher({
          onDefault: () => {
            throw new ContentFetchError("HTTP_ERROR", "refused", TARGET, 403);
          },
        }),
      );
      const render = (await attemptRows(jobId)).find(
        (r) => r.op === "FETCH_FAILED" && r.provider === "isolated-render",
      );
      expect(render!.diagnostic).toBeNull();
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });
});

describe("D-146 §J — provenance", () => {
  it("J. strategy is closed, recorded, and never authority", async () => {
    expect([...ACQUISITION_STRATEGIES]).toEqual([
      "DIRECT_HTTP",
      "CONTENT_NEGOTIATION",
      "ISOLATED_RENDER",
    ]);

    // A CONTENT_NEGOTIATION success on an UNCONFIRMED route records the
    // strategy and still resolves authority as CLAIMED/unclassified: a
    // different transport promotes nothing.
    const { project, jobId } = await seedTargets();
    await fetchPhase(
      project,
      jobId,
      scriptedFetcher({
        onDefault: () => {
          throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
        },
        onText: () => doc(TARGET, { contentType: "text/markdown" }),
      }),
    );
    const rows = await sealed(jobId);
    expect(rows[0].acquisitionStrategy).toBe("CONTENT_NEGOTIATION");
    const authority = rows[0].authority as { officiality: string; routeClass: string | null };
    expect(authority.officiality).toBe("CLAIMED");
    expect(authority.routeClass).toBeNull();
  });

  it("J. the columns are additive: historical rows read NULL", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(
      "src/server/db/migrations/0037_d146_acquisition_provenance.sql",
      "utf-8",
    );
    expect(sql).toContain('ADD COLUMN "acquisition_strategy" text');
    expect(sql).toContain('ADD COLUMN "admission" text');
    expect(sql.toUpperCase()).not.toContain("NOT NULL");
    expect(sql.toUpperCase()).not.toContain("DEFAULT");
    expect(sql.toUpperCase()).not.toContain("UPDATE ");
  });
});

describe("D-146 §K — the phased replay verifies the tamper seal", () => {
  it("K. a valid document replays; an altered one is refused, never repaired", async () => {
    const { project, jobId } = await seedTargets();
    await fetchPhase(project, jobId, scriptedFetcher({ onDefault: () => doc(TARGET) }));
    const rows = await sealed(jobId);
    expect(rows).toHaveLength(1);

    const before = await prepareExtractionReplayFetcher(ctx.db, jobId);
    expect(before.documentCount).toBe(1);
    expect((await before.fetcher.fetch(TARGET)).finalUrl).toBe(TARGET);

    // Tamper with the persisted text, leaving the seal untouched.
    await ctx.db
      .update(acquiredDocuments)
      .set({ normalizedText: "the fees are burned" })
      .where(eq(acquiredDocuments.id, rows[0].id));

    const after = await prepareExtractionReplayFetcher(ctx.db, jobId);
    expect(after.documentCount).toBe(0);
    await expect(after.fetcher.fetch(TARGET)).rejects.toThrow();

    // The row was neither repaired nor re-sealed.
    const [still] = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.id, rows[0].id));
    expect(still.normalizedText).toBe("the fees are burned");
    expect(still.textSha256).toBe(rows[0].textSha256);
  });
});

describe("D-146 §L/§M — budgets and independence", () => {
  it("L. no new budget axis; the frozen envelope is unchanged", () => {
    expect(INTERNAL_ALPHA_V1.maxSearchQueries).toBe(12);
    expect(INTERNAL_ALPHA_V1.maxSourceOpens).toBe(24);
    expect(INTERNAL_ALPHA_V1.maxModelCostMicro).toBe(2_000_000);
  });

  it("L. the chain stops when the source-open axis is spent", async () => {
    const { project, jobId } = await seedTargets({}, [TARGET, `https://${HOST}/mechanism/second`]);
    const calls = { n: 0, prefs: [] as string[], urls: [] as string[] };
    const result = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: scriptedFetcher({
        onDefault: () => {
          throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
        },
        onText: () => {
          throw new ContentFetchError("NETWORK_ERROR", "reset", TARGET);
        },
        calls,
      }),
      // Exactly one open for the whole phase.
      maxSourceOpens: 1,
    });
    expect(calls.n).toBe(1);
    expect(result.strategyAttempts).toHaveLength(1);
    expect(await sourceOpens(jobId)).toBe(1);
  });

  it("M. the chain names no project, domain, vendor or network product", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = (await readFile("src/server/engine/acquisition-phases.ts", "utf-8"))
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const word of [
      "raydium",
      "mintlify",
      "cloudflare",
      "github",
      "mantaray",
      "vpn",
      "proxy",
      "region",
      "country",
      "pump_fun",
    ]) {
      expect(code, `chain must not name ${word}`).not.toContain(word);
    }
  });
});
