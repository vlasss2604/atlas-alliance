// Phase 6, S5 (phase-6-s5-plan.md §6.1, D-094). The CORE CHECK 2 dictionary
// this codebase already carries as free text on evidence.mechanism_state /
// research_memory.mechanism_state — not invented here, only finally given a
// closed enum and a normalizer. `PAUSED` is the one addition the S5 plan
// approves alongside the existing seven (plan §8.1).
//
// evidence.mechanism_state is a free string written by a model (S4,
// deliberately no DB enum — the dictionary is CORE's, not the schema's).
// S5 must normalize it before any comparison: an unrecognized string
// becomes UNKNOWN, never a new state — otherwise a model could invent a
// string that silently creates OR silently hides a contradiction.
export const MECHANISM_STATES = [
  "PROPOSED",
  "APPROVED",
  "IMPLEMENTING",
  "LIVE",
  "DEPRECATED",
  "REMOVED",
  "PAUSED",
  "UNKNOWN",
] as const;

export type MechanismState = (typeof MECHANISM_STATES)[number];

const KNOWN = new Set<string>(MECHANISM_STATES);

// Exact match only, after trim + uppercase — no fuzzy/partial matching.
// `"definitely live"` (scenario Q) must normalize to UNKNOWN, not LIVE.
export function normalizeMechanismState(raw: string | null): MechanismState {
  if (raw === null) return "UNKNOWN";
  const candidate = raw.trim().toUpperCase();
  return KNOWN.has(candidate) ? (candidate as MechanismState) : "UNKNOWN";
}
