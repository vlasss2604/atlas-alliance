"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { api, type ResearchJobDetail } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { ComponentBreakdown } from "@/src/client/components/component-breakdown";
import { DeveloperDetails } from "@/src/client/components/developer-details";
import {
  EvidenceDocumentCard,
  type EvidenceRole,
} from "@/src/client/components/evidence-document-card";
import { GapsPanel } from "@/src/client/components/gaps-panel";
import { RealityCheck } from "@/src/client/components/reality-check";
import { ResearchProgress } from "@/src/client/components/research-progress";
import { OutcomeBadge } from "@/src/client/components/verdict-badge";
import {
  CONFIDENCE_LABELS,
  groupEvidenceByDocument,
  isTerminal,
  jobOutcome,
  researchAnswer,
  relativeAge,
  summariseComponents,
  type EvidenceItemLike,
} from "@/src/client/research-model";
import { useJobEvents, type JobEvent } from "@/src/client/use-job-events";

// THE RESEARCH SCREEN — one page for a running job and a finished Proof.
//
// INFORMATION HIERARCHY, after completion:
//   1. the answer to the question that was asked
//   2. verdict and confidence
//   3. what was verified (reality check)
//   4. what could not be verified
//   5. evidence
//   6. mechanism breakdown
//   7. research process
//   8. developer details
//
// While a run is LIVE the order inverts at the top: progress is what the user
// is waiting on, so it leads. Once the run is finished, progress is history
// and drops below the answer — the same screen, reordered by what is now
// worth reading first.
export default function ResearchDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = typeof params?.id === "string" ? params.id : null;
  const { refresh } = useApp();
  const [detail, setDetail] = useState<ResearchJobDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Re-read the whole detail. Used when the job reaches a terminal state,
  // because the Proof only exists once the job has finished.
  const load = useCallback(() => {
    if (!jobId) return;
    api
      .getResearchJob(jobId)
      .then((d) => {
        setDetail(d);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    api
      .getResearchJob(jobId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Mark read once, so the nav badge reflects reality.
  useEffect(() => {
    if (!jobId) return;
    void api
      .markRead(jobId)
      .then(() => refresh())
      .catch(() => {});
  }, [jobId, refresh]);

  const live = detail !== null && !isTerminal(detail.job.state);

  // LIVE STATE COMES FROM THE SERVER, ALWAYS.
  //
  // Each event is a fresh read of the job row, so `acquisitionPhase` here is
  // the engine's own persisted phase and not a client guess.
  const onEvent = useCallback(
    (e: JobEvent) => {
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              job: {
                ...prev.job,
                state: e.state,
                progressStage: e.progressStage,
                memoryStatus: e.memoryStatus,
                acquisitionPhase: e.acquisitionPhase,
                finishedAt: e.finishedAt,
              },
            }
          : prev,
      );
      if (isTerminal(e.state)) {
        load();
        void refresh();
      }
    },
    [load, refresh],
  );

  useJobEvents(live ? jobId : null, onEvent);

  if (status === "loading") {
    return (
      <main className="enter flex flex-col gap-6">
        <AtlasHeader compact back={{ href: "/research", label: "Back" }} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">Loading…</div>
      </main>
    );
  }

  if (status === "error" || !detail) {
    return (
      <main className="enter flex flex-col gap-6">
        <AtlasHeader compact back={{ href: "/research", label: "Back" }} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
          This research could not be loaded.
        </div>
      </main>
    );
  }

  const { job, proof, components } = detail;
  const projectName = job.projectName ?? job.projectTicker ?? "Unresolved project";
  const finished = isTerminal(job.state);
  const outcome = jobOutcome({ state: job.state, verdict: proof?.verdict ?? null });
  const summary = summariseComponents(components);
  const answer = researchAnswer({
    verdict: proof?.verdict ?? null,
    outcomeKind: outcome.kind,
    projectName: job.projectName,
    components,
  });

  // Evidence roles come from PERSISTED relationships only — S8's citation
  // binding first, then S5's component sets. An excluded row is labelled
  // EXCLUDED at the source and can never reach the supporting list.
  const citedIds = new Set((proof?.citations ?? []).map((c) => c.evidenceId));
  const used: { data: EvidenceItemLike; role: EvidenceRole }[] = (proof?.citations ?? []).map(
    (c) => ({
      data: {
        id: c.evidenceId,
        component: c.component,
        summary: c.summary,
        fragment: c.fragment,
        doesNotProve: c.doesNotProve,
        sourceClass: c.sourceClass,
        officiality: c.officiality,
        retrievedUrl: c.retrievedUrl,
        sourceTitle: c.source.title,
      },
      role: "USED",
    }),
  );
  const supporting = detail.finding.supporting
    .filter((e) => !citedIds.has(e.id))
    .map((e) => ({ data: toItem(e), role: "SUPPORTING" as const }));
  const contradicting = detail.finding.contradicting.map((e) => ({
    data: toItem(e),
    role: "CONTRADICTING" as const,
  }));
  const excluded = detail.finding.excluded.map((e) => ({
    data: { ...toItem(e), exclusionReason: e.exclusionReason },
    role: "EXCLUDED" as const,
  }));
  const admitted = [...used, ...supporting, ...contradicting];

  // OTHER MATERIAL THIS RESEARCH READ — deliberately a SEPARATE section.
  //
  // The finding above stays claim-scoped: evidence belonging to a component
  // the claim does not rest on must never appear beneath it. But a research
  // that read sources and bound none of them to its claim should not look
  // like a research that read nothing, so the rest is listed here, plainly
  // labelled and never attributed to the verdict.
  //
  // Each row's role comes from its PERSISTED component links, in a fixed
  // precedence, never from the text: a row any component excluded is shown
  // as excluded even if another component merely read it.
  const shownIds = new Set([...admitted, ...excluded].map((e) => e.data.id));
  const other = detail.evidence
    .filter((e) => !shownIds.has(e.id))
    .map((e) => {
      const excludedLink = e.links.find((l) => l.role === "EXCLUDED");
      const role: EvidenceRole = excludedLink
        ? "EXCLUDED"
        : e.links.some((l) => l.role === "CONTRADICTING")
          ? "CONTRADICTING"
          : e.links.some((l) => l.role === "SUPPORTING")
            ? "SUPPORTING"
            : "READ";
      return {
        data: { ...toItem(e), exclusionReason: excludedLink?.exclusionReason ?? null },
        role,
      };
    });

  // ONE ACQUIRED DOCUMENT, ONE CARD — per role, so an excluded document can
  // never be folded together with an admitted one.
  const byRole = (rows: { data: EvidenceItemLike; role: EvidenceRole }[], role: EvidenceRole) =>
    groupEvidenceByDocument(rows.filter((r) => r.role === role).map((r) => r.data));
  const admittedDocs: { role: EvidenceRole; groups: ReturnType<typeof groupEvidenceByDocument> }[] =
    (["USED", "SUPPORTING", "CONTRADICTING"] as const).map((role) => ({
      role,
      groups: byRole(admitted, role),
    }));
  const excludedDocs = groupEvidenceByDocument(excluded.map((e) => e.data));
  const otherDocs = (["READ", "SUPPORTING", "CONTRADICTING", "EXCLUDED"] as const).map(
    (role) => ({ role, groups: byRole(other, role) }),
  );

  const evidenceCountByComponent = new Map<string, number>();
  for (const c of components) {
    evidenceCountByComponent.set(c.component, c.supportingEvidenceIds.length);
  }

  const gaps = components.filter((c) => c.status === "INSUFFICIENT_EVIDENCE");
  const hasAdmittedDocs = admittedDocs.some((d) => d.groups.length > 0);
  const hasOtherDocs = otherDocs.some((d) => d.groups.length > 0);

  return (
    <main className="enter flex flex-col gap-5 pb-6">
      <AtlasHeader compact back={{ href: "/research", label: "Back" }} />

      {/* ---- 0. project + question ---------------------------------- */}
      <section className="flex items-start gap-4 px-1 pt-1">
        <span
          className="orb h-14 w-14 shrink-0 text-[0.95rem] font-semibold text-[var(--atlas-cyan)] sm:h-16 sm:w-16"
          aria-hidden
        >
          {projectName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow eyebrow-violet">Research result</p>
          <h1 className="mt-1.5 text-[1.6rem] font-semibold leading-tight tracking-tight sm:text-[2.15rem]">
            {projectName}
          </h1>
          <p className="mt-2 text-[0.95rem] leading-snug text-[var(--atlas-text-dim)]">
            {job.originalQuestion}
          </p>
        </div>
      </section>

      {/* ---- live: progress leads ----------------------------------- */}
      {!finished && (
        <>
          <section className="panel panel-raised panel-hero p-5 sm:p-6" data-testid="live-banner">
            <div className="flex items-center gap-3">
              <span className="pulse-dot" aria-hidden />
              <p className="text-[0.95rem] font-medium">Research in progress</p>
            </div>
            <p className="mt-2 text-[0.85rem] text-[var(--atlas-text-dim)]">
              You can leave this screen. ATLAS keeps working and the result will be
              here when you come back.
            </p>
          </section>
          <div data-testid="progress-slot-live">
            <ResearchProgress job={job} />
          </div>
        </>
      )}

      {/* ---- 1+2. THE ANSWER, then verdict/confidence ---------------- */}
      {finished && (
        <section
          className="panel panel-raised tone-edge p-5 sm:p-7"
          style={{ "--edge": edgeColor(outcome.tone) } as React.CSSProperties}
          data-testid="answer-panel"
        >
          <div className="flex flex-wrap items-center gap-3">
            <OutcomeBadge job={{ state: job.state, verdict: proof?.verdict ?? null }} />
            {proof?.confidence.band && (
              <span className="tone tone-neutral" data-testid="confidence-band">
                {CONFIDENCE_LABELS[proof.confidence.band] ?? proof.confidence.band} confidence
              </span>
            )}
            <span className="ml-auto text-[0.72rem] text-[var(--atlas-text-dim)]">
              {relativeAge(job.finishedAt)}
            </span>
          </div>

          <div
            className="mt-4 flex flex-col gap-2.5 text-[1.02rem] leading-relaxed sm:text-[1.08rem]"
            data-testid="answer-text"
          >
            {answer.map((s) => (
              <p key={s}>{s}</p>
            ))}
          </div>

          {/* Component counts are analyst metadata, so they sit BELOW the
              answer as a quiet footnote rather than leading it. */}
          {components.length > 0 && (
            <p
              className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--hairline)] pt-3.5 text-[0.75rem] text-[var(--atlas-text-dim)]"
              data-testid="answer-metadata"
            >
              <span className="flex items-center gap-1.5">
                <span className="dot dot-supported" aria-hidden />
                {summary.established} established
              </span>
              <span className="flex items-center gap-1.5">
                <span className="dot dot-insufficient" aria-hidden />
                {summary.unresolved} unresolved
              </span>
              {summary.contradicted > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="dot dot-negative" aria-hidden />
                  {summary.contradicted} contradicted
                </span>
              )}
            </p>
          )}
        </section>
      )}

      {/* ---- 3. what was verified ------------------------------------ */}
      <div data-testid="section-reality">
        <RealityCheck components={components} />
      </div>

      {/* ---- 4. what could not be verified --------------------------- */}
      <GapsPanel gaps={gaps} />

      {/* ---- 5. evidence --------------------------------------------- */}
      <section data-testid="section-evidence">
        <p className="eyebrow mb-3 px-1">Evidence &amp; sources</p>
        {!hasAdmittedDocs ? (
          <div className="panel px-5 py-5 text-sm text-[var(--atlas-text-dim)]">
            No evidence was bound in support of this finding.
          </div>
        ) : (
          <div className="grid gap-2.5 lg:grid-cols-2">
            {admittedDocs.flatMap((d) =>
              d.groups.map((g) => (
                <EvidenceDocumentCard key={`${d.role}:${g.key}`} group={g} role={d.role} />
              )),
            )}
          </div>
        )}

        {excludedDocs.length > 0 && (
          <div className="mt-5" data-testid="excluded-evidence">
            <p className="eyebrow mb-2 px-1">Considered but excluded</p>
            <p className="mb-3 px-1 text-[0.78rem] text-[var(--atlas-text-dim)]">
              These sources were read and refused. They support nothing here.
            </p>
            <div className="grid gap-2.5 lg:grid-cols-2">
              {excludedDocs.map((g) => (
                <EvidenceDocumentCard key={g.key} group={g} role="EXCLUDED" />
              ))}
            </div>
          </div>
        )}

        {hasOtherDocs && (
          <div className="mt-5">
            <p className="eyebrow mb-2 px-1">Other material read</p>
            <p className="mb-3 px-1 text-[0.78rem] text-[var(--atlas-text-dim)]">
              Read during this research but not bound to the finding above.
            </p>
            <div className="grid gap-2.5 lg:grid-cols-2">
              {otherDocs.flatMap((d) =>
                d.groups.map((g) => (
                  <EvidenceDocumentCard key={`${d.role}:${g.key}`} group={g} role={d.role} />
                )),
              )}
            </div>
          </div>
        )}
      </section>

      {/* ---- 6. mechanism breakdown ---------------------------------- */}
      <ComponentBreakdown
        components={components}
        evidenceCountByComponent={evidenceCountByComponent}
      />

      {/* ---- 7. research process (secondary once finished) ----------- */}
      {finished && (
        <details className="panel px-5 py-4" data-testid="progress-slot-finished">
          <summary className="cursor-pointer select-none text-[0.8rem] text-[var(--atlas-text-dim)]">
            Research process
          </summary>
          <div className="mt-4">
            <ResearchProgress job={job} />
          </div>
        </details>
      )}

      {/* ---- 8. developer details ------------------------------------ */}
      <DeveloperDetails detail={detail} />
    </main>
  );
}

function edgeColor(tone: string): string {
  switch (tone) {
    case "supported":
      return "rgba(45, 212, 191, 0.75)";
    case "partial":
      return "rgba(167, 139, 250, 0.75)";
    case "negative":
      return "rgba(248, 113, 113, 0.75)";
    case "insufficient":
      return "rgba(251, 191, 36, 0.7)";
    default:
      return "rgba(148, 163, 184, 0.35)";
  }
}

function toItem(e: {
  id: string;
  component: string | null;
  summary: string | null;
  fragment: string;
  doesNotProve: string | null;
  sourceClass: string | null;
  officiality: string | null;
  retrievedUrl: string;
  sourceTitle: string | null;
}): EvidenceItemLike {
  return {
    id: e.id,
    component: e.component,
    summary: e.summary,
    fragment: e.fragment,
    doesNotProve: e.doesNotProve,
    sourceClass: e.sourceClass,
    officiality: e.officiality,
    retrievedUrl: e.retrievedUrl,
    sourceTitle: e.sourceTitle,
  };
}
