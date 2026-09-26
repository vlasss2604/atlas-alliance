import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { evidence, onchainArtifacts, projects, topics, users } from "../src/server/db/schema";
import { readJobBudgetReserved } from "../src/server/engine/budget-reservation";
import {
  onchainFactMayEstablish,
  reconcileComponent,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { evaluateNetSupplyEffect } from "../src/server/engine/net-supply-effect";
import { persistOnchainArtifact, persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import {
  filterTemporalSupplyEligibility,
  isExplicitBlockSupplyRead,
} from "../src/server/engine/onchain-event-anchored-supply-interval";
import {
  establishableComponentsForFactKind,
  GROSS_SUPPLY_REDUCTION_FACT_KINDS,
  ONCHAIN_DOES_NOT_PROVE,
  onchainFactAppliesToComponent,
  synthesizeOnchainFacts,
} from "../src/server/engine/onchain-facts";
import {
  explicitBlockScenarioEarliestSlot,
  runPostEventSupplyCompletion,
} from "../src/server/engine/onchain-post-event-supply";
import { loadCurrentJobBurnEvents } from "../src/server/engine/onchain-supply-candidate-store";
import { runSupplyDeltaMaterialization } from "../src/server/engine/onchain-supply-delta-materialization";
import {
  buildCanonicalOnchainUri,
  onchainSourceUriOf,
  parseCanonicalOnchainUri,
} from "../src/server/engine/onchain-uri";
import {
  createEvmOnchainAdapter,
  ERC20_DECIMALS_SELECTOR,
  ERC20_TOTAL_SUPPLY_SELECTOR,
  ERC20_TRANSFER_TOPIC,
} from "../src/server/engine/providers/onchain-evm";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import {
  EVM_ZERO_ADDRESS,
  type OnchainArtifact,
  type OnchainIntent,
} from "../src/server/engine/providers/onchain-types";
import { REASON_CODE_EXPLANATIONS } from "../src/client/research-model";
import { SHORT_REASON } from "../src/client/components/result-blocks/audit-composition";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// EVM V1 — ZERO_ADDRESS_TRANSFER (Founder-approved).
//
// What these tests pin, all offline (a scripted JSON-RPC transport; no
// socket is ever opened):
//
//   - a receipt is read only for a named transaction, finalized and on the
//     canonical chain, and only the project token's ERC-20 Transfer logs
//     survive it;
//   - a Transfer to 0x000…000 is a ZERO_ADDRESS_TRANSFER, never a BURN; a
//     Transfer to 0x…dEaD is a TOKEN_TRANSFER; a reverted transaction and a
//     foreign token's log produce no positive fact;
//   - a totalSupply read at an explicit finalized block is its own canonical
//     target, and a head read keeps its URI exactly;
//   - the post-event stage takes at most ONE t0 (at the block before the
//     earliest event) and at most ONE t1, out of the unchanged budget;
//   - a measured decrease makes NET_EFFECT PARTIALLY_SUPPORTED with its own
//     code, attributing nothing; a non-decrease is reported as measured;
//   - EXECUTION_EVIDENCE is never established by the transfer, BURN and
//     Solana behaviour are unchanged, and no reader copy says "burn".

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const EXECUTION = { step: 4, component: "EXECUTION_EVIDENCE" };
const NET_EFFECT = { step: 7, component: "NET_EFFECT" };

const EVENT_BLOCK = 1000;
const FINALIZED = 5000;
const DEAD = "0x000000000000000000000000000000000000dead";
const HOLDER = "0x" + "12".repeat(20);
const FOREIGN_TOKEN = "0x" + "fe".repeat(20);

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return "0x" + (0xa000 + tokenCounter).toString(16).padStart(40, "c");
}
function txHash(seed: number): string {
  return "0x" + seed.toString(16).padStart(64, "7");
}

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;
const word = (n: number | bigint | string) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const topicOf = (address: string) => "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
const rpcError = (code: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: "missing trie node" } });
const blockHashOf = (n: number) => "0x" + n.toString(16).padStart(64, "b");

interface ChainScript {
  token: string;
  hash: string;
  status?: "0x1" | "0x0";
  receiptBlock?: number;
  // Supply per block; the head is FINALIZED.
  supplyAt?: Record<number, string>;
  // Blocks whose historical state the node cannot serve.
  noArchiveBelow?: number;
  logs?: unknown[];
  canonicalHashOverride?: string;
}

function log(script: ChainScript, opts: { address?: string; to: string; amount: string; index: number; topics?: string[] }) {
  return {
    address: opts.address ?? script.token,
    topics: opts.topics ?? [ERC20_TRANSFER_TOPIC, topicOf(HOLDER), topicOf(opts.to)],
    data: word(opts.amount),
    logIndex: hex(opts.index),
    transactionHash: script.hash,
    blockNumber: hex(script.receiptBlock ?? EVENT_BLOCK),
    removed: false,
  };
}

function chain(script: ChainScript) {
  const calls: { method: string; params: unknown[] }[] = [];
  const receiptBlock = script.receiptBlock ?? EVENT_BLOCK;
  const block = (n: number) => ({ number: hex(n), hash: blockHashOf(n), timestamp: hex(1_700_000_000 + n) });
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "eth_chainId") return envelope("0x1");
      if (method === "eth_getTransactionReceipt") {
        return envelope({
          transactionHash: script.hash,
          blockNumber: hex(receiptBlock),
          blockHash:
            script.canonicalHashOverride !== undefined && receiptBlock !== undefined
              ? script.canonicalHashOverride
              : blockHashOf(receiptBlock),
          status: script.status ?? "0x1",
          logs: script.logs ?? [],
        });
      }
      if (method === "eth_getBlockByNumber") {
        const tag = params[0] as string;
        return envelope(block(tag === "finalized" ? FINALIZED : Number(BigInt(tag))));
      }
      if (method === "eth_call") {
        const { data } = params[0] as { data: string };
        const at = Number(BigInt(params[1] as string));
        if (script.noArchiveBelow !== undefined && at < script.noArchiveBelow) return rpcError(-32000);
        if (data === ERC20_DECIMALS_SELECTOR) return envelope(word(18));
        if (data === ERC20_TOTAL_SUPPLY_SELECTOR) {
          const supply = script.supplyAt?.[at] ?? script.supplyAt?.[FINALIZED] ?? "1000000";
          return envelope(word(supply));
        }
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

const txIntent = (token: string, hash: string): OnchainIntent => ({
  kind: "TRANSACTION_DETAIL",
  chain: "ethereum",
  network: "mainnet",
  projectAnchor: token,
  subjectKind: "tx",
  subject: hash,
});
const supplyIntent = (token: string, block?: number): OnchainIntent => ({
  kind: "TOKEN_SUPPLY",
  chain: "ethereum",
  network: "mainnet",
  projectAnchor: token,
  subjectKind: "token",
  subject: token,
  ...(block === undefined ? {} : { block }),
});

function standardLogs(script: ChainScript, zeroAmount = "5000") {
  return [
    log(script, { to: EVM_ZERO_ADDRESS, amount: zeroAmount, index: 3 }),
    log(script, { to: DEAD, amount: "700", index: 4 }),
    // A foreign token's Transfer to the zero address: never ours.
    log(script, { address: FOREIGN_TOKEN, to: EVM_ZERO_ADDRESS, amount: "9", index: 5 }),
    // ERC-721 shape (token id indexed): four topics, not an ERC-20 Transfer.
    log(script, {
      to: EVM_ZERO_ADDRESS,
      amount: "1",
      index: 6,
      topics: [ERC20_TRANSFER_TOPIC, topicOf(HOLDER), topicOf(EVM_ZERO_ADDRESS), word(1)],
    }),
  ];
}

// ---------------------------------------------------------------------------
// A. The adapter: receipt and explicit-block supply
// ---------------------------------------------------------------------------

describe("A. the EVM adapter reads a receipt and a pinned supply, and nothing else", () => {
  it("a receipt yields only the project token's ERC-20 Transfer logs, in log order", async () => {
    const token = nextToken();
    const script: ChainScript = { token, hash: txHash(1) };
    script.logs = standardLogs(script);
    const { adapter, calls } = chain(script);
    const artifact = await adapter.retrieve(txIntent(token, script.hash));
    expect(calls.map((c) => c.method)).toEqual([
      "eth_chainId",
      "eth_getTransactionReceipt",
      "eth_getBlockByNumber",
      "eth_getBlockByNumber",
    ]);
    expect(artifact.result.kind).toBe("TRANSACTION_DETAIL");
    if (artifact.result.kind !== "TRANSACTION_DETAIL") return;
    expect(artifact.result.succeeded).toBe(true);
    expect(artifact.result.burns).toEqual([]);
    expect(artifact.result.evmTokenTransfers).toEqual([
      { logIndex: 3, token, from: HOLDER, to: EVM_ZERO_ADDRESS, amountRaw: "5000" },
      { logIndex: 4, token, from: HOLDER, to: DEAD, amountRaw: "700" },
    ]);
    expect(artifact.provenance).toMatchObject({
      slot: EVENT_BLOCK,
      finality: "finalized",
      providerMethod: "eth_getTransactionReceipt",
      transactionSignature: script.hash,
    });
  });

  it("a transaction above the finalized block, or off the canonical chain, produces no artifact", async () => {
    const token = nextToken();
    const pending = chain({ token, hash: txHash(2), receiptBlock: FINALIZED + 1 });
    await expect(pending.adapter.retrieve(txIntent(token, txHash(2)))).rejects.toThrow(/not in a finalized block/);
    const reorged = chain({ token, hash: txHash(3), canonicalHashOverride: "0x" + "99".repeat(32) });
    await expect(reorged.adapter.retrieve(txIntent(token, txHash(3)))).rejects.toThrow(/canonical chain/);
  });

  it("a reverted transaction carries no transfer at all", async () => {
    const token = nextToken();
    const script: ChainScript = { token, hash: txHash(4), status: "0x0" };
    script.logs = standardLogs(script);
    const { adapter } = chain(script);
    const artifact = await adapter.retrieve(txIntent(token, script.hash));
    if (artifact.result.kind !== "TRANSACTION_DETAIL") throw new Error("kind");
    expect(artifact.result.succeeded).toBe(false);
    expect(artifact.result.evmTokenTransfers).toEqual([]);
  });

  it("an explicit-block read is pinned to that block, refuses a non-finalized one, and fails closed without archive state", async () => {
    const token = nextToken();
    const { adapter, calls } = chain({ token, hash: txHash(5), supplyAt: { 999: "1000000" } });
    const artifact = await adapter.retrieve(supplyIntent(token, 999));
    expect(artifact.provenance.slot).toBe(999);
    expect(artifact.provenance.blockHash).toBe(blockHashOf(999));
    expect(artifact.canonicalUri).toBe(`${buildCanonicalOnchainUri(supplyIntent(token))}?block=999`);
    const ethCalls = calls.filter((c) => c.method === "eth_call");
    expect(ethCalls.map((c) => c.params[1])).toEqual(["0x3e7", "0x3e7"]);

    await expect(adapter.retrieve(supplyIntent(token, FINALIZED + 1))).rejects.toThrow(/not finalized/);

    const noArchive = chain({ token, hash: txHash(6), noArchiveBelow: FINALIZED });
    await expect(noArchive.adapter.retrieve(supplyIntent(token, 999))).rejects.toThrow();
  });

  it("a head read is unchanged: four calls, no selector in its URI", async () => {
    const token = nextToken();
    const { adapter, calls } = chain({ token, hash: txHash(7) });
    const artifact = await adapter.retrieve(supplyIntent(token));
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_call"]);
    expect(artifact.canonicalUri).toBe(buildCanonicalOnchainUri(supplyIntent(token)));
    expect(artifact.canonicalUri).not.toContain("?");
    expect(artifact.provenance.slot).toBe(FINALIZED);
    expect(artifact.provenance.requestParams).not.toHaveProperty("explicitBlock");
  });
});

// ---------------------------------------------------------------------------
// B. The canonical target
// ---------------------------------------------------------------------------

describe("B. an explicit block is part of the canonical target", () => {
  it("two blocks are two targets; no block keeps the old URI; the source ignores the position", () => {
    const token = nextToken();
    const head = buildCanonicalOnchainUri(supplyIntent(token));
    const at10 = buildCanonicalOnchainUri(supplyIntent(token, 10));
    const at11 = buildCanonicalOnchainUri(supplyIntent(token, 11));
    expect(new Set([head, at10, at11]).size).toBe(3);
    expect(head).toBe(`atlas-onchain://ethereum/mainnet/project/${token}/token/${token}/supply`);
    expect(parseCanonicalOnchainUri(head)?.block).toBeNull();
    expect(parseCanonicalOnchainUri(at10)?.block).toBe(10);
    expect(onchainSourceUriOf(at10)).toBe(head);
    expect(onchainSourceUriOf(head)).toBe(head);
    // Only the selector this module writes parses.
    expect(parseCanonicalOnchainUri(`${head}?block=01`)).toBeNull();
    expect(parseCanonicalOnchainUri(`${head}?foo=1`)).toBeNull();
    expect(parseCanonicalOnchainUri(`${head}#x`)).toBeNull();
  });

  it("a Solana URI is byte-for-byte what it was", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const uri = buildCanonicalOnchainUri({
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: mint,
      subjectKind: "token",
      subject: mint,
    });
    expect(uri).toBe(`atlas-onchain://solana/mainnet/project/${mint}/token/${mint}/supply`);
  });
});

// ---------------------------------------------------------------------------
// C. Synthesis — validation 1, 2, 3, 4, 10
// ---------------------------------------------------------------------------

describe("C. what a Transfer log becomes", () => {
  async function facts(status: "0x1" | "0x0" = "0x1") {
    const token = nextToken();
    const script: ChainScript = { token, hash: txHash(20), status };
    script.logs = standardLogs(script);
    const artifact = await chain(script).adapter.retrieve(txIntent(token, script.hash));
    return synthesizeOnchainFacts(artifact, EXECUTION);
  }

  it("1. a transfer to 0x000…000 is ZERO_ADDRESS_TRANSFER, never BURN", async () => {
    const f = await facts();
    const zat = f.filter((x) => x.onchainFactKind === "ZERO_ADDRESS_TRANSFER");
    expect(zat).toHaveLength(1);
    expect(zat[0].relationship).toBe("SUPPORTS");
    expect(zat[0].mechanismState).toBeNull();
    expect(f.some((x) => x.onchainFactKind === "BURN")).toBe(false);
    expect(GROSS_SUPPLY_REDUCTION_FACT_KINDS).toEqual(["BURN"]);
  });

  it("2. a transfer to 0x…dEaD stays a TOKEN_TRANSFER, offered as context", async () => {
    const f = await facts();
    const transfers = f.filter((x) => x.onchainFactKind === "TOKEN_TRANSFER");
    expect(transfers).toHaveLength(1);
    expect(transfers[0].statement).toContain(DEAD);
    expect(transfers[0].relationship).toBe("CONTEXT");
  });

  it("3. a reverted transaction creates no positive fact", async () => {
    expect(await facts("0x0")).toEqual([]);
  });

  it("4. a foreign token's log, and an ERC-721-shaped log, never qualify", async () => {
    const f = await facts();
    expect(f.every((x) => !x.statement.includes(FOREIGN_TOKEN))).toBe(true);
    expect(f).toHaveLength(2);
  });

  it("10. nothing said about a zero-address transfer says burn or buyback", async () => {
    const [zat] = (await facts()).filter((x) => x.onchainFactKind === "ZERO_ADDRESS_TRANSFER");
    for (const text of [
      zat.statement,
      zat.doesNotProve,
      ONCHAIN_DOES_NOT_PROVE.ZERO_ADDRESS_TRANSFER,
      REASON_CODE_EXPLANATIONS.ZERO_ADDRESS_TRANSFER_SUPPLY_DECREASE_NOT_ATTRIBUTED,
      REASON_CODE_EXPLANATIONS.ZERO_ADDRESS_TRANSFER_SUPPLY_NOT_REDUCED,
      SHORT_REASON.ZERO_ADDRESS_TRANSFER_SUPPLY_DECREASE_NOT_ATTRIBUTED,
      SHORT_REASON.ZERO_ADDRESS_TRANSFER_SUPPLY_NOT_REDUCED,
    ]) {
      expect(text).not.toMatch(/burn|buyback/i);
    }
    // Destruction is only ever NEGATED: the affirmative sentences never say it.
    for (const text of [
      zat.statement,
      REASON_CODE_EXPLANATIONS.ZERO_ADDRESS_TRANSFER_SUPPLY_DECREASE_NOT_ATTRIBUTED,
      REASON_CODE_EXPLANATIONS.ZERO_ADDRESS_TRANSFER_SUPPLY_NOT_REDUCED,
    ]) {
      expect(text).not.toMatch(/destroy/i);
    }
    expect(zat.doesNotProve).toContain("does not establish that the tokens were destroyed");
  });

  it("9. the kind establishes no component; NET_EFFECT may only read it", () => {
    expect(establishableComponentsForFactKind("ZERO_ADDRESS_TRANSFER")).toEqual([]);
    expect(onchainFactMayEstablish("ZERO_ADDRESS_TRANSFER", "EXECUTION_EVIDENCE")).toBe(false);
    expect(onchainFactMayEstablish("ZERO_ADDRESS_TRANSFER", "NET_EFFECT")).toBe(false);
    expect(onchainFactAppliesToComponent("ZERO_ADDRESS_TRANSFER", "NET_EFFECT")).toBe(true);
    expect(onchainFactAppliesToComponent("ZERO_ADDRESS_TRANSFER", "EXECUTION_EVIDENCE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. The pure supply evaluator — validation 6, 7, 8
// ---------------------------------------------------------------------------

describe("D. the typed supply evaluation", () => {
  const zat = { id: "z", onchainFactKind: "ZERO_ADDRESS_TRANSFER" as const, relationship: "SUPPORTS" as const };
  const burn = { id: "b", onchainFactKind: "BURN" as const, relationship: "SUPPORTS" as const };
  const down = { id: "d", onchainFactKind: "TOTAL_SUPPLY_DELTA" as const, relationship: "SUPPORTS" as const };
  const up = { id: "u", onchainFactKind: "TOTAL_SUPPLY_DELTA" as const, relationship: "CONTRADICTS" as const };

  it("6. a decrease around a zero-address transfer is its own outcome", () => {
    expect(evaluateNetSupplyEffect({ establishing: [down], contradictionCapable: [down], intervalAnchors: [zat] })).toEqual({
      kind: "ZERO_ADDRESS_INTERVAL_DECREASE",
      deltaEvidenceIds: ["d"],
    });
  });

  it("7. a non-decrease is reported as measured, and is never a burn outcome", () => {
    expect(evaluateNetSupplyEffect({ establishing: [], contradictionCapable: [up], intervalAnchors: [zat] })).toEqual({
      kind: "ZERO_ADDRESS_INTERVAL_NOT_REDUCED",
      deltaEvidenceIds: ["u"],
    });
    expect(evaluateNetSupplyEffect({ establishing: [], contradictionCapable: [], intervalAnchors: [zat] }).kind).toBe(
      "NO_GROSS_REDUCTION",
    );
  });

  it("8. a genuine BURN keeps every outcome it had, anchor or not", () => {
    for (const anchors of [undefined, [zat]]) {
      expect(evaluateNetSupplyEffect({ establishing: [burn], contradictionCapable: [], intervalAnchors: anchors }).kind).toBe(
        "NO_MEASURED_INTERVAL",
      );
      expect(
        evaluateNetSupplyEffect({ establishing: [burn, down], contradictionCapable: [down], intervalAnchors: anchors }).kind,
      ).toBe("MEASURED_DECREASE");
      expect(
        evaluateNetSupplyEffect({ establishing: [burn], contradictionCapable: [up], intervalAnchors: anchors }).kind,
      ).toBe("MEASURED_NOT_REDUCED");
    }
    // And a delta with no anchor at all is what it always was.
    expect(evaluateNetSupplyEffect({ establishing: [down], contradictionCapable: [down] }).kind).toBe("NO_GROSS_REDUCTION");
  });
});

// ---------------------------------------------------------------------------
// E. Reconciliation, pure — validation 6, 7, 9
// ---------------------------------------------------------------------------

describe("E. reconciliation", () => {
  const NOW = new Date("2026-09-20T00:00:00.000Z");
  const row = (id: string, kind: EvidenceRow["onchainFactKind"], relationship: EvidenceRow["relationship"], component: string, step: number): EvidenceRow => ({
    id,
    researchJobId: "job",
    sourceId: "src",
    evidenceContractVersion: 2,
    patternStep: step,
    component,
    relationship,
    directness: "DIRECT",
    fragment: `{"id":"${id}"}`,
    summary: `row ${id}`,
    mechanismState: null,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: kind,
    fetchedAt: NOW,
    publishedAt: null,
    extractionUnitKey: null,
    contentHash: `h-${id}`,
  });
  const reconcile = (component: string, step: number, evidenceRows: EvidenceRow[]) =>
    reconcileComponent({
      jobId: "job",
      item: { step, component },
      requirements: {
        component,
        establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
        requiresCurrentState: false,
        requiresLiveMechanismState: false,
        freshnessClass: "LOW_CHANGE",
        tokenStateSensitive: false,
        requiredTokenState: null,
      },
      evidence: evidenceRows,
      now: NOW,
      freshnessPolicyDays: { LOW_CHANGE: 3650, MEDIUM_CHANGE: 3650, HIGH_CHANGE: 3650 },
    });

  it("9. EXECUTION_EVIDENCE stays unresolved on a zero-address transfer alone", () => {
    const r = reconcile("EXECUTION_EVIDENCE", 4, [row("z", "ZERO_ADDRESS_TRANSFER", "SUPPORTS", "EXECUTION_EVIDENCE", 4)]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.supportingEvidenceIds).toEqual([]);
    expect(r.excludedEvidence.map((x) => x.reason)).toEqual(["FACT_KIND_CANNOT_ESTABLISH"]);
  });

  it("6. NET_EFFECT: a measured decrease around the transfer is PARTIALLY_SUPPORTED, attributing nothing", () => {
    const r = reconcile("NET_EFFECT", 7, [
      row("z", "ZERO_ADDRESS_TRANSFER", "SUPPORTS", "EXECUTION_EVIDENCE", 4),
      row("d", "TOTAL_SUPPLY_DELTA", "SUPPORTS", "NET_EFFECT", 7),
    ]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes[0]).toBe("ZERO_ADDRESS_TRANSFER_SUPPLY_DECREASE_NOT_ATTRIBUTED");
    expect(r.supportingEvidenceIds).toEqual(["d"]);
    for (const burnCode of ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED", "NET_SUPPLY_CHANGE_NOT_ESTABLISHED", "SUPPLY_REDUCTION_NOT_ESTABLISHED"]) {
      expect(r.reasonCodes).not.toContain(burnCode);
    }
  });

  it("7. NET_EFFECT: supply not lower across the interval is CONTRADICTED by measurement, with its own code", () => {
    const r = reconcile("NET_EFFECT", 7, [
      row("z", "ZERO_ADDRESS_TRANSFER", "SUPPORTS", "EXECUTION_EVIDENCE", 4),
      row("u", "TOTAL_SUPPLY_DELTA", "CONTRADICTS", "NET_EFFECT", 7),
    ]);
    expect(r.status).toBe("CONTRADICTED");
    expect(r.reasonCodes).toEqual(["ZERO_ADDRESS_TRANSFER_SUPPLY_NOT_REDUCED"]);
    expect(r.contradictingEvidenceIds).toEqual(["u"]);
    expect(r.supportingEvidenceIds).toEqual([]);
  });

  it("a zero-address transfer alone at NET_EFFECT establishes nothing", () => {
    const r = reconcile("NET_EFFECT", 7, [row("z", "ZERO_ADDRESS_TRANSFER", "SUPPORTS", "EXECUTION_EVIDENCE", 4)]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ---------------------------------------------------------------------------
// F. Eligibility of a current-job t0 — validation 5
// ---------------------------------------------------------------------------

describe("F. 5. this Research's own reading may be t0 only when pinned to an explicit block before the event", () => {
  it("pinned before the event: eligible; head read, or pinned at/after the event: not", async () => {
    const token = nextToken();
    const { adapter } = chain({ token, hash: txHash(30), supplyAt: { 999: "10", 1000: "10" } });
    const pinned = await adapter.retrieve(supplyIntent(token, 999));
    const pinnedAtEvent = await adapter.retrieve(supplyIntent(token, EVENT_BLOCK));
    const head = await adapter.retrieve(supplyIntent(token));
    expect(isExplicitBlockSupplyRead(pinned)).toBe(true);
    expect(isExplicitBlockSupplyRead(head)).toBe(false);
    const asCandidate = (artifact: OnchainArtifact) => ({
      artifact,
      originKind: "RESEARCH_JOB" as const,
      researchJobId: "current",
    });
    const { eligible, excluded } = filterTemporalSupplyEligibility({
      currentResearchJobId: "current",
      currentProjectAnchor: token,
      eventSlot: EVENT_BLOCK,
      domain: null,
      historical: [asCandidate(pinned), asCandidate(pinnedAtEvent), asCandidate(head)],
    });
    expect(eligible.map((e) => e.index)).toEqual([0]);
    expect(excluded).toEqual([
      { index: 1, reason: "NO_EVENT_CONTAINING_INTERVAL" },
      { index: 2, reason: "HISTORICAL_OBSERVATION_NOT_PRIOR_JOB" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// G. The whole path, persisted — validation 5, 6, 7, and the read bound
// ---------------------------------------------------------------------------

interface Fixture {
  projectId: string;
  token: string;
  jobId: string;
}

async function makeFixture(): Promise<Fixture> {
  const slug = uniq("zat");
  const token = nextToken();
  const [project] = await ctx.db.insert(projects).values({ slug, name: "ZAT Fixture", status: "ACTIVE_CORE" }).returning();
  const ok = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "ethereum", tokenAddress: token, ticker: "Z" });
  if (!ok.ok) throw new Error("fixture identity failed");
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "were tokens actually burned, and did total supply decrease?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "burn and supply" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return { projectId: project.id, token, jobId: job.id };
}

const identityFor = (token: string) => ({ chain: "ethereum" as const, tokenAddress: token, ticker: "Z" });

async function establishZeroAddressTransfer(f: Fixture, script: ChainScript) {
  const artifact = await chain(script).adapter.retrieve(txIntent(f.token, script.hash));
  await persistOnchainArtifactAndFacts({ db: ctx.db, jobId: f.jobId, artifact, identity: identityFor(f.token), target: EXECUTION });
}

async function headRead(f: Fixture, supply: string) {
  const artifact = await chain({ token: f.token, hash: txHash(99), supplyAt: { [FINALIZED]: supply } }).adapter.retrieve(
    supplyIntent(f.token),
  );
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "RESEARCH_JOB", jobId: f.jobId },
    artifact,
    identity: identityFor(f.token),
  });
  if (!stored.artifactId) throw new Error(`head read failed: ${stored.rejectedReason}`);
}

async function complete(f: Fixture, script: ChainScript, maxSourceOpens = 24) {
  const { adapter, calls } = chain(script);
  const result = await runPostEventSupplyCompletion(ctx.db, {
    jobId: f.jobId,
    projectId: f.projectId,
    maxSourceOpens,
    retriever: adapter,
  });
  return { result, supplyReads: calls.filter((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data === ERC20_TOTAL_SUPPLY_SELECTOR) };
}

describe("G. the persisted path", () => {
  it("5 + 6. one t0 at the block before the event, the held t1, a delta, and NET_EFFECT partly supported", async () => {
    const f = await makeFixture();
    const script: ChainScript = { token: f.token, hash: txHash(40), supplyAt: { 999: "1000000", [FINALIZED]: "995000" } };
    script.logs = standardLogs(script);
    await establishZeroAddressTransfer(f, script);
    await headRead(f, "995000");

    const events = await loadCurrentJobBurnEvents(ctx.db, { currentResearchJobId: f.jobId, projectAnchor: f.token });
    expect(events.map((e) => e.eventKind)).toEqual(["ZERO_ADDRESS_TRANSFER"]);
    expect(explicitBlockScenarioEarliestSlot(events, f.jobId, f.token)).toBe(EVENT_BLOCK);

    const first = await complete(f, script);
    expect(first.result.historicalRead).toMatchObject({ outcome: "ACQUIRED", block: 999, sourceOpensSpent: 1 });
    // The head read already sits after the event: no t1 read is needed.
    expect(first.result.outcome).toBe("NO_ACTION");
    expect(first.result.gate?.reason).toBe("POST_EVENT_OBSERVATION_ALREADY_HELD");
    expect(first.supplyReads.map((c) => c.params[1])).toEqual(["0x3e7"]);

    const [t0] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(and(eq(onchainArtifacts.researchJobId, f.jobId), eq(onchainArtifacts.slot, 999)));
    expect(t0.canonicalUri).toBe(`${buildCanonicalOnchainUri(supplyIntent(f.token))}?block=999`);

    const materialized = await runSupplyDeltaMaterialization(ctx.db, { jobId: f.jobId, projectId: f.projectId });
    expect(materialized).toMatchObject({ outcome: "MATERIALIZED", fromSlot: 999, toSlot: FINALIZED });
    const [delta] = await ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.researchJobId, f.jobId), eq(evidence.onchainFactKind, "TOTAL_SUPPLY_DELTA")));
    expect(delta.relationship).toBe("SUPPORTS");
    expect(delta.summary).toContain("changed by -5000 (decrease) between block 999 and block 5000");
    expect(delta.summary).not.toContain("slot");

    const now = new Date(Date.now() + 1000);
    const netEffect = await reconcileAndPersistComponent(ctx.db, f.jobId, NET_EFFECT, now);
    expect(netEffect.status).toBe("PARTIALLY_SUPPORTED");
    expect(netEffect.reasonCodes[0]).toBe("ZERO_ADDRESS_TRANSFER_SUPPLY_DECREASE_NOT_ATTRIBUTED");
    expect(netEffect.supportingEvidenceIds).toEqual([delta.id]);

    const execution = await reconcileAndPersistComponent(ctx.db, f.jobId, EXECUTION, now);
    expect(execution.status).toBe("INSUFFICIENT_EVIDENCE");

    // Run again: the t0 is held, nothing more is read.
    const second = await complete(f, script);
    expect(second.result.historicalRead).toBeNull();
    expect(second.supplyReads).toHaveLength(0);
  }, 120_000);

  it("two reads at most: t0 then t1 when no reading after the event is held", async () => {
    const f = await makeFixture();
    const script: ChainScript = { token: f.token, hash: txHash(41), supplyAt: { 999: "1000000", [FINALIZED]: "990000" } };
    script.logs = standardLogs(script);
    await establishZeroAddressTransfer(f, script);
    const before = (await readJobBudgetReserved(ctx.db, f.jobId))!.sourceOpens;

    const first = await complete(f, script);
    expect(first.result.historicalRead?.outcome).toBe("ACQUIRED");
    expect(first.result.outcome).toBe("ACQUIRED");
    expect(first.supplyReads.map((c) => c.params[1])).toEqual(["0x3e7", hex(FINALIZED)]);
    expect((await readJobBudgetReserved(ctx.db, f.jobId))!.sourceOpens).toBe(before + 2);

    const second = await complete(f, script);
    expect(second.supplyReads).toHaveLength(0);
    expect((await readJobBudgetReserved(ctx.db, f.jobId))!.sourceOpens).toBe(before + 2);
  }, 120_000);

  it("7. supply not lower across the interval: CONTRADICTED by measurement, never a burn outcome", async () => {
    const f = await makeFixture();
    const script: ChainScript = { token: f.token, hash: txHash(42), supplyAt: { 999: "1000000", [FINALIZED]: "1000500" } };
    script.logs = standardLogs(script);
    await establishZeroAddressTransfer(f, script);
    await headRead(f, "1000500");
    await complete(f, script);
    await runSupplyDeltaMaterialization(ctx.db, { jobId: f.jobId, projectId: f.projectId });
    const netEffect = await reconcileAndPersistComponent(ctx.db, f.jobId, NET_EFFECT, new Date(Date.now() + 1000));
    expect(netEffect.status).toBe("CONTRADICTED");
    expect(netEffect.reasonCodes).toEqual(["ZERO_ADDRESS_TRANSFER_SUPPLY_NOT_REDUCED"]);
  }, 120_000);

  it("archive state unavailable: a bounded technical stop, no t1, no delta, no supply finding", async () => {
    const f = await makeFixture();
    const script: ChainScript = { token: f.token, hash: txHash(43), noArchiveBelow: FINALIZED };
    script.logs = standardLogs(script);
    await establishZeroAddressTransfer(f, script);
    const first = await complete(f, script);
    expect(first.result.historicalRead).toMatchObject({ outcome: "RETRIEVAL_FAILED", sourceOpensSpent: 1 });
    expect(first.result.outcome).toBe("NO_ACTION");
    expect(first.result.gate?.reason).toBe("NO_HISTORICAL_T0");
    expect(first.supplyReads).toHaveLength(1);
    const materialized = await runSupplyDeltaMaterialization(ctx.db, { jobId: f.jobId, projectId: f.projectId });
    expect(materialized.outcome).not.toBe("MATERIALIZED");
    // The opportunity is spent: no retry on the next delivery.
    const again = await complete(f, { ...script, noArchiveBelow: undefined });
    expect(again.result.historicalRead?.outcome).toBe("OPPORTUNITY_ALREADY_CONSUMED");
    expect(again.supplyReads).toHaveLength(0);
  }, 120_000);

  it("no read for the future: when the budget cannot also pay for t1, no t0 is taken", async () => {
    const f = await makeFixture();
    const script: ChainScript = { token: f.token, hash: txHash(44), supplyAt: { 999: "1", [FINALIZED]: "1" } };
    script.logs = standardLogs(script);
    await establishZeroAddressTransfer(f, script);
    const reserved = (await readJobBudgetReserved(ctx.db, f.jobId))!.sourceOpens;
    const max = reserved + 1;
    const result = await complete(f, script, max);
    expect(result.result.historicalRead?.outcome).toBe("BUDGET_EXHAUSTED");
    expect(result.supplyReads).toHaveLength(0);
    expect((await readJobBudgetReserved(ctx.db, f.jobId))!.sourceOpens).toBe(reserved);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// H. BURN and Solana keep their old path — validation 8
// ---------------------------------------------------------------------------

describe("H. 8. a job with a burn never takes the explicit-block t0 path", () => {
  it("a Solana burn event, alone or beside a zero-address transfer, disables the scenario", async () => {
    const mint = "Mint9zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const signature = "Sig9".padEnd(66, "1");
    const burnIntent: OnchainIntent = {
      kind: "TRANSACTION_DETAIL",
      chain: "solana",
      network: "mainnet",
      projectAnchor: mint,
      subjectKind: "tx",
      subject: signature,
    };
    const result = {
      kind: "TRANSACTION_DETAIL" as const,
      signature,
      slot: 500,
      blockTime: null,
      succeeded: true,
      burns: [
        {
          programId: "TokenProg1111111111111111111111111111111111",
          instructionType: "BurnChecked" as const,
          mint,
          sourceAccount: "TokenAcct11111111111111111111111111111111111",
          authority: null,
          amountRaw: "100",
          decimals: 6,
        },
      ],
      programs: [],
      accountKeys: [],
      tokenInstructions: [],
      lifecycleInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    };
    const { brandOnchainArtifact } = await import("../src/server/engine/providers/onchain-types");
    const burnArtifact = brandOnchainArtifact({
      intent: burnIntent,
      canonicalUri: buildCanonicalOnchainUri(burnIntent),
      result,
      normalizedText: JSON.stringify(result),
      provenance: {
        chain: "solana",
        network: "mainnet",
        projectAnchor: mint,
        subjectKind: "tx",
        subject: signature,
        slot: 500,
        blockTime: null,
        blockHash: null,
        finality: "finalized",
        retrievalMethod: "RPC",
        providerId: "fixture",
        providerMethod: "getTransaction",
        requestParams: {},
        transactionSignature: signature,
        retrievedAt: new Date(),
        rawResponseHash: "sha256:raw",
        artifactHash: "sha256:art",
      },
    });
    const burnEvent = { artifact: burnArtifact, burnIndex: 0, researchJobId: "job" };
    expect(explicitBlockScenarioEarliestSlot([burnEvent], "job", mint)).toBeNull();
    // A synthesized burn is still BURN, still SUPPORTS, still LIVE.
    const [fact] = synthesizeOnchainFacts(burnArtifact, EXECUTION);
    expect(fact).toMatchObject({ onchainFactKind: "BURN", relationship: "SUPPORTS", mechanismState: "LIVE" });
  });
});
