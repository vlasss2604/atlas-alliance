// THE DOCUMENTARY STATE-CUE CONTRACT (Founder-approved).
//
// PRESENT TENSE ≠ CURRENT STATE. DOCUMENTED ≠ EXECUTING.
//
// A documentary row's mechanism_state is written by the extractor model, and
// the model labels description as state: in Wave 1A (job fd1252ef) 73 of 77
// documentary rows came back LIVE, among them a fee-split table row
// ("| CLMM | 84% | 12% | 4% |") and "12% of Raydium trading fees are used to
// buy back RAY". The prompt already said a documentation page is not an
// operating mechanism because it documents one; the prompt alone did not
// hold. So, as with traceability and locators, the CHECK decides, not the
// prompt.
//
// v1: a model-assigned state counts as a STATED state only when the extractor
// also returned a stateCue that
//   1. occurs literally inside the support fragment (the executor's strict
//      traceability check, injected here — one notion of "literal");
//   2. maps, through the closed code-owned table below, to EXACTLY ONE
//      canonical state — no fuzzy matching, and a cue matching two states
//      settles nothing;
//   3. maps to the SAME state the model assigned.
// A cue carrying a negation, a condition, a modal or a future is refused
// outright, whatever else it contains: "is not live", "will be live", "if
// the module is active" state nothing about the present.
//   4. sits, at EVERY place it occurs in the fragment, inside an ASSERTED
//      sentence. The model chooses how many words to cite, so checking the
//      cue alone let "is live" out of "…once the token is live…" and "is
//      enabled" out of "…is enabled only after governance approves it". The
//      sentence around the cue faces the same refusal words, plus a closed
//      set of contingency markers, and a question asserts nothing.
//
// THIS MODULE NEVER EDITS ANYTHING. The model's raw mechanism_state is
// persisted as written; the answer here is the rule-version marker stored
// beside it. Generic present-tense description ("fees are used to…",
// "rewards are sent…", "the balance updates…"), tables, addresses and
// allocation rows match no cue and are never a stated state.
//
// The canonical taxonomy (domain/mechanism-state.ts) is unchanged: every cue
// maps onto an existing state. UNKNOWN has no cue — it is what an uncued
// label already reads as.

import { normalizeMechanismState, type MechanismState } from "./mechanism-state";

// Bump only together with a change to the cue table and to the extractor
// prompt that states the contract.
export const MECHANISM_STATE_RULE_VERSION = 1;

export type CuedState = Exclude<MechanismState, "UNKNOWN">;

const ADJ_LIVE = "(?:live|active|enabled|operational|in effect)";

// The closed, code-owned cue table. Each entry is explicit state language;
// none of them is mere present tense. Matched case-insensitively, on word
// boundaries, against the cue text only.
export const STATE_CUES: Readonly<Record<CuedState, readonly RegExp[]>> = {
  LIVE: [
    new RegExp(`\\b(?:is|are)\\s+(?:currently\\s+|now\\s+)?${ADJ_LIVE}\\b`, "i"),
    /\b(?:is|are)\s+(?:currently|now)\s+running\b/i,
    new RegExp(`\\b(?:currently|now)\\s+${ADJ_LIVE}\\b`, "i"),
    /\b(?:has|have)\s+gone\s+live\b/i,
  ],
  IMPLEMENTING: [/\b(?:is|are)\s+(?:currently\s+|now\s+)?being\s+(?:implemented|deployed|rolled\s+out)\b/i],
  PAUSED: [
    /\b(?:is|are)\s+(?:currently\s+|temporarily\s+|now\s+)?(?:paused|suspended|halted)\b/i,
    /\b(?:has|have)\s+been\s+(?:temporarily\s+)?(?:paused|suspended|halted)\b/i,
    /\bcurrently\s+(?:paused|suspended|halted)\b/i,
  ],
  DEPRECATED: [/\b(?:is|are|has\s+been|have\s+been)\s+(?:now\s+)?(?:deprecated|superseded)\b/i],
  REMOVED: [/\b(?:is|are|was|were|has\s+been|have\s+been)\s+(?:now\s+)?(?:removed|discontinued|retired|sunset|shut\s+down)\b/i],
  APPROVED: [
    /\b(?:is|are|was|were|has\s+been|have\s+been)\s+(?:formally\s+)?(?:approved|ratified)\b/i,
    /\b(?:vote|proposal)\s+(?:has\s+)?passed\b/i,
  ],
  PROPOSED: [/\b(?:is|are|has\s+been|have\s+been)\s+proposed\b/i, /\b(?:is|are)\s+under\s+discussion\b/i],
};

// Language that removes a cue's force: a negation, a condition, a modal, a
// future or an expectation. Any of these anywhere in the cue refuses it.
const DISQUALIFIER =
  /\b(?:not|no|never|nor|no\s+longer|if|when|whenever|once|unless|until|will|would|could|should|may|might|can|shall|must|expected|planned|scheduled|intends?|intended|to\s+be)\b|n't\b/i;

// The single canonical state a cue states, or null — never a guess.
export function stateOfCue(cue: string | null | undefined): CuedState | null {
  if (typeof cue !== "string") return null;
  const t = cue.trim();
  if (t.length === 0 || DISQUALIFIER.test(t)) return null;
  const matched = (Object.keys(STATE_CUES) as CuedState[]).filter((s) => STATE_CUES[s].some((re) => re.test(t)));
  return matched.length === 1 ? matched[0] : null;
}

// Words that make a sentence contingent on something else: "enabled only
// after approval", "live upon deployment", "active provided that…". Checked
// against the sentence, never the cue, together with DISQUALIFIER.
// Deliberately broad on the refusing side: a genuine assertion that happens
// to share a sentence with one of these is left uncued (fail closed), never
// rewritten.
const CONTINGENCY =
  /\b(?:after|before|upon|provided|providing|subject\s+to|assuming|whether|in\s+case|as\s+soon\s+as|depend(?:s|ing|ent)?\s+on)\b/i;

// Sentence ends: . ! ? followed by whitespace or the end ("v1.5" is not an
// end), a semicolon, a line break, or a table cell bar.
const SENTENCE_END = /[.!?](?=\s|$)|[;\n|]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True only when the cue occurs in the fragment on word boundaries and every
// occurrence sits in a sentence that asserts: no negation, condition, modal,
// future or contingency, and not a question. A cue that cannot be located
// this way is not asserted — never a guess about where it was meant to be.
export function cueIsAsserted(supportFragment: string, cue: string): boolean {
  const words = cue.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return false;
  const locate = new RegExp(`(?<![A-Za-z0-9])${words.map(escapeRegExp).join("\\s+")}(?![A-Za-z0-9])`, "gi");
  const ends: { at: number; char: string }[] = [];
  for (const m of supportFragment.matchAll(SENTENCE_END)) ends.push({ at: m.index, char: m[0] });
  let found = false;
  for (const m of supportFragment.matchAll(locate)) {
    found = true;
    const start = m.index;
    const finish = start + m[0].length;
    const before = ends.filter((e) => e.at < start).at(-1);
    const after = ends.find((e) => e.at >= finish);
    const sentence = supportFragment.slice(before ? before.at + 1 : 0, after ? after.at : supportFragment.length);
    if (after?.char === "?") return false;
    if (DISQUALIFIER.test(sentence) || CONTINGENCY.test(sentence)) return false;
  }
  return found;
}

export interface StateCueInput {
  mechanismState: string | null | undefined;
  stateCue: string | null | undefined;
  supportFragment: string;
  // The executor's strict traceability check: does `needle` occur literally
  // in `container`? Injected so there is exactly one notion of "literal".
  isLiteral: (container: string, needle: string) => boolean;
}

// The marker the executor persists beside a model-written state: the contract
// version when the state is backed by a validated cue, NULL otherwise.
export function mechanismStateRuleVersionFor(input: StateCueInput): number | null {
  const labelled = normalizeMechanismState(input.mechanismState ?? null);
  if (labelled === "UNKNOWN") return null;
  const cue = input.stateCue;
  if (typeof cue !== "string" || cue.trim().length === 0) return null;
  if (!input.isLiteral(input.supportFragment, cue)) return null;
  if (stateOfCue(cue) !== labelled) return null;
  return cueIsAsserted(input.supportFragment, cue) ? MECHANISM_STATE_RULE_VERSION : null;
}
