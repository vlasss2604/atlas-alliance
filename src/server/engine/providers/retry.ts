import Anthropic from "@anthropic-ai/sdk";

// S10 acceptance closure (BLOCKER-2, D-119) — this module now owns ONLY
// the count_tokens retry (kept provider-internal, non-billable, per
// owner instruction: "It may retain at most one transient retry").
// SearchGateway/QueryProposer/EvidenceExtractor no longer self-retry
// here — every billable/budgeted external attempt now goes through
// s4-executor.ts's own reserveAndCallWithRetry, which reserves BEFORE
// every attempt (including a retry) so one reservation can never
// authorize two real external calls (the BLOCKER-2 defect this closure
// fixes). Provider primitives (search-gateway-brave.ts's doSearch,
// query-proposer-anthropic.ts's doProposeQueries, evidence-extractor-
// anthropic.ts's doExtract) each perform exactly ONE external attempt —
// s4-executor.ts calls them a second time itself, with a fresh
// reservation, if a retry is warranted.
//
// ContentFetcher deliberately never used this — 0 retries is the
// owner-approved policy for FETCH (move to the next candidate instead).

interface MaybeTransient {
  transient?: boolean;
}

// Exported so s4-executor.ts's reserveAndCallWithRetry classifies a
// caught (already-wrapped, own-typed) exception using the EXACT same
// rule as this module's own retryOnceIfTransient default — never a
// second, divergent transient-detection heuristic. This classifier only
// works on an error that already carries a normalized `.transient` flag
// (query-proposer-anthropic.ts/evidence-extractor-anthropic.ts/
// search-gateway-brave.ts compute and attach it before throwing their
// own typed error) — it is the WRONG classifier for a RAW, not-yet-
// wrapped Anthropic SDK exception; use isTransientAnthropicApiError for
// that (see MEDIUM-1 below).
export function isTransientError(e: unknown): boolean {
  return e instanceof Error && (e as Error & MaybeTransient).transient === true;
}

// S10 final pre-smoke closure (MEDIUM-1, D-120) — the ONE shared
// classifier for a RAW (not yet wrapped in one of this codebase's own
// typed provider errors) Anthropic SDK exception: 429, no distinguishable
// status (network/timeout/unknown), or any 5xx. This is the SAME rule
// query-proposer-anthropic.ts and evidence-extractor-anthropic.ts already
// compute independently in their own catch blocks before wrapping into
// QueryProposerUnavailableError/EvidenceExtractorUnavailableError — all
// three call sites (those two, plus token-gate.ts's own count_tokens
// retry below) now share this ONE function so the rule can never drift
// between them. Previously (the BLOCKER-1 defect this closure fixes),
// token-gate.ts wrapped `retryOnceIfTransient(() => client.messages.
// countTokens(...))` around the RAW SDK call — but isTransientError only
// recognizes an error carrying `.transient === true`, a field the raw
// SDK exception never has (it is computed by the CALLER, in the catch
// block AFTER this retry already decided not to retry). A genuinely
// transient 503/429/network failure on count_tokens attempt #1 therefore
// never retried in practice. Fixed by classifying the RAW exception with
// this function, before it is wrapped into anything.
export function isTransientAnthropicApiError(e: unknown): boolean {
  const status = e instanceof Anthropic.APIError ? e.status : undefined;
  return status === 429 || status === undefined || (status >= 500 && status < 600);
}

// NETWORK TRANSIENT RESILIENCE V1 (founder-approved, application-level
// only) — how long the ONE retry waits after a first attempt that the
// provider never answered. The live run 1f8e1a63 died on a single
// count_tokens NETWORK_NO_RESPONSE whose immediate retry landed inside the
// same short tunnel outage (proven to last ~10–30 s) as the first attempt,
// so "one retry" bought nothing. Waiting this long before that same
// single retry gives the outage time to end. It is a delay, not an
// attempt: the retry count stays exactly one, no third call is ever
// made, nothing is reserved or billed for the wait, and a successful
// first attempt never waits at all.
export const NETWORK_NO_RESPONSE_RETRY_DELAY_MS = 15_000;

// TRANSIENT RETRY DELAY POLICY (V2 + V3) — the ONE policy for how long
// the single retry waits, wherever the retry lives: the executor's
// reserveAndCallWithRetry (proposer, search, extractor generation) and
// token-gate.ts's non-billable count_tokens retry. Consulted ONLY after a
// caller has already decided to retry, so it changes no attempt count
// (two, total), no reservation and no classification: it only says how
// long the one retry waits, and it is bounded on every path.
//
//   no response (transient, no HTTP status)   DEFAULT_TRANSIENT_RETRY_DELAY_MS
//   429 with Retry-After                      the header, clamped to
//                                             [0, RETRY_AFTER_MAX_MS]
//   429 without Retry-After                   DEFAULT_TRANSIENT_RETRY_DELAY_MS
//   retryable 5xx (Retry-After honoured too)  DEFAULT_TRANSIENT_RETRY_DELAY_MS
//   any non-transient failure                 never retried, so never waits
//
// V2 covered only the first line — a 429 retried at once, which with the
// SDK at maxRetries: 0 meant the retry usually met the same limit. V3 makes
// every transient class wait, and honours Retry-After only inside a cap:
// an absurd or unparsable header never makes a paid job sleep for it.
//
// The facts come from the typed provider errors — `transient`,
// `httpStatus` (null when the provider never answered) and `retryAfterMs`
// (the header parsed at the throw site, null when absent) — or, for the
// raw SDK exception count_tokens retries before wrapping, from the SDK
// error itself. An error without `httpStatus` is treated as "no response":
// a transient error that could not say what the provider answered has,
// for this purpose, not been answered.
export const DEFAULT_TRANSIENT_RETRY_DELAY_MS = NETWORK_NO_RESPONSE_RETRY_DELAY_MS;
export const RETRY_AFTER_MAX_MS = 60_000;

export interface RetryDelayFacts {
  transient: boolean;
  httpStatus: number | null;
  retryAfterMs: number | null;
}

interface MaybeRetryFacts {
  transient?: boolean;
  httpStatus?: number | null;
  retryAfterMs?: number | null;
}

// RFC 9110 Retry-After: delay-seconds or an HTTP-date. Anything else, or
// a negative value, is null — "no usable header", never "wait forever".
export function parseRetryAfterMs(value: string | null | undefined, now: Date = new Date()): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // An HTTP-date names a weekday and a month; a bare number that is not
  // delay-seconds (a negative, a float) is not a date and is refused.
  if (!/[A-Za-z]/.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

// The header off a Fetch `Headers`, a plain record, or nothing. Only the
// standard name; only the parser above.
export function retryAfterMsFromHeaders(headers: unknown, now: Date = new Date()): number | null {
  if (headers === null || typeof headers !== "object") return null;
  const h = headers as { get?: (name: string) => string | null } & Record<string, unknown>;
  let raw: unknown = null;
  if (typeof h.get === "function") raw = h.get("retry-after");
  else raw = h["retry-after"] ?? h["Retry-After"] ?? null;
  return parseRetryAfterMs(typeof raw === "string" ? raw : null, now);
}

// The facts a wrapped provider error or a raw SDK exception carries.
export function retryDelayFactsOf(e: unknown): RetryDelayFacts {
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : null;
    return {
      transient: isTransientAnthropicApiError(e),
      httpStatus: status,
      retryAfterMs: retryAfterMsFromHeaders((e as { headers?: unknown }).headers),
    };
  }
  if (e instanceof Error) {
    const f = e as Error & MaybeRetryFacts;
    return {
      transient: f.transient === true,
      httpStatus: typeof f.httpStatus === "number" ? f.httpStatus : null,
      retryAfterMs: typeof f.retryAfterMs === "number" ? f.retryAfterMs : null,
    };
  }
  return { transient: false, httpStatus: null, retryAfterMs: null };
}

let transientRetryDelayCapOverrideMs: number | null = null;

// Offline test seam ONLY: a CEILING on every wait this policy returns.
// tests/setup-provider-env.ts sets 0 so no offline suite ever sleeps on a
// backoff; the resilience suites set a small positive value to prove the
// wait happens. null restores production behaviour. Never called from
// production code.
export function __setTransientRetryDelayCapMs(ms: number | null): void {
  transientRetryDelayCapOverrideMs = ms;
}

export function transientRetryDelayMs(firstAttemptError: unknown): number {
  const facts = retryDelayFactsOf(firstAttemptError);
  if (!facts.transient) return 0;
  let delay = DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  if (facts.httpStatus !== null && facts.retryAfterMs !== null) {
    delay = Math.min(Math.max(0, facts.retryAfterMs), RETRY_AFTER_MAX_MS);
  }
  if (transientRetryDelayCapOverrideMs !== null) delay = Math.min(delay, transientRetryDelayCapOverrideMs);
  return delay;
}

export interface RetryOnceOptions {
  // Milliseconds to wait between a transient attempt-1 failure and the
  // ONE retry, decided from the failure itself. Omitted, or returning 0,
  // means "retry at once" — the pre-existing behaviour, which every
  // transient class other than NETWORK_NO_RESPONSE keeps (token-gate.ts's
  // countTokensRetryDelayMs is the only policy in production). Never
  // consulted for a non-transient failure (those are rethrown before it)
  // and never for a successful first attempt.
  delayBeforeRetryMs?: (firstAttemptError: unknown) => number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `isTransient` defaults to isTransientError (the pre-existing default
// every caller except token-gate.ts still wants — retrying an already-
// classified, already-wrapped typed error). token-gate.ts passes
// isTransientAnthropicApiError explicitly (MEDIUM-1) since it retries a
// RAW SDK call, not a wrapped one — one retry-loop implementation, two
// pluggable classification rules, never two divergent retry mechanics.
export async function retryOnceIfTransient<T>(
  fn: () => Promise<T>,
  isTransient: (e: unknown) => boolean = isTransientError,
  options: RetryOnceOptions = {},
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isTransient(e)) throw e;
    const delayMs = options.delayBeforeRetryMs?.(e) ?? 0;
    if (delayMs > 0) await sleep(delayMs);
    return await fn();
  }
}
