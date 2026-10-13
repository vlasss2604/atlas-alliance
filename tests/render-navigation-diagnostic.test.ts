import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  projects,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import {
  plannedFallbacks,
  runFetchPhase,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import {
  loadAcquisitionLedger,
  persistedFailureDiagnostics,
} from "../src/server/engine/acquisition-ledger";
import {
  RENDER_NAVIGATION_DIAGNOSTIC_CODES,
  diagnosticCodeHead,
  recordTraceEvent,
} from "../src/server/engine/trace-store";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import {
  NAVIGATION_DIAGNOSTICS,
  RENDERED_DOCS_FAILURE_REASONS,
  RenderedDocsError,
  __setRenderedDocsFetcher,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import type {
  RenderedDocsFetcher,
  RenderedDocument,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { summarizeEgressDenials } from "../src/server/engine/providers/render-egress-proxy";
import type { ComponentTarget, FetchedDocument } from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// PRODUCTION HAD ALREADY DECIDED, AND THEN THREW THE ANSWER AWAY.
//
// A fresh Research worker render of a CONFIRMED / OFFICIAL_DOCS page
// failed as NAVIGATION_FAILED while a standalone production-equivalent
// probe of the exact same page succeeded, repeatedly. Three materially
// different causes live inside that one word — our containment aborting
// the main-frame navigation, a timeout, or an unclassified transport
// error — and they call for three different next actions.
//
// The renderer had ALREADY classified which one. `recordRenderFailure`
// wrote `e.reason` and nothing else, so `e.navigationDiagnostic` and the
// egress proxy's own counts were computed, carried across the process
// boundary, and dropped at the last line before the database. Fifth
// instance of one defect in this project: information produced and
// discarded.
//
// The fix is diagnostic only. The stage stays NAVIGATION_FAILED for every
// consumer that DECIDES anything, the closed-set discipline on the column
// is enumerated rather than relaxed, and no renderer, authority, budget,
// fallback or evidence behaviour changes.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  __setRenderedDocsFetcher(null);
  await ctx.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HOST = "docs.nav-diagnostic.test";
const TARGET = `https://${HOST}/mechanism/page`;
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

// Planted in every field a renderer error can carry, so a passing
// assertion is evidence rather than an appeal to the code reading right.
const SECRET_HOST = "internal-cdn.corp.test";
const SECRET_ADDR = "10.11.12.13";
const SECRET_MSG = `page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://${SECRET_HOST}/x?api_key=sk-live-QQ11WW22`;

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
    fetchedAt: new Date("2026-09-04T00:00:00Z"),
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
  calls: { n: number },
  fail?: RenderedDocsError,
): RenderedDocsFetcher {
  return {
    name: "fixture-renderer",
    version: "1",
    async render(url: string) {
      calls.n += 1;
      if (fail) throw fail;
      return renderedDoc(url);
    },
  };
}

function scriptedFetcher(script: {
  onDefault: () => FetchedDocument | never;
  onText?: () => FetchedDocument | never;
}): ContentFetcher {
  return {
    name: "safe-http",
    async fetch(url, opts) {
      const pref = opts?.acceptPreference ?? "DEFAULT";
      return pref === "TEXT_REPRESENTATION" && script.onText
        ? script.onText()
        : script.onDefault();
    },
  };
}

const oversized = () => ({
  onDefault: () => {
    throw new ContentFetchError("TOO_LARGE", "response exceeded 2000000 bytes", TARGET);
  },
  onText: () => {
    throw new ContentFetchError("TOO_LARGE", "response exceeded 2000000 bytes", TARGET);
  },
});

async function makeProject() {
  const slug = uniq("navdiag");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Nav Diagnostic Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("fixture identity failed");
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

async function seedTargets() {
  const project = await makeProject();
  const jobId = await makeJob(project.id);
  const { view } = await loadJobContractView(ctx.db, jobId);
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue.slice(0, 1),
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
        return [{ url: TARGET, title: null, snippet: null }];
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

async function traceRows(jobId: string) {
  return ctx.db
    .select({
      op: researchTraceEvents.operationType,
      provider: researchTraceEvents.providerName,
      diagnostic: researchTraceEvents.diagnosticCode,
      reason: researchTraceEvents.reasonCode,
      status: researchTraceEvents.status,
      target: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
}

// A render failure exactly as the isolated renderer builds one: the stage,
// the navigation sub-code, and the proxy's counts.
function navFailure(
  navigationDiagnostic: (typeof NAVIGATION_DIAGNOSTICS)[number],
  denials: { allowed: boolean; reason?: string; target?: string }[] = [],
): RenderedDocsError {
  const e = new RenderedDocsError(
    "NAVIGATION_FAILED",
    "isolated",
    null,
    null,
    navigationDiagnostic,
    summarizeEgressDenials(denials),
  );
  // The renderer never puts a message on the wire; a hostile one is
  // planted here so the assertions below are about the code, not luck.
  Object.defineProperty(e, "message", { value: SECRET_MSG, configurable: true });
  return e;
}

// -----------------------------------------------------------------------
describe("1. the column's closed set is ENUMERATED, never relaxed", () => {
  it("there is exactly one composite per navigation diagnostic, and no more", () => {
    expect(RENDER_NAVIGATION_DIAGNOSTIC_CODES).toEqual([
      "NAVIGATION_FAILED:NAVIGATION_TIMEOUT",
      "NAVIGATION_FAILED:BLOCKED_BY_ROUTE_POLICY",
      "NAVIGATION_FAILED:UNCLASSIFIED_NAVIGATION_ERROR",
    ]);
    expect(RENDER_NAVIGATION_DIAGNOSTIC_CODES.length).toBe(NAVIGATION_DIAGNOSTICS.length);
    // Derived from the renderer's own vocabulary, so the two cannot drift.
    for (const d of NAVIGATION_DIAGNOSTICS) {
      expect(RENDER_NAVIGATION_DIAGNOSTIC_CODES).toContain(`NAVIGATION_FAILED:${d}`);
    }
  });

  it("the stage is recovered from any stored code, and every other class is untouched", () => {
    expect(diagnosticCodeHead("NAVIGATION_FAILED:NAVIGATION_TIMEOUT")).toBe("NAVIGATION_FAILED");
    expect(diagnosticCodeHead(null)).toBeNull();
    // Every historical value passes through byte-identical.
    for (const r of RENDERED_DOCS_FAILURE_REASONS) expect(diagnosticCodeHead(r)).toBe(r);
    for (const r of ["TOO_LARGE", "NETWORK_ERROR", "BLOCKED_ADDRESS"]) {
      expect(diagnosticCodeHead(r)).toBe(r);
    }
  });

  it("the writer still admits ONLY closed members — arbitrary text cannot pass", async () => {
    const { project, jobId } = await seedTargets();
    void project;
    for (const hostile of [
      SECRET_MSG,
      `NAVIGATION_FAILED:${SECRET_HOST}`,
      "NAVIGATION_FAILED:NAVIGATION_TIMEOUT:extra",
      "NAVIGATION_FAILED:",
      SECRET_ADDR,
    ]) {
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: "FETCH_FAILED",
        providerKind: "FETCH",
        providerName: "isolated-render",
        targetRef: TARGET,
        status: "FAILED",
        reasonCode: "PROVIDER_ERROR",
        diagnosticCode: hostile as never,
      });
    }
    const rows = (await traceRows(jobId)).filter((r) => r.op === "FETCH_FAILED");
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.diagnostic).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(SECRET_HOST);
    expect(JSON.stringify(rows)).not.toContain(SECRET_ADDR);
  });
});

// -----------------------------------------------------------------------
describe("2. the sub-diagnostic survives renderer -> acquisition -> trace", () => {
  for (const nav of NAVIGATION_DIAGNOSTICS) {
    it(`${nav} reaches the persisted row`, async () => {
      const { project, jobId } = await seedTargets();
      const calls = { n: 0 };
      __setRenderedDocsFetcher(fixtureRenderer(calls, navFailure(nav)));
      try {
        const result = await fetchPhase(project, jobId, scriptedFetcher(oversized()));
        expect(calls.n).toBe(1);
        expect(result.sealedDocumentIds).toEqual([]);

        const failed = (await traceRows(jobId)).filter(
          (r) => r.op === "FETCH_FAILED" && r.provider === "isolated-render",
        );
        expect(failed).toHaveLength(1);
        // THE BIT THAT WAS MISSING.
        expect(failed[0].diagnostic).toBe(`NAVIGATION_FAILED:${nav}`);
        // Production failure semantics, unchanged.
        expect(failed[0].reason).toBe("PROVIDER_ERROR");
        expect(failed[0].status).toBe("FAILED");
        expect(failed[0].target).toBe(TARGET);
      } finally {
        __setRenderedDocsFetcher(null);
      }
    });
  }

  it("a renderer that classified NOTHING still records the bare stage", async () => {
    const { project, jobId } = await seedTargets();
    const calls = { n: 0 };
    // navigationDiagnostic null — the shape a driver that cannot classify
    // produces. Nothing is invented to fill the gap.
    __setRenderedDocsFetcher(
      fixtureRenderer(calls, new RenderedDocsError("NAVIGATION_FAILED", "isolated")),
    );
    try {
      await fetchPhase(project, jobId, scriptedFetcher(oversized()));
      const failed = (await traceRows(jobId)).filter(
        (r) => r.op === "FETCH_FAILED" && r.provider === "isolated-render",
      );
      expect(failed[0].diagnostic).toBe("NAVIGATION_FAILED");
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });

  it("every OTHER renderer failure class records exactly what it recorded before", async () => {
    for (const reason of ["TIMEOUT", "TOO_LARGE", "HTTP_ERROR", "RENDER_FAILED"] as const) {
      const { project, jobId } = await seedTargets();
      const calls = { n: 0 };
      __setRenderedDocsFetcher(
        fixtureRenderer(calls, new RenderedDocsError(reason, "isolated")),
      );
      try {
        await fetchPhase(project, jobId, scriptedFetcher(oversized()));
        const failed = (await traceRows(jobId)).filter(
          (r) => r.op === "FETCH_FAILED" && r.provider === "isolated-render",
        );
        expect(failed[0].diagnostic, reason).toBe(reason);
      } finally {
        __setRenderedDocsFetcher(null);
      }
    }
  });
});

// -----------------------------------------------------------------------
describe("3. production semantics are unchanged", () => {
  it("the PLANNER still sees the stage, so no fallback behaviour moves", async () => {
    const { project, jobId } = await seedTargets();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { n: 0 };
    __setRenderedDocsFetcher(fixtureRenderer(calls, navFailure("NAVIGATION_TIMEOUT")));
    try {
      await fetchPhase(project, jobId, scriptedFetcher(oversized()));
    } finally {
      __setRenderedDocsFetcher(null);
    }
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    const seen = persistedFailureDiagnostics(TARGET, ledger).map((f) => f.diagnosticCode);
    // The ledger carries the STAGE, exactly as it did before the sub-code
    // existed — the planner cannot tell the difference.
    expect(seen).toEqual(["TOO_LARGE", "TOO_LARGE", "NAVIGATION_FAILED"]);
    // Replayed exactly as this job produced them: the composite never
    // reaches the planner, so each answer is the one the bare stage gave.
    const strategies = ["DIRECT_HTTP", "CONTENT_NEGOTIATION", "ISOLATED_RENDER"] as const;
    expect(seen.map((d, i) => plannedFallbacks(d, null, strategies[i]))).toEqual([
      ["CONTENT_NEGOTIATION"],
      ["ISOLATED_RENDER"],
      [],
    ]);
    // And the composite is not a code the planner has ever been given.
    for (const composite of RENDER_NAVIGATION_DIAGNOSTIC_CODES) {
      expect(seen).not.toContain(composite);
      for (const st of strategies) {
        expect(plannedFallbacks(composite, null, st)).toEqual(
          plannedFallbacks("NAVIGATION_FAILED", null, st),
        );
      }
    }
  });

  it("a re-delivery after the render failure is unchanged: nothing repeats, nothing new is owed", async () => {
    const { project, jobId } = await seedTargets();
    const calls = { n: 0 };
    __setRenderedDocsFetcher(fixtureRenderer(calls, navFailure("BLOCKED_BY_ROUTE_POLICY")));
    try {
      const first = await fetchPhase(project, jobId, scriptedFetcher(oversized()));
      expect(first.strategyAttempts.map((a) => a.strategy)).toEqual([
        "DIRECT_HTTP",
        "CONTENT_NEGOTIATION",
        "ISOLATED_RENDER",
      ]);
      const second = await fetchPhase(project, jobId, scriptedFetcher(oversized()));
      expect(second.strategyAttempts).toEqual([]);
      expect(calls.n).toBe(1);
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });

  it("a SUCCESSFUL render is untouched: no diagnostic, no warning, FETCH_OK", async () => {
    const { project, jobId } = await seedTargets();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { n: 0 };
    __setRenderedDocsFetcher(fixtureRenderer(calls));
    try {
      const result = await fetchPhase(project, jobId, scriptedFetcher(oversized()));
      expect(result.sealedDocumentIds).toHaveLength(1);
      const rows = await traceRows(jobId);
      const renderRows = rows.filter((r) => r.provider === "isolated-render");
      expect(renderRows.map((r) => r.op).sort()).toEqual(["FETCH_ATTEMPTED", "FETCH_OK"]);
      for (const r of renderRows) expect(r.diagnostic).toBeNull();
      // Nothing is logged about a render that worked.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      __setRenderedDocsFetcher(null);
    }
  });

  it("the reservation is unchanged — one open per strategy, none for the diagnostic", async () => {
    const { project, jobId } = await seedTargets();
    const calls = { n: 0 };
    __setRenderedDocsFetcher(fixtureRenderer(calls, navFailure("NAVIGATION_TIMEOUT")));
    try {
      await fetchPhase(project, jobId, scriptedFetcher(oversized()));
    } finally {
      __setRenderedDocsFetcher(null);
    }
    const [row] = await ctx.db
      .select({ n: researchJobs.sourceOpensReserved })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    expect(row.n).toBe(3);
  });
});

// -----------------------------------------------------------------------
describe("4. the proxy counts are bounded, and carry nothing else", () => {
  it("the summary the renderer computed reaches the operator as integers only", async () => {
    const { project, jobId } = await seedTargets();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { n: 0 };
    __setRenderedDocsFetcher(
      fixtureRenderer(
        calls,
        navFailure("UNCLASSIFIED_NAVIGATION_ERROR", [
          // Every raw field a decision record carries is planted.
          { target: `${SECRET_HOST}:443`, allowed: false, reason: "HOST_NOT_CONFIRMED" },
          { target: `${SECRET_HOST}:443`, allowed: false, reason: "HOST_NOT_CONFIRMED" },
          { target: `${SECRET_ADDR}:443`, allowed: true },
        ]),
      ),
    );
    try {
      await fetchPhase(project, jobId, scriptedFetcher(oversized()));
    } finally {
      __setRenderedDocsFetcher(null);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].map(String).join(" ");
    // The counts an operator needs to tell containment from transport.
    expect(line).toContain("denied=2");
    expect(line).toContain("allowed=1");
    expect(line).toContain("classes=1");
    expect(line).toContain("HOST_NOT_CONFIRMED=2");
    expect(line).toContain("[render] containment:");
    // And NOTHING else. No host, no address, no url, no message.
    expect(line).not.toContain(SECRET_HOST);
    expect(line).not.toContain(SECRET_ADDR);
    expect(line).not.toContain(TARGET);
    expect(line).not.toContain(HOST);
    expect(line).not.toContain("sk-live");
    expect(line).not.toContain("net::ERR");
    // Bounded: at most one entry per closed denial class, plus the three
    // fixed counters.
    expect(line.length).toBeLessThan(400);
  });

  it("a render failure with no proxy at all logs nothing rather than zeros", async () => {
    const { project, jobId } = await seedTargets();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { n: 0 };
    // proxyDenials null — the proxy was never opened, which is a
    // different observation from opened-and-silent.
    __setRenderedDocsFetcher(
      fixtureRenderer(
        calls,
        new RenderedDocsError("NAVIGATION_FAILED", "isolated", null, null, "NAVIGATION_TIMEOUT"),
      ),
    );
    try {
      await fetchPhase(project, jobId, scriptedFetcher(oversized()));
    } finally {
      __setRenderedDocsFetcher(null);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("no renderer message, host or address can reach the persisted row", async () => {
    const { project, jobId } = await seedTargets();
    const calls = { n: 0 };
    __setRenderedDocsFetcher(
      fixtureRenderer(
        calls,
        navFailure("UNCLASSIFIED_NAVIGATION_ERROR", [
          { target: `${SECRET_HOST}:443`, allowed: false, reason: "BLOCKED_ADDRESS" },
        ]),
      ),
    );
    try {
      await fetchPhase(project, jobId, scriptedFetcher(oversized()));
    } finally {
      __setRenderedDocsFetcher(null);
    }
    const rows = await traceRows(jobId);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(SECRET_HOST);
    expect(serialized).not.toContain(SECRET_ADDR);
    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("net::ERR");
    expect(serialized).not.toContain("page.goto");
    // The one render failure row carries the closed composite and nothing
    // that was not code-authored.
    const failed = rows.filter((r) => r.op === "FETCH_FAILED" && r.provider === "isolated-render");
    expect(failed).toHaveLength(1);
    expect(failed[0].diagnostic).toBe("NAVIGATION_FAILED:UNCLASSIFIED_NAVIGATION_ERROR");
  });
});
