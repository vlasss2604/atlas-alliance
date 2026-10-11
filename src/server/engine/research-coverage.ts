import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts, researchComponentResults, researchJobs, researchTraceEvents } from "../db/schema";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { loadJobContractView } from "./job-contract-view";
import type { EvidenceSourceClass } from "./providers/types";
import { TECHNICAL_COMPONENT_CODES, technicalCodeForAttemptHead } from "./research-boundary";
import { deriveSourceType, resolveSourceClass, resolveSourceRoute } from "./source-authority";
import { auditRemainingKnownPaths } from "./targeted-recovery";

// RESEARCH COVERAGE (Research Quality V1, D-176).
//
// ENGINE FAILURE / INCOMPLETE COVERAGE MUST NOT BECOME A CLAIM ABOUT
// REALITY. A component that ends INSUFFICIENT_EVIDENCE has done so for one
// of two very different reasons, and the record used to keep them apart
// only at the level of the Proof's boundary (research-boundary.ts:
// TECHNICAL / SUBSTANTIVE codes). What a reader of a finished Research
// needs is the question asked per component and once for the whole job:
// WAS THIS ADEQUATELY RESEARCHED? — and the answer is a statement about the
// research, never about the project.
//
// This module derives that answer deterministically from persisted rows
// only — the S5 result, the attempt history, the trace of what was
// actually read for the component, the known paths the bounded recovery
// left open, and the job's terminal state. It persists nothing, calls no
// provider and changes no verdict, confidence, status or reason code: the
// coverage of a component is orthogonal to its evidence verdict.
//
// The per-component classes:
//
//   COMPLETE_WITH_RESULT         the component has an evidence verdict that
//                                says something — SUPPORTED, PARTIALLY_
//                                SUPPORTED or CONTRADICTED.
//   CHECKED_AND_NOT_ESTABLISHED  an admissible source class was actually
//                                read for this component, no known
//                                admissible path remains, nothing failed —
//                                and the evidence did not establish it.
//                                "We looked, and could not establish it."
//   INCOMPLETE_COVERAGE          the component was attempted, but what it
//                                would need was not all inspected: a known
//                                admissible path remains (the recovery bound
//                                or the search axis cut it), the attempt is
//                                not terminal, or NO source of an admissible
//                                class was ever read for it (every page it
//                                saw was of a class that cannot establish
//                                it). "The research limit was reached before
//                                every relevant path was exhausted."
//   BLOCKED                      the component's attempt ended on an
//                                operational or configuration stop before
//                                any admissible source was read: a provider
//                                failure, an unreachable required class
//                                (NO_ADMISSIBLE_ROUTE), an extraction that
//                                never completed.
//   NOT_REACHED                  the component was in the work queue and the
//                                job never made an attempt for it.
//   NOT_APPLICABLE               the component was not in this job's work
//                                queue (excluded by the contract) and has no
//                                result.
//
// The whole-job projection answers "can this verdict be read as a normal
// completed Proof?": COMPLETE when every finding below is absent,
// COVERAGE_LIMITED otherwise. A Research may carry a persisted Proof and
// still be COVERAGE_LIMITED; the two are different statements.

export const RESEARCH_COVERAGE_VERSION = 1 as const;

export type ComponentCoverage =
  | "COMPLETE_WITH_RESULT"
  | "CHECKED_AND_NOT_ESTABLISHED"
  | "INCOMPLETE_COVERAGE"
  | "BLOCKED"
  | "NOT_REACHED"
  | "NOT_APPLICABLE";

// Closed. Every reason names a persisted fact; none is a judgment.
export type CoverageReason =
  | "RESULT_SUPPORTED"
  | "RESULT_PARTIALLY_SUPPORTED"
  | "RESULT_CONTRADICTED"
  | "EXCLUDED_FROM_QUEUE"
  | "NO_ATTEMPT"
  | "ATTEMPT_NOT_TERMINAL"
  | "NO_ADMISSIBLE_ROUTE"
  | "SOURCE_UNAVAILABLE"
  | "SEARCH_UNAVAILABLE"
  | "EXTRACTION_NOT_COMPLETED"
  | "NO_QUERIES_PROPOSED"
  | "SEARCH_BUDGET_EXHAUSTED"
  | "RECOVERY_BOUND_REACHED"
  | "KNOWN_PATHS_UNEXPLORED"
  | "ADMISSIBLE_CLASS_NEVER_INSPECTED"
  | "ADMISSIBLE_CLASS_INSPECTED";

// Operational and configuration stops — the attempt ended before the
// component's admissible material was inspected. Read from the same closed
// technical vocabulary the boundary record uses.
const BLOCKING_CODES: ReadonlySet<string> = new Set([
  "NO_ADMISSIBLE_ROUTE",
  "SOURCE_UNAVAILABLE",
  "SEARCH_UNAVAILABLE",
  "EXTRACTION_NOT_COMPLETED",
  "NO_QUERIES_PROPOSED",
]);
const INFRASTRUCTURE_CODES: ReadonlySet<string> = new Set(["SOURCE_UNAVAILABLE", "SEARCH_UNAVAILABLE", "EXTRACTION_NOT_COMPLETED", "NO_QUERIES_PROPOSED"]);

export interface ComponentCoverageInput {
  step: number;
  component: string;
  inWorkQueue: boolean;
  establishingClasses: readonly EvidenceSourceClass[];
  // The intent's declared critical proof path (Pattern data). Read HERE —
  // a coverage statement is about what the Research tried, which is
  // exactly what a critical declaration describes. S7 still never reads it.
  critical: boolean;
  result: { status: string; reasonCodes: readonly string[] } | null;
  attempts: readonly { attemptNumber: number; status: string; reason: string | null }[];
  // Source classes of the documents and chain reads actually inspected
  // for this component (from the trace, not from evidence rows — a page
  // that yielded no fact was still read).
  inspectedClasses: readonly EvidenceSourceClass[];
  remainingPaths: readonly { kind: string; count: number }[];
  recoverySpent: boolean;
}

export interface ComponentCoverageRecord {
  step: number;
  component: string;
  critical: boolean;
  coverage: ComponentCoverage;
  reasons: CoverageReason[];
  inspectedClasses: EvidenceSourceClass[];
  establishingClasses: EvidenceSourceClass[];
}

export type CoverageFindingCode =
  | "CRITICAL_COMPONENT_NOT_REACHED"
  | "CRITICAL_COMPONENT_BLOCKED"
  | "CRITICAL_COMPONENT_INCOMPLETE"
  | "REQUIRED_CLASS_NEVER_CHECKED"
  | "KNOWN_PATHS_UNREAD"
  | "INFRASTRUCTURE_STOP"
  | "EXECUTION_NOT_COVERED"
  | "GOVERNANCE_NOT_COVERED"
  | "JOB_TERMINATED_EARLY";

export interface CoverageFinding {
  code: CoverageFindingCode;
  components: string[];
}

export interface ResearchCoverageRecord {
  version: typeof RESEARCH_COVERAGE_VERSION;
  intent: string;
  jobState: string;
  terminationReason: string | null;
  components: ComponentCoverageRecord[];
  findings: CoverageFinding[];
  // COMPLETE: the verdict may be read as a normal completed Proof.
  // COVERAGE_LIMITED: the verdict stands as evaluated, but the Research
  // did not inspect everything it would have needed to; the findings say
  // what. Never a truth verdict.
  overall: "COMPLETE" | "COVERAGE_LIMITED";
}

export interface ResearchCoverageInput {
  intent: string;
  jobState: string;
  terminationReason: string | null;
  components: readonly ComponentCoverageInput[];
}

const RESULT_REASON: Record<string, CoverageReason> = {
  SUPPORTED: "RESULT_SUPPORTED",
  PARTIALLY_SUPPORTED: "RESULT_PARTIALLY_SUPPORTED",
  CONTRADICTED: "RESULT_CONTRADICTED",
};

function attemptHead(reason: string | null): string | null {
  if (!reason) return null;
  const head = reason.split(";")[0].trim();
  return head.length > 0 ? head : null;
}

// Was this component ADEQUATELY RESEARCHED — i.e. may its evidence verdict
// be read without a coverage caveat? True for a result and for a thorough
// miss; false for everything the research did not finish.
export function isAdequatelyResearched(coverage: ComponentCoverage): boolean {
  return coverage === "COMPLETE_WITH_RESULT" || coverage === "CHECKED_AND_NOT_ESTABLISHED";
}

export function classifyComponentCoverage(input: ComponentCoverageInput): ComponentCoverageRecord {
  const base = {
    step: input.step,
    component: input.component,
    critical: input.critical,
    inspectedClasses: [...new Set(input.inspectedClasses)].sort() as EvidenceSourceClass[],
    establishingClasses: [...input.establishingClasses],
  };
  const reasons = new Set<CoverageReason>();

  // 1. A verdict that says something is a result, however it was reached
  //    (fresh research or adopted memory). Remaining paths stay visible
  //    beside it as reasons — a result with a limit is still a result.
  const status = input.result?.status ?? null;
  if (status && RESULT_REASON[status]) {
    reasons.add(RESULT_REASON[status]);
    for (const p of input.remainingPaths) if (p.count > 0) reasons.add(input.recoverySpent ? "RECOVERY_BOUND_REACHED" : "KNOWN_PATHS_UNEXPLORED");
    return { ...base, coverage: "COMPLETE_WITH_RESULT", reasons: [...reasons].sort() };
  }

  // 2. Not this job's work, and nothing to show for it.
  if (!input.inWorkQueue && input.attempts.length === 0) {
    return { ...base, coverage: "NOT_APPLICABLE", reasons: ["EXCLUDED_FROM_QUEUE"] };
  }

  // 3. In the queue, never attempted: the job stopped before its turn.
  if (input.attempts.length === 0) {
    return { ...base, coverage: "NOT_REACHED", reasons: ["NO_ATTEMPT"] };
  }

  const latest = [...input.attempts].sort((a, b) => a.attemptNumber - b.attemptNumber)[input.attempts.length - 1];
  // 4. Still running, or abandoned mid-attempt: not finished either way.
  if (latest.status === "STARTED") {
    return { ...base, coverage: "INCOMPLETE_COVERAGE", reasons: ["ATTEMPT_NOT_TERMINAL"] };
  }

  const admissibleInspected = input.establishingClasses.some((c) => input.inspectedClasses.includes(c));

  // 5. Technical stops, from the attempt head and from S5's own codes.
  const technical = new Set<string>();
  const head = attemptHead(latest.reason);
  if (head && (latest.status === "SKIPPED" || latest.status === "FAILED")) {
    const mapped = technicalCodeForAttemptHead(head);
    if (mapped) technical.add(mapped);
  }
  for (const code of input.result?.reasonCodes ?? []) if (TECHNICAL_COMPONENT_CODES.has(code)) technical.add(code);
  const blocking = [...technical].filter((c) => BLOCKING_CODES.has(c)) as CoverageReason[];
  if (blocking.length > 0 && !admissibleInspected) {
    return { ...base, coverage: "BLOCKED", reasons: blocking.sort() };
  }

  // 6. Known admissible paths left open, or a spent search axis, or a
  //    technical stop after something admissible WAS read: not finished.
  for (const p of input.remainingPaths) if (p.count > 0) reasons.add(input.recoverySpent ? "RECOVERY_BOUND_REACHED" : "KNOWN_PATHS_UNEXPLORED");
  if (technical.has("SEARCH_BUDGET_EXHAUSTED")) reasons.add("SEARCH_BUDGET_EXHAUSTED");
  for (const c of blocking) reasons.add(c);
  if (reasons.size > 0) {
    return { ...base, coverage: "INCOMPLETE_COVERAGE", reasons: [...reasons].sort() };
  }

  // 7. Every source it saw was of a class that cannot establish it: the
  //    question was never put to an admissible source.
  if (input.establishingClasses.length > 0 && !admissibleInspected) {
    return { ...base, coverage: "INCOMPLETE_COVERAGE", reasons: ["ADMISSIBLE_CLASS_NEVER_INSPECTED"] };
  }

  // 8. Looked, in the right places, and could not establish it.
  return { ...base, coverage: "CHECKED_AND_NOT_ESTABLISHED", reasons: ["ADMISSIBLE_CLASS_INSPECTED"] };
}

const EARLY_TERMINAL_STATES: ReadonlySet<string> = new Set(["BUDGET_LIMIT_REACHED", "FAILED", "CANCELLED"]);

export function deriveResearchCoverage(input: ResearchCoverageInput): ResearchCoverageRecord {
  const components = [...input.components]
    .sort((a, b) => a.step - b.step || a.component.localeCompare(b.component))
    .map(classifyComponentCoverage);
  const findings: CoverageFinding[] = [];
  const add = (code: CoverageFindingCode, names: string[]) => {
    if (names.length > 0) findings.push({ code, components: [...new Set(names)].sort() });
  };
  const critical = components.filter((c) => c.critical);
  add("CRITICAL_COMPONENT_NOT_REACHED", critical.filter((c) => c.coverage === "NOT_REACHED").map((c) => c.component));
  add("CRITICAL_COMPONENT_BLOCKED", critical.filter((c) => c.coverage === "BLOCKED").map((c) => c.component));
  add("CRITICAL_COMPONENT_INCOMPLETE", critical.filter((c) => c.coverage === "INCOMPLETE_COVERAGE").map((c) => c.component));
  add(
    "REQUIRED_CLASS_NEVER_CHECKED",
    critical
      .filter((c) => c.coverage !== "COMPLETE_WITH_RESULT" && c.establishingClasses.length > 0 && !c.establishingClasses.some((k) => c.inspectedClasses.includes(k)))
      .map((c) => c.component),
  );
  add(
    "KNOWN_PATHS_UNREAD",
    components.filter((c) => c.reasons.includes("RECOVERY_BOUND_REACHED") || c.reasons.includes("KNOWN_PATHS_UNEXPLORED")).map((c) => c.component),
  );
  add("INFRASTRUCTURE_STOP", components.filter((c) => c.coverage === "BLOCKED" && c.reasons.some((r) => INFRASTRUCTURE_CODES.has(r))).map((c) => c.component));
  const notCovered = (name: string) => components.filter((c) => c.component === name && c.critical && !isAdequatelyResearched(c.coverage)).map((c) => c.component);
  add("EXECUTION_NOT_COVERED", notCovered("EXECUTION_EVIDENCE"));
  add("GOVERNANCE_NOT_COVERED", notCovered("GOVERNANCE_BASIS"));
  if (EARLY_TERMINAL_STATES.has(input.jobState) || input.terminationReason === "BUDGET_EXHAUSTED") {
    findings.push({ code: "JOB_TERMINATED_EARLY", components: [] });
  }
  return {
    version: RESEARCH_COVERAGE_VERSION,
    intent: input.intent,
    jobState: input.jobState,
    terminationReason: input.terminationReason,
    components,
    findings,
    overall: findings.length === 0 ? "COMPLETE" : "COVERAGE_LIMITED",
  };
}

const ONCHAIN_REF_PREFIX = "atlas-onchain://";

// THE LOADER — persisted rows in, record out. Read-only; no provider, no
// spend, no write. Safe to call on a RUNNING job (it then reports what has
// been covered so far) and on a finished one.
export async function loadResearchCoverage(db: Database | Transaction, jobId: string): Promise<ResearchCoverageRecord> {
  const [job] = await db
    .select({ state: researchJobs.state, terminationReason: researchJobs.terminationReason, projectId: researchJobs.projectId })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  const projectId = job.projectId ?? null;

  const { view } = await loadJobContractView(db, jobId);
  const queued = new Map(view.workQueue.map((c) => [`${c.step}:${c.component}`, c]));
  const excluded = new Map(view.excludedComponents.map((c) => [`${c.step}:${c.component}`, c]));

  const results = await db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const attempts = await db
    .select()
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, jobId))
    .orderBy(asc(researchAttempts.attemptNumber));
  const trace = await db
    .select({ operationType: researchTraceEvents.operationType, component: researchTraceEvents.component, targetRef: researchTraceEvents.targetRef })
    .from(researchTraceEvents)
    .where(and(eq(researchTraceEvents.researchJobId, jobId), inArray(researchTraceEvents.operationType, ["EXTRACT_ATTEMPTED", "FETCH_OK"])));
  const remaining = await auditRemainingKnownPaths(db, jobId, projectId);

  // Every component this job knows: queued, excluded, or present in S5.
  const keys = new Set<string>([...queued.keys(), ...excluded.keys(), ...results.map((r) => `${r.patternStep}:${r.component}`)]);

  // What was actually read, per component: the class of every extracted
  // document (resolved exactly as S5 would have classified it) and every
  // chain read.
  const inspected = new Map<string, Set<EvidenceSourceClass>>();
  const classCache = new Map<string, EvidenceSourceClass>();
  for (const row of trace) {
    if (!row.component || !row.targetRef) continue;
    const set = inspected.get(row.component) ?? new Set<EvidenceSourceClass>();
    if (row.operationType === "FETCH_OK") {
      if (row.targetRef.startsWith(ONCHAIN_REF_PREFIX)) set.add("ONCHAIN_VERIFIABLE");
    } else {
      let cls = classCache.get(row.targetRef);
      if (!cls) {
        const route = await resolveSourceRoute(db, projectId, row.targetRef);
        cls = resolveSourceClass(row.targetRef, deriveSourceType(row.targetRef), route.officiality === "CONFIRMED" ? route.routeClass : null);
        classCache.set(row.targetRef, cls);
      }
      set.add(cls);
    }
    inspected.set(row.component, set);
  }

  const components: ComponentCoverageInput[] = [];
  let intent = "UNKNOWN";
  for (const key of keys) {
    const [stepText, component] = key.split(":");
    const step = Number(stepText);
    const plan = await loadAcquisitionPlan(db, jobId, component, projectId);
    intent = plan.intent;
    const result = results.find((r) => r.patternStep === step && r.component === component);
    const open = remaining.find((r) => r.step === step && r.component === component);
    components.push({
      step,
      component,
      inWorkQueue: queued.has(key),
      establishingClasses: plan.establishingClasses,
      critical: plan.criticalComponents.has(component),
      result: result ? { status: result.status, reasonCodes: Array.isArray(result.reasonCodes) ? (result.reasonCodes as string[]) : [] } : null,
      attempts: attempts.filter((a) => a.patternStep === step && a.component === component).map((a) => ({ attemptNumber: a.attemptNumber, status: a.status, reason: a.reason })),
      inspectedClasses: [...(inspected.get(component) ?? [])],
      remainingPaths: open?.paths ?? [],
      recoverySpent: open?.recoverySpent ?? false,
    });
  }

  return deriveResearchCoverage({ intent, jobState: job.state, terminationReason: job.terminationReason, components });
}
