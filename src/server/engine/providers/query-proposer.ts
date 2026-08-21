import type { ComponentTarget } from "./types";

// Phase 6, S1 — QueryProposer seam (phase-6-plan.md §4.1 table).
//
// A model role: proposes ≤N search-query formulations for ONE requested
// component. It never decides how many queries to run, where to go next,
// or when to stop (D-070) — the controller passes `maxQueries`, the
// proposer returns at most that many strings, and the controller decides
// what to do with them. Live wiring (a real model call under a strict
// schema) belongs to S4; this slice only fixes the contract so the
// controller (S3) can be written and tested against it today.

export interface QueryProposalInput {
  target: ComponentTarget;
  // Reason text from the contract (StepDecision.reason / blockers) —
  // context only, never parsed back into control flow.
  hint: string;
  maxQueries: number;
}

export interface QueryProposer {
  readonly name: string;
  proposeQueries(input: QueryProposalInput): Promise<string[]>;
}

export class QueryProposerUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
  ) {
    super(message);
    this.name = "QueryProposerUnavailableError";
  }
}

let _override: QueryProposer | null = null;

export function __setQueryProposer(p: QueryProposer | null): void {
  _override = p;
}

// P3 (model role selection + config key, D-032/D-026 continuation) is not
// resolved yet — same no-silent-fallback rule as search-gateway.ts.
export function resolveQueryProposer(): QueryProposer {
  if (_override) return _override;
  throw new QueryProposerUnavailableError(
    "no QueryProposer model role is configured for production (P3 not yet resolved) — " +
      "tests must call __setQueryProposer() with a fixture-backed implementation",
  );
}
