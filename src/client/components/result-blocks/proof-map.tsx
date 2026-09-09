"use client";

import { PROOF_STATE, type ProofMapCell } from "./types";

// 2. PROOF MAP — THE SHAPE OF THE RESEARCH, IN ONE GLANCE.
//
// Deliberately NOT a vertical table and NOT one card per component. A
// reader's first question is not "what does each check say" but "how much of
// this actually stands up" — and a grid answers that in about a second,
// where ten stacked rows make them count.
//
// Each cell is a dense tile with a state bar across its top. The bar is the
// fast channel; the word under it is the real one, so the map is still
// readable with no colour at all.
export function ProofMapBlock({ cells }: { cells: ProofMapCell[] }) {
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-proof-map">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
          Proof map
        </p>
        <p className="text-[0.7rem] text-[var(--atlas-text-dim)]">
          {cells.length} checks
        </p>
      </div>

      {/* Two columns on a phone, three from `sm`, five on a wide screen —
          the map should fill its width rather than stretch five tiles across
          a desktop or squeeze them onto a handset. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cells.map((c) => {
          const s = PROOF_STATE[c.state];
          return (
            <div
              key={c.label}
              className="overflow-hidden rounded-lg border border-[var(--hairline)]"
              style={{ background: "var(--surface-1)" }}
              data-testid="proof-cell"
              data-state={c.state}
            >
              <div className="h-[3px] w-full" style={{ background: s.color }} aria-hidden />
              <div className="px-2.5 py-2.5">
                <p className="text-[0.72rem] font-medium uppercase leading-tight tracking-[0.05em] text-[var(--atlas-text-dim)]">
                  {c.label}
                </p>
                <p
                  className="mt-1.5 text-[0.78rem] font-semibold leading-tight"
                  style={{ color: s.color }}
                >
                  {s.label}
                </p>
                {c.note && (
                  <p className="mt-1 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]">
                    {c.note}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
