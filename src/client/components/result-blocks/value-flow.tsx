"use client";

import { PROOF_STATE, type FlowStage } from "./types";

// 4. MECHANISM / VALUE FLOW — RESEARCH LOGIC, NOT AN INFOGRAPHIC.
//
// The one thing this diagram must do is show WHERE THE PROOF STOPS. A chain
// drawn in one uniform style says "all of this happens", which is precisely
// the claim ATLAS refuses to make when a step is unproven — so the
// connectors carry the argument:
//
//   solid  — the evidence carried from one stage to the next;
//   dashed — it carried only in part;
//   broken — it did not carry, and a marker says so in words.
//
// EVERYTHING PAST THE BREAK IS DIMMED. Not hidden: the stages are still
// claims the mechanism makes, and hiding them would misreport the mechanism.
// Dimmed, because after the break they are no longer things this research
// established, and they must not read as if they were.
export function ValueFlowBlock({ stages }: { stages: FlowStage[] }) {
  // The first stage the evidence did not fully reach. Everything after it is
  // downstream of a gap, however good its own row looks.
  const breakAt = stages.findIndex((s) => s.state !== "ESTABLISHED");

  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-flow">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        How the value moves
      </p>
      <p className="mt-1 text-[0.75rem] leading-snug text-[var(--atlas-text-dim)]">
        Each step is a separate claim. The link between two steps is drawn only as far as
        the evidence carried.
      </p>

      {/* One markup, two directions: a vertical rail on a phone, a
          left-to-right chain from `lg`. The connectors flip axis with it. */}
      <div className="mt-4 flex flex-col lg:flex-row lg:items-stretch" data-testid="flow-chain">
        {stages.map((stage, i) => {
          const s = PROOF_STATE[stage.state];
          const downstream = breakAt !== -1 && i > breakAt;
          const prev = i > 0 ? stages[i - 1] : null;
          return (
            <div
              key={stage.label}
              className="flex min-w-0 flex-col lg:flex-1 lg:flex-row lg:items-center"
            >
              {i > 0 && (
                <FlowConnector from={prev!} to={stage} firstBreak={i === breakAt} />
              )}
              <div
                className={`min-w-0 rounded-lg border px-3 py-2 lg:flex-1 ${downstream ? "opacity-55" : ""}`}
                style={{
                  background: downstream ? "transparent" : "var(--surface-1)",
                  borderColor: downstream ? "var(--hairline)" : s.dim.replace("0.1", "0.3"),
                }}
                data-testid="flow-stage"
                data-state={stage.state}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  <p className="text-[0.78rem] font-semibold leading-tight">{stage.label}</p>
                </div>
                <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                  <span
                    className="text-[0.6rem] font-semibold uppercase tracking-[0.05em]"
                    style={{ color: s.color }}
                  >
                    {s.label}
                  </span>
                  {stage.detail && (
                    <span className="text-[0.66rem] leading-snug text-[var(--atlas-text-dim)]">
                      {stage.detail}
                    </span>
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// THE LINK IS THE ARGUMENT. Its style comes from the stage it leads INTO,
// because that is the claim the evidence either reached or did not.
//
// ONLY THE FIRST BREAK IS LABELLED. Once the chain is broken every later
// link is broken too, and three "evidence stops here" chips in a row say the
// same thing three times while pricing the desktop layout out of its width.
// The first one is the finding; the rest is the dimming already showing.
//
// AND THE LABEL COSTS NO WIDTH ON DESKTOP. Set inline it added ~110px to a
// six-stage chain and pushed 167px past a 1024px viewport; it is absolutely
// positioned under the link there, and inline only in the vertical layout
// where there is room for it.
function FlowConnector({
  from,
  to,
  firstBreak,
}: {
  from: FlowStage;
  to: FlowStage;
  firstBreak: boolean;
}) {
  const carried = from.state === "ESTABLISHED" && to.state === "ESTABLISHED";
  const stops = to.state === "NOT_ESTABLISHED" || to.state === "CONTRADICTED";
  const color = PROOF_STATE[to.state].color;

  return (
    <div
      className="relative flex shrink-0 items-center gap-2 py-1 pl-3 lg:flex-col lg:px-1.5 lg:py-0 lg:pl-0"
      data-testid="flow-connector"
      data-carried={carried ? "true" : "false"}
    >
      <span
        className="block h-4 w-px lg:h-px lg:w-6"
        style={{
          background: carried
            ? color
            : `repeating-linear-gradient(${carried ? "0deg" : "180deg"}, ${color} 0 3px, transparent 3px 6px)`,
          opacity: stops ? 0.75 : 1,
        }}
        aria-hidden
      />
      {/* The break is stated in words, not left to the reader to infer from
          a dash pattern. */}
      {stops && firstBreak && (
        <span
          className="whitespace-nowrap rounded px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.05em] lg:absolute lg:left-1/2 lg:top-full lg:mt-1.5 lg:-translate-x-1/2"
          style={{ color, background: PROOF_STATE[to.state].dim }}
          data-testid="flow-break"
        >
          Evidence stops here
        </span>
      )}
    </div>
  );
}
