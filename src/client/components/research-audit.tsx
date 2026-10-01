"use client";

import Link from "next/link";
import { useState } from "react";

import type { AuditProjectionView, ResearchJobDetail } from "../api";
import {
  AUDIT_SECTION_TITLES,
  buildAuditContent,
  availableAuditSections,
  orderAuditSections,
  type AuditContent,
  type AuditEvidenceGroup,
  type AuditOpenItem,
  type AuditScopeItem,
  type AuditSectionId,
  type AuditSourceEntry,
  type SourceRegister,
  auditOutcome,
} from "../audit-model";
import { getPlatform } from "../platform";
import { retrievedOn } from "../research-model";
import { ChevronDownIcon, ExternalIcon, QuoteIcon, SnapshotIcon, SourceKindIcon, sourceKindFamily } from "./icons";
import {
  BOUNDARY_COPY,
  BOUNDARY_NEVER,
  buildResultSurface,
  RESULT_STATE_WORDS,
  sourceSentence,
  type EvidenceCard,
  type ResearchTableRow,
} from "../result-surface";

// THE FULL RESEARCH AUDIT.
//
// THE SAME QUESTIONS AS THE RESULT, ONE LEVEL DEEPER. The Result shows a
// reader what ATLAS found; the audit lets them check it. So the audit is
// built around the SAME research points, in the same words and the same
// order, and for each one shows: the question → the answer → every piece
// of evidence behind it, with what each proves and does not prove → the
// limit, when the point stopped short. A reader who has just left the
// Result recognises every heading, and nothing is said in a new
// vocabulary.
//
// THE TECHNICAL RECORD SITS BENEATH, CLOSED. Addresses, raw observations,
// the source register with exclusion reasons, coverage, open questions
// and the engine's own trace are kept complete — that is what an audit is
// for — but behind one disclosure at the bottom, so the normal reading
// path never crosses them.
//
// EVERY FACT IS CANONICAL. The points are the Result's own surface model
// over the persisted rows; the technical record is `audit-model.ts` over
// the same rows. The model-generated projection supplies section ORDER,
// short component LABELS and two sentences of connective copy inside the
// technical record — and where it supplied none, canonical labels are
// used and every section still renders.
export function ResearchAudit({
  jobId,
  detail,
  projection,
}: {
  jobId: string | null;
  detail: ResearchJobDetail;
  projection: AuditProjectionView | null;
}) {
  const surface = buildResultSurface(detail);
  const projectName = detail.job.projectName ?? detail.job.projectTicker ?? "Research record";
  const usable = projection?.status === "VALID" ? projection : null;
  const content = buildAuditContent(
    detail.components,
    detail.evidence,
    usable
      ? {
          summary: usable.content.summary,
          sectionOrder: usable.content.sectionOrder,
          scopeLabels: usable.content.scopeLabels,
        }
      : null,
  );
  const available = availableAuditSections(content);
  // THE COMPLETENESS GUARANTEE, APPLIED. A section canonical research gave
  // content to renders whether or not the model ordered it.
  const sections = orderAuditSections(usable?.content.sectionOrder ?? null, available);

  return (
    <div className="flex flex-col gap-10" data-testid="research-audit">
      {/* COMPACT CONTEXT ONLY. Enough to know which record this is —
          never a second copy of the Result the reader just left. */}
      <header data-testid="audit-context">
        <p className="text-[0.95rem] font-medium text-[var(--atlas-text-dim)]">Full audit · {projectName}</p>
        <h1 className="display mt-2 text-[1.4rem] font-semibold leading-[1.2] text-[var(--atlas-text-strong)] sm:text-[1.8rem]">
          {detail.job.originalQuestion}
        </h1>
        <p className="mt-3 text-[0.88rem] text-[var(--atlas-text-dim)]">
          Research completed {retrievedOn(detail.job.finishedAt) ?? "—"}
          {projection ? ` · audit prepared ${retrievedOn(projection.createdAt) ?? "—"}` : ""}
        </p>
      </header>

      {surface.table.length > 0 && (
        <section data-testid="audit-points">
          <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">Research points</h2>
          <ol className="mt-1 flex flex-col">
            {surface.table.map((row) => (
              <AuditPoint key={row.component} row={row} jobId={jobId} />
            ))}
          </ol>
        </section>
      )}

      <details className="group panel-section px-5 py-5 sm:px-6" data-testid="technical-record">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[1.05rem] font-semibold text-[var(--atlas-text)] select-none hover:text-[var(--atlas-text-strong)] [&::-webkit-details-marker]:hidden">
          <span className="grid h-7 w-7 place-items-center rounded-full border border-[var(--hairline-strong)] text-[var(--atlas-cyan-strong)]">
            <ChevronDownIcon size={14} className="transition-transform duration-200 group-open:rotate-180" />
          </span>
          Technical record
        </summary>
        <p className="mt-2 text-[0.9rem] text-[var(--atlas-text-dim)]">
          Coverage, every source read, raw on-chain observations, exclusion reasons and the engine trace.
        </p>
        <div className="mt-5 flex flex-col gap-4">
          {sections.map((id) => (
            <AuditSection key={id} id={id}>
              {id === "SUMMARY" && (
                <Summary content={content} summary={usable?.content.summary ?? null} />
              )}
              {id === "COVERAGE" && <Coverage scope={content.scope} />}
              {id === "EVIDENCE_MAP" && <EvidenceMap groups={content.evidenceMap} jobId={jobId} />}
              {id === "SOURCE_REGISTER" && <Register register={content.register} jobId={jobId} />}
              {id === "OPEN_QUESTIONS" && <OpenQuestions items={content.openItems} />}
              {id === "ONCHAIN" && <Onchain entries={content.onchain.entries} />}
              {id === "TRACE" && <Trace scope={content.scope} />}
            </AuditSection>
          ))}

          {projection && projection.status !== "VALID" && (
            // A PRESENTATION FAILURE, SAID QUIETLY. The record above is
            // complete and canonical either way — what a failed projection
            // costs is its labels and ordering, so the message says exactly
            // that and implies nothing about the research.
            <p
              className="px-1 py-2 text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]"
              data-testid="audit-projection-failed"
            >
              Audit labels could not be prepared, so research points are shown under their
              canonical names. The record itself is complete.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * RESEARCH POINTS — Question → Answer → Evidence → Limit
 * ---------------------------------------------------------------- */

// One point of the audit, in the Result's own words. The answer is the
// row's established text; the evidence is every admitted card for the
// row, each with what it tells and what it does not prove; the limit is
// the row's boundary, only where there is one.
function AuditPoint({ row, jobId }: { row: ResearchTableRow; jobId: string | null }) {
  return (
    <li
      className="relative border-b border-[var(--hairline)] py-6 pl-4 last:border-b-0"
      style={{ "--row-accent": `var(--atlas-${row.tone === "supported" ? "green" : row.tone === "partial" ? "amber" : row.tone === "negative" ? "red" : "slate"})` } as React.CSSProperties}
      data-testid="audit-point"
      data-component={row.component}
    >
      <span className="absolute left-0 top-7 bottom-7 w-[3px] rounded-r-full" style={{ background: "var(--row-accent)" }} aria-hidden />
      <p className="text-[1.05rem] font-semibold leading-snug text-[var(--atlas-text-strong)]" data-testid="audit-point-question">
        {row.label}
      </p>
      <p className="mt-2 text-[1.02rem] leading-[1.5] text-[var(--atlas-text)]/90" data-testid="audit-point-answer">
        {row.established}
      </p>
      <p className="mt-2 flex items-center gap-1.5 text-[0.88rem] text-[var(--atlas-text-dim)]">
        <span className={`dot dot-${row.tone}`} aria-hidden />
        {RESULT_STATE_WORDS[row.status]}
      </p>

      {row.restsOn.length > 0 && (
        <p className="mt-2 text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="audit-point-rests-on">
          Also confirmed: {row.restsOn.map((r) => r.phrase).join(", ")}.
        </p>
      )}

      {row.evidence.length > 0 && (
        <div className="mt-4" data-testid="audit-point-evidence">
          <p className="section-label">Evidence</p>
          <ul className="mt-2 flex flex-col gap-4">
            {row.evidence.map((card) => (
              <AuditEvidence key={card.id} card={card} jobId={jobId} />
            ))}
          </ul>
        </div>
      )}

      {/* THE LIMIT, ONLY WHERE IT ADDS INFORMATION. A substantive gap is
          already explained by the answer above ("checked, not found" and
          the persisted reason); a research limit or a missing source route
          is something the answer cannot say, so it is stated here in the
          same words the Result uses, with what it must never be read as. */}
      {row.boundary && row.boundary.kind !== "SUBSTANTIVE" && (
        <div className="mt-4" data-testid="audit-point-limit" data-kind={row.boundary.kind}>
          <p className="section-label">Limit</p>
          <p className="mt-1.5 text-[0.95rem] leading-[1.5] text-[var(--atlas-text)]/85">
            {row.boundary.kind === "TECHNICAL" && row.boundary.remainingPaths !== null
              ? `The research limit was reached before ${row.boundary.remainingPaths} known relevant ${row.boundary.remainingPaths === 1 ? "source" : "sources"} could be checked.`
              : BOUNDARY_COPY[row.boundary.kind]}
          </p>
          <p className="mt-1 text-[0.9rem] text-[var(--atlas-text-dim)]">{BOUNDARY_NEVER[row.boundary.kind]}</p>
        </div>
      )}
    </li>
  );
}

function AuditEvidence({ card, jobId }: { card: EvidenceCard; jobId: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-testid="audit-evidence" data-evidence-id={card.id} data-relation={card.relation}>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.88rem] text-[var(--atlas-text-dim)]">
        <span className={`kind kind-${sourceKindFamily(card.sourceClass)}`}>
          <SourceKindIcon label={card.sourceClass} size={13} />
          {card.sourceClass}
        </span>
        <span className="font-semibold text-[var(--atlas-text)]">{card.sourceName}</span>
        {card.onchain?.network && <span>{card.onchain.network}</span>}
        {card.date && (
          <span>
            {card.date.label} {card.date.value}
          </span>
        )}
        {card.relation === "CONTRADICTS" && <span className="font-semibold text-[var(--atlas-red)]">Contradicts</span>}
      </p>
      <p className="mt-1 text-[1rem] leading-[1.5]">{sourceSentence(card)}</p>
      {card.doesNotProve && (
        <p className="mt-1 text-[0.9rem] text-[var(--atlas-text-dim)]">{card.doesNotProve}</p>
      )}
      <p className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        {card.excerpt && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="btn-action">
            <QuoteIcon size={13} />
            {open ? "Hide excerpt" : "View excerpt"}
          </button>
        )}
        {card.openable && (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            className="link-action"
            onClick={(e) => {
              if (getPlatform().openExternal(card.url)) e.preventDefault();
            }}
          >
            <ExternalIcon size={14} />
            Open original
          </a>
        )}
        {card.snapshotHref && jobId && (
          <Link href={card.snapshotHref} className="link-action">
            <SnapshotIcon size={14} />
            Snapshot
          </Link>
        )}
      </p>
      {open && card.excerpt && (
        <blockquote className="mt-2 border-l-2 border-[var(--hairline-strong)] pl-4 text-[1rem] leading-[1.55] text-[var(--atlas-text)]/90">
          {card.excerpt}
        </blockquote>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- *
 * SECTION SHELL — progressive depth, not everything expanded
 * ---------------------------------------------------------------- */

// The state of the research is open; the deep material is a click down.
// The evidence map and the trace are where a reader goes with a specific
// question, not where they should land.
const OPEN_BY_DEFAULT: AuditSectionId[] = [
  "SUMMARY",
  "COVERAGE",
  "OPEN_QUESTIONS",
  "SOURCE_REGISTER",
];

function AuditSection({ id, children }: { id: AuditSectionId; children: React.ReactNode }) {
  if (OPEN_BY_DEFAULT.includes(id)) {
    return (
      <section className="rounded-[0.9rem] border border-[var(--hairline)] px-5 py-5 sm:px-6" data-testid={`audit-section-${id}`}>
        <p className="section-label">{AUDIT_SECTION_TITLES[id]}</p>
        <div className="mt-4">{children}</div>
      </section>
    );
  }
  return (
    <details className="group rounded-[0.9rem] border border-[var(--hairline)] px-5 py-4 sm:px-6" data-testid={`audit-section-${id}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[0.9rem] text-[var(--atlas-text-dim)] select-none [&::-webkit-details-marker]:hidden">
        <Chevron className="shrink-0 transition-transform duration-200 group-open:rotate-90" />
        {AUDIT_SECTION_TITLES[id]}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

/* ---------------------------------------------------------------- *
 * 1. AUDIT SUMMARY — about the record, never a second copy of the answer
 * ---------------------------------------------------------------- */

function Summary({ content, summary }: { content: AuditContent; summary: string | null }) {
  const c = content.counts;
  // RELATED NUMBERS READ TOGETHER. "12 exclusions" beside "1 unused
  // source" invites a reader to compare two figures that are one piece of
  // accounting; said as one sentence it becomes information instead.
  const exclusionLine =
    c.exclusions > 0
      ? `${c.exclusions} evidence ${c.exclusions === 1 ? "item" : "items"} excluded on admission`
      : null;
  return (
    <div>
      {/* CATEGORIES THAT DO NOT OVERLAP. "blocked" used to sit in the same
          row as confirmed / partial / unresolved while being a SUBSET of
          unresolved, so four numbers invited an addition that does not
          work. These three partition the record; anything that qualifies
          one of them is a sentence underneath. */}
      <div className="flex flex-wrap gap-x-7 gap-y-3" data-testid="audit-counts">
        <Stat n={c.componentsTotal} label="research points" />
        <Stat n={c.established} label="confirmed" tone="supported" />
        {c.partial > 0 && <Stat n={c.partial} label="partially confirmed" tone="partial" />}
        {c.contradicted > 0 && <Stat n={c.contradicted} label="contradicted" tone="negative" />}
        <Stat n={c.unresolved} label="unresolved" tone="insufficient" />
      </div>
      <div className="mt-4 border-t border-[var(--hairline)] pt-3.5 text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]">
        {c.technicalLimitations > 0 && (
          <p data-testid="audit-blocked-note">
            {c.technicalLimitations} of the unresolved{" "}
            {c.technicalLimitations === 1 ? "check was" : "checks were"} blocked by
            source-access limitations rather than by missing evidence.
          </p>
        )}
        <p className={c.technicalLimitations > 0 ? "mt-1.5" : ""}>
          {c.sourcesUsed} {c.sourcesUsed === 1 ? "source" : "sources"} used
          {c.sourcesCheckedNotUsed > 0
            ? `, ${c.sourcesCheckedNotUsed} checked and not used`
            : ""}
          {exclusionLine ? ` · ${exclusionLine}` : ""}.
        </p>
      </div>
      {summary && (
        <p
          className="mt-3 text-[0.84rem] leading-relaxed text-[var(--atlas-text)]/85"
          data-testid="audit-summary-prose"
        >
          {summary}
        </p>
      )}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p
        className="text-[1.3rem] leading-none font-semibold tracking-tight"
        style={{ color: toneColor(tone) }}
      >
        {n}
      </p>
      <p className="mt-1 text-[0.82rem] text-[var(--atlas-text-dim)]">{label}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * 2. RESEARCH COVERAGE — the canonical home for "what was checked"
 * ---------------------------------------------------------------- */

// ONE OUTCOME WORD PER RESEARCH POINT. Claim status and coverage are two
// genuinely different canonical axes, and showing them as two adjacent
// badges made a reader learn the state machine before they could read a
// result — "NOT ESTABLISHED / NOT CHECKED" is precise and teaches nothing.
// The pair is translated in the model (`auditOutcome`), and both axes
// remain on the row, shown on expansion where they EXPLAIN the outcome.
function Coverage({ scope }: { scope: AuditScopeItem[] }) {
  return (
    <div data-testid="audit-coverage">
      {scope.map((s) => (
        <CoverageRow key={`${s.patternStep}:${s.component}`} item={s} />
      ))}
    </div>
  );
}

function CoverageRow({ item }: { item: AuditScopeItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-[var(--hairline)] py-2.5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 text-left"
        data-testid="audit-coverage-row"
      >
        <Chevron
          className={`mt-1 shrink-0 text-[var(--atlas-text-dim)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.86rem] leading-snug font-medium">{item.label}</span>
          {/* The one line that keeps "we could not reach it" from being
              read as "it is not there". */}
          {item.outcome === "RESEARCH_BLOCKED" && (
            <span className="mt-0.5 block text-[0.82rem] text-[#fcd34d]">
              ATLAS could not access the source this check required.
            </span>
          )}
        </span>
        <span
          className="shrink-0 text-[0.82rem] font-medium tracking-wide uppercase"
          style={{ color: outcomeColor(item.outcome) }}
          data-testid="audit-outcome"
        >
          {item.outcomeLabel}
        </span>
      </button>

      {open && (
        <div
          className="mt-2 ml-[1.45rem] text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]"
          data-testid="audit-coverage-detail"
        >
          {item.reason && <p>{item.reason}</p>}
          <p className={item.reason ? "mt-1" : ""}>
            <span className="text-[var(--atlas-text)]/75">How far the check got: </span>
            {item.coverageLabel.toLowerCase()}
          </p>
          <p className="mt-1">
            <span className="text-[var(--atlas-text)]/75">Evidence: </span>
            {item.supportingCount} supporting · {item.contradictingCount} conflicting ·{" "}
            {item.excludedCount} excluded
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * 3. EVIDENCE MAP — relationships, never a second source register
 * ---------------------------------------------------------------- */

// ONE COMPACT ROW PER RESEARCH POINT, expandable. The first version drew a
// full source identity card — class, suitability, limits, both links —
// for every Evidence row under every point, and then the same sources
// again in the register. What belongs here is the RELATIONSHIP: which
// source carried this point, over how many passages, and what that kind
// of source can and cannot settle. Identity lives in the register, once.
function EvidenceMap({ groups, jobId }: { groups: AuditEvidenceGroup[]; jobId: string | null }) {
  return (
    <div data-testid="audit-evidence-map">
      {groups.map((g) => (
        <EvidenceRow key={`${g.patternStep}:${g.component}`} group={g} jobId={jobId} />
      ))}
    </div>
  );
}

function EvidenceRow({ group, jobId }: { group: AuditEvidenceGroup; jobId: string | null }) {
  const [open, setOpen] = useState(false);
  const excludedCount = group.excluded.reduce((n, l) => n + l.evidenceCount, 0);
  return (
    <div className="border-b border-[var(--hairline)] py-2.5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 text-left"
        data-testid="audit-evidence-row"
      >
        <Chevron
          className={`mt-1 shrink-0 text-[var(--atlas-text-dim)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.85rem] font-medium">{group.label}</span>
          <span className="mt-0.5 block text-[0.82rem] text-[var(--atlas-text-dim)]">
            {group.admitted.length > 0
              ? group.admitted
                  .map(
                    (l) =>
                      `${l.domain} · ${l.sourceClassLabel} · ${l.evidenceCount} ${l.evidenceCount === 1 ? "item" : "items"}`,
                  )
                  .join("   ")
              : "No admitted evidence"}
            {excludedCount > 0 && (
              <span className="text-[#fcd34d]">
                {group.admitted.length > 0 ? "   " : ""}
                {excludedCount} excluded
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 text-[0.82rem]" style={{ color: outcomeColor(auditOutcomeOf(group.status)) }}>
          {group.outcomeLabel}
        </span>
      </button>

      {open && (
        <div className="mt-3 ml-[1.45rem] flex flex-col gap-3" data-testid="audit-evidence-detail">
          {group.admitted.map((l) => (
            <div key={`a:${l.sourceKey}`}>
              <p className="text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]">
                <span className="text-[var(--atlas-text)]/75">What this establishes: </span>
                {l.canEstablish ?? "Not classified."}
              </p>
              {l.doesNotProve ? (
                // Already framed: "Does not establish: <claim>" for a v1
                // caveat, or a chain row's own complete sentence.
                <p className="mt-1 text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="audit-passage-limit">
                  {l.doesNotProve}
                </p>
              ) : (
                <p className="mt-1 text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]">
                  <span className="text-[var(--atlas-text)]/75">Outside its scope: </span>
                  {l.cannotEstablish ?? "Not recorded."}
                </p>
              )}
              {l.legacyExtractorNote && (
                // Provenance, not a boundary: the extractor's raw wording from
                // before the does_not_prove contract (or outside it).
                <p className="mt-1 text-[0.8rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="audit-legacy-extractor-note">
                  <span className="text-[var(--atlas-text)]/75">Legacy extractor note: </span>
                  {l.legacyExtractorNote}
                </p>
              )}
              <SourceActions
                jobId={jobId}
                link={{
                  evidenceIds: l.evidenceIds,
                  hasSnapshot: l.hasSnapshot,
                  retrievedUrl: l.retrievedUrl,
                }}
              />
            </div>
          ))}

          {/* REFUSED MATERIAL, GROUPED. Four near-identical "not admitted"
              cards taught nothing four times. One line per source, with a
              count and the engine's own reason, says the same thing once —
              and every item stays reachable in the register. */}
          {group.excluded.map((l) => (
            <p
              key={`x:${l.sourceKey}`}
              className="rounded-md border border-[rgba(251,191,36,0.2)] bg-[rgba(251,191,36,0.04)] px-3 py-2 text-[0.85rem] leading-snug text-[#fcd34d]"
              data-testid="audit-excluded-summary"
            >
              {l.evidenceCount} {l.evidenceCount === 1 ? "item" : "items"} from {l.domain} not
              admitted here
              {l.exclusionReasons.length > 0 ? ` — ${l.exclusionReasons.join("; ")}` : ""}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * 4. SOURCE REGISTER — the canonical home for source identity
 * ---------------------------------------------------------------- */

// EACH DISTINCT DOCUMENT APPEARS ONCE, HERE. This is the only place a
// full source identity is rendered: class, retrieval, what it contributed
// to, its role and its limit, and the two ways to read it. Every other
// section references a source compactly.
function Register({ register, jobId }: { register: SourceRegister; jobId: string | null }) {
  return (
    <div className="flex flex-col gap-5" data-testid="audit-source-register">
      <div>
        <p className="text-[0.82rem] tracking-wider text-[var(--atlas-text-dim)] uppercase">
          Sources used
        </p>
        <div className="mt-1" data-testid="audit-sources-used">
          {register.used.map((s) => (
            <SourceRow key={s.sourceKey} entry={s} jobId={jobId} />
          ))}
        </div>
      </div>

      {register.checkedNotUsed.length > 0 && (
        <div>
          {/* THE HALF A NORMAL RESULT NEVER SHOWS. Material the run read
              and did not rely on is where over-claiming would have
              happened and did not. */}
          <p className="text-[0.82rem] tracking-wider text-[var(--atlas-text-dim)] uppercase">
            Checked but not used
          </p>
          <div className="mt-1" data-testid="audit-sources-not-used">
            {register.checkedNotUsed.map((s) => (
              <SourceRow key={s.sourceKey} entry={s} jobId={jobId} notUsed />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceRow({
  entry,
  jobId,
  notUsed,
}: {
  entry: AuditSourceEntry;
  jobId: string | null;
  notUsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="border-b border-[var(--hairline)] py-2.5 last:border-b-0"
      data-testid={notUsed ? "audit-source-not-used" : "audit-source-used"}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 text-left"
      >
        <Chevron
          className={`mt-1 shrink-0 text-[var(--atlas-text-dim)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.83rem] font-medium">{entry.domain}</span>
          <span className="mt-0.5 block text-[0.82rem] text-[var(--atlas-text-dim)]">
            {entry.sourceClassLabel}
            {entry.fetchedAt ? ` · retrieved ${retrievedOn(entry.fetchedAt)}` : ""}
            {entry.evidenceIds.length > 1 ? ` · ${entry.evidenceIds.length} items` : ""}
          </span>
        </span>
      </button>

      {open && (
        <div className="mt-2 ml-[1.45rem] text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]">
          {entry.contributedTo.length > 0 && (
            <p>
              <span className="text-[var(--atlas-text)]/75">Contributed to: </span>
              {entry.contributedTo.map((x) => x.label).join(" · ")}
            </p>
          )}
          {entry.suitability && (
            <>
              <p className="mt-1">
                <span className="text-[var(--atlas-text)]/75">Source role: </span>
                {entry.suitability.can}
              </p>
              <p className="mt-1">
                <span className="text-[var(--atlas-text)]/75">Source limit: </span>
                {entry.suitability.cannot}
              </p>
            </>
          )}
          {notUsed && (
            <p className="mt-1 text-[#fcd34d]" data-testid="audit-not-used-reason">
              {entry.notUsedReasons.length > 0
                ? entry.notUsedReasons.join(" · ")
                : "Read during research; no research point relied on it."}
            </p>
          )}
          <SourceActions
            jobId={jobId}
            link={{
              evidenceIds: entry.evidenceIds,
              hasSnapshot: entry.hasSnapshot,
              retrievedUrl: entry.retrievedUrl,
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * SOURCE ACTIONS — the SAME snapshot surface, never a second one
 * ---------------------------------------------------------------- */

// Reuses the Source Snapshot route exactly as the result card does: the
// link appears only where a capture exists, and it is scoped by
// (job, evidence) so a document another job fetched can never surface here.
function SourceActions({
  jobId,
  link,
}: {
  jobId: string | null;
  link: { evidenceIds: string[]; hasSnapshot: boolean; retrievedUrl: string };
}) {
  const evidenceId = link.evidenceIds[0];
  if (!link.retrievedUrl) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {link.hasSnapshot && evidenceId && jobId && (
        <Link
          href={`/research/${jobId}/source/${evidenceId}`}
          className="text-[0.82rem] font-medium text-[var(--atlas-cyan)] hover:underline"
          data-testid="audit-view-snapshot"
        >
          View source snapshot
        </Link>
      )}
      <a
        href={link.retrievedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[0.82rem] text-[var(--atlas-text-dim)] hover:text-[var(--atlas-cyan)] hover:underline"
        data-testid="audit-open-original"
      >
        Open original
      </a>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * 5. OPEN QUESTIONS / CONFLICTS / LIMITATIONS
 * ---------------------------------------------------------------- */

const OPEN_ITEM_TITLES: Record<AuditOpenItem["kind"], string> = {
  CONFLICT: "Conflict",
  TECHNICAL_LIMITATION: "Research limitation",
  OPEN_EVIDENCE_QUESTION: "Evidence gap",
};

// EACH ITEM ADDS SOMETHING COVERAGE DID NOT SAY. Coverage states that a
// point is open; this states WHY it is open, which KIND of open it is,
// and what would close it. Repeating the coverage row word for word would
// make this section furniture.
function OpenQuestions({ items }: { items: AuditOpenItem[] }) {
  return (
    <div className="flex flex-col" data-testid="audit-open-questions">
      {items.map((i) => (
        <div
          key={`${i.kind}:${i.patternStep}:${i.component}`}
          className="border-b border-[var(--hairline)] py-3 last:border-b-0"
          data-testid={`audit-open-${i.kind}`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-[0.85rem] font-medium">{i.label}</p>
            <span
              className="text-[0.82rem] font-medium tracking-wider uppercase"
              style={{ color: openItemColor(i.kind) }}
            >
              {OPEN_ITEM_TITLES[i.kind]}
            </span>
          </div>
          <p className="mt-1.5 text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]">
            {i.detail}
          </p>
          <p className="mt-1.5 text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]">
            <span className="text-[var(--atlas-text)]/75">Needed to resolve: </span>
            {i.needed}
          </p>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * 6. ON-CHAIN VERIFICATION — rendered only where artifacts exist
 * ---------------------------------------------------------------- */

function Onchain({ entries }: { entries: { evidenceId: string; locator: string }[] }) {
  return (
    <div className="flex flex-col gap-2" data-testid="audit-onchain">
      {entries.map((e) => (
        <p
          key={e.evidenceId}
          className="font-mono text-[0.82rem] break-all text-[var(--atlas-text)]/85"
        >
          {e.locator}
        </p>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * 7. RESEARCH TRACE — deep, and still in ordinary words
 * ---------------------------------------------------------------- */

// DEEP IS NOT THE SAME AS RAW. The first version put the engine's own
// identifiers on this surface — SOURCE_OF_VALUE, reason codes, and
// counters compressed to "2s · 0c · 2x" — which is debug output wearing a
// table. A professional reading an audit should not have to learn a
// notation to find out how many sources supported a point.
//
// So the trace now spells everything out, and the raw identifiers move
// ONE LEVEL DEEPER, behind an explicit developer disclosure. Nothing is
// removed: the component key and its reason codes are exactly where an
// engineer would look for them, and nowhere a reader would trip over them.
function Trace({ scope }: { scope: AuditScopeItem[] }) {
  return (
    <div className="flex flex-col" data-testid="audit-trace">
      {scope.map((s) => (
        <div
          key={`${s.patternStep}:${s.component}`}
          className="border-b border-[var(--hairline)] py-3 last:border-b-0"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-[0.85rem] font-medium">{s.label}</p>
            <span
              className="text-[0.82rem] font-medium tracking-wide uppercase"
              style={{ color: outcomeColor(s.outcome) }}
            >
              {s.outcomeLabel}
            </span>
          </div>
          {s.reason && (
            <p className="mt-1 text-[0.85rem] leading-relaxed text-[var(--atlas-text-dim)]">
              {s.reason}
            </p>
          )}
          <p className="mt-1 text-[0.85rem] text-[var(--atlas-text-dim)]">
            How far the check got: {s.coverageLabel.toLowerCase()}
          </p>
          <p className="mt-0.5 text-[0.85rem] text-[var(--atlas-text-dim)]">
            Supporting: {s.supportingCount} · Conflicting: {s.contradictingCount} · Excluded:{" "}
            {s.excludedCount}
          </p>

          {/* THE ENGINE'S OWN VOCABULARY, ONE LEVEL DEEPER. This is the
              only place in the audit where a Pattern key or a reason code
              appears, and a reader has to ask for it. */}
          <details className="group mt-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.82rem] text-[var(--atlas-text-dim)]/80 select-none [&::-webkit-details-marker]:hidden">
              <Chevron className="shrink-0 transition-transform duration-200 group-open:rotate-90" />
              Developer details
            </summary>
            <dl className="mt-1.5 ml-4 font-mono text-[0.82rem] text-[var(--atlas-text-dim)]">
              <div>component: {s.component}</div>
              <div>pattern_step: {s.patternStep}</div>
              <div>status: {s.status}</div>
              <div>coverage: {s.coverage}</div>
              <div>reason_codes: {s.reasonCodes.length > 0 ? s.reasonCodes.join(", ") : "—"}</div>
            </dl>
          </details>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * small parts
 * ---------------------------------------------------------------- */

function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="m6 3 5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function toneColor(tone?: string): string {
  switch (tone) {
    case "supported":
      return "rgba(45, 212, 191, 0.95)";
    case "partial":
      return "rgba(167, 139, 250, 0.95)";
    case "negative":
      return "rgba(248, 113, 113, 0.95)";
    case "insufficient":
      return "rgba(251, 191, 36, 0.92)";
    default:
      return "var(--atlas-text)";
  }
}

// One colour per OUTCOME, so the word and the colour say the same thing.
// "Research blocked" is amber like a warning, not red like a finding —
// it is a fact about the run, and nothing about the project.
// An evidence-map group always HAS evidence, so it is never the blocked
// case; its outcome follows from the canonical status alone.
function auditOutcomeOf(status: string): string {
  return auditOutcome(status, "COMPLETED");
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "CONFIRMED":
      return "rgba(45,212,191,0.95)";
    case "PARTIALLY_CONFIRMED":
      return "rgba(167,139,250,0.95)";
    case "CONTRADICTED":
      return "rgba(248,113,113,0.95)";
    case "RESEARCH_BLOCKED":
      return "rgba(251,191,36,0.92)";
    default:
      return "rgba(226,232,240,0.7)";
  }
}

function openItemColor(kind: AuditOpenItem["kind"]): string {
  switch (kind) {
    case "CONFLICT":
      return "rgba(248,113,113,0.95)";
    case "TECHNICAL_LIMITATION":
      return "rgba(251,191,36,0.92)";
    default:
      return "var(--atlas-text-dim)";
  }
}
