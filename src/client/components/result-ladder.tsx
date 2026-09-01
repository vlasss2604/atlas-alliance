"use client";

import { useState } from "react";

import {
  deriveQuestionFindings,
  deriveResultLadder,
  sourceClassCaveat,
  sourceClassLabel,
  type LadderComponentInput,
  type RealityState,
  type ResultRow,
} from "../research-model";

// THE RESULT, AS TWO SHORT LISTS OF CLAIMS A READER CAN EVALUATE.
//
// This replaces the reality-check ladder and the separate gaps panel. Those
// were correct about the engine and wrong about the reader: between them
// they put four bare adjectives (Documented / Approved / Activated /
// Executing), a wall of one-line gap rows, and the phrase "could not verify"
// used with three different meanings on a single screen.
//
// What survives from them, deliberately and completely:
//
//   THE TWO-GROUP SEPARATION. The mechanism group is sequential; where the
//   value goes is established independently. Presenting them as one chain
//   would assert that an unverified execution step makes the destination
//   impossible, which the engine never claims.
//
//   THE CONSERVATIVE BOUNDARY. A boundary marker is a claim about where an
//   established run ENDS, so it is drawn only when there is one to end.
//
//   THE ASYMMETRY. Only a positively CONTRADICTED component reads as
//   "evidence indicates otherwise". Missing evidence never becomes evidence
//   of absence.
//
// What is new is that every row can now say WHY, from reason codes the
// engine has always persisted and the product has never shown.
export function ResultLadder({
  components,
  sourceClassesByComponent,
  questionFindings,
  onViewEvidence,
}: {
  components: LadderComponentInput[];
  sourceClassesByComponent?: Record<string, string[]>;
  // When a projection resolved, these are the findings the question
  // itself calls for, already named in the reader's words. When it is
  // absent — never generated, failed, or its refs no longer resolve — the
  // Pattern-driven ladder below is the conservative fallback.
  questionFindings?: {
    label: string;
    patternStep: number;
    component: string;
    supportingComponents: string[];
  }[] | null;
  onViewEvidence?: () => void;
}) {
  // ONE ROW OPEN AT A TIME. Progressive disclosure is only progressive if
  // the reader can put a thing back; a screen where every row can be open
  // at once is the wall of panels this section exists to replace.
  const [openRow, setOpenRow] = useState<string | null>(null);
  const view = deriveResultLadder(components, sourceClassesByComponent);
  const question =
    questionFindings && questionFindings.length > 0
      ? deriveQuestionFindings(questionFindings, components, sourceClassesByComponent)
      : [];

  // THE QUESTION SHAPES THE SCREEN WHEN IT CAN.
  //
  // These rows carry the same statuses, reasons and evidence the ladder
  // below would show for the same components — the only difference is
  // WHICH ones are here and what they are called. The Pattern's own
  // grouping does not appear at all, because a reader did not ask about
  // the Pattern.
  if (question.length > 0) {
    return (
      <section className="panel p-5 sm:p-6" data-testid="result-ladder">
        <p className="eyebrow eyebrow-violet">What ATLAS established for this question</p>
        <div className="mt-3.5" data-testid="ladder-question">
          {question.map((row) => (
            <LadderRow
              key={row.component}
              row={row}
              open={openRow === row.component}
              onToggle={() => setOpenRow((p) => (p === row.component ? null : row.component))}
              onViewEvidence={onViewEvidence}
              isBoundary={false}
            />
          ))}
        </div>
        <p className="mt-4 text-[0.72rem] text-[var(--atlas-text-dim)]">
          Everything else ATLAS checked is in the full research audit.
        </p>
      </section>
    );
  }

  if (!view.derivable) {
    return (
      <section className="panel p-5 sm:p-6" data-testid="result-ladder">
        <p className="text-[0.9rem] text-[var(--atlas-text-dim)]">
          This research has no component results, so there is nothing to show as
          established or open.
        </p>
      </section>
    );
  }

  const toggle = (component: string) =>
    setOpenRow((prev) => (prev === component ? null : component));

  return (
    <section className="panel p-5 sm:p-6" data-testid="result-ladder">
      {view.mechanism.length > 0 && (
        <>
          <p className="eyebrow eyebrow-violet">How the mechanism stands</p>
          <div className="mt-3.5" data-testid="ladder-mechanism">
            {view.mechanism.map((row) => (
              <LadderRow
                key={row.component}
                row={row}
                open={openRow === row.component}
                onToggle={() => toggle(row.component)}
                onViewEvidence={onViewEvidence}
                isBoundary={view.boundary?.component === row.component}
              />
            ))}
          </div>
        </>
      )}

      {view.value.length > 0 && (
        <>
          <p
            className={`eyebrow ${view.mechanism.length > 0 ? "mt-7" : ""}`}
            style={{ color: "var(--atlas-text-dim)" }}
          >
            What the evidence says about the value
          </p>
          {/* Stated explicitly, because the layout alone cannot say it: these
              are not later steps of the list above, and an open step above
              does not make any of them impossible. */}
          <p className="mt-1.5 mb-3 text-[0.74rem] leading-snug text-[var(--atlas-text-dim)]">
            Established separately — not later steps of the mechanism above.
          </p>
          <div data-testid="ladder-value">
            {view.value.map((row) => (
              <LadderRow
                key={row.component}
                row={row}
                open={openRow === row.component}
                onToggle={() => toggle(row.component)}
                onViewEvidence={onViewEvidence}
                isBoundary={false}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function LadderRow({
  row,
  open,
  onToggle,
  onViewEvidence,
  isBoundary,
}: {
  row: ResultRow;
  open: boolean;
  onToggle: () => void;
  onViewEvidence?: () => void;
  isBoundary: boolean;
}) {
  return (
    <div
      className={`ladder-item ${open ? "ladder-item-open" : ""}`}
      data-testid="ladder-row"
      data-component={row.component}
      data-state={row.state}
      data-coverage={row.coverage}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-3 text-left"
      >
        <StateIcon state={row.state} />
        <span className="min-w-0 flex-1">
          <span
            className={
              "block truncate text-[0.92rem] " +
              (row.state === "VERIFIED"
                ? "text-[var(--atlas-text)]"
                : "text-[var(--atlas-text-dim)]")
            }
          >
            {row.label}
          </span>
          {isBoundary && (
            <span
              className="mt-0.5 block text-[0.7rem] text-[#fcd34d]"
              data-testid="ladder-boundary"
            >
              The evidence stops here
            </span>
          )}
        </span>
        <span
          className="shrink-0 text-[0.72rem]"
          style={stateColor(row.state)}
          data-testid="ladder-state"
        >
          {row.stateLabel}
        </span>
        <span
          className={`shrink-0 text-[var(--atlas-text-dim)] transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="m6 3 5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && (
        <div className="pb-4 pl-8 pr-1" data-testid="ladder-expansion">
          {/* A RESEARCH LIMITATION IS NOT A FINDING, so it leads — before any
              sentence about what the evidence did or did not show. Without
              this the reader reads "not established" as a fact about the
              project when it is a fact about this run. */}
          {row.limitation && (
            <p
              className="mb-3 rounded-lg border border-[rgba(251,191,36,0.28)] bg-[var(--amber-dim)] px-3 py-2 text-[0.76rem] leading-snug text-[#fcd34d]"
              data-testid="ladder-limitation"
            >
              <span className="font-medium">Research limitation.</span>{" "}
              {row.limitation}
            </p>
          )}

          {row.reason && (
            <Block label="Why this status">
              <p>{row.reason}</p>
            </Block>
          )}

          <Block label="What ATLAS checked">
            <p>{row.checkedSummary}</p>
          </Block>

          {row.shows && (
            <Block label="What the evidence shows">
              <p>{row.shows}</p>
            </Block>
          )}

          {/* WHAT IT DOES NOT ESTABLISH comes from the CLASSES actually
              admitted for this row, never from a sentence written here. A
              step resting on documentation says so; a step resting on an
              on-chain record says something different. */}
          {row.sourceClasses.length > 0 && (
            <Block label="What it does not establish">
              <ul className="flex flex-col gap-1">
                {row.sourceClasses.map((cls) => {
                  const caveat = sourceClassCaveat(cls);
                  if (!caveat) return null;
                  return (
                    <li key={cls}>
                      <span className="text-[var(--atlas-text)]">
                        {sourceClassLabel(cls)}
                      </span>{" "}
                      — {caveat.cannot}
                    </li>
                  );
                })}
              </ul>
            </Block>
          )}

          {onViewEvidence && (
            <button
              type="button"
              onClick={onViewEvidence}
              className="mt-3 inline-flex items-center gap-1.5 text-[0.78rem] text-[var(--atlas-cyan)] hover:underline"
            >
              View evidence
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="m6 3 5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="eyebrow">{label}</p>
      <div className="mt-1 text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]">
        {children}
      </div>
    </div>
  );
}

function stateColor(state: RealityState): React.CSSProperties {
  switch (state) {
    case "VERIFIED":
      return { color: "#5eead4" };
    case "PARTIAL":
      return { color: "#c4b5fd" };
    case "NOT_HAPPENING":
      return { color: "#fca5a5" };
    default:
      return { color: "#fcd34d" };
  }
}

// RED BELONGS TO A POSITIVE CONTRADICTION ALONE. Missing evidence is amber,
// because absence of evidence is not evidence of absence and a colour is
// read faster than any sentence that would try to walk it back.
function StateIcon({ state }: { state: RealityState }) {
  if (state === "VERIFIED") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[rgba(45,212,191,0.5)] bg-[rgba(13,42,45,0.8)] text-[#5eead4]">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="m2.5 6.3 2.3 2.3 4.7-5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
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
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[rgba(251,191,36,0.35)] bg-[rgba(10,20,34,0.8)]">
      <span className="dot dot-insufficient h-1.5 w-1.5" aria-hidden />
    </span>
  );
}
