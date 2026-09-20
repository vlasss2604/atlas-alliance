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

// A PROVIDER FAILURE, as the executor actually writes it: a FAILED attempt
// whose reason head is `<LABEL>_FAILED:<ErrorClass>[:<detail>]`
// (s4-executor.ts safeFailureReason) — the sanitized class of the failure
// that ended the attempt, e.g. `CONTENT_FETCHER_FAILED:ContentFetchError:
// HTTP_ERROR:404`. A provider that refused or never answered has said
// nothing about the project (CORE_RULES: technical failure ≠ project
// reality), so these heads are technical, keyed by the label alone: the
// error class and detail vary, the boundary does not.
export const TECHNICAL_PROVIDER_FAILURE_LABELS: Readonly<Record<string, string>> = {
  CONTENT_FETCHER: "SOURCE_UNAVAILABLE",
  SEARCH_GATEWAY: "SEARCH_UNAVAILABLE",
  QUERY_PROPOSER: "NO_QUERIES_PROPOSED",
  EVIDENCE_EXTRACTOR: "EXTRACTION_NOT_COMPLETED",
};

// The technical boundary code for an attempt reason head, or null when the
// head is not a technical stop.
export function technicalCodeForAttemptHead(head: string): string | null {
  const mapped = TECHNICAL_ATTEMPT_REASONS[head];
  if (mapped) return mapped;
  const m = /^([A-Z_]+)_FAILED(?::|$)/.exec(head);
  if (m) return TECHNICAL_PROVIDER_FAILURE_LABELS[m[1]] ?? null;
  return null;
}

// KNOWN PATHS STILL OPEN WHEN THE RESEARCH STOPPED (Research Reliability
// V1 final acceptance). A critical component can end INSUFFICIENT_EVIDENCE
// with a known, admissible acquisition path the bounded Research never
// consumed — a sealed document it never extracted for this component, a
// candidate it never opened, a confirmed route it never searched. That is
// a limit of the run, not a finding about the project, and it is
// invisible to S5 (the reducer sees only what was read) and to the
// attempt reason (a recovery that read its three documents and found
// nothing closes NO_TRACEABLE_FACTS_FOR_COMPONENT). Read after the fact
// from the same persisted state the targeted second pass plans from
// (targeted-recovery.ts, audit mode), it is recorded here as a TECHNICAL
// boundary, with the paths that remained, so a reader can say "the
// research limit was reached before every relevant path was exhausted"
// and never "checked and not established":
//
//   RECOVERY_BOUND_REACHED  the one bounded recovery ran (its opens /
//                           extractions / searches are spent) and known
//                           admissible paths remain;
//   KNOWN_PATHS_UNEXPLORED  known admissible paths remain and no recovery
//                           ever ran for the component (the job stopped
//                           before its second pass).
//
// Neither changes a verdict or a confidence. Absence of either code means
// no known admissible path was left: what stands on the substantive side
// is then "looked, and could not establish it".
export const RECOVERY_BOUND_REACHED = "RECOVERY_BOUND_REACHED";
export const KNOWN_PATHS_UNEXPLORED = "KNOWN_PATHS_UNEXPLORED";

export interface RemainingPath {
  kind: string;
  count: number;
}

export interface BoundaryEntry {
  step: number;
  component: string;
  codes: string[];
  // Present only beside RECOVERY_BOUND_REACHED / KNOWN_PATHS_UNEXPLORED:
  // the known admissible paths still open, by kind.
  remainingPaths?: RemainingPath[];
}

export interface BoundaryRemainingPathsInput {
  step: number;
  component: string;
  // True when the component already had its one recovery attempt.
  recoverySpent: boolean;
  paths: readonly RemainingPath[];
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
  remainingPaths?: readonly BoundaryRemainingPathsInput[];
}): ResearchBoundary {
  const latestAttempt = new Map<string, BoundaryAttemptInput>();
  for (const a of input.attempts ?? []) {
    // Callers pass the latest attempt per component; if several are passed
    // the last one wins, which is the caller's ordering responsibility.
    latestAttempt.set(`${a.step}:${a.component}`, a);
  }
  const remaining = new Map<string, BoundaryRemainingPathsInput>();
  for (const r of input.remainingPaths ?? []) {
    if (r.paths.some((p) => p.count > 0)) remaining.set(`${r.step}:${r.component}`, r);
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
      const mapped = technicalCodeForAttemptHead(head);
      if (mapped) tech.add(mapped);
    }
    // Known admissible paths still open: the limit of the run, technical
    // by construction (see the codes' doc above).
    const open = remaining.get(`${row.step}:${row.component}`);
    if (open) tech.add(open.recoverySpent ? RECOVERY_BOUND_REACHED : KNOWN_PATHS_UNEXPLORED);
    // A component that stopped for a technical reason and has no other
    // code is technical only: NO_EVIDENCE_FOUND written beside a boundary
    // code is the reducer's zero-evidence default, not a second finding.
    if (tech.size > 0) subst.delete("NO_EVIDENCE_FOUND");
    if (tech.size > 0) {
      technical.push({
        step: row.step,
        component: row.component,
        codes: [...tech].sort(),
        ...(open ? { remainingPaths: open.paths.filter((p) => p.count > 0).map((p) => ({ kind: p.kind, count: p.count })) } : {}),
      });
    }
    if (subst.size > 0) substantive.push({ step: row.step, component: row.component, codes: [...subst].sort() });
    if (tech.size === 0 && subst.size === 0) {
      // Not established with no persisted reason at all: substantive by
      // the conservative rule, named as such.
      substantive.push({ step: row.step, component: row.component, codes: ["NO_EVIDENCE_FOUND"] });
    }
  }
  return { version: RESEARCH_BOUNDARY_VERSION, technical, substantive };
}
