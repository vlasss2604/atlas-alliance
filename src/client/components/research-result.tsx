"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobDetail } from "../api";
import {
  buildResultSurface,
  sourceSentence,
  statusTone,
  tableRows,
  type BoundaryGroup,
  type EvidenceCard,
  type ResearchTableRow,
  type ResultStatus,
  type ResultSurface,
} from "../result-surface";
import { type JobState, type VerdictTone } from "../research-model";
import { OutcomeBadge } from "./verdict-badge";

// THE COMPLETED RESEARCH V4 — ONE SURFACE, FOUR SECTIONS AND A DOOR.
//
//   1. QUESTION + ANSWER      the project, the question, the state, and
//                             2–4 sentences — the first one carries it
//   2. WHAT ATLAS CHECKED     one row per question the research turns on,
//                             with a count strip: confirmed · partly · unclear
//   3. SOURCES                the 3–5 sources the answer rests on
//   4. WHAT REMAINS UNCLEAR   only where the research boundary adds
//                             something the rows cannot say
//   →  OPEN FULL AUDIT        the same questions, at depth
//
// THE USER READS THE PROJECT, NOT THE ENGINE. Every label is a question a
// reader would ask; every cell is a fact in plain words; a status is a
// coloured spine beside the fact and never the fact itself. Every value
// arrives derived in `result-surface.ts` from persisted rows: nothing is
// decided, written or chosen here. PAGE <= PERSISTED VERIFIED RECORD.

const TONE_COLORS: Record<VerdictTone, string> = {
  supported: "var(--atlas-green)",
  partial: "var(--atlas-amber)",
  negative: "var(--atlas-red)",
  insufficient: "var(--atlas-slate)",
  fault: "var(--atlas-slate)",
  neutral: "var(--atlas-slate)",
};

// The count strip's words — a reader's, not a status vocabulary. The
// canonical status label stays on each row's cue as its title.
const COUNT_WORDS: Record<ResultStatus, string> = {
  CONFIRMED: "confirmed",
  PARTIAL: "partly",
  NOT_ESTABLISHED: "unclear",
  CONTRADICTED: "contradicted",
};
const COUNT_ORDER: ResultStatus[] = ["CONFIRMED", "PARTIAL", "CONTRADICTED", "NOT_ESTABLISHED"];

export function ResearchResult({ detail, jobId }: { detail: ResearchJobDetail; jobId: string | null }) {
  const surface = buildResultSurface(detail);
  const projectName = detail.job.projectName ?? detail.job.projectTicker ?? "Unresolved project";
  return (
    <article className="flex flex-col gap-10 sm:gap-12" data-testid="research-result">
      <AnswerPanel surface={surface} detail={detail} projectName={projectName} />
      <FindingsTable rows={surface.table} />
      <SourcesSection cards={surface.keyEvidence} />
      <UnclearSection groups={surface.boundary} />
      {jobId && (
        <p className="pb-2">
          <Link
            href={`/research/${jobId}/audit`}
            className="btn-secondary px-5 py-3 text-[0.98rem]"
            data-testid="audit-entry"
          >
            Open full audit
            <Chevron />
          </Link>
        </p>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* 1. QUESTION + ANSWER                                                */
/* ------------------------------------------------------------------ */

// THE ONE RAISED SURFACE ON THE PAGE. The project is an identity line;
// the question is the heading; the state is one badge beneath it; the
// answer is the largest running text on the screen, its first sentence
// carrying the weight; the dates are one quiet footnote — metadata,
// never the headline.
function AnswerPanel({ surface, detail, projectName }: { surface: ResultSurface; detail: ResearchJobDetail; projectName: string }) {
  const { job, proof } = detail;
  const lead = surface.answer.sentences[0];
  return (
    <section className="panel px-5 py-6 sm:px-9 sm:py-9" data-testid="answer-panel">
      <p className="text-[0.95rem] font-medium text-[var(--atlas-text-dim)]">{projectName}</p>
      <h1
        className="display mt-2 text-[1.4rem] font-semibold leading-[1.2] text-[var(--atlas-text-strong)] sm:text-[1.9rem]"
        data-testid="result-question"
      >
        {job.originalQuestion}
      </h1>
      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="answer-state">
        <OutcomeBadge job={{ state: job.state as JobState, verdict: proof?.verdict ?? null }} />
      </div>
      <div className="mt-5 flex flex-col gap-3 text-[1.15rem] leading-[1.5] sm:text-[1.25rem] sm:leading-[1.5]" data-testid="answer-text">
        {surface.answer.sentences.map((s) => (
          <p key={s} className={s === lead ? "font-medium text-[var(--atlas-text-strong)]" : "text-[var(--atlas-text)]/90"}>
            {s}
          </p>
        ))}
      </div>
      <p
        className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--hairline)] pt-4 text-[0.88rem] text-[var(--atlas-text-dim)]"
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

/* ------------------------------------------------------------------ */
/* 2. WHAT ATLAS CHECKED                                               */
/* ------------------------------------------------------------------ */

// ONE ROW PER QUESTION. The question is the strongest text in the row;
// the answer beneath it is the fact; the status is the row's coloured
// spine (titled with its word on the small cue) — a cue, not a word the
// reader must decode. Source and date are one quiet line, with the
// evidence a tap away in place. The count strip above says at a glance
// how much of the story is settled.
function FindingsTable({ rows: all }: { rows: readonly ResearchTableRow[] }) {
  const rows = tableRows(all);
  if (rows.length === 0) return null;
  const counts = COUNT_ORDER.map((status) => ({ status, n: rows.filter((r) => r.status === status).length })).filter((c) => c.n > 0);
  return (
    <section data-testid="research-table">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
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
      <ol className="mt-3 flex flex-col">
        {rows.map((r) => (
          <FindingRow key={r.component} row={r} />
        ))}
      </ol>
    </section>
  );
}

function FindingRow({ row }: { row: ResearchTableRow }) {
  const [open, setOpen] = useState(false);
  const color = TONE_COLORS[row.tone];
  const toggleLabel = open ? "Hide evidence" : `Evidence · ${row.evidence.length}`;
  return (
    <li
      className={`finding ${open ? "finding-open" : ""}`}
      style={{ "--row-accent": color } as React.CSSProperties}
      data-testid="research-row"
      data-component={row.component}
      data-status={row.status}
      data-kind={row.kind}
      data-boundary={row.boundary?.kind ?? ""}
    >
      <p className="text-[1.05rem] font-semibold leading-snug text-[var(--atlas-text-strong)]" title={row.statusLabel} data-testid="row-label">
        {/* The status cue: the row's coloured spine, with its word for a
            screen reader. Optional reinforcement — remove it and the
            sentence still says everything. */}
        <span className="sr-only" data-testid="row-cue">
          {row.statusLabel}:{" "}
        </span>
        {row.label}
      </p>
      <p className="mt-1.5 text-[1.02rem] leading-[1.5] text-[var(--atlas-text)]/90" data-testid="row-answer">
        {row.established}
      </p>
      {row.restsOn.length > 0 && (
        <p className="mt-1.5 text-[0.92rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="row-rests-on">
          Also established: {joinPhrases(row.restsOn.map((d) => d.phrase))}.
        </p>
      )}
      <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.88rem] text-[var(--atlas-text-dim)]">
        <span data-testid="row-source" className="min-w-0">
          {row.source ? (
            <>
              <span className="text-[var(--atlas-text)]/80">{row.source.kind}</span>
              <span> · {row.source.name}</span>
            </>
          ) : (
            <span>No qualifying source</span>
          )}
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
        <div className="mt-4 flex flex-col gap-4" data-testid="row-evidence">
          {row.evidence.map((c) => (
            <EvidenceCardView key={c.id} card={c} open />
          ))}
        </div>
      )}
    </li>
  );
}

function joinPhrases(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* 3. SOURCES                                                          */
/* ------------------------------------------------------------------ */

// THE FEW SOURCES THE ANSWER RESTS ON. Publisher, kind, date, one human
// sentence about what it tells us; the excerpt and the original are one
// tap away, in place. No disclaimer on any card.
function SourcesSection({ cards }: { cards: readonly EvidenceCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section data-testid="sources">
      <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">Sources</h2>
      <ul className="mt-1 flex flex-col">
        {cards.map((c) => (
          <li key={c.id} className="border-b border-[var(--hairline)] py-4 last:border-b-0">
            <EvidenceCardView card={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ONE SOURCE, INSPECTED IN PLACE. Collapsed: who published it, what kind
// of source it is, when, and one sentence on what it tells us. Open: the
// exact excerpt (a chain reading stays translated), what it does not
// prove only where the extractor recorded a specific limit, and the two
// ways to read it in full.
export function EvidenceCardView({ card, open: openByDefault = false }: { card: EvidenceCard; open?: boolean }) {
  const [open, setOpen] = useState(openByDefault);
  const contradicts = card.relation === "CONTRADICTS";
  return (
    <div data-testid="evidence-card" data-evidence-id={card.id} data-relation={card.relation} data-open={open ? "true" : "false"}>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[1rem] font-semibold text-[var(--atlas-text-strong)]" data-testid="evidence-source">
          {card.sourceName}
        </span>
        <span className="text-[0.88rem] text-[var(--atlas-text-dim)]">
          {card.sourceClass}
          {card.onchain?.network ? ` · ${card.onchain.network}` : ""}
          {card.date ? ` · ${card.date.label} ${card.date.value}` : ""}
        </span>
        {contradicts && (
          <span className="text-[0.85rem] font-semibold" style={{ color: TONE_COLORS.negative }}>
            Contradicts
          </span>
        )}
      </p>
      <p className="mt-1.5 text-[1rem] leading-[1.5] text-[var(--atlas-text)]/90" data-testid="evidence-tells">
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
/* 4. WHAT REMAINS UNCLEAR                                             */
/* ------------------------------------------------------------------ */

// ONLY THE RESEARCH BOUNDARY — never a row repeated. A row already says
// what was not established and, for a substantive gap, why. What it
// cannot say is that the run hit its configured limit with known sources
// unread, or that ATLAS has no supported route for this project: that is
// stated here, once per kind, with the checks it applies to.
const UNCLEAR_HEADINGS: Record<BoundaryGroup["kind"], string> = {
  TECHNICAL: "Research limit reached",
  CONFIGURATION: "No supported source route yet",
  SUBSTANTIVE: "Checked, not found",
};

function UnclearSection({ groups }: { groups: readonly BoundaryGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section data-testid="unclear-section">
      <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">What remains unclear</h2>
      <div className="mt-3 flex flex-col gap-3">
        {groups.map((g) => (
          <div
            key={g.kind}
            className="panel px-5 py-4 sm:px-6 sm:py-5"
            style={{ borderColor: "rgba(226, 179, 79, 0.28)" }}
            data-testid="unclear-group"
            data-kind={g.kind}
          >
            <p className="text-[1.02rem] font-semibold leading-snug text-[var(--atlas-text-strong)]">{UNCLEAR_HEADINGS[g.kind]}</p>
            <p className="mt-1.5 text-[1rem] leading-[1.5] text-[var(--atlas-text)]/85" data-testid="unclear-copy">
              {g.kind === "TECHNICAL" && g.remainingPaths !== null
                ? `Research reached its configured limit before ${g.remainingPaths} known relevant ${g.remainingPaths === 1 ? "source" : "sources"} could be checked.`
                : g.copy}
            </p>
            <p className="mt-2 text-[0.95rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="unclear-items">
              Applies to: {g.items.map((it) => lowerFirst(it.label)).join(" · ")}
            </p>
            <p className="mt-2 text-[0.9rem] text-[var(--atlas-text-dim)]" data-testid="unclear-never">
              {g.never}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
