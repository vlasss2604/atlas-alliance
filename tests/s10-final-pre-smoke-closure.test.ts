import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { evidence, projects, researchClaimSupport, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import { QueryProposerUnavailableError } from "../src/server/engine/providers/query-proposer";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import { SearchProviderUnavailableError } from "../src/server/engine/providers/search-gateway";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// S10 FINAL PRE-SMOKE CLOSURE (D-120) — HIGH-1 (dimensional budget
// exhaustion must surface as BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED, never
// SUCCEEDED/WORK_QUEUE_EXHAUSTED and never FAILED/SYSTEM_OR_PROVIDER_
// FAILURE) and MEDIUM-1 (count_tokens transient retry classification was
// ineffective against a RAW Anthropic SDK exception). Deterministic
// fixtures throughout — no live network, no live model.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-08-23T00:00:00Z");

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeJob(): Promise<{ jobId: string; projectId: string; projectName: string; projectSlug: string }> {
  const topicId = await activeTopicId();
  const slug = uniq("s10final");
  const name = "S10 Final Closure Test Project";
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId,
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return { jobId: job.id, projectId: project.id, projectName: name, projectSlug: slug };
}

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

function ctxFor(jobId: string, budgetOverrides: Partial<{ maxSearchQueries: number; maxSourceOpens: number; maxModelCostMicro: number }> = {}) {
  return {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: {
      maxSearchQueries: budgetOverrides.maxSearchQueries ?? 10,
      maxSourceOpens: budgetOverrides.maxSourceOpens ?? 10,
      maxModelCostMicro: budgetOverrides.maxModelCostMicro ?? 1_000_000,
    },
  };
}

const FIXTURE_COST_PROFILE: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
// = 8000*1 + 1536*5 = 15680 micro-USD per authorized attempt.
const PER_ATTEMPT_COST_MICRO =
  FIXTURE_COST_PROFILE.maxInputTokens * FIXTURE_COST_PROFILE.inputPriceMicroUsdPerToken +
  FIXTURE_COST_PROFILE.maxOutputTokens * FIXTURE_COST_PROFILE.outputPriceMicroUsdPerToken;

function doc(overrides: Partial<FetchedDocument> = {}): FetchedDocument {
  return {
    finalUrl: "https://example.com/doc",
    requestedUrl: "https://example.com/doc",
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "S10 Final Closure Test Project: the protocol fee accrues directly to the treasury contract",
    contentHash: "sha256:fixturehash",
    fetchedAt: NOW,
    byteLength: 200,
    ...overrides,
  };
}

function depsFor(p: { jobId: string; projectId: string; projectName: string; projectSlug: string }, overrides: Record<string, unknown> = {}) {
  return {
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
    queryProposerCostProfile: FIXTURE_COST_PROFILE,
    evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
    ...overrides,
  };
}

async function traceRowsFor(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return [...rows].sort((a, b) => a.sequence - b.sequence);
}

function fixedQueryProposer(queries: string[]): QueryProposer {
  return { name: "fixture", async proposeQueries() { return queries; } };
}

function fixedSearchGateway(urls: string[]): SearchGateway {
  return {
    name: "fixture",
    async search(query) {
      return urls.map((url) => ({ url, title: `result for ${query}`, snippet: "a search snippet, never evidence" }));
    },
  };
}

// ============================================================
// HIGH-1 tests A/B: retry-denied budget exhaustion -> BUDGET_LIMIT_REACHED
// via the FULL worker path (proves propagation, not just the throw).
// ============================================================
describe("S10 final pre-smoke closure — HIGH-1: dimensional budget exhaustion (E2E propagation)", () => {
  it("A. searchQueries=1 remaining, first Brave attempt transient failure, retry denied -> HTTP calls=1, job=BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED", async () => {
    const p = await makeJob();
    // CORE envelope's maxSearchQueries is 40 (budget_core) — leave exactly
    // 1 unit remaining so the retry's own reservation is denied.
    await ctx.db.update(researchJobs).set({ searchQueriesReserved: 39 }).where(eq(researchJobs.id, p.jobId));
    let calls = 0;
    const searchGateway: SearchGateway = {
      name: "fixture",
      async search() {
        calls++;
        throw new SearchProviderUnavailableError("transient blip", true);
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, { queryProposer: fixedQueryProposer(["q1"]), searchGateway }),
    );
    const result = await handleResearchJobTask(ctx.db, p.jobId, executor);
    expect(result.claimed).toBe(true);
    expect(calls).toBe(1);

    const jobRow = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobRow.state).toBe("BUDGET_LIMIT_REACHED");
    expect(jobRow.terminationReason).toBe("BUDGET_EXHAUSTED");
    expect(jobRow.errorCode).toBeNull();
    expect(jobRow.searchQueriesReserved).toBe(40);

    const s7 = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, p.jobId));
    expect(s7.length).toBe(0); // execution stopped before S7 — acceptable, never fabricated
  });

  it("B. modelCostMicro exactly one QP reservation remaining, first generation transient failure, retry denied -> generation calls=1, job=BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED", async () => {
    const p = await makeJob();
    // CORE envelope's maxModelCostMicro is 4_000_000 — leave exactly one
    // authorized attempt's worth remaining.
    await ctx.db
      .update(researchJobs)
      .set({ modelCostMicroReserved: 4_000_000 - PER_ATTEMPT_COST_MICRO })
      .where(eq(researchJobs.id, p.jobId));
    let calls = 0;
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        calls++;
        throw new QueryProposerUnavailableError("transient blip", true);
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }),
    );
    const result = await handleResearchJobTask(ctx.db, p.jobId, executor);
    expect(result.claimed).toBe(true);
    expect(calls).toBe(1);

    const jobRow = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobRow.state).toBe("BUDGET_LIMIT_REACHED");
    expect(jobRow.terminationReason).toBe("BUDGET_EXHAUSTED");
    expect(jobRow.errorCode).toBeNull();
    expect(jobRow.modelCostMicroReserved).toBe(4_000_000);
  });

  it("J. terminal replay after a budget stop: no duplicate work/trace/Evidence", async () => {
    const p = await makeJob();
    await ctx.db.update(researchJobs).set({ searchQueriesReserved: 39 }).where(eq(researchJobs.id, p.jobId));
    const searchGateway: SearchGateway = {
      name: "fixture",
      async search() {
        throw new SearchProviderUnavailableError("transient blip", true);
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, { queryProposer: fixedQueryProposer(["q1"]), searchGateway }),
    );
    const first = await handleResearchJobTask(ctx.db, p.jobId, executor);
    expect(first.claimed).toBe(true);
    const traceAfterFirst = await traceRowsFor(p.jobId);
    const jobAfterFirst = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobAfterFirst.state).toBe("BUDGET_LIMIT_REACHED");

    // Replay: the job is no longer QUEUED — claimResearchJob (D-116) must
    // refuse to re-claim it, exactly like any other terminal state.
    const second = await handleResearchJobTask(ctx.db, p.jobId, executor);
    expect(second).toEqual({ claimed: false, reason: "NOT_QUEUED" });

    const traceAfterSecond = await traceRowsFor(p.jobId);
    expect(traceAfterSecond.length).toBe(traceAfterFirst.length); // no new trace rows
    const jobAfterSecond = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobAfterSecond.searchQueriesReserved).toBe(jobAfterFirst.searchQueriesReserved); // no re-reservation
    const evidenceRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    expect(evidenceRows.length).toBe(0);
  });
});

// ============================================================
// HIGH-1 tests C/D/E: the remaining required scenarios, at the executor
// (unit) level — same throw mechanism A/B already proved end-to-end.
// ============================================================
describe("S10 final pre-smoke closure — HIGH-1: dimensional budget exhaustion (unit-level scope)", () => {
  it("C. ordinary searchQueries budget already fully exhausted mid-job -> BudgetExhaustedError('searchQueries')", async () => {
    const p = await makeJob();
    await ctx.db.update(researchJobs).set({ searchQueriesReserved: 5 }).where(eq(researchJobs.id, p.jobId));
    let calls = 0;
    const searchGateway: SearchGateway = {
      name: "fixture",
      async search() {
        calls++;
        return [];
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, { queryProposer: fixedQueryProposer(["q1"]), searchGateway }),
    );
    await expect(executor.execute(ITEM, ctxFor(p.jobId, { maxSearchQueries: 5 }))).rejects.toMatchObject({
      name: "BudgetExhaustedError",
      axis: "searchQueries",
    });
    expect(calls).toBe(0); // the FIRST reservation was already refused
  });

  it("D. modelCostMicro too small for the first QueryProposer call -> 0 generation calls, BudgetExhaustedError('modelCostMicro')", async () => {
    const p = await makeJob();
    let called = false;
    const executor = createS4WorkExecutor(
      depsFor(p, {
        queryProposer: { name: "fixture", async proposeQueries() { called = true; return ["q1"]; } },
        searchGateway: fixedSearchGateway([]),
      }),
    );
    await expect(executor.execute(ITEM, ctxFor(p.jobId, { maxModelCostMicro: 1 }))).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(called).toBe(false);
  });

  it("E. sourceOpens exhausted -> BudgetExhaustedError('sourceOpens')", async () => {
    const p = await makeJob();
    const url = "https://example.com/source-open-exhausted";
    await ctx.db.update(researchJobs).set({ sourceOpensReserved: 3 }).where(eq(researchJobs.id, p.jobId));
    let fetches = 0;
    const executor = createS4WorkExecutor(
      depsFor(p, {
        queryProposer: fixedQueryProposer(["q1"]),
        searchGateway: fixedSearchGateway([url]),
        contentFetcher: { name: "fixture", async fetch(u: string) { fetches += 1; return doc({ finalUrl: u }); } },
      }),
    );
    await expect(executor.execute(ITEM, ctxFor(p.jobId, { maxSourceOpens: 3 }))).rejects.toMatchObject({
      name: "BudgetExhaustedError",
      axis: "sourceOpens",
    });
    expect(fetches).toBe(0);
  });

  it("F. regression — both authorized attempts fail transiently (no budget denial) still -> CapabilityFatalError, not BudgetExhaustedError", async () => {
    const p = await makeJob();
    let calls = 0;
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        calls++;
        throw new QueryProposerUnavailableError("simulated outage", true);
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }),
    );
    await expect(executor.execute(ITEM, ctxFor(p.jobId))).rejects.toBeInstanceOf(CapabilityFatalError);
    expect(calls).toBe(2);
  });
});

// ============================================================
// MEDIUM-1 tests G/H/I: count_tokens transient classification against a
// RAW Anthropic SDK exception (the actual bug — isTransientError only
// recognized an already-wrapped `.transient` field, never a raw one).
// ============================================================
describe("S10 final pre-smoke closure — MEDIUM-1: count_tokens retries a RAW Anthropic APIError correctly", () => {
  it("G. 503 then 200 -> exactly 2 count_tokens calls, resolves (generation may proceed)", async () => {
    const { countThenGate } = await import("../src/server/engine/providers/token-gate");
    const countTokens = vi
      .fn()
      .mockRejectedValueOnce(new Anthropic.APIError(503, undefined, "server error", undefined, undefined))
      .mockResolvedValueOnce({ input_tokens: 10 });
    const createMock = vi.fn();
    const fakeClient = { messages: { countTokens, create: createMock } } as unknown as Anthropic;
    await expect(
      countThenGate(fakeClient, "claude-haiku-4-5", "sys", [{ role: "user", content: "hi" }], undefined, 4000),
    ).resolves.toBeUndefined();
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled(); // countThenGate itself never calls generation
  });

  it("H. 503 then 503 -> exactly 2 count_tokens calls, TokenCountUnavailableError(transient=true), generation calls=0", async () => {
    const { countThenGate, TokenCountUnavailableError } = await import("../src/server/engine/providers/token-gate");
    const countTokens = vi
      .fn()
      .mockRejectedValue(new Anthropic.APIError(503, undefined, "server error", undefined, undefined));
    const createMock = vi.fn();
    const fakeClient = { messages: { countTokens, create: createMock } } as unknown as Anthropic;
    const rejection = countThenGate(fakeClient, "claude-haiku-4-5", "sys", [{ role: "user", content: "hi" }], undefined, 4000);
    await expect(rejection).rejects.toBeInstanceOf(TokenCountUnavailableError);
    await rejection.catch((e: InstanceType<typeof TokenCountUnavailableError>) => {
      expect(e.transient).toBe(true);
    });
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("I. 400 permanent -> exactly 1 count_tokens call, no retry, TokenCountUnavailableError(transient=false)", async () => {
    const { countThenGate, TokenCountUnavailableError } = await import("../src/server/engine/providers/token-gate");
    const countTokens = vi
      .fn()
      .mockRejectedValue(new Anthropic.APIError(400, undefined, "bad request", undefined, undefined));
    const fakeClient = { messages: { countTokens, create: vi.fn() } } as unknown as Anthropic;
    const rejection = countThenGate(fakeClient, "claude-haiku-4-5", "sys", [{ role: "user", content: "hi" }], undefined, 4000);
    await expect(rejection).rejects.toBeInstanceOf(TokenCountUnavailableError);
    await rejection.catch((e: InstanceType<typeof TokenCountUnavailableError>) => {
      expect(e.transient).toBe(false);
    });
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  it("a network/unknown-status error (no APIError) is also treated as transient — exactly 2 count_tokens calls", async () => {
    const { countThenGate } = await import("../src/server/engine/providers/token-gate");
    const countTokens = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ input_tokens: 10 });
    const fakeClient = { messages: { countTokens, create: vi.fn() } } as unknown as Anthropic;
    await expect(
      countThenGate(fakeClient, "claude-haiku-4-5", "sys", [{ role: "user", content: "hi" }], undefined, 4000),
    ).resolves.toBeUndefined();
    expect(countTokens).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// §8 residual: MODEL_CALL attempt cardinality — one real HTTP attempt =
// one MODEL_CALL_ATTEMPTED row, even across a successful retry.
// ============================================================
describe("S10 final pre-smoke closure — §8: MODEL_CALL_ATTEMPTED cardinality across a successful retry", () => {
  it("K. 2 real QueryProposer generation attempts (fail then succeed) -> exactly 2 MODEL_CALL_ATTEMPTED rows, one FAILED one OK", async () => {
    const p = await makeJob();
    let calls = 0;
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        calls++;
        if (calls === 1) throw new QueryProposerUnavailableError("transient blip", true);
        return ["q1"];
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }),
    );
    await executor.execute(ITEM, ctxFor(p.jobId));
    expect(calls).toBe(2);

    const trace = await traceRowsFor(p.jobId);
    const modelCallRows = trace.filter((t) => t.operationType === "MODEL_CALL_ATTEMPTED");
    expect(modelCallRows.length).toBe(2);
    expect(modelCallRows[0].status).toBe("FAILED");
    expect(modelCallRows[0].budgetAmount).toBe(PER_ATTEMPT_COST_MICRO);
    expect(modelCallRows[1].status).toBe("OK");
    expect(modelCallRows[1].budgetAmount).toBe(PER_ATTEMPT_COST_MICRO);

    const jobRow = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobRow.modelCostMicroReserved).toBe(2 * PER_ATTEMPT_COST_MICRO); // reservation ceiling unaffected by the tracing split
  });
});
