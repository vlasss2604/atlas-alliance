import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import {
  deriveTotalSupplyDelta,
  isComparableSupplyObservation,
  supplyMeasurementDomain,
} from "../src/server/engine/onchain-supply-delta";
import { parseCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import {
  __testing as evmTesting,
  createEvmOnchainAdapter,
  ERC20_DECIMALS_SELECTOR,
  ERC20_TOTAL_SUPPLY_SELECTOR,
  isValidEvmAddress,
} from "../src/server/engine/providers/onchain-evm";
import { canonicalJson, OnchainRpcError, sha256 } from "../src/server/engine/providers/onchain-jsonrpc";
import {
  __setOnchainRetriever,
  onchainRetrievalAvailable,
  OnchainRetrieverUnavailableError,
  resolveOnchainRetriever,
  type OnchainRetriever,
  type OnchainRpcTransport,
} from "../src/server/engine/providers/onchain-retriever";
import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import {
  brandOnchainArtifact,
  chainPositionOf,
  isOnchainArtifact,
  type OnchainArtifact,
  type OnchainIntent,
} from "../src/server/engine/providers/onchain-types";

// EVM TOKEN_SUPPLY V1 — the first deterministic EVM primitive, and the
// first proof that the evidence-environment seam carries a second
// implementation without a second Research architecture.
//
// Everything here is offline: a scripted transport answers the four
// JSON-RPC methods the adapter is allowed to issue, records every call, and
// never opens a socket. The Ethereum half pins what the adapter asks, in
// what order, pinned to which block, and what it refuses. The Solana half
// pins that implementation #1 is unchanged by the arrival of #2.

const TOKEN = "0x" + "ab12".repeat(10);
const TOKEN_CHECKSUMMED = "0x" + "AB12".repeat(10);
const SOLANA_MINT = "So11111111111111111111111111111111111111112";

const ETHEREUM_MAINNET = { chain: "ethereum", network: "mainnet" } as const;
const SOLANA_MAINNET = { chain: "solana", network: "mainnet" } as const;

const ETHEREUM_IDENTITY: ConfirmedProjectIdentity = { chain: "ethereum", tokenAddress: TOKEN, ticker: "T" };
const SOLANA_IDENTITY: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: SOLANA_MINT, ticker: "S" };

// A finalized block as a node reports it: quantities are 0x hex.
const BLOCK_NUMBER = 19_090_108; // 0x1234abc
const BLOCK_TIME = 1_727_177_152; // 0x66f2a1c0
const BLOCK_HASH = "0x" + "ef".repeat(32);
const FINALIZED_BLOCK = { number: "0x1234abc", hash: "0x" + "EF".repeat(32), timestamp: "0x66f2a1c0" };

// One ABI return word: a uint256, 32 bytes, left-padded.
function word(value: bigint | number): string {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

interface Script {
  chainId?: unknown;
  block?: unknown;
  totalSupply?: unknown;
  decimals?: unknown;
  // Raw response TEXT overrides, for envelopes that are not results.
  raw?: Partial<Record<"eth_chainId" | "eth_getBlockByNumber" | "totalSupply" | "decimals", string>>;
}

function scriptedTransport(script: Script = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const has = (k: keyof Script) => Object.prototype.hasOwnProperty.call(script, k);
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "eth_chainId") {
        return script.raw?.eth_chainId ?? envelope(has("chainId") ? script.chainId : "0x1");
      }
      if (method === "eth_getBlockByNumber") {
        return script.raw?.eth_getBlockByNumber ?? envelope(has("block") ? script.block : FINALIZED_BLOCK);
      }
      if (method === "eth_call") {
        const data = (params[0] as { data: string }).data;
        if (data === ERC20_TOTAL_SUPPLY_SELECTOR) {
          return script.raw?.totalSupply ?? envelope(has("totalSupply") ? script.totalSupply : word(1_000_000));
        }
        if (data === ERC20_DECIMALS_SELECTOR) {
          return script.raw?.decimals ?? envelope(has("decimals") ? script.decimals : word(6));
        }
        throw new Error(`fixture: unexpected selector ${data}`);
      }
      throw new Error(`fixture: unexpected method ${method}`);
    },
  };
  return { transport, calls };
}

function evmAdapter(script: Script = {}) {
  const { transport, calls } = scriptedTransport(script);
  const adapter = createEvmOnchainAdapter({ transport, providerId: "fixture-evm-rpc", environment: ETHEREUM_MAINNET });
  return { adapter, calls };
}

function supplyIntent(overrides: Partial<OnchainIntent> = {}): OnchainIntent {
  return {
    kind: "TOKEN_SUPPLY",
    chain: "ethereum",
    network: "mainnet",
    projectAnchor: TOKEN,
    subjectKind: "token",
    subject: TOKEN,
    ...overrides,
  } as OnchainIntent;
}

function solanaFixture(): OnchainRetriever {
  return createSolanaOnchainAdapter({
    transport: {
      async call() {
        return envelope({ context: { slot: 100 }, value: { amount: "1000000", decimals: 6 } });
      },
    },
    providerId: "fixture-solana-rpc",
    finality: "finalized",
  });
}

afterEach(() => {
  __setOnchainRetriever(null);
  delete process.env.ETHEREUM_MAINNET_RPC_URL;
  delete process.env.SOLANA_MAINNET_RPC_URL;
});

// ---------------------------------------------------------------------
// A + B + C: the registry carries two implementations, keyed apart.
// ---------------------------------------------------------------------

describe("registry — implementation #2 alongside #1, no fallback between them", () => {
  it("A. ethereum/mainnet resolves the EVM retriever when explicitly installed", () => {
    const { adapter } = evmAdapter();
    __setOnchainRetriever(adapter, ETHEREUM_MAINNET);
    expect(resolveOnchainRetriever("ethereum", "mainnet")).toBe(adapter);
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(true);
    expect(adapter.supports("ethereum", "mainnet", "TOKEN_SUPPLY")).toBe(true);
    expect(adapter.name).toBe("evm-rpc:fixture-evm-rpc");
  });

  it("B. Solana still resolves the Solana retriever, unchanged", async () => {
    const solana = solanaFixture();
    __setOnchainRetriever(solana, SOLANA_MAINNET);
    __setOnchainRetriever(evmAdapter().adapter, ETHEREUM_MAINNET);
    expect(resolveOnchainRetriever("solana", "mainnet")).toBe(solana);
    const artifact = await solana.retrieve({
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: SOLANA_MINT,
      subjectKind: "token",
      subject: SOLANA_MINT,
    });
    // The Solana adapter now reads the shared envelope rule and encoding;
    // its artifact is byte-for-byte what it was.
    expect(artifact.result).toEqual({ kind: "TOKEN_SUPPLY", mint: SOLANA_MINT, amountRaw: "1000000", decimals: 6 });
    expect(artifact.provenance.slot).toBe(100);
    expect(artifact.provenance.providerMethod).toBe("getTokenSupply");
    expect(artifact.normalizedText).toBe(canonicalJson(artifact.result));
    expect(artifact.provenance.artifactHash).toBe(sha256(artifact.normalizedText));
  });

  it("C. no cross-chain fallback in either direction", () => {
    __setOnchainRetriever(evmAdapter().adapter, ETHEREUM_MAINNET);
    expect(() => resolveOnchainRetriever("solana", "mainnet")).toThrow(OnchainRetrieverUnavailableError);
    __setOnchainRetriever(null);
    __setOnchainRetriever(solanaFixture(), SOLANA_MAINNET);
    expect(() => resolveOnchainRetriever("ethereum", "mainnet")).toThrow(OnchainRetrieverUnavailableError);
    // The EVM adapter refuses to serve any other environment itself.
    const { adapter } = evmAdapter();
    expect(adapter.supports("solana", "mainnet", "TOKEN_SUPPLY")).toBe(false);
    expect(adapter.supports("ethereum", "sepolia", "TOKEN_SUPPLY")).toBe(false);
    expect(adapter.supports("base", "mainnet", "TOKEN_SUPPLY")).toBe(false);
  });

  it("the production factory constructs the EVM adapter for ethereum/mainnet from its own env var, and nothing else", () => {
    process.env.ETHEREUM_MAINNET_RPC_URL = "https://rpc.example.test";
    const evm = createProductionOnchainRetriever("ethereum", "mainnet");
    expect(evm).not.toBeNull();
    expect(evm!.name).toBe("evm-rpc:ethereum-mainnet-rpc");
    expect(evm!.supports("ethereum", "mainnet", "TOKEN_SUPPLY")).toBe(true);
    expect(evm!.supports("ethereum", "mainnet", "ACCOUNT_INFO")).toBe(false);
    expect(evm!.supports("solana", "mainnet", "TOKEN_SUPPLY")).toBe(false);
    // The Solana env var does not enable Ethereum, and vice versa.
    expect(createProductionOnchainRetriever("solana", "mainnet")).toBeNull();
    delete process.env.ETHEREUM_MAINNET_RPC_URL;
    expect(createProductionOnchainRetriever("ethereum", "mainnet")).toBeNull();
    // Constructing an adapter opens nothing: the endpoint is never touched
    // until a retrieve is issued, and no retrieve is issued here.
  });

  it("an environment the EVM adapter has no chain id for cannot construct an adapter", () => {
    expect(() =>
      createEvmOnchainAdapter({
        transport: scriptedTransport().transport,
        providerId: "x",
        environment: { chain: "base", network: "mainnet" },
      }),
    ).toThrow(OnchainRetrieverUnavailableError);
  });
});

// ---------------------------------------------------------------------
// D–K: what the adapter asks, in order, and what it refuses.
// ---------------------------------------------------------------------

describe("the four bounded calls — chain id, finalized block, two pinned reads", () => {
  it("D + F + G + H + I. the happy path issues exactly four calls in a fixed order, pinned to one finalized block", async () => {
    const { adapter, calls } = evmAdapter();
    const artifact = await adapter.retrieve(supplyIntent());

    expect(calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_call"]);
    // D. chain id 1 accepted (it was asked first, with no parameters).
    expect(calls[0].params).toEqual([]);
    // F. the finalized block, by tag, without transactions.
    expect(calls[1].params).toEqual(["finalized", false]);
    // G + H. the two closed selectors, addressed to the subject.
    expect(calls[2].params[0]).toEqual({ to: TOKEN, data: "0x18160ddd" });
    expect(calls[3].params[0]).toEqual({ to: TOKEN, data: "0x313ce567" });
    expect(ERC20_TOTAL_SUPPLY_SELECTOR).toBe("0x18160ddd");
    expect(ERC20_DECIMALS_SELECTOR).toBe("0x313ce567");
    // I. both reads pinned to the SAME block, by explicit number — not by
    // re-asking the tag.
    expect(calls[2].params[1]).toBe("0x1234abc");
    expect(calls[3].params[1]).toBe("0x1234abc");

    // F. the position captured: block number as the ordinal, hash and
    // timestamp alongside, finality as obtained.
    expect(artifact.provenance.slot).toBe(BLOCK_NUMBER);
    expect(artifact.provenance.blockHash).toBe(BLOCK_HASH);
    expect(artifact.provenance.blockTime).toBe(BLOCK_TIME);
    expect(artifact.provenance.finality).toBe("finalized");
    expect(chainPositionOf(artifact.provenance)).toEqual({
      ordinal: BLOCK_NUMBER,
      blockTime: BLOCK_TIME,
      blockHash: BLOCK_HASH,
      finality: "finalized",
    });
    expect(artifact.provenance.requestParams).toEqual({
      subject: TOKEN,
      chainId: 1,
      block: BLOCK_NUMBER,
      totalSupplySelector: "0x18160ddd",
      decimalsSelector: "0x313ce567",
    });
  });

  it("E. a wrong chain id fails closed before any read is issued", async () => {
    for (const wrong of ["0x5", "0x89", "0x2105"]) {
      const { adapter, calls } = evmAdapter({ chainId: wrong });
      await expect(adapter.retrieve(supplyIntent())).rejects.toThrow(/chain id .* requires 1/);
      expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
    }
    // Not a quantity at all: equally refused, equally before any read.
    const { adapter, calls } = evmAdapter({ chainId: "mainnet" });
    await expect(adapter.retrieve(supplyIntent())).rejects.toThrow(OnchainRetrieverUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("J. decimals are READ from the contract, never assumed to be 18", async () => {
    for (const [decimals, expected] of [
      [word(18), 18],
      [word(6), 6],
      [word(0), 0],
      [word(2), 2],
    ] as const) {
      const { adapter } = evmAdapter({ decimals });
      const artifact = await adapter.retrieve(supplyIntent());
      expect(artifact.result.kind === "TOKEN_SUPPLY" && artifact.result.decimals).toBe(expected);
    }
    // A decimals read that yields nothing decodable is a refusal — the
    // adapter has no default to fall back on.
    for (const bad of ["0x", word(256), "0x" + "00".repeat(31)]) {
      const { adapter } = evmAdapter({ decimals: bad });
      await expect(adapter.retrieve(supplyIntent())).rejects.toThrow(/decimals\(\)/);
    }
  });

  it("K. large supplies decode exactly through BigInt — a uint256 never passes through a double", async () => {
    const max = BigInt(2) ** BigInt(256) - BigInt(1);
    const { adapter } = evmAdapter({ totalSupply: word(max) });
    const artifact = await adapter.retrieve(supplyIntent());
    expect(artifact.result.kind === "TOKEN_SUPPLY" && artifact.result.amountRaw).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
    const big = BigInt("1000000000000000000000000000"); // 1e27, beyond 2^53
    const { adapter: adapter2 } = evmAdapter({ totalSupply: word(big) });
    const artifact2 = await adapter2.retrieve(supplyIntent());
    expect(artifact2.result.kind === "TOKEN_SUPPLY" && artifact2.result.amountRaw).toBe("1000000000000000000000000000");
    // Zero is a valid, exact reading.
    const { adapter: adapter3 } = evmAdapter({ totalSupply: word(0) });
    expect((await adapter3.retrieve(supplyIntent())).result).toMatchObject({ amountRaw: "0" });
    // The decoders themselves.
    expect(evmTesting.abiWordToBigInt(word(max))).toBe(max);
    expect(evmTesting.abiWordToBigInt("0x")).toBeNull();
    expect(evmTesting.abiWordToBigInt("0x" + "ff".repeat(33))).toBeNull();
    expect(evmTesting.quantityToBigInt("0x1234abc")).toBe(BigInt(BLOCK_NUMBER));
    expect(evmTesting.quantityToBigInt("0x01")).toBeNull(); // leading zero is not a quantity
    expect(evmTesting.quantityToBigInt("1234")).toBeNull();
  });

  it("a totalSupply read with no decodable word (no code at the address) fails closed", async () => {
    for (const bad of ["0x", "0x1234", "0x" + "00".repeat(33)]) {
      const { adapter, calls } = evmAdapter({ totalSupply: bad });
      await expect(adapter.retrieve(supplyIntent())).rejects.toThrow(/totalSupply\(\)/);
      // The decimals read is never issued once the supply read failed.
      expect(calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
    }
  });

  it("a node error envelope on any call is a provider failure, never a result", async () => {
    const error = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "nope" } });
    for (const key of ["eth_chainId", "eth_getBlockByNumber", "totalSupply", "decimals"] as const) {
      const { adapter } = evmAdapter({ raw: { [key]: error } });
      await expect(adapter.retrieve(supplyIntent())).rejects.toBeInstanceOf(OnchainRpcError);
    }
  });

  it("malformed identity or subject is refused BEFORE any request exists", async () => {
    for (const bad of [SOLANA_MINT, "0x" + "ab".repeat(19), "ab12".repeat(10), "0x" + "zz12".repeat(10)]) {
      const { adapter, calls } = evmAdapter();
      await expect(adapter.retrieve(supplyIntent({ subject: bad }))).rejects.toThrow(/invalid subject/);
      await expect(adapter.retrieve(supplyIntent({ projectAnchor: bad }))).rejects.toThrow(/invalid project anchor/);
      expect(calls).toHaveLength(0);
    }
    expect(isValidEvmAddress(TOKEN)).toBe(true);
    expect(isValidEvmAddress(TOKEN_CHECKSUMMED)).toBe(true);
    expect(isValidEvmAddress(SOLANA_MINT)).toBe(false);
  });

  it("the adapter serves ethereum/mainnet only — a wrong environment intent is refused before any call", async () => {
    const { adapter, calls } = evmAdapter();
    await expect(adapter.retrieve(supplyIntent({ network: "sepolia" as never }))).rejects.toThrow(/cannot serve/);
    await expect(adapter.retrieve(supplyIntent({ chain: "solana" }))).rejects.toThrow(/cannot serve/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// L + M: the observation is the existing TOKEN_SUPPLY shape, in the
// existing envelope, identified by environment.
// ---------------------------------------------------------------------

describe("canonical TOKEN_SUPPLY — one semantic shape for both chains", () => {
  it("L. the result is the existing TOKEN_SUPPLY shape, and the supply layer reads it as a comparable observation", async () => {
    const { adapter } = evmAdapter();
    const artifact = await adapter.retrieve(supplyIntent());
    expect(artifact.result).toEqual({ kind: "TOKEN_SUPPLY", mint: TOKEN, amountRaw: "1000000", decimals: 6 });
    expect(artifact.normalizedText).toBe('{"amountRaw":"1000000","decimals":6,"kind":"TOKEN_SUPPLY","mint":"' + TOKEN + '"}');
    expect(isOnchainArtifact(artifact)).toBe(true);
    // The generic supply layer accepts it with no EVM special case.
    expect(isComparableSupplyObservation(artifact)).toBe(true);
    expect(supplyMeasurementDomain(artifact)).toEqual({ chain: "ethereum", network: "mainnet", mint: TOKEN, decimals: 6 });
  });

  it("M. the canonical artifact identifies ethereum, mainnet, the subject and the intent", async () => {
    const { adapter } = evmAdapter();
    const artifact = await adapter.retrieve(supplyIntent());
    expect(artifact.canonicalUri).toBe(`atlas-onchain://ethereum/mainnet/project/${TOKEN}/token/${TOKEN}/supply`);
    expect(parseCanonicalOnchainUri(artifact.canonicalUri)).toEqual({
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: TOKEN,
      subjectKind: "token",
      subject: TOKEN,
      intentPath: "supply",
    });
    expect(artifact.intent).toEqual(supplyIntent());
    expect(artifact.provenance).toMatchObject({
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: TOKEN,
      subjectKind: "token",
      subject: TOKEN,
      retrievalMethod: "RPC",
      providerId: "fixture-evm-rpc",
      providerMethod: "eth_call",
      transactionSignature: null,
    });
    expect(artifact.provenance.artifactHash).toBe(sha256(artifact.normalizedText));
    expect(artifact.provenance.rawResponseHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.provenance.retrievedAt).toBeInstanceOf(Date);
  });

  it("two Ethereum observations at different finalized blocks form an exact delta; Ethereum against Solana never does", async () => {
    const earlier = await evmAdapter({ totalSupply: word(1_000_000) }).adapter.retrieve(supplyIntent());
    const later = await evmAdapter({
      totalSupply: word(900_000),
      block: { ...FINALIZED_BLOCK, number: "0x1234b00", hash: "0x" + "ab".repeat(32) },
    }).adapter.retrieve(supplyIntent());
    const delta = deriveTotalSupplyDelta(earlier, later);
    expect(delta.comparable).toBe(true);
    if (delta.comparable) {
      expect(delta.delta).toMatchObject({
        chain: "ethereum",
        network: "mainnet",
        mint: TOKEN,
        deltaRaw: "-100000",
        direction: "DECREASED",
        slotSpan: 0x1234b00 - 0x1234abc,
      });
    }
    expect(deriveTotalSupplyDelta(later, earlier)).toEqual({ comparable: false, reason: "NON_INCREASING_SLOT" });
    const solana = await solanaFixture().retrieve({
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: SOLANA_MINT,
      subjectKind: "token",
      subject: SOLANA_MINT,
    });
    expect(deriveTotalSupplyDelta(solana, later)).toEqual({ comparable: false, reason: "CHAIN_MISMATCH" });
  });
});

// ---------------------------------------------------------------------
// N + O + P: binding and finality are the existing generic rules.
// ---------------------------------------------------------------------

describe("binding and finality — the generic rules stay authoritative", () => {
  it("N. an Ethereum observation binds to the Ethereum identity, checksummed or not", async () => {
    const artifact = await evmAdapter().adapter.retrieve(supplyIntent());
    expect(validateOnchainBinding(artifact, ETHEREUM_IDENTITY)).toEqual({ binding: "CONFIRMED" });
    expect(validateOnchainBinding(artifact, { ...ETHEREUM_IDENTITY, tokenAddress: TOKEN_CHECKSUMMED })).toEqual({
      binding: "CONFIRMED",
    });
  });

  it("O. a Solana artifact under an Ethereum identity, and an Ethereum artifact under a Solana identity, are CHAIN_MISMATCH", async () => {
    const ethereum = await evmAdapter().adapter.retrieve(supplyIntent());
    const solana = await solanaFixture().retrieve({
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: SOLANA_MINT,
      subjectKind: "token",
      subject: SOLANA_MINT,
    });
    expect(validateOnchainBinding(solana, ETHEREUM_IDENTITY)).toEqual({ binding: "UNVERIFIED", reason: "CHAIN_MISMATCH" });
    expect(validateOnchainBinding(ethereum, SOLANA_IDENTITY)).toEqual({ binding: "UNVERIFIED", reason: "CHAIN_MISMATCH" });
    // A different Ethereum token is not this project.
    expect(validateOnchainBinding(ethereum, { ...ETHEREUM_IDENTITY, tokenAddress: "0x" + "cd34".repeat(10) })).toEqual({
      binding: "UNVERIFIED",
      reason: "ANCHOR_NOT_PROJECT_IDENTITY",
    });
  });

  it("O. a wrong Ethereum network fails closed at binding, and at the adapter", async () => {
    const good = await evmAdapter().adapter.retrieve(supplyIntent());
    const wrongNetwork: OnchainArtifact = brandOnchainArtifact({
      ...good,
      intent: { ...good.intent, network: "sepolia" as never },
      provenance: { ...good.provenance, network: "sepolia" as never },
    });
    expect(validateOnchainBinding(wrongNetwork, ETHEREUM_IDENTITY)).toEqual({
      binding: "UNVERIFIED",
      reason: "NETWORK_NOT_PRODUCTION",
    });
  });

  it("P. finality is never assumed: no finalized block means no observation, and a non-finalized reading anchors nothing", async () => {
    // A node that cannot serve the finalized tag answers null.
    const { adapter, calls } = evmAdapter({ block: null });
    await expect(adapter.retrieve(supplyIntent())).rejects.toThrow(/finalized block is not available/);
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
    // Or refuses the tag outright.
    const refused = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602 } });
    await expect(evmAdapter({ raw: { eth_getBlockByNumber: refused } }).adapter.retrieve(supplyIntent())).rejects.toBeInstanceOf(
      OnchainRpcError,
    );
    // A block with no usable position is a refusal, not a zero.
    for (const block of [
      { ...FINALIZED_BLOCK, number: "latest" },
      { ...FINALIZED_BLOCK, hash: "0x1234" },
      { ...FINALIZED_BLOCK, timestamp: "soon" },
      { hash: BLOCK_HASH },
    ]) {
      await expect(evmAdapter({ block }).adapter.retrieve(supplyIntent())).rejects.toThrow(OnchainRetrieverUnavailableError);
    }
    // The adapter never produces a non-finalized observation; if one were
    // constructed, the existing supply rule refuses it unchanged.
    const good = await evmAdapter().adapter.retrieve(supplyIntent());
    const confirmedOnly: OnchainArtifact = brandOnchainArtifact({
      ...good,
      provenance: { ...good.provenance, finality: "confirmed" },
    });
    expect(isComparableSupplyObservation(confirmedOnly)).toBe(false);
    expect(deriveTotalSupplyDelta(confirmedOnly, good)).toEqual({ comparable: false, reason: "NON_FINALIZED_OBSERVATION" });
    // And the adapter's own CODE never names "latest" as a block tag
    // (its comments say so; comment lines are excluded from the scan).
    const src = readFileSync("src/server/engine/providers/onchain-evm.ts", "utf-8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toMatch(/["']latest["']/);
    expect(src).toContain('const FINALIZED_BLOCK_TAG = "finalized"');
  });
});

// ---------------------------------------------------------------------
// Q: one primitive, and nothing else.
// ---------------------------------------------------------------------

describe("Q. the closed primitive — no other EVM read exists", () => {
  it("supports() and retrieve() refuse every intent kind but TOKEN_SUPPLY", async () => {
    const { adapter, calls } = evmAdapter();
    for (const kind of [
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNT_BALANCE",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "TOKEN_ACCOUNTS_BY_OWNER",
    ] as const) {
      expect(adapter.supports("ethereum", "mainnet", kind), kind).toBe(false);
      await expect(
        adapter.retrieve(supplyIntent({ kind, subjectKind: kind === "TRANSACTION_DETAIL" ? "tx" : "account" })),
      ).rejects.toThrow(/TOKEN_SUPPLY only/);
    }
    expect(calls).toHaveLength(0);
  });

  it("the adapter's source carries exactly two selectors and no balance, log, receipt, transfer, event, proxy or burn mechanics", () => {
    const raw = readFileSync("src/server/engine/providers/onchain-evm.ts", "utf-8");
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const selectors = new Set(code.match(/0x[0-9a-f]{8}\b/g) ?? []);
    expect([...selectors].sort()).toEqual(["0x18160ddd", "0x313ce567"]);
    const methods = new Set(code.match(/eth_[a-zA-Z]+/g) ?? []);
    expect([...methods].sort()).toEqual(["eth_call", "eth_chainId", "eth_getBlockByNumber"]);
    for (const banned of [
      "balanceOf",
      "0x70a08231",
      "eth_getLogs",
      "getLogs",
      "eth_getTransactionReceipt",
      "Receipt",
      "eth_getTransactionByHash",
      "Transfer(",
      "0xa9059cbb",
      "topics",
      "implementation",
      "eip1967",
      "1967",
      "burn",
      "Burn",
      "0x000000000000000000000000000000000000dEaD",
      "archive",
      "eth_getStorageAt",
      "eth_getCode",
    ]) {
      expect(code, banned).not.toContain(banned);
    }
    // No generic contract-call surface: the only place a selector reaches
    // eth_call is a literal constant, never a parameter.
    expect(code).not.toMatch(/data:\s*intent\./);
    expect(code).not.toMatch(/selector\s*:\s*string/i);
  });
});
