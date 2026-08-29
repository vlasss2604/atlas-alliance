import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projects, researchJobs, topics, users } from "../src/server/db/schema";
import {
  advancePhaseAndEnqueue,
  beginAcquisitionPhases,
} from "../src/server/jobs/acquisition-phase-worker";
import { claimResearchJob, createResearchJob } from "../src/server/jobs/research-jobs";
import { sweepStaleRunningJobs } from "../src/server/jobs/worker";
import type { AcquisitionPhase } from "../src/server/jobs/worker-capabilities";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-139 — THE LEGACY STALE SWEEP IS FOR SINGLE-PROCESS JOBS ONLY.
//
// The incident: a real phased job finished SEARCHING, advanced to
// FETCHING, and sat in the fetch queue while the operator switched the
// machine's network. 29 minutes later the FETCH worker started, ran
// sweepStaleRunningJobs at startup, decided the job had been "running"
// for longer than maxWallClockSec × 1.5, and killed it — 107 ms before
// its own fetch message was dequeued.
//
// The formula was never wrong for what it was written for. It was asked a
// question it cannot answer: for a phased job, RUNNING includes time
// PARKED between capability phases, and parked time is not execution
// time.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// budget_core.maxWallClockSec = 1200 → the legacy threshold is 1800s.
const WALL_CLOCK_SEC = coreEntitlement().budget.maxWallClockSec;
const THRESHOLD_SEC = (WALL_CLOCK_SEC * 3) / 2;

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeProject() {
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("d139"), name: "D139 Fixture", status: "ACTIVE_CORE" })
    .returning();
  return p;
}

// A RUNNING job whose execution began `agoSec` seconds ago. Claimed
// through the real atomic claim (QUEUED -> RUNNING), then back-dated —
// started_at is not a state change, so the state-machine trigger is not
// involved and nothing about the transition is faked.
async function makeRunningJob(opts: { agoSec: number; phased?: boolean }): Promise<string> {
  const topicId = await activeTopicId();
  const project = await makeProject();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    // A phased job is admitted the way the product admits one: no legacy
    // entry message, phase and first message in the same transaction.
    opts.phased ? { phased: true } : { skipEnqueue: true },
  );
  await claimResearchJob(ctx.db, job.id);
  await ctx.db
    .update(researchJobs)
    .set({ startedAt: sql`now() - make_interval(secs => ${opts.agoSec})` })
    .where(eq(researchJobs.id, job.id));
  return job.id;
}

async function stateOf(jobId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ state: researchJobs.state })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row.state;
}

async function phaseOf(jobId: string): Promise<AcquisitionPhase | null> {
  const [row] = await ctx.db
    .select({ phase: researchJobs.acquisitionPhase })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row.phase;
}

// Drives a phased job to the given phase through the real production
// primitives, never a raw UPDATE.
async function phasedJobAt(phase: AcquisitionPhase, agoSec: number): Promise<string> {
  const jobId = await makeRunningJob({ agoSec, phased: true });
  expect(await phaseOf(jobId)).toBe("SEARCHING");
  if (phase === "FETCHING" || phase === "EXTRACTING") {
    expect(await advancePhaseAndEnqueue(ctx.db, ctx.boss, jobId, "SEARCHING", "FETCHING")).toBe(true);
  }
  if (phase === "EXTRACTING") {
    expect(await advancePhaseAndEnqueue(ctx.db, ctx.boss, jobId, "FETCHING", "EXTRACTING")).toBe(true);
  }
  expect(await phaseOf(jobId)).toBe(phase);
  return jobId;
}

describe("D-139 §1 — the legacy sweep still does its job (items 1, 2, 8)", () => {
  it("1. a single-process job past the threshold is still swept", async () => {
    const jobId = await makeRunningJob({ agoSec: THRESHOLD_SEC + 120 });
    expect(await stateOf(jobId)).toBe("RUNNING");

    await sweepStaleRunningJobs(ctx.db);

    expect(await stateOf(jobId)).toBe("FAILED");
    // And it is still reachable as a reason, in the journal the trigger
    // writes — the note the sweep has always used.
    const rows = await ctx.db.execute(
      sql`SELECT note FROM research_job_transitions
          WHERE job_id = ${jobId} AND to_state = 'FAILED'`,
    );
    expect((rows.rows[0] as { note: string }).note).toBe("stale RUNNING sweep");
  });

  it("2. a single-process job below the threshold is left alone", async () => {
    const jobId = await makeRunningJob({ agoSec: THRESHOLD_SEC - 300 });
    await sweepStaleRunningJobs(ctx.db);
    expect(await stateOf(jobId)).toBe("RUNNING");
  });

  it("8. the timeout formula is unchanged: 1.4x survives, 1.6x does not", async () => {
    const under = await makeRunningJob({ agoSec: Math.floor(WALL_CLOCK_SEC * 1.4) });
    const over = await makeRunningJob({ agoSec: Math.floor(WALL_CLOCK_SEC * 1.6) });

    await sweepStaleRunningJobs(ctx.db);

    expect(await stateOf(under)).toBe("RUNNING");
    expect(await stateOf(over)).toBe("FAILED");

    // The formula itself, unchanged in the source: budget × 3 / 2.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/jobs/worker.ts", "utf-8");
    expect(src).toContain("'maxWallClockSec')::int * 3) / 2");
  });
});

describe("D-139 §2 — a phased job is never judged by that formula (items 3, 4, 5, 6)", () => {
  it("3. a phased job parked in SEARCHING past the legacy threshold is NOT swept", async () => {
    const jobId = await phasedJobAt("SEARCHING", THRESHOLD_SEC + 600);
    await sweepStaleRunningJobs(ctx.db);
    expect(await stateOf(jobId)).toBe("RUNNING");
    expect(await phaseOf(jobId)).toBe("SEARCHING");
  });

  it("4. a phased job parked in FETCHING past the legacy threshold is NOT swept", async () => {
    // The exact shape of the real incident: SEARCHING done, FETCHING
    // queued, the operator switching networks for half an hour.
    const jobId = await phasedJobAt("FETCHING", THRESHOLD_SEC + 900);
    await sweepStaleRunningJobs(ctx.db);
    expect(await stateOf(jobId)).toBe("RUNNING");
    expect(await phaseOf(jobId)).toBe("FETCHING");
  });

  it("5. a phased job in EXTRACTING past the legacy threshold is NOT swept by this mechanism", async () => {
    const jobId = await phasedJobAt("EXTRACTING", THRESHOLD_SEC + 900);
    await sweepStaleRunningJobs(ctx.db);
    expect(await stateOf(jobId)).toBe("RUNNING");
  });

  it("6. exclusion follows the PERSISTED phase alone — the same job, one column apart", async () => {
    const jobId = await makeRunningJob({ agoSec: THRESHOLD_SEC + 600, phased: true });
    await sweepStaleRunningJobs(ctx.db);
    expect(await stateOf(jobId)).toBe("RUNNING");

    // Clear the phase and nothing else: it is now a single-process job by
    // the only criterion the sweep uses, and the same call sweeps it.
    await ctx.db
      .update(researchJobs)
      .set({ acquisitionPhase: null })
      .where(eq(researchJobs.id, jobId));
    await sweepStaleRunningJobs(ctx.db);
    expect(await stateOf(jobId)).toBe("FAILED");
  });

  it("6/7. the sweep reads no role, no capability and nothing about the network", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/jobs/worker.ts", "utf-8");
    const fn = src.slice(
      src.indexOf("export async function sweepStaleRunningJobs"),
      src.indexOf("export type HandleResearchJobTaskResult"),
    );
    expect(fn).toContain("acquisitionPhase} IS NULL");
    for (const forbidden of [
      "capabilities",
      "workerServesPhase",
      "PhaseCapability",
      "ATLAS_WORKER_CAPABILITIES",
      "mantaray",
      "vpn",
      "proxy",
      "region",
    ]) {
      expect(fn.toLowerCase(), `sweep must not consult ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    // Its only argument is the database — there is nowhere for a role to
    // enter even if someone wanted one.
    expect(fn).toContain("sweepStaleRunningJobs(db: Database)");
  });

  it("a mixed population is separated correctly in one pass", async () => {
    const legacyStale = await makeRunningJob({ agoSec: THRESHOLD_SEC + 60 });
    const legacyFresh = await makeRunningJob({ agoSec: 60 });
    const phasedStale = await phasedJobAt("FETCHING", THRESHOLD_SEC + 60);

    await sweepStaleRunningJobs(ctx.db);

    expect(await stateOf(legacyStale)).toBe("FAILED");
    expect(await stateOf(legacyFresh)).toBe("RUNNING");
    expect(await stateOf(phasedStale)).toBe("RUNNING");
  });
});

describe("D-139 §3 — the explanation is readable (item 15)", () => {
  it("15. the operator inspector prints the transition journal, so a swept job explains itself", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("scripts/alpha-inspect.ts", "utf-8");
    // The journal is read and printed inside the TERMINATION section.
    const section = src.slice(src.indexOf('section("TERMINATION")'), src.indexOf('section("WARNINGS")'));
    expect(section).toContain("researchJobTransitions");
    expect(section).toContain("t.note");
    // Still read-only: no write of any kind was added.
    for (const forbidden of ["insert(", "update(", "delete("]) {
      expect(src, `alpha-inspect must stay read-only (${forbidden})`).not.toContain(forbidden);
    }
  });

  it("the journal really does carry the reason a swept job stopped", async () => {
    const jobId = await makeRunningJob({ agoSec: THRESHOLD_SEC + 60 });
    await sweepStaleRunningJobs(ctx.db);

    const rows = await ctx.db.execute(
      sql`SELECT from_state, to_state, note FROM research_job_transitions
          WHERE job_id = ${jobId} ORDER BY at`,
    );
    const journal = rows.rows as { from_state: string; to_state: string; note: string | null }[];
    expect(journal.map((r) => `${r.from_state}->${r.to_state}`)).toEqual([
      "QUEUED->RUNNING",
      "RUNNING->FAILED",
    ]);
    expect(journal[1].note).toBe("stale RUNNING sweep");
  });
});
