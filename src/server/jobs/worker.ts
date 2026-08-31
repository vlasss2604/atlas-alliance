import { loadEnvConfig } from "@next/env";
import { eq, sql } from "drizzle-orm";

import { deleteStaleRateLimits } from "../auth/rate-limit";
import { deleteExpiredSessions } from "../auth/session";
import { loadProductConfig } from "../config/product";
import { loadModelCostProfile } from "../engine/model-cost-profile";
import type { ModelUsage } from "../engine/providers/types";
import { createDatabase, type Database } from "../db/client";
import { projects, researchJobs } from "../db/schema";
import { BudgetExhaustedError } from "../engine/budget-exhausted-error";
import type { ControllerRunResult, WorkExecutor } from "../engine/controller";
import { createNonLiveS4WorkExecutor } from "../engine/non-live-executor";
import { runS4ResearchJob } from "../engine/run-job";
import { runMemoryPlanningStage } from "../memory/plan-job";
import {
  finishPhasedJob,
  handleExtractingPhase,
  handleFetchingPhase,
  handleSearchingPhase,
  type PhaseHandlerResult,
  type PhaseWorkerContext,
} from "./acquisition-phase-worker";
import {
  assertOwnerAlphaLive,
  resolveOwnerAlphaExtractionExecutor,
  resolveOwnerAlphaWorkExecutor,
} from "./owner-alpha-routing";
import {
  createBoss,
  PHASE_QUEUE,
  RESEARCH_EXTRACT_QUEUE,
  RESEARCH_FETCH_QUEUE,
  RESEARCH_QUEUE,
  type ResearchQueuePayload,
} from "./queue";
import { claimResearchJob, resolveDemoReservation, transitionJobState } from "./research-jobs";
import { resolveContentFetcher } from "../engine/providers/content-fetcher";
import { resolveQueryProposer } from "../engine/providers/query-proposer";
import { resolveSearchGateway } from "../engine/providers/search-gateway";
import { assertDirectAcquisitionEgress } from "./egress-integrity";
import {
  installFetchRendererCapability,
  uninstallRendererCapability,
} from "./renderer-capability";
import {
  loadWorkerCapabilities,
  workerServesPhase,
  type PhaseCapability,
} from "./worker-capabilities";

// Standalone entrypoint (tsx, outside the Next.js runtime) — Next's own
// dev-server env loading (.env.local etc.) never applies here, so this
// worker preloads the same files itself via Next's own loader. Safe to
// run unconditionally at import time: nothing else in this module's
// import graph reads process.env at module-init scope (only inside
// function bodies / default-parameter positions evaluated at call time).
loadEnvConfig(process.cwd());

// First Real Run, Stage 1 (pipeline-integration-stage.md, D-113) —
// terminal contract mapping. `job.state` is the execution result,
// `job.terminationReason` is WHY execution stopped, `job.errorCode` is
// the technical failure detail — these are never collapsed into each
// other, and neither is ever read as an evidentiary conclusion (that
// lives only in research_claim_support.status, written by S7).
//
// Reuses ControllerStopReason (controller.ts) verbatim where the
// terminal state came from the engine itself — this function does not
// invent a parallel vocabulary for outcomes the controller already names
// precisely. `null` means the engine stopped for a resumable,
// non-terminal reason (INTERRUPTED) — this worker never sets
// maxAttemptsThisRun, so the controller should never actually return
// this from a call made here; the null case exists only as a defensive
// fallback that leaves the job RUNNING for a later pickup rather than
// forcing it into a state that would misrepresent what happened.
interface EngineOutcome {
  state: "SUCCEEDED" | "BUDGET_LIMIT_REACHED" | "FAILED";
  terminationReason: string;
  errorCode: string | null;
}

export function mapEngineOutcome(stopReason: ControllerRunResult["stopReason"]): EngineOutcome | null {
  switch (stopReason) {
    case "BUDGET_EXHAUSTED":
      // §B of the stage spec: budget exhaustion with incomplete evidence
      // is NOT a system/provider failure — research_claim_support may
      // legitimately be INSUFFICIENT_EVIDENCE for this job, and that is
      // an honest evidentiary outcome, not a reason to mark the job
      // FAILED.
      return { state: "BUDGET_LIMIT_REACHED", terminationReason: "BUDGET_EXHAUSTED", errorCode: null };
    case "CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK":
      // Documented convention from controller.ts's own ControllerStopReason
      // comment: the caller turns this into errorCode=CAPABILITY_BOUNDARY.
      // Nothing failed — the capability ceiling excluded all work before
      // any attempt was made — so the job state is SUCCEEDED (there was
      // nothing eligible to do), not FAILED.
      return { state: "SUCCEEDED", terminationReason: "CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK", errorCode: "CAPABILITY_BOUNDARY" };
    case "WORK_QUEUE_EXHAUSTED":
      // §A of the stage spec: every eligible (step, component) has
      // either succeeded or exhausted its retries — normal evidence
      // completion, whatever research_claim_support.status turns out to
      // be.
      return { state: "SUCCEEDED", terminationReason: "WORK_QUEUE_EXHAUSTED", errorCode: null };
    case "INTERRUPTED":
      return null;
  }
}

// Periodic-обслуживание (phase-2-plan §2.1, §6): истёкшие сессии и
// устаревшие rate-limit-бакеты.
export async function runMaintenance(db: Database): Promise<void> {
  await deleteExpiredSessions(db);
  await deleteStaleRateLimits(db, 24 * 60 * 60);
}

// Зависший RUNNING (дольше бюджета × 1.5) — честный сбой вместо вечного
// RUNNING: FAILED + освобождение резервации квоты (phase-1-plan §6).
//
// D-139 — SINGLE-PROCESS JOBS ONLY.
//
// This sweep asks one question: "has this job been executing for longer
// than its own wall-clock budget could possibly justify?" That question
// only makes sense while RUNNING means "a worker is executing it right
// now", which is true for the single-process path and false for a D-136
// phased job.
//
// A phased job is RUNNING for its whole journey, but between phases it is
// PARKED: its work sits in another queue waiting for a worker with
// different network capability, and that wait is not execution time. The
// legacy formula measures from research_jobs.started_at against
// maxWallClockSec, so it read a normal handoff as a hang and killed a
// job that had just completed SEARCHING successfully — the real incident
// this decision closes (job 01589b84-…, swept 29 minutes after start
// while its FETCHING message was still queued, 107 ms before the fetch
// worker picked it up).
//
// So the predicate is narrowed to the jobs this formula was written for.
// Phased jobs are excluded by their PERSISTED phase — not by a worker
// role, a capability or anything about the network. A phased liveness
// policy, if one is needed, is a separate decision and must be built on
// acquisition_phase / acquisition_phase_at with capability-worker
// semantics; it is deliberately NOT invented here.
export async function sweepStaleRunningJobs(db: Database): Promise<number> {
  const stale = await db
    .select({ id: researchJobs.id, level: researchJobs.entitlementAtStart })
    .from(researchJobs)
    .where(
      sql`${researchJobs.state} = 'RUNNING'
        AND ${researchJobs.acquisitionPhase} IS NULL
        AND ${researchJobs.startedAt} IS NOT NULL
        AND now() - ${researchJobs.startedAt} >
            make_interval(secs => ((${researchJobs.budgetAtStart} ->> 'maxWallClockSec')::int * 3) / 2)`,
    );
  for (const job of stale) {
    await db.transaction(async (tx) => {
      await transitionJobState(tx, job.id, "FAILED", "stale RUNNING sweep");
      if (job.level === "DEMO") {
        await resolveDemoReservation(tx, job.id, "RELEASED");
      }
    });
  }
  return stale.length;
}

// D-139's sweep deliberately excludes phased jobs, and that exclusion left a
// hole this closes: a phased job whose delivery has run out of retries.
//
// A phase hands off through a queue message, and that message has a bounded
// retry budget. When it is spent, pg-boss moves the message to `failed`
// (its own rule: `retry_count < retry_limit` -> retry, otherwise failed).
// At that point nothing is left to carry the job forward — no worker will
// ever be handed it again — while research_jobs still says RUNNING with a
// phase set. The job is orphaned: not finished, not failed, not runnable,
// and deliberately out of reach of the stale sweep. That is a product
// failure, not a research outcome, and it must terminate.
//
// THE PREDICATE IS TERMINAL DELIVERY STATE, NEVER AGE. This is what makes
// it safe to apply to phased jobs where a wall-clock rule is not: a phased
// job may legitimately sit for hours between capability environments, and
// elapsed time says nothing about whether it can still run. Two conditions,
// both read from persisted queue state:
//
//   * the queue for the job's CURRENT phase holds a terminally failed
//     message for it, and
//   * that same queue holds NO message for it in a runnable state
//     (created / retry / active).
//
// The second condition is what prevents a false failure. A message that is
// merely old, or that failed once and was superseded by a legitimate newer
// delivery, leaves a runnable row behind and is skipped; an in-flight
// delivery is `active` and is skipped for the same reason. Requiring the
// failed row to actually EXIST is the other half: if pg-boss has already
// deleted the history (its retention is days, not minutes) this reconciler
// says nothing rather than guessing, which is the fail-closed direction.
//
// It creates no delivery, resets no retry count, and touches no queue row —
// bounded retries end in a terminal product failure, never in a manufactured
// extra generation. Acquired documents, trace, the source-open ledger and
// D-146 strategy history are all left exactly as the run left them: the job
// is being terminated, not rolled back, and a later authorized recovery
// still has everything it needs.
export async function reconcileExhaustedPhaseDeliveries(db: Database): Promise<number> {
  // Built from PHASE_QUEUE so a new phase cannot silently escape this check;
  // both sides are code-owned constants bound as parameters.
  const phaseToQueue = sql.join(
    Object.entries(PHASE_QUEUE).map(([phase, queue]) => sql`WHEN ${phase} THEN ${queue}`),
    sql` `,
  );

  const orphaned = await db.execute<{
    id: string;
    level: string;
    phase: string;
  }>(sql`
    WITH phased AS (
      SELECT j.id,
             j.entitlement_at_start AS level,
             j.acquisition_phase AS phase,
             CASE j.acquisition_phase ${phaseToQueue} END AS queue
        FROM research_jobs j
       WHERE j.state = 'RUNNING'
         AND j.acquisition_phase IS NOT NULL
    )
    SELECT p.id, p.level, p.phase
      FROM phased p
     WHERE p.queue IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM pgboss.job b
              WHERE b.name = p.queue
                AND b.data->>'jobId' = p.id::text
                AND b.state = 'failed')
       AND NOT EXISTS (
             SELECT 1 FROM pgboss.job b
              WHERE b.name = p.queue
                AND b.data->>'jobId' = p.id::text
                AND b.state IN ('created', 'retry', 'active'))
  `);

  for (const job of orphaned.rows) {
    // The existing terminal vocabulary, unchanged: a technical execution
    // failure, explicitly NOT an evidentiary outcome. Nothing here claims
    // anything about the project's evidence — INSUFFICIENT_EVIDENCE remains
    // reserved for research that actually ran and found the world wanting.
    // finishPhasedJob also carries the existing product-failure metering:
    // a DEMO reservation is RELEASED, so an execution failure is never
    // billed as a completed research result.
    await finishPhasedJob(
      db,
      job.id,
      {
        state: "FAILED",
        terminationReason: "SYSTEM_OR_PROVIDER_FAILURE",
        errorCode: "PHASE_DELIVERY_EXHAUSTED",
      },
      job.level,
      "phase delivery exhausted: no runnable " + job.phase + " delivery remains",
    );
  }
  return orphaned.rows.length;
}

// Обработчик одной задачи очереди — вынесен из startWorker() именованной
// экспортируемой функцией, чтобы её можно было прогнать через настоящий
// pg-boss dequeue в acceptance-тесте (tests/phase5-worker-acceptance.test.ts)
// без дублирования этой логики. Поведение не изменилось, только форма.
// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) —
// admin/test-only seam: when supplied, replaces the accepted Stage 1
// zero-candidate executor with a caller-provided WorkExecutor for this
// one call. Omitting it (every production caller, including
// startWorker() below and every pre-Stage-2 test) reproduces Stage 1's
// exact accepted behavior byte for byte. Used ONLY by alpha-run.ts (to
// exercise the richer non-live trace fixture through the real worker
// path) and Stage 2's own tests — never by any live/production code
// path, and it can never carry a real provider: alpha-run.ts only ever
// passes createTraceFixtureExecutor (trace-fixture-executor.ts), itself
// built entirely from non-live fixtures.
// First Real Run, Stage 2 acceptance closure (HIGH-1/§2, D-116): the
// smallest structured contract a caller needs to tell "I claimed and
// executed this job" apart from "someone/something else already has (or
// had) it" — never a public API, only consumed by scripts/alpha-run.ts
// and this module's own tests. `claimed: false` means this invocation
// did ZERO research work: no planning, no S4 attempt, no trace row, no
// Evidence, no S5/S6/S7, no terminal-state write — it returned before
// any of that could start.
export type HandleResearchJobTaskResult =
  | { claimed: true }
  | { claimed: false; reason: "NOT_FOUND" | "NOT_QUEUED" };

export async function handleResearchJobTask(
  db: Database,
  jobId: string,
  executorOverride?: WorkExecutor,
): Promise<HandleResearchJobTaskResult> {
  // Atomic claim (research-jobs.ts) replaces the former check-then-act
  // (SELECT, then unconditional transitionJobState(..., "RUNNING")) —
  // see claimResearchJob's own doc comment for why that was unsafe.
  const job = await claimResearchJob(db, jobId);
  if (!job) {
    const [existing] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    return { claimed: false, reason: existing ? "NOT_QUEUED" : "NOT_FOUND" };
  }

  // Стадия 2 LOCKED §9 «Проверяю накопленный опыт» — Фаза 5 делает её
  // настоящей: retrieval → детерминированный план → запись контракта.
  // Честный сбой планирования — не то же самое, что «движка ещё нет»
  // (Фаза 6): разные errorCode, чтобы не смешивать баг с гранью фазы.
  let planningErrorCode: string | null = null;
  try {
    await runMemoryPlanningStage(db, jobId);
  } catch (e) {
    console.error("[worker] memory planning stage failed", e);
    planningErrorCode = "MEMORY_PLANNING_FAILED";
  }

  if (planningErrorCode) {
    await db.transaction(async (tx) => {
      await tx
        .update(researchJobs)
        .set({ errorCode: planningErrorCode, terminationReason: planningErrorCode })
        .where(eq(researchJobs.id, jobId));
      await transitionJobState(tx, jobId, "FAILED", "phase 5: memory planning failed");
      if (job.entitlementAtStart === "DEMO") {
        await resolveDemoReservation(tx, jobId, "RELEASED");
      }
    });
    return { claimed: true };
  }

  // First Real Run, Stage 1 (pipeline-integration-stage.md, D-113) —
  // Phase 5 planning succeeded; hand off to the frozen S4->S5->S6->S7
  // research engine (runS4ResearchJob) via a deterministic, zero-cost,
  // zero-network executor (non-live-executor.ts). The worker only
  // orchestrates the hand-off and maps the engine's own outcome onto the
  // job's terminal contract — it never reimplements S4/S5/S6/S7 research
  // semantics itself. research_enabled stays false (D-028); this path
  // never resolves a live provider (non-live-executor.ts supplies every
  // one of S4's four provider roles and both model cost profiles as
  // explicit fixtures, so s4-executor.ts's preflight never falls back to
  // a production resolver).
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId as string));
  if (!project) {
    // Planning already required job.projectId to be set and resolvable
    // (runMemoryPlanningStage throws otherwise, handled above) — this is
    // therefore a genuine internal inconsistency, never an evidentiary
    // outcome, if it is ever reached.
    await db.transaction(async (tx) => {
      await tx
        .update(researchJobs)
        .set({ errorCode: "PROJECT_NOT_FOUND", terminationReason: "SYSTEM_OR_PROVIDER_FAILURE" })
        .where(eq(researchJobs.id, jobId));
      await transitionJobState(tx, jobId, "FAILED", "engine: job project vanished before execution");
      if (job.entitlementAtStart === "DEMO") {
        await resolveDemoReservation(tx, jobId, "RELEASED");
      }
    });
    return { claimed: true };
  }

  let outcome: EngineOutcome | null;
  try {
    // Owner Manual Alpha App Test (D-123) — the ONLY branch point where a
    // live-provider executor can be selected. executorOverride (test/CLI
    // seam) always wins, unchanged from before. A normal PRODUCT-origin
    // job (every existing/default job) falls straight to
    // createNonLiveS4WorkExecutor exactly as before this change — this
    // branch is additive, not a redefinition of the default path.
    let executor: WorkExecutor;
    if (executorOverride) {
      executor = executorOverride;
    } else if (job.origin === "OWNER_MANUAL_ALPHA") {
      const config = await loadProductConfig(db);
      executor = await resolveOwnerAlphaWorkExecutor({
        db,
        job,
        project,
        internalAlphaEnabled: config.internal_alpha_enabled,
      });
    } else {
      executor = createNonLiveS4WorkExecutor({ db, project });
    }
    const result = await runS4ResearchJob(db, jobId, executor, new Date());
    outcome = mapEngineOutcome(result.stopReason);
  } catch (e) {
    console.error("[worker] research engine execution failed", e);
    // S10 final pre-smoke closure (HIGH-1, D-120): a required dimensional
    // job budget axis (searchQueries/sourceOpens/modelCostMicro) being
    // exhausted is NOT a system/provider failure — s4-executor.ts throws
    // this ONE narrow typed exception (never an ordinary uncaught
    // exception) specifically so the worker can distinguish "the job
    // legitimately ran out of authorized budget" from "something actually
    // broke". Mapped to BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED, the SAME
    // terminal vocabulary mapEngineOutcome already uses for the
    // controller's own (attempt-count) BUDGET_EXHAUSTED stop reason —
    // never SYSTEM_OR_PROVIDER_FAILURE, and never allowed to fall through
    // to the generic branch below (which would misreport an honest budget
    // stop as a technical failure).
    if (e instanceof BudgetExhaustedError) {
      outcome = { state: "BUDGET_LIMIT_REACHED", terminationReason: "BUDGET_EXHAUSTED", errorCode: null };
    } else {
      // §C of the stage spec: a genuine execution failure (provider/
      // resolver/internal-invariant exception) must never masquerade as
      // an evidentiary conclusion (INSUFFICIENT_EVIDENCE/NOT_SUPPORTED/
      // etc) — it becomes FAILED with a preserved technical reason, full
      // stop.
      outcome = {
        state: "FAILED",
        terminationReason: "SYSTEM_OR_PROVIDER_FAILURE",
        errorCode: e instanceof Error ? e.name : "ENGINE_EXECUTION_FAILED",
      };
    }
  }

  if (outcome === null) {
    // INTERRUPTED (see mapEngineOutcome) — leave the job RUNNING; a later
    // worker pickup resumes it via the controller's own persisted-attempt
    // replay semantics. Not expected in production.
    return { claimed: true };
  }

  const resolvedOutcome = outcome;
  await db.transaction(async (tx) => {
    await tx
      .update(researchJobs)
      .set({ errorCode: resolvedOutcome.errorCode, terminationReason: resolvedOutcome.terminationReason })
      .where(eq(researchJobs.id, jobId));
    await transitionJobState(tx, jobId, resolvedOutcome.state, `engine: ${resolvedOutcome.terminationReason}`);
    if (job.entitlementAtStart === "DEMO") {
      await resolveDemoReservation(tx, jobId, "RELEASED");
    }
  });
  return { claimed: true };
}

// D-136 — PHASED DISPATCH.
//
// The entry queue keeps both meanings it can have: a job with no
// acquisition phase is the single-process path, byte for byte what
// handleResearchJobTask has always done; a job WITH a phase is a phased
// job whose SEARCHING message this is. Which one a message is, is read
// from the job's own persisted state — never from the message.
export async function dispatchResearchQueueMessage(
  ctx: PhaseWorkerContext,
  jobId: string,
): Promise<
  | { kind: "LEGACY"; result: HandleResearchJobTaskResult }
  | { kind: "PHASED"; result: PhaseHandlerResult }
> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job || job.acquisitionPhase === null) {
    return { kind: "LEGACY", result: await handleResearchJobTask(ctx.db, jobId) };
  }
  // D-149 — CAPABILITY IS ASKED FIRST, before anything else touches this
  // job. It used to be asked last, inside the phase handler, which meant a
  // process that structurally cannot run SEARCHING would still load config,
  // run the live-admission gate (which can terminate a job) and construct a
  // model provider before discovering it had nothing to do. Refusing here
  // costs one row read, has no side effect on the job, and — because the
  // entry queue is no longer subscribed by a process that cannot serve
  // SEARCHING (see startWorker) — should now be unreachable in practice.
  // It stays as the structural guarantee behind that subscription rule.
  if (!workerServesPhase(ctx.capabilities, "SEARCHING")) {
    return { kind: "PHASED", result: { ran: false, refusal: "CAPABILITY_NOT_CONFIGURED" } };
  }

  const config = await loadProductConfig(ctx.db);
  // D-138 — the SAME live gate EXTRACTING uses, asked BEFORE a provider
  // is even constructed. Eligibility is re-checked here and not inherited
  // from admission: configuration or the actor's role may have changed
  // since this message was enqueued. A refusal therefore costs zero model
  // calls, zero search calls and zero budget.
  const gate = await assertPhaseLiveAdmitted(ctx, job, "SEARCHING");
  if (!gate.ok) return { kind: "PHASED", result: gate.result };

  // D-140 — resolved exactly as s4-executor's preflight resolves it: the
  // approved cost profile supplies the call's token bounds, and a usage
  // callback captures what the call really consumed so the audit row is
  // not a guess. The profile also travels with the provider, because the
  // phase must reserve against the SAME profile the call was made under.
  const proposerProfile = loadModelCostProfile("QUERY_PROPOSER", config.query_proposer_model);
  let proposerUsage: ModelUsage | null = null;
  const result = await handleSearchingPhase(ctx, jobId, {
    queryProposer: await resolveQueryProposer(
      config.query_proposer_model,
      proposerProfile.maxOutputTokens,
      proposerProfile.maxInputTokens,
      (u) => {
        proposerUsage = u;
      },
    ),
    searchGateway: resolveSearchGateway(),
    queryProposerCostProfile: proposerProfile,
    readProposerUsage: () => proposerUsage,
  });
  await finishPhasedJobOnRefusal(ctx, jobId, result);
  return { kind: "PHASED", result };
}

// A phase that could not run because the JOB is wrong (not because this
// worker is wrong) is terminal for the job: leaving it RUNNING forever
// would be the silent stall the phased design exists to avoid. A
// capability refusal is deliberately NOT terminal — that message belongs
// to another worker.
async function finishPhasedJobOnRefusal(
  ctx: PhaseWorkerContext,
  jobId: string,
  result: PhaseHandlerResult,
): Promise<void> {
  if (result.ran) return;
  if (result.refusal !== "NOT_FOUND" && result.refusal !== "NOT_PHASED") return;
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job || job.state !== "RUNNING") return;
  await finishPhasedJob(
    ctx.db,
    jobId,
    { state: "FAILED", terminationReason: "SYSTEM_OR_PROVIDER_FAILURE", errorCode: result.refusal },
    job.entitlementAtStart,
    "phase dispatch: " + result.refusal,
  );
}

// The FETCHING message. The source-side role owns exactly one live
// capability — the bounded content fetcher — and nothing else.
export async function dispatchFetchQueueMessage(
  ctx: PhaseWorkerContext,
  jobId: string,
): Promise<PhaseHandlerResult> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) return { ran: false, refusal: "NOT_FOUND" };
  // D-138 — the same gate again, and deliberately NOT inferred from the
  // fact that SEARCHING already succeeded: this is a different process,
  // possibly a different day, and eligibility is re-decided from current
  // state. A refusal opens no source.
  const gate = await assertPhaseLiveAdmitted(ctx, job, "FETCHING");
  if (!gate.ok) return gate.result;

  const result = await handleFetchingPhase(ctx, jobId, resolveContentFetcher());
  await finishPhasedJobOnRefusal(ctx, jobId, result);
  return result;
}

// The shared execution-time gate for a phase that is about to touch live
// providers. Refusal is terminal for the job and typed exactly as the
// single-process path types it (the error class name as errorCode), because
// a job whose eligibility has gone is not going to become eligible by
// sitting in a queue.
async function assertPhaseLiveAdmitted(
  ctx: PhaseWorkerContext,
  job: typeof researchJobs.$inferSelect,
  phase: string,
): Promise<{ ok: true } | { ok: false; result: PhaseHandlerResult }> {
  const config = await loadProductConfig(ctx.db);
  const [project] = job.projectId
    ? await ctx.db.select().from(projects).where(eq(projects.id, job.projectId))
    : [];
  if (!project) {
    // Same claim-before-terminal rule as the refusal branch below.
    if (job.state === "QUEUED") await claimResearchJob(ctx.db, job.id);
    await finishPhasedJob(
      ctx.db,
      job.id,
      { state: "FAILED", terminationReason: "SYSTEM_OR_PROVIDER_FAILURE", errorCode: "PROJECT_NOT_FOUND" },
      job.entitlementAtStart,
      "phase " + phase + ": project not resolvable",
    );
    return { ok: false, result: { ran: false, refusal: "JOB_NOT_RUNNABLE" } };
  }
  try {
    await assertOwnerAlphaLive(
      ctx.db,
      { origin: job.origin, userId: job.userId, projectSlug: project.slug },
      config.internal_alpha_enabled,
    );
    return { ok: true };
  } catch (e) {
    // The DB state machine (0001_state_machine.sql) has no QUEUED->FAILED
    // edge: a job must be picked up before it can fail. The single-process
    // path satisfies that by claiming first and failing later; a phase
    // that refuses BEFORE claiming has to do the same, or the terminal
    // write is rejected by the trigger and the message is retried forever.
    // Claiming here is also the honest record: this worker did take the
    // job, and then refused it.
    if (job.state === "QUEUED") await claimResearchJob(ctx.db, job.id);
    console.error("[worker] phase " + phase + " refused before any provider call", e);
    await finishPhasedJob(
      ctx.db,
      job.id,
      {
        state: "FAILED",
        terminationReason: "SYSTEM_OR_PROVIDER_FAILURE",
        errorCode: e instanceof Error ? e.name : "OWNER_ALPHA_LIVE_REFUSED",
      },
      job.entitlementAtStart,
      "phase " + phase + ": live admission refused",
    );
    return { ok: false, result: { ran: false, refusal: "JOB_NOT_RUNNABLE" } };
  }
}

// The EXTRACTING message. The executor is resolved through the SAME
// owner-alpha admission gate the single-process path uses; only the
// acquisition providers differ, and they are replays of this job's own
// persisted state.
export async function dispatchExtractQueueMessage(
  ctx: PhaseWorkerContext,
  jobId: string,
): Promise<PhaseHandlerResult> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) return { ran: false, refusal: "NOT_FOUND" };
  const config = await loadProductConfig(ctx.db);

  let result: PhaseHandlerResult;
  try {
    result = await handleExtractingPhase(ctx, jobId, async (replay) =>
      resolveOwnerAlphaExtractionExecutor({
        db: ctx.db,
        job,
        project: replay.project,
        internalAlphaEnabled: config.internal_alpha_enabled,
        replay: {
          queryProposer: replay.queryProposer,
          searchGateway: replay.searchGateway,
          contentFetcher: replay.contentFetcher,
        },
      }),
    );
  } catch (e) {
    console.error("[worker] phased extraction failed", e);
    const budget = e instanceof BudgetExhaustedError;
    await finishPhasedJob(
      ctx.db,
      jobId,
      {
        state: budget ? "BUDGET_LIMIT_REACHED" : "FAILED",
        terminationReason: budget ? "BUDGET_EXHAUSTED" : "SYSTEM_OR_PROVIDER_FAILURE",
        errorCode: budget ? null : e instanceof Error ? e.name : "ENGINE_EXECUTION_FAILED",
      },
      job.entitlementAtStart,
      "phased extraction failed",
    );
    return { ran: false, refusal: "JOB_NOT_RUNNABLE" };
  }

  if (result.ran) {
    // The SAME terminal mapping the single-process path uses — one
    // vocabulary for one engine, whatever process it ran in.
    const outcome = result.budgetExhausted
      ? { state: "BUDGET_LIMIT_REACHED" as const, terminationReason: "BUDGET_EXHAUSTED", errorCode: null }
      : result.controller
        ? mapEngineOutcome(result.controller.stopReason)
        : null;
    if (outcome) {
      await finishPhasedJob(
        ctx.db,
        jobId,
        outcome,
        job.entitlementAtStart,
        "engine: " + outcome.terminationReason,
      );
    }
  } else {
    await finishPhasedJobOnRefusal(ctx, jobId, result);
  }
  return result;
}

// A message this process is not configured to serve must go BACK to the
// queue for a worker that is — never be consumed, never be silently
// dropped. Throwing is how pg-boss is told the message was not handled.
export class PhaseCapabilityMissingError extends Error {
  constructor(public readonly phase: string) {
    super("this worker is not configured to serve phase " + phase);
    this.name = "PhaseCapabilityMissingError";
  }
}

function throwIfCapabilityRefusal(result: PhaseHandlerResult, phase: string): void {
  if (!result.ran && result.refusal === "CAPABILITY_NOT_CONFIGURED") {
    throw new PhaseCapabilityMissingError(phase);
  }
}

// Entrypoint worker-процесса. В Фазе 1 хендлер — no-op (инфраструктура);
// реальный research-pipeline подключается в Фазах 4–6.
export async function startWorker() {
  const { db, pool } = createDatabase();
  const boss = createBoss();
  boss.on("error", (err) => console.error("[pg-boss]", err));

  await boss.start();
  await boss.createQueue(RESEARCH_QUEUE);
  await boss.createQueue(RESEARCH_FETCH_QUEUE);
  await boss.createQueue(RESEARCH_EXTRACT_QUEUE);

  // D-136 — what this process may do is DECLARED, in one env var, and
  // never inferred from what it happens to be able to reach.
  const capabilities: ReadonlySet<PhaseCapability> = loadWorkerCapabilities();

  // D-149 — the environment must agree with the declared capability. A
  // source-acquisition process whose egress has been redirected cannot
  // honour its pinned-address contract, and the failure would be silent, so
  // it refuses to start at all. Asserted BEFORE the renderer is installed
  // and before any queue is subscribed: a process that should not run must
  // not first acquire resources or accept a message.
  assertDirectAcquisitionEgress(capabilities);

  const ctx: PhaseWorkerContext = { db, boss, capabilities };

  // D-146 Slice 2 — the renderer is installed BEFORE any queue is served,
  // so no FETCHING message can ever be picked up by a process that is
  // still deciding whether it can render. Only the FETCH role installs
  // one; a declared-but-broken renderer fails startup here rather than
  // degrading quietly (see renderer-capability.ts). The self-test opens
  // no source and reserves no budget.
  const renderer = await installFetchRendererCapability({ capabilities });
  console.log("[worker] renderer capability:", renderer.outcome);

  await sweepStaleRunningJobs(db);
  // Runs after boss.start()/createQueue above, so the queue tables this
  // reads are guaranteed to exist.
  await reconcileExhaustedPhaseDeliveries(db);
  await runMaintenance(db);
  const maintenanceTimer = setInterval(() => {
    runMaintenance(db).catch((e) => console.error("[maintenance]", e));
    // Separate call, separate catch: a queue-reconciliation failure must not
    // stop session/rate-limit maintenance, or the reverse. A delivery can
    // exhaust its retries long after this process started, so this is
    // periodic rather than startup-only.
    reconcileExhaustedPhaseDeliveries(db).catch((e) =>
      console.error("[phase reconcile]", e),
    );
  }, 10 * 60 * 1000);

  // D-149 — WHO MAY SERVE THE ENTRY QUEUE.
  //
  // The entry queue carries two kinds of work: legacy single-process jobs,
  // which need no phase capability, and — because PHASE_QUEUE.SEARCHING is
  // this same queue — the SEARCHING phase, which requires SEARCH_EXTRACT.
  // It used to be subscribed unconditionally, which was safe only while one
  // worker existed. With two roles running permanently, a source-only
  // worker would take SEARCHING messages it can never execute and hand them
  // back by throwing — and every hand-back spends one of the message's
  // bounded deliveries. Enough unlucky pickups and a perfectly good
  // Research is terminated as PHASE_DELIVERY_EXHAUSTED for no reason but
  // which process happened to poll first.
  //
  // The fix is not a bigger retry budget — that would only make the wrong
  // outcome rarer while hiding it. A worker simply does not subscribe to
  // work it is structurally incapable of doing, which is the rule the other
  // two queues have always followed.
  //
  // A worker that declares NO capability at all is unchanged: it is the
  // single-process box, it serves the entry queue, and legacy jobs need no
  // phase capability. Only a worker that HAS declared its roles and did not
  // declare SEARCH_EXTRACT stays out — it has said, in the one place the
  // system reads such statements, that model and search work is not its job.
  const servesEntryQueue =
    capabilities.size === 0 || workerServesPhase(capabilities, "SEARCHING");
  if (servesEntryQueue) {
    await boss.work<ResearchQueuePayload>(RESEARCH_QUEUE, async ([task]) => {
      const out = await dispatchResearchQueueMessage(ctx, task.data.jobId);
      // Still thrown rather than swallowed: a refusal that reaches here is
      // now a real inconsistency, and returning normally would COMPLETE the
      // message and lose the job.
      if (out.kind === "PHASED") throwIfCapabilityRefusal(out.result, "SEARCHING");
    });
  }

  // The phase queues are served ONLY by a process configured for them.
  if (workerServesPhase(capabilities, "FETCHING")) {
    await boss.work<ResearchQueuePayload>(RESEARCH_FETCH_QUEUE, async ([task]) => {
      throwIfCapabilityRefusal(await dispatchFetchQueueMessage(ctx, task.data.jobId), "FETCHING");
    });
  }
  if (workerServesPhase(capabilities, "EXTRACTING")) {
    await boss.work<ResearchQueuePayload>(RESEARCH_EXTRACT_QUEUE, async ([task]) => {
      throwIfCapabilityRefusal(await dispatchExtractQueueMessage(ctx, task.data.jobId), "EXTRACTING");
    });
  }

  // Both signals are handled, and a supervisor may well send both — so
  // teardown runs exactly once. Uninstalling the renderer first is what
  // makes the ordering meaningful: after this line renderedDocsAvailable()
  // is false, so a job still draining cannot begin a render while the
  // process is on its way out.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    uninstallRendererCapability();
    clearInterval(maintenanceTimer);
    await boss.stop({ graceful: true });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const servedQueues = [
    ...(servesEntryQueue ? [RESEARCH_QUEUE] : []),
    ...(workerServesPhase(capabilities, "FETCHING") ? [RESEARCH_FETCH_QUEUE] : []),
    ...(workerServesPhase(capabilities, "EXTRACTING") ? [RESEARCH_EXTRACT_QUEUE] : []),
  ];
  console.log(
    "[worker] started, queues:",
    servedQueues.join(", "),
    "capabilities:",
    [...capabilities].join(",") || "(none — single-process jobs only)",
    "renderer:",
    renderer.outcome,
  );
}

// Запуск: npm run worker:dev
if (process.argv[1] && process.argv[1].endsWith("worker.ts")) {
  startWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
