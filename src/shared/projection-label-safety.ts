// PRESENTATION MUST NOT CREATE NEW TRUTH.
//
// A projection label is the ONE piece of user-visible copy a model authors.
// Everything else a reader is told — status, reason, coverage, evidence,
// verdict, band — is looked up from a canonical row. The label is therefore
// the only route by which free-form text can become a factual claim simply
// because it is used as a display label, and this module is the single
// guard on that route.
//
// THE INVARIANT (Founder decision A2):
//
//     PAGE <= PERSISTED VERIFIED RECORD
//
// A label may NAME a finding. It may not add certainty, magnitude,
// direction or economic meaning that the structured record does not carry.
// A neutral record must produce a neutral label.
//
// ONE FUNCTION, BOTH PATHS (Founder decision A3). A rule enforced only when
// writing is not a rule: legacy rows predate it, and corrupted rows are
// part of the adversarial model. `labelSafety` is called on the WRITE path
// (the projection is rejected) and again on every READ path (the label is
// replaced by the component's own canonical name). Storage is never
// trusted.
//
// WHY CLOSED CATEGORY LISTS AND NOT AN OPEN ADJECTIVE BLACKLIST. The four
// axes below are the four ways a name becomes a claim, and each is a small
// closed list named after the thing it refuses — the same bounded
// discipline every other classifier in ATLAS uses (D-100). It is not a
// general language model and does not pretend to be: a novel magnitude word
// outside these lists passes, exactly as a novel phrasing passes every
// other closed dictionary in the system. What the lists DO guarantee is
// that the ordinary ways of overstating a record are refused, and that a
// refusal degrades to canonical copy rather than to a guess.

// AXIS 1 — STATUS. A label that is a verdict word competes with the
// canonical status rendered beside it, and a reader cannot tell which to
// believe.
const STATUS_WORDS =
  /\b(established|unestablished|supported|unsupported|not supported|contradicted|verified|unverified|proven|disproven|confirmed|insufficient)\b/i;

// AXIS 2 — CERTAINTY. The record grades confidence in a band; a label may
// not grade it again, in either direction.
const CERTAINTY_WORDS =
  /\b(definitely|certainly|undoubtedly|clearly|obviously|guaranteed|guarantees|assured|indisputabl\w*|conclusiv\w*|definitive\w*|unambiguous\w*|always|never|yes|no|real|really|actual|actually|genuine|genuinely|truly|in fact)\b/i;

// AXIS 3 — MAGNITUDE. Any number is a magnitude, and so is a size word. The
// record represents quantities structurally (typed quantities with a mint,
// decimals and an admitted row); a label is not that representation.
const MAGNITUDE_WORDS =
  /\b(large|largest|larger|huge|massive|vast|small|smallest|smaller|tiny|minimal|major|minor|significant|significantly|substantial|substantially|strong|strongly|weak|weakly|most|majority|all|every|entire|entirely|fully|whole|half|double|triple)\b/i;
// A STANDALONE NUMBER IS A QUANTITY; A DIGIT INSIDE A NAME IS NOT. "50%",
// "1,000,000 tokens" and "Layer 2" are refused; "ERC-20", "v2" and "veCRV3"
// are names and pass. The rule is positional rather than a list: a digit
// that does not continue a word is a number being stated.
const STATED_NUMBER = /(^|[^A-Za-z0-9-])[0-9]/;
const PERCENT = /%/;

// AXIS 4 — DIRECTION. Whether something rose, fell or stayed put is a
// measured, attributed finding; naming a topic never requires it.
const DIRECTION_WORDS =
  /\b(increase[sd]?|increasing|decrease[sd]?|decreasing|rise[sn]?|rising|rose|fall[sn]?|falling|fell|grow[sn]?|growing|grew|shrink[s]?|shrinking|shrank|reduce[sd]?|reducing|boost[sed]*|higher|lower|more|less|up|down|net positive|net negative)\b/i;

// AXIS 5 — ECONOMIC MEANING, per component. Observed live: NET_EFFECT —
// whose canonical meaning is a durable effect on token SUPPLY — was
// labelled "the intended effect of buybacks on token value". A reader sees
// "value" and reasonably reads price. The research never checked price, so
// the label was claiming a different question had been answered than the
// one the status underneath it grades.
//
// Per COMPONENT, never per project: this names the vocabulary that is
// canonically wrong for a component's meaning, and holds for every project
// the engine will ever run. No token, no domain, no question text.
const ECONOMIC_ENVELOPE: Record<string, RegExp> = {
  // Supply, not markets. Price/return/valuation are a different question.
  NET_EFFECT: /\b(price|valuation|market cap|marketcap|return|returns|yield|worth|value)\b/i,
  // Where value COMES FROM is not where it goes.
  SOURCE_OF_VALUE: /\b(destination|recipient|receives?|ends? up|goes? to)\b/i,
  // What is written down is not what is happening.
  MECHANISM_SPEC: /\b(execut|running|happening|live|active)/i,
  // An authorisation is not an execution.
  GOVERNANCE_BASIS: /\b(execut|running|happening)/i,
  // An intended destination is not an observed transfer.
  DESTINATION: /\b(execut|transferred|actually sent|observed)/i,
};

// The closed vocabulary of WHY a label was refused. Recorded for audit;
// never shown to a reader, who sees only the canonical copy.
export type LabelRejection = "EMPTY" | "STATUS" | "CERTAINTY" | "MAGNITUDE" | "DIRECTION" | "ECONOMIC_ENVELOPE";

export type LabelSafety = { safe: true } | { safe: false; rejection: LabelRejection };

// `component` may be null where the caller does not know it — the four
// component-independent axes still apply, which is what makes this usable
// on a read path that has only the stored row.
export function labelSafety(component: string | null, label: string): LabelSafety {
  const trimmed = label.trim();
  if (trimmed.length === 0) return { safe: false, rejection: "EMPTY" };
  if (STATUS_WORDS.test(trimmed)) return { safe: false, rejection: "STATUS" };
  if (CERTAINTY_WORDS.test(trimmed)) return { safe: false, rejection: "CERTAINTY" };
  if (PERCENT.test(trimmed) || STATED_NUMBER.test(trimmed) || MAGNITUDE_WORDS.test(trimmed)) return { safe: false, rejection: "MAGNITUDE" };
  if (DIRECTION_WORDS.test(trimmed)) return { safe: false, rejection: "DIRECTION" };
  const envelope = component === null ? undefined : ECONOMIC_ENVELOPE[component];
  if (envelope && envelope.test(trimmed)) return { safe: false, rejection: "ECONOMIC_ENVELOPE" };
  return { safe: true };
}

export function isLabelSafe(component: string | null, label: string): boolean {
  return labelSafety(component, label).safe;
}

// THE NEUTRAL FALLBACK. A component key, read as words. Deliberately
// derived from the canonical key rather than from the refused label: a
// refusal degrades to copy the record already owns, and never tries to
// guess what the model meant.
export function neutralLabelFor(component: string | null): string {
  if (!component) return "This research";
  const words = component.toLowerCase().replace(/_/g, " ").trim();
  return words.length === 0 ? "This research" : words.charAt(0).toUpperCase() + words.slice(1);
}
