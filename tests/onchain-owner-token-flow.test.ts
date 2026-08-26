import { describe, expect, it } from "vitest";

import {
  computeOwnerTokenFlow,
  netFlowForMint,
  OWNER_TOKEN_FLOW_DOES_NOT_PROVE,
} from "../src/server/engine/onchain-owner-flow";
import type {
  TokenBalanceRef,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

// OWNER-BOUND TOKEN FLOW — what balances can and cannot say.
//
// The capability exists because a real transaction raised the question:
// a wallet's token account went from 0 to N and, five slots later, from N
// to 0 via BurnChecked. Reading that as "the wallet bought and burned" is
// an economic story; what the data holds is two balance changes. These
// tests pin the boundary between the two.

const OWNER = "OwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "OtherBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const MINT_A = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function bal(
  account: string,
  mint: string,
  owner: string | null,
  amountRaw: string,
  decimals = 6,
  accountIndex = 0,
): TokenBalanceRef {
  return { account, mint, owner, amountRaw, decimals, accountIndex };
}

function tx(
  pre: TokenBalanceRef[],
  post: TokenBalanceRef[],
  over: Partial<TransactionDetailResult> = {},
): TransactionDetailResult {
  return {
    kind: "TRANSACTION_DETAIL",
    signature: "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    slot: 100,
    blockTime: 1_700_000_000,
    succeeded: true,
    burns: [],
    programs: [],
    accountKeys: [],
    tokenInstructions: [],
    lifecycleInstructions: [],
    preTokenBalances: pre,
    postTokenBalances: post,
    ...over,
  };
}

describe("owner token flow — direction", () => {
  it("a balance that rose is an INFLOW", () => {
    const flow = computeOwnerTokenFlow(
      tx([bal("acc1", MINT_A, OWNER, "0")], [bal("acc1", MINT_A, OWNER, "7723746661")]),
      OWNER,
    );
    expect(flow.entries).toHaveLength(1);
    expect(flow.entries[0].direction).toBe("INFLOW");
    expect(flow.entries[0].deltaRaw).toBe("7723746661");
    expect(flow.entries[0].pairing).toBe("PAIRED");
  });

  it("a balance that fell is an OUTFLOW, and the delta keeps its sign", () => {
    const flow = computeOwnerTokenFlow(
      tx([bal("acc1", MINT_A, OWNER, "7723746661")], [bal("acc1", MINT_A, OWNER, "0")]),
      OWNER,
    );
    expect(flow.entries[0].direction).toBe("OUTFLOW");
    expect(flow.entries[0].deltaRaw).toBe("-7723746661");
    // The sign lives in direction; the formatted figure is magnitude only.
    expect(flow.entries[0].deltaFormatted).toBe("7723.746661");
  });

  it("an unmoved balance is UNCHANGED and is still reported", () => {
    // Kept rather than dropped: "the owner held this and it did not move"
    // is a different statement from "the owner held nothing".
    const flow = computeOwnerTokenFlow(
      tx([bal("acc1", MINT_A, OWNER, "500")], [bal("acc1", MINT_A, OWNER, "500")]),
      OWNER,
    );
    expect(flow.entries).toHaveLength(1);
    expect(flow.entries[0].direction).toBe("UNCHANGED");
    expect(flow.entries[0].deltaRaw).toBe("0");
  });
});

describe("owner token flow — one owner, several accounts", () => {
  it("nets across every account the owner holds for one mint", () => {
    const flow = computeOwnerTokenFlow(
      tx(
        [bal("acc1", MINT_A, OWNER, "100"), bal("acc2", MINT_A, OWNER, "50")],
        [bal("acc1", MINT_A, OWNER, "400"), bal("acc2", MINT_A, OWNER, "0")],
      ),
      OWNER,
    );
    expect(flow.entries).toHaveLength(2);
    const net = netFlowForMint(flow, MINT_A);
    expect(net?.netRaw).toBe("250"); // +300 and -50
    expect(net?.direction).toBe("INFLOW");
    expect(net?.accountsCounted).toBe(2);
  });

  it("two accounts that cancel out net to UNCHANGED without losing the entries", () => {
    const flow = computeOwnerTokenFlow(
      tx(
        [bal("acc1", MINT_A, OWNER, "100"), bal("acc2", MINT_A, OWNER, "100")],
        [bal("acc1", MINT_A, OWNER, "200"), bal("acc2", MINT_A, OWNER, "0")],
      ),
      OWNER,
    );
    expect(netFlowForMint(flow, MINT_A)?.direction).toBe("UNCHANGED");
    // The movement itself is not erased by the net.
    expect(flow.entries.map((e) => e.direction).sort()).toEqual(["INFLOW", "OUTFLOW"]);
  });

  it("never merges two different mints into one net", () => {
    const flow = computeOwnerTokenFlow(
      tx(
        [bal("acc1", MINT_A, OWNER, "0"), bal("acc2", MINT_B, OWNER, "1000", 9)],
        [bal("acc1", MINT_A, OWNER, "300"), bal("acc2", MINT_B, OWNER, "600", 9)],
      ),
      OWNER,
    );
    expect(flow.netByMint).toHaveLength(2);
    expect(netFlowForMint(flow, MINT_A)?.direction).toBe("INFLOW");
    expect(netFlowForMint(flow, MINT_B)?.direction).toBe("OUTFLOW");
    // Each mint keeps its own scale.
    expect(netFlowForMint(flow, MINT_A)?.decimals).toBe(6);
    expect(netFlowForMint(flow, MINT_B)?.decimals).toBe(9);
  });
});

describe("owner token flow — nothing else can contaminate it", () => {
  it("another party's account never enters this owner's flow", () => {
    const flow = computeOwnerTokenFlow(
      tx(
        [bal("acc1", MINT_A, OWNER, "0"), bal("acc9", MINT_A, OTHER, "97621058034968")],
        [bal("acc1", MINT_A, OWNER, "300"), bal("acc9", MINT_A, OTHER, "97613334288307")],
      ),
      OWNER,
    );
    expect(flow.entries).toHaveLength(1);
    expect(flow.entries[0].account).toBe("acc1");
    expect(netFlowForMint(flow, MINT_A)?.netRaw).toBe("300");
  });

  it("a balance with no owner is never attributed to anyone", () => {
    const flow = computeOwnerTokenFlow(
      tx([bal("accX", MINT_A, null, "0")], [bal("accX", MINT_A, null, "999")]),
      OWNER,
    );
    expect(flow.entries).toHaveLength(0);
    expect(flow.netByMint).toHaveLength(0);
  });

  it("an owner with no reported balances yields an empty flow, not a zero flow", () => {
    const flow = computeOwnerTokenFlow(
      tx([bal("acc9", MINT_A, OTHER, "10")], [bal("acc9", MINT_A, OTHER, "20")]),
      OWNER,
    );
    expect(flow.entries).toHaveLength(0);
    // There is no entry claiming the owner's balance stayed at zero.
    expect(flow.netByMint).toHaveLength(0);
  });
});

describe("owner token flow — an omitted balance is not a zero balance", () => {
  it("an account present only BEFORE is PRE_ONLY with no delta", () => {
    // Closed during the transaction. Treating post as 0 would invent an
    // outflow of the whole balance.
    const flow = computeOwnerTokenFlow(
      tx([bal("acc1", MINT_A, OWNER, "5000")], []),
      OWNER,
    );
    expect(flow.entries[0].pairing).toBe("PRE_ONLY");
    expect(flow.entries[0].deltaRaw).toBeNull();
    expect(flow.entries[0].direction).toBeNull();
    expect(flow.unpairedCount).toBe(1);
  });

  it("an account present only AFTER is POST_ONLY with no delta", () => {
    const flow = computeOwnerTokenFlow(
      tx([], [bal("acc1", MINT_A, OWNER, "5000")]),
      OWNER,
    );
    expect(flow.entries[0].pairing).toBe("POST_ONLY");
    expect(flow.entries[0].deltaRaw).toBeNull();
    expect(flow.unpairedCount).toBe(1);
  });

  it("an unpaired entry never reaches netByMint", () => {
    const flow = computeOwnerTokenFlow(
      tx(
        [bal("acc1", MINT_A, OWNER, "100")],
        [bal("acc1", MINT_A, OWNER, "300"), bal("acc2", MINT_A, OWNER, "77")],
      ),
      OWNER,
    );
    expect(netFlowForMint(flow, MINT_A)?.netRaw).toBe("200");
    expect(netFlowForMint(flow, MINT_A)?.accountsCounted).toBe(1);
    expect(flow.unpairedCount).toBe(1);
  });

  it("an account created AND closed inside the transaction is invisible, and silence says nothing", () => {
    // The real case: a wrapped-SOL account opened, spent through and
    // closed in one transaction appears in neither balance list. The
    // owner's wSOL movement is real and this module cannot see it.
    const flow = computeOwnerTokenFlow(
      tx([bal("accPump", MINT_A, OWNER, "0")], [bal("accPump", MINT_A, OWNER, "7723746661")]),
      OWNER,
    );
    expect(netFlowForMint(flow, MINT_B)).toBeNull();
    expect(flow.entries.some((e) => e.mint === MINT_B)).toBe(false);
    // null means "not measurable here", never "nothing happened" — the
    // caveat ships with the result so a caller cannot hold one without it.
    expect(OWNER_TOKEN_FLOW_DOES_NOT_PROVE).toContain("not evidence that none occurred");
  });
});

describe("owner token flow — precision", () => {
  it("keeps u64 amounts exact beyond Number.MAX_SAFE_INTEGER", () => {
    const pre = "18446744073709551000";
    const post = "18446744073709551615"; // u64 max
    const flow = computeOwnerTokenFlow(
      tx([bal("acc1", MINT_A, OWNER, pre, 0)], [bal("acc1", MINT_A, OWNER, post, 0)]),
      OWNER,
    );
    expect(flow.entries[0].deltaRaw).toBe("615");
    expect(BigInt(pre) + BigInt(615)).toBe(BigInt(post));
    // The naive route loses this outright.
    expect(Number(post) - Number(pre)).not.toBe(615);
  });

  it("raw values are strings, never numbers", () => {
    const flow = computeOwnerTokenFlow(
      tx([bal("acc1", MINT_A, OWNER, "1")], [bal("acc1", MINT_A, OWNER, "2")]),
      OWNER,
    );
    expect(typeof flow.entries[0].preRaw).toBe("string");
    expect(typeof flow.entries[0].postRaw).toBe("string");
    expect(typeof flow.entries[0].deltaRaw).toBe("string");
    expect(typeof netFlowForMint(flow, MINT_A)?.netRaw).toBe("string");
  });
});

describe("owner token flow — a flow is never an economic label", () => {
  // The whole point of the module. One transaction where a wallet's wSOL
  // falls and its PUMP rises is the shape of a swap, of a buyback, and
  // equally of two unrelated transfers batched together. The data cannot
  // tell them apart, so the type must not either.
  const twoLegged = computeOwnerTokenFlow(
    tx(
      [bal("accSol", MINT_B, OWNER, "382202589", 9), bal("accPump", MINT_A, OWNER, "0")],
      [bal("accSol", MINT_B, OWNER, "0", 9), bal("accPump", MINT_A, OWNER, "7723746661")],
    ),
    OWNER,
  );

  it("reports both legs exactly", () => {
    expect(netFlowForMint(twoLegged, MINT_B)?.direction).toBe("OUTFLOW");
    expect(netFlowForMint(twoLegged, MINT_A)?.direction).toBe("INFLOW");
    expect(netFlowForMint(twoLegged, MINT_A)?.netRaw).toBe("7723746661");
  });

  it("emits no swap, purchase, sale or buyback label", () => {
    const asJson = JSON.stringify(twoLegged).toLowerCase();
    for (const label of ["swap", "buyback", "purchase", "sale", "trade", "buy", "sell"]) {
      expect(asJson, `flow result carries the label "${label}"`).not.toContain(label);
    }
  });

  it("has no field an economic label could be written into", () => {
    const keys = Object.keys(twoLegged).concat(Object.keys(twoLegged.entries[0]));
    for (const k of keys) {
      expect(k.toLowerCase()).not.toMatch(/label|kind|category|classification|meaning|type/);
    }
  });

  it("the module's source names no project and no mechanism", () => {
    // Generic capability: no PUMP-specific decoding, ever.
    return (async () => {
      const fs = await import("node:fs/promises");
      const src = await fs.readFile(
        new URL("../src/server/engine/onchain-owner-flow.ts", import.meta.url),
        "utf-8",
      );
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n")
        .toLowerCase();
      for (const banned of ["pump", "jupiter", "raydium", "solscan", "buyback", "treasury"]) {
        expect(code, `module code mentions "${banned}"`).not.toContain(banned);
      }
    })();
  });

  it("two legs in one transaction are not asserted to be exchanged for each other", () => {
    // Nothing in the result relates MINT_A's inflow to MINT_B's outflow.
    // They are two independent measurements that happen to share a
    // transaction, and the shape of the type says exactly that.
    const a = netFlowForMint(twoLegged, MINT_A);
    const b = netFlowForMint(twoLegged, MINT_B);
    expect(Object.keys(a ?? {})).not.toContain("counterparty");
    expect(Object.keys(b ?? {})).not.toContain("exchangedFor");
    expect(OWNER_TOKEN_FLOW_DOES_NOT_PROVE).toContain("exchanged for each other");
  });
});

describe("owner token flow — sequential amount match is not attribution", () => {
  // Two transactions: an inflow of exactly N, then a burn of exactly N.
  // The equality is arithmetic and this module reports it as such; what
  // caused either remains outside what balances can say.
  const inflow = computeOwnerTokenFlow(
    tx([bal("accPump", MINT_A, OWNER, "0")], [bal("accPump", MINT_A, OWNER, "7723746661")], {
      slot: 441840975,
      signature: "SigInflowAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
    OWNER,
  );
  const burn = computeOwnerTokenFlow(
    tx([bal("accPump", MINT_A, OWNER, "7723746661")], [bal("accPump", MINT_A, OWNER, "0")], {
      slot: 441840980,
      signature: "SigBurnBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    }),
    OWNER,
  );

  it("the magnitudes match exactly and the directions oppose", () => {
    const inN = netFlowForMint(inflow, MINT_A);
    const outN = netFlowForMint(burn, MINT_A);
    expect(BigInt(inN!.netRaw)).toBe(BigInt(0) - BigInt(outN!.netRaw));
    expect(inN?.direction).toBe("INFLOW");
    expect(outN?.direction).toBe("OUTFLOW");
  });

  it("the two results stay separate observations, each tied to its own transaction", () => {
    // No combined object claims one caused the other.
    expect(inflow.signature).not.toBe(burn.signature);
    expect(inflow.slot).toBeLessThan(burn.slot);
    expect(Object.keys(inflow)).not.toContain("causedBy");
    expect(Object.keys(burn)).not.toContain("fundedBy");
  });

  it("an equal-and-opposite pair is not evidence the same tokens moved", () => {
    // Fungible balances have no identity. Equality of magnitude is
    // consistent with the same lot and with a coincidence of size, and
    // the module never picks between them.
    const asJson = (JSON.stringify(inflow) + JSON.stringify(burn)).toLowerCase();
    expect(asJson).not.toContain("same");
    expect(asJson).not.toContain("origin");
  });
});
