import type { OnchainChain, OnchainEnvironment } from "./providers/onchain-types";

// IMPLEMENTED EVIDENCE ENVIRONMENTS — code-owned, static, provider-free.
//
// The exact (chain, network) pairs this codebase has a deterministic
// implementation for, and the ENV VARIABLE NAME that supplies each
// endpoint. This table answers the STATIC question "can ATLAS address
// this environment at all?" — the acquisition gates, budget planning,
// intent creation and the post-event stages consult it, so no generic
// module needs to name a chain, and a module that must import no provider
// and no retriever can still ask which environment an identity lives in.
// Whether THIS process holds an endpoint for an environment is the
// runtime registry's question (providers/onchain-retriever.ts).
//
// A pair absent from this table is unreachable — which is how D-131 is
// enforced structurally rather than by filtering later: no test network
// appears here, so no test-network endpoint can be configured even if
// someone sets a variable. And a chain the project identity admits but
// this table does not (every EVM chain except Ethereum mainnet today) has
// NO environment: such an identity produces no intent, reserves no chain
// budget and can never be routed to another chain's implementation.
//
// EXACTLY ONE PRODUCTION NETWORK PER CHAIN. That is what lets a confirmed
// identity — which names a chain and nothing more — resolve to an
// environment without any network guessing.
const IMPLEMENTED_ENVIRONMENTS: ReadonlyMap<
  string,
  { environment: OnchainEnvironment; endpointEnvVar: string }
> = new Map([
  [
    "solana/mainnet",
    {
      environment: { chain: "solana", network: "mainnet" },
      endpointEnvVar: "SOLANA_MAINNET_RPC_URL",
    },
  ],
  // Implementation #2: Ethereum mainnet, TOKEN_SUPPLY only
  // (providers/onchain-evm.ts). Listed here so an Ethereum identity admits
  // acquisition and resolves to this environment; whether a process can
  // reach it is still the runtime registry's question.
  [
    "ethereum/mainnet",
    {
      environment: { chain: "ethereum", network: "mainnet" },
      endpointEnvVar: "ETHEREUM_MAINNET_RPC_URL",
    },
  ],
]);

export function endpointEnvVarFor(chain: string, network: string): string | null {
  return IMPLEMENTED_ENVIRONMENTS.get(`${chain}/${network}`)?.endpointEnvVar ?? null;
}

// Is this exact (chain, network) one the codebase implements? Static: it
// says nothing about whether THIS process has an endpoint for it.
export function onchainEnvironmentImplemented(chain: string, network: string): boolean {
  return IMPLEMENTED_ENVIRONMENTS.has(`${chain}/${network}`);
}

// The production environment the deterministic layer can address for a
// confirmed identity's chain, or null when no implementation exists for
// that chain. Null is the honest answer for an EVM identity today: the
// caller treats it exactly as it always treated a non-Solana identity —
// no intents, no reservation, no chain read — and never substitutes
// another chain's environment.
// Every implemented environment with the env var that supplies its
// endpoint, in table order. For the capability installer, which decides
// per environment whether this deployment configured it.
export function implementedOnchainEnvironments(): { environment: OnchainEnvironment; endpointEnvVar: string }[] {
  return [...IMPLEMENTED_ENVIRONMENTS.values()].map((e) => ({
    environment: { ...e.environment },
    endpointEnvVar: e.endpointEnvVar,
  }));
}

export function onchainEnvironmentFor(chain: OnchainChain): OnchainEnvironment | null {
  for (const entry of IMPLEMENTED_ENVIRONMENTS.values()) {
    if (entry.environment.chain === chain) return { ...entry.environment };
  }
  return null;
}
