import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  evidenceDocumentaryLocators,
  onchainArtifacts,
  onchainObservedSignatures,
  projects,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { persistOnchainArtifact } from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import {
  persistObservedSignatures,
  resolveObservedSignature,
  signaturesForArtifact,
} from "../src/server/engine/onchain-signature-provenance";
import {
  persistDerivedOnchainSubjects,
  resolveOnchainSubject,
} from "../src/server/engine/onchain-subject-provenance";
import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// OBSERVED TRANSACTION SIGNATURES.
//
// The mistake this exists to prevent: discover signatures live, print them,
// then find that a later getTransaction has no deterministic provenance and
// needs the RPC repeated — or worse, needs someone to paste a signature
// back in. A signature must be written down at the moment it is observed,
// with the reason it is eligible attached.
//
// It is NOT a documentary locator (no document states it) and it inherits
// NOTHING from the account it was listed for. Being listed says the RPC
// returned it; it says nothing about what the transaction did.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seq = 0;
function addr(prefix: string): string {
  seq += 1;
  const safe = prefix.split("").filter((ch) => B58.includes(ch)).join("");
  const tail = String(seq).split("").map((d) => B58[Number(d)]).join("");
  return `${safe}${tail}`.padEnd(44, "z").slice(0, 44);
}
function sig(prefix: string): string {
  seq += 1;
  const safe = prefix.split("").filter((ch) => B58.includes(ch)).join("");
  const tail = String(seq).split("").map((d) => B58[Number(d)]).join("");
  return `${safe}${tail}`.padEnd(88, "z").slice(0, 88);
}

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FOREIGN_MINT = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PAGE_URL = "https://docs.example-project.test/token/economics";
const NOW = new Date("2026-08-25T00:00:00Z");

function fixtureTransport(payload: unknown): OnchainRpcTransport {
  return { async call() { return JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }); } };
}
function adapterWith(payload: unknown) {
  return createSolanaOnchainAdapter({
    transport: fixtureTransport(payload),
    providerId: "fixture-rpc",
    finality: "finalized",
  });
}

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

interface Scene {
  mint: string;
  wallet: string;
  tokenAccount: string;
  identity: { chain: "solana"; tokenAddress: string; ticker: null };
  query: { chain: string; network: string; projectAnchor: string };
}

// PROJECT_IDENTITY -> documented wallet -> TOKEN_ACCOUNTS_BY_OWNER artifact
// -> derived token account. The lineage's first four links, built the
// ordinary way so the signature step starts from real provenance.
async function scene(opts: { documentWallet?: boolean; derive?: boolean } = {}): Promise<Scene> {
  const mint = addr("Mint");
  const wallet = addr("Wa");
  const tokenAccount = addr("Tok");
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("sig");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Signature Test Project", ticker: null, status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: t.id,
    projectId: project.id,
    originalQuestion: "q",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  if (opts.documentWallet !== false) {
    const [src] = await ctx.db
      .insert(sources)
      .values({ url: PAGE_URL, urlHash: uniq("hash"), sourceType: "OFFICIAL_DOCS" })
      .returning();
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
    await ctx.db.insert(evidenceDocumentaryLocators).values({
      evidenceId: row.id,
      ordinal: 0,
      value: wallet,
      shape: "ADDRESS_LIKE",
      literallyPresent: true,
      validationResult: "CONFIRMED",
    });
  }
  const s: Scene = {
    mint,
    wallet,
    tokenAccount,
    identity: { chain: "solana", tokenAddress: mint, ticker: null },
    query: { chain: "solana", network: "mainnet", projectAnchor: mint },
  };
  if (opts.derive !== false) await deriveTokenAccount(s);
  return s;
}

async function deriveTokenAccount(s: Scene) {
  const artifact = await adapterWith({
    context: { slot: 4_400_000 },
    value: [
      {
        pubkey: s.tokenAccount,
        account: {
          owner: SPL_TOKEN,
          data: {
            parsed: {
              info: {
                owner: s.wallet,
                mint: s.mint,
                tokenAmount: { amount: "0", decimals: 6 },
              },
            },
          },
        },
      },
    ],
  }).retrieve({
    kind: "TOKEN_ACCOUNTS_BY_OWNER",
    chain: "solana",
    network: "mainnet",
    projectAnchor: s.mint,
    subjectKind: "account",
    subject: s.wallet,
  });
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
    artifact,
    identity: s.identity,
  });
  await persistDerivedOnchainSubjects({
    db: ctx.db,
    artifactId: stored.artifactId!,
    artifact,
    binding: validateOnchainBinding(artifact, s.identity),
  });
}

function sigIntent(s: Scene, subject: string): OnchainIntent {
  return {
    kind: "SIGNATURES_FOR_ADDRESS",
    chain: "solana",
    network: "mainnet",
    projectAnchor: s.mint,
    subjectKind: "account",
    subject,
    limit: 10,
  };
}

async function observeSignatures(
  s: Scene,
  subject: string,
  entries: unknown[],
  identityMint = s.mint,
) {
  const artifact = await adapterWith(entries).retrieve(sigIntent(s, subject));
  const identity = { chain: "solana" as const, tokenAddress: identityMint, ticker: null };
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
    artifact,
    identity,
  });
  if (!stored.artifactId) return { artifactId: null, written: 0, artifact };
  const written = await persistObservedSignatures({
    db: ctx.db,
    artifactId: stored.artifactId,
    artifact,
    binding: validateOnchainBinding(artifact, identity),
  });
  return { artifactId: stored.artifactId, written, artifact };
}

function entry(signature: string, over: Record<string, unknown> = {}) {
  return { signature, slot: 4_412_345, blockTime: 1_787_606_179, err: null, ...over };
}

async function counts() {
  const [u] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [s] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(sources);
  const [e] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(evidence);
  return { users: u.n, sources: s.n, evidence: e.n };
}

describe("1/2/3. the parent subject gate", () => {
  it("1. a derived token account passes as DERIVED_ONCHAIN_SUBJECT", async () => {
    const s = await scene();
    const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount });
    expect(out.eligible).toBe(true);
    if (out.eligible) expect(out.provenance.class).toBe("DERIVED_ONCHAIN_SUBJECT");
  });

  it("2. an arbitrary account fails", async () => {
    const s = await scene();
    expect(
      await resolveOnchainSubject(ctx.db, { ...s.query, subject: addr("Nope") }),
    ).toMatchObject({ eligible: false, reason: "NOT_FOUND" });
  });

  it("3. a documentary locator is still supported as a parent", async () => {
    const s = await scene();
    const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.wallet });
    expect(out.eligible).toBe(true);
    if (out.eligible) expect(out.provenance.class).toBe("DOCUMENTARY_LOCATOR");
    // And a signature listed for it records THAT parent.
    const signature = sig("Doc");
    const { written } = await observeSignatures(s, s.wallet, [entry(signature)]);
    expect(written).toBe(1);
    const check = await resolveObservedSignature(ctx.db, { ...s.query, signature });
    expect(check.eligible).toBe(true);
    if (check.eligible) {
      expect(check.provenance.parentSubject).toBe(s.wallet);
      expect(check.provenance.parentClass).toBe("DOCUMENTARY_LOCATOR");
    }
  });
});

describe("4/5/6/7/8. persistence", () => {
  it("4. a standalone signature artifact needs no user, job or source", async () => {
    const s = await scene();
    const before = await counts();
    const { artifactId, written } = await observeSignatures(s, s.tokenAccount, [entry(sig("A"))]);
    expect(written).toBe(1);
    const [row] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, artifactId!));
    expect(row.originKind).toBe("STANDALONE_STRUCTURED_OBSERVATION");
    expect(row.researchJobId).toBeNull();
    expect(row.sourceId).toBeNull();
    const after = await counts();
    expect(after.users).toBe(before.users);
    expect(after.sources).toBe(before.sources);
    expect(after.evidence).toBe(before.evidence);
  });

  it("5/6. one artifact persists many signatures, each independently queryable", async () => {
    const s = await scene();
    const a = sig("Ma");
    const b = sig("Mb");
    const c = sig("Mc");
    const { artifactId, written } = await observeSignatures(s, s.tokenAccount, [
      entry(a, { slot: 3 }),
      entry(b, { slot: 2 }),
      entry(c, { slot: 1 }),
    ]);
    expect(written).toBe(3);
    expect((await signaturesForArtifact(ctx.db, artifactId!)).map((x) => x.signature)).toEqual([
      a,
      b,
      c,
    ]);
    for (const value of [a, b, c]) {
      const out = await resolveObservedSignature(ctx.db, { ...s.query, signature: value });
      expect(out.eligible, value).toBe(true);
      if (out.eligible) expect(out.provenance.signature).toBe(value);
    }
  });

  it("7. a malformed or truncated signature is never persisted", async () => {
    const s = await scene();
    const good = sig("Good");
    const { written } = await observeSignatures(s, s.tokenAccount, [
      entry(good),
      entry("short"),
      entry(`${good.slice(0, 20)}…${good.slice(-6)}`),
      entry(""),
      entry("0OIl".repeat(22)),
    ]);
    expect(written).toBe(1);
    const rows = await ctx.db.select().from(onchainObservedSignatures);
    for (const r of rows) expect(r.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  });

  it("7. the database refuses a truncated signature even by direct insert", async () => {
    const s = await scene();
    const { artifactId } = await observeSignatures(s, s.tokenAccount, [entry(sig("Db"))]);
    await expect(
      ctx.db.insert(onchainObservedSignatures).values({
        onchainArtifactId: artifactId!,
        chain: "solana",
        network: "mainnet",
        projectAnchor: s.mint,
        parentSubject: s.tokenAccount,
        signature: "4Hs9Tz…CvDkGm",
        slot: 1,
        blockTime: null,
        err: false,
        memo: null,
        bindingStatus: "CONFIRMED",
        observedAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it("8. a signature not returned by the artifact cannot be handed to the persister", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/onchain-signature-provenance.ts", import.meta.url),
      "utf-8",
    );
    // The input type carries an artifact and a binding — there is no
    // signature parameter to pass a prompt value through.
    expect(raw).toContain("artifact: OnchainArtifact");
    expect(raw).toContain("binding: OnchainBindingOutcome");
    expect(raw).toContain("signature: s.signature");
    expect(raw).not.toContain("signature: input.signature");
    // And a hand-written row for a signature no artifact returned is
    // refused by the gate, because the artifact would not agree.
    const s = await scene();
    const foreign = sig("Foreign");
    expect(
      await resolveObservedSignature(ctx.db, { ...s.query, signature: foreign }),
    ).toEqual({ eligible: false, reason: "NOT_FOUND" });
  });

  it("an unbound observation persists no signature", async () => {
    const s = await scene();
    const { artifactId, written } = await observeSignatures(
      s,
      s.tokenAccount,
      [entry(sig("Unb"))],
      FOREIGN_MINT,
    );
    expect(artifactId).toBeNull();
    expect(written).toBe(0);
  });

  it("replaying the same observation is idempotent", async () => {
    const s = await scene();
    const value = sig("Idem");
    const first = await observeSignatures(s, s.tokenAccount, [entry(value)]);
    const second = await observeSignatures(s, s.tokenAccount, [entry(value)]);
    expect(second.artifactId).toBe(first.artifactId);
    const rows = await ctx.db
      .select()
      .from(onchainObservedSignatures)
      .where(eq(onchainObservedSignatures.onchainArtifactId, first.artifactId!));
    expect(rows.length).toBe(1);
  });
});

describe("9/10/11/12/13/14/17/18. the getTransaction gate", () => {
  it("17. it accepts an exact persisted signature and names the whole lineage", async () => {
    const s = await scene();
    const value = sig("Ok");
    const { artifactId } = await observeSignatures(s, s.tokenAccount, [entry(value)]);
    const out = await resolveObservedSignature(ctx.db, { ...s.query, signature: value });
    expect(out.eligible).toBe(true);
    if (!out.eligible) return;
    expect(out.provenance).toMatchObject({
      class: "OBSERVED_SIGNATURE",
      signature: value,
      parentSubject: s.tokenAccount,
      parentClass: "DERIVED_ONCHAIN_SUBJECT",
      onchainArtifactId: artifactId,
      slot: 4_412_345,
      err: false,
    });
  });

  it("18. a similar, partial or differently-cased signature fails", async () => {
    const s = await scene();
    const value = sig("Case");
    await observeSignatures(s, s.tokenAccount, [entry(value)]);
    for (const near of [
      value.slice(0, 40),
      value.toLowerCase(),
      value.toUpperCase(),
      `${value.slice(0, -1)}A`,
      `%${value}%`,
      "",
    ]) {
      expect(
        await resolveObservedSignature(ctx.db, { ...s.query, signature: near }),
        near,
      ).toMatchObject({ eligible: false });
    }
  });

  it("9. a project-anchor mismatch fails", async () => {
    const s = await scene();
    const value = sig("Anch");
    await observeSignatures(s, s.tokenAccount, [entry(value)]);
    expect(
      await resolveObservedSignature(ctx.db, {
        chain: "solana",
        network: "mainnet",
        projectAnchor: FOREIGN_MINT,
        signature: value,
      }),
    ).toEqual({ eligible: false, reason: "ANCHOR_MISMATCH" });
  });

  it("10. a chain or network mismatch fails", async () => {
    const s = await scene();
    const value = sig("Chain");
    await observeSignatures(s, s.tokenAccount, [entry(value)]);
    for (const q of [
      { ...s.query, chain: "ethereum", signature: value },
      { ...s.query, network: "devnet", signature: value },
    ]) {
      expect(await resolveObservedSignature(ctx.db, q)).toEqual({
        eligible: false,
        reason: "CHAIN_OR_NETWORK_MISMATCH",
      });
    }
  });

  it("11. an artifact that disagrees with the row fails", async () => {
    const s = await scene();
    const value = sig("Art");
    const { artifactId } = await observeSignatures(s, s.tokenAccount, [entry(value)]);
    await ctx.db
      .update(onchainArtifacts)
      .set({ subject: addr("Other") })
      .where(eq(onchainArtifacts.id, artifactId!));
    expect(await resolveObservedSignature(ctx.db, { ...s.query, signature: value })).toEqual({
      eligible: false,
      reason: "ARTIFACT_INVALID",
    });
  });

  it("12. missing parent provenance fails — the chain is re-checked, not remembered", async () => {
    const s = await scene();
    const value = sig("Par");
    const { artifactId } = await observeSignatures(s, s.tokenAccount, [entry(value)]);
    expect((await resolveObservedSignature(ctx.db, { ...s.query, signature: value })).eligible).toBe(
      true,
    );
    // Break the parent's own provenance by removing the derived subject's
    // originating artifact. The signature row is untouched.
    const derivedArtifacts = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.intentKind, "TOKEN_ACCOUNTS_BY_OWNER"));
    for (const a of derivedArtifacts) {
      if (a.subject === s.wallet) {
        await ctx.db.delete(onchainArtifacts).where(eq(onchainArtifacts.id, a.id));
      }
    }
    expect(await resolveObservedSignature(ctx.db, { ...s.query, signature: value })).toEqual({
      eligible: false,
      reason: "PARENT_PROVENANCE_INVALID",
    });
    // The signature row itself was never swept.
    const rows = await ctx.db
      .select()
      .from(onchainObservedSignatures)
      .where(eq(onchainObservedSignatures.onchainArtifactId, artifactId!));
    expect(rows.length).toBe(1);
  });

  it("13. a signature attributed to the wrong originating intent fails", async () => {
    const s = await scene();
    const value = sig("Int");
    const { artifactId } = await observeSignatures(s, s.tokenAccount, [entry(value)]);
    await ctx.db
      .update(onchainArtifacts)
      .set({ intentKind: "ACCOUNT_INFO" })
      .where(eq(onchainArtifacts.id, artifactId!));
    expect(await resolveObservedSignature(ctx.db, { ...s.query, signature: value })).toEqual({
      eligible: false,
      reason: "WRONG_ORIGINATING_INTENT",
    });
  });

  it("14. the canonical URI alone proves nothing", async () => {
    const s = await scene();
    const value = sig("Uri");
    const { artifact } = await observeSignatures(s, s.tokenAccount, [entry(value)]);
    // The URI names the anchor and the parent; the signature is not in it.
    expect(artifact.canonicalUri).toContain(s.mint);
    expect(artifact.canonicalUri).toContain(s.tokenAccount);
    expect(artifact.canonicalUri).not.toContain(value);
    expect(
      await resolveObservedSignature(ctx.db, { ...s.query, signature: artifact.canonicalUri }),
    ).toMatchObject({ eligible: false });
  });
});

describe("15/16. semantics", () => {
  it("15. a memo confers no execution semantics", async () => {
    const s = await scene();
    const value = sig("Memo");
    await observeSignatures(s, s.tokenAccount, [
      entry(value, { memo: "[1] SPL Burn 160100000 PUMP official daily burn" }),
    ]);
    const out = await resolveObservedSignature(ctx.db, { ...s.query, signature: value });
    expect(out.eligible).toBe(true);
    if (!out.eligible) return;
    // The memo is carried verbatim and changes nothing else.
    expect(out.provenance.memo).toContain("SPL Burn");
    expect(out.provenance.err).toBe(false);
    // Nothing on the provenance can express what the transaction did.
    for (const banned of ["burned", "amount", "mint", "instruction", "direction", "sourceClass"]) {
      expect(Object.keys(out.provenance), banned).not.toContain(banned);
    }
  });

  it("16. failed transaction metadata stays distinguishable from successful", async () => {
    const s = await scene();
    const ok = sig("Ok2");
    const bad = sig("Bad");
    await observeSignatures(s, s.tokenAccount, [
      entry(ok),
      entry(bad, { err: { InstructionError: [0, "Custom"] } }),
    ]);
    const okOut = await resolveObservedSignature(ctx.db, { ...s.query, signature: ok });
    const badOut = await resolveObservedSignature(ctx.db, { ...s.query, signature: bad });
    expect(okOut.eligible && okOut.provenance.err).toBe(false);
    expect(badOut.eligible && badOut.provenance.err).toBe(true);
    // A failed transaction is still eligible to be READ — refusing it would
    // hide the failure rather than record it.
    expect(badOut.eligible).toBe(true);
  });

  it("a signature inherits no documentary authority from its parent", async () => {
    const s = await scene();
    const value = sig("Auth");
    // Parent is the DOCUMENTED wallet — the strongest parent available.
    await observeSignatures(s, s.wallet, [entry(value)]);
    const out = await resolveObservedSignature(ctx.db, { ...s.query, signature: value });
    expect(out.eligible).toBe(true);
    if (!out.eligible) return;
    expect(out.provenance.parentClass).toBe("DOCUMENTARY_LOCATOR");
    // The parent's class is REPORTED, never inherited: no authority field
    // exists on the signature's own provenance.
    for (const banned of ["sourceClass", "officiality", "documents", "retrievedUrl"]) {
      expect(Object.keys(out.provenance), banned).not.toContain(banned);
    }
  });
});

describe("19/20. compatibility and project independence", () => {
  it("19. account-derived provenance is unchanged", async () => {
    const s = await scene();
    await observeSignatures(s, s.tokenAccount, [entry(sig("Compat"))]);
    // Observing signatures neither promotes nor disturbs the token account.
    const out = await resolveOnchainSubject(ctx.db, { ...s.query, subject: s.tokenAccount });
    expect(out.eligible).toBe(true);
    if (out.eligible) {
      expect(out.provenance.class).toBe("DERIVED_ONCHAIN_SUBJECT");
      if (out.provenance.class === "DERIVED_ONCHAIN_SUBJECT") {
        expect(out.provenance.parentSubject).toBe(s.wallet);
        expect(out.provenance.derivationMethod).toBe("TOKEN_ACCOUNTS_BY_OWNER");
      }
    }
  });

  it("20. no project-specific logic", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/onchain-signature-provenance.ts",
      "../scripts/onchain-observe-signatures.ts",
    ]) {
      const raw = await fs.readFile(new URL(file, import.meta.url), "utf-8");
      const code = raw
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["solscan", "hyperliquid", "uniswap", "burn", "buyback", "treasury"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
      expect((code.match(/pump/g) ?? []).length, file).toBeLessThanOrEqual(1);
    }
  });

  it("the gate module uses equality only — no LIKE or substring matching", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/onchain-signature-provenance.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const b of ["like(", "ilike(", "toLowerCase", "startsWith"]) {
      expect(code, `gate uses "${b}"`).not.toContain(b);
    }
  });
});
