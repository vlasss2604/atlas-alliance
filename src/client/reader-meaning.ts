// READER MEANING — WHAT A PERSON TAKES AWAY, DERIVED FROM WHAT ATLAS PROVED.
//
// ATLAS's canonical state is precise and plural: a status, an ordered list of
// reason codes, two evidence sets, a confidence band. Each of those exists
// because a research decision needed it. None of them was designed to be the
// first thing a person reads, and together they make a reader do the joining
// up that this product exists to have already done.
//
// This module does that joining once, deterministically. It reads ONLY
// already-canonical state and it decides nothing:
//
//   * no verdict is recomputed, no status is changed, no reason code is
//     dropped, added or reordered;
//   * no Evidence id is invented, inferred or moved between the supporting
//     and contradicting sets;
//   * no model is called, nothing is fetched, no database is touched,
//     no clock is read.
//
// SIMPLIFY THE EXPLANATION, NOT THE EVIDENCE. A ReaderMeaning is a sentence
// about a component result, sitting ABOVE that result. It never replaces it:
// `SUPPORTED` / `PARTIALLY_SUPPORTED` / `CONTRADICTED` /
// `INSUFFICIENT_EVIDENCE`, the reason codes and the confidence band all stay
// exactly where they are and stay authoritative for the audit.
//
// WHY IT IS NOT `rungState`. The existing status -> RealityState mapping in
// research-model.ts reads the STATUS ALONE, which is correct for a badge: a
// badge says how firmly a finding is held. It cannot say WHAT was found, so
// a component where ATLAS measured a real supply decrease and a component
// where ATLAS could not measure anything both arrive as "Partly established".
// That difference is the whole value of the measurement, and this module is
// where it becomes visible. The badge is unchanged; this sits above it.

// The closed reader vocabulary. FIVE states, and each one exists because
// collapsing it into another would either overclaim or underclaim — see
// READER_STATE_LABELS below for what each says in the reader's own words.
export type ReaderState =
  // The proposition is established by admitted evidence, with no standing
  // limitation. Canonically: SUPPORTED, which is reached only when the
  // reason-code list is empty.
  | "ESTABLISHED"
  // Established, and something qualifies it — the authority of the sources,
  // their directness, a state that is being implemented rather than run.
  // The qualification does not point the other way; it bounds how far the
  // finding reaches. Collapsing this into ESTABLISHED would drop the bound;
  // collapsing it into NOT_ESTABLISHED would delete a real finding.
  | "ESTABLISHED_WITH_LIMITS"
  // ATLAS MEASURED a real outcome and has NOT established that the
  // researched mechanism produced it. The measurement is a fact; the
  // attribution is not, and nothing here may quietly supply it.
  | "MEASURED_NOT_ATTRIBUTED"
  // A deterministic measurement conflicts with the specific proposition
  // being tested — and with nothing else. It does not say a project lied,
  // that any event was faked, or that any other claim about the project is
  // false. Only the measured proposition is contradicted.
  | "CONTRADICTED_BY_MEASUREMENT"
  // Not enough admissible evidence to establish the proposition. This
  // covers a silent record, evidence that could not meet the standard the
  // claim requires, and sources that disagree with each other — three
  // different reasons for one reader meaning, kept apart in `detail`.
  // ABSENCE IS NOT CONTRADICTION and this state is never the negative.
  | "NOT_ESTABLISHED";

// The state in the reader's own words. Deliberately the same register as
// RESULT_STATE_LABELS, so a screen that shows both never appears to be
// grading a finding twice on different scales.
export const READER_STATE_LABELS: Record<ReaderState, string> = {
  ESTABLISHED: "Established",
  ESTABLISHED_WITH_LIMITS: "Established, with limits",
  MEASURED_NOT_ATTRIBUTED: "Measured, not attributed",
  CONTRADICTED_BY_MEASUREMENT: "Contradicted by measurement",
  NOT_ESTABLISHED: "Not established",
};

export interface ReaderMeaning {
  state: ReaderState;
  // One idea, plain language, always a full sentence. Derived from a closed
  // table — never generated, never a truncation of anything.
  headline: string;
  // At most one clarifying sentence, supplied by the caller from the
  // canonical reason-code copy it already renders. Null where there is
  // nothing to add, or where the supplied text failed the leak guard.
  detail: string | null;
  // CANONICAL, VERBATIM, AND STILL ON THEIR OWN SIDES. Copied from the
  // component result and never merged into one list: which side an Evidence
  // id is on is exactly the difference between "a burn was observed" and
  // "the burn is disputed", and a flat list would destroy it.
  supportingEvidenceIds: readonly string[];
  contradictingEvidenceIds: readonly string[];
  // The research cutoff this reading speaks for, passed through from the
  // Proof. Null when the caller has none — never substituted with a clock.
  asOf: string | null;
}

export interface ReaderMeaningInput {
  // Canonical component status, or null where no result exists.
  status: string | null;
  // Canonical reason codes IN S5's ORDER. Read, never reordered: S5 writes
  // the component-specific code first and this module depends on that in
  // exactly the way `reasonExplanation` already does.
  reasonCodes?: readonly unknown[] | null;
  supportingEvidenceIds?: readonly string[] | null;
  contradictingEvidenceIds?: readonly string[] | null;
  // What this component means in ordinary words, as the object of a
  // sentence ("where the value ends up"). Supplied by the caller, which
  // already owns that vocabulary. Null yields a subject-free headline
  // rather than a component name — an internal name must never surface.
  subject?: string | null;
  // The canonical reason-code sentence the caller already derives. Passed
  // IN rather than duplicated here, so there is exactly one home for that
  // copy and this module cannot drift from it.
  detail?: string | null;
  asOf?: string | null;
}

// A reason code that says the component's OWN proposition was not
// established, even though something else about it was. On NET_EFFECT a burn
// can be established while the net supply change is not: the component is
// canonically PARTIALLY_SUPPORTED, and the reader's answer to "did supply
// fall?" is still no answer. Closed, and extended only with the reason code
// it belongs to.
const NEGATES_THE_PROPOSITION: ReadonlySet<string> = new Set([
  // No typed gross reduction among the establishing evidence at all.
  "SUPPLY_REDUCTION_NOT_ESTABLISHED",
  // A burn is established; no interval was measured around it.
  "NET_SUPPLY_CHANGE_NOT_ESTABLISHED",
  // Two measured intervals disagree, so neither was used. Nothing is
  // averaged and nothing is chosen — so nothing is established.
  "CONFLICTING_SUPPLY_DELTA",
]);

// THE ONE MEASURED-BUT-UNATTRIBUTED CODE, and the one measurement-borne
// contradiction. Both are named individually rather than pattern-matched on
// the string, so a future reason code cannot fall into either by accident.
const MEASURED_NOT_ATTRIBUTED_CODE = "NET_SUPPLY_CHANGE_NOT_ATTRIBUTED";
const CONTRADICTED_BY_MEASUREMENT_CODE = "NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL";

// HEADLINE PER REASON CODE, where the code says something a generic sentence
// about the component cannot.
//
// Every sentence below states what was OBSERVED and stops there. None says a
// mechanism caused anything, none says a project claimed or concealed
// anything, and none uses the word "deflationary" — a measured decrease over
// one interval is not a property of a token.
//
// CASE C AND CASE D SHARE ONE SENTENCE, deliberately. The canonical component
// row carries the fact that supply did NOT decrease; it does not carry
// whether supply was unchanged or higher, because the reconciler files both
// as the same contradiction. Saying "increased" would be inventing the half
// of the measurement that did not reach here, so the honest form — "did not
// decrease" — is the one that covers both.
//
// EACH SENTENCE OPENS WITH WHAT WAS ESTABLISHED. "Burn was confirmed, but …"
// tells a reader the positive fact before the limitation on it; the same
// sentence written limitation-first reads as a verdict against the project
// when it is nothing of the kind. The clause order is the whole difference
// and it costs no accuracy: both halves are the same two observations.
const HEADLINE_BY_REASON_CODE: Record<string, string> = {
  SUPPLY_REDUCTION_NOT_ESTABLISHED:
    "Nothing checked here shows tokens being destroyed.",
  NET_SUPPLY_CHANGE_NOT_ESTABLISHED:
    "Burn was confirmed, but the net change in total supply was not established.",
  NET_SUPPLY_CHANGE_NOT_ATTRIBUTED:
    "Burn was confirmed and total supply decreased over the measured period, but the decrease is not attributed to this mechanism.",
  NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL:
    "Burn was confirmed, but total supply did not decrease over the measured period.",
  CONFLICTING_SUPPLY_DELTA:
    "The supply measurements recorded for this period disagree, so neither was used.",
};

// A code whose headline needs the component's own subject to read as a
// sentence. Kept apart from the table above because the sentence is built,
// not looked up — and it is built from a closed template either way.
const SOURCES_DISAGREE_CODE = "CONFLICTING_STATE";

// Anything shaped like an internal identifier. A reader-facing sentence that
// contains one is dropped rather than cleaned: a copy gap is recoverable, a
// leak of engine vocabulary onto a product surface is what this guard exists
// to make impossible.
const INTERNAL_IDENTIFIER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

// The FIRST recognised code wins — the identical rule `reasonExplanation`
// applies, for the identical reason: S5 writes the component-specific code
// first, so first-recognised is deterministic without a ranking of its own.
function leadingCode(codes: readonly unknown[] | null | undefined): string | null {
  for (const code of codes ?? []) {
    if (typeof code !== "string") continue;
    if (
      HEADLINE_BY_REASON_CODE[code] ||
      code === SOURCES_DISAGREE_CODE ||
      code === MEASURED_NOT_ATTRIBUTED_CODE ||
      code === CONTRADICTED_BY_MEASUREMENT_CODE ||
      NEGATES_THE_PROPOSITION.has(code)
    ) {
      return code;
    }
  }
  // An unrecognised code is not an error and is not guessed at. The state
  // falls back to what the STATUS alone supports, which is always true even
  // when it is less specific.
  return null;
}

function stateOf(status: string | null, code: string | null): ReaderState {
  switch (status) {
    case "SUPPORTED":
      // Canonically unreachable with a reason code: an empty list is what
      // reaches SUPPORTED. Read from the status regardless, so this file
      // never depends on an invariant it does not itself enforce.
      return "ESTABLISHED";
    case "CONTRADICTED":
      // ONLY a measurement-borne contradiction becomes a contradiction here.
      // CONFLICTING_STATE is canonically CONTRADICTED too, and it means the
      // sources disagree with EACH OTHER — which settles nothing and is
      // therefore reported as not established, with the disagreement stated
      // in the headline. Calling a disagreement "contradicted by
      // measurement" would assert a negative nobody measured.
      return code === CONTRADICTED_BY_MEASUREMENT_CODE
        ? "CONTRADICTED_BY_MEASUREMENT"
        : "NOT_ESTABLISHED";
    case "PARTIALLY_SUPPORTED":
      if (code === MEASURED_NOT_ATTRIBUTED_CODE) return "MEASURED_NOT_ATTRIBUTED";
      // A code that negates the component's own proposition reports as not
      // established even though the status is partial: something WAS
      // established, and it was not the thing the component asks about.
      if (code !== null && NEGATES_THE_PROPOSITION.has(code)) return "NOT_ESTABLISHED";
      // Every other partial row — authority, directness, a state still being
      // implemented, an unqualified token state, and any code this file does
      // not recognise — is a real finding with a bound on it.
      return "ESTABLISHED_WITH_LIMITS";
    case "INSUFFICIENT_EVIDENCE":
      return "NOT_ESTABLISHED";
    default:
      // No result, or a status this file does not know. Fail closed on the
      // weakest reading rather than guessing a stronger one.
      return "NOT_ESTABLISHED";
  }
}

function headlineOf(state: ReaderState, code: string | null, subject: string | null): string {
  if (code !== null) {
    const fromCode = HEADLINE_BY_REASON_CODE[code];
    if (fromCode) return fromCode;
    if (code === SOURCES_DISAGREE_CODE) {
      return subject === null
        ? "The sources disagree about this, so nothing here settles it."
        : `The sources disagree about ${subject}.`;
    }
  }
  switch (state) {
    case "ESTABLISHED":
      return subject === null
        ? "The checked evidence establishes this."
        : `The checked evidence establishes ${subject}.`;
    case "ESTABLISHED_WITH_LIMITS":
      return subject === null
        ? "The checked evidence partly establishes this."
        : `The checked evidence partly establishes ${subject}.`;
    case "MEASURED_NOT_ATTRIBUTED":
      return subject === null
        ? "A change was measured, but nothing checked attributes it to this mechanism."
        : `A change was measured, but nothing checked attributes it to ${subject}.`;
    case "CONTRADICTED_BY_MEASUREMENT":
      return subject === null
        ? "A measurement points the other way."
        : `On ${subject}, the measurement points the other way.`;
    case "NOT_ESTABLISHED":
      return subject === null
        ? "This was not established."
        : `${capitalise(subject)} was not established.`;
  }
}

// THE PROJECTION. Pure, total, and dependent on nothing but its argument:
// the same input always yields the same output, and no input can make it
// read a clock, a network or a database.
export function deriveReaderMeaning(input: ReaderMeaningInput): ReaderMeaning {
  const code = leadingCode(input.reasonCodes);
  const state = stateOf(input.status ?? null, code);
  const subject = input.subject ?? null;

  const detail = input.detail ?? null;
  return {
    state,
    headline: headlineOf(state, code, subject),
    // A supplied sentence carrying engine vocabulary is DROPPED, not
    // rewritten. Nothing here can guess what a leaking sentence meant to say.
    detail: detail !== null && !INTERNAL_IDENTIFIER.test(detail) ? detail : null,
    supportingEvidenceIds: [...(input.supportingEvidenceIds ?? [])],
    contradictingEvidenceIds: [...(input.contradictingEvidenceIds ?? [])],
    asOf: input.asOf ?? null,
  };
}

// WHAT A READER MEANING DOES NOT SAY. Stated beside the rules, in the same
// discipline as ONCHAIN_DOES_NOT_PROVE and NET_SUPPLY_EFFECT_DOES_NOT_PROVE,
// so a future consumer meets the boundary before it reaches for the state.
export const READER_MEANING_DOES_NOT_PROVE = [
  "a reader state is NOT a verdict and never replaces the canonical status",
  "CONTRADICTED_BY_MEASUREMENT contradicts one measured proposition and nothing else — not the event that was observed, and not the project",
  "MEASURED_NOT_ATTRIBUTED does NOT establish that any mechanism produced the measured change",
  "NOT_ESTABLISHED is the absence of an established answer, never evidence that the thing is absent",
  "no reader state carries or implies confidence, which stays exactly where it is persisted",
] as const;
