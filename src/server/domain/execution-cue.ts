// THE DOCUMENTARY EXECUTION-CUE CONTRACT (Founder-approved, D-165).
//
// EXECUTION_EVIDENCE = evidence that the claimed mechanism executed AT LEAST
// ONCE. It is not "executing now", not CURRENT_STATE = LIVE, not attribution
// of any observed transaction, not a burn and not a supply reduction.
//
//   CURRENT / LIVE ≠ EXECUTED
//   HISTORICAL EXECUTION ≠ CURRENT STATE
//   TRANSACTION HAPPENED ≠ CLAIMED MECHANISM EXECUTED
//
// A model-written row's mechanism_state is a lifecycle label; even a
// validated one ("is currently live", mechanism-state-cue.ts) states a
// position, never that anything ran. So a documentary row speaks for
// execution only through a SEPARATE cue: the extractor returns
// `executionCue`, the verbatim words of the support fragment that report a
// completed execution, and code accepts it only when it
//   1. occurs literally in the fragment (the executor's traceability check,
//      injected — one notion of "literal");
//   2. contains one of the closed, code-owned completed-execution forms
//      below — explicit auxiliary + participle, or a past form carrying a
//      concrete quantity; never bare simple past ("the mechanism executed
//      …"), whose subject code cannot verify ("Executed proposals are
//      listed below");
//   3. sits, at every place it occurs, in an ASSERTED sentence: the D-164
//      guard (no negation, condition, modal, future, contingency, question).
//
// Independent of mechanism_state: an execution report is typically labelled
// UNKNOWN, and a LIVE label adds nothing. THIS MODULE NEVER EDITS ANYTHING;
// the answer is the rule-version marker stored beside the row.
//
// Deliberately NOT here (Founder, v1): statistic labels and table rows
// ("Total bought back and burnt $448M", dated numeric rows), governance
// execution records, and any on-chain attribution. They match no form.

import { cueIsAsserted } from "./mechanism-state-cue";

// Bump only together with a change to the form table and to the extractor
// prompt that states the contract.
export const EXECUTION_RULE_VERSION = 1;

// A closed set of adverbs allowed between the auxiliary and the participle.
const ADV = "(?:(?:successfully|already|fully)\\s+)?";
// A concrete quantity: a number, optionally with a currency sign and a
// magnitude word or suffix ("1.2M", "70,000", "$218 million").
const QUANTITY = "[$€£]?\\d[\\d,.]*(?:\\s*(?:[kmb]|thousand|million|billion))?";

// The closed, code-owned completed-execution forms. Matched
// case-insensitively, on word boundaries, against the cue text only.
export const EXECUTION_FORMS: readonly RegExp[] = [
  new RegExp(`\\b(?:was|were)\\s+${ADV}(?:executed|completed)\\b`, "i"),
  new RegExp(`\\b(?:has|have)\\s+been\\s+${ADV}executed\\b`, "i"),
  new RegExp(`\\b(?:has|have)\\s+${ADV}(?:executed|completed|bought\\s+back|repurchased|burned)\\b`, "i"),
  // Simple past only with a concrete quantity right after the verb.
  new RegExp(`\\b(?:bought\\s+back|repurchased)\\s+(?:over\\s+|more\\s+than\\s+|about\\s+|around\\s+|approximately\\s+)?${QUANTITY}(?![\\w])`, "i"),
];

// Does the cue text itself carry an approved completed-execution form?
export function cueStatesExecution(cue: string | null | undefined): boolean {
  if (typeof cue !== "string") return false;
  const t = cue.trim();
  if (t.length === 0) return false;
  return EXECUTION_FORMS.some((re) => re.test(t));
}

export interface ExecutionCueInput {
  executionCue: string | null | undefined;
  supportFragment: string;
  // The executor's strict traceability check: does `needle` occur literally
  // in `container`? Injected so there is exactly one notion of "literal".
  isLiteral: (container: string, needle: string) => boolean;
}

// The marker the executor persists: the contract version when a validated
// execution cue backs the row, NULL otherwise.
export function executionRuleVersionFor(input: ExecutionCueInput): number | null {
  const cue = input.executionCue;
  if (typeof cue !== "string" || cue.trim().length === 0) return null;
  if (!input.isLiteral(input.supportFragment, cue)) return null;
  if (!cueStatesExecution(cue)) return null;
  return cueIsAsserted(input.supportFragment, cue) ? EXECUTION_RULE_VERSION : null;
}
