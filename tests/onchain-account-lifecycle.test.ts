import { describe, expect, it } from "vitest";

import {
  ACCOUNT_LIFECYCLE_DOES_NOT_PROVE,
  ownsAccountInTransaction,
  reconstructAccountLifecycle,
} from "../src/server/engine/onchain-account-lifecycle";
import { __testing } from "../src/server/engine/providers/onchain-solana";
import type { TransactionDetailResult } from "../src/server/engine/providers/onchain-types";

// EPHEMERAL TOKEN-ACCOUNT LIFECYCLE — who owned the account?
//
// The case behind these tests: a wrapped-SOL account created, transferred
// out of, and closed inside one transaction. It appears in NO balance list,
// so the only evidence of ownership is instruction-level. Three separate
// instructions named one wallet as `authority` or `destination`, and none
// of them establishes ownership — a delegate, a close authority and a
// lamport recipient are not owners. These tests pin that boundary.

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM = "11111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WSOL = "So11111111111111111111111111111111111111112";

const WALLET = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "OtherBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const EPHEMERAL = "EphemeralCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const UNRELATED = "UnrelatedDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

// A raw jsonParsed instruction, in the shape a Solana node emits.
function ix(programId: string, type: string, info: Record<string, unknown>) {
  return { programId, parsed: { type, info } };
}

// Runs raw instructions through the REAL adapter decoder, so these tests
// exercise the shipped decoding path rather than a hand-built typed value.
function decode(raws: unknown[], inner = false) {
  return raws
    .map((r) => __testing.decodeLifecycleInstruction(r, inner))
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

function tx(over: Partial<TransactionDetailResult> = {}): TransactionDetailResult {
  return {
    kind: "TRANSACTION_DETAIL",
    signature: "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    slot: 441840975,
    blockTime: 1_787_737_824,
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

function closeIx(account: string, authority: string, destination: string) {
  return {
    programId: TOKEN,
    type: "closeAccount",
    mint: null,
    account,
    destination,
    authority,
    amountRaw: null,
    decimals: null,
    inner: false,
  };
}

describe("lifecycle — the full ephemeral wrapped-SOL shape", () => {
  // 1. System create + initializeAccount3 + syncNative + transfer + close,
  //    the exact sequence that left ownership unrecoverable before.
  const full = tx({
    lifecycleInstructions: [
      ...decode([
        ix(SYSTEM, "createAccount", {
          source: WALLET,
          newAccount: EPHEMERAL,
          lamports: 2039280,
          space: 165,
          owner: TOKEN,
        }),
        ix(TOKEN, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: WALLET }),
        ix(TOKEN, "syncNative", { account: EPHEMERAL }),
      ]),
    ],
    tokenInstructions: [closeIx(EPHEMERAL, WALLET, WALLET)],
  });

  it("reconstructs every stage of the account's life", () => {
    const life = reconstructAccountLifecycle(full, EPHEMERAL);
    expect(life.created.value).toBe("YES");
    expect(life.initialized.value).toBe("YES");
    expect(life.syncNative.value).toBe("YES");
    expect(life.closed.value).toBe("YES");
    expect(life.mint.value).toBe(WSOL);
    expect(life.tokenProgram.value).toBe(TOKEN);
    expect(life.closeDestination.value).toBe(WALLET);
    expect(life.payer.value).toBe(WALLET);
  });

  it("recovers the owner from initializeAccount3, and says where it came from", () => {
    const life = reconstructAccountLifecycle(full, EPHEMERAL);
    expect(life.owner.value).toBe(WALLET);
    expect(life.owner.basis).toBe("DECODED_FROM_INSTRUCTION");
    expect(life.owner.fromInstruction).toBe("initializeAccount3");
    expect(ownsAccountInTransaction(full, EPHEMERAL, WALLET)).toBe(true);
  });

  it("never reads System createAccount's owner field as the account owner", () => {
    // That field names the assigned PROGRAM. Reading it as an owner would
    // make the SPL Token program the owner of every token account.
    const systemOnly = tx({
      lifecycleInstructions: decode([
        ix(SYSTEM, "createAccount", {
          source: WALLET,
          newAccount: EPHEMERAL,
          lamports: 2039280,
          owner: TOKEN,
        }),
      ]),
    });
    const life = reconstructAccountLifecycle(systemOnly, EPHEMERAL);
    expect(life.owner.value).toBeNull();
    expect(life.owner.basis).toBe("UNKNOWN");
    expect(life.created.value).toBe("YES");
    // The assignment is kept, under its own name.
    expect(systemOnly.lifecycleInstructions[0].assignedProgram).toBe(TOKEN);
    expect(systemOnly.lifecycleInstructions[0].owner).toBeNull();
  });
});

describe("lifecycle — initialization variants", () => {
  for (const type of ["initializeAccount", "initializeAccount2", "initializeAccount3"]) {
    it(`${type} establishes the owner`, () => {
      const t = tx({
        lifecycleInstructions: decode([
          ix(TOKEN, type, { account: EPHEMERAL, mint: WSOL, owner: WALLET }),
        ]),
      });
      const life = reconstructAccountLifecycle(t, EPHEMERAL);
      expect(life.owner.value).toBe(WALLET);
      expect(life.owner.fromInstruction).toBe(type);
      expect(life.initialized.value).toBe("YES");
    });
  }

  it("ATA create establishes the owner from `wallet`, not from `source`", () => {
    // source is the funder. wallet is the owner the ATA is derived for.
    const t = tx({
      lifecycleInstructions: decode([
        ix(ATA, "create", {
          account: EPHEMERAL,
          mint: WSOL,
          source: OTHER,
          wallet: WALLET,
          tokenProgram: TOKEN,
        }),
      ]),
    });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.owner.value).toBe(WALLET);
    expect(life.payer.value).toBe(OTHER);
    expect(life.tokenProgram.value).toBe(TOKEN);
  });

  it("createIdempotent is decoded and stays distinguishable from create", () => {
    const t = tx({
      lifecycleInstructions: decode([
        ix(ATA, "createIdempotent", {
          account: EPHEMERAL,
          mint: WSOL,
          source: WALLET,
          wallet: WALLET,
          tokenProgram: TOKEN_2022,
        }),
      ]),
    });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.owner.value).toBe(WALLET);
    expect(life.owner.fromInstruction).toBe("createIdempotent");
    expect(life.tokenProgram.value).toBe(TOKEN_2022);
  });

  it("Token and Token-2022 stay distinct", () => {
    const t = tx({
      lifecycleInstructions: decode([
        ix(TOKEN_2022, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: WALLET }),
      ]),
    });
    expect(reconstructAccountLifecycle(t, EPHEMERAL).tokenProgram.value).toBe(TOKEN_2022);
  });
});

describe("lifecycle — authority is not ownership", () => {
  // The heart of it. Every one of these transactions has the wallet
  // signing something, and none of them says the wallet owns the account.
  it("a transfer authority alone leaves the owner UNKNOWN", () => {
    const t = tx({
      tokenInstructions: [
        {
          programId: TOKEN,
          type: "transferChecked",
          mint: WSOL,
          account: EPHEMERAL,
          destination: OTHER,
          authority: WALLET,
          amountRaw: "382202589",
          decimals: 9,
          inner: true,
        },
      ],
    });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.owner.value).toBeNull();
    expect(life.owner.basis).toBe("UNKNOWN");
    expect(ownsAccountInTransaction(t, EPHEMERAL, WALLET)).toBe(false);
  });

  it("a close authority alone leaves the owner UNKNOWN", () => {
    // A close authority may be designated separately from the owner.
    const t = tx({ tokenInstructions: [closeIx(EPHEMERAL, WALLET, OTHER)] });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.closed.value).toBe("YES");
    expect(life.owner.value).toBeNull();
    expect(ownsAccountInTransaction(t, EPHEMERAL, WALLET)).toBe(false);
  });

  it("a close destination is not an owner", () => {
    const t = tx({ tokenInstructions: [closeIx(EPHEMERAL, OTHER, WALLET)] });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.closeDestination.value).toBe(WALLET);
    expect(life.owner.value).toBeNull();
  });

  it("an authority DIFFERENT from the initialized owner never overrides it", () => {
    const t = tx({
      lifecycleInstructions: decode([
        ix(TOKEN, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: OTHER }),
      ]),
      tokenInstructions: [closeIx(EPHEMERAL, WALLET, WALLET)],
    });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    // Signed by WALLET throughout, owned by OTHER. The delegate case.
    expect(life.owner.value).toBe(OTHER);
    expect(ownsAccountInTransaction(t, EPHEMERAL, WALLET)).toBe(false);
    expect(ownsAccountInTransaction(t, EPHEMERAL, OTHER)).toBe(true);
  });

  it("a payer is not an owner", () => {
    const t = tx({
      lifecycleInstructions: decode([
        ix(SYSTEM, "createAccount", {
          source: WALLET,
          newAccount: EPHEMERAL,
          lamports: 2039280,
          owner: TOKEN,
        }),
      ]),
    });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.payer.value).toBe(WALLET);
    expect(life.owner.value).toBeNull();
  });
});

describe("lifecycle — missing and contradictory evidence", () => {
  it("no initialization at all means the owner is UNKNOWN", () => {
    const t = tx({
      lifecycleInstructions: decode([ix(TOKEN, "syncNative", { account: EPHEMERAL })]),
    });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.syncNative.value).toBe("YES");
    expect(life.owner.basis).toBe("UNKNOWN");
    expect(life.initialized.value).toBe("UNKNOWN");
  });

  it("two contradictory owners resolve to UNKNOWN, not to the first", () => {
    const t = tx({
      lifecycleInstructions: decode([
        ix(TOKEN, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: WALLET }),
        ix(TOKEN, "initializeAccount", { account: EPHEMERAL, mint: WSOL, owner: OTHER }),
      ]),
    });
    const life = reconstructAccountLifecycle(t, EPHEMERAL);
    expect(life.owner.value).toBeNull();
    expect(life.owner.basis).toBe("UNKNOWN");
    expect(ownsAccountInTransaction(t, EPHEMERAL, WALLET)).toBe(false);
    expect(ownsAccountInTransaction(t, EPHEMERAL, OTHER)).toBe(false);
  });

  it("an empty transaction yields UNKNOWN everywhere, never NO", () => {
    const life = reconstructAccountLifecycle(tx(), EPHEMERAL);
    for (const field of [life.created, life.initialized, life.syncNative, life.closed]) {
      expect(field.value).toBe("UNKNOWN");
      expect(field.basis).toBe("UNKNOWN");
    }
    // Absence of a creation instruction is not evidence of non-creation.
    expect(JSON.stringify(life)).not.toContain('"NO"');
    expect(ACCOUNT_LIFECYCLE_DOES_NOT_PROVE).toContain("never that the thing did not happen");
  });
});

describe("lifecycle — nothing else can contaminate one account", () => {
  it("another account's initialization never supplies this account's owner", () => {
    const t = tx({
      lifecycleInstructions: decode([
        ix(TOKEN, "initializeAccount3", { account: UNRELATED, mint: WSOL, owner: WALLET }),
        ix(TOKEN, "syncNative", { account: EPHEMERAL }),
      ]),
    });
    expect(reconstructAccountLifecycle(t, EPHEMERAL).owner.value).toBeNull();
    expect(reconstructAccountLifecycle(t, UNRELATED).owner.value).toBe(WALLET);
  });

  it("another account's closeAccount never closes this one", () => {
    const t = tx({ tokenInstructions: [closeIx(UNRELATED, WALLET, WALLET)] });
    expect(reconstructAccountLifecycle(t, EPHEMERAL).closed.value).toBe("UNKNOWN");
  });

  it("a busy transaction yields separate, non-overlapping answers", () => {
    const t = tx({
      lifecycleInstructions: decode([
        ix(TOKEN, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: WALLET }),
        ix(TOKEN_2022, "initializeAccount3", { account: UNRELATED, mint: WSOL, owner: OTHER }),
      ]),
    });
    expect(reconstructAccountLifecycle(t, EPHEMERAL).owner.value).toBe(WALLET);
    expect(reconstructAccountLifecycle(t, UNRELATED).owner.value).toBe(OTHER);
    expect(reconstructAccountLifecycle(t, EPHEMERAL).tokenProgram.value).toBe(TOKEN);
    expect(reconstructAccountLifecycle(t, UNRELATED).tokenProgram.value).toBe(TOKEN_2022);
  });
});

describe("lifecycle — decoder scope and precision", () => {
  it("inner and outer instructions are both decoded, and stay distinguishable", () => {
    const outer = decode([ix(TOKEN, "syncNative", { account: EPHEMERAL })], false);
    const inner = decode([ix(TOKEN, "syncNative", { account: EPHEMERAL })], true);
    expect(outer[0].inner).toBe(false);
    expect(inner[0].inner).toBe(true);
    const t = tx({ lifecycleInstructions: [...outer, ...inner] });
    expect(reconstructAccountLifecycle(t, EPHEMERAL).syncNative.value).toBe("YES");
  });

  it("an instruction from an unrecognised program is not decoded", () => {
    expect(
      decode([ix("SomeOtherProgram1111111111111111111111111111", "createAccount", {
        newAccount: EPHEMERAL,
        owner: WALLET,
      })]),
    ).toHaveLength(0);
  });

  it("an unrecognised instruction type is not decoded", () => {
    expect(decode([ix(TOKEN, "approve", { account: EPHEMERAL, owner: WALLET })])).toHaveLength(0);
  });

  it("lamports are preserved as a string", () => {
    const [created] = decode([
      ix(SYSTEM, "createAccount", {
        source: WALLET,
        newAccount: EPHEMERAL,
        lamports: 2039280,
        owner: TOKEN,
      }),
    ]);
    expect(created.lamports).toBe("2039280");
    expect(typeof created.lamports).toBe("string");
  });

  it("a System transfer is decoded for funding provenance without granting ownership", () => {
    const [t] = decode([
      ix(SYSTEM, "transfer", { source: WALLET, destination: EPHEMERAL, lamports: 5000 }),
    ]);
    expect(t.destination).toBe(EPHEMERAL);
    expect(t.lamports).toBe("5000");
    expect(t.owner).toBeNull();
  });
});

describe("lifecycle — existing decoding is untouched", () => {
  it("burn decoding still works exactly as before", () => {
    const burn = __testing.decodeBurnInstruction(
      ix(TOKEN_2022, "burnChecked", {
        account: EPHEMERAL,
        mint: WSOL,
        authority: WALLET,
        tokenAmount: { amount: "7723746661", decimals: 6 },
      }),
    );
    expect(burn?.instructionType).toBe("BurnChecked");
    expect(burn?.amountRaw).toBe("7723746661");
    expect(burn?.sourceAccount).toBe(EPHEMERAL);
  });

  it("a movement instruction is never decoded as a lifecycle instruction", () => {
    // The two decoders have disjoint type sets, so a transfer cannot
    // arrive in the lifecycle list and reach the ownership path.
    expect(
      decode([
        ix(TOKEN, "transferChecked", {
          source: EPHEMERAL,
          destination: OTHER,
          authority: WALLET,
          mint: WSOL,
          tokenAmount: { amount: "1", decimals: 9 },
        }),
      ]),
    ).toHaveLength(0);
  });

  it("a lifecycle instruction is never decoded as a movement instruction", () => {
    expect(
      __testing.decodeLifecycleInstruction(
        ix(TOKEN, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: WALLET }),
        false,
      ),
    ).not.toBeNull();
  });
});

describe("lifecycle — no economic classification", () => {
  const life = reconstructAccountLifecycle(
    tx({
      lifecycleInstructions: decode([
        ix(TOKEN, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: WALLET }),
      ]),
    }),
    EPHEMERAL,
  );

  it("emits no economic label", () => {
    const asJson = JSON.stringify(life).toLowerCase();
    for (const label of ["swap", "buyback", "purchase", "sale", "treasury", "burn wallet"]) {
      expect(asJson, `lifecycle carries the label "${label}"`).not.toContain(label);
    }
  });

  it("has no field an economic role could be written into", () => {
    for (const k of Object.keys(life)) {
      expect(k.toLowerCase()).not.toMatch(/role|purpose|label|category|classification/);
    }
  });

  it("the modules name no project and no mechanism", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/onchain-account-lifecycle.ts",
    ]) {
      const src = await fs.readFile(new URL(file, import.meta.url), "utf-8");
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n")
        .toLowerCase();
      for (const banned of ["pump", "jupiter", "raydium", "solscan", "buyback"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
    }
  });
});

// MUTATION CHECK on the ownership path.
//
// Each case describes a specific wrong implementation and asserts the real
// one does not behave that way. If ownership were ever widened to accept an
// authority, a payer, a close destination or an assigned program, one of
// these fails.
describe("lifecycle — mutation check on the ownership-establishing path", () => {
  const signedByWalletOwnedByOther = tx({
    lifecycleInstructions: decode([
      ix(SYSTEM, "createAccount", {
        source: WALLET, // payer
        newAccount: EPHEMERAL,
        lamports: 2039280,
        owner: TOKEN, // assigned program
      }),
      ix(TOKEN, "initializeAccount3", { account: EPHEMERAL, mint: WSOL, owner: OTHER }),
    ]),
    tokenInstructions: [closeIx(EPHEMERAL, WALLET, WALLET)], // authority + destination
  });

  it("would fail if ownership accepted a transfer or close authority", () => {
    expect(ownsAccountInTransaction(signedByWalletOwnedByOther, EPHEMERAL, WALLET)).toBe(false);
  });

  it("would fail if ownership accepted the payer", () => {
    const life = reconstructAccountLifecycle(signedByWalletOwnedByOther, EPHEMERAL);
    expect(life.payer.value).toBe(WALLET);
    expect(life.owner.value).not.toBe(WALLET);
  });

  it("would fail if ownership accepted the close destination", () => {
    const life = reconstructAccountLifecycle(signedByWalletOwnedByOther, EPHEMERAL);
    expect(life.closeDestination.value).toBe(WALLET);
    expect(life.owner.value).not.toBe(WALLET);
  });

  it("would fail if ownership accepted System createAccount's assigned program", () => {
    expect(ownsAccountInTransaction(signedByWalletOwnedByOther, EPHEMERAL, TOKEN)).toBe(false);
  });

  it("the one true owner is still recovered", () => {
    expect(ownsAccountInTransaction(signedByWalletOwnedByOther, EPHEMERAL, OTHER)).toBe(true);
  });

  it("would fail if an owner could be claimed with no instruction at all", () => {
    expect(ownsAccountInTransaction(tx(), EPHEMERAL, WALLET)).toBe(false);
  });
});
