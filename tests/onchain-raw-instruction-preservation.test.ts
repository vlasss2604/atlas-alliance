import { describe, expect, it } from "vitest";

import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type {
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";

// KEEPING WHAT CANNOT YET BE READ.
//
// A program the node does not parse comes back as a program id, an account
// list and an opaque blob. Those were dropped, so the most consequential
// instruction in a transaction could leave nothing behind but its program
// id — and once the raw response was gone, no later decoding was possible
// even in principle. The same flattening threw away which outer
// instruction each inner one belonged to.
//
// Both are preserved now. NEITHER IS INTERPRETED. Nothing in this file, or
// in the code it exercises, says what any program does. Preserving the
// material is what makes a later, separately-decided decoding possible; it
// is not that decision, and no test here asserts a swap, a purchase or any
// other meaning.

const ANCHOR = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SIGNATURE = "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// Two programs this adapter does not decode. Named by id only — what they
// are is not established anywhere and is not asserted here.
const OPAQUE_A = "RawProgramAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OPAQUE_B = "RawProgramBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ACCT_1 = "AcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACCT_2 = "AcctBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SRC = "SrcTokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DST = "DstTokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OWNER_A = "OwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OWNER_B = "OwnerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const intent: OnchainIntent = {
  kind: "TRANSACTION_DETAIL",
  chain: "solana",
  network: "mainnet",
  projectAnchor: ANCHOR,
  subjectKind: "tx",
  subject: SIGNATURE,
};

function transport(payload: unknown): OnchainRpcTransport {
  return {
    async call() {
      return JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload });
    },
  };
}

async function read(payload: unknown): Promise<TransactionDetailResult> {
  const adapter = createSolanaOnchainAdapter({
    transport: transport(payload),
    providerId: "fixture-rpc",
    finality: "finalized",
  });
  const artifact = await adapter.retrieve(intent);
  return artifact.result as TransactionDetailResult;
}

// A parsed SPL Token transfer — the shape that already worked.
const parsedTransfer = {
  programId: TOKEN,
  parsed: {
    type: "transferChecked",
    info: {
      mint: ANCHOR,
      source: SRC,
      destination: DST,
      authority: OWNER_B,
      tokenAmount: { amount: "500", decimals: 6 },
    },
  },
};

// An instruction the node did not parse: id, accounts, opaque blob.
const opaque = (programId: string, accounts: string[], data: string) => ({
  programId,
  accounts,
  data,
});

function payload(over: Record<string, unknown> = {}) {
  return {
    slot: 100,
    blockTime: 1_787_737_824,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        instructions: [
          opaque(OPAQUE_A, [ACCT_1, ACCT_2], "3Bxs4h24hBtQy9rw"),
          { programId: SYSTEM, parsed: { type: "transfer", info: { source: OWNER_A, destination: ACCT_1, lamports: 42 } } },
        ],
        accountKeys: [OWNER_A, OWNER_B, ACCT_1, ACCT_2, SRC, DST],
      },
    },
    meta: {
      err: null,
      innerInstructions: [
        // Invoked from outer instruction 0.
        { index: 0, instructions: [parsedTransfer, opaque(OPAQUE_B, [SRC, DST], "5xY9")] },
        // Invoked from outer instruction 1.
        { index: 1, instructions: [opaque(OPAQUE_A, [ACCT_2], "7q")] },
      ],
      preTokenBalances: [
        { accountIndex: 4, mint: ANCHOR, owner: OWNER_B, uiTokenAmount: { amount: "500", decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 4, mint: ANCHOR, owner: OWNER_B, uiTokenAmount: { amount: "0", decimals: 6 } },
      ],
    },
    ...over,
  };
}

describe("1. parsed instructions are unchanged", () => {
  it("the SPL transfer decodes exactly as before", async () => {
    const r = await read(payload());
    const ix = r.tokenInstructions.find((x) => x.type === "transferChecked")!;
    expect(ix.programId).toBe(TOKEN);
    expect(ix.mint).toBe(ANCHOR);
    expect(ix.account).toBe(SRC);
    expect(ix.destination).toBe(DST);
    expect(ix.authority).toBe(OWNER_B);
    expect(ix.amountRaw).toBe("500");
    expect(ix.decimals).toBe(6);
    expect(ix.inner).toBe(true);
  });

  it("the System transfer still decodes as a lifecycle instruction", async () => {
    const r = await read(payload());
    const sys = r.lifecycleInstructions.find((x) => x.programId === SYSTEM)!;
    expect(sys.type).toBe("transfer");
    expect(sys.source).toBe(OWNER_A);
    expect(sys.destination).toBe(ACCT_1);
    expect(sys.lamports).toBe("42");
    expect(sys.inner).toBe(false);
  });

  it("a parsed instruction is never also kept as raw", async () => {
    const r = await read(payload());
    for (const raw of r.rawInstructions ?? []) {
      expect(raw.programId).not.toBe(TOKEN);
      expect(raw.programId).not.toBe(SYSTEM);
    }
  });

  it("programs still lists every invoked program, outer and inner", async () => {
    const r = await read(payload());
    expect(new Set(r.programs)).toEqual(new Set([OPAQUE_A, SYSTEM, TOKEN, OPAQUE_B]));
  });
});

describe("2. an unparsed instruction survives normalization", () => {
  it("programId, accounts and data are all kept, verbatim and in order", async () => {
    const r = await read(payload());
    const kept = (r.rawInstructions ?? []).filter((x) => !x.inner);
    expect(kept).toHaveLength(1);
    expect(kept[0].programId).toBe(OPAQUE_A);
    expect(kept[0].accounts).toEqual([ACCT_1, ACCT_2]); // order preserved, never sorted
    expect(kept[0].data).toBe("3Bxs4h24hBtQy9rw");
  });

  it("every unparsed instruction is kept, inner ones included", async () => {
    const r = await read(payload());
    expect(r.rawInstructions).toHaveLength(3);
    expect((r.rawInstructions ?? []).map((x) => x.programId)).toEqual([
      OPAQUE_A, // outer 0
      OPAQUE_B, // inner of outer 0
      OPAQUE_A, // inner of outer 1
    ]);
  });
});

describe("3. inner instructions retain their parent", () => {
  it("an outer instruction has no parent and its own position", async () => {
    const r = await read(payload());
    const outer = (r.rawInstructions ?? []).find((x) => !x.inner)!;
    expect(outer.parentIndex).toBeNull();
    expect(outer.instructionIndex).toBe(0);
  });

  it("an unparsed inner instruction names the outer instruction it came from", async () => {
    const r = await read(payload());
    const fromZero = (r.rawInstructions ?? []).find((x) => x.programId === OPAQUE_B)!;
    expect(fromZero.inner).toBe(true);
    expect(fromZero.parentIndex).toBe(0);
    expect(fromZero.instructionIndex).toBe(1); // second within its group

    const fromOne = (r.rawInstructions ?? []).find((x) => x.inner && x.programId === OPAQUE_A)!;
    expect(fromOne.parentIndex).toBe(1);
    expect(fromOne.instructionIndex).toBe(0);
  });

  it("a PARSED inner instruction carries the linkage too", async () => {
    // This is the one that matters for reasoning about movements: the SPL
    // transfer can now be attributed to the outer instruction that invoked
    // it, which is what "one invocation" versus "one transaction" turns on.
    const r = await read(payload());
    const ix = r.tokenInstructions.find((x) => x.type === "transferChecked")!;
    expect(ix.parentIndex).toBe(0);
    expect(ix.instructionIndex).toBe(0);
  });

  it("a group with no index reported leaves the parent absent, not invented", async () => {
    const p = payload();
    (p.meta.innerInstructions as { index?: number }[])[0] = {
      instructions: [parsedTransfer],
    } as never;
    const r = await read(p);
    const ix = r.tokenInstructions.find((x) => x.type === "transferChecked")!;
    // Still known to be inner; parent simply not recorded.
    expect(ix.inner).toBe(true);
    expect(ix.parentIndex).toBeNull();
  });
});

describe("4. malformed raw instructions fail closed", () => {
  const withOuter = (ix: unknown) => {
    const p = payload();
    (p.transaction.message.instructions as unknown[])[0] = ix;
    return p;
  };

  it("no data: dropped", async () => {
    const r = await read(withOuter({ programId: OPAQUE_A, accounts: [ACCT_1] }));
    expect((r.rawInstructions ?? []).some((x) => !x.inner)).toBe(false);
  });

  it("no accounts: dropped", async () => {
    const r = await read(withOuter({ programId: OPAQUE_A, data: "3Bxs" }));
    expect((r.rawInstructions ?? []).some((x) => !x.inner)).toBe(false);
  });

  it("no programId: dropped", async () => {
    const r = await read(withOuter({ accounts: [ACCT_1], data: "3Bxs" }));
    expect((r.rawInstructions ?? []).some((x) => !x.inner)).toBe(false);
  });

  it("non-base58 data: dropped rather than stored as-is", async () => {
    const r = await read(withOuter(opaque(OPAQUE_A, [ACCT_1], "not base58! 0OIl")));
    expect((r.rawInstructions ?? []).some((x) => !x.inner)).toBe(false);
  });

  it("an account that is not a valid address: the whole instruction is dropped", async () => {
    // Partial is worse than nothing: a half-recorded opaque instruction is
    // indistinguishable from a complete one later.
    const r = await read(withOuter(opaque(OPAQUE_A, [ACCT_1, "!!!not-an-address!!!"], "3Bxs")));
    expect((r.rawInstructions ?? []).some((x) => !x.inner)).toBe(false);
  });

  it("data past the ceiling: dropped, never truncated", async () => {
    const huge = "1".repeat(5000);
    const r = await read(withOuter(opaque(OPAQUE_A, [ACCT_1], huge)));
    expect((r.rawInstructions ?? []).some((x) => !x.inner)).toBe(false);
    for (const kept of r.rawInstructions ?? []) expect(kept.data).not.toBe(huge.slice(0, 4096));
  });

  it("too many accounts: dropped", async () => {
    const many = Array.from({ length: 65 }, () => ACCT_1);
    const r = await read(withOuter(opaque(OPAQUE_A, many, "3Bxs")));
    expect((r.rawInstructions ?? []).some((x) => !x.inner)).toBe(false);
  });

  it("dropping one leaves the rest of the transaction intact", async () => {
    const r = await read(withOuter({ programId: OPAQUE_A }));
    // The parsed instructions and the other raw ones are unaffected.
    expect(r.tokenInstructions).toHaveLength(1);
    expect(r.lifecycleInstructions.length).toBeGreaterThan(0);
    expect(r.rawInstructions).toHaveLength(2);
    expect(r.succeeded).toBe(true);
  });
});

describe("5. an artifact stored before this remains readable", () => {
  it("a payload with no rawInstructions key is valid, and absent is not empty", () => {
    // Shaped exactly like the persisted rows that predate this field. The
    // distinction is the point: undefined means nothing is known either
    // way, [] means the transaction was read and carried none.
    const old = {
      kind: "TRANSACTION_DETAIL",
      signature: SIGNATURE,
      slot: 100,
      blockTime: 1,
      succeeded: true,
      burns: [],
      programs: [OPAQUE_A],
      accountKeys: [],
      tokenInstructions: [],
      lifecycleInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    } as TransactionDetailResult;
    expect("rawInstructions" in old).toBe(false);
    expect(old.rawInstructions).toBeUndefined();
    // A reader that wants a list can default it — but only after deciding
    // that "unknown" and "none" may be treated alike for its purpose.
    expect(old.rawInstructions ?? []).toEqual([]);
  });

  it("a freshly read transaction with nothing unparsed reports an empty list", async () => {
    const p = payload();
    (p.transaction.message.instructions as unknown[]) = [
      { programId: SYSTEM, parsed: { type: "transfer", info: { source: OWNER_A, destination: ACCT_1, lamports: 42 } } },
    ];
    (p.meta.innerInstructions as unknown[]) = [{ index: 0, instructions: [parsedTransfer] }];
    const r = await read(p);
    expect(r.rawInstructions).toEqual([]);
    expect(r.rawInstructions).not.toBeUndefined();
  });
});

describe("6. nothing here assigns meaning", () => {
  it("the preserved record carries no type, name or semantics field", async () => {
    const r = await read(payload());
    const kept = (r.rawInstructions ?? [])[0];
    expect(Object.keys(kept).sort()).toEqual(
      ["accounts", "data", "inner", "instructionIndex", "parentIndex", "programId"].sort(),
    );
  });

  it("no burn, transfer or any decoded semantics is invented from an opaque blob", async () => {
    const r = await read(payload());
    expect(r.burns).toHaveLength(0);
    // Exactly one token instruction: the genuinely parsed one. The two
    // opaque instructions contributed no movement of any kind.
    expect(r.tokenInstructions).toHaveLength(1);
  });
});
