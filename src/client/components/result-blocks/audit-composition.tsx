"use client";

import type { AuditComposition } from "../../audit-composition";
import { CONFIDENCE_LABELS, componentLabel, verdictLabel } from "../../research-model";
import { AnalyticalTableBlock } from "./analytical-table";
import { DeepProofEntryBlock } from "./deep-proof-entry";
import { EvidenceSnapshotBlock } from "./evidence-snapshot";
import { ProofMapBlock } from "./proof-map";
import { SelectedBlocks } from "./selected-blocks";
import { PROOF_STATE, type ProofState } from "./types";

// AUDIT OUTPUT V1 — THE COMPOSITION.
//
// The order is the point. A research result leads with the answer and proves
// it underneath; an audit leads with the verdict, the coverage and what did
// not line up, and shows the analytical explanation only afterwards. Same
// blocks, different question:
//
//   1  AUDIT VERDICT + COVERAGE      ten seconds: how much stood up
//   2  MAIN FINDINGS                  what did not line up
//   3  CLAIM VS REALITY               every check, as a table
//   4  ANALYTICAL BLOCKS              only those the selector chose
//   5  WHAT COULD NOT BE VERIFIED     the audit boundary, in three kinds
//   6  KEY EVIDENCE                   the same snapshot selection
//   7  DEEP AUDIT                     the same verification layer
//
// Nothing here decides a state. The verdict is the Proof's; every row state
// is a persisted component status; the analytical blocks are the plan's.

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
    <div className="flex flex-col gap-4" data-testid="audit-composition">
      {/* 1 — verdict and coverage are one thought */}
      <section className="panel panel-raised p-4 sm:p-5 lg:p-6" data-testid="block-audit-verdict">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-7">
          <AuditVerdict audit={audit} asOf={asOf} />
          <div className="border-t border-[var(--hairline)] pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <ProofMapBlock cells={audit.coverage.map((c) => ({ label: componentLabel(c.component), state: c.state }))} />
          </div>
        </div>
      </section>

      {/* 2 — what did not line up */}
      <AuditFindings audit={audit} />

      {/* 3 — every check, as a table */}
      <div data-testid="block-claim-reality">
      <AnalyticalTableBlock
        title="Claim vs reality"
        columns={[
          { key: "check", label: "Check" },
          { key: "established", label: "What ATLAS established" },
          { key: "sources", label: "Sources", numeric: true },
        ]}
        rows={audit.checks.map((c) => ({
          key: c.component,
          state: c.state,
          cells: { check: c.check, established: c.established, sources: String(c.sources) },
        }))}
        note="Each row is one check the research made, in the words the result uses. The state grades that check and nothing else: a check the sources did not establish is not a check that failed."
      />
      </div>

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

      {/* 5 — the boundary */}
      <AuditBoundary audit={audit} />

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
          rows={audit.deep.spec.rows.map((r) => ({ label: componentLabel(r.component), state: r.state, sources: r.sources }))}
        />
      )}
    </div>
  );
}

// THE TEN-SECOND AUDIT. The Proof's verdict, its confidence band, and the
// coverage restated in words. No score, no severity, no sentence of ours:
// upstream carries none of those, so this shows none.
function AuditVerdict({ audit, asOf }: { audit: AuditComposition; asOf: string }) {
  const counts = (["ESTABLISHED", "PARTLY_ESTABLISHED", "CONTRADICTED", "NOT_ESTABLISHED"] as ProofState[])
    .map((s) => ({ s, n: audit.coverage.filter((c) => c.state === s).length }))
    .filter((c) => c.n > 0);
  const tone = audit.verdict ? verdictColor(audit.verdict) : "var(--atlas-text-dim)";
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow eyebrow-violet">Audit verdict</p>
        <p className="text-[0.68rem] text-[var(--atlas-text-dim)]">{asOf}</p>
      </div>
      <p className="mt-2 text-[1.5rem] font-semibold leading-tight tracking-tight sm:text-[1.8rem]" style={{ color: tone }} data-testid="audit-verdict-label">
        {verdictLabel(audit.verdict)}
      </p>
      <p className="mt-1 text-[0.75rem] text-[var(--atlas-text-dim)]">
        {audit.confidenceBand ? `${CONFIDENCE_LABELS[audit.confidenceBand] ?? audit.confidenceBand} confidence` : "No confidence band"} ·{" "}
        {audit.coverage.length} checks
      </p>
      <p className="mt-3 text-[0.82rem] leading-snug" data-testid="audit-coverage-words">
        {counts.map((c, i) => (
          <span key={c.s}>
            {i > 0 && <span className="text-[var(--atlas-text-dim)]"> · </span>}
            <span className="font-semibold" style={{ color: PROOF_STATE[c.s].color }}>{c.n}</span>{" "}
            {PROOF_STATE[c.s].label.toLowerCase()}
          </span>
        ))}
      </p>
      <p className="mt-3 text-[0.72rem] leading-snug text-[var(--atlas-text-dim)]">
        Audited question: {audit.question}
      </p>
      <p className="mt-2 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]">
        Coverage counts checks, not quality. A check the sources did not establish is not a check that failed.
      </p>
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

function AuditFindings({ audit }: { audit: AuditComposition }) {
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-audit-findings">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Main findings</p>
        <p className="text-[0.68rem] text-[var(--atlas-text-dim)]">{audit.findings.length} of {audit.checks.length} checks</p>
      </div>
      {audit.findings.length === 0 ? (
        <p className="mt-2 text-[0.8rem] text-[var(--atlas-text-dim)]" data-testid="audit-no-findings">
          No check was contradicted or left with a stated gap.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2">
          {audit.findings.map((f, i) => {
            const s = PROOF_STATE[f.state];
            return (
              <li key={f.component} className="rounded-r-md border-l-2 py-1.5 pl-3" style={{ borderColor: s.color, background: s.dim }} data-testid="audit-finding" data-state={f.state}>
                <div className="flex items-baseline gap-2">
                  <span className="text-[0.62rem] tabular-nums text-[var(--atlas-text-dim)]">{String(i + 1).padStart(2, "0")}</span>
                  <p className="min-w-0 flex-1 text-[0.82rem] font-medium leading-tight">{f.label}</p>
                  <span className="shrink-0 text-[0.58rem] font-semibold uppercase tracking-[0.05em]" style={{ color: s.color }}>{s.label}</span>
                </div>
                <p className="mt-1 text-[0.74rem] leading-snug text-[var(--atlas-text-dim)]">{f.sentence}</p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const BOUNDARY_HEADING: Record<AuditComposition["boundary"][number]["kind"], { title: string; note: string; state: ProofState }> = {
  PARTLY_ESTABLISHED: {
    title: "Partly established — what is missing",
    note: "The evidence went part of the way. Each line names the part it did not reach.",
    state: "PARTLY_ESTABLISHED",
  },
  NOT_ESTABLISHED: {
    title: "Not established",
    note: "The sources ATLAS read did not establish these. Absence of evidence is not evidence of absence.",
    state: "NOT_ESTABLISHED",
  },
  COULD_NOT_CHECK: {
    title: "Could not be checked",
    note: "Sources for these checks could not be opened. This is a limit of the research run, not a finding about the project.",
    state: "NOT_ESTABLISHED",
  },
};

function AuditBoundary({ audit }: { audit: AuditComposition }) {
  const groups = (["PARTLY_ESTABLISHED", "NOT_ESTABLISHED", "COULD_NOT_CHECK"] as const)
    .map((k) => ({ kind: k, items: audit.boundary.filter((b) => b.kind === k) }))
    .filter((g) => g.items.length > 0);
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-not-verified">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>What could not be verified</p>
      {groups.length === 0 ? (
        <p className="mt-2 text-[0.8rem] text-[var(--atlas-text-dim)]" data-testid="audit-boundary-empty">
          Every check the research made was established.
        </p>
      ) : (
        groups.map((g) => {
          const h = BOUNDARY_HEADING[g.kind];
          return (
            <div key={g.kind} className="mt-3" data-testid={`boundary-${g.kind.toLowerCase().replace(/_/g, "-")}`}>
              <p className="text-[0.72rem] font-semibold" style={{ color: PROOF_STATE[h.state].color }}>{h.title}</p>
              <p className="mt-0.5 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]">{h.note}</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {g.items.map((b) => (
                  <li key={`${g.kind}-${b.component}`} className="border-t border-[var(--hairline)] pt-1.5 text-[0.76rem] leading-snug" data-testid="boundary-item">
                    <span className="font-medium">{b.label}</span>
                    <span className="text-[var(--atlas-text-dim)]"> — {b.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

// Referenced so the audit mode renders the SAME snapshot cards the research
// mode does; the framing title is the only difference.
export { EvidenceSnapshotBlock };
