// S10 acceptance closure (D-118 closure, BLOCKER-1) — the ONE typed
// exception that means "the capability itself is unavailable", never a
// local/continuable operational failure. Thrown by s4-executor.ts,
// caught NOWHERE between here and worker.ts: WorkExecutor.execute() has
// no try/catch around it in controller.ts, runS4ResearchJob has none
// around the controller call, so this propagates unmodified all the way
// to worker.ts's existing catch boundary (built in Stage 1), which maps
// ANY uncaught exception to state=FAILED/terminationReason=
// SYSTEM_OR_PROVIDER_FAILURE/errorCode=e.name — never a fabricated S7
// evidentiary conclusion. Controller.ts, run-job.ts, and S5/S6/S7 need
// ZERO changes to honor this: it is a structural consequence of the
// existing exception boundary, exactly like TracePersistenceError
// (Stage 2) already relies on.
//
// Reserved for genuine capability unavailability — never for a local,
// continuable condition (one fetch 404, one oversized document, one
// extraction failure with other sources remaining). See s4-executor.ts's
// reserveAndCallWithRetry for the exact classification rule.
export class CapabilityFatalError extends Error {
  constructor(
    public readonly capability: string,
    public readonly cause?: unknown,
  ) {
    // A STRING cause is included in the message; any other cause stays an
    // unprinted field. Every string handed to this constructor is a
    // safeFailureReason() product — label, class name, and a closed
    // membership-gated detail — so surfacing it exposes nothing free-form.
    // Without this, a terminal owner run died saying only which capability
    // failed, while the classified WHY sat in an unprinted field.
    super(
      typeof cause === "string" && cause.length > 0
        ? `capability unavailable: ${capability} — ${cause}`
        : `capability unavailable: ${capability}`,
    );
    this.name = "CapabilityFatalError";
  }
}
