import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchComponentResults } from "../db/schema";
import { BudgetExhaustedError } from "./budget-exhausted-error";
import { runResearchController } from "./controller";
import type { ControllerRunResult, WorkExecutor } from "./controller";
import { MissingActivePatternError } from "./active-pattern";
import { loadJobContractView } from "./job-contract-view";
import { adoptReusedMemory } from "./memory-evidence-adoption";
import { reconcileAndPersistComponent, reconcileOutstandingComponents } from "./component-reconciliation-store";
import { runOnchainReactivationPass } from "./onchain-reactivation";
import { runPostEventSupplyCompletion } from "./onchain-post-event-supply";
import { runSupplyDeltaMaterialization } from "./onchain-supply-delta-materialization";
import { assembleAndPersistMechanism } from "./mechanism-assembly-store";
import { evaluateAndPersistClaimSupport } from "./claim-support-store";
import { buildAndPersistProof } from "./proof-store";

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
  const { job, view: plannedView } = await loadJobContractView(db, jobId);

  // RESEARCH MEMORY -> EVIDENCE ADOPTION V1 — before any work is claimed.
  //
  // A component the planner closed from ACTIVE Research Memory is not in
  // the planned work queue, and until this step nothing took its place:
  // no Evidence of this job, no S5 result, and the assembly reported it
  // MISSING. Adoption materializes one ordinary current-job Evidence row
  // per reused memory observation (authority re-resolved under today's
  // routes, provenance copied, an explicit pointer to the memory row) and
  // runs the ordinary S5 reducer over it. A component the reduced Evidence
  // establishes stays out of the queue; any other outcome — a fresh-only
  // component, a refused memory row, incomplete provenance, an inadmissible
  // class, INSUFFICIENT_EVIDENCE — puts the component BACK on the queue as
  // ordinary fresh work. Memory can therefore save acquisition, and can
  // never suppress it. Idempotent: a redelivery adopts nothing twice.
  //
  // The search phase (acquisition-phase-worker.ts) derives the same
  // effective queue through the same call, so a phased job searches for
  // exactly the components this controller will walk.
  const adoption = await adoptReusedMemory(db, jobId, plannedView, now);
  const view = { ...plannedView, workQueue: adoption.workQueue };

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
    //     exception still propagates untouched — a broken capability is
    //     not an evidentiary outcome. The `else` branch below runs the
    //     zero-spend S5 sweep for it and nothing else: no S6, no S7, no
    //     Proof.
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
      // PROTECTED DETERMINISTIC WORK STILL RUNS, and the premise that said
      // otherwise is what changed.
      //
      // This path used to skip the three stages below, reasoning that "the
      // job's axis is spent, so a pass here could only spend components'
      // one opportunity on reservations that are certain to be refused".
      // That was true when ONE flat floor was held back from documentary
      // work alone. It is not true now: the reservation is the contract's
      // own remaining deterministic demand and is enforced per spender, so
      // documentary exhaustion means the UNPROTECTED pool is gone while
      // every component's protected units are still there, untouched, still
      // reserved for exactly this work.
      //
      // Skipping them threw away capacity that had been protected precisely
      // so it would survive this moment — and with it the burn a
      // reactivated component would have established, the one bounded
      // reading that closes an interval, and the delta that needs neither.
      //
      // NOTHING IS GRANTED HERE. Each stage passes the same derived ceiling
      // it always passes: per-component for reactivation, the unprotected
      // remainder for the opportunistic supply read, and none at all for
      // materialization, which acquires nothing. All of it goes through the
      // one ledger mutator, and a stage that cannot reserve refuses and
      // traces it exactly as on the ordinary path. Documentary work gains
      // nothing: it is not resumed, and its ceiling is unchanged.
      //
      // THE JOB STILL ENDS THE WAY IT ENDED. `e` is re-thrown below
      // unchanged, so the terminal state stays
      // BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED and no exhausted job is
      // converted into a successful one.
      try {
        // Documentary acquisition is over: the throw came from the
        // reservation boundary and nothing here resumes it, so a component
        // with no admissible subject by now will never have one. Declaring
        // that lets the reservation release what it was holding for such a
        // component (D2) instead of stranding it — on the first fresh
        // Raydium run five of twenty-four units ended the job held for a
        // chain that had no subject and no way left to get one.
        await runOnchainReactivationPass(db, {
          jobId,
          projectId: job.projectId,
          workQueue: view.workQueue,
          maxSourceOpens: view.researchBudget.maxSourceOpens,
          documentaryAcquisitionFinished: true,
        });
        await runPostEventSupplyCompletion(db, {
          jobId,
          projectId: job.projectId,
          maxSourceOpens: view.researchBudget.maxSourceOpens,
          documentaryAcquisitionFinished: true,
        });
        await runSupplyDeltaMaterialization(db, { jobId, projectId: job.projectId });
      } catch (continuation) {
        // A failure in a continuation stage must NOT replace the terminal
        // reason. The job stopped because documentary capacity ran out, and
        // that stays the answer; surfacing a secondary provider or database
        // error here would rename an honest budget outcome after whatever
        // happened last. It is reported rather than hidden, and the
        // original `e` is what propagates.
        console.error(
          "[run-job] on-chain continuation after budget exhaustion did not complete:",
          continuation,
        );
      }

      // ACQUISITION HAS DEFINITIVELY STOPPED HERE, and that is what the flag
      // says. The throw came from the reservation boundary, so the work loop
      // aborted mid-queue and every component after it has no attempt row and
      // never will — including the one the three stages above may have just
      // written evidence into. Zero-cost reconciliation of an
      // EVIDENCE-BACKED pending component is therefore the difference between
      // reporting what this job deterministically established and discarding
      // it. A pending component with no persisted inputs stays untouched.
      await reconcileOutstandingComponents(db, jobId, view.workQueue, now, {
        acquisitionStopped: true,
      });
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
    } else {
      // TECHNICAL FAILURE != PROJECT REALITY.
      //
      // Any other exception — a capability down, a rejected database
      // write, an internal invariant — is a fault of the RUN, and the job
      // ends FAILED/SYSTEM_OR_PROVIDER_FAILURE at the worker's boundary.
      // Nothing substantive may be derived from it: S6/S7/S8 do NOT run
      // here, because claim support over a queue that was never walked to
      // its end would grade every unexecuted component as a gap and write
      // a Proof whose INSUFFICIENT_EVIDENCE speaks about the project when
      // only the run broke. Absence of completed research is not evidence
      // of absence. The continuation stages do not run either: they may
      // spend an on-chain read, and a job that just failed for an unknown
      // reason is not licensed to spend anything further.
      //
      // ONE THING DOES RUN, AND IT SPENDS NOTHING: the same S5 sweep the
      // ordinary path runs after the controller, over components whose
      // S4 attempt is already terminal. The per-attempt hook cannot
      // survive a crash between an attempt's terminal UPDATE and its own
      // persistence (HIGH-2, see the module comment) — the sweep is the
      // designed repair for that, and it ran on every path except this
      // one. A FAILED job is never picked up again, so this catch is the
      // last moment its finished work can be reconciled at all. The sweep
      // is a derived-projection upsert over Evidence already persisted for
      // components S4 actually finished: no executor, no provider, no
      // reservation, idempotent for a component the hook already wrote.
      //
      // DELIBERATELY NOT `acquisitionStopped`. The component whose attempt
      // was cut off mid-way keeps no result row: the closed S5 vocabulary
      // has no NOT_EVALUATED, and a status computed from a truncated
      // Evidence set would be indistinguishable from an honest one. "Work
      // never finished" stays a missing row, which the result screen
      // already renders as not assessed rather than as insufficient.
      //
      // The sweep's own failure is reported, never allowed to replace `e`:
      // the job stopped because of the first fault, and that stays the
      // answer. `e` is re-thrown unchanged either way.
      try {
        await reconcileOutstandingComponents(db, jobId, view.workQueue, now);
      } catch (sweep) {
        console.error("[run-job] S5 sweep after technical failure did not complete:", sweep);
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
  // ALSO RUN on the BudgetExhaustedError path above, since Budget
  // Reservation V2: documentary exhaustion no longer means the axis is
  // spent, only that the unprotected part of it is, so a pass there spends
  // capacity that was reserved for exactly this and would otherwise be
  // thrown away. It is the same call with the same derived ceiling.
  //
  // It creates no attempt, calls no model, runs no search and fetches no
  // document (see the module comment), and it cannot fail the job:
  // acquisition-level outcomes are recorded as observations and trace, the
  // same way the executor's own on-chain branch records them.
  //
  // The controller has returned, so every documentary attempt this job will
  // ever make has been made and extracted: the same declaration the
  // budget-exhausted path makes above, for the same reason (D2). The one
  // stop reason that is resumable — INTERRUPTED, a per-call attempt cap
  // this worker never sets — is the one case where documentary work could
  // still follow, and it withholds the declaration rather than guess.
  const documentaryAcquisitionFinished = result.stopReason !== "INTERRUPTED";
  await runOnchainReactivationPass(db, {
    jobId,
    projectId: job.projectId,
    workQueue: view.workQueue,
    maxSourceOpens: view.researchBudget.maxSourceOpens,
    documentaryAcquisitionFinished,
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
    documentaryAcquisitionFinished,
  });

  // SUPPLY DELTA MATERIALIZATION — the exact change this job can already
  // prove, filed as Evidence.
  //
  // LAST OF THE DETERMINISTIC STAGES, and the only one that acquires nothing.
  // It runs AFTER the completion above because the reading that closes the
  // interval is frequently the one that pass just acquired, and BEFORE the S5
  // sweep so the Evidence it writes is visible to ordinary later processing
  // with no special case.
  //
  // It consumes only rows this job already paid for: the burns it
  // established, the readings it and earlier Research took. No RPC, no
  // search, no fetch, no model call, no attempt row and no budget — the
  // module imports no provider, and there is no seam for one. If the reading
  // it needs is absent, no delta is materialized, and that is a limit on what
  // this Research observed rather than a statement that supply did not
  // change.
  //
  // It changes no verdict: TOTAL_SUPPLY_DELTA has no applicability entry and
  // the row is filed CONTEXT, which reconciliation never counts.
  await runSupplyDeltaMaterialization(db, { jobId, projectId: job.projectId });

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

  // QUESTION-DRIVEN PROJECTION — NOT HERE ANY MORE.
  //
  // It used to be the last call of this function, and it never produced a
  // row on the worker path: the projection store admits only a job whose
  // persisted state is SUCCEEDED or BUDGET_LIMIT_REACHED, and at this point
  // the job is still RUNNING — the worker writes the terminal state only
  // after this function returns. Every normal run answered NOT_PROJECTABLE
  // (two live Lido jobs, dd092896 and a118fb74, both with a Proof and no
  // projection row). The call now lives in the worker, immediately after
  // its terminal transaction commits (worker.ts), where the state the store
  // guards on is already the state the reader will see. Nothing above this
  // line changed: the projection still runs strictly after the Proof, still
  // once per (job, version), still through the one store that owns it.

  return result;
}
