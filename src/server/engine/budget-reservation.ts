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
//
// BUDGET SETTLEMENT (D-173, the separately approved downward rule D-090
// reserved room for). A model-cost reservation is the THEORETICAL MAXIMUM
// of one call (maxInputTokens × price + maxOutputTokens × price). While the
// call is in flight that maximum is the only honest exposure, so it is
// what the hard cap is enforced against. Once the provider has answered
// and reported usage, the call's cost is KNOWN, and holding the unused
// part of the maximum as if it had been spent is not caution — it is a
// false statement about the job's spend. On the first measured Jito
// Research (job b817eb99, 2026-10-11) 34 completed extraction calls held
// 1,893,120 micro-USD of reservation against 370,296 micro-USD actually
// billed, and the LAST component was refused MODEL_COST_BUDGET_EXHAUSTED
// with 81 % of the configured budget unspent.
//
// settleJobBudgetReservation therefore releases exactly
// `reserved − actual` for ONE completed call, and only that:
//   * downward only — `actual > reserved` releases nothing and is never
//     written upward (D-090: never up, never above the frozen ceiling);
//   * only when the provider reported priceable usage — a call that failed
//     before answering, a truncated output (usage is not captured), an
//     unsupported billing category or a refused reservation keeps the
//     full maximum, exactly as before ("not a free retry" is unchanged);
//   * one atomic conditional UPDATE, the same shape as the reservation,
//     guarded so the counter can never go below zero.
// After settlement the counter reads: Σ actual cost of completed calls +
// Σ maximum of calls still in flight — the exposure a hard cap must bound.
// Concurrent calls stay safe for the same reason reservations are:
// every admission is one conditional UPDATE against the live counter.

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

// Settles ONE completed reservation of `dimension` down to its actual cost:
// releases `reservedAmount - actualAmount` when that is positive, nothing
// otherwise. Returns how much was released (0 when nothing was, including
// the never-expected case where the counter held less than the release —
// the guard refuses rather than driving it negative).
export async function settleJobBudgetReservation(
  db: Database | Transaction,
  jobId: string,
  dimension: BudgetDimension,
  reservedAmount: number,
  actualAmount: number,
): Promise<{ released: number }> {
  if (!Number.isFinite(reservedAmount) || !Number.isFinite(actualAmount)) return { released: 0 };
  const reserved = Math.max(0, Math.floor(reservedAmount));
  // Rounded UP, like every price in the approved profiles: a fractional
  // actual never settles below what was billed.
  const actual = Math.max(0, Math.ceil(actualAmount));
  const release = reserved - actual;
  if (release <= 0) return { released: 0 };
  const column = sql.raw(`"${COLUMN_BY_DIMENSION[dimension]}"`);
  const result = await db.execute(sql`
    UPDATE research_jobs
    SET ${column} = ${column} - ${release}
    WHERE id = ${jobId} AND ${column} >= ${release}
    RETURNING ${column} AS reserved
  `);
  return { released: result.rows.length > 0 ? release : 0 };
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
