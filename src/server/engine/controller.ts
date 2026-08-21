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

// Reads the persisted attempt history for this job and reduces it to two
// things: which (step, component) pairs are already SUCCEEDED (never
// re-attempted — that is the whole point of persisting attempts), and the
// highest attempt_number seen per pair (so the next attempt, if any,
// numbers itself correctly instead of colliding with history).
async function loadAttemptState(
  db: Database | Transaction,
  jobId: string,
): Promise<{
  succeededKeys: Set<string>;
  maxAttemptByKey: Map<string, number>;
}> {
  const rows = await db
    .select()
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, jobId));

  const succeededKeys = new Set<string>();
  const maxAttemptByKey = new Map<string, number>();
  for (const row of rows) {
    const key = componentKey(row.patternStep, row.component);
    if (row.status === "SUCCEEDED") succeededKeys.add(key);
    maxAttemptByKey.set(
      key,
      Math.max(maxAttemptByKey.get(key) ?? 0, row.attemptNumber),
    );
  }
  return { succeededKeys, maxAttemptByKey };
}

export async function runResearchController(
  input: ControllerRunInput,
): Promise<ControllerRunResult> {
  const { db, jobId, view, executor, now } = input;
  const maxAttemptsThisRun = input.maxAttemptsThisRun ?? Infinity;

  const { succeededKeys, maxAttemptByKey } = await loadAttemptState(db, jobId);

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

  let normalAttemptsUsed = 0;
  let recoveryAttemptsUsed = 0;
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
    // Budget is charged BEFORE the executor runs (§5.5: "инкрементирует
    // счётчики job'а до вызова") — a failed/throwing executor still
    // consumed the attempt slot, it does not get refunded.
    if (isRecoveryAttempt) recoveryAttemptsUsed += 1;
    else normalAttemptsUsed += 1;

    await db
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
      });

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
