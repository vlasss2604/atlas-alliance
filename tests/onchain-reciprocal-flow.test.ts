import { describe, expect, it } from "vitest";

import {
  deriveReciprocalAssetFlows,
  RECIPROCAL_FLOW_DOES_NOT_PROVE,
} from "../src/server/engine/onchain-transaction-flow";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

// TWO ASSETS MOVING OPPOSITE WAYS IN ONE TRANSACTION.
//
// A real transaction sent native SOL from a documented address toward an
// account owned by another party, while an account owned by that same party
// sent the project's token into an account owned by the first — and the
// engine produced NOTHING from it, because TRANSACTION_DETAIL synthesized
// burns and only burns. The transaction contained zero burns.
//
// The structure is now expressible. What these tests mostly guard is that
// expressing it never becomes interpreting it: this shape is what a swap
// looks like, what a buyback looks like, and equally what two unrelated
// transfers batched together look like.

const ANCHOR = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FOREIGN = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const A = "PartyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // participant
const C = "PartyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"; // counterparty
const D = "PartyDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"; // a third party
const C_WSOL = "CwsolAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const C_TOKEN = "CtokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const A_TOKEN = "AtokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const D_WSOL = "DwsolAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const LAMPORTS = "850140914";
const TOKEN_AMOUNT = "17509274333";

const TARGET = { step: 2, component: "FLOW_PATH" };

function bal(account: string, mint: string, owner: string, amountRaw: string, decimals = 6) {
  return { accountIndex: 0, account, mint, owner, amountRaw, decimals };
}

function nativeTransfer(source: string, destination: string, lamports = LAMPORTS) {
  return {
    programId: SYSTEM,
    type: "transfer",
    inner: true,
    account: null,
    mint: null,
    owner: null,
    assignedProgram: null,
    payer: source,
    source,
    destination,
    lamports,
    tokenProgram: null,
  };
}

function syncNative(account: string) {
  return {
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    type: "syncNative",
    inner: true,
    account,
    mint: null,
    owner: null,
    assignedProgram: null,
    payer: null,
    source: null,
    destination: null,
    lamports: null,
    tokenProgram: null,
  };
}

function tokenTransfer(from: string, to: string, mint: string, amountRaw = TOKEN_AMOUNT) {
  return {
    programId: TOKEN_2022,
    type: "transferChecked",
    mint,
    account: from,
    destination: to,
    authority: C,
    amountRaw,
    decimals: 6,
    inner: true,
  };
}

function tx(over: Partial<TransactionDetailResult> = {}): TransactionDetailResult {
  return {
    kind: "TRANSACTION_DETAIL",
    signature: "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    slot: 442_000_000,
    blockTime: 1_787_800_000,
    succeeded: true,
    burns: [],
    programs: [],
    accountKeys: [],
    tokenInstructions: [],
    lifecycleInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    ...over,
  };
}

// The live shape, in synthetic form: A pays native SOL into C's wSOL
// account (synced), C's token account sends the target mint into A's token
// account, one successful transaction, zero burns.
function liveShaped(over: Partial<TransactionDetailResult> = {}): TransactionDetailResult {
  return tx({
    lifecycleInstructions: [nativeTransfer(A, C_WSOL), syncNative(C_WSOL)],
    tokenInstructions: [tokenTransfer(C_TOKEN, A_TOKEN, ANCHOR)],
    preTokenBalances: [
      bal(C_WSOL, WSOL, C, "38308803758074", 9),
      bal(A_TOKEN, ANCHOR, A, "0"),
      bal(C_TOKEN, ANCHOR, C, "19957702528399"),
    ],
    postTokenBalances: [
      bal(C_WSOL, WSOL, C, "38309653898988", 9),
      bal(A_TOKEN, ANCHOR, A, TOKEN_AMOUNT),
      bal(C_TOKEN, ANCHOR, C, "19940193254066"),
    ],
    ...over,
  });
}

function artifactOf(result: TransactionDetailResult, anchor = ANCHOR): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "tx",
    subject: result.signature,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: `atlas-onchain://solana/mainnet/project/${anchor}/tx/${result.signature}/detail`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "tx",
      subject: result.signature,
      slot: result.slot,
      blockTime: result.blockTime,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "getTransaction",
      requestParams: { subject: result.signature },
      retrievedAt: new Date(0),
      rawResponseHash: `sha256:raw:${result.signature}`,
      artifactHash: `sha256:art:${result.signature}`,
      transactionSignature: result.signature,
    },
  });
}

describe("reciprocal flow — the live-shaped transaction", () => {
  const flows = deriveReciprocalAssetFlows(liveShaped(), ANCHOR);

  it("derives exactly one flow, binding both legs to one counterparty", () => {
    expect(flows).toHaveLength(1);
    expect(flows[0].participant).toBe(A);
    expect(flows[0].counterparty).toBe(C);
  });

  it("keeps each leg exact, and does not collapse native SOL into wrapped SOL", () => {
    const [f] = flows;
    expect(f.outbound.kind).toBe("NATIVE_SOL");
    expect(f.outbound.amountRaw).toBe(LAMPORTS);
    expect(f.outbound.mint).toBeNull();
    expect(f.outbound.to).toBe(C_WSOL);
    expect(f.outbound.toOwner).toBe(C);
    // The conversion path is recorded as observed, not assumed away.
    expect(f.outbound.destinationSyncedNative).toBe(true);

    expect(f.inbound.kind).toBe("TOKEN");
    expect(f.inbound.mint).toBe(ANCHOR);
    expect(f.inbound.amountRaw).toBe(TOKEN_AMOUNT);
    expect(f.inbound.from).toBe(C_TOKEN);
    expect(f.inbound.fromOwner).toBe(C);
    expect(f.inbound.to).toBe(A_TOKEN);
    expect(f.inbound.toOwner).toBe(A);
  });

  it("requires no amount relationship between the two assets", () => {
    // Different assets, different scales. A rule requiring equality would
    // be inventing an exchange rate.
    const odd = deriveReciprocalAssetFlows(
      liveShaped({ lifecycleInstructions: [nativeTransfer(A, C_WSOL, "1"), syncNative(C_WSOL)] }),
      ANCHOR,
    );
    expect(odd).toHaveLength(1);
    expect(odd[0].outbound.amountRaw).toBe("1");
  });

  it("a syncNative that never ran is recorded as not observed", () => {
    const noSync = deriveReciprocalAssetFlows(
      liveShaped({ lifecycleInstructions: [nativeTransfer(A, C_WSOL)] }),
      ANCHOR,
    );
    expect(noSync[0].outbound.destinationSyncedNative).toBe(false);
  });
});

describe("reciprocal flow — facts, and the words they must not use", () => {
  const facts = synthesizeOnchainFacts(artifactOf(liveShaped()), TARGET);

  it("produces the two legs and the pairing, where it previously produced nothing", () => {
    // Zero burns: before this capability the whole transaction yielded [].
    expect(liveShaped().burns).toHaveLength(0);
    expect(facts).toHaveLength(3);
  });

  it("the legs are DIRECT decoded movements, offered as context only", () => {
    // DIRECT is about the READING: these are decoded instructions, not an
    // inference. CONTEXT is about the CLAIM: a movement is not a mechanism,
    // so no component may be established from one. The two axes answer
    // different questions and are set independently.
    for (const f of facts.slice(0, 2)) {
      expect(f.directness).toBe("DIRECT");
      expect(f.relationship).toBe("CONTEXT");
    }
  });

  it("the pairing is CONTEXT — structure, never an established exchange", () => {
    const pairing = facts[2];
    expect(pairing.relationship).toBe("CONTEXT");
    expect(pairing.doesNotProve).toBe(RECIPROCAL_FLOW_DOES_NOT_PROVE);
    // Co-occurrence, not causality.
    expect(pairing.statement).toContain("The same successful transaction");
    expect(pairing.statement.toLowerCase()).not.toContain("in exchange for");
  });

  it("no economic verdict appears in any statement", () => {
    const text = facts.map((f) => f.statement).join(" ").toLowerCase();
    for (const forbidden of [
      "buyback",
      "buy back",
      "purchase",
      "bought",
      "swap",
      "sold",
      "sale",
      "market buy",
      "revenue",
      "burn",
      "destroy",
      "supply",
    ]) {
      expect(text, `statement asserts "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("no owner is called a wallet, and no role is assigned", () => {
    const text = facts.map((f) => `${f.statement} ${f.doesNotProve}`).join(" ").toLowerCase();
    for (const forbidden of ["wallet", "treasury", "vault", "holder"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("the limits say plainly that batching produces the same picture", () => {
    expect(RECIPROCAL_FLOW_DOES_NOT_PROVE).toContain(
      "Two unrelated transfers batched into one transaction produce exactly this picture",
    );
    expect(RECIPROCAL_FLOW_DOES_NOT_PROVE).toContain("does NOT establish that either movement caused the other");
  });

  it("every subject, amount and mint survives into the statements exactly", () => {
    const text = facts.map((f) => f.statement).join(" ");
    for (const value of [A, C, C_WSOL, C_TOKEN, A_TOKEN, ANCHOR, LAMPORTS]) {
      expect(text, value).toContain(value);
    }
  });
});

describe("reciprocal flow — negative and ambiguous cases", () => {
  it("1. two transfers to DIFFERENT counterparties yield no flow", () => {
    const t = liveShaped({
      lifecycleInstructions: [nativeTransfer(A, D_WSOL), syncNative(D_WSOL)],
      preTokenBalances: [
        bal(D_WSOL, WSOL, D, "1", 9),
        bal(A_TOKEN, ANCHOR, A, "0"),
        bal(C_TOKEN, ANCHOR, C, "5"),
      ],
      postTokenBalances: [
        bal(D_WSOL, WSOL, D, "2", 9),
        bal(A_TOKEN, ANCHOR, A, TOKEN_AMOUNT),
        bal(C_TOKEN, ANCHOR, C, "1"),
      ],
    });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
  });

  it("2. a target-token transfer alone yields no flow", () => {
    const t = liveShaped({ lifecycleInstructions: [] });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
  });

  it("3. a native transfer alone yields no flow", () => {
    const t = liveShaped({ tokenInstructions: [] });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
  });

  it("4. a FOREIGN mint on the token leg yields no flow", () => {
    const t = liveShaped({
      tokenInstructions: [tokenTransfer(C_TOKEN, A_TOKEN, FOREIGN)],
      preTokenBalances: [
        bal(C_WSOL, WSOL, C, "1", 9),
        bal(A_TOKEN, FOREIGN, A, "0"),
        bal(C_TOKEN, FOREIGN, C, "5"),
      ],
      postTokenBalances: [
        bal(C_WSOL, WSOL, C, "2", 9),
        bal(A_TOKEN, FOREIGN, A, TOKEN_AMOUNT),
        bal(C_TOKEN, FOREIGN, C, "1"),
      ],
    });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
    // And it is not quietly re-derived against its own mint by the caller:
    // synthesis always uses the artifact's project anchor.
    expect(synthesizeOnchainFacts(artifactOf(t), TARGET)).toHaveLength(0);
  });

  it("6. an unresolved token-account owner fails closed", () => {
    // No balance metadata for the destination: the counterparty cannot be
    // bound, so the flow is not derived at all.
    const t = liveShaped({
      preTokenBalances: [bal(A_TOKEN, ANCHOR, A, "0"), bal(C_TOKEN, ANCHOR, C, "5")],
      postTokenBalances: [bal(A_TOKEN, ANCHOR, A, TOKEN_AMOUNT), bal(C_TOKEN, ANCHOR, C, "1")],
    });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
  });

  it("6. contradictory ownership for one account fails closed", () => {
    const t = liveShaped({
      postTokenBalances: [
        bal(C_WSOL, WSOL, D, "38309653898988", 9), // owner disagrees with pre
        bal(A_TOKEN, ANCHOR, A, TOKEN_AMOUNT),
        bal(C_TOKEN, ANCHOR, C, "19940193254066"),
      ],
    });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
  });

  it("7. a FAILED transaction yields no flow and no facts", () => {
    const t = liveShaped({ succeeded: false });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
    expect(synthesizeOnchainFacts(artifactOf(t), TARGET)).toHaveLength(0);
  });

  it("8. no burn fact is synthesized when no burn was decoded", () => {
    const facts = synthesizeOnchainFacts(artifactOf(liveShaped()), TARGET);
    expect(facts.some((f) => f.statement.includes("destroying"))).toBe(false);
    expect(facts.map((f) => f.statement).join(" ").toLowerCase()).not.toContain("burn");
  });

  it("a participant paying itself is not a reciprocal flow", () => {
    const t = liveShaped({
      lifecycleInstructions: [nativeTransfer(A, A_TOKEN), syncNative(A_TOKEN)],
      preTokenBalances: [bal(A_TOKEN, ANCHOR, A, "0"), bal(C_TOKEN, ANCHOR, A, "5")],
      postTokenBalances: [bal(A_TOKEN, ANCHOR, A, TOKEN_AMOUNT), bal(C_TOKEN, ANCHOR, A, "1")],
    });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
  });

  it("an ambiguous pair with two candidate legs is dropped, not resolved", () => {
    // Two native legs from A to C-owned accounts. Which pairs with the
    // token leg is not decidable, so no flow is claimed.
    const t = liveShaped({
      lifecycleInstructions: [
        nativeTransfer(A, C_WSOL),
        nativeTransfer(A, C_TOKEN, "5"),
        syncNative(C_WSOL),
      ],
    });
    expect(deriveReciprocalAssetFlows(t, ANCHOR)).toHaveLength(0);
  });
});

describe("reciprocal flow — identity and replay", () => {
  it("replaying the same transaction yields identical facts", () => {
    const a = synthesizeOnchainFacts(artifactOf(liveShaped()), TARGET);
    const b = synthesizeOnchainFacts(artifactOf(liveShaped()), TARGET);
    expect(b).toEqual(a);
  });

  it("reversing the A/C roles is a different semantic identity", () => {
    const reversed = liveShaped({
      lifecycleInstructions: [nativeTransfer(C, A_TOKEN), syncNative(A_TOKEN)],
      tokenInstructions: [tokenTransfer(A_TOKEN, C_TOKEN, ANCHOR)],
      preTokenBalances: [
        bal(A_TOKEN, ANCHOR, A, "5"),
        bal(C_TOKEN, ANCHOR, C, "0"),
      ],
      postTokenBalances: [
        bal(A_TOKEN, ANCHOR, A, "1"),
        bal(C_TOKEN, ANCHOR, C, TOKEN_AMOUNT),
      ],
    });
    const forward = deriveReciprocalAssetFlows(liveShaped(), ANCHOR)[0];
    const back = deriveReciprocalAssetFlows(reversed, ANCHOR)[0];
    expect(back).toBeTruthy();
    expect(back.participant).toBe(C);
    expect(back.counterparty).toBe(A);
    expect(back.participant).not.toBe(forward.participant);

    const fwdFacts = synthesizeOnchainFacts(artifactOf(liveShaped()), TARGET);
    const backFacts = synthesizeOnchainFacts(artifactOf(reversed), TARGET);
    expect(backFacts[2].supportFragment).not.toBe(fwdFacts[2].supportFragment);
  });

  it("the three facts of one flow never share a fragment", () => {
    const facts = synthesizeOnchainFacts(artifactOf(liveShaped()), TARGET);
    const fragments = new Set(facts.map((f) => f.supportFragment));
    expect(fragments.size).toBe(facts.length);
  });

  it("two independent transactions stay separate", () => {
    const other = liveShaped({ signature: "SigBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", slot: 442_000_001 });
    const a = synthesizeOnchainFacts(artifactOf(liveShaped()), TARGET);
    const b = synthesizeOnchainFacts(artifactOf(other), TARGET);
    for (let i = 0; i < a.length; i += 1) {
      expect(b[i].supportFragment).not.toBe(a[i].supportFragment);
    }
  });

  it("a different target mint does not collapse into the same fact", () => {
    // Same transaction shape, judged against a different project anchor:
    // the token leg is then foreign and no flow exists.
    expect(deriveReciprocalAssetFlows(liveShaped(), FOREIGN)).toHaveLength(0);
  });

  it("flow ordering is deterministic across runs", () => {
    for (let i = 0; i < 5; i += 1) {
      const flows = deriveReciprocalAssetFlows(liveShaped(), ANCHOR);
      expect(flows.map((f) => `${f.participant}|${f.counterparty}`)).toEqual([`${A}|${C}`]);
    }
  });

  it("the module names no project and hard-codes no address but chain infrastructure", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/onchain-transaction-flow.ts", import.meta.url),
      "utf-8",
    );
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // PROJECT-SPECIFIC names are banned outright. Economic words are NOT:
    // RECIPROCAL_FLOW_DOES_NOT_PROVE is a code string whose whole job is to
    // name the conclusions this observation does not support, exactly as
    // every other doesNotProve entry does. That no such word reaches a
    // STATEMENT is asserted separately, over the synthesized facts.
    const lower = src.toLowerCase();
    for (const banned of ["pump", "jupiter", "raydium", "solscan"]) {
      expect(lower, `module mentions "${banned}"`).not.toContain(banned);
    }
    expect(RECIPROCAL_FLOW_DOES_NOT_PROVE.toLowerCase()).toContain("buyback");
    const addresses = (codeOnly.match(/["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/g) ?? []).map((m) =>
      m.slice(1, -1),
    );
    // Only the System program id, which is the same constant for every
    // project on Solana.
    expect(addresses).toEqual(["11111111111111111111111111111111"]);
  });
});
