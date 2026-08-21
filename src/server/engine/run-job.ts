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

  const view: ContractView = buildContractView({
    contract,
    mode: planRow.mode,
    capabilityAtStart: job.capabilityAtStart,
    activePatternVersion: activePatternVersion ?? undefined,
  });

  return runResearchController({ db, jobId, view, executor, now });
}
