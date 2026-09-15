import AnthropicNS from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError, type EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import { QueryProposerUnavailableError, type QueryProposer } from "../src/server/engine/providers/query-proposer";
import {
  __setTransientRetryDelayCapMs,
  DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  NETWORK_NO_RESPONSE_RETRY_DELAY_MS,
  parseRetryAfterMs,
  RETRY_AFTER_MAX_MS,
  retryAfterMsFromHeaders,
  transientRetryDelayMs,
} from "../src/server/engine/providers/retry";
import { SearchProviderUnavailableError, type SearchGateway } from "../src/server/engine/providers/search-gateway";
import { TokenCountUnavailableError } from "../src/server/engine/providers/token-gate";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// TRANSIENT RETRY DELAY POLICY — the executor's ONE transient retry (and
// the count_tokens gate's) waits a bounded delay decided by ONE shared
// policy: no response 15 s; 429 the Retry-After header inside a 60 s cap,
// 15 s without one; retryable 5xx 15 s; a non-transient failure never
// retried. The tunnel on the live path flaps for 10–30 s, and a 429
// retried at once meets the same limit.
//
// What must NOT change, and is held below: exactly two attempts, one
// reservation per attempt, nothing reserved or billed for the wait, no
// third call ever, a non-transient failure never retried, offline suites
// never actually sleeping, and one Evidence row per extracted unit however
// many attempts it took.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

afterEach(() => {
  // tests/setup-provider-env.ts's offline default for every other suite.
  __setTransientRetryDelayCapMs(0);
});

// Small enough to keep the suite fast, large enough that a wait is
// unmistakable against the executor's own few-millisecond work.
const TEST_DELAY_MS = 250;

const NOW = new Date("2026-09-14T00:00:00Z");
const DOC_URL = "https://example.com/doc";
const FRAGMENT = "the protocol fee accrues directly to the treasury contract";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
const PER_ATTEMPT_MICRO = COST.maxInputTokens * COST.inputPriceMicroUsdPerToken + COST.maxOutputTokens * COST.outputPriceMicroUsdPerToken;

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

async function makeJob() {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("netretry");
  const name = "Net Retry Project";
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  return { jobId: job.id, project: { id: project.id, name, slug, ticker: null as string | null } };
}

const ctxFor = (jobId: string) => ({
  jobId,
  attemptNumber: 1,
  isRecoveryAttempt: false,
  budget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro: 10_000_000 },
});

function doc(): FetchedDocument {
  return {
    finalUrl: DOC_URL,
    requestedUrl: DOC_URL,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: `Net Retry Project: ${FRAGMENT}`,
    contentHash: "sha256:fixture",
    fetchedAt: NOW,
    byteLength: 100,
  };
}

const fact: ExtractedFact = {
  step: 1,
  component: "SOURCE_OF_VALUE",
  statement: "protocol fee accrues to the treasury",
  supportFragment: FRAGMENT,
  mechanismState: null,
  directness: "DIRECT",
  publishedAt: null,
  doesNotProve: "does not prove distribution",
  relationship: "SUPPORTS",
};

// A provider that fails the first N calls with the given error, then
// answers. Records every call, and WHEN each call arrived, so a test can
// measure the wait between two attempts directly instead of inferring it
// from the whole execute() — which also contains database work whose
// duration under load is not the retry policy's.
function failing<T>(errors: unknown[], answer: T): { calls: { n: number; at: number[] }; fn: () => Promise<T> } {
  const calls = { n: 0, at: [] as number[] };
  return {
    calls,
    fn: async () => {
      calls.n += 1;
      calls.at.push(Date.now());
      const e = errors[calls.n - 1];
      if (e !== undefined) throw e;
      return answer;
    },
  };
}

function executorWith(project: { id: string; name: string; slug: string; ticker: string | null }, roles: {
  queryProposer?: QueryProposer;
  searchGateway?: SearchGateway;
  contentFetcher?: ContentFetcher;
  evidenceExtractor?: EvidenceExtractor;
}) {
  return createS4WorkExecutor({
    db: ctx.db,
    project,
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: roles.queryProposer ?? { name: "fixture", async proposeQueries() { return ["q"]; } },
    searchGateway: roles.searchGateway ?? { name: "fixture", async search() { return []; } },
    contentFetcher: roles.contentFetcher ?? { name: "fixture", async fetch() { throw new Error("fixture: no fetch expected"); } },
    evidenceExtractor: roles.evidenceExtractor ?? { name: "fixture", async extract() { return []; } },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

async function jobRow(jobId: string) {
  const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return row;
}

const noResponse = () => new QueryProposerUnavailableError("api call failed: connect ETIMEDOUT", true, null);
const rateLimited = (retryAfterMs: number | null = null) => new QueryProposerUnavailableError("api 429 RateLimitError", true, 429, retryAfterMs);

function apiError(status: number, headers?: Record<string, string>): InstanceType<typeof AnthropicNS.APIError> {
  return new AnthropicNS.APIError(status, { type: "error" }, `api ${status}`, headers ? new Headers(headers) : undefined);
}

describe("1. the policy — every transient class waits a bounded delay, decided in one place", () => {
  it("no response, 429 without Retry-After and retryable 5xx wait the default; non-transient failures never wait", () => {
    __setTransientRetryDelayCapMs(null);
    expect(DEFAULT_TRANSIENT_RETRY_DELAY_MS).toBe(15_000);
    expect(NETWORK_NO_RESPONSE_RETRY_DELAY_MS).toBe(DEFAULT_TRANSIENT_RETRY_DELAY_MS);
    // no response, the three provider roles the executor retries:
    expect(transientRetryDelayMs(new QueryProposerUnavailableError("timeout", true, null))).toBe(15_000);
    expect(transientRetryDelayMs(new SearchProviderUnavailableError("Brave Search request failed: fetch failed", true))).toBe(15_000);
    expect(transientRetryDelayMs(new EvidenceExtractorUnavailableError("generation failed: NETWORK_NO_RESPONSE", true, "NETWORK_NO_RESPONSE", null))).toBe(15_000);
    // a typed error that predates the field is a no-response failure too
    expect(transientRetryDelayMs(new QueryProposerUnavailableError("legacy", true))).toBe(15_000);
    // 429 without Retry-After
    expect(transientRetryDelayMs(rateLimited())).toBe(15_000);
    expect(transientRetryDelayMs(new EvidenceExtractorUnavailableError("generation failed: RATE_LIMITED:429", true, "RATE_LIMITED", 429))).toBe(15_000);
    // retryable 5xx
    expect(transientRetryDelayMs(new SearchProviderUnavailableError("Brave Search returned HTTP 503", true, 503))).toBe(15_000);
    expect(transientRetryDelayMs(new QueryProposerUnavailableError("529 overloaded", true, 529))).toBe(15_000);
    // non-transient: never retried, so never waits
    expect(transientRetryDelayMs(new QueryProposerUnavailableError("model output is not valid JSON", false, null))).toBe(0);
    expect(transientRetryDelayMs(new QueryProposerUnavailableError("401", false, 401))).toBe(0);
    expect(transientRetryDelayMs(new SearchProviderUnavailableError("not JSON", false))).toBe(0);
    expect(transientRetryDelayMs(new TokenCountUnavailableError("permanent", false))).toBe(0);
    expect(transientRetryDelayMs(new Error("plain"))).toBe(0);
    expect(transientRetryDelayMs(null)).toBe(0);
  });

  it("Retry-After is honoured only inside the cap: seconds and HTTP-dates parse, absurd or unparsable values fall back", () => {
    __setTransientRetryDelayCapMs(null);
    expect(RETRY_AFTER_MAX_MS).toBe(60_000);
    expect(parseRetryAfterMs("7")).toBe(7_000);
    expect(parseRetryAfterMs(" 0 ")).toBe(0);
    const now = new Date("2026-09-14T12:00:00Z");
    expect(parseRetryAfterMs("Mon, 14 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterMs("Mon, 14 Sep 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(retryAfterMsFromHeaders(new Headers({ "Retry-After": "12" }))).toBe(12_000);
    expect(retryAfterMsFromHeaders({ "retry-after": "3" })).toBe(3_000);
    expect(retryAfterMsFromHeaders(undefined)).toBeNull();
    // typed errors carrying the parsed header
    expect(transientRetryDelayMs(rateLimited(7_000))).toBe(7_000);
    expect(transientRetryDelayMs(rateLimited(0))).toBe(0);
    expect(transientRetryDelayMs(rateLimited(600_000))).toBe(RETRY_AFTER_MAX_MS);
    expect(transientRetryDelayMs(new SearchProviderUnavailableError("503", true, 503, 20_000))).toBe(20_000);
    expect(transientRetryDelayMs(new EvidenceExtractorUnavailableError("429", true, "RATE_LIMITED", 429, null, 4_000))).toBe(4_000);
    // a no-response failure has no answering headers, so nothing to honour
    expect(transientRetryDelayMs(new QueryProposerUnavailableError("timeout", true, null, 1_000))).toBe(15_000);
    // the raw SDK exception count_tokens retries before wrapping
    expect(transientRetryDelayMs(new AnthropicNS.APIConnectionError({ message: "no response" }))).toBe(15_000);
    expect(transientRetryDelayMs(apiError(429))).toBe(15_000);
    expect(transientRetryDelayMs(apiError(429, { "retry-after": "9" }))).toBe(9_000);
    expect(transientRetryDelayMs(apiError(429, { "retry-after": "3600" }))).toBe(RETRY_AFTER_MAX_MS);
    expect(transientRetryDelayMs(apiError(503))).toBe(15_000);
    expect(transientRetryDelayMs(apiError(401))).toBe(0);
    expect(transientRetryDelayMs(apiError(400))).toBe(0);
  });

  it("the offline seam is a ceiling on every wait, never a floor", () => {
    __setTransientRetryDelayCapMs(0);
    expect(transientRetryDelayMs(noResponse())).toBe(0);
    expect(transientRetryDelayMs(rateLimited(7_000))).toBe(0);
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    expect(transientRetryDelayMs(noResponse())).toBe(TEST_DELAY_MS);
    expect(transientRetryDelayMs(rateLimited(7_000))).toBe(TEST_DELAY_MS);
    expect(transientRetryDelayMs(rateLimited(50))).toBe(50);
    expect(transientRetryDelayMs(new QueryProposerUnavailableError("permanent", false, 400))).toBe(0);
  });

  it("the provider throw sites carry the status and the header: Brave and Anthropic shapes", () => {
    const transport = new SearchProviderUnavailableError("Brave Search request failed: fetch failed", true);
    const answered = new SearchProviderUnavailableError("Brave Search returned HTTP 503", true, 503, 2_000);
    expect(transport.httpStatus).toBeNull();
    expect(transport.retryAfterMs).toBeNull();
    expect(answered.httpStatus).toBe(503);
    expect(answered.retryAfterMs).toBe(2_000);
    expect(new QueryProposerUnavailableError("x", true, 529, 1_000).retryAfterMs).toBe(1_000);
    expect(new EvidenceExtractorUnavailableError("x", true, "RATE_LIMITED", 429, null, 1_500).retryAfterMs).toBe(1_500);
  });
});

describe("2. the executor — one bounded wait before the single retry, nothing else changes", () => {
  it("query proposer: no-response first attempt waits, retries once with its own reservation, succeeds; two attempts, no third", async () => {
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const proposer = failing([noResponse()], ["q1"]);
    const executor = executorWith(project, { queryProposer: { name: "fixture", proposeQueries: proposer.fn } });
    const started = Date.now();
    // (The attempt itself ends without Evidence — the fixture search
    // returns nothing — which is an ordinary local outcome, not a throw.)
    await executor.execute(ITEM, ctxFor(jobId));
    const elapsed = Date.now() - started;
    expect(proposer.calls.n).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(TEST_DELAY_MS - 5);
    expect((await jobRow(jobId)).modelCostMicroReserved).toBe(2 * PER_ATTEMPT_MICRO);
  });

  it("query proposer: a 429 no longer retries at once — it waits its Retry-After (inside the cap), then retries once", async () => {
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const retryAfter = 120;
    const proposer = failing([rateLimited(retryAfter)], ["q1"]);
    const executor = executorWith(project, { queryProposer: { name: "fixture", proposeQueries: proposer.fn } });
    const started = Date.now();
    await executor.execute(ITEM, ctxFor(jobId));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(retryAfter - 5);
    expect(elapsed).toBeLessThan(TEST_DELAY_MS);
    expect(proposer.calls.n).toBe(2);
    expect((await jobRow(jobId)).modelCostMicroReserved).toBe(2 * PER_ATTEMPT_MICRO);
  });

  it("query proposer: a 429 without Retry-After waits the default (capped here), then retries once", async () => {
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const proposer = failing([rateLimited()], ["q1"]);
    const executor = executorWith(project, { queryProposer: { name: "fixture", proposeQueries: proposer.fn } });
    const started = Date.now();
    await executor.execute(ITEM, ctxFor(jobId));
    expect(Date.now() - started).toBeGreaterThanOrEqual(TEST_DELAY_MS - 5);
    expect(proposer.calls.n).toBe(2);
    expect((await jobRow(jobId)).modelCostMicroReserved).toBe(2 * PER_ATTEMPT_MICRO);
  });

  it("query proposer: no response twice is still fatal after exactly two attempts and one wait — bounded, never a loop", async () => {
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const proposer = failing([noResponse(), noResponse(), noResponse()], ["never"]);
    const executor = executorWith(project, { queryProposer: { name: "fixture", proposeQueries: proposer.fn } });
    await expect(executor.execute(ITEM, ctxFor(jobId))).rejects.toBeInstanceOf(CapabilityFatalError);
    const rejectedAt = Date.now();
    // Exactly two attempts: termination is structural, not a timing guess.
    expect(proposer.calls.n).toBe(2);
    // ONE wait, and it sits between the two attempts: measured on the
    // attempt timestamps themselves. The old assertion bounded the whole
    // execute() — contract-view loads, reservations and trace writes
    // included — under 2x the delay, and flaked under full-suite database
    // load while the retry semantics were intact. The wait-before-retry
    // is the policy; the tail after the final failure holds no retry and
    // therefore no wait, which the short post-attempt span proves.
    const gapBetweenAttempts = proposer.calls.at[1] - proposer.calls.at[0];
    expect(gapBetweenAttempts).toBeGreaterThanOrEqual(TEST_DELAY_MS - 5);
    expect(rejectedAt - proposer.calls.at[1]).toBeLessThan(TEST_DELAY_MS);
    expect((await jobRow(jobId)).modelCostMicroReserved).toBe(2 * PER_ATTEMPT_MICRO);
  });

  it("query proposer: a non-transient failure never waits and never retries", async () => {
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const proposer = failing([new QueryProposerUnavailableError("model output is not valid JSON", false, null)], ["never"]);
    const executor = executorWith(project, { queryProposer: { name: "fixture", proposeQueries: proposer.fn } });
    const started = Date.now();
    const result = await executor.execute(ITEM, ctxFor(jobId));
    expect(result.status).toBe("FAILED");
    expect(Date.now() - started).toBeLessThan(TEST_DELAY_MS);
    expect(proposer.calls.n).toBe(1);
    expect((await jobRow(jobId)).modelCostMicroReserved).toBe(PER_ATTEMPT_MICRO);
  });

  it("search gateway: a transport failure waits before its one retry; a fresh searchQueries reservation per attempt", async () => {
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const search = failing([new SearchProviderUnavailableError("Brave Search request failed: fetch failed", true)], []);
    const executor = executorWith(project, { searchGateway: { name: "fixture", search: search.fn } });
    const started = Date.now();
    await executor.execute(ITEM, ctxFor(jobId));
    expect(Date.now() - started).toBeGreaterThanOrEqual(TEST_DELAY_MS - 5);
    expect(search.calls.n).toBe(2);
    expect((await jobRow(jobId)).searchQueriesReserved).toBe(2);
  });

  it("evidence extractor: a no-response generation waits before its one retry, and the retried extraction writes exactly ONE Evidence row", async () => {
    __setTransientRetryDelayCapMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const extract = failing([new EvidenceExtractorUnavailableError("generation failed: NETWORK_NO_RESPONSE", true, "NETWORK_NO_RESPONSE", null)], [fact]);
    const executor = executorWith(project, {
      searchGateway: { name: "fixture", async search() { return [{ url: DOC_URL, title: null, snippet: null }]; } },
      contentFetcher: { name: "fixture", async fetch() { return doc(); } },
      evidenceExtractor: { name: "fixture", extract: extract.fn },
    });
    const started = Date.now();
    const result = await executor.execute(ITEM, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(Date.now() - started).toBeGreaterThanOrEqual(TEST_DELAY_MS - 5);
    expect(extract.calls.n).toBe(2);
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.length).toBe(1);
    expect(rows[0].fragment).toBe(FRAGMENT);
    // Two real attempts, two audit rows — the wait added none.
    const traces = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
    expect(traces.filter((t) => t.providerKind === "EXTRACT" && t.operationType === "MODEL_CALL_ATTEMPTED").length).toBe(2);
    expect((await jobRow(jobId)).sourceOpensReserved).toBe(1);
  });
});
