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
import { stateOfCue } from "../src/server/domain/mechanism-state-cue";

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
