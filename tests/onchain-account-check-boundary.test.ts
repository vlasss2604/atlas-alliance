import { describe, expect, it } from "vitest";

// BOUNDED ACCOUNT CHARACTERIZATION — structural guarantees.
//
// This entrypoint performs a real, billable, externally-visible chain
// read. Its safety argument is entirely about what it CANNOT do, so these
// tests read its source: one intent, one read, no retry, no escalation to
// signature scanning or transaction detail, and no persistence.

const ENTRYPOINT = new URL("../scripts/onchain-account-check.ts", import.meta.url);

async function source(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(ENTRYPOINT, "utf-8");
}

async function code(): Promise<string> {
  const raw = await source();
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("account check — exactly one bounded read", () => {
  it("constructs ONE intent and performs ONE retrieval", async () => {
    const c = await code();
    expect((c.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    expect((c.match(/const intent: OnchainIntent = \{/g) ?? []).length).toBe(1);
    expect((c.match(/createProductionOnchainRetriever\(/g) ?? []).length).toBe(1);
  });

  it("uses ACCOUNT_INFO and cannot escalate to a scan or a transaction fetch", async () => {
    const c = await code();
    expect(c).toContain('kind: "ACCOUNT_INFO"');
    for (const banned of [
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "TOKEN_ACCOUNT_BALANCE",
      "TOKEN_SUPPLY",
      "getSignaturesForAddress",
      "getTransaction",
      "limit:",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("has no retry and no loop around the read", async () => {
    const c = await code();
    for (const banned of ["retry", "attempt", "for (let i", "while (", "Promise.all"]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("persists nothing — no insert, update or delete anywhere", async () => {
    const c = await code();
    for (const banned of [".insert(", ".update(", ".delete(", "onConflict", "transaction("]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("makes no model call and no search call", async () => {
    const c = await code();
    for (const banned of [
      "anthropic",
      "Anthropic",
      "evidence-extractor",
      "query-proposer",
      "search-gateway",
      "brave",
      "Brave",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("builds no Proof and enters no assembly or claim stage", async () => {
    const c = await code();
    for (const banned of ["mechanism-assembl", "claim-support", "claim-evaluator", "run-job", "controller", "s4-executor"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("renders nothing — the browser boundary is not in its graph", async () => {
    const c = await code();
    for (const banned of ["playwright", "chromium", "rendered-docs", "RENDERED_DOCS_ENABLED"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });
});

describe("account check — the subject must be documented", () => {
  it("reads the subject's provenance from admitted Evidence, not from the caller", async () => {
    const c = await code();
    // The command-line address is checked AGAINST evidence.documentary_locator;
    // an undocumented address is refused before the retriever exists.
    // The gate is the shared subject gate. Documentary provenance still
    // resolves exactly as before — the normalized locator table and the
    // legacy scalar column both answer — and a derived on-chain subject
    // is a SEPARATE class that never inherits document authority.
    // The shared subject gate: it answers for BOTH provenance classes
    // (documentary locator and derived on-chain subject) and keeps them
    // distinct. Neither class is queried by substring — equality only.
    expect(c).toContain("resolveOnchainSubject(db, {");
    expect(c).toContain("subject: address,");
    expect(c).toContain("projectAnchor: anchor,");
    expect(c).not.toContain("documentaryLocator, ");
    expect(c).not.toContain("documentaryLocator, address");
    const gate = c.indexOf("refusing — this address has no admitted on-chain subject provenance");
    const retriever = c.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(retriever);
  });

  it("takes the ANCHOR from confirmed identity, never from the command line", async () => {
    const c = await code();
    expect(c).toContain("resolveConfirmedIdentity(");
    expect(c).toContain("anchor = identity.tokenAddress");
    // The anchor and the subject are distinct by construction: the subject
    // is argv, the anchor is the confirmed mint.
    expect(c).toContain("projectAnchor: anchor");
    expect(c).toContain("subject: address");
    expect(c).toContain('subjectKind: "account"');
  });

  it("closes the database before the read, so nothing can write during it", async () => {
    const raw = await source();
    const poolEnd = raw.indexOf("pool.end()");
    const retrieve = raw.indexOf("retriever.retrieve(");
    expect(poolEnd).toBeGreaterThan(-1);
    expect(poolEnd).toBeLessThan(retrieve);
  });

  it("validates binding rather than assuming it", async () => {
    const c = await code();
    expect(c).toContain("validateOnchainBinding(");
  });

  it("names no project or mechanism in its executable code", async () => {
    const c = (await code()).toLowerCase();
    for (const banned of ["solscan", "burn", "treasury", "buyback", "hyperliquid", "uniswap"]) {
      expect(c, `entrypoint code mentions "${banned}"`).not.toContain(banned);
    }
    // pump_fun appears once, as the default project slug for owner tooling.
    expect((c.match(/pump/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});
