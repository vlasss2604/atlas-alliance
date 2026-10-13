"use client";

import { PROOF_STATE, type ChartPoint } from "./types";

// 6. QUANTITATIVE VIEW — A CHART THAT KEEPS THE PRODUCT'S DISCIPLINE.
//
// WRITTEN AS INLINE SVG, WITH NO CHARTING DEPENDENCY. The repository has
// none, and one bar chart does not justify pulling a framework into a
// product that ships to a Telegram Mini App. Everything here is geometry; if
// the result language later needs several chart forms, that is the point to
// discuss a library rather than now.
//
// IT NO LONGER REDRAWS A COLUMN OF THE TABLE. A single series plotted beside
// the table it came from told the reader nothing the table had not; the
// chart earns its place by carrying the COMPARISON the table makes you do in
// your head — what was acquired against what was actually removed. That
// divergence is the analytical point of this result, and it is visible here
// in about a second and nowhere else on the page.
//
// So the two blocks now do different jobs: the chart is for recognising a
// shape, the table is for exact values, periods and how well established
// each one is.
//
// THE RULE THIS CHART EXISTS TO DEMONSTRATE: a period ATLAS did not
// establish is drawn as an EMPTY SLOT, never as a zero. A zero is a
// measurement — "no tokens were burned" — and it is a different claim from
// "this research could not establish how many were". The fixture puts both
// in adjacent slots on purpose: P5 is a measured zero and draws as a real
// bar at the baseline with a real 0 on it; P6 is unknown and draws as an
// outline with the words "not established" in it.
const VIEW_W = 600;
const VIEW_H = 300;
const PAD_X = 12;
const PAD_TOP = 46;
const PAD_BOTTOM = 48;
const BAR_W = 32;
const BAR_GAP = 7;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: ChartPoint[];
}

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
  series,
}: {
  title: string;
  unit: string;
  period: string;
  source: string;
  series: ChartSeries[];
}) {
  const labels = series[0]?.points.map((p) => p.label) ?? [];
  const values = series
    .flatMap((s) => s.points.map((p) => p.value))
    .filter((v): v is number => v !== null);
  const max = values.length > 0 ? Math.max(...values) : 1;
  const slot = (VIEW_W - PAD_X * 2) / Math.max(labels.length, 1);
  const baseline = PAD_TOP + PLOT_H;
  const groupW = series.length * BAR_W + (series.length - 1) * BAR_GAP;

  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-chart">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        {title}
      </p>
      <p className="mt-1 text-[0.75rem] text-[var(--atlas-text-dim)]">
        {unit} · {period}
      </p>

      {/* TWO SERIES NEED A LEGEND, and the legend is words with a swatch
          rather than a swatch alone. */}
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.68rem]" data-testid="chart-legend">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-[2px]"
              style={{ background: s.color }}
              aria-hidden
            />
            <span className="text-[var(--atlas-text-dim)]">{s.label}</span>
          </span>
        ))}
      </p>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="mt-2 block h-auto w-full"
        role="img"
        aria-label={`${title}. ${unit}, ${period}. ${series.map((s) => s.label).join(" and ")}.`}
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
        {labels.map((label, i) => {
          const cx = PAD_X + slot * i + slot / 2;
          const points = series.map((s) => s.points[i]);
          // A period is unknown only when NO series established anything in
          // it. One series measuring zero while the other measured a value
          // is not an unknown period, and must not be drawn as one.
          const unknown = points.every((p) => !p || p.value === null);

          if (unknown) {
            const state = points[0]?.state ?? "NOT_ESTABLISHED";
            const color = PROOF_STATE[state].color;
            return (
              <g key={label} data-testid="chart-slot" data-state={state}>
                {/* AN EMPTY SLOT, FULL HEIGHT. It occupies the space a
                    measurement would have occupied and holds nothing, which
                    is exactly the claim being made. */}
                <title>{`${label}: ${PROOF_STATE[state].label}`}</title>
                <rect
                  x={cx - groupW / 2}
                  y={PAD_TOP}
                  width={groupW}
                  height={PLOT_H}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  opacity={0.7}
                  rx={4}
                />
                {/* SET ON TWO LINES. On one line "not established" is wider
                    than the slot it labels, and on the last slot it ran off
                    the right edge of the viewBox. */}
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
                <text
                  x={cx}
                  y={baseline + 26}
                  textAnchor="middle"
                  fontSize={16}
                  fill="var(--atlas-text-dim)"
                >
                  {label}
                </text>
              </g>
            );
          }

          return (
            <g key={label} data-testid="chart-slot" data-state="ESTABLISHED">
              {series.map((s, j) => {
                const p = s.points[i];
                if (!p || p.value === null) return null;
                const x = cx - groupW / 2 + j * (BAR_W + BAR_GAP);
                // A measured zero still gets a visible mark: it is a
                // finding, and an invisible finding reads as a missing one.
                const h = Math.max(3, (p.value / max) * PLOT_H);
                const y = baseline - h;
                return (
                  <g key={s.key} data-testid="chart-bar" data-series={s.key} data-state={p.state}>
                    {/* ONE STRING, NOT THREE CHILDREN. React renders a
                        <title> child array as a warning rather than a
                        tooltip, so the whole label is interpolated at once. */}
                    <title>{`${label} · ${s.label}: ${p.value} ${unit}`}</title>
                    <path d={topRoundedBar(x, y, BAR_W, h)} fill={s.color} />
                    <text
                      x={x + BAR_W / 2}
                      y={y - 9}
                      textAnchor="middle"
                      fontSize={16}
                      fontWeight={600}
                      fill="var(--atlas-text)"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {p.value.toFixed(1)}
                    </text>
                  </g>
                );
              })}
              <text
                x={cx}
                y={baseline + 26}
                textAnchor="middle"
                fontSize={16}
                fill="var(--atlas-text-dim)"
              >
                {label}
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
