import type { ComponentTarget, MeteredProvider, ModelUsage } from "./types";

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

export interface QueryProposer extends MeteredProvider {
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

export const DEFAULT_QUERY_PROPOSER_MODEL = "claude-haiku-4-5";

// S10 LAST HIGH CLOSURE (HIGH-2, D-121): P3's original lazy-failure
// discipline (this function resolving successfully, with the missing-
// credential failure only surfacing on the first REAL call, already
// budget-reserved) is corrected here — a missing ANTHROPIC_API_KEY is a
// preflight-time capability/configuration fact, not a per-call outcome,
// and s4-executor.ts's preflight() must be able to catch it BEFORE any
// reservation is made (mirrors resolveSearchGateway()'s own eager
// BRAVE_SEARCH_API_KEY check, same file layout, same reasoning). `model`
// lets a caller that already loaded
// product_config.query_proposer_model pass it through; omitted, it falls
// back to QUERY_PROPOSER_MODEL / the D-026-style default — config key,
// not deploy.
// `maxOutputTokens` (D-090, phase-6-plan.md §5.6): the caller's approved
// model cost profile's output ceiling, passed straight through as the
// live implementation's `max_tokens` — the reservation this ceiling was
// priced against is only a real upper bound if the call is actually
// constrained by the same number. Omitted only by direct callers that
// don't go through the D-090 cost-profile flow (e.g. this module's own
// tests exercising lazy-failure resolution) — falls back to the live
// implementation's own default in that case.
export async function resolveQueryProposer(
  model?: string,
  maxOutputTokens?: number,
  maxInputTokens?: number,
  onUsage?: (usage: ModelUsage) => void,
): Promise<QueryProposer> {
  if (_override) return _override;
  const kind = process.env.MODEL_GATEWAY ?? "anthropic";
  if (kind === "fake") {
    throw new QueryProposerUnavailableError(
      "MODEL_GATEWAY=fake has no built-in QueryProposer fixture — " +
        "tests must call __setQueryProposer() with a fixture-backed implementation",
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new QueryProposerUnavailableError("ANTHROPIC_API_KEY is not set");
  }
  const { createAnthropicQueryProposer } = await import("./query-proposer-anthropic");
  return createAnthropicQueryProposer(
    model ?? process.env.QUERY_PROPOSER_MODEL ?? DEFAULT_QUERY_PROPOSER_MODEL,
    maxOutputTokens,
    maxInputTokens,
    onUsage,
  );
}
