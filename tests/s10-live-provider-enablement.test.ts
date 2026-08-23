import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// S10 (live-provider-enablement.md, D-118) — unit-level tests for the
// building blocks that don't require live credentials or real network:
// retry policy, D-090 count-then-gate, expanded URL redaction, the
// internal-alpha gate, and the static "alpha tooling is unreachable from
// public/product runtime" boundary. Real-provider acceptance-matrix
// items that genuinely require a live Brave/Anthropic call are NOT
// exercised here — see live-provider-enablement.md §19/§23 for what
// remains a manual, owner-controlled smoke check.

import { retryOnceIfTransient } from "../src/server/engine/providers/retry";
import { redactUrl } from "../src/server/engine/trace-store";
import { createLiveS4WorkExecutor, InternalAlphaGateClosedError, INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { loadModelCostProfile } from "../src/server/engine/model-cost-profile";
import { INTERNAL_ALPHA_V1, DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";

describe("S10 §8 — retryOnceIfTransient: exactly one retry, only for a transient failure", () => {
  class TransientErr extends Error {
    transient = true;
  }
  class PermanentErr extends Error {
    transient = false;
  }

  it("succeeds on the first attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryOnceIfTransient(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a transient failure is retried exactly once — 2 total attempts, then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TransientErr("x")).mockResolvedValueOnce("ok");
    await expect(retryOnceIfTransient(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a SECOND transient failure is not retried again — 2 total attempts maximum", async () => {
    const fn = vi.fn().mockRejectedValue(new TransientErr("x"));
    await expect(retryOnceIfTransient(fn)).rejects.toThrow("x");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a non-transient (permanent) failure is never retried — 1 total attempt", async () => {
    const fn = vi.fn().mockRejectedValue(new PermanentErr("schema invalid"));
    await expect(retryOnceIfTransient(fn)).rejects.toThrow("schema invalid");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("S10 §5 — D-090 count-then-gate (token-gate.ts)", () => {
  it("exact input_tokens > maxInputTokens throws ModelInputOversizedError BEFORE any generation call", async () => {
    const { countThenGate, ModelInputOversizedError } = await import("../src/server/engine/providers/token-gate");
    const createMock = vi.fn();
    const fakeClient = {
      messages: {
        countTokens: vi.fn().mockResolvedValue({ input_tokens: 5000 }),
        create: createMock,
      },
      // Anthropic.APIError static is referenced via instanceof in the
      // catch branch — not needed on the happy/oversized path.
    } as unknown as import("@anthropic-ai/sdk").default;

    await expect(countThenGate(fakeClient, "claude-haiku-4-5", "sys", [{ role: "user", content: "hi" }], 4000)).rejects.toBeInstanceOf(
      ModelInputOversizedError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("exact input_tokens <= maxInputTokens resolves (generation may proceed)", async () => {
    const { countThenGate } = await import("../src/server/engine/providers/token-gate");
    const fakeClient = {
      messages: { countTokens: vi.fn().mockResolvedValue({ input_tokens: 10 }) },
    } as unknown as import("@anthropic-ai/sdk").default;
    await expect(countThenGate(fakeClient, "claude-haiku-4-5", "sys", [{ role: "user", content: "hi" }], 4000)).resolves.toBeUndefined();
  });

  it("count_tokens itself failing throws TokenCountUnavailableError — never falls through to generation", async () => {
    const { countThenGate, TokenCountUnavailableError } = await import("../src/server/engine/providers/token-gate");
    const fakeClient = {
      messages: { countTokens: vi.fn().mockRejectedValue(new Error("network down")) },
    } as unknown as import("@anthropic-ai/sdk").default;
    await expect(countThenGate(fakeClient, "claude-haiku-4-5", "sys", [{ role: "user", content: "hi" }], 4000)).rejects.toBeInstanceOf(
      TokenCountUnavailableError,
    );
  });
});

describe("S10 §13 — expanded URL credential redaction (pre-live hardening)", () => {
  it("redacts the newly-approved param names: auth_token/refresh_token/client_secret/password/session", () => {
    for (const name of ["auth_token", "refresh_token", "client_secret", "password", "session"]) {
      const url = `https://example.com/x?${name}=SECRET_VALUE&safe=1`;
      const redacted = redactUrl(url);
      expect(redacted).not.toContain("SECRET_VALUE");
      expect(redacted).toContain(`${name}=[REDACTED]`);
      expect(redacted).toContain("safe=1");
    }
  });

  it("redacts URL userinfo (user:password@host) without touching the host", () => {
    const url = "https://alice:hunter2@example.com/path?q=1";
    const redacted = redactUrl(url);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("alice");
    expect(redacted).toContain("example.com/path?q=1");
    expect(redacted).toContain("[REDACTED]@example.com");
  });

  it("redacts a credential-bearing URL fragment (#access_token=...)", () => {
    const url = "https://example.com/callback#access_token=SECRET_FRAGMENT&token_type=bearer";
    const redacted = redactUrl(url);
    expect(redacted).not.toContain("SECRET_FRAGMENT");
    expect(redacted).toContain("access_token=[REDACTED]");
  });

  it("does not mutate a plain search-query string with none of the sensitive shapes", () => {
    const query = "does protocol revenue reach Aave token holders?";
    expect(redactUrl(query)).toBe(query);
  });

  it("previously-approved names (api_key etc) still redact — expansion is additive", () => {
    const url = "https://example.com/x?api_key=SECRET&other=1";
    const redacted = redactUrl(url);
    expect(redacted).not.toContain("SECRET");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).toContain("other=1");
  });
});

describe("S10 §10 — internal-alpha gate: createLiveS4WorkExecutor refuses construction when internal_alpha_enabled is false", () => {
  it("throws InternalAlphaGateClosedError when internalAlphaEnabled=false — never silently falls back to anything", () => {
    expect(() =>
      createLiveS4WorkExecutor({
        db: {} as never,
        project: { id: "p", name: "Proj", slug: "proj", ticker: null },
        internalAlphaEnabled: false,
      }),
    ).toThrow(InternalAlphaGateClosedError);
  });

  it("constructs (returns a WorkExecutor) when internalAlphaEnabled=true", () => {
    const executor = createLiveS4WorkExecutor({
      db: {} as never,
      project: { id: "p", name: "Proj", slug: "proj", ticker: null },
      internalAlphaEnabled: true,
    });
    expect(typeof executor.execute).toBe("function");
  });
});

describe("S10 §10 — DEFAULT_PRODUCT_CONFIG.internal_alpha_enabled defaults to false; research_enabled stays false", () => {
  it("both public/product gates remain closed by default", () => {
    expect(DEFAULT_PRODUCT_CONFIG.internal_alpha_enabled).toBe(false);
    expect(DEFAULT_PRODUCT_CONFIG.research_enabled).toBe(false);
  });
});

describe("S10 §12 — internal-alpha live project allowlist", () => {
  it("the approved first live target (pump_fun, §18) is in the allowlist", () => {
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("pump_fun")).toBe(true);
  });

  it("an arbitrary/unapproved project slug is NOT in the allowlist", () => {
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("some_random_project")).toBe(false);
  });
});

describe("S10 §6 — INTERNAL_ALPHA_V1 is the one locked envelope, distinct from budget_core/budget_demo", () => {
  it("matches the owner-approved numbers exactly", () => {
    expect(INTERNAL_ALPHA_V1).toEqual({
      maxSearchQueries: 12,
      maxSourceOpens: 24,
      maxModelCostMicro: 2_000_000,
      maxWallClockSec: 900,
      reservedRecoverySteps: 1,
    });
  });
});

describe("S10 §3/§4 — role-qualified cost profiles resolve independently for the SAME model id", () => {
  it("QUERY_PROPOSER and EVIDENCE_EXTRACTOR both resolve claude-haiku-4-5, with different ceilings", () => {
    const qp = loadModelCostProfile("QUERY_PROPOSER", "claude-haiku-4-5");
    const ee = loadModelCostProfile("EVIDENCE_EXTRACTOR", "claude-haiku-4-5");
    expect(qp.maxInputTokens).toBe(4000);
    expect(qp.maxOutputTokens).toBe(512);
    expect(ee.maxInputTokens).toBe(48000);
    expect(ee.maxOutputTokens).toBe(1536);
  });
});

describe("S10 §15 — Interpreter tooling boundary (static): alpha-run / __setInterpreterGateway unreachable from public/product runtime", () => {
  async function allTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...(await allTsFiles(full)));
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(full);
    }
    return files;
  }

  it("no file under app/ (public Next.js routes) imports __setInterpreterGateway or scripts/alpha-run", async () => {
    const root = new URL("../app", import.meta.url).pathname;
    let files: string[] = [];
    try {
      files = await allTsFiles(root);
    } catch {
      // app/ may not exist in some checkouts — nothing to check, not a
      // false pass: absence of public routes is itself the invariant.
      return;
    }
    for (const f of files) {
      const source = await readFile(f, "utf-8");
      expect(source, f).not.toContain("__setInterpreterGateway");
      expect(source, f).not.toContain("alpha-run");
    }
  });

  it("no file under src/server/services/ (product service layer) imports __setInterpreterGateway or scripts/alpha-run", async () => {
    const root = new URL("../src/server/services", import.meta.url).pathname;
    const files = await allTsFiles(root);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const source = await readFile(f, "utf-8");
      expect(source, f).not.toContain("__setInterpreterGateway");
      expect(source, f).not.toContain("alpha-run");
    }
  });

  it("src/server/jobs/worker.ts (the real production task handler) never imports live-executor.ts or scripts", async () => {
    const source = await readFile(new URL("../src/server/jobs/worker.ts", import.meta.url), "utf-8");
    // Negative lookbehind excludes the accepted non-live-executor.ts
    // import (Stage 1's own zero-candidate fixture) — this checks for
    // live-executor.ts specifically, not the substring shared with its
    // name.
    expect(source).not.toMatch(/(?<!non-)live-executor/);
    expect(source).not.toContain("__setInterpreterGateway");
  });
});
