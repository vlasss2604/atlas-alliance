"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobListItem } from "../api";
import { jobOutcome, relativeAge, type ProjectGroup } from "../research-model";

// RESEARCH HISTORY, NOT A JOB LOG. A project researched eight times is ONE
// row with eight runs behind it. The row leads with the project, the
// latest outcome in a quiet word and when it was last researched; it
// opens to the questions asked and their runs.
export function ResearchGroupCard({ group }: { group: ProjectGroup<ResearchJobListItem> }) {
  const [open, setOpen] = useState(false);
  const latest = jobOutcome(group.latest);
  return (
    <li className="list-none border-b border-[var(--hairline)] last:border-b-0" data-testid={`group-${group.key}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="history-row w-full text-left">
        <span className="min-w-0 flex-1">
          <span className="block text-[1.05rem] font-medium">{group.projectName}</span>
          <span className="mt-0.5 block text-[0.9rem] text-[var(--atlas-text-dim)]">
            <span data-testid="group-run-count">
              {group.runCount} {group.runCount === 1 ? "run" : "runs"}
            </span>
            {group.questions.length > 1 && <span data-testid="group-question-count"> · {group.questions.length} questions</span>}
            <span> · last researched {relativeAge(group.lastAt)}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[0.85rem] text-[var(--atlas-text-dim)]">
          <span className="flex items-center gap-1.5" data-testid="group-latest" data-verdict={latest.verdict ?? "NONE"}>
            <span className={`dot dot-${latest.tone}`} aria-hidden />
            {latest.label}
          </span>
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-5 pb-5 pl-1">
          {group.questions.map((q) => (
            <div key={q.key} data-testid="question-group">
              <p className="text-[0.98rem] leading-snug">{q.question}</p>
              <ul className="mt-1.5 flex flex-col">
                {q.runs.map((run) => {
                  const o = jobOutcome(run);
                  return (
                    <li key={run.id}>
                      <Link href={`/research/${run.id}`} data-testid={`run-${run.id}`} className="flex items-center gap-3 py-2 text-[0.9rem] text-[var(--atlas-text-dim)] hover:text-[var(--atlas-text)]">
                        <span className="flex-1">{relativeAge(run.finishedAt ?? run.createdAt)}</span>
                        <span className="flex items-center gap-1.5" data-verdict={o.verdict ?? "NONE"}>
                          <span className={`dot dot-${o.tone}`} aria-hidden />
                          {o.label}
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
