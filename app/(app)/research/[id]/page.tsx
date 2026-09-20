"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { api, type ResearchJobDetail } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { DeveloperDetails } from "@/src/client/components/developer-details";
import { ResearchProgress } from "@/src/client/components/research-progress";
import { ResearchResult } from "@/src/client/components/research-result";
import { isTerminal, type JobState } from "@/src/client/research-model";
import { useJobEvents, type JobEvent } from "@/src/client/use-job-events";

// THE RESEARCH SCREEN — one page for a running job and a finished result.
//
// WHILE THE RUN IS LIVE the subject, the question and the engine's own
// progress lead. ONCE IT FINISHES the whole result is ONE component,
// `ResearchResult` (components/research-result.tsx), composed from the
// detail payload alone: answer → what ATLAS found → sources → what
// remains unclear → the full audit. The same
// component renders the offline fixtures at /dev/result-states, so what
// the Founder reviews there is byte-for-byte what a real result renders.
//
// ONE RESEARCH OBJECT. There is no Research | Verification switch and no
// view state. The full audit is its own route.

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

  const live = detail !== null && !isTerminal(detail.job.state as JobState);

  // LIVE STATE COMES FROM THE SERVER, ALWAYS. Each event is a fresh read of
  // the job row, so `acquisitionPhase` here is the engine's own persisted
  // phase and not a client guess.
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
        <div className="px-1 py-6 text-[0.95rem] text-[var(--atlas-text-dim)]">Loading…</div>
      </main>
    );
  }

  if (status === "error" || !detail) {
    return (
      <main className="enter flex flex-col gap-6">
        <AtlasHeader compact back={{ href: "/research", label: "Back" }} />
        <div className="px-1 py-6 text-[0.95rem] text-[var(--atlas-text-dim)]">
          This research could not be loaded.
        </div>
      </main>
    );
  }

  const { job } = detail;
  const projectName = job.projectName ?? job.projectTicker ?? "Unresolved project";
  const finished = isTerminal(job.state as JobState);

  return (
    <main className="enter flex flex-col gap-5 pb-6">
      <AtlasHeader compact back={{ href: "/research", label: "Back" }} />

      {/* ---- LIVE: the subject and the question are the header — there is
           no result yet for them to belong to — and progress leads. ---- */}
      {!finished && (
        <>
          <section className="flex items-start gap-4 px-1 pt-1">
            <span
              className="orb h-14 w-14 shrink-0 text-[0.95rem] font-semibold text-[var(--atlas-cyan)] sm:h-16 sm:w-16"
              aria-hidden
            >
              {projectName.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="section-label">Researching</p>
              <p className="mt-1 text-[1.2rem] font-semibold leading-tight tracking-tight">{projectName}</p>
              <p className="mt-1.5 text-[1rem] leading-snug text-[var(--atlas-text-dim)]">{job.originalQuestion}</p>
            </div>
          </section>
          <section className="panel p-5 sm:p-6" data-testid="live-banner">
            <div className="flex items-center gap-3">
              <span className="pulse-dot" aria-hidden />
              <p className="text-[1.05rem] font-medium">Research in progress</p>
            </div>
            <p className="mt-2 text-[0.95rem] text-[var(--atlas-text-dim)]">
              You can leave this screen. ATLAS keeps working and the result will be here when you come
              back.
            </p>
          </section>
          <div data-testid="progress-slot-live">
            <ResearchProgress job={job} />
          </div>
        </>
      )}

      {/* ---- FINISHED: the one result surface. ------------------------ */}
      {finished && <ResearchResult detail={detail} jobId={jobId} />}

      {/* ---- engine internals, behind an explicit opt-in ------------- */}
      <DeveloperDetails detail={detail} />
    </main>
  );
}
