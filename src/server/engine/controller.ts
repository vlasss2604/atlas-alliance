import { and, eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts, researchJobs } from "../db/schema";
import type { ComponentWorkItem, ContractView } from "./contract-view";

// Phase 6, S3 — ResearchController skeleton (phase-6-plan.md §19 S3, D-070,
// D-072). Deterministic: consumes a ContractView (S0), schedules the
// components it authorizes, enforces budget and the capability ceiling,
// tracks attempts for idempotent-enough resume, and reports a
// machine-readable stop reason. It never calls a model and never decides
// WHAT is true about a component — that is EvidenceExtractor/
// ComponentReconciler territory (S4/S5), explicitly out of scope here.
//
// The one thing this slice delegates to a caller-supplied `WorkExecutor`
// is "go do the actual research for this one component" — S4+ wires a
// real implementation (QueryProposer -> SearchGateway -> ContentFetcher ->
// EvidenceExtractor); this slice only ever sees its typed result. Per
// D-070's own test: swapping the executor for a deterministic fake must
// not change scope, eligibility, budget accounting, or the stop reason —
// only whether individual attempts succeed or fail.

export interface WorkExecutionResult {
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  // Deterministic-from-the-controller's-perspective reason string — the
  // executor may embed model output inside it, but the controller never
  // parses or acts on the text, only the status.
  reason?: string;
  // Cost the executor reports having spent on this one attempt — used
  // only for observability at S3 (see module comment on ATTEMPT-COUNT
  // budget enforcement below); real multi-dimensional accounting is S4+.
  spent?: {
    searchQueries: number;
    sourceOpens: number;
    modelCostMicro: number;
  };
}

export interface WorkExecutor {
  execute(
    item: ComponentWorkItem,
    ctx: { jobId: string; attemptNumber: number; isRecoveryAttempt: boolean },
  ): Promise<WorkExecutionResult>;
}

export type ControllerStopReason =
  // Every pending (step, component) in the work queue has either
  // succeeded or been attempted this call with no budget left to retry —
  // nothing eligible remains.
  | "WORK_QUEUE_EXHAUSTED"
  // The work queue was empty from the start (or emptied) SPECIFICALLY
  // because the capability ceiling excluded everything (D-071 territory —
  // the caller, not this module, turns this into errorCode=
  // CAPABILITY_BOUNDARY on the job).
  | "CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK"
  // The normal or recovery budget pool is exhausted mid-run.
  | "BUDGET_EXHAUSTED"
  // maxAttemptsThisRun was reached — this run stopped early by request
  // (used to simulate "the worker died mid-batch"); a later call with the
  // same jobId resumes from persisted research_attempts state.
  | "INTERRUPTED";

export interface ControllerRunInput {
  db: Database | Transaction;
  jobId: string;
  view: ContractView;
  executor: WorkExecutor;
  now: Date;
  // Test/operational seam for simulating an interrupted run — never used
  // to widen or narrow scope, only to cap how many NEW attempts this one
  // call makes before returning.
  maxAttemptsThisRun?: number;
  // TEST-ONLY seam (R-1): artificially widens the window inside
  // claimAttempt's job-locked transaction between reading persisted
  // attempt state and committing a claim, so concurrency tests can force
  // two transactions to genuinely overlap instead of depending on
  // incidental scheduling. Never set outside tests; 0/undefined (the
  // production default) has no effect on behavior.
  debugClaimDelayMs?: number;
}

export interface ControllerRunResult {
  stopReason: ControllerStopReason;
  attemptsThisRun: number;
  succeeded: ComponentWorkItem[];
  failed: ComponentWorkItem[];
  skipped: ComponentWorkItem[];
  budgetSpent: {
    searchQueries: number;
    sourceOpens: number;
    modelCostMicro: number;
  };
  recoveryAttemptsUsed: number;
}

function componentKey(step: number, component: string): string {
  return `${step}:${component}`;
}

// Reads the persisted attempt history for this job and reduces it to
// three things: which (step, component) pairs are already SUCCEEDED
// (never re-attempted — that is the whole point of persisting attempts),
// the highest attempt_number seen per pair (so the next attempt, if any,
// numbers itself correctly instead of colliding with history), and how
// much of the JOB-LIFETIME recovery budget has already been spent.
//
// HIGH-1 fix: recovery capacity is a property of the JOB, not of any one
// call to this function's caller. A row with attempt_number > 1 is, by
// definition, a retry of a component that already failed (or was
// interrupted) on a prior attempt — it consumed one unit of
// reservedRecoverySteps at the moment it was claimed, and that charge
// must never be forgotten just because the process serving it later
// restarted or the job task was redelivered. Counting persisted rows
// directly (rather than trusting any in-memory counter) is also
// naturally robust to a malformed or gapped attempt history — out-of-
// order rows, missing attempt_number values in between, duplicate
// STARTED rows from a race — none of that changes what "count of rows
// with attempt_number > 1" means.
//
// This function is used in two places with two different atomicity
// requirements: (1) once, up front, to build the initial `pending` work
// list — a plain, unlocked read is fine there, it is only an
// optimization that narrows what this run bothers to loop over; (2)
// inside `claimAttempt`'s job-locked transaction (R-1), where it is the
// authoritative read the budget decision is made from.
interface LatestAttempt {
  attemptNumber: number;
  status: "STARTED" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  createdAt: Date;
}

async function loadAttemptState(
  db: Database | Transaction,
  jobId: string,
): Promise<{
  succeededKeys: Set<string>;
  maxAttemptByKey: Map<string, number>;
  // The single most-recent (highest attempt_number) row per (step,
  // component) key, status and creation time included — this is what
  // claimAttempt's in-flight-vs-abandoned decision (R-1) is made from.
  latestAttemptByKey: Map<string, LatestAttempt>;
  recoveryAttemptsUsedLifetime: number;
  normalAttemptsUsedLifetime: number;
}> {
  const rows = await db
    .select()
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, jobId));

  const succeededKeys = new Set<string>();
  const maxAttemptByKey = new Map<string, number>();
  const latestAttemptByKey = new Map<string, LatestAttempt>();
  let recoveryAttemptsUsedLifetime = 0;
  let normalAttemptsUsedLifetime = 0;
  for (const row of rows) {
    const key = componentKey(row.patternStep, row.component);
    if (row.status === "SUCCEEDED") succeededKeys.add(key);
    const priorMax = maxAttemptByKey.get(key) ?? 0;
    if (row.attemptNumber >= priorMax) {
      maxAttemptByKey.set(key, row.attemptNumber);
      latestAttemptByKey.set(key, {
        attemptNumber: row.attemptNumber,
        status: row.status,
        createdAt: row.createdAt,
      });
    }
    // Same job-lifetime reasoning as the recovery pool (HIGH-1): the
    // normal pool must not be "refilled" by a redelivery/restart either,
    // only reservedRecoverySteps was named explicitly, but a per-run
    // normal counter would carry the identical defect.
    if (row.attemptNumber > 1) recoveryAttemptsUsedLifetime += 1;
    else normalAttemptsUsedLifetime += 1;
  }
  return {
    succeededKeys,
    maxAttemptByKey,
    latestAttemptByKey,
    recoveryAttemptsUsedLifetime,
    normalAttemptsUsedLifetime,
  };
}

// A STARTED attempt row with no terminal status yet is ambiguous: it may
// be another invocation genuinely still running right now (must block a
// concurrent re-claim of the SAME component — MEDIUM-3's guarantee) or a
// worker that crashed/was killed after claiming but before persisting a
// terminal result (must eventually become reclaimable, or the documented
// residual at-least-once replay could never actually happen). The row
// alone carries no heartbeat/lease column to distinguish the two, so a
// bounded age against the caller-supplied `now` stands in for one: within
// the window, presume "still running" and block; past it, presume
// "abandoned" and allow reclaim as the next attempt (recovery-budget-
// bounded like any other retry). This is an operational reclaim
// mechanism, not a new research/product semantic state.
const ATTEMPT_LEASE_MS = 5 * 60 * 1000;

type ClaimOutcome =
  | { claimed: true; attemptNumber: number; isRecoveryAttempt: boolean }
  // Some OTHER attempt row for this (step, component) is already
  // SUCCEEDED or STARTED (still in flight) — this invocation must not
  // touch the executor or the budget for it at all.
  | { claimed: false; reason: "ALREADY_CLAIMED" }
  | { claimed: false; reason: "BUDGET_EXHAUSTED" };

// R-1 fix — atomic job-level budget authorization.
//
// Review finding: sequential/restart accounting (HIGH-1) was correct,
// but two concurrent `runResearchController` invocations could each read
// the same persisted attempt state, independently decide "budget
// available", and both insert a claim — over-authorizing the job-
// lifetime recovery/normal pool. The per-component unique-index claim
// (MEDIUM-3) stopped two invocations from double-executing the SAME
// (job, step, component, attemptNumber) triple, but did nothing to stop
// two invocations from each computing a DIFFERENT next attemptNumber for
// the same component (or from separately authorized components) against
// a stale, independently-read view of the job's remaining budget.
//
// Fix: `loadAttemptState` (the read), the budget-ceiling check, and the
// STARTED insert (the claim) now happen inside ONE transaction, itself
// serialized against every other concurrent claim transaction for the
// same job via `SELECT ... FROM research_jobs WHERE id = $1 FOR UPDATE`
// — the same row-lock serialization pattern already used elsewhere in
// this codebase for per-user admission (createResearchJob's DEMO quota
// check). Only one such transaction can hold this job's row lock at a
// time; every other concurrent transaction blocks at the SELECT ... FOR
// UPDATE until the lock holder commits (or rolls back), at which point it
// sees the lock holder's writes and makes its own decision against the
// now-current state. No concurrent invocation can act on a stale view of
// remaining job budget.
//
// The external executor call and the terminal UPDATE are deliberately
// OUTSIDE this transaction (call sites below) — the lock is held only
// across the read-check-claim, never across a model/provider call, per
// the review's explicit constraint.
async function claimAttempt(
  db: Database | Transaction,
  jobId: string,
  item: ComponentWorkItem,
  budget: { maxSearchQueries: number; reservedRecoverySteps: number },
  now: Date,
  debugClaimDelayMs: number,
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT id FROM ${researchJobs} WHERE id = ${jobId} FOR UPDATE`,
    );
    if (locked.rows.length === 0) {
      throw new Error(`research job not found: ${jobId}`);
    }

    const { maxAttemptByKey, succeededKeys, latestAttemptByKey, recoveryAttemptsUsedLifetime, normalAttemptsUsedLifetime } =
      await loadAttemptState(tx, jobId);
    // Test-only seam: widens the read-to-claim window so concurrency
    // tests can deterministically force two transactions to overlap
    // inside it, instead of depending on incidental Node/Postgres
    // scheduling luck. Zero (the production default) has no effect.
    if (debugClaimDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, debugClaimDelayMs));
    }

    const key = componentKey(item.step, item.component);
    if (succeededKeys.has(key)) {
      return { claimed: false, reason: "ALREADY_CLAIMED" };
    }
    const latest = latestAttemptByKey.get(key);
    if (latest && latest.status === "STARTED") {
      const ageMs = now.getTime() - latest.createdAt.getTime();
      if (ageMs < ATTEMPT_LEASE_MS) {
        // Some other invocation's claim on this exact component is still
        // within its lease window — presumed still running. This
        // invocation reserves nothing and must not call the executor.
        return { claimed: false, reason: "ALREADY_CLAIMED" };
      }
      // Lease expired: presumed abandoned (crashed before the terminal
      // UPDATE). Fall through and reclaim it as the next attempt — this
      // is the residual at-least-once replay path, still budget-bounded
      // below like any other recovery attempt.
    }

    const isRecoveryAttempt = (maxAttemptByKey.get(key) ?? 0) > 0;
    const normalCeiling = Math.max(0, budget.maxSearchQueries - budget.reservedRecoverySteps);
    const recoveryCeiling = budget.reservedRecoverySteps;
    const wouldExceed = isRecoveryAttempt
      ? recoveryAttemptsUsedLifetime >= recoveryCeiling
      : normalAttemptsUsedLifetime >= normalCeiling;
    if (wouldExceed) {
      return { claimed: false, reason: "BUDGET_EXHAUSTED" };
    }

    const attemptNumber = (maxAttemptByKey.get(key) ?? 0) + 1;
    // The unique index (uq_research_attempts_job_step_component_attempt)
    // + onConflictDoNothing stays as a defense-in-depth backstop — under
    // correct FOR UPDATE serialization it should never actually lose,
    // since only one transaction can be computing this job's next
    // attemptNumber at a time.
    const inserted = await tx
      .insert(researchAttempts)
      .values({
        researchJobId: jobId,
        patternStep: item.step,
        component: item.component,
        attemptNumber,
        status: "STARTED",
      })
      .onConflictDoNothing({
        target: [
          researchAttempts.researchJobId,
          researchAttempts.patternStep,
          researchAttempts.component,
          researchAttempts.attemptNumber,
        ],
      })
      .returning({ id: researchAttempts.id });

    if (inserted.length === 0) {
      // Should be unreachable under correct row-lock serialization; if it
      // ever fires, treat it exactly like any other lost claim rather
      // than crash.
      return { claimed: false, reason: "ALREADY_CLAIMED" };
    }

    return { claimed: true, attemptNumber, isRecoveryAttempt };
  });
}

export async function runResearchController(
  input: ControllerRunInput,
): Promise<ControllerRunResult> {
  const { db, jobId, view, executor, now } = input;
  const maxAttemptsThisRun = input.maxAttemptsThisRun ?? Infinity;
  const debugClaimDelayMs = input.debugClaimDelayMs ?? 0;

  // Unlocked read, used only to narrow which items this run bothers to
  // loop over (D-072: workQueue is the only authoritative work source).
  // It is NOT the budget authority — that lives inside claimAttempt's
  // job-locked transaction (R-1) and is re-checked fresh per item.
  const { succeededKeys } = await loadAttemptState(db, jobId);

  const pending = view.workQueue.filter(
    (item) => !succeededKeys.has(componentKey(item.step, item.component)),
  );

  if (
    pending.length === 0 &&
    view.capabilityCeilingHit &&
    view.excludedComponents.length > 0
  ) {
    return {
      stopReason: "CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK",
      attemptsThisRun: 0,
      succeeded: [],
      failed: [],
      skipped: [],
      budgetSpent: { searchQueries: 0, sourceOpens: 0, modelCostMicro: 0 },
      recoveryAttemptsUsed: 0,
    };
  }

  let attemptsThisRun = 0;
  const succeeded: ComponentWorkItem[] = [];
  const failed: ComponentWorkItem[] = [];
  const skipped: ComponentWorkItem[] = [];
  const budgetSpent = { searchQueries: 0, sourceOpens: 0, modelCostMicro: 0 };

  // Reported lifetime recovery count — refreshed after every claim
  // decision (see below) so the returned value is never staler than this
  // run's own view of the job, even though concurrent invocations may
  // keep advancing it after this run returns.
  let recoveryAttemptsUsed = (await loadAttemptState(db, jobId)).recoveryAttemptsUsedLifetime;

  for (const item of pending) {
    if (attemptsThisRun >= maxAttemptsThisRun) {
      return {
        stopReason: "INTERRUPTED",
        attemptsThisRun,
        succeeded,
        failed,
        skipped,
        budgetSpent,
        recoveryAttemptsUsed,
      };
    }

    const outcome = await claimAttempt(db, jobId, item, view.researchBudget, now, debugClaimDelayMs);

    if (!outcome.claimed) {
      if (outcome.reason === "ALREADY_CLAIMED") {
        // Nothing reserved, nothing spent — another invocation already
        // owns (or already finished) this component; move on to the
        // next pending item in this run.
        continue;
      }
      // BUDGET_EXHAUSTED: re-read the authoritative lifetime count for
      // reporting, then stop — same behavior as before R-1, just driven
      // by a live (not locally-tracked) budget decision.
      recoveryAttemptsUsed = (await loadAttemptState(db, jobId)).recoveryAttemptsUsedLifetime;
      return {
        stopReason: "BUDGET_EXHAUSTED",
        attemptsThisRun,
        succeeded,
        failed,
        skipped,
        budgetSpent,
        recoveryAttemptsUsed,
      };
    }

    const { attemptNumber, isRecoveryAttempt } = outcome;

    // Residual at-least-once semantics, stated plainly: this call to
    // executor.execute() is NOT exactly-once. If this process crashes (or
    // is killed) after the executor completes real external work but
    // before the UPDATE below persists, the attempt row is left as
    // STARTED forever, and a later run sees this (step, component) as
    // still-pending and will genuinely retry it as attemptNumber+1 — a
    // real second external call, unless the executor's own provider is
    // idempotent. That retry correctly consumes another unit of the
    // (job-lifetime, HIGH-1/R-1) recovery budget, exactly like any other
    // recovery attempt — nothing here claims exactly-once external
    // side effects, only exactly-once-per-successfully-claimed-attempt-row,
    // and the claim itself is job-lifetime-budget-bounded (R-1).
    const result = await executor.execute(item, {
      jobId,
      attemptNumber,
      isRecoveryAttempt,
    });
    attemptsThisRun += 1;

    if (result.spent) {
      budgetSpent.searchQueries += result.spent.searchQueries;
      budgetSpent.sourceOpens += result.spent.sourceOpens;
      budgetSpent.modelCostMicro += result.spent.modelCostMicro;
    }

    await db
      .update(researchAttempts)
      .set({
        status: result.status,
        reason: result.reason ?? null,
        completedAt: now,
      })
      .where(
        and(
          eq(researchAttempts.researchJobId, jobId),
          eq(researchAttempts.patternStep, item.step),
          eq(researchAttempts.component, item.component),
          eq(researchAttempts.attemptNumber, attemptNumber),
        ),
      );

    recoveryAttemptsUsed = (await loadAttemptState(db, jobId)).recoveryAttemptsUsedLifetime;

    if (result.status === "SUCCEEDED") succeeded.push(item);
    else if (result.status === "SKIPPED") skipped.push(item);
    else failed.push(item);
  }

  return {
    stopReason: "WORK_QUEUE_EXHAUSTED",
    attemptsThisRun,
    succeeded,
    failed,
    skipped,
    budgetSpent,
    recoveryAttemptsUsed,
  };
}
