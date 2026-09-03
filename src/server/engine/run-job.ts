import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchComponentResults } from "../db/schema";
import { BudgetExhaustedError } from "./budget-exhausted-error";
import { runResearchController } from "./controller";
import type { ControllerRunResult, WorkExecutor } from "./controller";
import { MissingActivePatternError } from "./active-pattern";
import { loadJobContractView } from "./job-contract-view";
import { reconcileAndPersistComponent, reconcileOutstandingComponents } from "./component-reconciliation-store";
import { runOnchainReactivationPass } from "./onchain-reactivation";
import { runPostEventSupplyCompletion } from "./onchain-post-event-supply";
import { assembleAndPersistMechanism } from "./mechanism-assembly-store";
import { evaluateAndPersistClaimSupport } from "./claim-support-store";
import { buildAndPersistProof } from "./proof-store";
import { generateQuestionProjectionSafely } from "./question-projection-store";

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
  // Lifted verbatim into job-contract-view.ts (D-136) so the search
  // phase derives the SAME work queue this controller run will walk.
  // Identical reads, identical order, identical failure messages.
  const { job, view } = await loadJobContractView(db, jobId);

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
        // S8 belongs on this path for the same reason S6/S7 do: a job
        // that did real, already-paid-for research before running out of
        // budget has a projectable result, and its Proof will honestly
        // carry whatever gaps the exhausted budget left behind.
        await buildAndPersistProof(db, jobId);
      }
    }
    throw e;
  }

  // DYNAMIC SUBJECT REACTIVATION — one bounded on-chain opportunity for a
  // component whose deterministic subject arrived AFTER it ran.
  //
  // Placed here, and only here, for two reasons that are both about
  // ordering. It runs AFTER the controller because that is the earliest
  // moment every locator this job will admit actually exists; and BEFORE
  // the S5 sweep below because that sweep is a derived projection over
  // persisted Evidence — so a component reactivated now is re-reconciled
  // from its new on-chain rows automatically, with no special case, and
  // NET_EFFECT then reads the applicable typed fact through the ordinary
  // applicability route. Nothing downstream needs to know this pass exists.
  //
  // Deliberately NOT on the BudgetExhaustedError path above: that job's
  // axis is spent, so a pass there could only spend components' one
  // opportunity on reservations that are certain to be refused.
  //
  // It creates no attempt, calls no model, runs no search and fetches no
  // document (see the module comment), and it cannot fail the job:
  // acquisition-level outcomes are recorded as observations and trace, the
  // same way the executor's own on-chain branch records them.
  await runOnchainReactivationPass(db, {
    jobId,
    projectId: job.projectId,
    workQueue: view.workQueue,
    maxSourceOpens: view.researchBudget.maxSourceOpens,
  });

  // POST-EVENT SUPPLY COMPLETION — one bounded reading, for a temporal gap
  // the deterministic events of this job just exposed.
  //
  // Placed here, and only here, for reasons that are all about ordering. It
  // runs AFTER the reactivation pass because the burn that creates the gap is
  // frequently established BY that pass, and because it must not compete with
  // it: reactivation's protected chain is what discovers the burn, and this
  // optional read holds no reservation of its own. It runs BEFORE the S5
  // sweep so the observation it persists is visible to ordinary later
  // processing with no special case.
  //
  // It is NOT folded into the reactivation pass. Their licences differ: that
  // one revisits a component whose subject arrived late, this one closes a
  // temporal gap that belongs to no component at all — which is also why its
  // trace carries no component and cannot consume any component's one
  // bounded opportunity.
  //
  // It creates no attempt, calls no model, runs no search, fetches no
  // document and writes no Evidence, and it cannot fail the job: every
  // outcome, budget refusal and provider failure included, is returned and
  // traced rather than thrown.
  await runPostEventSupplyCompletion(db, {
    jobId,
    projectId: job.projectId,
    maxSourceOpens: view.researchBudget.maxSourceOpens,
  });

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

  // Phase 6, S8 — the Proof. The same derived-projection discipline as S6
  // and S7 above: it reads only what S5/S6/S7 already persisted, makes no
  // model, network, RPC or search call, and re-running it is deterministic
  // and free. It refuses (writes nothing) when there is no S7 result, when
  // the job has no project, or when a human has already REVIEWED/VERIFIED
  // the existing Proof — every one of those is a legitimate outcome, not a
  // failure, so the refusal is returned rather than thrown and the job
  // result is unchanged by it.
  await buildAndPersistProof(db, jobId);

  // QUESTION-DRIVEN PROJECTION — presentation, after the fact, isolated.
  //
  // The ONLY place a projection model call originates. It runs here, once,
  // after canonical research has finished and its Proof exists; no read
  // path can reach it, which is what makes "one model call per Proof" a
  // structural property of the system rather than a convention.
  //
  // It is deliberately the LAST thing this function does, and it cannot
  // throw: `generateQuestionProjectionSafely` returns every outcome,
  // including its own failures, and persists terminal failure so a later
  // page load never becomes a reason to call the model again.
  //
  // Nothing above this line can be changed by what happens below it. The
  // job's state, the S7 verdict, the Proof and every component result are
  // already written and are not revisited. That separation is the point:
  // a projection decides how an answer is ARRANGED, never what it says, so
  // a projection that fails must mean nothing whatsoever about the project
  // — the reader simply gets the canonical result without the
  // question-shaped breakdown.
  await generateQuestionProjectionSafely(db, jobId);

  return result;
}
