import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projects,
  proofs,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { WorkExecutor } from "../src/server/engine/controller";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// FAILED RESEARCH FINALIZATION V1.
//
// The first normal live EVM Research (job 2d68c1d5) persisted ten Evidence
// rows and three component results, then S4 threw on a rejected database
// write. The job ended FAILED/SYSTEM_OR_PROVIDER_FAILURE, which is right —
// and this file pins everything that must ALSO be true of such a run:
//
//   * every Evidence row acquired before the fault is retained;
//   * every component S4 actually finished keeps its S5 result;
//   * the component whose attempt was cut off gets NO result row — not
//     INSUFFICIENT_EVIDENCE, nothing;
//   * no mechanism assembly, no claim support and no Proof are written,
//     so no substantive verdict can speak for a run that broke;
//   * the fault propagates unchanged to the worker, which records a
//     technical terminal state and never reruns the job.
//
// TECHNICAL FAILURE != PROJECT REALITY. Absence of completed research is
// not evidence of absence.
//
// The one behaviour that changed: the S5 sweep (the HIGH-2 repair for a
// crash between an attempt's terminal UPDATE and the per-attempt hook's
// persistence) now also runs on the technical-failure path, where it
// previously never ran — and a FAILED job is never picked up again, so it
// could not run later either. It spends nothing and adds no semantics.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-13T12:00:00Z");

// The error class the live run actually died on has no special meaning to
// the engine — it must be handled exactly like any other unexpected
// exception. Named so the worker's `errorCode = e.name` mapping is visible
// in the assertions below.
class RejectedWriteError extends Error {
  constructor() {
    super("simulated rejected database write during S4");
    this.name = "RejectedWriteError";
  }
}

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeJob(opts: { plan: boolean }): Promise<{ jobId: string; projectId: string }> {
  const slug = uniq("failfin");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Failed finalization project", status: "ACTIVE_CORE" })
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
  if (opts.plan) await runMemoryPlanningStage(ctx.db, job.id);
  return { jobId: job.id, projectId: project.id };
}

async function makeSource(): Promise<string> {
  const url = `https://example.com/${uniq("doc")}`;
  const [row] = await ctx.db
    .insert(sources)
    .values({ url, urlHash: `sha256:${url}`, sourceType: "OFFICIAL_DOCS" })
    .returning({ id: sources.id });
  return row.id;
}

// The shape s4-executor.ts persists: an admitted documentary fact filed at
// exactly the (step, component) being executed.
async function insertEvidence(jobId: string, sourceId: string, step: number, component: string): Promise<string> {
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId,
      patternStep: step,
      component,
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: "the protocol fee accrues directly to the treasury contract",
      summary: "protocol fee accrues to the treasury",
      mechanismState: null,
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      fetchedAt: NOW,
      publishedAt: NOW,
      doesNotProve: "does not prove distribution to holders",
      retrievedUrl: "https://example.com/docs",
      contentHash: uniq("hash"),
      extractionUnitKey: uniq("unit"),
    })
    .returning({ id: evidence.id });
  return row.id;
}

async function evidenceFor(jobId: string) {
  return ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
}

async function componentResultsFor(jobId: string) {
  return ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
}

async function attemptsFor(jobId: string) {
  return ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
}

async function projectionsFor(jobId: string) {
  const [assembly, support, proof] = await Promise.all([
    ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId)),
    ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId)),
    ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId)),
  ]);
  return { assembly, support, proof };
}

// Models the live shape exactly: the first component completes and its
// Evidence is persisted; the SECOND component persists one Evidence row
// and then S4 throws mid-attempt, before the attempt reaches a terminal
// status. Everything after it is never attempted.
function crashingExecutor(sourceId: string, beforeThrow?: (jobId: string) => Promise<void>) {
  const calls: string[] = [];
  const executor: WorkExecutor = {
    async execute(item, execCtx) {
      calls.push(`${item.step}:${item.component}`);
      await insertEvidence(execCtx.jobId, sourceId, item.step, item.component);
      if (calls.length === 1) return { status: "SUCCEEDED", reason: "fixture component completed" };
      if (beforeThrow) await beforeThrow(execCtx.jobId);
      throw new RejectedWriteError();
    },
  };
  return { executor, calls };
}

describe("runS4ResearchJob — an unexpected S4 exception keeps finished work and derives nothing substantive", () => {
  it("retains Evidence and completed component results, leaves the interrupted component without a row, writes no S6/S7/S8, and re-throws the same error", async () => {
    const { jobId } = await makeJob({ plan: true });
    const sourceId = await makeSource();
    const { executor, calls } = crashingExecutor(sourceId);

    let caught: unknown = null;
    try {
      await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    } catch (e) {
      caught = e;
    }
    // The fault is the answer — same class, same instance, not wrapped and
    // not swallowed.
    expect(caught).toBeInstanceOf(RejectedWriteError);
    expect(calls.length).toBe(2);
    const [finished, interrupted] = calls;

    // Every Evidence row acquired before the fault is still there — the
    // finished component's AND the interrupted one's.
    const rows = await evidenceFor(jobId);
    expect(rows.length).toBe(2);
    const filed = new Set(rows.map((r) => `${r.patternStep}:${r.component}`));
    expect(filed.has(finished)).toBe(true);
    expect(filed.has(interrupted)).toBe(true);

    // The attempt record says what happened: one terminal, one cut off.
    const attempts = await attemptsFor(jobId);
    expect(attempts.length).toBe(2);
    expect(attempts.find((a) => `${a.patternStep}:${a.component}` === finished)?.status).toBe("SUCCEEDED");
    expect(attempts.find((a) => `${a.patternStep}:${a.component}` === interrupted)?.status).toBe("STARTED");

    // Completed work keeps its S5 result; the interrupted component has
    // NONE — not INSUFFICIENT_EVIDENCE, no row. "Work never finished" and
    // "the evidence is insufficient" stay different findings.
    const results = await componentResultsFor(jobId);
    expect(results.length).toBe(1);
    expect(`${results[0].patternStep}:${results[0].component}`).toBe(finished);
    expect(results[0].supportingEvidenceIds).toHaveLength(1);

    // Nothing substantive was derived from a run that broke.
    const { assembly, support, proof } = await projectionsFor(jobId);
    expect(assembly.length).toBe(0);
    expect(support.length).toBe(0);
    expect(proof.length).toBe(0);

    // Nothing here writes a terminal state — that stays the worker's job.
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.state).toBe("QUEUED");
  });

  it("the S5 sweep runs on the technical-failure path: a finished component whose per-attempt result was lost is reconciled again from its persisted Evidence", async () => {
    const { jobId } = await makeJob({ plan: true });
    const sourceId = await makeSource();

    // Simulate the crash window the per-attempt hook cannot survive: the
    // first component's attempt is terminal and its Evidence is persisted,
    // but its research_component_results row is gone when the fault hits.
    // Done directly against the DB, from inside the second attempt, so the
    // row is absent at exactly the moment the exception propagates.
    let firstKey: { step: number; component: string } | null = null;
    const { executor, calls } = crashingExecutor(sourceId, async (id) => {
      const [first] = await componentResultsFor(id);
      expect(first).toBeDefined();
      firstKey = { step: first.patternStep, component: first.component };
      await ctx.db
        .delete(researchComponentResults)
        .where(
          and(
            eq(researchComponentResults.researchJobId, id),
            eq(researchComponentResults.patternStep, first.patternStep),
            eq(researchComponentResults.component, first.component),
          ),
        );
      expect((await componentResultsFor(id)).length).toBe(0);
    });

    await expect(runS4ResearchJob(ctx.db, jobId, executor, NOW)).rejects.toBeInstanceOf(RejectedWriteError);
    expect(calls.length).toBe(2);
    expect(firstKey).not.toBeNull();

    // Reconciled again — from persisted Evidence, with no new attempt and
    // no executor call (calls is still 2).
    const results = await componentResultsFor(jobId);
    expect(results.length).toBe(1);
    expect(results[0].patternStep).toBe(firstKey!.step);
    expect(results[0].component).toBe(firstKey!.component);
    expect(results[0].supportingEvidenceIds).toHaveLength(1);

    // And still no projection of any kind.
    const { assembly, support, proof } = await projectionsFor(jobId);
    expect(assembly.length + support.length + proof.length).toBe(0);
  });

  it("a fault before ANY component finished leaves nothing behind but the retained Evidence — no component result is invented", async () => {
    const { jobId } = await makeJob({ plan: true });
    const sourceId = await makeSource();
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, item.step, item.component);
        throw new RejectedWriteError();
      },
    };

    await expect(runS4ResearchJob(ctx.db, jobId, executor, NOW)).rejects.toBeInstanceOf(RejectedWriteError);

    expect((await evidenceFor(jobId)).length).toBe(1);
    expect((await componentResultsFor(jobId)).length).toBe(0);
    const { assembly, support, proof } = await projectionsFor(jobId);
    expect(assembly.length + support.length + proof.length).toBe(0);
  });
});

describe("worker — the technical terminal state, and no rerun", () => {
  it("maps the fault to FAILED/SYSTEM_OR_PROVIDER_FAILURE with the error's name, keeps the partial work, and a redelivery does no work at all", async () => {
    const { jobId } = await makeJob({ plan: false });
    const sourceId = await makeSource();
    const { executor, calls } = crashingExecutor(sourceId);

    const first = await handleResearchJobTask(ctx.db, jobId, executor);
    expect(first).toEqual({ claimed: true });

    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    // A fault of the run, typed as one — never BUDGET_LIMIT_REACHED, never
    // SUCCEEDED, never an evidentiary reason.
    expect(job.state).toBe("FAILED");
    expect(job.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(job.errorCode).toBe("RejectedWriteError");
    expect(job.finishedAt).not.toBeNull();

    // The partial work survived the terminal write.
    expect((await evidenceFor(jobId)).length).toBe(2);
    expect((await componentResultsFor(jobId)).length).toBe(1);
    const { support, proof } = await projectionsFor(jobId);
    expect(support.length).toBe(0);
    expect(proof.length).toBe(0);

    // No crash loop: a redelivered message finds the job no longer QUEUED
    // and returns before any planning, attempt or executor call.
    const again = await handleResearchJobTask(ctx.db, jobId, executor);
    expect(again).toEqual({ claimed: false, reason: "NOT_QUEUED" });
    expect(calls.length).toBe(2);
    expect((await attemptsFor(jobId)).length).toBe(2);
    const [after] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(after.state).toBe("FAILED");
  });
});
