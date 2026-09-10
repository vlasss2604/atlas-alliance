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
  resultBriefing,
  unresolvedFrom,
  type LadderComponentInput,
  type OutcomeKind,
  type RealityState,
  type ResultRow,
  type UnresolvedItem,
} from "./research-model";

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

// ONE ROW OF THE CHECK TABLE: the claim ATLAS set out to test, what the
// admitted evidence established about it, the state, and how many sources
// stand behind it. The claim label is the ladder's own sentence for the
// component, so no project claim is ever manufactured from prose.
export interface AuditCheck {
  component: string;
  check: string;
  established: string;
  state: ProofState;
  reasonCodes: readonly string[];
  blocked: boolean;
  sources: number;
}

export interface AuditBoundaryItem {
  component: string;
  label: string;
  detail: string;
  reasonCodes: readonly string[];
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
  // ONE SENTENCE, AND NOT ONE OF OURS. The lead sentence of the research
  // screen's own short answer — a contradiction if there is one, else what
  // stood, else what partly stood, else what did not — so the audit's
  // summary is the result's summary, not a second phrasing of it. Null
  // only when that derivation has nothing to say.
  summary: string | null;
  coverage: { step: number; component: string; state: ProofState }[];
  checks: AuditCheck[];
  // THE THREE DECISION-RELEVANT CHECKS, for the top of the page. The full
  // set is `checks`, shown ONLY in the deep audit; repeating all of them
  // was the noise V2 removed. Order: a contradiction
  // first, then partly established with a stated reason, then not
  // established with a stated reason, then what stood — ladder order
  // within each — and a blocked check last, because it is a fact about the
  // run. Capped, not scored.
  highlights: AuditCheck[];
  boundary: AuditBoundaryItem[];
  // WHERE THE AUDIT STOPS: the single most important open boundary, chosen
  // by the priority the short answer already uses for its "main
  // limitation" — a BLOCKED check first (ATLAS could not look, which bears
  // on everything else), else the first check the sources did not
  // establish, else the first partly-established check with a stated
  // reason. Ladder order within each. Null when every check stood.
  gap: AuditBoundaryItem | null;
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
  projectName?: string | null;
  plan?: AnalyticalOutputPlanV1;
}): AuditComposition {
  const plan = args.plan ?? chooseAnalyticalBlocks(args.input);
  const ladder = deriveResultLadder(args.components);
  // Both groups, mechanism first: an audit lists every check that was made.
  const rows = [...ladder.mechanism, ...ladder.value].filter((r) => r.state !== "NOT_ASSESSED");

  const proofMap = plan.orderedBlocks.find((b) => b.type === "PROOF_MAP");
  const coverage = proofMap && proofMap.type === "PROOF_MAP" ? proofMap.spec.cells : [];
  const codes = new Map(
    args.components.map((c) => [c.component, (c.reasonCodes ?? []).filter((x): x is string => typeof x === "string")]),
  );

  const boundary = auditBoundary(rows, args.outcomeKind, codes);
  const checks = auditChecks(rows, codes);
  const briefing = resultBriefing({
    verdict: args.input.verdict,
    outcomeKind: args.outcomeKind,
    projectName: args.projectName ?? null,
    components: args.components.map((c) => ({ component: c.component, status: c.status })),
    rows,
  });

  return {
    question: args.input.question.text,
    verdict: args.input.verdict,
    confidenceBand: args.input.confidenceBand,
    summary: briefing.shortAnswer[0] ?? null,
    coverage,
    checks,
    highlights: auditHighlights(checks),
    boundary,
    gap: auditGap(rows, boundary),
    analytical: plan.orderedBlocks.filter((b) => ANALYTICAL.has(b.type)),
    evidence: (plan.orderedBlocks.find((b) => b.type === "EVIDENCE_SNAPSHOT") as AuditComposition["evidence"]) ?? null,
    deep: (plan.orderedBlocks.find((b) => b.type === "DEEP_PROOF") as AuditComposition["deep"]) ?? null,
    plan,
  };
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
export function auditChecks(
  rows: readonly ResultRow[],
  codes: ReadonlyMap<string, readonly string[]> = new Map(),
): AuditCheck[] {
  return rows.flatMap((r) => {
    const state = proofStateOfRung(r.state);
    if (state === null) return [];
    const blocked = r.coverage === "BLOCKED";
    return [
      {
        component: r.component,
        check: r.label,
        established: blocked
          ? (r.limitation ?? "Sources for this check could not be opened.")
          : (r.shows ?? r.reason ?? "—"),
        state,
        reasonCodes: codes.get(r.component) ?? [],
        blocked,
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
export function auditBoundary(
  rows: readonly ResultRow[],
  outcomeKind: OutcomeKind,
  codes: ReadonlyMap<string, readonly string[]> = new Map(),
): AuditBoundaryItem[] {
  const unresolved: AuditBoundaryItem[] = unresolvedFrom(rows, outcomeKind).map((u: UnresolvedItem) => ({
    component: u.component,
    label: u.label,
    detail: u.detail,
    reasonCodes: codes.get(u.component) ?? [],
    kind: u.blocked ? "COULD_NOT_CHECK" : "NOT_ESTABLISHED",
  }));
  const partial: AuditBoundaryItem[] = rows
    .filter((r) => r.state === "PARTIAL" && r.reason !== null)
    .map((r) => ({
      component: r.component,
      label: r.label,
      detail: r.reason!,
      reasonCodes: codes.get(r.component) ?? [],
      kind: "PARTLY_ESTABLISHED",
    }));
  // Partial checks first — they are the sharper boundaries — then the
  // unestablished ones, then what could not be checked at all, each group
  // in ladder order.
  return [
    ...partial,
    ...unresolved.filter((u) => u.kind === "NOT_ESTABLISHED"),
    ...unresolved.filter((u) => u.kind === "COULD_NOT_CHECK"),
  ];
}

// THE ONE BOUNDARY THAT MATTERS MOST — by the priority the short answer
// already applies to its "main limitation": a blocked check outranks an
// unestablished one, because ATLAS could not look and that bears on how
// much the rest covers; an unestablished check outranks a partly
// established one. Ladder order decides within a kind. Nothing is scored.
export function auditGap(rows: readonly ResultRow[], boundary: readonly AuditBoundaryItem[]): AuditBoundaryItem | null {
  const byComponent = new Map(boundary.map((b) => [b.component, b]));
  const first = (pred: (r: ResultRow) => boolean) => {
    const r = rows.find(pred);
    return r ? (byComponent.get(r.component) ?? null) : null;
  };
  return (
    first((r) => r.coverage === "BLOCKED") ??
    first((r) => r.state === "UNRESOLVED") ??
    first((r) => r.state === "PARTIAL" && r.reason !== null)
  );
}

// THREE, NOT FIVE. The top of an audit is the three checks most useful for
// understanding it quickly; the complete list, with sources, is the deep
// audit and lives nowhere else. Same priority, shorter cut.
export const MAX_AUDIT_HIGHLIGHTS = 3;

export function auditHighlights(checks: readonly AuditCheck[], cap = MAX_AUDIT_HIGHLIGHTS): AuditCheck[] {
  const stated = (c: AuditCheck) => c.reasonCodes.some((code) => typeof code === "string" && code.length > 0);
  const groups: AuditCheck[][] = [
    checks.filter((c) => !c.blocked && c.state === "CONTRADICTED"),
    checks.filter((c) => !c.blocked && c.state === "PARTLY_ESTABLISHED" && stated(c)),
    checks.filter((c) => !c.blocked && c.state === "NOT_ESTABLISHED" && stated(c)),
    checks.filter((c) => !c.blocked && c.state === "ESTABLISHED"),
    checks.filter((c) => c.blocked),
  ];
  return groups.flat().slice(0, cap);
}
