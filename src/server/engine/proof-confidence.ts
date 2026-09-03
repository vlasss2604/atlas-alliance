import type { ResultReasonCode } from "./component-reconciler";
import type { ComponentReconciliationStatus } from "./component-reconciler";

// D-135 — CONFIDENCE IS A CLOSED ORDINAL BAND, NOT A PROBABILITY.
//
// The number stored in `proofs.confidence` encodes one of exactly four
// bands. It expresses STRUCTURAL CONFIDENCE IN THE VERDICT — how well
// established the finding is, given what was recorded — and never the
// probability that the underlying claim is true, never a price or market
// signal, and never model certainty. Nothing here is a percentage: the
// integer exists only because the column is NOT NULL, and no arithmetic
// is ever performed on it (the result is a `min` over a table of caps,
// which cannot be summed, averaged or interpolated).
//
// D-081 and D-110 are preserved: the value is a pure deterministic
// function of persisted closed state, and the model never names it.
//
// Deliberately NOT monotonic with verdict positivity. A reasoned
// INSUFFICIENT_EVIDENCE can outrank a blocked PARTIALLY_SUPPORTED,
// because the question is how well the VERDICT is established, not how
// positive it is. If confidence were a function of the verdict alone it
// would carry no information at all.

export const CONFIDENCE_BANDS = {
  LOW: 20,
  LIMITED: 40,
  STRONG: 60,
  VERY_STRONG: 80,
} as const;

export type ConfidenceBand = keyof typeof CONFIDENCE_BANDS;
export type ConfidenceScore = (typeof CONFIDENCE_BANDS)[ConfidenceBand];

// 0 and 100 are unreachable by construction: 0 because every persisted
// Proof reached a real verdict, 100 because nothing ATLAS concludes is
// beyond revision — which is exactly what the mandatory "what could
// change this conclusion" layer exists to say.
export const CONFIDENCE_SCORES: readonly ConfidenceScore[] = [20, 40, 60, 80];

export function bandOfScore(score: ConfidenceScore): ConfidenceBand {
  const entry = (Object.keys(CONFIDENCE_BANDS) as ConfidenceBand[]).find(
    (b) => CONFIDENCE_BANDS[b] === score,
  );
  // Unreachable: the type admits only the four encodings.
  if (!entry) throw new Error("unreachable: score outside the closed band encoding");
  return entry;
}

// The verdict sets a CEILING, never a floor.
//
// SUPPORTED and NOT_SUPPORTED can reach the top because both are positive
// structural findings — NOT_SUPPORTED in particular is produced only when
// a required requirement is positively CONTRADICTED (claim-evaluator.ts),
// never from absence, so a well-established refutation is exactly as
// strong a finding as a well-established confirmation.
//
// PARTIALLY_SUPPORTED and INSUFFICIENT_EVIDENCE cap at STRONG because
// neither closes the question, and ATLAS cannot establish that it looked
// everywhere. An open verdict is never "no limitation recorded".
const VERDICT_CEILING = {
  SUPPORTED: CONFIDENCE_BANDS.VERY_STRONG,
  NOT_SUPPORTED: CONFIDENCE_BANDS.VERY_STRONG,
  PARTIALLY_SUPPORTED: CONFIDENCE_BANDS.STRONG,
  INSUFFICIENT_EVIDENCE: CONFIDENCE_BANDS.STRONG,
} as const satisfies Record<string, ConfidenceScore>;

export type ConfidenceVerdict = keyof typeof VERDICT_CEILING;

// EXHAUSTIVE over the closed ResultReasonCode vocabulary. This is a
// `Record<ResultReasonCode, …>`, so adding a member to that union without
// deciding its cap is a COMPILE ERROR — a new code can never silently
// fall through as "no limitation" and inflate confidence. `null` means a
// deliberate no-cap, written out rather than omitted.
const REASON_CODE_CAP: Record<ResultReasonCode, ConfidenceScore | null> = {
  // Bare absence. We cannot distinguish "nothing exists" from "we did not
  // look in the right place", which is the weakest possible footing.
  NO_EVIDENCE_FOUND: CONFIDENCE_BANDS.LOW,
  // Reasoned exclusion is NOT blind absence: every candidate was examined
  // and rejected for a recorded reason, so the insufficiency is itself
  // established. No cap of its own — an accompanying blocking gap still
  // applies normally.
  ALL_EVIDENCE_EXCLUDED: null,
  MISSING_EXECUTION_EVIDENCE: CONFIDENCE_BANDS.LIMITED,
  // B1 — both are MISSING STRUCTURE, not weak authority, so both sit with
  // the other missing-structure caps rather than with INSUFFICIENT_AUTHORITY.
  //
  // SUPPLY_REDUCTION_NOT_ESTABLISHED: no typed gross reduction exists at
  // all. A buyback, a holding, a transfer or a supply reading was offered
  // for a supply claim, and none of them is one.
  SUPPLY_REDUCTION_NOT_ESTABLISHED: CONFIDENCE_BANDS.LIMITED,
  // NET_SUPPLY_CHANGE_NOT_ESTABLISHED: a burn IS deterministically
  // established, and the net question still is not — nothing observed what
  // else happened to supply over the same interval. A Proof resting on
  // this must never read as confident about net deflation, which is
  // exactly what an uncapped path would allow.
  NET_SUPPLY_CHANGE_NOT_ESTABLISHED: CONFIDENCE_BANDS.LIMITED,
  // B2 — a measured interval changes WHAT is missing, never that something
  // is. All three stay at the missing-structure band rather than moving up
  // with the authority caveats.
  //
  // NET_SUPPLY_CHANGE_NOT_ATTRIBUTED: the net change IS measured now, and the
  // thing the claim actually needs — that this mechanism caused it — is still
  // entirely unobserved. Capping this ABOVE the not-established case would
  // let "we measured a fall" read as confidence about a mechanism, which is
  // the exact false positive B1 and B2 exist to prevent.
  NET_SUPPLY_CHANGE_NOT_ATTRIBUTED: CONFIDENCE_BANDS.LIMITED,
  // NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL: it accompanies a CONTRADICTED
  // component, so the structural COMPONENT_CONTRADICTED cap normally binds
  // first. The entry exists because a cap must never be absent, and it is
  // LIMITED for the same reason as its neighbours.
  NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL: CONFIDENCE_BANDS.LIMITED,
  // CONFLICTING_SUPPLY_DELTA: the record contradicts itself about the
  // measurement. Nothing about that footing is strong.
  CONFLICTING_SUPPLY_DELTA: CONFIDENCE_BANDS.LIMITED,
  MISSING_CURRENT_STATE: CONFIDENCE_BANDS.LIMITED,
  CONFLICTING_STATE: CONFIDENCE_BANDS.LIMITED,
  // D-074. The best establishing row is CLAIMED, so the finding rests on
  // a claim rather than confirmed authority. It caps at STRONG rather
  // than lower because a chain read is deterministic and its binding is
  // CONFIRMED — what it lacks is officiality, not reliability. Capping
  // lower would conflate weak authority with missing structure; not
  // capping would let ONCHAIN_VERIFIABLE / CLAIMED silently receive the
  // same treatment as OFFICIAL_DOCS / CONFIRMED, which D-074 forbids.
  INSUFFICIENT_AUTHORITY: CONFIDENCE_BANDS.STRONG,
  TOKEN_STATE_UNQUALIFIED: CONFIDENCE_BANDS.STRONG,
  INDIRECT_ONLY: CONFIDENCE_BANDS.STRONG,
  STATE_NOT_FULLY_LIVE: CONFIDENCE_BANDS.STRONG,
  STALE_CURRENT_STATE: CONFIDENCE_BANDS.STRONG,
};

// Why a band ended where it did. Closed vocabulary: every member is
// either a ResultReasonCode or one of the three structural caps below.
export const CONFIDENCE_BINDING_REASONS = [
  "VERDICT_CEILING",
  "REQUIRED_BLOCKING_GAP",
  "CLAIM_CONTEXT_GAP",
  "COMPONENT_CONTRADICTED",
  "UNKNOWN_REASON_CODE",
] as const;
export type ConfidenceBindingReason =
  | (typeof CONFIDENCE_BINDING_REASONS)[number]
  | ResultReasonCode;

export interface ConfidenceInput {
  verdict: ConfidenceVerdict;
  // True when any REQUIRED requirement carries at least one blocking gap.
  hasRequiredBlockingGap: boolean;
  // True when the claim recorded any context gap.
  hasClaimContextGap: boolean;
  // EVERY component result persisted for this job — not only the ones the
  // claim cites. A limitation recorded anywhere in the job's reconciled
  // state is a real limitation on the Proof, and taking all of them is
  // the conservative direction (more caps, never fewer). It is also what
  // guarantees a bare-absence job is caught: a component that found
  // nothing may be cited by no requirement at all.
  componentResults: { status: ComponentReconciliationStatus; reasonCodes: string[] }[];
}

export interface ConfidenceResult {
  band: ConfidenceBand;
  score: ConfidenceScore;
  // Every cap that actually bound the result, deduped and sorted. Empty
  // only when the verdict ceiling alone decided it (then VERDICT_CEILING
  // is the single entry).
  bindingReasons: ConfidenceBindingReason[];
}

function isResultReasonCode(v: string): v is ResultReasonCode {
  return Object.prototype.hasOwnProperty.call(REASON_CODE_CAP, v);
}

// THE FUNCTION. Pure: no IO, no clock, no randomness. Same input, same
// result. `final = min(ceiling, every applicable cap)` — precedence only,
// never weighting, never counting citations, never source popularity.
export function computeProofConfidence(input: ConfidenceInput): ConfidenceResult {
  const ceiling = VERDICT_CEILING[input.verdict];
  let score: ConfidenceScore = ceiling;
  const binding = new Map<ConfidenceBindingReason, ConfidenceScore>();

  function applyCap(reason: ConfidenceBindingReason, cap: ConfidenceScore): void {
    if (cap < score) score = cap;
    binding.set(reason, cap);
  }

  if (input.hasRequiredBlockingGap) applyCap("REQUIRED_BLOCKING_GAP", CONFIDENCE_BANDS.LIMITED);
  if (input.hasClaimContextGap) applyCap("CLAIM_CONTEXT_GAP", CONFIDENCE_BANDS.STRONG);

  for (const row of input.componentResults) {
    // A component that reconciled to CONTRADICTED means the evidence
    // disagrees with itself. Where the claim verdict is NOT_SUPPORTED the
    // contradiction IS the finding and must not be penalised; anywhere
    // else it is unresolved conflict.
    if (row.status === "CONTRADICTED" && input.verdict !== "NOT_SUPPORTED") {
      applyCap("COMPONENT_CONTRADICTED", CONFIDENCE_BANDS.LIMITED);
    }
    for (const raw of row.reasonCodes) {
      if (!isResultReasonCode(raw)) {
        // FAIL CLOSED. A reason code this table does not know cannot be
        // assumed harmless: an unrecognised limitation drops the result to
        // the lowest band rather than silently leaving it STRONG or
        // VERY_STRONG. The compile-time Record makes this unreachable for
        // in-vocabulary codes; this guards persisted rows written by an
        // older or newer schema.
        applyCap("UNKNOWN_REASON_CODE", CONFIDENCE_BANDS.LOW);
        continue;
      }
      const cap = REASON_CODE_CAP[raw];
      if (cap !== null) applyCap(raw, cap);
    }
  }

  // Only the caps that actually bound the final score are reported —
  // a cap of 60 on a result that landed at 40 explains nothing.
  const bindingReasons = [...binding.entries()]
    .filter(([, cap]) => cap === score)
    .map(([reason]) => reason)
    .sort();
  if (bindingReasons.length === 0) bindingReasons.push("VERDICT_CEILING");

  return { band: bandOfScore(score), score, bindingReasons };
}
