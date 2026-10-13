import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  projects,
  proofs,
  researchJobs,
  researchQuestionProjections,
  topics,
  users,
} from "../src/server/db/schema";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import type { WorkExecutor } from "../src/server/engine/controller";
import { PROJECTION_VERSION, type ProjectionModelInput } from "../src/server/engine/question-projection";
import {
  generateQuestionProjection,
  generateQuestionProjectionSafely,
} from "../src/server/engine/question-projection-store";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { claimResearchJob, createResearchJob, transitionJobState } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// QUESTION PROJECTION LIFECYCLE V1.
//
// The projection store admits only a job whose persisted state is
// SUCCEEDED or BUDGET_LIMIT_REACHED. The call used to sit at the end of
// runS4ResearchJob — while the job is still RUNNING, because the worker
// writes the terminal state only after that function returns — so every
// normal run answered NOT_PROJECTABLE and no row was ever written (live
// jobs dd092896 and a118fb74, both with a Proof and no projection row).
//
// The call now runs from the worker, after its terminal transaction has
// committed. These tests pin the lifecycle from both sides:
//
//   RUNNING            -> refused, no row (the guard is unchanged)
//   SUCCEEDED + Proof  -> generated, one row
//   BUDGET_LIMIT       -> generated (the store already permitted it)
//   FAILED             -> refused, no row (a broken run has nothing to
//                         arrange)
//   re-entry           -> ALREADY_EXISTS, still one row
//   projection failure -> its own row only; the job, its state and its
//                         Proof are untouched
//
// The test environment holds no ANTHROPIC_API_KEY (tests/setup-provider-env
// scrubs it), so the worker's real projector refuses before any network
// and the store persists FAILED_MODEL — which is exactly the terminal,
// never-retried row the design requires, and proves the lifecycle point
// without a model. VALID generation is proven through the store's own
// provider seam. Nothing here is project-, chain- or EVM-specific.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-13T16:00:00Z");

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeJob(): Promise<string> {
  const slug = uniq("qproj");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Projection lifecycle project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: await activeTopicId(),
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "does protocol revenue reach token holders" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

// Every component completes (with no evidence) — enough for S5/S6/S7 to run
// and S8 to write a Proof, which is all the projection needs as input.
const COMPLETING: WorkExecutor = {
  async execute() {
    return { status: "SUCCEEDED", reason: "fixture component completed" };
  },
};

async function projectionRows(jobId: string) {
  return ctx.db
    .select()
    .from(researchQuestionProjections)
    .where(eq(researchQuestionProjections.researchJobId, jobId));
}

async function jobRow(jobId: string) {
  const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return row;
}

async function proofRow(jobId: string) {
  const [row] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  return row;
}

// A provider that answers with two well-formed findings over whatever
// components it was given — never a status, never an invented reference.
function fixtureProjector(calls: { n: number }) {
  return {
    name: "fixture-projector",
    async project(input: ProjectionModelInput) {
      calls.n += 1;
      const [a, b] = input.components;
      return {
        findings: [
          { userFacingLabel: "Where does the value come from?", primaryRef: { kind: "COMPONENT", step: a.step, component: a.component }, supportingRefs: [] },
          { userFacingLabel: "Which path does it take?", primaryRef: { kind: "COMPONENT", step: b.step, component: b.component }, supportingRefs: [] },
        ],
      };
    },
  };
}

describe("question projection — the lifecycle point is the terminal state", () => {
  it("1. the normal worker path: terminal state written, then exactly one projection row exists", async () => {
    const jobId = await makeJob();
    await handleResearchJobTask(ctx.db, jobId, COMPLETING);

    const job = await jobRow(jobId);
    expect(job.state).toBe("SUCCEEDED");
    expect(await proofRow(jobId)).toBeDefined();

    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].projectionVersion).toBe(PROJECTION_VERSION);
    // No key in the test environment: the real projector refused before
    // any network call and the store persisted the terminal failure. The
    // row's existence is the point — before the fix there was none.
    expect(rows[0].status).toBe("FAILED_MODEL");
    expect(rows[0].findings).toEqual([]);
  });

  it("3. RUNNING is still refused: a job with a Proof but no terminal state gets no row, and the same job projects once its state is terminal", async () => {
    const jobId = await makeJob();
    await runMemoryPlanningStage(ctx.db, jobId);
    await claimResearchJob(ctx.db, jobId);
    // The engine on its own: S4..S8 complete, a Proof exists, and the job
    // is exactly where the old call site saw it — RUNNING.
    await runS4ResearchJob(ctx.db, jobId, COMPLETING, NOW);
    expect((await jobRow(jobId)).state).toBe("RUNNING");
    expect(await proofRow(jobId)).toBeDefined();

    const calls = { n: 0 };
    const whileRunning = await generateQuestionProjection(ctx.db, jobId, { provider: fixtureProjector(calls) });
    expect(whileRunning).toEqual({ kind: "SKIPPED", reason: "NOT_PROJECTABLE" });
    expect(calls.n).toBe(0);
    expect((await projectionRows(jobId)).length).toBe(0);

    // The worker's terminal write, then the same call: generated.
    await transitionJobState(ctx.db, jobId, "SUCCEEDED", "test: terminal");
    const afterTerminal = await generateQuestionProjection(ctx.db, jobId, { provider: fixtureProjector(calls) });
    expect(afterTerminal).toEqual({ kind: "VALID", findingCount: 2 });
    expect(calls.n).toBe(1);
    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("VALID");
  });

  it("2. BUDGET_LIMIT_REACHED: the existing semantics permit a projection, and the worker path now produces one", async () => {
    const jobId = await makeJob();
    let n = 0;
    const executor: WorkExecutor = {
      async execute() {
        n += 1;
        if (n <= 2) return { status: "SUCCEEDED", reason: "fixture component completed" };
        throw new BudgetExhaustedError("searchQueries", "SEARCH_QUERY_BUDGET_EXHAUSTED");
      },
    };
    await handleResearchJobTask(ctx.db, jobId, executor);

    const job = await jobRow(jobId);
    expect(job.state).toBe("BUDGET_LIMIT_REACHED");
    expect(job.terminationReason).toBe("BUDGET_EXHAUSTED");
    // D-127 built the Proof on the budget path; the projection follows it.
    expect(await proofRow(jobId)).toBeDefined();
    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("FAILED_MODEL");
  });

  it("4. FAILED technical Research: no projection row of any kind", async () => {
    const jobId = await makeJob();
    let n = 0;
    const executor: WorkExecutor = {
      async execute() {
        n += 1;
        if (n === 1) return { status: "SUCCEEDED", reason: "fixture component completed" };
        throw new Error("simulated rejected database write during S4");
      },
    };
    await handleResearchJobTask(ctx.db, jobId, executor);

    const job = await jobRow(jobId);
    expect(job.state).toBe("FAILED");
    expect(job.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(await proofRow(jobId)).toBeUndefined();
    expect((await projectionRows(jobId)).length).toBe(0);

    // Even asked directly with a willing provider, the store refuses.
    const calls = { n: 0 };
    const direct = await generateQuestionProjection(ctx.db, jobId, { provider: fixtureProjector(calls) });
    expect(direct).toEqual({ kind: "SKIPPED", reason: "NOT_PROJECTABLE" });
    expect(calls.n).toBe(0);
    expect((await projectionRows(jobId)).length).toBe(0);
  });

  it("5. idempotent: re-entry after the worker path answers ALREADY_EXISTS, makes no call, and leaves one row", async () => {
    const jobId = await makeJob();
    await handleResearchJobTask(ctx.db, jobId, COMPLETING);
    expect((await projectionRows(jobId)).length).toBe(1);

    // A redelivered message does no work at all — it never reaches the
    // projection.
    const again = await handleResearchJobTask(ctx.db, jobId, COMPLETING);
    expect(again).toEqual({ claimed: false, reason: "NOT_QUEUED" });
    expect((await projectionRows(jobId)).length).toBe(1);

    // And a direct re-entry is gated by the (job, version) slot: no model
    // call, no second row, whatever provider is offered.
    const calls = { n: 0 };
    const outcome = await generateQuestionProjection(ctx.db, jobId, { provider: fixtureProjector(calls) });
    expect(outcome).toEqual({ kind: "SKIPPED", reason: "ALREADY_EXISTS" });
    expect(calls.n).toBe(0);
    expect((await projectionRows(jobId)).length).toBe(1);
  });

  it("6. a projection failure after the terminal state changes nothing about the Research", async () => {
    const jobId = await makeJob();
    await runMemoryPlanningStage(ctx.db, jobId);
    await claimResearchJob(ctx.db, jobId);
    await runS4ResearchJob(ctx.db, jobId, COMPLETING, NOW);
    await transitionJobState(ctx.db, jobId, "SUCCEEDED", "test: terminal");
    const before = await jobRow(jobId);
    const proofBefore = await proofRow(jobId);
    expect(proofBefore).toBeDefined();

    // The provider breaks in the ordinary way (a thrown provider error)…
    const broken = {
      name: "broken-projector",
      async project() {
        throw new Error("provider exploded");
      },
    };
    const outcome = await generateQuestionProjectionSafely(ctx.db, jobId, { provider: broken });
    expect(outcome).toEqual({ kind: "FAILED_MODEL" });

    // …its failure is its own row, and the Research is byte-for-byte what
    // it was: state, reason, timestamps, Proof id and verdict.
    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("FAILED_MODEL");
    const after = await jobRow(jobId);
    expect(after.state).toBe("SUCCEEDED");
    expect(after.terminationReason).toBe(before.terminationReason);
    expect(after.errorCode).toBe(before.errorCode);
    expect(after.finishedAt?.toISOString()).toBe(before.finishedAt?.toISOString());
    const proofAfter = await proofRow(jobId);
    expect(proofAfter?.id).toBe(proofBefore?.id);
    expect(proofAfter?.verdict).toBe(proofBefore?.verdict);

    // And the failure occupies the slot: nothing retries it.
    const calls = { n: 0 };
    const retry = await generateQuestionProjection(ctx.db, jobId, { provider: fixtureProjector(calls) });
    expect(retry).toEqual({ kind: "SKIPPED", reason: "ALREADY_EXISTS" });
    expect(calls.n).toBe(0);
  });

  it("8. no chain, project or intent special-case decides the lifecycle: the store reads only job state, Proof and component rows", async () => {
    const { readFileSync } = await import("node:fs");
    const store = readFileSync("src/server/engine/question-projection-store.ts", "utf-8");
    const worker = readFileSync("src/server/jobs/worker.ts", "utf-8");
    for (const literal of ["ethereum", "solana", "lido", "pump_fun", "EVM", "TOKEN_SUPPLY"]) {
      expect(store, literal).not.toContain(literal);
    }
    // The worker gates nothing itself — the store's guard is the only
    // policy, so both worker paths call the same function unconditionally
    // after their terminal write.
    const single = worker.indexOf("generateQuestionProjectionSafely(\n    db,\n    jobId,");
    const phased = worker.indexOf("generateQuestionProjectionSafely(ctx.db, jobId)");
    expect(single).toBeGreaterThan(-1);
    expect(phased).toBeGreaterThan(-1);
    for (const at of [single, phased]) {
      const preceding = worker.slice(Math.max(0, at - 400), at);
      expect(preceding).not.toMatch(/if \(.*state.*SUCCEEDED/);
    }
    // The unique slot is the schema's, not a convention.
    const schema = readFileSync("src/server/db/schema/projection.ts", "utf-8");
    expect(schema).toContain("uq_research_question_projections_job_version");
    // Guard unchanged: RUNNING and FAILED are outside it.
    expect(store).toContain('if (job.state !== "SUCCEEDED" && job.state !== "BUDGET_LIMIT_REACHED")');
  });
});
