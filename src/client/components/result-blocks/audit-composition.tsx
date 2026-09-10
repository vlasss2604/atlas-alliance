"use client";

import type { AuditBoundaryItem, AuditCheck, AuditComposition } from "../../audit-composition";
import { CONFIDENCE_LABELS, componentPhrase, verdictLabel } from "../../research-model";
import { DeepProofEntryBlock } from "./deep-proof-entry";
import { ProofMapBlock } from "./proof-map";
import { SelectedBlocks } from "./selected-blocks";
import { PROOF_STATE, type ProofState } from "./types";

// AUDIT OUTPUT V2 — ONE INSTRUMENT, NOT MANY BOXES.
//
// The audit answers, in this order: what is the result; what stood up and
// what did not; what is the main gap; what evidence supports that; then the
// verification layer. The first screen is one verdict, one sentence, the
// counts, and ONE table. Nothing on it is a paragraph.
//
// WHAT V1 HAD AND V2 DOES NOT. V1 showed the same ten statuses four times —
// a coverage grid, finding tiles, a comparison table and a chip list — and
// each was individually honest and together they were noise. V2 keeps the
// table, because it is the one form that carries check, finding and state
// in a single row, and folds the rest into it: the map moves below as
// depth, the tiles and chips are gone, and the boundary becomes ONE block
// naming the single most important open check.
//
// Nothing here decides a state. The verdict is the Proof's; the summary is
// the research screen's own lead sentence; every row state is a persisted
// component status; the gap is chosen by the short answer's own priority;
// the analytical blocks are the plan's. Every short form keeps its full
// sentence in the DOM, folded.

// SHORT FORMS, KEYED ON THE ENGINE'S OWN CODES. A closed map of the same
// vocabulary REASON_CODE_EXPLANATIONS covers, each entry a compression of
// its sentence there and never a stronger claim than it. Each describes the
// RECORD — what was and was not found — and none says the project did or
// did not do anything.
export const SHORT_REASON: Record<string, string> = {
  NO_EVIDENCE_FOUND: "Nothing found in checked sources",
  ALL_EVIDENCE_EXCLUDED: "Discussed · no admissible source",
  MISSING_EXECUTION_EVIDENCE: "Described · not seen running",
  MISSING_CURRENT_STATE: "Current state not stated",
  STALE_CURRENT_STATE: "Only dated sources",
  INSUFFICIENT_AUTHORITY: "Only in sources that cannot settle it",
  MECHANICAL_PROVENANCE_NOT_ESTABLISHED: "Documented · on-chain link missing",
  INDIRECT_ONLY: "Only indirect references",
  STATE_NOT_FULLY_LIVE: "Preparation · not fully live",
  CONFLICTING_STATE: "Sources disagree on state",
  TOKEN_STATE_UNQUALIFIED: "Token state imprecise",
  SUPPLY_REDUCTION_NOT_ESTABLISHED: "No burn seen in checked sources",
  NET_SUPPLY_CHANGE_NOT_ESTABLISHED: "Burn seen · net change unmeasured",
  NET_SUPPLY_CHANGE_NOT_ATTRIBUTED: "Supply fell · cause not attributed",
  NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL: "Supply not lower over interval",
  CONFLICTING_SUPPLY_DELTA: "Supply measurements disagree",
};

function shortReason(codes: readonly string[]): string | null {
  for (const c of codes) if (SHORT_REASON[c]) return SHORT_REASON[c];
  return null;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// WHAT ATLAS FOUND, IN A FEW WORDS. For a check that stood, the subject of
// the check; for one that did not, the short form of its persisted reason;
// for one that could not be checked, that fact. Where none exists, the
// state's own label — never a phrase written here.
function shortFound(c: Pick<AuditCheck, "component" | "state" | "reasonCodes" | "blocked">): string {
  if (c.blocked) return "Sources could not be opened";
  const short = shortReason(c.reasonCodes);
  if (c.state === "ESTABLISHED") {
    const phrase = componentPhrase(c.component);
    return phrase ? capitalise(phrase) : PROOF_STATE.ESTABLISHED.label;
  }
  return short ?? PROOF_STATE[c.state].label;
}

// A BLOCKED CHECK IS CHIPPED "NOT CHECKED", never "not established": the
// sources could not be opened, which is a fact about the run. Same colour
// as not established — amber, never red — different words.
function StateChip({ state, blocked = false }: { state: ProofState; blocked?: boolean }) {
  const s = PROOF_STATE[state];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.05em]"
      style={{ color: s.color, background: s.dim }}
      data-state={state}
      data-blocked={blocked ? "true" : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden />
      {blocked ? "Not checked" : s.label}
    </span>
  );
}

export function AuditCompositionView({
  audit,
  input,
  asOf,
}: {
  audit: AuditComposition;
  input: Parameters<typeof SelectedBlocks>[0]["input"];
  asOf: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:gap-4" data-testid="audit-composition">
      {/* 1–5 — THE INSTRUMENT. On a handset: verdict, summary, counts, the
          table, the gap, in that order. On a desk: the verdict column at
          the left with the gap beneath it, the table as the main area. */}
      <section className="panel panel-raised p-4 sm:p-5 lg:p-6" data-testid="block-audit-verdict">
        <div className="grid gap-5 lg:grid-cols-[21rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-8 lg:gap-y-5">
          <AuditMasthead audit={audit} asOf={asOf} />
          <div className="lg:col-start-2 lg:row-span-2 lg:border-l lg:border-[var(--hairline)] lg:pl-8">
            <AuditTable audit={audit} />
          </div>
          <div className="lg:col-start-1 lg:row-start-2">
            <AuditGap audit={audit} />
          </div>
        </div>
      </section>

      {/* 6 — the analytical blocks the selector chose, and only those */}
      {audit.analytical.length > 0 && (
        <SelectedBlocks
          plan={audit.plan}
          input={input}
          include={["METRIC", "FLOW", "TABLE", "CHART", "TIMELINE"]}
          answer={{ short: "", paragraphs: [] }}
          asOf={asOf}
        />
      )}

      {/* 7 — the map: supporting depth, not a second summary */}
      <section className="panel p-4 sm:p-5" data-testid="block-audit-map">
        <ProofMapBlock cells={audit.coverage.map((c) => ({ label: checkLabel(audit, c.component), state: c.state }))} />
      </section>

      {/* 8 — the same evidence selection, framed for the audit */}
      {audit.evidence && (
        <SelectedBlocks
          plan={audit.plan}
          input={input}
          include={["EVIDENCE_SNAPSHOT"]}
          answer={{ short: "", paragraphs: [] }}
          asOf={asOf}
          evidenceTitle="Key evidence"
        />
      )}

      {/* 9 — the same verification layer */}
      {audit.deep && (
        <DeepProofEntryBlock
          title="Deep audit"
          intro="Above is what the audit found. Below is every check with the sources behind it, what they were refused for, and the full research audit."
          rows={audit.deep.spec.rows.map((r) => ({ label: checkLabel(audit, r.component), state: r.state, sources: r.sources }))}
        />
      )}
    </div>
  );
}

function checkLabel(audit: AuditComposition, component: string): string {
  return audit.checks.find((c) => c.component === component)?.check ?? component;
}

/* --------------------------- 1–3. MASTHEAD -------------------------- */

// COUNTS, NOT A SCORE. "Established: 2" beside "Not established: 6" is a
// coverage summary; "2 / 10" as a hero number reads as a grade, and a check
// the sources did not establish is not a point lost. The subordinate line
// says so once.
const COUNT_ORDER: { state: ProofState; label: string }[] = [
  { state: "ESTABLISHED", label: "Established" },
  { state: "PARTLY_ESTABLISHED", label: "Partial" },
  { state: "CONTRADICTED", label: "Contradicted" },
  { state: "NOT_ESTABLISHED", label: "Not established" },
];

function AuditMasthead({ audit, asOf }: { audit: AuditComposition; asOf: string }) {
  const n = (s: ProofState) => audit.coverage.filter((c) => c.state === s).length;
  const tone = audit.verdict ? verdictColor(audit.verdict) : "var(--atlas-text-dim)";
  return (
    <div className="flex min-w-0 flex-col" data-testid="audit-masthead">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow eyebrow-violet">Audit verdict</p>
        <p className="text-[0.64rem] text-[var(--atlas-text-dim)]">{asOf}</p>
      </div>
      <p
        className="mt-1.5 text-[1.7rem] font-semibold leading-none tracking-tight sm:text-[2rem]"
        style={{ color: tone }}
        data-testid="audit-verdict-label"
      >
        {verdictLabel(audit.verdict)}
      </p>
      <p className="mt-1.5 text-[0.7rem] text-[var(--atlas-text-dim)]">
        {audit.confidenceBand ? `${CONFIDENCE_LABELS[audit.confidenceBand] ?? audit.confidenceBand} confidence` : "No confidence band"}
      </p>

      {audit.summary && (
        <p className="mt-3 text-[0.86rem] leading-snug" data-testid="audit-summary">
          {audit.summary}
        </p>
      )}

      <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-1" data-testid="audit-counts">
        {COUNT_ORDER.filter((c) => n(c.state) > 0).map((c) => (
          <div key={c.state} className="flex items-baseline justify-between gap-2 border-b border-[var(--hairline)] pb-1" data-state={c.state}>
            <dt className="flex items-center gap-1.5 text-[0.7rem] text-[var(--atlas-text-dim)]">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: PROOF_STATE[c.state].color }} aria-hidden />
              {c.label}
            </dt>
            <dd className="text-[0.86rem] font-semibold tabular-nums" style={{ color: PROOF_STATE[c.state].color }}>
              {n(c.state)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[0.62rem] leading-snug text-[var(--atlas-text-dim)] opacity-80">
        Coverage counts checks, not quality. A check the sources did not establish is not a check that failed.
      </p>
      <p className="mt-2 line-clamp-2 text-[0.66rem] leading-snug text-[var(--atlas-text-dim)]">{audit.question}</p>
    </div>
  );
}

function verdictColor(verdict: string): string {
  switch (verdict) {
    case "SUPPORTED":
      return PROOF_STATE.ESTABLISHED.color;
    case "PARTIALLY_SUPPORTED":
      return PROOF_STATE.PARTLY_ESTABLISHED.color;
    case "NOT_SUPPORTED":
      return PROOF_STATE.CONTRADICTED.color;
    default:
      return PROOF_STATE.NOT_ESTABLISHED.color;
  }
}

/* -------------------------- 4. THE TABLE --------------------------- */

// CHECK · WHAT ATLAS FOUND · STATE. Every assessed check, in the ladder's
// order, one line each. Stacked on a handset (label and chip on one line,
// the finding beneath), three true columns on a desk. Full sentences are
// one fold below the table, never removed.
function AuditTable({ audit }: { audit: AuditComposition }) {
  return (
    <div data-testid="block-audit-table">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Checks</p>
        <p className="text-[0.64rem] text-[var(--atlas-text-dim)]">{audit.checks.length} made</p>
      </div>

      <div className="mt-2 hidden grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto] gap-x-4 border-b border-[var(--hairline-strong)] pb-1.5 text-[0.58rem] font-semibold uppercase tracking-[0.06em] text-[var(--atlas-text-dim)] lg:grid">
        <span>Check</span>
        <span>What ATLAS found</span>
        <span className="text-right">State</span>
      </div>

      <ul className="mt-1 flex flex-col">
        {audit.checks.map((c) => (
          <li
            key={c.component}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-[var(--hairline)] py-2 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto] lg:items-center lg:gap-x-4"
            data-testid="audit-row"
            data-state={c.state}
            data-blocked={c.blocked ? "true" : undefined}
          >
            <p className="min-w-0 text-[0.78rem] font-medium leading-tight">{c.check}</p>
            <div className="col-start-2 row-start-1 flex justify-end lg:col-start-3">
              <StateChip state={c.state} blocked={c.blocked} />
            </div>
            <p className="col-span-2 min-w-0 text-[0.72rem] leading-snug text-[var(--atlas-text-dim)] lg:col-span-1 lg:col-start-2 lg:row-start-1" data-testid="audit-found">
              {shortFound(c)}
              <span className="ml-1.5 text-[0.6rem] tabular-nums opacity-70">{c.sources} src</span>
            </p>
          </li>
        ))}
      </ul>

      <details className="mt-2 border-t border-[var(--hairline)] pt-2">
        <summary className="cursor-pointer text-[0.64rem] text-[var(--atlas-text-dim)]">Full sentences for every check</summary>
        <ul className="mt-1.5 flex flex-col gap-1.5 text-[0.72rem] leading-snug" data-testid="audit-full">
          {audit.checks.map((c) => (
            <li key={c.component}>
              <span className="font-medium">{c.check}</span>
              <span className="text-[var(--atlas-text-dim)]"> — {c.established}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[0.62rem] leading-snug text-[var(--atlas-text-dim)]">
          The state grades the check and nothing else. A check the sources did not establish is not a check that failed; a
          check that could not be opened is a limit of the run, not a finding about the project.
        </p>
      </details>
    </div>
  );
}

/* --------------------------- 5. THE GAP ---------------------------- */

const GAP_KIND_LABEL: Record<AuditBoundaryItem["kind"], string> = {
  PARTLY_ESTABLISHED: "Partly established",
  NOT_ESTABLISHED: "Not established",
  COULD_NOT_CHECK: "Could not be checked",
};

// ONE BLOCK, ONE CHECK. The single most important open boundary, with its
// full sentence — the one place above the fold a whole sentence is shown,
// because this is the sentence the audit exists to deliver. The count of
// other open checks points back at the table rather than listing them
// again.
function AuditGap({ audit }: { audit: AuditComposition }) {
  const g = audit.gap;
  const others = audit.boundary.length - (g ? 1 : 0);
  const state: ProofState = g?.kind === "PARTLY_ESTABLISHED" ? "PARTLY_ESTABLISHED" : "NOT_ESTABLISHED";
  return (
    <div className="rounded-lg border-l-2 py-2.5 pl-3 pr-2" style={{ borderColor: PROOF_STATE[state].color, background: g ? PROOF_STATE[state].dim : "transparent" }} data-testid="block-audit-gap">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Where the audit stops</p>
      {g ? (
        <>
          <div className="mt-1.5 flex items-start justify-between gap-2">
            <p className="text-[0.82rem] font-semibold leading-tight" data-testid="audit-gap-check">{g.label}</p>
            <StateChip state={state} blocked={g.kind === "COULD_NOT_CHECK"} />
          </div>
          <p className="mt-1.5 text-[0.74rem] leading-snug" data-testid="audit-gap-detail">{g.detail}</p>
          <p className="mt-1.5 text-[0.62rem] text-[var(--atlas-text-dim)]">
            {GAP_KIND_LABEL[g.kind]}
            {others > 0 && ` · ${others} other open ${others === 1 ? "check" : "checks"} in the table`}
          </p>
        </>
      ) : (
        <p className="mt-1.5 text-[0.76rem] text-[var(--atlas-text-dim)]" data-testid="audit-gap-none">
          Every check the research made was established.
        </p>
      )}
    </div>
  );
}
