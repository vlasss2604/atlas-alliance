import type { OnchainArtifact, OnchainIntent } from "./onchain-types";

// OnchainRetriever — the fifth provider role (owner-approved V1).
//
// Same discipline as the existing four: a typed seam, a resolver that
// throws rather than silently substituting a fake in production, and a
// test-only override. It is deliberately NOT a general "structured
// retriever": chain, network, address validation, slot/finality and
// cryptographic entity binding are on-chain concepts with no meaningful
// analogue in a filings API or an analytics endpoint, and an umbrella
// abstraction over one implementation would be an empty interface.
//
// VENDOR NEUTRALITY (owner amendment): nothing in this module names a
// vendor. An endpoint is supplied by server-side configuration, resolved
// against a code-owned allowlist of ENV VARIABLE NAMES, and identified
// downstream only by a label. No paid provider is committed to, and no
// endpoint can originate from a user, a model, or a search result.

export class OnchainRetrieverUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
  ) {
    super(message);
    this.name = "OnchainRetrieverUnavailableError";
  }
}

// The transport is the ONLY thing that touches the network. It accepts a
// method name and parameters — never a URL — so no caller, adapter or
// model can redirect where a request goes.
export interface OnchainRpcTransport {
  // Returns the raw response body as text, so the caller can hash exactly
  // what was received before anything parses or reshapes it.
  call(method: string, params: unknown[]): Promise<string>;
}

export interface OnchainRetriever {
  readonly name: string;
  supports(chain: string, network: string, kind: string): boolean;
  retrieve(intent: OnchainIntent): Promise<OnchainArtifact>;
}

// Code-owned: the exact (chain, network) pairs v1 may address, and the
// ENV VARIABLE NAME that supplies each endpoint. A pair absent from this
// table is unreachable — which is how D-131 is enforced structurally
// rather than by filtering later: no test network appears here, so no
// test-network endpoint can be configured even if someone sets a variable.
const ENDPOINT_ENV_BY_TARGET: Record<string, string> = {
  "solana/mainnet": "SOLANA_MAINNET_RPC_URL",
};

export function endpointEnvVarFor(chain: string, network: string): string | null {
  return ENDPOINT_ENV_BY_TARGET[`${chain}/${network}`] ?? null;
}

// An endpoint must be https and carry no credential in the URL itself
// (keys belong in a header supplied by configuration, never in a string
// that could reach a log, a trace row, or provenance).
export function isAcceptableEndpoint(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

let _override: OnchainRetriever | null = null;

// Test-only. There is no production "fake" branch — an unconfigured
// environment throws, exactly like the other provider roles.
export function __setOnchainRetriever(r: OnchainRetriever | null): void {
  _override = r;
}

export function resolveOnchainRetriever(): OnchainRetriever {
  if (_override) return _override;
  // v1 ships no production transport wiring: the bounded live smoke is a
  // separate, owner-authorized step. Failing loudly here is the honest
  // state — never a silent fallback to a fixture, and never a fabricated
  // "no on-chain data found" conclusion.
  throw new OnchainRetrieverUnavailableError(
    "no OnchainRetriever is configured in this environment — structured on-chain retrieval " +
      "requires a server-side RPC endpoint that has not been enabled; tests must call " +
      "__setOnchainRetriever() with a fixture-backed implementation",
  );
}

// Is structured on-chain retrieval available at all right now? Callers use
// this to skip the path silently instead of turning a configuration
// boundary into a research failure.
export function onchainRetrievalAvailable(): boolean {
  return _override !== null;
}
