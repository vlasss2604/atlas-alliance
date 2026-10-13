"use client";

import Link from "next/link";

import { AtlasHeader } from "@/src/client/components/atlas-header";
import { ResearchProgress } from "@/src/client/components/research-progress";
import { ResearchStatus, WhatHappensNext } from "@/src/client/components/research-status";
import { useApp } from "@/src/client/app-context";
import { isTerminal } from "@/src/client/research-model";
import { PROGRESS_FIXTURE_NOTICE, PROGRESS_FIXTURES, progressFixture } from "@/src/client/progress-fixtures";

// The client half of /dev/progress-states: the same composition as the
// research page for a job in one fixture state. The fixture notice sits at
// the end so the screen above it reads as the product does.
export function ProgressStatesView({ fixtureKey }: { fixtureKey: string }) {
  const { dict, me } = useApp();
  const fixture = progressFixture(fixtureKey);
  const { job } = fixture;
  const finished = isTerminal(job.state);
  return (
    <main className="flex flex-col gap-4 pb-6" data-testid="progress-states-page">
      <AtlasHeader compact back={{ href: "/research", label: dict.detailPage.back }} />
      {/* The budget fixture is shown as a run that HAS a Proof (02-7). */}
      <ResearchStatus
        job={job}
        memoryEnabled={me?.memoryEnabled ?? false}
        onCancel={finished ? undefined : () => {}}
        onOpenProof={job.state === "BUDGET_LIMIT_REACHED" ? () => {} : undefined}
      />
      {!finished && (
        <>
          <ResearchProgress job={job} memoryEnabled={me?.memoryEnabled ?? false} />
          {job.state !== "AWAITING_CLARIFICATION" && <WhatHappensNext />}
        </>
      )}
      <section className="rounded-xl border px-3.5 py-2.5" style={{ borderColor: "rgba(127, 142, 163, 0.32)" }} data-testid="fixture-banner">
        <p className="text-[0.8rem] font-semibold uppercase tracking-[0.08em] text-[var(--atlas-text-dim)]">{PROGRESS_FIXTURE_NOTICE.title}</p>
        <p className="mt-0.5 text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]">{PROGRESS_FIXTURE_NOTICE.body}</p>
        <nav className="mt-2 flex flex-wrap gap-2">
          {PROGRESS_FIXTURES.map((f) => (
            <Link key={f.key} href={`/dev/progress-states?state=${f.key}`} className="rounded-lg border border-[var(--hairline)] px-2 py-0.5 text-[0.8rem] text-[var(--atlas-text-dim)]">
              {f.key} · {f.title}
            </Link>
          ))}
        </nav>
      </section>
    </main>
  );
}
