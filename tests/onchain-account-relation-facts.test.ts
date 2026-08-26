import { describe, expect, it } from "vitest";

import { ONCHAIN_DOES_NOT_PROVE, synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  AccountInfoResult,
  OnchainArtifact,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";

// DETERMINISTIC ACCOUNT-RELATIONSHIP FACTS.
//
// The adapter parses whether a queried account is an SPL token account and
// for which mint. That reached the stored artifact and stopped there, so the
// Evidence layer could not see it: the strongest deterministic statement
// ACCOUNT_INFO supports — "this documented address IS this project's token
// account" — was unavailable to any consumer.
//
// What these tests mostly guard is the opposite direction. A documentary
// source may call an address anything at all; the chain says only what it
// says, and none of the document's language may cross into a synthesized
// on-chain fact.

const ANCHOR = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FOREIGN = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SUBJECT = "AcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_SUBJECT = "AcctBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const HOLDER = "OwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM = "11111111111111111111111111111111";

const TARGET = { step: 6, component: "DESTINATION" };

function artifactFor(
  result: AccountInfoResult,
  opts: { anchor?: string; slot?: number } = {},
): OnchainArtifact {
  const anchor = opts.anchor ?? ANCHOR;
  const intent: OnchainIntent = {
    kind: "ACCOUNT_INFO",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "account",
    subject: result.address,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: `atlas-onchain://solana/mainnet/project/${anchor}/account/${result.address}/info`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "account",
      subject: result.address,
      slot: opts.slot ?? 441_840_975,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "getAccountInfo",
      requestParams: { subject: result.address },
      retrievedAt: new Date(0),
      rawResponseHash: `sha256:raw:${result.address}:${result.tokenAccount?.mint ?? "none"}`,
      artifactHash: `sha256:art:${result.address}:${result.tokenAccount?.mint ?? "none"}`,
      transactionSignature: null,
    },
  });
}

const ordinary = (address = SUBJECT): AccountInfoResult => ({
  kind: "ACCOUNT_INFO",
  address,
  exists: true,
  ownerProgram: SYSTEM,
  executable: false,
  lamports: "64850000000",
  tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
  tokenAccount: null,
});

const tokenAccountFor = (
  mint: string,
  opts: { address?: string; program?: string; owner?: string | null } = {},
): AccountInfoResult => ({
  kind: "ACCOUNT_INFO",
  address: opts.address ?? SUBJECT,
  exists: true,
  ownerProgram: opts.program ?? SPL_TOKEN,
  executable: false,
  lamports: "2039280",
  tokenAccountRelation: "TOKEN_ACCOUNT_PARSED",
  tokenAccount: {
    mint,
    owner: opts.owner === undefined ? HOLDER : opts.owner,
    amountRaw: "7723746661",
    decimals: 6,
    state: "initialized",
  },
});

const unresolved = (): AccountInfoResult => ({
  kind: "ACCOUNT_INFO",
  address: SUBJECT,
  exists: true,
  ownerProgram: SPL_TOKEN,
  executable: false,
  lamports: "2039280",
  tokenAccountRelation: "TOKEN_PROGRAM_OWNED_UNRESOLVED",
  tokenAccount: null,
});

const synth = (result: AccountInfoResult, anchor = ANCHOR) =>
  synthesizeOnchainFacts(artifactFor(result, { anchor }), TARGET);

describe("account relation facts — 1. a non-token-program account", () => {
  const facts = synth(ordinary());

  it("preserves the exact owner program", () => {
    expect(facts).toHaveLength(1);
    expect(facts[0].statement).toContain(SYSTEM);
    expect(facts[0].statement).toContain(SUBJECT);
  });

  it("makes no token-account claim at all", () => {
    const text = facts.map((f) => f.statement).join(" ").toLowerCase();
    expect(text).not.toContain("token account");
    expect(text).not.toContain("mint");
  });

  it("infers no economic role — not a wallet, not a holder, not anything", () => {
    const text = facts.map((f) => f.statement).join(" ").toLowerCase();
    for (const role of ["wallet", "treasury", "vault", "holder", "burn", "custody"]) {
      expect(text, `statement asserts the role "${role}"`).not.toContain(role);
    }
    // The limits are still shipped with the fact.
    expect(facts[0].doesNotProve).toContain("economic labels, not chain facts");
  });
});

describe("account relation facts — 2/3. a target-mint token account", () => {
  for (const [label, program] of [
    ["SPL Token", SPL_TOKEN],
    ["Token-2022", TOKEN_2022],
  ] as const) {
    it(`${label}: synthesizes the deterministic target-mint relationship`, () => {
      const facts = synth(tokenAccountFor(ANCHOR, { program }));
      expect(facts).toHaveLength(2);
      const relation = facts[1];
      expect(relation.statement).toContain(SUBJECT);
      expect(relation.statement).toContain(ANCHOR);
      expect(relation.statement).toContain(program);
      expect(relation.statement).toContain(HOLDER);
      expect(relation.statement).toContain("this project's confirmed mint");
      expect(relation.relationship).toBe("SUPPORTS");
      expect(relation.directness).toBe("DIRECT");
      expect(relation.doesNotProve).toBe(ONCHAIN_DOES_NOT_PROVE.ACCOUNT_TOKEN_RELATION);
    });
  }

  it("keeps the existence fact alongside, not merged into it", () => {
    const facts = synth(tokenAccountFor(ANCHOR));
    expect(facts[0].doesNotProve).toBe(ONCHAIN_DOES_NOT_PROVE.ACCOUNT_INFO);
    expect(facts[0].supportFragment).not.toBe(facts[1].supportFragment);
  });

  it("omits the owner clause rather than inventing one", () => {
    const facts = synth(tokenAccountFor(ANCHOR, { owner: null }));
    expect(facts[1].statement).not.toContain("token-account owner");
    expect(facts[1].statement).toContain(ANCHOR);
  });

  it("quotes only bytes that are in the artifact", () => {
    const artifact = artifactFor(tokenAccountFor(ANCHOR));
    const facts = synthesizeOnchainFacts(artifact, TARGET);
    for (const f of facts) {
      const fragment = JSON.parse(f.supportFragment) as Record<string, unknown>;
      for (const [k, v] of Object.entries(fragment)) {
        expect(JSON.stringify((artifact.result as unknown as Record<string, unknown>)[k])).toBe(
          JSON.stringify(v),
        );
      }
    }
  });
});

describe("account relation facts — 4. a foreign-mint token account", () => {
  const facts = synth(tokenAccountFor(FOREIGN));

  it("preserves the exact observed mint and says it is NOT the anchor", () => {
    expect(facts).toHaveLength(2);
    expect(facts[1].statement).toContain(FOREIGN);
    expect(facts[1].statement).toContain("NOT this project's confirmed mint");
    expect(facts[1].statement).toContain(ANCHOR);
  });

  it("is never offered as support for this project", () => {
    // The account holds a different asset. Calling that SUPPORTS would
    // carry the project across on the strength of a document mentioning
    // the address.
    expect(facts[1].relationship).toBe("CONTEXT");
    expect(facts[1].doesNotProve).toBe(ONCHAIN_DOES_NOT_PROVE.ACCOUNT_TOKEN_RELATION_FOREIGN);
    expect(facts[1].doesNotProve).toContain("does not make the account this project's");
  });

  it("does not claim the anchor mint anywhere in the relationship", () => {
    // The anchor appears only as the thing the observed mint differs from.
    expect(facts[1].statement).toContain(`NOT this project's confirmed mint ${ANCHOR}`);
  });
});

describe("account relation facts — 5/6. nothing is guessed", () => {
  it("token-program owned but UNRESOLVED yields no relationship fact", () => {
    const facts = synth(unresolved());
    expect(facts).toHaveLength(1);
    const text = facts[0].statement.toLowerCase();
    // No mint, in either direction.
    expect(text).not.toContain("mint");
    expect(text).not.toContain("not this project");
  });

  it("UNRESOLVED never yields an ordinary-account claim either", () => {
    const facts = synth(unresolved());
    const text = facts.map((f) => f.statement).join(" ").toLowerCase();
    expect(text).not.toContain("wallet");
    expect(text).not.toContain("is not a token account");
    // What IS established survives: the exact owning program.
    expect(facts[0].statement).toContain(SPL_TOKEN);
  });

  it("a non-token program is never classified as a token account", () => {
    // The adapter gates on the program owner, so a program returning a
    // mint-shaped field arrives here as NOT_TOKEN_PROGRAM_OWNED.
    const facts = synth(ordinary());
    expect(facts).toHaveLength(1);
    expect(facts.some((f) => f.statement.includes(ANCHOR))).toBe(false);
  });

  it("a non-existent account yields nothing, and never an absence claim", () => {
    const facts = synth({ ...ordinary(), exists: false, ownerProgram: null });
    expect(facts).toHaveLength(0);
  });
});

describe("account relation facts — 7. anchor and subject stay distinct", () => {
  it("the subject is the queried account, never the anchor", () => {
    const facts = synth(tokenAccountFor(ANCHOR));
    expect(facts[1].statement.startsWith(`Account ${SUBJECT} `)).toBe(true);
    expect(facts[1].statement.startsWith(`Account ${ANCHOR} `)).toBe(false);
  });

  it("the anchor comes from provenance, not from the observation", () => {
    // Same observation, different project anchor: the SAME parsed mint is
    // now foreign, purely because the project it is judged against changed.
    const asTarget = synthesizeOnchainFacts(
      artifactFor(tokenAccountFor(ANCHOR), { anchor: ANCHOR }),
      TARGET,
    );
    const asForeign = synthesizeOnchainFacts(
      artifactFor(tokenAccountFor(ANCHOR), { anchor: FOREIGN }),
      TARGET,
    );
    expect(asTarget[1].relationship).toBe("SUPPORTS");
    expect(asForeign[1].relationship).toBe("CONTEXT");
    expect(asForeign[1].statement).toContain("NOT this project's confirmed mint");
  });

  it("an anchor equal to the subject does not collapse the two roles", () => {
    // Degenerate but representable: the queried account address is also
    // the anchor. Subject and anchor must still read as separate things.
    const facts = synthesizeOnchainFacts(
      artifactFor(tokenAccountFor(FOREIGN), { anchor: SUBJECT }),
      TARGET,
    );
    expect(facts[1].statement).toContain(`Account ${SUBJECT}`);
    expect(facts[1].statement).toContain(FOREIGN);
  });
});

describe("account relation facts — 8. replay and identity", () => {
  it("the same observation replays to identical facts", () => {
    const first = synth(tokenAccountFor(ANCHOR));
    const second = synth(tokenAccountFor(ANCHOR));
    expect(second).toEqual(first);
  });

  it("target and foreign never share a support fragment", () => {
    // The extraction-unit key is derived from the fragment, so identical
    // fragments would collapse two different findings into one row.
    const target = synth(tokenAccountFor(ANCHOR))[1];
    const foreign = synth(tokenAccountFor(FOREIGN))[1];
    expect(target.supportFragment).not.toBe(foreign.supportFragment);
    expect(target.statement).not.toBe(foreign.statement);
  });

  it("two different subjects never share a support fragment", () => {
    const a = synth(tokenAccountFor(ANCHOR, { address: SUBJECT }))[1];
    const b = synth(tokenAccountFor(ANCHOR, { address: OTHER_SUBJECT }))[1];
    expect(a.supportFragment).not.toBe(b.supportFragment);
  });

  it("fact order is stable across runs", () => {
    for (let i = 0; i < 5; i += 1) {
      const facts = synth(tokenAccountFor(ANCHOR));
      expect(facts.map((f) => f.doesNotProve)).toEqual([
        ONCHAIN_DOES_NOT_PROVE.ACCOUNT_INFO,
        ONCHAIN_DOES_NOT_PROVE.ACCOUNT_TOKEN_RELATION,
      ]);
    }
  });
});

describe("account relation facts — 9. the documentary label never crosses over", () => {
  // The case that made this matter: a documented address whose official
  // source calls it a burn address, observed to be System-owned.
  const facts = synth(ordinary());

  it("states the chain relationship and nothing the document said", () => {
    const text = facts.map((f) => `${f.statement} ${f.doesNotProve}`).join(" ");
    expect(facts[0].statement).toContain(`owned by program ${SYSTEM}`);
    // The statement itself asserts no role whatsoever.
    for (const forbidden of [
      "burn account",
      "burns tokens",
      "supply decreased",
      "reached this address",
      "the official label",
    ]) {
      expect(facts[0].statement.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // doesNotProve may NAME the labels it refuses — that is its job.
    expect(text).toContain("burn address");
  });

  it("synthesizes no burn, transfer or movement fact from ACCOUNT_INFO", () => {
    for (const result of [ordinary(), tokenAccountFor(ANCHOR), tokenAccountFor(FOREIGN), unresolved()]) {
      const text = synth(result).map((f) => f.statement).join(" ").toLowerCase();
      for (const forbidden of ["burn", "transfer", "destroy", "sent", "received", "supply"]) {
        expect(text, `${result.tokenAccountRelation}: "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it("states no balance, because a balance here has no justified consumer", () => {
    // The parsed amount is preserved in the artifact; it is deliberately
    // not spoken as a fact, so a zero cannot be read as a history.
    const facts = synth(tokenAccountFor(ANCHOR));
    expect(facts.map((f) => f.statement).join(" ")).not.toContain("7723746661");
  });

  it("names no project and no ticker in the module itself", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/onchain-facts.ts", import.meta.url),
      "utf-8",
    );
    const lower = src.toLowerCase();
    for (const banned of ["pump", "solscan", "jupiter", "raydium"]) {
      expect(lower, `facts module mentions "${banned}"`).not.toContain(banned);
    }
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(/["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/.test(codeOnly)).toBe(false);
  });
});
