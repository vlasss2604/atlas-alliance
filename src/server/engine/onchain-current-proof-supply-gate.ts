import {
  anchorBurnRef,
  filterTemporalSupplyEligibility,
  type AnchorBurnEvent,
  type AnchorBurnRef,
  type CandidateExclusion,
  type PersistedObservation,
} from "./onchain-event-anchored-supply-interval";
import {
  planPostEventSupplyAcquisition,
  type PostEventSupplyPlan,
} from "./onchain-post-event-supply-plan";
import {
  supplyMeasurementDomain,
  type SupplyMeasurementDomain,
} from "./onchain-supply-delta";
import type { OnchainArtifact, TokenSupplyResult } from "./providers/onchain-types";

// CURRENT-PROOF ELIGIBILITY — may this Research spend a read, or not?
//
// THE POLICY THIS ENCODES, IN ONE SENTENCE. A one-shot additional
// TOKEN_SUPPLY read may be spent only when it can help complete the CURRENT
// Proof. Current-job budget is never spent to build observation history for
// a future Research.
//
// That policy is not the same question as "is a post-event observation
// missing". A first-ever Research of a project can be missing one and still
// have nothing to gain from acquiring it: with no PRIOR job's reading before
// the event there is no t0, so no interval can be formed today however fresh
// the new reading is. The post-event planner answers the first question; this
// layer adds the second and only then permits a read.
//
// NOTHING IS BUILT FOR THE FUTURE. A refusal here is not a lost opportunity:
// the ordinary anchor-level TOKEN_SUPPLY observations this Research already
// acquires become historical candidates for a later Research by themselves.
// No special history-building read exists, and none is needed.
//
// PURE, AND COMPOSED RATHER THAN COPIED. No database, no provider, no model,
// no clock, and no budget: the eligibility rules are B2b2's own
// `filterTemporalSupplyEligibility`, the missing-observation test is the
// post-event planner's, and the measurement domain is B2a's. This module
// contributes exactly one thing — the order in which they are asked and what
// their combination is allowed to authorise.
//
// IT AUTHORISES NOTHING BY ITSELF. `POST_EVENT_SUPPLY_REQUIRED` means a read
// would complete an interval that today cannot be formed. Whether one may be
// ISSUED still depends on budget, capability and orchestration, none of which
// are this module's question.

export type CurrentProofSupplyDecision = "POST_EVENT_SUPPLY_REQUIRED" | "NO_ACTION";

export type CurrentProofSupplyReason =
  // --- NO_ACTION ---------------------------------------------------------
  // Nothing offered is a usable deterministic event for this project and
  // this job. An acquisition boundary, never a finding about supply.
  | "NO_USABLE_EVENT"
  // A deterministic event exists and a post-event observation is genuinely
  // missing — and acquiring one would still complete nothing, because no
  // PRIOR Research holds an eligible reading before the event. THIS IS THE
  // FUTURE-HISTORY REFUSAL, and it is deliberately distinct from
  // POST_EVENT_OBSERVATION_ALREADY_HELD: one says "a read would buy nothing
  // today", the other says "no read is needed at all".
  | "NO_HISTORICAL_T0"
  // An observation this Research already acquired sits strictly after the
  // event. The interval's right-hand side exists; a fresher reading would
  // only widen it.
  | "POST_EVENT_OBSERVATION_ALREADY_HELD"
  // --- POST_EVENT_SUPPLY_REQUIRED ----------------------------------------
  // A t0 is available and this Research holds no usable total-supply
  // observation at all.
  | "NO_COMPARABLE_CURRENT_OBSERVATION"
  // A t0 is available and every observation this Research holds sits at or
  // before the event. "At" is refused for the same fail-closed reason the
  // interval selector refuses it.
  | "EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT";

export interface CurrentProofSupplyGate {
  decision: CurrentProofSupplyDecision;
  reason: CurrentProofSupplyReason;
  // Retained on the result so a reader never has to reconstruct WHICH job,
  // WHICH project and WHICH event this answer was about.
  currentResearchJobId: string;
  projectAnchor: string;
  event: AnchorBurnRef | null;
  // The domain the historical candidates were compared against, or null when
  // this Research holds no usable reading to establish one yet. Exposed
  // because it changes what eligibility could check.
  measurementDomain: SupplyMeasurementDomain | null;
  // The post-event planner's own answer, unmodified.
  observation: PostEventSupplyPlan;
  historicalCandidatesConsidered: number;
  eligibleHistoricalCandidates: number;
  excludedHistorical: readonly CandidateExclusion[];
}

export interface CurrentProofSupplyGateInput {
  currentResearchJobId: string;
  // The project's CURRENTLY ACTIVE token address, resolved by the caller
  // through the canonical identity mechanism. Passing it in is what keeps
  // identity resolution out of the pure arithmetic, and it is deliberately
  // never read back off a historical observation: an old mint's readings are
  // comparable with each other and are no longer about this project.
  currentProjectAnchor: string;
  // Deterministic BURN events this Research established. V1 anchors on
  // burns and nothing else; LOCATOR_BOUND_BURN is NOT required, because an
  // interval anchor states when something happened and asserts no
  // attribution.
  events: readonly AnchorBurnEvent[];
  // Total-supply observations already persisted, of any origin. Foreign ones
  // are counted and excluded inside, so the answer cannot silently depend on
  // how the caller queried.
  observations: readonly PersistedObservation[];
  // t0 candidates, already loaded. Order is irrelevant.
  historicalCandidates: readonly PersistedObservation[];
}

export const CURRENT_PROOF_SUPPLY_GATE_DOES_NOT_PROVE = [
  "REQUIRED does NOT authorise a read — budget, capability and orchestration are separate",
  "REQUIRED does NOT establish that an interval WILL be selected; B2b2 still decides",
  "an eligible t0 EXISTING is not the same as that t0 being chosen",
  "NO_ACTION does NOT establish that supply was unchanged, or that no burn occurred",
  "no read is ever requested to build observation history for a future Research",
] as const;

function isSupply(
  artifact: OnchainArtifact,
): artifact is OnchainArtifact & { result: TokenSupplyResult } {
  return artifact.result.kind === "TOKEN_SUPPLY";
}

// The measurement domain THIS Research is working in, taken from its own
// readings. Deterministic when several exist: the greatest slot, ties broken
// by artifact hash. A mint's unit scale does not change, so the choice is a
// tie-break rather than a judgement — but it is still made by a rule rather
// than by whichever row arrived first.
function currentMeasurementDomain(
  input: CurrentProofSupplyGateInput,
): SupplyMeasurementDomain | null {
  let best: { slot: number; hash: string; domain: SupplyMeasurementDomain } | null = null;
  for (const candidate of input.observations) {
    if (candidate.originKind !== "RESEARCH_JOB" || candidate.researchJobId === null) continue;
    if (candidate.researchJobId !== input.currentResearchJobId) continue;
    const artifact = candidate.artifact;
    if (!isSupply(artifact)) continue;
    if (artifact.result.mint !== input.currentProjectAnchor) continue;
    if (artifact.provenance.projectAnchor !== input.currentProjectAnchor) continue;
    const domain = supplyMeasurementDomain(artifact);
    if (domain === null) continue;
    const slot = artifact.provenance.slot;
    const hash = artifact.provenance.artifactHash;
    if (best === null || slot > best.slot || (slot === best.slot && hash < best.hash)) {
      best = { slot, hash, domain };
    }
  }
  return best?.domain ?? null;
}

// Which of the offered events the answer is anchored on: the one at the
// greatest usable slot the planner found, ties broken by signature so the
// report cannot depend on input order.
function anchoredEvent(
  input: CurrentProofSupplyGateInput,
  eventSlot: number,
): AnchorBurnRef | null {
  let best: AnchorBurnRef | null = null;
  for (const event of input.events) {
    if (event.researchJobId !== input.currentResearchJobId) continue;
    if (event.artifact.provenance.slot !== eventSlot) continue;
    const ref = anchorBurnRef(event.artifact, event.burnIndex, input.currentResearchJobId);
    if (ref === null) continue;
    if (ref.mint !== input.currentProjectAnchor) continue;
    if (best === null || ref.signature < best.signature) best = ref;
  }
  return best;
}

export function gateCurrentProofSupplyAcquisition(
  input: CurrentProofSupplyGateInput,
): CurrentProofSupplyGate {
  // STEP 1 — is there an event, and is a post-event observation missing?
  // Both answered by the post-event planner, unmodified and not restated.
  const observation = planPostEventSupplyAcquisition({
    currentResearchJobId: input.currentResearchJobId,
    currentProjectAnchor: input.currentProjectAnchor,
    events: input.events,
    observations: input.observations,
  });

  const base = {
    currentResearchJobId: input.currentResearchJobId,
    projectAnchor: input.currentProjectAnchor,
    observation,
    historicalCandidatesConsidered: input.historicalCandidates.length,
  };

  if (observation.eventSlot === null) {
    return {
      ...base,
      decision: "NO_ACTION",
      reason: "NO_USABLE_EVENT",
      event: null,
      measurementDomain: null,
      eligibleHistoricalCandidates: 0,
      excludedHistorical: [],
    };
  }

  const event = anchoredEvent(input, observation.eventSlot);
  const measurementDomain = currentMeasurementDomain(input);

  // STEP 2 — could ANY prior Research's reading legitimately serve as t0?
  // Asked through B2b2's own eligibility, so RESEARCH_JOB-origin-only,
  // prior-job-only, active-anchor, provenance-complete, finalized, strictly
  // before the event and same measurement domain are one rule set, not two.
  const { eligible, excluded } = filterTemporalSupplyEligibility({
    currentResearchJobId: input.currentResearchJobId,
    currentProjectAnchor: input.currentProjectAnchor,
    eventSlot: observation.eventSlot,
    domain: measurementDomain,
    historical: input.historicalCandidates,
  });

  const withEvidence = {
    ...base,
    event,
    measurementDomain,
    eligibleHistoricalCandidates: eligible.length,
    excludedHistorical: excluded,
  };

  // THE POLICY GATE. Checked BEFORE "is one already held", because the
  // question it answers is different in kind: without a t0 there is no
  // interval to complete today, and a read taken anyway would exist only for
  // a future Research to use.
  //
  // EXISTENCE IS ENOUGH. One eligible candidate makes a read worth taking;
  // WHICH candidate becomes t0 is B2b2's decision, made later, against the
  // reading that does not exist yet.
  if (eligible.length === 0) {
    return { ...withEvidence, decision: "NO_ACTION", reason: "NO_HISTORICAL_T0" };
  }

  // STEP 3 — a t0 exists. Does this Research already hold its t1?
  if (observation.decision === "NO_ACTION") {
    return {
      ...withEvidence,
      decision: "NO_ACTION",
      reason: "POST_EVENT_OBSERVATION_ALREADY_HELD",
    };
  }

  // A t0 exists, and no observation this Research holds sits strictly after
  // the event. A read would complete an interval that today cannot be formed.
  return {
    ...withEvidence,
    decision: "POST_EVENT_SUPPLY_REQUIRED",
    reason:
      observation.reason === "NO_COMPARABLE_CURRENT_OBSERVATION"
        ? "NO_COMPARABLE_CURRENT_OBSERVATION"
        : "EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT",
  };
}
