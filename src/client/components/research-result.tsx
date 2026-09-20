"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobDetail } from "../api";
import {
  buildResultSurface,
  mechanismNounOf,
  sourceSentence,
  statusTone,
  tableRows,
  type BoundaryGroup,
  type EvidenceCard,
  type ProofNode,
  type ResearchTableRow,
  type ResultStatus,
  type ResultSurface,
} from "../result-surface";
import { canonicalDocumentKey, type JobState, type VerdictTone } from "../research-model";
import { OutcomeBadge } from "./verdict-badge";

// THE COMPLETED RESEARCH V5 — ONE SURFACE, FIVE AREAS AND A DOOR.
//
//   1. EXECUTIVE ANSWER       the project, the question, the state, the
//                             answer, and four figures for the work done
//   2. RESEARCH PATH          the logic of the research as a strip of
//                             nodes — revenue → mechanism → execution →
//                             destination → supply — coloured by state
//   3. WHAT ATLAS CHECKED     one structured row per question: the
//                             question, the fact, a state line (glyph,
//                             state + source kind, source, date), evidence
//   4. EVIDENCE               the 3–5 sources the answer rests on, as
//                             evidence cards: kind, date, source, what it
//                             establishes, excerpt / original / snapshot
//   5. WHAT REMAINS UNCLEAR   the research boundary, once, with the
//                             checks it applies to
//   →  OPEN FULL AUDIT        the same questions, at depth
//
// THE USER READS THE PROJECT, NOT THE ENGINE. Every label is a question a
// reader would ask; every fact is in plain words; a state is a glyph and a
// word beside the fact, never the fact itself. Every value arrives derived
// in `result-surface.ts` from persisted rows: nothing is decided, written
// or chosen here. PAGE <= PERSISTED VERIFIED RECORD.

const TONE_COLORS: Record<VerdictTone, string> = {
  supported: "var(--atlas-green)",
  partial: "var(--atlas-amber)",
  negative: "var(--atlas-red)",
  insufficient: "var(--atlas-slate)",
  fault: "var(--atlas-slate)",
  neutral: "var(--atlas-slate)",
};

// THE STATE, IN A READER'S WORD. The canonical status label stays on the
// row as its title; this is what the state line says beside the fact.
const STATE_WORDS: Record<ResultStatus, string> = {
  CONFIRMED: "Verified",
  PARTIAL: "Partly verified",
  NOT_ESTABLISHED: "Unresolved",
  CONTRADICTED: "Contradicted",
};
const STATE_GLYPHS: Record<ResultStatus, string> = {
  CONFIRMED: "✓",
  PARTIAL: "◐",
  NOT_ESTABLISHED: "?",
  CONTRADICTED: "✕",
};
const COUNT_WORDS: Record<ResultStatus, string> = {
  CONFIRMED: "verified",
  PARTIAL: "partly",
  NOT_ESTABLISHED: "unresolved",
  CONTRADICTED: "contradicted",
};
const COUNT_ORDER: ResultStatus[] = ["CONFIRMED", "PARTIAL", "CONTRADICTED", "NOT_ESTABLISHED"];

export function ResearchResult({ detail, jobId }: { detail: ResearchJobDetail; jobId: string | null }) {
  const surface = buildResultSurface(detail);
  const projectName = detail.job.projectName ?? detail.job.projectTicker ?? "Unresolved project";
  const noun = mechanismNounOf([detail.job.originalQuestion, ...surface.table.filter((r) => r.primary).map((r) => r.label)]);
  return (
    <article className="flex flex-col gap-8 sm:gap-10" data-testid="research-result">
      <AnswerPanel surface={surface} detail={detail} projectName={projectName} />
      <ResearchPath chain={surface.chain} noun={noun} />
      <FindingsTable rows={surface.table} />
      <SourcesSection cards={surface.keyEvidence} />
      <UnclearSection groups={surface.boundary} />
      {jobId && (
        <p className="pb-2">
          <Link href={`/research/${jobId}/audit`} className="btn-secondary px-5 py-3 text-[0.98rem]" data-testid="audit-entry">
            Open full audit
            <Chevron />
          </Link>
        </p>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* 1. EXECUTIVE ANSWER                                                 */
/* ------------------------------------------------------------------ */

// THE ONE RAISED SURFACE ON THE PAGE. The project is an identity line;
// the question is the heading; the state is one badge with its
// confidence; the answer is the largest running text on the screen, its
// first sentence carrying the weight; four figures say how much work sits
// behind it; the dates are one quiet footnote.
function AnswerPanel({ surface, detail, projectName }: { surface: ResultSurface; detail: ResearchJobDetail; projectName: string }) {
  const { job, proof } = detail;
  const lead = surface.answer.sentences[0];
  const stats = workFigures(surface);
  return (
    <section className="panel panel-hero px-5 py-6 sm:px-9 sm:py-9" data-testid="answer-panel">
      <p className="flex flex-wrap items-center gap-x-2 text-[0.95rem] font-medium text-[var(--atlas-text-dim)]">
        <span className="text-[var(--atlas-text)]">{projectName}</span>
        <span aria-hidden>·</span>
        <span>Research result</span>
      </p>
      <h1 className="display mt-2 text-[1.4rem] font-semibold leading-[1.2] text-[var(--atlas-text-strong)] sm:text-[1.9rem]" data-testid="result-question">
        {job.originalQuestion}
      </h1>
      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="answer-state">
        <OutcomeBadge job={{ state: job.state as JobState, verdict: proof?.verdict ?? null }} />
        {surface.answer.confidenceLabel && (
          <span className="text-[0.92rem] text-[var(--atlas-text-dim)]" data-testid="answer-confidence">
            {surface.answer.confidenceLabel} confidence
          </span>
        )}
      </div>
      <div className="mt-5 flex flex-col gap-3 text-[1.15rem] leading-[1.5] sm:text-[1.25rem] sm:leading-[1.5]" data-testid="answer-text">
        {surface.answer.sentences.map((s) => (
          <p key={s} className={s === lead ? "font-medium text-[var(--atlas-text-strong)]" : "text-[var(--atlas-text)]/90"}>
            {s}
          </p>
        ))}
      </div>
      {stats.length > 0 && (
        <div className="stats mt-7" data-testid="answer-stats">
          {stats.map((s) => (
            <div key={s.label} className="stat">
              <span className="stat-n">{s.n}</span>
              <span className="stat-l">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      <p
        className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--hairline)] pt-4 text-[0.88rem] text-[var(--atlas-text-dim)]"
        data-testid="answer-meta"
      >
        {surface.checkedOn && <span data-testid="answer-checked">Checked {surface.checkedOn}</span>}
        {surface.latestEvidence && (
          <span>
            Newest source {surface.latestEvidence.label.toLowerCase()} {surface.latestEvidence.value}
          </span>
        )}
      </p>
    </section>
  );
}

// THE WORK, IN FIGURES — counted from the rows, never estimated: the
// checks the research turned on, the distinct documents admitted behind
// them, the admitted evidence items, and the checks that were verified.
function workFigures(surface: ResultSurface): { n: number; label: string }[] {
  const rows = surface.table;
  if (rows.length === 0) return [];
  const cards = rows.flatMap((r) => r.evidence);
  const items = new Set(cards.map((c) => c.id)).size;
  const docs = new Set(cards.map((c) => canonicalDocumentKey(c.url))).size;
  const verified = rows.filter((r) => r.status === "CONFIRMED").length;
  return [
    { n: rows.length, label: rows.length === 1 ? "check" : "checks" },
    { n: docs, label: docs === 1 ? "source" : "sources" },
    { n: items, label: items === 1 ? "evidence item" : "evidence items" },
    { n: verified, label: "verified" },
  ];
}

/* ------------------------------------------------------------------ */
/* 2. RESEARCH PATH                                                    */
/* ------------------------------------------------------------------ */

// THE LOGIC OF THE RESEARCH, VISIBLE. One node per check in proof-path
// order — the money story from where it comes from to what it does to
// supply — each in one or two human words and its state colour. It
// exists so a reader sees WHAT was checked and in what order; it never
// repeats a row's text.
function pathWord(component: string, noun: string): string {
  switch (component) {
    case "SOURCE_OF_VALUE":
      return "Revenue";
    case "FLOW_PATH":
      return "Flow";
    case "MECHANISM_SPEC":
      return noun === "the mechanism" ? "Design" : capitalize(noun.replace(/^the /, ""));
    case "GOVERNANCE_BASIS":
      return "Approval";
    case "CURRENT_STATE":
      return "Active now";
    case "EXECUTION_EVIDENCE":
      return "Execution";
    case "DESTINATION":
      return "Destination";
    case "RECIPIENT":
      return "Recipient";
    case "NET_EFFECT":
      return "Supply impact";
    case "DURABILITY_BASIS":
      return "Durability";
    default:
      return capitalize(component.toLowerCase().replace(/_/g, " "));
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function ResearchPath({ chain, noun }: { chain: readonly ProofNode[]; noun: string }) {
  if (chain.length < 2) return null;
  return (
    <section data-testid="research-path" aria-label="Research path">
      <p className="mb-3 px-1 text-[0.95rem] font-medium text-[var(--atlas-text-dim)]">What the research followed</p>
      <ol className="path">
        {chain.map((n) => (
          <li
            key={n.component}
            className="path-node"
            style={{ "--node": TONE_COLORS[n.tone] } as React.CSSProperties}
            title={`${n.label} — ${n.statusLabel}`}
            data-testid="path-node"
            data-component={n.component}
            data-status={n.status}
          >
            <span className={`path-mark ${n.status === "NOT_ESTABLISHED" ? "" : "path-mark-filled"}`} aria-hidden>
              {STATE_GLYPHS[n.status]}
            </span>
            <span>{pathWord(n.component, noun)}</span>
            <span className="sr-only">{n.statusLabel}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 3. WHAT ATLAS CHECKED                                               */
/* ------------------------------------------------------------------ */

// ONE STRUCTURED ROW PER QUESTION, inside one section surface. The
// question on the left, the fact on the right in the strongest running
// text of the row; beneath the fact one state line — a glyph in the state
// colour, the state with its source kind, the source, the date — and the
// evidence a tap away in place. The count strip in the header says at a
// glance how much of the story is settled — counted over every check,
// folded supporting checks included, the same set the figures above use.
function FindingsTable({ rows: all }: { rows: readonly ResearchTableRow[] }) {
  const rows = tableRows(all);
  if (rows.length === 0) return null;
  const counts = COUNT_ORDER.map((status) => ({ status, n: all.filter((r) => r.status === status).length })).filter((c) => c.n > 0);
  return (
    <section className="panel-section" data-testid="research-table">
      <div className="flex flex-col gap-2 border-b border-[var(--hairline)] px-5 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 sm:px-6">
        <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">What ATLAS checked</h2>
        <p className="counts" data-testid="research-counts">
          {counts.map((c) => (
            <span key={c.status}>
              <span className="dot" style={{ background: TONE_COLORS[statusTone(c.status)] }} aria-hidden />
              {c.n} {COUNT_WORDS[c.status]}
            </span>
          ))}
        </p>
      </div>
      <ol className="flex flex-col">
        {rows.map((r) => (
          <FindingRow key={r.component} row={r} />
        ))}
      </ol>
    </section>
  );
}

// "Verified from official docs" / "Partly verified from governance" /
// "Contradicted by on-chain record" / "Unresolved" — the state and where
// it came from, in one breath. The source kind is the row's own strongest
// admitted class, lowercased; nothing here names a source that was not
// admitted to the row.
function stateSentence(row: ResearchTableRow): string {
  const word = STATE_WORDS[row.status];
  const kind = row.source?.kind.toLowerCase() ?? null;
  if (!kind) return word;
  if (row.status === "CONTRADICTED") return `${word} by ${kind}`;
  if (row.status === "NOT_ESTABLISHED") return `${word} · ${kind}`;
  return `${word} from ${kind}`;
}

function FindingRow({ row }: { row: ResearchTableRow }) {
  const [open, setOpen] = useState(false);
  const color = TONE_COLORS[row.tone];
  const toggleLabel = open ? "Hide evidence" : `Evidence · ${row.evidence.length}`;
  return (
    <li
      className={`finding ${open ? "finding-open" : ""}`}
      style={{ "--row-accent": color } as React.CSSProperties}
      title={row.statusLabel}
      data-testid="research-row"
      data-component={row.component}
      data-status={row.status}
      data-kind={row.kind}
      data-boundary={row.boundary?.kind ?? ""}
    >
      <p className="text-[1.05rem] font-semibold leading-snug text-[var(--atlas-text-strong)]" data-testid="row-label">
        {row.label}
      </p>
      <div className="min-w-0">
        <p className="text-[1.05rem] leading-[1.5] text-[var(--atlas-text)]" data-testid="row-answer">
          {row.established}
        </p>
        {row.restsOn.length > 0 && (
          <p className="mt-1.5 text-[0.92rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="row-rests-on">
            Also established: {joinPhrases(row.restsOn.map((d) => d.phrase))}.
          </p>
        )}
        <p className="state-line mt-2.5">
          <span className="state-glyph" aria-hidden>
            {STATE_GLYPHS[row.status]}
          </span>
          <span className="state-word" data-testid="row-cue">
            {stateSentence(row)}
          </span>
          <span data-testid="row-source" className="min-w-0">
            {row.source ? <span>{row.source.name}</span> : <span>No qualifying source</span>}
          </span>
          <span data-testid="row-date">{row.date ? row.date.value : ""}</span>
          {row.evidence.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="font-medium text-[var(--atlas-cyan-strong)] hover:underline"
              data-testid="row-evidence-toggle"
            >
              {toggleLabel}
            </button>
          )}
        </p>
        {open && (
          <div className="mt-4 flex flex-col gap-4 border-t border-[var(--hairline)] pt-4" data-testid="row-evidence">
            {row.evidence.map((c) => (
              <EvidenceCardView key={c.id} card={c} open compact />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function joinPhrases(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* 4. EVIDENCE                                                         */
/* ------------------------------------------------------------------ */

// THE FEW SOURCES THE ANSWER RESTS ON, AS EVIDENCE OBJECTS. Each card:
// the kind and the date across the top, the source, one human sentence on
// what it establishes, and the excerpt, the original and the snapshot one
// tap away. Two-up on a desk, stacked on a handset. A contradicting card
// carries a red edge — the one thing a reader must not miss.
function SourcesSection({ cards }: { cards: readonly EvidenceCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section data-testid="sources">
      <div className="flex items-baseline justify-between gap-4 px-1">
        <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">Evidence</h2>
        <p className="text-[0.92rem] text-[var(--atlas-text-dim)]">
          {cards.length} {cards.length === 1 ? "source" : "sources"} behind the answer
        </p>
      </div>
      <ul className="evidence-grid mt-3">
        {cards.map((c, i) => (
          <li key={c.id} className={`evidence-card ${cards.length % 2 === 1 && i === cards.length - 1 ? "evidence-card-wide" : ""}`} data-relation={c.relation}>
            <EvidenceCardView card={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ONE SOURCE, INSPECTED IN PLACE. Collapsed: what kind of source it is,
// when, who published it, and one sentence on what it establishes. Open:
// the exact excerpt (a chain reading stays translated), what it does not
// prove only where the extractor recorded a specific limit, and the two
// ways to read it in full. `compact` is the in-row form under a finding.
export function EvidenceCardView({ card, open: openByDefault = false, compact = false }: { card: EvidenceCard; open?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(openByDefault);
  const contradicts = card.relation === "CONTRADICTS";
  return (
    <div data-testid="evidence-card" data-evidence-id={card.id} data-relation={card.relation} data-open={open ? "true" : "false"}>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[0.88rem] text-[var(--atlas-text-dim)]">
        <span className={`kind ${card.onchain ? "kind-onchain" : ""}`}>{card.sourceClass}</span>
        {card.onchain?.network && <span>{card.onchain.network}</span>}
        {card.date && (
          <span>
            {card.date.label} {card.date.value}
          </span>
        )}
        {contradicts && (
          <span className="font-semibold" style={{ color: TONE_COLORS.negative }}>
            Contradicts
          </span>
        )}
      </p>
      <p className={`${compact ? "mt-1.5" : "mt-2"} text-[1.02rem] font-semibold leading-snug text-[var(--atlas-text-strong)]`} data-testid="evidence-source">
        {card.sourceName}
      </p>
      <p className="mt-1 text-[1rem] leading-[1.5] text-[var(--atlas-text)]/90" data-testid="evidence-tells">
        {sourceSentence(card)}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.88rem] font-medium">
        {!card.onchain && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-[var(--atlas-cyan-strong)] hover:underline" data-testid="evidence-details-toggle">
            {open ? "Hide excerpt" : "View excerpt"}
          </button>
        )}
        {card.openable && (
          <a href={card.url} target="_blank" rel="noopener noreferrer" className="text-[var(--atlas-text-dim)] hover:text-[var(--atlas-text)] hover:underline" data-testid="evidence-open-original">
            Open original
          </a>
        )}
        {card.snapshotHref && (
          <Link href={card.snapshotHref} className="text-[var(--atlas-text-dim)] hover:text-[var(--atlas-text)] hover:underline" data-testid="evidence-snapshot">
            Snapshot
          </Link>
        )}
      </p>
      {open && !card.onchain && (
        <div className="mt-3 flex flex-col gap-3" data-testid="evidence-details">
          <blockquote className="border-l-2 border-[var(--hairline-strong)] pl-4 text-[1rem] leading-[1.55] text-[var(--atlas-text)]/85" data-testid="evidence-excerpt">
            {card.excerpt}
          </blockquote>
          {card.doesNotProve && (
            <p className="text-[0.9rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="evidence-does-not-prove">
              Does not prove: {card.doesNotProve}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. WHAT REMAINS UNCLEAR                                             */
/* ------------------------------------------------------------------ */

// ONLY THE RESEARCH BOUNDARY — never a row repeated. A row already says
// what was not established and, for a substantive gap, why. What it
// cannot say is that the run hit its configured limit with known sources
// unread, or that ATLAS has no supported route for this project: that is
// stated here, once per kind, as one intentional surface, with the checks
// it applies to listed one per line.
const UNCLEAR_HEADINGS: Record<BoundaryGroup["kind"], string> = {
  TECHNICAL: "Research limit reached",
  CONFIGURATION: "No supported source route yet",
  SUBSTANTIVE: "Checked, not found",
};

function UnclearSection({ groups }: { groups: readonly BoundaryGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="panel-section tone-edge" style={{ "--edge": "var(--atlas-amber)" } as React.CSSProperties} data-testid="unclear-section">
      <div className="border-b border-[var(--hairline)] px-5 py-4 sm:px-6">
        <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">What remains unclear</h2>
      </div>
      <div className="flex flex-col">
        {groups.map((g) => (
          <div key={g.kind} className="border-b border-[var(--hairline)] px-5 py-5 last:border-b-0 sm:px-6" data-testid="unclear-group" data-kind={g.kind}>
            <p className="text-[1.05rem] font-semibold leading-snug text-[var(--atlas-text-strong)]">{UNCLEAR_HEADINGS[g.kind]}</p>
            <p className="mt-1.5 text-[1rem] leading-[1.5] text-[var(--atlas-text)]/90" data-testid="unclear-copy">
              {g.kind === "TECHNICAL" && g.remainingPaths !== null
                ? `Research reached its configured limit before ${g.remainingPaths} known relevant ${g.remainingPaths === 1 ? "source" : "sources"} could be checked.`
                : g.copy}
            </p>
            <ul className="mt-3 flex flex-col gap-1.5" data-testid="unclear-items">
              {g.items.map((it) => (
                <li key={it.component} className="flex items-start gap-2.5 text-[0.98rem] leading-snug">
                  <span className="state-glyph mt-[0.2rem]" style={{ background: "var(--atlas-slate)" }} aria-hidden>
                    ?
                  </span>
                  <span>
                    <span className="font-medium text-[var(--atlas-text)]">{it.label}</span>
                    {it.detail && <span className="text-[var(--atlas-text-dim)]"> — {it.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[0.9rem] text-[var(--atlas-text-dim)]" data-testid="unclear-never">
              {g.never}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
