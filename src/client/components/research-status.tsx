"use client";

import Link from "next/link";

import { useDict } from "../app-context";
import { stageText } from "../localize";
import { deriveProgress, type ProgressInput } from "../research-model";
import { ATLAS_SHIELD_SRC } from "./atlas-header";
import { ProjectAvatar } from "./project-avatar";

// THE RESEARCH SCREEN'S STATUS (V7, HANDOFF §4.2) — the subject line and
// the one hero "scanner" panel, for every state of a job.
//
// Everything shown is the persisted job: its state and deriveProgress().
// There is no ETA, no percentage and no count-up. The cyan arc is the only
// rotating element and turns only while the job is QUEUED (4s) or RUNNING
// (2.4s). States that are not findings about the project — failed,
// cancelled, stopped at the budget limit — are GREY, never a verdict
// colour. A clarification is static. A succeeded job closes its ring once.

export type StatusKind = "queued" | "running" | "clarify" | "succeeded" | "budget" | "failed" | "cancelled";

export function statusKind(state: string): StatusKind {
  switch (state) {
    case "QUEUED":
      return "queued";
    case "AWAITING_CLARIFICATION":
      return "clarify";
    case "SUCCEEDED":
      return "succeeded";
    case "BUDGET_LIMIT_REACHED":
      return "budget";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "running";
  }
}

const GREY: readonly StatusKind[] = ["budget", "failed", "cancelled"];
const LIVE: readonly StatusKind[] = ["queued", "running"];

export interface StatusJob extends ProgressInput {
  projectName: string | null;
  projectTicker: string | null;
  projectSlug: string | null;
  originalQuestion: string;
}

export function ResearchStatus({
  job,
  memoryEnabled = false,
  onCancel,
  cancelling = false,
}: {
  job: StatusJob;
  memoryEnabled?: boolean;
  // The existing cancel flow; the Stop button renders only when given.
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const dict = useDict();
  const kind = statusKind(job.state);
  const progress = deriveProgress(job, { memoryEnabled });
  const projectName = job.projectName ?? job.projectTicker ?? dict.detailPage.unresolvedProject;
  const live = LIVE.includes(kind);
  const grey = GREY.includes(kind);

  const kicker: Record<StatusKind, string> = {
    queued: dict.detailPage.researching,
    running: dict.detailPage.researching,
    clarify: dict.research.states.AWAITING_CLARIFICATION,
    succeeded: dict.research.states.SUCCEEDED,
    budget: dict.outcome.STOPPED_AT_LIMIT,
    failed: dict.outcome.FAILED,
    cancelled: dict.outcome.CANCELLED,
  };
  const active = progress.stages[progress.activeIndex];
  const title: Record<StatusKind, string> = {
    queued: dict.research.states.QUEUED,
    running: active ? stageText(active, dict) : dict.detailPage.inProgress,
    clarify: dict.ask.clarifyTitle,
    succeeded: dict.research.states.SUCCEEDED,
    budget: dict.outcome.STOPPED_AT_LIMIT,
    failed: dict.progress.failedTitle,
    cancelled: dict.research.states.CANCELLED,
  };
  const sub: Record<StatusKind, string> = {
    queued: dict.detailPage.leaveNote,
    running: dict.detailPage.leaveNote,
    clarify: dict.progress.next.clarify.text,
    succeeded: dict.progress.doneSub,
    budget: dict.research.states.BUDGET_LIMIT_REACHED,
    failed: dict.progress.failedSub,
    cancelled: dict.progress.cancelledSub,
  };

  return (
    <>
      <section className="status-head" data-testid="status-head" data-kind={kind}>
        <span className="status-fade" style={{ animationDelay: "0ms" }}>
          <ProjectAvatar name={job.projectName} ticker={job.projectTicker} slug={job.projectSlug} size={48} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={`status-kicker status-fade ${grey ? "status-kicker-grey" : ""}`} style={{ animationDelay: "18ms" }} data-testid="status-kicker">
            <span className={`status-dot ${live ? "status-dot-live" : ""}`} aria-hidden />
            {kicker[kind]}
          </span>
          <h1 className="status-name status-fade">{projectName}</h1>
          <p className="status-question">{job.originalQuestion}</p>
        </div>
      </section>

      <section className="scanner-panel status-fade" style={{ animationDelay: "72ms" }} data-kind={kind} data-testid="live-banner">
        <span className="scanner-line" aria-hidden />
        <Scanner kind={kind} />
        <div className="flex flex-col items-center gap-2">
          {live && (
            <span className="status-pill" data-testid="status-pill">
              <span className="status-dot status-dot-live" aria-hidden />
              {dict.detailPage.inProgress}
            </span>
          )}
          <h2 className="scanner-title" data-testid="status-title">
            {title[kind]}
          </h2>
          <p className="scanner-sub" data-testid="status-sub">
            {sub[kind]}
          </p>
        </div>
        {kind === "failed" && (
          <p className="attempt-chip" data-testid="attempt-chip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            {dict.progress.failedChip}
          </p>
        )}
        {(kind === "failed" || kind === "cancelled") && (
          <Link href="/home" className="cta-wide" data-testid="ask-another">
            {dict.ask.newQuestion}
          </Link>
        )}
        {live && onCancel && (
          <button type="button" onClick={onCancel} disabled={cancelling} className="stop-button" data-testid="stop-research">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
              <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
            </svg>
            {dict.research.cancel}
          </button>
        )}
      </section>
    </>
  );
}

// The scanner: a static dotted outer ring, the arc, and the AP shield in a
// static disc. The arc spins only while live; a badge marks the end states.
function Scanner({ kind }: { kind: StatusKind }) {
  const spinning = kind === "queued" || kind === "running";
  return (
    <div className="scanner" data-kind={kind} aria-hidden>
      <svg className="scanner-dots" width="176" height="176" viewBox="0 0 176 176">
        <circle cx="88" cy="88" r="84" fill="none" strokeWidth="1.2" strokeDasharray="2 7" />
      </svg>
      <svg className={`scanner-arc ${spinning ? (kind === "queued" ? "scanner-spin-slow" : "scanner-spin") : ""}`} width="176" height="176" viewBox="0 0 176 176">
        <circle className="scanner-track" cx="88" cy="88" r="70" fill="none" strokeWidth="4" />
        {kind === "succeeded" ? (
          <circle className="scanner-ring-draw" cx="88" cy="88" r="70" fill="none" strokeWidth="4" strokeLinecap="round" strokeDasharray="440" transform="rotate(-90 88 88)" />
        ) : (
          <circle
            className="scanner-head"
            cx="88"
            cy="88"
            r="70"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={spinning ? "96 344" : kind === "clarify" ? "110 330" : "300 140"}
            transform="rotate(-90 88 88)"
          />
        )}
      </svg>
      <div className="scanner-disc">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={ATLAS_SHIELD_SRC} alt="" width={62} height={58} draggable={false} />
      </div>
      {kind !== "queued" && kind !== "running" && <span className="scanner-badge">{BADGES[kind]}</span>}
    </div>
  );
}

const BADGES: Partial<Record<StatusKind, React.ReactNode>> = {
  clarify: <span className="text-[12px] font-extrabold">?</span>,
  succeeded: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  budget: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M5 16a7 7 0 1 1 14 0" />
      <path d="M12 16l3-4" />
    </svg>
  ),
  failed: <span className="text-[13px] font-extrabold">!</span>,
  cancelled: (
    <svg width="10" height="10" viewBox="0 0 24 24">
      <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
    </svg>
  ),
};

// "What happens next" — only while the job runs. Cyan for ready and
// clarify; grey for budget and failure (they are not findings).
export function WhatHappensNext() {
  const dict = useDict();
  const rows = [
    { key: "ready", tone: "cyan", icon: "✓", ...dict.progress.next.ready },
    { key: "clarify", tone: "cyan", icon: "?", ...dict.progress.next.clarify },
    { key: "budget", tone: "grey", icon: "gauge", ...dict.progress.next.budget },
    { key: "failure", tone: "grey", icon: "!", ...dict.progress.next.failure },
  ] as const;
  return (
    <section className="process-panel rise" style={{ animationDelay: "80ms" }} data-testid="what-next">
      <h2 className="process-title">{dict.progress.next.title}</h2>
      <ul className="flex flex-col gap-4">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start gap-3" data-row={r.key}>
            <span className={`next-icon next-icon-${r.tone}`} aria-hidden>
              {r.icon === "gauge" ? BADGES.budget : r.icon === "✓" ? BADGES.succeeded : <span className="text-[12px] font-extrabold">{r.icon}</span>}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14.5px] leading-5 font-bold text-[var(--atlas-text-strong)]">{r.title}</span>
              <span className="text-[13.5px] leading-5 text-[var(--atlas-text-dim)]">{r.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
