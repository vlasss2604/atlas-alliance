import { describe, expect, it } from "vitest";

import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { deriveReciprocalAssetFlows } from "../src/server/engine/onchain-transaction-flow";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

// THE INFLOW THAT PRODUCES NO FACT.
//
// The fixture is the normalized_result of onchain_artifacts row
// 1c9f3afd-f02f-4c04-a394-2aa78d0537c3, copied verbatim from the local
// database. It is the transaction five slots before the known burn, and it
// moved exactly the quantity that was later destroyed INTO the token
// account that was later burned from.
//
// It carries a reciprocal shape — the documented address pays out native
// SOL, a counterparty's account pays in the project's token — but ATLAS
// derives nothing from it, because the payment is routed through a
// TRANSIENT WRAPPED-SOL ACCOUNT the payer creates, funds, spends and closes
// inside the same transaction. That account never appears in the
// transaction's token-balance metadata, so its ownership is unresolvable,
// and the derivation correctly refuses to guess.
//
// These tests pin BOTH halves: the movements really are there and reconcile
// exactly, AND today's code yields no fact from them. Neither half is an
// accusation. The derivation fails closed, which is the designed behaviour;
// what the tests establish is the exact shape a future extension would have
// to handle, so nobody has to rediscover it from a database.
//
// NOTHING here says buyback, purchase, swap or market. The programs the
// transaction invokes are recorded as opaque ids on purpose — decoding what
// a program means is a separate, separately-authorized step, and it is the
// step that would license those words.

const ANCHOR = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// A — the documented address, and the token account it owns.
const A = "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c";
const A_PUMP = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
// The transient wrapped-SOL account A creates, funds, spends and closes.
const A_WSOL_TRANSIENT = "DnpwdpjS7Ko1nQYbR8suRzcrYEqiTwhNbqXFviAPzeLn";
// C — the owner on the other side of both legs.
const C = "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5";
const C_PUMP = "48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK";
const C_WSOL = "A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6";
// A third party receiving a small separate wSOL amount. Not interpreted.
const D = "7iWnBRRhBCiNXXPhqiGzvvBkKrvFSWqqmxRyu9VyYBxE";
const D_WSOL = "2oL6my4QDDCfpgJZX1bZV1NgbmuNptKdgcE8wJm6efgk";

const SIGNATURE =
  "4eMRNdmcsvxG86g7KqfQHFNivueW1BHnY5Qut6WkTkX2zGL2E4EQEkGH2vB8b7vtamc6xa5E4Wi1BCnzUteQCwXR";
const SLOT = 441_840_975;
const PUMP_RAW = "7723746661";
const LAMPORTS_IN = "382585174";
const WSOL_TO_C = "382202589";
const WSOL_TO_D = "382585";

function storedResult(): TransactionDetailResult {
  return JSON.parse(
    JSON.stringify({
      kind: "TRANSACTION_DETAIL",
      slot: SLOT,
      burns: [],
      programs: [
        "ComputeBudget111111111111111111111111111111",
        ATA,
        SYSTEM,
        TOKEN,
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        TOKEN_2022,
      ],
      blockTime: 1_787_737_824,
      signature: SIGNATURE,
      succeeded: true,
      accountKeys: [A, A_PUMP, C_PUMP, C_WSOL, D_WSOL, A_WSOL_TRANSIENT],
      tokenInstructions: [
        { mint: null, type: "closeAccount", inner: false, account: A_WSOL_TRANSIENT, decimals: null, amountRaw: null, authority: A, programId: TOKEN, destination: A },
        { mint: WSOL, type: "transferChecked", inner: true, account: A_WSOL_TRANSIENT, decimals: 9, amountRaw: WSOL_TO_C, authority: A, programId: TOKEN, destination: C_WSOL },
        { mint: ANCHOR, type: "transferChecked", inner: true, account: C_PUMP, decimals: 6, amountRaw: PUMP_RAW, authority: C, programId: TOKEN_2022, destination: A_PUMP },
        { mint: null, type: "transfer", inner: true, account: A_WSOL_TRANSIENT, decimals: null, amountRaw: WSOL_TO_D, authority: A, programId: TOKEN, destination: D_WSOL },
      ],
      lifecycleInstructions: [
        { mint: WSOL, type: "createIdempotent", inner: false, owner: A, payer: A, source: A, account: A_WSOL_TRANSIENT, lamports: null, programId: ATA, destination: null, tokenProgram: TOKEN, assignedProgram: null },
        { mint: null, type: "transfer", inner: false, owner: null, payer: A, source: A, account: null, lamports: LAMPORTS_IN, programId: SYSTEM, destination: A_WSOL_TRANSIENT, tokenProgram: null, assignedProgram: null },
        { mint: null, type: "syncNative", inner: false, owner: null, payer: null, source: null, account: A_WSOL_TRANSIENT, lamports: null, programId: TOKEN, destination: null, tokenProgram: null, assignedProgram: null },
        { mint: null, type: "createAccount", inner: true, owner: null, payer: A, source: A, account: A_WSOL_TRANSIENT, lamports: "2039280", programId: SYSTEM, destination: null, tokenProgram: null, assignedProgram: TOKEN },
        { mint: WSOL, type: "initializeAccount3", inner: true, owner: A, payer: null, source: null, account: A_WSOL_TRANSIENT, lamports: null, programId: TOKEN, destination: null, tokenProgram: null, assignedProgram: null },
      ],
      preTokenBalances: [
        { mint: ANCHOR, owner: A, account: A_PUMP, decimals: 6, amountRaw: "0", accountIndex: 3 },
        { mint: WSOL, owner: D, account: D_WSOL, decimals: 9, amountRaw: "1035310248", accountIndex: 11 },
        { mint: ANCHOR, owner: C, account: C_PUMP, decimals: 6, amountRaw: "97621058034968", accountIndex: 13 },
        { mint: WSOL, owner: C, account: C_WSOL, decimals: 9, amountRaw: "6099621274382", accountIndex: 15 },
      ],
      postTokenBalances: [
        { mint: ANCHOR, owner: A, account: A_PUMP, decimals: 6, amountRaw: PUMP_RAW, accountIndex: 3 },
        { mint: WSOL, owner: D, account: D_WSOL, decimals: 9, amountRaw: "1035692833", accountIndex: 11 },
        { mint: ANCHOR, owner: C, account: C_PUMP, decimals: 6, amountRaw: "97613334288307", accountIndex: 13 },
        { mint: WSOL, owner: C, account: C_WSOL, decimals: 9, amountRaw: "6100003476971", accountIndex: 15 },
      ],
    }),
  ) as TransactionDetailResult;
}

function artifact(result: TransactionDetailResult): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: ANCHOR,
    subjectKind: "tx",
    subject: SIGNATURE,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: `atlas-onchain://solana/mainnet/project/${ANCHOR}/tx/${SIGNATURE}/detail`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "tx",
      subject: SIGNATURE,
      slot: SLOT,
      blockTime: 1_787_737_824,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: SIGNATURE },
      retrievedAt: new Date("2026-08-26T11:13:28.495Z"),
      rawResponseHash: "sha256:686ba894aaabfd9f47ce709b9a75f9e5db7bbf918b102652c370ec84c8f81212",
      artifactHash: "sha256:3437100549a618bcb65830843814756f4ee741f59474ca743fd55a326245fe09",
      transactionSignature: SIGNATURE,
    },
  });
}

describe("1. the movements are real and reconcile exactly", () => {
  const r = storedResult();

  it("the project's token moves from the counterparty into the documented account", () => {
    const ix = r.tokenInstructions.find((x) => x.mint === ANCHOR)!;
    expect(ix.type).toBe("transferChecked");
    expect(ix.account).toBe(C_PUMP);
    expect(ix.destination).toBe(A_PUMP);
    expect(ix.amountRaw).toBe(PUMP_RAW);
    expect(ix.authority).toBe(C);
  });

  it("the token balances confirm it on both sides", () => {
    const delta = (acct: string, mint: string) => {
      const pre = r.preTokenBalances.find((b) => b.account === acct && b.mint === mint);
      const post = r.postTokenBalances.find((b) => b.account === acct && b.mint === mint);
      return BigInt(post?.amountRaw ?? "0") - BigInt(pre?.amountRaw ?? "0");
    };
    expect(delta(A_PUMP, ANCHOR)).toBe(BigInt(PUMP_RAW));
    expect(delta(C_PUMP, ANCHOR)).toBe(-BigInt(PUMP_RAW));
    expect(delta(C_WSOL, WSOL)).toBe(BigInt(WSOL_TO_C));
    expect(delta(D_WSOL, WSOL)).toBe(BigInt(WSOL_TO_D));
  });

  it("the documented address funds a transient wSOL account and spends all of it", () => {
    const sys = r.lifecycleInstructions.find((x) => x.programId === SYSTEM && x.type === "transfer")!;
    expect(sys.source).toBe(A);
    expect(sys.destination).toBe(A_WSOL_TRANSIENT);
    expect(sys.lamports).toBe(LAMPORTS_IN);
    // Every lamport delivered leaves again in this same transaction.
    expect(BigInt(WSOL_TO_C) + BigInt(WSOL_TO_D)).toBe(BigInt(LAMPORTS_IN));
    // And the account is created and closed inside the transaction.
    expect(r.lifecycleInstructions.some((x) => x.type === "createIdempotent" && x.account === A_WSOL_TRANSIENT)).toBe(true);
    expect(r.tokenInstructions.some((x) => x.type === "closeAccount" && x.account === A_WSOL_TRANSIENT)).toBe(true);
  });

  it("the transient account appears in NO balance metadata, so its owner is unresolvable", () => {
    // This is the whole reason the derivation below finds nothing.
    for (const b of [...r.preTokenBalances, ...r.postTokenBalances]) {
      expect(b.account).not.toBe(A_WSOL_TRANSIENT);
    }
  });

  it("there is no burn here", () => {
    expect(r.burns).toHaveLength(0);
  });
});

describe("2. what ATLAS derives from it today: nothing", () => {
  it("no reciprocal flow is derived", () => {
    // The native leg's destination is the transient account, whose owner
    // cannot be read from balance metadata — so the leg is dropped before
    // any pairing is attempted. Failing closed, not failing wrong.
    expect(deriveReciprocalAssetFlows(storedResult(), ANCHOR)).toHaveLength(0);
  });

  it("the synthesizer produces no fact at all", () => {
    // No burn and no derivable flow means this transaction contributes
    // nothing to Evidence, however much it deterministically established.
    for (const component of ["EXECUTION_EVIDENCE", "FLOW_PATH", "DESTINATION"]) {
      const facts = synthesizeOnchainFacts(artifact(storedResult()), { step: 4, component });
      expect(facts, component).toHaveLength(0);
    }
  });

  it("the shape it cannot see is A -> A's own wrapper -> C, not A -> C", () => {
    // The derivation looks for a native transfer whose destination is a
    // token account owned by the COUNTERPARTY. Here the destination is
    // owned by the payer, and the counterparty is reached one hop later by
    // a token transfer out of that wrapper.
    const sys = storedResult().lifecycleInstructions.find(
      (x) => x.programId === SYSTEM && x.type === "transfer",
    )!;
    const wsolOut = storedResult().tokenInstructions.find(
      (x) => x.mint === WSOL && x.destination === C_WSOL,
    )!;
    expect(sys.destination).toBe(A_WSOL_TRANSIENT);
    expect(wsolOut.account).toBe(A_WSOL_TRANSIENT);
    // The wrapper is owned by the payer, per the lifecycle instruction that
    // initialized it — not by anything in balance metadata.
    const init = storedResult().lifecycleInstructions.find((x) => x.type === "initializeAccount3")!;
    expect(init.account).toBe(A_WSOL_TRANSIENT);
    expect(init.owner).toBe(A);
  });
});

describe("3. the words this transaction does not license", () => {
  it("the programs stay opaque ids — decoding one is a separate step", () => {
    const r = storedResult();
    // Recorded, never interpreted. Naming what a program does is exactly
    // the step that would license "swap" or "market purchase".
    expect(r.programs).toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(r.programs).toContain("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  });

  it("nothing establishes where the lamports came from", () => {
    // The System transfer's source is the documented address. What funded
    // THAT is outside this transaction entirely.
    const sys = storedResult().lifecycleInstructions.find(
      (x) => x.programId === SYSTEM && x.type === "transfer",
    )!;
    expect(sys.source).toBe(A);
    // There is no inbound native leg to A anywhere in this transaction.
    expect(
      storedResult().lifecycleInstructions.filter((x) => x.destination === A),
    ).toHaveLength(0);
  });
});
