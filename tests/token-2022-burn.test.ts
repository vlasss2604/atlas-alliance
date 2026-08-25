import { describe, expect, it } from "vitest";

import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type {
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";

// TOKEN-2022 BURN DECODING.
//
// The confirmed PUMP mint is a Token-2022 mint, which the live
// characterisation read confirmed: its transferChecked instructions ran
// under TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb, not the classic SPL
// Token program. Transfer support was demonstrated there.
//
// TRANSFER SUPPORT DOES NOT IMPLY BURN SUPPORT. Both go through the same
// program-id allowlist, so both SHOULD work — but "should" is what tests
// are for, and no test covered a Token-2022 Burn or BurnChecked before
// this file. A burn under the wrong assumption is exactly the kind of
// finding that would be missed silently.

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// The REAL Token-2022 program id, as observed on chain.
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_MINT = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_ACCOUNT = "TokAcctEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const AUTHORITY = "AuthHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
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
function intentFor(anchor: string): OnchainIntent {
  return {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "tx",
    subject: SIGNATURE,
  };
}
function tx(instructions: unknown[], inner: unknown[] = []) {
  return {
    slot: 441_595_300,
    blockTime: 1_787_648_082,
    transaction: {
      signatures: [SIGNATURE],
      message: { instructions, accountKeys: [{ pubkey: TOKEN_ACCOUNT }, { pubkey: MINT }] },
    },
    meta: { err: null, innerInstructions: inner.length > 0 ? [{ instructions: inner }] : [] },
  };
}
function burnIx(programId: string, type: "burn" | "burnChecked", over: Record<string, unknown> = {}) {
  const info: Record<string, unknown> =
    type === "burn"
      ? { mint: MINT, account: TOKEN_ACCOUNT, authority: AUTHORITY, amount: "160100000000000" }
      : {
          mint: MINT,
          account: TOKEN_ACCOUNT,
          authority: AUTHORITY,
          tokenAmount: { amount: "160100000000000", decimals: 6 },
        };
  return { programId, parsed: { type, info: { ...info, ...over } } };
}

async function detail(payload: unknown, anchor = MINT): Promise<TransactionDetailResult> {
  const artifact = await adapterWith(payload).retrieve(intentFor(anchor));
  return artifact.result as TransactionDetailResult;
}

describe("Token-2022 burn decoding", () => {
  it("recognises Burn under Token-2022", async () => {
    const r = await detail(tx([burnIx(TOKEN_2022, "burn")]));
    expect(r.burns.length).toBe(1);
    expect(r.burns[0]).toMatchObject({
      programId: TOKEN_2022,
      instructionType: "Burn",
      mint: MINT,
      sourceAccount: TOKEN_ACCOUNT,
      authority: AUTHORITY,
      amountRaw: "160100000000000",
    });
  });

  it("recognises BurnChecked under Token-2022, with decimals", async () => {
    const r = await detail(tx([burnIx(TOKEN_2022, "burnChecked")]));
    expect(r.burns.length).toBe(1);
    expect(r.burns[0]).toMatchObject({
      programId: TOKEN_2022,
      instructionType: "BurnChecked",
      mint: MINT,
      amountRaw: "160100000000000",
      decimals: 6,
    });
  });

  it("recognises a Token-2022 burn as an INNER instruction (a CPI)", async () => {
    // A burn triggered by another program is still a burn, and inner
    // instructions are where a routed mechanism would put it.
    const r = await detail(tx([], [burnIx(TOKEN_2022, "burnChecked")]));
    expect(r.burns.length).toBe(1);
    expect(r.tokenInstructions[0]).toMatchObject({ type: "burnChecked", inner: true });
  });

  it("classic SPL Token burns still decode — both programs, not one", async () => {
    const classic = await detail(tx([burnIx(SPL_TOKEN, "burn")]));
    expect(classic.burns[0].programId).toBe(SPL_TOKEN);
    const both = await detail(tx([burnIx(SPL_TOKEN, "burn"), burnIx(TOKEN_2022, "burnChecked")]));
    expect(both.burns.map((b) => b.programId)).toEqual([SPL_TOKEN, TOKEN_2022]);
  });

  it("a burn under an UNKNOWN program is not a burn", async () => {
    // The allowlist is the whole authority here: a program that merely
    // emits a "burn"-shaped parsed instruction proves nothing.
    for (const impostor of ["11111111111111111111111111111111", MINT, AUTHORITY]) {
      const r = await detail(tx([burnIx(impostor, "burn")]));
      expect(r.burns, impostor).toEqual([]);
    }
  });

  it("a Token-2022 burn amount keeps full precision", async () => {
    const huge = "838098204263102994";
    expect(Number(huge).toString()).not.toBe(huge);
    const r = await detail(
      tx([burnIx(TOKEN_2022, "burnChecked", { tokenAmount: { amount: huge, decimals: 6 } })]),
    );
    expect(r.burns[0].amountRaw).toBe(huge);
  });
});

describe("a Token-2022 burn still requires confirmed mint binding", () => {
  it("a burn of the CONFIRMED mint synthesizes a burn fact", async () => {
    const artifact = await adapterWith(tx([burnIx(TOKEN_2022, "burnChecked")])).retrieve(
      intentFor(MINT),
    );
    const facts = synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" });
    expect(facts.length).toBe(1);
    expect(facts[0].statement).toContain("BurnChecked");
    expect(facts[0].statement).toContain(MINT);
    // And the fact says plainly what it does not prove.
    expect(facts[0].doesNotProve.toLowerCase()).toContain("buyback");
  });

  it("a burn of a DIFFERENT mint is decoded but is NOT the project's", async () => {
    // Reporting it is correct — refusing to decode it would hide what the
    // transaction contains. Treating it as the project's would be the
    // error, so the mint is carried for the caller to compare.
    const r = await detail(
      tx([burnIx(TOKEN_2022, "burnChecked", { mint: OTHER_MINT })]),
      MINT,
    );
    expect(r.burns.length).toBe(1);
    expect(r.burns[0].mint).toBe(OTHER_MINT);
    expect(r.burns[0].mint).not.toBe(MINT);
  });

  it("an artifact whose anchor is not the confirmed identity fails binding", async () => {
    const { validateOnchainBinding } = await import("../src/server/engine/onchain-binding");
    const artifact = await adapterWith(tx([burnIx(TOKEN_2022, "burnChecked")])).retrieve(
      intentFor(OTHER_MINT),
    );
    expect(
      validateOnchainBinding(artifact, { chain: "solana", tokenAddress: MINT, ticker: null }),
    ).toMatchObject({ binding: "UNVERIFIED", reason: "ANCHOR_NOT_PROJECT_IDENTITY" });
  });

  it("the program allowlist contains exactly the two real SPL token programs", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/onchain-solana.ts", import.meta.url),
      "utf-8",
    );
    // Pinned literally, so a mistyped program id cannot be introduced
    // quietly. These are chain infrastructure constants, not any project's
    // identity.
    expect(raw).toContain('"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"');
    expect(raw).toContain('"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"');
    const ids = raw.match(/"Token[a-zA-Z0-9]{20,}"/g) ?? [];
    expect([...new Set(ids)].length).toBe(2);
  });
});
