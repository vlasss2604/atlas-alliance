import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { runStructuredOnchainAcquisition, selectOnchainIntents } from "../src/server/engine/onchain-acquisition";
import {
  __setOnchainRetriever,
  onchainRetrievalAvailable,
  OnchainRetrieverUnavailableError,
  resolveOnchainRetriever,
  type OnchainRetriever,
} from "../src/server/engine/providers/onchain-retriever";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import { FORBIDDEN_ENV_KEYS } from "../src/server/engine/providers/renderer-env";
import {
  configuredOnchainEnvironments,
  installOnchainResearchCapability,
  ONCHAIN_RESEARCH_ENV,
  OnchainCapabilityUnavailableError,
  uninstallOnchainResearchCapability,
} from "../src/server/jobs/onchain-capability";
import { installRuntimeCapabilities } from "../src/server/jobs/runtime-capabilities";
import type { PhaseCapability } from "../src/server/jobs/worker-capabilities";

// EVM CAPABILITY INSTALL V1 — the runtime installer covers every
// implemented environment this deployment configured, under its exact
// (chain, network) key, with no fallback between them.
//
// Offline throughout. Production adapters are constructed from fixture
// endpoint strings and never asked to retrieve; construction opens no
// socket. The tests that install real adapters assert only on identity
// and `supports()`, which are pure.

const EXTRACT: ReadonlySet<PhaseCapability> = new Set(["SEARCH_EXTRACT"]);
const SOLANA_URL = "https://solana.example.test/v1/k3y-solana";
const ETHEREUM_URL = "https://ethereum.example.test/v1/k3y-ethereum";
const ENABLED = { [ONCHAIN_RESEARCH_ENV]: "1" };

const EVM_ADDRESS = "0x" + "ab12".repeat(10);
const SOLANA_MINT = "So11111111111111111111111111111111111111112";
const ETHEREUM_IDENTITY: ConfirmedProjectIdentity = { chain: "ethereum", tokenAddress: EVM_ADDRESS, ticker: "E" };
const SOLANA_IDENTITY: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: SOLANA_MINT, ticker: "S" };

function fixture(name: string): OnchainRetriever {
  return {
    name,
    supports: () => true,
    retrieve: async () => {
      throw new Error(`${name}: never retrieves`);
    },
  };
}

afterEach(() => {
  __setOnchainRetriever(null);
});

describe("which environments a deployment configured", () => {
  it("is decided by the presence of each allowlisted endpoint variable, never by its value", () => {
    expect(configuredOnchainEnvironments({}).map((e) => e.endpointEnvVar)).toEqual([]);
    expect(configuredOnchainEnvironments({ SOLANA_MAINNET_RPC_URL: SOLANA_URL })).toEqual([
      { environment: { chain: "solana", network: "mainnet" }, endpointEnvVar: "SOLANA_MAINNET_RPC_URL" },
    ]);
    expect(configuredOnchainEnvironments({ ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL })).toEqual([
      { environment: { chain: "ethereum", network: "mainnet" }, endpointEnvVar: "ETHEREUM_MAINNET_RPC_URL" },
    ]);
    expect(
      configuredOnchainEnvironments({ SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL }).map(
        (e) => `${e.environment.chain}/${e.environment.network}`,
      ),
    ).toEqual(["solana/mainnet", "ethereum/mainnet"]);
    // An empty value is "not configured".
    expect(configuredOnchainEnvironments({ ETHEREUM_MAINNET_RPC_URL: "" })).toEqual([]);
    // G. an unlisted environment's variable configures nothing.
    expect(configuredOnchainEnvironments({ ETHEREUM_SEPOLIA_RPC_URL: ETHEREUM_URL, BASE_MAINNET_RPC_URL: ETHEREUM_URL })).toEqual([]);
  });
});

describe("A. Solana-only configuration installs Solana exactly as before", () => {
  it("installs solana/mainnet, and nothing for ethereum", () => {
    const r = installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL },
    });
    expect(r.outcome).toBe("INSTALLED");
    expect(r.providerId).toBe("solana-mainnet-rpc");
    expect(r.installed).toEqual([{ chain: "solana", network: "mainnet", providerId: "solana-mainnet-rpc" }]);
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(true);
    expect(resolveOnchainRetriever("solana", "mainnet").name).toBe("solana-rpc:solana-mainnet-rpc");
    // D. no Ethereum URL: ethereum/mainnet remains unavailable.
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(false);
    expect(() => resolveOnchainRetriever("ethereum", "mainnet")).toThrow(OnchainRetrieverUnavailableError);
  });

  it("the flag with nothing configured still fails closed naming SOLANA_MAINNET_RPC_URL, as it always did", () => {
    expect(() => installOnchainResearchCapability({ capabilities: EXTRACT, env: { ...ENABLED } })).toThrow(
      OnchainCapabilityUnavailableError,
    );
    try {
      installOnchainResearchCapability({ capabilities: EXTRACT, env: { ...ENABLED } });
    } catch (e) {
      expect((e as OnchainCapabilityUnavailableError).envVar).toBe("SOLANA_MAINNET_RPC_URL");
      expect((e as OnchainCapabilityUnavailableError).chain).toBe("solana");
    }
    expect(onchainRetrievalAvailable()).toBe(false);
  });
});

describe("B. Ethereum-only configuration installs the ethereum/mainnet retriever", () => {
  it("installs ethereum/mainnet under its exact key, and nothing for solana", () => {
    const r = installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ...ENABLED, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
    });
    expect(r.outcome).toBe("INSTALLED");
    expect(r.providerId).toBe("ethereum-mainnet-rpc");
    expect(r.installed).toEqual([{ chain: "ethereum", network: "mainnet", providerId: "ethereum-mainnet-rpc" }]);
    const evm = resolveOnchainRetriever("ethereum", "mainnet");
    expect(evm.name).toBe("evm-rpc:ethereum-mainnet-rpc");
    expect(evm.supports("ethereum", "mainnet", "TOKEN_SUPPLY")).toBe(true);
    expect(evm.supports("ethereum", "mainnet", "ACCOUNT_INFO")).toBe(false);
    // F. a Solana identity never resolves Ethereum.
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(false);
    expect(() => resolveOnchainRetriever("solana", "mainnet")).toThrow(OnchainRetrieverUnavailableError);
    expect(evm.supports("solana", "mainnet", "TOKEN_SUPPLY")).toBe(false);
  });

  it("still requires the role and the flag — an Ethereum URL alone declares nothing", () => {
    const withoutFlag = installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
    });
    expect(withoutFlag.outcome).toBe("NOT_ENABLED");
    const wrongRole = installOnchainResearchCapability({
      capabilities: new Set<PhaseCapability>(["FETCH"]),
      env: { ...ENABLED, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
    });
    expect(wrongRole.outcome).toBe("NOT_EXTRACT_ROLE");
    expect(onchainRetrievalAvailable()).toBe(false);
  });
});

describe("C. both configured: two retrievers coexist and resolve independently", () => {
  it("installs both under their own keys; each resolves only itself", () => {
    const r = installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
    });
    expect(r.outcome).toBe("INSTALLED");
    expect(r.installed.map((i) => i.providerId)).toEqual(["solana-mainnet-rpc", "ethereum-mainnet-rpc"]);
    const solana = resolveOnchainRetriever("solana", "mainnet");
    const ethereum = resolveOnchainRetriever("ethereum", "mainnet");
    expect(solana).not.toBe(ethereum);
    expect(solana.name).toBe("solana-rpc:solana-mainnet-rpc");
    expect(ethereum.name).toBe("evm-rpc:ethereum-mainnet-rpc");
    expect(solana.supports("ethereum", "mainnet", "TOKEN_SUPPLY")).toBe(false);
    expect(ethereum.supports("solana", "mainnet", "TOKEN_SUPPLY")).toBe(false);
    // G. an unsupported network remains unavailable with both installed.
    expect(onchainRetrievalAvailable("ethereum", "sepolia" as never)).toBe(false);
    expect(onchainRetrievalAvailable("solana", "devnet" as never)).toBe(false);
    expect(() => resolveOnchainRetriever("ethereum", "sepolia" as never)).toThrow(OnchainRetrieverUnavailableError);
    // The worker's bootstrap reports the same through the shared path.
    uninstallOnchainResearchCapability();
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("through the shared runtime bootstrap, both environments install together", async () => {
    const r = await installRuntimeCapabilities({
      capabilities: new Set<PhaseCapability>(["SEARCH_EXTRACT", "FETCH"]),
      // The renderer is not declared here (no RENDERED_DOCS_ENABLED), so
      // its installer returns NOT_ENABLED without touching a browser.
      env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.renderer.outcome).toBe("NOT_ENABLED");
    expect(r.onchain.outcome).toBe("INSTALLED");
    expect(r.onchain.installed.map((i) => `${i.chain}/${i.network}`)).toEqual(["solana/mainnet", "ethereum/mainnet"]);
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(true);
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(true);
  });

  it("uninstall removes every environment, once", () => {
    installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
    });
    uninstallOnchainResearchCapability();
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(false);
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(false);
    uninstallOnchainResearchCapability();
    expect(onchainRetrievalAvailable()).toBe(false);
  });
});

describe("fail closed — a configured environment that cannot construct stops startup, and installs nothing", () => {
  it("an unacceptable Ethereum endpoint fails startup naming ETHEREUM_MAINNET_RPC_URL, and leaves Solana uninstalled too", () => {
    for (const bad of ["http://ethereum.example.test", "https://user:secret@ethereum.example.test", "not a url"]) {
      expect(() =>
        installOnchainResearchCapability({
          capabilities: EXTRACT,
          env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: bad },
        }),
      ).toThrow(OnchainCapabilityUnavailableError);
      try {
        installOnchainResearchCapability({
          capabilities: EXTRACT,
          env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: bad },
        });
      } catch (e) {
        const err = e as OnchainCapabilityUnavailableError;
        expect(err.envVar).toBe("ETHEREUM_MAINNET_RPC_URL");
        expect(err.chain).toBe("ethereum");
        // H. never the endpoint, in any field or the message.
        expect(err.message).not.toContain("ethereum.example.test");
        expect(err.message).not.toContain("secret");
        expect(err.message).not.toContain(SOLANA_URL);
      }
      // Nothing half-installed: a broken second environment does not leave
      // the first quietly serving.
      expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(false);
      expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(false);
    }
  });

  it("the create seam is asked per environment, and a null for any one of them refuses the whole installation", () => {
    const asked: string[] = [];
    expect(() =>
      installOnchainResearchCapability({
        capabilities: EXTRACT,
        env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
        create: (chain, network) => {
          asked.push(`${chain}/${network}`);
          return chain === "solana" ? fixture("solana") : null;
        },
      }),
    ).toThrow(/ethereum\/mainnet/);
    expect(asked).toEqual(["solana/mainnet", "ethereum/mainnet"]);
    expect(onchainRetrievalAvailable()).toBe(false);
  });
});

describe("E. an Ethereum identity never falls back to Solana; F. a Solana identity never resolves Ethereum", () => {
  it("E. Solana-only process: an Ethereum identity's intents take the bounded not-configured path", async () => {
    installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL },
    });
    const intents = selectOnchainIntents({
      component: "NET_EFFECT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity: ETHEREUM_IDENTITY,
      maxIntents: 2,
    });
    expect(intents.map((i) => `${i.chain}/${i.network}`)).toEqual(["ethereum/mainnet"]);
    const outcome = await runStructuredOnchainAcquisition({
      db: null as never,
      jobId: "job",
      attemptId: null,
      item: { step: 7, component: "NET_EFFECT" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: ETHEREUM_IDENTITY },
      maxSourceOpens: 24,
    });
    expect(outcome).toEqual({ evidenceIds: [], sourceOpensSpent: 0, observations: ["ONCHAIN_RETRIEVER_NOT_CONFIGURED"] });
  });

  it("F. Ethereum-only process: a Solana identity's intents take the same path, never the EVM adapter", async () => {
    installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ...ENABLED, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
    });
    const intents = selectOnchainIntents({
      component: "NET_EFFECT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity: SOLANA_IDENTITY,
      maxIntents: 2,
    });
    expect(intents.map((i) => `${i.chain}/${i.network}`)).toEqual(["solana/mainnet"]);
    const outcome = await runStructuredOnchainAcquisition({
      db: null as never,
      jobId: "job",
      attemptId: null,
      item: { step: 7, component: "NET_EFFECT" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: SOLANA_IDENTITY },
      maxSourceOpens: 24,
    });
    expect(outcome).toEqual({ evidenceIds: [], sourceOpensSpent: 0, observations: ["ONCHAIN_RETRIEVER_NOT_CONFIGURED"] });
  });
});

describe("H. endpoint values never reach diagnostics, provenance labels, or the renderer's environment", () => {
  it("the install result carries labels only, and the transport factory's label is allowlist-derived", () => {
    const r = installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { ...ENABLED, SOLANA_MAINNET_RPC_URL: SOLANA_URL, ETHEREUM_MAINNET_RPC_URL: ETHEREUM_URL },
    });
    const serialized = JSON.stringify(r);
    for (const secret of [SOLANA_URL, ETHEREUM_URL, "k3y-solana", "k3y-ethereum", "example.test"]) {
      expect(serialized).not.toContain(secret);
    }
    process.env.ETHEREUM_MAINNET_RPC_URL = ETHEREUM_URL;
    try {
      const evm = createProductionOnchainRetriever("ethereum", "mainnet");
      expect(evm?.name).toBe("evm-rpc:ethereum-mainnet-rpc");
      expect(JSON.stringify(evm)).not.toContain("example.test");
    } finally {
      delete process.env.ETHEREUM_MAINNET_RPC_URL;
    }
  });

  it("ETHEREUM_MAINNET_RPC_URL is on the renderer's forbidden-key tripwire, beside the Solana one", () => {
    expect(FORBIDDEN_ENV_KEYS).toContain("SOLANA_MAINNET_RPC_URL");
    expect(FORBIDDEN_ENV_KEYS).toContain("ETHEREUM_MAINNET_RPC_URL");
  });

  it("the installer reads presence only and never interpolates a value; the example env documents the variable empty", () => {
    const src = readFileSync("src/server/jobs/onchain-capability.ts", "utf-8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // The value is consulted for presence and length, nowhere else.
    expect(src).not.toMatch(/console\.(log|error|warn)/);
    expect(src).not.toMatch(/\$\{[^}]*endpoint[^}]*\}/i);
    const example = readFileSync(".env.local.example", "utf-8");
    expect(example).toMatch(/^ETHEREUM_MAINNET_RPC_URL=$/m);
    expect(example).toMatch(/^SOLANA_MAINNET_RPC_URL=$/m);
  });
});
