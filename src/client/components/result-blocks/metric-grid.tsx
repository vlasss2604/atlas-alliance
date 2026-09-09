"use client";

import { PROOF_STATE, type Metric } from "./types";

// 3. KEY METRICS — THE NUMBER FIRST, AND THE NUMBER LARGEST.
//
// A quantity buried mid-sentence is a quantity nobody reads. Each tile leads
// with the value at display size in tabular figures, with the unit set
// beside it rather than inside it, and everything else — what it measures,
// over what period, how well established, from where — recedes underneath.
//
// EVERY METRIC CARRIES ITS OWN STANDING. A number with no evidence state is
// exactly the kind of confident-looking figure this product exists not to
// produce, so the state is part of the type, not an optional decoration.
export function MetricGridBlock({ metrics }: { metrics: Metric[] }) {
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-metrics">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Key measures
      </p>

      {/* Two up on a phone, four across on a desktop. Tight gaps and shared
          hairlines so the set reads as one instrument panel rather than as
          four separate cards. */}
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-[var(--hairline)] lg:grid-cols-4">
        {metrics.map((m) => {
          const s = PROOF_STATE[m.state];
          return (
            <div
              key={m.label}
              className="px-3 py-3.5"
              style={{ background: "var(--surface-1)" }}
              data-testid="metric-tile"
            >
              <p className="flex items-baseline gap-1 leading-none">
                <span className="text-[1.5rem] font-semibold tabular-nums tracking-tight sm:text-[1.7rem]">
                  {m.value}
                </span>
                {m.unit && (
                  <span className="text-[0.8rem] font-medium text-[var(--atlas-text-dim)]">
                    {m.unit}
                  </span>
                )}
              </p>
              <p className="mt-1.5 text-[0.8rem] font-medium leading-snug">{m.label}</p>
              <p
                className="mt-2 text-[0.62rem] font-semibold uppercase leading-tight tracking-[0.05em]"
                style={{ color: s.color }}
              >
                {s.label}
              </p>
              {(m.period || m.source) && (
                <p className="mt-1 text-[0.65rem] leading-snug text-[var(--atlas-text-dim)]">
                  {[m.period, m.source].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
