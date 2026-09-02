"use client";

import { useState } from "react";
import Link from "next/link";

import {
  deriveQuestionFindings,
  deriveResultLadder,
  findingExplanation,
  findingMicroAnswer,
  retrievedOn,
  retrievedResource,
  sourceClassCaveat,
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
  jobId,
  sourceClassesByComponent,
  evidenceByComponent,
  supportingSummariesByComponent,
  questionFindings,
}: {
  components: LadderComponentInput[];
  // Needed only to address the snapshot route. The evidence model carries
  // whether a capture EXISTS; the job is what makes it reachable, and it
  // stays a prop so this component never reads routing state itself.
  jobId?: string | null;
  sourceClassesByComponent?: Record<string, string[]>;
  // Canonical evidence per component, already resolved from persisted
  // links. A finding renders ONLY its own component's entry — this
  // component never joins evidence to a finding itself.
  evidenceByComponent?: Record<string, EvidenceItemLike[]>;
  // SUPPORTING-linked evidence summaries per component, in S5 order.
  // These ground the collapsed row's micro-answer, and being keyed per
  // component is what stops one finding answering another's question.
  supportingSummariesByComponent?: Record<string, string[]>;
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
    jobId: jobId ?? null,
    open: openRows.has(row.component),
    onToggle: () => toggle(row.component),
    evidence: evidenceByComponent?.[row.component] ?? [],
    supportingSummaries: supportingSummariesByComponent?.[row.component] ?? [],
  });

  // THE QUESTION SHAPES THE SCREEN WHEN IT CAN.
  if (question.length > 0) {
    return (
      <section className="panel p-5 sm:p-6" data-testid="result-ladder">
        {/* The reader is inside the product; the brand does not need to
            appear in the heading of every section it renders. */}
        <p className="eyebrow eyebrow-violet">Key findings</p>
        <div className="mt-3.5" data-testid="ladder-question">
          {question.map((row) => (
            <LadderRow key={row.component} {...rowProps(row)} isBoundary={false} />
          ))}
        </div>
        <p className="mt-4 text-[0.72rem] text-[var(--atlas-text-dim)]">
          Everything else checked is in the full research audit.
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
  jobId,
  open,
  onToggle,
  evidence,
  supportingSummaries,
  isBoundary,
}: {
  row: ResultRow;
  jobId: string | null;
  open: boolean;
  onToggle: () => void;
  evidence: EvidenceItemLike[];
  supportingSummaries: string[];
  isBoundary: boolean;
}) {
  // Proof state is LOCAL to this row. Opening it cannot reach another
  // finding, and cannot close the one it lives in.
  const [proofOpen, setProofOpen] = useState(false);
  const microAnswer = findingMicroAnswer(row, supportingSummaries);
  // The expansion answers "why?", so it must not open with the sentence
  // the reader has already read on the collapsed row. This only ever fires
  // on the fallback path, where the micro-answer had no admitted statement
  // to use and borrowed the explanation's own opening line.
  const explanation = findingExplanation(row).filter((s) => s !== microAnswer);

  return (
    <div
      className={`ladder-item ${open ? "ladder-item-open" : ""}`}
      // The row's own tone colour, read by .ladder-item-open's left
      // accent — the same colour the status text and icon already use,
      // so the accent is a restatement of an existing signal, not a new
      // one. Present on every row, not only the open one: CSS only draws
      // it once the row is open, so nothing renders differently while
      // collapsed.
      style={{ "--row-accent": stateColor(row.state).color } as React.CSSProperties}
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
        className="flex w-full items-center gap-3 py-3.5 text-left"
      >
        <StateIcon state={row.state} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 text-[0.92rem] font-medium leading-snug text-[var(--atlas-text)]">
              {row.label}
            </span>
            {/* A STATUS MARKER, not a second sentence — set apart from the
                question above it by weight and case (the same treatment
                every verdict badge in the product already uses), so
                strength and substance stay visually distinct even before
                the micro-answer line is read. The word itself is
                untouched; only its presentation changes. */}
            <span
              className="shrink-0 text-[0.68rem] font-semibold uppercase tracking-[0.05em]"
              style={stateColor(row.state)}
              data-testid="ladder-state"
            >
              {row.stateLabel}
            </span>
          </span>
          {/* THE ANSWER, ON THE COLLAPSED ROW.
              The badge above says how strongly; this says what. Without it
              a reader had to open "Where does trading fee revenue go?"
              purely to discover where it goes, which made expansion a
              retrieval step rather than the "why?" it is meant to be. */}
          {microAnswer && (
            <span
              className="mt-1 block text-[0.82rem] leading-snug text-[var(--atlas-text-dim)]"
              data-testid="finding-micro-answer"
            >
              {microAnswer}
            </span>
          )}
          {isBoundary && (
            <span
              className="mt-1 block text-[0.7rem] text-[#fcd34d]"
              data-testid="ladder-boundary"
            >
              The evidence stops here
            </span>
          )}
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
              jobId={jobId}
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
  jobId,
  open,
  onToggle,
}: {
  items: EvidenceItemLike[];
  jobId: string | null;
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
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hairline)] bg-[rgba(34,211,238,0.045)] px-2.5 py-1.5 text-[0.75rem] font-medium text-[var(--atlas-cyan)] transition-colors hover:border-[var(--hairline-strong)] hover:bg-[rgba(34,211,238,0.08)]"
      >
        {/* ONE ACTION VOCABULARY. This said "Show proof · 2 sources" while
            the page above said "sources used as evidence" and the card
            below said "Supports:" — three words for one idea. Everything
            that leads to a source now says SOURCES, and the only other
            verb in the chain is OPEN ORIGINAL at the end of it. */}
        <ProofIcon />
        {open ? "Hide sources" : "Sources"}
        <span className="font-normal text-[var(--atlas-text-dim)]">· {items.length}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3" data-testid="finding-evidence-open">
          <EvidenceItem item={primary} jobId={jobId} />
          {rest.length > 0 && !restOpen && (
            <button
              type="button"
              onClick={() => setRestOpen(true)}
              className="self-start text-[0.75rem] text-[var(--atlas-cyan)] hover:underline"
              data-testid="toggle-supporting-sources"
            >
              + {rest.length} more {rest.length === 1 ? "source" : "sources"}
            </button>
          )}
          {restOpen &&
            rest.map((item) => <EvidenceItem key={item.id} item={item} jobId={jobId} />)}
        </div>
      )}
    </div>
  );
}

// Deliberately lighter than the finding it supports — a thin hairline, a
// near-transparent fill, and (per the brief) a fragment coloured a shade
// under full text brightness. A conclusion is read first; its proof is
// read on request, and the card should look like the second thing, not
// compete with the first.
function EvidenceItem({ item, jobId }: { item: EvidenceItemLike; jobId: string | null }) {
  const caveat = sourceClassCaveat(item.sourceClass);
  // The source-class limit is generic to the KIND of source; doesNotProve
  // is what the extractor recorded about THIS passage. The specific one
  // wins where it exists.
  const limit = item.doesNotProve ?? caveat?.cannot ?? null;
  const domain = domainOf(item.retrievedUrl);
  // A real page title when one was captured; otherwise the publisher, which
  // is the strongest identity that actually exists. Never the filename.
  const title = item.sourceTitle?.trim() || domain;
  const resource = retrievedResource(item.retrievedUrl);
  const retrievedDate = retrievedOn(item.fetchedAt);

  return (
    <div
      className="rounded-xl border border-[var(--hairline)] bg-[rgba(255,255,255,0.022)] p-3.5"
      data-testid={`finding-evidence-${item.id}`}
    >
      {/* PROVENANCE FIRST — WHO PUBLISHED IT, AND WHAT KIND OF THING IT IS.
          A card that opened straight into a quotation looked like text this
          product had written about itself. Publisher and class are what let
          a reader answer "how do I know you did not write this?" before
          reading a word of the passage.

          THE HEADLINE IS THE PUBLISHER, NOT THE FILENAME. `ray-buybacks.md`
          told a reader nothing except that they were looking at a file, and
          `sources.title` is null on every row this engine has produced so
          far — so the strongest identity actually available is the domain
          that served it. When a real title does exist it takes the line and
          the domain drops beside the class. Nothing is invented in either
          case: no page title is guessed, and no prettier url is derived. */}
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Source
      </p>
      <p
        className="mt-1 truncate text-[0.85rem] font-medium text-[var(--atlas-text)]"
        data-testid="source-identity"
      >
        {title}
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[0.72rem] text-[var(--atlas-text-dim)]">
        <span
          className="rounded-md border px-1.5 py-0.5 font-medium uppercase tracking-wider"
          style={sourceClassChipStyle(item.sourceClass)}
          data-testid="source-class-chip"
        >
          {sourceClassLabel(item.sourceClass)}
        </span>
        {title !== domain && <span className="truncate">{domain}</span>}
      </p>

      {/* WHAT WAS ACTUALLY READ, AND WHEN — quietly, below the identity.
          The engine often fetches the machine-readable form of a page
          because it parses cleanly. That is a good research decision and a
          baffling thing to meet unexplained, so the card says plainly that
          this is a machine-readable document rather than leaving a reader
          to wonder why "Open source" led to raw markdown.

          The retrieval date is a real persisted fact (`evidence.fetched_at`)
          and one of the few things a fabricated card could not carry. */}
      {(resource.filename || retrievedDate) && (
        <p
          className="mt-1.5 text-[0.7rem] text-[var(--atlas-text-dim)]"
          data-testid="retrieved-resource"
        >
          {resource.machineReadable && "Machine-readable document"}
          {resource.machineReadable && resource.filename && " · "}
          {resource.filename}
          {retrievedDate && ` · retrieved ${retrievedDate}`}
        </p>
      )}

      {/* AN EXCERPT, CALLED AN EXCERPT. This is the passage the extractor
          took, not the document — saying "source excerpt" is the honest
          description of what is actually on screen, and it is the only
          thing here checked against the fetched page rather than written. */}
      <p className="eyebrow mt-3.5" style={{ color: "var(--atlas-text-dim)" }}>
        Relevant excerpt
      </p>
      <blockquote className="mt-1.5 border-l-2 border-[rgba(45,212,191,0.4)] pl-3 text-[0.84rem] leading-relaxed text-[var(--atlas-text)]/92">
        {item.fragment}
      </blockquote>

      {/* WHY THIS SOURCE, AND WHAT IT STILL CANNOT SETTLE.
          What is deliberately NOT here is `summary` — the model's reading
          of this passage, which is the same sentence the collapsed finding
          already showed. Reading one fact three times on the way down is
          what made depth feel like padding; these two lines are new
          information instead. */}
      {caveat && (
        <>
          <p className="eyebrow mt-3.5" style={{ color: "var(--atlas-text-dim)" }}>
            Why this source
          </p>
          <p className="mt-1.5 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]">
            {caveat.can}
          </p>
        </>
      )}
      {limit && (
        <>
          <p className="eyebrow mt-3.5" style={{ color: "var(--atlas-text-dim)" }}>
            Source limit
          </p>
          <p className="mt-1.5 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]">
            {limit}
          </p>
        </>
      )}

      {/* TWO DESTINATIONS, AND THEY ANSWER DIFFERENT QUESTIONS.
          "What did you read?" is answered by the snapshot — the document
          as it was received at research time, which is the only version
          that can actually account for this excerpt. "Is it still true?"
          is answered by the live original, which may have changed since
          and is the reader's to judge.

          The original link is unchanged: there is no second, human-facing
          url in the data (`sources.url` equals `evidence.retrieved_url` on
          every row), and sending a reader to a guessed address — the same
          path minus `.md` — would be a fabricated provenance claim dressed
          as a convenience. It goes exactly where the excerpt came from.

          THE SNAPSHOT ACTION APPEARS ONLY WHERE A CAPTURE EXISTS. Not
          disabled, not greyed: absent. A button that leads to "nothing
          stored" would spend a reader's trust to tell them nothing, and
          the honest signal is simply that this card offers one route and
          another card offers two. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {item.hasSnapshot && jobId && (
          <Link
            href={`/research/${jobId}/source/${item.id}`}
            className="inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-[var(--atlas-cyan)] hover:underline"
            data-testid="view-source-snapshot"
          >
            <SnapshotIcon />
            View source snapshot
          </Link>
        )}
        <a
          href={item.retrievedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-[var(--atlas-text-dim)] hover:text-[var(--atlas-cyan)] hover:underline"
          data-testid="open-source"
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
    </div>
  );
}

// A page with a corner turned down — a kept copy of a document, which is
// what a snapshot is. Deliberately not an eye or a magnifier: this is not
// a preview of the live site.
function SnapshotIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2.5 1.5h4L9.5 4.5v6h-7z M6.5 1.5v3h3"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A small shield-check — "proof", not "document". The evidence card below
// already has its own document identity (source-class chip); this icon
// belongs to the CONTROL that reveals it, so it reads as "verify this"
// rather than duplicating the document glyph used elsewhere in the audit.
function ProofIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path
        d="M6 1.4 10 2.9v2.7c0 2.3-1.6 4.1-4 4.9-2.4-.8-4-2.6-4-4.9V2.9L6 1.4Z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path d="M4.3 6.1 5.5 7.3 7.8 4.8" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// SOURCE CLASSES SHOULD NOT ALL LOOK THE SAME.
//
// A reader scanning several cards needs to tell an on-chain record from a
// blog at a glance, because the two answer different kinds of question.
// This is a KIND marker, never a quality score: nothing here ranks
// sources, an official document gets no brighter treatment than a data
// provider, and the class's real limits are stated in words beside it.
// Anything unrecognised falls back to plain neutral rather than guessing.
function sourceClassChipStyle(sourceClass: string | null): React.CSSProperties {
  switch (sourceClass) {
    case "ONCHAIN_VERIFIABLE":
      return { color: "#7dd3fc", borderColor: "rgba(125, 211, 252, 0.35)" };
    case "GOVERNANCE":
      return { color: "#c4b5fd", borderColor: "rgba(167, 139, 250, 0.35)" };
    case "OFFICIAL_DOCS":
    case "OFFICIAL_REPORT":
      return { color: "#5eead4", borderColor: "rgba(45, 212, 191, 0.32)" };
    case "DATA_PROVIDER":
      return { color: "#cbd5e1", borderColor: "rgba(148, 163, 184, 0.35)" };
    default:
      return { color: "var(--atlas-text-dim)", borderColor: "var(--hairline)" };
  }
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
