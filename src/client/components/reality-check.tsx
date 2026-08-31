"use client";

import {
  deriveRealityCheck,
  REALITY_STATE_LABELS,
  type RealityState,
} from "../research-model";

// REALITY CHECK — how far up the ladder this research actually got.
//
// Every rung reads exactly one persisted component result. Nothing here is
// inferred from the verdict, from the evidence count, or from the absence of
// a row: a component with no result is "not assessed", a component with
// insufficient evidence is "could not verify", and ONLY a positively
// CONTRADICTED component is shown as verified-not-happening.
//
// "Reality stops here" is drawn only where research-model says it is safely
// derivable — meaning at least one rung really was verified, so the marker
// describes the end of an established chain rather than implying a failure
// at a rung nothing ever tested.
export function RealityCheck({
  components,
}: {
  components: { component: string; status: string }[];
}) {
  const view = deriveRealityCheck(components);

  return (
    <section className="panel p-5 sm:p-6" data-testid="reality-check">
      <p className="eyebrow eyebrow-violet">Reality check</p>

      {!view.derivable && (
        <p className="mt-3 text-sm text-[var(--atlas-text-dim)]">
          This research has no component results yet, so no rung can be shown as
          verified or unverified.
        </p>
      )}

      <div className="mt-4">
        {view.rungs.map((rung, i) => (
          <div key={rung.key}>
            {view.stopsAtIndex === i && (
              <p className="stop-marker" data-testid="reality-stop">
                Reality stops here
              </p>
            )}
            <div
              className={
                "ladder-row " +
                (rung.state === "VERIFIED"
                  ? "ladder-row-verified"
                  : rung.state === "NOT_ASSESSED"
                    ? "ladder-row-dim"
                    : "")
              }
              data-rung={rung.key}
              data-state={rung.state}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <RungIcon state={rung.state} />
                <span
                  className={
                    "truncate text-[0.9rem] " +
                    (rung.state === "VERIFIED"
                      ? "text-[var(--atlas-text)]"
                      : "text-[var(--atlas-text-dim)]")
                  }
                >
                  {rung.label}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[0.7rem] text-[var(--atlas-text-dim)]">
                {REALITY_STATE_LABELS[rung.state]}
                <span className={`dot ${stateDot(rung.state)}`} aria-hidden />
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function stateDot(state: RealityState): string {
  switch (state) {
    case "VERIFIED":
      return "dot-supported";
    case "PARTIAL":
      return "dot-partial";
    case "NOT_HAPPENING":
      return "dot-negative";
    default:
      return "dot-neutral";
  }
}

function RungIcon({ state }: { state: RealityState }) {
  if (state === "VERIFIED") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[rgba(45,212,191,0.5)] bg-[rgba(13,42,45,0.8)] text-[#5eead4]">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="m2.5 6.3 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === "NOT_HAPPENING") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[rgba(248,113,113,0.5)] bg-[rgba(45,14,16,0.8)] text-[#fca5a5]">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (state === "PARTIAL") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[rgba(167,139,250,0.5)] bg-[rgba(30,22,54,0.8)] text-[#c4b5fd]">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[var(--hairline)] bg-[rgba(10,20,34,0.8)]">
      <span className="dot dot-neutral h-1.5 w-1.5" aria-hidden />
    </span>
  );
}
