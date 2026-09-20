"use client";

import Link from "next/link";

import type { ResearchJobListItem } from "../api";
import { deriveProgress, isTerminal, jobOutcome, relativeAge } from "../research-model";

// ONE ROW OF RESEARCH HISTORY: project, question, when — and the outcome
// in a quiet word, only because a list must be scannable. Everything
// shown is a value the server sent. A job with no Proof is labelled by
// its live stage or lifecycle state, never given a verdict to look done.
export function RecentProofCard({ job }: { job: ResearchJobListItem }) {
  const terminal = isTerminal(job.state);
  const title = job.projectName ?? job.projectTicker ?? "Unresolved project";
  const outcome = jobOutcome(job);
  const progress = deriveProgress({ state: job.state, progressStage: job.progressStage, acquisitionPhase: job.acquisitionPhase });
  return (
    <li className="list-none">
      <Link href={`/research/${job.id}`} className="history-row" data-testid={`proof-card-${job.id}`}>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[1rem] font-medium">{title}</span>
            {job.unread && <span className="dot dot-partial" aria-hidden />}
          </span>
          <span className="mt-0.5 block text-[0.95rem] leading-snug text-[var(--atlas-text-dim)]">{job.originalQuestion}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-right text-[0.85rem] text-[var(--atlas-text-dim)]">
          <span>{relativeAge(job.finishedAt ?? job.createdAt)}</span>
          {terminal ? (
            <span className="flex items-center gap-1.5" data-testid="history-outcome" data-verdict={outcome.verdict ?? "NONE"} data-outcome={outcome.kind}>
              <span className={`dot dot-${outcome.tone}`} aria-hidden />
              {outcome.label}
            </span>
          ) : (
            <span className="flex items-center gap-1.5" data-testid={`job-status-${job.id}`}>
              <span className="pulse-dot h-2 w-2" aria-hidden />
              {progress.stages[progress.activeIndex]?.label}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
