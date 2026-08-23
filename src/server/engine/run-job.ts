import { desc, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchComponentResults, researchJobs, researchPlans } from "../db/schema";
import { BudgetExhaustedError } from "./budget-exhausted-error";
import { buildContractView } from "./contract-view";
import type { ContractView } from "./contract-view";
import { runResearchController } from "./controller";
import type { ControllerRunResult, WorkExecutor } from "./controller";
import { parseContract } from "../memory/contract";
import { loadActivePatternVersion, MissingActivePatternError } from "./active-pattern";
import { reconcileAndPersistComponent, reconcileOutstandingComponents } from "./component-reconciliation-store";
import { assembleAndPersistMechanism } from "./mechanism-assembly-store";
import { evaluateAndPersistClaimSupport } from "./claim-support-store";

// Phase 6, S4 — the actual production wiring point: given a jobId, load
// its frozen entitlement/budget, its persisted Research Boundary
// Contract (Phase 5), and the topic's ACTIVE Pattern version (Phase-6-
// safe lookup, active-pattern.ts), build a ContractView (S0), and hand it
// to the deterministic controller (S3) together with a WorkExecutor.
//
// This function is NOT wired into the job worker/pg-boss queue — Phase 6
// stays behind research_enabled=false regardless (§17), and S10 (live
// provider execution) does not exist yet for this function's output to
// feed into. It exists so activePatternVersion resolution has one real,
// testable production caller instead of remaining test-only.
//
// HIGH-1 (deep audit, phase-6-s5-audit.md) — S5's reconcileAndPersistComponent
// was, until this fix, reachable only from tests: this is the ONE
// declared production integration point (the module comment above said so
// before this fix even existed), so it is the one that must actually pass
// the hook. research_enabled=false still gates live provider execution
// (§17/D-028) — it was never a justification for leaving the deterministic
// S4->S5 wiring itself untested-in-production; a fixture/deterministic
// executor already exercises this path end-to-end today.
//
// HIGH-2 (deep audit) — the per-attempt `reconcile` hook the controller
// calls (controller.ts) cannot by itself survive a crash between the
// attempt's terminal UPDATE and the hook's own persistence (see that
// hook's doc comment) — a component already SUCCEEDED on a PRIOR run is
// never revisited by the controller's inner loop on a later run at all
// (it is filtered out of `pending` before the loop even starts). The fix
// is a sweep AFTER the controller returns: reconcile every workQueue
// (step, component) whose S4 attempt is already terminal, regardless of
// whether it was reconciled by the per-attempt hook a moment ago in THIS
// call or was already terminal from a run that crashed before ever
// reaching S5. reconcileAndPersistComponent is a derived-projection
// upsert (§11.3) — re-running it for an already-reconciled component is
// deterministic, cheap, and never re-spends search/fetch/model budget
// (D-084's "S5 does not trigger new research" boundary, §12 of the plan).

// S4 review fix (LOW-1): the approved plan requires the active Pattern
// version to match the stored contract, or the job fails explicitly.
// Silently passing `undefined` when no ACTIVE row exists (buildContractView
// simply skips its own cross-check for `undefined` — contract-view.ts is
// frozen and untouched here) would let a topic with no ACTIVE Pattern run
// research unchecked. This module hard-fails BEFORE calling
// buildContractView instead. MissingActivePatternError now lives in
// active-pattern.ts (shared with component-reconciliation-store.ts's own
// HIGH-4 check) — re-exported here so existing callers/imports of this
// module keep working unchanged.
export { MissingActivePatternError };

export async function runS4ResearchJob(
  db: Database | Transaction,
  jobId: string,
  executor: WorkExecutor,
  now: Date,
): Promise<ControllerRunResult> {
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  if (!job.topicId) throw new Error(`research job ${jobId} has no topicId`);

  const [planRow] = await db
    .select()
    .from(researchPlans)
    .where(eq(researchPlans.researchJobId, jobId))
    .orderBy(desc(researchPlans.version))
    .limit(1);
  if (!planRow) throw new Error(`no research_plans row for job ${jobId}`);

  const contract = parseContract(planRow.contract);
  const activePatternVersion = await loadActivePatternVersion(db, job.topicId);
  if (activePatternVersion === null) {
    throw new MissingActivePatternError(
      `no ACTIVE research_patterns row for topic ${job.topicId} — refusing to run research without a confirmed active Pattern version`,
    );
  }

  const view: ContractView = buildContractView({
    contract,
    mode: planRow.mode,
    capabilityAtStart: job.capabilityAtStart,
    activePatternVersion,
  });

  let result: ControllerRunResult;
  try {
    result = await runResearchController({
      db,
      jobId,
      view,
      executor,
      now,
      reconcile: reconcileAndPersistComponent,
    });
  } catch (e) {
    // D-127 — dimensional budget exhaustion must still produce the derived
    // projections. s4-executor.ts signals an exhausted job budget AXIS
    // (searchQueries/sourceOpens/modelCostMicro) by THROWING
    // BudgetExhaustedError, which propagated straight past the S5 sweep /
    // S6 assembly / S7 claim-support steps below and left the job with
    // evidence and component results persisted but NO mechanism and NO
    // research_claim_support row at all — a blank "stopped, no finding"
    // screen despite fully paid-for research.
    //
    // That contradicts the terminal contract worker.ts already documents
    // for this exact case: "budget exhaustion with incomplete evidence is
    // NOT a system/provider failure — research_claim_support may
    // legitimately be INSUFFICIENT_EVIDENCE for this job, and that is an
    // honest evidentiary outcome". The controller's OWN attempt-count
    // BUDGET_EXHAUSTED stop reason (returned, not thrown) already reaches
    // those steps normally — so the same logical condition produced two
    // different behaviours depending only on which mechanism detected it.
    //
    // These three steps are pure derived projections over ALREADY-persisted
    // rows (see their own doc comments: "never re-spends S4 budget or
    // repeats paid research"), so running them here spends nothing, calls
    // no provider, and cannot manufacture evidence or support. The
    // exception is re-thrown unchanged afterwards, so the job's terminal
    // state stays exactly BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED.
    //
    // Deliberately NARROW in two independent ways:
    //
    //  1. Only BudgetExhaustedError. A CapabilityFatalError or any other
    //     exception still propagates immediately, untouched — a broken
    //     capability is not an evidentiary outcome.
    //
    //  2. Only when the S5 sweep actually produced component results.
    //     A job whose budget was refused before ANY component reached a
    //     terminal S4 attempt has genuinely nothing to project: it stopped
    //     before S7 with no research performed, and inventing an empty
    //     assembly + claim-support row for it would assert an evidentiary
    //     conclusion about work that never happened. That "stopped before
    //     S7" case is an accepted S10 outcome (D-120) and stays exactly as
    //     it was. Only a job that DID do real, already-paid-for research
    //     before running out of budget gets its projection.
    if (e instanceof BudgetExhaustedError) {
      await reconcileOutstandingComponents(db, jobId, view.workQueue, now);
      const reconciled = await db
        .select({ id: researchComponentResults.id })
        .from(researchComponentResults)
        .where(eq(researchComponentResults.researchJobId, jobId))
        .limit(1);
      if (reconciled.length > 0) {
        await assembleAndPersistMechanism(db, jobId, now);
        await evaluateAndPersistClaimSupport(db, jobId, now);
      }
    }
    throw e;
  }

  // HIGH-2: cover every workQueue component whose S4 attempt is already
  // terminal, not just the ones this call's own inner loop attempted —
  // this is what makes S5 eventually consistent across a crash/restart
  // even though the per-attempt hook alone cannot be (see doc comment
  // above).
  await reconcileOutstandingComponents(db, jobId, view.workQueue, now);

  // Phase 6, S6 (phase-6-s6-plan.md §27) — assembly is a derived
  // projection over whatever S5 results currently exist, same discipline
  // as the S5 sweep above: re-running it after every call is
  // deterministic, cheap, and never re-spends S4 budget or repeats paid
  // research. This is what makes S6 eventually consistent across a
  // crash/restart between S5 persistence and S6 assembly, without a
  // separate per-attempt hook (S6 has no per-component granularity to
  // hook into — it consumes the whole job's S5 result set at once).
  await assembleAndPersistMechanism(db, jobId, now);

  // Phase 6, S7 (phase-6-s7-plan.md §34) — claim support is a derived
  // projection over whatever S6 assembly currently exists, same
  // discipline as the S6 assembly step above. evaluateAndPersistClaimSupport
  // returns null (no-op) when no S6 projection exists yet for this job —
  // S7 never runs ahead of S6, and this is not a failure, just "not yet".
  await evaluateAndPersistClaimSupport(db, jobId, now);

  return result;
}
