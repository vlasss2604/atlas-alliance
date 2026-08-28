import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// BOUNDARY TEST for the owner count_tokens probe — entirely static, no
// process is spawned and no network is touched. The probe's whole value
// is what it CANNOT do, so that is what gets pinned: no generation call,
// no research/documentary/on-chain module in its import graph, and no
// path by which raw provider material could reach the operator output.

async function probeSource(): Promise<string> {
  return readFile(new URL("../scripts/anthropic-count-tokens-probe.ts", import.meta.url), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("anthropic-count-tokens-probe — what it must never do", () => {
  it("makes no generation call and touches no research surface", async () => {
    const code = codeOnly(await probeSource());
    for (const banned of [
      "messages.create",
      "content-fetcher",
      "search-gateway",
      "rendered-docs",
      "onchain",
      "s4-executor",
      "createResearchJob",
      "createS4WorkExecutor",
      // No persistence of any kind: the only DB use is one config read.
      ".insert(",
      ".update(",
      ".delete(",
      "documentary-locator",
    ]) {
      expect(code.toLowerCase(), `probe references "${banned}"`).not.toContain(banned.toLowerCase());
    }
  });

  it("names no project — the probe is provider-only, not research", async () => {
    const code = codeOnly(await probeSource()).toLowerCase();
    for (const banned of ["raydium", "pump", "solscan", "docs.raydium"]) {
      expect(code, `probe mentions "${banned}"`).not.toContain(banned);
    }
  });

  it("uses the SAME production retry and classification primitives, not copies", async () => {
    const src = await probeSource();
    expect(src).toContain("retryOnceIfTransient");
    expect(src).toContain("isTransientAnthropicApiError");
    expect(src).toContain("classifyTokenCountFailure");
    // The client construction matches the extractor's exactly.
    expect(src).toContain("new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })");
    // Model id comes from product config, never a literal in the probe.
    expect(src).toContain("evidence_extractor_model");
    expect(codeOnly(src)).not.toContain("claude-haiku");
  });

  it("failure output is composed only from the closed diagnostic — the caught error is never printed", async () => {
    const code = codeOnly(await probeSource());
    // No template/concat that would interpolate the exception itself.
    for (const leak of ["e.message", "e.stack", "String(e)", "console.error(e", "console.log(e"]) {
      expect(code, `probe would print raw error via ${leak}`).not.toContain(leak);
    }
    // The API key is read for the client and existence check only.
    expect(code).not.toContain("console.log(process.env.ANTHROPIC_API_KEY");
    expect((code.match(/ANTHROPIC_API_KEY/g) ?? []).length).toBe(3); // guard + guard-msg-adjacent + client
  });
});
