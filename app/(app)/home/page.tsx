"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchComposer } from "@/src/client/components/research-composer";
import { groupResearchRuns } from "@/src/client/research-model";

// HOME — ONE PURPOSE: START A VERIFICATION.
//
// The input is the hero. Beneath it, recent research as plain rows — the
// latest run of each distinct question, real records from the server, no
// verdict invented for a job that has none. Nothing else competes: no
// marketing card, no second headline, no repeated brand.
export default function HomePage() {
  const [jobs, setJobs] = useState<ResearchJobListItem[] | null>(null);

  useEffect(() => {
    void api
      .getResearchJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
  }, []);

  const recent = groupResearchRuns(jobs ?? [])
    .flatMap((group) => group.questions.map((q) => q.latest))
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
    .slice(0, 6);

  return (
    <main className="enter flex flex-col gap-10 pt-6 sm:pt-12">
      <ResearchComposer />

      <section data-testid="recent-research">
        <div className="flex items-baseline justify-between">
          <h2 className="section-label">Recent research</h2>
          <Link href="/research" className="text-[0.88rem] text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-cyan)]">
            View all
          </Link>
        </div>
        {jobs === null ? (
          <p className="mt-4 text-[0.95rem] text-[var(--atlas-text-dim)]">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="mt-4 text-[0.95rem] text-[var(--atlas-text-dim)]">
            No research yet. Ask a question above and ATLAS will verify it.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {recent.map((job) => (
              <RecentProofCard key={job.id} job={job} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
