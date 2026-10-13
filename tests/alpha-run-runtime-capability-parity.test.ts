import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { installRuntimeCapabilities } from "../src/server/jobs/runtime-capabilities";
import { ONCHAIN_RESEARCH_ENV } from "../src/server/jobs/onchain-capability";
import { RENDERED_DOCS_ENV } from "../src/server/jobs/renderer-capability";
import { PHASE_CAPABILITIES } from "../src/server/jobs/worker-capabilities";
import {
  __setOnchainRetriever,
  onchainRetrievalAvailable,
} from "../src/server/engine/providers/onchain-retriever";
import {
  __setRenderedDocsFetcher,
  renderedDocsAvailable,
} from "../src/server/engine/providers/rendered-docs-fetcher";

// A CAPABILITY LIST CAN BE SHORT, AND A SHORT ONE FAILS SILENTLY.
//
// `alpha-run` drives the real task handler without the worker's startup,
// so every capability the worker installs had to be remembered there by
// hand. Twice it was not. The on-chain retriever was missing first — a
// live run reached the chain branch, found nothing, and answered from
// documents after spending real budget. The renderer was missing second,
// and would have failed identically: enabled, browser starting fine,
// `renderedDocsAvailable()` false, the oversized-document chain reaching
// negotiation and never the render.
//
// These tests pin the shared bootstrap and, most importantly, the GENERIC
// guard: a capability module that this bootstrap does not know about fails
// the suite rather than a paid run. Nothing here opens a socket or starts
// a browser — every decision is driven through the installers' own seams.

const WORKER = readFileSync("src/server/jobs/worker.ts", "utf-8");
const ALPHA = readFileSync("scripts/alpha-run.ts", "utf-8");
const BOOTSTRAP = readFileSync("src/server/jobs/runtime-capabilities.ts", "utf-8");

const ALL_PHASES = new Set(PHASE_CAPABILITIES);
const fakeRetriever = { retrieve: async () => ({}) } as never;
const fakeRenderer = { render: async () => ({}) } as never;

// A minimal environment, and the installers' own seams. No browser is
// started and no transport is constructed: what is under test is the
// WIRING, and each installer's own suite already covers its decisions.
const env = (vars: Record<string, string>): NodeJS.ProcessEnv =>
  vars as unknown as NodeJS.ProcessEnv;
const SEAMS = {
  renderer: {
    selfTest: async () => ({
      ok: true,
      browserVersion: "fixture",
      reason: null,
      diagnostic: null,
      proxyDenials: null,
      durationMs: 0,
    }),
    create: () => fakeRenderer,
  },
  onchain: { create: () => fakeRetriever },
};

afterEach(() => {
  __setOnchainRetriever(null);
  __setRenderedDocsFetcher(null);
});

describe("1/2. the bootstrap installs BOTH capabilities when both are declared", () => {
  it("renderer installs when its flag is set, and becomes available", async () => {
    expect(renderedDocsAvailable()).toBe(false);
    const r = await installRuntimeCapabilities({
      capabilities: ALL_PHASES,
      env: env({ [RENDERED_DOCS_ENV]: "1" }),
      ...SEAMS,
    });
    expect(r.renderer.outcome).toBe("INSTALLED");
    expect(renderedDocsAvailable()).toBe(true);
  });

  it("on-chain installs when its flag is set, and becomes available", async () => {
    expect(onchainRetrievalAvailable()).toBe(false);
    const r = await installRuntimeCapabilities({
      capabilities: ALL_PHASES,
      env: env({ [ONCHAIN_RESEARCH_ENV]: "1" }),
      ...SEAMS,
    });
    expect(r.onchain.outcome).toBe("INSTALLED");
    expect(onchainRetrievalAvailable()).toBe(true);
  });

  it("both together — the exact state alpha-run needs before it spends", async () => {
    const r = await installRuntimeCapabilities({
      capabilities: ALL_PHASES,
      env: env({
        [RENDERED_DOCS_ENV]: "1",
        [ONCHAIN_RESEARCH_ENV]: "1",
      }),
      ...SEAMS,
    });
    expect(r.renderer.outcome).toBe("INSTALLED");
    expect(r.onchain.outcome).toBe("INSTALLED");
    expect(renderedDocsAvailable()).toBe(true);
    expect(onchainRetrievalAvailable()).toBe(true);
  });

  it("neither is granted without its own flag — declaring one never declares the other", async () => {
    const r = await installRuntimeCapabilities({
      capabilities: ALL_PHASES,
      env: env({ [ONCHAIN_RESEARCH_ENV]: "1" }),
      ...SEAMS,
    });
    expect(r.onchain.outcome).toBe("INSTALLED");
    expect(r.renderer.outcome).toBe("NOT_ENABLED");
    expect(renderedDocsAvailable()).toBe(false);
  });
});

describe("3/4. failure refuses before the job exists or a provider is built", () => {
  // Source positions: a refusal after job creation is a report, not a refusal.
  const preflight = ALPHA.indexOf("installRuntimeCapabilities({");
  const refusal = ALPHA.indexOf("[alpha-run] refusing --mode=live — prerequisites missing:");
  const jobCreation = ALPHA.indexOf("createResearchJob(");
  const liveExecutor = ALPHA.indexOf("createLiveS4WorkExecutor({");
  const handler = ALPHA.indexOf("handleResearchJobTask(");

  it("every marker exists", () => {
    for (const [name, at] of Object.entries({
      preflight,
      refusal,
      jobCreation,
      liveExecutor,
      handler,
    })) {
      expect(at, name).toBeGreaterThan(-1);
    }
  });

  it("installation and its refusal both precede job creation and every paid provider", () => {
    expect(preflight).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(jobCreation);
    // The live executor is what holds Brave and Anthropic.
    expect(refusal).toBeLessThan(liveExecutor);
    expect(refusal).toBeLessThan(handler);
  });

  it("3: a declared renderer that does not install is a refusal, not a downgrade", () => {
    expect(ALPHA).toContain(`process.env[RENDERED_DOCS_ENV] === "1"`);
    expect(ALPHA).toContain("did not install");
    expect(ALPHA).toContain("RendererCapabilityUnavailableError");
  });

  it("4: a declared-but-unconstructible retriever still refuses", () => {
    expect(ALPHA).toContain("OnchainCapabilityUnavailableError");
    expect(ALPHA).toContain("problems.push(e.message)");
  });
});

describe("5/6. one bootstrap, one construction, worker unchanged in behaviour", () => {
  it("5: the worker installs through the same bootstrap", () => {
    expect(WORKER).toContain("installRuntimeCapabilities({ capabilities })");
    expect(WORKER).toContain('console.log("[worker] renderer capability:", renderer.outcome);');
    expect(WORKER).toContain("uninstallRendererCapability");
    expect(WORKER).toContain("uninstallOnchainResearchCapability");
  });

  it("6: neither caller constructs a provider or calls an installer directly", () => {
    for (const [name, src] of Object.entries({ WORKER, ALPHA })) {
      // Word-bounded: `uninstallOnchainResearchCapability` legitimately
      // contains the installer's name and is the shutdown path, which both
      // callers keep.
      expect(src, name).not.toMatch(/(?<![A-Za-z])installFetchRendererCapability\(/);
      expect(src, name).not.toMatch(/(?<![A-Za-z])installOnchainResearchCapability\(/);
      expect(src, name).not.toContain("createProductionOnchainRetriever");
      expect(src, name).not.toContain("__setRenderedDocsFetcher");
      expect(src, name).not.toContain("__setOnchainRetriever");
    }
  });
});

describe("7. THE PARITY GUARD — a new capability cannot be forgotten", () => {
  // Every module in jobs/ whose job is to install a runtime capability.
  // Derived from the directory, never listed here, so a capability added
  // later is discovered rather than remembered.
  const capabilityModules = readdirSync("src/server/jobs")
    .filter((f) => f.endsWith("-capability.ts"))
    .map((f) => ({
      file: f,
      installers: [
        ...readFileSync(`src/server/jobs/${f}`, "utf-8").matchAll(
          /export (?:async )?function (install\w+)\(/g,
        ),
      ].map((m) => m[1]),
    }))
    .filter((m) => m.installers.length > 0);

  it("the directory really does declare capability installers", () => {
    expect(capabilityModules.length).toBeGreaterThanOrEqual(2);
  });

  it("the bootstrap knows every capability installer that exists", () => {
    for (const mod of capabilityModules) {
      for (const installer of mod.installers) {
        // If this fails, a capability module was added and the bootstrap
        // was not told — which is exactly how alpha-run silently lost the
        // renderer. Add it to runtime-capabilities.ts.
        expect(BOOTSTRAP, `${mod.file} -> ${installer}`).toContain(installer);
      }
    }
  });

  it("and every caller reaches them only through the bootstrap", () => {
    for (const [name, src] of Object.entries({ WORKER, ALPHA })) {
      expect(src, name).toContain("installRuntimeCapabilities");
      for (const mod of capabilityModules) {
        for (const installer of mod.installers) {
          // Word-bounded so the matching `uninstall...` shutdown call,
          // which both callers legitimately keep, is not mistaken for a
          // direct installation.
          expect(src, `${name} calls ${installer} directly`).not.toMatch(
            new RegExp(`(?<![A-Za-z])${installer}\\(`),
          );
        }
      }
    }
  });
});

describe("8. no network, no browser, no provider", () => {
  it("the bootstrap itself contains no transport, endpoint or provider name", () => {
    for (const banned of ["http://", "https://", "fetch(", "chromium", "SOLANA_MAINNET_RPC_URL"]) {
      expect(BOOTSTRAP, banned).not.toContain(banned);
    }
  });

  it("it decides nothing the installers decide — no flag or role test of its own", () => {
    expect(BOOTSTRAP).not.toContain('=== "1"');
    expect(BOOTSTRAP).not.toContain("workerServesPhase");
  });
});
