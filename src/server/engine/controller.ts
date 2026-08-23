import { and, eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts, researchJobs } from "../db/schema";
import type { ComponentWorkItem, ContractView } from "./contract-view";
import type { ComponentReconciliationResult } from "./component-reconciler";

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
  // Informational/audit only (S4 review fix BLOCKER-2/HIGH-1): the real
  // dimensional ceiling enforcement now happens via atomic per-call
  // reservation against research_jobs.*Reserved BEFORE each external
  // action (budget-reservation.ts), inside the executor itself — not by
  // the controller trusting or clamping this self-report after the fact.
  // These numbers are persisted onto the attempt row for audit/resume
  // visibility; they do not gate anything here.
  spent?: {
    searchQueries: number;
    sourceOpens: number;
    // D-090 (S4 final implementation): this is an AUTHORIZED MAXIMUM
    // (what was reserved before the model call), never actual provider
    // spend — no per-token usage reconciliation happens in S4. Named
    // accordingly so audit/reporting never reads it as money actually
    // billed (D-036). The underlying DB columns
    // (research_attempts.model_cost_micro_spent,
    // research_jobs.model_cost_micro_reserved) keep their existing
    // storage names — this is a runtime/reporting-boundary rename only,
    // not a migration.
    authorizedModelCostMicro: number;
  };
}

export interface WorkExecutor {
  execute(
    item: ComponentWorkItem,
    ctx: {
      jobId: string;
      attemptNumber: number;
      isRecoveryAttempt: boolean;
      // Phase 6, S4 review fix (BLOCKER-2/HIGH-1) — the job's frozen
      // dimensional CEILINGS (not a claim-time remaining snapshot). The
      // executor is responsible for atomically reserving each real
      // external action against these ceilings itself, one unit at a
      // time, immediately before making that action — see
      // budget-reservation.ts and s4-executor.ts. Passing ceilings
      // instead of a precomputed "remaining" figure is deliberate: a
      // remaining snapshot taken once at claim time goes stale the
      // moment ANY concurrent attempt (on this or another component)
      // reserves anything, which is exactly the race BLOCKER-2 found.
      budget: { maxSearchQueries: number; maxSourceOpens: number; maxModelCostMicro: number };
      // D-130 — shape of the job's own work queue, so an executor can
      // divide the frozen ceilings fairly instead of letting whichever
      // components the queue happens to visit first consume everything.
      // Both are optional so every existing/fixture executor keeps
      // working unchanged; s4-executor treats absence as "1" (i.e. the
      // historic behaviour of no fair-share division).
      //
      // workQueueSize: total components in this job's queue.
      // remainingComponents: components with no terminal attempt yet,
      // INCLUDING the one now being executed (always >= 1 here).
      workQueueSize?: number;
      remainingComponents?: number;
    },
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
  // Phase 6, S5 (phase-6-s5-plan.md §12 "продолжение исследования S5 не
  // запускает", §17.1) — an optional post-attempt hook: reconciliation
  // reads whatever Evidence THIS job has accumulated for the (step,
  // component) just attempted and persists a ComponentReconciliationResult.
  // Called AFTER S4 Evidence acquisition for that component (per the task:
  // "S5 only after S4 Evidence acquisition"), regardless of whether the
  // attempt itself SUCCEEDED/FAILED/SKIPPED — a FAILED/SKIPPED attempt can
  // still leave prior-attempt Evidence behind that is worth reconciling,
  // and "no new Evidence this attempt" is itself a legitimate
  // INSUFFICIENT_EVIDENCE outcome (D-084), not a reason to skip
  // reconciliation. Optional and additive: omitting it (every S3/S4 caller
  // that predates S5) reproduces the exact pre-S5 controller behavior byte
  // for byte — this hook has no effect on scope, budget, eligibility, or
  // stop reason, only on whether research_component_results gets written.
  // The controller passes the hook exactly what S5's plan requires (job
  // id, item, now) and never inspects or acts on the returned result
  // itself (§12: "реконсилятор не имеет доступа ни к бюджету, ни к
  // очереди" — symmetrically, the controller does not read its
  // requiresFreshEvidence/status to trigger another attempt; that
  // decision is out of S5's and this slice's scope, D-092/§17.1).
  reconcile?: (
    db: Database | Transaction,
    jobId: string,
    item: Pick<ComponentWorkItem, "step" | "component">,
    now: Date,
  ) => Promise<ComponentReconciliationResult>;
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
    // D-090: authorized maximum, not actual spend — see WorkExecutionResult.
    authorizedModelCostMicro: number;
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
//
// S4 fix (final S0-S3 review note): a FIXED 5-minute lease was too tight
// once real provider/model work can legitimately run for the job's own
// maxWallClockSec (CORE: 20 minutes) — a slow-but-healthy attempt could
// be reclaimed out from under itself well before it was actually
// abandoned. The lease is now derived from the job's own frozen
// maxWallClockSec with a fixed safety margin, floored at the old default
// (never LESS generous than before) and capped at an absolute outer
// bound (never unbounded, per the review's explicit requirement).
const ATTEMPT_LEASE_MARGIN_MS = 60_000; // grace beyond the job's own wall-clock ceiling
const ATTEMPT_LEASE_FLOOR_MS = 5 * 60_000; // never less generous than the prior fixed default
const ATTEMPT_LEASE_CAP_MS = 60 * 60_000; // hard outer bound — "no unbounded lease"

function effectiveAttemptLeaseMs(maxWallClockSec: number): number {
  const derived = maxWallClockSec * 1000 + ATTEMPT_LEASE_MARGIN_MS;
  return Math.min(ATTEMPT_LEASE_CAP_MS, Math.max(ATTEMPT_LEASE_FLOOR_MS, derived));
}

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
//
// NOTE (S4 review fix, BLOCKER-2/HIGH-1, refined MEDIUM-A): this
// function's own budget gate is the ATTEMPT-COUNT gate only (how many
// attempts/recovery-retries a component gets) — it is deliberately NOT
// where real external-call dimensional budget (maxSearchQueries as call
// count, maxSourceOpens, maxModelCostMicro) is enforced. That enforcement
// lives entirely in per-call atomic reservation against
// research_jobs.*Reserved (budget-reservation.ts), made by the executor
// immediately before each real external action — conflating the two was
// exactly the defect (attempt count vs. real search-call count) the
// review found. An earlier round of this fix also read the reserved
// dimensional counters here as a "cheap early-exit optimization" before
// claiming an attempt; that read was removed (MEDIUM-A) because it was
// actively wrong at ceiling=0 (a legitimate config for a dimension a
// component never needs) — it refused to claim ANY attempt in that case,
// even for components that would never have touched the dimension,
// instead of letting the executor run and terminate honestly.
async function claimAttempt(
  db: Database | Transaction,
  jobId: string,
  item: ComponentWorkItem,
  budget: {
    maxSearchQueries: number;
    maxSourceOpens: number;
    maxModelCostMicro: number;
    maxWallClockSec: number;
    reservedRecoverySteps: number;
  },
  // MEDIUM-A (S4 final re-review): the ceiling on NORMAL (first) attempt
  // slots — deliberately NOT derived from maxSearchQueries. maxSearchQueries
  // means "maximum real SearchGateway calls" (BLOCKER-2) and nothing else;
  // the Boundary Contract does not define it as "maxAttempts", and no
  // independent attempt-ceiling field exists in the frozen 5-field budget
  // vocabulary either (inventing one would be a new frozen-contract field,
  // out of scope for S4). The deterministic work set itself already
  // provides a finite, job-lifetime-stable upper bound: every distinct
  // (step, component) pair the job's frozen Pattern/contract requires gets
  // exactly one normal attempt, regardless of how many (if any) of those
  // attempts end up making a real search call. Callers pass
  // `view.workQueue.length` — fixed for the job's lifetime once the
  // contract/active-Pattern are frozen at plan time.
  normalAttemptCeiling: number,
  now: Date,
  debugClaimDelayMs: number,
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    // The row lock itself (not its columns) is what serializes concurrent
    // claimAttempt transactions for this job (R-1) — see the function doc
    // comment. MEDIUM-A (S4 final re-review) removed the early-exit read
    // of search_queries_reserved/source_opens_reserved/model_cost_micro_reserved
    // that used to accompany this lock: at ceiling=0 (a legitimate config,
    // e.g. a component that never needs search at all) that check treated
    // "0 spent >= 0 ceiling" as already-exhausted and refused to claim an
    // attempt for EVERY component, even ones that would never have touched
    // that dimension — blocking the executor from ever running long enough
    // to terminate honestly. Real dimensional enforcement was already
    // fully owned by per-call atomic reservation inside the executor
    // (BLOCKER-2/HIGH-1); this was only ever a non-authoritative
    // optimization, and it was actively wrong at the zero-ceiling edge.
    const locked = await tx.execute(sql`SELECT id FROM ${researchJobs} WHERE id = ${jobId} FOR UPDATE`);
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
      if (ageMs < effectiveAttemptLeaseMs(budget.maxWallClockSec)) {
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
    // MEDIUM-A: normalCeiling is the deterministic work-set size, not
    // maxSearchQueries-derived — see the parameter doc comment above.
    const normalCeiling = normalAttemptCeiling;
    const recoveryCeiling = budget.reservedRecoverySteps;
    const attemptSlotExhausted = isRecoveryAttempt
      ? recoveryAttemptsUsedLifetime >= recoveryCeiling
      : normalAttemptsUsedLifetime >= normalCeiling;
    if (attemptSlotExhausted) {
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
  const reconcile = input.reconcile;

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
      budgetSpent: { searchQueries: 0, sourceOpens: 0, authorizedModelCostMicro: 0 },
      recoveryAttemptsUsed: 0,
    };
  }

  let attemptsThisRun = 0;
  // D-130 — how many of `pending` this run has already handed to the
  // executor, so the per-component fair share is computed against what
  // genuinely still needs budget rather than the original queue length.
  let processedFromPending = 0;
  const succeeded: ComponentWorkItem[] = [];
  const failed: ComponentWorkItem[] = [];
  const skipped: ComponentWorkItem[] = [];
  const budgetSpent = { searchQueries: 0, sourceOpens: 0, authorizedModelCostMicro: 0 };

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

    const outcome = await claimAttempt(
      db,
      jobId,
      item,
      view.researchBudget,
      view.workQueue.length,
      now,
      debugClaimDelayMs,
    );

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
    // and the claim itself is job-lifetime-budget-bounded (R-1). Every
    // real external action the executor performs while handling this
    // attempt is separately, atomically reserved against
    // research_jobs.*Reserved (BLOCKER-2/HIGH-1) — a crash here does not
    // "un-reserve" anything already spent, matching "not a free retry".
    const result = await executor.execute(item, {
      jobId,
      attemptNumber,
      isRecoveryAttempt,
      budget: {
        maxSearchQueries: view.researchBudget.maxSearchQueries,
        maxSourceOpens: view.researchBudget.maxSourceOpens,
        maxModelCostMicro: view.researchBudget.maxModelCostMicro,
      },
      // D-130 — queue shape, so the executor can divide the frozen
      // ceilings fairly across components instead of letting the ones the
      // queue visits first spend everything. `pending` is this run's own
      // not-yet-succeeded set; `processedFromPending` counts how many of
      // them this run has already attempted, so the remainder (including
      // the current item) is what still needs a share.
      workQueueSize: view.workQueue.length,
      remainingComponents: Math.max(1, pending.length - processedFromPending),
    });
    processedFromPending += 1;
    attemptsThisRun += 1;

    // Informational/audit only — see WorkExecutionResult doc comment.
    // Floored at zero for sanity; not clamped to any ceiling here because
    // the real ceiling was already enforced per-call, atomically, inside
    // the executor.
    const auditedSpent = {
      searchQueries: Math.max(0, result.spent?.searchQueries ?? 0),
      sourceOpens: Math.max(0, result.spent?.sourceOpens ?? 0),
      authorizedModelCostMicro: Math.max(0, result.spent?.authorizedModelCostMicro ?? 0),
    };
    budgetSpent.searchQueries += auditedSpent.searchQueries;
    budgetSpent.sourceOpens += auditedSpent.sourceOpens;
    budgetSpent.authorizedModelCostMicro += auditedSpent.authorizedModelCostMicro;

    await db
      .update(researchAttempts)
      .set({
        status: result.status,
        reason: result.reason ?? null,
        completedAt: now,
        searchQueriesSpent: auditedSpent.searchQueries,
        sourceOpensSpent: auditedSpent.sourceOpens,
        // D-090: research_attempts.model_cost_micro_spent is the legacy
        // storage name (frozen column, not renamed) — the value written is
        // the authorized-maximum reservation, not actual provider spend.
        modelCostMicroSpent: auditedSpent.authorizedModelCostMicro,
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

    // S5 (phase-6-s5-plan.md §12, §17.1): after S4 Evidence acquisition
    // for this (step, component) — regardless of this attempt's own
    // status, see the reconcile field's doc comment — and never gating or
    // altering anything about this attempt's own outcome above.
    if (reconcile) {
      await reconcile(db, jobId, item, now);
    }

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
