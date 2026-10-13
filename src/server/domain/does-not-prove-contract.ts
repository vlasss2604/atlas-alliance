// THE does_not_prove CONTRACT (Founder-approved).
//
// `evidence.does_not_prove` on a documentary row is written by the extractor
// model. Before this contract the field was a bare required string the
// prompt never described, so the model chose its form freely, and every
// surface read it under one fixed label ("Does not prove: …"). That label
// reads correctly only when the text NAMES A CLAIM. A free-standing sentence
// flipped: "The mechanism is not yet LIVE" read as "does not prove that the
// mechanism is not yet LIVE", and "X is not specified" read as "does not
// prove that X is not specified" — the opposite of what was meant.
//
// v1 asks for the claim itself, in its own polarity, in one of three forms:
//
//   that <claim>        "that the mechanism is currently LIVE"
//                       "that value does not reach token holders"
//   whether <claim>     "whether buybacks are actually executing"
//   a short noun phrase "net supply reduction"
//
// THIS MODULE NEVER EDITS THE TEXT. It answers one question — was this caveat
// written in a v1 form? — and the answer is the rule-version marker persisted
// beside it. A caveat that is not in a v1 form keeps its exact words and gets
// no marker, which makes it a legacy caveat: preserved as provenance, never
// shown as an authoritative boundary on a primary Result surface. Nothing
// here strips, inverts or adds a negation: a negated claim is legitimate in
// the that/whether forms, and "not" inside one is the claim's own polarity.
//
// THE CHECK IS ABOUT FRAMING, NOT MEANING. It rejects shapes that cannot be
// read under "Does not establish: …" — a sentence about the excerpt, a
// statement of what the document lacks, several sentences — and accepts
// only shapes that can. It is deliberately conservative: an unusual but
// harmless phrase that fails it is shown as the code-owned source-class
// limit instead, which loses detail and never meaning.

// Bump only together with a change to the contract above and to the
// extractor prompt that states it.
export const DOES_NOT_PROVE_RULE_VERSION = 1;

// A claim clause: the reader's "does not establish" is completed by it.
const CLAIM_CLAUSE = /^(that|whether)\s+\S/i;

// A sentence that talks about the evidence instead of naming a claim.
const SELF_REFERENCE =
  /^(this|these|it|they|the\s+(excerpt|document|statement|fact|page|source|evidence|passage|text|disclaimer|data|figure|claim|row|article|post|report|section))\b/i;

// A finite auxiliary, copula or modal makes a free-standing sentence out of
// what should be a noun phrase ("X is not specified", "X may not reflect").
// Content verbs are deliberately absent: "current state" or "fee split" must
// stay noun phrases.
const FINITE_AUXILIARY =
  /\b(is|are|was|were|am|be|been|being|has|have|had|does|do|did|can|cannot|could|will|would|shall|should|may|might|must)\b|n't\b/i;

// A negation outside a that/whether clause is the shape that flips under the
// label. A negated claim must use the clause form, where its polarity is
// unambiguous.
const NEGATION = /\b(not|no|never|nor|none|neither)\b|n't\b/i;

// More than one sentence is a description, not a claim.
const SENTENCE_BREAK = /[.;!?]\s+\S/;

export function conformsToDoesNotProveContract(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0) return false;
  if (SENTENCE_BREAK.test(t)) return false;
  if (CLAIM_CLAUSE.test(t)) return true;
  if (SELF_REFERENCE.test(t)) return false;
  if (FINITE_AUXILIARY.test(t)) return false;
  if (NEGATION.test(t)) return false;
  return true;
}

// The marker the executor persists beside a model-written caveat: the
// contract version when the caveat is in a v1 form, NULL otherwise.
export function doesNotProveRuleVersionFor(text: string | null | undefined): number | null {
  return conformsToDoesNotProveContract(text) ? DOES_NOT_PROVE_RULE_VERSION : null;
}
