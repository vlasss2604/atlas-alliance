"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { AtlasMark } from "@/src/client/components/atlas-header";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchComposer } from "@/src/client/components/research-composer";
import { groupResearchRuns } from "@/src/client/research-model";

// HOME V5 — THE CENTRAL ENTRY POINT, WITH PRODUCT CHARACTER.
//
// Top to bottom: the brand, centred and alone, with one line on what
// ATLAS verifies; the composer as one large raised surface — the thing
// the product asks you to do — with three suggested questions inside it;
// recent research as rows with their outcome. No marketing cards. Every
// row is a real record from the server; no verdict is invented for a job
// that has none.

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
    <main className="enter flex flex-col gap-10 pt-4 sm:gap-12 sm:pt-6">
      {/* THE BRAND, ONCE, IN THE MIDDLE — and one line on what it does. */}
      <section className="flex flex-col items-center text-center" data-testid="home-brand">
        <AtlasMark size={64} />
        <p className="wordmark mt-4 text-[1.05rem] leading-none text-[var(--atlas-text-strong)] sm:text-[1.2rem]">
          ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>
        </p>
        <p className="mt-2 text-[0.95rem] text-[var(--atlas-text-dim)]">Crypto Verification</p>
        <p className="mt-4 max-w-[44ch] text-[1rem] leading-[1.5] text-[var(--atlas-text)]/85" data-testid="home-line">
          ATLAS checks what a token actually earns and where the value goes — from official sources, governance and
          on-chain data — and shows the proof.
        </p>
      </section>

      <section className="panel panel-hero px-5 py-6 sm:px-9 sm:py-8" data-testid="home-composer">
        <ResearchComposer hero />
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
