import { describe, expect, it } from "vitest";

import {
  componentAllowsRule,
  intentForPromotedSubject,
  MAX_PROMOTED_INTENTS_PER_ATTEMPT,
  MAX_PROMOTION_DEPTH,
  promoteFromObservation,
  PROMOTION_ONLY_INTENTS,
} from "../src/server/engine/onchain-subject-promotion";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";

// BOUNDED SUBJECT PROMOTION — what one observation may earn.
//
// The rules encode a research path the owner scripts walked by hand. What
// these tests protect is not that the path works, but that it CANNOT run
// away: no pagination, no counterparty chasing, no depth beyond a
// transaction, no continuing until a burn turns up.

const ANCHOR = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_ACCOUNT = "TokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_ACCOUNT = "OtherAcctBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SIG_A = "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIG_B = "SigBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function artifact(result: OnchainResult): OnchainArtifact {
  const intent = {
    kind: result.kind === "TRANSACTION_DETAIL" ? ("TRANSACTION_DETAIL" as const) : ("ACCOUNT_INFO" as const),
    chain: "solana" as const,
    network: "mainnet" as const,
    projectAnchor: ANCHOR,
    subjectKind: "account" as const,
    subject: WALLET,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: "atlas-onchain://test",
    result,
    normalizedText: "",
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "account",
      subject: WALLET,
      slot: 100,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "test",
      providerMethod: "test",
      requestParams: {},
      retrievedAt: new Date(0),
      rawResponseHash: "sha256:x",
      artifactHash: "sha256:y",
      transactionSignature: null,
    },
  });
}

// An ordinary (non-token) account: tokenAccount is null, which is what
// getAccountInfo yields for anything the SPL Token programs do not own.
const accountInfo = (exists = true) =>
  artifact({
    kind: "ACCOUNT_INFO",
    address: WALLET,
    exists,
    ownerProgram: "SomeProgram1111111111111111111111111111111",
    executable: false,
    lamports: "1",
    tokenAccount: null,
  });

// The same address, but the node parsed it AS a token account. `mint` is
// what decides whether it is this project's business.
const accountInfoAsTokenAccount = (mint: string, owner: string | null = WALLET) =>
  artifact({
    kind: "ACCOUNT_INFO",
    address: WALLET,
    exists: true,
    ownerProgram: "TokenProgram11111111111111111111111111111",
    executable: false,
    lamports: "2039280",
    tokenAccount: { mint, owner, amountRaw: "0", decimals: 6, state: "initialized" },
  });

const tokenAccounts = (accounts: { account: string; owner: string; mint: string }[]) =>
  artifact({
    kind: "TOKEN_ACCOUNTS_BY_OWNER",
    owner: WALLET,
    mint: ANCHOR,
    rejectedCount: 0,
    accounts: accounts.map((a) => ({ ...a, amountRaw: "0", decimals: 6 })),
  });

const signatures = (sigs: { signature: string; slot: number; err: boolean }[]) =>
  artifact({
    kind: "SIGNATURES_FOR_ADDRESS",
    address: TOKEN_ACCOUNT,
    signatures: sigs.map((s) => ({ ...s, blockTime: null, memo: null })),
  });

const transaction = (burns: OnchainResult extends { burns: infer B } ? B : never = [] as never) =>
  artifact({
    kind: "TRANSACTION_DETAIL",
    signature: SIG_A,
    slot: 100,
    blockTime: null,
    succeeded: true,
    burns,
    programs: [],
    accountKeys: [],
    tokenInstructions: [],
    lifecycleInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
  });

const EXEC = "EXECUTION_EVIDENCE";
const base = { bindingConfirmed: true, depth: 0, component: EXEC, visited: new Set<string>() };

describe("promotion — the intended chain", () => {
  it("an existing account earns a token-account discovery", () => {
    const out = promoteFromObservation({ ...base, artifact: accountInfo() });
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0].intentKind).toBe("TOKEN_ACCOUNTS_BY_OWNER");
    expect(out.promoted[0].rule).toBe("ACCOUNT_TO_TOKEN_ACCOUNTS");
    expect(out.promoted[0].depth).toBe(1);
    expect(out.promoted[0].parentSubject).toBe(WALLET);
  });

  it("a returned token account earns ONE bounded signature window", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 1,
      artifact: tokenAccounts([{ account: TOKEN_ACCOUNT, owner: WALLET, mint: ANCHOR }]),
    });
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0].intentKind).toBe("SIGNATURES_FOR_ADDRESS");
    expect(out.promoted[0].subject).toBe(TOKEN_ACCOUNT);
    expect(out.promoted[0].depth).toBe(2);
  });

  it("a signature window earns ONE transaction", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 2,
      artifact: signatures([
        { signature: SIG_A, slot: 10, err: false },
        { signature: SIG_B, slot: 20, err: false },
      ]),
    });
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0].intentKind).toBe("TRANSACTION_DETAIL");
    expect(out.promoted[0].subjectKind).toBe("tx");
    // Most recent successful.
    expect(out.promoted[0].subject).toBe(SIG_B);
    expect(out.promoted[0].depth).toBe(3);
  });

  it("the intent built from a promoted subject carries the anchor unchanged", () => {
    const out = promoteFromObservation({ ...base, artifact: accountInfo() });
    const intent = intentForPromotedSubject(out.promoted[0]);
    expect(intent.projectAnchor).toBe(ANCHOR);
    expect(intent.chain).toBe("solana");
    expect(intent.network).toBe("mainnet");
    expect(intent.subject).toBe(WALLET);
  });
});

describe("promotion — a transaction is the end", () => {
  it("a transaction WITH a burn promotes nothing", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 3,
      artifact: transaction([
        {
          programId: "P",
          instructionType: "BurnChecked",
          mint: ANCHOR,
          sourceAccount: TOKEN_ACCOUNT,
          authority: WALLET,
          amountRaw: "1",
          decimals: 6,
        },
      ] as never),
    });
    expect(out.promoted).toHaveLength(0);
  });

  it("a transaction WITHOUT a burn promotes nothing either — no second search", () => {
    // The rule that matters most. If a no-burn transaction promoted
    // anything, the engine would be searching until it found what it
    // wanted, which is the opposite of research.
    const out = promoteFromObservation({ ...base, depth: 2, artifact: transaction() });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("TERMINAL_OBSERVATION");
  });

  it("the two cases are indistinguishable to the promoter", () => {
    const withBurn = promoteFromObservation({
      ...base,
      depth: 2,
      artifact: transaction([
        {
          programId: "P",
          instructionType: "Burn",
          mint: ANCHOR,
          sourceAccount: TOKEN_ACCOUNT,
          authority: null,
          amountRaw: "1",
          decimals: null,
        },
      ] as never),
    });
    const without = promoteFromObservation({ ...base, depth: 2, artifact: transaction() });
    expect(withBurn.refusal).toBe(without.refusal);
    expect(withBurn.promoted).toEqual(without.promoted);
  });
});

describe("promotion — hard bounds", () => {
  it("refuses at the depth ceiling", () => {
    const out = promoteFromObservation({
      ...base,
      depth: MAX_PROMOTION_DEPTH,
      artifact: accountInfo(),
    });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("DEPTH_LIMIT");
  });

  it("the ceiling is exactly deep enough for locator → account → signature → transaction", () => {
    expect(MAX_PROMOTION_DEPTH).toBe(3);
    expect(MAX_PROMOTED_INTENTS_PER_ATTEMPT).toBeLessThanOrEqual(MAX_PROMOTION_DEPTH);
  });

  it("an unbound observation promotes nothing", () => {
    const out = promoteFromObservation({
      ...base,
      bindingConfirmed: false,
      artifact: accountInfo(),
    });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("BINDING_NOT_CONFIRMED");
  });

  it("an already-visited subject is not promoted again", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 1,
      visited: new Set([`SIGNATURES_FOR_ADDRESS::${TOKEN_ACCOUNT}`]),
      artifact: tokenAccounts([{ account: TOKEN_ACCOUNT, owner: WALLET, mint: ANCHOR }]),
    });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("NO_ELIGIBLE_SUBJECT");
  });

  it("a wallet with SEVERAL token accounts still earns only ONE window", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 1,
      artifact: tokenAccounts([
        { account: TOKEN_ACCOUNT, owner: WALLET, mint: ANCHOR },
        { account: OTHER_ACCOUNT, owner: WALLET, mint: ANCHOR },
      ]),
    });
    expect(out.promoted).toHaveLength(1);
  });

  it("a dense signature window still earns only ONE transaction", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      signature: `Sig${String(i).padStart(2, "0")}${"C".repeat(62)}`,
      slot: 1000 + i,
      err: false,
    }));
    const out = promoteFromObservation({ ...base, depth: 2, artifact: signatures(many) });
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0].intentKind).toBe("TRANSACTION_DETAIL");
  });
});

describe("promotion — nothing that is not ours becomes a subject", () => {
  it("a token account owned by someone else is never promoted", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 1,
      artifact: tokenAccounts([
        { account: OTHER_ACCOUNT, owner: "SomeoneElse111111111111111111111111111111", mint: ANCHOR },
      ]),
    });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("NO_ELIGIBLE_SUBJECT");
  });

  it("a token account of a DIFFERENT mint is never promoted", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 1,
      artifact: tokenAccounts([
        { account: OTHER_ACCOUNT, owner: WALLET, mint: "OtherMint11111111111111111111111111111111" },
      ]),
    });
    expect(out.promoted).toHaveLength(0);
  });

  it("a failed transaction is never selected from a window", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 2,
      artifact: signatures([{ signature: SIG_A, slot: 99, err: true }]),
    });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("NO_ELIGIBLE_SUBJECT");
  });

  it("a window of only failures earns nothing even with a successful one older", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 2,
      artifact: signatures([
        { signature: SIG_A, slot: 99, err: true },
        { signature: SIG_B, slot: 50, err: false },
      ]),
    });
    // The successful one is chosen, not the newest overall.
    expect(out.promoted[0].subject).toBe(SIG_B);
  });

  it("an account that does not exist promotes nothing", () => {
    const out = promoteFromObservation({ ...base, artifact: accountInfo(false) });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("NO_ELIGIBLE_SUBJECT");
  });
});

describe("promotion — components must justify the step", () => {
  it("only EXECUTION_EVIDENCE may reach a signature window or a transaction", () => {
    expect(componentAllowsRule("EXECUTION_EVIDENCE", "TOKEN_ACCOUNT_TO_SIGNATURES")).toBe(true);
    expect(componentAllowsRule("EXECUTION_EVIDENCE", "SIGNATURE_TO_TRANSACTION")).toBe(true);
    for (const c of ["DESTINATION", "RECIPIENT", "CURRENT_STATE", "SOURCE_OF_VALUE"]) {
      expect(componentAllowsRule(c, "TOKEN_ACCOUNT_TO_SIGNATURES")).toBe(false);
      expect(componentAllowsRule(c, "SIGNATURE_TO_TRANSACTION")).toBe(false);
    }
  });

  it("DESTINATION may discover token accounts but stops there", () => {
    const discovery = promoteFromObservation({
      ...base,
      component: "DESTINATION",
      artifact: accountInfo(),
    });
    expect(discovery.promoted).toHaveLength(1);
    const further = promoteFromObservation({
      ...base,
      component: "DESTINATION",
      depth: 1,
      artifact: tokenAccounts([{ account: TOKEN_ACCOUNT, owner: WALLET, mint: ANCHOR }]),
    });
    expect(further.promoted).toHaveLength(0);
    expect(further.refusal).toBe("COMPONENT_NOT_PERMITTED");
  });

  it("a component with no rules promotes nothing at all", () => {
    for (const kind of [accountInfo(), tokenAccounts([]), signatures([])]) {
      const out = promoteFromObservation({ ...base, component: "CURRENT_STATE", artifact: kind });
      expect(out.promoted).toHaveLength(0);
    }
  });
});

describe("promotion — deterministic and steer-proof", () => {
  it("the same window always yields the same transaction", () => {
    const window = signatures([
      { signature: SIG_B, slot: 20, err: false },
      { signature: SIG_A, slot: 20, err: false },
    ]);
    const first = promoteFromObservation({ ...base, depth: 2, artifact: window });
    const second = promoteFromObservation({ ...base, depth: 2, artifact: window });
    expect(first.promoted[0].subject).toBe(second.promoted[0].subject);
    // Tie on slot broken by comparing the signatures, not by arrival order.
    expect(first.promoted[0].subject).toBe(SIG_A);
  });

  it("selection never consults a memo", async () => {
    // A memo is text the sender chose. Selecting on it would let anyone
    // who can write one decide what ATLAS reads next.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/onchain-subject-promotion.ts", import.meta.url),
      "utf-8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("memo");
  });

  it("the module contains no pagination machinery whatsoever", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/onchain-subject-promotion.ts", import.meta.url),
      "utf-8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .toLowerCase();
    for (const banned of ["before", "until", "cursor", "nextpage", "paginat", "offset"]) {
      expect(code, `promotion references "${banned}"`).not.toContain(banned);
    }
  });

  it("names no project, mint, wallet or mechanism", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/onchain-subject-promotion.ts", import.meta.url),
      "utf-8",
    );
    const code = src.toLowerCase();
    for (const banned of ["pump", "jupiter", "raydium", "solscan", "buyback", "treasury"]) {
      expect(code, `promotion mentions "${banned}"`).not.toContain(banned);
    }
    // No hard-coded address of any kind.
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(/["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/.test(codeOnly)).toBe(false);
  });

  it("a transaction can only ever be reached by promotion", () => {
    expect(PROMOTION_ONLY_INTENTS.has("TRANSACTION_DETAIL")).toBe(true);
  });
});

// MUTATION CHECKS on the promotion path. Each names a specific wrong
// implementation and asserts the real one does not behave that way.
describe("promotion — mutation checks", () => {
  it("would fail if the depth limit were removed", () => {
    for (const depth of [MAX_PROMOTION_DEPTH, MAX_PROMOTION_DEPTH + 1, 99]) {
      expect(
        promoteFromObservation({ ...base, depth, artifact: accountInfo() }).promoted,
      ).toHaveLength(0);
    }
  });

  it("would fail if binding were not required", () => {
    for (const art of [accountInfo(), tokenAccounts([{ account: TOKEN_ACCOUNT, owner: WALLET, mint: ANCHOR }])]) {
      expect(
        promoteFromObservation({ ...base, depth: 1, bindingConfirmed: false, artifact: art })
          .promoted,
      ).toHaveLength(0);
    }
  });

  it("would fail if a window promoted another window", () => {
    const out = promoteFromObservation({
      ...base,
      depth: 2,
      artifact: signatures([{ signature: SIG_A, slot: 1, err: false }]),
    });
    expect(out.promoted.every((p) => p.intentKind !== "SIGNATURES_FOR_ADDRESS")).toBe(true);
  });

  it("would fail if a transaction promoted anything", () => {
    for (let depth = 0; depth <= MAX_PROMOTION_DEPTH; depth += 1) {
      expect(
        promoteFromObservation({ ...base, depth, artifact: transaction() }).promoted,
      ).toHaveLength(0);
    }
  });

  it("would fail if an owner check were dropped from token-account promotion", () => {
    const foreign = promoteFromObservation({
      ...base,
      depth: 1,
      artifact: tokenAccounts([
        { account: OTHER_ACCOUNT, owner: "NotOurWallet11111111111111111111111111111", mint: ANCHOR },
      ]),
    });
    expect(foreign.promoted).toHaveLength(0);
  });
});

// THE DOCUMENTARY-LOCATOR → TOKEN BRIDGE.
//
// A documented address is one of three things, and getAccountInfo already
// requests jsonParsed encoding, so ONE observation settles which:
//
//   an ordinary account   → ask which token accounts it owns
//   OUR mint's token acct → it IS the token account; read its history
//   another mint's acct   → not this project's business; stop
//
// The third case is the one that matters. Falling back to the discovery
// rule there would spend a bounded call asking a token account which token
// accounts it owns — a question with no meaningful answer — and reading its
// history would be researching a stranger's account that our document
// happened to name.
describe("promotion — the locator may itself be a token account", () => {
  it("a token account FOR THE ANCHOR MINT is read directly, not asked what it owns", () => {
    const out = promoteFromObservation({ ...base, artifact: accountInfoAsTokenAccount(ANCHOR) });
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0].intentKind).toBe("SIGNATURES_FOR_ADDRESS");
    expect(out.promoted[0].rule).toBe("TOKEN_ACCOUNT_TO_SIGNATURES");
    expect(out.promoted[0].subject).toBe(WALLET);
  });

  it("a token account for ANOTHER mint promotes nothing at all", () => {
    const foreign = "ForeignMint11111111111111111111111111111111";
    const out = promoteFromObservation({ ...base, artifact: accountInfoAsTokenAccount(foreign) });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("NO_ELIGIBLE_SUBJECT");
  });

  it("a wrong-mint token account never falls back to the discovery rule", () => {
    // The specific regression: before the bridge, ANY existing account was
    // promoted to TOKEN_ACCOUNTS_BY_OWNER regardless of what it was.
    const foreign = "ForeignMint11111111111111111111111111111111";
    const out = promoteFromObservation({ ...base, artifact: accountInfoAsTokenAccount(foreign) });
    expect(out.promoted.some((pr) => pr.intentKind === "TOKEN_ACCOUNTS_BY_OWNER")).toBe(false);
  });

  it("an ordinary account still takes the discovery rule unchanged", () => {
    const out = promoteFromObservation({ ...base, artifact: accountInfo() });
    expect(out.promoted[0].intentKind).toBe("TOKEN_ACCOUNTS_BY_OWNER");
    expect(out.promoted[0].rule).toBe("ACCOUNT_TO_TOKEN_ACCOUNTS");
  });

  it("a component that may not read history gets nothing from a token-account locator", () => {
    // DESTINATION may discover, but may not reach a signature window.
    const out = promoteFromObservation({
      ...base,
      component: "DESTINATION",
      artifact: accountInfoAsTokenAccount(ANCHOR),
    });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("COMPONENT_NOT_PERMITTED");
  });

  it("the bridge respects the visited set like every other rule", () => {
    const out = promoteFromObservation({
      ...base,
      visited: new Set([`SIGNATURES_FOR_ADDRESS::${WALLET}`]),
      artifact: accountInfoAsTokenAccount(ANCHOR),
    });
    expect(out.promoted).toHaveLength(0);
    expect(out.refusal).toBe("NO_ELIGIBLE_SUBJECT");
  });

  it("an unparsed account is treated as ordinary, never guessed at", () => {
    // tokenAccount === null means "not established", which must behave as
    // the ordinary case rather than as a token account with an unknown mint.
    const out = promoteFromObservation({ ...base, artifact: accountInfo() });
    expect(out.promoted[0].intentKind).toBe("TOKEN_ACCOUNTS_BY_OWNER");
  });

  it("binding and depth still gate the bridge", () => {
    expect(
      promoteFromObservation({
        ...base,
        bindingConfirmed: false,
        artifact: accountInfoAsTokenAccount(ANCHOR),
      }).promoted,
    ).toHaveLength(0);
    expect(
      promoteFromObservation({
        ...base,
        depth: MAX_PROMOTION_DEPTH,
        artifact: accountInfoAsTokenAccount(ANCHOR),
      }).refusal,
    ).toBe("DEPTH_LIMIT");
  });
});
