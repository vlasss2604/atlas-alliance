import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquiredDocuments,
  projects,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { PHASE_QUEUE } from "../src/server/jobs/queue";
import { claimResearchJob, createResearchJob } from "../src/server/jobs/research-jobs";
import { reconcileExhaustedPhaseDeliveries } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// A BOUNDED QUEUE FAILURE MUST NOT ORPHAN A RESEARCH.
//
// A phase hands off through a queue message with a bounded retry budget.
// When that budget is spent pg-boss moves the message to `failed`, and
// before this reconciler existed the owning research stayed RUNNING with a
// phase set forever: nothing would ever deliver it again, and D-139's stale
// sweep excludes phased jobs by design. Finite retries are correct; an
// orphaned RUNNING job is not.
//
// These tests drive the real queue rows rather than mocking them, because
// the whole predicate IS persisted queue state.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function makeProject() {
  const slug = uniq("d147");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D147 Fixture", status: "ACTIVE_CORE" })
    .returning();
  return project;
}

// A phased job parked in the given phase, exactly as the engine parks one.
async function makePhasedJob(phase: "FETCHING" | "EXTRACTING") {
  const project = await makeProject();
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  // QUEUED -> RUNNING (the engine's own atomic claim), then parked in the
  // phase. Done directly rather than through beginAcquisitionPhases so the
  // fixture does not also enqueue a SEARCHING message it does not want.
  await claimResearchJob(ctx.db, job.id);
  await ctx.db
    .update(researchJobs)
    .set({ acquisitionPhase: phase, acquisitionPhaseAt: new Date() })
    .where(eq(researchJobs.id, job.id));
  return { job, project };
}

// Writes one queue row in a chosen state for a job. Mirrors what pg-boss
// itself leaves behind after a delivery reaches that state.
async function putQueueRow(
  queue: string,
  jobId: string,
  state: "created" | "retry" | "active" | "failed" | "completed",
) {
  await ctx.db.execute(sql`
    INSERT INTO pgboss.job (name, data, state, retry_limit, retry_count, start_after, started_on, completed_on, keep_until)
    VALUES (
      ${queue},
      ${JSON.stringify({ jobId })}::jsonb,
      ${state}::pgboss.job_state,
      2,
      ${state === "failed" ? 2 : 0},
      now(),
      ${state === "created" ? null : sql`now()`},
      ${state === "failed" || state === "completed" ? sql`now()` : null},
      now() + interval '14 days'
    )
  `);
}

async function stateOf(jobId: string) {
  const [row] = await ctx.db
    .select({
      state: researchJobs.state,
      phase: researchJobs.acquisitionPhase,
      terminationReason: researchJobs.terminationReason,
      errorCode: researchJobs.errorCode,
      sourceOpens: researchJobs.sourceOpensReserved,
    })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row;
}

async function queueRowCount(queue: string, jobId: string): Promise<number> {
  const r = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pgboss.job
     WHERE name = ${queue} AND data->>'jobId' = ${jobId}
  `);
  return Number(r.rows[0].n);
}

describe("exhausted phase delivery terminates the research", () => {
  for (const phase of ["FETCHING", "EXTRACTING"] as const) {
    it(`${phase}: a terminally failed delivery with no successor fails the job as a product failure`, async () => {
      const { job, project } = await makePhasedJob(phase);
      const queue = PHASE_QUEUE[phase];

      // Partial work the run had already banked — it must survive.
      await ctx.db
        .update(researchJobs)
        .set({ sourceOpensReserved: 20 })
        .where(eq(researchJobs.id, job.id));
      await ctx.db.insert(acquiredDocuments).values({
        projectId: project.id,
        acquiringJobId: job.id,
        url: "https://docs.example.test/a",
        finalUrl: "https://docs.example.test/a",
        httpStatus: 200,
        contentType: "text/html",
        byteLength: 10,
        normalizedText: "kept",
        contentHash: "sha256:keep",
        textSha256: "0".repeat(64),
        authority: { officiality: "CLAIMED", routeClass: null, matchedPathPrefix: null },
        acquisitionStrategy: "CONTENT_NEGOTIATION",
        admission: "PRODUCT_ACQUISITION",
      });
      await ctx.db.insert(researchTraceEvents).values({
        researchJobId: job.id,
        sequence: 1,
        operationType: "FETCH_ATTEMPTED",
        providerKind: "FETCH",
        providerName: "safe-http",
        targetRef: "https://docs.example.test/a",
        status: "OK",
      });

      // The delivery ran out of retries and pg-boss made it terminal.
      await putQueueRow(queue, job.id, "failed");

      expect((await stateOf(job.id)).state).toBe("RUNNING");
      const n = await reconcileExhaustedPhaseDeliveries(ctx.db);
      expect(n).toBe(1);

      const after = await stateOf(job.id);
      // Terminated, and terminated as what it is.
      expect(after.state).toBe("FAILED");
      expect(after.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
      expect(after.errorCode).toBe("PHASE_DELIVERY_EXHAUSTED");
      // Never an evidentiary verdict — this says nothing about the project.
      expect(after.terminationReason).not.toBe("INSUFFICIENT_EVIDENCE");
      expect(after.state).not.toBe("SUCCEEDED");

      // Partial work preserved: documents, trace, ledger, phase history.
      const docs = await ctx.db
        .select()
        .from(acquiredDocuments)
        .where(eq(acquiredDocuments.acquiringJobId, job.id));
      expect(docs).toHaveLength(1);
      expect(docs[0].acquisitionStrategy).toBe("CONTENT_NEGOTIATION");
      const trace = await ctx.db
        .select()
        .from(researchTraceEvents)
        .where(eq(researchTraceEvents.researchJobId, job.id));
      expect(trace.length).toBeGreaterThan(0);
      expect(after.sourceOpens).toBe(20);
      expect(after.phase).toBe(phase);

      // No delivery was manufactured: still exactly the one failed row.
      expect(await queueRowCount(queue, job.id)).toBe(1);

      // Idempotent — a second pass finds nothing, because the job is no
      // longer RUNNING.
      expect(await reconcileExhaustedPhaseDeliveries(ctx.db)).toBe(0);
    });
  }

  it("does NOT fail a job whose failed delivery was superseded by a runnable one", async () => {
    const { job } = await makePhasedJob("FETCHING");
    const queue = PHASE_QUEUE.FETCHING;

    // An old exhausted delivery AND a legitimate newer one.
    await putQueueRow(queue, job.id, "failed");
    await putQueueRow(queue, job.id, "created");

    expect(await reconcileExhaustedPhaseDeliveries(ctx.db)).toBe(0);
    expect((await stateOf(job.id)).state).toBe("RUNNING");
  });

  for (const live of ["active", "retry"] as const) {
    it(`does NOT fail a job whose delivery is ${live}`, async () => {
      const { job } = await makePhasedJob("FETCHING");
      await putQueueRow(PHASE_QUEUE.FETCHING, job.id, "failed");
      await putQueueRow(PHASE_QUEUE.FETCHING, job.id, live);

      expect(await reconcileExhaustedPhaseDeliveries(ctx.db)).toBe(0);
      expect((await stateOf(job.id)).state).toBe("RUNNING");
    });
  }

  it("does NOT fail a job with no failed delivery at all", async () => {
    const { job } = await makePhasedJob("FETCHING");
    // Nothing terminal recorded — say nothing rather than guess.
    expect(await reconcileExhaustedPhaseDeliveries(ctx.db)).toBe(0);
    expect((await stateOf(job.id)).state).toBe("RUNNING");
  });

  it("does NOT fail on a failed delivery belonging to a DIFFERENT phase's queue", async () => {
    const { job } = await makePhasedJob("FETCHING");
    // The job is parked in FETCHING; an old EXTRACT-queue failure is not
    // authoritative for the phase it is actually in.
    await putQueueRow(PHASE_QUEUE.EXTRACTING, job.id, "failed");

    expect(await reconcileExhaustedPhaseDeliveries(ctx.db)).toBe(0);
    expect((await stateOf(job.id)).state).toBe("RUNNING");
  });

  it("does NOT touch a non-phased RUNNING job (D-139 keeps that path)", async () => {
    const { job } = await makePhasedJob("FETCHING");
    await ctx.db
      .update(researchJobs)
      .set({ acquisitionPhase: null })
      .where(eq(researchJobs.id, job.id));
    await putQueueRow(PHASE_QUEUE.FETCHING, job.id, "failed");

    expect(await reconcileExhaustedPhaseDeliveries(ctx.db)).toBe(0);
    expect((await stateOf(job.id)).state).toBe("RUNNING");
  });
});
