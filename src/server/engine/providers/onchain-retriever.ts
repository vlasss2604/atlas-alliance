import type {
  OnchainArtifact,
  OnchainChain,
  OnchainEnvironment,
  OnchainIntent,
  OnchainNetwork,
} from "./onchain-types";
import { onchainEnvironmentKey } from "./onchain-types";
import {
  endpointEnvVarFor,
  onchainEnvironmentFor,
  onchainEnvironmentImplemented,
} from "../onchain-environment";

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
// ONE RESEARCH CORE, MULTIPLE EVIDENCE ENVIRONMENTS. A retriever answers
// "how do I deterministically obtain and normalise this observation?" for
// exactly one (chain, network). The Research Core — reconciliation, Proof,
// Memory — answers "what does this evidence prove?" and never asks which
// chain served it. This module is the seam between the two: a small
// explicit registry keyed by environment. Solana mainnet is implementation
// #1; a second implementation registers under its own key and nothing
// generic changes.
//
// VENDOR NEUTRALITY (owner amendment): nothing in this module names a
// vendor. An endpoint is supplied by server-side configuration, resolved
// against a code-owned allowlist of ENV VARIABLE NAMES, and identified
// downstream only by a label. No paid provider is committed to, and no
// endpoint can originate from a user, a model, or a search result.

export type { OnchainEnvironment };
// The static environment table lives in engine/onchain-environment.ts so a
// module that imports no provider can still consult it; it is re-exported
// here because this is where every retriever-facing caller already looks.
export { endpointEnvVarFor, onchainEnvironmentFor, onchainEnvironmentImplemented };

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

// ---- installed retrievers (runtime) ------------------------------------
//
// What THIS process can actually reach, keyed by environment. Installed
// by jobs/onchain-capability.ts in production (gated on the worker ROLE
// plus an explicit flag) and by tests with fixture-backed implementations.
// There is still no production "fake" branch: an unconfigured environment
// has no entry at all.
const installed = new Map<string, OnchainRetriever>();

// THE ONE INSTALL SEAM, for tests and for production capability wiring
// alike — the same convention __setRenderedDocsFetcher follows.
//
// The environment is EXPLICIT. A retriever is installed for exactly the
// (chain, network) the caller names, and only if the codebase implements
// that environment: installing under an unimplemented key is refused
// loudly, so a fixture cannot quietly create a capability no adapter has.
// `null` uninstalls — the named environment when one is given, every
// environment otherwise (shutdown, and the test-suite reset).
export function __setOnchainRetriever(
  r: OnchainRetriever | null,
  environment?: OnchainEnvironment,
): void {
  if (r === null) {
    if (environment) installed.delete(onchainEnvironmentKey(environment));
    else installed.clear();
    return;
  }
  if (!environment) {
    throw new Error(
      "__setOnchainRetriever: a retriever must be installed for an explicit (chain, network) " +
        "environment — there is no default environment and no chain is ever guessed",
    );
  }
  const key = onchainEnvironmentKey(environment);
  if (!onchainEnvironmentImplemented(environment.chain, environment.network)) {
    throw new Error(
      `__setOnchainRetriever: ${key} is not an implemented on-chain environment; ` +
        "a retriever cannot be installed for an environment the codebase has no adapter for",
    );
  }
  installed.set(key, r);
}

// The retriever for exactly this environment. Reached only when the caller
// has already decided a chain read is admissible; there is NO fallback —
// not to another network, not to another chain, not to a fixture. Failing
// loudly here is the honest state for an environment nothing installed:
// never a silent substitute, and never a fabricated "no on-chain data
// found" conclusion.
//
// Production installation is jobs/onchain-capability.ts, which fails
// worker STARTUP when the capability is declared and unconstructible — so
// a running worker either has one or was never told to have one.
export function resolveOnchainRetriever(chain: OnchainChain, network: OnchainNetwork): OnchainRetriever {
  const key = onchainEnvironmentKey({ chain, network });
  const r = installed.get(key);
  if (r) return r;
  throw new OnchainRetrieverUnavailableError(
    `no OnchainRetriever is configured for ${key} in this environment — structured on-chain ` +
      "retrieval requires a server-side RPC endpoint that has not been enabled; tests must call " +
      "__setOnchainRetriever() with a fixture-backed implementation for that environment",
  );
}

// Is structured on-chain retrieval available right now — for one exact
// environment when named, for any environment at all otherwise? Callers
// use this to skip the path silently instead of turning a configuration
// boundary into a research failure. The unqualified form exists for
// process-level questions ("did this worker install anything?"); a
// research path always asks about the identity's own environment.
export function onchainRetrievalAvailable(chain?: OnchainChain, network?: OnchainNetwork): boolean {
  if (chain === undefined || network === undefined) return installed.size > 0;
  return installed.has(onchainEnvironmentKey({ chain, network }));
}
