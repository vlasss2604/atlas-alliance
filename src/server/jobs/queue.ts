import { and, eq, sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";

import type { Transaction } from "../db/client";
import { researchJobs } from "../db/schema";
import type { AcquisitionPhase } from "./worker-capabilities";

export const RESEARCH_QUEUE = "research";

// D-136 — one queue per phase HANDOFF, not per job. The entry queue keeps
// its existing name and its existing meaning (a job to be started), so
// nothing that already sends to it changes; the two new queues carry a
// job that has already been started and has already advanced its
// persisted phase. A worker subscribes only to the queues its configured
// capabilities can serve (worker-capabilities.ts) — the queue name is the
// routing, and the process never inspects the network to decide.
export const RESEARCH_FETCH_QUEUE = "research-fetch";
export const RESEARCH_EXTRACT_QUEUE = "research-extract";

// Which queue carries each phase. Exhaustive by type: a new phase will
// not compile until it is given a queue here.
export const PHASE_QUEUE: Record<AcquisitionPhase, string> = {
  SEARCHING: RESEARCH_QUEUE,
  FETCHING: RESEARCH_FETCH_QUEUE,
  EXTRACTING: RESEARCH_EXTRACT_QUEUE,
};

export const ALL_RESEARCH_QUEUES = [
  RESEARCH_QUEUE,
  RESEARCH_FETCH_QUEUE,
  RESEARCH_EXTRACT_QUEUE,
] as const;

// The ONLY payload any research queue carries: a persisted identifier.
// Never a document, a candidate list, model output, a raw url or an
// Evidence object — the receiving worker reloads every piece of state it
// needs from the database, so a message can never smuggle in something
// that did not go through the persisted, bounded path.
export interface ResearchQueuePayload {
  jobId: string;
}

export function createBoss(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new PgBoss({ connectionString });
}

// Транзакционный enqueue: задача pg-boss пишется тем же клиентом, что и
// INSERT research_jobs + резервация квоты. Нет коммита — нет задачи.
export async function enqueueResearchJobInTx(
  boss: PgBoss,
  tx: Transaction,
  jobId: string,
): Promise<void> {
  await boss.send(RESEARCH_QUEUE, { jobId }, { db: fromDrizzle(tx, sql) });
}

// D-136 — the same transactional discipline, for a phase handoff: the
// queue message for the NEXT phase is written by the same client (and
// therefore the same transaction) that advanced the persisted phase.
// Neither half can outlive the other.
export async function enqueueAcquisitionPhaseInTx(
  boss: PgBoss,
  tx: Transaction,
  jobId: string,
  phase: AcquisitionPhase,
): Promise<void> {
  await boss.send(PHASE_QUEUE[phase], { jobId }, { db: fromDrizzle(tx, sql) });
}

// D-138 — THE FIRST PHASE, WRITTEN INSIDE THE CALLER'S TRANSACTION.
//
// Setting the phase and enqueueing its message are one indivisible act:
// a job marked SEARCHING with no message would stall forever, and a
// message for a job with no phase is refused as NOT_PHASED. Both writes
// therefore go through the caller's transaction, so admission can put
// them in the SAME transaction that inserts the job — there is no window
// in which a job exists with neither a legacy nor a phase message.
//
// The UPDATE is conditional on the phase still being NULL, which makes it
// the same atomic-claim shape every other phase transition uses: a job
// can be initialized exactly once, so it can never carry two SEARCHING
// messages. Returns false when the job was already phased (or is gone),
// in which case nothing was enqueued.
export async function initializeAcquisitionPhaseInTx(
  boss: PgBoss,
  tx: Transaction,
  jobId: string,
): Promise<boolean> {
  const rows = await tx
    .update(researchJobs)
    .set({ acquisitionPhase: "SEARCHING", acquisitionPhaseAt: sql`now()` })
    .where(and(eq(researchJobs.id, jobId), sql`${researchJobs.acquisitionPhase} IS NULL`))
    .returning({ id: researchJobs.id });
  if (rows.length === 0) return false;
  await enqueueAcquisitionPhaseInTx(boss, tx, jobId, "SEARCHING");
  return true;
}
