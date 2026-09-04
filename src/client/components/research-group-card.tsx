"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobListItem } from "../api";
import { relativeAge, type ProjectGroup } from "../research-model";
import { OutcomeBadge } from "./verdict-badge";

// RESEARCH HISTORY, NOT A JOB LOG.
//
// A user who researched Raydium eight times has ONE line of history with
// eight runs behind it, not eight identical rows. The group leads with what a
// reader wants — latest outcome, how many runs, when it was last researched —
// and opens to the individual runs.
//
// Question-level history is preserved inside: runs are sub-grouped by the
// question that was asked, so two materially different questions about the
// same project stay visibly distinct and can never be merged into one.
export function ResearchGroupCard({ group }: { group: ProjectGroup<ResearchJobListItem> }) {
  const [open, setOpen] = useState(false);
  const multiQuestion = group.questions.length > 1;

  return (
    <div className="row-card overflow-hidden" data-testid={`group-${group.key}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3.5 px-4 py-4 text-left sm:gap-4 sm:px-5"
      >
        <span
          className="orb orb-sm h-11 w-11 shrink-0 text-[0.8rem] font-semibold text-[var(--atlas-cyan)] sm:h-12 sm:w-12"
          aria-hidden
        >
          {initials(group.projectName)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[1rem] font-medium">{group.projectName}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.76rem] text-[var(--atlas-text-dim)]">
            <span data-testid="group-run-count">
              {group.runCount} research {group.runCount === 1 ? "run" : "runs"}
            </span>
            {multiQuestion && (
              <span data-testid="group-question-count">
                {group.questions.length} questions
              </span>
            )}
            <span>Last researched {relativeAge(group.lastAt)}</span>
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2 sm:gap-3">
          <span className="hidden text-right text-[0.68rem] uppercase tracking-wider text-[var(--atlas-text-dim)] sm:block">
            Latest
          </span>
          <OutcomeBadge job={group.latest} size="sm" />
          <span
            className={`text-[var(--atlas-text-dim)] transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--hairline)] px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-4">
            {group.questions.map((q) => (
              <div key={q.key} data-testid="question-group">
                <p className="text-[0.85rem] leading-snug text-[var(--atlas-text)]">
                  {q.question}
                </p>
                <p className="mt-1 text-[0.72rem] text-[var(--atlas-text-dim)]">
                  {q.runs.length} {q.runs.length === 1 ? "run" : "runs"}
                </p>
                <ul className="mt-2 flex flex-col">
                  {q.runs.map((run) => (
                    <li key={run.id}>
                      <Link
                        href={`/research/${run.id}`}
                        data-testid={`run-${run.id}`}
                        className="flex items-center gap-3 border-b border-[var(--hairline)] py-2.5 last:border-b-0"
                      >
                        <span className="flex-1 text-[0.78rem] text-[var(--atlas-text-dim)]">
                          {relativeAge(run.finishedAt ?? run.createdAt)}
                        </span>
                        <OutcomeBadge job={run} size="sm" />
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden
                          className="text-[var(--atlas-text-dim)]"
                        >
                          <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
