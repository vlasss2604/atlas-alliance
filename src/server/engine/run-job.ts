import { desc, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchJobs, researchPlans } from "../db/schema";
import { buildContractView } from "./contract-view";
import type { ContractView } from "./contract-view";
import { runResearchController } from "./controller";
import type { ControllerRunResult, WorkExecutor } from "./controller";
import { parseContract } from "../memory/contract";
import { loadActivePatternVersion } from "./active-pattern";

// Phase 6, S4 — the actual production wiring point: given a jobId, load
// its frozen entitlement/budget, its persisted Research Boundary
// Contract (Phase 5), and the topic's ACTIVE Pattern version (Phase-6-
// safe lookup, active-pattern.ts), build a ContractView (S0), and hand it
// to the deterministic controller (S3) together with a WorkExecutor.
//
// This function is NOT wired into the job worker/pg-boss queue — Phase 6
// stays behind research_enabled=false regardless (§17), and S5+
// (reconciliation, Proof Core) does not exist yet for this function's
// output to feed into. It exists so activePatternVersion resolution has
// one real, testable production caller instead of remaining test-only,
// and so a future S5 slice has a single integration point to call.

// S4 review fix (LOW-1): the approved plan requires the active Pattern
// version to match the stored contract, or the job fails explicitly.
// Silently passing `undefined` when no ACTIVE row exists (buildContractView
// simply skips its own cross-check for `undefined` — contract-view.ts is
// frozen and untouched here) would let a topic with no ACTIVE Pattern run
// research unchecked. This module hard-fails BEFORE calling
// buildContractView instead.
export class MissingActivePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingActivePatternError";
  }
}

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

  return runResearchController({ db, jobId, view, executor, now });
}
