"use client";

import Link from "next/link";
import { useState } from "react";

import type { AuditProjectionView } from "../api";
import {
  AUDIT_SECTION_TITLES,
  buildAuditContent,
  availableAuditSections,
  orderAuditSections,
  type AuditComponentRow,
  type AuditContent,
  type AuditEvidenceGroup,
  type AuditEvidenceRow,
  type AuditOpenItem,
  type AuditScopeItem,
  type AuditSectionId,
  type AuditSourceEntry,
  type SourceRegister,
  auditOutcome,
} from "../audit-model";
import { retrievedOn } from "../research-model";

// THE FULL RESEARCH AUDIT SURFACE.
//
// A DIFFERENT SCREEN FOR A DIFFERENT QUESTION. The Result answers "what is
// the answer?". This answers "can I check how that answer was reached?" —
// so it shares no layout with the Result and repeats none of its parts.
// No verdict banner, no question-driven findings, no answer sentences, no
// result ladder. A source is a citation on the Result and a ledger entry
// here.
//
// ONE CANONICAL HOME PER FACT. The rule that shapes every section below:
// a reader must never wonder "did I already read this?". Coverage owns
// what was checked. The evidence map owns RELATIONSHIPS and references
// sources compactly. The source register owns source IDENTITY, once. Open
// questions own what remains and what would close it. The trace owns the
// engine's own vocabulary. Nothing is stated twice for its own sake.
//
// PROGRESSIVE DEPTH. Summary, coverage, open questions and the register's
// rows are open; every detail is one click down. A professional should
// understand the state of the research in under a minute, then drill.
//
// EVERY FACT IS CANONICAL. Statuses, counts, reason codes, evidence links,
// exclusion reasons, classes and retrieval times are computed by
// `audit-model.ts` from persisted rows. The model-generated projection
// supplies section ORDER, short component LABELS and two sentences of
// connective copy — and where it supplied none, canonical labels are used
// and every section still renders.
export function ResearchAudit({
  jobId,
  projectName,
  question,
  researchedAt,
  components,
  evidence,
  projection,
}: {
  jobId: string | null;
  projectName: string | null;
  question: string;
  researchedAt: string | null;
  components: AuditComponentRow[];
  evidence: AuditEvidenceRow[];
  projection: AuditProjectionView | null;
}) {
  const usable = projection?.status === "VALID" ? projection : null;
  const content = buildAuditContent(
    components,
    evidence,
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
    <div className="flex flex-col gap-4" data-testid="research-audit">
      {/* COMPACT CONTEXT ONLY. Enough to know which record this is —
          never a second copy of the Result the reader just left. */}
      <header className="panel panel-raised px-5 py-5 sm:px-6" data-testid="audit-context">
        <p className="eyebrow eyebrow-violet">Full research audit</p>
        <h1 className="mt-2 text-[1.1rem] font-semibold tracking-tight sm:text-[1.25rem]">
          {projectName ?? "Research record"}
        </h1>
        <p className="mt-1.5 text-[0.82rem] leading-snug text-[var(--atlas-text-dim)]">
          {question}
        </p>
        <p className="mt-2.5 text-[0.72rem] text-[var(--atlas-text-dim)]">
          Research completed {retrievedOn(researchedAt) ?? "—"}
          {projection ? ` · audit prepared ${retrievedOn(projection.createdAt) ?? "—"}` : ""}
        </p>
      </header>

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
        // A PRESENTATION FAILURE, SAID QUIETLY. The audit above is complete
        // and canonical either way — what a failed projection costs is its
        // labels and ordering, so the message says exactly that and implies
        // nothing about the research.
        <p
          className="panel px-5 py-3 text-[0.76rem] leading-relaxed text-[var(--atlas-text-dim)]"
          data-testid="audit-projection-failed"
        >
          Audit labels could not be prepared, so research points are shown under their
          canonical names. The record itself is complete.
        </p>
      )}
    </div>
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
      <section className="panel px-5 py-5 sm:px-6" data-testid={`audit-section-${id}`}>
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
          {AUDIT_SECTION_TITLES[id]}
        </p>
        <div className="mt-4">{children}</div>
      </section>
    );
  }
  return (
    <details className="group panel px-5 py-4 sm:px-6" data-testid={`audit-section-${id}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[0.8rem] text-[var(--atlas-text-dim)] select-none [&::-webkit-details-marker]:hidden">
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
      <div className="mt-4 border-t border-[var(--hairline)] pt-3.5 text-[0.78rem] leading-relaxed text-[var(--atlas-text-dim)]">
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
      <p className="mt-1 text-[0.71rem] text-[var(--atlas-text-dim)]">{label}</p>
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
            <span className="mt-0.5 block text-[0.73rem] text-[#fcd34d]">
              ATLAS could not access the source this check required.
            </span>
          )}
        </span>
        <span
          className="shrink-0 text-[0.73rem] font-medium tracking-wide uppercase"
          style={{ color: outcomeColor(item.outcome) }}
          data-testid="audit-outcome"
        >
          {item.outcomeLabel}
        </span>
      </button>

      {open && (
        <div
          className="mt-2 ml-[1.45rem] text-[0.75rem] leading-relaxed text-[var(--atlas-text-dim)]"
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
          <span className="mt-0.5 block text-[0.72rem] text-[var(--atlas-text-dim)]">
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
        <span className="shrink-0 text-[0.72rem]" style={{ color: outcomeColor(auditOutcomeOf(group.status)) }}>
          {group.outcomeLabel}
        </span>
      </button>

      {open && (
        <div className="mt-3 ml-[1.45rem] flex flex-col gap-3" data-testid="audit-evidence-detail">
          {group.admitted.map((l) => (
            <div key={`a:${l.sourceKey}`}>
              <p className="text-[0.76rem] leading-snug text-[var(--atlas-text-dim)]">
                <span className="text-[var(--atlas-text)]/75">What this establishes: </span>
                {l.canEstablish ?? "Not classified."}
              </p>
              <p className="mt-1 text-[0.76rem] leading-snug text-[var(--atlas-text-dim)]">
                <span className="text-[var(--atlas-text)]/75">Outside its scope: </span>
                {l.doesNotProve ?? l.cannotEstablish ?? "Not recorded."}
              </p>
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
              className="rounded-md border border-[rgba(251,191,36,0.2)] bg-[rgba(251,191,36,0.04)] px-3 py-2 text-[0.75rem] leading-snug text-[#fcd34d]"
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
        <p className="text-[0.62rem] tracking-wider text-[var(--atlas-text-dim)] uppercase">
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
          <p className="text-[0.62rem] tracking-wider text-[var(--atlas-text-dim)] uppercase">
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
          <span className="mt-0.5 block text-[0.72rem] text-[var(--atlas-text-dim)]">
            {entry.sourceClassLabel}
            {entry.fetchedAt ? ` · retrieved ${retrievedOn(entry.fetchedAt)}` : ""}
            {entry.evidenceIds.length > 1 ? ` · ${entry.evidenceIds.length} items` : ""}
          </span>
        </span>
      </button>

      {open && (
        <div className="mt-2 ml-[1.45rem] text-[0.75rem] leading-relaxed text-[var(--atlas-text-dim)]">
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
          className="text-[0.73rem] font-medium text-[var(--atlas-cyan)] hover:underline"
          data-testid="audit-view-snapshot"
        >
          View source snapshot
        </Link>
      )}
      <a
        href={link.retrievedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[0.73rem] text-[var(--atlas-text-dim)] hover:text-[var(--atlas-cyan)] hover:underline"
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
              className="text-[0.64rem] font-medium tracking-wider uppercase"
              style={{ color: openItemColor(i.kind) }}
            >
              {OPEN_ITEM_TITLES[i.kind]}
            </span>
          </div>
          <p className="mt-1.5 text-[0.78rem] leading-relaxed text-[var(--atlas-text-dim)]">
            {i.detail}
          </p>
          <p className="mt-1.5 text-[0.78rem] leading-relaxed text-[var(--atlas-text-dim)]">
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
          className="font-mono text-[0.72rem] break-all text-[var(--atlas-text)]/85"
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
              className="text-[0.72rem] font-medium tracking-wide uppercase"
              style={{ color: outcomeColor(s.outcome) }}
            >
              {s.outcomeLabel}
            </span>
          </div>
          {s.reason && (
            <p className="mt-1 text-[0.76rem] leading-relaxed text-[var(--atlas-text-dim)]">
              {s.reason}
            </p>
          )}
          <p className="mt-1 text-[0.76rem] text-[var(--atlas-text-dim)]">
            How far the check got: {s.coverageLabel.toLowerCase()}
          </p>
          <p className="mt-0.5 text-[0.76rem] text-[var(--atlas-text-dim)]">
            Supporting: {s.supportingCount} · Conflicting: {s.contradictingCount} · Excluded:{" "}
            {s.excludedCount}
          </p>

          {/* THE ENGINE'S OWN VOCABULARY, ONE LEVEL DEEPER. This is the
              only place in the audit where a Pattern key or a reason code
              appears, and a reader has to ask for it. */}
          <details className="group mt-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.7rem] text-[var(--atlas-text-dim)]/80 select-none [&::-webkit-details-marker]:hidden">
              <Chevron className="shrink-0 transition-transform duration-200 group-open:rotate-90" />
              Developer details
            </summary>
            <dl className="mt-1.5 ml-4 font-mono text-[0.68rem] text-[var(--atlas-text-dim)]">
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
