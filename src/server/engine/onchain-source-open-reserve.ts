import type { Database, Transaction } from "../db/client";
import type { ConfirmedProjectIdentity } from "../domain/project-identity";
import type { EvidenceSourceClass } from "./providers/types";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { admittedLocatorsForJob } from "./documentary-locator-store";
import {
  MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  selectOnchainIntents,
  type MechanismLocator,
} from "./onchain-acquisition";

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

// The floor: ONE bounded on-chain attempt's base intents, and nothing
// beyond that. Derived from the acquisition bound rather than restated, so
// the protected capacity can never drift from what one attempt may
// actually issue — and so the floor stays small by construction.
export const ONCHAIN_RESERVED_SOURCE_OPENS = MAX_ONCHAIN_INTENTS_PER_ATTEMPT;

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

// Does ANY of the outstanding components yield a deterministic on-chain
// intent right now? Asked through `selectOnchainIntents` itself, so this
// module owns no opinion about which components, chains or subjects
// qualify — it inherits every existing gate, including the one that makes
// an account-kind intent unreachable while no locator has been admitted.
// No locator therefore means no floor for locator-dependent work, which is
// the same fail-closed direction acquisition already takes.
export function planHasActionableOnchainWork(input: {
  identity: ConfirmedProjectIdentity | null;
  components: readonly OnchainPlanComponent[];
  locators?: readonly MechanismLocator[];
}): boolean {
  for (const c of input.components) {
    const intents = selectOnchainIntents({
      component: c.component,
      establishingClasses: c.establishingClasses,
      identity: input.identity,
      locators: input.locators ?? [],
      maxIntents: 1,
    });
    if (intents.length > 0) return true;
  }
  return false;
}

// The database-backed resolution, for callers that hold only component
// NAMES. Reads the same authorities acquisition itself reads — the ACTIVE
// Pattern's component requirements (`loadAcquisitionPlan`) and the job's
// admitted locators — and writes nothing, reserves nothing, calls no
// provider.
//
// DEGRADE, NEVER THROW. A budget floor is a scheduling protection; it must
// never be able to fail a job that would otherwise run. Anything unreadable
// yields NO floor, which is exactly the behaviour that existed before this
// module — the safe direction is always "documentary keeps what it had".
export async function resolveOnchainSourceOpenReserve(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string | null;
    // Components whose work is still OUTSTANDING. A component that has
    // already had its on-chain opportunity needs no floor, so an empty
    // list releases the reserve — that is the release rule, not a special
    // case of it.
    outstandingComponents: readonly string[];
    maxSourceOpens: number;
    onchainAcquisitionUnavailable?: boolean;
  },
): Promise<OnchainSourceOpenReserve> {
  try {
    if (input.outstandingComponents.length === 0) {
      return computeOnchainSourceOpenReserve({
        maxSourceOpens: input.maxSourceOpens,
        onchainWorkPlanned: false,
      });
    }
    const locators: MechanismLocator[] = (
      await admittedLocatorsForJob(db, input.jobId)
    ).map((l) => ({ address: l.value, origin: "ADMITTED_EVIDENCE_SOURCE" as const }));

    let identity: ConfirmedProjectIdentity | null = null;
    const components: OnchainPlanComponent[] = [];
    for (const component of input.outstandingComponents) {
      const plan = await loadAcquisitionPlan(db, input.jobId, component, input.projectId);
      identity = plan.confirmedIdentity ?? identity;
      components.push({ component, establishingClasses: plan.establishingClasses });
    }
    return computeOnchainSourceOpenReserve({
      maxSourceOpens: input.maxSourceOpens,
      onchainWorkPlanned: planHasActionableOnchainWork({ identity, components, locators }),
      onchainAcquisitionUnavailable: input.onchainAcquisitionUnavailable,
    });
  } catch {
    return computeOnchainSourceOpenReserve({
      maxSourceOpens: input.maxSourceOpens,
      onchainWorkPlanned: false,
    });
  }
}
