"use client";

import {
  componentLabel,
  componentStatusLabel,
  componentTone,
} from "../research-model";

// KEY COMPONENTS — the parts of the value chain this research examined,
// named the way a reader would name them and carrying the status S5
// persisted. Engineering reason codes are deliberately NOT shown here; they
// live in Developer details, where they belong.
export function ComponentStatusCard({
  component,
  status,
  evidenceCount,
}: {
  component: string;
  status: string;
  evidenceCount: number;
}) {
  const tone = componentTone(status);
  return (
    <div
      className="row-card p-4"
      data-testid={`component-${component}`}
      data-status={status}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.9rem] font-medium">{componentLabel(component)}</p>
        <span className={`dot dot-${tone} mt-1.5`} aria-hidden />
      </div>
      <p className={`mt-2 text-[0.78rem] tone-text-${tone}`} style={toneStyle(tone)}>
        {componentStatusLabel(status)}
      </p>
      <p className="mt-1 text-[0.72rem] text-[var(--atlas-text-dim)]">
        {evidenceCount === 0
          ? "No admissible evidence"
          : `${evidenceCount} evidence ${evidenceCount === 1 ? "item" : "items"}`}
      </p>
    </div>
  );
}

function toneStyle(tone: string): React.CSSProperties {
  switch (tone) {
    case "supported":
      return { color: "#5eead4" };
    case "partial":
      return { color: "#c4b5fd" };
    case "negative":
      return { color: "#fca5a5" };
    default:
      return { color: "#fcd34d" };
  }
}
