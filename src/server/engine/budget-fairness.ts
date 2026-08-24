// D-130 — per-component acquisition allowance.
//
// The defect this closes: MAX_QUERIES_PER_ATTEMPT was a flat 3, and the
// controller walks the work queue in Pattern order. With the
// INTERNAL_ALPHA_V1 envelope (12 searchQueries) the first four components
// consumed 3 each and the axis was gone. Across five live runs the engine
// reached only pattern steps 1-3 every single time; steps 5-8 were never
// attempted at all. For a BURN_OR_SUPPLY_EFFECT question the ONE
// intent-required component is NET_EFFECT at step 7 — so the engine was
// structurally incapable of researching what the user actually asked,
// while spending the entire budget on earlier steps.
//
// This module answers one narrow question: "how many search units may
// THIS component's attempt spend, so that every component still pending
// — especially the ones the job's intent actually requires — keeps a
// usable share?" It never increases any ceiling; it only divides the
// existing, already-authorized envelope more honestly.
//
// Deterministic and project-independent: the inputs are the job's frozen
// ceiling, the size of its own work queue, and whether the component is
// required by the job's intent per the Pattern's own intentRequirements.
// No PUMP-specific, domain-specific or question-specific rule.

export interface ComponentAllowanceInput {
  // The job's frozen maxSearchQueries ceiling.
  maxSearchQueries: number;
  // How many search units the job has already reserved.
  alreadyReserved: number;
  // Total components in this job's work queue (pending + done).
  workQueueSize: number;
  // How many components still have no terminal attempt, INCLUDING this
  // one. Always >= 1 when an attempt is running.
  remainingComponents: number;
  // True when this component is named by a REQUIRED requirement in the
  // Pattern's intentRequirements entry for the job's normalized intent.
  isIntentRequired: boolean;
  // The historic flat cap, still the per-attempt upper bound.
  hardCapPerAttempt: number;
  // ACQUISITION MINIMUM SAFE V1 (E) — how many OTHER intent-required
  // components still have no terminal attempt. D-130's fair share already
  // reserves one unit per pending component, but it treats every pending
  // component alike: with the axis nearly gone, a non-required component
  // could still take the last unit an unresolved intent-required
  // component needed, because "1 per pending" is satisfied by units that
  // the non-required component is itself about to consume. A real run
  // ended with a non-required step 8 spending the final searches after
  // the intent-critical component had already failed.
  //
  // Optional and defaulting to 0, so every existing caller and test keeps
  // its exact current behaviour.
  intentRequiredPending?: number;
}

// Never let a component take so much that a still-pending component
// could get zero. One unit per remaining component is the floor the
// division must protect.
export function componentSearchAllowance(input: ComponentAllowanceInput): number {
  const {
    maxSearchQueries,
    alreadyReserved,
    remainingComponents,
    isIntentRequired,
    hardCapPerAttempt,
    intentRequiredPending = 0,
  } = input;

  const remainingBudget = Math.max(0, maxSearchQueries - alreadyReserved);
  if (remainingBudget <= 0) return 0;

  // Nothing left to protect: this is the only component still pending, so
  // fair-share division has no purpose and must NOT apply. This is not a
  // nicety — capping the last component to exactly the remaining budget
  // would mean the executor never attempts the one query the reservation
  // would refuse, so it would never DISCOVER that the axis is exhausted
  // and would return an ordinary FAILED result instead of throwing
  // BudgetExhaustedError. The controller could then fold that into
  // WORK_QUEUE_EXHAUSTED -> SUCCEEDED, which is precisely the fabricated
  // evidentiary completion D-120 exists to prevent. The reservation layer
  // stays the only authority on exhaustion; this allowance is a proposal
  // cap, never a ceiling.
  if (remainingComponents <= 1) return hardCapPerAttempt;

  // Reserve one unit for every OTHER component still pending, so walking
  // the queue in Pattern order can never leave a later component — which
  // may be the intent-critical one — with nothing.
  const othersPending = Math.max(0, remainingComponents - 1);
  const spendableNow = Math.max(0, remainingBudget - othersPending);

  // An intent-required component is allowed the full per-attempt cap when
  // the budget genuinely permits it; a non-required one is held to the
  // fair share so it cannot crowd out what the question actually needs.
  // Both are floored at 1 whenever any budget remains at all: a component
  // that gets zero searches produces no evidence and is indistinguishable
  // from one that was never in scope.
  const fairShare = Math.max(1, Math.floor(remainingBudget / Math.max(1, remainingComponents)));
  const desired = isIntentRequired ? hardCapPerAttempt : fairShare;

  // E — priority, not deletion. A NON-required component must leave one
  // unit standing for every still-unresolved intent-required component,
  // over and above the generic per-pending floor. It is still floored at
  // 1 (below), so no component is ever starved out of the Pattern
  // entirely; it simply cannot take the LAST unit that the question's own
  // critical component needs. An intent-required component is unaffected,
  // and no ceiling anywhere is raised.
  const priorityFloor = isIntentRequired
    ? spendableNow
    : Math.max(0, spendableNow - intentRequiredPending);

  return Math.max(0, Math.min(desired, hardCapPerAttempt, Math.max(1, priorityFloor)));
}

// Requirement kinds that name their component STRUCTURALLY rather than
// through `components[]`. These mirror claim-evaluator.ts's own
// componentResultKeys for the same kinds — e.g.
// evaluateNetEffectEstablished reports { step: 7, component: "NET_EFFECT" }
// and evaluateDurabilityEstablished reports
// { step: 8, component: "DURABILITY_BASIS" }.
//
// This mapping exists because a requirement like BURN_OR_SUPPLY_EFFECT's
// BSE-1 carries ONLY { kind: "NET_EFFECT_ESTABLISHED", optionality:
// "REQUIRED" } — no components[] array at all. Reading components[] alone
// would classify that intent as requiring NOTHING, which is exactly the
// component the whole question depends on. Kept deliberately small and
// explicit; a kind absent here contributes no component, never a guess.
const KIND_IMPLIED_COMPONENT: Record<string, string> = {
  NET_EFFECT_ESTABLISHED: "NET_EFFECT",
  DURABILITY_ESTABLISHED: "DURABILITY_BASIS",
  LIFECYCLE: "CURRENT_STATE",
};

// Extracts the component names a job's intent REQUIRES, from the
// Pattern's own intentRequirements entry. The Pattern is the authority;
// this only reads it, across all three ways a requirement can name a
// component: components[], the flow endpoints, and the structural kinds
// above.
export function intentRequiredComponents(
  requirementSet: {
    requirements: Array<{
      kind?: string;
      optionality: string;
      components?: string[];
      relationshipFrom?: string;
      relationshipTo?: string;
    }>;
  } | null,
): Set<string> {
  const out = new Set<string>();
  if (!requirementSet) return out;
  for (const requirement of requirementSet.requirements) {
    if (requirement.optionality !== "REQUIRED") continue;
    for (const component of requirement.components ?? []) out.add(component);
    if (requirement.relationshipFrom) out.add(requirement.relationshipFrom);
    if (requirement.relationshipTo) out.add(requirement.relationshipTo);
    const implied = requirement.kind ? KIND_IMPLIED_COMPONENT[requirement.kind] : undefined;
    if (implied) out.add(implied);
  }
  return out;
}
