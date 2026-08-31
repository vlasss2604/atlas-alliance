"use client";

import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchGroupCard } from "@/src/client/components/research-group-card";
import { groupResearchRuns, isActive } from "@/src/client/research-model";

// RESEARCH HISTORY.
//
// Running work stays flat and prominent — it is what the user is waiting on.
// Everything finished is grouped by project, because eight runs of the same
// project is one line of history with eight runs behind it, not eight rows
// that look like an engineering job log.
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
    <main className="enter flex flex-col gap-6 pb-6">
      <AtlasHeader compact back={{ href: "/home", label: "Back to home" }} />

      <div className="px-1">
        <h1 className="text-[1.6rem] font-semibold tracking-tight sm:text-[2rem]">Research</h1>
        <p className="mt-1.5 text-[0.85rem] text-[var(--atlas-text-dim)]">
          Everything ATLAS has researched for you, grouped by project.
        </p>
      </div>

      {jobs === null && (
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">Loading…</div>
      )}

      {jobs !== null && jobs.length === 0 && (
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
          Nothing here yet.
        </div>
      )}

      {running.length > 0 && (
        <section>
          <p className="eyebrow eyebrow-cyan mb-3 px-1">In progress</p>
          <div className="flex flex-col gap-2.5">
            {running.map((job) => (
              <RecentProofCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}

      {groups.length > 0 && (
        <section>
          <p className="eyebrow mb-3 px-1">Projects researched</p>
          <div className="flex flex-col gap-2.5">
            {groups.map((group) => (
              <ResearchGroupCard key={group.key} group={group} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
