import { describe, expect, it } from "vitest";

import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type {
  OnchainIntent,
  SignaturesForAddressResult,
} from "../src/server/engine/providers/onchain-types";

// SIGNATURE MEMO — an additive typed field.
//
// getSignaturesForAddress returns a `memo` per entry. The projection did
// not declare it, and zod strips undeclared keys, so it was silently
// discarded: the only way to tell a labelled operational transaction from
// an unlabelled one was to fetch every transaction in full — precisely the
// expensive read this field exists to avoid needing.
//
// A memo is a HINT, never a fact. It is arbitrary text written by whoever
// signed the transaction; anyone can write "daily burn" into one. These
// tests pin that it is carried, bounded, and never allowed to become
// anything more than a string.

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACCOUNT = "AcctCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const SIGNATURE =
  "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Fixtures mirror a REAL node: a JSON-RPC 2.0 envelope, not a bare result.
function fixtureTransport(payload: unknown): OnchainRpcTransport {
  return { async call() { return JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }); } };
}

function adapterWith(payload: unknown) {
  return createSolanaOnchainAdapter({
    transport: fixtureTransport(payload),
    providerId: "fixture-rpc",
    finality: "finalized" as const,
  });
}

function intent(): OnchainIntent {
  return {
    kind: "SIGNATURES_FOR_ADDRESS",
    chain: "solana",
    network: "mainnet",
    projectAnchor: MINT,
    subjectKind: "account",
    subject: ACCOUNT,
    limit: 10,
  };
}

async function signaturesFrom(entries: unknown[]): Promise<SignaturesForAddressResult> {
  const artifact = await adapterWith(entries).retrieve(intent());
  return artifact.result as SignaturesForAddressResult;
}

function entry(over: Record<string, unknown> = {}) {
  return { signature: SIGNATURE, slot: 500, blockTime: 1_787_606_179, err: null, ...over };
}

describe("signature memo — carried through the projection", () => {
  it("a memo present in the response reaches the typed result", async () => {
    const r = await signaturesFrom([entry({ memo: "[16] daily buyback" })]);
    expect(r.signatures[0].memo).toBe("[16] daily buyback");
  });

  it("an absent memo field is null, not undefined", async () => {
    const r = await signaturesFrom([entry()]);
    expect(r.signatures[0].memo).toBeNull();
    expect("memo" in r.signatures[0]).toBe(true);
  });

  it("an explicit null memo is null", async () => {
    const r = await signaturesFrom([entry({ memo: null })]);
    expect(r.signatures[0].memo).toBeNull();
  });

  it("an empty or whitespace-only memo is null rather than an empty string", async () => {
    for (const blank of ["", "   ", "\n\t "]) {
      const r = await signaturesFrom([entry({ memo: blank })]);
      expect(r.signatures[0].memo, JSON.stringify(blank)).toBeNull();
    }
  });

  it("memo is trimmed", async () => {
    const r = await signaturesFrom([entry({ memo: "  padded  " })]);
    expect(r.signatures[0].memo).toBe("padded");
  });

  it("every other field is unchanged by the addition", async () => {
    const r = await signaturesFrom([entry({ memo: "x" })]);
    expect(r.signatures[0]).toMatchObject({
      signature: SIGNATURE,
      slot: 500,
      blockTime: 1_787_606_179,
      err: false,
    });
  });

  it("err still reflects failure independently of memo", async () => {
    const r = await signaturesFrom([entry({ memo: "note", err: { InstructionError: [0, "x"] } })]);
    expect(r.signatures[0].err).toBe(true);
    expect(r.signatures[0].memo).toBe("note");
  });
});

describe("signature memo — bounded and untrusted", () => {
  it("an oversized memo is truncated, visibly", async () => {
    const huge = "M".repeat(5_000);
    const r = await signaturesFrom([entry({ memo: huge })]);
    const memo = r.signatures[0].memo!;
    // Bounded...
    expect(memo.length).toBeLessThan(huge.length);
    expect(memo.length).toBeLessThanOrEqual(256 + "…[truncated]".length);
    // ...and the cut is visible, so a reader can never mistake a truncated
    // memo for the whole one.
    expect(memo.endsWith("…[truncated]")).toBe(true);
  });

  it("a memo of exactly the limit is NOT marked truncated", async () => {
    const exact = "M".repeat(256);
    const r = await signaturesFrom([entry({ memo: exact })]);
    expect(r.signatures[0].memo).toBe(exact);
  });

  it("a non-string memo yields null rather than failing the whole page", async () => {
    // A node returning an unexpected type must not cost us every other
    // signature in the response.
    for (const wrong of [42, true, { text: "x" }, ["a"]]) {
      const r = await signaturesFrom([entry({ memo: wrong })]);
      expect(r.signatures.length).toBe(1);
      expect(r.signatures[0].memo).toBeNull();
    }
  });

  it("memo content is carried verbatim and confers nothing", async () => {
    // A memo claiming to be a burn is still just a string. Nothing in the
    // result type can express approval, and no field changes because of
    // what the text says.
    const claim = "SPL Burn 160100000 PUMP official daily burn";
    const r = await signaturesFrom([entry({ memo: claim })]);
    expect(r.signatures[0].memo).toBe(claim);
    expect(r.signatures[0].err).toBe(false);
    expect(Object.keys(r.signatures[0]).sort()).toEqual(
      ["blockTime", "err", "memo", "signature", "slot"].sort(),
    );
  });

  it("memos are per-entry, never merged or carried between signatures", async () => {
    const r = await signaturesFrom([
      entry({ signature: `${SIGNATURE.slice(0, 87)}1`, memo: "first" }),
      entry({ signature: `${SIGNATURE.slice(0, 87)}2` }),
      entry({ signature: `${SIGNATURE.slice(0, 87)}3`, memo: "third" }),
    ]);
    expect(r.signatures.map((s) => s.memo)).toEqual(["first", null, "third"]);
  });
});
