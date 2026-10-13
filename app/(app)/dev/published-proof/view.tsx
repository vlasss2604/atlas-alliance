"use client";

import { useApp } from "@/src/client/app-context";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { ResearchResult } from "@/src/client/components/research-result";
import { RESULT_FIXTURE_NOTICE, resultFixture } from "@/src/client/result-surface-fixtures";

// The client half of /dev/published-proof: one fixture as a published,
// read-only Proof. No jobId is passed — exactly as on the real route — so
// no audit and no owner-only snapshot is offered.
export function PublishedProofPreview({ fixtureKey }: { fixtureKey: string }) {
  const { dict } = useApp();
  const fixture = resultFixture(fixtureKey);
  const checkedAt = fixture.detail.job.finishedAt ?? fixture.detail.job.createdAt;
  return (
    <main className="flex flex-col gap-4 pb-6" data-testid="published-preview-page">
      <AtlasHeader compact back={{ href: "/home", label: dict.detailPage.back }} />
      <ResearchResult detail={fixture.detail} jobId={null} published={{ slug: "fixture", checkedAt }} />
      <section className="rounded-xl border px-3.5 py-2.5" style={{ borderColor: "rgba(226, 179, 79, 0.32)" }} data-testid="fixture-banner">
        <p className="text-[0.8rem] font-semibold uppercase tracking-[0.08em] text-[var(--atlas-amber)]">{RESULT_FIXTURE_NOTICE.title}</p>
        <p className="mt-0.5 text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]">{RESULT_FIXTURE_NOTICE.body}</p>
      </section>
    </main>
  );
}
