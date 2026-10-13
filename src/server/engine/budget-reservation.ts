import { sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";

// Phase 6, S4 review fix (BLOCKER-2/HIGH-1) — atomic, job-level
// dimensional budget reservation, one unit per REAL external action
// (one SearchGateway call, one ContentFetcher open, one reserved
// model-cost estimate), independent of and never conflated with the
// controller's ATTEMPT-COUNT gate (claimAttempt in controller.ts, which
// counts a structurally different thing).
//
// The atomicity primitive is a single conditional UPDATE:
//   UPDATE research_jobs SET col = col + amount
//   WHERE id = $1 AND col + amount <= ceiling
//   RETURNING col
// Postgres serializes concurrent UPDATEs to the same row via its normal
// MVCC row-level write lock — no explicit `SELECT ... FOR UPDATE`, no
// application-level lock, and critically no lock held across the
// external call (the call happens strictly AFTER this resolves). If the
// WHERE clause's post-increment bound fails, zero rows are affected and
// the caller learns the reservation was refused BEFORE it does any real
// work. This is a plain, standard atomic-counter-with-ceiling pattern,
// not a new synchronization primitive.
//
// A reservation is never refunded on failure — "not a free retry" is by
// design: if the subsequent SearchGateway/ContentFetcher/model call
// fails, the unit stays spent. Retrying is still possible as long as
// budget remains, exactly like any other unit of the ceiling.

export type BudgetDimension = "searchQueries" | "sourceOpens" | "modelCostMicro";

const COLUMN_BY_DIMENSION: Record<BudgetDimension, string> = {
  searchQueries: "search_queries_reserved",
  sourceOpens: "source_opens_reserved",
  modelCostMicro: "model_cost_micro_reserved",
};

// Reserves `amount` units of `dimension` against `ceiling` for `jobId`.
// Returns true if the reservation succeeded (the caller may now perform
// the external action), false if it would have exceeded the ceiling (the
// caller must not perform it).
export async function reserveJobBudget(
  db: Database | Transaction,
  jobId: string,
  dimension: BudgetDimension,
  amount: number,
  ceiling: number,
): Promise<boolean> {
  if (amount <= 0) return true; // nothing to reserve
  const column = sql.raw(`"${COLUMN_BY_DIMENSION[dimension]}"`);
  const result = await db.execute(sql`
    UPDATE research_jobs
    SET ${column} = ${column} + ${amount}
    WHERE id = ${jobId} AND ${column} + ${amount} <= ${ceiling}
    RETURNING ${column} AS reserved
  `);
  return result.rows.length > 0;
}

export async function readJobBudgetReserved(
  db: Database | Transaction,
  jobId: string,
): Promise<{ searchQueries: number; sourceOpens: number; modelCostMicro: number } | null> {
  const result = await db.execute(sql`
    SELECT search_queries_reserved, source_opens_reserved, model_cost_micro_reserved
    FROM research_jobs WHERE id = ${jobId}
  `);
  const row = result.rows[0] as
    | { search_queries_reserved: number; source_opens_reserved: number; model_cost_micro_reserved: number }
    | undefined;
  if (!row) return null;
  return {
    searchQueries: row.search_queries_reserved,
    sourceOpens: row.source_opens_reserved,
    modelCostMicro: row.model_cost_micro_reserved,
  };
}
