"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobListItem } from "../api";
import { useDict } from "../app-context";
import { rowHeadline } from "../library-filter";
import { outcomeText } from "../localize";
import { jobOutcome, relativeAge, type ProjectGroup } from "../research-model";
import { ProjectAvatar } from "./project-avatar";

// RESEARCH HISTORY, NOT A JOB LOG. A project researched eight times is ONE
// card with eight runs behind it (the Figma library row): the avatar
// tile with the headline outcome's dot on its corner, the project with that
// outcome as a pill beside it, runs · questions, then when it was last
// researched. It opens to the questions asked and their runs.
//
// The headline is rowHeadline (library-filter.ts): a newest run that did
// not finish never replaces the project's last finished verdict — the row
// keeps that verdict and says, in grey, that the last run did not finish.
export function ResearchGroupCard({ group }: { group: ProjectGroup<ResearchJobListItem> }) {
  const [open, setOpen] = useState(false);
  const headline = rowHeadline(group);
  const tone = headline.outcome?.tone ?? "neutral";
  const dict = useDict();
  return (
    <li className="list-none" data-testid={`group-${group.key}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="history-row lib-row">
        <span className="lib-avatar">
          <ProjectAvatar name={group.projectName} ticker={group.latest.projectTicker} slug={group.latest.projectSlug ?? group.key} size={48} />
          {/* The same outcome as the pill, in the same colour — never a
              second judgement. */}
          <span className={`lib-avatar-dot dot-${tone}`} aria-hidden data-testid="group-dot" />
        </span>
        <span className="lib-row-body">
          <span className="history-head">
            <span className="truncate text-[17px] leading-[22px] font-extrabold text-[var(--atlas-text-strong)]">{group.projectName}</span>
            <span className={`tone tone-${tone}`} data-testid="group-latest" data-verdict={headline.outcome?.verdict ?? "NONE"}>
              {headline.outcome ? outcomeText(headline.outcome, dict) : dict.history.noVerdictYet}
            </span>
          </span>
          {headline.lastRunUnfinished && (
            <span className="lib-row-note" data-testid="group-last-run-unfinished">
              {dict.history.lastRunUnfinished}
            </span>
          )}
          <span className="lib-row-meta">
            <span data-testid="group-run-count">{dict.history.runs(group.runCount)}</span>
            {group.questions.length > 1 && <span data-testid="group-question-count"> · {dict.history.questions(group.questions.length)}</span>}
          </span>
          <span className="lib-row-age">{dict.history.lastResearched(relativeAge(group.lastAt))}</span>
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="expand-enter flex flex-col gap-5 px-3 pt-4 pb-2 sm:px-5">
          {group.questions.map((q) => (
            <div key={q.key} data-testid="question-group">
              <p className="text-[1rem] leading-snug text-[var(--atlas-text)]">{q.question}</p>
              <ul className="mt-1.5 flex flex-col">
                {q.runs.map((run) => {
                  const o = jobOutcome(run);
                  return (
                    <li key={run.id}>
                      <Link href={`/research/${run.id}`} data-testid={`run-${run.id}`} className="flex items-center gap-3 py-2 text-[0.9rem] text-[var(--atlas-text-dim)] hover:text-[var(--atlas-text)]">
                        <span className="flex-1">{relativeAge(run.finishedAt ?? run.createdAt)}</span>
                        <span className="flex items-center gap-1.5" data-verdict={o.verdict ?? "NONE"}>
                          <span className={`dot dot-${o.tone}`} aria-hidden />
                          {outcomeText(o, dict)}
                        </span>
                        <Chevron open={false} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className={`shrink-0 text-[var(--atlas-text-dim)] transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
