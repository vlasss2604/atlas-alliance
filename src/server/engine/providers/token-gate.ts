import Anthropic from "@anthropic-ai/sdk";

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
// Two distinct, closed failure classes (never conflated — see
// s4-executor.ts's classification of these into trace reason codes):
//   - ModelInputOversizedError: the EXACT count exceeded the ceiling —
//     a deterministic, safe SKIP. Not a provider failure.
//   - TokenCountUnavailableError: count_tokens itself could not be
//     obtained (the counting endpoint is itself an external provider
//     dependency) — Atlas must not guess and must not proceed to
//     generation. Classified consistently with other model-provider
//     capability failures (transient vs not), never silently converted
//     into "research still happened normally".

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
// proceed. `system`/`messages` must be the IDENTICAL values the caller is
// about to pass to `messages.create` — a count against a different
// request shape would prove nothing about the actual call.
export async function countThenGate(
  client: Anthropic,
  model: string,
  system: string,
  messages: Anthropic.MessageParam[],
  maxInputTokens: number,
): Promise<void> {
  let result: { input_tokens: number };
  try {
    result = await client.messages.countTokens({ model, system, messages });
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    const transient = status === 429 || status === undefined || (status >= 500 && status < 600);
    throw new TokenCountUnavailableError(
      `count_tokens failed: ${status ?? "?"} ${e instanceof Error ? e.name : String(e)}`,
      transient,
    );
  }
  if (result.input_tokens > maxInputTokens) {
    throw new ModelInputOversizedError(result.input_tokens, maxInputTokens);
  }
}
