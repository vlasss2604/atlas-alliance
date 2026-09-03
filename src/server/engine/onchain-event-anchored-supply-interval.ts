import {
  deriveTotalSupplyDelta,
  isComparableSupplyObservation,
  supplyMeasurementDomain,
  supplyMeasurementDomainMismatch,
  type SupplyMeasurementDomain,
  type TotalSupplyDelta,
} from "./onchain-supply-delta";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  TokenSupplyResult,
  TransactionDetailResult,
} from "./providers/onchain-types";

// EVENT-ANCHORED SUPPLY INTERVAL — which two observations, and why those.
//
// THE PROBLEM THIS SOLVES, AND WHY IT IS NOT A CONVENIENCE. A total-supply
// delta is only as honest as the interval it spans, and the obvious way to
// pick that interval is dishonest: "compare against whatever ATLAS last
// observed" makes the answer a function of ATLAS's own observation cadence
// rather than of the world. Observed ten minutes ago, the delta is ~0 and
// reads as "the mechanism does not reduce supply". Observed six months ago,
// the same code answers the same question about the same chain completely
// differently. An interval chosen by our schedule cannot answer a question
// about a project.
//
// So V1 anchors the interval on something IN THE WORLD: a deterministic
// event established by this Research. The interval must contain the event,
// and among the intervals that do, the narrowest is taken.
//
// A NARROWER INTERVAL PROVES NOTHING EXTRA. It does not show that less
// unrelated minting or burning occurred — only that there was less chain
// interval in which it could have. It is a deterministic tie-break, chosen
// so the rule cannot be argued with, and it is not attribution evidence.
//
// STRICT ON BOTH SIDES, DELIBERATELY:
//
//     t0.slot < event.slot < t1.slot
//
// The left bound must be strict: a burn AT t0's slot is already reflected in
// t0's reading, so the delta would not contain it and calling that
// containment would be false. The right bound is strict FOR NOW as a
// fail-closed measure: whether a finalized supply read at context slot S
// includes transactions in slot S has not been validated against live node
// behaviour, so `event.slot == t1.slot` is refused rather than assumed. If
// acceptance confirms the semantics, widening that one comparison to `<=`
// is a separate, reviewed change.
//
// PURE. No database access, no query, no provider, no model, no text
// matching. The caller supplies already-loaded canonical rows and the
// project's CURRENTLY ACTIVE anchor; this module never resolves identity
// itself, which is what keeps arithmetic comparability and current-Research
// admission two different questions.
//
// PERSISTS NOTHING. No Evidence, no fact kind, no row, and no wiring to
// reconciliation or NET_EFFECT.

// The two canonical origin modes of `onchain_artifacts`, as the table's own
// CHECK constrains them. A narrow projection of the persistence metadata an
// artifact cannot carry in itself — the same discipline `EvidenceRow` in
// component-reconciler.ts and `DerivationEdge` in onchain-locator-bound-burn.ts
// already follow.
export interface PersistedObservation {
  artifact: OnchainArtifact;
  originKind: "RESEARCH_JOB" | "STANDALONE_STRUCTURED_OBSERVATION";
  // NULL exactly when the origin is standalone.
  researchJobId: string | null;
}

// The deterministic event the interval is anchored on. V1 uses the BURN
// shape that already exists rather than inventing an event abstraction: the
// caller names which decoded burn in the transaction, exactly as the
// locator-bound-burn primitive does.
//
// THE ANCHOR IS ABOUT CONTAINMENT ONLY. It positions the interval; it
// establishes no attribution, and LOCATOR_BOUND_BURN is deliberately not
// required — a burn need not be bound to a documented identifier to say
// truthfully when it happened.
export interface AnchorBurnEvent {
  artifact: OnchainArtifact;
  burnIndex: number;
  researchJobId: string | null;
}

export interface EventAnchoredSupplyIntervalInput {
  currentResearchJobId: string;
  // The project's CURRENTLY ACTIVE token address, resolved by the caller.
  // Passing it in is what stops this module from deciding admission: an old
  // mint's observations are arithmetically comparable with each other and
  // still not about this project any more.
  currentProjectAnchor: string;
  event: AnchorBurnEvent;
  // t1 — freshly acquired by THIS job. Freshness in V1 is structural rather
  // than a wall-clock threshold: it is current because this Research
  // acquired it, so no day count is needed or invented.
  current: PersistedObservation;
  // t0 candidates, already loaded. Order is irrelevant.
  historical: readonly PersistedObservation[];
}

export interface SupplyObservationRef {
  researchJobId: string;
  amountRaw: string;
  decimals: number;
  slot: number;
  requestedFinality: "finalized" | "confirmed";
  retrievedAt: Date;
  providerId: string;
  canonicalUri: string;
  rawResponseHash: string;
  artifactHash: string;
}

export interface AnchorBurnRef {
  researchJobId: string;
  signature: string;
  slot: number;
  mint: string;
  sourceAccount: string;
  amountRaw: string;
  decimals: number | null;
  instructionType: BurnInstructionRef["instructionType"];
  canonicalUri: string;
  rawResponseHash: string;
  artifactHash: string;
}

export interface EventAnchoredSupplyInterval {
  currentResearchJobId: string;
  projectAnchor: string;
  // Named on the result so a reader never has to infer why THIS interval.
  selectionRule: "GREATEST_ELIGIBLE_SLOT_STRICTLY_BEFORE_EVENT";
  // The ordering, stated rather than implied. t0 < event < t1, strictly.
  ordering: { historicalSlot: number; eventSlot: number; currentSlot: number };
  historical: SupplyObservationRef;
  current: SupplyObservationRef;
  event: AnchorBurnRef;
  // Recomputed here, every time, from the two selected observations. A
  // historical delta is never reused — only historical OBSERVATIONS are.
  delta: TotalSupplyDelta;
  // WHICH interval was available to choose from. Exposed because the answer
  // depends on it: a different candidate set can yield a different interval
  // and therefore a different number, and presenting the delta as timeless
  // would hide that.
  candidatesConsidered: number;
  eligibleCandidates: number;
}

export type SupplyIntervalRefusal =
  // t1 is not a usable deterministic total-supply observation.
  | "INVALID_CURRENT_OBSERVATION"
  | "CURRENT_OBSERVATION_NOT_RESEARCH_ORIGIN"
  | "CURRENT_OBSERVATION_NOT_CURRENT_JOB"
  | "CURRENT_IDENTITY_MISMATCH"
  // The anchor event is unusable, foreign, or not positioned before t1.
  | "INVALID_EVENT"
  | "EVENT_NOT_CURRENT_JOB"
  | "EVENT_MINT_MISMATCH"
  | "EVENT_NOT_STRICTLY_BEFORE_CURRENT_OBSERVATION"
  // Nothing was offered to choose from.
  | "NO_HISTORICAL_CANDIDATES"
  // Every candidate failed, at the stage named. Reported as the failure of
  // the candidate that got FURTHEST, so the reason describes the nearest
  // miss rather than the first rejection.
  | "STANDALONE_OBSERVATION_NOT_ELIGIBLE"
  | "HISTORICAL_OBSERVATION_NOT_PRIOR_JOB"
  | "HISTORICAL_IDENTITY_MISMATCH"
  | "NO_EVENT_CONTAINING_INTERVAL"
  | "NO_COMPARABLE_HISTORICAL_OBSERVATION"
  // Two candidates stand at the same greatest eligible slot and disagree
  // about the supply. Never silently resolved.
  | "AMBIGUOUS_HISTORICAL_OBSERVATION";

export interface CandidateExclusion {
  index: number;
  reason: Exclude<
    SupplyIntervalRefusal,
    | "INVALID_CURRENT_OBSERVATION"
    | "CURRENT_OBSERVATION_NOT_RESEARCH_ORIGIN"
    | "CURRENT_OBSERVATION_NOT_CURRENT_JOB"
    | "CURRENT_IDENTITY_MISMATCH"
    | "INVALID_EVENT"
    | "EVENT_NOT_CURRENT_JOB"
    | "EVENT_MINT_MISMATCH"
    | "EVENT_NOT_STRICTLY_BEFORE_CURRENT_OBSERVATION"
    | "NO_HISTORICAL_CANDIDATES"
    | "AMBIGUOUS_HISTORICAL_OBSERVATION"
  >;
}

export type EventAnchoredSupplyIntervalOutcome =
  | { selected: true; interval: EventAnchoredSupplyInterval }
  | { selected: false; reason: SupplyIntervalRefusal; excluded: readonly CandidateExclusion[] };

// How far a candidate got before it failed. Higher is nearer to eligible,
// and the aggregate refusal reports the highest reached — so "one candidate
// was right except it sat after the event" is never masked by "another was
// standalone".
const EXCLUSION_PROGRESS: Record<CandidateExclusion["reason"], number> = {
  STANDALONE_OBSERVATION_NOT_ELIGIBLE: 0,
  HISTORICAL_OBSERVATION_NOT_PRIOR_JOB: 1,
  HISTORICAL_IDENTITY_MISMATCH: 2,
  NO_EVENT_CONTAINING_INTERVAL: 3,
  NO_COMPARABLE_HISTORICAL_OBSERVATION: 4,
};

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

// Identity is checked on BOTH the response's own mint and the artifact's
// anchor. They agree for a well-formed observation; requiring both means a
// disagreement is a refusal rather than a coin toss about which to trust.
function matchesAnchor(
  observation: OnchainArtifact & { result: TokenSupplyResult },
  anchor: string,
): boolean {
  return observation.result.mint === anchor && observation.provenance.projectAnchor === anchor;
}

function supplyRef(
  observation: OnchainArtifact & { result: TokenSupplyResult },
  researchJobId: string,
): SupplyObservationRef {
  const p = observation.provenance;
  return {
    researchJobId,
    amountRaw: observation.result.amountRaw,
    decimals: observation.result.decimals,
    slot: p.slot,
    requestedFinality: p.finality,
    retrievedAt: p.retrievedAt,
    providerId: p.providerId,
    canonicalUri: observation.canonicalUri,
    rawResponseHash: p.rawResponseHash,
    artifactHash: p.artifactHash,
  };
}

// The anchor event, as a flat reference. Exported so a caller that must
// REPORT which event it anchored on — without selecting an interval — builds
// it from the same fields rather than a copy of them. Returns null for
// anything that is not a decoded burn at the named index.
export function anchorBurnRef(
  artifact: OnchainArtifact,
  burnIndex: number,
  researchJobId: string,
): AnchorBurnRef | null {
  if (!isTransaction(artifact)) return null;
  const burn: BurnInstructionRef | undefined = artifact.result.burns[burnIndex];
  if (!burn) return null;
  return {
    researchJobId,
    signature: artifact.result.signature,
    slot: artifact.provenance.slot,
    mint: burn.mint,
    sourceAccount: burn.sourceAccount,
    amountRaw: burn.amountRaw,
    decimals: burn.decimals,
    instructionType: burn.instructionType,
    canonicalUri: artifact.canonicalUri,
    rawResponseHash: artifact.provenance.rawResponseHash,
    artifactHash: artifact.provenance.artifactHash,
  };
}

// ELIGIBILITY, as its own step. Returns the candidates that may take part
// in THIS Research at all — never which one to use.
//
// TAKES A MEASUREMENT DOMAIN, NOT A t1. Eligibility asks whether a candidate
// COULD legitimately serve as t0; that question has an answer before any
// current observation exists, and a caller deciding whether to acquire one
// needs it then. `domain` may therefore be null, meaning "the current
// measurement domain is not established yet" — every other rule still
// applies, and the domain agreement is simply not among them.
//
// Nothing is weakened for the selector: it always passes the domain of its
// own t1, and its `t0.slot < event.slot < t1.slot` bounds already guarantee
// the strictly-increasing slot that `deriveTotalSupplyDelta` would check.
export function filterTemporalSupplyEligibility(input: {
  currentResearchJobId: string;
  currentProjectAnchor: string;
  eventSlot: number;
  domain: SupplyMeasurementDomain | null;
  historical: readonly PersistedObservation[];
}): {
  eligible: { candidate: PersistedObservation; slot: number; index: number }[];
  excluded: CandidateExclusion[];
} {
  const eligible: { candidate: PersistedObservation; slot: number; index: number }[] = [];
  const excluded: CandidateExclusion[] = [];

  for (const [index, candidate] of input.historical.entries()) {
    const { artifact, originKind, researchJobId } = candidate;
    // PRODUCT POLICY, NOT DATA QUALITY. A standalone owner-script
    // observation may be perfectly formed and is still refused in V1: it was
    // not acquired by any Research, and letting owner activity move a Proof
    // is a widening nobody has approved.
    if (originKind !== "RESEARCH_JOB" || researchJobId === null) {
      excluded.push({ index, reason: "STANDALONE_OBSERVATION_NOT_ELIGIBLE" });
      continue;
    }
    if (researchJobId === input.currentResearchJobId) {
      // t0 must come from a PRIOR job. An earlier reading inside this same
      // job is not a historical observation; it is this run observing twice.
      excluded.push({ index, reason: "HISTORICAL_OBSERVATION_NOT_PRIOR_JOB" });
      continue;
    }
    if (!isSupply(artifact) || !isComparableSupplyObservation(artifact)) {
      excluded.push({ index, reason: "NO_COMPARABLE_HISTORICAL_OBSERVATION" });
      continue;
    }
    if (!matchesAnchor(artifact, input.currentProjectAnchor)) {
      // Arithmetically comparable with each other, and no longer about this
      // project — the case only a current identity can catch.
      excluded.push({ index, reason: "HISTORICAL_IDENTITY_MISMATCH" });
      continue;
    }
    if (!(artifact.provenance.slot < input.eventSlot)) {
      excluded.push({ index, reason: "NO_EVENT_CONTAINING_INTERVAL" });
      continue;
    }
    // Comparability is B2a's question, asked through B2a: same chain,
    // network, mint and unit scale. Skipped, never guessed, when the current
    // domain is not established — a candidate is not disqualified by a
    // comparison there is nothing to make.
    const candidateDomain = supplyMeasurementDomain(artifact);
    if (
      input.domain !== null &&
      (candidateDomain === null ||
        supplyMeasurementDomainMismatch(candidateDomain, input.domain) !== null)
    ) {
      excluded.push({ index, reason: "NO_COMPARABLE_HISTORICAL_OBSERVATION" });
      continue;
    }
    eligible.push({ candidate, slot: artifact.provenance.slot, index });
  }

  return { eligible, excluded };
}

// SELECTION, as its own step. The greatest eligible slot strictly before the
// event — the narrowest interval that still contains it.
export function selectEventAnchoredSupplyObservation(
  eligible: readonly { candidate: PersistedObservation; slot: number; index: number }[],
): { selected: PersistedObservation } | { ambiguous: true } | null {
  if (eligible.length === 0) return null;
  const greatest = Math.max(...eligible.map((e) => e.slot));
  const atGreatest = eligible.filter((e) => e.slot === greatest);
  if (atGreatest.length > 1) {
    // Two observations at one chain position. If they report the same value
    // they are the same reading recorded by two jobs, and either yields an
    // identical delta — resolved deterministically. If they DISAGREE about
    // the supply at one slot, the record contradicts itself and picking one
    // would be inventing an answer.
    const values = new Set(
      atGreatest.map((e) => (e.candidate.artifact.result as TokenSupplyResult).amountRaw),
    );
    if (values.size > 1) return { ambiguous: true };
    const sorted = [...atGreatest].sort((a, b) =>
      a.candidate.artifact.provenance.artifactHash === b.candidate.artifact.provenance.artifactHash
        ? (a.candidate.researchJobId ?? "").localeCompare(b.candidate.researchJobId ?? "")
        : a.candidate.artifact.provenance.artifactHash.localeCompare(
            b.candidate.artifact.provenance.artifactHash,
          ),
    );
    return { selected: sorted[0].candidate };
  }
  return { selected: atGreatest[0].candidate };
}

export function selectEventAnchoredSupplyInterval(
  input: EventAnchoredSupplyIntervalInput,
): EventAnchoredSupplyIntervalOutcome {
  const none: readonly CandidateExclusion[] = [];

  // --- t1, the current observation -------------------------------------
  const t1 = input.current.artifact;
  if (!isSupply(t1) || !isComparableSupplyObservation(t1)) {
    return { selected: false, reason: "INVALID_CURRENT_OBSERVATION", excluded: none };
  }
  if (input.current.originKind !== "RESEARCH_JOB" || input.current.researchJobId === null) {
    return { selected: false, reason: "CURRENT_OBSERVATION_NOT_RESEARCH_ORIGIN", excluded: none };
  }
  if (input.current.researchJobId !== input.currentResearchJobId) {
    return { selected: false, reason: "CURRENT_OBSERVATION_NOT_CURRENT_JOB", excluded: none };
  }
  if (!matchesAnchor(t1, input.currentProjectAnchor)) {
    return { selected: false, reason: "CURRENT_IDENTITY_MISMATCH", excluded: none };
  }

  // --- the anchor event --------------------------------------------------
  const eventArtifact = input.event.artifact;
  if (!isTransaction(eventArtifact)) {
    return { selected: false, reason: "INVALID_EVENT", excluded: none };
  }
  const burn: BurnInstructionRef | undefined = eventArtifact.result.burns[input.event.burnIndex];
  if (!burn || typeof burn.sourceAccount !== "string" || burn.sourceAccount.length === 0) {
    return { selected: false, reason: "INVALID_EVENT", excluded: none };
  }
  const eventSlot = eventArtifact.provenance.slot;
  if (!Number.isInteger(eventSlot) || eventSlot < 0) {
    return { selected: false, reason: "INVALID_EVENT", excluded: none };
  }
  if (input.event.researchJobId !== input.currentResearchJobId) {
    return { selected: false, reason: "EVENT_NOT_CURRENT_JOB", excluded: none };
  }
  if (
    burn.mint !== input.currentProjectAnchor ||
    eventArtifact.provenance.projectAnchor !== input.currentProjectAnchor
  ) {
    return { selected: false, reason: "EVENT_MINT_MISMATCH", excluded: none };
  }
  // STRICT, and strict on this side for a reason that is about evidence
  // rather than arithmetic: `event.slot == t1.slot` is refused because
  // whether a finalized read at slot S includes slot S's transactions has
  // not been validated live. Fail closed until it has.
  if (!(eventSlot < t1.provenance.slot)) {
    return {
      selected: false,
      reason: "EVENT_NOT_STRICTLY_BEFORE_CURRENT_OBSERVATION",
      excluded: none,
    };
  }

  // --- eligibility, then selection ---------------------------------------
  if (input.historical.length === 0) {
    return { selected: false, reason: "NO_HISTORICAL_CANDIDATES", excluded: none };
  }
  const { eligible, excluded } = filterTemporalSupplyEligibility({
    currentResearchJobId: input.currentResearchJobId,
    currentProjectAnchor: input.currentProjectAnchor,
    eventSlot,
    domain: supplyMeasurementDomain(t1),
    historical: input.historical,
  });

  const chosen = selectEventAnchoredSupplyObservation(eligible);
  if (chosen === null) {
    // Report the nearest miss, so the refusal names the real obstacle.
    let reason: SupplyIntervalRefusal = "NO_EVENT_CONTAINING_INTERVAL";
    let best = -1;
    for (const e of excluded) {
      const progress = EXCLUSION_PROGRESS[e.reason];
      if (progress > best) {
        best = progress;
        reason = e.reason;
      }
    }
    return { selected: false, reason, excluded };
  }
  if ("ambiguous" in chosen) {
    return { selected: false, reason: "AMBIGUOUS_HISTORICAL_OBSERVATION", excluded };
  }

  const t0 = chosen.selected.artifact as OnchainArtifact & { result: TokenSupplyResult };
  // RECOMPUTED, ALWAYS. Only the observations are historical; the arithmetic
  // is this job's, every time, and no stored delta is ever reused.
  const delta = deriveTotalSupplyDelta(t0, t1);
  if (!delta.comparable) {
    return { selected: false, reason: "NO_COMPARABLE_HISTORICAL_OBSERVATION", excluded };
  }

  return {
    selected: true,
    interval: {
      currentResearchJobId: input.currentResearchJobId,
      projectAnchor: input.currentProjectAnchor,
      selectionRule: "GREATEST_ELIGIBLE_SLOT_STRICTLY_BEFORE_EVENT",
      ordering: {
        historicalSlot: t0.provenance.slot,
        eventSlot,
        currentSlot: t1.provenance.slot,
      },
      // The historical observation keeps its OWN job id. It is not rewritten
      // to look current-job acquired: a Proof that rests on an earlier run's
      // reading must be able to say so.
      historical: supplyRef(t0, chosen.selected.researchJobId as string),
      current: supplyRef(t1, input.currentResearchJobId),
      event: anchorBurnRef(eventArtifact, input.event.burnIndex, input.currentResearchJobId)!,
      delta: delta.delta,
      candidatesConsidered: input.historical.length,
      eligibleCandidates: eligible.length,
    },
  };
}

// WHAT A SELECTED INTERVAL ESTABLISHES, AND WHERE IT STOPS.
export const EVENT_ANCHORED_SUPPLY_INTERVAL_DOES_NOT_PROVE =
  "This states only that total supply of this mint changed by the stated amount between two observed " +
  "slots, and that the observed burn sits strictly inside that interval. It does NOT establish that the " +
  "burn caused the change; it does NOT establish that any buyback or mechanism caused the burn; it does " +
  "NOT establish that no other minting or burning occurred in the interval — the change is the NET of " +
  "everything that happened in it; it does NOT establish any change in circulating supply; and it does " +
  "NOT establish that the change is durable. A narrower interval bounds where unrelated activity could " +
  "have occurred, and never shows that none did.";
