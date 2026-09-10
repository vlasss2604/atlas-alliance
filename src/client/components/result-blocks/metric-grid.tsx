"use client";

import { PROOF_STATE, type Metric, type MetricAttribution } from "./types";

// 3. KEY MEASURES — FOUR NUMBERS THAT ARE ONE ARGUMENT.
//
// Four headline figures in a row are four unrelated facts, and a reader has
// to reconstruct the economics for themselves. Named and numbered as the
// chain they belong to —
//
//     SOURCE → ALLOCATION → EXECUTION → EFFECT
//
// — they read as the argument the research actually made, and the reader can
// see at a glance which link the evidence reached and which it did not.
//
// THE STATE ON A TILE IS THE STATE OF THE MEASUREMENT, AND NOTHING ELSE.
// This is the rule the block exists to hold. A supply figure measured
// correctly is ESTABLISHED even when the conclusion someone wanted to draw
// from it collapsed; stamping it CONTRADICTED because the story failed makes
// the number itself look unreliable, which is a different — and false —
// claim. So the readings drawn from the strip are lifted out and stated
// underneath it, each in its own words and with its own state.
//
//   MEASURED SUPPLY DECREASE  ≠  MECHANISM CAUSED SUPPLY DECREASE
//   TOKENS ACQUIRED           ≠  VALUE CAPTURE FOR HOLDERS
//
// AND THERE IS MORE THAN ONE SUCH READING, WITH DIFFERENT STATES. A rise in
// total supply CONTRADICTS a net reduction and says nothing whatever about
// whether the mechanism removed tokens — issuance elsewhere can outrun a
// real burn. One row carrying both collapsed a disproof and an open question
// into a single verdict, so `claims` is a list: each proposition the numbers
// invite, named, with the state the evidence actually supports for it.
export function MetricGridBlock({
  metrics,
  claims,
}: {
  metrics: Metric[];
  claims?: MetricAttribution[];
}) {
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-metrics">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
          Key measures
        </p>
        <p className="text-[0.64rem] uppercase tracking-[0.08em] text-[var(--atlas-text-dim)]">
          source → allocation → execution → effect
        </p>
      </div>

      {/* Two up on a phone, four across from `lg`. The chevrons follow the
          reading order in both: between the columns of a 2×2 grid, and
          between every tile of a single row. */}
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {metrics.map((m, i) => {
          const s = PROOF_STATE[m.state];
          return (
            <div
              key={m.label}
              className="relative min-w-0 overflow-hidden rounded-xl border border-[var(--hairline)]"
              style={{ background: "var(--surface-1)" }}
              data-testid="metric-tile"
              data-state={m.state}
            >
              {/* The state, restated as a bar on the top edge — the fast
                  channel. The word for it is four lines below. */}
              <span
                className="absolute inset-x-0 top-0 h-[2px]"
                style={{ background: s.color }}
                aria-hidden
              />
              <div className="px-3 py-3">
                <p className="flex items-center gap-1.5 leading-none">
                  <span className="text-[0.58rem] font-semibold tabular-nums text-[var(--atlas-text-dim)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {m.step && (
                    <span className="text-[0.58rem] font-semibold uppercase tracking-[0.1em] text-[var(--atlas-text-dim)]">
                      {m.step}
                    </span>
                  )}
                </p>

                <p className="mt-2.5 flex items-baseline gap-1 leading-none">
                  <span className="text-[1.42rem] font-semibold tabular-nums tracking-tight sm:text-[1.6rem]">
                    {m.value}
                  </span>
                  {m.unit && (
                    <span className="text-[0.75rem] font-medium text-[var(--atlas-text-dim)]">
                      {m.unit}
                    </span>
                  )}
                </p>

                <p className="mt-1.5 text-[0.78rem] font-medium leading-snug">{m.label}</p>
                <p
                  className="mt-2 text-[0.6rem] font-semibold uppercase leading-tight tracking-[0.05em]"
                  style={{ color: s.color }}
                >
                  {s.label}
                </p>
                {(m.period || m.source) && (
                  <p className="mt-1 text-[0.64rem] leading-snug text-[var(--atlas-text-dim)]">
                    {[m.period, m.source].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>

              {/* THE CHAIN, DRAWN. Shown on every tile but the first from
                  `lg`; on a 2×2 phone grid only on the tiles that really do
                  follow their left-hand neighbour, so an arrow never points
                  backwards across a row break. */}
              {i > 0 && (
                <span
                  className={`absolute -left-[7px] top-1/2 -translate-y-1/2 text-[0.9rem] leading-none text-[var(--atlas-text-dim)] ${
                    i % 2 === 1 ? "block" : "hidden"
                  } lg:block`}
                  aria-hidden
                  data-testid="metric-chain-link"
                >
                  ›
                </span>
              )}
            </div>
          );
        })}
      </div>

      {claims?.map((claim) => (
        <AttributionRow key={claim.label} attribution={claim} />
      ))}
    </section>
  );
}

// A CLAIM THE FOUR TILES ARE NOT ALLOWED TO IMPLY.
//
// Set apart from the strip and tinted with its own state, so it cannot be
// read as a fifth measure. Four sound numbers in a row invite the reader to
// join them into a story; each of these says whether the research actually
// joined them, and — because "disproved" and "not shown" are different
// findings — carries its own state rather than borrowing its neighbour's.
function AttributionRow({ attribution }: { attribution: MetricAttribution }) {
  const s = PROOF_STATE[attribution.state];
  return (
    <div
      className="mt-2.5 rounded-xl border px-3 py-2.5"
      style={{ borderColor: `${s.color}44`, background: s.dim }}
      data-testid="metric-attribution"
      data-state={attribution.state}
    >
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className="text-[0.58rem] font-semibold uppercase tracking-[0.06em]"
          style={{ color: s.color }}
        >
          {s.label}
        </span>
        <span className="text-[0.78rem] font-semibold leading-snug">
          {attribution.label}
        </span>
      </p>
      <p className="mt-1 text-[0.73rem] leading-snug text-[var(--atlas-text-dim)]">
        {attribution.detail}
      </p>
    </div>
  );
}
