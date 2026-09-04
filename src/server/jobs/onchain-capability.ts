import {
  __setOnchainRetriever,
  type OnchainRetriever,
} from "../engine/providers/onchain-retriever";
import { createProductionOnchainRetriever } from "../engine/providers/onchain-transport";
import { workerServesPhase, type PhaseCapability } from "./worker-capabilities";

// STRUCTURED ON-CHAIN RETRIEVAL BECOMES A REAL CAPABILITY OF THE
// SEARCH_EXTRACT WORKER, AND ONLY OF THAT WORKER.
//
// The whole deterministic Solana stack already existed — typed intents,
// bounded retrieval, artifact validation, entity binding, fact synthesis,
// evidence persistence — and no production process ever installed a
// retriever. `onchainRetrievalAvailable()` was `_override !== null`, and
// the only setter was documented test-only, so ordinary Research silently
// took the `ONCHAIN_RETRIEVER_NOT_CONFIGURED` branch on every job. Every
// deterministic chain observation in this repository was therefore made by
// a standalone script and could never become Evidence. This module is the
// whole of the production installation.
//
// DECLARED, NEVER DISCOVERED — the same rule D-136 established for phase
// capability and D-146 Slice 2 for the renderer. Whether this process may
// reach a chain is answered by exactly two declarations:
//
//   1. the worker ROLE (ATLAS_WORKER_CAPABILITIES serves EXTRACTING), and
//   2. the explicit flag (ONCHAIN_RESEARCH_ENABLED=1).
//
// Nothing else is consulted. Not reachability, not a probe, not whether an
// RPC URL happens to be present in the environment, not a project, not a
// document. A process that has not been told to reach a chain does not
// reach one, and a process that HAS been told either gets a retriever or
// fails to start.
//
// WHY THE EXTRACT ROLE. On-chain acquisition runs inside `s4-executor`,
// which the EXTRACTING phase invokes — and EXTRACTING is served by
// SEARCH_EXTRACT (worker-capabilities.ts). Installing this on the FETCH
// role would put a retriever in a process that never runs the code that
// uses it, and would give the pinned-address document role an extra
// outbound path it has no reason to hold. The role that runs the executor
// is the role that gets the capability.
//
// FAIL CLOSED, LOUDLY. If the owner declares on-chain capability and no
// retriever can be constructed — the endpoint is absent, is not https, or
// carries a credential in the URL — the worker does NOT come up in a
// quietly documentary-only mode. That mode is indistinguishable, from the
// outside, from a project having no on-chain footprint: every component
// would report ordinary evidentiary absence for a cause that has nothing
// to do with any project. Startup fails instead.
//
// DISABLED IS A DIFFERENT THING FROM BROKEN. A deployment that never
// declared the capability is not failing: research proceeds without
// structured chain reads, and `runStructuredOnchainAcquisition` records
// the closed observation `ONCHAIN_RETRIEVER_NOT_CONFIGURED` on the job, so
// the limitation stays visible in the trace and is never mistaken for a
// finding about a project.
//
// NO NEW TRANSPORT. `createProductionOnchainRetriever` already exists and
// already carries the security contract: the endpoint comes from a fixed
// (chain, network) -> env-var allowlist, must be https with no credential
// in the URL, and the provider label that reaches provenance is derived
// from the allowlist key rather than from the endpoint string. Nothing
// here widens any of that, and no document, model output or evidence row
// can influence which endpoint is used.

export const ONCHAIN_RESEARCH_ENV = "ONCHAIN_RESEARCH_ENABLED";

// v1 is Solana mainnet only — the same bound `selectOnchainIntents`
// already enforces (`identity.chain !== "solana"` returns no intents).
export const ONCHAIN_CHAIN = "solana";
export const ONCHAIN_NETWORK = "mainnet";

// Why this process did or did not end up with a retriever. Closed, and
// printed at startup so an unexpected "not enabled" is visible then rather
// than inferred from a research result later.
export type OnchainInstallOutcome =
  // Declared EXTRACT role + declared flag + a retriever was constructed.
  | "INSTALLED"
  // This process does not serve EXTRACTING. No retriever is installed
  // here whatever the flag says.
  | "NOT_EXTRACT_ROLE"
  // The role, but the capability was not declared. Research runs without
  // structured chain reads and says so in the trace.
  | "NOT_ENABLED";

export interface OnchainInstallResult {
  outcome: OnchainInstallOutcome;
  // The allowlist-derived label, present only on INSTALLED. Never the
  // endpoint: the endpoint can be the credential.
  providerId: string | null;
}

// Thrown to stop worker startup. Carries the (chain, network) and the name
// of the env var that should have held the endpoint — never the endpoint
// value itself, and never a transport error, which can contain the host.
export class OnchainCapabilityUnavailableError extends Error {
  constructor(
    readonly chain: string,
    readonly network: string,
    readonly envVar: string,
  ) {
    super(
      "on-chain research capability was declared (" +
        ONCHAIN_RESEARCH_ENV +
        "=1) but no retriever could be constructed for " +
        chain +
        "/" +
        network +
        ": " +
        envVar +
        " must be set to an https endpoint carrying no credential in the URL",
    );
    this.name = "OnchainCapabilityUnavailableError";
  }
}

export interface OnchainInstallDeps {
  capabilities: ReadonlySet<PhaseCapability>;
  // A plain string map rather than NodeJS.ProcessEnv: this reads an
  // injected environment, not necessarily this process's own, and the
  // decision needs exactly one key from it. Same choice dev-launch.ts
  // documents for its launch plan.
  env?: Readonly<Record<string, string | undefined>>;
  // Seams, so the decision above is testable without a network. Production
  // passes none of them.
  create?: () => OnchainRetriever | null;
  install?: (r: OnchainRetriever | null) => void;
}

// The env var this deployment must set for the declared target. Exported
// so the operator message and the error name the same thing.
export function onchainEndpointEnvVar(): string {
  return "SOLANA_MAINNET_RPC_URL";
}

export function installOnchainResearchCapability(
  deps: OnchainInstallDeps,
): OnchainInstallResult {
  const env = deps.env ?? process.env;
  const install = deps.install ?? __setOnchainRetriever;

  if (!workerServesPhase(deps.capabilities, "EXTRACTING")) {
    return { outcome: "NOT_EXTRACT_ROLE", providerId: null };
  }
  if (env[ONCHAIN_RESEARCH_ENV] !== "1") {
    return { outcome: "NOT_ENABLED", providerId: null };
  }

  const retriever =
    (deps.create ?? (() => createProductionOnchainRetriever(ONCHAIN_CHAIN, ONCHAIN_NETWORK)))();

  if (!retriever) {
    // Declared and unconstructible. Uninstall unconditionally first: a
    // supervisor restart must never inherit a half-installed capability.
    install(null);
    throw new OnchainCapabilityUnavailableError(
      ONCHAIN_CHAIN,
      ONCHAIN_NETWORK,
      onchainEndpointEnvVar(),
    );
  }

  install(retriever);
  return { outcome: "INSTALLED", providerId: `${ONCHAIN_CHAIN}-${ONCHAIN_NETWORK}-rpc` };
}

// Shutdown. The retriever holds no long-lived connection of its own —
// each bounded call opens and closes its own request — so what is removed
// here is the capability object, exactly once, so a stopped worker cannot
// still answer `onchainRetrievalAvailable()` with true.
export function uninstallOnchainResearchCapability(
  install: (r: OnchainRetriever | null) => void = __setOnchainRetriever,
): void {
  install(null);
}
