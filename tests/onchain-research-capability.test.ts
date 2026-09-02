import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  installOnchainResearchCapability,
  onchainEndpointEnvVar,
  uninstallOnchainResearchCapability,
  OnchainCapabilityUnavailableError,
  ONCHAIN_RESEARCH_ENV,
} from "../src/server/jobs/onchain-capability";
import {
  __setOnchainRetriever,
  onchainRetrievalAvailable,
} from "../src/server/engine/providers/onchain-retriever";
import type { PhaseCapability } from "../src/server/jobs/worker-capabilities";

// PRODUCTION ON-CHAIN TRANSPORT — DECLARED, NEVER DISCOVERED.
//
// The whole deterministic Solana stack existed and no production process
// ever installed a retriever, so ordinary Research took the
// ONCHAIN_RETRIEVER_NOT_CONFIGURED branch on every job and every chain
// observation in this repository was made by a standalone script. These
// tests pin the installation and, more importantly, its refusals.

const EXTRACT: ReadonlySet<PhaseCapability> = new Set(["SEARCH_EXTRACT"]);
const FETCH: ReadonlySet<PhaseCapability> = new Set(["FETCH"]);

const fakeRetriever = { retrieve: async () => ({}) } as never;

afterEach(() => {
  __setOnchainRetriever(null);
});

describe("on-chain capability — disabled unless explicitly declared", () => {
  it("TEST 1: nothing is installed without the flag, whatever the role", () => {
    const r = installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: {},
      create: () => fakeRetriever,
    });
    expect(r.outcome).toBe("NOT_ENABLED");
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("the flag alone is not a licence — the ROLE decides", () => {
    // A FETCH worker on a box where the flag happens to be set installs
    // nothing: it never runs the executor that would use a retriever.
    const r = installOnchainResearchCapability({
      capabilities: FETCH,
      env: { [ONCHAIN_RESEARCH_ENV]: "1" },
      create: () => fakeRetriever,
    });
    expect(r.outcome).toBe("NOT_EXTRACT_ROLE");
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("a value other than the exact flag does not enable it", () => {
    for (const value of ["0", "true", "yes", "", " 1"]) {
      const r = installOnchainResearchCapability({
        capabilities: EXTRACT,
        env: { [ONCHAIN_RESEARCH_ENV]: value },
        create: () => fakeRetriever,
      });
      expect(r.outcome, value).toBe("NOT_ENABLED");
    }
  });

  it("TEST 2: declared on the extract role installs a retriever", () => {
    const r = installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { [ONCHAIN_RESEARCH_ENV]: "1" },
      create: () => fakeRetriever,
    });
    expect(r.outcome).toBe("INSTALLED");
    expect(r.providerId).toBe("solana-mainnet-rpc");
    expect(onchainRetrievalAvailable()).toBe(true);
  });

  it("TEST 3: production uses the EXISTING factory, with no test-only override", () => {
    const src = readFileSync("src/server/jobs/onchain-capability.ts", "utf-8");
    // The one factory, imported and called — not a new transport.
    expect(src).toContain(
      'import { createProductionOnchainRetriever } from "../engine/providers/onchain-transport"',
    );
    expect(src).toContain("createProductionOnchainRetriever(ONCHAIN_CHAIN, ONCHAIN_NETWORK)");
    // No fixture, no fallback, no second transport anywhere in the path.
    expect(src).not.toMatch(/fixture|fallback|stub|mock/i);
    // And the worker installs it before serving any queue.
    const worker = readFileSync("src/server/jobs/worker.ts", "utf-8");
    expect(worker).toContain("installOnchainResearchCapability({ capabilities })");
    expect(worker).toContain("uninstallOnchainResearchCapability()");
  });

  it("TEST 4: declared but unconstructible fails startup, loudly", () => {
    // The critical refusal. A worker that silently degraded to
    // documentary-only would make a configuration fault look exactly like
    // a project with no on-chain footprint.
    expect(() =>
      installOnchainResearchCapability({
        capabilities: EXTRACT,
        env: { [ONCHAIN_RESEARCH_ENV]: "1" },
        create: () => null,
      }),
    ).toThrow(OnchainCapabilityUnavailableError);
    // Nothing is left half-installed for a supervisor restart to inherit.
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("the failure names the env var and never the endpoint", () => {
    try {
      installOnchainResearchCapability({
        capabilities: EXTRACT,
        env: { [ONCHAIN_RESEARCH_ENV]: "1", SOLANA_MAINNET_RPC_URL: "https://secret.example/k3y" },
        create: () => null,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OnchainCapabilityUnavailableError);
      const message = (e as Error).message;
      expect(message).toContain(onchainEndpointEnvVar());
      // The endpoint can BE the credential — it must never reach an error.
      expect(message).not.toContain("secret.example");
      expect(message).not.toContain("k3y");
    }
  });

  it("uninstall removes the capability exactly once", () => {
    installOnchainResearchCapability({
      capabilities: EXTRACT,
      env: { [ONCHAIN_RESEARCH_ENV]: "1" },
      create: () => fakeRetriever,
    });
    expect(onchainRetrievalAvailable()).toBe(true);
    uninstallOnchainResearchCapability();
    expect(onchainRetrievalAvailable()).toBe(false);
    uninstallOnchainResearchCapability();
    expect(onchainRetrievalAvailable()).toBe(false);
  });
});

describe("on-chain capability — security and bounds are unchanged", () => {
  it("TEST 6: the endpoint comes from configuration, never from research input", () => {
    const capability = readFileSync("src/server/jobs/onchain-capability.ts", "utf-8");
    expect(capability).toContain('export const ONCHAIN_CHAIN = "solana"');
    expect(capability).toContain('export const ONCHAIN_NETWORK = "mainnet"');
    // Scanned over the CODE: the module's own comment explains that chain
    // observations could never become Evidence, and a ban a denial trips
    // measures documentation rather than the path. What must be absent is
    // any dynamic input reaching the endpoint decision.
    const code = capability
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const forbidden of ["evidence", "locator", "document", "fragment", "http://"]) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // The factory itself still derives the endpoint from the allowlist and
    // refuses anything that is not credential-free https.
    const transport = readFileSync(
      "src/server/engine/providers/onchain-transport.ts",
      "utf-8",
    );
    expect(transport).toContain("endpointEnvVarFor(chain, network)");
    expect(transport).toContain("isAcceptableEndpoint(endpoint)");
    const retriever = readFileSync(
      "src/server/engine/providers/onchain-retriever.ts",
      "utf-8",
    );
    expect(retriever).toContain('if (parsed.protocol !== "https:") return false;');
    expect(retriever).toContain("if (parsed.username || parsed.password) return false;");
  });

  it("TEST 5: acquisition bounds are untouched by enablement", () => {
    const acq = readFileSync("src/server/engine/onchain-acquisition.ts", "utf-8");
    expect(acq).toContain("export const MAX_ONCHAIN_INTENTS_PER_ATTEMPT = 2");
    // Every call still wins its own reservation before acting.
    expect(acq).toContain("reserveJobBudget");
    const promotion = readFileSync(
      "src/server/engine/onchain-subject-promotion.ts",
      "utf-8",
    );
    expect(promotion).toContain("export const MAX_PROMOTION_DEPTH = 3");
    expect(promotion).toContain("export const MAX_PROMOTED_INTENTS_PER_ATTEMPT = 3");
  });

  it("TEST 7 + 8: standalone scripts are untouched and no provider was added", () => {
    // The scripts build their own retriever directly and never went
    // through the capability module; enabling production changes nothing
    // about them.
    const script = readFileSync("scripts/onchain-observe-token-accounts.ts", "utf-8");
    expect(script).toContain("createProductionOnchainRetriever");
    expect(script).not.toContain("installOnchainResearchCapability");
    // No new provider module, and no new vendor in the path.
    const capability = readFileSync("src/server/jobs/onchain-capability.ts", "utf-8");
    const imports = capability.match(/^import[\s\S]*?from "[^"]+";$/gm) ?? [];
    for (const line of imports) {
      expect(line).toMatch(/from "\.\.\/engine\/providers\/onchain-(retriever|transport)"|from "\.\/worker-capabilities"/);
    }
  });

  it("a disabled deployment stays distinguishable from a project with no chain footprint", () => {
    // Not silence: the acquisition path records a closed observation on
    // the job, so "we could not look" never reads as "there is nothing".
    const acq = readFileSync("src/server/engine/onchain-acquisition.ts", "utf-8");
    expect(acq).toContain('observations: ["ONCHAIN_RETRIEVER_NOT_CONFIGURED"]');
  });
});
