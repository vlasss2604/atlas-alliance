"use client";

import { PROOF_STATE, type ProofMapCell, type ProofState } from "./types";

// 2. PROOF MAP — HOW MUCH OF THE CLAIM ACTUALLY STANDS UP.
//
// It answers ONE question — "what parts of this economic claim are
// established?" — and it has to answer it before the reader has read a word,
// which is why it opens with a coverage bar: one segment per check, in the
// order of the argument, coloured by state. The shape of that bar IS the
// answer, and the counts under it say the same thing in words.
//
// IT IS NOT A TABLE, AND IT IS NOT FIVE CARDS. Five boxed tiles read as five
// separate findings and cost a whole screen on a handset; five table rows
// read as data to be studied. These are hairline rows with a coloured spine
// — an index into the argument, which is what a map is.
//
// IT RENDERS NO FRAME OF ITS OWN — the masthead panel wraps it beside the
// answer, so the first screen carries the answer AND its coverage.
const ORDER: ProofState[] = [
  "ESTABLISHED",
  "PARTLY_ESTABLISHED",
  "NOT_ESTABLISHED",
  "CONTRADICTED",
];

export function ProofMapBlock({ cells }: { cells: ProofMapCell[] }) {
  // Arithmetic over the cells above and nothing else. The map does not know
  // a fifth fact about the research; it counts what it was handed.
  const counts = ORDER.map((state) => ({
    state,
    n: cells.filter((c) => c.state === state).length,
  })).filter((c) => c.n > 0);

  return (
    <section className="min-w-0" data-testid="block-proof-map">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
          Proof map
        </p>
        <p className="text-[0.68rem] text-[var(--atlas-text-dim)]">
          {cells.length} checks
        </p>
      </div>

      {/* THE COVERAGE BAR. Segments are equal width because each check is
          one check — weighting them by anything would be a claim about
          importance that no evidence supports. */}
      <div
        className="mt-2.5 flex gap-1"
        role="img"
        aria-label={counts
          .map((c) => `${c.n} ${PROOF_STATE[c.state].label.toLowerCase()}`)
          .join(", ")}
        data-testid="proof-coverage"
      >
        {cells.map((c) => (
          <span
            key={c.label}
            className="h-1.5 flex-1 rounded-full"
            style={{ background: PROOF_STATE[c.state].color }}
          />
        ))}
      </div>

      {/* The bar restated in words, so colour is never the only carrier. */}
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.63rem] font-medium">
        {counts.map((c) => (
          <span key={c.state} style={{ color: PROOF_STATE[c.state].color }}>
            {c.n} {PROOF_STATE[c.state].label.toLowerCase()}
          </span>
        ))}
      </p>

      <ul className="mt-3 flex flex-col gap-1.5">
        {cells.map((c) => {
          const s = PROOF_STATE[c.state];
          return (
            <li
              key={c.label}
              className="rounded-r-md border-l-2 py-1 pl-2.5"
              style={{ borderColor: s.color, background: s.dim }}
              data-testid="proof-cell"
              data-state={c.state}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[0.76rem] font-medium leading-tight">{c.label}</p>
                {c.evidenceRef && (
                  <span className="shrink-0 text-[0.58rem] uppercase tracking-[0.05em] text-[var(--atlas-text-dim)]">
                    {c.evidenceRef}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[0.65rem] leading-snug">
                <span className="font-semibold" style={{ color: s.color }}>
                  {s.label}
                </span>
                {c.note && (
                  <span className="text-[var(--atlas-text-dim)]"> · {c.note}</span>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
