"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { AtlasMark } from "@/src/client/components/atlas-header";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchComposer } from "@/src/client/components/research-composer";
import { groupResearchRuns } from "@/src/client/research-model";

// HOME — FINAL COMPOSITION.
//
// Top to bottom: the brand, centred and alone (the brand says what the
// product is — no paragraph); the composer as one compact raised surface
// with four research examples; the projects ATLAS has already researched,
// one row each with an avatar, the question and when it was checked. No
// marketing cards, no statistics. Every row is a real record from the
// server; no verdict is invented for a job that has none.

export default function HomePage() {
  const { dict, me, betaAccessFull } = useApp();
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
    <main className="enter flex flex-col gap-7 pt-2 sm:gap-9 sm:pt-4">
      {/* THE BRAND, ONCE, IN THE MIDDLE. The mark, the wordmark, the line
          beneath — the brand says what the product is. */}
      <section className="flex flex-col items-center text-center" data-testid="home-brand">
        <AtlasMark size={64} hero />
        <p className="wordmark mt-4 text-[1.25rem] leading-none sm:text-[1.45rem]">
          ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>
        </p>
        <p className="tagline mt-2.5">Crypto Verification</p>
      </section>

      <section className="panel panel-hero px-5 py-5 sm:px-8 sm:py-6" data-testid="home-composer">
        <ResearchComposer hero />
      </section>

      {/* PRIVATE BETA ALLOWANCE (D-170) — the server's own count, shown only
          while private beta is what admits this user. */}
      {me?.privateBeta && (
        <p className="-mt-3 px-1 text-center text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="beta-allowance">
          <span className="font-medium text-[var(--atlas-cyan-strong)]">{dict.home.betaLabel}</span>
          {" · "}
          {dict.home.betaRemaining(me.privateBeta.remaining)}
        </p>
      )}
      {!me?.privateBeta && betaAccessFull && (
        <p className="-mt-3 px-1 text-center text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="beta-access-full">
          {dict.home.betaAccessFull}
        </p>
      )}

      <section data-testid="recent-research">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">{dict.home.previouslyResearched}</h2>
          <Link href="/research" className="text-[0.92rem] font-medium text-[var(--atlas-cyan-strong)] hover:underline">
            {dict.home.viewAll}
          </Link>
        </div>
        {jobs === null ? (
          <ul className="mt-2 flex flex-col" aria-busy data-testid="recent-loading">
            {[0, 1, 2].map((i) => (
              <li key={i} className="history-row">
                <span className="skeleton h-10 w-10 rounded-full" />
                <span className="flex-1">
                  <span className="skeleton block h-4 w-32" />
                  <span className="skeleton mt-2 block h-3.5 w-3/4" />
                </span>
              </li>
            ))}
          </ul>
        ) : recent.length === 0 ? (
          <p className="mt-3 px-1 text-[0.98rem] text-[var(--atlas-text-dim)]" data-testid="recent-empty">
            {dict.home.recentEmpty}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {recent.map((job) => (
              <RecentProofCard key={job.id} job={job} memoryEnabled={me?.memoryEnabled ?? false} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
