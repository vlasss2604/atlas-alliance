"use client";

import { verdictLabel, verdictTone, type VerdictTone } from "../research-model";

// A verdict is never styled ad hoc. Tone comes from research-model's closed
// mapping, so red can only ever appear for NOT_SUPPORTED — the one verdict
// that positively established something to be false. Missing evidence is
// amber, because absence of evidence is not evidence of absence.
export function VerdictBadge({
  verdict,
  size = "md",
}: {
  verdict: string | null | undefined;
  size?: "sm" | "md";
}) {
  const tone = verdictTone(verdict);
  return (
    <span
      className={`tone tone-${tone} ${size === "sm" ? "text-[0.625rem] px-2.5 py-1" : ""}`}
      data-testid="verdict-badge"
      data-verdict={verdict ?? "NONE"}
      data-tone={tone}
    >
      {verdictLabel(verdict)}
    </span>
  );
}

export function ToneDot({ tone }: { tone: VerdictTone }) {
  return <span className={`dot dot-${tone}`} aria-hidden />;
}
