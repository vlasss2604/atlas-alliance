"use client";

import Link from "next/link";

import type { ResearchJobListItem } from "../api";
import { useDict } from "../app-context";
import { outcomeText, stageText } from "../localize";
import { deriveProgress, isTerminal, jobOutcome, relativeAge, retrievedOn } from "../research-model";
import { ProjectAvatar } from "./project-avatar";

// ONE PREVIOUSLY RESEARCHED PROJECT, AS A CARD (the Figma row): the
// avatar tile, the name with the outcome pill beside it, the question on
// its own full-width line, and when it was checked. The pill sits on the
// name's line so a long one ("Недостаточно доказательств") can never
// squeeze the question into a column of single words — the defect the
// old flex row had at 390 px in Russian. Everything shown is a value the
// server sent. A job with no Proof is labelled by its live stage or
// lifecycle state, never given a verdict to look done.
export function RecentProofCard({ job, memoryEnabled = false }: { job: ResearchJobListItem; memoryEnabled?: boolean }) {
  const terminal = isTerminal(job.state);
  const dict = useDict();
  const title = job.projectName ?? job.projectTicker ?? dict.detailPage.unresolvedProject;
  const outcome = jobOutcome(job);
  const progress = deriveProgress({ state: job.state, progressStage: job.progressStage, acquisitionPhase: job.acquisitionPhase }, { memoryEnabled });
  const checked = job.finishedAt ? retrievedOn(job.finishedAt) : null;
  return (
    <li className="list-none">
      <Link href={`/research/${job.id}`} className="history-row" data-testid={`proof-card-${job.id}`}>
        <ProjectAvatar name={job.projectName} ticker={job.projectTicker} slug={job.projectSlug} size={44} />
        <span className="history-head">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[1.05rem] font-semibold text-[var(--atlas-text-strong)]">{title}</span>
            {job.unread && <span className="dot dot-partial" aria-hidden />}
          </span>
          {terminal ? (
            <span className={`tone tone-${outcome.tone}`} data-testid="history-outcome" data-verdict={outcome.verdict ?? "NONE"} data-outcome={outcome.kind}>
              {outcomeText(outcome, dict)}
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1.5 text-[0.85rem] text-[var(--atlas-text-dim)]" data-testid={`job-status-${job.id}`}>
              <span className="pulse-dot h-2 w-2" aria-hidden />
              {progress.stages[progress.activeIndex] ? stageText(progress.stages[progress.activeIndex], dict) : null}
            </span>
          )}
        </span>
        <span className="block text-[0.95rem] leading-snug text-[var(--atlas-text-dim)]">{job.originalQuestion}</span>
        <span className="block text-[0.85rem] text-[var(--atlas-text-faint)]" data-testid="history-checked">
          {terminal && checked ? dict.detailPage.checked(checked) : relativeAge(job.finishedAt ?? job.createdAt)}
        </span>
      </Link>
    </li>
  );
}
