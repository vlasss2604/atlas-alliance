"use client";

import { type KeyFinding, type UnresolvedItem } from "../research-model";

// THE TOP OF A FINISHED RESULT — UNDERSTANDING BEFORE PROOF.
//
// A reader arriving at a finished research had one compact answer and then,
// immediately, the Proof: the ladder, the evidence, the audit. Everything
// needed to CHECK the work was there, and nothing that let them GRASP it
// first. This layer sits above all of that and removes nothing from it.
//
//   KEY FINDINGS — every assessed check, its state, and what the evidence
//   reached, in one scannable table.
//
//   STILL OPEN — only the checks that came back short, worded so absence of
//   evidence never reads as evidence of absence.
//
// IT DECIDES NOTHING. Every cell is derived in `research-model` from
// persisted component statuses, persisted reason codes and the coverage
// classification. No status is computed here, no wording is written here,
// and no free-text evidence summary reaches here — so a source's own
// sentence can never be promoted into an ATLAS conclusion at the top of
// the page, where it would have no attribution to sit beside.
export function ResultBriefing({
  keyFindings,
  unresolved,
}: {
  keyFindings: KeyFinding[];
  unresolved: UnresolvedItem[];
}) {
  if (keyFindings.length === 0 && unresolved.length === 0) return null;

  return (
    <div className="flex flex-col gap-5" data-testid="result-briefing">
      {keyFindings.length > 0 && (
        <section className="panel p-5 sm:p-6" data-testid="key-findings">
          <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
            Key findings
          </p>
          <p className="mt-1.5 text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]">
            Each check ATLAS ran for this question, and how far the evidence got.
          </p>

          {/* A WIDE TABLE SCROLLS INSIDE ITSELF, never the page. */}
          <div className="mt-4 -mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[34rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--hairline)]">
                  <th
                    scope="col"
                    className="py-2 pr-4 text-[0.68rem] font-medium uppercase tracking-[0.08em] text-[var(--atlas-text-dim)]"
                  >
                    Check
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 text-[0.68rem] font-medium uppercase tracking-[0.08em] text-[var(--atlas-text-dim)]"
                  >
                    Result
                  </th>
                  <th
                    scope="col"
                    className="py-2 text-[0.68rem] font-medium uppercase tracking-[0.08em] text-[var(--atlas-text-dim)]"
                  >
                    What ATLAS established
                  </th>
                </tr>
              </thead>
              <tbody>
                {keyFindings.map((f) => (
                  <tr
                    key={f.component}
                    className="border-b border-[var(--hairline)] last:border-b-0 align-top"
                    data-testid="key-finding-row"
                    data-component={f.component}
                  >
                    <td className="py-3 pr-4 text-[0.85rem] font-medium leading-snug">
                      {f.check}
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`tone tone-${f.tone} text-[0.625rem] px-2.5 py-1`}>
                        {f.result}
                      </span>
                    </td>
                    <td className="py-3 text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]">
                      {f.established ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* STILL OPEN — NEVER "THIS DOES NOT HAPPEN".
          Every sentence here describes the EVIDENCE. A check that came back
          short means ATLAS did not find enough to establish the claim; it is
          not a finding that the claim is false. The heading, the copy and
          the derived detail all hold that line, and the amber tone is the
          product's "unresolved", deliberately not the red it reserves for a
          positive contradiction. */}
      {unresolved.length > 0 && (
        <section className="panel p-5 sm:p-6" data-testid="unresolved-section">
          <p className="eyebrow" style={{ color: "#fcd34d" }}>
            Still open
          </p>
          <p className="mt-1.5 text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]">
            ATLAS did not find enough evidence to settle these. That is not a finding
            that they are untrue — only that this research could not establish them.
          </p>
          <ul className="mt-4 flex flex-col gap-3.5">
            {unresolved.map((u) => (
              <li
                key={u.component}
                className="border-t border-[var(--hairline)] pt-3.5 first:border-t-0 first:pt-0"
                data-testid="unresolved-item"
                data-component={u.component}
              >
                <p className="text-[0.85rem] font-medium leading-snug">{u.label}</p>
                <p className="mt-1 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]">
                  {u.detail}
                </p>
                {u.blocked && (
                  <p className="mt-1 text-[0.72rem] text-[var(--atlas-text-dim)]">
                    This is a limit of the research run, not evidence for or against the
                    project.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
