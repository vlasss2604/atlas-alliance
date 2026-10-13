import { describe, expect, it } from "vitest";

// DURABLE-PROVENANCE ENTRYPOINT — structural guarantees.
//
// This is the only on-chain owner script that WRITES. Its safety argument
// is therefore about what it writes and what it cannot reach, and both are
// read from its source rather than promised in prose.
//
// The read-only sibling (onchain-token-accounts.ts) must stay provably
// read-only, which is why these are two entrypoints and not one flag.

const ENTRYPOINT = new URL("../scripts/onchain-derive-token-accounts.ts", import.meta.url);
const READONLY = new URL("../scripts/onchain-token-accounts.ts", import.meta.url);

async function sourceOf(url: URL): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(url, "utf-8");
}

async function codeOf(url: URL): Promise<string> {
  const raw = await sourceOf(url);
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("what it writes", () => {
  it("inserts into NO table directly, and needs no synthetic rows", async () => {
    const code = await codeOf(ENTRYPOINT);
    // NO direct insert at all. Artifacts and derived subjects go through the
    // shared persistence functions, and the standalone origin mode means no
    // synthetic user, job or source row is needed to satisfy a foreign key —
    // so there is nothing left for this file to insert.
    const inserts = code.match(/\.insert\(([a-zA-Z]+)\)/g) ?? [];
    expect(inserts).toEqual([]);
    expect(code).toContain("persistOnchainArtifact(");
    expect(code).toContain("persistDerivedOnchainSubjects(");
    expect(code).toContain('origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" }');
    for (const banned of ["createResearchJob", "createBoss", "EntitlementSnapshot"]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("writes NO Evidence — the fact-writing path is not imported", async () => {
    const code = await codeOf(ENTRYPOINT);
    for (const banned of [
      "persistOnchainArtifactAndFacts",
      "synthesizeOnchainFacts",
      ".insert(evidence)",
      "evidenceDocumentaryLocators",
      "persistFactLocators",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("writes NO memory, NO proof and NO route change", async () => {
    const code = await codeOf(ENTRYPOINT);
    for (const banned of [
      "projectMemoryItems",
      "researchMemory",
      "promoteProjectMemoryItem",
      "proofs",
      "SOURCE_ROUTE",
      "routeClass",
      "resolveSourceRoute",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("never updates or deletes anything", async () => {
    const code = await codeOf(ENTRYPOINT);
    for (const banned of [".update(", ".delete("]) {
      expect(code, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("persists the artifact BEFORE any derived subject", async () => {
    const raw = await sourceOf(ENTRYPOINT);
    const artifact = raw.indexOf("persistOnchainArtifact({");
    const derived = raw.indexOf("persistDerivedOnchainSubjects({");
    expect(artifact).toBeGreaterThan(-1);
    expect(derived).toBeGreaterThan(artifact);
    // And refuses to write a subject when the artifact was not stored: a
    // derived subject with no observation behind it is the one thing this
    // design must not be able to represent.
    expect(raw).toContain("if (!stored.artifactId) {");
  });

  it("supplies NO address to the persistence path", async () => {
    const code = await codeOf(ENTRYPOINT);
    // The only inputs are the artifact, its binding and the artifact row id.
    expect(code).toContain("artifactId: stored.artifactId,");
    expect(code).toContain("artifact,");
    expect(code).toContain("binding,");
    // The wallet is the QUERY subject, never a persisted derived subject.
    expect(code).not.toContain("subject: wallet,\n      derivationMethod");
  });
});

describe("what it cannot reach", () => {
  it("performs exactly ONE read, with no retry, cursor or escalation", async () => {
    const code = await codeOf(ENTRYPOINT);
    expect((code.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    expect((code.match(/createProductionOnchainRetriever\(/g) ?? []).length).toBe(1);
    for (const banned of [
      "retry",
      "attempt",
      "for (let i",
      "while (",
      "before",
      "until",
      "cursor",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "ACCOUNT_INFO",
      "getTransaction",
      "getAccountInfo",
      "getSignaturesForAddress",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("makes no model call, no search call and renders nothing", async () => {
    const code = await codeOf(ENTRYPOINT);
    for (const banned of [
      "anthropic",
      "Anthropic",
      "evidence-extractor",
      "query-proposer",
      "search-gateway",
      "brave",
      "Brave",
      "playwright",
      "rendered-docs",
      "content-fetcher",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("refuses an ineligible subject before the retriever is constructed", async () => {
    const code = await codeOf(ENTRYPOINT);
    expect(code).toContain("resolveOnchainSubject(db, {");
    const gate = code.indexOf("refusing — this address has no admitted on-chain subject provenance");
    const retriever = code.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(retriever);
  });

  it("takes the anchor from confirmed identity and the mint filter from the anchor", async () => {
    const code = await codeOf(ENTRYPOINT);
    expect(code).toContain("resolveConfirmedIdentity(");
    expect(code).toContain("const anchor = identity.tokenAddress;");
    expect(code).toContain("projectAnchor: anchor,");
  });

  it("names no project or mechanism in its executable code", async () => {
    const code = (await codeOf(ENTRYPOINT)).toLowerCase();
    for (const banned of ["solscan", "burn", "treasury", "buyback", "hyperliquid", "uniswap"]) {
      expect(code, `entrypoint mentions "${banned}"`).not.toContain(banned);
    }
    expect((code.match(/pump/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe("the read-only sibling stays read-only", () => {
  it("persists nothing at all", async () => {
    const code = await codeOf(READONLY);
    for (const banned of [
      ".insert(",
      ".update(",
      ".delete(",
      "persistOnchainArtifact",
      "persistDerivedOnchainSubjects",
      "createResearchJob",
    ]) {
      expect(code, `read-only script contains "${banned}"`).not.toContain(banned);
    }
  });

  it("the two scripts are separate files, so neither guarantee is a flag", async () => {
    expect(await sourceOf(ENTRYPOINT)).not.toBe(await sourceOf(READONLY));
    // Checked against EXECUTABLE code: the entrypoint comment explains why
    // there is no --persist flag, and prose describing the absence of a
    // thing must not read as the thing.
    const a = await codeOf(ENTRYPOINT);
    const b = await codeOf(READONLY);
    for (const flag of ["--persist", "persist=", "args.persist"]) {
      expect(a, `entrypoint has a "${flag}" mode`).not.toContain(flag);
    }
    for (const flag of ["--persist", "persist=", "args.persist"]) {
      expect(b, `read-only script has a "${flag}" mode`).not.toContain(flag);
    }
  });
});
