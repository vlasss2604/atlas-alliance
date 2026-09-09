"use client";

import { PROOF_STATE, type ProofState } from "./types";

// 10. DEEP PROOF — THE HANDOVER FROM UNDERSTANDING TO VERIFICATION.
//
// Everything above answers the question. This is where a reader who wants to
// check the work goes, and the transition should feel like changing surface,
// not like more of the same page. So it is set apart: a divider, a change of
// register, and rows that are plainly an index into the existing detail
// rather than another analytical block.
export function DeepProofEntryBlock({
  rows,
}: {
  rows: { label: string; state: ProofState; sources: number }[];
}) {
  return (
    <section data-testid="block-deep-proof">
      <div className="flex items-center gap-3 px-1">
        <span className="h-px flex-1" style={{ background: "var(--hairline-strong)" }} aria-hidden />
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
          Verification layer
        </p>
        <span className="h-px flex-1" style={{ background: "var(--hairline-strong)" }} aria-hidden />
      </div>

      <div className="panel mt-3 px-4 py-4 sm:px-5">
        <p className="text-[0.8rem] leading-snug text-[var(--atlas-text-dim)]">
          Above is what the research concluded. Below is every step of why — each finding
          with the sources behind it, what they were refused for, and the full audit.
        </p>

        <ul className="mt-3 flex flex-col">
          {rows.map((r) => {
            const s = PROOF_STATE[r.state];
            return (
              <li
                key={r.label}
                className="flex items-center gap-3 border-t border-[var(--hairline)] py-2.5 first:border-t-0"
                data-testid="deep-proof-row"
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 text-[0.8rem] font-medium leading-snug">
                  {r.label}
                </span>
                <span
                  className="shrink-0 text-[0.58rem] font-semibold uppercase tracking-[0.05em]"
                  style={{ color: s.color }}
                >
                  {s.label}
                </span>
                <span className="w-16 shrink-0 text-right text-[0.65rem] tabular-nums text-[var(--atlas-text-dim)]">
                  {r.sources} src
                </span>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 border-t border-[var(--hairline)] pt-3 text-[0.75rem] text-[var(--atlas-text-dim)]">
          Full research audit →
        </p>
      </div>
    </section>
  );
}
