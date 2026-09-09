"use client";

import { PROOF_STATE, type ChartPoint } from "./types";

// 6. QUANTITATIVE VIEW — A CHART THAT KEEPS THE PRODUCT'S DISCIPLINE.
//
// WRITTEN AS INLINE SVG, WITH NO CHARTING DEPENDENCY. The repository has
// none, and one bar chart does not justify pulling a framework into a
// product that ships to a Telegram Mini App. Everything here is ~90 lines of
// geometry; if the result language later needs several chart forms, that is
// the point to discuss a library rather than now.
//
// THE RULE THIS CHART EXISTS TO DEMONSTRATE: a period ATLAS did not
// establish is drawn as an EMPTY SLOT, never as a zero. A zero is a
// measurement — "no tokens were acquired" — and it is a different claim from
// "this research could not establish how many were". Charts make that
// substitution constantly and silently; this one refuses to.
//
// Single series, so no legend: the title names it. Values are labelled
// directly on each bar, which lets the y-axis go away entirely.
const VIEW_W = 600;
const VIEW_H = 300;
const PAD_X = 10;
const PAD_TOP = 46;
const PAD_BOTTOM = 48;
const BAR_W = 46;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;
const DATA_COLOR = "#2dd4bf";

// A bar is anchored to the baseline, so only its top corners are rounded —
// a fully rounded rect floats and reads as a pill rather than a magnitude.
function topRoundedBar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h / 2, w / 2);
  return `M ${x} ${y + h} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h} Z`;
}

export function QuantChartBlock({
  title,
  unit,
  period,
  source,
  points,
}: {
  title: string;
  unit: string;
  period: string;
  source: string;
  points: ChartPoint[];
}) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = values.length > 0 ? Math.max(...values) : 1;
  const slot = (VIEW_W - PAD_X * 2) / points.length;
  const baseline = PAD_TOP + PLOT_H;

  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-chart">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        {title}
      </p>
      <p className="mt-1 text-[0.75rem] text-[var(--atlas-text-dim)]">
        {unit} · {period}
      </p>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="mt-2 block h-auto w-full"
        role="img"
        aria-label={`${title}. ${unit}, ${period}.`}
        data-testid="chart-svg"
      >
        {/* A single recessive baseline. No gridlines: with values written on
            the bars there is nothing left for a grid to help read. */}
        <line
          x1={PAD_X}
          y1={baseline}
          x2={VIEW_W - PAD_X}
          y2={baseline}
          stroke="var(--hairline-strong)"
          strokeWidth={1}
        />
        {points.map((p, i) => {
          const cx = PAD_X + slot * i + slot / 2;
          const x = cx - BAR_W / 2;
          const established = p.value !== null;
          const h = established ? Math.max(3, (p.value! / max) * PLOT_H) : PLOT_H;
          const y = baseline - h;
          const color = established ? DATA_COLOR : PROOF_STATE[p.state].color;
          return (
            <g key={p.label} data-testid="chart-bar" data-state={p.state}>
              {/* Native tooltip: hover reaches the reader with no JS and no
                  library. */}
              {/* ONE STRING, NOT THREE CHILDREN. React renders a <title>
                  child array as a warning rather than a tooltip, so the
                  whole label is interpolated in one go. */}
              <title>{`${p.label}: ${established ? `${p.value} ${unit}` : PROOF_STATE[p.state].label}`}</title>
              {established ? (
                <path d={topRoundedBar(x, y, BAR_W, h)} fill={color} />
              ) : (
                // AN EMPTY SLOT, FULL HEIGHT. It occupies the space a
                // measurement would have occupied and holds nothing, which is
                // exactly the claim being made.
                <rect
                  x={x}
                  y={PAD_TOP}
                  width={BAR_W}
                  height={PLOT_H}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  opacity={0.7}
                  rx={4}
                />
              )}
              {/* SET ON TWO LINES WHEN THERE IS NO VALUE. On one line
                  "not established" is wider than the slot it labels, and on
                  the last slot it ran off the right edge of the viewBox. */}
              {established ? (
                <text
                  x={cx}
                  y={y - 12}
                  textAnchor="middle"
                  fontSize={19}
                  fontWeight={600}
                  fill="var(--atlas-text)"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {p.value}
                </text>
              ) : (
                <text
                  x={cx}
                  y={PAD_TOP - 20}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={600}
                  fill={color}
                >
                  <tspan x={cx} dy="0">not</tspan>
                  <tspan x={cx} dy="14">established</tspan>
                </text>
              )}
              <text
                x={cx}
                y={baseline + 26}
                textAnchor="middle"
                fontSize={17}
                fill="var(--atlas-text-dim)"
              >
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>

      <p className="mt-2 border-t border-[var(--hairline)] pt-2.5 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]">
        {source}
      </p>
    </section>
  );
}
