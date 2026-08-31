"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchComposer } from "@/src/client/components/research-composer";
import { groupResearchRuns } from "@/src/client/research-model";

// HOME — what you can do, and what you have already proved.
//
// Recent Proofs are REAL records from /api/research-jobs. A job with no
// Proof shows no verdict; nothing on this screen is placeholder data.
export default function HomePage() {
  const [jobs, setJobs] = useState<ResearchJobListItem[] | null>(null);

  useEffect(() => {
    void api
      .getResearchJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
  }, []);

  // RECENT PROOFS, not recent runs. Six rows of the same question re-run six
  // times tells a reader nothing they did not learn from the first; the
  // latest run of each distinct question does. Nothing is hidden — "View all"
  // opens the full grouped history, with every run inside it.
  const recent = groupResearchRuns(jobs ?? [])
    .flatMap((group) => group.questions.map((q) => q.latest))
    .sort(
      (a, b) =>
        Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt),
    )
    .slice(0, 6);

  return (
    <main className="enter flex flex-col gap-7 pb-6">
      <AtlasHeader />

      <ResearchComposer />

      <section>
        <div className="mb-3 flex items-baseline justify-between px-1">
          <p className="eyebrow">Recent proofs</p>
          <Link
            href="/research"
            className="flex items-center gap-1 text-[0.75rem] text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-cyan)]"
          >
            View all
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>

        {jobs === null ? (
          <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">Loading…</div>
        ) : recent.length === 0 ? (
          <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
            No research yet. Ask a question above and ATLAS will build your first Proof.
          </div>
        ) : (
          <div className="grid gap-2.5 lg:grid-cols-2">
            {recent.map((job) => (
              <RecentProofCard key={job.id} job={job} />
            ))}
          </div>
        )}
      </section>

      <section className="panel relative overflow-hidden px-5 py-5 sm:px-7">
        <div className="flex items-center gap-4">
          <span className="orb h-12 w-12 shrink-0 text-[var(--atlas-cyan)]" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 2.5 16 5v5c0 3.5-2.4 6.4-6 7.5-3.6-1.1-6-4-6-7.5V5z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="text-[1.05rem] font-medium leading-snug">
              Atlas investigates.
              <br className="hidden sm:block" /> You decide.
            </p>
            <p className="mt-1 text-[0.8rem] text-[var(--atlas-text-dim)]">
              Every conclusion is traced to the evidence it rests on — and to the
              evidence it lacks.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
