"use client";

import { useState } from "react";

import { componentLabel } from "../research-model";

// COULD NOT VERIFY — one panel, one line per gap.
//
// Ten near-identical cards is a wall a reader skips; a compact list they can
// scan and open is the same information they will actually read. Nothing is
// hidden: every unresolved component still appears, and each line expands to
// the same explanation it carried before.
//
// A gap is a research FINDING, not an error and not a promise to keep
// looking. The product does not monitor anything, so the copy never says it
// does — and an unresolved component never becomes a claim that the thing is
// absent.
export function GapsPanel({
  gaps,
}: {
  gaps: { patternStep: number; component: string; status: string }[];
}) {
  if (gaps.length === 0) return null;
  return (
    <section className="panel p-5 sm:p-6" data-testid="gaps-panel">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "#fcd34d" }}>
          Could not verify
        </p>
        <span className="text-[0.72rem] text-[var(--atlas-text-dim)]">
          {gaps.length} {gaps.length === 1 ? "finding" : "findings"}
        </span>
      </div>
      <p className="mt-2 text-[0.78rem] leading-snug text-[var(--atlas-text-dim)]">
        ATLAS looked for these and the admissible evidence did not establish them.
        That is not the same as establishing that they are false.
      </p>
      <ul className="mt-3 flex flex-col">
        {gaps.map((g) => (
          <GapRow key={`${g.patternStep}:${g.component}`} component={g.component} />
        ))}
      </ul>
    </section>
  );
}

function GapRow({ component }: { component: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-[var(--hairline)] last:border-b-0" data-testid="gap-row">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 py-2.5 text-left"
      >
        <span className="dot dot-insufficient" aria-hidden />
        <span className="flex-1 text-[0.88rem]">{componentLabel(component)}</span>
        <span
          className={`shrink-0 text-[var(--atlas-text-dim)] transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && (
        <p className="pb-3 pl-5 pr-2 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]">
          ATLAS could not verify {componentLabel(component).toLowerCase()} from the
          sources it was able to admit for this research.
        </p>
      )}
    </li>
  );
}
