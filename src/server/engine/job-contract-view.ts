import { desc, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchJobs, researchPlans } from "../db/schema";
import { loadActivePatternVersion, MissingActivePatternError } from "./active-pattern";
import { buildContractView } from "./contract-view";
import type { ContractView } from "./contract-view";
import { parseContract } from "../memory/contract";

export type ResearchJobRow = typeof researchJobs.$inferSelect;

// The job's ContractView, derived from persisted state exactly as
// run-job.ts has always derived it — lifted out of runS4ResearchJob
// verbatim (same reads, same order, same four failure messages) so that
// D-136's search phase asks for the SAME work queue the controller will
// later walk, rather than a second, drifting copy of this derivation.
//
// That the two must agree is not a stylistic preference: a phase that
// covers fewer components than the controller processes leaves the rest
// with nothing to replay, and a phase that covers more spends real
// external budget on work the controller will never ask for.
//
// Pure: reads rows, builds a view, throws on a genuine inconsistency.
// Writes nothing, reserves nothing, calls no provider.
export async function loadJobContractView(
  db: Database | Transaction,
  jobId: string,
): Promise<{ job: ResearchJobRow; view: ContractView }> {
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
  return { job, view };
}
