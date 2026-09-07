import {
  anchorBurnRef,
  filterTemporalSupplyEligibility,
  selectEventAnchoredSupplyObservation,
  type AnchorBurnEvent,
  type CandidateExclusion,
  type PersistedObservation,
} from "./onchain-event-anchored-supply-interval";
import {
  deriveTotalSupplyDelta,
  isComparableSupplyObservation,
  supplyMeasurementDomain,
  type TotalSupplyDelta,
} from "./onchain-supply-delta";
import type { OnchainArtifact, TokenSupplyResult } from "./providers/onchain-types";

// ONE INTERVAL THAT SPANS EVERY BURN THIS RESEARCH ESTABLISHED.
//
// THE PROBLEM WITH ANCHORING ON ONE BURN. A Research that finds several
// deterministic burns has no principled way to call one of them THE event.
// Picking the latest makes the newest burn look canonical and causal; picking
// one per burn produces several deltas that share endpoints and read as
// several findings; picking by amount or by memo lets whoever writes a
// transaction decide what ATLAS measures.
//
// So V1 measures ONE interval that CONTAINS them all. The burn set is
// reduced to a span — its earliest and latest slot — and the interval is the
// narrowest pair of eligible observations lying strictly outside that span:
//
//     t0.slot < earliestBurnSlot   ...   latestBurnSlot < t1.slot
//
// Every burn this Research established is inside the measured interval, no
// burn is made canonical, and the two endpoints are each the nearest
// available on their own side.
//
// A NARROWER INTERVAL PROVES NOTHING EXTRA. It does not show that less
// unrelated minting or burning occurred — only that there was less chain
// interval in which it could have. It is a deterministic tie-break, and it is
// not attribution evidence.
//
// STRICT ON BOTH SIDES. A reading AT a burn's slot is refused on either end,
// for the reason the single-event selector already states: whether a
// finalized read at slot S includes slot S's transactions has not been
// validated against live node behaviour, so it is fail-closed rather than
// assumed.
//
// A THIN LAYER, NOT A REWRITE. Eligibility, the nearest-boundary selection,
// the same-slot ambiguity refusal and the arithmetic are all the existing
// primitives, called. This module contributes the span and the order in which
// the two ends are chosen.
//
// THE SPAN IS SELECTION, NEVER PROVENANCE. `earliestSlot`, `latestSlot` and
// `eventCount` say which question made ATLAS measure this interval. The delta
// is established by t0 and t1 alone and stays true whatever the reason for
// choosing them, which is why no burn is ever an input to it.
//
// PURE. No database, no provider, no model, no clock.

export interface BurnEventSpan {
  earliestSlot: number;
  latestSlot: number;
  eventCount: number;
}

export type BurnSpanningIntervalRefusal =
  // Nothing offered is a usable deterministic burn of this project, from this
  // Research. An acquisition boundary, never a finding about supply.
  | "NO_USABLE_BURN_EVENT"
  // This Research holds no usable reading strictly after the last burn. B2c3
  // already had its one optional chance to acquire one; nothing here asks for
  // another.
  | "NO_CURRENT_OBSERVATION_AFTER_SPAN"
  // Two current readings at the nearest slot after the span report different
  // supplies. The record contradicts itself and picking one would invent an
  // answer.
  | "AMBIGUOUS_CURRENT_OBSERVATION"
  // Nothing was offered as history at all.
  | "NO_HISTORICAL_CANDIDATES"
  // Candidates existed and none may serve as t0. The nearest miss is in
  // `excluded`.
  | "NO_ELIGIBLE_HISTORICAL_OBSERVATION"
  | "AMBIGUOUS_HISTORICAL_OBSERVATION"
  // The two selected endpoints are not of the same measurable thing. No
  // farther endpoint is tried: the policy chooses the nearest on each side,
  // and reaching past it to make the arithmetic succeed would be choosing an
  // interval for its answer.
  | "NOT_COMPARABLE";

export interface BurnSpanningSupplyInterval {
  // WHY this interval, never what it establishes.
  span: BurnEventSpan;
  selectionRule: "NEAREST_ELIGIBLE_OBSERVATIONS_STRICTLY_OUTSIDE_BURN_SPAN";
  from: PersistedObservation;
  to: PersistedObservation;
  // Recomputed here, every time, from the two selected observations.
  delta: TotalSupplyDelta;
  historicalCandidatesConsidered: number;
  eligibleHistoricalCandidates: number;
  currentCandidatesConsidered: number;
  eligibleCurrentCandidates: number;
}

export type BurnSpanningIntervalOutcome =
  | { selected: true; interval: BurnSpanningSupplyInterval }
  | {
      selected: false;
      reason: BurnSpanningIntervalRefusal;
      span: BurnEventSpan | null;
      excludedHistorical: readonly CandidateExclusion[];
    };

export interface BurnSpanningSupplyIntervalInput {
  currentResearchJobId: string;
  // The project's CURRENTLY ACTIVE token address, resolved by the caller.
  currentProjectAnchor: string;
  events: readonly AnchorBurnEvent[];
  // This Research's own readings.
  current: readonly PersistedObservation[];
  // t0 candidates, already loaded. Order is irrelevant.
  historical: readonly PersistedObservation[];
}

export const BURN_SPANNING_INTERVAL_DOES_NOT_PROVE = [
  "the interval containing the burns does NOT establish that any burn caused the change",
  "the delta is the NET of everything that happened between the two slots",
  "a narrower interval does NOT prove less unrelated activity occurred",
  "no burn in the span is made the canonical event of the Proof",
  "the span is selection provenance and is NEVER an establishing input",
] as const;

function isSupply(
  artifact: OnchainArtifact,
): artifact is OnchainArtifact & { result: TokenSupplyResult } {
  return artifact.result.kind === "TOKEN_SUPPLY";
}

// THE SPAN. Reduced from the burn set by the only two numbers an interval
// needs to contain it, plus how many burns went into them so a diagnostic can
// tell "one burn" from "the outer edges of nine".
//
// Usability is asked through `anchorBurnRef`, so what counts as a decoded
// burn is the interval selector's own answer rather than a second one, and
// the admission rules — this Research's, this project's mint — are the same
// ones every B2 layer applies.
export function deriveBurnEventSpan(input: {
  currentResearchJobId: string;
  currentProjectAnchor: string;
  events: readonly AnchorBurnEvent[];
}): BurnEventSpan | null {
  let earliestSlot: number | null = null;
  let latestSlot: number | null = null;
  let eventCount = 0;
  for (const event of input.events) {
    if (event.researchJobId !== input.currentResearchJobId) continue;
    const ref = anchorBurnRef(event.artifact, event.burnIndex, input.currentResearchJobId);
    if (ref === null) continue;
    if (!Number.isInteger(ref.slot) || ref.slot < 0) continue;
    if (
      ref.mint !== input.currentProjectAnchor ||
      event.artifact.provenance.projectAnchor !== input.currentProjectAnchor
    ) {
      continue;
    }
    eventCount += 1;
    if (earliestSlot === null || ref.slot < earliestSlot) earliestSlot = ref.slot;
    if (latestSlot === null || ref.slot > latestSlot) latestSlot = ref.slot;
  }
  if (earliestSlot === null || latestSlot === null) return null;
  return { earliestSlot, latestSlot, eventCount };
}

// WHICH OF THIS RESEARCH'S OWN READINGS MAY CLOSE THE INTERVAL.
//
// The mirror of `filterTemporalSupplyEligibility`, for the other end and the
// other origin: t1 must be THIS job's (a prior job's reading is history, and
// this Research did not observe it), of this project's active mint, usable by
// B2a's own validator, and strictly after the last burn. Standalone
// owner-script observations are refused here for the same product reason they
// are refused as t0.
export function filterCurrentSupplyEligibility(input: {
  currentResearchJobId: string;
  currentProjectAnchor: string;
  afterSlot: number;
  current: readonly PersistedObservation[];
}): { candidate: PersistedObservation; slot: number; index: number }[] {
  const eligible: { candidate: PersistedObservation; slot: number; index: number }[] = [];
  for (const [index, candidate] of input.current.entries()) {
    if (candidate.originKind !== "RESEARCH_JOB" || candidate.researchJobId === null) continue;
    if (candidate.researchJobId !== input.currentResearchJobId) continue;
    const artifact = candidate.artifact;
    if (!isSupply(artifact) || !isComparableSupplyObservation(artifact)) continue;
    if (
      artifact.result.mint !== input.currentProjectAnchor ||
      artifact.provenance.projectAnchor !== input.currentProjectAnchor
    ) {
      continue;
    }
    // STRICT. A reading at the last burn's own slot does not close the
    // interval, for the same fail-closed reason the left bound is strict.
    if (!(artifact.provenance.slot > input.afterSlot)) continue;
    eligible.push({ candidate, slot: artifact.provenance.slot, index });
  }
  return eligible;
}

export function selectBurnSpanningSupplyInterval(
  input: BurnSpanningSupplyIntervalInput,
): BurnSpanningIntervalOutcome {
  const none: readonly CandidateExclusion[] = [];

  const span = deriveBurnEventSpan(input);
  if (span === null) {
    return {
      selected: false,
      reason: "NO_USABLE_BURN_EVENT",
      span: null,
      excludedHistorical: none,
    };
  }

  // --- t1 first, because it establishes the measurement domain ----------
  const currentEligible = filterCurrentSupplyEligibility({
    currentResearchJobId: input.currentResearchJobId,
    currentProjectAnchor: input.currentProjectAnchor,
    afterSlot: span.latestSlot,
    current: input.current,
  });
  // THE NEAREST ONE AFTER THE SPAN, not the latest this job holds. A later
  // reading is a wider interval, and a wider interval is a weaker statement
  // about when the change happened.
  const chosenCurrent = selectEventAnchoredSupplyObservation(currentEligible, "SMALLEST");
  if (chosenCurrent === null) {
    return {
      selected: false,
      reason: "NO_CURRENT_OBSERVATION_AFTER_SPAN",
      span,
      excludedHistorical: none,
    };
  }
  if ("ambiguous" in chosenCurrent) {
    return {
      selected: false,
      reason: "AMBIGUOUS_CURRENT_OBSERVATION",
      span,
      excludedHistorical: none,
    };
  }
  const to = chosenCurrent.selected;

  // --- t0, through the existing eligibility, bounded by the EARLIEST burn
  if (input.historical.length === 0) {
    return {
      selected: false,
      reason: "NO_HISTORICAL_CANDIDATES",
      span,
      excludedHistorical: none,
    };
  }
  const { eligible, excluded } = filterTemporalSupplyEligibility({
    currentResearchJobId: input.currentResearchJobId,
    currentProjectAnchor: input.currentProjectAnchor,
    // The left bound is the FIRST burn, so a reading taken between two burns
    // is excluded: it already reflects the burns before it, and an interval
    // starting there would not contain them.
    eventSlot: span.earliestSlot,
    domain: supplyMeasurementDomain(to.artifact),
    historical: input.historical,
  });
  const chosenHistorical = selectEventAnchoredSupplyObservation(eligible, "GREATEST");
  if (chosenHistorical === null) {
    return {
      selected: false,
      reason: "NO_ELIGIBLE_HISTORICAL_OBSERVATION",
      span,
      excludedHistorical: excluded,
    };
  }
  if ("ambiguous" in chosenHistorical) {
    return {
      selected: false,
      reason: "AMBIGUOUS_HISTORICAL_OBSERVATION",
      span,
      excludedHistorical: excluded,
    };
  }
  const from = chosenHistorical.selected;

  // --- the arithmetic, B2a's, run on the two chosen endpoints -----------
  const delta = deriveTotalSupplyDelta(from.artifact, to.artifact);
  if (!delta.comparable) {
    return { selected: false, reason: "NOT_COMPARABLE", span, excludedHistorical: excluded };
  }

  return {
    selected: true,
    interval: {
      span,
      selectionRule: "NEAREST_ELIGIBLE_OBSERVATIONS_STRICTLY_OUTSIDE_BURN_SPAN",
      from,
      to,
      delta: delta.delta,
      historicalCandidatesConsidered: input.historical.length,
      eligibleHistoricalCandidates: eligible.length,
      currentCandidatesConsidered: input.current.length,
      eligibleCurrentCandidates: currentEligible.length,
    },
  };
}
