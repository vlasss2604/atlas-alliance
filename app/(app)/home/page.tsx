"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { AtlasMark } from "@/src/client/components/atlas-header";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchComposer } from "@/src/client/components/research-composer";
import { groupResearchRuns } from "@/src/client/research-model";

// HOME V4 — THE CENTRAL ENTRY POINT.
//
// Top to bottom: the brand, centred and alone; the question — the one
// thing the product asks you to do; three short steps that say what
// happens next; recent research as plain rows. Nothing else competes.
// Every row is a real record from the server; no verdict is invented for
// a job that has none.

const STEPS = [
  { n: "1", title: "Ask", copy: "A project, a token, a claim or a link." },
  { n: "2", title: "ATLAS checks", copy: "Official sources, governance and on-chain data." },
  { n: "3", title: "You get proof", copy: "A clear answer, what is confirmed, what is not." },
] as const;

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
    .slice(0, 5);

  return (
    <main className="enter flex flex-col gap-12 pt-4 sm:gap-14 sm:pt-6">
      {/* THE BRAND, ONCE, IN THE MIDDLE. */}
      <section className="flex flex-col items-center text-center" data-testid="home-brand">
        <AtlasMark size={64} />
        <p className="wordmark mt-4 text-[1.05rem] leading-none text-[var(--atlas-text-strong)] sm:text-[1.2rem]">
          ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>
        </p>
        <p className="mt-2 text-[0.95rem] text-[var(--atlas-text-dim)]">Crypto Verification</p>
      </section>

      <ResearchComposer hero />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="home-steps" aria-label="How it works">
        {STEPS.map((s) => (
          <div key={s.n} className="panel flex items-start gap-3.5 px-4 py-4">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--cyan-dim)] text-[0.85rem] font-semibold text-[var(--atlas-cyan-strong)]">
              {s.n}
            </span>
            <span className="min-w-0">
              <span className="block text-[1rem] font-semibold leading-snug text-[var(--atlas-text-strong)]">{s.title}</span>
              <span className="mt-0.5 block text-[0.92rem] leading-snug text-[var(--atlas-text-dim)]">{s.copy}</span>
            </span>
          </div>
        ))}
      </section>

      <section data-testid="recent-research">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">Recent research</h2>
          <Link href="/research" className="text-[0.92rem] font-medium text-[var(--atlas-cyan-strong)] hover:underline">
            View all
          </Link>
        </div>
        {jobs === null ? (
          <p className="mt-4 text-[0.98rem] text-[var(--atlas-text-dim)]">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="mt-4 text-[0.98rem] text-[var(--atlas-text-dim)]">
            No research yet. Ask a question above and ATLAS will verify it.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {recent.map((job) => (
              <RecentProofCard key={job.id} job={job} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
