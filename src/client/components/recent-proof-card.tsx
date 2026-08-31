"use client";

import Link from "next/link";

import type { ResearchJobListItem } from "../api";
import { deriveProgress, isTerminal, relativeAge } from "../research-model";
import { VerdictBadge } from "./verdict-badge";

// One row of RECENT PROOFS.
//
// Everything shown is a value the server sent. A job with no Proof has
// `verdict: null` and is labelled by its live stage or its lifecycle state —
// it is never given a verdict to make the row look complete.
export function RecentProofCard({ job }: { job: ResearchJobListItem }) {
  const terminal = isTerminal(job.state);
  const title = job.projectName ?? job.projectTicker ?? "Unresolved project";
  const progress = deriveProgress({
    state: job.state,
    progressStage: job.progressStage,
    acquisitionPhase: job.acquisitionPhase,
  });

  return (
    <Link
      href={`/research/${job.id}`}
      className="row-card flex items-center gap-3.5 px-4 py-3.5 sm:gap-4 sm:px-5"
      data-testid={`proof-card-${job.id}`}
    >
      <span
        className="orb orb-sm h-11 w-11 shrink-0 text-[0.8rem] font-semibold text-[var(--atlas-cyan)] sm:h-12 sm:w-12"
        aria-hidden
      >
        {initials(title)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[0.95rem] font-medium">{title}</span>
          {job.unread && <span className="dot dot-partial" aria-hidden />}
        </span>
        <span className="mt-0.5 block truncate text-[0.8rem] text-[var(--atlas-text-dim)]">
          {job.originalQuestion}
        </span>
        <span className="mt-1.5 flex items-center gap-1.5 text-[0.72rem] text-[var(--atlas-text-dim)]">
          <ClockIcon />
          {relativeAge(job.finishedAt ?? job.createdAt)}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2 sm:gap-3">
        {job.verdict ? (
          <VerdictBadge verdict={job.verdict} size="sm" />
        ) : terminal ? (
          <span className="tone tone-neutral text-[0.625rem]">No proof</span>
        ) : (
          <span
            className="tone tone-neutral text-[0.625rem]"
            data-testid={`job-status-${job.id}`}
          >
            <span className="pulse-dot h-2 w-2" aria-hidden />
            {progress.stages[progress.activeIndex]?.label}
          </span>
        )}
        <ChevronIcon />
      </span>
    </Link>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6 3.4V6l1.8 1.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-[var(--atlas-text-dim)]"
    >
      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
