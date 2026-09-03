import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { onchainArtifacts, projects, topics, users } from "../src/server/db/schema";
import { persistOnchainArtifact } from "../src/server/engine/onchain-acquisition";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// AN OBSERVATION IS NOT THE SAME THING AS ITS NORMALIZED VALUE.
//
// `artifact_hash` is sha256 of the normalized RESULT, and identity used to
// be that hash alone — so two genuinely different chain observations
// collapsed into one row whenever they happened to report equal values:
//
//   slot 100: supply 1,000
//   slot 200: supply 1,000        <- silently dropped
//
// "Supply did not move between these two positions" is a finding, and the
// record could not hold it. Identity is now WHAT came back plus WHERE ON
// THE CHAIN it was read, and `artifact_hash` keeps its own separate meaning
// as a content address rather than being redefined to carry position.
//
// The defect was never supply-specific: four of the six intent kinds take
// their slot from the RPC context rather than the result body. These tests
// cover the affected kinds and the two unaffected ones alike.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const MINT = "Mint1111111111111111111111111111111111111111";
const ACCOUNT = "Acct1111111111111111111111111111111111111111";
const IDENTITY: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: MINT, ticker: "TST" };
const NOW = new Date("2026-09-03T00:00:00.000Z");

function observation(opts: {
  kind: OnchainIntent["kind"];
  subject: string;
  subjectKind: OnchainIntent["subjectKind"];
  result: OnchainResult;
  slot: number;
  retrievedAt?: Date;
  providerId?: string;
}): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: opts.kind,
    chain: "solana",
    network: "mainnet",
    projectAnchor: MINT,
    subjectKind: opts.subjectKind,
    subject: opts.subject,
  };
  // Reproduces the adapter exactly: the hash is of the NORMALIZED RESULT,
  // and the result of a context-slot kind carries no slot.
  const normalizedText = JSON.stringify(opts.result);
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result: opts.result,
    normalizedText,
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: opts.subjectKind,
      subject: opts.subject,
      slot: opts.slot,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: opts.providerId ?? "solana-mainnet-rpc",
      providerMethod: "fixture",
      requestParams: { subject: opts.subject },
      transactionSignature: opts.kind === "TRANSACTION_DETAIL" ? opts.subject : null,
      retrievedAt: opts.retrievedAt ?? NOW,
      // Distinct raw bytes per reading — the raw envelope carries the
      // context slot, so this differs even when the normalized value does
      // not. Deliberately NOT the identity: see the test below.
      rawResponseHash: `sha256:raw:${opts.kind}:${opts.subject}:${opts.slot}`,
      // THE CONTENT ADDRESS: identical for equal normalized results,
      // whatever slot they were read at. This is the whole collision.
      artifactHash: `sha256:art:${normalizedText}`,
    },
  });
}

function supply(slot: number, amountRaw = "1000", over: { retrievedAt?: Date; providerId?: string } = {}) {
  return observation({
    kind: "TOKEN_SUPPLY",
    subject: MINT,
    subjectKind: "token",
    result: { kind: "TOKEN_SUPPLY", mint: MINT, amountRaw, decimals: 6 },
    slot,
    ...over,
  });
}

function accountInfo(slot: number) {
  return observation({
    kind: "ACCOUNT_INFO",
    subject: ACCOUNT,
    subjectKind: "account",
    result: {
      kind: "ACCOUNT_INFO",
      address: ACCOUNT,
      exists: true,
      ownerProgram: "SysProg11111111111111111111111111111111111",
      executable: false,
      lamports: "64850000000",
      tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
      tokenAccount: null,
    },
    slot,
  });
}

async function standalone(artifact: OnchainArtifact) {
  return persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
    artifact,
    identity: IDENTITY,
  });
}

async function makeJob(): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("obsid"), name: "Observation Identity", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "did total supply move?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

async function jobScoped(jobId: string, artifact: OnchainArtifact) {
  return persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "RESEARCH_JOB", jobId },
    artifact,
    identity: IDENTITY,
  });
}

// Scoped by content address, and optionally by slot. Each test below uses
// its OWN amount so its content address is its own — equal values are
// exactly what collides, so sharing one across tests would make the counts
// meaningless.
async function standaloneRows(hash: string, slot?: number) {
  const rows = await ctx.db
    .select()
    .from(onchainArtifacts)
    .where(and(eq(onchainArtifacts.artifactHash, hash), isNull(onchainArtifacts.researchJobId)));
  return slot === undefined ? rows : rows.filter((r) => r.slot === slot);
}

// ---------------------------------------------------------------------
// 1/2/4 — equal values at different slots are two observations.
// ---------------------------------------------------------------------

describe("1/2/4. the same value at a later slot is a second observation", () => {
  it("1. standalone TOKEN_SUPPLY: SAME amount, different slots -> both persist", async () => {
    const t0 = supply(100, "1001");
    const t1 = supply(200, "1001");
    // The collision is real: the content addresses are identical.
    expect(t0.provenance.artifactHash).toBe(t1.provenance.artifactHash);

    const a = await standalone(t0);
    const b = await standalone(t1);
    expect(a.artifactId).toBeTruthy();
    expect(b.artifactId).toBeTruthy();
    expect(a.artifactId).not.toBe(b.artifactId);

    const rows = await standaloneRows(t0.provenance.artifactHash);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.slot).sort((x, y) => x - y)).toEqual([100, 200]);
  }, 120_000);

  it("2. standalone TOKEN_SUPPLY: different amount, different slots -> both persist", async () => {
    const t0 = supply(300, "1000");
    const t1 = supply(400, "990");
    expect(t0.provenance.artifactHash).not.toBe(t1.provenance.artifactHash);
    const a = await standalone(t0);
    const b = await standalone(t1);
    expect(a.artifactId).toBeTruthy();
    expect(b.artifactId).toBeTruthy();
    expect(a.artifactId).not.toBe(b.artifactId);
  }, 120_000);

  it("4. an equal normalized result does NOT by itself make a duplicate observation", async () => {
    // Stated as its own case because it is the invariant, not a side
    // effect: identity is value AND chain position, so equality of value
    // alone can never collapse two readings.
    const first = supply(504, "1004");
    const second = supply(505, "1004");
    expect(first.normalizedText).toBe(second.normalizedText);
    await standalone(first);
    await standalone(second);
    const rows = await standaloneRows(first.provenance.artifactHash);
    expect(rows.filter((r) => r.slot === 504 || r.slot === 505)).toHaveLength(2);
  }, 120_000);

  it("the defect was never supply-specific — ACCOUNT_INFO behaves the same", async () => {
    // Slot arrives in the RPC context for TOKEN_SUPPLY, ACCOUNT_INFO,
    // TOKEN_ACCOUNT_BALANCE and TOKEN_ACCOUNTS_BY_OWNER alike.
    const t0 = accountInfo(600);
    const t1 = accountInfo(700);
    expect(t0.provenance.artifactHash).toBe(t1.provenance.artifactHash);
    const a = await standalone(t0);
    const b = await standalone(t1);
    expect(a.artifactId).not.toBe(b.artifactId);
    expect(await standaloneRows(t0.provenance.artifactHash)).toHaveLength(2);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 3 — an exact retry is still one observation.
// ---------------------------------------------------------------------

describe("3. an exact retry stays idempotent", () => {
  it("the same reading at the same slot resolves to the same row", async () => {
    const first = supply(800, "1003");
    const a = await standalone(first);
    const b = await standalone(supply(800, "1003"));
    expect(a.artifactId).toBeTruthy();
    expect(b.artifactId).toBe(a.artifactId);
    expect(await standaloneRows(first.provenance.artifactHash)).toHaveLength(1);
  }, 120_000);

  it("retrievedAt is NOT the discriminator — a retry a second later is not a new observation", async () => {
    const first = supply(900, "1093", { retrievedAt: new Date("2026-09-03T00:00:00.000Z") });
    const retry = supply(900, "1093", { retrievedAt: new Date("2026-09-03T00:00:01.000Z") });
    const a = await standalone(first);
    const b = await standalone(retry);
    expect(b.artifactId).toBe(a.artifactId);
    expect(await standaloneRows(first.provenance.artifactHash)).toHaveLength(1);
    // And the FIRST retrieval's timestamp is what stands — nothing is
    // rewritten by a repeat.
    const [row] = await standaloneRows(first.provenance.artifactHash);
    expect(row.retrievedAt.toISOString()).toBe("2026-09-03T00:00:00.000Z");
  }, 120_000);
});

// ---------------------------------------------------------------------
// 5/6 — the two hashes keep their own, separate meanings.
// ---------------------------------------------------------------------

describe("5/6. artifactHash and rawResponseHash are unchanged", () => {
  it("5. artifactHash is still the content address of the normalized result", async () => {
    const { readFile } = await import("node:fs/promises");
    const adapter = await readFile("src/server/engine/providers/onchain-solana.ts", "utf-8");
    // Not redefined to include slot or retrieval provenance.
    expect(adapter).toContain("const normalizedText = canonicalJson(normalized.result);");
    expect(adapter).toContain("artifactHash: sha256(normalizedText),");
    // And equal values at different slots still hash equally — the hash did
    // not change, the IDENTITY did.
    expect(supply(1000, "1005").provenance.artifactHash).toBe(supply(2000, "1005").provenance.artifactHash);
  });

  it("6. rawResponseHash is still the hash of the raw response, and is not the identity", async () => {
    const { readFile } = await import("node:fs/promises");
    const adapter = await readFile("src/server/engine/providers/onchain-solana.ts", "utf-8");
    expect(adapter).toContain("rawResponseHash: sha256(rawText),");
    // Two readings at the SAME slot with different raw bytes are still one
    // observation: raw bytes vary with provider formatting, so making them
    // the identity would break exact-retry idempotency.
    const a = supply(1100, "1006");
    const b = supply(1100, "1006");
    (b.provenance as { rawResponseHash: string }).rawResponseHash = "sha256:raw:reformatted";
    expect(a.provenance.rawResponseHash).not.toBe(b.provenance.rawResponseHash);
    const first = await standalone(a);
    const second = await standalone(b);
    expect(second.artifactId).toBe(first.artifactId);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 7/8 — nothing else moved.
// ---------------------------------------------------------------------

describe("7/8. existing rows stay readable, and job-scoped mode is fixed too", () => {
  it("7. an observation written before the change is still readable and still unique", async () => {
    // A row inserted directly, as a pre-change row would exist, then read
    // back and re-observed: the historical row stands and the retry finds it.
    const legacy = supply(1200, "1007");
    const inserted = await standalone(legacy);
    const [row] = await standaloneRows(legacy.provenance.artifactHash);
    expect(row.id).toBe(inserted.artifactId);
    expect(row.artifactHash).toBe(legacy.provenance.artifactHash);
    expect(row.originKind).toBe("STANDALONE_STRUCTURED_OBSERVATION");
    expect(row.researchJobId).toBeNull();
    const again = await standalone(supply(1200, "1007"));
    expect(again.artifactId).toBe(inserted.artifactId);
  }, 120_000);

  it("8. JOB-SCOPED mode had the same defect and is fixed the same way", async () => {
    const jobId = await makeJob();
    const t0 = supply(1300, "1008");
    const t1 = supply(1400, "1008");
    expect(t0.provenance.artifactHash).toBe(t1.provenance.artifactHash);

    const a = await jobScoped(jobId, t0);
    const b = await jobScoped(jobId, t1);
    expect(a.artifactId).toBeTruthy();
    expect(b.artifactId).toBeTruthy();
    expect(a.artifactId).not.toBe(b.artifactId);

    // And an exact retry inside the job is still one row.
    const retry = await jobScoped(jobId, supply(1300, "1008"));
    expect(retry.artifactId).toBe(a.artifactId);

    const rows = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.researchJobId, jobId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.slot).sort((x, y) => x - y)).toEqual([1300, 1400]);
  }, 120_000);

  it("the two modes stay separate — an identical observation in each is two rows", async () => {
    const jobId = await makeJob();
    const value = supply(1500, "1009");
    const alone = await standalone(value);
    const scoped = await jobScoped(jobId, supply(1500, "1009"));
    expect(alone.artifactId).not.toBe(scoped.artifactId);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 9/10/11 — boundaries.
// ---------------------------------------------------------------------

describe("9/10/11. identity only — no memory, no project logic, no wiring", () => {
  it("9/10. the migration and schema name no project and no memory concept", async () => {
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(
      "src/server/db/migrations/0043_onchain_observation_identity.sql",
      "utf-8",
    );
    const lower = migration.toLowerCase();
    for (const banned of ["pump", "raydium", "memory", "freshness", "stale_after", "reuse policy"]) {
      expect(lower, `migration must not mention ${banned}`).not.toContain(banned);
    }
    // Widening only: it drops the two narrow indexes and creates two wider
    // ones. Nothing is deleted, merged or backfilled.
    expect(migration).toContain('DROP INDEX IF EXISTS "uq_onchain_artifacts_job_artifact"');
    expect(migration).toContain('DROP INDEX IF EXISTS "uq_onchain_artifacts_standalone_hash"');
    expect(migration).toContain('CREATE UNIQUE INDEX "uq_onchain_artifacts_job_observation"');
    expect(migration).toContain('CREATE UNIQUE INDEX "uq_onchain_artifacts_standalone_observation"');
    for (const destructive of ["DELETE", "TRUNCATE", "UPDATE ", "DROP TABLE", "DROP COLUMN"]) {
      expect(migration, `migration must not ${destructive}`).not.toContain(destructive);
    }
  });

  it("11. no B2a delta, NET_EFFECT or applicability wiring came with it", async () => {
    const { readFile } = await import("node:fs/promises");
    const acquisition = await readFile("src/server/engine/onchain-acquisition.ts", "utf-8");
    expect(acquisition).not.toContain("onchain-supply-delta");
    expect(acquisition).not.toContain("deriveTotalSupplyDelta");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).not.toContain("SUPPLY_DELTA");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
  });

  it("the conflict arbiter and the recovery lookup describe the SAME identity", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-acquisition.ts", "utf-8");
    // Both halves must carry slot, or a conflict would resolve to a
    // different observation than the one being written.
    expect(src).toContain("onchainArtifacts.slot,\n            ],");
    expect(src).toContain("target: [onchainArtifacts.artifactHash, onchainArtifacts.slot],");
    expect(src).toContain("eq(onchainArtifacts.slot, p.slot),");
  });
});
