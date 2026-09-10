// AUDIT OUTPUT V1 — A COMPOSITION MODE OVER THE EXISTING RESULT.
//
// An audit answers a different question from a research result. The result
// says WHAT IS HAPPENING; the audit says WHAT EXACTLY WAS CHECKED, WHERE IT
// DID NOT LINE UP, AND WHAT COULD NOT BE VERIFIED. Same record, same
// selector, same blocks — a different emphasis and order, and three small
// derivations the research page does not need.
//
// IT IS NOT A SECOND ENGINE, AND THE SHAPE OF THIS FILE IS HOW. Every state
// below is a persisted component status read through the SAME two functions
// the research screen already uses — `deriveResultLadder` for the rows and
// `unresolvedFrom` for the boundary — and every analytical block comes from
// the SAME plan `chooseAnalyticalBlocks` produced. There is no audit verdict
// (the Proof's verdict is relabelled), no severity (nothing upstream carries
// one), no risk score, and no sentence that is not a restatement of a stored
// row. The functions here choose, order and group; they assert nothing.
import { chooseAnalyticalBlocks, type AnalyticalOutputInputV1, type AnalyticalOutputPlanV1, type PlannedBlock } from "./output-plan";
import type { ProofState } from "./components/result-blocks/types";
import {
  deriveResultLadder,
  unresolvedFrom,
  type LadderComponentInput,
  type OutcomeKind,
  type RealityState,
  type ResultRow,
  type UnresolvedItem,
} from "./research-model";

export const MAX_AUDIT_FINDINGS = 5;

// RUNG STATE → BLOCK STATE. The ladder's own asymmetry, kept: only a
// positive contradiction is red, and "not established" is never "false".
export function proofStateOfRung(state: RealityState): ProofState | null {
  switch (state) {
    case "VERIFIED":
      return "ESTABLISHED";
    case "PARTIAL":
      return "PARTLY_ESTABLISHED";
    case "NOT_HAPPENING":
      return "CONTRADICTED";
    case "UNRESOLVED":
      return "NOT_ESTABLISHED";
    default:
      return null;
  }
}

export interface AuditFinding {
  component: string;
  label: string;
  state: ProofState;
  // The row's own sentence: what the evidence positively shows for a
  // contradiction, the persisted reason for a gap. Never composed here.
  sentence: string;
  sources: number;
}

// ONE ROW OF THE CHECK TABLE: the claim ATLAS set out to test, what the
// admitted evidence established about it, the state, and how many sources
// stand behind it. The claim label is the ladder's own sentence for the
// component, so no project claim is ever manufactured from prose.
export interface AuditCheck {
  component: string;
  check: string;
  established: string;
  state: ProofState;
  sources: number;
}

export interface AuditBoundaryItem {
  component: string;
  label: string;
  detail: string;
  // A gap in the PROJECT RECORD (the sources ATLAS read did not establish
  // it) as opposed to a gap in the RUN (the sources could not be opened).
  // The second is a limitation of the research and says nothing about the
  // project, and the two must never share a list.
  kind: "NOT_ESTABLISHED" | "PARTLY_ESTABLISHED" | "COULD_NOT_CHECK";
}

export interface AuditComposition {
  question: string;
  verdict: string | null;
  confidenceBand: string | null;
  coverage: { step: number; component: string; state: ProofState }[];
  findings: AuditFinding[];
  checks: AuditCheck[];
  boundary: AuditBoundaryItem[];
  // The selector's analytical blocks, exactly as chosen — an audit shows a
  // flow or a metric only when the research result would have.
  analytical: PlannedBlock[];
  evidence: Extract<PlannedBlock, { type: "EVIDENCE_SNAPSHOT" }> | null;
  deep: Extract<PlannedBlock, { type: "DEEP_PROOF" }> | null;
  plan: AnalyticalOutputPlanV1;
}

const ANALYTICAL: ReadonlySet<PlannedBlock["type"]> = new Set(["METRIC", "FLOW", "TABLE", "CHART", "TIMELINE"]);

export function composeAudit(args: {
  input: AnalyticalOutputInputV1;
  // The component rows WITH coverage where the payload carries it, so a
  // BLOCKED check can be told apart from an unestablished one. The
  // selector's input carries no coverage, and does not need to.
  components: readonly LadderComponentInput[];
  outcomeKind: OutcomeKind;
  plan?: AnalyticalOutputPlanV1;
}): AuditComposition {
  const plan = args.plan ?? chooseAnalyticalBlocks(args.input);
  const ladder = deriveResultLadder(args.components);
  // Both groups, mechanism first: an audit lists every check that was made.
  const rows = [...ladder.mechanism, ...ladder.value].filter((r) => r.state !== "NOT_ASSESSED");

  const proofMap = plan.orderedBlocks.find((b) => b.type === "PROOF_MAP");
  const coverage = proofMap && proofMap.type === "PROOF_MAP" ? proofMap.spec.cells : [];

  return {
    question: args.input.question.text,
    verdict: args.input.verdict,
    confidenceBand: args.input.confidenceBand,
    coverage,
    findings: auditFindings(rows),
    checks: auditChecks(rows),
    boundary: auditBoundary(rows, args.outcomeKind),
    analytical: plan.orderedBlocks.filter((b) => ANALYTICAL.has(b.type)),
    evidence: (plan.orderedBlocks.find((b) => b.type === "EVIDENCE_SNAPSHOT") as AuditComposition["evidence"]) ?? null,
    deep: (plan.orderedBlocks.find((b) => b.type === "DEEP_PROOF") as AuditComposition["deep"]) ?? null,
    plan,
  };
}

// MAIN FINDINGS — WHAT DID NOT LINE UP, IN A FIXED ORDER.
//
// A contradiction first, always: it is the one state in which the record
// positively says otherwise. Then checks the evidence only partly reached,
// then checks it did not reach — each only when a PERSISTED reason code
// explains why, because a finding with no stated reason is not a finding.
// Within a group the ladder's order stands (mechanism before value), so
// "important" is the Pattern's ordering and not a score of ours.
//
// A BLOCKED check is never a finding. The sources could not be opened; that
// is a limit of the run, it belongs in the boundary, and listing it here
// would present a fetch failure as something learned about the project.
//
// An established check is not a finding either. An audit's findings are the
// weaknesses; what stood is on the map and in the table.
export function auditFindings(rows: readonly ResultRow[]): AuditFinding[] {
  const toFinding = (r: ResultRow, sentence: string | null): AuditFinding | null => {
    const state = proofStateOfRung(r.state);
    if (state === null || sentence === null) return null;
    return { component: r.component, label: r.label, state, sentence, sources: r.admittedCount };
  };
  const contradicted = rows.filter((r) => r.state === "NOT_HAPPENING").map((r) => toFinding(r, r.shows ?? r.reason));
  const partial = rows.filter((r) => r.state === "PARTIAL").map((r) => toFinding(r, r.reason));
  const unresolved = rows
    .filter((r) => r.state === "UNRESOLVED" && r.coverage !== "BLOCKED")
    .map((r) => toFinding(r, r.reason));
  return [...contradicted, ...partial, ...unresolved]
    .filter((f): f is AuditFinding => f !== null)
    .slice(0, MAX_AUDIT_FINDINGS);
}

// CLAIM VS REALITY — EVERY CHECK, AS A TABLE ROW.
//
// The "claim" column is the ladder's own label for the component ("The
// project documents the mechanism", "Where the value is meant to go"): the
// proposition ATLAS set out to test, in the words the result screen already
// uses. The "established" column is the row's own `shows` sentence where the
// evidence reached something, and its persisted `reason` where it did not.
// Nothing is read from a fragment and no project statement is invented to
// fill the left-hand column.
export function auditChecks(rows: readonly ResultRow[]): AuditCheck[] {
  return rows.flatMap((r) => {
    const state = proofStateOfRung(r.state);
    if (state === null) return [];
    return [
      {
        component: r.component,
        check: r.label,
        established:
          r.coverage === "BLOCKED"
            ? (r.limitation ?? "Sources for this check could not be opened.")
            : (r.shows ?? r.reason ?? "—"),
        state,
        sources: r.admittedCount,
      },
    ];
  });
}

// THE AUDIT BOUNDARY — WHAT COULD NOT BE VERIFIED, AND WHY, IN THREE KINDS.
//
//   NOT_ESTABLISHED   the sources ATLAS read did not establish it
//   PARTLY_ESTABLISHED the evidence went part of the way; the reason says
//                      which part is missing
//   COULD_NOT_CHECK   the sources could not be opened — a limit of the run
//
// The unresolved items come from `unresolvedFrom`, the research screen's
// own derivation, which already knows a BLOCKED row from an unestablished
// one. Partly-established rows are added with their persisted reason,
// because "attribution not established" and "state not fully live" are the
// boundaries an audit exists to name. Nothing is inferred, and a row with
// no stated reason contributes no sentence.
export function auditBoundary(rows: readonly ResultRow[], outcomeKind: OutcomeKind): AuditBoundaryItem[] {
  const unresolved: AuditBoundaryItem[] = unresolvedFrom(rows, outcomeKind).map((u: UnresolvedItem) => ({
    component: u.component,
    label: u.label,
    detail: u.detail,
    kind: u.blocked ? "COULD_NOT_CHECK" : "NOT_ESTABLISHED",
  }));
  const partial: AuditBoundaryItem[] = rows
    .filter((r) => r.state === "PARTIAL" && r.reason !== null)
    .map((r) => ({ component: r.component, label: r.label, detail: r.reason!, kind: "PARTLY_ESTABLISHED" }));
  // Partial checks first — they are the sharper boundaries — then the
  // unestablished ones, then what could not be checked at all, each group
  // in ladder order.
  return [
    ...partial,
    ...unresolved.filter((u) => u.kind === "NOT_ESTABLISHED"),
    ...unresolved.filter((u) => u.kind === "COULD_NOT_CHECK"),
  ];
}
