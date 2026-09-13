import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { endpointEnvVarFor } from "../src/server/engine/onchain-environment";
import {
  __setOnchainRetriever,
  onchainRetrievalAvailable,
  type OnchainRetriever,
} from "../src/server/engine/providers/onchain-retriever";
import {
  installOnchainResearchCapability,
  onchainEndpointEnvVar,
  ONCHAIN_RESEARCH_ENV,
} from "../src/server/jobs/onchain-capability";
import { PHASE_CAPABILITIES } from "../src/server/jobs/worker-capabilities";
import { onchainPreflightRequirement, onchainPreflightVerdict } from "../scripts/alpha-run";

// ALPHA RUN ENVIRONMENT PREFLIGHT FIX V1.
//
// The live pre-flight required the installer's DEFAULT environment's
// endpoint — a Solana variable — whatever chain the project's confirmed
// identity named. An Ethereum project therefore needed a Solana RPC
// endpoint merely to pass pre-flight, and "both configured" hid it.
//
// The pre-flight now asks for the project's OWN evidence environment,
// through the same registry and env-var table the engine resolves intents
// with. These tests drive the two pure helpers with the REAL installer and
// the REAL retriever registry (fixture retrievers, zero network), and pin
// that no chain, variable or project is named in the script itself.

const SCRIPT = readFileSync("scripts/alpha-run.ts", "utf-8");

const ETH_VAR = endpointEnvVarFor("ethereum", "mainnet")!;
const SOL_VAR = endpointEnvVarFor("solana", "mainnet")!;

const ETHEREUM: ConfirmedProjectIdentity = { chain: "ethereum", tokenAddress: "0x" + "ab12".repeat(10), ticker: "E" };
const SOLANA: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: "So11111111111111111111111111111111111111112", ticker: "S" };

afterEach(() => {
  __setOnchainRetriever(null);
});

function fixture(chain: string, network: string): OnchainRetriever {
  return {
    name: `fixture:${chain}/${network}`,
    supports: (c, n) => c === chain && n === network,
    retrieve: async () => {
      throw new Error("fixture: never called by pre-flight");
    },
  };
}

// The pre-flight as the script composes it: the endpoint gate for the
// project's own variable, then the shared installer over every configured
// variable, then the verdict against what was actually installed.
function preflight(identity: ConfirmedProjectIdentity | null, configured: Record<string, string>) {
  const requirement = onchainPreflightRequirement(identity);
  if (!configured[requirement.endpointEnvVar]) {
    return { stage: "endpoint" as const, requirement, problem: `${requirement.endpointEnvVar} is not set` };
  }
  const installed = installOnchainResearchCapability({
    capabilities: new Set(PHASE_CAPABILITIES),
    env: { [ONCHAIN_RESEARCH_ENV]: "1", ...configured },
    create: (chain, network) => fixture(chain, network),
  });
  return { stage: "verdict" as const, requirement, installed, verdict: onchainPreflightVerdict(requirement, installed) };
}

describe("the requirement is the project's own environment, from the canonical registry", () => {
  it("an Ethereum identity requires Ethereum's variable; a Solana identity requires Solana's", () => {
    expect(onchainPreflightRequirement(ETHEREUM)).toEqual({
      environment: { chain: "ethereum", network: "mainnet" },
      endpointEnvVar: ETH_VAR,
    });
    expect(onchainPreflightRequirement(SOLANA)).toEqual({
      environment: { chain: "solana", network: "mainnet" },
      endpointEnvVar: SOL_VAR,
    });
    expect(ETH_VAR).not.toBe(SOL_VAR);
  });

  it("no confirmed identity keeps the existing default-environment requirement, unchanged", () => {
    expect(onchainPreflightRequirement(null)).toEqual({ environment: null, endpointEnvVar: onchainEndpointEnvVar() });
  });

  it("a supported chain with no implemented environment admits no chain read, so it takes the same default path — never another chain's", () => {
    const bsc = { chain: "bsc", tokenAddress: "0x" + "cd34".repeat(10), ticker: "B" } as unknown as ConfirmedProjectIdentity;
    expect(onchainPreflightRequirement(bsc)).toEqual({ environment: null, endpointEnvVar: onchainEndpointEnvVar() });
  });
});

describe("the seven scenarios, against the real installer and the real registry", () => {
  it("1. Ethereum project + Ethereum RPC only → passes, for ethereum/mainnet", () => {
    const r = preflight(ETHEREUM, { [ETH_VAR]: "https://eth.example/rpc" });
    expect(r.stage).toBe("verdict");
    if (r.stage !== "verdict") return;
    expect(r.verdict).toEqual({ ok: true, providerId: "ethereum-mainnet-rpc", environment: "ethereum/mainnet" });
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(true);
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(false);
  });

  it("2. Ethereum project + Solana RPC only → fails closed naming the missing Ethereum variable, before anything installs", () => {
    const r = preflight(ETHEREUM, { [SOL_VAR]: "https://sol.example/rpc" });
    expect(r.stage).toBe("endpoint");
    expect(r.problem).toBe(`${ETH_VAR} is not set`);
    expect(r.problem).not.toContain(SOL_VAR);
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("3. Solana project + Solana RPC only → the existing behaviour passes, for solana/mainnet", () => {
    const r = preflight(SOLANA, { [SOL_VAR]: "https://sol.example/rpc" });
    expect(r.stage).toBe("verdict");
    if (r.stage !== "verdict") return;
    expect(r.verdict).toEqual({ ok: true, providerId: "solana-mainnet-rpc", environment: "solana/mainnet" });
  });

  it("4. Solana project + Ethereum RPC only → fails closed naming the missing Solana variable", () => {
    const r = preflight(SOLANA, { [ETH_VAR]: "https://eth.example/rpc" });
    expect(r.stage).toBe("endpoint");
    expect(r.problem).toBe(`${SOL_VAR} is not set`);
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("5. both configured → each project is answered by its own environment, and neither requires the other's", () => {
    const both = { [ETH_VAR]: "https://eth.example/rpc", [SOL_VAR]: "https://sol.example/rpc" };
    const eth = preflight(ETHEREUM, both);
    expect(eth.stage).toBe("verdict");
    if (eth.stage === "verdict") {
      expect(eth.installed.installed.map((e) => `${e.chain}/${e.network}`).sort()).toEqual(["ethereum/mainnet", "solana/mainnet"]);
      expect(eth.verdict).toEqual({ ok: true, providerId: "ethereum-mainnet-rpc", environment: "ethereum/mainnet" });
    }
    __setOnchainRetriever(null);
    const sol = preflight(SOLANA, both);
    expect(sol.stage).toBe("verdict");
    if (sol.stage === "verdict") {
      expect(sol.verdict).toEqual({ ok: true, providerId: "solana-mainnet-rpc", environment: "solana/mainnet" });
    }
  });

  it("6. no cross-chain fallback: a process that installed only the other chain is refused, and the registry — not the label list — is authoritative", () => {
    // Installed for Solana only, asked for Ethereum: refused, naming the
    // variable that would fix it and stating that no substitute is used.
    const installed = installOnchainResearchCapability({
      capabilities: new Set(PHASE_CAPABILITIES),
      env: { [ONCHAIN_RESEARCH_ENV]: "1", [SOL_VAR]: "https://sol.example/rpc" },
      create: (chain, network) => fixture(chain, network),
    });
    const refused = onchainPreflightVerdict(onchainPreflightRequirement(ETHEREUM), installed);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.problem).toContain("solana/mainnet");
      expect(refused.problem).toContain("ethereum/mainnet");
      expect(refused.problem).toContain(ETH_VAR);
      expect(refused.problem).toContain("never used in its place");
    }
    // Even a label list that CLAIMS the environment does not pass if the
    // registry cannot resolve it.
    const claimed = {
      ...installed,
      installed: [...installed.installed, { chain: "ethereum", network: "mainnet", providerId: "ethereum-mainnet-rpc" }],
    };
    const stillRefused = onchainPreflightVerdict(onchainPreflightRequirement(ETHEREUM), claimed, () => false);
    expect(stillRefused.ok).toBe(false);
    // And an installer that did not install at all is a problem for every project.
    const none = onchainPreflightVerdict(onchainPreflightRequirement(ETHEREUM), { outcome: "NOT_ENABLED", providerId: null, installed: [] });
    expect(none).toEqual({ ok: false, problem: "on-chain capability did not install (outcome: NOT_ENABLED)" });
  });

  it("no identity + default configuration → the unchanged default verdict", () => {
    const r = preflight(null, { [SOL_VAR]: "https://sol.example/rpc" });
    expect(r.stage).toBe("verdict");
    if (r.stage === "verdict") expect(r.verdict).toEqual({ ok: true, providerId: "solana-mainnet-rpc", environment: "(default)" });
  });
});

describe("7. no project-specific and no chain-specific logic in the script", () => {
  const helpers = SCRIPT.slice(SCRIPT.indexOf("export function onchainPreflightRequirement"), SCRIPT.indexOf("async function main()"));

  it("the helpers name no chain, no network, no variable and no project", () => {
    expect(helpers.length).toBeGreaterThan(0);
    for (const forbidden of ['"solana"', '"ethereum"', '"mainnet"', "RPC_URL", "lido", "pump_fun", "SOLANA", "ETHEREUM"]) {
      expect(helpers, forbidden).not.toContain(forbidden);
    }
    // The whole script still names no endpoint variable.
    expect(SCRIPT).not.toContain(ETH_VAR);
    expect(SCRIPT).not.toContain(SOL_VAR);
  });

  it("the literal default-environment endpoint gate is gone from the live block; the identity is read before the gate and before the job exists", () => {
    expect(SCRIPT).not.toContain("process.env[onchainEndpointEnvVar()]");
    const identityRead = SCRIPT.indexOf("resolveConfirmedIdentity(db,");
    const flagCheck = SCRIPT.indexOf(`process.env[ONCHAIN_RESEARCH_ENV] !== "1"`);
    const endpointGate = SCRIPT.indexOf("process.env[requirement.endpointEnvVar]");
    const install = SCRIPT.indexOf("installRuntimeCapabilities({");
    const verdict = SCRIPT.indexOf("onchainPreflightVerdict(requirement, installed.onchain)");
    const jobCreation = SCRIPT.indexOf("createResearchJob(");
    for (const [name, at] of Object.entries({ identityRead, flagCheck, endpointGate, install, verdict, jobCreation })) {
      expect(at, name).toBeGreaterThan(-1);
    }
    expect(identityRead).toBeLessThan(flagCheck);
    expect(flagCheck).toBeLessThan(endpointGate);
    expect(endpointGate).toBeLessThan(install);
    expect(install).toBeLessThan(verdict);
    expect(verdict).toBeLessThan(jobCreation);
  });

  it("the installer's own default environment is untouched — worker startup semantics are not this script's to change", () => {
    const capability = readFileSync("src/server/jobs/onchain-capability.ts", "utf-8");
    expect(capability).toContain('export const ONCHAIN_CHAIN = "solana"');
    expect(capability).toContain('export const ONCHAIN_NETWORK = "mainnet"');
  });
});
