"use client";

import Link from "next/link";
import { useState } from "react";

import type { ResearchJobDetail } from "../api";
import {
  buildResultSurface,
  mechanismNounOf,
  PROOF_PATH_ORDER,
  RESULT_STATE_WORDS,
  sourceSentence,
  statementPhraseFor,
  tableRows,
  type AnswerKind,
  type BoundaryKind,
  type EvidenceCard,
  type ProofNode,
  type ResearchTableRow,
  type ResultStatus,
  type ResultSurface,
} from "../result-surface";
import { useDict } from "../app-context";
import type { Dict } from "../i18n/en";
import { getPlatform } from "../platform";
import { canonicalDocumentKey, domainOf, exclusionLabel, SOURCE_CLASS_LABELS, sourceClassCaveat, verdictTone, type JobState } from "../research-model";
import { CalendarIcon, ChevronIcon, ExternalIcon, QuoteIcon, SnapshotIcon, SourceKindIcon, sourceKindFamily } from "./icons";
import { ProjectAvatar } from "./project-avatar";
import { OutcomeBadge } from "./verdict-badge";

// THE COMPLETED RESEARCH — V7 (docs/design/v7, HANDOFF §4.3).
//
//   head                      the project and the question
//   1. ANSWER PANEL           a ring of N segments (one per checked
//                             component, in PROOF_PATH_ORDER), the verdict,
//                             the confidence, four figures, the answer
//   2. RESEARCH PATH          the same components as a horizontal strip
//   3. WHAT ATLAS CHECKED     one card per question; evidence in place
//   4. EVIDENCE               the 3–5 sources the answer rests on
//   5. WHAT REMAINS UNCLEAR   one card per unresolved link: its boundary
//                             kind, what is not established, why, what
//                             could help, the sources found but not admitted
//   →  OPEN FULL AUDIT
//
// THE USER READS THE PROJECT, NOT THE ENGINE. Every value arrives derived
// in `result-surface.ts` from persisted rows: nothing is decided, written
// or chosen here. The ring, the strip and the bar are new PRESENTATIONS of
// the same statuses (D6) — they replace the old proof map, add no state.
// Numbers are never animated: figures render at their real values.

// THE STATE, IN A READER'S WORD — shared with the audit so both surfaces
// say the same thing beside the same fact.
const STATE_WORDS = RESULT_STATE_WORDS;
const COUNT_ORDER: ResultStatus[] = ["CONFIRMED", "PARTIAL", "CONTRADICTED", "NOT_ESTABLISHED"];
// The answer block of each kind borrows the glyph and colour of the row
// state it was written from — the same closed mapping, nothing new.
const ANSWER_KIND_STATUS: Record<Exclude<AnswerKind, "NONE">, ResultStatus> = {
  CONTRADICTED: "CONTRADICTED",
  CONFIRMED: "CONFIRMED",
  PARTIAL: "PARTIAL",
  OPEN: "NOT_ESTABLISHED",
};
// The confidence bands, weakest first: the bar lights one cell per band.
const CONFIDENCE_ORDER = ["Low", "Limited", "Strong", "Very strong"];

export function ResearchResult({ detail, jobId }: { detail: ResearchJobDetail; jobId: string | null }) {
  const dict = useDict();
  const surface = buildResultSurface(detail);
  const projectName = detail.job.projectName ?? detail.job.projectTicker ?? dict.detailPage.unresolvedProject;
  const noun = mechanismNounOf([detail.job.originalQuestion, ...surface.table.filter((r) => r.primary).map((r) => r.label)]);
  return (
    <article className="flex flex-col gap-[18px]" data-testid="research-result">
      <ResultHead detail={detail} projectName={projectName} />
      <AnswerPanel surface={surface} detail={detail} />
      <ResearchPath chain={surface.chain} noun={noun} />
      <FindingsTable rows={surface.table} jobId={jobId} />
      <SourcesSection cards={surface.keyEvidence} jobId={jobId} />
      <UnclearSection surface={surface} detail={detail} noun={noun} />
      {jobId && (
        <p className="pb-2">
          <Link href={`/research/${jobId}/audit`} className="btn-secondary px-5 py-3 text-[0.98rem]" data-testid="audit-entry">
            {dict.result.openAudit}
            <ChevronIcon size={14} />
          </Link>
        </p>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* HEAD — the project and the question                                 */
/* ------------------------------------------------------------------ */

function ResultHead({ detail, projectName }: { detail: ResearchJobDetail; projectName: string }) {
  const dict = useDict();
  const { job } = detail;
  return (
    <header className="rise -mt-2 flex flex-col gap-3">
      <p className="flex h-8 items-center gap-2.5">
        <ProjectAvatar name={job.projectName} ticker={job.projectTicker} slug={job.projectSlug} size={32} />
        <span className="text-[15px] leading-5 font-bold text-[var(--atlas-text-strong)]">{projectName}</span>
        <span className="text-[13px] leading-5 text-[var(--atlas-text-dim)]">{dict.result.label}</span>
      </p>
      <h1 className="result-title" data-testid="result-question">
        {job.originalQuestion}
      </h1>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* 1. ANSWER PANEL                                                     */
/* ------------------------------------------------------------------ */

function AnswerPanel({ surface, detail }: { surface: ResultSurface; detail: ResearchJobDetail }) {
  const { job, proof } = detail;
  const dict = useDict();
  const lead = surface.answer.sentences[0];
  const stats = workFigures(surface, dict);
  const confirmed = surface.chain.filter((n) => n.status === "CONFIRMED").length;
  const counts = COUNT_ORDER.map((status) => ({ status, n: surface.chain.filter((n) => n.status === status).length })).filter((c) => c.n > 0);
  const band = surface.answer.confidenceLabel;
  const bandAt = band ? CONFIDENCE_ORDER.indexOf(band) : -1;
  return (
    <section className="answer-v7 status-fade" style={{ animationDelay: "68ms" }} data-testid="answer-panel">
      <span className="scanner-line" aria-hidden />
      <div className="flex items-center gap-4 px-4 py-[18px]">
        {surface.chain.length > 0 && (
          <div className="proof-ring" data-testid="proof-ring">
            <ProofRing chain={surface.chain} />
            <span className="proof-ring-center">
              <span className="proof-ring-n">
                {confirmed}
                <span className="text-[var(--atlas-text-faint)]">/{surface.chain.length}</span>
              </span>
              <span className="text-[11px] leading-[13px] text-[var(--atlas-text-dim)]">{dict.result.figures.verified}</span>
            </span>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="answer-pill" data-testid="answer-state">
            <OutcomeBadge job={{ state: job.state as JobState, verdict: proof?.verdict ?? null }} />
          </div>
          {band && (
            <div className="flex flex-col gap-1.5" data-testid="answer-confidence" data-tone={verdictTone(proof?.verdict)}>
              {bandAt >= 0 && (
                <span className="confidence-bar" aria-hidden>
                  {CONFIDENCE_ORDER.map((b, i) => (
                    <span key={b} className={i <= bandAt ? "confidence-on" : ""} />
                  ))}
                </span>
              )}
              <span className="text-[13px] leading-4 text-[var(--atlas-text-soft)]">
                {dict.result.confidence(dict.result.confidenceWords[band] ?? band)}
              </span>
            </div>
          )}
          {counts.length > 0 && (
            <ul className="flex flex-col gap-1 text-[12px] leading-4 text-[var(--atlas-text-dim)]">
              {counts.map((c) => (
                <li key={c.status} className="flex items-center gap-2">
                  <span className="legend-dot" data-status={c.status} aria-hidden />
                  {c.n} {dict.result.counts[c.status]}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {stats.length > 0 && (
        <div className="figures-row" data-testid="answer-stats">
          {stats.map((s) => (
            <div key={s.key} className={`figure ${s.key === "verified" ? "figure-verified" : ""}`}>
              <span className="figure-n">{s.n}</span>
              <span className="figure-l">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      {/* THE ANSWER, IN HEADED BLOCKS (the approved design). Each block is
          one sentence of the answer, byte for byte, under the heading of
          the branch that wrote it — with that state's glyph. A sentence the
          non-verdict path wrote has no kind and is shown as plain text. */}
      <div className="answer-list" data-testid="answer-text">
        {surface.answer.sentences.map((s) => (
          <AnswerSentence key={s} text={s} kind={kindOf(surface, s)} lead={s === lead} />
        ))}
      </div>
      <p className="answer-meta" data-testid="answer-meta">
        {surface.checkedOn && <span data-testid="answer-checked">{dict.result.checkedOn(surface.checkedOn)}</span>}
        {surface.latestEvidence && (
          <span>{dict.result.newest(dict.result.dateLabels[surface.latestEvidence.label] ?? surface.latestEvidence.label, surface.latestEvidence.value)}</span>
        )}
      </p>
    </section>
  );
}

// THE RING: one segment per checked component, in PROOF_PATH_ORDER, in its
// state colour; each segment draws once (ap-seg, 45ms step).
function ProofRing({ chain }: { chain: readonly ProofNode[] }) {
  const C = 2 * Math.PI * 50;
  const n = chain.length;
  const slot = C / n;
  const gap = n > 1 ? 5 : 0;
  const seg = Math.max(2, slot - gap);
  return (
    <svg width="116" height="116" viewBox="0 0 120 120" aria-hidden>
      <circle cx="60" cy="60" r="39" fill="#03111f" stroke="rgba(30, 197, 245, 0.16)" strokeWidth="1" />
      <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(30, 197, 245, 0.06)" strokeWidth="11" />
      <g transform="rotate(-90 60 60)" fill="none" strokeWidth="9">
        {chain.map((node, i) => (
          <circle
            key={node.component}
            className="ring-seg"
            data-status={node.status}
            cx="60"
            cy="60"
            r="50"
            strokeDasharray={`${seg.toFixed(2)} ${(C - seg).toFixed(2)}`}
            strokeDashoffset={(-(gap / 2) - i * slot).toFixed(2)}
            style={{ animationDelay: `${120 + i * 45}ms` }}
          />
        ))}
      </g>
    </svg>
  );
}

// The kind the surface recorded for this sentence — the branch that wrote
// it, never a reading of its text. Unmatched means the non-verdict path.
function kindOf(surface: ResultSurface, sentence: string): AnswerKind {
  return surface.answer.parts.find((p) => p.text === sentence)?.kind ?? "NONE";
}

// ONE SENTENCE OF THE ANSWER. With a kind, it sits under that kind's
// heading with the glyph of the row state it maps to; without one (the
// non-verdict path) it is plain text.
function AnswerSentence({ text, kind, lead }: { text: string; kind: AnswerKind; lead: boolean }) {
  const dict = useDict();
  if (kind === "NONE") {
    return <p className={`answer-plain ${lead ? "answer-plain-lead" : ""}`}>{text}</p>;
  }
  const status = ANSWER_KIND_STATUS[kind];
  return (
    <div className="answer-block" data-testid="answer-block" data-kind={kind}>
      <StateGlyph status={status} size={26} />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="answer-heading">{dict.result.answerHeadings[kind]}</p>
        <p className="answer-sentence">{text}</p>
      </div>
    </div>
  );
}

// A state glyph: ✓, a half-filled disc for partial (CSS, not ◐), ?, ✕.
function StateGlyph({ status, size, filled = false }: { status: ResultStatus; size: number; filled?: boolean }) {
  return (
    <span className={`glyph ${filled ? "glyph-filled" : ""}`} data-status={status} style={{ width: size, height: size }} aria-hidden>
      {status === "CONFIRMED" ? "✓" : status === "PARTIAL" ? <span className="half-disc" /> : status === "CONTRADICTED" ? "✕" : "?"}
    </span>
  );
}

// THE WORK, IN FIGURES — counted from the rows, never estimated: the
// checks the research turned on, the distinct documents admitted behind
// them, the admitted evidence items, and the checks that were verified.
function workFigures(surface: ResultSurface, dict: Dict): { key: string; n: number; label: string }[] {
  const rows = surface.table;
  if (rows.length === 0) return [];
  const cards = rows.flatMap((r) => r.evidence);
  const items = new Set(cards.map((c) => c.id)).size;
  const docs = new Set(cards.map((c) => canonicalDocumentKey(c.url))).size;
  const verified = rows.filter((r) => r.status === "CONFIRMED").length;
  return [
    { key: "checks", n: rows.length, label: dict.result.figures.checks(rows.length) },
    { key: "sources", n: docs, label: dict.result.figures.sources(docs) },
    { key: "items", n: items, label: dict.result.figures.items(items) },
    { key: "verified", n: verified, label: dict.result.figures.verified },
  ];
}

/* ------------------------------------------------------------------ */
/* 2. RESEARCH PATH                                                    */
/* ------------------------------------------------------------------ */

// THE LOGIC OF THE RESEARCH, VISIBLE. One node per check in proof-path
// order, each in one or two human words and its state word. Connectors
// after a filled node are tinted; nothing travels along them.
function pathWord(component: string, noun: string, dict: Dict): string {
  // The English design word follows the question's own mechanism noun
  // ("Buyback", "Burn"); every other word, and every Russian word, is the
  // dictionary's (D-171).
  if (!dict.result.pathNounFromQuestion && dict.result.pathWords[component]) return dict.result.pathWords[component];
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
      return "Where it goes";
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
  const dict = useDict();
  if (chain.length < 2) return null;
  return (
    <section className="rise flex flex-col gap-2.5" style={{ animationDelay: "72ms" }} data-testid="research-path" aria-label={dict.result.pathAria}>
      <a href="#checked" className="flex h-6 items-center justify-between text-[var(--atlas-text)]">
        <span className="text-[17px] leading-[22px] font-extrabold">{dict.result.pathTitle}</span>
        <span className="flex items-center gap-1 text-[12px] leading-none text-[var(--atlas-cyan-strong)]">
          {chain.length} {dict.result.figures.checks(chain.length)}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </a>
      <div className="path-strip">
        <ol className="path-v7">
          {chain.map((n, i) => (
            <li
              key={n.component}
              className="path-node"
              data-status={n.status}
              title={`${n.label} — ${dict.result.stateWords[n.status] ?? STATE_WORDS[n.status]}`}
              data-testid="path-node"
              data-component={n.component}
            >
              {i < chain.length - 1 && <span className="path-link" data-status={n.status} aria-hidden />}
              <span className="path-mark-v7" data-status={n.status} style={{ animationDelay: `${180 + i * 35}ms` }} aria-hidden>
                {n.status === "CONFIRMED" ? "✓" : n.status === "PARTIAL" ? <span className="half-disc half-disc-lg" /> : n.status === "CONTRADICTED" ? "✕" : "?"}
              </span>
              <span className="path-word">{pathWord(n.component, noun, dict)}</span>
              <span className="path-state" data-status={n.status}>
                {dict.result.stateWords[n.status] ?? STATE_WORDS[n.status]}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 3. WHAT ATLAS CHECKED                                               */
/* ------------------------------------------------------------------ */

// One card per question. A segmented bar and the legend say at a glance
// how much of the story is settled — counted over every check, folded
// supporting checks included, the same set the figures above use.
function FindingsTable({ rows: all, jobId }: { rows: readonly ResearchTableRow[]; jobId: string | null }) {
  const dict = useDict();
  const rows = tableRows(all);
  if (rows.length === 0) return null;
  const counts = COUNT_ORDER.map((status) => ({ status, n: all.filter((r) => r.status === status).length })).filter((c) => c.n > 0);
  const ordered = [...all].sort((a, b) => pathOrder(a.component) - pathOrder(b.component));
  return (
    <section id="checked" className="checked-panel rise" style={{ animationDelay: "108ms" }} data-testid="research-table">
      <div className="flex flex-col gap-3 border-b border-[var(--edge-soft)] px-4 pt-[18px] pb-3.5">
        <h2 className="text-[21px] leading-[26px] font-extrabold tracking-[-0.01em] text-[var(--atlas-text-strong)]">{dict.result.checkedTitle}</h2>
        <div className="checks-bar" style={{ gridTemplateColumns: `repeat(${ordered.length}, minmax(0, 1fr))` }} aria-hidden>
          {ordered.map((r, i) => (
            <span key={r.component} className="checks-seg" data-status={r.status} style={{ animationDelay: `${120 + i * 45}ms` }} />
          ))}
        </div>
        <p className="counts flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-4 text-[var(--atlas-text-dim)]" data-testid="research-counts">
          {counts.map((c) => (
            <span key={c.status} className="flex items-center gap-[7px]">
              <span className="legend-dot" data-status={c.status} aria-hidden />
              {c.n} {dict.result.counts[c.status]}
            </span>
          ))}
        </p>
      </div>
      <ol className="flex flex-col">
        {rows.map((r) => (
          <FindingRow key={r.component} row={r} jobId={jobId} />
        ))}
      </ol>
    </section>
  );
}

function pathOrder(component: string): number {
  const i = (PROOF_PATH_ORDER as readonly string[]).indexOf(component);
  return i === -1 ? PROOF_PATH_ORDER.length : i;
}

// "Verified from official docs" / "Partly verified from governance" /
// "Contradicted by on-chain record" / "Unresolved" — the state and where
// it came from, in one breath.
function stateSentence(row: ResearchTableRow, dict: Dict): string {
  const word = dict.result.stateWords[row.status] ?? STATE_WORDS[row.status];
  const kind = row.source ? (dict.result.sourceKinds[row.source.kind] ?? row.source.kind.toLowerCase()) : null;
  if (!kind) return word;
  if (row.status === "CONTRADICTED") return dict.result.stateBy(word, kind);
  if (row.status === "NOT_ESTABLISHED") return dict.result.stateWith(word, kind);
  return dict.result.stateFrom(word, kind);
}

// `defaultOpen` is presentation state for tests and fixtures — the row
// opens exactly as a tap on "Evidence · N" opens it.
export function FindingRow({ row, jobId, defaultOpen = false }: { row: ResearchTableRow; jobId: string | null; defaultOpen?: boolean }) {
  const dict = useDict();
  const [open, setOpen] = useState(defaultOpen);
  const toggleLabel = open ? dict.result.hideEvidence : dict.result.evidenceCount(row.evidence.length);
  const unresolved = row.status === "NOT_ESTABLISHED";
  return (
    <li
      className={`finding-v7 ${unresolved ? "finding-compact" : ""} ${open ? "finding-open" : ""}`}
      title={stateSentence(row, dict)}
      data-testid="research-row"
      data-component={row.component}
      data-status={row.status}
      data-kind={row.kind}
      data-boundary={row.boundary?.kind ?? ""}
    >
      {unresolved ? (
        // An unresolved row is compact: the "?" glyph, the question, and
        // "Unresolved · {reason}" — the reason is the row's own.
        <div className="flex items-start gap-3">
          <StateGlyph status={row.status} size={26} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="finding-label" data-testid="row-label">
              {row.label}
            </h3>
            <p className="state-line text-[12.5px] leading-[18px] text-[var(--atlas-text-dim)]">
              <span className="state-word" data-testid="row-cue">
                {dict.result.stateWords[row.status] ?? STATE_WORDS[row.status]}
              </span>
              <span aria-hidden> · </span>
              <span data-testid="row-answer">{row.established}</span>
              <span className="sr-only" data-testid="row-source">
                {row.source ? row.source.name : dict.result.noQualifyingSource}
              </span>
              <span data-testid="row-date" />
            </p>
          </div>
        </div>
      ) : (
        <>
          <h3 className="finding-label" data-testid="row-label">
            {row.label}
          </h3>
          <p className="finding-answer" data-testid="row-answer">
            {row.established}
          </p>
          {row.restsOn.length > 0 && (
            <p className="text-[13px] leading-[19px] text-[var(--atlas-text-dim)]" data-testid="row-rests-on">
              {dict.result.alsoConfirmed} {joinPhrases(row.restsOn.map((d) => d.phrase), dict.result.and)}.
            </p>
          )}
          <p className="state-line">
            <span className="state-word" data-status={row.status} data-testid="row-cue">
              <StateGlyph status={row.status} size={12} filled />
              {stateSentence(row, dict)}
            </span>
            <span data-testid="row-source" className="byline min-w-0">
              {row.source ? (
                <>
                  <SourceKindIcon label={row.source.kind} size={13} className="shrink-0 opacity-80" />
                  <span>{row.source.name}</span>
                </>
              ) : (
                <span>{dict.result.noQualifyingSource}</span>
              )}
            </span>
            {row.date && (
              <span className="byline" data-testid="row-date">
                <CalendarIcon size={13} className="shrink-0 opacity-70" />
                {row.date.value}
              </span>
            )}
            {!row.date && <span data-testid="row-date" />}
          </p>
          {row.evidence.length > 0 && (
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="evidence-pill" data-testid="row-evidence-toggle">
              {toggleLabel}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden className={`transition-transform duration-200 ${open ? "" : "rotate-180"}`}>
                <path d="M6 15l6-6 6 6" />
              </svg>
            </button>
          )}
          {/* THE PROOF BEHIND THIS ANSWER, IN PLACE: its own surface, a
              title that says what it is, one card per admitted source with
              the excerpt already open. */}
          {open && (
            <div className="row-evidence expand-enter" data-testid="row-evidence">
              <p className="row-evidence-title">
                {dict.result.evidenceBehind}
                <span className="font-medium text-[var(--atlas-text-dim)]">· {dict.result.sourcesCount(row.evidence.length)}</span>
              </p>
              <div className="flex flex-col gap-4">
                {row.evidence.map((c) => (
                  <EvidenceCardView key={c.id} card={c} jobId={jobId} open compact />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </li>
  );
}

function joinPhrases(items: readonly string[], and: string): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* 4. EVIDENCE                                                         */
/* ------------------------------------------------------------------ */

// THE FEW SOURCES THE ANSWER RESTS ON (kept by owner decision, V7 style).
// A contradicting card carries a red edge — the one thing a reader must
// not miss.
function SourcesSection({ cards, jobId }: { cards: readonly EvidenceCard[]; jobId: string | null }) {
  const dict = useDict();
  if (cards.length === 0) return null;
  return (
    <section className="rise flex flex-col gap-3" style={{ animationDelay: "120ms" }} data-testid="sources">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[17px] leading-[22px] font-extrabold text-[var(--atlas-text-strong)]">{dict.result.evidenceTitle}</h2>
        <p className="text-[12px] text-[var(--atlas-text-dim)]">{dict.result.sourcesBehind(cards.length)}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {cards.map((c) => (
          <li key={c.id} className="source-card-v7" data-relation={c.relation}>
            <EvidenceCardView card={c} jobId={jobId} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ONE SOURCE, INSPECTED IN PLACE. Collapsed: its kind, its date, who
// published it and one sentence on what it establishes. Open: the exact
// excerpt with a static highlighter mark, then two rows — what this kind
// of source establishes, and what this passage does not establish (the v1
// contract line when the card carries one; the class caveat otherwise) —
// and the ways to read it in full. `compact` is the in-row form.
//
// SNAPSHOT IS OFFERED ONLY WHERE A ROUTE CAN SERVE IT: the route's `jobId`
// is the authority — no route, no snapshot action.
export function EvidenceCardView({
  card,
  jobId,
  open: openByDefault = false,
  compact = false,
}: {
  card: EvidenceCard;
  jobId: string | null;
  open?: boolean;
  compact?: boolean;
}) {
  const dict = useDict();
  const [open, setOpen] = useState(openByDefault);
  const contradicts = card.relation === "CONTRADICTS";
  const kindLabel = dict.result.sourceKindChips[card.sourceClass] ?? card.sourceClass;
  // The card carries the class LABEL ("Official docs"); the caveat table is
  // keyed by the class code — read back through the same label map.
  const classCode = Object.entries(SOURCE_CLASS_LABELS).find(([, label]) => label === card.sourceClass)?.[0] ?? card.sourceClass;
  const caveat = sourceClassCaveat(classCode);
  return (
    <div className="evidence-v7" data-testid="evidence-card" data-evidence-id={card.id} data-relation={card.relation} data-open={open ? "true" : "false"}>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-[var(--atlas-text-dim)]">
        <span className={`kind-chip kind-${sourceKindFamily(card.sourceClass)}`}>
          <SourceKindIcon label={card.sourceClass} size={12} />
          {kindLabel}
        </span>
        {card.onchain?.network && <span>{card.onchain.network}</span>}
        {card.date && (
          <span className="byline">
            <CalendarIcon size={12} className="opacity-70" />
            {dict.result.dateLabels[card.date.label] ?? card.date.label} {card.date.value}
          </span>
        )}
        {contradicts && <span className="font-semibold text-[var(--atlas-red)]">{dict.result.contradicts}</span>}
      </p>
      <p className={`${compact ? "text-[13px]" : "text-[14.5px]"} mt-1.5 leading-snug font-bold text-[var(--atlas-text-strong)]`} data-testid="evidence-source">
        {card.sourceName}
      </p>
      {!compact && (
        <p className="mt-1 text-[13.5px] leading-5 text-[var(--atlas-text-2,#e6ecf4)]" data-testid="evidence-tells">
          {sourceSentence(card)}
        </p>
      )}
      {compact && card.onchain && (
        <p className="mt-1 text-[13.5px] leading-5 text-[#e6ecf4]" data-testid="evidence-tells">
          {sourceSentence(card)}
        </p>
      )}
      {open && !card.onchain && (
        <div className="expand-enter mt-2.5 flex flex-col gap-2.5" data-testid="evidence-details">
          <p className="text-[13.5px] leading-[21px] text-[#e6ecf4]" data-testid="evidence-excerpt">
            <mark className="highlight">{card.excerpt}</mark>
          </p>
          {(caveat?.can || card.doesNotProve) && (
            <div className="flex flex-col gap-1.5">
              {caveat?.can && (
                <div className="establish-row establish-yes">
                  <span className="establish-label">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                    {dict.result.evidenceRows.establishes}
                  </span>
                  <span className="establish-text">{caveat.can}</span>
                </div>
              )}
              {card.doesNotProve && (
                <div className="establish-row establish-no">
                  <span className="establish-label">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                    {dict.result.evidenceRows.notEstablishes}
                  </span>
                  <span className="establish-text" data-testid="evidence-does-not-prove">
                    {card.doesNotProve}
                  </span>
                </div>
              )}
            </div>
          )}
          {caveat?.from && <p className="text-[12px] leading-[17px] text-[var(--atlas-text-dim)]">{caveat.from}</p>}
        </div>
      )}
      <p className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        {!card.onchain && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="link-action" data-testid="evidence-details-toggle">
            <QuoteIcon size={13} />
            {open ? dict.result.hideExcerpt : dict.result.viewExcerpt}
          </button>
        )}
        {card.snapshotHref && jobId && (
          <Link href={card.snapshotHref} className="link-action" data-testid="evidence-snapshot">
            <SnapshotIcon size={14} />
            {dict.result.snapshot}
          </Link>
        )}
        {/* Only a real http(s) original is offered — a chain locator has no
            page. Inside Telegram the Mini App API opens it. */}
        {card.openable && (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            className="link-action link-muted"
            data-testid="evidence-open-original"
            onClick={(e) => {
              if (getPlatform().openExternal(card.url)) e.preventDefault();
            }}
          >
            <ExternalIcon size={13} />
            {dict.result.openOriginal}
          </a>
        )}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. WHAT REMAINS UNCLEAR                                             */
/* ------------------------------------------------------------------ */

// One expandable card per unresolved link (NOT_ESTABLISHED rows), in
// PROOF_PATH_ORDER — the approved V7 reference (Founder-accepted
// 2026-10-12; owner decision 2026-10-13: every unresolved link, the
// substantive ones included). The chip is the row's boundaryOf(...).kind
// and nothing else: SUBSTANTIVE "checked, not established", TECHNICAL
// "not fully checked" (only from a technical code), CONFIGURATION "no
// supported verification route". "What could help" is one template per
// kind — a direction, never a promise. The excluded list shows only
// evidence the engine excluded for that component, with its label.
function UnclearSection({ surface, detail, noun }: { surface: ResultSurface; detail: ResearchJobDetail; noun: string }) {
  const dict = useDict();
  const rows =
    surface.outcomeKind === "VERDICT"
      ? surface.chain
          .filter((n) => n.status === "NOT_ESTABLISHED")
          .map((n) => surface.table.find((r) => r.component === n.component))
          .filter((r): r is ResearchTableRow => r !== undefined)
      : [];
  // One card open at a time; the first is open on arrival (the reference).
  const [openAt, setOpenAt] = useState<string | null>(rows[0]?.component ?? null);
  if (rows.length === 0) return null;
  const evidenceById = new Map(detail.evidence.map((e) => [e.id, e]));
  return (
    <section className="unclear-panel rise" style={{ animationDelay: "140ms" }} data-testid="unclear-section">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] leading-[22px] font-extrabold text-[var(--atlas-text-strong)]">{dict.result.unclearTitle}</h2>
        <p className="text-[13px] leading-[19px] text-[var(--atlas-text-dim)]">{dict.result.unclearSub}</p>
      </div>
      <ul className="flex flex-col gap-2.5" data-testid="unclear-items">
        {rows.map((r) => {
          const kind: BoundaryKind = r.boundary?.kind ?? "SUBSTANTIVE";
          const excluded = (detail.components.find((c) => c.component === r.component)?.excludedEvidence ?? []).map((x) => {
            const e = evidenceById.get(x.evidenceId);
            return { id: x.evidenceId, name: e ? (e.sourceTitle ?? domainOf(e.retrievedUrl)) : null, label: exclusionLabel(x.reason) };
          });
          return (
            <UnclearCard
              key={r.component}
              row={r}
              kind={kind}
              what={capitalize(statementPhraseFor(r.component, noun))}
              excluded={excluded}
              open={openAt === r.component}
              onToggle={() => setOpenAt((v) => (v === r.component ? null : r.component))}
            />
          );
        })}
      </ul>
      <p className="text-[12px] leading-[17px] text-[var(--atlas-text-dim)]" data-testid="unclear-never">
        {dict.result.unclearClosing}
      </p>
    </section>
  );
}

function UnclearCard({
  row,
  kind,
  what,
  excluded,
  open,
  onToggle,
}: {
  row: ResearchTableRow;
  kind: BoundaryKind;
  what: string;
  excluded: { id: string; name: string | null; label: string }[];
  open: boolean;
  onToggle: () => void;
}) {
  const dict = useDict();
  const [showExcluded, setShowExcluded] = useState(false);
  // WHY: the run's real reason. Technical — the remaining paths when the
  // record carries them; configuration — the route limit; substantive —
  // the row's own persisted reason.
  const why =
    kind === "TECHNICAL"
      ? row.boundary?.remainingPaths
        ? dict.result.technicalRemaining(row.boundary.remainingPaths)
        : dict.result.unclearCopy.TECHNICAL
      : kind === "CONFIGURATION"
        ? dict.result.unclearCopy.CONFIGURATION
        : row.established;
  return (
    <li className={`unclear-card ${open ? "unclear-card-open" : ""}`} data-testid="unclear-group" data-kind={kind} data-component={row.component}>
      <button type="button" className="unclear-head" onClick={onToggle} aria-expanded={open}>
        <StateGlyph status="NOT_ESTABLISHED" size={26} />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5 text-left">
          <span className="text-[14.5px] leading-5 font-bold text-[var(--atlas-text-strong)]">{row.label}</span>
          <span className="boundary-chip" data-kind={kind} data-testid="boundary-chip">
            {dict.result.boundaryChips[kind]}
          </span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden className={`mt-1.5 flex-none text-[var(--atlas-text-dim)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {/* Every card's content is in the page; a collapsed card hides it.
          One card is open at a time. */}
      <div className={`flex-col gap-3 px-3.5 pb-3.5 ${open ? "flex expand-enter" : ""}`} hidden={!open} data-testid="unclear-copy">
          <p className="text-[13px] leading-[19px] text-[var(--atlas-text-dim)]">{dict.result.boundaryHints[kind]}</p>
          <div className="flex flex-col gap-1">
            <p className="unclear-label">{dict.result.unclearLabels.what}</p>
            <p className="text-[13.5px] leading-5 text-[#e6ecf4]">{what}.</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="unclear-label">{dict.result.unclearLabels.why}</p>
            <p className="text-[13.5px] leading-5 text-[#e6ecf4]">{why}</p>
            {/* What a route limit must never be read as (HANDOFF §4.3:
                unclearCopy + unclearNever for CONFIGURATION). The technical
                template and the closing line already say it for the others. */}
            {kind === "CONFIGURATION" && (
              <p className="text-[12.5px] leading-[18px] text-[var(--atlas-text-dim)]">{dict.result.unclearNever.CONFIGURATION}</p>
            )}
          </div>
          <div className="help-box">
            <p className="help-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />
              </svg>
              {dict.result.unclearLabels.help}
            </p>
            <p className="text-[13px] leading-[19px] text-[#e6ecf4]">{dict.result.helpTemplates[kind]}</p>
          </div>
          {excluded.length > 0 && (
            <div className="flex flex-col gap-2">
              <button type="button" className="excluded-toggle" onClick={() => setShowExcluded((v) => !v)} aria-expanded={showExcluded} data-testid="excluded-toggle">
                {showExcluded ? dict.result.excludedHide : dict.result.excludedToggle(excluded.length)}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden className={showExcluded ? "rotate-180" : ""}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {showExcluded && (
                <ul className="expand-enter flex flex-col gap-1.5" data-testid="excluded-list">
                  {excluded.map((x) => (
                    <li key={x.id} className="excluded-row">
                      {x.name && <span className="font-semibold text-[#dce4ec]">{x.name}</span>}
                      <span className="text-[var(--atlas-text-dim)]">{x.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
      </div>
    </li>
  );
}
