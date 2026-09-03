import type { Database, Transaction } from "../db/client";
import type { ConfirmedProjectIdentity } from "../domain/project-identity";
import type { EvidenceSourceClass } from "./providers/types";
import { researchTraceEvents } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { loadJobContractView } from "./job-contract-view";
import {
  anchorBaseReadDemand,
  componentAdmitsOnchainAcquisition,
  componentStartsAccountChain,
} from "./onchain-acquisition";
import { parseCanonicalOnchainUri } from "./onchain-uri";
import { MAX_PROMOTION_DEPTH, promotedReadsForComponent } from "./onchain-subject-promotion";

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

// The deepest chain a single component may authorise: its account-level
// base read plus every promoted hop its rules permit. Kept as the name the
// V1 floor already had, but it is no longer THE floor — it is the ceiling on
// the promotion half of a reservation that is now computed per job.
//
// Derived, never chosen: if a promotion rule is ever removed the number
// shrinks with it, and no project, asset or mechanism appears in the
// derivation.
export const ONCHAIN_RESERVED_SOURCE_OPENS = 1 + MAX_PROMOTION_DEPTH;

export interface OnchainSourceOpenReserve {
  // Does outstanding plan work admit deterministic on-chain acquisition?
  planned: boolean;
  // Why no capacity is held, when none is.
  released: OnchainReserveReleaseReason | null;
  // Units of the EXISTING ceiling documentary acquisition may not take.
  reserved: number;
  // The two halves, reported separately because they are protected for
  // different reasons and released at different moments.
  baseReserved: number;
  promotionReserved: number;
  // WHOSE capacity each protected unit is. This is what makes the guarantee
  // end-to-end rather than documentary-only: a deterministic read passes a
  // ceiling that excludes only ITS OWN allocation, so one on-chain component
  // can never spend another's protected units.
  demandByComponent: Readonly<Record<string, number>>;
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

export interface OnchainReserveDemand {
  component: string;
  // Anchor-level reads this component will certainly issue.
  base: number;
  // What its deepest authorised promotion chain would cost, end to end.
  // Only the DEEPEST such component's chain is protected — see below.
  chain: number;
}

export interface OnchainReserveInput {
  // The job's frozen ceiling. Never modified.
  maxSourceOpens: number;
  // Outstanding deterministic demand, one entry per work-queue component
  // that still admits on-chain acquisition and has not yet had its bounded
  // opportunity. An empty list means no floor.
  demands: readonly OnchainReserveDemand[];
  // The caller KNOWS the on-chain path cannot act in this context (owner
  // documentary-only instruction, or no retriever installed here). Absent
  // means "not known", which never releases the floor: a process that
  // cannot see the capability must not spend the capacity of one that can.
  onchainAcquisitionUnavailable?: boolean;
}

// THE ONE ARITHMETIC, and the whole fix.
//
// V1 held ONE flat number for the whole job: `1 + MAX_PROMOTION_DEPTH`,
// held back from documentary acquisition only. That was not the invariant it
// claimed to enforce, because the SAME ledger also pays for ordinary
// anchor-level reads. On the seeded Pattern three components each issue a
// guaranteed anchor read, so on a 24-open job 20 documentary opens plus
// those 3 left ONE unit for a promotion chain the architecture had promised
// four. The protection was real against documentary work and imaginary
// against everything else.
//
// The demand is therefore computed from the contract, in two parts:
//
//   BASE       every remaining component's guaranteed anchor-level reads,
//              summed. These WILL be issued; nothing may be allowed to
//              make them unaffordable.
//   PROMOTION  the deepest chain still reachable — ONE of them, because
//              one is what the architecture promises. Taking the maximum
//              rather than the sum is what keeps this a floor instead of a
//              claim on the whole budget: four account-kind components do
//              not reserve four chains.
//
// AND IT IS ENFORCED PER SPENDER, not just against documentary work.
// `deterministicCeilingForComponent` gives a component a ceiling that
// excludes every OTHER component's protected units, so an anchor read
// cannot consume the promotion chain's capacity any more than a documentary
// fetch can. That is the end-to-end guarantee V1 did not have.
//
// PROTECTION, NEVER PRIORITY. The total is still capped at HALF the job's
// ceiling, so a small envelope can never be handed to the chain path at
// documentary acquisition's expense. When the cap bites, the promotion half
// is trimmed first and the guaranteed base reads last — giving up a hop of
// a chain that may not even have a subject costs less than making a read
// that is certain to be issued unaffordable.
export function computeOnchainSourceOpenReserve(
  input: OnchainReserveInput,
): OnchainSourceOpenReserve {
  const maxSourceOpens = Math.max(0, Math.floor(input.maxSourceOpens));
  const demands = input.demands.filter((d) => d.base > 0 || d.chain > 0);
  const release: OnchainReserveReleaseReason | null =
    demands.length === 0
      ? "NO_ACTIONABLE_ONCHAIN_WORK"
      : input.onchainAcquisitionUnavailable === true
        ? "ONCHAIN_ACQUISITION_UNAVAILABLE"
        : null;
  if (release !== null) {
    return {
      planned: demands.length > 0,
      released: release,
      reserved: 0,
      baseReserved: 0,
      promotionReserved: 0,
      demandByComponent: {},
      documentaryCeiling: maxSourceOpens,
      maxSourceOpens,
    };
  }

  // The deepest still-reachable chain, and which component owns it. Ties
  // are broken by component name so the answer cannot depend on work-queue
  // iteration order or on which row Postgres returned first.
  let chainOwner: string | null = null;
  let promotionReserved = 0;
  for (const d of demands) {
    if (d.chain <= 0) continue;
    if (
      chainOwner === null ||
      d.chain > promotionReserved ||
      (d.chain === promotionReserved && d.component < chainOwner)
    ) {
      chainOwner = d.component;
      promotionReserved = d.chain;
    }
  }

  const perComponent = new Map<string, number>();
  let baseReserved = 0;
  for (const d of demands) {
    const base = Math.max(0, Math.floor(d.base));
    baseReserved += base;
    const own = base + (d.component === chainOwner ? promotionReserved : 0);
    if (own > 0) perComponent.set(d.component, own);
  }

  // THE HALF-CEILING CAP, trimmed deterministically. Promotion first, down
  // to nothing; then the guaranteed base reads, from the LAST component in
  // the demand list backwards, so an earlier step keeps its protection when
  // a later one must lose it.
  const cap = Math.floor(maxSourceOpens / 2);
  while (baseReserved + promotionReserved > cap) {
    if (promotionReserved > 0) {
      promotionReserved -= 1;
      if (chainOwner !== null) {
        const next = (perComponent.get(chainOwner) ?? 1) - 1;
        if (next > 0) perComponent.set(chainOwner, next);
        else perComponent.delete(chainOwner);
      }
      continue;
    }
    let trimmed = false;
    for (let i = demands.length - 1; i >= 0; i -= 1) {
      const name = demands[i]!.component;
      const held = perComponent.get(name) ?? 0;
      if (held <= 0) continue;
      if (held > 1) perComponent.set(name, held - 1);
      else perComponent.delete(name);
      baseReserved -= 1;
      trimmed = true;
      break;
    }
    // Nothing left to give up. Only reachable at maxSourceOpens 0/1.
    if (!trimmed) break;
  }

  const reserved = baseReserved + promotionReserved;
  return {
    planned: true,
    released: null,
    reserved,
    baseReserved,
    promotionReserved,
    demandByComponent: Object.fromEntries(perComponent),
    documentaryCeiling: Math.max(0, maxSourceOpens - reserved),
    maxSourceOpens,
  };
}

// THE CEILING A DETERMINISTIC READ MUST PASS.
//
// Not `maxSourceOpens`. A component may spend its OWN protected allocation
// and the unprotected remainder, and nothing else — so an anchor read can
// never make the protected promotion chain unaffordable, and a component
// with no protected allocation (an opportunistic second chain, say) may
// only spend what is genuinely spare.
//
// Pure, and total for an unknown component: an unrecognised name simply has
// no allocation, which is the fail-closed answer.
export function deterministicCeilingForComponent(
  reserve: OnchainSourceOpenReserve,
  component: string,
): number {
  const own = reserve.demandByComponent[component] ?? 0;
  return Math.max(0, reserve.maxSourceOpens - (reserve.reserved - own));
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

// The same question, answered with the NUMBERS the reservation needs rather
// than a boolean. One entry per component, in the order it was given, so a
// caller passing its work queue gets demands in work-queue order — which is
// the order the half-ceiling cap trims from.
export function planDeterministicDemand(input: {
  identity: ConfirmedProjectIdentity | null;
  components: readonly OnchainPlanComponent[];
}): OnchainReserveDemand[] {
  const out: OnchainReserveDemand[] = [];
  for (const c of input.components) {
    const query = {
      component: c.component,
      establishingClasses: c.establishingClasses,
      identity: input.identity,
    };
    const base = anchorBaseReadDemand(query);
    // The account-level base read plus every hop its rules authorise. Zero
    // when the component starts no chain, and NOT a constant when it does:
    // a component authorised one hop costs two reads where one authorised
    // three costs four, and reserving the deeper number for the shallower
    // component is over-reservation taken out of documentary acquisition.
    const chain = componentStartsAccountChain(query)
      ? Math.min(1 + promotedReadsForComponent(c.component), ONCHAIN_RESERVED_SOURCE_OPENS)
      : 0;
    out.push({ component: c.component, base, chain });
  }
  return out;
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
  const none = (): OnchainSourceOpenReserve =>
    computeOnchainSourceOpenReserve({ maxSourceOpens: input.maxSourceOpens, demands: [] });
  try {
    const { view } = await loadJobContractView(db, input.jobId);
    const consumed = await onchainOpportunityConsumedComponents(db, input.jobId);
    const candidates = view.workQueue.filter((i) => !consumed.has(i.component));
    if (candidates.length === 0) return none();

    let identity: ConfirmedProjectIdentity | null = null;
    const components: OnchainPlanComponent[] = [];
    for (const item of candidates) {
      const plan = await loadAcquisitionPlan(db, input.jobId, item.component, input.projectId);
      identity = plan.confirmedIdentity ?? identity;
      components.push({ component: item.component, establishingClasses: plan.establishingClasses });
    }
    return computeOnchainSourceOpenReserve({
      maxSourceOpens: input.maxSourceOpens,
      demands: planDeterministicDemand({ identity, components }),
      onchainAcquisitionUnavailable: input.onchainAcquisitionUnavailable,
    });
  } catch {
    return none();
  }
}
