import { isComparableSupplyObservation } from "./onchain-supply-delta";
import type {
  AnchorBurnEvent,
  PersistedObservation,
} from "./onchain-event-anchored-supply-interval";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  TokenSupplyResult,
  TransactionDetailResult,
} from "./providers/onchain-types";

// POST-EVENT SUPPLY PLANNER — is a supply observation AFTER the event
// missing, or is one already held?
//
// WHAT IT ANSWERS, AND WHAT IT DELIBERATELY DOES NOT. The event-anchored
// interval requires `event.slot < t1.slot` strictly, and t1 must have been
// acquired by the CURRENT Research. Whether this job holds such an
// observation is a question about slots that are already known, so it is
// answerable without touching a chain, a database or a budget. This module
// answers exactly that and stops.
//
// `POST_EVENT_SUPPLY_REQUIRED` therefore states NECESSITY, never
// AUTHORIZATION. It means "no observation this job holds can serve as t1
// for this event". It does not mean a read may be issued, that budget
// exists for one, that the current Proof would gain anything from it, or
// that a component's bounded on-chain opportunity may be spent on it. Each
// of those is a separate decision that lives outside this file and has not
// been made.
//
// ONE, STRUCTURALLY. The result is a single decision, not a list and not a
// count: there is no representation here in which two post-event reads
// could be requested. A planner that could ask for "another" would be the
// first half of a polling loop.
//
// WHY THE GAP IS REAL AND NOT HYPOTHETICAL. A TOKEN_SUPPLY observation is
// stamped with the node's context slot at read time; a BURN is stamped with
// the slot of the transaction that contained it. Those are different
// clocks. A burn confirmed BEFORE this job's last supply read is already
// covered — nothing is required. A burn discovered late whose transaction
// is NEWER than every supply read this job made is not covered, and no
// amount of re-reading the burn changes that.
//
// PURE. No database, no provider, no model, no text matching, no wall
// clock. The caller supplies already-loaded canonical rows and the
// project's currently active anchor.
//
// PERSISTS NOTHING and is wired to nothing.

export type PostEventSupplyDecision = "POST_EVENT_SUPPLY_REQUIRED" | "NO_ACTION";

export type PostEventSupplyReason =
  // --- POST_EVENT_SUPPLY_REQUIRED ---------------------------------------
  // This job holds no total-supply observation that could serve as t1 at
  // all — not one at the wrong position, none.
  | "NO_COMPARABLE_CURRENT_OBSERVATION"
  // It holds some, and every one of them sits at or before the event. The
  // "at" case is refused for the same fail-closed reason the interval
  // selector refuses it: whether a finalized read at slot S includes slot
  // S's transactions has not been validated against live node behaviour.
  | "EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT"
  // --- NO_ACTION ---------------------------------------------------------
  // Nothing offered is a usable deterministic event for this project and
  // this job. An acquisition boundary, never a finding about supply.
  | "NO_USABLE_EVENT"
  // An observation this job already acquired sits strictly after the event.
  // The interval's right-hand side exists; acquiring a fresher one would
  // only widen the interval.
  | "POST_EVENT_OBSERVATION_ALREADY_HELD";

export interface PostEventSupplyPlan {
  decision: PostEventSupplyDecision;
  reason: PostEventSupplyReason;
  // The GREATEST usable event slot. Greatest rather than any, because an
  // observation strictly after the latest event is strictly after all of
  // them — one decision covers every event this job established.
  eventSlot: number | null;
  // The greatest slot among this job's comparable supply observations.
  newestObservationSlot: number | null;
  // What the decision was made from, so a reader never has to infer it.
  eventsConsidered: number;
  usableEvents: number;
  observationsConsidered: number;
  comparableObservations: number;
}

export interface PostEventSupplyPlanInput {
  currentResearchJobId: string;
  // The project's CURRENTLY ACTIVE token address, resolved by the caller —
  // the same discipline the interval selector follows, and for the same
  // reason: an old mint's observations stay arithmetically comparable and
  // stop being about this project.
  currentProjectAnchor: string;
  // Deterministic events this Research established. Order is irrelevant.
  events: readonly AnchorBurnEvent[];
  // Supply observations already persisted, of any origin. Foreign ones are
  // counted and excluded here rather than being filtered by the caller, so
  // the decision cannot silently depend on how the caller queried.
  observations: readonly PersistedObservation[];
}

// The ceiling this planner carries, stated so no reader has to infer it.
export const POST_EVENT_SUPPLY_PLAN_DOES_NOT_PROVE = [
  "REQUIRED states that no held observation can serve as t1; it does NOT authorise a read",
  "REQUIRED does NOT establish that budget exists, or that any budget may be spent",
  "NO_ACTION does NOT establish that a supply delta can be derived — t0 is a separate question",
  "a post-event observation does NOT establish that the event caused any supply change",
  "acquiring a fresher observation WIDENS the interval and proves nothing extra",
] as const;

function isSupply(
  artifact: OnchainArtifact,
): artifact is OnchainArtifact & { result: TokenSupplyResult } {
  return artifact.result.kind === "TOKEN_SUPPLY";
}

function isTransaction(
  artifact: OnchainArtifact,
): artifact is OnchainArtifact & { result: TransactionDetailResult } {
  return artifact.result.kind === "TRANSACTION_DETAIL";
}

// Usable as an anchor here means exactly what it means to the interval
// selector, minus the one comparison that needs a t1 — restated by
// structure rather than imported, because the selector's own check is
// fused into a single refusal-returning path and cannot be called for one
// event in isolation. A test asserts the two agree.
function usableEventSlot(event: AnchorBurnEvent, input: PostEventSupplyPlanInput): number | null {
  const artifact = event.artifact;
  if (!isTransaction(artifact)) return null;
  const burn: BurnInstructionRef | undefined = artifact.result.burns[event.burnIndex];
  if (!burn || typeof burn.sourceAccount !== "string" || burn.sourceAccount.length === 0) {
    return null;
  }
  const slot = artifact.provenance.slot;
  if (!Number.isInteger(slot) || slot < 0) return null;
  if (event.researchJobId !== input.currentResearchJobId) return null;
  if (
    burn.mint !== input.currentProjectAnchor ||
    artifact.provenance.projectAnchor !== input.currentProjectAnchor
  ) {
    return null;
  }
  return slot;
}

// A candidate t1 must be this Research's own, of this project, and
// arithmetically comparable. Standalone observations are refused for the
// same product reason they are refused as t0: owner activity does not move
// a Proof.
function comparableCurrentSlot(
  candidate: PersistedObservation,
  input: PostEventSupplyPlanInput,
): number | null {
  if (candidate.originKind !== "RESEARCH_JOB" || candidate.researchJobId === null) return null;
  if (candidate.researchJobId !== input.currentResearchJobId) return null;
  const artifact = candidate.artifact;
  if (!isSupply(artifact)) return null;
  if (!isComparableSupplyObservation(artifact)) return null;
  if (
    artifact.result.mint !== input.currentProjectAnchor ||
    artifact.provenance.projectAnchor !== input.currentProjectAnchor
  ) {
    return null;
  }
  return artifact.provenance.slot;
}

export function planPostEventSupplyAcquisition(
  input: PostEventSupplyPlanInput,
): PostEventSupplyPlan {
  let eventSlot: number | null = null;
  let usableEvents = 0;
  for (const event of input.events) {
    const slot = usableEventSlot(event, input);
    if (slot === null) continue;
    usableEvents += 1;
    if (eventSlot === null || slot > eventSlot) eventSlot = slot;
  }

  let newestObservationSlot: number | null = null;
  let comparableObservations = 0;
  for (const candidate of input.observations) {
    const slot = comparableCurrentSlot(candidate, input);
    if (slot === null) continue;
    comparableObservations += 1;
    if (newestObservationSlot === null || slot > newestObservationSlot) {
      newestObservationSlot = slot;
    }
  }

  const counts = {
    eventSlot,
    newestObservationSlot,
    eventsConsidered: input.events.length,
    usableEvents,
    observationsConsidered: input.observations.length,
    comparableObservations,
  };

  // No event, no anchor, no question. Deliberately decided BEFORE the
  // observations are looked at: "this job holds no supply observation" is
  // not a reason to acquire one when there is nothing to position it
  // against.
  if (eventSlot === null) {
    return { decision: "NO_ACTION", reason: "NO_USABLE_EVENT", ...counts };
  }
  if (newestObservationSlot === null) {
    return {
      decision: "POST_EVENT_SUPPLY_REQUIRED",
      reason: "NO_COMPARABLE_CURRENT_OBSERVATION",
      ...counts,
    };
  }
  // STRICT, matching the interval selector's right-hand bound exactly. An
  // observation AT the event's slot does not satisfy it, so it must not
  // satisfy this planner either — a planner that said "already held" for an
  // interval the selector would refuse is worse than no planner.
  if (newestObservationSlot > eventSlot) {
    return { decision: "NO_ACTION", reason: "POST_EVENT_OBSERVATION_ALREADY_HELD", ...counts };
  }
  return {
    decision: "POST_EVENT_SUPPLY_REQUIRED",
    reason: "EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT",
    ...counts,
  };
}
