"use client";

import { PROOF_STATE, type TimelineEvent } from "./types";

// 7. TIMELINE — THE FOUR CLAIMS ATLAS REFUSES TO CONFLATE.
//
// A mechanism being DOCUMENTED is not it being APPROVED, which is not it
// being ACTIVATED, which is not it EXECUTING. Collapsing those is the single
// most common way a token mechanism gets overstated, and a plain list of
// dates collapses them by default.
//
// So the milestone KIND gets its own glyph as well as its own word: a square
// for what was written down, a diamond for what was authorised, a ring for
// what was switched on, a filled dot for what was observed running. Shape
// and text both carry it, so the distinction survives without colour.
const KIND_LABEL: Record<TimelineEvent["kind"], string> = {
  DOCUMENTED: "Documented",
  APPROVED: "Approved",
  ACTIVATED: "Activated",
  EXECUTED: "Executed",
};

function KindGlyph({ kind, color }: { kind: TimelineEvent["kind"]; color: string }) {
  const common = { stroke: color, strokeWidth: 1.6, fill: "none" };
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden className="shrink-0">
      {kind === "DOCUMENTED" && <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" {...common} />}
      {kind === "APPROVED" && <rect x="7" y="1.2" width="8" height="8" rx="1.2" transform="rotate(45 7 1.2)" {...common} />}
      {kind === "ACTIVATED" && <circle cx="7" cy="7" r="4.6" {...common} />}
      {kind === "EXECUTED" && <circle cx="7" cy="7" r="4.6" fill={color} stroke={color} />}
    </svg>
  );
}

export function ResearchTimelineBlock({ events }: { events: TimelineEvent[] }) {
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-timeline">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Research timeline
      </p>
      <p className="mt-1 text-[0.75rem] leading-snug text-[var(--atlas-text-dim)]">
        Written down, authorised, switched on and observed running are four different
        claims. Each is dated separately.
      </p>

      <ol className="mt-4 flex flex-col" data-testid="timeline-list">
        {events.map((e, i) => {
          const s = PROOF_STATE[e.state];
          const last = i === events.length - 1;
          return (
            <li key={e.label} className="flex gap-3" data-testid="timeline-event" data-kind={e.kind}>
              {/* The rail: glyph, then a segment down to the next event. */}
              <div className="flex shrink-0 flex-col items-center">
                <KindGlyph kind={e.kind} color={s.color} />
                {!last && (
                  <span
                    className="mt-1 w-px flex-1"
                    style={{ background: "var(--hairline-strong)", minHeight: "1.6rem" }}
                    aria-hidden
                  />
                )}
              </div>
              <div className={last ? "pb-0" : "pb-4"}>
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[0.7rem] tabular-nums text-[var(--atlas-text-dim)]">
                    {e.date}
                  </span>
                  <span
                    className="text-[0.58rem] font-semibold uppercase tracking-[0.06em]"
                    style={{ color: s.color }}
                  >
                    {KIND_LABEL[e.kind]}
                  </span>
                </p>
                <p className="mt-0.5 text-[0.83rem] font-medium leading-snug">{e.label}</p>
                {e.note && (
                  <p className="mt-0.5 text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">
                    {e.note}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
