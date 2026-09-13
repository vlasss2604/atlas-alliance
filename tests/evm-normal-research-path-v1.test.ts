import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { evidence, onchainArtifacts, projects, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { loadAcquisitionPlan } from "../src/server/engine/acquisition-plan";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { MAX_ONCHAIN_INTENTS_PER_ATTEMPT, selectOnchainIntents } from "../src/server/engine/onchain-acquisition";
import { loadHistoricalSupplyCandidates } from "../src/server/engine/onchain-supply-candidate-store";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import {
  createEvmOnchainAdapter,
  ERC20_DECIMALS_SELECTOR,
  ERC20_TOTAL_SUPPLY_SELECTOR,
} from "../src/server/engine/providers/onchain-evm";
import {
  __setOnchainRetriever,
  onchainRetrievalAvailable,
  resolveOnchainRetriever,
  type OnchainRpcTransport,
} from "../src/server/engine/providers/onchain-retriever";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { installOnchainResearchCapability } from "../src/server/jobs/onchain-capability";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// NORMAL RESEARCH → EVM TOKEN_SUPPLY PATH AUDIT V1 — the offline proof.
//
// The first live Ethereum TOKEN_SUPPLY observation was an OWNER script.
// That script reaches the retriever through its own seam and proves
// nothing about whether ORDINARY Research — a PRODUCT job walking the
// Pattern through the real S4 executor — can consume the same primitive.
// These tests start where a real Research attempt starts: a project with
// a confirmed Ethereum identity, a PRODUCT-origin job, an EXTRACT-role
// process that installed the Ethereum environment through the production
// capability installer, and the real executor asked to work CURRENT_STATE.
//
// Nothing here names Lido; the identity is any Ethereum token. ZERO
// network: the EVM adapter is the production adapter over a scripted
// transport that records exactly what it was asked.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setOnchainRetriever(null);
});

// One token per project: the historical supply loader keys by the
// environment-qualified anchor, so two fixtures sharing an address would
// see each other's readings — as two real projects sharing one contract
// would, which is not a state the identity workflow ever produces.
let tokenSeq = 0;
function nextToken(): string {
  tokenSeq += 1;
  return "0x" + "Ab12".repeat(8) + tokenSeq.toString(16).padStart(8, "0");
}
const BLOCK_NUMBER = 0x1234abc;
const BLOCK_HASH = "0x" + "ef".repeat(32);
const BLOCK_TIME = 0x66f2a1c0;
const SUPPLY_RAW = "1000000000000000000000000000"; // 1e27 — a uint256 that must never pass through a double

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

const CURRENT_STATE: ComponentWorkItem = {
  step: 5,
  stepName: "Current State",
  component: "CURRENT_STATE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

function word(value: bigint | number): string {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}
const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

// The production EVM adapter over a scripted transport. Every call is
// recorded, so the test can state the exact RPC footprint of one normal
// Research read.
function evmFixture() {
  const calls: { method: string; params: unknown[] }[] = [];
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "eth_chainId") return envelope("0x1");
      if (method === "eth_getBlockByNumber") {
        return envelope({ number: "0x" + BLOCK_NUMBER.toString(16), hash: BLOCK_HASH, timestamp: "0x" + BLOCK_TIME.toString(16) });
      }
      if (method === "eth_call") {
        const data = (params[0] as { data: string }).data;
        if (data === ERC20_TOTAL_SUPPLY_SELECTOR) return envelope(word(BigInt(SUPPLY_RAW)));
        if (data === ERC20_DECIMALS_SELECTOR) return envelope(word(18));
      }
      throw new Error(`fixture: unexpected ${method}`);
    },
  };
  const adapter = createEvmOnchainAdapter({
    transport,
    providerId: "fixture-evm-rpc",
    environment: { chain: "ethereum", network: "mainnet" },
  });
  return { adapter, calls };
}

// THE PRODUCTION INSTALLER, not the test seam directly: an EXTRACT-role
// process whose deployment configured ETHEREUM_MAINNET_RPC_URL (presence
// only; the value is a placeholder the `create` seam never reads).
function installThroughProduction(adapter: ReturnType<typeof evmFixture>["adapter"]) {
  return installOnchainResearchCapability({
    capabilities: new Set(["SEARCH_EXTRACT"]),
    env: { ONCHAIN_RESEARCH_ENABLED: "1", ETHEREUM_MAINNET_RPC_URL: "https://fixture.invalid/rpc" },
    create: (chain, network) => (chain === "ethereum" && network === "mainnet" ? adapter : null),
  });
}

interface Fixture {
  id: string;
  name: string;
  slug: string;
  ticker: string | null;
  token: string;
}

async function makeProject(): Promise<Fixture> {
  const slug = uniq("evmnorm");
  const name = "EVM Normal Path Project";
  const token = nextToken();
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  // The controlled confirmation workflow — the same entrypoint the owner
  // script uses — so the identity is a real ACTIVE PROJECT_IDENTITY row.
  const ok = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "ethereum", tokenAddress: token, ticker: "T" });
  if (!ok.ok) throw new Error("fixture identity failed: " + ok.refusal);
  return { id: project.id, name, slug, ticker: null, token };
}

// A PRODUCT job — the default origin — planned through the memory stage so
// the frozen contract S5 cross-checks exists, exactly as production leaves it.
async function makeProductJob(projectId: string, slug: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "what is the token's on-chain supply right now?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "current supply state" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

// The real executor with the ordinary documentary providers stubbed to
// count. Search returns nothing and the fetcher serves nothing, so any
// Evidence can only have come from the deterministic chain branch. No
// chainAcquisition override: production (live-executor.ts) passes none.
function executorFor(project: Fixture) {
  const counters = { proposer: 0, search: 0, fetch: 0, extract: 0 };
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    queryProposer: { name: "fixture", async proposeQueries() { counters.proposer += 1; return ["q"]; } },
    searchGateway: { name: "fixture", async search() { counters.search += 1; return []; } },
    contentFetcher: {
      name: "fixture",
      async fetch(url: string) {
        counters.fetch += 1;
        throw new ContentFetchError("HTTP_ERROR", "fixture: nothing is fetchable", url, 404);
      },
    },
    evidenceExtractor: { name: "fixture", async extract() { counters.extract += 1; return []; } },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
  return { executor, counters };
}

const runCtx = (jobId: string) => ({
  jobId,
  attemptNumber: 1,
  isRecoveryAttempt: false,
  budget: { maxSearchQueries: 5, maxSourceOpens: 5, maxModelCostMicro: 1_000_000 },
});

describe("normal Research → EVM TOKEN_SUPPLY — the ordinary S4 path consumes implementation #2", () => {
  it("1-4. the acquisition plan carries the Ethereum identity, intents address ethereum/mainnet, and the registry resolves the EVM retriever installed by the production installer", async () => {
    const project = await makeProject();
    const jobId = await makeProductJob(project.id, project.slug);

    // 1. identity, through the plan the executor itself loads
    const plan = await loadAcquisitionPlan(ctx.db, jobId, "CURRENT_STATE", project.id);
    expect(plan.confirmedIdentity).toMatchObject({ chain: "ethereum", tokenAddress: project.token });
    expect(plan.establishingClasses).toContain("ONCHAIN_VERIFIABLE");

    // 2 + 3. environment and intent, from the same selector the executor calls
    const intents = selectOnchainIntents({
      component: "CURRENT_STATE",
      establishingClasses: plan.establishingClasses,
      identity: plan.confirmedIdentity,
      maxIntents: MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
    });
    expect(intents).toEqual([
      { kind: "TOKEN_SUPPLY", chain: "ethereum", network: "mainnet", projectAnchor: project.token, subjectKind: "token", subject: project.token },
    ]);

    // 4. the retriever, installed the way a worker installs it
    const { adapter } = evmFixture();
    const installed = installThroughProduction(adapter);
    expect(installed.outcome).toBe("INSTALLED");
    expect(installed.installed).toEqual([{ chain: "ethereum", network: "mainnet", providerId: "ethereum-mainnet-rpc" }]);
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(true);
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(false);
    const retriever = resolveOnchainRetriever("ethereum", "mainnet");
    expect(retriever).toBe(adapter);
    expect(retriever.supports("ethereum", "mainnet", "TOKEN_SUPPLY")).toBe(true);
  });

  it("5-7. the real S4 executor working CURRENT_STATE issues the four bounded EVM calls, persists artifact + Evidence, spends one source open, never searches, and reconciles through the generic component path", async () => {
    const project = await makeProject();
    const jobId = await makeProductJob(project.id, project.slug);
    const { adapter, calls } = evmFixture();
    installThroughProduction(adapter);

    const { executor, counters } = executorFor(project);
    const outcome = await executor.execute(CURRENT_STATE, runCtx(jobId));

    // The deterministic branch established the component and returned
    // before the documentary chain: no proposer, no search, no fetch, no
    // extraction — the whole model/search budget is conserved.
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.reason).toContain("ONCHAIN_EVIDENCE_ESTABLISHED");
    expect(outcome.spent).toMatchObject({ searchQueries: 0, sourceOpens: 1, authorizedModelCostMicro: 0 });
    expect(counters).toEqual({ proposer: 0, search: 0, fetch: 0, extract: 0 });

    // The exact RPC footprint of ONE normal Research read: the adapter's
    // bounded flow and nothing else, both eth_calls pinned to the finalized block.
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_call"]);
    expect(calls[1].params).toEqual(["finalized", false]);
    expect(calls[2].params[1]).toBe("0x" + BLOCK_NUMBER.toString(16));
    expect(calls[3].params[1]).toBe("0x" + BLOCK_NUMBER.toString(16));

    // 5. the artifact, in the same table, identified by its environment
    const artifacts = await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, jobId));
    expect(artifacts.length).toBe(1);
    const [artifact] = artifacts;
    expect(artifact).toMatchObject({
      originKind: "RESEARCH_JOB",
      chain: "ethereum",
      network: "mainnet",
      intentKind: "TOKEN_SUPPLY",
      projectAnchor: project.token,
      subject: project.token,
      slot: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      finality: "finalized",
      providerId: "fixture-evm-rpc",
      canonicalUri: `atlas-onchain://ethereum/mainnet/project/${project.token}/token/${project.token}/supply`,
    });
    expect(artifact.blockTime?.getTime()).toBe(BLOCK_TIME * 1000);
    expect(artifact.normalizedResult).toEqual({ kind: "TOKEN_SUPPLY", mint: project.token, amountRaw: SUPPLY_RAW, decimals: 18 });

    // 6. Evidence, decided entirely by production synthesis
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      onchainArtifactId: artifact.id,
      sourceClass: "ONCHAIN_VERIFIABLE",
      entityBinding: "CONFIRMED",
      directness: "DIRECT",
      patternStep: 5,
      component: "CURRENT_STATE",
    });

    // The read was traced against this component on the sourceOpens axis.
    const traced = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
    expect(traced.some((t) => t.component === "CURRENT_STATE" && t.budgetAxis === "sourceOpens")).toBe(true);

    // 7. reconciliation, through the same generic S5 path a Solana reading
    // takes: a lone CONFIRMED-bound ONCHAIN_VERIFIABLE row establishes the
    // component at CLAIMED authority (D-074), never more.
    const result = await reconcileAndPersistComponent(ctx.db, jobId, { step: 5, component: "CURRENT_STATE" }, new Date());
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
    expect(result.supportingEvidenceIds).toEqual([rows[0].id]);
    expect(result.excludedEvidence).toEqual([]);
  });

  it("NET_EFFECT addresses the same anchor with its own TOKEN_SUPPLY intent — a second read, not a same-job reuse", async () => {
    const project = await makeProject();
    const jobId = await makeProductJob(project.id, project.slug);
    const plan = await loadAcquisitionPlan(ctx.db, jobId, "NET_EFFECT", project.id);
    const intents = selectOnchainIntents({
      component: "NET_EFFECT",
      establishingClasses: plan.establishingClasses,
      identity: plan.confirmedIdentity,
      maxIntents: MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
    });
    expect(intents.map((i) => [i.kind, i.chain, i.network])).toEqual([["TOKEN_SUPPLY", "ethereum", "mainnet"]]);
  });

  it("a PRODUCT reading IS a historical candidate for a later Research, while a process holding no Ethereum retriever takes the bounded not-configured path with zero RPC", async () => {
    const project = await makeProject();
    const first = await makeProductJob(project.id, project.slug);
    const { adapter, calls } = evmFixture();
    installThroughProduction(adapter);
    const { executor } = executorFor(project);
    await executor.execute(CURRENT_STATE, runCtx(first));
    expect(calls.length).toBe(4);
    const [artifact] = await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, first));

    // Unlike an OWNER_OBSERVATION (owner-observation-origin-v1), a normal
    // Research acquisition is admitted by the historical loader for the
    // NEXT job, keyed by the same environment-qualified URI.
    const second = await makeProductJob(project.id, project.slug);
    const candidates = await loadHistoricalSupplyCandidates(ctx.db, {
      currentResearchJobId: second,
      projectAnchor: project.token,
      chain: "ethereum",
      network: "mainnet",
      beforeSlot: BLOCK_NUMBER + 1,
    });
    expect(candidates.map((c) => c.onchainArtifactId)).toEqual([artifact.id]);

    // Solana-only process: the Ethereum identity's intents are selected,
    // the registry has no ethereum/mainnet entry, and the attempt records
    // the closed observation and falls through to the documentary path
    // instead of reaching any adapter — never the Solana one.
    __setOnchainRetriever(null);
    const solanaTouched = { n: 0 };
    __setOnchainRetriever(
      {
        name: "solana-fixture",
        supports: () => {
          solanaTouched.n += 1;
          return true;
        },
        retrieve: async () => {
          solanaTouched.n += 1;
          throw new Error("a Solana retriever must never serve an Ethereum identity");
        },
      },
      { chain: "solana", network: "mainnet" },
    );
    const third = await makeProductJob(project.id, project.slug);
    const { executor: solanaOnlyExecutor, counters } = executorFor(project);
    const outcome = await solanaOnlyExecutor.execute(CURRENT_STATE, runCtx(third));
    // The closed observation ONCHAIN_RETRIEVER_NOT_CONFIGURED is recorded on
    // the attempt (evm-capability-install-v1 pins the leaf's return); what
    // the executor then does is fall through to the ordinary documentary
    // path, which here has nothing to offer.
    expect(outcome.status).not.toBe("SUCCEEDED");
    expect(outcome.reason).not.toContain("ONCHAIN_EVIDENCE_ESTABLISHED");
    expect(counters.proposer).toBe(1); // the documentary path ran
    expect(solanaTouched.n).toBe(0); // never the Solana adapter
    expect(calls.length).toBe(4); // the EVM fixture was not called again
    expect(outcome.spent?.sourceOpens ?? 0).toBe(0);
    const thirdRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, third));
    expect(thirdRows.length).toBe(0);
  }, 30_000);
});
