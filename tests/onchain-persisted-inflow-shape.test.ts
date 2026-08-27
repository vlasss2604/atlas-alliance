import { describe, expect, it } from "vitest";

import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { deriveReciprocalAssetFlows } from "../src/server/engine/onchain-transaction-flow";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

// THE INFLOW, AND THE ROUTING THAT USED TO HIDE IT.
//
// The fixture is the normalized_result of onchain_artifacts row
// 1c9f3afd-f02f-4c04-a394-2aa78d0537c3, copied verbatim from the local
// database. It is the transaction five slots before the known burn, and it
// moved exactly the quantity that was later destroyed INTO the token account
// that was later burned from.
//
// It carries a reciprocal shape — the documented address pays out native SOL,
// a counterparty's account pays in the project's token — routed through a
// TRANSIENT WRAPPED-SOL ACCOUNT the payer creates, funds, spends and closes
// inside the same transaction. That account appears in no token-balance
// metadata, because it did not exist before the transaction and did not
// survive it. Ownership was therefore unresolvable and the derivation returned
// nothing at all, however much the transaction established.
//
// It is resolvable now, from the same-transaction instructions that name the
// owner by protocol definition — an attestation READ, never an owner guessed.
//
// NOTHING here says buyback, purchase, swap or market. The programs the
// transaction invokes are recorded as opaque ids on purpose: decoding what a
// program means is a separate, separately-authorized step, and it is the step
// that would license those words.

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

function storedResult(over: Partial<TransactionDetailResult> = {}): TransactionDetailResult {
  const base = JSON.parse(
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
  return { ...base, ...over };
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

const factsFor = (r: TransactionDetailResult) =>
  synthesizeOnchainFacts(artifact(r), { step: 2, component: "FLOW_PATH" });

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
    expect(BigInt(WSOL_TO_C) + BigInt(WSOL_TO_D)).toBe(BigInt(LAMPORTS_IN));
    expect(r.lifecycleInstructions.some((x) => x.type === "createIdempotent" && x.account === A_WSOL_TRANSIENT)).toBe(true);
    expect(r.tokenInstructions.some((x) => x.type === "closeAccount" && x.account === A_WSOL_TRANSIENT)).toBe(true);
  });

  it("the transient account appears in NO balance metadata", () => {
    // Which is why ownership has to come from the attestation, or not at all.
    for (const b of [...r.preTokenBalances, ...r.postTokenBalances]) {
      expect(b.account).not.toBe(A_WSOL_TRANSIENT);
    }
  });

  it("there is no burn here", () => {
    expect(r.burns).toHaveLength(0);
  });
});

describe("2. the real transaction now produces the reciprocal flow", () => {
  const flows = deriveReciprocalAssetFlows(storedResult(), ANCHOR);

  it("exactly one flow, between the payer and the counterparty", () => {
    expect(flows).toHaveLength(1);
    expect(flows[0].participant).toBe(A);
    expect(flows[0].counterparty).toBe(C);
    expect(flows[0].signature).toBe(SIGNATURE);
    expect(flows[0].slot).toBe(SLOT);
  });

  it("the A -> wrapper -> C routing is preserved exactly", () => {
    const via = flows[0].outbound.via!;
    // The native leg states where the lamports actually went: the wrapper.
    expect(flows[0].outbound.from).toBe(A);
    expect(flows[0].outbound.to).toBe(A_WSOL_TRANSIENT);
    expect(flows[0].outbound.amountRaw).toBe(LAMPORTS_IN);
    expect(flows[0].outbound.toOwner).toBe(A);
    // And the hop that reached the counterparty is stated separately.
    expect(via.account).toBe(A_WSOL_TRANSIENT);
    expect(via.accountOwner).toBe(A);
    expect(via.onward.to).toBe(C_WSOL);
    expect(via.onward.toOwner).toBe(C);
    expect(via.onward.mint).toBe(WSOL);
    // NO AMOUNT CROSSES THE HOP. What arrived and what went on are different
    // numbers, and each is reported as itself.
    expect(via.onward.amountRaw).toBe(WSOL_TO_C);
    expect(via.onward.amountRaw).not.toBe(flows[0].outbound.amountRaw);
  });

  it("the wrapper's owner comes from the attestation, and the leg says so", () => {
    const via = flows[0].outbound.via!;
    expect(via.ownerSource).toBe("LIFECYCLE_ATTESTATION");
    // BOTH agreeing instructions are named, not just the first.
    expect(via.attestedBy).toEqual(["createIdempotent", "initializeAccount3"]);
    expect(via.syncedNative).toBe(true);
    expect(via.closedInTransaction).toBe(true);
  });

  it("the inbound leg is the project's token, into the payer's account", () => {
    expect(flows[0].inbound.mint).toBe(ANCHOR);
    expect(flows[0].inbound.amountRaw).toBe(PUMP_RAW);
    expect(flows[0].inbound.from).toBe(C_PUMP);
    expect(flows[0].inbound.fromOwner).toBe(C);
    expect(flows[0].inbound.to).toBe(A_PUMP);
    expect(flows[0].inbound.toOwner).toBe(A);
  });

  it("the third-party output neither breaks the flow nor pairs with it", () => {
    // The wrapper also paid D. D sends no project token back, so D never
    // becomes a counterparty — and its presence does not make the A/C pair
    // ambiguous either.
    expect(flows.map((f) => f.counterparty)).toEqual([C]);
    expect(flows[0].outbound.via!.onward.toOwner).not.toBe(D);
  });
});

describe("3. the facts it now synthesizes", () => {
  const facts = factsFor(storedResult());

  it("three facts, every one DIRECT and CONTEXT", () => {
    expect(facts).toHaveLength(3);
    for (const f of facts) {
      expect(f.relationship).toBe("CONTEXT");
      expect(f.directness).toBe("DIRECT");
      expect(f.mechanismState).toBeNull();
    }
  });

  it("the native-leg statement describes the routing without misstating it", () => {
    const s = facts[0].statement;
    expect(s).toContain(LAMPORTS_IN);
    expect(s).toContain(A_WSOL_TRANSIENT);
    expect(s).toContain("the sending address itself");
    expect(s).toContain("createIdempotent and initializeAccount3 instructions in the same transaction");
    expect(s).toContain(WSOL_TO_C);
    expect(s).toContain(C_WSOL);
    expect(s).toContain("was closed in the same transaction");
    // It must never claim the wrapper belongs to the counterparty.
    expect(s).not.toContain(`${A_WSOL_TRANSIENT}, which the transaction's balance metadata reports as owned by ${C}`);
  });

  it("the pairing fact stays co-occurrence, and names the intermediate", () => {
    const s = facts[2].statement;
    expect(s).toContain("The same successful transaction");
    expect(s).toContain("into an account it owns itself");
    expect(s.toLowerCase()).not.toContain("in exchange for");
  });

  it("no economic verdict appears in any statement", () => {
    const text = facts.map((f) => f.statement).join(" ").toLowerCase();
    for (const forbidden of [
      "buyback", "buy back", "purchase", "bought", "swap", "sold", "sale",
      "market", "revenue", "burn", "in exchange for",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("the limits name the two-amount problem explicitly", () => {
    expect(facts[0].doesNotProve).toContain(
      "nothing here establishes that what arrived is what went on",
    );
  });
});

describe("4. fail-closed: conflicting ownership evidence", () => {
  it("lifecycle attestation disagreeing with balance metadata yields no flow", () => {
    // The wrapper now DOES appear in balance metadata, naming a different
    // owner than the instruction that initialized it. Preferring either
    // reading would be choosing what to believe about the very thing being
    // established, so the account resolves to nothing and the flow is gone.
    const r = storedResult();
    const conflicting = storedResult({
      preTokenBalances: [
        ...r.preTokenBalances,
        { accountIndex: 20, account: A_WSOL_TRANSIENT, mint: WSOL, owner: C, amountRaw: "0", decimals: 9 },
      ],
      postTokenBalances: [
        ...r.postTokenBalances,
        { accountIndex: 20, account: A_WSOL_TRANSIENT, mint: WSOL, owner: C, amountRaw: "0", decimals: 9 },
      ],
    });
    expect(deriveReciprocalAssetFlows(conflicting, ANCHOR)).toHaveLength(0);
    expect(factsFor(conflicting)).toHaveLength(0);
  });

  it("two lifecycle instructions naming different owners yield no flow", () => {
    const r = storedResult();
    const ambiguous = storedResult({
      lifecycleInstructions: r.lifecycleInstructions.map((ix) =>
        ix.type === "createIdempotent" ? { ...ix, owner: C } : ix,
      ),
    });
    expect(deriveReciprocalAssetFlows(ambiguous, ANCHOR)).toHaveLength(0);
  });

  it("no ownership evidence at all yields no flow", () => {
    // Strip the attestations: the wrapper is unknown again, exactly as before
    // this capability existed. The old behaviour is still the fallback.
    const r = storedResult();
    const unattested = storedResult({
      lifecycleInstructions: r.lifecycleInstructions.map((ix) => ({ ...ix, owner: null })),
    });
    expect(deriveReciprocalAssetFlows(unattested, ANCHOR)).toHaveLength(0);
  });

  it("agreeing balance metadata is used, and reported as the source", () => {
    // Same owner from both. Balance metadata is in front, so that is what the
    // leg records — attestation only ever fills a gap.
    const r = storedResult();
    const agreeing = storedResult({
      preTokenBalances: [
        ...r.preTokenBalances,
        { accountIndex: 20, account: A_WSOL_TRANSIENT, mint: WSOL, owner: A, amountRaw: "0", decimals: 9 },
      ],
      postTokenBalances: [
        ...r.postTokenBalances,
        { accountIndex: 20, account: A_WSOL_TRANSIENT, mint: WSOL, owner: A, amountRaw: LAMPORTS_IN, decimals: 9 },
      ],
    });
    const flows = deriveReciprocalAssetFlows(agreeing, ANCHOR);
    expect(flows).toHaveLength(1);
    expect(flows[0].outbound.via!.ownerSource).toBe("BALANCE_METADATA");
    expect(flows[0].outbound.via!.attestedBy).toEqual([]);
  });
});

describe("5. fail-closed: transient accounts that reach nobody relevant", () => {
  it("a wrapper that pays only a third party yields no flow", () => {
    // Remove the hop to C. D is still paid, and D sends no project token
    // back — so there is no pair to make.
    const r = storedResult();
    const onlyD = storedResult({
      tokenInstructions: r.tokenInstructions.filter((ix) => ix.destination !== C_WSOL),
    });
    expect(deriveReciprocalAssetFlows(onlyD, ANCHOR)).toHaveLength(0);
  });

  it("a wrapper that pays nobody yields no flow", () => {
    const r = storedResult();
    const noHops = storedResult({
      tokenInstructions: r.tokenInstructions.filter(
        (ix) => ix.account !== A_WSOL_TRANSIENT || ix.type === "closeAccount",
      ),
    });
    expect(deriveReciprocalAssetFlows(noHops, ANCHOR)).toHaveLength(0);
  });

  it("two hops to the SAME owner are ambiguous and yield no flow", () => {
    // Reducing them to one would mean choosing between them.
    const r = storedResult();
    const doubled = storedResult({
      tokenInstructions: [
        ...r.tokenInstructions,
        { mint: WSOL, type: "transferChecked", inner: true, account: A_WSOL_TRANSIENT, decimals: 9, amountRaw: "1", authority: A, programId: TOKEN, destination: C_WSOL },
      ],
    });
    expect(deriveReciprocalAssetFlows(doubled, ANCHOR)).toHaveLength(0);
  });

  it("a foreign-mint inbound leg yields no flow", () => {
    const r = storedResult();
    const foreign = storedResult({
      tokenInstructions: r.tokenInstructions.map((ix) =>
        ix.mint === ANCHOR ? { ...ix, mint: "MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" } : ix,
      ),
    });
    expect(deriveReciprocalAssetFlows(foreign, ANCHOR)).toHaveLength(0);
  });

  it("a failed transaction yields no flow", () => {
    expect(deriveReciprocalAssetFlows(storedResult({ succeeded: false }), ANCHOR)).toHaveLength(0);
  });

  it("the payer paying only itself is not an onward hop", () => {
    const r = storedResult();
    const selfOnly = storedResult({
      tokenInstructions: r.tokenInstructions.map((ix) =>
        ix.destination === C_WSOL ? { ...ix, destination: A_PUMP } : ix,
      ),
    });
    expect(deriveReciprocalAssetFlows(selfOnly, ANCHOR)).toHaveLength(0);
  });
});

describe("6. the words this transaction still does not license", () => {
  it("the programs stay opaque ids — decoding one is a separate step", () => {
    const r = storedResult();
    expect(r.programs).toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(r.programs).toContain("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  });

  it("nothing establishes where the lamports came from", () => {
    const sys = storedResult().lifecycleInstructions.find(
      (x) => x.programId === SYSTEM && x.type === "transfer",
    )!;
    expect(sys.source).toBe(A);
    expect(storedResult().lifecycleInstructions.filter((x) => x.destination === A)).toHaveLength(0);
  });
});
