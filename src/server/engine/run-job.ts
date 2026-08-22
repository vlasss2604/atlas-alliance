import { desc, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchJobs, researchPlans } from "../db/schema";
import { buildContractView } from "./contract-view";
import type { ContractView } from "./contract-view";
import { runResearchController } from "./controller";
import type { ControllerRunResult, WorkExecutor } from "./controller";
import { parseContract } from "../memory/contract";
import { loadActivePatternVersion, MissingActivePatternError } from "./active-pattern";
import { reconcileAndPersistComponent, reconcileOutstandingComponents } from "./component-reconciliation-store";
import { assembleAndPersistMechanism } from "./mechanism-assembly-store";

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

  const result = await runResearchController({
    db,
    jobId,
    view,
    executor,
    now,
    reconcile: reconcileAndPersistComponent,
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

  return result;
}
