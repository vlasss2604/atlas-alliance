import { describe, expect, it } from "vitest";

import {
  createSolanaOnchainAdapter,
  rpcParamsFor,
  SOLANA_ALLOWED_RPC_METHODS,
} from "../src/server/engine/providers/onchain-solana";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type {
  OnchainIntent,
  TokenAccountsByOwnerResult,
} from "../src/server/engine/providers/onchain-types";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { parseCanonicalOnchainUri } from "../src/server/engine/onchain-uri";

// TYPED TOKEN-ACCOUNT DISCOVERY.
//
// A documented wallet is a System account; SPL balances live in token
// accounts it owns. This intent asks which token accounts one wallet holds
// FOR ONE MINT — and the mint is not a parameter anyone chooses, it is the
// intent's projectAnchor, so the request structurally cannot ask about a
// mint that is not the project's confirmed identity.
//
// THREE ADDRESSES STAY APART throughout: the project anchor (the mint),
// the documented owner (the subject), and the token accounts the query
// returns (answers, never inputs). Collapsing any two is the confusion
// D-134 exists to prevent.
//
// Every returned entry is re-validated against what WE ASKED FOR. A node
// that answers about a different owner, a different mint, or an account
// owned by something that is not an SPL Token program has not answered our
// question, and its entry is dropped rather than included with a caveat.

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_MINT = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const OWNER = "AcctCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const OTHER_OWNER = "AcctDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const TOKEN_ACCOUNT = "TokAcctEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const TOKEN_ACCOUNT_2 = "TokAcctFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

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

function intent(over: Partial<OnchainIntent> = {}): OnchainIntent {
  return {
    kind: "TOKEN_ACCOUNTS_BY_OWNER",
    chain: "solana",
    network: "mainnet",
    projectAnchor: MINT,
    subjectKind: "account",
    subject: OWNER,
    ...over,
  } as OnchainIntent;
}

function entry(over: {
  pubkey?: string;
  programOwner?: string;
  owner?: string;
  mint?: string;
  amount?: string;
  decimals?: number;
} = {}) {
  return {
    pubkey: over.pubkey ?? TOKEN_ACCOUNT,
    account: {
      owner: over.programOwner ?? SPL_TOKEN,
      data: {
        parsed: {
          info: {
            owner: over.owner ?? OWNER,
            mint: over.mint ?? MINT,
            tokenAmount: { amount: over.amount ?? "1000000", decimals: over.decimals ?? 6 },
          },
        },
      },
    },
  };
}

function payload(entries: unknown[], slot = 4_412_345) {
  return { context: { slot }, value: entries };
}

async function resultFrom(entries: unknown[], over: Partial<OnchainIntent> = {}) {
  const artifact = await adapterWith(payload(entries)).retrieve(intent(over));
  return { artifact, result: artifact.result as TokenAccountsByOwnerResult };
}

describe("1/12. the request shape is code-owned", () => {
  it("builds exact RPC params from the anchor and the subject", () => {
    const params = rpcParamsFor(intent(), "finalized");
    expect(params).toEqual([
      OWNER,
      { mint: MINT },
      { encoding: "jsonParsed", commitment: "finalized" },
    ]);
  });

  it("the mint filter IS the project anchor — there is no separate mint input", () => {
    // Changing the anchor is the only way to change the filter, and the
    // anchor comes from confirmed PROJECT_IDENTITY.
    const params = rpcParamsFor(intent({ projectAnchor: OTHER_MINT }), "finalized") as [
      string,
      { mint: string },
      unknown,
    ];
    expect(params[1].mint).toBe(OTHER_MINT);
    // OnchainIntent has no field a caller could use to name a mint
    // independently of the anchor.
    expect(Object.keys(intent())).not.toContain("mint");
  });

  it("the method is code-owned and on the allowlist", () => {
    expect(SOLANA_ALLOWED_RPC_METHODS.has("getTokenAccountsByOwner")).toBe(true);
  });

  it("no model can alter owner, mint or method — they are read from typed fields only", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(
      new URL("../src/server/engine/providers/onchain-solana.ts", import.meta.url),
      "utf-8",
    );
    // The params come from intent fields, never from response content or
    // any string the model produced.
    expect(code).toContain("{ mint: intent.projectAnchor }");
    expect(code).toContain('case "TOKEN_ACCOUNTS_BY_OWNER":');
  });

  it("3. a mint that is not the project identity cannot produce a bound result", async () => {
    // A REAL artifact, built by the adapter from an anchor that is not the
    // confirmed identity. The filter it sent was that anchor, so this is
    // exactly the 'wrong mint' case — and binding refuses it. Constructing
    // the artifact through the adapter rather than by hand matters: a
    // hand-built object could assert a shape the adapter never produces.
    const { artifact } = await resultFrom([entry({ mint: OTHER_MINT })], {
      projectAnchor: OTHER_MINT,
    });
    expect(artifact.intent.projectAnchor).toBe(OTHER_MINT);
    expect(
      validateOnchainBinding(artifact, { chain: "solana", tokenAddress: MINT, ticker: null }),
    ).toMatchObject({ binding: "UNVERIFIED", reason: "ANCHOR_NOT_PROJECT_IDENTITY" });
  });
});

describe("4/5/6/7. every returned entry is bound independently", () => {
  it("a matching entry is admitted", async () => {
    const { result } = await resultFrom([entry()]);
    expect(result.accounts).toEqual([
      { account: TOKEN_ACCOUNT, owner: OWNER, mint: MINT, amountRaw: "1000000", decimals: 6 },
    ]);
    expect(result.rejectedCount).toBe(0);
    expect(result.owner).toBe(OWNER);
    expect(result.mint).toBe(MINT);
  });

  it("4. a parsed owner that is not the requested owner fails binding", async () => {
    const { result } = await resultFrom([entry({ owner: OTHER_OWNER })]);
    expect(result.accounts).toEqual([]);
    expect(result.rejectedCount).toBe(1);
  });

  it("5. a parsed mint that is not the requested mint fails binding", async () => {
    const { result } = await resultFrom([entry({ mint: OTHER_MINT })]);
    expect(result.accounts).toEqual([]);
    expect(result.rejectedCount).toBe(1);
  });

  it("6. an account owned by a non-SPL-Token program fails binding", async () => {
    for (const programOwner of ["11111111111111111111111111111111", MINT, "NotAProgram"]) {
      const { result } = await resultFrom([entry({ programOwner })]);
      expect(result.accounts, programOwner).toEqual([]);
      expect(result.rejectedCount).toBe(1);
    }
  });

  it("6. Token-2022 is accepted — both SPL programs, no others", async () => {
    const { result } = await resultFrom([entry({ programOwner: SPL_TOKEN_2022 })]);
    expect(result.accounts.length).toBe(1);
  });

  it("7. a malformed token-account address fails closed", async () => {
    for (const pubkey of ["", "short", "0OIl".repeat(10), `${TOKEN_ACCOUNT}!!`]) {
      const { result } = await resultFrom([entry({ pubkey })]);
      expect(result.accounts, JSON.stringify(pubkey)).toEqual([]);
      expect(result.rejectedCount).toBe(1);
    }
  });

  it("a rejected entry never contaminates a valid sibling", async () => {
    const { result } = await resultFrom([
      entry({ owner: OTHER_OWNER }),
      entry({ pubkey: TOKEN_ACCOUNT_2 }),
      entry({ mint: OTHER_MINT }),
    ]);
    expect(result.accounts.map((a) => a.account)).toEqual([TOKEN_ACCOUNT_2]);
    expect(result.rejectedCount).toBe(2);
  });

  it("a structurally malformed entry is a parse failure, not a silent default", async () => {
    // A missing tokenAmount cannot be defaulted to zero — that would
    // manufacture a balance the chain never reported.
    await expect(
      adapterWith(payload([{ pubkey: TOKEN_ACCOUNT, account: { owner: SPL_TOKEN, data: { parsed: { info: { owner: OWNER, mint: MINT } } } } }])).retrieve(intent()),
    ).rejects.toThrow();
  });
});

describe("8/9/10. balances and multiplicity", () => {
  it("8. an exact large balance preserves precision", async () => {
    // Beyond Number.MAX_SAFE_INTEGER: a double would round this.
    const huge = "838098204263102994";
    expect(Number(huge).toString()).not.toBe(huge); // the loss, demonstrated
    const { result } = await resultFrom([entry({ amount: huge, decimals: 6 })]);
    expect(result.accounts[0].amountRaw).toBe(huge);
    expect(typeof result.accounts[0].amountRaw).toBe("string");
    // And the human-readable rendering is exact too.
    const facts = synthesizeOnchainFacts(
      (await resultFrom([entry({ amount: huge, decimals: 6 })])).artifact,
      { step: 6, component: "DESTINATION" },
    );
    expect(facts[0].statement).toContain("838098204263.102994");
    expect(facts[0].statement).toContain(huge);
  });

  it("9. a zero balance is a valid observation, not an absence", async () => {
    const { result } = await resultFrom([entry({ amount: "0" })]);
    expect(result.accounts.length).toBe(1);
    expect(result.accounts[0].amountRaw).toBe("0");
    const facts = synthesizeOnchainFacts((await resultFrom([entry({ amount: "0" })])).artifact, {
      step: 6,
      component: "DESTINATION",
    });
    expect(facts.length).toBe(1);
  });

  it("no token accounts yields NO fact — absence is never a fact", async () => {
    const { artifact, result } = await resultFrom([]);
    expect(result.accounts).toEqual([]);
    expect(synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" })).toEqual([]);
  });

  it("10. multiple matching token accounts are represented independently", async () => {
    const { artifact, result } = await resultFrom([
      entry({ pubkey: TOKEN_ACCOUNT, amount: "1" }),
      entry({ pubkey: TOKEN_ACCOUNT_2, amount: "2" }),
    ]);
    expect(result.accounts.map((a) => a.account)).toEqual([TOKEN_ACCOUNT, TOKEN_ACCOUNT_2]);
    const facts = synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" });
    // One fact per account, each quoting its OWN bytes — two accounts must
    // not deduplicate into one fact downstream.
    expect(facts.length).toBe(2);
    expect(facts[0].supportFragment).not.toBe(facts[1].supportFragment);
    expect(facts[0].supportFragment).toContain(TOKEN_ACCOUNT);
    expect(facts[1].supportFragment).toContain(TOKEN_ACCOUNT_2);
    // Balances are never summed into an invented aggregate.
    expect(facts.map((f) => f.statement).join(" ")).not.toContain("total");
  });

  it("every fact carries an explicit doesNotProve", async () => {
    const { artifact } = await resultFrom([entry()]);
    const [f] = synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" });
    for (const phrase of ["burned", "bought back", "supply", "who funded", "controls the"]) {
      expect(f.doesNotProve.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
    // A position, not a purpose: this is context, never support for a claim.
    expect(f.relationship).toBe("CONTEXT");
  });
});

describe("11/13/14. URI, project independence, and existing intents", () => {
  it("11. the canonical URI cannot confer binding", async () => {
    const { artifact } = await resultFrom([entry()]);
    const parsed = parseCanonicalOnchainUri(artifact.canonicalUri);
    expect(parsed).toMatchObject({
      projectAnchor: MINT,
      subjectKind: "account",
      subject: OWNER,
      intentPath: "token-accounts",
    });
    // The URI names the anchor and the OWNER; the discovered token account
    // is deliberately absent from it, so a URI can never be read as proof
    // that some account belongs to the project.
    expect(artifact.canonicalUri).not.toContain(TOKEN_ACCOUNT);
    // And a hand-written URI claiming the right anchor proves nothing:
    // binding is decided by the artifact's fields, and a wrong-owner
    // response still fails despite a perfectly-formed URI.
    const { artifact: mismatched } = await resultFrom([entry({ owner: OTHER_OWNER })]);
    expect(mismatched.canonicalUri).toBe(artifact.canonicalUri);
    expect((mismatched.result as TokenAccountsByOwnerResult).accounts).toEqual([]);
  });

  it("binding checks the RESPONSE subject, not the URI", async () => {
    const { artifact } = await resultFrom([entry()]);
    expect(
      validateOnchainBinding(artifact, { chain: "solana", tokenAddress: MINT, ticker: null }),
    ).toEqual({ binding: "CONFIRMED" });
    // Same artifact, different confirmed identity -> refused.
    expect(
      validateOnchainBinding(artifact, { chain: "solana", tokenAddress: OTHER_MINT, ticker: null }),
    ).toMatchObject({ binding: "UNVERIFIED" });
  });

  it("13. no project-specific logic anywhere in the new path", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/providers/onchain-solana.ts",
      "../src/server/engine/providers/onchain-types.ts",
      "../src/server/engine/onchain-facts.ts",
      "../src/server/engine/onchain-uri.ts",
      "../src/server/engine/onchain-binding.ts",
    ]) {
      const raw = await fs.readFile(new URL(file, import.meta.url), "utf-8");
      const code = raw
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["pump", "solscan", "hyperliquid", "uniswap"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("14. existing structured intents are unchanged", async () => {
    // Params for every prior intent keep their exact shape.
    expect(rpcParamsFor({ ...intent({ kind: "TOKEN_SUPPLY", subject: MINT }) }, "finalized")).toEqual([
      MINT,
      { commitment: "finalized" },
    ]);
    expect(rpcParamsFor(intent({ kind: "ACCOUNT_INFO" }), "finalized")).toEqual([
      OWNER,
      { encoding: "jsonParsed", commitment: "finalized" },
    ]);
    expect(rpcParamsFor(intent({ kind: "TOKEN_ACCOUNT_BALANCE" }), "finalized")).toEqual([
      OWNER,
      { commitment: "finalized" },
    ]);
    // And a prior intent still normalizes as before.
    const supply = await adapterWith({
      context: { slot: 100 },
      value: { amount: "1000000", decimals: 6 },
    }).retrieve(intent({ kind: "TOKEN_SUPPLY", subjectKind: "token", subject: MINT }));
    expect(supply.result).toEqual({
      kind: "TOKEN_SUPPLY",
      mint: MINT,
      amountRaw: "1000000",
      decimals: 6,
    });
  });
});

describe("2. the owner provenance gate — structural", () => {
  const ENTRYPOINT = new URL("../scripts/onchain-token-accounts.ts", import.meta.url);

  async function code(): Promise<string> {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(ENTRYPOINT, "utf-8");
    return raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  }

  it("an undocumented owner is refused BEFORE transport is constructed", async () => {
    const c = await code();
    expect(c).toContain("findAdmittedLocator(db, wallet)");
    const gate = c.indexOf("refusing — this address is not a confirmed documentary locator");
    const retriever = c.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(retriever);
  });

  it("the anchor comes from confirmed identity, never from the command line", async () => {
    const c = await code();
    expect(c).toContain("resolveConfirmedIdentity(");
    expect(c).toContain("anchor = identity.tokenAddress");
    expect(c).toContain("projectAnchor: anchor");
    expect(c).toContain("subject: wallet");
  });

  it("exactly one read, no retry, no escalation, no persistence", async () => {
    const c = await code();
    expect((c.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    for (const banned of [
      "retry",
      "attempt",
      "for (let i",
      "while (",
      "before",
      "until",
      "cursor",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "getTransaction",
      ".insert(",
      ".update(",
      ".delete(",
      "anthropic",
      "brave",
      "playwright",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("closes the database before the read", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(ENTRYPOINT, "utf-8");
    expect(raw.indexOf("pool.end()")).toBeLessThan(raw.indexOf("retriever.retrieve("));
  });
});
