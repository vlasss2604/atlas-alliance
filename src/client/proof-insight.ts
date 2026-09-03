import { deriveReaderMeaning, type ReaderState } from "./reader-meaning";

// DETERMINISTIC PROOF INSIGHT v1 — ONE THING THE ANSWER DOES NOT SAY.
//
// The Result already tells a reader what was established, what was measured
// and what remains open. An Insight is not a summary of any of that. It
// exists for exactly one job:
//
//   is there ONE important thing in the verified research that a reader
//   could easily miss from the direct Answer?
//
// NONE IS THE NORMAL OUTCOME AND A SUCCESSFUL ONE. Nothing here fires
// because a field exists, and nothing scores, ranks or categorises. There
// is a closed priority, two rules, and silence everywhere else.
//
// AN INSIGHT IS NOT Evidence, not a Fact, not a Verdict, not confidence,
// not new research, not a risk score and not advice. It is a read-only
// projection over completed canonical state: this module writes nothing,
// persists nothing, and has no way to reach a database, a provider or a
// model. Its whole input is its argument.
//
// WHY IT DOES NOT RESTATE THE MEASUREMENT. The direct Answer now leads with
// the reader layer's own headline for exactly the two states this module
// selects on, so an Insight repeating that sentence would put the same words
// twice on one screen and add nothing. Each template below therefore says
// the SECOND thing — what the measurement does and does not reach — which is
// the misreading each state actually invites. A candidate whose text has
// already been said is dropped (see the duplication guard).

// Which rule produced the Insight. Carried for tests, the audit and future
// analysis; NEVER rendered, because a reader has no use for the name of a
// rule.
export type InsightRelation = "MEASURED_CONTRADICTION" | "MEASURED_WITHOUT_ATTRIBUTION";

export type ProofInsight =
  | {
      type: "INSIGHT";
      text: string;
      relation: InsightRelation;
      // The component whose canonical result this Insight reads. Carried for
      // keys and tests, never rendered as a label.
      component: string;
      // CANONICAL, VERBATIM, AND STILL ON THEIR OWN SIDES — the same
      // discipline ReaderMeaning keeps. Flattening them would erase the
      // difference between the event that was observed and the measurement
      // that bounds it, which is the entire content of the first rule.
      supportingEvidenceIds: readonly string[];
      contradictingEvidenceIds: readonly string[];
    }
  | { type: "NONE" };

export interface InsightComponentInput {
  component: string;
  status: string;
  reasonCodes?: readonly unknown[] | null;
  supportingEvidenceIds?: readonly string[] | null;
  contradictingEvidenceIds?: readonly string[] | null;
}

export interface ProofInsightInput {
  components: readonly InsightComponentInput[];
  // The sentences the direct Answer is already showing. Used ONLY by the
  // duplication guard, by exact match after whitespace normalisation — there
  // is no similarity scoring here and no model comparing meanings.
  answerSentences?: readonly string[] | null;
}

// THE CLOSED PRIORITY. Two rules, in order, then silence. A lower-priority
// candidate never displaces a higher one, and two candidates never both
// render: this returns at most one Insight, always.
//
// Deliberately NOT implemented in v1: "an established mechanism with a
// material limit further along". The Pattern's mechanism group is sequential
// but its value group explicitly is not a continuation of it, so "a later
// material step" has no single deterministic meaning across the two — it
// would need per-component ordering rules, which is the broad rule engine
// this is meant to avoid. It stays out until the Pattern says what "later"
// means, rather than this file guessing.
const PRIORITY: readonly ReaderState[] = [
  "CONTRADICTED_BY_MEASUREMENT",
  "MEASURED_NOT_ATTRIBUTED",
];

const RELATION_BY_STATE: Record<string, InsightRelation> = {
  CONTRADICTED_BY_MEASUREMENT: "MEASURED_CONTRADICTION",
  MEASURED_NOT_ATTRIBUTED: "MEASURED_WITHOUT_ATTRIBUTION",
};

// THE TWO SENTENCES, KEYED BY THE REASON CODE THAT EARNED THEM.
//
// Keyed the same way the reader headlines are, and for the same reason: a
// reason code is what a research decision actually produced, so a code with
// no Insight text simply yields no Insight. That is the fail-closed
// direction — a new engine reason can never inherit a sentence written for a
// different finding.
//
// Each states what is NOT reached, which is the misreading its state
// invites: a contradiction read as doubt about the event, and a measured
// decrease read as proof of cause. Neither accuses anyone of anything and
// neither asserts a cause.
const INSIGHT_BY_REASON_CODE: Record<string, string> = {
  NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL:
    "What the measurement contradicts is the reduction in total supply — the burn ATLAS observed is established and is not in question.",
  NET_SUPPLY_CHANGE_NOT_ATTRIBUTED:
    "A measured decrease covers everything that changed total supply in that period, so on its own it does not show that this mechanism is what reduced it.",
};

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

// Compares a candidate against what the Answer already says, by exact match
// after whitespace normalisation. Deliberately NOT similarity: a fuzzy
// comparison would silently drop real Insights, and a model comparing
// meanings is the thing this whole module is built to do without.
function alreadySaid(text: string, answerSentences: readonly string[]): boolean {
  const target = normalise(text);
  return answerSentences.some((s) => typeof s === "string" && normalise(s) === target);
}

const NONE: ProofInsight = { type: "NONE" };

export function deriveProofInsight(input: ProofInsightInput): ProofInsight {
  // FAILURE IS SILENCE, NEVER A BROKEN RESULT. A malformed row, a missing
  // field, anything at all that throws here produces NONE — the Proof, the
  // verdict and every finding on the screen are already rendered from state
  // this function cannot touch.
  try {
    const answerSentences = (input.answerSentences ?? []).filter(
      (s): s is string => typeof s === "string",
    );

    const candidates: {
      rank: number;
      component: string;
      text: string;
      relation: InsightRelation;
      supportingEvidenceIds: readonly string[];
      contradictingEvidenceIds: readonly string[];
    }[] = [];

    for (const row of input.components ?? []) {
      if (!row || typeof row.component !== "string") continue;
      const meaning = deriveReaderMeaning({
        status: row.status ?? null,
        reasonCodes: row.reasonCodes,
        supportingEvidenceIds: row.supportingEvidenceIds,
        contradictingEvidenceIds: row.contradictingEvidenceIds,
      });
      const rank = PRIORITY.indexOf(meaning.state);
      if (rank === -1) continue;

      // The text comes from the code, not from the state, so a state reached
      // by some future reason code yields nothing rather than a sentence
      // written about a different finding.
      const code = (row.reasonCodes ?? []).find(
        (c): c is string => typeof c === "string" && INSIGHT_BY_REASON_CODE[c] !== undefined,
      );
      if (!code) continue;

      candidates.push({
        rank,
        component: row.component,
        text: INSIGHT_BY_REASON_CODE[code],
        relation: RELATION_BY_STATE[meaning.state],
        // Canonical, copied verbatim from the component result. Excluded
        // evidence is not read at all — there is no field for it on this
        // module's input, so a refused row has no path here.
        supportingEvidenceIds: meaning.supportingEvidenceIds,
        contradictingEvidenceIds: meaning.contradictingEvidenceIds,
      });
    }

    if (candidates.length === 0) return NONE;

    // ORDER IN, ORDER OUT — but never the caller's order. Rank first, then
    // component name, so the same set of rows yields the same Insight
    // however the rows arrived.
    candidates.sort((a, b) => a.rank - b.rank || a.component.localeCompare(b.component));

    for (const candidate of candidates) {
      // AN INSIGHT MUST ADD A SECOND MEANING. One the reader has already
      // read is not one, and the right outcome is silence rather than a
      // second block saying it again.
      if (alreadySaid(candidate.text, answerSentences)) continue;
      return {
        type: "INSIGHT",
        text: candidate.text,
        relation: candidate.relation,
        component: candidate.component,
        supportingEvidenceIds: candidate.supportingEvidenceIds,
        contradictingEvidenceIds: candidate.contradictingEvidenceIds,
      };
    }
    return NONE;
  } catch {
    return NONE;
  }
}

// WHAT AN INSIGHT DOES NOT ESTABLISH. The same discipline as
// ONCHAIN_DOES_NOT_PROVE and READER_MEANING_DOES_NOT_PROVE: the boundary is
// stated beside the rule, where a future consumer meets it first.
export const PROOF_INSIGHT_DOES_NOT_PROVE = [
  "an Insight is NOT a verdict, a fact, evidence, confidence or a risk assessment",
  "an Insight never establishes a cause, and never states that a mechanism produced a measured change",
  "an Insight about a contradiction says nothing about anyone's honesty or intent",
  "the absence of an Insight means no second meaning was found, never that nothing is wrong",
  "nothing here is advice, and no Insight may be read as one",
] as const;

// THE SEAM, LEFT OPEN AND DELIBERATELY EMPTY.
//
// A later design may become: deterministic candidate → if NONE, a bounded
// check over already-verified context → Insight or NONE. That fallback is
// NOT built here, on purpose: v1 exists to show what deterministic selection
// alone provides before anything less predictable is added to the surface.
// When it is built, it belongs after `deriveProofInsight` returns NONE and
// nowhere else — this function stays the first and cheapest answer, and it
// stays model-free.
