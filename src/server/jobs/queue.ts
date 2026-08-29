import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";

import type { Transaction } from "../db/client";
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
