import Anthropic from "@anthropic-ai/sdk";

import { isTransientAnthropicApiError, retryOnceIfTransient } from "./retry";

// S10 (live-provider-enablement.md §5, D-118) — D-090's provable model-
// input bound, implemented as COUNT-THEN-GATE: before every Anthropic
// generation call that relies on an approved maxInputTokens ceiling,
// construct the EXACT request shape that would be sent, count its input
// tokens via the provider's own token-counting facility
// (`messages.count_tokens` — never a chars/token heuristic, never an
// estimate treated as proof), and only proceed to generation if the
// exact count is within the role-specific approved ceiling. Never
// truncates the document to fit; never approximates.
//
// S10 acceptance closure (HIGH-1, D-119): the counted request must match
// the generation request EXACTLY on every input-bearing field — model,
// system, messages, AND output_config (structured-output schema).
// `output_config` affects how the provider tokenizes/handles the
// request; omitting it from the count (as the pre-closure version did)
// proves the wrong request shape. `outputConfig` here is REQUIRED (no
// default) so a caller cannot silently drift the counted shape from the
// generated one — both query-proposer-anthropic.ts and evidence-
// extractor-anthropic.ts build ONE shared base-request object and pass
// it to both this function and `messages.create`, so the two requests
// cannot structurally diverge. `max_tokens` is deliberately NOT part of
// the counted request — it is an output-generation control, not an
// input-bearing field (§3 of the closure: "generation may then add only
// output-generation controls such as max_tokens").
//
// Two distinct, closed failure classes (never conflated — see
// s4-executor.ts's classification of these into trace reason codes):
//   - ModelInputOversizedError: the EXACT count exceeded the ceiling —
//     a deterministic, safe SKIP. Not a provider failure.
//   - TokenCountUnavailableError: count_tokens itself could not be
//     obtained (the counting endpoint is itself an external provider
//     dependency) — Atlas must not guess and must not proceed to
//     generation. count_tokens is intentionally treated as OUTSIDE the
//     modelCostMicro budget axis (it is currently non-billable) — it
//     retains its own internal retry here (retryOnceIfTransient, at most
//     one retry) rather than going through s4-executor.ts's reservation-
//     gated retry loop, since there is nothing to reserve for a non-
//     billable call. An unresolved failure after that retry is
//     classified consistently with other model-provider capability
//     failures by s4-executor.ts's reserveAndCallWithRetry (BLOCKER-1:
//     capability-fatal), never silently converted into "research still
//     happened normally".

export class ModelInputOversizedError extends Error {
  readonly transient = false;
  constructor(
    public readonly inputTokens: number,
    public readonly maxInputTokens: number,
  ) {
    super(`input_tokens=${inputTokens} exceeds approved maxInputTokens=${maxInputTokens}`);
    this.name = "ModelInputOversizedError";
  }
}

export class TokenCountUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
  ) {
    super(message);
    this.name = "TokenCountUnavailableError";
  }
}

// Throws ModelInputOversizedError or TokenCountUnavailableError; resolves
// (void) only when the exact count is within bound and generation may
// proceed. `system`/`messages`/`outputConfig` must be the IDENTICAL
// values the caller is about to pass to `messages.create` — a count
// against a different request shape would prove nothing about the
// actual call.
export async function countThenGate(
  client: Anthropic,
  model: string,
  system: string,
  messages: Anthropic.MessageParam[],
  outputConfig: Anthropic.MessageCreateParams["output_config"],
  maxInputTokens: number,
): Promise<void> {
  let result: { input_tokens: number };
  try {
    // MEDIUM-1 (S10 final pre-smoke closure, D-120): classify the RAW SDK
    // exception with isTransientAnthropicApiError, NOT the default
    // (.transient-field) classifier — a raw count_tokens exception never
    // carries that field, so the default would never retry a genuinely
    // transient 429/503/network failure. Exactly one retry, max 2 total
    // count_tokens attempts.
    result = await retryOnceIfTransient(
      () => client.messages.countTokens({ model, system, messages, output_config: outputConfig }),
      isTransientAnthropicApiError,
    );
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    throw new TokenCountUnavailableError(
      `count_tokens failed: ${status ?? "?"} ${e instanceof Error ? e.name : String(e)}`,
      isTransientAnthropicApiError(e),
    );
  }
  if (result.input_tokens > maxInputTokens) {
    throw new ModelInputOversizedError(result.input_tokens, maxInputTokens);
  }
}
