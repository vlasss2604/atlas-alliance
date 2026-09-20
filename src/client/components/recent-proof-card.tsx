"use client";

import Link from "next/link";

import type { ResearchJobListItem } from "../api";
import { deriveProgress, isTerminal, jobOutcome, relativeAge, retrievedOn } from "../research-model";
import { ProjectAvatar } from "./project-avatar";

// ONE PREVIOUSLY RESEARCHED PROJECT: its avatar, its name, the question
// asked, when it was checked, and the outcome in a quiet pill — only
// because a list must be scannable. Everything shown is a value the
// server sent. A job with no Proof is labelled by its live stage or
// lifecycle state, never given a verdict to look done.
export function RecentProofCard({ job }: { job: ResearchJobListItem }) {
  const terminal = isTerminal(job.state);
  const title = job.projectName ?? job.projectTicker ?? "Unresolved project";
  const outcome = jobOutcome(job);
  const progress = deriveProgress({ state: job.state, progressStage: job.progressStage, acquisitionPhase: job.acquisitionPhase });
  const checked = job.finishedAt ? retrievedOn(job.finishedAt) : null;
  return (
    <li className="list-none">
      <Link href={`/research/${job.id}`} className="history-row" data-testid={`proof-card-${job.id}`}>
        <ProjectAvatar name={job.projectName} ticker={job.projectTicker} slug={job.projectSlug} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[1.05rem] font-semibold text-[var(--atlas-text-strong)]">{title}</span>
            {job.unread && <span className="dot dot-partial" aria-hidden />}
          </span>
          <span className="mt-0.5 block text-[0.95rem] leading-snug text-[var(--atlas-text-dim)]">{job.originalQuestion}</span>
          <span className="mt-1.5 block text-[0.85rem] text-[var(--atlas-text-faint)]" data-testid="history-checked">
            {terminal && checked ? `Checked ${checked}` : relativeAge(job.finishedAt ?? job.createdAt)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5 text-right text-[0.88rem] text-[var(--atlas-text-dim)]">
          {terminal ? (
            <span className={`tone tone-${outcome.tone} text-[0.8rem] px-2.5 py-1`} data-testid="history-outcome" data-verdict={outcome.verdict ?? "NONE"} data-outcome={outcome.kind}>
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
