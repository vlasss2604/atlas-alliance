import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { loadProductConfig } from "../config/product";
import type { Database } from "../db/client";
import { projects, researchJobs, researchPlans } from "../db/schema";
import { BudgetExhaustedError } from "../engine/budget-exhausted-error";
import type { ControllerRunResult, WorkExecutor } from "../engine/controller";
import {
  loadFetchTargets,
  prepareExtractionReplayFetcher,
  prepareExtractionReplayProposer,
  prepareExtractionReplaySearch,
  runFetchPhase,
  runSearchPhase,
  type FetchPhaseResult,
  type SearchPhaseResult,
} from "../engine/acquisition-phases";
import type { ComponentWorkItem } from "../engine/contract-view";
import { loadJobContractView } from "../engine/job-contract-view";
import type { ContentFetcher } from "../engine/providers/content-fetcher";
import type { ModelCostProfile } from "../engine/model-cost-profile";
import type { QueryProposer } from "../engine/providers/query-proposer";
import type { SearchGateway } from "../engine/providers/search-gateway";
import type { ComponentTarget, ModelUsage } from "../engine/providers/types";
import { runS4ResearchJob } from "../engine/run-job";
import { runMemoryPlanningStage } from "../memory/plan-job";
import { enqueueAcquisitionPhaseInTx, initializeAcquisitionPhaseInTx } from "./queue";
import { claimResearchJob, resolveDemoReservation, transitionJobState } from "./research-jobs";
import type { AcquisitionPhase, PhaseCapability } from "./worker-capabilities";
import { workerServesPhase } from "./worker-capabilities";

// D-136 SLICE 2 — the durable orchestration that carries Slice 1's
// already-proven phase functions across process and network boundaries.
//
// This module adds NO research logic. Every phase body is one call into
// engine/acquisition-phases.ts (Slice 1) or one call into
// engine/run-job.ts (the existing controller entrypoint). What it owns is
// exactly the part that only exists once a job crosses processes:
//   - deciding whether THIS process may run THIS phase (capabilities);
//   - refusing, closed, every message that does not match the job's own
//     persisted phase;
//   - advancing the persisted phase and enqueueing the next phase's
//     message in ONE transaction;
//   - tolerating at-least-once delivery without repeating paid work.
//
// It is still not a second controller: it schedules PHASES, of which
// there are three, in a fixed order, with no branching and no retry
// policy of its own. Component scheduling, attempt numbering and the
// recovery budget remain entirely inside controller.ts, which runs
// exactly once, in EXTRACTING.

// Closed refusal vocabulary. Every one of these means "this delivery did
// no work, and that is correct" — never "something broke".
export type PhaseRefusal =
  // No such job.
  | "NOT_FOUND"
  // The job does not run the phased path at all (acquisition_phase IS
  // NULL): a historical row, or one the single-process worker owns.
  | "NOT_PHASED"
  // The message names a phase the job is not in. Covers BOTH directions:
  // a stale message for a phase already completed, and a premature
  // message for a phase whose prerequisites have not been committed.
  | "PHASE_MISMATCH"
  // The job is no longer runnable (terminal state). This is also what a
  // duplicate EXTRACTING delivery meets after extraction has finished.
  | "JOB_NOT_RUNNABLE"
  // This worker process is not configured to serve this phase. The
  // message must NOT be consumed in production — a capable worker still
  // has to get it.
  | "CAPABILITY_NOT_CONFIGURED";

export type PhaseHandlerResult =
  | { ran: false; refusal: PhaseRefusal }
  | {
      ran: true;
      phase: AcquisitionPhase;
      // Set when this delivery advanced the persisted phase and enqueued
      // the next one. Null for EXTRACTING (the last phase) and whenever
      // the advance found the phase already moved on.
      advancedTo: AcquisitionPhase | null;
      search?: SearchPhaseResult;
      fetch?: FetchPhaseResult;
      controller?: ControllerRunResult;
      // Set instead of `controller` when extraction stopped on an
      // exhausted job budget axis — an honest evidentiary outcome, mapped
      // by the caller exactly as the single-process worker maps it.
      budgetExhausted?: boolean;
    };

// The providers a phase needs, supplied by the caller. Production wiring
// resolves these behind the SAME admission gate the single-process live
// path already uses (owner-alpha-routing.ts); tests inject fixtures. This
// module never resolves a provider itself, so it can never widen what a
// job is allowed to reach.
export interface SearchPhaseProviders {
  queryProposer: QueryProposer;
  searchGateway: SearchGateway;
  // D-140 — the proposer is a real model call and must be charged. The
  // caller that RESOLVED the provider is the only one that can wire its
  // usage callback and knows which cost profile it was resolved under, so
  // both travel with the provider rather than being guessed here.
  queryProposerCostProfile?: ModelCostProfile;
  readProposerUsage?: () => ModelUsage | null | undefined;
}

export interface PhaseWorkerContext {
  db: Database;
  boss: PgBoss;
  capabilities: ReadonlySet<PhaseCapability>;
}

type ProjectRow = typeof projects.$inferSelect;
type JobRow = typeof researchJobs.$inferSelect;

// A message is admissible only if this process may serve the phase and
// the job exists, is phased, is still runnable, and its OWN persisted
// phase is the one the message names. Read-only: it decides nothing, it
// only refuses.
async function admitPhaseMessage(
  db: Database,
  jobId: string,
  phase: AcquisitionPhase,
  capabilities: ReadonlySet<PhaseCapability>,
): Promise<{ ok: true; job: JobRow } | { ok: false; refusal: PhaseRefusal }> {
  if (!workerServesPhase(capabilities, phase)) {
    return { ok: false, refusal: "CAPABILITY_NOT_CONFIGURED" };
  }
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) return { ok: false, refusal: "NOT_FOUND" };
  if (job.acquisitionPhase === null) return { ok: false, refusal: "NOT_PHASED" };
  if (job.state !== "QUEUED" && job.state !== "RUNNING") {
    return { ok: false, refusal: "JOB_NOT_RUNNABLE" };
  }
  if (job.acquisitionPhase !== phase) return { ok: false, refusal: "PHASE_MISMATCH" };
  return { ok: true, job };
}

// THE ATOMIC HANDOFF.
//
// One transaction contains both halves: the conditional phase advance and
// the next phase's queue message (written through the same client by
// pg-boss's own transactional send — the mechanism createResearchJob has
// used for the entry queue since Phase 1). Therefore:
//
//   - no commit => neither the advance nor the message exists;
//   - commit    => both exist.
//
// The advance is conditional on the CURRENT phase (WHERE acquisition_phase
// = from), which makes it the same atomic-claim shape as
// claimResearchJob: two concurrent deliveries of the same phase cannot
// both advance, so the next phase is enqueued exactly once.
export async function advancePhaseAndEnqueue(
  db: Database,
  boss: PgBoss,
  jobId: string,
  from: AcquisitionPhase,
  to: AcquisitionPhase,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(researchJobs)
      .set({ acquisitionPhase: to, acquisitionPhaseAt: sql`now()` })
      .where(and(eq(researchJobs.id, jobId), eq(researchJobs.acquisitionPhase, from)))
      .returning({ id: researchJobs.id });
    if (rows.length === 0) return false;
    await enqueueAcquisitionPhaseInTx(boss, tx, jobId, to);
    return true;
  });
}

// Admission for the phased path. Marks the job as phased and enqueues its
// FIRST phase in one transaction — same rule as every later handoff.
// Deliberately separate from createResearchJob: an existing caller keeps
// creating exactly the jobs it created before, and nothing about
// entitlement, quota or eligibility is touched here.
// D-138: the product admission path needs this INSIDE the transaction
// that creates the job, so the two writes live in
// initializeAcquisitionPhaseInTx (queue.ts) and this wrapper only opens a
// transaction around it. One implementation, two entry points — a caller
// that already owns a transaction must never get a second, subtly
// different version of "start the phases".
export async function beginAcquisitionPhases(
  db: Database,
  boss: PgBoss,
  jobId: string,
): Promise<boolean> {
  return db.transaction((tx) => initializeAcquisitionPhaseInTx(boss, tx, jobId));
}

async function loadProject(db: Database, job: JobRow): Promise<ProjectRow> {
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId as string));
  if (!project) throw new Error(`research job ${job.id} has no resolvable project`);
  return project;
}

function targetFor(project: ProjectRow) {
  return (item: ComponentWorkItem): ComponentTarget => ({
    step: item.step,
    stepName: item.stepName,
    component: item.component,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });
}

function budgetOf(job: JobRow): {
  maxSearchQueries: number;
  maxSourceOpens: number;
  maxModelCostMicro: number;
} {
  const b = job.budgetAtStart as {
    maxSearchQueries: number;
    maxSourceOpens: number;
    maxModelCostMicro: number;
  };
  return {
    maxSearchQueries: b.maxSearchQueries,
    maxSourceOpens: b.maxSourceOpens,
    maxModelCostMicro: b.maxModelCostMicro,
  };
}

// PHASE 1 — SEARCHING. Role: SEARCH_EXTRACT.
//
// Claims the job the same way the single-process worker does, runs the
// existing planning stage, then hands the CONTROLLER'S OWN work queue to
// Slice 1's runSearchPhase. Creates no research_attempts and consumes no
// recovery step: the controller has not started and will not start until
// EXTRACTING.
export async function handleSearchingPhase(
  ctx: PhaseWorkerContext,
  jobId: string,
  providers: SearchPhaseProviders,
  opts?: { maxResultsPerQuery?: number; maxQueriesPerComponent?: number },
): Promise<PhaseHandlerResult> {
  const admitted = await admitPhaseMessage(ctx.db, jobId, "SEARCHING", ctx.capabilities);
  if (!admitted.ok) return { ran: false, refusal: admitted.refusal };

  // QUEUED -> RUNNING exactly once, by the same atomic claim the
  // single-process path uses. An already-RUNNING job (a redelivery, or a
  // resumed phase) simply continues: the persisted phase is the authority
  // for what still needs doing, and every step below is idempotent.
  await claimResearchJob(ctx.db, jobId);

  // Planning runs ONCE per job. research_plans is unique per (job,
  // version), so a redelivered SEARCHING message must not plan again —
  // and must not need to: the persisted plan is the same contract the
  // first delivery wrote, and every step after it reads that row rather
  // than any in-memory result. Resume, not repeat.
  const [existingPlan] = await ctx.db
    .select({ id: researchPlans.id })
    .from(researchPlans)
    .where(eq(researchPlans.researchJobId, jobId))
    .limit(1);
  if (!existingPlan) {
    await runMemoryPlanningStage(ctx.db, jobId);
  }
  const { job, view } = await loadJobContractView(ctx.db, jobId);
  const project = await loadProject(ctx.db, job);

  const search = await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue,
    target: targetFor(project),
    queryProposer: providers.queryProposer,
    searchGateway: providers.searchGateway,
    maxSearchQueries: budgetOf(job).maxSearchQueries,
    maxResultsPerQuery: opts?.maxResultsPerQuery ?? 5,
    maxQueriesPerComponent: opts?.maxQueriesPerComponent ?? 2,
    // D-140 — one model envelope, shared with extraction; and the
    // project whose Pattern says which components the intent requires.
    maxModelCostMicro: budgetOf(job).maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: providers.queryProposerCostProfile,
    readProposerUsage: providers.readProposerUsage,
  });

  const advanced = await advancePhaseAndEnqueue(ctx.db, ctx.boss, jobId, "SEARCHING", "FETCHING");
  return { ran: true, phase: "SEARCHING", advancedTo: advanced ? "FETCHING" : null, search };
}

// PHASE 2 — FETCHING. Role: FETCH.
//
// Consumes ONLY the persisted candidate handoff and seals what the
// bounded transport returns. No model, no search, no attempts, no
// Evidence. A redelivery finds every url already fetched or already known
// dead and seals nothing further.
export async function handleFetchingPhase(
  ctx: PhaseWorkerContext,
  jobId: string,
  contentFetcher: ContentFetcher,
): Promise<PhaseHandlerResult> {
  const admitted = await admitPhaseMessage(ctx.db, jobId, "FETCHING", ctx.capabilities);
  if (!admitted.ok) return { ran: false, refusal: admitted.refusal };
  const job = admitted.job;
  const project = await loadProject(ctx.db, job);

  let fetch: Awaited<ReturnType<typeof runFetchPhase>>;
  try {
    fetch = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher,
      maxSourceOpens: budgetOf(job).maxSourceOpens,
    });
  } catch (e) {
    // AN UNEXPECTED FAILURE HERE ENDS THE JOB, IT DOES NOT ESCAPE.
    //
    // This phase seals documents, and sealing writes external text to the
    // database. A rejected write throws, and before this catch existed the
    // throw travelled out of the phase, out of the dispatcher and into
    // pg-boss — which then could not persist its OWN failure output,
    // because the value it was serialising carried the very character the
    // first write was rejected for. The queue item stayed active with no
    // output and the Research stayed RUNNING forever: the mechanism that
    // should have recorded the failure was the mechanism that failed.
    //
    // The EXTRACTING phase below already owns its throws. This is the same
    // discipline, and the terminal write is the one
    // `assertPhaseLiveAdmitted` already uses for a phase that cannot
    // proceed — no new failure architecture, no new refusal value.
    //
    // THE ERROR CODE IS A CONSTANT, not `e.name`. Everything persisted from
    // here has to be storable unconditionally, or this catch acquires the
    // failure mode it exists to remove. The classification detail is
    // logged, where no column can reject it.
    console.error("[worker] phase FETCHING failed unexpectedly", e);
    await finishPhasedJob(
      ctx.db,
      jobId,
      {
        state: "FAILED",
        // TECHNICAL FAILURE != PROJECT REALITY. This says the run broke,
        // and says nothing whatever about the project — no component is
        // resolved, no FETCH_OK is written, and no Evidence is invented.
        terminationReason: "SYSTEM_OR_PROVIDER_FAILURE",
        errorCode: "FETCH_PHASE_FAILED",
      },
      job.entitlementAtStart,
      "phase FETCHING: unexpected failure",
    );
    return { ran: false, refusal: "JOB_NOT_RUNNABLE" };
  }

  const advanced = await advancePhaseAndEnqueue(ctx.db, ctx.boss, jobId, "FETCHING", "EXTRACTING");
  return { ran: true, phase: "FETCHING", advancedTo: advanced ? "EXTRACTING" : null, fetch };
}

// PHASE 3 — EXTRACTING. Role: SEARCH_EXTRACT.
//
// Builds the replay providers over this job's OWN persisted phase-1 and
// phase-2 outputs, then runs the ordinary controller entrypoint exactly
// once. Everything downstream — attempt numbering, the recovery budget,
// S5, S6, S7, S8, S9 — is untouched and unaware that the job crossed a
// process boundary at all.
//
// The executor comes from the caller so that the live-provider admission
// gate stays where it already is. This function only decides WHICH
// persisted state the executor is allowed to replay.
export async function handleExtractingPhase(
  ctx: PhaseWorkerContext,
  jobId: string,
  buildExecutor: (replay: {
    queryProposer: QueryProposer;
    searchGateway: SearchGateway;
    contentFetcher: ContentFetcher;
    project: ProjectRow;
    documentCount: number;
  }) => Promise<WorkExecutor> | WorkExecutor,
  now: Date = new Date(),
): Promise<PhaseHandlerResult> {
  const admitted = await admitPhaseMessage(ctx.db, jobId, "EXTRACTING", ctx.capabilities);
  if (!admitted.ok) return { ran: false, refusal: admitted.refusal };
  const project = await loadProject(ctx.db, admitted.job);

  const { fetcher, documentCount } = await prepareExtractionReplayFetcher(ctx.db, jobId);
  const executor = await buildExecutor({
    queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
    searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
    contentFetcher: fetcher,
    project,
    documentCount,
  });

  try {
    const controller = await runS4ResearchJob(ctx.db, jobId, executor, now);
    return { ran: true, phase: "EXTRACTING", advancedTo: null, controller };
  } catch (e) {
    if (e instanceof BudgetExhaustedError) {
      // Same terminal contract the single-process worker already applies:
      // an exhausted budget axis is an honest evidentiary outcome, never
      // a system failure — and run-job.ts has already persisted the
      // derived projections for it (D-127).
      return { ran: true, phase: "EXTRACTING", advancedTo: null, budgetExhausted: true };
    }
    throw e;
  }
}

// The terminal write, shared by every phased failure and by extraction's
// own outcome. Identical in shape to the single-process worker's terminal
// transaction, including the DEMO reservation release — a phased job must
// not leave a quota slot reserved forever.
export async function finishPhasedJob(
  db: Database,
  jobId: string,
  outcome: {
    state: "SUCCEEDED" | "FAILED" | "BUDGET_LIMIT_REACHED";
    terminationReason: string;
    errorCode: string | null;
  },
  entitlementAtStart: string,
  note: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(researchJobs)
      .set({ errorCode: outcome.errorCode, terminationReason: outcome.terminationReason })
      .where(eq(researchJobs.id, jobId));
    await transitionJobState(tx, jobId, outcome.state, note);
    if (entitlementAtStart === "DEMO") {
      await resolveDemoReservation(tx, jobId, "RELEASED");
    }
  });
}

// Operator-facing, read-only: what phase a job is in, when it last moved,
// and the two counts that tell an operator whether the phase is actually
// making progress. Used by alpha-inspect; never by the engine.
export async function readAcquisitionPhase(
  db: Database,
  jobId: string,
): Promise<{
  phase: AcquisitionPhase | null;
  at: Date | null;
  pendingTargets: number;
  sealedDocuments: number;
} | null> {
  const [job] = await db
    .select({ phase: researchJobs.acquisitionPhase, at: researchJobs.acquisitionPhaseAt })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  if (!job) return null;
  if (job.phase === null) {
    return { phase: null, at: job.at, pendingTargets: 0, sealedDocuments: 0 };
  }
  const targets = await loadFetchTargets(db, jobId);
  const { documentCount } = await prepareExtractionReplayFetcher(db, jobId);
  return { phase: job.phase, at: job.at, pendingTargets: targets.length, sealedDocuments: documentCount };
}

// Kept adjacent to the handlers on purpose: the phased path must read the
// same product configuration the single-process path reads, so a future
// change to internal-alpha admission cannot apply to one and not the
// other.
export async function internalAlphaEnabled(db: Database): Promise<boolean> {
  const config = await loadProductConfig(db);
  return config.internal_alpha_enabled;
}
