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
  __setNoResponseRetryDelayMs,
  NETWORK_NO_RESPONSE_RETRY_DELAY_MS,
  noResponseRetryDelayMs,
} from "../src/server/engine/providers/retry";
import { SearchProviderUnavailableError, type SearchGateway } from "../src/server/engine/providers/search-gateway";
import { TokenCountUnavailableError } from "../src/server/engine/providers/token-gate";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// NETWORK TRANSIENT RESILIENCE V2 — the executor's ONE transient retry
// waits the same bounded delay count_tokens already waits, when the first
// attempt was never answered.
//
// The defect: the tunnel on the live path flaps for 10–30 s. A query
// proposer, search or extractor generation call made inside a flap failed
// with no response, its immediate retry failed inside the same flap, and
// the executor — correctly — classified two consecutive transient failures
// as a capability outage: CapabilityFatalError, the paid job FAILED.
//
// What must NOT change, and is held below: exactly two attempts, one
// reservation per attempt, nothing reserved or billed for the wait, no
// third call ever, an answered transient failure (429) still retried at
// once, a non-transient failure never retried, and one Evidence row per
// extracted unit however many attempts it took.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

afterEach(() => {
  // tests/setup-provider-env.ts's offline default for every other suite.
  __setNoResponseRetryDelayMs(0);
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
// answers. Records every call.
function failing<T>(errors: unknown[], answer: T): { calls: { n: number }; fn: () => Promise<T> } {
  const calls = { n: 0 };
  return {
    calls,
    fn: async () => {
      calls.n += 1;
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
const rateLimited = () => new QueryProposerUnavailableError("api 429 RateLimitError", true, 429);

describe("1. the policy — which transient failures wait, and for how long", () => {
  it("a transient failure with no HTTP status waits the production delay; an answered one, or a non-transient one, does not", () => {
    __setNoResponseRetryDelayMs(null);
    expect(NETWORK_NO_RESPONSE_RETRY_DELAY_MS).toBe(15_000);
    // The three provider roles the executor retries, no response:
    expect(noResponseRetryDelayMs(new QueryProposerUnavailableError("timeout", true, null))).toBe(15_000);
    expect(noResponseRetryDelayMs(new SearchProviderUnavailableError("Brave Search request failed: fetch failed", true))).toBe(15_000);
    expect(noResponseRetryDelayMs(new EvidenceExtractorUnavailableError("generation failed: NETWORK_NO_RESPONSE", true, "NETWORK_NO_RESPONSE", null))).toBe(15_000);
    // A typed error that predates the field is a no-response failure too.
    expect(noResponseRetryDelayMs(new QueryProposerUnavailableError("legacy", true))).toBe(15_000);
    // Answered transient failures keep the immediate retry.
    expect(noResponseRetryDelayMs(new QueryProposerUnavailableError("429", true, 429))).toBe(0);
    expect(noResponseRetryDelayMs(new SearchProviderUnavailableError("Brave Search returned HTTP 503", true, 503))).toBe(0);
    expect(noResponseRetryDelayMs(new EvidenceExtractorUnavailableError("generation failed: RATE_LIMITED:429", true, "RATE_LIMITED", 429))).toBe(0);
    // Non-transient failures are never retried, so they never wait.
    expect(noResponseRetryDelayMs(new QueryProposerUnavailableError("model output is not valid JSON", false, null))).toBe(0);
    expect(noResponseRetryDelayMs(new SearchProviderUnavailableError("not JSON", false))).toBe(0);
    expect(noResponseRetryDelayMs(new TokenCountUnavailableError("permanent", false))).toBe(0);
    expect(noResponseRetryDelayMs(new Error("plain"))).toBe(0);
    expect(noResponseRetryDelayMs(null)).toBe(0);
    // The offline seam.
    __setNoResponseRetryDelayMs(0);
    expect(noResponseRetryDelayMs(noResponse())).toBe(0);
    __setNoResponseRetryDelayMs(TEST_DELAY_MS);
    expect(noResponseRetryDelayMs(noResponse())).toBe(TEST_DELAY_MS);
    expect(noResponseRetryDelayMs(rateLimited())).toBe(0);
  });

  it("the provider throw sites carry the status: Brave passes its HTTP status, a transport failure carries none", () => {
    // The Brave and Anthropic primitives construct these exact shapes at
    // their catch sites; the classes must keep both readings distinct.
    const transport = new SearchProviderUnavailableError("Brave Search request failed: fetch failed", true);
    const answered = new SearchProviderUnavailableError("Brave Search returned HTTP 503", true, 503);
    expect(transport.httpStatus).toBeNull();
    expect(answered.httpStatus).toBe(503);
    expect(new QueryProposerUnavailableError("x", true, null).httpStatus).toBeNull();
    expect(new QueryProposerUnavailableError("x", true, 529).httpStatus).toBe(529);
  });
});

describe("2. the executor — one bounded wait before the single retry, nothing else changes", () => {
  it("query proposer: no-response first attempt waits, retries once with its own reservation, succeeds; two attempts, no third", async () => {
    __setNoResponseRetryDelayMs(TEST_DELAY_MS);
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

  it("query proposer: an answered transient failure (429) still retries at once", async () => {
    __setNoResponseRetryDelayMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const proposer = failing([rateLimited()], ["q1"]);
    const executor = executorWith(project, { queryProposer: { name: "fixture", proposeQueries: proposer.fn } });
    const started = Date.now();
    await executor.execute(ITEM, ctxFor(jobId));
    expect(Date.now() - started).toBeLessThan(TEST_DELAY_MS);
    expect(proposer.calls.n).toBe(2);
    expect((await jobRow(jobId)).modelCostMicroReserved).toBe(2 * PER_ATTEMPT_MICRO);
  });

  it("query proposer: no response twice is still fatal after exactly two attempts and one wait — bounded, never a loop", async () => {
    __setNoResponseRetryDelayMs(TEST_DELAY_MS);
    const { jobId, project } = await makeJob();
    const proposer = failing([noResponse(), noResponse(), noResponse()], ["never"]);
    const executor = executorWith(project, { queryProposer: { name: "fixture", proposeQueries: proposer.fn } });
    const started = Date.now();
    await expect(executor.execute(ITEM, ctxFor(jobId))).rejects.toBeInstanceOf(CapabilityFatalError);
    const elapsed = Date.now() - started;
    expect(proposer.calls.n).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(TEST_DELAY_MS - 5);
    expect(elapsed).toBeLessThan(2 * TEST_DELAY_MS);
    expect((await jobRow(jobId)).modelCostMicroReserved).toBe(2 * PER_ATTEMPT_MICRO);
  });

  it("query proposer: a non-transient failure never waits and never retries", async () => {
    __setNoResponseRetryDelayMs(TEST_DELAY_MS);
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
    __setNoResponseRetryDelayMs(TEST_DELAY_MS);
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
    __setNoResponseRetryDelayMs(TEST_DELAY_MS);
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
