import {
  isGrossSupplyReductionFact,
  isSupplyIntervalAnchorOnlyFact,
  type OnchainFactKind,
} from "./onchain-facts";

// WHAT THIS RESEARCH ESTABLISHED ABOUT NET SUPPLY, AND WHERE IT STOPS.
//
// Two deterministic observations answer two different questions, and the
// product's whole exposure is in not confusing them:
//
//   a BURN   says a gross destruction event occurred.
//   a DELTA  says how total supply changed across a measured interval —
//            the NET of everything that happened in it.
//
// Neither says the researched mechanism caused anything. That is why NO
// combination here reaches "established": the strongest outcome is a measured
// decrease that remains UNATTRIBUTED, and attribution is a separate
// capability nobody has built.
//
// THE BURN IS REQUIRED. A delta alone is a number about a token, not a
// finding about a mechanism, and reading one without a gross-reduction event
// would let "supply drifted down" become "the buyback worked" and "supply
// drifted up" become "the burn was a lie". So without a typed BURN among the
// establishing evidence this function says only that no gross reduction was
// established, exactly as it did before deltas existed.
//
// ONE BOUNDED EXCEPTION (EVM V1, Founder-approved): a ZERO_ADDRESS_TRANSFER
// that passed every quality gate may ANCHOR the interval in place of a burn.
// It is not a gross reduction and is never treated as one; its outcomes are
// its own two kinds, and the strongest says a decrease was measured around
// the transfer and attributes it to nothing.
//
// DIRECTION IS READ FROM THE RELATIONSHIP, NOT FROM TEXT. A delta filed at
// NET_EFFECT carries SUPPORTS when the measured change was a decrease and
// CONTRADICTS when it was not — set once, deterministically, by the writer
// that computed the arithmetic. Nothing here parses a fragment, and no model
// is involved.
//
// PURE. No database, no clock, no provider.

export interface SupplyEffectRow {
  id: string;
  onchainFactKind: OnchainFactKind | null;
  relationship: "SUPPORTS" | "CONTRADICTS" | "CONTEXT" | "LIMITS";
}

export type NetSupplyEffect =
  // No typed gross reduction among the establishing evidence. A buyback, a
  // holding, a transfer or a single supply reading is not one.
  | { kind: "NO_GROSS_REDUCTION" }
  // A burn IS established, and no measured interval accompanies it. This is a
  // limit on what was OBSERVED — an unavailable provider, an exhausted
  // budget, no prior reading, no reading after the burns, incomparable
  // endpoints — and never a statement that supply did not change.
  | { kind: "NO_MEASURED_INTERVAL" }
  // A burn IS established AND total supply decreased across an interval
  // containing it. The decrease is measured; nothing attributes it.
  | { kind: "MEASURED_DECREASE"; deltaEvidenceIds: readonly string[] }
  // A burn IS established AND total supply did not decrease across the
  // interval containing it: aggregate issuance offset or exceeded aggregate
  // burning over that interval. This contradicts a NET REDUCTION claim, and
  // contradicts nothing about the burn itself.
  | { kind: "MEASURED_NOT_REDUCED"; deltaEvidenceIds: readonly string[] }
  // Two measured intervals disagree about the direction. Never averaged,
  // never resolved by picking the favourable one.
  | { kind: "CONFLICTING_INTERVALS"; deltaEvidenceIds: readonly string[] }
  // EVM V1 — NO burn is established, a ZERO_ADDRESS_TRANSFER anchors the
  // interval, and total supply decreased across it. The decrease is
  // measured; neither destruction by that transfer nor any cause is.
  | { kind: "ZERO_ADDRESS_INTERVAL_DECREASE"; deltaEvidenceIds: readonly string[] }
  // The same anchor, and total supply did NOT decrease across the interval.
  // Contradicts a net-reduction claim; says nothing about the transfer.
  | { kind: "ZERO_ADDRESS_INTERVAL_NOT_REDUCED"; deltaEvidenceIds: readonly string[] };

const isDelta = (row: SupplyEffectRow): boolean => row.onchainFactKind === "TOTAL_SUPPLY_DELTA";

export function evaluateNetSupplyEffect(input: {
  // Rows that passed the full establishing threshold for this component.
  establishing: readonly SupplyEffectRow[];
  // Rows eligible to bear a contradiction: CONTRADICTS + DIRECT + core.
  contradictionCapable: readonly SupplyEffectRow[];
  // EVM V1 — rows of an anchor-only kind (ZERO_ADDRESS_TRANSFER) that passed
  // every quality gate and were withheld from establishment by their kind.
  // They never establish anything; they only say an interval is anchored.
  // Optional, so every existing caller is unchanged.
  intervalAnchors?: readonly SupplyEffectRow[];
}): NetSupplyEffect {
  const decreased = input.establishing.filter(isDelta).map((r) => r.id);
  const notReduced = input.contradictionCapable
    .filter((r) => isDelta(r) && r.relationship === "CONTRADICTS")
    .map((r) => r.id);

  // The burn gate, asked first and asked of the ESTABLISHING set: a delta is
  // interpreted only alongside a gross reduction this Research established.
  if (!input.establishing.some((r) => isGrossSupplyReductionFact(r.onchainFactKind))) {
    // No burn. A zero-address transfer can anchor the interval instead, and
    // then the outcome says only what was measured around it — its own
    // kinds, never the burn outcomes, so no burn wording can follow from it.
    // Without such an anchor, or without a measured interval, the answer is
    // exactly what it always was.
    const anchored = (input.intervalAnchors ?? []).some((r) =>
      isSupplyIntervalAnchorOnlyFact(r.onchainFactKind),
    );
    if (!anchored) return { kind: "NO_GROSS_REDUCTION" };
    if (decreased.length > 0 && notReduced.length > 0) {
      return { kind: "CONFLICTING_INTERVALS", deltaEvidenceIds: [...decreased, ...notReduced].sort() };
    }
    if (notReduced.length > 0) {
      return { kind: "ZERO_ADDRESS_INTERVAL_NOT_REDUCED", deltaEvidenceIds: [...notReduced].sort() };
    }
    if (decreased.length > 0) {
      return { kind: "ZERO_ADDRESS_INTERVAL_DECREASE", deltaEvidenceIds: [...decreased].sort() };
    }
    return { kind: "NO_GROSS_REDUCTION" };
  }

  // FAIL CLOSED ON DISAGREEMENT. One interval per Research is what the
  // materializer produces, and identity makes a recomputation idempotent — so
  // two intervals pointing opposite ways means the record contradicts itself.
  // Averaging them would invent a number nobody observed, and choosing one
  // would be choosing an answer.
  if (decreased.length > 0 && notReduced.length > 0) {
    return { kind: "CONFLICTING_INTERVALS", deltaEvidenceIds: [...decreased, ...notReduced].sort() };
  }
  if (notReduced.length > 0) {
    return { kind: "MEASURED_NOT_REDUCED", deltaEvidenceIds: [...notReduced].sort() };
  }
  if (decreased.length > 0) {
    return { kind: "MEASURED_DECREASE", deltaEvidenceIds: [...decreased].sort() };
  }
  return { kind: "NO_MEASURED_INTERVAL" };
}

// WHAT NONE OF THESE OUTCOMES ESTABLISH. Stated beside the rules so a future
// consumer cannot reach for the outcome without reading the boundary.
export const NET_SUPPLY_EFFECT_DOES_NOT_PROVE = [
  "a measured decrease does NOT establish that the researched mechanism caused it",
  "a measured increase does NOT establish that any burn was fake or that anyone lied",
  "an unchanged supply does NOT establish which issuance offset the burn",
  "no outcome here establishes circulating supply, which is not a chain value",
  "an absent interval is a limit on what was observed, never a statement about the token",
  "a zero-address transfer is NOT a burn, and a decrease around it is NOT attributed to it",
] as const;
