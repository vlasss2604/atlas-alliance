"use client";

import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchGroupCard } from "@/src/client/components/research-group-card";
import { groupResearchRuns, isActive } from "@/src/client/research-model";

// RESEARCH HISTORY. Running work stays flat and first — it is what the
// user is waiting on. Everything finished is grouped by project, one
// readable row each, opening to the questions and runs behind it.
export default function ResearchListPage() {
  const [jobs, setJobs] = useState<ResearchJobListItem[] | null>(null);

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

  return (
    <main className="enter flex flex-col gap-8 pt-4">
      <div>
        <h1 className="display text-[1.7rem] font-semibold text-[var(--atlas-text-strong)] sm:text-[2rem]">Research</h1>
        <p className="mt-1.5 text-[1.02rem] text-[var(--atlas-text-dim)]">Everything ATLAS has verified for you, grouped by project.</p>
      </div>

      {jobs === null && <p className="text-[0.95rem] text-[var(--atlas-text-dim)]">Loading…</p>}
      {jobs !== null && jobs.length === 0 && <p className="text-[0.95rem] text-[var(--atlas-text-dim)]">Nothing here yet.</p>}

      {running.length > 0 && (
        <section>
          <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">In progress</h2>
          <ul className="mt-2 flex flex-col">
            {running.map((job) => (
              <RecentProofCard key={job.id} job={job} />
            ))}
          </ul>
        </section>
      )}

      {groups.length > 0 && (
        <section>
          <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">Projects researched</h2>
          <ul className="mt-2 flex flex-col">
            {groups.map((group) => (
              <ResearchGroupCard key={group.key} group={group} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
