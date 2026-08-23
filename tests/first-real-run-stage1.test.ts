import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  evidence,
  projects,
  researchAttempts,
  researchClaimSupport,
  researchJobs,
  researchPatterns,
  topics,
  users,
} from "../src/server/db/schema";
import { createNonLiveS4WorkExecutor } from "../src/server/engine/non-live-executor";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { handleResearchJobTask, mapEngineOutcome } from "../src/server/jobs/worker";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// First Real Run, Stage 1 (pipeline-integration-stage.md, D-113) —
// real-Postgres integration tests proving the worker now reaches the
// frozen S4->S5->S6->S7 engine through a deterministic, zero-cost,
// zero-network executor, and that the terminal contract (job.state /
// job.terminationReason / job.errorCode / research_claim_support.status)
// never collapses execution outcome into evidentiary conclusion or vice
// versa.

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
  const slug = uniq("frr_stage1");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "First Real Run Stage 1 project", status: "ACTIVE_CORE" }).returning();
  return project;
}

async function makeUser(): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  return user.id;
}

async function queueJob(
  projectId: string,
  topicId: string,
  entitlement: EntitlementSnapshot,
  demoLifetimeProofLimit = 1000,
): Promise<string> {
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
    demoLifetimeProofLimit,
  });
  return job.id;
}

async function jobRow(jobId: string) {
  const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return row;
}

describe("First Real Run Stage 1 — mapEngineOutcome: terminal contract mapping is pure and total", () => {
  it("BUDGET_EXHAUSTED -> BUDGET_LIMIT_REACHED, distinct from FAILED", () => {
    const outcome = mapEngineOutcome("BUDGET_EXHAUSTED");
    expect(outcome).toEqual({ state: "BUDGET_LIMIT_REACHED", terminationReason: "BUDGET_EXHAUSTED", errorCode: null });
  });

  it("WORK_QUEUE_EXHAUSTED -> SUCCEEDED", () => {
    const outcome = mapEngineOutcome("WORK_QUEUE_EXHAUSTED");
    expect(outcome).toEqual({ state: "SUCCEEDED", terminationReason: "WORK_QUEUE_EXHAUSTED", errorCode: null });
  });

  it("CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK -> SUCCEEDED with the documented errorCode convention", () => {
    const outcome = mapEngineOutcome("CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK");
    expect(outcome).toEqual({ state: "SUCCEEDED", terminationReason: "CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK", errorCode: "CAPABILITY_BOUNDARY" });
  });

  it("INTERRUPTED -> null (non-terminal, resumable, never forced into a terminal state)", () => {
    expect(mapEngineOutcome("INTERRUPTED")).toBeNull();
  });
});

describe("First Real Run Stage 1 — full fake-provider job reaches S7 through the real worker path", () => {
  it("QUEUED -> RUNNING -> terminal, research_claim_support exists, NOT_IMPLEMENTED is gone", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());

    const before = await jobRow(jobId);
    expect(before.state).toBe("QUEUED");

    await handleResearchJobTask(ctx.db, jobId);

    const after = await jobRow(jobId);
    expect(after.state).not.toBe("QUEUED");
    expect(after.state).not.toBe("RUNNING");
    expect(after.errorCode).not.toBe("NOT_IMPLEMENTED");
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(after.state);
    expect(after.terminationReason).toBeTruthy();

    // S7 ran: a research_claim_support row exists for this job, whatever
    // its evidentiary status turned out to be.
    const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(claim).toBeTruthy();
    expect(["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE"]).toContain(claim.status);

    // No live provider was ever reachable: every S4 attempt this job
    // made failed for the fake-executor's own deterministic reason
    // (zero search candidates), never a resolver/credential error that
    // would indicate a real provider was actually resolved and touched.
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) {
      expect(a.reason).not.toMatch(/SEARCH_GATEWAY|CONTENT_FETCHER|QUERY_PROPOSER|EVIDENCE_EXTRACTOR|BRAVE|ANTHROPIC/);
    }

    // No fabricated Evidence — the fake providers never produce a
    // traceable fact, so zero Evidence rows exist for this job.
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev.length).toBe(0);
  });
});

describe("First Real Run Stage 1 — execution failure never masquerades as an evidentiary conclusion", () => {
  it("engine-level MissingActivePatternError (topic has no ACTIVE pattern at execution time) -> FAILED, technical reason preserved, no research_claim_support row", async () => {
    // Phase 5's loadActivePattern (plan-job.ts) does NOT filter on
    // status='ACTIVE' (documented LOW-2 debt, active-pattern.ts) — a
    // DRAFT-only pattern still lets planning succeed. Phase 6's
    // loadActivePatternVersion DOES filter on status='ACTIVE' — the
    // engine step then genuinely throws MissingActivePatternError. This
    // reproduces a real, already-existing system-inconsistency failure
    // mode without any test-only bypass of worker.ts's own logic.
    const activeTopic = await activeTopicId();
    const [activePattern] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, activeTopic));
    const [topic] = await ctx.db.insert(topics).values({ slug: uniq("frr_no_active"), name: "No active pattern (Stage 1 test)", isActive: false }).returning();
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 1, status: "DRAFT", content: activePattern.content });
    const project = await makeProject();
    const jobId = await queueJob(project.id, topic.id, coreEntitlement());

    await handleResearchJobTask(ctx.db, jobId);

    const after = await jobRow(jobId);
    expect(after.state).toBe("FAILED");
    expect(after.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(after.errorCode).toBe("MissingActivePatternError");
    // Never converted into an evidentiary conclusion.
    expect(after.errorCode).not.toBe("INSUFFICIENT_EVIDENCE");
    expect(after.errorCode).not.toBe("NOT_SUPPORTED");

    const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(claim).toBeUndefined();
  });
});

describe("First Real Run Stage 1 — budget exhaustion is distinct from failure", () => {
  it("recovery-budget ceiling reached on a resumed job -> BUDGET_EXHAUSTED, mapped to BUDGET_LIMIT_REACHED (not FAILED)", async () => {
    // The controller's own accounting (controller.ts, MEDIUM-A) only
    // ever hits BUDGET_EXHAUSTED via the RECOVERY-attempt ceiling
    // (reservedRecoverySteps) — a component's FIRST attempt is always
    // covered by the deterministic work-queue-size ceiling, never by a
    // budget number. Recovery attempts only exist for components that
    // already have a prior attempt on record, i.e. a job resumed after
    // an earlier partial run (exactly the crash/resume scenario
    // reservedRecoverySteps exists for) — so this test drives the real
    // engine (runS4ResearchJob, the exact function the worker calls)
    // through two calls for the same job with reservedRecoverySteps=0,
    // then applies the worker's own exported mapping function to the
    // real result, proving the engine+mapping seam end to end.
    const topicId = await activeTopicId();
    const project = await makeProject();
    const zeroRecoveryBudget: EntitlementSnapshot = {
      level: "ARI_CORE",
      capability: "FRESH_RESEARCH",
      budget: { maxSearchQueries: 40, maxSourceOpens: 60, maxModelCostMicro: 4_000_000, maxWallClockSec: 1200, reservedRecoverySteps: 0 },
    };
    const jobId = await queueJob(project.id, topicId, zeroRecoveryBudget);

    await runMemoryPlanningStage(ctx.db, jobId);
    const executor = createNonLiveS4WorkExecutor({ db: ctx.db, project });

    // First call: every pending component gets its one normal attempt;
    // the fake executor deterministically fails every one of them
    // (zero search candidates) -> WORK_QUEUE_EXHAUSTED.
    const first = await runS4ResearchJob(ctx.db, jobId, executor, new Date());
    expect(first.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(first.failed.length).toBeGreaterThan(0);

    // Second call for the SAME job: every still-pending (failed, never
    // succeeded) component now has a prior attempt on record, so the
    // very next claim is a RECOVERY attempt — with
    // reservedRecoverySteps=0, it is immediately budget-exhausted.
    const second = await runS4ResearchJob(ctx.db, jobId, executor, new Date());
    expect(second.stopReason).toBe("BUDGET_EXHAUSTED");

    const mapped = mapEngineOutcome(second.stopReason);
    expect(mapped).toEqual({ state: "BUDGET_LIMIT_REACHED", terminationReason: "BUDGET_EXHAUSTED", errorCode: null });
    expect(mapped?.state).not.toBe("FAILED");

    // Claim support may legitimately be INSUFFICIENT_EVIDENCE here (no
    // evidence was gathered), and that is a successful evidentiary
    // outcome, never converted into a job failure.
    const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(claim).toBeTruthy();
    expect(claim.status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("First Real Run Stage 1 — replay/idempotency: a duplicate worker pickup never duplicates state", () => {
  it("calling handleResearchJobTask a second time after a terminal transition is a pure no-op", async () => {
    const topicId = await activeTopicId();
    const project = await makeProject();
    const jobId = await queueJob(project.id, topicId, coreEntitlement());

    await handleResearchJobTask(ctx.db, jobId);
    const firstOutcome = await jobRow(jobId);
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(firstOutcome.state);

    const attemptsBefore = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    const claimBefore = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));

    // A duplicate pg-boss delivery of the same task, after the job has
    // already left QUEUED — handleResearchJobTask's own guard
    // (`job.state !== "QUEUED"`) makes this a pure no-op.
    await handleResearchJobTask(ctx.db, jobId);

    const secondOutcome = await jobRow(jobId);
    expect(secondOutcome).toEqual(firstOutcome);

    const attemptsAfter = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    const claimAfter = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(attemptsAfter).toEqual(attemptsBefore);
    expect(claimAfter).toEqual(claimBefore);
  });
});
