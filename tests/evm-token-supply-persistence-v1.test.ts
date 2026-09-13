import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, onchainArtifacts, projects, sources, topics, users } from "../src/server/db/schema";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import {
  createEvmOnchainAdapter,
  ERC20_DECIMALS_SELECTOR,
  ERC20_TOTAL_SUPPLY_SELECTOR,
} from "../src/server/engine/providers/onchain-evm";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// EVM TOKEN_SUPPLY V1 — persistence. The one database-backed check: an
// Ethereum observation goes through the SAME artifact-and-facts path a
// Solana one does, lands in the same tables, and is identified there by
// its own environment. No EVM-specific column, table or fact kind exists.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const TOKEN = "0x" + "ab12".repeat(10);
const BLOCK_HASH = "0x" + "ef".repeat(32);
const identity: ConfirmedProjectIdentity = { chain: "ethereum", tokenAddress: TOKEN, ticker: "T" };

function word(value: number): string {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

const transport: OnchainRpcTransport = {
  async call(method, params) {
    if (method === "eth_chainId") return envelope("0x1");
    if (method === "eth_getBlockByNumber") {
      return envelope({ number: "0x1234abc", hash: BLOCK_HASH, timestamp: "0x66f2a1c0" });
    }
    const data = (params[0] as { data: string }).data;
    if (data === ERC20_TOTAL_SUPPLY_SELECTOR) return envelope(word(1_000_000));
    if (data === ERC20_DECIMALS_SELECTOR) return envelope(word(18));
    throw new Error(`fixture: unexpected ${method} ${data}`);
  },
};

async function makeJob(): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("evm"), name: "EVM Test Project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "does the mechanism reduce supply?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

describe("M. an Ethereum TOKEN_SUPPLY observation persists through the existing path, identified by environment", () => {
  it("stores one artifact row and one CONFIRMED-bound ONCHAIN_VERIFIABLE evidence row", async () => {
    const jobId = await makeJob();
    const adapter = createEvmOnchainAdapter({
      transport,
      providerId: "fixture-evm-rpc",
      environment: { chain: "ethereum", network: "mainnet" },
    });
    const artifact = await adapter.retrieve({
      kind: "TOKEN_SUPPLY",
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: TOKEN,
      subjectKind: "token",
      subject: TOKEN,
    });

    const result = await persistOnchainArtifactAndFacts({
      db: ctx.db,
      jobId,
      artifact,
      identity,
      target: { step: 5, component: "CURRENT_STATE" },
    });
    expect(result.rejectedReason).toBeNull();
    expect(result.evidenceIds.length).toBe(1);

    const [row] = await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, jobId));
    expect(row).toMatchObject({
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: TOKEN,
      subjectKind: "token",
      subject: TOKEN,
      intentKind: "TOKEN_SUPPLY",
      // The finalized block number sits in the persisted `slot` column —
      // the column keeps its name; the value is the environment's ordinal.
      slot: 0x1234abc,
      blockHash: BLOCK_HASH,
      finality: "finalized",
      providerId: "fixture-evm-rpc",
      providerMethod: "eth_call",
      transactionSignature: null,
      canonicalUri: `atlas-onchain://ethereum/mainnet/project/${TOKEN}/token/${TOKEN}/supply`,
    });
    expect(row.blockTime?.getTime()).toBe(0x66f2a1c0 * 1000);
    expect(row.normalizedResult).toEqual({ kind: "TOKEN_SUPPLY", mint: TOKEN, amountRaw: "1000000", decimals: 18 });

    const evidenceRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(evidenceRows.length).toBe(1);
    expect(evidenceRows[0]).toMatchObject({
      onchainArtifactId: row.id,
      sourceClass: "ONCHAIN_VERIFIABLE",
      entityBinding: "CONFIRMED",
      component: "CURRENT_STATE",
    });
    const [source] = await ctx.db.select().from(sources).where(eq(sources.id, row.sourceId!));
    expect(source.url).toBe(row.canonicalUri);
  });

  it("the same observation under a Solana identity is refused at the same gate, and nothing is stored", async () => {
    const jobId = await makeJob();
    const adapter = createEvmOnchainAdapter({
      transport,
      providerId: "fixture-evm-rpc",
      environment: { chain: "ethereum", network: "mainnet" },
    });
    const artifact = await adapter.retrieve({
      kind: "TOKEN_SUPPLY",
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: TOKEN,
      subjectKind: "token",
      subject: TOKEN,
    });
    const result = await persistOnchainArtifactAndFacts({
      db: ctx.db,
      jobId,
      artifact,
      identity: { chain: "solana", tokenAddress: "So11111111111111111111111111111111111111112", ticker: "S" },
      target: { step: 5, component: "CURRENT_STATE" },
    });
    expect(result.rejectedReason).toBe("BINDING_NOT_CONFIRMED");
    expect(result.evidenceIds).toEqual([]);
    expect(await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, jobId))).toEqual([]);
    expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId))).toEqual([]);
  });
});
