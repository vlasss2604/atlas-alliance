"use client";

import { type KeyFinding, type UnresolvedItem, type VerdictTone } from "../research-model";

// THE STATUS COLOURS, AND WHY THIS IS NOT A `.tone` PILL.
//
// The index first rendered each state as the product's tone pill. `.tone`
// sets `white-space: nowrap`, so "PARTLY ESTABLISHED" became a 161px pill
// inside a 124px cell and pushed 4px past the right edge of a 430px
// viewport — `table-fixed` bounds the TABLE, it cannot bound a child that
// refuses to wrap. A pill is right for one headline verdict and wrong for
// a dense ten-row index.
//
// This is the treatment the ladder already gives its own row states:
// weight and case, no chip, and text that wraps. So the index matches the
// surface directly below it and can never overflow again.
//
// The four values are the ladder's `stateColor` mapping, and a test reads
// both files to keep them identical. Red belongs to a positive
// contradiction alone; missing evidence is amber.
const TONE_COLORS: Record<VerdictTone, string> = {
  supported: "#5eead4",
  partial: "#c4b5fd",
  negative: "#fca5a5",
  insufficient: "#fcd34d",
  fault: "#cbd5e1",
  neutral: "#cbd5e1",
};

// THE TOP OF A FINISHED RESULT — UNDERSTANDING BEFORE PROOF.
//
// A reader arriving at a finished research had one compact answer and then,
// immediately, the Proof: the ladder, the evidence, the audit. Everything
// needed to CHECK the work was there, and nothing that let them GRASP it
// first. This layer sits above all of that and removes nothing from it.
//
//   STATUS INDEX — every assessed check and how far the evidence got, as a
//   scannable two-column map. It is an INDEX, not a summary: it says where
//   to look, and the ladder below says what was found.
//
//   STILL OPEN — at most three checks that came back short, worded so
//   absence of evidence never reads as evidence of absence.
//
// MOBILE FIRST, AND LEARNED THE HARD WAY. The index carried a third column
// of derived sentences. On the 430px viewport this product actually ships
// to, the table needed 544px inside a 364px panel, so that column — the
// only one carrying substance — sat off-screen behind a sideways scroll.
// It is gone, and nothing here may reintroduce a fixed minimum width: the
// table is `table-fixed w-full`, both cells wrap, and there is no
// horizontal scroll container to hide in.
//
// IT DECIDES NOTHING. Every value is derived in `research-model` from
// persisted component statuses and the coverage classification. No status
// is computed here, no wording is written here, and no free-text evidence
// summary reaches here — so a source's own sentence can never be promoted
// into an ATLAS conclusion at the top of the page, where it would have no
// attribution to sit beside.
export function ResultBriefing({
  keyFindings,
  unresolved,
  unresolvedMore,
}: {
  keyFindings: KeyFinding[];
  unresolved: UnresolvedItem[];
  unresolvedMore: number;
}) {
  if (keyFindings.length === 0 && unresolved.length === 0) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="result-briefing">
      {keyFindings.length > 0 && (
        <section className="panel px-4 py-3.5 sm:px-6 sm:py-4" data-testid="key-findings">
          <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
            What was checked
          </p>

          {/* `table-fixed` + `w-full` and no min-width: the table can never
              be wider than its panel, and every child wraps, so no viewport
              can push a column out of view.
              SIZED SO MOST LABELS HOLD ONE LINE.
              At 430px the panel gives ~360px of content; 66% of that is
              wide enough for the longest claim label at this size, so a
              row is one line tall and the ten of them read as a list
              rather than a wall. A label that does wrap still cannot
              widen the table — `table-fixed` guarantees that. */}
          <table className="mt-2.5 w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[66%]" />
              <col className="w-[34%]" />
            </colgroup>
            <tbody>
              {keyFindings.map((f) => (
                <tr
                  key={f.component}
                  className="border-t border-[var(--hairline)] first:border-t-0"
                  data-testid="key-finding-row"
                  data-component={f.component}
                >
                  <td className="py-1.5 pr-2 text-[0.78rem] font-medium leading-snug">
                    {f.check}
                  </td>
                  <td className="py-1.5 text-right">
                    <span
                      className="text-[0.6rem] font-semibold uppercase leading-tight tracking-[0.04em]"
                      style={{ color: TONE_COLORS[f.tone] }}
                      data-testid="key-finding-result"
                    >
                      {f.result}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* STILL OPEN — NEVER "THIS DOES NOT HAPPEN".
          Every sentence here describes the EVIDENCE. A check that came back
          short means ATLAS did not find enough to establish the claim; it is
          not a finding that the claim is false. The amber tone is the
          product's "unresolved", deliberately not the red it reserves for a
          positive contradiction. */}
      {unresolved.length > 0 && (
        <section className="panel px-4 py-3.5 sm:px-6 sm:py-4" data-testid="unresolved-section">
          <p className="eyebrow" style={{ color: "#fcd34d" }}>
            Still open
          </p>
          <p className="mt-1 text-[0.78rem] leading-snug text-[var(--atlas-text-dim)]">
            Not enough evidence to settle these — not a finding that they are untrue.
          </p>
          <ul className="mt-2.5 flex flex-col gap-2">
            {unresolved.map((u) => (
              <li
                key={u.component}
                className="border-t border-[var(--hairline)] pt-2 first:border-t-0 first:pt-0"
                data-testid="unresolved-item"
                data-component={u.component}
              >
                <p className="text-[0.82rem] font-medium leading-snug">{u.label}</p>
                <p className="mt-0.5 text-[0.78rem] leading-snug text-[var(--atlas-text-dim)]">
                  {u.detail}
                </p>
                {u.blocked && (
                  <p className="mt-0.5 text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">
                    A limit of the research run, not evidence for or against the project.
                  </p>
                )}
              </li>
            ))}
          </ul>
          {/* NOTHING IS HIDDEN, ONLY DEFERRED. The remaining open checks are
              named in the index above and read in full in the ladder below,
              so this points at them rather than repeating them. */}
          {unresolvedMore > 0 && (
            <p
              className="mt-2.5 border-t border-[var(--hairline)] pt-2 text-[0.73rem] text-[var(--atlas-text-dim)]"
              data-testid="unresolved-more"
            >
              and {unresolvedMore} more below
            </p>
          )}
        </section>
      )}
    </div>
  );
}
