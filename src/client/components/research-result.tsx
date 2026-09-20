"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobDetail } from "../api";
import {
  buildResultSurface,
  tableRows,
  type BoundaryGroup,
  type EvidenceCard,
  type ProofNode,
  type ResearchTableRow,
  type ResultSurface,
} from "../result-surface";
import { relativeAge, type EvidenceItemLike, type JobState, type VerdictTone } from "../research-model";
import { JobVerification } from "./job-verification";
import { ResearchProgress } from "./research-progress";
import { ResultLadder } from "./result-ladder";
import { OutcomeBadge } from "./verdict-badge";

// THE COMPLETED RESEARCH RESULT — ONE SURFACE, SIX SECTIONS.
//
//   1. ANSWER            project, the question, verdict, 2–4 sentences
//   2. RESEARCH TABLE    every check the question turns on, one row each
//   3. PROOF MAP         the chain, one status per node
//   4. KEY EVIDENCE      the 3–5 pieces the conclusion rests on
//   5. BOUNDARY          what is not established, and of which kind
//   6. FULL EVIDENCE     everything deeper, behind one disclosure
//
// The first five sections are the answer. A reader who opens nothing else
// should know what ATLAS concluded, why, where the money goes, whether the
// mechanism is executing, what is still unknown and what the main sources
// are — in seconds, not minutes.
//
// PRESENTATION ONLY, AND DELIBERATELY DUMB. Every value here arrives
// derived in `result-surface.ts` from persisted rows. No status is decided
// in this file, no sentence is written in this file, no evidence is chosen
// in this file, and nothing is fetched. PAGE <= PERSISTED VERIFIED RECORD.

// One colour per tone, the product's existing status colours: teal for
// confirmed, violet for partially confirmed, amber for not established,
// red reserved for a contradiction.
const TONE_COLORS: Record<VerdictTone, string> = {
  supported: "#5eead4",
  partial: "#c4b5fd",
  negative: "#fca5a5",
  insufficient: "#fcd34d",
  fault: "#cbd5e1",
  neutral: "#cbd5e1",
};

export function ResearchResult({
  detail,
  jobId,
  deepOpen = false,
}: {
  detail: ResearchJobDetail;
  jobId: string | null;
  // A legacy `?view=verification` / `?view=full` link opens the deep
  // disclosure; nothing navigates and nothing is fetched for it.
  deepOpen?: boolean;
}) {
  const surface = buildResultSurface(detail);
  const { job } = detail;
  const projectName = job.projectName ?? job.projectTicker ?? "Unresolved project";
  // A failed or cancelled run is a product fault, not a finding: it has no
  // verification to compose and no boundary to state.
  const verifiable = surface.outcomeKind !== "FAILED" && surface.outcomeKind !== "CANCELLED";

  return (
    <div className="flex flex-col gap-5" data-testid="research-result">
      <AnswerPanel surface={surface} detail={detail} projectName={projectName} />
      <ResearchTable rows={surface.table} />
      <ProofChainView nodes={surface.chain} />
      <KeyEvidencePanel cards={surface.keyEvidence} />
      <BoundaryPanel groups={surface.boundary} />
      <DeepEvidence detail={detail} jobId={jobId} open={deepOpen} verifiable={verifiable} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1. ANSWER                                                           */
/* ------------------------------------------------------------------ */

function AnswerPanel({
  surface,
  detail,
  projectName,
}: {
  surface: ResultSurface;
  detail: ResearchJobDetail;
  projectName: string;
}) {
  const { job, proof } = detail;
  return (
    <section
      className="panel panel-raised tone-edge p-5 sm:p-7"
      style={{ "--edge": edgeColor(surface.outcomeKind, proof?.verdict ?? null) } as React.CSSProperties}
      data-testid="answer-panel"
    >
      <div className="flex items-center gap-3">
        <span className="orb h-10 w-10 shrink-0 text-[0.8rem] font-semibold text-[var(--atlas-cyan)]" aria-hidden>
          {projectName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow eyebrow-violet">Research result</p>
          <p className="mt-0.5 text-[1rem] font-semibold leading-tight tracking-tight">{projectName}</p>
        </div>
      </div>

      <p className="eyebrow mt-5" style={{ color: "var(--atlas-text-dim)" }}>
        Your question
      </p>
      <h1 className="mt-2 text-[1.16rem] font-semibold leading-snug tracking-tight sm:text-[1.3rem]" data-testid="result-question">
        {job.originalQuestion}
      </h1>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--hairline)] pt-4">
        <OutcomeBadge job={{ state: job.state as JobState, verdict: proof?.verdict ?? null }} />
        {surface.answer.confidenceLabel && (
          <span className="tone tone-neutral" data-testid="confidence-band">
            {surface.answer.confidenceLabel} confidence
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[0.72rem] text-[var(--atlas-text-dim)]">
          <ClockIcon />
          {relativeAge(job.finishedAt)}
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-2.5 text-[1.02rem] leading-relaxed" data-testid="answer-text">
        {surface.answer.sentences.map((s) => (
          <p key={s}>{s}</p>
        ))}
      </div>

      {/* FRESHNESS, STATED ONCE AT THE TOP: when the evidence was checked,
          and how recent the most recent admitted source is. Both are
          persisted dates; neither is a score. */}
      {(surface.checkedOn || surface.latestEvidence) && (
        <p className="mt-5 flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--hairline)] pt-3.5 text-[0.75rem] text-[var(--atlas-text-dim)]" data-testid="answer-freshness">
          {surface.checkedOn && <span>Evidence checked {surface.checkedOn}</span>}
          {surface.latestEvidence && (
            <span>
              · Latest source {surface.latestEvidence.label.toLowerCase()} {surface.latestEvidence.value}
            </span>
          )}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 2. RESEARCH TABLE                                                   */
/* ------------------------------------------------------------------ */

// THE PRIMARY RESULT SURFACE. One row per check the question turns on:
// what was checked, its status, what the evidence established in one or
// two lines, the strongest source and its date — and, one tap away, the
// evidence behind the row, inline. A row's status word comes from the
// closed vocabulary and nothing else.
function ResearchTable({ rows: all }: { rows: readonly ResearchTableRow[] }) {
  const rows = tableRows(all);
  if (rows.length === 0) return null;
  return (
    <section className="panel px-4 py-4 sm:px-6 sm:py-5" data-testid="research-table">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow eyebrow-violet">What was checked</p>
        <p className="text-[0.68rem] text-[var(--atlas-text-dim)]">{all.length} checks</p>
      </div>
      {/* Column heads on a wide screen; on a handset each row carries its
          own labels, so the heads would only take a line. */}
      <div className="mt-3 hidden grid-cols-[minmax(0,1.3fr)_8.5rem_minmax(0,2fr)_minmax(0,1fr)] gap-x-4 border-b border-[var(--hairline)] pb-2 text-[0.64rem] font-semibold uppercase tracking-[0.06em] text-[var(--atlas-text-dim)] sm:grid">
        <span>Check</span>
        <span>Status</span>
        <span>What the evidence established</span>
        <span>Source</span>
      </div>
      <ol className="flex flex-col">
        {rows.map((r) => (
          <TableRow key={r.component} row={r} />
        ))}
      </ol>
    </section>
  );
}

function TableRow({ row }: { row: ResearchTableRow }) {
  const [open, setOpen] = useState(false);
  const color = TONE_COLORS[row.tone];
  return (
    <li
      className="border-b border-[var(--hairline)] py-3.5 last:border-b-0"
      data-testid="research-row"
      data-component={row.component}
      data-status={row.status}
      data-boundary={row.boundary?.kind ?? ""}
      data-primary={row.primary ? "true" : "false"}
    >
      <div className="grid grid-cols-1 gap-y-1.5 sm:grid-cols-[minmax(0,1.3fr)_8.5rem_minmax(0,2fr)_minmax(0,1fr)] sm:gap-x-4">
        {/* CHECK + STATUS. On a handset they share one line; the status is
            the first thing the eye lands on, so it keeps its colour and its
            word wherever it sits. */}
        <div className="flex items-start justify-between gap-3 sm:block">
          <p className="min-w-0 text-[0.88rem] font-medium leading-snug" data-testid="row-label">
            {row.label}
          </p>
          <StatusChip label={row.statusLabel} color={color} className="sm:hidden" />
        </div>
        <div className="hidden sm:block">
          <StatusChip label={row.statusLabel} color={color} />
        </div>
        <div>
          <p className="text-[0.84rem] leading-snug text-[var(--atlas-text)]/85" data-testid="row-established">
            {row.established}
          </p>
          {/* THE CHECKS THIS FINDING LEANS ON, each with its own status —
              folded here rather than listed as rows of their own, so the
              table stays the question's rows and the proof map stays the
              whole chain. */}
          {row.restsOn.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.68rem] text-[var(--atlas-text-dim)]" data-testid="row-rests-on">
              <span>Rests on</span>
              {row.restsOn.map((d) => (
                <span key={d.component} className="inline-flex items-center gap-1" data-testid="rests-on-item" data-component={d.component} data-status={d.status}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_COLORS[d.tone] }} aria-hidden />
                  <span className="text-[var(--atlas-text)]/75">{d.label}</span>
                  <span style={{ color: TONE_COLORS[d.tone] }}>· {d.statusLabel}</span>
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-[var(--atlas-text-dim)] sm:flex-col sm:items-start sm:gap-y-0.5">
          {row.source ? (
            <span data-testid="row-source">
              <span className="font-medium text-[var(--atlas-text)]/80">{row.source.kind}</span>
              <span className="text-[var(--atlas-text-dim)]"> · {row.source.name}</span>
            </span>
          ) : (
            <span data-testid="row-source" className="text-[var(--atlas-text-dim)]/70">
              No admitted source
            </span>
          )}
          {row.date && (
            <span data-testid="row-date">
              {row.date.label} {row.date.value}
            </span>
          )}
          {row.evidence.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-[0.72rem] font-medium text-[var(--atlas-cyan)] hover:underline"
              data-testid="row-evidence-toggle"
            >
              {open ? "Hide evidence" : "Evidence"}
              <span className="font-normal text-[var(--atlas-text-dim)]">· {row.evidence.length}</span>
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-3 flex flex-col gap-2.5" data-testid="row-evidence">
          {row.evidence.map((c) => (
            <EvidenceCardView key={c.id} card={c} compact />
          ))}
        </div>
      )}
    </li>
  );
}

function StatusChip({ label, color, className = "" }: { label: string; color: string; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[0.66rem] font-semibold uppercase tracking-[0.05em] ${className}`}
      style={{ color }}
      data-testid="row-status"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }} aria-hidden />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 3. PROOF MAP                                                        */
/* ------------------------------------------------------------------ */

// THE CHAIN THE QUESTION TURNS ON, top to bottom in proof-path order. Each
// node: a name, a status, and the kind of source behind it. No paragraph
// under any node — the table above and the boundary below carry the words.
function ProofChainView({ nodes }: { nodes: readonly ProofNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <section className="panel px-4 py-4 sm:px-6 sm:py-5" data-testid="proof-chain">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Proof map
      </p>
      <ol className="mt-3 flex flex-col">
        {nodes.map((n, i) => {
          const color = TONE_COLORS[n.tone];
          return (
            <li
              key={n.component}
              className="flex items-center gap-3 py-1.5"
              data-testid="proof-node"
              data-component={n.component}
              data-status={n.status}
            >
              <span className="relative flex w-3 shrink-0 justify-center self-stretch" aria-hidden>
                <span className="mt-[0.45rem] h-2.5 w-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }} />
                {i < nodes.length - 1 && (
                  <span className="absolute left-1/2 top-[1.05rem] h-[calc(100%-0.3rem)] w-px -translate-x-1/2" style={{ background: "var(--hairline-strong)" }} />
                )}
              </span>
              <span className="min-w-0 flex-1 text-[0.86rem] font-medium leading-snug">{n.label}</span>
              {n.sourceKind && (
                <span className="hidden text-[0.68rem] text-[var(--atlas-text-dim)] sm:inline" data-testid="proof-node-source">
                  {n.sourceKind}
                </span>
              )}
              <span className="shrink-0 text-[0.64rem] font-semibold uppercase tracking-[0.05em]" style={{ color }} data-testid="proof-node-status">
                {n.statusLabel}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 4. KEY EVIDENCE                                                     */
/* ------------------------------------------------------------------ */

function KeyEvidencePanel({ cards }: { cards: readonly EvidenceCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section className="panel px-4 py-4 sm:px-6 sm:py-5" data-testid="key-evidence">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Key evidence
      </p>
      <ul className="mt-2 flex flex-col">
        {cards.map((c) => (
          <li key={c.id} className="border-t border-[var(--hairline)] py-3 first:border-t-0">
            <EvidenceCardView card={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ONE EVIDENCE CARD, INSPECTED IN PLACE. Collapsed: the source, what it
// proves, its date. Expanded — the reader stays on the result: the exact
// excerpt, why this kind of source was used, what it does not prove, and
// the two ways to read it in full. A chain observation is translated into
// a sentence; the raw integer never appears.
export function EvidenceCardView({ card, compact = false }: { card: EvidenceCard; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const contradicts = card.relation === "CONTRADICTS";
  return (
    <div
      className={compact ? "rounded-xl border border-[var(--hairline)] bg-[rgba(255,255,255,0.022)] px-3.5 py-3" : ""}
      data-testid="evidence-card"
      data-evidence-id={card.id}
      data-relation={card.relation}
      data-open={open ? "true" : "false"}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem]">
        <span className="font-medium text-[var(--atlas-text)]/85" data-testid="evidence-source">
          {card.sourceName}
        </span>
        <span className="text-[var(--atlas-text-dim)]">· {card.sourceClass}</span>
        {card.onchain?.network && <span className="text-[var(--atlas-text-dim)]">· {card.onchain.network}</span>}
        {card.date && (
          <span className="text-[var(--atlas-text-dim)]" data-testid="evidence-date">
            · {card.date.label} {card.date.value}
          </span>
        )}
        {contradicts && (
          <span className="rounded-md border px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wider" style={{ color: TONE_COLORS.negative, borderColor: "rgba(248,113,113,0.4)" }}>
            Contradicts
          </span>
        )}
      </p>
      {card.onchain && (
        <p className="mt-1.5 text-[0.9rem] font-medium leading-snug" data-testid="evidence-observation">
          {card.onchain.observation}
        </p>
      )}
      <p className="mt-1 text-[0.7rem] text-[var(--atlas-text-dim)]">
        <span className="font-semibold uppercase tracking-[0.04em]">What it proves</span> · {card.claim}
      </p>
      {/* A chain reading's observation line above IS what it proves;
          repeating it here would be the same sentence twice. */}
      {!card.onchain && (
        <p className="mt-0.5 text-[0.86rem] leading-relaxed" data-testid="evidence-proves">
          {card.proves}
        </p>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.74rem] font-medium">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-[var(--atlas-cyan)] hover:underline"
          data-testid="evidence-details-toggle"
        >
          {open ? "Hide details" : "Details"}
        </button>
        {card.snapshotHref && (
          <Link href={card.snapshotHref} className="text-[var(--atlas-text-dim)] hover:text-[var(--atlas-cyan)] hover:underline" data-testid="evidence-snapshot">
            Source snapshot
          </Link>
        )}
        {card.openable && (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--atlas-text-dim)] hover:text-[var(--atlas-cyan)] hover:underline"
            data-testid="evidence-open-original"
          >
            Open source
          </a>
        )}
      </p>
      {open && (
        <div className="mt-3 flex flex-col gap-3 border-t border-[var(--hairline)] pt-3" data-testid="evidence-details">
          {!card.onchain && (
            <div>
              <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
                Relevant excerpt
              </p>
              <blockquote className="mt-1.5 border-l-2 border-[rgba(45,212,191,0.4)] pl-3 text-[0.84rem] leading-relaxed text-[var(--atlas-text)]/92" data-testid="evidence-excerpt">
                {card.excerpt}
              </blockquote>
            </div>
          )}
          {card.whyUsed && (
            <div>
              <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
                Why this source
              </p>
              <p className="mt-1 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]">{card.whyUsed}</p>
            </div>
          )}
          {card.doesNotProve && (
            <div>
              <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
                What it does not prove
              </p>
              <p className="mt-1 text-[0.8rem] leading-relaxed text-[var(--atlas-text-dim)]" data-testid="evidence-does-not-prove">
                {card.doesNotProve}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. WHAT IS NOT ESTABLISHED / RESEARCH BOUNDARY                      */
/* ------------------------------------------------------------------ */

// ONE COMPACT BLOCK, THREE KINDS. A technical limit, a configuration limit
// and a substantive gap read differently, on purpose: the first two say
// something about the run and ATLAS's reach, the third about the evidence
// checked. None of them says the thing is absent, and the block says so.
const BOUNDARY_HEADINGS: Record<BoundaryGroup["kind"], string> = {
  TECHNICAL: "Research limit reached",
  CONFIGURATION: "Outside currently supported evidence routes",
  SUBSTANTIVE: "Not established after checking",
};

function BoundaryPanel({ groups }: { groups: readonly BoundaryGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="panel px-4 py-4 sm:px-6 sm:py-5" data-testid="boundary-section">
      <p className="eyebrow" style={{ color: "#fcd34d" }}>
        What is not established
      </p>
      <div className="mt-2 flex flex-col gap-4">
        {groups.map((g) => (
          <div key={g.kind} data-testid="boundary-group" data-kind={g.kind}>
            <p className="text-[0.86rem] font-medium leading-snug">{BOUNDARY_HEADINGS[g.kind]}</p>
            <p className="mt-0.5 text-[0.8rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="boundary-copy">
              {g.copy}
              {g.remainingPaths !== null && ` ${g.remainingPaths} known ${g.remainingPaths === 1 ? "source was" : "sources were"} left unread.`}
              {g.sharedDetail && ` ${g.sharedDetail}`}
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {g.items.map((it) => (
                <li key={it.component} className="text-[0.8rem] leading-snug" data-testid="boundary-item" data-component={it.component}>
                  <span className="font-medium">{it.label}</span>
                  {it.detail && <span className="text-[var(--atlas-text-dim)]"> — {it.detail}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[0.72rem] text-[var(--atlas-text-dim)]" data-testid="boundary-never">
              {g.never}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 6. FULL EVIDENCE & AUDIT                                            */
/* ------------------------------------------------------------------ */

// EVERYTHING DEEPER, BEHIND ONE DISCLOSURE. The full ladder with every row
// and excerpt, the verification composition, the audit entry and the
// research process. Nothing here is fetched or recomputed: it is the same
// object, read further down.
function DeepEvidence({
  detail,
  jobId,
  open,
  verifiable,
}: {
  detail: ResearchJobDetail;
  jobId: string | null;
  open: boolean;
  verifiable: boolean;
}) {
  const { job, components } = detail;
  const snapshotIds = new Set(detail.snapshotEvidenceIds);
  const sourceClassesByComponent: Record<string, string[]> = {};
  const evidenceByComponent: Record<string, EvidenceItemLike[]> = {};
  const supportingSummariesByComponent: Record<string, string[]> = {};
  for (const e of detail.evidence) {
    for (const link of e.links) {
      // An excluded row is never proof of anything; it stays in the audit.
      if (link.role === "EXCLUDED") continue;
      if (e.sourceClass) {
        const classes = (sourceClassesByComponent[link.component] ??= []);
        if (!classes.includes(e.sourceClass)) classes.push(e.sourceClass);
      }
      const list = (evidenceByComponent[link.component] ??= []);
      if (!list.some((x) => x.id === e.id)) {
        list.push({
          id: e.id,
          component: e.component,
          summary: e.summary,
          fragment: e.fragment,
          doesNotProve: e.doesNotProve,
          sourceClass: e.sourceClass,
          officiality: e.officiality,
          retrievedUrl: e.retrievedUrl,
          fetchedAt: e.fetchedAt,
          sourceTitle: e.sourceTitle,
          hasSnapshot: snapshotIds.has(e.id),
        });
      }
      if (link.role === "SUPPORTING" && e.summary) {
        (supportingSummariesByComponent[link.component] ??= []).push(e.summary);
      }
    }
  }
  return (
    <details className="panel group px-4 py-3.5 sm:px-6 sm:py-4" open={open} data-testid="full-evidence">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[0.8rem] font-medium text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-text)]/85 [&::-webkit-details-marker]:hidden">
        <Chevron />
        Full evidence and audit
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <ResultLadder
          components={components}
          jobId={jobId}
          sourceClassesByComponent={sourceClassesByComponent}
          evidenceByComponent={evidenceByComponent}
          supportingSummariesByComponent={supportingSummariesByComponent}
          questionFindings={detail.questionFindings}
        />
        {verifiable && (
          <div data-testid="verification-view">
            <JobVerification detail={detail} />
          </div>
        )}
        <div className="flex flex-col gap-4" data-testid="progress-slot-finished">
          {jobId && (
            <Link
              href={`/research/${jobId}/audit`}
              className="panel flex w-full items-center gap-2.5 px-5 py-4 text-[0.8rem] text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-text)]/85"
              data-testid="audit-entry"
            >
              <Chevron />
              Full research audit
            </Link>
          )}
          <ResearchProgress job={job} />
        </div>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* glyphs and tones                                                    */
/* ------------------------------------------------------------------ */

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 transition-transform group-open:rotate-90">
      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6 3.4V6l1.8 1.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

// The verdict's colour, restated once at the edge of the answer panel.
function edgeColor(outcomeKind: string, verdict: string | null): string {
  if (outcomeKind === "FAILED") return "rgba(148, 163, 184, 0.55)";
  if (outcomeKind !== "VERDICT") return "rgba(148, 163, 184, 0.35)";
  switch (verdict) {
    case "SUPPORTED":
      return "rgba(45, 212, 191, 0.75)";
    case "PARTIALLY_SUPPORTED":
      return "rgba(167, 139, 250, 0.75)";
    case "NOT_SUPPORTED":
      return "rgba(248, 113, 113, 0.75)";
    case "INSUFFICIENT_EVIDENCE":
      return "rgba(251, 191, 36, 0.7)";
    default:
      return "rgba(148, 163, 184, 0.35)";
  }
}
