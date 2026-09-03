import type { Database, Transaction } from "../db/client";
import type { ConfirmedProjectIdentity } from "../domain/project-identity";
import type { EvidenceSourceClass } from "./providers/types";
import { researchTraceEvents } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { loadJobContractView } from "./job-contract-view";
import { componentAdmitsOnchainAcquisition } from "./onchain-acquisition";
import { parseCanonicalOnchainUri } from "./onchain-uri";
import { MAX_PROMOTION_DEPTH } from "./onchain-subject-promotion";

// ON-CHAIN SOURCE-OPEN RESERVATION.
//
// THE DEFECT. `sourceOpens` is ONE job-level axis shared by every real
// external open: a documentary fetch, a render, and a bounded RPC read.
// Nothing decided the ORDER in which the axis could be claimed, and the
// phased architecture fixes that order structurally — the FETCH phase runs
// to completion before EXTRACTING starts, and only EXTRACTING runs the
// deterministic on-chain path. So documentary acquisition spent the entire
// axis first, and every planned on-chain intent was then refused with
// SOURCE_OPEN_BUDGET_EXHAUSTED. The research answered its question from
// secondary documents because the primary, deterministic reads it had
// already planned could not be paid for.
//
// That is a FALSE-NEGATIVE RISK, not merely a scheduling inefficiency: an
// absent mechanism and an unaffordable observation of that mechanism are
// different findings, and the budget was quietly turning the second into
// the first.
//
// THE RULE. Not "more budget", and not "chain first". A small bounded
// FLOOR inside the EXISTING ceiling that documentary acquisition may not
// consume, and only while the active plan actually holds deterministic
// on-chain work that is still outstanding.
//
// HOW IT IS ENFORCED — deliberately NOT a second ledger. There is exactly
// one accounting authority (`research_jobs.source_opens_reserved`, moved
// only by `reserveJobBudget`) and this module never touches it. It
// computes a LOWER CEILING that documentary reservations pass to that same
// primitive, while on-chain reservations keep passing the full ceiling.
// Consequences that matter:
//
//   * the job's total sourceOpens ceiling is UNCHANGED — every reservation
//     is still bounded by `maxSourceOpens`, so no path gains capacity;
//   * on-chain reads still spend the canonical ledger, one unit per real
//     call, reserved before the call, exactly as before;
//   * the floor is not a withdrawal. Nothing is moved into a pool that
//     could be lost. Units the on-chain path does not spend simply stay in
//     the one counter, available to anything allowed the full ceiling.
//
// NOTHING HERE KNOWS A PROJECT. Whether a floor applies is answered by
// `selectOnchainIntents` — the Pattern's own establishing classes, the
// confirmed identity, the supported chain and the component -> intent map
// — asked once per outstanding component. No project name, no asset
// identifier and no chain-specific heuristic appears in this file or can
// influence what it decides.

// The floor: ONE authorised deterministic chain, end to end.
//
// Derived, never chosen: a chain starts at a classified subject (depth 0)
// and may be promoted MAX_PROMOTION_DEPTH times, so the deepest route the
// promotion rules currently authorise costs 1 + MAX_PROMOTION_DEPTH bounded
// reads. Protecting fewer than that protects a chain that can start and
// cannot finish, which buys an inconclusive artifact instead of an answer.
//
// It is not a budget for any particular finding. The depth is whatever
// `onchain-subject-promotion.ts` authorises; if a rule is ever removed the
// floor shrinks with it, and no project, asset or mechanism appears in the
// derivation.
export const ONCHAIN_RESERVED_SOURCE_OPENS = 1 + MAX_PROMOTION_DEPTH;

export interface OnchainSourceOpenReserve {
  // Does outstanding plan work admit deterministic on-chain acquisition?
  planned: boolean;
  // Why no floor is held, when none is.
  released: OnchainReserveReleaseReason | null;
  // Units of the EXISTING ceiling documentary acquisition may not take.
  reserved: number;
  // The ceiling documentary reservations must pass to reserveJobBudget.
  documentaryCeiling: number;
  // The unchanged job ceiling, echoed so a caller can assert the total.
  maxSourceOpens: number;
}

export type OnchainReserveReleaseReason =
  // No outstanding component admits ONCHAIN_VERIFIABLE as an establishing
  // class, or none yields an intent against an admissible subject.
  | "NO_ACTIONABLE_ONCHAIN_WORK"
  // This execution context cannot reach a chain at all, so a floor here
  // would protect capacity nothing can use.
  | "ONCHAIN_ACQUISITION_UNAVAILABLE";

export interface OnchainReserveInput {
  // The job's frozen ceiling. Never modified.
  maxSourceOpens: number;
  // Outstanding plan work admits deterministic on-chain acquisition.
  onchainWorkPlanned: boolean;
  // The caller KNOWS the on-chain path cannot act in this context (owner
  // documentary-only instruction, or no retriever installed here). Absent
  // means "not known", which never releases the floor: a process that
  // cannot see the capability must not spend the capacity of one that can.
  onchainAcquisitionUnavailable?: boolean;
}

// The one arithmetic. Pure, total, and stated as an invariant rather than
// a tuning knob: the floor may never exceed HALF the job's ceiling, so a
// small envelope can never be handed to the chain path at documentary
// acquisition's expense. Protection from starvation, never priority.
export function computeOnchainSourceOpenReserve(
  input: OnchainReserveInput,
): OnchainSourceOpenReserve {
  const maxSourceOpens = Math.max(0, Math.floor(input.maxSourceOpens));
  const release: OnchainReserveReleaseReason | null = !input.onchainWorkPlanned
    ? "NO_ACTIONABLE_ONCHAIN_WORK"
    : input.onchainAcquisitionUnavailable === true
      ? "ONCHAIN_ACQUISITION_UNAVAILABLE"
      : null;
  const reserved =
    release !== null
      ? 0
      : Math.min(ONCHAIN_RESERVED_SOURCE_OPENS, Math.floor(maxSourceOpens / 2));
  return {
    planned: input.onchainWorkPlanned,
    released: release,
    reserved,
    documentaryCeiling: Math.max(0, maxSourceOpens - reserved),
    maxSourceOpens,
  };
}

export interface OnchainPlanComponent {
  component: string;
  establishingClasses: readonly EvidenceSourceClass[];
}

// Could ANY of these components still need a bounded chain read in this
// job? Asked through `componentAdmitsOnchainAcquisition`, so this module
// owns no opinion about which components, chains or identities qualify.
//
// DELIBERATELY NOT "does a subject exist right now". A locator can be
// admitted by documentary extraction LATER in the same job, and the whole
// reason this floor exists is to keep the read that locator unblocks
// affordable when it arrives. Releasing capacity because a subject has not
// appeared yet would defeat the protection at exactly the moment it is
// needed. Whether a call may actually be ISSUED still requires a subject,
// and `selectOnchainIntents` still decides that — no call is ever made
// because capacity was held.
export function planHasActionableOnchainWork(input: {
  identity: ConfirmedProjectIdentity | null;
  components: readonly OnchainPlanComponent[];
}): boolean {
  return input.components.some((c) =>
    componentAdmitsOnchainAcquisition({
      component: c.component,
      establishingClasses: c.establishingClasses,
      identity: input.identity,
    }),
  );
}

// THE ONE-SHOT LEDGER, DERIVED FROM TRACE RATHER THAN STORED.
//
// Which components have already HAD their bounded on-chain opportunity in
// this job? A trace row is written immediately BEFORE every real chain
// operation (FETCH_ATTEMPTED) and whenever one was refused by the budget
// (CANDIDATE_SKIPPED_BUDGET), each carrying the component it was for. So
// the answer already exists in rows the engine writes anyway, with no new
// column, no new enum value and no migration.
//
// It is written before the call, which is what makes it a genuine one-shot:
// an RPC that fails still leaves the marker, so a failure consumes the
// opportunity exactly as a success does. That is the intended discipline —
// this is not a retry mechanism.
//
// A canonical on-chain URI is recognised by the canonical parser, never by
// a string prefix, so a documentary FETCH_ATTEMPTED can never be counted.
export async function onchainOpportunityConsumedComponents(
  db: Database | Transaction,
  jobId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      component: researchTraceEvents.component,
      targetRef: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(
      and(
        eq(researchTraceEvents.researchJobId, jobId),
        inArray(researchTraceEvents.operationType, [
          "FETCH_ATTEMPTED",
          "CANDIDATE_SKIPPED_BUDGET",
        ]),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.component || !r.targetRef) continue;
    if (parseCanonicalOnchainUri(r.targetRef) === null) continue;
    out.add(r.component);
  }
  return out;
}

// The database-backed resolution. Reads the same authorities acquisition
// itself reads — the job's own work queue, the ACTIVE Pattern's component
// requirements, the confirmed identity, and the trace that records which
// components have already had their opportunity — and writes nothing,
// reserves nothing, calls no provider.
//
// THE RELEASE CONDITION, STATED ONCE. Capacity is held while ANY work-queue
// component both admits deterministic on-chain acquisition AND has not yet
// had its one bounded opportunity. It is released when that set is empty —
// which is the smallest deterministic statement of "no current-job chain
// work can still happen". Note what is NOT a release condition: the
// controller finishing. A component whose subject arrives late is revisited
// once AFTER the controller, so pending-component emptiness says nothing
// about whether deterministic research is over.
//
// DEGRADE, NEVER THROW. A budget floor is a scheduling protection and must
// never fail a job that would otherwise run. Anything unreadable yields NO
// floor — exactly the behaviour that existed before this module.
export async function resolveOnchainSourceOpenReserve(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string | null;
    maxSourceOpens: number;
    onchainAcquisitionUnavailable?: boolean;
  },
): Promise<OnchainSourceOpenReserve> {
  try {
    const { view } = await loadJobContractView(db, input.jobId);
    const consumed = await onchainOpportunityConsumedComponents(db, input.jobId);
    const candidates = view.workQueue.filter((i) => !consumed.has(i.component));
    if (candidates.length === 0) {
      return computeOnchainSourceOpenReserve({
        maxSourceOpens: input.maxSourceOpens,
        onchainWorkPlanned: false,
      });
    }

    let identity: ConfirmedProjectIdentity | null = null;
    const components: OnchainPlanComponent[] = [];
    for (const item of candidates) {
      const plan = await loadAcquisitionPlan(db, input.jobId, item.component, input.projectId);
      identity = plan.confirmedIdentity ?? identity;
      components.push({ component: item.component, establishingClasses: plan.establishingClasses });
    }
    return computeOnchainSourceOpenReserve({
      maxSourceOpens: input.maxSourceOpens,
      onchainWorkPlanned: planHasActionableOnchainWork({ identity, components }),
      onchainAcquisitionUnavailable: input.onchainAcquisitionUnavailable,
    });
  } catch {
    return computeOnchainSourceOpenReserve({
      maxSourceOpens: input.maxSourceOpens,
      onchainWorkPlanned: false,
    });
  }
}
