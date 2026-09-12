import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { projects, users } from "../src/server/db/schema";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import { RenderedDocsError } from "../src/server/engine/providers/rendered-docs-fetcher";
import {
  isTransientAnthropicApiError,
  NETWORK_NO_RESPONSE_RETRY_DELAY_MS,
  retryOnceIfTransient,
} from "../src/server/engine/providers/retry";
import {
  classifyTokenCountFailure,
  countThenGate,
  countTokensRetryDelayMs,
  isTokenCountDiagnostic,
  ModelInputOversizedError,
  TOKEN_COUNT_DIAGNOSTICS,
  TokenCountUnavailableError,
} from "../src/server/engine/providers/token-gate";
import type { FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor, safeFailureReason } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// CLOSED OBSERVABILITY FOR count_tokens FAILURES — entirely offline; no
// Anthropic call is made anywhere in this file (every client is a stub).
//
// A live window died with "capability unavailable:
// EVIDENCE_EXTRACTOR_COUNT_TOKENS" and nothing persisted could distinguish
// a bad credential from an unrecognised model id from a rate limit from an
// outage from a network path that never answered. This suite pins the
// closed diagnostic that now crosses the boundary, and — just as hard —
// what still cannot cross it: raw provider messages, keys, bodies, stacks.

// A secret that must NEVER appear in any operator-facing string.
const SECRET = "sk-ant-SECRET_DO_NOT_LEAK";

function apiError(status: number) {
  // The 5-arg construction the existing S10 suites already use — the raw
  // message deliberately carries the secret so leak assertions are real.
  return new Anthropic.APIError(status, { detail: SECRET }, `boom ${SECRET}`, undefined, undefined);
}

describe("classification: SDK signal -> closed diagnostic (items 1-8)", () => {
  it("1-6. each status maps to its closed class, with the trusted integer kept", () => {
    for (const [status, expected] of [
      [401, "AUTHENTICATION_FAILED"],
      [403, "PERMISSION_DENIED"],
      [404, "NOT_FOUND"],
      [400, "INVALID_REQUEST"],
      [422, "INVALID_REQUEST"],
      [429, "RATE_LIMITED"],
      [500, "PROVIDER_SERVER_ERROR"],
      [503, "PROVIDER_SERVER_ERROR"],
    ] as const) {
      expect(classifyTokenCountFailure(apiError(status)), String(status)).toEqual({
        diagnostic: expected,
        httpStatus: status,
      });
    }
  });

  it("7. the SDK's own no-response class maps to NETWORK_NO_RESPONSE, with no status", () => {
    const e = new Anthropic.APIConnectionError({ message: `no response ${SECRET}` });
    expect(classifyTokenCountFailure(e)).toEqual({
      diagnostic: "NETWORK_NO_RESPONSE",
      httpStatus: null,
    });
  });

  it("8. an unknown error maps to UNCLASSIFIED, never to a guessed class", () => {
    expect(classifyTokenCountFailure(new Error(`weird ${SECRET}`))).toEqual({
      diagnostic: "UNCLASSIFIED_PROVIDER_ERROR",
      httpStatus: null,
    });
    // An APIError with an out-of-vocabulary status keeps the integer but
    // claims no class it cannot stand behind.
    expect(classifyTokenCountFailure(apiError(418))).toEqual({
      diagnostic: "UNCLASSIFIED_PROVIDER_ERROR",
      httpStatus: 418,
    });
  });

  it("the vocabulary itself is closed and membership-checked", () => {
    for (const d of TOKEN_COUNT_DIAGNOSTICS) expect(isTokenCountDiagnostic(d)).toBe(true);
    for (const bad of ["", "boom", "text/anything", SECRET, "AUTHENTICATION_FAILED "]) {
      expect(isTokenCountDiagnostic(bad), bad).toBe(false);
    }
  });
});

// A stub client whose countTokens rejects with the given error each call.
function clientRejecting(e: unknown, calls: { n: number }): Anthropic {
  return {
    messages: {
      countTokens: vi.fn(async () => {
        calls.n += 1;
        throw e;
      }),
      create: vi.fn(),
    },
  } as unknown as Anthropic;
}

// NETWORK TRANSIENT RESILIENCE V1: a no-response first attempt now waits
// NETWORK_NO_RESPONSE_RETRY_DELAY_MS before its one retry, so the gate
// runs under fake timers here — every pending wait is advanced
// deterministically, never slept for real. Restored in `finally` so the
// DB-backed suites below always run on real timers.
async function gateFailure(e: unknown): Promise<{ err: TokenCountUnavailableError; calls: number }> {
  const calls = { n: 0 };
  vi.useFakeTimers();
  try {
    const settled = countThenGate(clientRejecting(e, calls), "m", "sys", [{ role: "user", content: "hi" }], undefined, 4000).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    await vi.runAllTimersAsync();
    const thrown = await settled;
    if (thrown === null) throw new Error("countThenGate unexpectedly resolved");
    expect(thrown).toBeInstanceOf(TokenCountUnavailableError);
    return { err: thrown as TokenCountUnavailableError, calls: calls.n };
  } finally {
    vi.useRealTimers();
  }
}

describe("countThenGate carries the diagnostic; retry semantics unchanged (items 14-16)", () => {
  it("401 -> AUTHENTICATION_FAILED, exactly ONE attempt (15. non-retryable stays non-retryable)", async () => {
    const { err, calls } = await gateFailure(apiError(401));
    expect(calls).toBe(1);
    expect(err.diagnostic).toBe("AUTHENTICATION_FAILED");
    expect(err.httpStatus).toBe(401);
    expect(err.transient).toBe(false);
    expect(err.message).toBe("count_tokens failed: AUTHENTICATION_FAILED:401");
  });

  it("404 -> NOT_FOUND, one attempt, not transient", async () => {
    const { err, calls } = await gateFailure(apiError(404));
    expect(calls).toBe(1);
    expect(err.diagnostic).toBe("NOT_FOUND");
    expect(err.transient).toBe(false);
  });

  it("429 -> RATE_LIMITED, exactly TWO attempts (14. retry count unchanged)", async () => {
    const { err, calls } = await gateFailure(apiError(429));
    expect(calls).toBe(2);
    expect(err.diagnostic).toBe("RATE_LIMITED");
    expect(err.httpStatus).toBe(429);
    expect(err.transient).toBe(true);
  });

  it("503 -> PROVIDER_SERVER_ERROR, two attempts; connection error -> NETWORK_NO_RESPONSE, two attempts", async () => {
    const a = await gateFailure(apiError(503));
    expect(a.calls).toBe(2);
    expect(a.err.diagnostic).toBe("PROVIDER_SERVER_ERROR");

    const b = await gateFailure(new Anthropic.APIConnectionError({ message: SECRET }));
    expect(b.calls).toBe(2);
    expect(b.err.diagnostic).toBe("NETWORK_NO_RESPONSE");
    expect(b.err.httpStatus).toBeNull();
  });

  it("the shared retry loop itself is untouched: max 2 attempts, transience rule identical", async () => {
    let n = 0;
    await expect(
      retryOnceIfTransient(async () => {
        n += 1;
        throw apiError(500);
      }, isTransientAnthropicApiError),
    ).rejects.toBeInstanceOf(Anthropic.APIError);
    expect(n).toBe(2);
    expect(isTransientAnthropicApiError(apiError(401))).toBe(false);
    expect(isTransientAnthropicApiError(apiError(429))).toBe(true);
  });

  it("16. successful counting is unchanged: under the ceiling resolves, over it is still the oversized SKIP", async () => {
    const ok = { messages: { countTokens: vi.fn(async () => ({ input_tokens: 100 })), create: vi.fn() } } as unknown as Anthropic;
    await expect(countThenGate(ok, "m", "sys", [{ role: "user", content: "hi" }], undefined, 4000)).resolves.toBeUndefined();

    const over = { messages: { countTokens: vi.fn(async () => ({ input_tokens: 9000 })), create: vi.fn() } } as unknown as Anthropic;
    await expect(countThenGate(over, "m", "sys", [{ role: "user", content: "hi" }], undefined, 4000)).rejects.toBeInstanceOf(
      ModelInputOversizedError,
    );
  });
});

// NETWORK TRANSIENT RESILIENCE V1 — the bounded wait before the ONE
// count_tokens retry. Fake timers throughout: the ~15 s is advanced, never
// slept. Each case restores real timers in `finally`.
describe("NETWORK_NO_RESPONSE: one bounded wait, then the same single retry — never a third call", () => {
  function stubClient(countTokens: ReturnType<typeof vi.fn>): Anthropic {
    return { messages: { countTokens, create: vi.fn() } } as unknown as Anthropic;
  }
  const gate = (client: Anthropic) => countThenGate(client, "m", "sys", [{ role: "user", content: "hi" }], undefined, 4000);
  const noResponse = () => new Anthropic.APIConnectionError({ message: `no response ${SECRET}` });

  it("the delay policy: exactly the no-response class waits; every other class, transient or not, waits 0", () => {
    expect(NETWORK_NO_RESPONSE_RETRY_DELAY_MS).toBe(15_000);
    expect(countTokensRetryDelayMs(noResponse())).toBe(NETWORK_NO_RESPONSE_RETRY_DELAY_MS);
    // An APIError with no status is the same "never heard from" class.
    expect(countTokensRetryDelayMs(new Anthropic.APIError(undefined, undefined, "x", undefined, undefined))).toBe(
      NETWORK_NO_RESPONSE_RETRY_DELAY_MS,
    );
    for (const status of [401, 403, 404, 400, 422, 429, 500, 503, 418]) {
      expect(countTokensRetryDelayMs(apiError(status)), String(status)).toBe(0);
    }
    expect(countTokensRetryDelayMs(new Error("ECONNRESET"))).toBe(0);
  });

  it("A. a healthy request: one call, no timer is ever scheduled, resolves at once", async () => {
    vi.useFakeTimers();
    try {
      const countTokens = vi.fn(async () => ({ input_tokens: 100 }));
      await expect(gate(stubClient(countTokens))).resolves.toBeUndefined();
      expect(countTokens).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B. no-response then success: the retry is not made before the wait elapses, is made exactly once after it, and the gate resolves", async () => {
    vi.useFakeTimers();
    try {
      const countTokens = vi.fn().mockRejectedValueOnce(noResponse()).mockResolvedValueOnce({ input_tokens: 100 });
      let settled = false;
      const p = gate(stubClient(countTokens)).then(() => {
        settled = true;
      });
      // The first attempt has failed and the wait is pending: one timer,
      // one call so far, nothing resolved.
      await vi.advanceTimersByTimeAsync(0);
      expect(countTokens).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      // One millisecond short of the bound: still no retry.
      await vi.advanceTimersByTimeAsync(NETWORK_NO_RESPONSE_RETRY_DELAY_MS - 1);
      expect(countTokens).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      // At the bound: exactly one retry, and it carries the result.
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toBe(true);
      expect(countTokens).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("C. no-response twice: one wait, the one retry, then TokenCountUnavailableError(transient, NETWORK_NO_RESPONSE) — no second wait, no third call", async () => {
    vi.useFakeTimers();
    try {
      const countTokens = vi.fn().mockRejectedValue(noResponse());
      const settled = gate(stubClient(countTokens)).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(NETWORK_NO_RESPONSE_RETRY_DELAY_MS);
      const err = await settled;
      expect(err).toBeInstanceOf(TokenCountUnavailableError);
      expect((err as TokenCountUnavailableError).transient).toBe(true);
      expect((err as TokenCountUnavailableError).diagnostic).toBe("NETWORK_NO_RESPONSE");
      expect(countTokens).toHaveBeenCalledTimes(2);
      // Nothing left pending: a further advance changes nothing.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(NETWORK_NO_RESPONSE_RETRY_DELAY_MS * 10);
      expect(countTokens).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("other transient classes retry at once exactly as before (503, 429): no timer, two calls", async () => {
    vi.useFakeTimers();
    try {
      for (const status of [503, 429]) {
        const countTokens = vi.fn().mockRejectedValueOnce(apiError(status)).mockResolvedValueOnce({ input_tokens: 100 });
        await expect(gate(stubClient(countTokens))).resolves.toBeUndefined();
        expect(countTokens, String(status)).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a permanent failure neither waits nor retries: one call, rejects at once", async () => {
    vi.useFakeTimers();
    try {
      for (const status of [401, 400, 404]) {
        const countTokens = vi.fn().mockRejectedValue(apiError(status));
        await expect(gate(stubClient(countTokens))).rejects.toBeInstanceOf(TokenCountUnavailableError);
        expect(countTokens, String(status)).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("the shared loop: the delay hook is consulted only for a transient first failure, and a policy answering 0 retries at once", async () => {
    vi.useFakeTimers();
    try {
      const consulted: unknown[] = [];
      const policy = (e: unknown) => {
        consulted.push(e);
        return 0;
      };
      // Non-transient: rethrown before the hook is consulted.
      await expect(
        retryOnceIfTransient(async () => {
          throw apiError(401);
        }, isTransientAnthropicApiError, { delayBeforeRetryMs: policy }),
      ).rejects.toBeInstanceOf(Anthropic.APIError);
      expect(consulted).toHaveLength(0);
      // Success: never consulted.
      await expect(retryOnceIfTransient(async () => "ok", isTransientAnthropicApiError, { delayBeforeRetryMs: policy })).resolves.toBe("ok");
      expect(consulted).toHaveLength(0);
      // Transient, policy says 0: consulted once, retried at once, no timer.
      let n = 0;
      await expect(
        retryOnceIfTransient(async () => {
          n += 1;
          if (n === 1) throw apiError(503);
          return "ok";
        }, isTransientAnthropicApiError, { delayBeforeRetryMs: policy }),
      ).resolves.toBe("ok");
      expect(consulted).toHaveLength(1);
      expect(n).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the boundary: what may and may not cross (items 9-13, 17-18)", () => {
  it("13. safeFailureReason now carries the closed diagnostic for count_tokens failures", async () => {
    const { err } = await gateFailure(apiError(429));
    expect(safeFailureReason("EVIDENCE_EXTRACTOR", err)).toBe(
      "EVIDENCE_EXTRACTOR_FAILED:TokenCountUnavailableError:RATE_LIMITED:429",
    );
    const { err: net } = await gateFailure(new Anthropic.APIConnectionError({ message: SECRET }));
    expect(safeFailureReason("EVIDENCE_EXTRACTOR", net)).toBe(
      "EVIDENCE_EXTRACTOR_FAILED:TokenCountUnavailableError:NETWORK_NO_RESPONSE",
    );
  });

  it("9-12. neither the raw provider message, key, body nor stack ever crosses", async () => {
    for (const raw of [apiError(401), apiError(503), new Anthropic.APIConnectionError({ message: SECRET })]) {
      const { err } = await gateFailure(raw);
      const surfaces = [
        err.message,
        safeFailureReason("EVIDENCE_EXTRACTOR", err),
        new CapabilityFatalError("EVIDENCE_EXTRACTOR_COUNT_TOKENS", safeFailureReason("EVIDENCE_EXTRACTOR", err)).message,
      ];
      for (const s of surfaces) {
        expect(s).not.toContain(SECRET);
        expect(s).not.toContain("boom");
        expect(s).not.toContain("at "); // no stack fragment
      }
    }
  });

  it("MUTATION CHECK: a forged out-of-vocabulary diagnostic is refused at the boundary", () => {
    // If the membership gate in safeFailureDetail is ever removed, this
    // forged free-text value crosses into the operator surface and the
    // assertion below fails. The class alone must vouch for nothing.
    const forged = new TokenCountUnavailableError(
      "x",
      false,
      `INJECTED ${SECRET}; DROP TABLE evidence` as never,
      429,
    );
    const reason = safeFailureReason("EVIDENCE_EXTRACTOR", forged);
    expect(reason).toBe("EVIDENCE_EXTRACTOR_FAILED:TokenCountUnavailableError");
    expect(reason).not.toContain("INJECTED");
    expect(reason).not.toContain(SECRET);
  });

  it("17. documentary fetch failure semantics are unchanged", () => {
    const http = new ContentFetchError("HTTP_ERROR", `refused ${SECRET}`, "https://x.test/a", 404);
    expect(safeFailureReason("CONTENT_FETCHER", http)).toBe("CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:404");
    const mime = new ContentFetchError("UNSUPPORTED_CONTENT_TYPE", `bad ${SECRET}`, "https://x.test/a");
    expect(safeFailureReason("CONTENT_FETCHER", mime)).toBe(
      "CONTENT_FETCHER_FAILED:ContentFetchError:UNSUPPORTED_CONTENT_TYPE",
    );
    expect(safeFailureReason("CONTENT_FETCHER", mime)).not.toContain(SECRET);
  });

  it("18. renderer failure semantics are unchanged — class name only, no detail invented", () => {
    const render = new RenderedDocsError("NAVIGATION_FAILED", "isolated", null, null, "NAVIGATION_TIMEOUT");
    expect(safeFailureReason("RENDERED_DOCS", render)).toBe("RENDERED_DOCS_FAILED:RenderedDocsError");
  });
});

// ---- the full production boundary, through the real executor ----------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

const DOC_URL = "https://docs.example-project.test/doc";

function fixtureDoc(): FetchedDocument {
  return {
    finalUrl: DOC_URL,
    requestedUrl: DOC_URL,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "Fixture project: the protocol fee accrues directly to the treasury contract",
    contentHash: "sha256:fixturehash",
    fetchedAt: new Date(),
    byteLength: 200,
  };
}

describe("end to end: the terminal error an operator actually sees", () => {
  async function runWithExtractorThrowing(e: Error) {
    const slug = uniq("ctd");
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug, name: "Count Tokens Diagnostic Fixture", status: "ACTIVE_CORE" })
      .returning();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { topics } = await import("../src/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug, ticker: null },
      queryProposer: { name: "fixture", async proposeQueries() { return ["q1"]; } },
      searchGateway: {
        name: "fixture",
        async search() { return [{ url: DOC_URL, title: "t", snippet: "s" }]; },
      },
      contentFetcher: { name: "fixture", async fetch() { return fixtureDoc(); } },
      evidenceExtractor: { name: "fixture", async extract() { throw e; } },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
    });
    return executor.execute(ITEM, {
      jobId: job.id,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: 5, maxSourceOpens: 5, maxModelCostMicro: 1_000_000 },
    });
  }

  it("13. a permanent count_tokens failure: the capability stays EVIDENCE_EXTRACTOR_COUNT_TOKENS and the message says WHY", async () => {
    // NETWORK TRANSIENT RESILIENCE V1: the immediately-fatal path is now
    // the PERMANENT one (a transient failure on a single document is a
    // document-local EXTRACT_FAILED — see the case below and
    // tests/transient-extractor-resilience-v1.test.ts). 401 here.
    const { err } = await gateFailure(apiError(401));
    const rejection = runWithExtractorThrowing(err);
    await expect(rejection).rejects.toBeInstanceOf(CapabilityFatalError);
    await rejection.catch((thrown: CapabilityFatalError) => {
      expect(thrown.capability).toBe("EVIDENCE_EXTRACTOR_COUNT_TOKENS");
      expect(thrown.message).toBe(
        "capability unavailable: EVIDENCE_EXTRACTOR_COUNT_TOKENS — EVIDENCE_EXTRACTOR_FAILED:TokenCountUnavailableError:AUTHENTICATION_FAILED:401",
      );
      expect(thrown.message).not.toContain(SECRET);
    });
  }, 30_000);

  it("13b. a transient count_tokens failure on the run's only document is document-local: no throw, the classified WHY still persists, nothing leaks", async () => {
    const { err } = await gateFailure(apiError(429));
    const result = await runWithExtractorThrowing(err);
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(result.reason).toContain("EXTRACT_FAILED:RATE_LIMITED:429");
    expect(result.reason).not.toContain(SECRET);
  }, 30_000);

  it("a forged diagnostic never reaches the terminal message either", async () => {
    const forged = new TokenCountUnavailableError("x", false, `INJECTED ${SECRET}` as never, 401);
    const rejection = runWithExtractorThrowing(forged);
    await expect(rejection).rejects.toBeInstanceOf(CapabilityFatalError);
    await rejection.catch((thrown: CapabilityFatalError) => {
      expect(thrown.capability).toBe("EVIDENCE_EXTRACTOR_COUNT_TOKENS");
      expect(thrown.message).toBe(
        "capability unavailable: EVIDENCE_EXTRACTOR_COUNT_TOKENS — EVIDENCE_EXTRACTOR_FAILED:TokenCountUnavailableError",
      );
      expect(thrown.message).not.toContain("INJECTED");
      expect(thrown.message).not.toContain(SECRET);
    });
  }, 30_000);
});

describe("19. no project-specific knowledge entered the diagnostic path", () => {
  it("token-gate and capability-fatal-error name no project or host", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/providers/token-gate.ts",
      "../src/server/engine/capability-fatal-error.ts",
    ]) {
      const code = (await fs.readFile(new URL(file, import.meta.url), "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["raydium", "pump", "solscan", "docs.raydium"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
    }
  });
});
