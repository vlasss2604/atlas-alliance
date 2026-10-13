import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  onchainArtifacts,
  productConfig,
  projectMemoryItems,
  projects,
  researchComponentResults,
  researchJobs,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import {
  createEvmOnchainAdapter,
  ERC20_DECIMALS_SELECTOR,
  ERC20_TOTAL_SUPPLY_SELECTOR,
} from "../src/server/engine/providers/onchain-evm";
import type { OnchainRetriever, OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainEnvironment } from "../src/server/engine/providers/onchain-types";
import { promoteProjectMemoryItem } from "../src/server/memory/lifecycle";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { observeTokenSupply, type TokenSupplyObservationDeps } from "../scripts/onchain-observe-token-supply";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// GENERIC PERSISTING TOKEN_SUPPLY PROBE — the bounded operator path
//
//   project -> confirmed PROJECT_IDENTITY -> exact environment retriever
//   -> TOKEN_SUPPLY -> canonical OnchainArtifact -> canonical Evidence
//
// driven here end to end against the test database with fixture-backed
// retrievers for BOTH implemented environments. Nothing opens a socket.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  await ctx.db.update(productConfig).set({ value: true }).where(eq(productConfig.key, "internal_alpha_enabled"));
});

afterAll(async () => {
  await ctx.close();
});

const SOLANA_MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const EVM_TOKEN = "0x" + "ab12".repeat(10);
const BLOCK_HASH = "0x" + "ef".repeat(32);

const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
const word = (n: number) => "0x" + BigInt(n).toString(16).padStart(64, "0");

function solanaTransport() {
  const calls: string[] = [];
  const transport: OnchainRpcTransport = {
    async call(method) {
      calls.push(method);
      return envelope({ context: { slot: 4321 }, value: { amount: "1000000", decimals: 6 } });
    },
  };
  return { transport, calls };
}

function evmTransport() {
  const calls: string[] = [];
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      calls.push(method);
      if (method === "eth_chainId") return envelope("0x1");
      if (method === "eth_getBlockByNumber") return envelope({ number: "0x1234abc", hash: BLOCK_HASH, timestamp: "0x66f2a1c0" });
      const data = (params[0] as { data: string }).data;
      if (data === ERC20_TOTAL_SUPPLY_SELECTOR) return envelope(word(5_000_000));
      if (data === ERC20_DECIMALS_SELECTOR) return envelope(word(18));
      throw new Error(`fixture: unexpected ${method} ${data}`);
    },
  };
  return { transport, calls };
}

function solanaRetriever() {
  const { transport, calls } = solanaTransport();
  return { retriever: createSolanaOnchainAdapter({ transport, providerId: "fixture-solana-rpc", finality: "finalized" }), calls };
}

function evmRetriever() {
  const { transport, calls } = evmTransport();
  return {
    retriever: createEvmOnchainAdapter({ transport, providerId: "fixture-evm-rpc", environment: { chain: "ethereum", network: "mainnet" } }),
    calls,
  };
}

// A resolver that records which environment the probe asked for and answers
// from a map — never from a chain name of its own.
function resolverFor(map: Partial<Record<string, OnchainRetriever>>) {
  const asked: string[] = [];
  const resolve = (env: OnchainEnvironment) => {
    const key = `${env.chain}/${env.network}`;
    asked.push(key);
    return map[key] ?? null;
  };
  return { resolve, asked };
}

async function makeProject(prefix = "probe") {
  const slug = uniq(prefix);
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Probe fixture", status: "ACTIVE_CORE" }).returning();
  return { slug, id: project.id };
}

async function confirm(slug: string, chain: "solana" | "ethereum", tokenAddress: string) {
  const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain, tokenAddress });
  expect(r.ok).toBe(true);
}

function deps(slug: string, resolve: TokenSupplyObservationDeps["resolveRetriever"], extra: Partial<TokenSupplyObservationDeps> = {}): TokenSupplyObservationDeps {
  return { db: ctx.db, boss: ctx.boss, projectSlug: slug, resolveRetriever: resolve, liveAllowlist: new Set([slug]), ...extra };
}

async function rowsFor(jobId: string) {
  const artifacts = await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, jobId));
  const evidenceRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
  return { artifacts, evidenceRows };
}

// ---------------------------------------------------------------------
// A + B: no identity, no retrieval.
// ---------------------------------------------------------------------

describe("identity gate — nothing is constructed, nothing is read, no job exists", () => {
  it("A. missing PROJECT_IDENTITY -> NO_ACTIVE_IDENTITY, resolver never asked, no job created", async () => {
    const p = await makeProject();
    const { resolve, asked } = resolverFor({ "solana/mainnet": solanaRetriever().retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome).toEqual({ ok: false, refusal: "NO_ACTIVE_IDENTITY", detail: expect.any(String), jobId: null });
    expect(asked).toEqual([]);
    expect(await ctx.db.select().from(researchJobs).where(eq(researchJobs.projectId, p.id))).toEqual([]);
  });

  it("B. a non-ACTIVE identity is no identity -> no retrieval", async () => {
    const p = await makeProject();
    await confirm(p.slug, "solana", SOLANA_MINT);
    await ctx.db
      .update(projectMemoryItems)
      .set({ lifecycleState: "SUPERSEDED" })
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "PROJECT_IDENTITY")));
    const { resolve, asked } = resolverFor({ "solana/mainnet": solanaRetriever().retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome).toMatchObject({ ok: false, refusal: "NO_ACTIVE_IDENTITY" });
    expect(asked).toEqual([]);
  });

  it("two ACTIVE identities are ambiguous -> refused, never one of them observed", async () => {
    const p = await makeProject();
    await confirm(p.slug, "solana", SOLANA_MINT);
    // A second ACTIVE row, promoted through the lifecycle path — the
    // confirmation script itself refuses to create one (ACTIVE_IDENTITY_EXISTS),
    // so this is the only way the state can arise.
    const [second] = await ctx.db
      .insert(projectMemoryItems)
      .values({
        projectId: p.id,
        kind: "PROJECT_IDENTITY",
        lifecycleState: "OBSERVED",
        content: { chain: "ethereum", tokenAddress: EVM_TOKEN },
      })
      .returning();
    await promoteProjectMemoryItem(ctx.db, second.id);
    const { resolve, asked } = resolverFor({ "solana/mainnet": solanaRetriever().retriever, "ethereum/mainnet": evmRetriever().retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome).toMatchObject({ ok: false, refusal: "AMBIGUOUS_IDENTITY" });
    expect(asked).toEqual([]);
  });

  it("an identity confirmed without a token address is refused before any environment is resolved", async () => {
    const p = await makeProject();
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: p.slug, chain: "ethereum" });
    expect(r.ok).toBe(true);
    const { resolve, asked } = resolverFor({ "ethereum/mainnet": evmRetriever().retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome).toMatchObject({ ok: false, refusal: "IDENTITY_WITHOUT_TOKEN" });
    expect(asked).toEqual([]);
  });

  it("the owner gates still hold: not in the live allowlist, or internal alpha off, is refused first", async () => {
    const p = await makeProject();
    await confirm(p.slug, "solana", SOLANA_MINT);
    const { resolve, asked } = resolverFor({ "solana/mainnet": solanaRetriever().retriever });
    expect(await observeTokenSupply(deps(p.slug, resolve, { liveAllowlist: new Set() }))).toMatchObject({
      ok: false,
      refusal: "NOT_IN_LIVE_ALLOWLIST",
    });
    await ctx.db.update(productConfig).set({ value: false }).where(eq(productConfig.key, "internal_alpha_enabled"));
    try {
      expect(await observeTokenSupply(deps(p.slug, resolve))).toMatchObject({ ok: false, refusal: "INTERNAL_ALPHA_DISABLED" });
    } finally {
      await ctx.db.update(productConfig).set({ value: true }).where(eq(productConfig.key, "internal_alpha_enabled"));
    }
    expect(await observeTokenSupply(deps("no_such_project", resolve))).toMatchObject({ ok: false, refusal: "PROJECT_NOT_FOUND" });
    expect(asked).toEqual([]);
  });

  it("a component the Pattern does not establish by ONCHAIN_VERIFIABLE is refused; unknown components too", async () => {
    const p = await makeProject();
    await confirm(p.slug, "solana", SOLANA_MINT);
    const { resolve, asked } = resolverFor({ "solana/mainnet": solanaRetriever().retriever });
    expect(await observeTokenSupply(deps(p.slug, resolve, { component: "GOVERNANCE_BASIS" }))).toMatchObject({
      ok: false,
      refusal: "COMPONENT_NOT_ONCHAIN",
    });
    expect(await observeTokenSupply(deps(p.slug, resolve, { component: "NOT_A_COMPONENT" }))).toMatchObject({
      ok: false,
      refusal: "UNKNOWN_COMPONENT",
    });
    expect(asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// C + D + E + F + G + K: environment resolution and the single observation.
// ---------------------------------------------------------------------

describe("environment — the identity's chain picks the retriever; the operator picks nothing", () => {
  it("C + F + G. a Solana identity resolves solana/mainnet, one TOKEN_SUPPLY intent, one RPC request", async () => {
    const p = await makeProject();
    await confirm(p.slug, "solana", SOLANA_MINT);
    const solana = solanaRetriever();
    const { resolve, asked } = resolverFor({ "solana/mainnet": solana.retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(asked).toEqual(["solana/mainnet"]);
    // F. nothing about the chain came from the caller: the intent carries
    // the identity's own chain, network and token.
    expect(outcome.artifact.intent).toEqual({
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: SOLANA_MINT,
      subjectKind: "token",
      subject: SOLANA_MINT,
    });
    // G + K. exactly one request, the supply method, nothing else.
    expect(solana.calls).toEqual(["getTokenSupply"]);
    expect(outcome.step).toBe(5);
    expect(outcome.component).toBe("CURRENT_STATE");
  });

  it("D + F + G. an Ethereum identity resolves ethereum/mainnet, one TOKEN_SUPPLY intent, the adapter's four bounded requests", async () => {
    const p = await makeProject();
    await confirm(p.slug, "ethereum", EVM_TOKEN);
    const evm = evmRetriever();
    const { resolve, asked } = resolverFor({ "ethereum/mainnet": evm.retriever, "solana/mainnet": solanaRetriever().retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(asked).toEqual(["ethereum/mainnet"]);
    expect(outcome.environment).toEqual({ chain: "ethereum", network: "mainnet" });
    expect(outcome.artifact.intent).toMatchObject({ kind: "TOKEN_SUPPLY", chain: "ethereum", network: "mainnet", subject: EVM_TOKEN });
    // One observation; the four requests are the EVM adapter's own bounded
    // sequence for one TOKEN_SUPPLY, never a second intent.
    expect(evm.calls).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_call"]);
    expect(outcome.artifact.result).toEqual({ kind: "TOKEN_SUPPLY", mint: EVM_TOKEN, amountRaw: "5000000", decimals: 18 });
    expect(outcome.artifact.provenance).toMatchObject({ slot: 0x1234abc, blockHash: BLOCK_HASH, blockTime: 0x66f2a1c0, finality: "finalized" });
  });

  it("E. an Ethereum identity in a process with only a Solana retriever is refused — never served by Solana", async () => {
    const p = await makeProject();
    await confirm(p.slug, "ethereum", EVM_TOKEN);
    const solana = solanaRetriever();
    const { resolve, asked } = resolverFor({ "solana/mainnet": solana.retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome).toMatchObject({ ok: false, refusal: "RETRIEVER_NOT_CONFIGURED", jobId: null });
    expect(asked).toEqual(["ethereum/mainnet"]);
    expect(solana.calls).toEqual([]);
    expect(await ctx.db.select().from(researchJobs).where(eq(researchJobs.projectId, p.id))).toEqual([]);
  });

  it("the reverse holds: a Solana identity with only an Ethereum retriever is refused, and the EVM adapter is never asked", async () => {
    const p = await makeProject();
    await confirm(p.slug, "solana", SOLANA_MINT);
    const evm = evmRetriever();
    const { resolve, asked } = resolverFor({ "ethereum/mainnet": evm.retriever });
    expect(await observeTokenSupply(deps(p.slug, resolve))).toMatchObject({ ok: false, refusal: "RETRIEVER_NOT_CONFIGURED" });
    expect(asked).toEqual(["solana/mainnet"]);
    expect(evm.calls).toEqual([]);
  });

  it("a retriever that does not serve TOKEN_SUPPLY for the environment is refused before any request", async () => {
    const p = await makeProject();
    await confirm(p.slug, "ethereum", EVM_TOKEN);
    const evm = evmRetriever();
    // The Solana adapter mis-installed under the Ethereum key: its own
    // supports() refuses the environment, so nothing is issued.
    const { resolve } = resolverFor({ "ethereum/mainnet": solanaRetriever().retriever });
    expect(await observeTokenSupply(deps(p.slug, resolve))).toMatchObject({ ok: false, refusal: "INTENT_NOT_SUPPORTED" });
    expect(evm.calls).toEqual([]);
  });

  it("a retrieval failure is reported, the job holds no Evidence, and nothing is retried", async () => {
    const p = await makeProject();
    await confirm(p.slug, "ethereum", EVM_TOKEN);
    let attempts = 0;
    const failing: OnchainRetriever = {
      name: "failing",
      supports: () => true,
      retrieve: async () => {
        attempts += 1;
        throw new Error("fixture: node unavailable");
      },
    };
    const { resolve } = resolverFor({ "ethereum/mainnet": failing });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome).toMatchObject({ ok: false, refusal: "RETRIEVAL_FAILED", detail: "fixture: node unavailable" });
    expect(attempts).toBe(1);
    if (!outcome.ok && outcome.jobId) {
      const { artifacts, evidenceRows } = await rowsFor(outcome.jobId);
      expect(artifacts).toEqual([]);
      expect(evidenceRows).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------
// H + I + J + L + M: canonical persistence, binding, and what is NOT written.
// ---------------------------------------------------------------------

describe("persistence — the production path, byte-for-byte what Research would write", () => {
  it("H + I. the Ethereum observation lands in the same rows Research writes, ONCHAIN_VERIFIABLE and CONFIRMED-bound", async () => {
    const p = await makeProject();
    await confirm(p.slug, "ethereum", EVM_TOKEN);
    const { resolve } = resolverFor({ "ethereum/mainnet": evmRetriever().retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.binding).toEqual({ binding: "CONFIRMED" });

    const { artifacts, evidenceRows } = await rowsFor(outcome.jobId);
    expect(artifacts).toHaveLength(1);
    expect(evidenceRows).toHaveLength(1);
    const artifactRow = artifacts[0];
    expect(artifactRow).toMatchObject({
      id: outcome.artifactId,
      originKind: "RESEARCH_JOB",
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: EVM_TOKEN,
      subjectKind: "token",
      subject: EVM_TOKEN,
      intentKind: "TOKEN_SUPPLY",
      slot: 0x1234abc,
      blockHash: BLOCK_HASH,
      finality: "finalized",
      providerId: "fixture-evm-rpc",
      providerMethod: "eth_call",
      canonicalUri: `atlas-onchain://ethereum/mainnet/project/${EVM_TOKEN}/token/${EVM_TOKEN}/supply`,
    });
    expect(artifactRow.normalizedResult).toEqual({ kind: "TOKEN_SUPPLY", mint: EVM_TOKEN, amountRaw: "5000000", decimals: 18 });
    expect(evidenceRows[0]).toMatchObject({
      id: outcome.evidenceIds[0],
      onchainArtifactId: outcome.artifactId,
      sourceClass: "ONCHAIN_VERIFIABLE",
      officiality: "CLAIMED",
      entityBinding: "CONFIRMED",
      component: "CURRENT_STATE",
      patternStep: 5,
    });
    const [source] = await ctx.db.select().from(sources).where(eq(sources.id, artifactRow.sourceId!));
    expect(source.url).toBe(artifactRow.canonicalUri);
    // No website authority was involved: the source is the canonical URI,
    // not an http(s) page, and no SOURCE_ROUTE exists for this project.
    expect(source.url.startsWith("atlas-onchain://")).toBe(true);
    expect(
      await ctx.db.select().from(projectMemoryItems).where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE"))),
    ).toEqual([]);
    // Reconciliation ran for the one component, scoped to this job.
    const results = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, outcome.jobId));
    expect(results.map((r) => r.component)).toEqual(["CURRENT_STATE"]);
    expect(outcome.reconciliation.status).toBe(results[0].status);
  });

  it("H. identical to Research persistence: the same artifact persisted through a Research-created job yields the same rows", async () => {
    const p = await makeProject();
    await confirm(p.slug, "solana", SOLANA_MINT);
    const { resolve } = resolverFor({ "solana/mainnet": solanaRetriever().retriever });
    const probe = await observeTokenSupply(deps(p.slug, resolve));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    // What Research would do with the very same artifact, in a job it
    // created itself.
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId: topic.id,
      projectId: p.id,
      originalQuestion: "does the mechanism reduce supply?",
      normalizedTask: { project_slug: p.slug, project_slugs: [p.slug], task: "t" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    const research = await persistOnchainArtifactAndFacts({
      db: ctx.db,
      jobId: job.id,
      artifact: probe.artifact,
      identity: probe.identity,
      target: { step: 5, component: "CURRENT_STATE" },
    });
    expect(research.rejectedReason).toBeNull();

    const strip = (row: Record<string, unknown>) => {
      const { id, researchJobId, sourceId, createdAt, updatedAt, ...rest } = row;
      void id; void researchJobId; void sourceId; void createdAt; void updatedAt;
      return rest;
    };
    const [probeArtifact] = (await rowsFor(probe.jobId)).artifacts;
    const [researchArtifact] = (await rowsFor(job.id)).artifacts;
    expect(strip(probeArtifact as Record<string, unknown>)).toEqual(strip(researchArtifact as Record<string, unknown>));
    // Same source row: the canonical URI is one identity across jobs.
    expect(probeArtifact.sourceId).toBe(researchArtifact.sourceId);

    // extractionUnitKey is job-scoped by construction (it hashes the job
    // id with the artifact hash), so it differs across jobs exactly as it
    // would between two Research jobs; everything else must agree.
    const stripEvidence = (row: Record<string, unknown>) => {
      const { id, researchJobId, onchainArtifactId, createdAt, updatedAt, extractionUnitKey, ...rest } = row;
      void id; void researchJobId; void onchainArtifactId; void createdAt; void updatedAt; void extractionUnitKey;
      return rest;
    };
    const [probeEvidence] = (await rowsFor(probe.jobId)).evidenceRows;
    const [researchEvidence] = (await rowsFor(job.id)).evidenceRows;
    expect(stripEvidence(probeEvidence as Record<string, unknown>)).toEqual(stripEvidence(researchEvidence as Record<string, unknown>));
  });

  it("J. a wrong-chain artifact fails closed at the production gate: nothing admitted, nothing written", async () => {
    const p = await makeProject();
    await confirm(p.slug, "ethereum", EVM_TOKEN);
    // A retriever installed under the Ethereum key that answers with a
    // SOLANA artifact — the adapter's supports() says yes, its artifact
    // says solana. Binding, not the script, must refuse it.
    const solana = solanaRetriever();
    const lying: OnchainRetriever = {
      name: "lying",
      supports: () => true,
      retrieve: (intent) =>
        solana.retriever.retrieve({ ...intent, chain: "solana", projectAnchor: SOLANA_MINT, subject: SOLANA_MINT }),
    };
    const { resolve } = resolverFor({ "ethereum/mainnet": lying });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome).toMatchObject({ ok: false, refusal: "NOT_PERSISTED" });
    if (outcome.ok || !outcome.jobId) throw new Error("expected a job id on NOT_PERSISTED");
    expect(outcome.detail).toContain("BINDING_NOT_CONFIRMED");
    const { artifacts, evidenceRows } = await rowsFor(outcome.jobId);
    expect(artifacts).toEqual([]);
    expect(evidenceRows).toEqual([]);
    expect(await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, outcome.jobId))).toEqual([]);
  });

  it("L. the observation is an owner-attributed, never-enqueued job; it writes no Research Memory", async () => {
    const p = await makeProject();
    await confirm(p.slug, "ethereum", EVM_TOKEN);
    const before = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.projectId, p.id));
    const { resolve } = resolverFor({ "ethereum/mainnet": evmRetriever().retriever });
    const outcome = await observeTokenSupply(deps(p.slug, resolve));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.projectId, p.id));
    // Exactly the one PROJECT_IDENTITY row that was there before.
    expect(after.map((r) => r.kind)).toEqual(before.map((r) => r.kind));
    expect(after).toHaveLength(1);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, outcome.jobId));
    expect(job.originalQuestion).toContain("observe on-chain TOKEN_SUPPLY");
    expect((job.normalizedTask as { task: string }).task).toContain("one bounded TOKEN_SUPPLY read");
    expect(job.budgetAtStart).toMatchObject({ maxSourceOpens: 1, maxSearchQueries: 0, maxModelCostMicro: 0 });
    // The job is an owner-run operation, never a product research job.
    expect(job.state).toBe("QUEUED");
    // Never enqueued: no pg-boss task exists for this job.
    const queued = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'jobId' = ${outcome.jobId}`,
    );
    expect(Number((queued.rows[0] as { n: number }).n)).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Structural guarantees over the entrypoint's source.
// ---------------------------------------------------------------------

describe("the entrypoint's source — one intent, no chain literal, no second surface", () => {
  const raw = readFileSync("scripts/onchain-observe-token-supply.ts", "utf-8");
  const code = raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  it("F. the operator can name a project and a component, and nothing about the chain", () => {
    expect(code).toContain('arg.startsWith("--project=")');
    expect(code).toContain('arg.startsWith("--component=")');
    for (const banned of ["--chain", "--network", "--token", "--address", "--mint", "--contract", "--rpc", "--endpoint"]) {
      expect(code, banned).not.toContain(banned);
    }
  });

  it("no chain branching: neither chain is named in code, and the environment comes from the seam", () => {
    for (const banned of ['"solana"', '"ethereum"', "'solana'", "'ethereum'", "solana/mainnet", "ethereum/mainnet", "SOLANA_MAINNET_RPC_URL", "ETHEREUM_MAINNET_RPC_URL"]) {
      expect(code, banned).not.toContain(banned);
    }
    expect(code).toContain("onchainEnvironmentFor(identity.chain)");
    expect(code).toContain("createProductionOnchainRetriever(env.chain, env.network)");
    expect(code).toContain("resolveConfirmedIdentity(db, project.id)");
  });

  it("G + K. exactly one intent kind, one retrieve, no retry, no loop around the read, no other primitive", () => {
    expect(code).toContain('const INTENT_KIND = "TOKEN_SUPPLY" as const');
    expect((code.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    expect((code.match(/const intent: OnchainIntent = \{/g) ?? []).length).toBe(1);
    for (const banned of [
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNT_BALANCE",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "balanceOf",
      "getLogs",
      "retry",
      "while (",
      "Promise.all",
      "selectOnchainIntents",
      "runStructuredOnchainAcquisition",
      "onchain-subject-promotion",
      "s4-executor",
      "anthropic",
      "search-gateway",
      "content-fetcher",
      "rendered-docs",
      "promote",
      "SOURCE_ROUTE",
    ]) {
      expect(code, banned).not.toContain(banned);
    }
  });

  it("M. persistence is the production function, never a second writer", () => {
    expect(code).toContain("persistOnchainArtifactAndFacts({");
    for (const banned of ["insert(onchainArtifacts)", "insert(evidence)", "insert(sources)", "insert(projectMemoryItems)", "STANDALONE_STRUCTURED_OBSERVATION"]) {
      expect(code, banned).not.toContain(banned);
    }
    expect(code).toContain("{ skipEnqueue: true }");
  });
});
