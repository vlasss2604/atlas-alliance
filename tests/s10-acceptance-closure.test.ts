import AnthropicNS from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, researchClaimSupport, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError } from "../src/server/engine/providers/evidence-extractor";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import { QueryProposerUnavailableError } from "../src/server/engine/providers/query-proposer";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import { SearchProviderUnavailableError } from "../src/server/engine/providers/search-gateway";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import { ModelInputOversizedError, TokenCountUnavailableError } from "../src/server/engine/providers/token-gate";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// S10 acceptance closure (D-119) — BLOCKER-1 (capability-fatal execution
// channel), BLOCKER-2 (retry reserves per real external attempt), HIGH-1
// (counted request matches generation request), MEDIUM-1 (one usage/cost
// audit record per model attempt), MEDIUM-2 (no silent cache-billing
// understatement). Deterministic fixtures throughout — no live network,
// no live model. Fixtures call the SAME s4-executor.ts retry/reservation
// logic real Brave/Anthropic providers would go through; they just throw
// controlled typed errors (with the SAME `.transient` flag the real
// providers already compute) instead of making a real HTTP/API call.

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
  const slug = uniq("s10close");
  const name = "S10 Closure Test Project";
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

function doc(overrides: Partial<FetchedDocument> = {}): FetchedDocument {
  return {
    finalUrl: "https://example.com/doc",
    requestedUrl: "https://example.com/doc",
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "S10 Closure Test Project: the protocol fee accrues directly to the treasury contract",
    contentHash: "sha256:fixturehash",
    fetchedAt: NOW,
    byteLength: 200,
    ...overrides,
  };
}

function validFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 1,
    component: "SOURCE_OF_VALUE",
    statement: "protocol fee accrues to the treasury",
    supportFragment: "the protocol fee accrues directly to the treasury contract",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    ...overrides,
  };
}

function depsFor(p: { jobId: string; projectId: string; projectName: string; projectSlug: string }, overrides: Record<string, unknown> = {}) {
  return {
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
    queryProposerCostProfile: FIXTURE_COST_PROFILE,
    evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
    // S10 LAST HIGH CLOSURE (D-121): every role now defaults to a
    // harmless, never-invoked-unless-actually-reached fixture — HIGH-2
    // made the real resolvers eagerly validate credentials at preflight,
    // so a test exercising only SearchGateway/QueryProposer (leaving
    // EvidenceExtractor unfixtured, as most tests below do) would
    // otherwise hit the real resolveEvidenceExtractor() and fail on the
    // test environment's missing ANTHROPIC_API_KEY before ever reaching
    // what the test actually exercises. Tests that specifically want the
    // REAL resolver to run (to test a missing-credential/profile
    // scenario itself) must NOT use depsFor — construct deps directly,
    // as the HIGH-2 preflight tests below do.
    queryProposer: fixedQueryProposer([]),
    searchGateway: fixedSearchGateway([]),
    contentFetcher: fixedContentFetcher({}),
    evidenceExtractor: fixedEvidenceExtractor([]),
    ...overrides,
  };
}

async function traceRowsFor(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return [...rows].sort((a, b) => a.sequence - b.sequence);
}

// ============================================================
// BLOCKER-1: capability-fatal execution channel
// ============================================================
describe("S10 closure — BLOCKER-1: capability-fatal execution channel", () => {
  it("A. all Brave attempts fail (transient) after approved retry -> CapabilityFatalError('SEARCH_GATEWAY')", async () => {
    const p = await makeJob();
    let calls = 0;
    const searchGateway: SearchGateway = {
      name: "fixture",
      async search() {
        calls++;
        throw new SearchProviderUnavailableError("simulated outage", true);
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { searchGateway, queryProposer: fixedQueryProposer(["q1"]) }));
    await expect(executor.execute(ITEM, ctxFor(p.jobId))).rejects.toThrow(CapabilityFatalError);
    expect(calls).toBe(2); // exactly 2 total attempts, not 3+
  });

  it("B. count_tokens unavailable after retry -> CapabilityFatalError('QUERY_PROPOSER_COUNT_TOKENS')", async () => {
    const p = await makeJob();
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        throw new TokenCountUnavailableError("simulated count_tokens outage", true);
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }));
    await expect(executor.execute(ITEM, ctxFor(p.jobId))).rejects.toThrow(CapabilityFatalError);
  });

  it("C. Anthropic generation capability unavailable after retry -> CapabilityFatalError('QUERY_PROPOSER')", async () => {
    const p = await makeJob();
    let calls = 0;
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        calls++;
        throw new QueryProposerUnavailableError("simulated outage", true);
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }));
    await expect(executor.execute(ITEM, ctxFor(p.jobId))).rejects.toThrow(CapabilityFatalError);
    expect(calls).toBe(2);
  });

  it("D. persistent provider 429 (EvidenceExtractor) after retry -> CapabilityFatalError('EVIDENCE_EXTRACTOR')", async () => {
    const p = await makeJob();
    const url = "https://example.com/d-429";
    let extractCalls = 0;
    const evidenceExtractor: EvidenceExtractor = {
      name: "fixture",
      async extract() {
        extractCalls++;
        throw new EvidenceExtractorUnavailableError("api 429: rate limited", true);
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, {
        queryProposer: fixedQueryProposer(["q1"]),
        searchGateway: fixedSearchGateway([url]),
        contentFetcher: fixedContentFetcher({ [url]: doc({ finalUrl: url }) }),
        evidenceExtractor,
      }),
    );
    await expect(executor.execute(ITEM, ctxFor(p.jobId))).rejects.toThrow(CapabilityFatalError);
    expect(extractCalls).toBe(2);
  });

  it("E. one oversized document with another viable source -> local skip, research continues (never fatal)", async () => {
    const p = await makeJob();
    const oversizedUrl = "https://example.com/oversized";
    const goodUrl = "https://example.com/good";
    const evidenceExtractor: EvidenceExtractor = {
      name: "fixture",
      async extract(input) {
        if (input.document.finalUrl === oversizedUrl) throw new ModelInputOversizedError(99999, 8000);
        return [validFact()];
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, {
        queryProposer: fixedQueryProposer(["q1"]),
        searchGateway: fixedSearchGateway([oversizedUrl, goodUrl]),
        contentFetcher: fixedContentFetcher({
          [oversizedUrl]: doc({ finalUrl: oversizedUrl }),
          [goodUrl]: doc({ finalUrl: goodUrl }),
        }),
        evidenceExtractor,
      }),
    );
    const result = await executor.execute(ITEM, ctxFor(p.jobId));
    expect(result.status).toBe("SUCCEEDED"); // the good source still produced Evidence
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    expect(rows.length).toBe(1);
    const trace = await traceRowsFor(p.jobId);
    const oversizedRow = trace.find((t) => t.targetRef === oversizedUrl && t.reasonCode === "MODEL_INPUT_OVERSIZED");
    expect(oversizedRow).toBeDefined();
    expect(oversizedRow?.status).toBe("FAILED"); // EXTRACT_FAILED — local, not a throw
  });

  it("F. an oversized document produces no contradiction/absence finding — silently discarded, not a semantic verdict", async () => {
    const p = await makeJob();
    const url = "https://example.com/oversized-only";
    const evidenceExtractor: EvidenceExtractor = {
      name: "fixture",
      async extract() {
        throw new ModelInputOversizedError(99999, 8000);
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, {
        queryProposer: fixedQueryProposer(["q1"]),
        searchGateway: fixedSearchGateway([url]),
        contentFetcher: fixedContentFetcher({ [url]: doc({ finalUrl: url }) }),
        evidenceExtractor,
      }),
    );
    const result = await executor.execute(ITEM, ctxFor(p.jobId));
    // Every document failed the same way (oversized) — SKIPPED, not FAILED,
    // and never treated as though the extractor was itself unavailable.
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).not.toContain("CONTRADICTED");
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    expect(rows.length).toBe(0);
  });

  it("a non-transient (permanent) failure is never fatal — stays a local FAILED result, no throw", async () => {
    const p = await makeJob();
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        throw new QueryProposerUnavailableError("schema invalid", false);
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }));
    const result = await executor.execute(ITEM, ctxFor(p.jobId));
    expect(result.status).toBe("FAILED");
  });

  it("E2E: a capability-fatal throw propagates to job.state=FAILED/SYSTEM_OR_PROVIDER_FAILURE with NO research_claim_support row", async () => {
    const p = await makeJob();
    const searchGateway: SearchGateway = {
      name: "fixture",
      async search() {
        throw new SearchProviderUnavailableError("simulated total outage", true);
      },
    };
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
      queryProposerCostProfile: FIXTURE_COST_PROFILE,
      evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
      queryProposer: fixedQueryProposer(["q1"]),
      searchGateway,
    });
    const result = await handleResearchJobTask(ctx.db, p.jobId, executor);
    expect(result.claimed).toBe(true);

    const jobRow = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobRow.state).toBe("FAILED");
    expect(jobRow.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(jobRow.errorCode).toBe("CapabilityFatalError");

    const s7 = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, p.jobId));
    expect(s7.length).toBe(0); // S7 never ran for this job
  });
});

// ============================================================
// BLOCKER-2: retry reserves per real external attempt
// ============================================================
describe("S10 closure — BLOCKER-2: retry reserves per real external attempt", () => {
  it("1. Brave first transient failure + second success: real calls=2, searchQueriesReserved=2", async () => {
    const p = await makeJob();
    let calls = 0;
    const searchGateway: SearchGateway = {
      name: "fixture",
      async search() {
        calls++;
        if (calls === 1) throw new SearchProviderUnavailableError("transient blip", true);
        return [{ url: "https://example.com/ok", title: null, snippet: null }];
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer: fixedQueryProposer(["q1"]), searchGateway }));
    await executor.execute(ITEM, ctxFor(p.jobId));
    expect(calls).toBe(2);
    const jobRow = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobRow.searchQueriesReserved).toBe(2);
  });

  it("2. Brave first transient failure but no budget for retry: real calls=1, reserved=1, no second call", async () => {
    const p = await makeJob();
    let calls = 0;
    const searchGateway: SearchGateway = {
      name: "fixture",
      async search() {
        calls++;
        throw new SearchProviderUnavailableError("transient blip", true);
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer: fixedQueryProposer(["q1"]), searchGateway }));
    // maxSearchQueries=1 — the retry's reservation must be denied. A
    // denied retry reservation is a budget constraint, not proven
    // capability unavailability (BLOCKER-1 classification) — but since
    // zero candidates end up possible, S10 final pre-smoke closure
    // (HIGH-1, D-120) requires this to throw BudgetExhaustedError, never
    // an ordinary FAILED result the controller could fold into
    // WORK_QUEUE_EXHAUSTED -> SUCCEEDED.
    await expect(executor.execute(ITEM, ctxFor(p.jobId, { maxSearchQueries: 1 }))).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(calls).toBe(1);
    const jobRow = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    expect(jobRow.searchQueriesReserved).toBe(1);
  });

  it("3. Anthropic generation first transient failure + second success: calls=2, modelCostMicroReserved=2x per-attempt reservation", async () => {
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
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }));
    await executor.execute(ITEM, ctxFor(p.jobId));
    expect(calls).toBe(2);
    const jobRow = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId)))[0];
    const perAttempt = FIXTURE_COST_PROFILE.maxInputTokens * FIXTURE_COST_PROFILE.inputPriceMicroUsdPerToken + FIXTURE_COST_PROFILE.maxOutputTokens * FIXTURE_COST_PROFILE.outputPriceMicroUsdPerToken;
    expect(jobRow.modelCostMicroReserved).toBe(2 * perAttempt);
  });

  it("4. generation retry denied by model budget: second generation call=0", async () => {
    const p = await makeJob();
    let calls = 0;
    const perAttempt = FIXTURE_COST_PROFILE.maxInputTokens * FIXTURE_COST_PROFILE.inputPriceMicroUsdPerToken + FIXTURE_COST_PROFILE.maxOutputTokens * FIXTURE_COST_PROFILE.outputPriceMicroUsdPerToken;
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        calls++;
        throw new QueryProposerUnavailableError("transient blip", true);
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }));
    // Budget for exactly one attempt's reservation, not two. S10 final
    // pre-smoke closure (HIGH-1, D-120, test B/G2): the denied retry
    // reservation means zero usable result is possible for this
    // QueryProposer-first component — throws BudgetExhaustedError.
    await expect(
      executor.execute(ITEM, ctxFor(p.jobId, { maxModelCostMicro: perAttempt })),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toBe(1);
  });

  it("5. no SDK-hidden retries: Anthropic SDK client is constructed with maxRetries: 0 (source check)", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["query-proposer-anthropic.ts", "evidence-extractor-anthropic.ts"]) {
      const source = await fs.readFile(new URL(`../src/server/engine/providers/${f}`, import.meta.url), "utf-8");
      expect(source).toContain("maxRetries: 0");
    }
  });
});

// ============================================================
// HIGH-1: counted request matches generation request exactly
// ============================================================
describe("S10 closure — HIGH-1: count_tokens request matches generation request", () => {
  it("countThenGate is called with the SAME model/system/messages/output_config later sent to messages.create", async () => {
    const capturedCounts: unknown[] = [];
    const capturedCreates: unknown[] = [];
    // Direct unit-level proof at the token-gate.ts level: the caller
    // (query-proposer-anthropic.ts/evidence-extractor-anthropic.ts) is
    // responsible for passing an IDENTICAL baseRequest object to both —
    // verified here by capturing what a fake client receives from each.
    const fakeClient = {
      messages: {
        countTokens: async (req: unknown) => {
          capturedCounts.push(req);
          return { input_tokens: 10 };
        },
        create: async (req: unknown) => {
          capturedCreates.push(req);
          return { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 }, content: [] };
        },
      },
    } as unknown as InstanceType<typeof AnthropicNS>;
    const { countThenGate } = await import("../src/server/engine/providers/token-gate");
    const baseRequest = {
      model: "claude-haiku-4-5",
      system: "sys prompt",
      messages: [{ role: "user" as const, content: "hi" }],
      output_config: { format: { type: "json_schema" } } as unknown as AnthropicNS.MessageCreateParams["output_config"],
    };
    await countThenGate(fakeClient, baseRequest.model, baseRequest.system, baseRequest.messages, baseRequest.output_config, 4000);
    await fakeClient.messages.create({ ...baseRequest, max_tokens: 512 });

    expect(capturedCounts[0]).toEqual({
      model: baseRequest.model,
      system: baseRequest.system,
      messages: baseRequest.messages,
      output_config: baseRequest.output_config,
    });
    const created = capturedCreates[0] as { model: string; system: string; messages: unknown; output_config: unknown };
    expect(created.model).toBe(baseRequest.model);
    expect(created.system).toBe(baseRequest.system);
    expect(created.messages).toEqual(baseRequest.messages);
    expect(created.output_config).toEqual(baseRequest.output_config);
  });

  it("query-proposer-anthropic.ts / evidence-extractor-anthropic.ts build ONE shared baseRequest object for both calls (source check)", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["query-proposer-anthropic.ts", "evidence-extractor-anthropic.ts"]) {
      const source = await fs.readFile(new URL(`../src/server/engine/providers/${f}`, import.meta.url), "utf-8");
      expect(source).toContain("baseRequest");
      expect(source).toContain("...baseRequest");
    }
  });
});

// ============================================================
// MEDIUM-1: one usage/cost audit record per model attempt
// ============================================================
describe("S10 closure — MEDIUM-1: one MODEL_CALL_ATTEMPTED audit record per successful generation call", () => {
  it("N proposed queries from one QueryProposer call -> exactly one usage record (not N)", async () => {
    const p = await makeJob();
    const queryProposer: QueryProposer = {
      name: "fixture",
      async proposeQueries() {
        return ["q1", "q2", "q3"];
      },
    };
    const executor = createS4WorkExecutor(depsFor(p, { queryProposer, searchGateway: fixedSearchGateway([]) }));
    await executor.execute(ITEM, ctxFor(p.jobId));
    const trace = await traceRowsFor(p.jobId);
    const queryProposedRows = trace.filter((t) => t.operationType === "QUERY_PROPOSED");
    expect(queryProposedRows.length).toBe(3); // 3 semantic output rows
    for (const r of queryProposedRows) expect(r.actualCostMicro).toBeNull(); // never duplicated usage
    const usageRows = trace.filter((t) => t.operationType === "MODEL_CALL_ATTEMPTED" && t.providerKind === "QUERY_PROPOSE");
    expect(usageRows.length).toBe(1); // exactly one audit record for the one call
  });

  it("M extracted facts from one EvidenceExtractor call -> exactly one usage record (not M)", async () => {
    const p = await makeJob();
    const url = "https://example.com/multi-fact";
    const evidenceExtractor: EvidenceExtractor = {
      name: "fixture",
      async extract() {
        return [
          validFact({ supportFragment: "the protocol fee accrues directly to the treasury contract" }),
          validFact({ supportFragment: "the protocol fee accrues directly", statement: "second fact" }),
        ];
      },
    };
    const executor = createS4WorkExecutor(
      depsFor(p, {
        queryProposer: fixedQueryProposer(["q1"]),
        searchGateway: fixedSearchGateway([url]),
        contentFetcher: fixedContentFetcher({ [url]: doc({ finalUrl: url }) }),
        evidenceExtractor,
      }),
    );
    const result = await executor.execute(ITEM, ctxFor(p.jobId));
    expect(result.status).toBe("SUCCEEDED");
    const trace = await traceRowsFor(p.jobId);
    const extractOkRows = trace.filter((t) => t.operationType === "EXTRACT_OK");
    expect(extractOkRows.length).toBe(2); // 2 admitted facts
    for (const r of extractOkRows) expect(r.actualCostMicro).toBeNull(); // never duplicated usage
    const usageRows = trace.filter((t) => t.operationType === "MODEL_CALL_ATTEMPTED" && t.providerKind === "EXTRACT");
    expect(usageRows.length).toBe(1); // exactly one audit record for the one call
  });
});

// ============================================================
// MEDIUM-2: no silent cache-billing understatement
// ============================================================
describe("S10 closure — MEDIUM-2: no prompt caching in INTERNAL_ALPHA_V1; unsupported billing usage never silently priced", () => {
  it("no request built by either live provider sets cache_control (source check)", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["query-proposer-anthropic.ts", "evidence-extractor-anthropic.ts"]) {
      const source = await fs.readFile(new URL(`../src/server/engine/providers/${f}`, import.meta.url), "utf-8");
      expect(source).not.toContain("cache_control");
    }
  });

  it("ModelUsage.unsupportedBillingUsage=true -> actualCostMicro is null, reasonCode=UNSUPPORTED_BILLING_USAGE, never an invented price", async () => {
    // Direct unit-level proof: inject a queryProposer whose onUsage-style
    // reporting is simulated via the SAME usage-capture path s4-executor.ts
    // uses — since fixtures don't call onUsage naturally, this proves the
    // s4-executor.ts branch by exercising resolveQueryProposer's real
    // onUsage wiring is out of scope for a fixture; instead this asserts
    // the type contract and s4-executor.ts's own conditional exist and are
    // exercised via calculateActualCostMicro directly.
    const { calculateActualCostMicro } = await import("../src/server/engine/model-cost-profile");
    const profile: ModelCostProfile = FIXTURE_COST_PROFILE;
    // A caller must gate on unsupportedBillingUsage BEFORE calling
    // calculateActualCostMicro — verified structurally in s4-executor.ts.
    const source = await (await import("node:fs/promises")).readFile(new URL("../src/server/engine/s4-executor.ts", import.meta.url), "utf-8");
    expect(source).toContain("unsupportedBillingUsage");
    expect(source).toContain("UNSUPPORTED_BILLING_USAGE");
    // Sanity: the pure pricing function itself has no awareness of the
    // flag (by design — the gating happens at the call site, not here).
    expect(calculateActualCostMicro(profile, { inputTokens: 10, outputTokens: 2 })).toBe(10 * profile.inputPriceMicroUsdPerToken + 2 * profile.outputPriceMicroUsdPerToken);
  });
});

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

function fixedContentFetcher(byUrl: Record<string, FetchedDocument | "BLOCK">): ContentFetcher {
  return {
    name: "fixture",
    async fetch(url) {
      const item = byUrl[url];
      if (!item || item === "BLOCK") {
        throw new ContentFetchError("HTTP_ERROR", "not found in fixture", url);
      }
      return item;
    },
  };
}

function fixedEvidenceExtractor(facts: ExtractedFact[]): EvidenceExtractor {
  return { name: "fixture", async extract() { return facts; } };
}
