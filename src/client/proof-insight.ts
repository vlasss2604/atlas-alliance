import { deriveReaderMeaning, type ReaderMeaning, type ReaderState } from "./reader-meaning";

// DETERMINISTIC PROOF INSIGHT — ONE THING THE ANSWER DOES NOT SAY.
//
// The Result already tells a reader what was established, what was measured
// and what remains open. An Insight is not a summary of any of that. It
// exists for exactly one job:
//
//   is there ONE verified RELATIONSHIP in this research that materially
//   changes how the project is understood, beyond the direct answer?
//
// RELATIONSHIP is the load-bearing word. A single component restated in
// other words is not an Insight however true it is — the Answer already
// said it, and the reader gains nothing for the second read. What they can
// miss is the JOIN: something documented whose execution was never seen,
// value that moves to a place that is not removal, a gross event whose net
// outcome is weaker or absent.
//
// NONE IS THE NORMAL OUTCOME AND A SUCCESSFUL ONE. Nothing here fires
// because a field exists, and nothing scores, ranks or categorises. There
// is a closed priority, five rules, and silence everywhere else.
//
// AN INSIGHT IS NOT Evidence, not a Fact, not a Verdict, not confidence,
// not new research, not a risk score and not advice. It is a read-only
// projection over completed canonical state: this module writes nothing,
// persists nothing, and has no way to reach a database, a provider or a
// model. Its whole input is its argument.
//
// THE THREE LENSES are how candidates are found, not what a reader is
// shown. No lens name reaches a screen, and there are no Insight
// categories, badges or counts anywhere in the product.

export type InsightLens =
  // Something is documented or approved, and the corresponding execution is
  // not established.
  | "STATED_VS_OBSERVED"
  // Value flow is established, and where it ultimately lands changes the
  // reading.
  | "VALUE_DESTINATION"
  // A gross positive-looking event exists, and the measured net outcome is
  // weaker, absent or opposite.
  | "GROSS_VS_NET_EFFECT";

// Which rule produced the Insight. Carried for tests and later review;
// NEVER rendered, because a reader has no use for the name of a rule.
export type InsightRelation =
  | "MEASURED_CONTRADICTION"
  | "EXECUTION_GAP"
  | "DESTINATION_HELD"
  | "HOLDER_VALUE_NOT_ESTABLISHED"
  | "MEASURED_WITHOUT_ATTRIBUTION";

export type ProofInsight =
  | {
      type: "INSIGHT";
      text: string;
      relation: InsightRelation;
      lens: InsightLens;
      // Every component whose canonical STATE this relationship rests on —
      // which is what makes it a relationship rather than a restatement.
      // Carried for tests and review, never rendered as a label.
      components: readonly string[];
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
  // S6 mechanism assembly, exactly as the result contract carries it. ONE
  // structured attribute is read from it — the destination kind of the
  // CURRENT flow — and nothing else: no lineage, no gaps, no node text, and
  // never a fragment. Optional, because a run without an assembly must
  // still be able to produce the other four rules.
  flows?: readonly unknown[] | null;
  // The sentences the direct Answer is already showing. Used ONLY by the
  // duplication guards, by exact match after whitespace normalisation —
  // there is no similarity scoring here and no model comparing meanings.
  answerSentences?: readonly string[] | null;
}

/* ------------------------------------------------------------------ *
 * CANONICAL STATE, READ THROUGH THE ONE INTERPRETATION THAT EXISTS
 * ------------------------------------------------------------------ */

interface Row {
  component: string;
  meaning: ReaderMeaning;
  // The canonical reason codes, carried alongside the reader meaning rather
  // than added to it: the reader layer's contract is unchanged by this
  // module, and a code is what a research decision actually produced.
  reasonCodes: readonly string[];
}

// UNQUALIFIED, DELIBERATELY. Every sentence this module can produce asserts
// the established half plainly — "Governance approved", "Execution is
// confirmed", "observed executing" — so a component carrying a standing
// limitation must not satisfy it. A diagnostic run surfaced exactly this:
// an EXECUTION_EVIDENCE row that was PARTIALLY_SUPPORTED because its only
// source could not settle the claim still produced "Execution is confirmed",
// which is a stronger statement than the research made.
//
// ESTABLISHED_WITH_LIMITS is therefore NOT established for this purpose. The
// alternative — a second, hedged sentence per rule — would double the copy
// table to say something a reader cannot act on, and hedged copy beside a
// Proof is worse than silence.
const ESTABLISHED_STATES: ReadonlySet<ReaderState> = new Set<ReaderState>(["ESTABLISHED"]);

// "Not established" is read ONLY from a row that exists. A component with no
// persisted result was never assessed, and saying its execution "is not
// established" would report a gap this research did not find — the same
// distinction the ladder makes by hiding unassessed rows rather than dimming
// them.
const isEstablished = (r: Row | undefined): boolean =>
  r !== undefined && ESTABLISHED_STATES.has(r.meaning.state);
const isNotEstablished = (r: Row | undefined): boolean =>
  r !== undefined && r.meaning.state === "NOT_ESTABLISHED";

/* ------------------------------------------------------------------ *
 * THE ONE ATTRIBUTE READ FROM S6
 * ------------------------------------------------------------------ */

// Where an established value flow lands, as S6 already classified it. This
// is persisted canonical state, not a judgement made here: the
// classification happened once, during assembly, over already-admitted
// DESTINATION evidence.
//
// FAILS CLOSED THREE WAYS: a flow that is not CURRENT is ignored (a
// historical arrangement must never drive a statement about now), UNKNOWN is
// ignored, and two CURRENT flows that disagree yield null rather than a
// chosen answer. Anything malformed is skipped without throwing.
function currentDestinationKind(flows: readonly unknown[] | null | undefined): string | null {
  let found: string | null = null;
  for (const raw of flows ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const flow = raw as { lifecycle?: unknown; attributes?: { destinationKind?: unknown } };
    if (flow.lifecycle !== "CURRENT") continue;
    const kind = flow.attributes?.destinationKind;
    if (typeof kind !== "string" || kind === "UNKNOWN") continue;
    // Two current flows pointing at different destinations is a record that
    // does not have one answer. Nothing here picks the more interesting one.
    if (found !== null && found !== kind) return null;
    found = kind;
  }
  return found;
}

// The destinations that mean HELD RATHER THAN REMOVED. Both are canonical S6
// values; neither says anything about intent, and neither is a criticism.
const HELD_DESTINATIONS: Record<string, string> = {
  TREASURY:
    "Execution is confirmed, and the established destination is the treasury — permanent removal from supply is not established.",
  BUYBACK_HOLD:
    "Execution is confirmed, and the purchased tokens are recorded as held rather than removed — permanent removal from supply is not established.",
};

/* ------------------------------------------------------------------ *
 * THE CANDIDATES
 * ------------------------------------------------------------------ */

interface Candidate {
  rank: number;
  relation: InsightRelation;
  lens: InsightLens;
  text: string;
  // Every component this relationship rests on. Size >= 2 is what the
  // materiality gate reads.
  components: string[];
  supportingEvidenceIds: readonly string[];
  contradictingEvidenceIds: readonly string[];
  // The two B2 rules predate the materiality gate and are stronger than it:
  // see MATERIALITY below. Set only where that exception is deliberate.
  gateException?: true;
}

// THE TWO SUPPLY SENTENCES, KEYED BY THE REASON CODE THAT EARNED THEM.
//
// Keyed the same way the reader headlines are, and for the same reason: a
// reason code is what a research decision actually produced, so a code with
// no Insight text simply yields no Insight. That is the fail-closed
// direction — a new engine reason can never inherit a sentence written for a
// different finding.
const SUPPLY_INSIGHT_BY_REASON_CODE: Record<string, string> = {
  NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL:
    "What the measurement contradicts is the reduction in total supply — the burn ATLAS observed is established and is not in question.",
  NET_SUPPLY_CHANGE_NOT_ATTRIBUTED:
    "A measured decrease covers everything that changed total supply in that period, so on its own it does not show that this mechanism is what reduced it.",
};

const reasonCodeIn = (row: Row, table: Record<string, string>): string | null => {
  for (const code of row.reasonCodes) {
    if (table[code] !== undefined) return code;
  }
  return null;
};

/* ------------------------------------------------------------------ *
 * MATERIALITY
 * ------------------------------------------------------------------ */

// AN INSIGHT MUST JOIN SOMETHING. A candidate qualifies only if it rests on
// the canonical state of at least TWO components, or on ONE component that
// carries canonical evidence on BOTH sides. A single-component,
// single-sided restatement is exactly the trivia this gate exists to
// refuse, and it returns NONE.
//
// THE ONE DOCUMENTED EXCEPTION is the already-approved B2 measured-decrease
// rule. It rests on one component with all its evidence on the supporting
// side, so it fails both limbs — and it is the single most valuable thing
// this product can say, because a reader who sees "supply decreased" and
// stops has drawn a causal conclusion the research explicitly did not
// reach. The approved semantics are stronger than the gate, so the gate
// yields to them here rather than being weakened for everything else.
//
// GROUNDING IS NOT OPTIONAL either way: a candidate citing no canonical
// evidence at all is refused whatever else it satisfies.
function isMaterial(c: Candidate): boolean {
  if (c.supportingEvidenceIds.length + c.contradictingEvidenceIds.length === 0) return false;
  if (c.gateException) return true;
  if (new Set(c.components).size >= 2) return true;
  return c.supportingEvidenceIds.length > 0 && c.contradictingEvidenceIds.length > 0;
}

/* ------------------------------------------------------------------ *
 * DUPLICATION
 * ------------------------------------------------------------------ */

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

const NONE: ProofInsight = { type: "NONE" };

export function deriveProofInsight(input: ProofInsightInput): ProofInsight {
  // FAILURE IS SILENCE, NEVER A BROKEN RESULT. A malformed row, a missing
  // field, anything at all that throws here produces NONE — the Proof, the
  // verdict and every finding on the screen are already rendered from state
  // this function cannot touch.
  try {
    const answerSentences = (input.answerSentences ?? [])
      .filter((s): s is string => typeof s === "string")
      .map(normalise);

    // ---- canonical state, read once ---------------------------------
    const byComponent = new Map<string, Row>();
    for (const raw of input.components ?? []) {
      if (!raw || typeof raw.component !== "string") continue;
      byComponent.set(raw.component, {
        component: raw.component,
        reasonCodes: (raw.reasonCodes ?? []).filter((c): c is string => typeof c === "string"),
        meaning: deriveReaderMeaning({
          status: raw.status ?? null,
          reasonCodes: raw.reasonCodes,
          supportingEvidenceIds: raw.supportingEvidenceIds,
          contradictingEvidenceIds: raw.contradictingEvidenceIds,
        }),
      });
    }

    // WHICH COMPONENTS THE ANSWER HAS ALREADY SPOKEN FOR. Derived here
    // rather than plumbed in: a component whose reader headline is one of
    // the Answer's sentences is, by definition, the finding the reader has
    // just read. Exact match, never similarity.
    const spokenFor = new Set<string>();
    for (const row of byComponent.values()) {
      if (answerSentences.includes(normalise(row.meaning.headline))) spokenFor.add(row.component);
    }

    const spec = byComponent.get("MECHANISM_SPEC");
    const governance = byComponent.get("GOVERNANCE_BASIS");
    const execution = byComponent.get("EXECUTION_EVIDENCE");
    const destination = byComponent.get("DESTINATION");
    const recipient = byComponent.get("RECIPIENT");
    const netEffect = byComponent.get("NET_EFFECT");

    const candidates: Candidate[] = [];

    // ---- 1. GROSS VS NET: contradicted by deterministic measurement --
    //
    // Component-agnostic: the rule names no component, only the reason code
    // a measurement produced, so any component the engine ever files it
    // under is read identically.
    for (const row of byComponent.values()) {
      if (row.meaning.state !== "CONTRADICTED_BY_MEASUREMENT") continue;
      const code = reasonCodeIn(row, SUPPLY_INSIGHT_BY_REASON_CODE);
      if (!code) continue;
      candidates.push({
        rank: 1,
        relation: "MEASURED_CONTRADICTION",
        lens: "GROSS_VS_NET_EFFECT",
        text: SUPPLY_INSIGHT_BY_REASON_CODE[code],
        components: [row.component],
        supportingEvidenceIds: row.meaning.supportingEvidenceIds,
        contradictingEvidenceIds: row.meaning.contradictingEvidenceIds,
      });
    }

    // ---- 2. STATED VS OBSERVED: an execution gap ---------------------
    //
    // Something the project states or a governing body approved, with no
    // established execution of it. Governance leads where both exist: an
    // approved decision is a stronger stated basis than a description, so
    // the unexecuted gap is the more material one.
    if (isNotEstablished(execution)) {
      const stated = isEstablished(governance)
        ? {
            row: governance!,
            text: "Governance approved the mechanism, but ATLAS has not established that it is executing.",
          }
        : isEstablished(spec)
          ? {
              row: spec!,
              text: "The mechanism is documented, but ATLAS has not established that it is executing.",
            }
          : null;
      if (stated) {
        candidates.push({
          rank: 2,
          relation: "EXECUTION_GAP",
          lens: "STATED_VS_OBSERVED",
          text: stated.text,
          components: [stated.row.component, execution!.component],
          supportingEvidenceIds: stated.row.meaning.supportingEvidenceIds,
          contradictingEvidenceIds: [],
        });
      }
    }

    // ---- 3. VALUE DESTINATION: established, and held rather than removed
    //
    // Execution is real, S6 classified the current destination as a place
    // value is HELD, and no net reduction is established. A reader who has
    // just read that a buyback executes can very reasonably conclude that
    // supply fell; this is the one sentence that separates the two.
    const heldText = HELD_DESTINATIONS[currentDestinationKind(input.flows) ?? ""];
    if (heldText && isEstablished(execution) && isNotEstablished(netEffect)) {
      candidates.push({
        rank: 3,
        relation: "DESTINATION_HELD",
        lens: "VALUE_DESTINATION",
        text: heldText,
        components: [
          execution!.component,
          netEffect!.component,
          ...(destination ? [destination.component] : []),
        ],
        // The execution that was observed, plus the destination evidence
        // that says where it lands. Nothing from a component this
        // relationship does not rest on.
        supportingEvidenceIds: [
          ...execution!.meaning.supportingEvidenceIds,
          ...(destination?.meaning.supportingEvidenceIds ?? []),
        ],
        contradictingEvidenceIds: [],
      });
    }

    // ---- 4. VALUE DESTINATION: the value does not reach holders ------
    //
    // The mechanism runs, and who ultimately receives the value it moves was
    // checked and not established. Not a claim that nobody receives it.
    if (isEstablished(execution) && isNotEstablished(recipient)) {
      candidates.push({
        rank: 4,
        relation: "HOLDER_VALUE_NOT_ESTABLISHED",
        lens: "VALUE_DESTINATION",
        text: "The mechanism is observed executing, but ATLAS has not established that the value it moves reaches token holders.",
        components: [execution!.component, recipient!.component],
        supportingEvidenceIds: execution!.meaning.supportingEvidenceIds,
        contradictingEvidenceIds: [],
      });
    }

    // ---- 5. GROSS VS NET: measured, with no attribution --------------
    //
    // The documented gate exception. See MATERIALITY above.
    for (const row of byComponent.values()) {
      if (row.meaning.state !== "MEASURED_NOT_ATTRIBUTED") continue;
      const code = reasonCodeIn(row, SUPPLY_INSIGHT_BY_REASON_CODE);
      if (!code) continue;
      candidates.push({
        rank: 5,
        relation: "MEASURED_WITHOUT_ATTRIBUTION",
        lens: "GROSS_VS_NET_EFFECT",
        text: SUPPLY_INSIGHT_BY_REASON_CODE[code],
        components: [row.component],
        supportingEvidenceIds: row.meaning.supportingEvidenceIds,
        contradictingEvidenceIds: row.meaning.contradictingEvidenceIds,
        gateException: true,
      });
    }

    // ORDER IN, ORDER OUT — but never the caller's order. Rank first, then
    // component name, so the same set of rows yields the same Insight
    // however the rows arrived.
    candidates.sort(
      (a, b) => a.rank - b.rank || a.components[0].localeCompare(b.components[0]),
    );

    for (const candidate of candidates) {
      if (!isMaterial(candidate)) continue;

      // AN INSIGHT MUST ADD A SECOND MEANING. One the reader has already
      // read is not one, and the right outcome is silence rather than a
      // second block saying it again.
      if (answerSentences.includes(normalise(candidate.text))) continue;

      // Nor may it merely re-describe the single component the Answer led
      // with. A candidate resting only on that component adds a
      // relationship only when it holds canonical evidence on both sides —
      // the join is then INSIDE the component. The B2 exception stands as
      // documented above.
      const beyondTheAnswer =
        candidate.gateException ||
        candidate.components.some((c) => !spokenFor.has(c)) ||
        (candidate.supportingEvidenceIds.length > 0 &&
          candidate.contradictingEvidenceIds.length > 0);
      if (!beyondTheAnswer) continue;

      return {
        type: "INSIGHT",
        text: candidate.text,
        relation: candidate.relation,
        lens: candidate.lens,
        components: [...new Set(candidate.components)],
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
  "'not established' is the absence of an established answer, never evidence that the thing is absent",
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
