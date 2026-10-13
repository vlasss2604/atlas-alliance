import { jobOutcome, type GroupableJob, type OutcomeView, type ProjectGroup, type VerdictTone } from "./research-model";

// THE LIBRARY OVERVIEW AND ROW HEADLINE (V7, HANDOFF §4.5, D7).
//
// What a project row leads with (owner decision, step 7 review): the
// project's most recent FINISHED verdict. When the newest run did not
// finish — it failed, was cancelled or stopped at the budget limit — that
// run is not a finding about the project, so it does not replace the last
// real verdict; the row keeps that verdict and adds a grey note that the
// last run did not finish. A project that never reached a finished verdict
// shows a grey "No verdict yet" instead. A verdict persisted on a run that
// stopped early is not a finished verdict and is never counted.
//
// The count, the bar and the four filter tiles all read this one headline,
// so they always agree with what the rows show.

export const LIBRARY_FILTERS = ["ALL", "SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

const UNFINISHED: ReadonlySet<OutcomeView["kind"]> = new Set(["FAILED", "CANCELLED", "STOPPED_AT_LIMIT"]);

export interface RowHeadline {
  // The outcome the row's pill shows: the latest run's own outcome, or —
  // when that run did not finish — the latest finished verdict. Null when
  // the newest run did not finish and no run ever reached a verdict.
  outcome: OutcomeView | null;
  // The newest run failed, was cancelled or stopped at the limit.
  lastRunUnfinished: boolean;
}

export function rowHeadline<T extends GroupableJob>(group: ProjectGroup<T>): RowHeadline {
  const latest = jobOutcome(group.latest);
  if (!UNFINISHED.has(latest.kind)) return { outcome: latest, lastRunUnfinished: false };
  // `runs` is newest first, so the first finished verdict is the latest one.
  for (const run of group.runs) {
    const outcome = jobOutcome(run);
    if (outcome.kind === "VERDICT") return { outcome, lastRunUnfinished: true };
  }
  return { outcome: null, lastRunUnfinished: true };
}

// The verdict the row's pill shows, or null when it shows no verdict.
export function shownVerdict(headline: RowHeadline): string | null {
  return headline.outcome?.kind === "VERDICT" ? headline.outcome.verdict : null;
}

export function matchesFilter<T extends GroupableJob>(group: ProjectGroup<T>, filter: LibraryFilter): boolean {
  return filter === "ALL" || shownVerdict(rowHeadline(group)) === filter;
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
    const headline = rowHeadline(group);
    const tone: VerdictTone = shownVerdict(headline) && headline.outcome ? headline.outcome.tone : "neutral";
    byTone.set(tone, (byTone.get(tone) ?? 0) + 1);
  }
  return BAR_ORDER.filter((tone) => byTone.has(tone)).map((tone) => ({ tone, count: byTone.get(tone) ?? 0 }));
}
