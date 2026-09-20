// RESEARCH BOUNDARY RECORD (Research Reliability V1, A2).
//
// A finished Research that did not establish something has ONE of two
// kinds of reason for each such component, and the Proof must keep them
// apart:
//
//   TECHNICAL    the bounded Research never actually inspected the
//                admissible material — the search axis was spent before
//                the component's turn, no confirmed route existed for the
//                only classes that could establish it, its documents were
//                opened but could not be read through, or a provider
//                failed. Says nothing about the project.
//   SUBSTANTIVE  the admissible material WAS attempted and the evidence
//                stayed insufficient, partial, unauthoritative or
//                contradicted. A finding about the record.
//
// This module derives that split from the codes S5 already persisted on
// each component result and from the executor's own terminal attempt
// reasons — nothing is inferred, nothing new is judged, and the split can
// never change a verdict or a confidence: it is a label on WHY the record
// stops where it stops. A Proof carries it as an additive, nullable field
// (`proofs.bounded_by`, migration 0055).
//
// The technical vocabulary is CLOSED and code-owned. A code this module
// does not name is substantive by construction — the conservative
// direction, because calling a substantive gap "technical" would invite a
// reader to discount a real finding.

export const RESEARCH_BOUNDARY_VERSION = 1 as const;

// S5 reason codes that mean "acquisition stopped before inspection"
// (component-reconciler.ts: AcquisitionBoundary), verbatim.
export const TECHNICAL_COMPONENT_CODES: ReadonlySet<string> = new Set([
  "SEARCH_BUDGET_EXHAUSTED",
  "NO_ADMISSIBLE_ROUTE",
  "EXTRACTION_NOT_COMPLETED",
]);

// Executor terminal attempt reasons (the head of `research_attempts.reason`)
// that are technical, with the boundary code the record carries for each.
// Only reasons the executor actually writes (s4-executor.ts
// closeDocumentaryPass callers) are listed; anything else is not a
// technical boundary.
export const TECHNICAL_ATTEMPT_REASONS: Readonly<Record<string, string>> = {
  SEARCH_BUDGET_EXHAUSTED: "SEARCH_BUDGET_EXHAUSTED",
  NO_ADMISSIBLE_ROUTE: "NO_ADMISSIBLE_ROUTE",
  EXTRACTION_NOT_COMPLETED: "EXTRACTION_NOT_COMPLETED",
  EVIDENCE_EXTRACTOR_UNAVAILABLE: "EXTRACTION_NOT_COMPLETED",
  NO_SOURCE_COULD_BE_FETCHED: "SOURCE_UNAVAILABLE",
  NO_QUERIES_PROPOSED: "NO_QUERIES_PROPOSED",
};

export interface BoundaryEntry {
  step: number;
  component: string;
  codes: string[];
}

export interface ResearchBoundary {
  version: typeof RESEARCH_BOUNDARY_VERSION;
  technical: BoundaryEntry[];
  substantive: BoundaryEntry[];
}

export interface BoundaryComponentInput {
  step: number;
  component: string;
  status: string;
  reasonCodes: readonly string[];
}

export interface BoundaryAttemptInput {
  step: number;
  component: string;
  status: string;
  reason: string | null;
}

function attemptHead(reason: string | null): string | null {
  if (!reason) return null;
  const head = reason.split(";")[0].trim();
  return head.length > 0 ? head : null;
}

// One entry per component, in (step, component) order, for every component
// whose status is not SUPPORTED. A component can appear on both sides when
// it carries both kinds of code — the reader then sees exactly that.
export function deriveResearchBoundary(input: {
  components: readonly BoundaryComponentInput[];
  attempts?: readonly BoundaryAttemptInput[];
}): ResearchBoundary {
  const latestAttempt = new Map<string, BoundaryAttemptInput>();
  for (const a of input.attempts ?? []) {
    // Callers pass the latest attempt per component; if several are passed
    // the last one wins, which is the caller's ordering responsibility.
    latestAttempt.set(`${a.step}:${a.component}`, a);
  }
  const technical: BoundaryEntry[] = [];
  const substantive: BoundaryEntry[] = [];
  const rows = [...input.components].sort((a, b) => a.step - b.step || a.component.localeCompare(b.component));
  for (const row of rows) {
    if (row.status === "SUPPORTED") continue;
    const tech = new Set<string>();
    const subst = new Set<string>();
    for (const code of row.reasonCodes) {
      if (TECHNICAL_COMPONENT_CODES.has(code)) tech.add(code);
      else subst.add(code);
    }
    const attempt = latestAttempt.get(`${row.step}:${row.component}`);
    const head = attempt ? attemptHead(attempt.reason) : null;
    if (attempt && head && (attempt.status === "SKIPPED" || attempt.status === "FAILED")) {
      const mapped = TECHNICAL_ATTEMPT_REASONS[head];
      if (mapped) tech.add(mapped);
    }
    // A component that stopped for a technical reason and has no other
    // code is technical only: NO_EVIDENCE_FOUND written beside a boundary
    // code is the reducer's zero-evidence default, not a second finding.
    if (tech.size > 0) subst.delete("NO_EVIDENCE_FOUND");
    if (tech.size > 0) technical.push({ step: row.step, component: row.component, codes: [...tech].sort() });
    if (subst.size > 0) substantive.push({ step: row.step, component: row.component, codes: [...subst].sort() });
    if (tech.size === 0 && subst.size === 0) {
      // Not established with no persisted reason at all: substantive by
      // the conservative rule, named as such.
      substantive.push({ step: row.step, component: row.component, codes: ["NO_EVIDENCE_FOUND"] });
    }
  }
  return { version: RESEARCH_BOUNDARY_VERSION, technical, substantive };
}
