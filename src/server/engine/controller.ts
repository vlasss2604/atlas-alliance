import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts } from "../db/schema";
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
// reservedRecoverySteps at the moment it was claimed (§5.5: budget is
// charged before the attempt runs), and that charge must never be
// forgotten just because the process serving it later restarted or the
// job task was redelivered. Counting persisted rows directly (rather than
// trusting any in-memory counter) is also naturally robust to a malformed
// or gapped attempt history — out-of-order rows, missing attempt_number
// values in between, duplicate STARTED rows from a race — none of that
// changes what "count of rows with attempt_number > 1" means.
async function loadAttemptState(
  db: Database | Transaction,
  jobId: string,
): Promise<{
  succeededKeys: Set<string>;
  maxAttemptByKey: Map<string, number>;
  recoveryAttemptsUsedLifetime: number;
  normalAttemptsUsedLifetime: number;
}> {
  const rows = await db
    .select()
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, jobId));

  const succeededKeys = new Set<string>();
  const maxAttemptByKey = new Map<string, number>();
  let recoveryAttemptsUsedLifetime = 0;
  let normalAttemptsUsedLifetime = 0;
  for (const row of rows) {
    const key = componentKey(row.patternStep, row.component);
    if (row.status === "SUCCEEDED") succeededKeys.add(key);
    maxAttemptByKey.set(
      key,
      Math.max(maxAttemptByKey.get(key) ?? 0, row.attemptNumber),
    );
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
    recoveryAttemptsUsedLifetime,
    normalAttemptsUsedLifetime,
  };
}

export async function runResearchController(
  input: ControllerRunInput,
): Promise<ControllerRunResult> {
  const { db, jobId, view, executor, now } = input;
  const maxAttemptsThisRun = input.maxAttemptsThisRun ?? Infinity;

  const {
    succeededKeys,
    maxAttemptByKey,
    recoveryAttemptsUsedLifetime,
    normalAttemptsUsedLifetime,
  } = await loadAttemptState(db, jobId);

  // Authoritative and ONLY source of what may be worked on (D-072) —
  // never contract.alreadySatisfiedSteps/requiredFreshEvidence/missingSteps,
  // never re-derived here. Already-succeeded components (from a prior run
  // of this same controller) are skipped without touching the executor —
  // this is the resume/idempotency guarantee.
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

  // ATTEMPT-COUNT budget enforcement (S3 skeleton, not final): each unit
  // of work costs exactly one attempt against its pool. Real
  // multi-dimensional accounting (actual search/fetch/model cost per
  // attempt) is S4+ territory, once real providers report real numbers —
  // this slice enforces the one thing that's true regardless: normal work
  // never spends into the reserved recovery pool (§5.5, D-082 "пять полей
  // бюджета уже заморожены Фазой 1").
  const normalCeiling = Math.max(
    0,
    view.researchBudget.maxSearchQueries -
      view.researchBudget.reservedRecoverySteps,
  );
  const recoveryCeiling = view.researchBudget.reservedRecoverySteps;

  // Start from the JOB-LIFETIME totals already persisted (HIGH-1) — not
  // zero. A redelivered/restarted run continues spending the same pools,
  // it never gets a fresh allowance.
  let normalAttemptsUsed = normalAttemptsUsedLifetime;
  let recoveryAttemptsUsed = recoveryAttemptsUsedLifetime;
  let attemptsThisRun = 0;
  const succeeded: ComponentWorkItem[] = [];
  const failed: ComponentWorkItem[] = [];
  const skipped: ComponentWorkItem[] = [];
  const budgetSpent = { searchQueries: 0, sourceOpens: 0, modelCostMicro: 0 };

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

    const key = componentKey(item.step, item.component);
    const priorAttempts = maxAttemptByKey.get(key) ?? 0;
    const isRecoveryAttempt = priorAttempts > 0;

    if (isRecoveryAttempt) {
      if (recoveryAttemptsUsed >= recoveryCeiling) {
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
    } else if (normalAttemptsUsed >= normalCeiling) {
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

    const attemptNumber = priorAttempts + 1;

    // MEDIUM-3 fix: the STARTED insert is the real, DB-atomic claim on
    // this (job, step, component, attemptNumber) slot — the unique index
    // (uq_research_attempts_job_step_component_attempt) plus
    // onConflictDoNothing()+RETURNING is what actually decides the race,
    // not "we're the only caller" (we might not be: two workers can pick
    // up a redelivered/duplicate queue message for the same job). If
    // `claimed` comes back empty, some other concurrent invocation
    // already owns this exact attempt — we must not call the external
    // executor for it. We simply move on; the invocation that WON the
    // claim is responsible for it, and a future run of this controller
    // (this one or another) will see its outcome via loadAttemptState.
    const claimed = await db
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

    if (claimed.length === 0) {
      // Lost the claim — do NOT touch normal/recoveryAttemptsUsed either:
      // this invocation reserved nothing, so it must not appear to have
      // spent budget it never actually spent. The winning invocation
      // charges its own counters in its own call. Advance the local
      // attempt-number tracking defensively so this run doesn't loop
      // trying the same already-claimed number again this pass.
      maxAttemptByKey.set(key, attemptNumber);
      continue;
    }

    // Budget is charged BEFORE the executor runs (§5.5: "инкрементирует
    // счётчики job'а до вызова") — a failed/throwing executor still
    // consumed the attempt slot, it does not get refunded. Charged only
    // now, after the claim is confirmed won, so a lost race never charges
    // budget for work this invocation didn't actually perform.
    if (isRecoveryAttempt) recoveryAttemptsUsed += 1;
    else normalAttemptsUsed += 1;

    // Residual at-least-once semantics, stated plainly: this call to
    // executor.execute() is NOT exactly-once. If this process crashes (or
    // is killed) after the executor completes real external work but
    // before the UPDATE below persists, the attempt row is left as
    // STARTED forever, and a later run sees this (step, component) as
    // still-pending and will genuinely retry it as attemptNumber+1 — a
    // real second external call, unless the executor's own provider is
    // idempotent. That retry correctly consumes another unit of the
    // (job-lifetime, HIGH-1) recovery budget, exactly like any other
    // recovery attempt — nothing here claims exactly-once external
    // side effects, only exactly-once-per-successfully-claimed-attempt-row.
    const result = await executor.execute(item, {
      jobId,
      attemptNumber,
      isRecoveryAttempt,
    });
    attemptsThisRun += 1;
    maxAttemptByKey.set(key, attemptNumber);

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
