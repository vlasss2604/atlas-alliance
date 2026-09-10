"use client";

import type { AuditBoundaryItem, AuditCheck, AuditComposition, AuditFinding } from "../../audit-composition";
import { CONFIDENCE_LABELS, componentPhrase, verdictLabel } from "../../research-model";
import { DeepProofEntryBlock } from "./deep-proof-entry";
import { ProofMapBlock } from "./proof-map";
import { SelectedBlocks } from "./selected-blocks";
import { PROOF_STATE, type ProofState } from "./types";

// AUDIT OUTPUT V1 — THE COMPOSITION, COMPRESSED.
//
// TOP = SCAN, BOTTOM = INSPECT. The first two screens are built to be read
// without reading: one verdict, one fraction, four counts, then finding
// TILES, then a comparison a reader can run their eye down, then the gaps
// as chips. Prose returns only where it belongs — the evidence's own words
// and the verification layer.
//
// EVERY SHORT FORM KEEPS ITS LONG FORM IN THE DOM. Compression is a visual
// decision and never a semantic one: a tile shows a short fact keyed on the
// persisted reason CODE, and the row's full sentence sits beneath it in a
// <details>, so nothing that was said is unsaid — it is folded. Where no
// short form exists for a code, the sentence itself is shown, clamped, and
// never abbreviated by hand.
//
// Nothing here decides a state. The verdict is the Proof's; every row state
// is a persisted component status; the analytical blocks are the plan's.

// SHORT FORMS, KEYED ON THE ENGINE'S OWN CODES. A closed map of the same
// vocabulary REASON_CODE_EXPLANATIONS covers, each entry a compression of
// its sentence there and never a stronger claim than it. Each describes the
// RECORD — what was and was not found — and none says the project did or
// did not do anything. The middle dot separates two facts; it never joins
// them into a conclusion.
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

// The FIRST recognised code wins — the same rule `reasonExplanation` uses,
// so the short form and the sentence beneath it always describe one code.
function shortReason(codes: readonly string[]): string | null {
  for (const c of codes) if (SHORT_REASON[c]) return SHORT_REASON[c];
  return null;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// WHAT ATLAS FOUND, IN A FEW WORDS. For a check that stood, the subject of
// the check (the same phrase the long sentence embeds). For one that did
// not, the short form of its persisted reason. Where neither exists the
// state's own label is shown — never a phrase written here.
function shortFound(c: Pick<AuditCheck, "component" | "state" | "reasonCodes" | "blocked">): string {
  if (c.blocked) return "Sources could not be opened";
  const short = shortReason(c.reasonCodes);
  switch (c.state) {
    case "ESTABLISHED": {
      const phrase = componentPhrase(c.component);
      return phrase ? capitalise(phrase) : PROOF_STATE.ESTABLISHED.label;
    }
    case "CONTRADICTED":
      return short ?? PROOF_STATE.CONTRADICTED.label;
    default:
      return short ?? PROOF_STATE[c.state].label;
  }
}

function StateChip({ state, className = "" }: { state: ProofState; className?: string }) {
  const s = PROOF_STATE[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.05em] ${className}`}
      style={{ color: s.color, background: s.dim }}
      data-state={state}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden />
      {s.label}
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
      {/* 1 — verdict, fraction, distribution; the map beside it on a wide screen */}
      <section className="panel panel-raised p-4 sm:p-5 lg:p-6" data-testid="block-audit-verdict">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
          <AuditMasthead audit={audit} asOf={asOf} />
          <CoverageGrid audit={audit} />
        </div>
      </section>

      {/* 2 — what did not line up, as tiles */}
      <AuditFindingsTiles audit={audit} />

      {/* 3 — every check, as a comparison a reader runs their eye down */}
      <ClaimVsReality audit={audit} />

      {/* 4 — the analytical blocks the selector chose, and only those */}
      {audit.analytical.length > 0 && (
        <SelectedBlocks
          plan={audit.plan}
          input={input}
          include={["METRIC", "FLOW", "TABLE", "CHART", "TIMELINE"]}
          answer={{ short: "", paragraphs: [] }}
          asOf={asOf}
        />
      )}

      {/* 5 — the boundary, as chips */}
      <AuditBoundaryChips audit={audit} />

      {/* the full map — the first depth layer, after everything that is scanned */}
      <section className="panel p-4 sm:p-5" data-testid="block-audit-map">
        <ProofMapBlock cells={audit.coverage.map((c) => ({ label: checkLabel(audit, c.component), state: c.state }))} />
      </section>

      {/* 6 — the same evidence selection, framed for the audit */}
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

      {/* 7 — the same verification layer */}
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

// The ladder's sentence for a check, so the map, the tiles, the comparison
// and the deep audit all name one check with one phrase.
function checkLabel(audit: AuditComposition, component: string): string {
  return audit.checks.find((c) => c.component === component)?.check ?? component;
}

/* --------------------------- 1. MASTHEAD --------------------------- */

const DISTRIBUTION: ProofState[] = ["ESTABLISHED", "PARTLY_ESTABLISHED", "CONTRADICTED", "NOT_ESTABLISHED"];

function AuditMasthead({ audit, asOf }: { audit: AuditComposition; asOf: string }) {
  const total = audit.coverage.length;
  const n = (s: ProofState) => audit.coverage.filter((c) => c.state === s).length;
  const established = n("ESTABLISHED");
  const tone = audit.verdict ? verdictColor(audit.verdict) : "var(--atlas-text-dim)";
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow eyebrow-violet">Audit verdict</p>
        <p className="text-[0.66rem] text-[var(--atlas-text-dim)]">{asOf}</p>
      </div>

      <p
        className="mt-1.5 text-[1.7rem] font-semibold leading-none tracking-tight sm:text-[2.1rem]"
        style={{ color: tone }}
        data-testid="audit-verdict-label"
      >
        {verdictLabel(audit.verdict)}
      </p>
      <p className="mt-1.5 text-[0.7rem] text-[var(--atlas-text-dim)]">
        {audit.confidenceBand ? `${CONFIDENCE_LABELS[audit.confidenceBand] ?? audit.confidenceBand} confidence` : "No confidence band"}
      </p>

      {/* THE FRACTION AND THE DISTRIBUTION. Real counts, equal weight. */}
      <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-3" data-testid="audit-coverage-words">
        <div className="flex items-baseline gap-1.5" data-testid="audit-fraction">
          <span className="text-[2rem] font-semibold leading-none tabular-nums sm:text-[2.4rem]" style={{ color: PROOF_STATE.ESTABLISHED.color }}>
            {established}
          </span>
          <span className="text-[1.05rem] leading-none text-[var(--atlas-text-dim)]">/ {total}</span>
          <span className="ml-1 text-[0.7rem] leading-none text-[var(--atlas-text-dim)]">checks established</span>
        </div>
        <ul className="flex flex-wrap gap-1.5" data-testid="audit-distribution">
          {DISTRIBUTION.filter((s) => n(s) > 0).map((s) => (
            <li
              key={s}
              className="rounded-md px-2 py-1 text-[0.66rem] font-medium leading-none"
              style={{ color: PROOF_STATE[s].color, background: PROOF_STATE[s].dim }}
              data-state={s}
            >
              <span className="font-semibold tabular-nums">{n(s)}</span> {PROOF_STATE[s].label.toLowerCase()}
            </li>
          ))}
        </ul>
      </div>

      {/* The coverage bar restated as a bar, so a glance carries the shape. */}
      <div className="mt-3 flex gap-0.5" role="img" aria-label={`${established} of ${total} checks established`}>
        {audit.coverage.map((c) => (
          <span key={c.component} className="h-1 flex-1 rounded-full" style={{ background: PROOF_STATE[c.state].color }} />
        ))}
      </div>

      <p className="mt-3 line-clamp-2 text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">{audit.question}</p>
      <p className="mt-1.5 text-[0.62rem] leading-snug text-[var(--atlas-text-dim)] opacity-80">
        Coverage counts checks, not quality. A check the sources did not establish is not a check that failed.
      </p>
    </div>
  );
}

// THE COVERAGE AT A GLANCE: every check as one short row, full label and
// state, in a column that matches the verdict's height. Two across was
// tried and truncated every label to its first two words, which loses the
// one thing a cell exists to say. DESKTOP ONLY: on a handset the fraction, the chips and the
// bar already carry the coverage in three lines, and ten stacked cells would
// push the findings off the first screen. The full map, with its notes, is
// a depth layer below on every width.
function CoverageGrid({ audit }: { audit: AuditComposition }) {
  return (
    <div className="hidden border-l border-[var(--hairline)] pl-8 lg:block" data-testid="audit-coverage-grid">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Coverage</p>
        <p className="text-[0.66rem] text-[var(--atlas-text-dim)]">{audit.coverage.length} checks</p>
      </div>
      <ul className="mt-2 flex flex-col gap-[3px]">
        {audit.coverage.map((c) => {
          const s = PROOF_STATE[c.state];
          return (
            <li
              key={c.component}
              className="flex min-w-0 items-center gap-2 rounded-md border-l-2 py-[3px] pl-2 pr-1.5"
              style={{ borderColor: s.color, background: s.dim }}
              data-testid="coverage-cell"
              data-state={c.state}
            >
              <span className="min-w-0 flex-1 truncate text-[0.7rem] font-medium leading-tight">{checkLabel(audit, c.component)}</span>
              <span className="shrink-0 text-[0.54rem] font-semibold uppercase tracking-[0.04em]" style={{ color: s.color }}>
                {s.label.replace("Evidence indicates otherwise", "Contradicted")}
              </span>
            </li>
          );
        })}
      </ul>
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

/* ---------------------------- 2. TILES ----------------------------- */

function AuditFindingsTiles({ audit }: { audit: AuditComposition }) {
  return (
    <section className="panel px-4 py-3.5 sm:px-5 sm:py-4" data-testid="block-audit-findings">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Main findings</p>
        <p className="text-[0.66rem] text-[var(--atlas-text-dim)]">{audit.findings.length} of {audit.checks.length} checks</p>
      </div>
      {audit.findings.length === 0 ? (
        <p className="mt-2 text-[0.78rem] text-[var(--atlas-text-dim)]" data-testid="audit-no-findings">
          No check was contradicted or left with a stated gap.
        </p>
      ) : (
        <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {audit.findings.map((f, i) => (
            <FindingTile key={f.component} finding={f} index={i} />
          ))}
        </ol>
      )}
    </section>
  );
}

// ONE GLANCE: the check, the state, one short fact. The full sentence is
// folded beneath, not removed.
function FindingTile({ finding: f, index }: { finding: AuditFinding; index: number }) {
  const s = PROOF_STATE[f.state];
  const short = f.state === "CONTRADICTED" ? (shortReason(f.reasonCodes) ?? s.label) : shortReason(f.reasonCodes);
  return (
    <li
      className="flex flex-col rounded-lg border-l-2 px-3 py-2.5"
      style={{ borderColor: s.color, background: s.dim }}
      data-testid="audit-finding"
      data-state={f.state}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[0.8rem] font-semibold leading-tight">
          <span className="mr-1.5 text-[0.6rem] font-normal tabular-nums text-[var(--atlas-text-dim)]">{String(index + 1).padStart(2, "0")}</span>
          {f.label}
        </p>
      </div>
      <StateChip state={f.state} className="mt-1.5 self-start" />
      {short ? (
        <p className="mt-1.5 text-[0.74rem] leading-snug" data-testid="finding-short">{short}</p>
      ) : (
        <p className="mt-1.5 line-clamp-2 text-[0.72rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="finding-short">{f.sentence}</p>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-[0.62rem] text-[var(--atlas-text-dim)]">why</summary>
        <p className="mt-1 text-[0.72rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="finding-sentence">{f.sentence}</p>
      </details>
    </li>
  );
}

/* ------------------------ 3. CLAIM VS REALITY ---------------------- */

// STACKED ON A HANDSET, THREE COLUMNS ON A DESK. A 38rem table swiped
// sideways is not scannable at 430px; a row per check, with the state at
// the right edge and the finding beneath, is. The full sentences stay in a
// single fold at the bottom.
function ClaimVsReality({ audit }: { audit: AuditComposition }) {
  return (
    <section className="panel px-4 py-3.5 sm:px-5 sm:py-4" data-testid="block-claim-reality">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Claim vs reality</p>
        <p className="text-[0.66rem] text-[var(--atlas-text-dim)]">{audit.checks.length} checks</p>
      </div>

      <div className="mt-2 hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_auto] gap-x-4 border-b border-[var(--hairline-strong)] pb-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.06em] text-[var(--atlas-text-dim)] lg:grid">
        <span>Check</span>
        <span>What ATLAS found</span>
        <span className="text-right">State</span>
      </div>

      <ul className="mt-1 flex flex-col">
        {audit.checks.map((c) => (
          <li
            key={c.component}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-[var(--hairline)] py-2 first:border-t-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_auto] lg:gap-x-4 lg:items-center"
            data-testid="claim-row"
            data-state={c.state}
          >
            <p className="min-w-0 text-[0.78rem] font-medium leading-tight">{c.check}</p>
            <div className="row-start-1 col-start-2 flex items-center justify-end gap-2 lg:col-start-3">
              <StateChip state={c.state} />
            </div>
            <p className="col-span-2 min-w-0 text-[0.72rem] leading-snug text-[var(--atlas-text-dim)] lg:col-span-1 lg:col-start-2 lg:row-start-1" data-testid="claim-found">
              {shortFound(c)}
              <span className="ml-1.5 text-[0.62rem] tabular-nums opacity-70">{c.sources} src</span>
            </p>
          </li>
        ))}
      </ul>

      <details className="mt-2 border-t border-[var(--hairline)] pt-2">
        <summary className="cursor-pointer text-[0.66rem] text-[var(--atlas-text-dim)]">Full sentences for every check</summary>
        <ul className="mt-1.5 flex flex-col gap-1.5 text-[0.72rem] leading-snug" data-testid="claim-full">
          {audit.checks.map((c) => (
            <li key={c.component}>
              <span className="font-medium">{c.check}</span>
              <span className="text-[var(--atlas-text-dim)]"> — {c.established}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[0.64rem] leading-snug text-[var(--atlas-text-dim)]">
          The state grades the check and nothing else: a check the sources did not establish is not a check that failed.
        </p>
      </details>
    </section>
  );
}

/* --------------------------- 5. BOUNDARY --------------------------- */

const BOUNDARY_HEADING: Record<AuditBoundaryItem["kind"], { title: string; chip: string; note: string; state: ProofState }> = {
  PARTLY_ESTABLISHED: {
    title: "Partly established",
    chip: "Partly established",
    note: "The evidence went part of the way; the short form names the part it did not reach.",
    state: "PARTLY_ESTABLISHED",
  },
  NOT_ESTABLISHED: {
    title: "Not established",
    chip: "Not established",
    note: "The sources ATLAS read did not establish these. Absence of evidence is not evidence of absence.",
    state: "NOT_ESTABLISHED",
  },
  COULD_NOT_CHECK: {
    title: "Could not be checked",
    chip: "Not checked",
    note: "Sources could not be opened. A limit of the research run, not a finding about the project.",
    state: "NOT_ESTABLISHED",
  },
};

function AuditBoundaryChips({ audit }: { audit: AuditComposition }) {
  const groups = (["PARTLY_ESTABLISHED", "NOT_ESTABLISHED", "COULD_NOT_CHECK"] as const)
    .map((k) => ({ kind: k, items: audit.boundary.filter((b) => b.kind === k) }))
    .filter((g) => g.items.length > 0);
  return (
    <section className="panel px-4 py-3.5 sm:px-5 sm:py-4" data-testid="block-not-verified">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>What could not be verified</p>
        <p className="text-[0.66rem] text-[var(--atlas-text-dim)]">{audit.boundary.length} items</p>
      </div>
      {groups.length === 0 ? (
        <p className="mt-2 text-[0.78rem] text-[var(--atlas-text-dim)]" data-testid="audit-boundary-empty">
          Every check the research made was established.
        </p>
      ) : (
        <>
          <div className="mt-2.5 flex flex-col gap-2.5">
            {groups.map((g) => {
              const h = BOUNDARY_HEADING[g.kind];
              return (
                <div key={g.kind} data-testid={`boundary-${g.kind.toLowerCase().replace(/_/g, "-")}`}>
                  <p className="text-[0.62rem] font-semibold uppercase tracking-[0.06em]" style={{ color: PROOF_STATE[h.state].color }}>
                    {h.title}
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {g.items.map((b) => {
                      const short = shortReason(b.reasonCodes);
                      return (
                        <li
                          key={`${g.kind}-${b.component}`}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[0.7rem] leading-tight"
                          style={{ borderColor: PROOF_STATE[h.state].color, background: PROOF_STATE[h.state].dim }}
                          title={b.detail}
                          data-testid="boundary-item"
                          data-state={h.state}
                        >
                          <span className="font-medium">{b.label}</span>
                          {short && <span className="text-[var(--atlas-text-dim)]">· {short}</span>}
                          <span className="ml-0.5 text-[0.56rem] font-semibold uppercase tracking-[0.05em]" style={{ color: PROOF_STATE[h.state].color }}>
                            {h.chip}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
          <details className="mt-2.5 border-t border-[var(--hairline)] pt-2">
            <summary className="cursor-pointer text-[0.66rem] text-[var(--atlas-text-dim)]">Full detail</summary>
            <div className="mt-1.5 flex flex-col gap-2" data-testid="boundary-full">
              {groups.map((g) => (
                <div key={g.kind}>
                  <p className="text-[0.64rem] leading-snug text-[var(--atlas-text-dim)]">{BOUNDARY_HEADING[g.kind].note}</p>
                  <ul className="mt-1 flex flex-col gap-1 text-[0.72rem] leading-snug">
                    {g.items.map((b) => (
                      <li key={`${g.kind}-${b.component}-full`}>
                        <span className="font-medium">{b.label}</span>
                        <span className="text-[var(--atlas-text-dim)]"> — {b.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
