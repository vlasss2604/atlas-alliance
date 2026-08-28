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

// WHY count_tokens FAILED, as a closed code-owned set. A live window died
// with "capability unavailable: EVIDENCE_EXTRACTOR_COUNT_TOKENS" and
// nothing persisted could say whether that was a bad credential, an
// unrecognised model id, an exhausted rate limit, a provider outage, or a
// network path that never answered — five situations whose next actions
// have nothing in common. Every value below rests on a signal the SDK
// actually provides (its own error class, its own trusted status
// integer); nothing is parsed out of a message.
export const TOKEN_COUNT_DIAGNOSTICS = [
  // 401 — the credential was rejected.
  "AUTHENTICATION_FAILED",
  // 403 — authenticated, but not permitted.
  "PERMISSION_DENIED",
  // 404 — the resource does not exist. The endpoint is fixed by the SDK,
  // so in practice the variable part of this request is the model id.
  "NOT_FOUND",
  // 400 / 422 — the request shape itself was rejected.
  "INVALID_REQUEST",
  // 429 — rate/usage ceiling at the provider.
  "RATE_LIMITED",
  // 5xx — the provider answered that IT failed.
  "PROVIDER_SERVER_ERROR",
  // The SDK's own no-response class (connection/timeout), or an APIError
  // that carries no status at all: the provider was never heard from.
  // Deliberately says only that — no DNS/VPN/routing cause is inferred.
  "NETWORK_NO_RESPONSE",
  // Anything else. Never a stand-in for one of the above.
  "UNCLASSIFIED_PROVIDER_ERROR",
] as const;

export type TokenCountDiagnostic = (typeof TOKEN_COUNT_DIAGNOSTICS)[number];

const TOKEN_COUNT_DIAGNOSTIC_SET: ReadonlySet<string> = new Set<string>(TOKEN_COUNT_DIAGNOSTICS);

// The runtime gate. Membership of the closed list is the only way a value
// may cross an observability boundary — the type alone vouches for
// nothing, because a runtime value can violate a compile-time union.
export function isTokenCountDiagnostic(v: unknown): v is TokenCountDiagnostic {
  return typeof v === "string" && TOKEN_COUNT_DIAGNOSTIC_SET.has(v);
}

// The ONE place a raw count_tokens exception is reduced to the closed
// vocabulary. Reads only the SDK's class identity and trusted numeric
// status — never the message, never the response body, never headers.
export function classifyTokenCountFailure(e: unknown): {
  diagnostic: TokenCountDiagnostic;
  httpStatus: number | null;
} {
  // The SDK's own "no response was received" class (timeouts included).
  // Checked before the generic APIError branch it extends.
  if (e instanceof Anthropic.APIConnectionError) {
    return { diagnostic: "NETWORK_NO_RESPONSE", httpStatus: null };
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : null;
    if (status === null) return { diagnostic: "NETWORK_NO_RESPONSE", httpStatus: null };
    if (status === 401) return { diagnostic: "AUTHENTICATION_FAILED", httpStatus: status };
    if (status === 403) return { diagnostic: "PERMISSION_DENIED", httpStatus: status };
    if (status === 404) return { diagnostic: "NOT_FOUND", httpStatus: status };
    if (status === 400 || status === 422) return { diagnostic: "INVALID_REQUEST", httpStatus: status };
    if (status === 429) return { diagnostic: "RATE_LIMITED", httpStatus: status };
    if (status >= 500 && status < 600) return { diagnostic: "PROVIDER_SERVER_ERROR", httpStatus: status };
    return { diagnostic: "UNCLASSIFIED_PROVIDER_ERROR", httpStatus: status };
  }
  return { diagnostic: "UNCLASSIFIED_PROVIDER_ERROR", httpStatus: null };
}

export class TokenCountUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
    // Closed classification of WHY, decided at the throw site — the only
    // place still holding the raw SDK exception. Defaults keep every
    // existing constructor call (tests included) valid and honest.
    public readonly diagnostic: TokenCountDiagnostic = "UNCLASSIFIED_PROVIDER_ERROR",
    public readonly httpStatus: number | null = null,
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
    // The message is COMPOSED from closed values only — the diagnostic
    // and the trusted status integer. The raw exception's message is
    // never interpolated: a provider error string is provider-influenced
    // text and has no business inside anything an operator will read.
    const { diagnostic, httpStatus } = classifyTokenCountFailure(e);
    throw new TokenCountUnavailableError(
      `count_tokens failed: ${diagnostic}${httpStatus === null ? "" : `:${httpStatus}`}`,
      isTransientAnthropicApiError(e),
      diagnostic,
      httpStatus,
    );
  }
  if (result.input_tokens > maxInputTokens) {
    throw new ModelInputOversizedError(result.input_tokens, maxInputTokens);
  }
}
