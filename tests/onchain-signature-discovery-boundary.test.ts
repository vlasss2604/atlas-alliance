import { describe, expect, it } from "vitest";

import {
  MAX_SIGNATURES_PER_INTENT,
  SOLANA_ALLOWED_RPC_METHODS,
} from "../src/server/engine/providers/onchain-solana";

// BOUNDED SIGNATURE DISCOVERY — structural guarantees.
//
// This entrypoint performs a real, billable, externally-visible chain
// read, and it is the one intent that invites escalation: the RPC accepts
// before/until cursors, so a caller that threads them turns a single cheap
// read into an unbounded scan of an account's entire history. The tests
// that matter therefore read the source and prove the cursor machinery is
// absent, not merely unused.

const ENTRYPOINT = new URL("../scripts/onchain-signature-discovery.ts", import.meta.url);

async function source(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(ENTRYPOINT, "utf-8");
}

// Comment prose wraps across lines, so a phrase is matched against the
// header with its comment markers and line breaks flattened away.
function normalize(header: string): string {
  return header
    .split("\n")
    .map((l) => l.trim())
    .map((l) => (l.startsWith("//") ? l.slice(2).trim() : l))
    .join(" ")
    .split(" ")
    .filter((w) => w !== "")
    .join(" ")
    .toLowerCase();
}

async function code(): Promise<string> {
  const raw = await source();
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("signature discovery — one window, no pagination", () => {
  it("constructs ONE intent and performs ONE retrieval", async () => {
    const c = await code();
    expect((c.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    expect((c.match(/const intent: OnchainIntent = \{/g) ?? []).length).toBe(1);
    expect((c.match(/createProductionOnchainRetriever\(/g) ?? []).length).toBe(1);
  });

  it("NEVER constructs a pagination cursor", async () => {
    const c = await code();
    // The two fields that make getSignaturesForAddress unbounded.
    for (const banned of ["before", "until", "cursor", "nextPage", "paginat"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("has no retry and no loop around the read", async () => {
    const c = await code();
    for (const banned of ["retry", "attempt", "for (let i", "while (", "Promise.all", "do {"]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("cannot escalate to transaction detail or any other intent", async () => {
    const c = await code();
    expect(c).toContain('kind: "SIGNATURES_FOR_ADDRESS"');
    for (const banned of [
      "TRANSACTION_DETAIL",
      "ACCOUNT_INFO",
      "TOKEN_SUPPLY",
      "TOKEN_ACCOUNT_BALANCE",
      "getTransaction",
      "getAccountInfo",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("the adapter clamps the limit independently of what this script asks for", () => {
    // The bound is enforced where the request is built, so an over-large
    // --limit is clamped rather than honoured — the script's own argument
    // validation is not the only thing standing between a caller and a
    // large scan.
    expect(MAX_SIGNATURES_PER_INTENT).toBeGreaterThan(0);
    expect(MAX_SIGNATURES_PER_INTENT).toBeLessThanOrEqual(25);
    expect(SOLANA_ALLOWED_RPC_METHODS.has("getSignaturesForAddress")).toBe(true);
  });

  it("rejects a non-integer or non-positive limit before touching anything", async () => {
    const raw = await source();
    const guard = raw.indexOf("!Number.isInteger(limit) || limit < 1");
    const db = raw.indexOf("createDatabase()");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(db);
  });

  it("persists nothing — no insert, update or delete anywhere", async () => {
    const c = await code();
    for (const banned of [".insert(", ".update(", ".delete(", "onConflict", "transaction("]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("makes no model call, no search call, and renders nothing", async () => {
    const c = await code();
    for (const banned of [
      "anthropic",
      "Anthropic",
      "evidence-extractor",
      "query-proposer",
      "search-gateway",
      "brave",
      "Brave",
      "playwright",
      "rendered-docs",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("builds no Proof and enters no assembly or claim stage", async () => {
    const c = await code();
    for (const banned of ["mechanism-assembl", "claim-support", "claim-evaluator", "run-job", "controller", "s4-executor"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });
});

describe("signature discovery — the subject must be documented", () => {
  it("reads the subject's provenance from admitted Evidence before the retriever exists", async () => {
    const c = await code();
    // The gate is the shared subject gate. Documentary provenance still
    // resolves exactly as before — the normalized locator table and the
    // legacy scalar column both answer — and a derived on-chain subject
    // is a SEPARATE class that never inherits document authority.
    // The shared subject gate: it answers for BOTH provenance classes
    // (documentary locator and derived on-chain subject) and keeps them
    // distinct. Neither class is queried by substring — equality only.
    expect(c).toContain("resolveOnchainSubject(db, {");
    expect(c).toContain("subject: address,");
    expect(c).toContain("projectAnchor: anchor,");
    expect(c).not.toContain("documentaryLocator, ");
    expect(c).not.toContain("documentaryLocator, address");
    const gate = c.indexOf("refusing — this address has no admitted on-chain subject provenance");
    const retriever = c.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(retriever);
  });

  it("takes the ANCHOR from confirmed identity, never from the command line", async () => {
    const c = await code();
    expect(c).toContain("resolveConfirmedIdentity(");
    expect(c).toContain("anchor = identity.tokenAddress");
    expect(c).toContain("projectAnchor: anchor");
    expect(c).toContain("subject: address");
    expect(c).toContain('subjectKind: "account"');
  });

  it("closes the database before the read", async () => {
    const raw = await source();
    const poolEnd = raw.indexOf("pool.end()");
    const retrieve = raw.indexOf("retriever.retrieve(");
    expect(poolEnd).toBeGreaterThan(-1);
    expect(poolEnd).toBeLessThan(retrieve);
  });

  it("validates binding rather than assuming it", async () => {
    expect(await code()).toContain("validateOnchainBinding(");
  });

  it("names no project or mechanism in its executable code", async () => {
    const c = (await code()).toLowerCase();
    for (const banned of ["solscan", "burn", "treasury", "buyback", "hyperliquid", "uniswap"]) {
      expect(c, `entrypoint code mentions "${banned}"`).not.toContain(banned);
    }
    expect((c.match(/pump/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});

// DIAGNOSTIC COMPLETENESS — a projected field that is never printed makes
// the output lie by omission.
//
// The adapter projects SignatureRef.memo, and this script printed every
// other field of the ref while silently dropping it. A reader of the
// output could not tell a transaction with no memo from one whose memo was
// simply not reported, which is the same absence-vs-unsearched confusion
// the embedded-record verdicts were separated to prevent.
describe("signature discovery — reports every field it projects", () => {
  it("prints the memo the adapter already projects", async () => {
    const c = await code();
    expect(c).toContain("s.memo");
  });

  it("prints memo for EVERY returned signature, not just some", async () => {
    // Inside the per-signature loop, alongside the other per-ref prints,
    // rather than a summary line outside it.
    const c = await code();
    const loop = c.indexOf("for (const [i, s] of result.signatures.entries())");
    const binding = c.indexOf("validateOnchainBinding(");
    const memo = c.indexOf("s.memo");
    expect(loop).toBeGreaterThan(-1);
    expect(memo).toBeGreaterThan(loop);
    expect(memo).toBeLessThan(binding);
  });

  it("every field of the typed ref reaches the output", async () => {
    const c = await code();
    for (const field of ["s.signature", "s.slot", "s.blockTime", "s.err", "s.memo"]) {
      expect(c, `projected field ${field} is never printed`).toContain(field);
    }
  });

  it("labels memo as selection metadata, never as evidence", async () => {
    // A memo is arbitrary text chosen by the sender. Printing it without
    // that label invites reading "burn" in a memo as proof of a burn.
    const raw = await source();
    expect(raw).toContain("selection metadata only");
  });
});

// THE GATE ACCEPTS TWO PROVENANCE CLASSES, AND THE PROSE MUST SAY SO.
//
// The header claimed the subject must be a confirmed DOCUMENTARY_LOCATOR
// while the code called resolveOnchainSubject, which admits a
// DERIVED_ONCHAIN_SUBJECT too — and did, for a token account discovered by
// a previous read. Documentation that understates what an entrypoint
// accepts is a false guarantee, and the next reader audits the comment.
describe("signature discovery — documented provenance matches enforced provenance", () => {
  it("resolves the subject through the two-class gate", async () => {
    const c = await code();
    expect(c).toContain("resolveOnchainSubject(");
    expect(c).toContain("eligibility.eligible");
  });

  it("the header does not claim DOCUMENTARY_LOCATOR is the only class", async () => {
    const raw = await source();
    const header = raw.slice(0, raw.indexOf("import "));
    expect(header).not.toContain("THE SUBJECT MUST BE A CONFIRMED DOCUMENTARY LOCATOR");
  });

  it("the header names BOTH classes the gate accepts", async () => {
    const raw = await source();
    const header = raw.slice(0, raw.indexOf("import "));
    expect(header).toContain("DOCUMENTARY_LOCATOR");
    expect(header).toContain("DERIVED_ONCHAIN_SUBJECT");
  });

  it("the header still denies the derived class any authority", async () => {
    // Eligible to be READ is not authoritative. Naming the second class
    // must not read as granting it documentary weight.
    const raw = await source();
    const header = normalize(raw.slice(0, raw.indexOf("import ")));
    expect(header).toContain("no document authority");
  });
});
