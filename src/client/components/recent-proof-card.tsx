"use client";

import Link from "next/link";

import type { ResearchJobListItem } from "../api";
import { useDict } from "../app-context";
import { outcomeText, stageText } from "../localize";
import { deriveProgress, isTerminal, jobOutcome, relativeAge, retrievedOn, type VerdictTone } from "../research-model";
import { ProjectAvatar } from "./project-avatar";

// ONE PREVIOUSLY RESEARCHED PROJECT, AS A CARD (the Figma row): the
// avatar tile, the name with the outcome pill beside it, the question on
// its own full-width line, and when it was checked. The pill sits on the
// name's line so a long one ("Недостаточно доказательств") can never
// squeeze the question into a column of single words — the defect the
// old flex row had at 390 px in Russian. Everything shown is a value the
// server sent. A job with no Proof is labelled by its live stage or
// lifecycle state, never given a verdict to look done.
export function RecentProofCard({
  job,
  memoryEnabled = false,
  variant = "row",
  index = 0,
}: {
  job: ResearchJobListItem;
  memoryEnabled?: boolean;
  // "card": the V7 Verify carousel card (HANDOFF §4.1) — the same record,
  // the same link and test ids, laid out as a 236×204 snap card.
  variant?: "row" | "card";
  index?: number;
}) {
  const terminal = isTerminal(job.state);
  const dict = useDict();
  const title = job.projectName ?? job.projectTicker ?? dict.detailPage.unresolvedProject;
  const outcome = jobOutcome(job);
  const progress = deriveProgress({ state: job.state, progressStage: job.progressStage, acquisitionPhase: job.acquisitionPhase }, { memoryEnabled });
  const checked = job.finishedAt ? retrievedOn(job.finishedAt) : null;
  if (variant === "card") {
    return (
      <li className="list-none rise" style={{ animationDelay: `${Math.min(index, 5) * 40}ms` }}>
        <Link href={`/research/${job.id}`} className="recent-card" data-tone={outcome.tone} data-testid={`proof-card-${job.id}`}>
          <span className="flex h-[38px] items-center gap-2.5">
            <ProjectAvatar name={job.projectName} ticker={job.projectTicker} slug={job.projectSlug} size={38} />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-[16px] leading-5 font-bold">{title}</span>
              {job.unread && <span className="dot dot-partial" aria-hidden />}
            </span>
            {terminal && <VerdictGlyph tone={outcome.tone} />}
          </span>
          <span className="recent-card-question">{job.originalQuestion}</span>
          {terminal ? (
            <span className={`tone tone-${outcome.tone} tone-sm self-start`} data-testid="history-outcome" data-verdict={outcome.verdict ?? "NONE"} data-outcome={outcome.kind}>
              {outcomeText(outcome, dict)}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[0.85rem] text-[var(--atlas-text-dim)]" data-testid={`job-status-${job.id}`}>
              <span className="pulse-dot h-2 w-2" aria-hidden />
              {progress.stages[progress.activeIndex] ? stageText(progress.stages[progress.activeIndex], dict) : null}
            </span>
          )}
        </Link>
      </li>
    );
  }
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

// The verdict mark in the corner of a carousel card: a tick for supported,
// a half-filled disc for partial (drawn, not the ◐ character), a dash for
// insufficient, a cross for not supported. A run without a verdict (failed,
// cancelled, budget) gets no mark: it is not a finding about the project.
function VerdictGlyph({ tone }: { tone: VerdictTone }) {
  if (tone !== "supported" && tone !== "partial" && tone !== "insufficient" && tone !== "negative") return null;
  return (
    <span className="verdict-glyph" data-tone={tone} aria-hidden>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        {tone === "supported" && <path d="M5 12.5l4.5 4.5L19 7.5" />}
        {tone === "partial" && (
          <>
            <circle cx="12" cy="12" r="8" strokeWidth="2.8" />
            <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
          </>
        )}
        {tone === "insufficient" && <path d="M7 12h10" />}
        {tone === "negative" && <path d="M7 7l10 10M17 7L7 17" />}
      </svg>
    </span>
  );
}
