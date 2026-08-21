import type { ResearchCapability } from "../domain/types";
import type {
  ComponentDecision,
  ResearchBoundaryContract,
} from "../memory/contract";

// Phase 6, S0 — ContractView (phase-6-plan.md §3.2–3.3, §5, D-072).
//
// The frozen Phase 5 Boundary Contract is consumed here, never
// reinterpreted. Authoritative source of the work list is
// stepDecisions[].components[] (D-072) — the summary arrays
// (alreadySatisfiedSteps / requiredFreshEvidence / missingSteps) are
// projections only and MUST NOT be used to build a work queue.
//
// This module derives its own typed view of "what is in scope" purely
// from stepDecisions + mode, independently of planner.ts (§3.3): if the
// two disagree, that is a real defect, not something to patch locally.
// Reimplementing the same small formula here (rather than importing
// planner.ts's internal derivation) is intentional — a shared function
// would let planner.ts and ContractView drift together undetected.

export class ContractDerivationMismatchError extends Error {
  readonly code = "CONTRACT_DERIVATION_MISMATCH" as const;
  constructor(details: string) {
    super(`CONTRACT_DERIVATION_MISMATCH: ${details}`);
    this.name = "ContractDerivationMismatchError";
  }
}

export class ContractInvalidError extends Error {
  readonly code = "CONTRACT_INVALID" as const;
  constructor(details: string) {
    super(`CONTRACT_INVALID: ${details}`);
    this.name = "ContractInvalidError";
  }
}

const CAPABILITY_RANK: Record<ResearchCapability, number> = {
  MEMORY: 0,
  TARGETED_REFRESH: 1,
  FRESH_RESEARCH: 2,
};

// A single unit of executable work — one (step, component) pair whose
// state is NOT SATISFIED and whose step is not excluded by the capability
// ceiling. This is the ONLY shape the controller (S3) is allowed to read
// as "things to research".
export interface ComponentWorkItem {
  step: number;
  stepName: string;
  component: string;
  // SATISFIED never appears here — satisfied components are routed to
  // `reused`, never to the work queue (D-072 §5.2).
  state: Exclude<ComponentDecision["state"], "SATISFIED">;
  blockers: string[];
  memoryIds: string[];
  conflictingMemoryIds: string[];
}

export interface ReusedComponent {
  step: number;
  component: string;
  memoryIds: string[];
}

export type StopConditionKind =
  | "MEMORY_SUFFICIENT"
  | "CAPABILITY_CEILING"
  | "OTHER";

export interface TypedStopCondition {
  kind: StopConditionKind;
  // Original contract string, kept for audit/logging only — never parsed
  // back into control flow (§3.3: "человекочитаемые строки... нельзя
  // парсить регулярками").
  text: string;
}

export interface ContractView {
  patternVersion: number;
  mode: ResearchCapability;
  capabilityAtStart: ResearchCapability;
  capabilityCeilingHit: boolean;
  // Authoritative work list (D-072). Empty when everything is either
  // reused or excluded by the capability ceiling.
  workQueue: ComponentWorkItem[];
  reused: ReusedComponent[];
  // Components that WOULD be work but are outside excludedScope's
  // enforcement boundary (capability ceiling) — never executed.
  excludedComponents: ComponentWorkItem[];
  stopConditions: TypedStopCondition[];
  // Passed through byte-for-byte — S0 never recomputes the budget.
  researchBudget: ResearchBoundaryContract["researchBudget"];
  noveltyState: ResearchBoundaryContract["noveltyState"];
}

export interface BuildContractViewInput {
  contract: ResearchBoundaryContract;
  // research_plans.mode — already clamped by the capability ceiling if
  // one was hit (§5.1: authoritative for the type of work and for whether
  // the ceiling was hit).
  mode: ResearchCapability;
  // research_jobs.capability_at_start — frozen entitlement snapshot (D-050).
  capabilityAtStart: ResearchCapability;
  // Optional: the version of the currently ACTIVE Pattern, when the
  // caller has already loaded it. When provided, a mismatch with
  // contract.patternVersion is a hard, explicit failure (§5.1, §13:
  // errorCode=CONTRACT_INVALID) rather than something ContractView
  // silently tolerates.
  activePatternVersion?: number;
}

// Deterministic, pure — no DB, no model, no I/O (§19 S0: "первые четыре
// не ходят в сеть и не вызывают модель вовсе").
export function buildContractView(input: BuildContractViewInput): ContractView {
  const { contract, mode, capabilityAtStart, activePatternVersion } = input;

  if (
    activePatternVersion !== undefined &&
    contract.patternVersion !== activePatternVersion
  ) {
    throw new ContractInvalidError(
      `contract.patternVersion=${contract.patternVersion} does not match active Pattern version=${activePatternVersion}`,
    );
  }

  // Independent re-derivation of the desired mode from the authoritative
  // stepDecisions (same formula planner.ts uses, D-058) — deliberately
  // NOT imported from planner.ts, see module comment.
  const missingSteps = contract.stepDecisions.filter(
    (d) => d.decision === "MISSING",
  );
  const requiredFreshSteps = contract.stepDecisions.filter(
    (d) => d.decision === "REQUIRED_FRESH",
  );
  const desiredMode: ResearchCapability =
    missingSteps.length > 0
      ? "FRESH_RESEARCH"
      : requiredFreshSteps.length > 0
        ? "TARGETED_REFRESH"
        : "MEMORY";
  const capabilityCeilingHit =
    CAPABILITY_RANK[desiredMode] > CAPABILITY_RANK[capabilityAtStart];

  // Structural cross-check against excludedScope — count-based, not a
  // regex over the human-readable strings (§3.3). Planner fills exactly
  // one excludedScope entry per not-yet-closed step when the ceiling is
  // hit, and none otherwise; any other shape means the contract and this
  // independent derivation disagree.
  const expectedExcludedCount = capabilityCeilingHit
    ? missingSteps.length + requiredFreshSteps.length
    : 0;
  if (contract.excludedScope.length !== expectedExcludedCount) {
    throw new ContractDerivationMismatchError(
      `excludedScope has ${contract.excludedScope.length} entries, independently derived scope implies ${expectedExcludedCount} ` +
        `(capabilityCeilingHit=${capabilityCeilingHit}, desiredMode=${desiredMode}, capabilityAtStart=${capabilityAtStart})`,
    );
  }

  const expectedMode = capabilityCeilingHit ? capabilityAtStart : desiredMode;
  if (mode !== expectedMode) {
    throw new ContractDerivationMismatchError(
      `research_plans.mode=${mode} disagrees with independently derived mode=${expectedMode}`,
    );
  }

  const workQueue: ComponentWorkItem[] = [];
  const excludedComponents: ComponentWorkItem[] = [];
  const reused: ReusedComponent[] = [];

  for (const step of contract.stepDecisions) {
    // A step is excluded from execution ONLY by the capability ceiling,
    // and only when it isn't already fully closed — this mirrors exactly
    // what planner.ts excludes (D-058), never more, never less.
    const stepExcludedByCeiling =
      capabilityCeilingHit && step.decision !== "ALREADY_SATISFIED";

    for (const c of step.components) {
      if (c.state === "SATISFIED") {
        // Reused, never re-researched — true even inside a REQUIRED_FRESH
        // step (D-072: partially fresh steps keep their satisfied
        // components skipped). This is trusted from component state, not
        // from the step-level decision label, so a step tagged
        // REQUIRED_FRESH cannot "widen" work back onto a component the
        // planner already closed.
        reused.push({
          step: step.step,
          component: c.component,
          memoryIds: c.memoryIds,
        });
        continue;
      }
      const item: ComponentWorkItem = {
        step: step.step,
        stepName: step.stepName,
        component: c.component,
        state: c.state,
        blockers: c.blockers,
        memoryIds: c.memoryIds,
        conflictingMemoryIds: c.conflictingMemoryIds,
      };
      if (stepExcludedByCeiling) {
        excludedComponents.push(item);
      } else {
        workQueue.push(item);
      }
    }
  }

  const stopConditions: TypedStopCondition[] = contract.stopConditions.map(
    (text) => ({
      kind: classifyStopCondition(text),
      text,
    }),
  );

  return {
    patternVersion: contract.patternVersion,
    mode,
    capabilityAtStart,
    capabilityCeilingHit,
    workQueue,
    reused,
    excludedComponents,
    stopConditions,
    researchBudget: contract.researchBudget,
    noveltyState: contract.noveltyState,
  };
}

function classifyStopCondition(text: string): StopConditionKind {
  if (text.includes("capability ceiling")) return "CAPABILITY_CEILING";
  if (text.includes("sufficient verified memory")) return "MEMORY_SUFFICIENT";
  return "OTHER";
}
