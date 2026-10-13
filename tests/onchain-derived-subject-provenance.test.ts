import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  evidenceDocumentaryLocators,
  onchainArtifacts,
  onchainDerivedSubjects,
  projects,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import {
  ALLOWED_DERIVATION_METHODS,
  persistDerivedOnchainSubjects,
  resolveOnchainSubject,
} from "../src/server/engine/onchain-subject-provenance";
import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// DERIVED ON-CHAIN SUBJECT PROVENANCE.
//
// A token account returned by getTokenAccountsByOwner is not documentary
// evidence — no page states it — and must never be reclassified as one. It
// is also not arbitrary: a confirmed structured read bound its identity. So
// it gets its OWN class, and the two must stay distinguishable forever,
// because merging them would launder an RPC result into something the
// project said.
//
// Eligibility to be READ is not authority to be BELIEVED. A derived subject
// carries no source class, no officiality, no documentary authority and no
// economic role, and the type has no field able to express any of them.

// Addresses are generated PER SCENARIO. An earlier cut of this file shared
// them, and rows written by one test stayed eligible in another — the gate
// is scoped by project anchor, and every scenario reusing one anchor is not
// how real projects look. Unique fixtures keep each assertion about its own
// data.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let addrSeq = 0;
function addr(prefix: string): string {
  addrSeq += 1;
  // Base58 excludes 0, O, I and l, so a readable prefix like "Wallet" is
  // not automatically a legal address fragment. Filtering keeps the label
  // useful without ever producing a value the CHECK constraints refuse;
  // uniqueness comes from the counter, never from the prefix.
  const safePrefix = prefix.split("").filter((c) => B58.includes(c)).join("");
  const tail = String(addrSeq)
    .split("")
    .map((d) => B58[Number(d)])
    .join("");
  return `${safePrefix}${tail}`.padEnd(44, "z").slice(0, 44);
}

// Values that must NEVER resolve, whatever any scenario wrote.
const ARBITRARY = "8Qw3rTyU9pAsDfGhJkLzXcVbNmQw3rTyU9pAsDfGhJkm";
const FOREIGN_MINT = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const HOST = "docs.example-project.test";
const PAGE_URL = `https://${HOST}/token/economics`;
const NOW = new Date("2026-08-25T00:00:00Z");

function fixtureTransport(payload: unknown): OnchainRpcTransport {
  return { async call() { return JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }); } };
}

function tokenEntry(pubkey: string, owner: string, mint: string) {
  return {
    pubkey,
    account: {
      owner: SPL_TOKEN,
      data: { parsed: { info: { owner, mint, tokenAmount: { amount: "0", decimals: 6 } } } },
    },
  };
}

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

interface Scenario {
  jobId: string;
  sourceId: string;
  mint: string;
  wallet: string;
  tokenAccount: string;
  tokenAccount2: string;
  evidenceId: string | null;
  query: { chain: string; network: string; projectAnchor: string };
}

// One project, one job, one documented wallet — the lineage's first two
// links, built the ordinary way rather than inserted by hand.
async function scenario(opts: { documentWallet?: boolean } = {}): Promise<Scenario> {
  const mint = addr("Mint");
  const wallet = addr("Wall");
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("dsp");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Derived Subject Test Project", ticker: null, status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: t.id,
    projectId: project.id,
    originalQuestion: "where do the tokens end up?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  const [src] = await ctx.db
    .insert(sources)
    .values({ url: PAGE_URL, urlHash: uniq("hash"), sourceType: "OFFICIAL_DOCS" })
    .returning();

  let evidenceId: string | null = null;
  if (opts.documentWallet !== false) {
    const [row] = await ctx.db
      .insert(evidence)
      .values({
        researchJobId: job.id,
        sourceId: src.id,
        patternStep: 6,
        component: "DESTINATION",
        relationship: "SUPPORTS",
        directness: "DIRECT",
        fragment: "the page names a wallet",
        summary: "documented wallet",
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        documentaryLocator: wallet,
        fetchedAt: NOW,
        retrievedUrl: PAGE_URL,
        contentHash: "sha256:fixture",
      })
      .returning();
    evidenceId = row.id;
    await ctx.db.insert(evidenceDocumentaryLocators).values({
      evidenceId: row.id,
      ordinal: 0,
      value: wallet,
      shape: "ADDRESS_LIKE",
      literallyPresent: true,
      validationResult: "CONFIRMED",
    });
  }
  return {
    jobId: job.id,
    sourceId: src.id,
    mint,
    wallet,
    tokenAccount: addr("Tok"),
    tokenAccount2: addr("Tok"),
    evidenceId,
    query: { chain: "solana", network: "mainnet", projectAnchor: mint },
  };
}

async function buildArtifact(s: Scenario, entries: unknown[], slot = 4_412_345) {
  const adapter = createSolanaOnchainAdapter({
    transport: fixtureTransport({ context: { slot }, value: entries }),
    providerId: "fixture-rpc",
    finality: "finalized",
  });
  const intent: OnchainIntent = {
    kind: "TOKEN_ACCOUNTS_BY_OWNER",
    chain: "solana",
    network: "mainnet",
    projectAnchor: s.mint,
    subjectKind: "account",
    subject: s.wallet,
  };
  return adapter.retrieve(intent);
}

// Stores an artifact row the way the real persistence path does, then the
// derived subjects FROM THAT ARTIFACT — never from a literal address.
async function storeArtifactAndDerive(
  s: Scenario,
  entries: unknown[],
  identityMint = s.mint,
) {
  const artifact = await buildArtifact(s, entries);
  const p = artifact.provenance;
  const [row] = await ctx.db
    .insert(onchainArtifacts)
    .values({
      researchJobId: s.jobId,
      sourceId: s.sourceId,
      canonicalUri: artifact.canonicalUri,
      chain: p.chain,
      network: p.network,
      projectAnchor: p.projectAnchor,
      subjectKind: p.subjectKind,
      subject: p.subject,
      intentKind: artifact.intent.kind,
      slot: p.slot,
      blockTime: null,
      blockHash: p.blockHash,
      finality: p.finality,
      transactionSignature: p.transactionSignature,
      retrievalMethod: p.retrievalMethod,
      providerId: p.providerId,
      providerMethod: p.providerMethod,
      requestParams: p.requestParams,
      retrievedAt: p.retrievedAt,
      rawResponseHash: p.rawResponseHash,
      artifactHash: p.artifactHash,
      normalizedResult: JSON.parse(artifact.normalizedText),
    })
    .returning();
  const binding = validateOnchainBinding(artifact, {
    chain: "solana",
    tokenAddress: identityMint,
    ticker: null,
  });
  const written = await persistDerivedOnchainSubjects({
    db: ctx.db,
    artifactId: row.id,
    artifact,
    binding,
  });
  return { artifact, artifactRowId: row.id, binding, written };
}

describe("1/2/3. the two provenance classes", () => {
  it("1. a documentary locator still resolves as DOCUMENTARY_LOCATOR", async () => {
    const s = await scenario();
    const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.wallet });
    expect(out.eligible).toBe(true);
    if (!out.eligible || out.provenance.class !== "DOCUMENTARY_LOCATOR") {
      throw new Error("expected a documentary locator");
    }
    expect(out.provenance.documents.some((d) => d.evidenceId === s.evidenceId)).toBe(true);
    expect(out.provenance.documents[0].sourceClass).toBe("OFFICIAL_DOCS");
  });

  it("2. a confirmed derived token account resolves as DERIVED_ONCHAIN_SUBJECT", async () => {
    const s = await scenario();
    const { written, artifactRowId } = await storeArtifactAndDerive(s, [
      tokenEntry(s.tokenAccount, s.wallet, s.mint),
    ]);
    expect(written).toBe(1);
    const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount });
    if (!out.eligible || out.provenance.class !== "DERIVED_ONCHAIN_SUBJECT") {
      throw new Error("expected a derived subject");
    }
    expect(out.provenance).toMatchObject({
      subject: s.tokenAccount,
      subjectKind: "TOKEN_ACCOUNT",
      parentSubject: s.wallet,
      derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER",
      onchainArtifactId: artifactRowId,
      observedSlot: 4_412_345,
    });
  });

  it("3. the classes stay distinguishable — neither is reported as the other", async () => {
    const s = await scenario();
    await storeArtifactAndDerive(s, [tokenEntry(s.tokenAccount, s.wallet, s.mint)]);
    const wallet = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.wallet });
    const derived = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount });
    expect(wallet.eligible && wallet.provenance.class).toBe("DOCUMENTARY_LOCATOR");
    expect(derived.eligible && derived.provenance.class).toBe("DERIVED_ONCHAIN_SUBJECT");
  });

  it("14/15. a derived subject carries no authority and no economic label", async () => {
    const s = await scenario();
    await storeArtifactAndDerive(s, [tokenEntry(s.tokenAccount, s.wallet, s.mint)]);
    const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount });
    if (!out.eligible || out.provenance.class !== "DERIVED_ONCHAIN_SUBJECT") {
      throw new Error("expected a derived subject");
    }
    const keys = Object.keys(out.provenance);
    // 14 — no source authority is representable on this branch.
    for (const banned of ["sourceClass", "officiality", "documents", "retrievedUrl", "entityBinding"]) {
      expect(keys, `derived provenance exposes "${banned}"`).not.toContain(banned);
    }
    // 15 — and no economic semantics either.
    for (const banned of ["burn", "buyback", "role", "purpose", "destination"]) {
      expect(JSON.stringify(out.provenance).toLowerCase()).not.toContain(banned);
    }
  });
});

describe("4/5/6/12/13. what must never pass", () => {
  it("4. an arbitrary RPC-returned address that was never persisted cannot pass", async () => {
    const s = await scenario();
    // The adapter returned it in some other run; nothing recorded it.
    expect(await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount2 })).toEqual({
      eligible: false,
      reason: "NOT_FOUND",
    });
  });

  it("5/6. a model-proposed or owner-supplied address cannot pass", async () => {
    const s = await scenario();
    // There is no path that admits a bare string: both classes are looked
    // up, and neither has a row for it. The third value is the real token
    // account from the owner's own console output — it must not pass either.
    for (const proposed of [
      ARBITRARY,
      addr("Never"),
      "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX",
    ]) {
      expect(await resolveOnchainSubject(ctx.db, { ...s.query, subject: proposed }), proposed).toEqual(
        { eligible: false, reason: "NOT_FOUND" },
      );
    }
  });

  it("12. a canonical URI alone establishes nothing", async () => {
    const s = await scenario();
    const { artifact } = await storeArtifactAndDerive(s, [
      tokenEntry(s.tokenAccount, s.wallet, s.mint),
    ]);
    // The URI names the anchor and the parent wallet. Passing it as a
    // subject resolves nothing: eligibility is decided by rows, never by a
    // string we generated ourselves.
    expect(artifact.canonicalUri).toContain(s.mint);
    expect(artifact.canonicalUri).toContain(s.wallet);
    expect(artifact.canonicalUri).not.toContain(s.tokenAccount);
    expect(
      await resolveOnchainSubject(ctx.db, { ...s.query, subject: artifact.canonicalUri }),
    ).toMatchObject({ eligible: false });
  });

  it("13. exact equality only — no partial, prefix or case-folded match", async () => {
    const s = await scenario();
    await storeArtifactAndDerive(s, [tokenEntry(s.tokenAccount, s.wallet, s.mint)]);
    for (const near of [
      s.tokenAccount.slice(0, 20),
      s.tokenAccount.toLowerCase(),
      `${s.tokenAccount}x`,
      `%${s.tokenAccount}%`,
      "",
    ]) {
      expect(await resolveOnchainSubject(ctx.db, { ...s.query, subject: near }), near).toMatchObject({
        eligible: false,
      });
    }
  });

  it("the gate module contains no LIKE or substring matching", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/onchain-subject-provenance.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const b of ["like(", "ilike(", ".includes(", "startsWith", "toLowerCase"]) {
      expect(code, `gate uses "${b}"`).not.toContain(b);
    }
  });
});

describe("7/8/9/10/11. binding conditions", () => {
  it("7. a project-anchor mismatch fails", async () => {
    const s = await scenario();
    await storeArtifactAndDerive(s, [tokenEntry(s.tokenAccount, s.wallet, s.mint)]);
    expect(
      await resolveOnchainSubject(ctx.db, {
        chain: "solana",
        network: "mainnet",
        projectAnchor: FOREIGN_MINT,
        subject: s.tokenAccount,
      }),
    ).toEqual({ eligible: false, reason: "ANCHOR_MISMATCH" });
  });

  it("8. a chain or network mismatch fails", async () => {
    const s = await scenario();
    await storeArtifactAndDerive(s, [tokenEntry(s.tokenAccount, s.wallet, s.mint)]);
    for (const q of [
      { ...s.query, chain: "ethereum", subject: s.tokenAccount },
      { ...s.query, network: "devnet", subject: s.tokenAccount },
    ]) {
      expect(await resolveOnchainSubject(ctx.db, q)).toEqual({
        eligible: false,
        reason: "CHAIN_OR_NETWORK_MISMATCH",
      });
    }
  });

  it("9. an unconfirmed derivation is never written at all", async () => {
    const s = await scenario();
    // Binding against a DIFFERENT confirmed identity -> UNVERIFIED.
    const { written, binding } = await storeArtifactAndDerive(
      s,
      [tokenEntry(s.tokenAccount, s.wallet, s.mint)],
      FOREIGN_MINT,
    );
    expect(binding.binding).toBe("UNVERIFIED");
    expect(written).toBe(0);
    expect(
      await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount }),
    ).toMatchObject({ eligible: false });
  });

  it("the database refuses an unconfirmed binding row outright", async () => {
    const s = await scenario();
    const { artifactRowId } = await storeArtifactAndDerive(s, [
      tokenEntry(s.tokenAccount, s.wallet, s.mint),
    ]);
    await expect(
      ctx.db.insert(onchainDerivedSubjects).values({
        onchainArtifactId: artifactRowId,
        chain: "solana",
        network: "mainnet",
        projectAnchor: s.mint,
        subject: s.tokenAccount2,
        subjectKind: "TOKEN_ACCOUNT",
        parentSubject: s.wallet,
        derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER",
        bindingStatus: "UNVERIFIED",
        observedSlot: 1,
        retrievedAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it("10. missing parent provenance fails — the lineage is re-checked, not remembered", async () => {
    const s = await scenario();
    await storeArtifactAndDerive(s, [tokenEntry(s.tokenAccount, s.wallet, s.mint)]);
    expect(
      (await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount })).eligible,
    ).toBe(true);
    // Remove the parent wallet's documentary evidence. The derived row is
    // untouched — and stops being eligible on the very next call.
    await ctx.db.delete(evidence).where(eq(evidence.id, s.evidenceId!));
    expect(await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount })).toEqual({
      eligible: false,
      reason: "PARENT_PROVENANCE_INVALID",
    });
    // The row itself was never deleted — provenance is re-derived, not swept.
    const rows = await ctx.db
      .select()
      .from(onchainDerivedSubjects)
      .where(eq(onchainDerivedSubjects.subject, s.tokenAccount));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("11. an artifact that disagrees with the row fails", async () => {
    const s = await scenario();
    const { artifactRowId } = await storeArtifactAndDerive(s, [
      tokenEntry(s.tokenAccount, s.wallet, s.mint),
    ]);
    // Repoint the artifact at a different parent subject: the link is now
    // broken even though both rows still exist.
    await ctx.db
      .update(onchainArtifacts)
      .set({ subject: addr("Other") })
      .where(eq(onchainArtifacts.id, artifactRowId));
    expect(await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount })).toEqual({
      eligible: false,
      reason: "ARTIFACT_INVALID",
    });
  });

  it("a derived subject cannot exist without its artifact — FK enforced", async () => {
    const s = await scenario();
    await expect(
      ctx.db.insert(onchainDerivedSubjects).values({
        onchainArtifactId: "00000000-0000-0000-0000-000000000000",
        chain: "solana",
        network: "mainnet",
        projectAnchor: s.mint,
        subject: s.tokenAccount2,
        subjectKind: "TOKEN_ACCOUNT",
        parentSubject: s.wallet,
        derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER",
        bindingStatus: "CONFIRMED",
        observedSlot: 1,
        retrievedAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it("the derivation method allowlist is closed", () => {
    expect([...ALLOWED_DERIVATION_METHODS]).toEqual(["TOKEN_ACCOUNTS_BY_OWNER"]);
  });
});

describe("persistence takes no caller-supplied address", () => {
  it("subjects come from the artifact's own validated result", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/onchain-subject-provenance.ts", import.meta.url),
      "utf-8",
    );
    // The input type carries an artifact and a binding — there is no
    // address parameter to pass a prompt value through.
    expect(raw).toContain("artifact: OnchainArtifact");
    expect(raw).toContain("binding: OnchainBindingOutcome");
    expect(raw).toContain("subject: a.account");
    expect(raw).not.toContain("subject: input.subject");
  });

  it("a non-derivable result kind writes nothing", async () => {
    const s = await scenario();
    const { artifactRowId } = await storeArtifactAndDerive(s, [
      tokenEntry(s.tokenAccount, s.wallet, s.mint),
    ]);
    const adapter = createSolanaOnchainAdapter({
      transport: fixtureTransport({ context: { slot: 5 }, value: { amount: "1", decimals: 6 } }),
      providerId: "fixture-rpc",
      finality: "finalized",
    });
    const supply = await adapter.retrieve({
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: s.mint,
      subjectKind: "token",
      subject: s.mint,
    });
    const written = await persistDerivedOnchainSubjects({
      db: ctx.db,
      artifactId: artifactRowId,
      artifact: supply,
      binding: { binding: "CONFIRMED" },
    });
    expect(written).toBe(0);
  });

  it("10. multiple token accounts each become their own derived subject", async () => {
    const s = await scenario();
    const { written } = await storeArtifactAndDerive(s, [
      tokenEntry(s.tokenAccount, s.wallet, s.mint),
      tokenEntry(s.tokenAccount2, s.wallet, s.mint),
    ]);
    expect(written).toBe(2);
    for (const value of [s.tokenAccount, s.tokenAccount2]) {
      const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: value });
      expect(out.eligible, value).toBe(true);
      if (out.eligible && out.provenance.class === "DERIVED_ONCHAIN_SUBJECT") {
        expect(out.provenance.subject).toBe(value);
      }
    }
  });

  it("re-running the same observation is idempotent", async () => {
    const s = await scenario();
    const { artifact, artifactRowId, binding } = await storeArtifactAndDerive(s, [
      tokenEntry(s.tokenAccount, s.wallet, s.mint),
    ]);
    await persistDerivedOnchainSubjects({ db: ctx.db, artifactId: artifactRowId, artifact, binding });
    const rows = await ctx.db
      .select()
      .from(onchainDerivedSubjects)
      .where(eq(onchainDerivedSubjects.onchainArtifactId, artifactRowId));
    expect(rows.length).toBe(1);
  });
});

describe("16/17. compatibility and project independence", () => {
  it("16. the documentary gate is unchanged for a scalar-only historical row", async () => {
    const s = await scenario({ documentWallet: false });
    const legacyWallet = addr("Legacy");
    // A pre-child-table row: scalar set, no locator rows.
    await ctx.db.insert(evidence).values({
      researchJobId: s.jobId,
      sourceId: s.sourceId,
      patternStep: 6,
      component: "DESTINATION",
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: "legacy",
      summary: "legacy row",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      documentaryLocator: legacyWallet,
      fetchedAt: NOW,
      retrievedUrl: PAGE_URL,
      contentHash: "sha256:legacy",
    });
    const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: legacyWallet });
    expect(out.eligible).toBe(true);
    if (out.eligible) expect(out.provenance.class).toBe("DOCUMENTARY_LOCATOR");
  });

  it("17. no project-specific logic", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/onchain-subject-provenance.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const banned of ["pump", "solscan", "solana", "hyperliquid", "uniswap", "burn"]) {
      expect(code, `gate mentions "${banned}"`).not.toContain(banned);
    }
  });
});
