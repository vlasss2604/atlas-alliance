// S10 final pre-smoke closure (D-120, HIGH-1) — the ONE typed exception
// that means "a real, authoritative dimensional job budget axis
// (searchQueries/sourceOpens/modelCostMicro) is exhausted and that
// prevents any further relevant research this attempt could have done",
// never a capability failure and never routed through S5/S6/S7. Thrown
// by s4-executor.ts, caught NOWHERE between here and worker.ts — exactly
// the same structural propagation CapabilityFatalError already relies on
// (WorkExecutor.execute() has no try/catch around it in controller.ts,
// runS4ResearchJob has none around the controller call) — so this
// reaches worker.ts's existing catch boundary unmodified. Unlike an
// uncaught generic exception, worker.ts gives this ONE narrow, explicit
// branch: state=BUDGET_LIMIT_REACHED/terminationReason=BUDGET_EXHAUSTED/
// errorCode=null — never SYSTEM_OR_PROVIDER_FAILURE (nothing failed —
// the job legitimately ran out of authorized budget) and never allowed
// to fall through to WORK_QUEUE_EXHAUSTED->SUCCEEDED (which would make
// an honest budget stop look like completed research).
//
// Reserved for the case where the exhausted axis left ZERO usable result
// for this attempt (no candidate found, no document fetched, no
// generation call ever authorized) — a budget axis running low but this
// attempt still producing a legitimate SUCCEEDED result from what it
// already obtained before the axis ran out is NOT this error; see each
// call site in s4-executor.ts for the exact "zero usable result" check.
export class BudgetExhaustedError extends Error {
  constructor(
    public readonly axis: "searchQueries" | "sourceOpens" | "modelCostMicro",
    public readonly cause?: unknown,
  ) {
    super(`budget exhausted: ${axis}`);
    this.name = "BudgetExhaustedError";
  }
}
