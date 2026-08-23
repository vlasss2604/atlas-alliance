import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";

import type { Transaction } from "../db/client";

export const RESEARCH_QUEUE = "research";

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
