"use client";

import { useState } from "react";

import {
  deriveQuestionFindings,
  deriveResultLadder,
  findingExplanation,
  sourceClassLabel,
  type EvidenceItemLike,
  type LadderComponentInput,
  type RealityState,
  type ResultRow,
} from "../research-model";

// THE RESULT, AS A SHORT LIST OF CLAIMS A READER CAN EVALUATE — AND OPEN.
//
// Three things this component is responsible for, all of them about how a
// person consumes a finding rather than what a finding says:
//
//   ONE CONNECTED EXPLANATION per finding, not three headed blocks. The
//   old form was accurate and read like an internal report; joining it up
//   was work the reader should not have been doing.
//
//   PROOF ATTACHED TO ITS CONCLUSION. Evidence opens inside the finding it
//   belongs to, so a source is never something a reader has to explain to
//   themselves. There is no general document list on this screen at all.
//
//   INDEPENDENT OPEN STATE. Several findings stay open at once, because
//   comparing two conclusions means holding both in view. Opening one
//   never closes another, and opening proof never closes its finding.
//
// Nothing here decides anything. Status, reason copy, coverage and the
// evidence shown under a finding are all canonical, resolved elsewhere and
// passed in.
export function ResultLadder({
  components,
  sourceClassesByComponent,
  evidenceByComponent,
  questionFindings,
}: {
  components: LadderComponentInput[];
  sourceClassesByComponent?: Record<string, string[]>;
  // Canonical evidence per component, already resolved from persisted
  // links. A finding renders ONLY its own component's entry — this
  // component never joins evidence to a finding itself.
  evidenceByComponent?: Record<string, EvidenceItemLike[]>;
  questionFindings?:
    | {
        label: string;
        patternStep: number;
        component: string;
        supportingComponents: string[];
      }[]
    | null;
}) {
  // INDEPENDENT, NOT AN ACCORDION. A Set, so each finding's state is its
  // own: opening B leaves A open, and closing A leaves B untouched.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const toggle = (component: string) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(component)) next.delete(component);
      else next.add(component);
      return next;
    });

  const view = deriveResultLadder(components, sourceClassesByComponent);
  const question =
    questionFindings && questionFindings.length > 0
      ? deriveQuestionFindings(questionFindings, components, sourceClassesByComponent)
      : [];

  const rowProps = (row: ResultRow) => ({
    row,
    open: openRows.has(row.component),
    onToggle: () => toggle(row.component),
    evidence: evidenceByComponent?.[row.component] ?? [],
  });

  // THE QUESTION SHAPES THE SCREEN WHEN IT CAN.
  if (question.length > 0) {
    return (
      <section className="panel p-5 sm:p-6" data-testid="result-ladder">
        <p className="eyebrow eyebrow-violet">What ATLAS established for this question</p>
        <div className="mt-3.5" data-testid="ladder-question">
          {question.map((row) => (
            <LadderRow key={row.component} {...rowProps(row)} isBoundary={false} />
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

  return (
    <section className="panel p-5 sm:p-6" data-testid="result-ladder">
      {view.mechanism.length > 0 && (
        <>
          <p className="eyebrow eyebrow-violet">How the mechanism stands</p>
          <div className="mt-3.5" data-testid="ladder-mechanism">
            {view.mechanism.map((row) => (
              <LadderRow
                key={row.component}
                {...rowProps(row)}
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
          {/* Stated explicitly, because the layout alone cannot say it:
              these are not later steps of the list above, and an open step
              above does not make any of them impossible. */}
          <p className="mt-1.5 mb-3 text-[0.74rem] leading-snug text-[var(--atlas-text-dim)]">
            Established separately — not later steps of the mechanism above.
          </p>
          <div data-testid="ladder-value">
            {view.value.map((row) => (
              <LadderRow key={row.component} {...rowProps(row)} isBoundary={false} />
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
  evidence,
  isBoundary,
}: {
  row: ResultRow;
  open: boolean;
  onToggle: () => void;
  evidence: EvidenceItemLike[];
  isBoundary: boolean;
}) {
  // Proof state is LOCAL to this row. Opening it cannot reach another
  // finding, and cannot close the one it lives in.
  const [proofOpen, setProofOpen] = useState(false);
  const explanation = findingExplanation(row);

  return (
    <div
      className={`ladder-item ${open ? "ladder-item-open" : ""}`}
      data-testid="ladder-row"
      data-component={row.component}
      data-state={row.state}
      data-coverage={row.coverage}
      data-open={open ? "true" : "false"}
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
          {/* A RESEARCH LIMITATION IS NOT A FINDING, so it keeps its own
              frame rather than becoming one more sentence in the prose.
              Without the visual break a skimming reader takes "not
              established" as a fact about the project. */}
          {row.limitation ? (
            <p
              className="rounded-lg border border-[rgba(251,191,36,0.28)] bg-[var(--amber-dim)] px-3 py-2 text-[0.82rem] leading-relaxed text-[#fcd34d]"
              data-testid="ladder-limitation"
            >
              <span className="font-medium">Research limitation.</span>{" "}
              {explanation.join(" ")}
            </p>
          ) : (
            <div
              className="flex flex-col gap-2 text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]"
              data-testid="finding-explanation"
            >
              {explanation.map((s) => (
                <p key={s}>{s}</p>
              ))}
            </div>
          )}

          {evidence.length > 0 && (
            <FindingEvidence
              items={evidence}
              open={proofOpen}
              onToggle={() => setProofOpen((v) => !v)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// PROOF, ATTACHED TO THE CONCLUSION IT SUPPORTS.
//
// Only the canonical evidence already linked to this finding's component.
// Nothing is joined here: the caller resolved the links, this renders them.
//
// The strongest item leads and the rest stay behind a count, because five
// documents opened at once is the wall this whole redesign removed — a
// reader wants ONE thing to read, and the option of more.
function FindingEvidence({
  items,
  open,
  onToggle,
}: {
  items: EvidenceItemLike[];
  open: boolean;
  onToggle: () => void;
}) {
  const [primary, ...rest] = items;
  const [restOpen, setRestOpen] = useState(false);

  return (
    <div className="mt-3.5" data-testid="finding-evidence">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="toggle-finding-evidence"
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hairline)] px-2.5 py-1 text-[0.75rem] text-[var(--atlas-cyan)] hover:border-[var(--hairline-strong)]"
      >
        {open ? "Hide proof" : "Show proof"}
        <span className="text-[var(--atlas-text-dim)]">
          · {items.length} {items.length === 1 ? "source" : "sources"}
        </span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3" data-testid="finding-evidence-open">
          <EvidenceItem item={primary} />
          {rest.length > 0 && !restOpen && (
            <button
              type="button"
              onClick={() => setRestOpen(true)}
              className="self-start text-[0.75rem] text-[var(--atlas-cyan)] hover:underline"
              data-testid="toggle-supporting-sources"
            >
              + {rest.length} supporting {rest.length === 1 ? "source" : "sources"}
            </button>
          )}
          {restOpen && rest.map((item) => <EvidenceItem key={item.id} item={item} />)}
        </div>
      )}
    </div>
  );
}

function EvidenceItem({ item }: { item: EvidenceItemLike }) {
  return (
    <div
      className="rounded-xl border border-[var(--hairline)] bg-[rgba(255,255,255,0.02)] p-3"
      data-testid={`finding-evidence-${item.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[0.72rem] text-[var(--atlas-text-dim)]">
        <span className="rounded-md border border-[var(--hairline)] px-1.5 py-0.5 uppercase tracking-wider">
          {sourceClassLabel(item.sourceClass)}
        </span>
        <span className="truncate text-[var(--atlas-text)]">
          {item.sourceTitle ?? domainOf(item.retrievedUrl)}
        </span>
      </div>

      {/* THE SOURCE'S OWN WORDS FIRST. The fragment is the only thing on
          this screen checked against the fetched document rather than
          generated, so it is the reason to believe any of the rest. */}
      <blockquote className="mt-2.5 border-l-2 border-[rgba(45,212,191,0.4)] pl-3 text-[0.84rem] leading-relaxed text-[var(--atlas-text)]">
        {item.fragment}
      </blockquote>

      {item.summary && (
        <p className="mt-2.5 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]">
          <span className="text-[var(--atlas-text)]">Supports:</span> {item.summary}
        </p>
      )}
      {item.doesNotProve && (
        <p className="mt-1.5 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]">
          <span className="text-[var(--atlas-text)]">Does not establish:</span>{" "}
          {item.doesNotProve}
        </p>
      )}

      <a
        href={item.retrievedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2.5 inline-flex items-center gap-1.5 text-[0.75rem] text-[var(--atlas-cyan)] hover:underline"
      >
        Open original
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M4 2h6v6M10 2 3 9"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    </div>
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
