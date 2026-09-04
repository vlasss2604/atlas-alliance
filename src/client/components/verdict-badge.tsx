"use client";

import {
  jobOutcome,
  verdictLabel,
  verdictTone,
  type JobState,
  type VerdictTone,
} from "../research-model";

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

// What a RUN ended as — a verdict when there is one, and otherwise the real
// lifecycle outcome in product language. A broken run reads "Research failed"
// in its own tone; it is never dressed up as a finding, and "no proof" (an
// implementation detail) never reaches a reader.
export function OutcomeBadge({
  job,
  size = "md",
}: {
  job: { state: JobState; verdict?: string | null };
  size?: "sm" | "md";
}) {
  const outcome = jobOutcome(job);
  return (
    <span
      className={`tone tone-${outcome.tone} ${size === "sm" ? "text-[0.625rem] px-2.5 py-1" : ""}`}
      data-testid="outcome-badge"
      data-outcome={outcome.kind}
      data-verdict={outcome.verdict ?? "NONE"}
      data-tone={outcome.tone}
    >
      {outcome.label}
    </span>
  );
}

export function ToneDot({ tone }: { tone: VerdictTone }) {
  return <span className={`dot dot-${tone}`} aria-hidden />;
}
