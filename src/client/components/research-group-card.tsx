"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobListItem } from "../api";
import { useDict } from "../app-context";
import { outcomeText } from "../localize";
import { jobOutcome, relativeAge, type ProjectGroup } from "../research-model";
import { ProjectAvatar } from "./project-avatar";

// RESEARCH HISTORY, NOT A JOB LOG. A project researched eight times is ONE
// card with eight runs behind it (the Figma library row): the avatar
// tile, the project with its latest outcome as a pill beside it, then one
// line — runs · questions · when it was last researched. It opens to the
// questions asked and their runs.
export function ResearchGroupCard({ group }: { group: ProjectGroup<ResearchJobListItem> }) {
  const [open, setOpen] = useState(false);
  const latest = jobOutcome(group.latest);
  const dict = useDict();
  return (
    <li className="list-none" data-testid={`group-${group.key}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="history-row">
        <ProjectAvatar name={group.projectName} ticker={group.latest.projectTicker} slug={group.latest.projectSlug ?? group.key} size={44} />
        <span className="history-head">
          <span className="truncate text-[1.08rem] font-semibold text-[var(--atlas-text-strong)]">{group.projectName}</span>
          <span className="flex shrink-0 items-center gap-2">
            <span className={`tone tone-${latest.tone}`} data-testid="group-latest" data-verdict={latest.verdict ?? "NONE"}>
              {outcomeText(latest, dict)}
            </span>
            <Chevron open={open} />
          </span>
        </span>
        <span className="block text-[0.92rem] leading-snug text-[var(--atlas-text-dim)]">
          <span data-testid="group-run-count">{dict.history.runs(group.runCount)}</span>
          {group.questions.length > 1 && <span data-testid="group-question-count"> · {dict.history.questions(group.questions.length)}</span>}
          <span> · {dict.history.lastResearched(relativeAge(group.lastAt))}</span>
        </span>
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
