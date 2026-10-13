import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import type { OnchainArtifact } from "../src/server/engine/providers/onchain-types";

// BOUNDED PERSISTING TOKEN-ACCOUNT OBSERVATION — structural guarantees.
//
// This entrypoint performs a real, billable, externally-visible chain read
// AND writes Evidence. Its safety argument is three-sided: what it cannot do
// (one intent, one read, no retry, no follow-up), what it cannot author
// (every Evidence property comes from production), and what an EMPTY answer
// may never become (an economic negative).

const ENTRYPOINT = new URL("../scripts/onchain-observe-token-accounts.ts", import.meta.url);

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

function artifactWith(accounts: unknown[], slot = 442446081): OnchainArtifact {
  return {
    canonicalUri: "atlas-onchain://solana/mainnet/project/MINT/account/OWNER/token-accounts",
    normalizedText: "",
    result: { kind: "TOKEN_ACCOUNTS_BY_OWNER", owner: "OWNER", mint: "MINT", accounts },
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: "MINT",
      subject: "OWNER",
      slot,
      finality: "finalized",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTokenAccountsByOwner",
      retrievedAt: new Date("2026-08-29T00:00:00.000Z"),
      rawResponseHash: "sha256:raw",
      artifactHash: "sha256:artifact",
    },
  } as unknown as OnchainArtifact;
}

describe("observe-token-accounts — exactly one bounded read (items 5-13)", () => {
  it("5/6. ONE intent, ONE retrieval, ONE retriever; the intent kind is a constant", async () => {
    const c = await code();
    expect((c.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    expect((c.match(/const intent: OnchainIntent = \{/g) ?? []).length).toBe(1);
    expect((c.match(/createProductionOnchainRetriever\(/g) ?? []).length).toBe(1);
    expect(c).toContain('const INTENT_KIND = "TOKEN_ACCOUNTS_BY_OWNER" as const');
    expect(c).toContain("kind: INTENT_KIND");
  });

  it("7/8. no retry, no loop around the read, no pagination cursor", async () => {
    const c = await code();
    for (const banned of ["retry", "attempt", "for (let i", "while (", "Promise.all", "cursor", "before:", "until:", "limit:"]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("9/10/11. issues no ACCOUNT_INFO, no history, no signatures, no transaction fetch", async () => {
    const c = await code();
    // ACCOUNT_INFO appears ONLY as the name of the persisted prerequisite it
    // reads from the database — never as an intent it constructs.
    expect(c).toContain('const PREREQUISITE_KIND = "ACCOUNT_INFO" as const');
    expect(c).not.toContain('kind: "ACCOUNT_INFO"');
    for (const banned of [
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "TOKEN_ACCOUNT_BALANCE",
      "TOKEN_SUPPLY",
      "getSignaturesForAddress",
      "getTransaction",
      "getAccountInfo",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("12. returned accounts trigger NO follow-up live read and NO promotion", async () => {
    const c = await code();
    for (const banned of ["onchain-subject-promotion", "intentForPromotedSubject", "PromotedSubject", "promoteSubjects"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
    // The single retrieval precedes derived-subject persistence, and there
    // is no second retrieval anywhere after it.
    const retrieve = c.indexOf("retriever.retrieve(");
    const derive = c.indexOf("persistDerivedOnchainSubjects(");
    expect(retrieve).toBeGreaterThan(-1);
    expect(derive).toBeGreaterThan(retrieve);
    expect(c.slice(derive).includes("retriever.retrieve(")).toBe(false);
  });

  it("13/14/15/16. no other locators, no search, no docs fetch, no model call, no renderer", async () => {
    const c = await code();
    for (const banned of [
      "admittedLocatorsForJob",
      "findAdmittedLocator",
      "eligibleSubjects",
      "selectOnchainIntents",
      "anthropic",
      "Anthropic",
      "evidence-extractor",
      "query-proposer",
      "search-gateway",
      "brave",
      "Brave",
      "content-fetcher",
      "acquired_documents",
      "playwright",
      "chromium",
      "rendered-docs",
      "s4-executor",
      "runStructuredOnchainAcquisition",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });
});

describe("observe-token-accounts — fail-closed gates (items 1-4, 29)", () => {
  it("1. the subject must be admitted, and the gate runs BEFORE the retriever exists", async () => {
    const c = await code();
    expect(c).toContain("resolveOnchainSubject(db, {");
    const gate = c.indexOf("refusing — this address has no admitted on-chain subject provenance");
    const retriever = c.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(retriever);
  });

  it("2/3. identity is required and is the ONLY source of the mint", async () => {
    const c = await code();
    expect(c).toContain("resolveConfirmedIdentity(");
    expect(c).toContain("anchor = identity.tokenAddress");
    expect(c).toContain("no ACTIVE PROJECT_IDENTITY");
    expect(c).toContain("not solana");
    // The mint travels as projectAnchor; there is no mint argument at all.
    expect(c).toContain("projectAnchor: anchor");
    expect(c).toContain("const [address, slug, component, stepRaw, ...rest] = process.argv.slice(2)");
    expect(c).not.toContain("mint = process.argv");
    expect(c).not.toContain("mint: process.argv");
  });

  it("4. the promoted-intent precondition is enforced from PERSISTED state, before the read", async () => {
    const c = await code();
    // A stored ACCOUNT_INFO artifact for this exact subject AND anchor whose
    // normalized result established NOT_TOKEN_PROGRAM_OWNED.
    expect(c).toContain("eq(onchainArtifacts.subject, address)");
    expect(c).toContain("eq(onchainArtifacts.projectAnchor, anchor)");
    expect(c).toContain("eq(onchainArtifacts.intentKind, PREREQUISITE_KIND)");
    expect(c).toContain('r.tokenAccountRelation === "NOT_TOKEN_PROGRAM_OWNED"');
    expect(c).toContain("if (!qualifies)");
    const gate = c.indexOf("if (!qualifies)");
    const retriever = c.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeLessThan(retriever);
  });

  it("29. malformed, missing or extra CLI arguments fail closed", async () => {
    const c = await code();
    expect(c).toContain("rest.length > 0");
    expect(c).toContain("!Number.isInteger(step) || step < 1 || step > 8");
    expect(c).toContain("unknown component");
    expect(c).toContain("INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(slug)");
    expect(c).toContain("internal_alpha_enabled");
    expect(c).toContain('establishingClasses.includes("ONCHAIN_VERIFIABLE")');
    // The Pattern really does gate this way.
    expect(componentRequirementsFor(PATTERN_V1_CONTENT, "DESTINATION").establishingClasses).toContain(
      "ONCHAIN_VERIFIABLE",
    );
    expect(componentRequirementsFor(PATTERN_V1_CONTENT, "MECHANISM_SPEC").establishingClasses).not.toContain(
      "ONCHAIN_VERIFIABLE",
    );
  });

  it("18. binding is validated before persistence", async () => {
    const c = await code();
    const binding = c.indexOf("validateOnchainBinding(");
    const persist = c.indexOf("persistOnchainArtifactAndFacts(");
    expect(binding).toBeGreaterThan(-1);
    expect(binding).toBeLessThan(persist);
  });
});

describe("observe-token-accounts — persistence is the production path (items 17, 19-24)", () => {
  it("19/20/21/22. ONE production call writes artifact + facts + Evidence; nothing is hand-authored", async () => {
    const c = await code();
    expect((c.match(/persistOnchainArtifactAndFacts\(/g) ?? []).length).toBe(1);
    expect(c).not.toContain(".insert(evidence)");
    expect(c).not.toContain(".insert(onchainArtifacts)");
    expect(c).not.toContain(".insert(onchainDerivedSubjects)");
    expect((c.match(/\.insert\(/g) ?? []).length).toBe(1);
    expect(c).toContain(".insert(users)");
    const authored = c
      .split("\n")
      .filter((l) => !l.trim().startsWith("console."))
      .join("\n");
    for (const banned of [
      'sourceClass: "',
      'officiality: "',
      'entityBinding: "',
      'relationship: "',
      'directness: "',
      "summary: `",
      'summary: "',
      "statement: `",
      'statement: "',
      "doesNotProve: `",
      'doesNotProve: "',
    ]) {
      expect(authored, `entrypoint authors "${banned}"`).not.toContain(banned);
    }
    // It never calls the synthesizer directly — the production persistence
    // path does, so facts and Evidence cannot diverge.
    expect(c).not.toContain("synthesizeOnchainFacts(");
    // Two legitimate mentions of the class only: the Pattern gate and the
    // refusal message naming it. Never an assignment.
    expect((authored.match(/ONCHAIN_VERIFIABLE/g) ?? []).length).toBe(2);
    expect(authored).not.toContain("CLAIMED");
  });

  it("17/18. a failed read or a refused artifact writes no Evidence, no derived subject, no reconciliation", async () => {
    const c = await code();
    const retrieve = c.indexOf("retriever.retrieve(");
    const persist = c.indexOf("persistOnchainArtifactAndFacts(");
    expect(retrieve).toBeLessThan(persist);
    expect(c).toContain("stored.rejectedReason !== null || !stored.artifactId");
    const refusal = c.indexOf("no Evidence written, no derived subject, no reconciliation run");
    const derive = c.indexOf("persistDerivedOnchainSubjects(");
    const reconcile = c.indexOf("reconcileAndPersistComponent(");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(derive);
    expect(refusal).toBeLessThan(reconcile);
  });

  it("24. reconciliation runs exactly once, after persistence, scoped to this job", async () => {
    const c = await code();
    expect((c.match(/reconcileAndPersistComponent\(/g) ?? []).length).toBe(1);
    expect(c).toContain("reconcileAndPersistComponent(db, jobId, { step, component }, new Date())");
    const persist = c.indexOf("persistOnchainArtifactAndFacts(");
    const reconcile = c.indexOf("reconcileAndPersistComponent(");
    expect(persist).toBeLessThan(reconcile);
  });

  it("the owner job it creates is truthful and claims no document, search or model", async () => {
    const c = await code();
    expect(c).toContain("createResearchJob(");
    expect(c).toContain("skipEnqueue: true");
    expect(c).toContain("observe token accounts owned by");
    expect(c).toContain("maxSearchQueries: 0");
    expect(c).toContain("maxModelCostMicro: 0");
    const question = c.slice(c.indexOf("originalQuestion:"), c.indexOf("normalizedTaskHash:")).toLowerCase();
    for (const banned of ["documentary", "search", "fetch", "model", "acquired document"]) {
      expect(question, `job description claims "${banned}"`).not.toContain(banned);
    }
  });
});

describe("observe-token-accounts — derived subjects are recorded, never chased (item 27)", () => {
  it("27. reuses the existing bounded derivation path and reads nothing from it", async () => {
    const c = await code();
    expect((c.match(/persistDerivedOnchainSubjects\(/g) ?? []).length).toBe(1);
    // No new derivation mechanism, and no read of what it recorded.
    expect(c).not.toContain("derivationMethod:");
    expect(c).not.toContain("subjectKind: \"TOKEN_ACCOUNT\"");
    // Nothing after derivation issues another retrieval.
    const derive = c.indexOf("persistDerivedOnchainSubjects(");
    expect(c.slice(derive)).not.toContain("retriever.retrieve(");
  });
});

describe("observe-token-accounts — result semantics come from production (items 25, 26, 28)", () => {
  it("25. a ZERO result synthesizes NOTHING — absence is never an economic negative", async () => {
    // The production synthesizer is the authority, and it returns no facts.
    expect(synthesizeOnchainFacts(artifactWith([]), { step: 6, component: "DESTINATION" })).toHaveLength(0);
    // And the entrypoint cannot author a negative of its own: it writes no
    // fact text at all, and its only zero-result output is a statement that
    // nothing was returned.
    const c = await code();
    for (const banned of [
      "no RAY",
      "does not hold",
      "holds no",
      "owns no",
      "never held",
      "docs are false",
      "contradicts",
      "no buyback",
    ]) {
      expect(c.toLowerCase(), `entrypoint asserts "${banned}"`).not.toContain(banned.toLowerCase());
    }
    expect(c).toContain("absence is not a fact");
  });

  it("26. a NONZERO result states only the deterministic position — never a buyback or a burn", async () => {
    const facts = synthesizeOnchainFacts(
      artifactWith([{ account: "TOKACC", owner: "OWNER", mint: "MINT", amountRaw: "1234500000", decimals: 6 }]),
      { step: 6, component: "DESTINATION" },
    );
    expect(facts).toHaveLength(1);
    const f = facts[0];
    // The statement names owner, account, mint, balance and slot — and the
    // relationship is CONTEXT, not support.
    expect(f.statement).toContain("OWNER");
    expect(f.statement).toContain("TOKACC");
    expect(f.statement).toContain("MINT");
    expect(f.statement).toContain("as observed at slot 442446081");
    expect(f.relationship).toBe("CONTEXT");
    expect(f.directness).toBe("DIRECT");
    expect(f.mechanismState).toBeNull();
    for (const banned of ["buyback", "burn", "revenue", "treasury", "permanent", "accumulat", "control"]) {
      expect(f.statement.toLowerCase(), `statement implies "${banned}"`).not.toContain(banned);
    }
    // The limits are stated explicitly by production, not by this test.
    expect(f.doesNotProve).toContain("does not establish how any balance got there");
    expect(f.doesNotProve).toContain("never a history and never a purpose");
  });

  it("ONE fact per account — balances are never collapsed into an invented total", async () => {
    const facts = synthesizeOnchainFacts(
      artifactWith([
        { account: "ACC1", owner: "OWNER", mint: "MINT", amountRaw: "100", decimals: 6 },
        { account: "ACC2", owner: "OWNER", mint: "MINT", amountRaw: "200", decimals: 6 },
      ]),
      { step: 6, component: "DESTINATION" },
    );
    expect(facts).toHaveLength(2);
    expect(facts[0].supportFragment).not.toBe(facts[1].supportFragment);
    for (const f of facts) expect(f.statement).not.toContain("300");
  });

  it("28. a later slot is a SEPARATE observation — equal balances are never claimed to be the same tokens", async () => {
    const acc = [{ account: "ACC1", owner: "OWNER", mint: "MINT", amountRaw: "100", decimals: 6 }];
    const first = synthesizeOnchainFacts(artifactWith(acc, 442446081), { step: 6, component: "DESTINATION" });
    const later = synthesizeOnchainFacts(artifactWith(acc, 442999999), { step: 6, component: "DESTINATION" });
    // Each statement is pinned to its OWN slot, so two observations can
    // never read as one continuous holding.
    expect(first[0].statement).toContain("442446081");
    expect(later[0].statement).toContain("442999999");
    expect(first[0].statement).not.toBe(later[0].statement);
    // HONEST NUANCE, verified rather than assumed: the supportFragment is
    // per-ACCOUNT ({owner, mint, account}) and carries no slot, so an
    // unchanged balance produces the IDENTICAL fragment at both slots — and
    // artifactHash, being sha256 of the normalized result, behaves the same
    // way. Neither of those separates the observations. What does is job
    // scoping: extractionUnitKey is computed over jobId + artifactHash +
    // step + component + fragment (onchain-acquisition.ts), and each owner
    // run creates its own job, so two runs can never collapse into one row.
    expect(first[0].supportFragment).toBe(later[0].supportFragment);
    // Nothing in either claims continuity.
    for (const f of [first[0], later[0]]) {
      for (const banned of ["still", "since", "unchanged", "continu", "same tokens"]) {
        expect(f.statement.toLowerCase(), `statement implies "${banned}"`).not.toContain(banned);
      }
    }
    // And the entrypoint never overwrites: it has no update or delete path.
    const c = await code();
    for (const banned of [".update(", ".delete(", "onConflictDoUpdate"]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("30. no project-specific string appears in the executable code", async () => {
    const c = (await code()).toLowerCase();
    for (const banned of [
      "raydium",
      "ddhdoz",
      "4k3dyj",
      "pump",
      "solscan",
      "buyback",
      "burn",
      "treasury",
      "hyperliquid",
      "uniswap",
    ]) {
      expect(c, `entrypoint code mentions "${banned}"`).not.toContain(banned);
    }
  });
});
