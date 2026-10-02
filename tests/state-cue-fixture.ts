// FIXTURE EXTRACTORS AND THE DOCUMENTARY STATE-CUE CONTRACT (D-163).
//
// The live extractor now returns `stateCue`: the exact words of the support
// fragment that state its mechanism state. A fixture extractor models a
// COMPLIANT extractor: it cites the shortest run of the fragment's own words
// that the production cue table (`stateOfCue`) maps to the labelled state —
// and cites nothing when the fragment only describes. It never invents words,
// never paraphrases, and never makes a descriptive fragment stated: a fixture
// world whose CURRENT_STATE text is not explicit stays uncued, exactly as a
// real run would.
import { normalizeMechanismState } from "../src/server/domain/mechanism-state";
import { EXECUTION_RULE_VERSION, executionRuleVersionFor } from "../src/server/domain/execution-cue";
import { stateOfCue } from "../src/server/domain/mechanism-state-cue";
import { isTraceable } from "../src/server/engine/s4-executor";

const MAX_CUE_WORDS = 8;

export function fixtureStateCue(fragment: string, mechanismState: string | null | undefined): string | null {
  const state = normalizeMechanismState(mechanismState ?? null);
  if (state === "UNKNOWN") return null;
  const words = fragment.split(/\s+/).filter((w) => w.length > 0);
  for (let len = 1; len <= Math.min(MAX_CUE_WORDS, words.length); len += 1) {
    for (let start = 0; start + len <= words.length; start += 1) {
      const window = words.slice(start, start + len).join(" ").replace(/[.,;:!?]+$/, "");
      if (stateOfCue(window) === state && fragment.includes(window)) return window;
    }
  }
  return null;
}

// THE DOCUMENTARY EXECUTION-CUE CONTRACT (D-165), modelled the same way: a
// COMPLIANT extractor cites the shortest run of the fragment's own words
// that the production contract (`executionRuleVersionFor`, the executor's
// own literal check) accepts as a completed execution — and nothing when the
// fragment describes, plans or states a lifecycle position. A fixture row
// therefore carries the execution marker exactly when its own text reports a
// completed execution in a v1 form; the builder never grants it by default.
export function fixtureExecutionCue(fragment: string): string | null {
  const words = fragment.split(/\s+/).filter((w) => w.length > 0);
  for (let len = 1; len <= Math.min(MAX_CUE_WORDS, words.length); len += 1) {
    for (let start = 0; start + len <= words.length; start += 1) {
      const window = words.slice(start, start + len).join(" ").replace(/[.,;:!?]+$/, "");
      if (executionRuleVersionFor({ executionCue: window, supportFragment: fragment, isLiteral: isTraceable }) === EXECUTION_RULE_VERSION) {
        return window;
      }
    }
  }
  return null;
}

export function fixtureExecutionRuleVersion(fragment: string): number | null {
  return fixtureExecutionCue(fragment) === null ? null : EXECUTION_RULE_VERSION;
}

// For in-memory row builders: derive the marker from the row's FINAL
// fragment (after overrides) unless the test set it explicitly.
export function withFixtureExecutionMarker<T extends { fragment: string; executionRuleVersion?: number | null }>(row: T): T {
  if (row.executionRuleVersion !== undefined) return row;
  return { ...row, executionRuleVersion: fixtureExecutionRuleVersion(row.fragment) };
}
