import { loadEnvConfig } from "@next/env";
import { eq, sql } from "drizzle-orm";

import { deleteStaleRateLimits } from "../auth/rate-limit";
import { deleteExpiredSessions } from "../auth/session";
import { loadProductConfig } from "../config/product";
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
  resolveOwnerAlphaExtractionExecutor,
  resolveOwnerAlphaWorkExecutor,
} from "./owner-alpha-routing";
import {
  createBoss,
  RESEARCH_EXTRACT_QUEUE,
  RESEARCH_FETCH_QUEUE,
  RESEARCH_QUEUE,
  type ResearchQueuePayload,
} from "./queue";
import { claimResearchJob, resolveDemoReservation, transitionJobState } from "./research-jobs";
import { resolveContentFetcher } from "../engine/providers/content-fetcher";
import { resolveQueryProposer } from "../engine/providers/query-proposer";
import { resolveSearchGateway } from "../engine/providers/search-gateway";
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
export async function sweepStaleRunningJobs(db: Database): Promise<number> {
  const stale = await db
    .select({ id: researchJobs.id, level: researchJobs.entitlementAtStart })
    .from(researchJobs)
    .where(
      sql`${researchJobs.state} = 'RUNNING'
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
  // Live search providers are resolved here, in the worker, exactly where
  // the single-process path resolves its own — this module is the one
  // place that decides a real provider may be constructed, and the
  // resolvers themselves still fail closed when unconfigured.
  const result = await handleSearchingPhase(ctx, jobId, {
    queryProposer: await resolveQueryProposer(),
    searchGateway: resolveSearchGateway(),
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
  const result = await handleFetchingPhase(ctx, jobId, resolveContentFetcher());
  await finishPhasedJobOnRefusal(ctx, jobId, result);
  return result;
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
  const ctx: PhaseWorkerContext = { db, boss, capabilities };

  await sweepStaleRunningJobs(db);
  await runMaintenance(db);
  const maintenanceTimer = setInterval(
    () => runMaintenance(db).catch((e) => console.error("[maintenance]", e)),
    10 * 60 * 1000,
  );

  // The entry queue is always served: it still carries single-process
  // jobs, which need no phase capability at all.
  await boss.work<ResearchQueuePayload>(RESEARCH_QUEUE, async ([task]) => {
    const out = await dispatchResearchQueueMessage(ctx, task.data.jobId);
    if (out.kind === "PHASED") throwIfCapabilityRefusal(out.result, "SEARCHING");
  });

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

  const shutdown = async () => {
    clearInterval(maintenanceTimer);
    await boss.stop({ graceful: true });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const servedQueues = [
    RESEARCH_QUEUE,
    ...(workerServesPhase(capabilities, "FETCHING") ? [RESEARCH_FETCH_QUEUE] : []),
    ...(workerServesPhase(capabilities, "EXTRACTING") ? [RESEARCH_EXTRACT_QUEUE] : []),
  ];
  console.log(
    "[worker] started, queues:",
    servedQueues.join(", "),
    "capabilities:",
    [...capabilities].join(",") || "(none — single-process jobs only)",
  );
}

// Запуск: npm run worker:dev
if (process.argv[1] && process.argv[1].endsWith("worker.ts")) {
  startWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
