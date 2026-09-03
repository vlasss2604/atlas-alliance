import type {
  OnchainArtifact,
  OnchainProvenance,
  TokenSupplyResult,
} from "./providers/onchain-types";
import { isProvenanceComplete } from "./onchain-binding";

// TOTAL SUPPLY DELTA — the pure arithmetic over two deterministic
// observations, and nothing else.
//
// WHY THIS IS A DERIVATION AND NOT A QUERY. `getTokenSupply` reads the
// mint's live state; the adapter sends `[mint, { commitment }]` and there
// is no parameter in the intent contract, or in the method, that can ask
// for supply AT a past slot. So a supply CHANGE cannot be retrieved. It can
// only be derived from two observations taken at different times — which
// makes the comparison itself the capability, and makes it worth writing
// once, exactly, with no room for a judgment call.
//
// WHAT THIS MODULE IS. A pure function. It reads no database, writes no
// row, calls no provider, creates no Evidence, synthesizes no fact kind and
// is reachable from no production path. It answers one question:
//
//   "Are these two deterministic observations of the same measurable token
//    supply, and if so, by exactly how much did that supply change between
//    them?"
//
// WHAT IT DELIBERATELY IS NOT.
//
//   * NOT project admission. Whether this mint is the project a Research
//     job is about — the ACTIVE PROJECT_IDENTITY question — belongs to the
//     caller. Two observations of a token nobody is researching are still
//     two comparable observations of that token, and a comparator that
//     refused them would be answering a question it was not asked.
//   * NOT freshness. A mathematically valid pair does not stop being valid
//     because it is old. Whether `to` is recent enough to support a claim
//     in a Proof is a research-policy decision, made by whatever consumes
//     this, against the ordinary freshness policy.
//   * NOT a re-observation guard. Exact historical-slot supply retrieval is
//     not available, so "re-read t0's slot and confirm" is not a check that
//     could be performed. Encoding an unperformable verification as an
//     invariant would be a rule that is satisfied only by never being run.
//
// ON FINALITY, PRECISELY. `provenance.finality` records the commitment
// ATLAS REQUESTED and under which the response was recorded. It is not a
// cryptographic proof returned by the node, and this module does not treat
// it as one. Requiring `finalized` on both inputs means "both readings were
// taken at the canonical commitment level this system asks for", which is
// the strongest thing the existing observation contract can say.

export type TotalSupplyDirection = "DECREASED" | "UNCHANGED" | "INCREASED";

// An artifact already proved to carry a total-supply reading. Narrowed
// once, at the validation boundary, so nothing below re-tests the kind or
// reaches for a field the union does not have.
type TokenSupplyObservation = OnchainArtifact & { result: TokenSupplyResult };

// Enough of an observation's provenance to identify it again, carried on
// the result so a derived delta is never a number without a source. Both
// inputs are represented; neither is summarised away.
export interface TotalSupplyObservationRef {
  amountRaw: string;
  slot: number;
  // The commitment REQUESTED, echoed from provenance — see the note above.
  requestedFinality: OnchainProvenance["finality"];
  // ATLAS's own clock at retrieval, not a chain timestamp. A TOKEN_SUPPLY
  // artifact carries no blockTime, so no wall-clock interval is derived
  // from these — the chain-ordered interval is the slot span below.
  retrievedAt: Date;
  providerId: string;
  providerMethod: string;
  canonicalUri: string;
  rawResponseHash: string;
  artifactHash: string;
}

export interface TotalSupplyDelta {
  chain: string;
  network: string;
  mint: string;
  decimals: number;
  // Signed exact integer string. Never a number, never rounded: token
  // supplies routinely exceed Number.MAX_SAFE_INTEGER, and a delta that
  // lost a unit to floating point would be a false fact.
  deltaRaw: string;
  direction: TotalSupplyDirection;
  // The chain's own ordering of the interval. Deliberately the only
  // interval this module reports.
  slotSpan: number;
  from: TotalSupplyObservationRef;
  to: TotalSupplyObservationRef;
}

// Why a pair could not be compared. Every one is a refusal to derive, never
// a derived zero: "not comparable" and "unchanged" are different findings
// and must never collapse into each other.
export type TotalSupplyDeltaRefusal =
  // Something other than a total-supply observation was offered.
  | "WRONG_FACT_KIND"
  // The observation does not carry a usable chain position.
  | "MISSING_OR_INVALID_SLOT"
  // A reading taken below the canonical requested commitment can be
  // reorganised away, so it may not anchor an interval.
  | "NON_FINALIZED_OBSERVATION"
  // The observation fails the existing deterministic provenance contract,
  // or disagrees with itself about which mint it describes.
  | "INVALID_PROVENANCE"
  // amountRaw is not a canonical non-negative integer string.
  | "INVALID_RAW_SUPPLY"
  // decimals is not a usable non-negative integer, so the raw value has no
  // determinate meaning even though it parses.
  | "INVALID_DECIMALS"
  // The two observations are not of the same measurable thing.
  | "CHAIN_MISMATCH"
  | "NETWORK_MISMATCH"
  | "MINT_MISMATCH"
  | "DECIMALS_MISMATCH"
  // Without a strictly later reading there is no interval — equal slots are
  // the same chain position, not a span of zero.
  | "NON_INCREASING_SLOT";

export type TotalSupplyDeltaOutcome =
  | { comparable: true; delta: TotalSupplyDelta }
  | { comparable: false; reason: TotalSupplyDeltaRefusal };

// A canonical non-negative integer string, the same shape the adapter's
// `amountRaw` contract already promises. Leading zeros, signs, decimal
// points, exponents and whitespace are all refused rather than coerced —
// a value we had to guess at is not a deterministic observation.
const CANONICAL_UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/;

function isCanonicalUnsignedInteger(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UNSIGNED_INTEGER.test(value);
}

// Per-observation validity, in a fixed order so the reported reason is
// deterministic for a given input rather than dependent on evaluation
// accidents. The slot check runs BEFORE the full provenance contract even
// though that contract also covers slot: the specific reason is the more
// useful one, and the general check still guards everything else.
function validateObservation(
  o: OnchainArtifact,
): { ok: true; observation: TokenSupplyObservation } | { ok: false; reason: TotalSupplyDeltaRefusal } {
  if (o.result.kind !== "TOKEN_SUPPLY") return { ok: false, reason: "WRONG_FACT_KIND" };
  const observation = o as TokenSupplyObservation;
  const p = observation.provenance;
  if (!Number.isInteger(p?.slot) || p.slot < 0) {
    return { ok: false, reason: "MISSING_OR_INVALID_SLOT" };
  }
  if (p.finality !== "finalized") return { ok: false, reason: "NON_FINALIZED_OBSERVATION" };
  // The existing deterministic observation contract, reused rather than
  // restated — an observation nobody can re-verify cannot anchor anything.
  if (!isProvenanceComplete(p)) return { ok: false, reason: "INVALID_PROVENANCE" };
  // AND the observation must agree with itself: the normalized response
  // names the mint it describes, and provenance names the subject that was
  // requested. A provider answering about a different mint than the one
  // asked for is caught here. This is the self-consistency half of what
  // `validateOnchainBinding` checks; the other half is project identity,
  // which is deliberately not this function's question.
  if (observation.result.mint !== p.subject) return { ok: false, reason: "INVALID_PROVENANCE" };
  if (!isCanonicalUnsignedInteger(observation.result.amountRaw)) {
    return { ok: false, reason: "INVALID_RAW_SUPPLY" };
  }
  if (!Number.isInteger(observation.result.decimals) || observation.result.decimals < 0) {
    return { ok: false, reason: "INVALID_DECIMALS" };
  }
  return { ok: true, observation };
}

// Derives the exact total-supply change between two observations.
//
// `from` is the earlier reading and `to` the later one; the ordering is
// asserted from the chain's own slot, never from either observation's
// retrievedAt — two nodes' clocks are not comparable, and slot is the only
// ordering the chain itself provides.
export function deriveTotalSupplyDelta(
  from: OnchainArtifact,
  to: OnchainArtifact,
): TotalSupplyDeltaOutcome {
  const earlier = validateObservation(from);
  if (!earlier.ok) return { comparable: false, reason: earlier.reason };
  const later = validateObservation(to);
  if (!later.ok) return { comparable: false, reason: later.reason };
  const t0 = earlier.observation;
  const t1 = later.observation;

  // Both are valid total-supply observations. Now: are they of the SAME
  // measurable thing? Each of these is a different token, or the same token
  // measured in different units, and none of them is an arithmetic problem
  // that could be worked around.
  if (t0.provenance.chain !== t1.provenance.chain) {
    return { comparable: false, reason: "CHAIN_MISMATCH" };
  }
  if (t0.provenance.network !== t1.provenance.network) {
    return { comparable: false, reason: "NETWORK_MISMATCH" };
  }
  if (t0.result.mint !== t1.result.mint) {
    return { comparable: false, reason: "MINT_MISMATCH" };
  }
  if (t0.result.decimals !== t1.result.decimals) {
    return { comparable: false, reason: "DECIMALS_MISMATCH" };
  }
  if (!(t1.provenance.slot > t0.provenance.slot)) {
    return { comparable: false, reason: "NON_INCREASING_SLOT" };
  }

  // EXACT INTEGER ARITHMETIC. BigInt, not Number: a token with 9 decimals
  // and a billion units has a raw supply above 2^53, so a delta computed in
  // floating point could be silently wrong by whole tokens.
  // `BigInt(0)` rather than a `0n` literal: this project targets ES2017,
  // where BigInt literals are unavailable although the runtime type is not.
  const ZERO = BigInt(0);
  const deltaRaw = BigInt(t1.result.amountRaw) - BigInt(t0.result.amountRaw);

  return {
    comparable: true,
    delta: {
      chain: t0.provenance.chain,
      network: t0.provenance.network,
      mint: t0.result.mint,
      decimals: t0.result.decimals,
      deltaRaw: deltaRaw.toString(),
      direction: deltaRaw < ZERO ? "DECREASED" : deltaRaw > ZERO ? "INCREASED" : "UNCHANGED",
      slotSpan: t1.provenance.slot - t0.provenance.slot,
      from: observationRef(t0),
      to: observationRef(t1),
    },
  };
}

function observationRef(o: TokenSupplyObservation): TotalSupplyObservationRef {
  const p = o.provenance;
  return {
    amountRaw: o.result.amountRaw,
    slot: p.slot,
    requestedFinality: p.finality,
    retrievedAt: p.retrievedAt,
    providerId: p.providerId,
    providerMethod: p.providerMethod,
    canonicalUri: o.canonicalUri,
    rawResponseHash: p.rawResponseHash,
    artifactHash: p.artifactHash,
  };
}

// WHAT A DERIVED DELTA ESTABLISHES, AND WHERE IT STOPS.
//
// Stated here, beside the arithmetic, so a future consumer cannot reach for
// the number without reading the boundary. This is not yet product copy and
// is deliberately not wired into `ONCHAIN_DOES_NOT_PROVE` — that structure
// belongs to persisted fact kinds, and this module persists nothing.
//
// ESTABLISHES: total supply of this mint, as recorded on-chain, was X at
// the earlier slot and Y at the later one, so between those two chain
// positions total supply changed by exactly Y - X — the net of all minting
// and all burning in that interval.
//
// DOES NOT ESTABLISH:
//   * circulating supply, or any change in it — circulating supply is a
//     definitional and economic concept, not a chain value;
//   * what happened INSIDE the interval — a net of -10 is equally
//     consistent with one burn of 10 and with 1,000 burned against 990
//     minted;
//   * that any particular observed burn caused any part of the change;
//   * attribution to a buyback, a mechanism, an actor or a policy;
//   * holder impact, or that fewer tokens are available — unlocks and
//     vesting move already-minted tokens and change total supply by zero;
//   * durability — that supply stays where the later reading found it;
//   * the presence or absence of unlocks, mints or burns not visible in the
//     two readings themselves.
export const TOTAL_SUPPLY_DELTA_DOES_NOT_PROVE =
  "This is the change in the token's total supply as recorded on-chain between two observed slots, " +
  "which is the net of all minting and all burning in that interval. It does not establish circulating " +
  "supply or any change in it; it does not show what individual events occurred inside the interval; it " +
  "does not establish that any particular burn, buyback or mechanism caused the change; and it does not " +
  "establish holder impact, unlock activity or durability.";
