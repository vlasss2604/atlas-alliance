"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { api, type ResearchJobDetail } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { BetaFeedbackPrompt } from "@/src/client/components/beta-feedback-prompt";
import { DeveloperDetails } from "@/src/client/components/developer-details";
import { ResearchProgress } from "@/src/client/components/research-progress";
import { ResearchResult } from "@/src/client/components/research-result";
import { ResearchStatus, statusKind, WhatHappensNext } from "@/src/client/components/research-status";
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
  const { refresh, me, dict } = useApp();
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

  // V7: when a job this screen watched SUCCEEDS, the scanner closes its ring
  // once (0.5s) before the result replaces it — the existing auto-switch,
  // held just long enough to be seen. Never on reopening a finished job.
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!settling) return;
    const t = window.setTimeout(() => setSettling(false), 700);
    return () => window.clearTimeout(t);
  }, [settling]);

  // A budget-limited run's Proof is opened from its status screen.
  const [budgetOpen, setBudgetOpen] = useState(false);

  // The existing cancel flow (POST /cancel), behind one confirmation.
  const [cancelling, setCancelling] = useState(false);
  const cancel = useCallback(() => {
    if (!jobId || !window.confirm(dict.progress.cancelConfirm)) return;
    setCancelling(true);
    api
      .cancelJob(jobId)
      .catch(() => {})
      .finally(() => {
        setCancelling(false);
        load();
      });
  }, [jobId, dict, load]);

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
        if (e.state === "SUCCEEDED") setSettling(true);
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
        <AtlasHeader compact back={{ href: "/research", label: dict.detailPage.back }} />
        <div className="px-1 py-6 text-[0.95rem] text-[var(--atlas-text-dim)]">{dict.detailPage.loading}</div>
      </main>
    );
  }

  if (status === "error" || !detail) {
    return (
      <main className="enter flex flex-col gap-6">
        <AtlasHeader compact back={{ href: "/research", label: dict.detailPage.back }} />
        <div className="px-1 py-6 text-[0.95rem] text-[var(--atlas-text-dim)]">
          {dict.detailPage.loadError}
        </div>
      </main>
    );
  }

  const { job } = detail;
  const finished = isTerminal(job.state as JobState);
  const kind = statusKind(job.state);
  // Failed and cancelled runs keep the status screen on top (grey: not a
  // finding); their result, if a Proof exists, follows. A budget-limited
  // run shows its status with "Open Proof" when a Proof exists (02-7), and
  // the result once that is tapped; without a Proof there is no button.
  const stoppedEarly = kind === "failed" || kind === "cancelled";
  const budgetProof = kind === "budget" && detail.proof !== null;
  const showStatus = !finished || settling || stoppedEarly || (kind === "budget" && !budgetOpen);
  const showResult = finished && !settling && (stoppedEarly ? detail.proof !== null : kind === "budget" ? budgetProof && budgetOpen : true);

  return (
    <main className="flex flex-col gap-4 pb-6">
      <AtlasHeader compact back={{ href: "/research", label: dict.detailPage.back }} />

      {/* ---- STATUS: while live the subject, the question and the engine's
           own progress lead — there is no result yet. ---- */}
      {showStatus && (
        <ResearchStatus
          job={job}
          memoryEnabled={me?.memoryEnabled ?? false}
          onCancel={finished ? undefined : cancel}
          cancelling={cancelling}
          onOpenProof={budgetProof ? () => setBudgetOpen(true) : undefined}
        />
      )}
      {!finished && (
        <>
          {/* The rail never runs for a finished job: deriveProgress cannot
              say where a stopped run stopped (D5), so nothing is shown as
              done that the record does not say was done. */}
          <div data-testid="progress-slot-live">
            <ResearchProgress job={job} memoryEnabled={me?.memoryEnabled ?? false} />
          </div>
          {job.state !== "AWAITING_CLARIFICATION" && <WhatHappensNext />}
        </>
      )}

      {/* D-171: a due feedback prompt is announced at the top of the
          finished Result, so it is seen without scrolling past the answer. */}
      {finished && detail.proof && me?.feedbackDue && (
        <a href="#beta-feedback" className="glass block px-4 py-3 text-[0.95rem] text-[var(--atlas-cyan-strong)]" data-testid="beta-feedback-banner">
          {dict.feedback.banner}
        </a>
      )}

      {/* ---- FINISHED: the one result surface. ------------------------ */}
      {showResult && <ResearchResult detail={detail} jobId={jobId} />}

      {/* D-170: the one-time feedback prompt, right after a finished Result
          with a Proof, only when the server says it is due. */}
      {finished && detail.proof && me?.feedbackDue && <BetaFeedbackPrompt />}

      {/* ---- engine internals, behind an explicit opt-in ------------- */}
      <DeveloperDetails detail={detail} />
    </main>
  );
}
