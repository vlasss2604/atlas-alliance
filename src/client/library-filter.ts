import type { GroupableJob, OutcomeView, ProjectGroup, VerdictTone } from "./research-model";

// THE LIBRARY OVERVIEW (V7, HANDOFF §4.5, D7): a count, a bar and four
// filter tiles, all derived on the client from what each project row
// already shows. Nothing here reads a verdict the row does not display:
// a group counts under a verdict only when its pill IS that verdict. A
// failed, cancelled or budget-stopped latest run shows its state, not a
// verdict, so it is counted under "All" alone — it is not a finding about
// the project — and draws a grey part of the bar.

export const LIBRARY_FILTERS = ["ALL", "SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

// The verdict the row's pill shows, or null when the pill shows a state.
export function shownVerdict(outcome: OutcomeView): string | null {
  return outcome.kind === "VERDICT" ? outcome.verdict : null;
}

export function matchesFilter<T extends GroupableJob>(group: ProjectGroup<T>, filter: LibraryFilter): boolean {
  return filter === "ALL" || shownVerdict(group.latestOutcome) === filter;
}

export function libraryCounts<T extends GroupableJob>(groups: ProjectGroup<T>[]): Record<LibraryFilter, number> {
  const counts = { ALL: 0, SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, INSUFFICIENT_EVIDENCE: 0 } as Record<LibraryFilter, number>;
  for (const group of groups) {
    for (const filter of LIBRARY_FILTERS) if (matchesFilter(group, filter)) counts[filter] += 1;
  }
  return counts;
}

// One bar part per tone that occurs, in a fixed order; widths are the
// counts, so the parts always add up to every project in the library.
const BAR_ORDER: VerdictTone[] = ["supported", "partial", "insufficient", "negative", "neutral"];

export function verdictBar<T extends GroupableJob>(groups: ProjectGroup<T>[]): { tone: VerdictTone; count: number }[] {
  const byTone = new Map<VerdictTone, number>();
  for (const group of groups) {
    const verdict = shownVerdict(group.latestOutcome);
    const tone: VerdictTone = verdict ? group.latestOutcome.tone : "neutral";
    byTone.set(tone, (byTone.get(tone) ?? 0) + 1);
  }
  return BAR_ORDER.filter((tone) => byTone.has(tone)).map((tone) => ({ tone, count: byTone.get(tone) ?? 0 }));
}
