"use client";

import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { AccentTitle } from "@/src/client/components/accent-title";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchGroupCard } from "@/src/client/components/research-group-card";
import { LIBRARY_FILTERS, libraryCounts, matchesFilter, verdictBar, type LibraryFilter } from "@/src/client/library-filter";
import { groupResearchRuns, isActive } from "@/src/client/research-model";

// THE RESEARCH LIBRARY (D-169). Running work stays flat and first — it is
// what the user is waiting on. Everything finished is grouped by project,
// one readable row each, opening to the questions and runs behind it.
// Finished Research belongs to the user and reopening it is a pure read;
// the page says so once, in the user's language.
//
// V7 (HANDOFF §4.5, D7): an overview panel above the list — how many
// projects, a bar of their latest verdicts, and four filter tiles. All of
// it is counted on the client from what each row already shows
// (library-filter.ts); the filter only hides rows, it never changes one.
export default function ResearchListPage() {
  const { dict, me } = useApp();
  const [jobs, setJobs] = useState<ResearchJobListItem[] | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>("ALL");

  useEffect(() => {
    let cancelled = false;
    api
      .getResearchJobs()
      .then((r) => {
        if (!cancelled) setJobs(r.jobs);
      })
      .catch(() => {
        if (!cancelled) setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const running = (jobs ?? []).filter((j) => isActive(j.state));
  const groups = groupResearchRuns((jobs ?? []).filter((j) => !isActive(j.state)));
  const counts = libraryCounts(groups);
  const bar = verdictBar(groups);
  // A tile with nothing behind it cannot stay selected: the list would be
  // empty for a reason the reader did not choose.
  const active: LibraryFilter = counts[filter] > 0 ? filter : "ALL";
  const shown = groups.filter((group) => matchesFilter(group, active));

  return (
    <main className="flex flex-col gap-6 pt-3">
      <div className="flex flex-col gap-2.5 rise">
        <h1 className="library-title">
          <AccentTitle text={dict.research.title} />
        </h1>
        <p className="library-sub">{dict.research.subtitle}</p>
        <p className="library-keep" data-testid="library-keep-note">
          <ShieldIcon />
          <span>{dict.research.keepNote}</span>
        </p>
      </div>

      {jobs === null && <p className="text-[0.95rem] text-[var(--atlas-text-dim)]">{dict.research.loading}</p>}
      {jobs !== null && jobs.length === 0 && (
        <p className="text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="library-empty">
          {dict.research.empty}
        </p>
      )}

      {running.length > 0 && (
        <section className="rise" style={{ animationDelay: "40ms" }}>
          <h2 className="library-h2">{dict.research.inProgress}</h2>
          <ul className="history-list lib-list mt-3">
            {running.map((job) => (
              <RecentProofCard key={job.id} job={job} memoryEnabled={me?.memoryEnabled ?? false} />
            ))}
          </ul>
        </section>
      )}

      {groups.length > 0 && (
        <>
          <section className="lib-hero rise" style={{ animationDelay: "40ms" }} data-testid="library-overview">
            <span className="lib-hero-light" aria-hidden />
            <div className="flex items-baseline gap-2.5 px-0.5">
              {/* A real count, shown at its value at once — never counted up. */}
              <span className="lib-count" data-testid="library-count">
                {groups.length}
              </span>
              <h2 className="lib-hero-title">{dict.research.projectsResearched}</h2>
            </div>

            <div className="lib-bar" aria-hidden>
              {bar.map((part, i) => (
                <span
                  key={part.tone}
                  className="lib-bar-part"
                  data-tone={part.tone}
                  style={{ flexGrow: part.count, animationDelay: `${60 + Math.min(i, 4) * 30}ms` }}
                />
              ))}
            </div>

            <div className="lib-filters" role="group" aria-label={dict.research.filterLabel}>
              {LIBRARY_FILTERS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="lib-filter"
                  aria-pressed={active === key}
                  disabled={counts[key] === 0}
                  onClick={() => setFilter(key)}
                  data-filter={key}
                  data-testid={`library-filter-${key}`}
                >
                  <span className="lib-filter-count">
                    <span className="lib-filter-dot" data-filter={key} aria-hidden />
                    {counts[key]}
                  </span>
                  <span className="lib-filter-label">{dict.research.filters[key]}</span>
                </button>
              ))}
            </div>
          </section>

          <ul className="history-list lib-list rise" style={{ animationDelay: "80ms" }} data-testid="library-list">
            {shown.map((group) => (
              <ResearchGroupCard key={group.key} group={group} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--atlas-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-[1.5px] shrink-0">
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 9.5-4-1.2-7-5-7-9.5V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
