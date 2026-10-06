import type { Dict } from "./i18n/en";
import { MEMORY_NOT_CONSULTED_LABEL, type OutcomeView } from "./research-model";

// RENDER-TIME WORDS FOR THE MODEL'S CANONICAL LABELS (D-171).
//
// research-model stays pure and English: it derives a kind, a verdict code
// or a stage key and carries an English label beside it (its tests pin
// those). The screens say the same thing in the user's language by KEY,
// falling back to the model's English label for anything not in the
// dictionary — so a new code can never render blank, and nothing about the
// derivation changes with the language.
export function outcomeText(outcome: Pick<OutcomeView, "kind" | "label" | "verdict">, dict: Dict): string {
  if (outcome.kind === "VERDICT" && outcome.verdict) return dict.verdict[outcome.verdict] ?? outcome.label;
  return dict.outcome[outcome.kind] ?? outcome.label;
}

export function stageText(stage: { key: string; label: string }, dict: Dict): string {
  if (stage.key === "MEMORY" && stage.label === MEMORY_NOT_CONSULTED_LABEL) return dict.progress.stages.PLANNING;
  return dict.progress.stages[stage.key] ?? stage.label;
}
