import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  installOnchainResearchCapability,
  onchainEndpointEnvVar,
  ONCHAIN_RESEARCH_ENV,
} from "../src/server/jobs/onchain-capability";
import {
  __setOnchainRetriever,
  onchainRetrievalAvailable,
} from "../src/server/engine/providers/onchain-retriever";
import { PHASE_CAPABILITIES } from "../src/server/jobs/worker-capabilities";

// THE ALPHA RUNNER COULD NOT REACH A CHAIN, AND NOTHING SAID SO.
//
// The worker installs the on-chain capability during startup, immediately
// before it serves any queue. `alpha-run.ts` never starts a worker — it
// drives `handleResearchJobTask` directly — so no retriever was ever
// installed for it. A --mode=live run therefore spent real search and model
// budget and then recorded ONCHAIN_RETRIEVER_NOT_CONFIGURED on every
// component that planned a chain read, producing a documentary-only answer
// that reads exactly like a finding. Observed on a real PUMP run: 19 of 24
// source opens and 39,692 micro-USD spent, zero on-chain artifacts.
//
// These tests pin the wiring and, more importantly, its REFUSALS. Nothing
// here opens a socket: the installer's own seams supply the retriever, and
// every ordering claim is read off the script's source.

const SCRIPT = readFileSync("scripts/alpha-run.ts", "utf-8");
const WORKER = readFileSync("src/server/jobs/worker.ts", "utf-8");

const fakeRetriever = { retrieve: async () => ({}) } as never;

afterEach(() => {
  __setOnchainRetriever(null);
});

describe("alpha-run installs the EXISTING capability, never a second one", () => {
  it("it calls the shared installer and constructs no retriever of its own", () => {
    expect(SCRIPT).toContain("installOnchainResearchCapability({");
    // The endpoint, the allowlist and the https/no-credential contract all
    // live in the installer. A script that reached for the factory directly
    // would be a second provider path with a second set of rules.
    expect(SCRIPT).not.toContain("createProductionOnchainRetriever");
    expect(SCRIPT).not.toContain("__setOnchainRetriever");
    expect(SCRIPT).not.toContain("SOLANA_MAINNET_RPC_URL");
  });

  it("it declares the capability set rather than reading the deployment's", () => {
    // `loadWorkerCapabilities` answers "which queues does this PROCESS
    // serve". This script runs the whole pipeline in one process, so it
    // serves every phase by construction and must not depend on a developer
    // having exported ATLAS_WORKER_CAPABILITIES.
    expect(SCRIPT).toContain("capabilities: new Set(PHASE_CAPABILITIES)");
    // Not IMPORTED — the name appears in the explanatory comment above the
    // call, which is exactly where it should appear and nowhere else.
    expect(SCRIPT).not.toMatch(/import\s*\{[^}]*loadWorkerCapabilities/);
  });

  it("the worker's own installation is untouched", () => {
    expect(WORKER).toContain("installOnchainResearchCapability({ capabilities })");
    expect(WORKER).toContain("uninstallOnchainResearchCapability");
  });
});

describe("the live pre-flight fails closed BEFORE anything is spent", () => {
  // Positions, not prose: a refusal that runs after job creation is not a
  // refusal, it is a report.
  const flagCheck = SCRIPT.indexOf(`process.env[ONCHAIN_RESEARCH_ENV] !== "1"`);
  const endpointCheck = SCRIPT.indexOf("onchainEndpointEnvVar()");
  const install = SCRIPT.indexOf("installOnchainResearchCapability({");
  const refusal = SCRIPT.indexOf("[alpha-run] refusing --mode=live — prerequisites missing:");
  const jobCreation = SCRIPT.indexOf("createResearchJob(");
  const liveExecutor = SCRIPT.indexOf("createLiveS4WorkExecutor({");
  const handler = SCRIPT.indexOf("handleResearchJobTask(");

  it("every gate exists", () => {
    for (const [name, at] of Object.entries({
      flagCheck,
      endpointCheck,
      install,
      refusal,
      jobCreation,
      liveExecutor,
      handler,
    })) {
      expect(at, name).toBeGreaterThan(-1);
    }
  });

  it("the flag and endpoint are checked before the job exists", () => {
    expect(flagCheck).toBeLessThan(jobCreation);
    expect(endpointCheck).toBeLessThan(jobCreation);
  });

  it("installation is attempted, and refused, before the job exists", () => {
    expect(install).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(jobCreation);
  });

  it("no provider that costs money is constructed before the refusal", () => {
    // The live executor is what holds Brave and Anthropic. If it were built
    // first, a missing chain capability would already have cost something.
    expect(refusal).toBeLessThan(liveExecutor);
    expect(refusal).toBeLessThan(handler);
  });

  it("a failed installation is reported as a prerequisite, not thrown", () => {
    // Declared-but-unconstructible must join the same refusal list as a
    // missing key, so the operator sees every problem at once.
    expect(SCRIPT).toContain("OnchainCapabilityUnavailableError");
    expect(SCRIPT).toContain("problems.push(e.message)");
  });
});

describe("the gate itself — exact, and not merely truthy", () => {
  it('only the literal "1" enables it', () => {
    for (const value of ["true", "TRUE", "yes", "on", "0", ""]) {
      const r = installOnchainResearchCapability({
        capabilities: new Set(PHASE_CAPABILITIES),
        env: { [ONCHAIN_RESEARCH_ENV]: value },
        create: () => fakeRetriever,
        install: () => {},
      });
      expect(r.outcome, value).toBe("NOT_ENABLED");
    }
  });

  it('"1" with the capability set alpha-run declares installs a retriever', () => {
    const r = installOnchainResearchCapability({
      capabilities: new Set(PHASE_CAPABILITIES),
      env: { [ONCHAIN_RESEARCH_ENV]: "1" },
      create: () => fakeRetriever,
    });
    expect(r.outcome).toBe("INSTALLED");
    expect(r.providerId).toBe("solana-mainnet-rpc");
    expect(onchainRetrievalAvailable()).toBe(true);
  });

  it("declared but unconstructible refuses, naming the env var and never an endpoint", () => {
    expect(() =>
      installOnchainResearchCapability({
        capabilities: new Set(PHASE_CAPABILITIES),
        env: { [ONCHAIN_RESEARCH_ENV]: "1" },
        create: () => null,
        install: () => {},
      }),
    ).toThrowError(new RegExp(onchainEndpointEnvVar()));
    expect(onchainRetrievalAvailable()).toBe(false);
  });
});

describe("the flag is documented where an operator will look", () => {
  const EXAMPLE = readFileSync(".env.local.example", "utf-8");

  it("the example names it, states the exact value, and carries no secret", () => {
    expect(EXAMPLE).toContain(`${ONCHAIN_RESEARCH_ENV}=`);
    // The trap that produced the invalid run: "true" looks enabled and is not.
    expect(EXAMPLE).toContain('including "true"');
    // Declared as empty — a value here would be a committed configuration.
    expect(EXAMPLE).toMatch(new RegExp(`^${ONCHAIN_RESEARCH_ENV}=$`, "m"));
  });
});
