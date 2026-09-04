import { eq, isNull, sql } from "drizzle-orm";
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
import {
  persistOnchainArtifact,
  persistOnchainArtifactAndFacts,
} from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import {
  persistDerivedOnchainSubjects,
  resolveOnchainSubject,
} from "../src/server/engine/onchain-subject-provenance";
import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// STANDALONE STRUCTURED OBSERVATIONS.
//
// Persisting one deterministic chain read used to require inventing a user,
// a research job and a source row, purely to satisfy NOT NULL foreign keys.
// Those rows asserted things that were false — that research had run, that a
// document had been fetched. Provenance that has to lie to be stored is not
// provenance.
//
// Two explicit modes now, and the CHECK makes every invalid combination
// unrepresentable rather than merely discouraged. What must NOT change: a
// standalone artifact gains nothing by existing — not Evidence, not a source
// class, not Proof eligibility — and the derived-subject gate still depends
// on a validated artifact plus live parent provenance, never on a row.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let addrSeq = 0;
function addr(prefix: string): string {
  addrSeq += 1;
  const safe = prefix.split("").filter((c) => B58.includes(c)).join("");
  const tail = String(addrSeq).split("").map((d) => B58[Number(d)]).join("");
  return `${safe}${tail}`.padEnd(44, "z").slice(0, 44);
}

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FOREIGN_MINT = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PAGE_URL = "https://docs.example-project.test/token/economics";
const NOW = new Date("2026-08-25T00:00:00Z");

function fixtureTransport(payload: unknown): OnchainRpcTransport {
  return { async call() { return JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }); } };
}

function tokenEntry(pubkey: string, owner: string, mint: string, amount = "0") {
  return {
    pubkey,
    account: {
      owner: SPL_TOKEN,
      data: { parsed: { info: { owner, mint, tokenAmount: { amount, decimals: 6 } } } },
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

interface Fixture {
  projectId: string;
  jobId: string;
  mint: string;
  wallet: string;
  tokenAccount: string;
  identity: { chain: "solana"; tokenAddress: string; ticker: null };
  query: { chain: string; network: string; projectAnchor: string };
}

async function fixture(opts: { documentWallet?: boolean } = {}): Promise<Fixture> {
  const mint = addr("Mint");
  const wallet = addr("Wa");
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("orig");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Origin Test Project", ticker: null, status: "ACTIVE_CORE" })
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
  return {
    projectId: project.id,
    jobId: job.id,
    mint,
    wallet,
    tokenAccount: addr("Tok"),
    identity: { chain: "solana", tokenAddress: mint, ticker: null },
    query: { chain: "solana", network: "mainnet", projectAnchor: mint },
  };
}

async function artifactFor(f: Fixture, entries: unknown[], slot = 4_412_345) {
  const adapter = createSolanaOnchainAdapter({
    transport: fixtureTransport({ context: { slot }, value: entries }),
    providerId: "fixture-rpc",
    finality: "finalized",
  });
  const intent: OnchainIntent = {
    kind: "TOKEN_ACCOUNTS_BY_OWNER",
    chain: "solana",
    network: "mainnet",
    projectAnchor: f.mint,
    subjectKind: "account",
    subject: f.wallet,
  };
  return adapter.retrieve(intent);
}

async function counts() {
  const [u] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [j] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(sources);
  return { users: u.n, sources: j.n };
}

describe("1/14. the research-job mode is unchanged", () => {
  it("1/14. a research-job artifact still requires a job, and keeps its source row", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const stored = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "RESEARCH_JOB", jobId: f.jobId },
      artifact,
      identity: f.identity,
    });
    expect(stored.artifactId).toBeTruthy();
    expect(stored.sourceId).toBeTruthy();
    const [row] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, stored.artifactId!));
    expect(row.originKind).toBe("RESEARCH_JOB");
    expect(row.researchJobId).toBe(f.jobId);
    expect(row.sourceId).toBe(stored.sourceId);
  });

  it("1. a research-job row cannot exist without a job or without a source", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const p = artifact.provenance;
    const base = {
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
      artifactHash: uniq("hash"),
      normalizedResult: JSON.parse(artifact.normalizedText),
    };
    // RESEARCH_JOB with no job -> refused by the CHECK.
    await expect(
      ctx.db.insert(onchainArtifacts).values({
        ...base,
        originKind: "RESEARCH_JOB",
        researchJobId: null,
        sourceId: null,
      }),
    ).rejects.toThrow();
  });
});

describe("2/3/4/5/6. the standalone mode", () => {
  it("2/3/4/5. a standalone artifact needs no job, no user and no source", async () => {
    const f = await fixture();
    const before = await counts();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const stored = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: f.identity,
    });
    expect(stored.artifactId).toBeTruthy();
    expect(stored.sourceId).toBeNull();
    const [row] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, stored.artifactId!));
    expect(row.originKind).toBe("STANDALONE_STRUCTURED_OBSERVATION");
    expect(row.researchJobId).toBeNull();
    expect(row.sourceId).toBeNull();
    // 3/4/5 — nothing synthetic was created to make that possible.
    const after = await counts();
    expect(after.users).toBe(before.users);
    expect(after.sources).toBe(before.sources);
  });

  it("6. structured provider provenance is complete without a job", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const stored = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: f.identity,
    });
    const [row] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, stored.artifactId!));
    // Absence of research_job_id is never absence of provenance.
    expect(row.providerId).toBeTruthy();
    expect(row.providerMethod).toBe("getTokenAccountsByOwner");
    expect(row.intentKind).toBe("TOKEN_ACCOUNTS_BY_OWNER");
    expect(row.chain).toBe("solana");
    expect(row.network).toBe("mainnet");
    expect(row.projectAnchor).toBe(f.mint);
    expect(row.subject).toBe(f.wallet);
    expect(Number(row.slot)).toBe(4_412_345);
    expect(row.retrievedAt).toBeInstanceOf(Date);
    expect(row.rawResponseHash).toMatch(/^sha256:/);
    expect(row.artifactHash).toMatch(/^sha256:/);
    expect(row.canonicalUri).toContain("atlas-onchain://");
    expect(row.finality).toBe("finalized");
    expect(row.retrievalMethod).toBe("RPC");
  });

  it("a standalone row carrying a job id or a source id is unrepresentable", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const p = artifact.provenance;
    const base = {
      originKind: "STANDALONE_STRUCTURED_OBSERVATION" as const,
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
      artifactHash: uniq("hash"),
      normalizedResult: JSON.parse(artifact.normalizedText),
    };
    await expect(
      ctx.db.insert(onchainArtifacts).values({ ...base, researchJobId: f.jobId, sourceId: null }),
    ).rejects.toThrow();
  });

  it("a replayed standalone observation is a no-op, not a duplicate", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const a = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: f.identity,
    });
    const b = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: f.identity,
    });
    expect(b.artifactId).toBe(a.artifactId);
    const rows = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.artifactHash, artifact.provenance.artifactHash));
    expect(rows.filter((r) => r.researchJobId === null).length).toBe(1);
  });

  it("identical content in BOTH modes stays two distinct rows", async () => {
    // The artifact hash is a CONTENT address, so the same observation
    // reached two ways collides on it. A job insert must never resolve to
    // the standalone row, or a job would silently adopt another's artifact.
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const standalone = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: f.identity,
    });
    const job = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "RESEARCH_JOB", jobId: f.jobId },
      artifact,
      identity: f.identity,
    });
    expect(job.artifactId).not.toBe(standalone.artifactId);
    const [jobRow] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, job.artifactId!));
    expect(jobRow.researchJobId).toBe(f.jobId);
    expect(jobRow.originKind).toBe("RESEARCH_JOB");
  });
});

describe("7/8. a standalone artifact gains nothing by existing", () => {
  it("7. it does not become Evidence", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const before = await ctx.db.select().from(evidence);
    await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: f.identity,
    });
    const after = await ctx.db.select().from(evidence);
    expect(after.length).toBe(before.length);
  });

  it("7. no Evidence row can reference a standalone artifact — structurally", async () => {
    // evidence.source_id is NOT NULL and a standalone artifact has no source
    // row, so the impossibility is enforced by the schema rather than by a
    // rule someone must remember.
    const standalone = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(isNull(onchainArtifacts.researchJobId));
    expect(standalone.length).toBeGreaterThan(0);
    for (const row of standalone) expect(row.sourceId).toBeNull();
    const linked = await ctx.db
      .select()
      .from(evidence)
      .where(isNull(evidence.sourceId));
    expect(linked.length).toBe(0);
  });

  it("8. it carries no sourceClass and no officiality — those live on Evidence", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    const stored = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: f.identity,
    });
    const [row] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, stored.artifactId!));
    const keys = Object.keys(row);
    for (const banned of ["sourceClass", "officiality", "entityBinding", "relationship", "verdict"]) {
      expect(keys, `artifact exposes "${banned}"`).not.toContain(banned);
    }
  });

  it("the facts path still writes Evidence for a research job, unchanged", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint, "5")]);
    const out = await persistOnchainArtifactAndFacts({
      db: ctx.db,
      jobId: f.jobId,
      artifact,
      identity: f.identity,
      target: { step: 6, component: "DESTINATION" },
    });
    expect(out.artifactId).toBeTruthy();
    expect(out.evidenceIds.length).toBeGreaterThan(0);
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, out.evidenceIds[0]));
    expect(row.sourceClass).toBe("ONCHAIN_VERIFIABLE");
    expect(row.officiality).toBe("CLAIMED");
    expect(row.onchainArtifactId).toBe(out.artifactId);
  });
});

describe("9/10/11/12/13. the derived-subject gate is unaffected", () => {
  async function deriveStandalone(f: Fixture, entries: unknown[], identityMint = f.mint) {
    const artifact = await artifactFor(f, entries);
    const stored = await persistOnchainArtifact({
      db: ctx.db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity: { chain: "solana", tokenAddress: identityMint, ticker: null },
    });
    if (!stored.artifactId) return { artifactId: null, written: 0 };
    const binding = validateOnchainBinding(artifact, {
      chain: "solana",
      tokenAddress: identityMint,
      ticker: null,
    });
    const written = await persistDerivedOnchainSubjects({
      db: ctx.db,
      artifactId: stored.artifactId,
      artifact,
      binding,
    });
    return { artifactId: stored.artifactId, written };
  }

  it("9. a valid STANDALONE artifact supports a derived subject", async () => {
    const f = await fixture();
    const { written } = await deriveStandalone(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    expect(written).toBe(1);
    const out = await resolveOnchainSubject(ctx.db, { ...f.query, subject: f.tokenAccount });
    expect(out.eligible).toBe(true);
    if (out.eligible) expect(out.provenance.class).toBe("DERIVED_ONCHAIN_SUBJECT");
  });

  it("10. an unbound observation still writes no derived subject", async () => {
    const f = await fixture();
    // Containment fails against a different confirmed identity, so the
    // artifact is not even persisted.
    const { artifactId, written } = await deriveStandalone(
      f,
      [tokenEntry(f.tokenAccount, f.wallet, f.mint)],
      FOREIGN_MINT,
    );
    expect(artifactId).toBeNull();
    expect(written).toBe(0);
    expect(
      await resolveOnchainSubject(ctx.db, { ...f.query, subject: f.tokenAccount }),
    ).toMatchObject({ eligible: false });
  });

  it("11. missing parent provenance still fails closed", async () => {
    const f = await fixture({ documentWallet: false });
    const { written } = await deriveStandalone(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    // The row is written — the artifact is valid — but the parent wallet was
    // never documented, so the gate refuses it.
    expect(written).toBe(1);
    expect(await resolveOnchainSubject(ctx.db, { ...f.query, subject: f.tokenAccount })).toEqual({
      eligible: false,
      reason: "PARENT_PROVENANCE_INVALID",
    });
  });

  it("12. a project-anchor mismatch still fails", async () => {
    const f = await fixture();
    await deriveStandalone(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    expect(
      await resolveOnchainSubject(ctx.db, {
        chain: "solana",
        network: "mainnet",
        projectAnchor: FOREIGN_MINT,
        subject: f.tokenAccount,
      }),
    ).toEqual({ eligible: false, reason: "ANCHOR_MISMATCH" });
  });

  it("13. the canonical URI alone still proves nothing", async () => {
    const f = await fixture();
    const artifact = await artifactFor(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    await deriveStandalone(f, [tokenEntry(f.tokenAccount, f.wallet, f.mint)]);
    expect(artifact.canonicalUri).not.toContain(f.tokenAccount);
    expect(
      await resolveOnchainSubject(ctx.db, { ...f.query, subject: artifact.canonicalUri }),
    ).toMatchObject({ eligible: false });
  });

  it("a derived subject from a standalone artifact still names its lineage", async () => {
    const f = await fixture();
    const { artifactId } = await deriveStandalone(f, [
      tokenEntry(f.tokenAccount, f.wallet, f.mint),
    ]);
    const [row] = await ctx.db
      .select()
      .from(onchainDerivedSubjects)
      .where(eq(onchainDerivedSubjects.subject, f.tokenAccount));
    expect(row.onchainArtifactId).toBe(artifactId);
    expect(row.parentSubject).toBe(f.wallet);
    expect(row.bindingStatus).toBe("CONFIRMED");
  });
});

describe("15. no project-specific logic", () => {
  it("the persistence path names no project, host or mechanism", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/onchain-acquisition.ts", import.meta.url),
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
    for (const banned of ["pump", "solscan", "hyperliquid", "uniswap", "burn"]) {
      expect(code, `persistence mentions "${banned}"`).not.toContain(banned);
    }
  });
});
