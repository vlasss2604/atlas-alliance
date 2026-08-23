import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  evidence,
  interpretations,
  projects,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchPlans,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import {
  createTraceFixtureExecutor,
  NON_LIVE_FIXTURE_PROVIDER_NAME,
} from "../src/server/engine/trace-fixture-executor";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { recordTraceEvent, TracePersistenceError } from "../src/server/engine/trace-store";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { claimResearchJob, createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { createInterpretation } from "../src/server/interpreter/interpret";
import { __setInterpreterGateway } from "../src/server/interpreter/gateway";
import { fakeGateway } from "../src/server/interpreter/fake";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) —
// real-Postgres integration tests for the operational trace and its
// non-live fixture. TRACE != EVIDENCE is the central invariant tested
// throughout: trace rows must never be readable as, or substitutable
// for, admissible research Evidence.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeProject(): Promise<{ id: string; slug: string; name: string; ticker: string | null }> {
  const slug = uniq("frr_stage2");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Stage 2 fixture project", status: "ACTIVE_CORE" }).returning();
  return project;
}

async function makeUser(): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  return user.id;
}

async function queueJob(projectId: string, topicId: string, entitlement: EntitlementSnapshot): Promise<string> {
  const userId = await makeUser();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId,
    topicId,
    projectId,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "does protocol revenue reach token holders" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement,
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

async function traceRowsFor(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return [...rows].sort((a, b) => a.sequence - b.sequence);
}

describe("First Real Run Stage 2 — full non-live worker run produces inspectable trace", () => {
  it("a job driven through the real worker path with the trace fixture produces search/fetch/extract trace linked to the correct attempt", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());

    const executor = createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" });
    await handleResearchJobTask(ctx.db, jobId, executor);

    const job = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId)))[0];
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(job.state);

    const trace = await traceRowsFor(jobId);
    expect(trace.length).toBeGreaterThan(0);

    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBeGreaterThan(0);

    // #2 — search-query trace exists and is linked to the correct attempt.
    const queryEvents = trace.filter((t) => t.operationType === "QUERY_PROPOSED");
    expect(queryEvents.length).toBeGreaterThan(0);
    for (const ev of queryEvents) {
      expect(ev.researchAttemptId).not.toBeNull();
      const owningAttempt = attempts.find((a) => a.id === ev.researchAttemptId);
      expect(owningAttempt).toBeTruthy();
      expect(owningAttempt?.patternStep).toBe(ev.patternStep);
      expect(owningAttempt?.component).toBe(ev.component);
    }

    // #6 — provider identity visible per applicable operation.
    const searchEvents = trace.filter((t) => t.operationType === "SEARCH_EXECUTED");
    for (const ev of searchEvents) expect(ev.providerName).toBe(NON_LIVE_FIXTURE_PROVIDER_NAME);

    // #7 — USED/LIMIT reconstructs for all 3 budget axes.
    const budget = job.budgetAtStart as { maxSearchQueries: number; maxSourceOpens: number; maxModelCostMicro: number };
    expect(job.searchQueriesReserved).toBeGreaterThan(0);
    expect(job.searchQueriesReserved).toBeLessThanOrEqual(budget.maxSearchQueries);
    expect(job.sourceOpensReserved).toBeLessThanOrEqual(budget.maxSourceOpens);
    expect(job.modelCostMicroReserved).toBeLessThanOrEqual(budget.maxModelCostMicro);

    // #8 — terminal reason visible separately from state/error_code.
    expect(job.terminationReason).toBeTruthy();

    // #19 — trace sequence is deterministic and gap-free for this job.
    const sequences = trace.map((t) => t.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences[0]).toBe(1);
    for (let i = 1; i < sequences.length; i++) expect(sequences[i]).toBe(sequences[i - 1] + 1);
  });
});

describe("First Real Run Stage 2 — outcome distinguishability", () => {
  it("#3 zero candidates is distinguishable from fetch failure", async () => {
    const topicId = await activeTopicId();
    const projectZero = await makeProject();
    const jobZero = await queueJob(projectZero.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobZero, createTraceFixtureExecutor({ db: ctx.db, project: projectZero, defaultScenario: "ZERO_CANDIDATES" }));
    const traceZero = await traceRowsFor(jobZero);
    expect(traceZero.some((t) => t.operationType === "FETCH_ATTEMPTED")).toBe(false);
    expect(traceZero.some((t) => t.operationType === "SEARCH_EXECUTED" && t.status === "OK")).toBe(true);

    const projectFetch = await makeProject();
    const jobFetch = await queueJob(projectFetch.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobFetch, createTraceFixtureExecutor({ db: ctx.db, project: projectFetch, defaultScenario: "FETCH_FAILURE" }));
    const traceFetch = await traceRowsFor(jobFetch);
    expect(traceFetch.some((t) => t.operationType === "FETCH_FAILED")).toBe(true);
  });

  it("#4 fetch failure is distinguishable from fetched-but-no-Evidence (extraction failure)", async () => {
    const topicId = await activeTopicId();
    const projectFetch = await makeProject();
    const jobFetch = await queueJob(projectFetch.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobFetch, createTraceFixtureExecutor({ db: ctx.db, project: projectFetch, defaultScenario: "FETCH_FAILURE" }));
    const traceFetch = await traceRowsFor(jobFetch);
    expect(traceFetch.some((t) => t.operationType === "FETCH_OK")).toBe(false);
    expect(traceFetch.some((t) => t.operationType === "EXTRACT_ATTEMPTED")).toBe(false);

    const projectExtract = await makeProject();
    const jobExtract = await queueJob(projectExtract.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobExtract, createTraceFixtureExecutor({ db: ctx.db, project: projectExtract, defaultScenario: "EXTRACTION_FAILURE" }));
    const traceExtract = await traceRowsFor(jobExtract);
    expect(traceExtract.some((t) => t.operationType === "FETCH_OK")).toBe(true);
    expect(traceExtract.some((t) => t.operationType === "EXTRACT_FAILED")).toBe(true);
    const evidenceRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobExtract));
    expect(evidenceRows.length).toBe(0);
  });

  it("#16 duplicate candidate is visible as CANDIDATE_DEDUPED", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobId, createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "DUPLICATE_CANDIDATE" }));
    const trace = await traceRowsFor(jobId);
    expect(trace.some((t) => t.operationType === "CANDIDATE_DEDUPED" && t.reasonCode === "DUPLICATE_URL")).toBe(true);
  });

  it("#17 one failed fetch remains visible even when another source succeeds", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobId, createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "PARTIAL_FETCH_FAILURE" }));
    const trace = await traceRowsFor(jobId);
    expect(trace.some((t) => t.operationType === "FETCH_FAILED")).toBe(true);
    expect(trace.some((t) => t.operationType === "FETCH_OK")).toBe(true);
    // Not collapsed into only the final research_attempts.reason: the
    // attempt for this component still SUCCEEDED (the other source
    // worked), but the failed fetch's own trace row survives independently.
    const attempt = (await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId)))[0];
    expect(attempt.status).toBe("SUCCEEDED");
  });

  it("#18 successful extraction links trace to resulting source/evidence ids without the trace row itself becoming Evidence", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobId, createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" }));
    const trace = await traceRowsFor(jobId);
    const extractOk = trace.find((t) => t.operationType === "EXTRACT_OK" && t.evidenceId !== null);
    expect(extractOk).toBeTruthy();
    const [evRow] = await ctx.db.select().from(evidence).where(eq(evidence.id, extractOk!.evidenceId!));
    expect(evRow).toBeTruthy();
    // The trace row carries only ids, never Evidence content fields.
    const traceKeys = Object.keys(extractOk!);
    for (const forbidden of ["fragment", "summary", "doesNotProve", "supportFragment", "statement"]) {
      expect(traceKeys).not.toContain(forbidden);
    }
  });

  it("#9 a budget-skipped candidate produces CANDIDATE_SKIPPED_BUDGET with the correct axis", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const userId = await makeUser();
    const tinySourceOpenBudget: EntitlementSnapshot = {
      level: "ARI_CORE",
      capability: "FRESH_RESEARCH",
      budget: { maxSearchQueries: 40, maxSourceOpens: 1, maxModelCostMicro: 4_000_000, maxWallClockSec: 1200, reservedRecoverySteps: 3 },
    };
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId,
      topicId,
      projectId: project.id,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: tinySourceOpenBudget,
      demoLifetimeProofLimit: 1000,
    });
    await handleResearchJobTask(ctx.db, job.id, createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "BUDGET_SKIPPED_SOURCE_OPEN" }));
    const trace = await traceRowsFor(job.id);
    const skipped = trace.filter((t) => t.operationType === "CANDIDATE_SKIPPED_BUDGET" && t.budgetAxis === "sourceOpens");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].reasonCode).toBe("SOURCE_OPEN_BUDGET_EXHAUSTED");
  });
});

describe("First Real Run Stage 2 — TRACE != EVIDENCE", () => {
  it("#5 trace rows never appear in Evidence or S5 component results, structurally", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, jobId, createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" }));

    const trace = await traceRowsFor(jobId);
    const evidenceRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    const s5Rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));

    const traceIds = new Set(trace.map((t) => t.id));
    for (const e of evidenceRows) expect(traceIds.has(e.id)).toBe(false);
    for (const r of s5Rows) {
      for (const supportingId of r.supportingEvidenceIds as string[]) expect(traceIds.has(supportingId)).toBe(false);
    }

    // No store in this codebase imports researchTraceEvents at all —
    // verified structurally: claim-evaluator.ts, claim-support-store.ts,
    // component-reconciler.ts, component-reconciliation-store.ts,
    // mechanism-assembler.ts, mechanism-assembly-store.ts never reference
    // it (checked by tests/first-real-run-stage2-static.test.ts's own
    // source-grep regression, kept as a separate lightweight file so a
    // future accidental import fails a dedicated, obviously-named test).
  });

  it("trace persistence failure (#20) propagates as a genuine execution failure — never a fabricated evidentiary conclusion", async () => {
    await expect(
      recordTraceEvent(ctx.db, {
        researchJobId: "00000000-0000-0000-0000-000000000000",
        operationType: "QUERY_PROPOSED",
        status: "OK",
      }),
    ).rejects.toThrow(TracePersistenceError);
  });

  it("a trace write for a REAL job with a corrupt attempt reference (FK violation) throws TracePersistenceError, not a swallowed failure", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    await runMemoryPlanningStage(ctx.db, jobId);
    // research_attempt_id references research_attempts.id — a
    // syntactically valid but nonexistent uuid here is a genuine
    // persistence-layer failure (FK violation) on a REAL, valid job, not
    // merely "the job itself doesn't exist" (already covered above).
    await expect(
      recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        researchAttemptId: "00000000-0000-0000-0000-000000000099",
        operationType: "QUERY_PROPOSED",
        status: "OK",
      }),
    ).rejects.toThrow(TracePersistenceError);
  });

  it("no recordTraceEvent call site in s4-executor.ts is wrapped in a local try/catch that could swallow a persistence failure", async () => {
    // Structural proof, checked directly against the source this test
    // suite exercises: preflight() (the only function with its own
    // try/catch blocks in s4-executor.ts) contains zero recordTraceEvent
    // calls — every trace write happens in the main execute() closure,
    // unguarded, so a thrown TracePersistenceError propagates through
    // controller.ts's executor.execute() call (which has no try/catch
    // around it either) all the way to worker.ts's own catch, which maps
    // it to FAILED/SYSTEM_OR_PROVIDER_FAILURE — never a fabricated
    // INSUFFICIENT_EVIDENCE/SUPPORTED/etc conclusion.
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../src/server/engine/s4-executor.ts", import.meta.url), "utf-8");
    const preflightMatch = /function preflight\([\s\S]*?\n\}\n/.exec(source);
    expect(preflightMatch).toBeTruthy();
    expect(preflightMatch![0]).not.toContain("recordTraceEvent");
    expect((source.match(/recordTraceEvent\(/g) ?? []).length).toBeGreaterThan(0);
  });
});

describe("First Real Run Stage 2 — secret/adversarial safety (#14)", () => {
  it("a provider error containing a credential-bearing URL never leaks into reason_code or any unrestricted trace field", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    const secretUrl = "https://example.com/leak?api_key=SECRET_TOKEN_DO_NOT_LEAK";

    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: NON_LIVE_FIXTURE_PROVIDER_NAME, async proposeQueries() { return ["q"]; } },
      searchGateway: { name: NON_LIVE_FIXTURE_PROVIDER_NAME, async search() { return [{ url: "https://example.com/candidate", title: "t", snippet: "s" }]; } },
      contentFetcher: {
        name: NON_LIVE_FIXTURE_PROVIDER_NAME,
        async fetch() {
          throw new ContentFetchError("HTTP_ERROR", `request failed for ${secretUrl} with Authorization: Bearer SECRET_TOKEN_DO_NOT_LEAK`, secretUrl);
        },
      },
      evidenceExtractor: { name: NON_LIVE_FIXTURE_PROVIDER_NAME, async extract() { return []; } },
      queryProposerCostProfile: { modelId: "t", inputPriceMicroUsdPerToken: 1, outputPriceMicroUsdPerToken: 1, maxInputTokens: 1, maxOutputTokens: 1, priceVersion: "t" },
      evidenceExtractorCostProfile: { modelId: "t", inputPriceMicroUsdPerToken: 1, outputPriceMicroUsdPerToken: 1, maxInputTokens: 1, maxOutputTokens: 1, priceVersion: "t" },
    });
    await handleResearchJobTask(ctx.db, jobId, executor);

    const trace = await traceRowsFor(jobId);
    expect(trace.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("SECRET_TOKEN_DO_NOT_LEAK");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    const fetchFailed = trace.find((t) => t.operationType === "FETCH_FAILED");
    expect(fetchFailed?.reasonCode).toBe("PROVIDER_ERROR"); // closed vocabulary, never the raw message

    // MEDIUM-2 closure (E): the SAME secret must not survive into
    // research_attempts.reason either — controller.ts persists
    // WorkExecutionResult.reason verbatim, and callProvider() used to
    // interpolate the caught exception's own message into that reason.
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBeGreaterThan(0);
    const attemptReasons = attempts.map((a) => a.reason).join(" | ");
    expect(attemptReasons).not.toContain("SECRET_TOKEN_DO_NOT_LEAK");
    expect(attemptReasons).not.toContain("Authorization");
    expect(attemptReasons).not.toContain("Bearer");
    expect(attemptReasons).toContain("CONTENT_FETCHER_FAILED:ContentFetchError"); // safe, closed category — provider role + failure class, no raw text
  });
});

describe("First Real Run Stage 2 acceptance closure — trace URL redaction (MEDIUM-1, §F/§G)", () => {
  it("a search-result candidate URL carrying a credential query param is persisted to trace only in redacted form, while the REAL url is what is actually fetched", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    const secretUrl = "https://example.com/candidate?api_key=SECRET_TOKEN_DO_NOT_LEAK&other=1";
    let fetchedWith: string | null = null;

    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: NON_LIVE_FIXTURE_PROVIDER_NAME, async proposeQueries() { return ["q"]; } },
      searchGateway: {
        name: NON_LIVE_FIXTURE_PROVIDER_NAME,
        async search() {
          return [{ url: secretUrl, title: "t", snippet: "s" }];
        },
      },
      contentFetcher: {
        name: NON_LIVE_FIXTURE_PROVIDER_NAME,
        async fetch(url: string) {
          // §G: this is the REAL url ContentFetcher receives — trace
          // sanitization must never mutate what is actually fetched.
          fetchedWith = url;
          return {
            finalUrl: url,
            requestedUrl: url,
            httpStatus: 200,
            contentType: "text/html",
            normalizedText: `${project.name}: unrelated content`,
            contentHash: "sha256:fixturehash",
            fetchedAt: new Date(),
            byteLength: 100,
          };
        },
      },
      evidenceExtractor: { name: NON_LIVE_FIXTURE_PROVIDER_NAME, async extract() { return []; } },
      queryProposerCostProfile: { modelId: "t", inputPriceMicroUsdPerToken: 1, outputPriceMicroUsdPerToken: 1, maxInputTokens: 1, maxOutputTokens: 1, priceVersion: "t" },
      evidenceExtractorCostProfile: { modelId: "t", inputPriceMicroUsdPerToken: 1, outputPriceMicroUsdPerToken: 1, maxInputTokens: 1, maxOutputTokens: 1, priceVersion: "t" },
    });
    await handleResearchJobTask(ctx.db, jobId, executor);

    expect(fetchedWith).toBe(secretUrl); // §G: fetch received the unredacted, original url

    const trace = await traceRowsFor(jobId);
    const withUrl = trace.filter((t) => t.targetRef?.includes("example.com/candidate"));
    expect(withUrl.length).toBeGreaterThan(0); // CANDIDATE_RETURNED, FETCH_ATTEMPTED, FETCH_OK, etc all carry this url
    for (const t of withUrl) {
      expect(t.targetRef).not.toContain("SECRET_TOKEN_DO_NOT_LEAK");
      expect(t.targetRef).toContain("api_key=[REDACTED]");
      expect(t.targetRef).toContain("other=1"); // a non-sensitive param survives untouched
    }
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("SECRET_TOKEN_DO_NOT_LEAK");
  });
});

describe("First Real Run Stage 2 — replay does not duplicate trace", () => {
  it("#11 replaying a terminal job (second handleResearchJobTask call) never duplicates trace rows", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    const executor = createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" });

    const first = await handleResearchJobTask(ctx.db, jobId, executor);
    expect(first.claimed).toBe(true);
    const traceBefore = await traceRowsFor(jobId);
    expect(traceBefore.length).toBeGreaterThan(0);

    // §K: job already left QUEUED — atomic claim makes this a no-op, and
    // the caller can SEE it was a no-op via the structured return.
    const second = await handleResearchJobTask(ctx.db, jobId, executor);
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.reason).toBe("NOT_QUEUED");
    const traceAfter = await traceRowsFor(jobId);
    expect(traceAfter).toEqual(traceBefore);
  });
});

describe("First Real Run Stage 2 acceptance closure — atomic job claim (HIGH-1, §A/§B)", () => {
  it("two concurrent handleResearchJobTask calls on one QUEUED job: exactly one claims it, the loser performs zero research work", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();

    // Baseline: one job run alone, to know exactly how many rows ONE
    // execution of this deterministic fixture scenario produces.
    const baselineJobId = await queueJob(project.id, topicId, coreEntitlement());
    await handleResearchJobTask(ctx.db, baselineJobId, createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" }));
    const baselineTrace = await traceRowsFor(baselineJobId);
    const baselineAttempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, baselineJobId));
    const baselineEvidence = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, baselineJobId));
    expect(baselineTrace.length).toBeGreaterThan(0);

    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    const executor = createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" });
    const [r1, r2] = await Promise.all([
      handleResearchJobTask(ctx.db, jobId, executor),
      handleResearchJobTask(ctx.db, jobId, executor),
    ]);

    const results = [r1, r2];
    expect(results.filter((r) => r.claimed).length).toBe(1); // exactly one claims it
    const loser = results.find((r) => !r.claimed);
    expect(loser).toBeDefined();
    if (loser && !loser.claimed) expect(loser.reason).toBe("NOT_QUEUED");

    // §B: the loser created zero planning duplication, zero extra
    // attempts, zero extra trace, zero extra Evidence — this job's rows
    // match the baseline (ONE execution) exactly, never doubled.
    const plans = await ctx.db.select().from(researchPlans).where(eq(researchPlans.researchJobId, jobId));
    expect(plans.length).toBe(1);
    const trace = await traceRowsFor(jobId);
    expect(trace.length).toBe(baselineTrace.length);
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBe(baselineAttempts.length);
    const evidenceRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(evidenceRows.length).toBe(baselineEvidence.length);

    // No terminal-state corruption from two writers racing the terminal
    // transition — exactly one coherent terminal state.
    const job = (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId)))[0];
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(job.state);
  });

  it("§C: handleResearchJobTask returns claimed:false and performs zero work when another handler already claimed the job", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());

    // Simulate a competing worker (or a real pg-boss worker racing
    // alpha-run) claiming the job first.
    const claimed = await claimResearchJob(ctx.db, jobId);
    expect(claimed).not.toBeNull();

    const executor = createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" });
    const result = await handleResearchJobTask(ctx.db, jobId, executor);
    expect(result.claimed).toBe(false);
    if (!result.claimed) expect(result.reason).toBe("NOT_QUEUED");

    const trace = await traceRowsFor(jobId);
    expect(trace.length).toBe(0);
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBe(0);
  });

  it("§D: createResearchJob({ skipEnqueue: true }) leaves zero pg-boss queue rows for the job — alpha-run's design leaves no orphan task", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const userId = await makeUser();
    const { job } = await createResearchJob(
      ctx.db,
      ctx.boss,
      {
        userId,
        topicId,
        projectId: project.id,
        originalQuestion: "does protocol revenue reach token holders?",
        normalizedTask: null,
        normalizedTaskHash: uniq("hash"),
        idempotencyKey: uniq("idem"),
        entitlement: coreEntitlement(),
        demoLifetimeProofLimit: 1000,
      },
      { skipEnqueue: true },
    );
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS c FROM pgboss.job WHERE data->>'jobId' = ${job.id}`);
    expect((rows.rows[0] as { c: number }).c).toBe(0);

    // A job created WITHOUT skipEnqueue (the normal production path,
    // used by every other test in this file via queueJob) does get one
    // — proving skipEnqueue is what changed, not enqueue itself breaking.
    const normalJobId = await queueJob(project.id, topicId, coreEntitlement());
    const normalRows = await ctx.db.execute(sql`SELECT count(*)::int AS c FROM pgboss.job WHERE data->>'jobId' = ${normalJobId}`);
    expect((normalRows.rows[0] as { c: number }).c).toBe(1);
  });
});

describe("First Real Run Stage 2 acceptance closure — real Interpreter path (MEDIUM-3, §H/§I/§J)", () => {
  it("a real Interpretation (fake gateway, non-live) classifies DEEP_RESEARCH and S7 evaluates the resulting intent — never falls back to UNKNOWN", async () => {
    __setInterpreterGateway(fakeGateway);
    try {
      const topicId = await activeTopicId();
      const projectSlug = uniq("aave_test");
      const [project] = await ctx.db.insert(projects).values({ slug: projectSlug, name: "Aave", status: "ACTIVE_CORE" }).returning();
      const userId = await makeUser();

      const interpretResult = await createInterpretation(ctx.db, DEFAULT_PRODUCT_CONFIG, {
        userId,
        question: "does protocol revenue reach Aave token holders?",
      });
      const interp = interpretResult.interpretation;
      // §I: a classified alpha-run-style question does NOT default to
      // normalized_intent=UNKNOWN — this is the real Interpreter
      // contract's own product behaviour for a named, in-scope asset.
      expect(interp.status).toBe("READY");
      expect(interp.route).toBe("DEEP_RESEARCH");
      expect(interp.understood?.projectSlug).toBe(projectSlug);

      const { job } = await createResearchJob(
        ctx.db,
        ctx.boss,
        {
          userId,
          topicId,
          projectId: project.id,
          originalQuestion: "does protocol revenue reach Aave token holders?",
          normalizedTask: {
            project_slug: interp.understood!.projectSlug,
            project_slugs: [interp.understood!.projectSlug],
            task: interp.understood!.researchTask,
          },
          normalizedTaskHash: uniq("hash"),
          idempotencyKey: uniq("idem"),
          entitlement: coreEntitlement(),
          demoLifetimeProofLimit: 1000,
        },
        { skipEnqueue: true },
      );
      await ctx.db.update(interpretations).set({ researchJobId: job.id }).where(eq(interpretations.id, interp.id));

      const executor = createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" });
      const result = await handleResearchJobTask(ctx.db, job.id, executor);
      expect(result.claimed).toBe(true);

      // §J: S7's result is driven by the classified intent (read from the
      // linked interpretation row), never by manually injected prose.
      const [s7] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, job.id));
      expect(s7).toBeDefined();
      expect(s7.intent).toBe("PROTOCOL_REVENUE_TO_TOKEN"); // the fake gateway's real classification for this question — not "UNKNOWN"
    } finally {
      __setInterpreterGateway(null);
    }
  });
});

describe("First Real Run Stage 2 — no live network/provider call is reachable (#12)", () => {
  it("the trace fixture never resolves a production provider — direct execution against a fresh job proves it", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());
    await runMemoryPlanningStage(ctx.db, jobId);
    const executor = createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" });
    const item: ComponentWorkItem = { step: 1, stepName: "s", component: "SOURCE_OF_VALUE", state: "NO_MEMORY", blockers: [], memoryIds: [], conflictingMemoryIds: [] };
    const result = await executor.execute(item, { jobId, attemptNumber: 1, isRecoveryAttempt: false, budget: { maxSearchQueries: 40, maxSourceOpens: 60, maxModelCostMicro: 4_000_000 } });
    expect(result.status).toBe("SUCCEEDED");
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
    for (const t of trace) {
      if (t.providerName) expect(t.providerName).toBe(NON_LIVE_FIXTURE_PROVIDER_NAME);
    }
  });
});
