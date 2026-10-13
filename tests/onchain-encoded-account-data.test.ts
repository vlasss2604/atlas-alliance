import { describe, expect, it } from "vitest";

import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { createSolanaOnchainAdapter } from "../src/server/engine/providers/onchain-solana";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";
import type { OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";

// ENCODED ACCOUNT DATA IS A VALID ANSWER, NOT A FAULT.
//
// jsonParsed is a REQUEST. The node parses account data when it has a
// parser for the owning program and otherwise returns the encoded form
// [<data>, <encoding>]. A System-owned account has no parser at all, so
// that fallback is the ORDINARY case for exactly the kind of address a
// documentary locator most often names.
//
// The schema accepted only the parsed object form, so a correct response
// was rejected and reported as "rpc response failed schema validation for
// getAccountInfo" — which reads as a provider fault when the provider did
// nothing wrong. The first bounded live validation failed on precisely
// this, and these tests reproduce it offline.

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SUBJECT = "AcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOLDER = "OwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SYSTEM = "11111111111111111111111111111111";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const OTHER_PROGRAM = "SomeOtherProgram11111111111111111111111111";

function fixtureTransport(payload: unknown): OnchainRpcTransport {
  return {
    async call() {
      return JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload });
    },
  };
}

function adapterWith(payload: unknown) {
  return createSolanaOnchainAdapter({
    transport: fixtureTransport(payload),
    providerId: "fixture-rpc",
    finality: "finalized",
  });
}

const intent: OnchainIntent = {
  kind: "ACCOUNT_INFO",
  chain: "solana",
  network: "mainnet",
  projectAnchor: MINT,
  subjectKind: "account",
  subject: SUBJECT,
};

function accountPayload(owner: string, data: unknown) {
  return {
    context: { slot: 500 },
    value: { owner, executable: false, lamports: 64_850_000_000, ...(data === undefined ? {} : { data }) },
  };
}

async function relationOf(owner: string, data: unknown) {
  const artifact = await adapterWith(accountPayload(owner, data)).retrieve(intent);
  return artifact.result as {
    tokenAccountRelation: string;
    tokenAccount: unknown;
    ownerProgram: string | null;
    exists: boolean;
  };
}

describe("encoded account data — the fallback is accepted", () => {
  it("System Program-owned with data ['', 'base64'] is accepted and classified", async () => {
    // The exact shape that failed the first live validation.
    const r = await relationOf(SYSTEM, ["", "base64"]);
    expect(r.exists).toBe(true);
    expect(r.ownerProgram).toBe(SYSTEM);
    expect(r.tokenAccountRelation).toBe("NOT_TOKEN_PROGRAM_OWNED");
    expect(r.tokenAccount).toBeNull();
  });

  it("a generic non-token program with an encoded fallback is NOT_TOKEN_PROGRAM_OWNED", async () => {
    const r = await relationOf(OTHER_PROGRAM, ["ZGF0YQ==", "base64"]);
    expect(r.tokenAccountRelation).toBe("NOT_TOKEN_PROGRAM_OWNED");
  });

  it("every encoding the RPC actually emits is accepted", async () => {
    for (const encoding of ["base64", "base58", "base64+zstd"]) {
      const r = await relationOf(SYSTEM, ["ZGF0YQ==", encoding]);
      expect(r.tokenAccountRelation, encoding).toBe("NOT_TOKEN_PROGRAM_OWNED");
    }
  });
});

describe("encoded account data — a token program with no parsed data stays UNRESOLVED", () => {
  for (const [label, program] of [
    ["SPL Token", SPL_TOKEN],
    ["Token-2022", TOKEN_2022],
  ] as const) {
    it(`${label}: encoded fallback is UNRESOLVED, never demoted`, async () => {
      // We KNOW it is a token account (the program owner says so) and we do
      // NOT know which mint. Demoting it to an ordinary account would turn
      // a failure to establish identity into positive evidence against it.
      const r = await relationOf(program, ["c29tZSBiaW5hcnk=", "base64"]);
      expect(r.tokenAccountRelation).toBe("TOKEN_PROGRAM_OWNED_UNRESOLVED");
      expect(r.tokenAccountRelation).not.toBe("NOT_TOKEN_PROGRAM_OWNED");
      expect(r.tokenAccount).toBeNull();
    });

    it(`${label}: no mint is fabricated from binary data`, async () => {
      const r = await relationOf(program, ["ZGF0YQ==", "base64"]);
      expect(JSON.stringify(r)).not.toContain(MINT);
      expect(r.tokenAccount).toBeNull();
    });
  }

  it("a token program with data absent entirely is also UNRESOLVED", async () => {
    const r = await relationOf(SPL_TOKEN, undefined);
    expect(r.tokenAccountRelation).toBe("TOKEN_PROGRAM_OWNED_UNRESOLVED");
  });
});

describe("encoded account data — strictness is preserved", () => {
  it("parsed SPL token data still yields the target-mint relationship", async () => {
    const r = await relationOf(SPL_TOKEN, {
      program: "spl-token",
      parsed: { type: "account", info: { mint: MINT, owner: HOLDER } },
    });
    expect(r.tokenAccountRelation).toBe("TOKEN_ACCOUNT_PARSED");
    expect((r.tokenAccount as { mint: string }).mint).toBe(MINT);
  });

  it("a malformed parsed mint is still UNRESOLVED", async () => {
    for (const bad of ["", "not-base58!", "tooShort", 12345]) {
      const r = await relationOf(SPL_TOKEN, {
        program: "spl-token",
        parsed: { type: "account", info: { mint: bad, owner: HOLDER } },
      });
      expect(r.tokenAccountRelation, String(bad)).toBe("TOKEN_PROGRAM_OWNED_UNRESOLVED");
    }
  });

  it("an unrecognised encoding is REFUSED, not quietly accepted", async () => {
    // The union admits the fallback in its exact shape. A form this adapter
    // cannot interpret must not pass as though it had been understood.
    await expect(
      adapterWith(accountPayload(SYSTEM, ["ZGF0YQ==", "hex"])).retrieve(intent),
    ).rejects.toThrow();
  });

  it("a malformed data shape is still REFUSED", async () => {
    for (const bad of [["only-one-element"], ["a", "base64", "extra"], 42, "raw-string"]) {
      await expect(
        adapterWith(accountPayload(SYSTEM, bad)).retrieve(intent),
        JSON.stringify(bad),
      ).rejects.toThrow();
    }
  });

  it("no token identity is ever inferred from arbitrary binary data", async () => {
    // A non-token program returning something that LOOKS parsed is still
    // gated on the program owner.
    const r = await relationOf(OTHER_PROGRAM, {
      program: "spl-token",
      parsed: { type: "account", info: { mint: MINT, owner: HOLDER } },
    });
    expect(r.tokenAccountRelation).toBe("NOT_TOKEN_PROGRAM_OWNED");
    expect(r.tokenAccount).toBeNull();
  });
});

describe("encoded account data — facts follow the classification", () => {
  it("a System-owned encoded account yields exactly the existence fact", async () => {
    const artifact = await adapterWith(accountPayload(SYSTEM, ["", "base64"])).retrieve(intent);
    const facts = synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" });
    expect(facts).toHaveLength(1);
    expect(facts[0].statement).toContain(SYSTEM);
    expect(facts[0].statement.toLowerCase()).not.toContain("mint");
  });

  it("a token-program-owned encoded account yields no mint relationship", async () => {
    const artifact = await adapterWith(
      accountPayload(SPL_TOKEN, ["ZGF0YQ==", "base64"]),
    ).retrieve(intent);
    const facts = synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" });
    expect(facts).toHaveLength(1);
    const text = facts[0].statement.toLowerCase();
    expect(text).not.toContain("mint");
    expect(text).not.toContain("not this project");
  });
});
