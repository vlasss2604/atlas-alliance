import { describe, expect, it } from "vitest";

import {
  attributeCaller,
  deriveTransferProvenance,
  inflowsTo,
  INVOCATION_PROVENANCE_DOES_NOT_PROVE,
} from "../src/server/engine/onchain-invocation-provenance";
import {
  KNOWN_INSTRUCTION_METHODS,
  decodeBase58Bytes,
  decodeKnownMethod,
  discriminator,
  isProgramKnown,
} from "../src/server/engine/onchain-instruction-registry";
import { parseProjectIdentity } from "../src/server/domain/project-identity";
import type { TransactionDetailResult } from "../src/server/engine/providers/onchain-types";

// D-158 PHASE 1 — MACHINE-OWNED INVOCATION PROVENANCE.
//
// The capability under test answers one question: which program invoked
// the instruction that moved this value. It is deliberately NOT wired into
// any component status, and the last describe block asserts exactly that.
//
// Every input here is a field the RPC adapter writes. Nothing a model can
// author appears anywhere in this suite, because nothing a model can
// author reaches the derivation.

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const AGGREGATOR = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const UNRELATED = "BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi";
const MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const DEST = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
const SRC = "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c";

function base58(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leading = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading += "1";
  }
  return leading + digits.reverse().map((d) => ALPHABET[d]).join("");
}

function tx(over: Partial<TransactionDetailResult> = {}): TransactionDetailResult {
  return {
    kind: "TRANSACTION_DETAIL",
    signature: "sig1",
    slot: 100,
    blockTime: null,
    succeeded: true,
    burns: [],
    programs: [],
    accountKeys: [],
    tokenInstructions: [],
    lifecycleInstructions: [],
    rawInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    ...over,
  };
}

function tokenTransfer(over: Record<string, unknown> = {}) {
  return {
    programId: TOKEN_PROGRAM,
    type: "transfer",
    mint: MINT,
    account: SRC,
    destination: DEST,
    authority: null,
    amountRaw: "1000",
    decimals: 6,
    inner: false,
    instructionIndex: 0,
    parentIndex: null,
    stackHeight: 1,
    ...over,
  };
}

function rawIx(over: Record<string, unknown> = {}) {
  return {
    programId: RAYDIUM_CLMM,
    accounts: [],
    data: base58(Buffer.concat([discriminator("global:swap_v2"), Buffer.alloc(33)])),
    inner: false,
    instructionIndex: 0,
    parentIndex: null,
    stackHeight: 1,
    ...over,
  };
}

describe("D-158 §1 — caller attribution follows CPI structure, never co-occurrence", () => {
  it("TEST 1: a top-level transfer is attributed to no caller, and names its own executing program", () => {
    const t = tx({ tokenInstructions: [tokenTransfer()] as never });
    const out = attributeCaller(t, t.tokenInstructions[0]);
    expect(out.attributed).toBe(true);
    if (!out.attributed) return;
    // The signer wrote it. No program invoked it, and saying otherwise
    // would invent a caller.
    expect(out.attribution.callerProgramId).toBeNull();
    expect(out.attribution.executingProgramId).toBe(TOKEN_PROGRAM);
    expect(out.attribution.topLevel).toBe(true);
    expect(out.attribution.stackHeight).toBe(1);
  });

  it("TEST 2: a single-level CPI transfer is attributed to the outer program that invoked it", () => {
    const t = tx({
      rawInstructions: [rawIx({ instructionIndex: 0 })] as never,
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: 2 }),
      ] as never,
    });
    const out = attributeCaller(t, t.tokenInstructions[0]);
    expect(out.attributed).toBe(true);
    if (!out.attributed) return;
    expect(out.attribution.callerProgramId).toBe(RAYDIUM_CLMM);
    expect(out.attribution.executingProgramId).toBe(TOKEN_PROGRAM);
    expect(out.attribution.invocationIndex).toBe(0);
    expect(out.attribution.topLevel).toBe(false);
  });

  it("TEST 3: nested CPI attributes to the enclosing invocation, not the outer instruction", () => {
    // outer 0 = aggregator; inner depth-2 = venue; inner depth-3 = the
    // token transfer. The transfer was invoked by the VENUE, and naming
    // the aggregator would be wrong by one level.
    const t = tx({
      rawInstructions: [
        rawIx({ programId: AGGREGATOR, instructionIndex: 0, inner: false, stackHeight: 1 }),
        rawIx({ programId: RAYDIUM_CLMM, inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: 2 }),
      ] as never,
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 1, parentIndex: 0, stackHeight: 3 }),
      ] as never,
    });
    const out = attributeCaller(t, t.tokenInstructions[0]);
    expect(out.attributed).toBe(true);
    if (!out.attributed) return;
    expect(out.attribution.callerProgramId).toBe(RAYDIUM_CLMM);
    expect(out.attribution.callerProgramId).not.toBe(AGGREGATOR);
    expect(out.attribution.stackHeight).toBe(3);
  });

  it("TEST 4: a program merely present in the transaction is never credited with an unrelated transfer", () => {
    // UNRELATED sits at outer index 1. The transfer belongs to outer 0.
    const t = tx({
      programs: [UNRELATED, RAYDIUM_CLMM],
      rawInstructions: [
        rawIx({ programId: RAYDIUM_CLMM, instructionIndex: 0 }),
        rawIx({ programId: UNRELATED, instructionIndex: 1 }),
      ] as never,
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: 2 }),
      ] as never,
    });
    const out = attributeCaller(t, t.tokenInstructions[0]);
    expect(out.attributed).toBe(true);
    if (!out.attributed) return;
    expect(out.attribution.callerProgramId).toBe(RAYDIUM_CLMM);
    expect(out.attribution.callerProgramId).not.toBe(UNRELATED);
  });

  it("TEST 5: a historical artifact without stackHeight yields UNKNOWN, never a guessed caller", () => {
    // Exactly the shape of an artifact stored before stackHeight existed:
    // inner, with a parent, and no depth. Depth 2 is PLAUSIBLE and is
    // still refused, because plausible is not proven.
    const t = tx({
      rawInstructions: [rawIx({ instructionIndex: 0 })] as never,
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: undefined }),
      ] as never,
    });
    const out = attributeCaller(t, t.tokenInstructions[0]);
    expect(out.attributed).toBe(false);
    if (out.attributed) return;
    expect(out.refusal).toBe("NO_STACK_HEIGHT");
  });

  it("refuses rather than reconciles a depth the structure cannot support", () => {
    const t = tx({
      tokenInstructions: [tokenTransfer({ inner: false, stackHeight: 4 })] as never,
    });
    const out = attributeCaller(t, t.tokenInstructions[0]);
    expect(out.attributed).toBe(false);
    if (out.attributed) return;
    expect(out.refusal).toBe("INCONSISTENT_DEPTH");
  });

  it("refuses a nested transfer whose enclosing invocation was not reported", () => {
    const t = tx({
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: 3 }),
      ] as never,
    });
    const out = attributeCaller(t, t.tokenInstructions[0]);
    expect(out.attributed).toBe(false);
    if (out.attributed) return;
    expect(out.refusal).toBe("NO_ENCLOSING_INVOCATION");
  });
});

describe("D-158 §2 — the method registry decodes only what it can prove", () => {
  it("TEST 6: a known program with a known discriminator yields the method", () => {
    const data = base58(Buffer.concat([discriminator("global:swap_v2"), Buffer.alloc(33)]));
    expect(decodeKnownMethod({ chain: "solana", programId: RAYDIUM_CLMM, data })).toBe("swap_v2");
  });

  it("TEST 7: an unknown discriminator under a known program yields no method", () => {
    const data = base58(Buffer.concat([discriminator("global:not_a_real_method"), Buffer.alloc(33)]));
    expect(decodeKnownMethod({ chain: "solana", programId: RAYDIUM_CLMM, data })).toBeNull();
  });

  it("a known discriminator under an UNKNOWN program yields no method", () => {
    const data = base58(Buffer.concat([discriminator("global:swap_v2"), Buffer.alloc(33)]));
    expect(decodeKnownMethod({ chain: "solana", programId: UNRELATED, data })).toBeNull();
    expect(isProgramKnown("solana", UNRELATED)).toBe(false);
  });

  it("malformed or short data decodes to nothing rather than partially", () => {
    expect(decodeKnownMethod({ chain: "solana", programId: RAYDIUM_CLMM, data: "0OIl" })).toBeNull();
    expect(decodeKnownMethod({ chain: "solana", programId: RAYDIUM_CLMM, data: "" })).toBeNull();
    expect(decodeBase58Bytes("0OIl")).toBeNull();
  });

  it("TEST 8: the registry restates the Raydium constant the exchange decoder derives", () => {
    // Behaviour-equivalence with the decoder that already ships: same
    // program, same method, same 8 bytes, derived by the same function.
    const entry = KNOWN_INSTRUCTION_METHODS.find((e) => e.programId === RAYDIUM_CLMM);
    expect(entry).toBeDefined();
    expect(entry!.method).toBe("swap_v2");
    expect(entry!.discriminatorHex).toBe(discriminator("global:swap_v2").toString("hex"));
  });

  it("seeds no program this repository has not independently confirmed", () => {
    // In particular no pump.fun program: none appears anywhere in src/,
    // so none may appear here. Phase 1 is capability, not PUMP research.
    expect(KNOWN_INSTRUCTION_METHODS).toHaveLength(1);
    expect(KNOWN_INSTRUCTION_METHODS[0].programId).toBe(RAYDIUM_CLMM);
  });
});

describe("D-158 §3 — transfer provenance, and what it refuses to say", () => {
  it("carries the attributed caller and the method of that same invocation", () => {
    const t = tx({
      rawInstructions: [rawIx({ instructionIndex: 0 })] as never,
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: 2 }),
      ] as never,
    });
    const [p] = deriveTransferProvenance(t);
    expect(p.attribution?.callerProgramId).toBe(RAYDIUM_CLMM);
    // SAME-INVOCATION: read off the instruction attribution named, not off
    // any instruction sharing the transaction.
    expect(p.callerMethod).toBe("swap_v2");
    expect(p.destination).toBe(DEST);
    expect(p.amountRaw).toBe("1000");
    expect(p.asset).toEqual({ kind: "TOKEN", mint: MINT, decimals: 6 });
  });

  it("a known method elsewhere in the transaction never attaches to an unrelated transfer", () => {
    // swap_v2 runs under outer 1. The transfer belongs to outer 0, whose
    // program has no registry entry.
    const t = tx({
      rawInstructions: [
        rawIx({ programId: UNRELATED, instructionIndex: 0 }),
        rawIx({ programId: RAYDIUM_CLMM, instructionIndex: 1 }),
      ] as never,
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: 2 }),
      ] as never,
    });
    const [p] = deriveTransferProvenance(t);
    expect(p.attribution?.callerProgramId).toBe(UNRELATED);
    expect(p.callerMethod).toBeNull();
  });

  it("an unattributable transfer is listed with a named refusal, not dropped", () => {
    const t = tx({
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: undefined }),
      ] as never,
    });
    const [p] = deriveTransferProvenance(t);
    expect(p.attribution).toBeNull();
    expect(p.refusal).toBe("NO_STACK_HEIGHT");
  });

  it("native SOL transfers are covered, and burns are not treated as movements", () => {
    const t = tx({
      lifecycleInstructions: [
        {
          programId: SYSTEM_PROGRAM,
          type: "transfer",
          inner: false,
          account: null,
          mint: null,
          owner: null,
          assignedProgram: null,
          payer: null,
          source: SRC,
          destination: DEST,
          lamports: "500",
          tokenProgram: null,
          instructionIndex: 0,
          parentIndex: null,
          stackHeight: 1,
        },
      ] as never,
      burns: [
        {
          programId: TOKEN_PROGRAM,
          instructionType: "Burn",
          mint: MINT,
          sourceAccount: SRC,
          authority: null,
          amountRaw: "9",
          decimals: 6,
        },
      ] as never,
    });
    const all = deriveTransferProvenance(t);
    expect(all).toHaveLength(1);
    expect(all[0].asset).toEqual({ kind: "NATIVE_SOL" });
    expect(all[0].amountRaw).toBe("500");
  });

  it("inflowsTo filters without granting anything the derivation refused", () => {
    const t = tx({
      tokenInstructions: [
        tokenTransfer({ inner: true, instructionIndex: 0, parentIndex: 0, stackHeight: undefined }),
      ] as never,
    });
    const [p] = inflowsTo(t, DEST);
    expect(p.attribution).toBeNull();
    expect(inflowsTo(t, "someOtherAccount")).toHaveLength(0);
  });

  it("states in code what an attributed transfer does not prove", () => {
    for (const phrase of ["does NOT establish why", "fee", "net of anything", "representative"]) {
      expect(INVOCATION_PROVENANCE_DOES_NOT_PROVE).toContain(phrase);
    }
  });
});

describe("D-158 §4 — the model cannot forge any of it", () => {
  it("TEST 9: no provenance field exists on the model's extracted-fact contract", () => {
    // The model's output type is the boundary. If none of these names can
    // appear on it, no extraction, prompt or document can populate them.
    const forbidden = [
      "callerProgramId",
      "executingProgramId",
      "invocationIndex",
      "stackHeight",
      "callerMethod",
      "attribution",
    ];
    // Asserted against the source of the model-facing schema rather than a
    // remembered claim about it.
    return import("node:fs/promises").then(async (fs) => {
      const src = await fs.readFile(
        "src/server/engine/providers/evidence-extractor-anthropic.ts",
        "utf-8",
      );
      const schema = src.slice(
        src.indexOf("const extractedFactSchema"),
        src.indexOf("const extractionResultSchema"),
      );
      expect(schema.length).toBeGreaterThan(0);
      for (const name of forbidden) expect(schema).not.toContain(name);
    });
  });

  it("the provenance module reads no model-authored field", () => {
    return import("node:fs/promises").then(async (fs) => {
      const src = await fs.readFile("src/server/engine/onchain-invocation-provenance.ts", "utf-8");
      // statement/summary/relationship/directness are the model's fields.
      for (const name of ["statement", "summary", "relationship", "directness", "doesNotProve"]) {
        expect(src).not.toContain(`.${name}`);
      }
    });
  });
});

describe("D-158 §5 — confirmed identity is the only route to a program mapping", () => {
  it("TEST 10: a parsed identity carries confirmed programs", () => {
    const id = parseProjectIdentity({
      chain: "solana",
      tokenAddress: MINT,
      programs: [{ activity: "PumpSwap", programId: RAYDIUM_CLMM }],
    });
    expect(id).not.toBeNull();
    expect(id!.programs).toEqual([{ activity: "PumpSwap", programId: RAYDIUM_CLMM }]);
  });

  it("an identity with no programs confirmed parses to an empty list, never null", () => {
    const id = parseProjectIdentity({ chain: "solana", tokenAddress: MINT });
    expect(id!.programs).toEqual([]);
  });

  it("TEST 11: a wrong-chain or malformed program id makes the whole record unusable", () => {
    // An EVM address on Solana. Refused whole rather than partially
    // admitted, exactly as a mismatched tokenAddress is.
    expect(
      parseProjectIdentity({
        chain: "solana",
        tokenAddress: MINT,
        programs: [{ activity: "X", programId: "0x1111111111111111111111111111111111111111" }],
      }),
    ).toBeNull();
    expect(
      parseProjectIdentity({
        chain: "solana",
        tokenAddress: MINT,
        programs: [{ activity: "X", programId: "not an address" }],
      }),
    ).toBeNull();
  });

  it("D-158 PHASE 2: a confirmed activity may carry human-confirmed aliases", () => {
    // Aliases exist so a literal activity binding can survive a document
    // that spells the activity differently. They are stored exactly as
    // given and nothing derives them.
    const id = parseProjectIdentity({
      chain: "solana",
      tokenAddress: MINT,
      programs: [{ activity: "PumpSwap", programId: RAYDIUM_CLMM, aliases: ["Pump AMM"] }],
    });
    expect(id).not.toBeNull();
    expect(id!.programs).toEqual([
      { activity: "PumpSwap", programId: RAYDIUM_CLMM, aliases: ["Pump AMM"] },
    ]);
  });

  it("aliases are optional, and their absence is not an empty list", () => {
    const id = parseProjectIdentity({
      chain: "solana",
      tokenAddress: MINT,
      programs: [{ activity: "PumpSwap", programId: RAYDIUM_CLMM }],
    });
    expect(id!.programs![0].aliases).toBeUndefined();
  });

  it("an alias of the wrong shape makes the whole record unusable", () => {
    // Same rule the rest of the contract follows: a record that is partly
    // wrong confers no identity, rather than a quietly trimmed one.
    expect(
      parseProjectIdentity({
        chain: "solana",
        tokenAddress: MINT,
        programs: [{ activity: "PumpSwap", programId: RAYDIUM_CLMM, aliases: [""] }],
      }),
    ).toBeNull();
    expect(
      parseProjectIdentity({
        chain: "solana",
        tokenAddress: MINT,
        programs: [{ activity: "PumpSwap", programId: RAYDIUM_CLMM, aliases: "Pump AMM" }],
      }),
    ).toBeNull();
  });

  it("an unknown extra field is still rejected by the strict contract", () => {
    expect(
      parseProjectIdentity({ chain: "solana", tokenAddress: MINT, invented: true }),
    ).toBeNull();
  });
});

describe("D-158 §6 — this phase creates observations, not conclusions", () => {
  it("TEST 12: the derivation stays out of the modules that decide meaning", async () => {
    const fs = await import("node:fs/promises");
    // D-158 PHASE 2 SUPERSEDES THE PHASE 1 FORM OF THIS TEST. Phase 1
    // asserted the capability was consumed by nothing at all, which was
    // true while it was inert. Phase 2 deliberately connects it: on-chain
    // synthesis derives it, and the reducer reads the persisted metadata
    // through a structural obligation.
    //
    // What must STILL hold, and is what this test now protects: the
    // modules that assign MEANING never call the derivation themselves.
    // The reducer reads a persisted, machine-owned column; it does not
    // reach back into raw RPC artifacts, which would be a second and
    // hidden proof path beside Evidence.
    for (const file of [
      "src/server/engine/component-reconciler.ts",
      "src/server/domain/pattern.ts",
      "src/server/engine/claim-evaluator.ts",
      "src/server/engine/mechanism-assembler.ts",
    ]) {
      const src = await fs.readFile(file, "utf-8");
      expect(src, file).not.toContain("deriveTransferProvenance");
      expect(src, file).not.toContain("attributeCaller");
      expect(src, file).not.toContain("inflowsTo");
    }
    // The one module that DOES derive it is the deterministic synthesis.
    const facts = await fs.readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).toContain("deriveTransferProvenance");
  });

  it("no synthesized fact kind was added for this capability", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/server/engine/onchain-facts.ts", "utf-8");
    const list = src.slice(
      src.indexOf("export const ONCHAIN_FACT_KINDS"),
      src.indexOf("export type OnchainFactKind"),
    );
    expect(list).not.toContain("INVOCATION");
    expect(list).not.toContain("PROVENANCE");
  });
});
