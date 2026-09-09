"use client";

import { PROOF_STATE, type TableColumn, type TableRow } from "./types";

// 5. ANALYTICAL TABLE — SOMETHING AN ANALYST WOULD ACTUALLY INSPECT.
//
// Not a status list with numbers in it: comparable rows over a common set of
// measures, dense enough to scan down a column and compare periods without
// reading a word.
//
// THE MOBILE TREATMENT IS A DECISION, NOT AN ACCIDENT. Six measures cannot
// honestly fit 430px, and the two dishonest answers are dropping columns
// (information disappears with no notice) or letting the table silently push
// the page sideways (which this product has already shipped once and had to
// fix). So the table scrolls INSIDE its own frame, the key column is pinned
// so a row never loses its identity, and a hint says the scroll is there.
// Nothing is hidden and nothing is clipped without saying so.
export function AnalyticalTableBlock({
  title,
  columns,
  rows,
  note,
}: {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  note?: string;
}) {
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-table">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
          {title}
        </p>
        <p className="text-[0.65rem] text-[var(--atlas-text-dim)] lg:hidden" data-testid="table-scroll-hint">
          swipe for all columns →
        </p>
      </div>

      <div className="mt-3 -mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5" data-testid="table-scroller">
        <table className="w-full min-w-[38rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--hairline-strong)]">
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`whitespace-nowrap px-2 pb-2 text-[0.62rem] font-semibold uppercase tracking-[0.06em] text-[var(--atlas-text-dim)] ${
                    c.numeric ? "text-right" : "text-left"
                  } ${i === 0 ? "sticky left-0 z-10 w-[6.5rem] pl-0" : ""}`}
                  style={i === 0 ? { background: "var(--surface-1)" } : undefined}
                >
                  {c.label}
                  {c.unit && <span className="ml-1 normal-case opacity-70">({c.unit})</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="border-b border-[var(--hairline)] last:border-b-0"
                data-testid="table-row"
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={`px-2 py-2 text-[0.78rem] leading-snug ${
                      // Digits stack only if they are the same width and share
                      // an edge — this is most of what makes a column scannable.
                      c.numeric ? "text-right tabular-nums" : "text-left"
                    } ${i === 0 ? "sticky left-0 z-10 w-[6.5rem] whitespace-nowrap pl-0 font-medium" : "text-[var(--atlas-text-dim)]"}`}
                    style={i === 0 ? { background: "var(--surface-1)" } : undefined}
                  >
                    {r.cells[c.key] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {note && (
        <p className="mt-3 border-t border-[var(--hairline)] pt-2.5 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]">
          {note}
        </p>
      )}

      {/* A row whose figures the research did not establish is named here
          rather than quietly rendered as if it were measured. */}
      {rows.some((r) => r.state && r.state !== "ESTABLISHED") && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.65rem]">
          {rows
            .filter((r) => r.state && r.state !== "ESTABLISHED")
            .map((r) => (
              <span key={r.key} style={{ color: PROOF_STATE[r.state!].color }}>
                {r.cells[columns[0].key]} — {PROOF_STATE[r.state!].label.toLowerCase()}
              </span>
            ))}
        </p>
      )}
    </section>
  );
}
