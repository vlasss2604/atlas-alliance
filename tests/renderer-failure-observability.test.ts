import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projectMemoryItems, projects, topics, users } from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import {
  CHILD_REPORTABLE_RENDER_REASONS,
  RENDERED_DOCS_FAILURE_REASONS,
  RenderedDocsError,
  __setRenderedDocsFetcher,
  isRenderedDocsFailureReason,
  type ConfirmedDocsRoute,
  type RenderedDocsFetcher,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// A FAILED RENDER MUST SAY WHICH FAILURE IT WAS.
//
// The renderer already classified its own failures — the child put a typed
// reason on the wire and the parent threw it away one line before use, then
// reported RENDER_FAILED for every one of them. Downstream, S4 caught the
// error with a bare `catch {}` and recorded a single observation.
//
// The cost is not cosmetic. "the site defeated the browser" and "the
// browser never started" are opposite diagnoses with opposite next moves,
// and they were indistinguishable. A window spent on a live page could come
// back saying nothing actionable at all — the same defect that was already
// paid for once on the static fetch path.
//
// WHAT MUST NOT COME WITH IT. The renderer's boundary exists because a
// browser touches provider-controlled bytes: page content, an error message
// naming a filesystem path, a stack, a url, a stderr stream. None of that
// may cross. Only a value from a closed, code-authored list may, and only
// through two independent gates — the class AND the list — because a
// runtime value can violate a compile-time union and a look-alike object
// can carry a matching field.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

afterEach(() => {
  __setRenderedDocsFetcher(null);
});

const HOST = "docs.render-observability.test";
const PAGE_URL = `https://${HOST}/token/economics`;
const ROUTE: ConfirmedDocsRoute = { confirmedHost: HOST, matchedPathPrefix: "/token" };

// Credential-shaped text of exactly the kind a provider error can embed.
// It is planted in every untrusted channel so a leak has something
// unambiguous to be caught by.
const SECRET = "Bearer sk-live-51H8QqRtZzAaBbCcDd";
const SECRET_URL = `https://${HOST}/token?api_key=${SECRET}`;

const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  DATABASE_URL: `postgres://u:${SECRET}@h/db`,
  NODE_ENV: "test",
};

function fakeProxy() {
  return async () => ({ port: 44551, decisions: [], close: async () => {} });
}

function isolated(
  spawnImpl: (a: { scriptPath: string; env: Record<string, string>; request: unknown }) => Promise<{
    stdout: string;
    code: number | null;
  }>,
  startProxy?: unknown,
) {
  return createIsolatedRenderedDocsFetcher({
    spawnChild: spawnImpl as never,
    startProxy: (startProxy ?? fakeProxy()) as never,
    parentEnv: PARENT_ENV,
  });
}

const goodDocument = {
  renderMode: "RENDERED",
  finalUrl: PAGE_URL,
  normalizedText: "the protocol buys the token and destroys it",
  contentHash: "h",
  byteLength: 42,
  fetchedAt: new Date("2026-08-27T00:00:00Z").toISOString(),
};

// ---------------------------------------------------------------------
// 1. The contract itself
// ---------------------------------------------------------------------

describe("1. the reason list is closed, code-owned and exists at runtime", () => {
  it("the type is DERIVED from a runtime array, so membership is checkable", () => {
    // A bare type union vanishes at compile time. The sanitizer has to
    // decide membership for a value that crossed a process boundary, and
    // it cannot ask a type that no longer exists.
    expect(Array.isArray(RENDERED_DOCS_FAILURE_REASONS)).toBe(true);
    expect(RENDERED_DOCS_FAILURE_REASONS.length).toBeGreaterThan(0);
    expect(new Set(RENDERED_DOCS_FAILURE_REASONS).size).toBe(RENDERED_DOCS_FAILURE_REASONS.length);
  });

  it("every reason is an upper-case identifier — no shape that could carry prose", () => {
    for (const r of RENDERED_DOCS_FAILURE_REASONS) expect(r).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("each stage that can independently fail has exactly one reason", () => {
    // The four boundaries a render crosses, plus the render itself. Named
    // explicitly so adding a value is a deliberate act rather than drift.
    for (const required of [
      "EGRESS_PROXY_UNAVAILABLE", // network boundary
      "CHILD_SPAWN_FAILED", // process boundary — never started
      "CHILD_EXIT_NONZERO", // process boundary — died
      "CHILD_OUTPUT_MALFORMED", // data boundary
      "BROWSER_LAUNCH_FAILED", // render stage — the browser itself
      "HOST_NOT_ALLOWED", // render stage — blocked/private address
      "NAVIGATION_BLOCKED", // render stage — route policy
      "TIMEOUT",
      "TOO_LARGE",
      "RENDER_FAILED", // genuinely unclassified, never a stand-in
    ]) {
      expect(RENDERED_DOCS_FAILURE_REASONS).toContain(required);
    }
  });

  it("the guard admits members and refuses everything else", () => {
    for (const r of RENDERED_DOCS_FAILURE_REASONS) expect(isRenderedDocsFailureReason(r)).toBe(true);
    for (const bad of [
      "render_failed", // wrong case
      "RENDER_FAILED ", // padded
      "RENDER_FAILED:extra", // suffixed
      "PROVIDER_ERROR", // a different enum's value
      SECRET,
      "",
      null,
      undefined,
      42,
      { reason: "RENDER_FAILED" },
      ["RENDER_FAILED"],
    ]) {
      expect(isRenderedDocsFailureReason(bad)).toBe(false);
    }
  });

  it("what the child may claim is a strict subset of what exists", () => {
    for (const r of CHILD_REPORTABLE_RENDER_REASONS) {
      expect(RENDERED_DOCS_FAILURE_REASONS).toContain(r);
    }
    // The child renders; it does not supervise. It cannot have witnessed a
    // proxy that failed before it existed, a spawn that never produced it,
    // its own non-zero exit or its own malformed output.
    for (const parentOnly of [
      "EGRESS_PROXY_UNAVAILABLE",
      "CHILD_SPAWN_FAILED",
      "CHILD_EXIT_NONZERO",
      "CHILD_OUTPUT_MALFORMED",
      "RENDERER_UNAVAILABLE",
    ]) {
      expect(CHILD_REPORTABLE_RENDER_REASONS.has(parentOnly)).toBe(false);
    }
  });

  it("the error carries the reason and nothing provider-controlled", () => {
    const e = new RenderedDocsError("HOST_NOT_ALLOWED", "isolated");
    expect(e.reason).toBe("HOST_NOT_ALLOWED");
    expect(JSON.stringify({ m: e.message })).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------
// 2. Each stage is distinguishable
// ---------------------------------------------------------------------

describe("2. the supervisor names the stage that actually failed", () => {
  it("the egress proxy failing is not reported as a render failure", async () => {
    const f = createIsolatedRenderedDocsFetcher({
      spawnChild: (async () => {
        throw new Error("must not be reached");
      }) as never,
      startProxy: (async () => {
        throw new Error(`proxy bind failed for ${SECRET_URL}`);
      }) as never,
      parentEnv: PARENT_ENV,
    });
    // No child was spawned and nothing left the machine, so the site is
    // not implicated at all.
    await expect(f.render(PAGE_URL, ROUTE)).rejects.toMatchObject({
      reason: "EGRESS_PROXY_UNAVAILABLE",
    });
  });

  it("a child that cannot be spawned is distinguishable from one that ran", async () => {
    const f = isolated(async () => {
      throw new Error(`spawn ENOENT C:\\Users\\someone\\node_modules\\.bin\\tsx ${SECRET}`);
    });
    await expect(f.render(PAGE_URL, ROUTE)).rejects.toMatchObject({
      reason: "CHILD_SPAWN_FAILED",
    });
  });

  it("a child that started and died is distinguishable from one that spawned badly", async () => {
    const f = isolated(async () => ({ stdout: "", code: 1 }));
    await expect(f.render(PAGE_URL, ROUTE)).rejects.toMatchObject({
      reason: "CHILD_EXIT_NONZERO",
    });
  });

  it("a child killed by signal is a non-zero exit, not a page failure", async () => {
    const f = isolated(async () => ({ stdout: "partial", code: null }));
    await expect(f.render(PAGE_URL, ROUTE)).rejects.toMatchObject({
      reason: "CHILD_EXIT_NONZERO",
    });
  });

  it("a wedged child is a TIMEOUT, at the parent's own deadline", async () => {
    const f = createIsolatedRenderedDocsFetcher({
      spawnChild: (() => new Promise(() => {})) as never,
      startProxy: fakeProxy() as never,
      parentEnv: PARENT_ENV,
      limits: {
        browserLaunchTimeoutMs: 50,
        navigationTimeoutMs: 50,
        totalWallClockMs: 50,
        maxRenderedTextLength: 1000,
        maxTotalResponseBytes: 1000,
        maxNavigations: 1,
      },
    });
    await expect(f.render(PAGE_URL, ROUTE)).rejects.toMatchObject({ reason: "TIMEOUT" });
  }, 20_000);

  it("output that fails the data contract is malformed, not a failed render", async () => {
    for (const stdout of [
      "not json",
      "",
      JSON.stringify({ ok: true }), // no document
      JSON.stringify({ ok: true, document: { renderMode: "STATIC" } }), // wrong mode
      JSON.stringify({ ok: true, document: { renderMode: "RENDERED" } }), // missing fields
    ]) {
      const f = isolated(async () => ({ stdout, code: 0 }));
      await expect(f.render(PAGE_URL, ROUTE), stdout.slice(0, 24)).rejects.toMatchObject({
        reason: "CHILD_OUTPUT_MALFORMED",
      });
    }
  });
});

// ---------------------------------------------------------------------
// 3. The child's own reason survives — through both gates
// ---------------------------------------------------------------------

describe("3. what the child classified is what the parent reports", () => {
  it("each reason the child may report arrives intact", async () => {
    for (const reason of CHILD_REPORTABLE_RENDER_REASONS) {
      const f = isolated(async () => ({ stdout: JSON.stringify({ ok: false, reason }), code: 0 }));
      await expect(f.render(PAGE_URL, ROUTE), reason).rejects.toMatchObject({ reason });
    }
  });

  it("a blocked/private address survives as HOST_NOT_ALLOWED, not RENDER_FAILED", async () => {
    // The distinction that matters most in practice: our own containment
    // refusing the host, versus the page defeating the browser.
    const f = isolated(async () => ({
      stdout: JSON.stringify({ ok: false, reason: "HOST_NOT_ALLOWED" }),
      code: 0,
    }));
    await expect(f.render(PAGE_URL, ROUTE)).rejects.toMatchObject({ reason: "HOST_NOT_ALLOWED" });
  });

  it("a reason outside the closed list is refused, never echoed", async () => {
    for (const reason of [SECRET, "TOTALLY_MADE_UP", "render_failed", 7, null, { r: "TIMEOUT" }]) {
      const f = isolated(async () => ({ stdout: JSON.stringify({ ok: false, reason }), code: 0 }));
      const err = await f.render(PAGE_URL, ROUTE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RenderedDocsError);
      expect((err as RenderedDocsError).reason).toBe("CHILD_OUTPUT_MALFORMED");
    }
  });

  it("a child claiming a stage it cannot have witnessed is not believed", async () => {
    // These are real, code-owned values — so a list-membership check alone
    // would admit them. They are still refused, because the parent OWNS
    // the observation that the child never spawned, exited non-zero, or
    // produced malformed output.
    for (const parentOnly of [
      "CHILD_SPAWN_FAILED",
      "CHILD_EXIT_NONZERO",
      "CHILD_OUTPUT_MALFORMED",
      "EGRESS_PROXY_UNAVAILABLE",
      "RENDERER_UNAVAILABLE",
    ]) {
      const f = isolated(async () => ({
        stdout: JSON.stringify({ ok: false, reason: parentOnly }),
        code: 0,
      }));
      await expect(f.render(PAGE_URL, ROUTE), parentOnly).rejects.toMatchObject({
        reason: "CHILD_OUTPUT_MALFORMED",
      });
    }
  });

  it("nothing else on the envelope is read", async () => {
    // A hostile child cannot smuggle a field through by attaching it to a
    // legitimate failure.
    const f = isolated(async () => ({
      stdout: JSON.stringify({
        ok: false,
        reason: "TIMEOUT",
        message: SECRET,
        stack: `at ${SECRET_URL}`,
        url: SECRET_URL,
        headers: { authorization: SECRET },
        body: "<html>secret page content</html>",
      }),
      code: 0,
    }));
    const err = (await f.render(PAGE_URL, ROUTE).catch((e: unknown) => e)) as RenderedDocsError;
    expect(err.reason).toBe("TIMEOUT");
    expect(JSON.stringify({ r: err.reason, m: err.message, n: err.name })).not.toContain(SECRET);
    expect(JSON.stringify({ r: err.reason, m: err.message })).not.toContain("secret page content");
  });
});

// ---------------------------------------------------------------------
// 4. Nothing untrusted crosses
// ---------------------------------------------------------------------

describe("4. the boundary still holds", () => {
  it("arbitrary child stdout is never surfaced", async () => {
    const f = isolated(async () => ({ stdout: `${SECRET} ${SECRET_URL} <html>page</html>`, code: 0 }));
    const err = (await f.render(PAGE_URL, ROUTE).catch((e: unknown) => e)) as RenderedDocsError;
    expect(err.reason).toBe("CHILD_OUTPUT_MALFORMED");
    const surfaced = JSON.stringify({ r: err.reason, m: err.message, n: err.name });
    expect(surfaced).not.toContain(SECRET);
    expect(surfaced).not.toContain("<html>");
    expect(surfaced).not.toContain(HOST);
  });

  it("an arbitrary Error.message is never surfaced", async () => {
    const f = isolated(async () => {
      throw new Error(`ENOENT ${SECRET_URL} — authorization: ${SECRET}`);
    });
    const err = (await f.render(PAGE_URL, ROUTE).catch((e: unknown) => e)) as RenderedDocsError;
    const surfaced = JSON.stringify({ r: err.reason, m: err.message, n: err.name });
    expect(surfaced).not.toContain(SECRET);
    expect(surfaced).not.toContain("ENOENT");
  });

  it("a look-alike object carrying a valid reason is not trusted", async () => {
    // Duck typing is the exact failure the class gate exists to prevent:
    // this object would satisfy any structural check.
    const impostor = {
      name: "RenderedDocsError",
      reason: "HOST_NOT_ALLOWED",
      message: SECRET,
      rendererName: "isolated",
    };
    const f = isolated(async () => {
      throw impostor;
    });
    const err = (await f.render(PAGE_URL, ROUTE).catch((e: unknown) => e)) as RenderedDocsError;
    // It is replaced by the parent's own observation of the stage, and the
    // impostor's claimed reason does not survive.
    expect(err).toBeInstanceOf(RenderedDocsError);
    expect(err.reason).toBe("CHILD_SPAWN_FAILED");
    expect(JSON.stringify({ m: err.message })).not.toContain(SECRET);
  });

  it("the scrubbed environment is unchanged by any of this", async () => {
    let seenEnv: Record<string, string> | null = null;
    const f = isolated(async (a) => {
      seenEnv = a.env as Record<string, string>;
      return { stdout: JSON.stringify({ ok: true, document: goodDocument }), code: 0 };
    });
    await f.render(PAGE_URL, ROUTE);
    expect(JSON.stringify(seenEnv)).not.toContain(SECRET);
    expect(seenEnv!.DATABASE_URL).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// 5. Nothing about the successful path or the render budget moved
// ---------------------------------------------------------------------

describe("5. success and the one-attempt rule are untouched", () => {
  it("a successful render still returns a document", async () => {
    const f = isolated(async () => ({ stdout: JSON.stringify({ ok: true, document: goodDocument }), code: 0 }));
    const doc = await f.render(PAGE_URL, ROUTE);
    expect(doc.renderMode).toBe("RENDERED");
    expect(doc.normalizedText).toContain("destroys it");
    expect(doc.fetchedAt).toBeInstanceOf(Date);
  });

  it("EXACTLY ONE child render request, on every failure stage", async () => {
    // Classifying a failure must not have introduced a retry anywhere.
    for (const outcome of [
      async () => ({ stdout: "", code: 1 }),
      async () => ({ stdout: "not json", code: 0 }),
      async () => ({ stdout: JSON.stringify({ ok: false, reason: "TIMEOUT" }), code: 0 }),
      async () => {
        throw new Error("spawn failed");
      },
    ]) {
      let calls = 0;
      const f = isolated(async () => {
        calls += 1;
        return outcome() as never;
      });
      await f.render(PAGE_URL, ROUTE).catch(() => {});
      expect(calls).toBe(1);
    }
  });

  it("the egress boundary is still torn down after every outcome", async () => {
    let closed = 0;
    const proxy = async () => ({ port: 44551, decisions: [], close: async () => { closed += 1; } });
    const mk = (impl: () => Promise<{ stdout: string; code: number | null }>) =>
      createIsolatedRenderedDocsFetcher({
        spawnChild: impl as never,
        startProxy: proxy as never,
        parentEnv: PARENT_ENV,
      });
    await mk(async () => ({ stdout: JSON.stringify({ ok: true, document: goodDocument }), code: 0 })).render(PAGE_URL, ROUTE);
    await mk(async () => ({ stdout: "", code: 1 })).render(PAGE_URL, ROUTE).catch(() => {});
    await mk(async () => ({ stdout: JSON.stringify({ ok: false, reason: "TOO_LARGE" }), code: 0 }))
      .render(PAGE_URL, ROUTE)
      .catch(() => {});
    expect(closed).toBe(3);
  });
});

// ---------------------------------------------------------------------
// 6. It reaches the owner
// ---------------------------------------------------------------------

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

const FIXTURE_COST_PROFILE: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

async function makeJob() {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("rfo");
  const name = "Render Observability Test Project";
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name, ticker: null, status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: t.id,
    projectId: project.id,
    originalQuestion: "what does the page state?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return { jobId: job.id, projectId: project.id, projectName: name, projectSlug: slug };
}

// The lifecycle guard forbids INSERT-as-ACTIVE; walk the legal path.
async function activateSourceRoute(projectId: string, content: Record<string, unknown>) {
  const [row] = await ctx.db
    .insert(projectMemoryItems)
    .values({ projectId, kind: "SOURCE_ROUTE", content, lifecycleState: "OBSERVED" })
    .returning();
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "CANDIDATE" })
    .where(eq(projectMemoryItems.id, row.id));
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "ACTIVE" })
    .where(eq(projectMemoryItems.id, row.id));
}

function refusingFetcher(status: number): ContentFetcher {
  return {
    name: "fixture",
    async fetch(url) {
      throw new ContentFetchError("HTTP_ERROR", `HTTP ${status} for ${SECRET_URL}`, url, status);
    },
  };
}

function failingRenderer(e: unknown): RenderedDocsFetcher {
  return {
    name: "fixture-renderer",
    version: "1",
    async render() {
      throw e;
    },
  };
}

function depsFor(p: { projectId: string; projectName: string; projectSlug: string }, fetcher: ContentFetcher) {
  const proposer: QueryProposer = { name: "fixture", async proposeQueries() { return ["q1"]; } };
  const search: SearchGateway = {
    name: "fixture",
    async search() {
      return [{ url: PAGE_URL, title: "t", snippet: "a snippet, never evidence" }];
    },
  };
  const extractor: EvidenceExtractor = { name: "fixture", async extract() { return []; } };
  return {
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
    queryProposer: proposer,
    searchGateway: search,
    contentFetcher: fetcher,
    evidenceExtractor: extractor,
    queryProposerCostProfile: FIXTURE_COST_PROFILE,
    evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
  } as unknown as Parameters<typeof createS4WorkExecutor>[0];
}

function jobCtx(jobId: string) {
  return {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro: 1_000_000 },
  };
}

async function runWithFailingRender(thrown: unknown): Promise<string> {
  const p = await makeJob();
  await activateSourceRoute(p.projectId, {
    domain: HOST,
    pathPrefix: "/token",
    routeClass: "OFFICIAL_DOCS",
  });
  __setRenderedDocsFetcher(failingRenderer(thrown));
  const executor = createS4WorkExecutor(depsFor(p, refusingFetcher(403)));
  const outcome = await executor.execute(ITEM, jobCtx(p.jobId));
  expect(outcome.status).toBe("FAILED");
  return String((outcome as { reason?: unknown }).reason);
}

describe("6. the reason reaches the owner-visible terminal path", () => {
  it("a render refused by our own host policy says so", async () => {
    const reason = await runWithFailingRender(new RenderedDocsError("HOST_NOT_ALLOWED", "isolated"));
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:HOST_NOT_ALLOWED");
    // The static refusal that opened the render is still stated too, so
    // both halves of the story survive in one line.
    expect(reason).toContain("HTTP_ERROR:403");
  });

  it("a browser that never started is not reported as a page failure", async () => {
    const reason = await runWithFailingRender(
      new RenderedDocsError("BROWSER_LAUNCH_FAILED", "isolated"),
    );
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:BROWSER_LAUNCH_FAILED");
    // THE DISTINCTION THE WHOLE TASK EXISTS FOR: a broken local install
    // must not read as a site that defeated the renderer.
    expect(reason).not.toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:RENDER_FAILED");
  });

  it("a timeout is distinguishable from every other stage", async () => {
    const reason = await runWithFailingRender(new RenderedDocsError("TIMEOUT", "isolated"));
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:TIMEOUT");
  });

  it("when the browser is what failed, WHICH local fault reaches the owner too", async () => {
    const reason = await runWithFailingRender(
      new RenderedDocsError("BROWSER_LAUNCH_FAILED", "isolated", "EXECUTABLE_NOT_FOUND"),
    );
    expect(reason).toContain(
      "DOCS_RENDER_AFTER_REFUSAL_FAILED:BROWSER_LAUNCH_FAILED:EXECUTABLE_NOT_FOUND",
    );
  });

  it("a server that refused the BROWSER reports its trusted status to the owner", async () => {
    // The whole point of reading page.goto()'s Response: a browser served
    // 403 receives a page and renders it, so without the status check this
    // run would have reported a SUCCESSFUL render of a refusal page.
    const reason = await runWithFailingRender(
      new RenderedDocsError("HTTP_ERROR", "isolated", null, 403),
    );
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:HTTP_ERROR:403");
    // Both halves of the story in one line: the static client was refused
    // with 403, and so was the browser.
    expect(reason).toContain("CONTENT_FETCHER_FAILED");
  });

  it("a render with no verifiable status says so, and claims no number", async () => {
    const reason = await runWithFailingRender(
      new RenderedDocsError("NO_NAVIGATION_RESPONSE", "isolated"),
    );
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:NO_NAVIGATION_RESPONSE");
    expect(reason).not.toMatch(/NO_NAVIGATION_RESPONSE:\d/);
  });

  it("an unrecognised status cannot be injected into the owner's line", async () => {
    const e = new RenderedDocsError("HTTP_ERROR", "isolated");
    Object.defineProperty(e, "httpStatus", { value: `403 ${SECRET}` });
    const reason = await runWithFailingRender(e);
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:HTTP_ERROR");
    expect(reason).not.toContain(SECRET);
    expect(reason).not.toMatch(/HTTP_ERROR:403 /);
  });

  it("an unrecognised diagnostic is dropped, and the stage still stands alone", async () => {
    const e = new RenderedDocsError("BROWSER_LAUNCH_FAILED", "isolated");
    // Forced past the constructor's own check, which is exactly the case
    // the sanitizer's second gate exists for.
    Object.defineProperty(e, "diagnostic", { value: `SNEAKY ${SECRET}` });
    const reason = await runWithFailingRender(e);
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:BROWSER_LAUNCH_FAILED");
    expect(reason).not.toContain("SNEAKY");
    expect(reason).not.toContain(SECRET);
  });

  it("an unclassified renderer error stays unclassified, and says nothing more", async () => {
    const reason = await runWithFailingRender(new Error(`boom ${SECRET_URL} ${SECRET}`));
    // Not a RenderedDocsError, so no detail is claimed at all — the label
    // stands alone rather than borrowing a reason it does not have.
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED");
    expect(reason).not.toMatch(/DOCS_RENDER_AFTER_REFUSAL_FAILED:/);
    expect(reason).not.toContain(SECRET);
  });

  it("a look-alike error cannot inject a reason into the owner's line", async () => {
    const reason = await runWithFailingRender({
      name: "RenderedDocsError",
      reason: "HOST_NOT_ALLOWED",
      message: SECRET,
    });
    expect(reason).not.toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED:HOST_NOT_ALLOWED");
    expect(reason).toContain("DOCS_RENDER_AFTER_REFUSAL_FAILED");
    expect(reason).not.toContain(SECRET);
  });

  it("no provider text of any kind reaches the terminal reason", async () => {
    const reason = await runWithFailingRender(new RenderedDocsError("TOO_LARGE", "isolated"));
    expect(reason).not.toContain(SECRET);
    expect(reason).not.toContain("api_key");
    expect(reason).not.toContain(HOST);
    // Whole-string shape: code-owned identifiers, the sanitizer's own
    // separators, and nothing else. Prose, a url or a header could not
    // satisfy this.
    expect(reason).toMatch(/^[A-Za-z0-9_:]+(; source-route observations: [A-Z0-9_:]+(, [A-Z0-9_:]+)*)?$/);
  });

  it("the render is attempted exactly once even though it fails", async () => {
    const p = await makeJob();
    await activateSourceRoute(p.projectId, {
      domain: HOST,
      pathPrefix: "/token",
      routeClass: "OFFICIAL_DOCS",
    });
    let renders = 0;
    __setRenderedDocsFetcher({
      name: "counting",
      version: "1",
      async render() {
        renders += 1;
        throw new RenderedDocsError("RENDER_FAILED", "isolated");
      },
    });
    const executor = createS4WorkExecutor(depsFor(p, refusingFetcher(403)));
    const outcome = await executor.execute(ITEM, jobCtx(p.jobId));
    expect(renders).toBe(1);
    // And it cost exactly its own one reservation — never a hidden extra.
    expect(outcome.spent?.sourceOpens).toBe(1);
  });

  it("a status that does not open the render path attempts none", async () => {
    const p = await makeJob();
    await activateSourceRoute(p.projectId, {
      domain: HOST,
      pathPrefix: "/token",
      routeClass: "OFFICIAL_DOCS",
    });
    let renders = 0;
    __setRenderedDocsFetcher({
      name: "counting",
      version: "1",
      async render() {
        renders += 1;
        throw new RenderedDocsError("RENDER_FAILED", "isolated");
      },
    });
    // 404 is an absent page; rendering does not invent one.
    const executor = createS4WorkExecutor(depsFor(p, refusingFetcher(404)));
    const outcome = await executor.execute(ITEM, jobCtx(p.jobId));
    expect(renders).toBe(0);
    expect(outcome.spent?.sourceOpens).toBe(0);
    expect(String((outcome as { reason?: unknown }).reason)).toContain("HTTP_ERROR:404");
  });
});
