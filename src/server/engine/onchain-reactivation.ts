import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts } from "../db/schema";
import type { ComponentWorkItem } from "./contract-view";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { admittedLocatorsForJob } from "./documentary-locator-store";
import {
  MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  runStructuredOnchainAcquisition,
  selectOnchainIntents,
  type MechanismLocator,
} from "./onchain-acquisition";
import {
  deterministicCeilingForComponent,
  onchainOpportunityConsumedComponents,
  resolveOnchainSourceOpenReserve,
} from "./onchain-source-open-reserve";
import type { OnchainRetriever } from "./providers/onchain-retriever";
import { recordTraceEvent } from "./trace-store";

// ONE BOUNDED ON-CHAIN REACTIVATION, AFTER THE CONTROLLER.
//
// THE DEFECT THIS CLOSES. Acquisition order is fixed; subject availability
// is not. A component's structured on-chain branch runs at the TOP of its
// attempt, before that attempt's own search, fetch and extraction — and the
// documentary locator that would give it a subject is admitted at the
// BOTTOM, by extraction, possibly of a much later component. So on the
// seeded Pattern, FLOW_PATH (step 2), EXECUTION_EVIDENCE (step 4),
// DESTINATION and RECIPIENT (step 6) can all reach their chain branch with
// no subject, and the address that unblocks them is admitted by this very
// job minutes later. The controller walks its work queue exactly once and
// never revisits, so the subject died unused and the Proof reported
// insufficient evidence for a mechanism it had the locator for.
//
// THIS IS NOT A RETRY. Nothing that was attempted is attempted again. The
// justification is narrower and is the whole licence for this pass: NEW
// EVIDENCE ADMITTED INSIDE THIS SAME JOB created a deterministic subject
// that did not exist when the component ran. Research is allowed to learn
// from what it acquired an hour earlier in its own run. An RPC that failed,
// a budget that refused, a chain that ran out of promotion depth — none of
// those is newly-unblocked work, and none of them is revisited here.
//
// WHAT IT IS NOT ALLOWED TO BE. Not a scheduler: one pass, one loop over
// the work queue, no queue of its own, no re-entry, no recursion. Not a
// second attempt: it writes NO research_attempts row, so the recovery pool
// (reservedRecoverySteps) is untouched and each component keeps exactly one
// canonical outcome. Not a repeat of paid work: this module imports no
// QueryProposer, no SearchGateway, no ContentFetcher and no
// EvidenceExtractor, so no query is proposed, no search is executed, no
// document is fetched or rendered and no model is called — by construction,
// not by discipline.
//
// EVERY EXISTING BOUND STILL APPLIES, because the work is done by the same
// leaf the executor uses: MAX_ONCHAIN_INTENTS_PER_ATTEMPT base intents,
// MAX_PROMOTED_INTENTS_PER_ATTEMPT promotions, MAX_PROMOTION_DEPTH, the
// per-call sourceOpens reservation against the job's unchanged ceiling, the
// containment and binding checks, and the closed trace vocabulary.

export type ReactivationRefusal =
  // The component never reached a terminal attempt, so there is nothing to
  // revisit — it was not researched, it was not finished.
  | "NO_TERMINAL_ATTEMPT"
  // Its one bounded opportunity is already spent: an on-chain operation was
  // issued for it (or refused by budget) earlier in this job.
  | "OPPORTUNITY_ALREADY_CONSUMED"
  // Still no subject, or the Pattern never admitted a chain read here. An
  // acquisition boundary, not a finding.
  | "NO_ACTIONABLE_SUBJECT";

export interface ReactivationResult {
  step: number;
  component: string;
  sourceOpensSpent: number;
  evidenceIds: string[];
  observations: string[];
}

export interface OnchainReactivationOutcome {
  reactivated: ReactivationResult[];
  refused: Array<{ step: number; component: string; reason: ReactivationRefusal }>;
}

// Components whose S4 attempt is already terminal. A STARTED (still-leased)
// or never-attempted component is deliberately left alone: revisiting work
// that has not finished is the controller's job, never this pass's.
async function terminalComponents(
  db: Database | Transaction,
  jobId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      component: researchAttempts.component,
      patternStep: researchAttempts.patternStep,
      attemptNumber: researchAttempts.attemptNumber,
      status: researchAttempts.status,
    })
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, jobId));
  const latest = new Map<string, { attemptNumber: number; status: string }>();
  for (const r of rows) {
    const key = `${r.patternStep}:${r.component}`;
    const prior = latest.get(key);
    if (!prior || r.attemptNumber >= prior.attemptNumber) {
      latest.set(key, { attemptNumber: r.attemptNumber, status: r.status });
    }
  }
  const out = new Set<string>();
  for (const [key, v] of latest) {
    if (v.status !== "STARTED") out.add(key);
  }
  return out;
}

export async function runOnchainReactivationPass(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string | null;
    workQueue: readonly Pick<ComponentWorkItem, "step" | "component">[];
    maxSourceOpens: number;
    // Test seam only, exactly as runStructuredOnchainAcquisition's own.
    // Absent means "resolve the production retriever, if this process has
    // one" — an unconfigured environment simply performs no chain read.
    retriever?: OnchainRetriever | null;
  },
): Promise<OnchainReactivationOutcome> {
  const out: OnchainReactivationOutcome = { reactivated: [], refused: [] };
  if (input.workQueue.length === 0) return out;

  // THE ONE-SHOT LEDGER, read ONCE before the loop. Derived from trace rows
  // the engine already writes, so it survives a redelivered EXTRACTING
  // phase: a component whose opportunity this pass consumed on an earlier
  // delivery is refused on the next one, without any new column or flag.
  const consumed = await onchainOpportunityConsumedComponents(db, input.jobId);
  const terminal = await terminalComponents(db, input.jobId);

  // THE SUBJECTS, read ONCE. Current-job scope is enforced inside
  // admittedLocatorsForJob; this pass cannot widen it and never asks for a
  // locator from anywhere else.
  const locators: MechanismLocator[] = (await admittedLocatorsForJob(db, input.jobId)).map(
    (l) => ({ address: l.value, origin: "ADMITTED_EVIDENCE_SOURCE" as const }),
  );

  for (const item of input.workQueue) {
    if (!terminal.has(`${item.step}:${item.component}`)) {
      out.refused.push({ ...item, reason: "NO_TERMINAL_ATTEMPT" });
      continue;
    }
    if (consumed.has(item.component)) {
      out.refused.push({ ...item, reason: "OPPORTUNITY_ALREADY_CONSUMED" });
      continue;
    }

    const plan = await loadAcquisitionPlan(db, input.jobId, item.component, input.projectId);
    // THE NEWLY-POSSIBLE TEST. `selectOnchainIntents` is the same authority
    // acquisition uses, asked with the locators this job has admitted BY
    // NOW. Because the opportunity is unconsumed, this component's own
    // branch previously returned nothing — so a non-empty answer here means
    // exactly one thing: evidence admitted later in this job created a
    // subject that did not exist then. The Pattern gate, the identity gate
    // and the supported-chain gate are inherited, never restated.
    const intents = selectOnchainIntents({
      component: item.component,
      establishingClasses: plan.establishingClasses,
      identity: plan.confirmedIdentity,
      locators,
      maxIntents: MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
    });
    if (intents.length === 0) {
      out.refused.push({ ...item, reason: "NO_ACTIONABLE_SUBJECT" });
      continue;
    }

    // RESOLVED PER COMPONENT, not once for the pass. Every component this
    // loop reactivates consumes its opportunity, which shrinks what is still
    // protected — so a later component in the same pass must be measured
    // against the state this one left behind, never against a snapshot taken
    // before it ran. The job's ceiling is unchanged; this only decides how
    // much of it THIS component may reach.
    const reserve = await resolveOnchainSourceOpenReserve(db, {
      jobId: input.jobId,
      projectId: input.projectId,
      maxSourceOpens: input.maxSourceOpens,
    });

    const outcome = await runStructuredOnchainAcquisition({
      db,
      jobId: input.jobId,
      // No attempt row exists for this work and none is created, so the
      // trace links to the job and the component rather than to an attempt.
      attemptId: null,
      item,
      plan: {
        establishingClasses: plan.establishingClasses,
        confirmedIdentity: plan.confirmedIdentity,
      },
      locators,
      maxSourceOpens: deterministicCeilingForComponent(reserve, item.component),
      ...(input.retriever === undefined ? {} : { retriever: input.retriever }),
      recordTrace: async (event) =>
        recordTraceEvent(db, {
          researchJobId: input.jobId,
          researchAttemptId: null,
          operationType: event.operationType,
          providerKind: "FETCH",
          patternStep: item.step,
          // Carrying the component is what makes the one-shot ledger work:
          // this row is what refuses the same component next time.
          component: item.component,
          targetRef: event.targetRef,
          status: event.status,
          reasonCode: event.reasonCode ?? "NONE",
          budgetAxis: "sourceOpens",
          budgetAmount: 1,
        }),
    });
    out.reactivated.push({
      step: item.step,
      component: item.component,
      sourceOpensSpent: outcome.sourceOpensSpent,
      evidenceIds: outcome.evidenceIds,
      observations: outcome.observations,
    });
  }

  return out;
}
