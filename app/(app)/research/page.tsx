"use client";

import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { isActive } from "@/src/client/research-model";

// The Research index: every research this user has run. The Research SCREEN
// itself is /research/[id] — one page that serves a running job and a
// finished Proof alike.
export default function ResearchListPage() {
  const [jobs, setJobs] = useState<ResearchJobListItem[] | null>(null);

  useEffect(() => {
    void api
      .getResearchJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
  }, []);

  const running = (jobs ?? []).filter((j) => isActive(j.state));
  const finished = (jobs ?? []).filter((j) => !isActive(j.state));

  return (
    <main className="enter flex flex-col gap-6 pb-6">
      <AtlasHeader compact back={{ href: "/home", label: "Back to home" }} />

      <h1 className="px-1 text-[1.5rem] font-semibold tracking-tight">Research</h1>

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

      {finished.length > 0 && (
        <section>
          <p className="eyebrow mb-3 px-1">Completed</p>
          <div className="flex flex-col gap-2.5">
            {finished.map((job) => (
              <RecentProofCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
