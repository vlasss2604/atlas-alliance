"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { api, type AuditProjectionView, type ResearchJobDetail } from "@/src/client/api";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { ResearchAudit } from "@/src/client/components/research-audit";

// FULL RESEARCH AUDIT — ITS OWN SCREEN.
//
// It was a disclosure at the bottom of the Result, which meant reaching
// the audit required scrolling back through the entire answer and every
// key finding first. A professional opening an audit has already read the
// answer; making them read it again before the record starts is the same
// repetition this surface exists to remove.
//
// A SUB-ROUTE, NOT A NEW ARCHITECTURE. `/research/[id]/source/[evidenceId]`
// already established the pattern for a focused view over one job, with
// the same session, the same detail payload and its own back link. This
// follows it exactly.
//
// THE CALL STILL HAPPENS ONCE, AND ONLY BECAUSE A HUMAN CAME HERE.
// Reaching this route IS the explicit request, so it POSTs on mount — and
// the server generates at most one projection per (job, audit version),
// returning the persisted row on every later visit. The Result page makes
// no audit request at all.
export default function ResearchAuditPage() {
  const params = useParams<{ id: string }>();
  const jobId = typeof params?.id === "string" ? params.id : null;

  const [detail, setDetail] = useState<ResearchJobDetail | null>(null);
  const [projection, setProjection] = useState<AuditProjectionView | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    // SEQUENCED, NOT RACED, AND THE ORDER IS LOAD-BEARING.
    //
    // Preparing an audit is a mutation, so it carries a CSRF token that
    // only exists once the session has bootstrapped. Firing it in parallel
    // with the first read meant it could reach the server before the
    // bootstrap that authorises it and come back 403 — which the audit
    // then rendered as "no projection", silently losing its labels while
    // a perfectly good row sat in the database.
    //
    // Reading the record first guarantees the session exists by the time
    // the mutation goes out. It also happens to be the right order for
    // the reader: the canonical record is what the page is, and the
    // projection only labels and orders it.
    api
      .getResearchJob(jobId)
      .then(async (d) => {
        if (cancelled) return;
        setDetail(d);
        setStatus("ready");
        // A projection that fails costs the audit its labels and nothing
        // else, so it never blocks or fails the page.
        const a = await api.prepareAudit(jobId).catch(() => ({ audit: null }));
        if (!cancelled) setProjection(a.audit);
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const back = { href: `/research/${jobId ?? ""}`, label: "Back to result" };

  if (status === "loading") {
    return (
      <main className="enter flex flex-col gap-5 pb-6">
        <AtlasHeader compact back={back} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
          Preparing research audit…
        </div>
      </main>
    );
  }

  if (status === "error" || !detail) {
    return (
      <main className="enter flex flex-col gap-5 pb-6">
        <AtlasHeader compact back={back} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
          Full audit could not be prepared.
        </div>
      </main>
    );
  }

  // The job-wide evidence, deliberately. Everywhere on the Result evidence
  // is claim-scoped; the audit is the one surface that must also see what
  // the run read and did NOT rely on.
  const snapshotIds = new Set(detail.snapshotEvidenceIds);
  const evidence = detail.evidence.map((e) => ({
    id: e.id,
    component: e.component,
    summary: e.summary,
    fragment: e.fragment,
    doesNotProve: e.doesNotProve,
    sourceClass: e.sourceClass,
    officiality: e.officiality,
    retrievedUrl: e.retrievedUrl,
    sourceTitle: e.sourceTitle,
    fetchedAt: e.fetchedAt,
    hasSnapshot: snapshotIds.has(e.id),
    links: e.links,
  }));

  return (
    <main className="enter flex flex-col gap-4 pb-6">
      <AtlasHeader compact back={back} />
      <ResearchAudit
        jobId={jobId}
        projectName={detail.job.projectName ?? detail.job.projectTicker}
        question={detail.job.originalQuestion}
        researchedAt={detail.job.finishedAt}
        components={detail.components}
        evidence={evidence}
        projection={projection}
      />
    </main>
  );
}
