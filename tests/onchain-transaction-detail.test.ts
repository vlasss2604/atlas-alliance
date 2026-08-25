import { describe, expect, it } from "vitest";

import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type {
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";

// TRANSACTION CHARACTERISATION — decoding, never interpretation.
//
// The projection previously carried burns and nothing else, so a
// transaction with no burn was indistinguishable from one this layer
// simply could not describe. It now reports what the transaction CONTAINS:
// programs, account keys, parsed SPL Token instructions, and the token
// balances the RPC itself reported.
//
// The line that must not move: a Transfer to an address someone calls a
// burn address is a TRANSFER. CloseAccount is CloseAccount. A burn exists
// only when an actual Burn/BurnChecked instruction is present, and is never
// inferred from a zero post-balance, a destination, a closed account, a
// memo, or a balance decrease.

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_MINT = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_ACCOUNT = "TokAcctEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const DEST = "DestGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";
const AUTHORITY = "AuthHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const SIGNATURE =
  "44235e2hWBDBQvKpKn9mqkJ1FCnrZhoCBSLocjBDxUdYXB3GDc67RmEh6gciuvXdTrEtTF9S33uiHNcVLS8MEHe2";

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
const intent: OnchainIntent = {
  kind: "TRANSACTION_DETAIL",
  chain: "solana",
  network: "mainnet",
  projectAnchor: MINT,
  subjectKind: "tx",
  subject: SIGNATURE,
};

function ix(programId: string, type: string, info: Record<string, unknown>) {
  return { programId, parsed: { type, info } };
}

function tx(over: {
  instructions?: unknown[];
  inner?: unknown[];
  accountKeys?: unknown[];
  pre?: unknown[];
  post?: unknown[];
  err?: unknown;
} = {}) {
  return {
    slot: 441_595_300,
    blockTime: 1_787_648_082,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        instructions: over.instructions ?? [],
        accountKeys: over.accountKeys ?? [{ pubkey: TOKEN_ACCOUNT }, { pubkey: MINT }],
      },
    },
    meta: {
      err: over.err ?? null,
      innerInstructions: over.inner ? [{ instructions: over.inner }] : [],
      preTokenBalances: over.pre ?? [],
      postTokenBalances: over.post ?? [],
    },
  };
}

async function detail(payload: unknown): Promise<TransactionDetailResult> {
  const artifact = await adapterWith(payload).retrieve(intent);
  return artifact.result as TransactionDetailResult;
}

describe("what the transaction contains", () => {
  it("reports every distinct program, outer and inner, without duplicates", async () => {
    const r = await detail(
      tx({
        instructions: [ix(SYSTEM, "transfer", {}), ix(SPL_TOKEN, "transfer", {})],
        inner: [ix(SPL_TOKEN, "burn", { mint: MINT, account: TOKEN_ACCOUNT, amount: "1" })],
      }),
    );
    expect(r.programs.sort()).toEqual([SPL_TOKEN, SYSTEM].sort());
  });

  it("reports account keys in order, accepting both jsonParsed shapes", async () => {
    const objects = await detail(tx({ accountKeys: [{ pubkey: TOKEN_ACCOUNT }, { pubkey: MINT }] }));
    const strings = await detail(tx({ accountKeys: [TOKEN_ACCOUNT, MINT] }));
    expect(objects.accountKeys).toEqual([TOKEN_ACCOUNT, MINT]);
    expect(strings.accountKeys).toEqual([TOKEN_ACCOUNT, MINT]);
  });

  it("decodes the recognised SPL token instructions and marks inner ones", async () => {
    const r = await detail(
      tx({
        instructions: [
          ix(SPL_TOKEN, "transfer", {
            source: TOKEN_ACCOUNT,
            destination: DEST,
            authority: AUTHORITY,
            amount: "500",
          }),
        ],
        inner: [
          ix(SPL_TOKEN, "burnChecked", {
            mint: MINT,
            account: TOKEN_ACCOUNT,
            authority: AUTHORITY,
            tokenAmount: { amount: "160100000000000", decimals: 6 },
          }),
          ix(SPL_TOKEN, "closeAccount", { account: TOKEN_ACCOUNT, destination: DEST }),
        ],
      }),
    );
    expect(r.tokenInstructions.map((i) => `${i.inner ? "inner" : "outer"}:${i.type}`)).toEqual([
      "outer:transfer",
      "inner:burnChecked",
      "inner:closeAccount",
    ]);
    const transfer = r.tokenInstructions[0];
    expect(transfer).toMatchObject({
      account: TOKEN_ACCOUNT,
      destination: DEST,
      authority: AUTHORITY,
      amountRaw: "500",
    });
    const burn = r.tokenInstructions[1];
    expect(burn).toMatchObject({ mint: MINT, amountRaw: "160100000000000", decimals: 6 });
  });

  it("ignores instructions from programs that are not SPL Token", async () => {
    const r = await detail(tx({ instructions: [ix(SYSTEM, "transfer", { lamports: 1 })] }));
    expect(r.tokenInstructions).toEqual([]);
    expect(r.programs).toEqual([SYSTEM]);
  });

  it("ignores SPL instruction types it does not recognise, rather than guessing", async () => {
    const r = await detail(tx({ instructions: [ix(SPL_TOKEN, "mintTo", { mint: MINT })] }));
    expect(r.tokenInstructions).toEqual([]);
  });

  it("reports pre and post token balances, resolving the account by index", async () => {
    const balance = (index: number, amount: string, mint = MINT) => ({
      accountIndex: index,
      mint,
      owner: AUTHORITY,
      uiTokenAmount: { amount, decimals: 6 },
    });
    const r = await detail(
      tx({
        accountKeys: [{ pubkey: TOKEN_ACCOUNT }, { pubkey: MINT }],
        pre: [balance(0, "160100000000000")],
        post: [balance(0, "0")],
      }),
    );
    expect(r.preTokenBalances[0]).toMatchObject({
      accountIndex: 0,
      account: TOKEN_ACCOUNT,
      mint: MINT,
      amountRaw: "160100000000000",
      decimals: 6,
    });
    expect(r.postTokenBalances[0].amountRaw).toBe("0");
  });

  it("an out-of-range balance index resolves to null rather than a guess", async () => {
    const r = await detail(
      tx({
        accountKeys: [{ pubkey: TOKEN_ACCOUNT }],
        pre: [{ accountIndex: 9, mint: MINT, uiTokenAmount: { amount: "1", decimals: 6 } }],
      }),
    );
    expect(r.preTokenBalances[0].account).toBeNull();
    expect(r.preTokenBalances[0].owner).toBeNull();
  });

  it("balances stay strings — a u64 must not round", async () => {
    const huge = "838098204263102994";
    expect(Number(huge).toString()).not.toBe(huge);
    const r = await detail(
      tx({ pre: [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: huge, decimals: 6 } }] }),
    );
    expect(r.preTokenBalances[0].amountRaw).toBe(huge);
  });

  it("a failed transaction is reported as failed, not hidden", async () => {
    const r = await detail(tx({ err: { InstructionError: [0, "Custom"] } }));
    expect(r.succeeded).toBe(false);
    // And a failed transaction executed nothing, so it yields no fact.
    const artifact = await adapterWith(tx({ err: { InstructionError: [0, "x"] } })).retrieve(intent);
    expect(synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" })).toEqual([]);
  });
});

describe("decoding is not interpretation", () => {
  it("a TRANSFER to any destination is reported as a transfer, never a burn", async () => {
    const r = await detail(
      tx({
        instructions: [
          ix(SPL_TOKEN, "transfer", { source: TOKEN_ACCOUNT, destination: DEST, amount: "1" }),
        ],
      }),
    );
    expect(r.burns).toEqual([]);
    expect(r.tokenInstructions[0].type).toBe("transfer");
  });

  it("CloseAccount is not a burn", async () => {
    const r = await detail(
      tx({ instructions: [ix(SPL_TOKEN, "closeAccount", { account: TOKEN_ACCOUNT })] }),
    );
    expect(r.burns).toEqual([]);
  });

  it("a zero post-balance is not a burn", async () => {
    const r = await detail(
      tx({
        instructions: [
          ix(SPL_TOKEN, "transfer", { source: TOKEN_ACCOUNT, destination: DEST, amount: "10" }),
        ],
        pre: [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: "10", decimals: 6 } }],
        post: [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: "0", decimals: 6 } }],
      }),
    );
    expect(r.burns).toEqual([]);
    expect(synthesizeOnchainFacts(
      await adapterWith(
        tx({
          instructions: [
            ix(SPL_TOKEN, "transfer", { source: TOKEN_ACCOUNT, destination: DEST, amount: "10" }),
          ],
        }),
      ).retrieve(intent),
      { step: 6, component: "DESTINATION" },
    )).toEqual([]);
  });

  it("a genuine Burn IS reported, with its exact amount", async () => {
    const r = await detail(
      tx({
        instructions: [
          ix(SPL_TOKEN, "burn", {
            mint: MINT,
            account: TOKEN_ACCOUNT,
            authority: AUTHORITY,
            amount: "160100000000000",
          }),
        ],
      }),
    );
    expect(r.burns.length).toBe(1);
    expect(r.burns[0]).toMatchObject({
      instructionType: "Burn",
      mint: MINT,
      sourceAccount: TOKEN_ACCOUNT,
      amountRaw: "160100000000000",
    });
  });

  it("a burn of a DIFFERENT mint is still decoded, and is not the project's", async () => {
    // Reporting it is correct; calling it the project's would not be. The
    // mint is carried so the caller can compare against the anchor.
    const r = await detail(
      tx({
        instructions: [
          ix(SPL_TOKEN, "burn", { mint: OTHER_MINT, account: TOKEN_ACCOUNT, amount: "1" }),
        ],
      }),
    );
    expect(r.burns.length).toBe(1);
    expect(r.burns[0].mint).toBe(OTHER_MINT);
    expect(r.burns[0].mint).not.toBe(MINT);
  });

  it("no burn means an EMPTY list, never an assertion that none happened", async () => {
    const r = await detail(tx({}));
    expect(r.burns).toEqual([]);
    expect(r.tokenInstructions).toEqual([]);
    // And no fact is synthesized from absence.
    const artifact = await adapterWith(tx({})).retrieve(intent);
    expect(synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" })).toEqual([]);
  });
});

describe("the characterisation entrypoint", () => {
  const ENTRYPOINT = new URL("../scripts/onchain-transaction-detail.ts", import.meta.url);

  async function code(): Promise<string> {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(ENTRYPOINT, "utf-8");
    return raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  }

  it("gates on observed-signature provenance before transport exists", async () => {
    const c = await code();
    expect(c).toContain("resolveObservedSignature(db, {");
    const gate = c.indexOf("refusing — this signature has no admitted observed provenance");
    const retriever = c.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(retriever);
  });

  it("performs exactly ONE read and cannot escalate", async () => {
    const c = await code();
    expect((c.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    expect(c).toContain('kind: "TRANSACTION_DETAIL"');
    for (const banned of [
      "retry",
      "attempt",
      "for (let i",
      "while (",
      "before",
      "until",
      "cursor",
      "SIGNATURES_FOR_ADDRESS",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "getSignaturesForAddress",
      "anthropic",
      "brave",
      "playwright",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("writes no Evidence, memory, proof or route change, and inserts nothing directly", async () => {
    const c = await code();
    expect((c.match(/\.insert\(([a-zA-Z]+)\)/g) ?? [])).toEqual([]);
    for (const banned of [
      "persistOnchainArtifactAndFacts",
      "synthesizeOnchainFacts",
      "projectMemoryItems",
      "researchMemory",
      "proofs",
      "resolveSourceRoute",
      "createResearchJob",
      ".update(",
      ".delete(",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
    // Persistence, where it happens, is the standalone structured path.
    expect(c).toContain('origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" }');
  });

  it("names no project or mechanism in its executable code", async () => {
    const c = (await code()).toLowerCase();
    for (const banned of ["solscan", "buyback", "treasury", "hyperliquid", "uniswap"]) {
      expect(c, `entrypoint mentions "${banned}"`).not.toContain(banned);
    }
    expect((c.match(/pump/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});
