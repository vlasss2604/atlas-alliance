import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectMemoryItems, projects } from "../src/server/db/schema";
import {
  SUPPORTED_CHAINS,
  explorerLocatorsForIdentity,
  parseProjectIdentity,
  resolveConfirmedIdentity,
} from "../src/server/domain/project-identity";
import {
  confirmProjectIdentity,
  validateIdentityInput,
} from "../src/server/memory/project-identity-confirmation";
import { promoteProjectMemoryItem } from "../src/server/memory/lifecycle";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// STATING WHICH ENTITY A PROJECT IS, AND ONLY THAT.
//
// D-133 exists because a live run found an unrelated Ethereum ERC-20 that
// merely matched a name and used it to support claims about a Solana
// asset. The cure was to address projects by a human-confirmed identifier
// — and confirming one had no supported path at all. Nothing in the
// repository ever inserted a PROJECT_IDENTITY row, while five owner
// scripts and the S4 acquisition plan read one and correctly refuse
// without it.
//
// What this tool must NOT become is a way to discover, infer or replace an
// identity. The tests below pin that structurally — the import graph
// contains no chain, no web, no model — rather than by convention.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// A real Solana mint shape, and a real EVM contract shape. Deliberately
// not any actual project's values: this capability has no project-specific
// behaviour and these tests must not smuggle one in.
const SOL_MINT = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm";
const SOL_MINT_2 = "7KpLmNqRsTuVwXyZaBcDeFgHjKmNpQrStUvWxYzAbCdE";
const EVM_ADDR = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";

async function makeProject(): Promise<{ id: string; slug: string }> {
  const slug = uniq("cpi");
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Identity Test Project", ticker: null, status: "ACTIVE_CORE" })
    .returning();
  return { id: p.id, slug };
}

// An ACTIVE identity planted the legal way — insert OBSERVED, then use the
// same lifecycle function production uses.
async function plantActiveIdentity(projectId: string, content: Record<string, unknown>): Promise<void> {
  const [row] = await ctx.db
    .insert(projectMemoryItems)
    .values({ projectId, kind: "PROJECT_IDENTITY", content, lifecycleState: "OBSERVED" })
    .returning();
  await promoteProjectMemoryItem(ctx.db, row.id);
}

// ---------------------------------------------------------------------
// 1. The happy path, and what it grants
// ---------------------------------------------------------------------

describe("1. a valid identity becomes ACTIVE and resolves", () => {
  it("creates one ACTIVE PROJECT_IDENTITY with exactly the contract's fields", async () => {
    const p = await makeProject();
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT,
      ticker: "TEST",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "PROJECT_IDENTITY")));
    expect(rows.length).toBe(1);
    expect(rows[0].lifecycleState).toBe("ACTIVE");
    expect(rows[0].content).toEqual({ chain: "solana", tokenAddress: SOL_MINT, ticker: "TEST" });
    // Auditability comes from the schema's own fields, not invented ones.
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows[0].supersededBy).toBeNull();
  });

  it("THE PRODUCTION RESOLVER returns exactly what was confirmed", async () => {
    const p = await makeProject();
    await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT,
      ticker: "TEST",
    });
    // Read back independently of the tool's own return value.
    const identity = await resolveConfirmedIdentity(ctx.db, p.id);
    expect(identity).not.toBeNull();
    expect(identity!.chain).toBe("solana");
    expect(identity!.tokenAddress).toBe(SOL_MINT);
    expect(identity!.ticker).toBe("TEST");
  });

  it("a chain-only identity is legitimate, and yields no explorer locator", async () => {
    // The schema makes tokenAddress optional on purpose: a project may be
    // confirmed on a chain before its token is. Without an address there
    // is no locator at all — the chain alone does not make a shared
    // explorer safe to search by name.
    const p = await makeProject();
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: p.slug, chain: "solana" });
    expect(r.ok).toBe(true);
    const identity = await resolveConfirmedIdentity(ctx.db, p.id);
    expect(identity).toMatchObject({ chain: "solana", tokenAddress: null });
    expect(explorerLocatorsForIdentity(identity!)).toEqual([]);
  });

  it("a confirmed identity produces address-targeted explorer locators", async () => {
    const p = await makeProject();
    await confirmProjectIdentity(ctx.db, { projectSlug: p.slug, chain: "solana", tokenAddress: SOL_MINT });
    const identity = await resolveConfirmedIdentity(ctx.db, p.id);
    const locators = explorerLocatorsForIdentity(identity!);
    expect(locators.length).toBeGreaterThan(0);
    // Targeted by ADDRESS, never by project name — the whole point of D-133.
    for (const l of locators) {
      expect(l).toContain(SOL_MINT);
      expect(l).toMatch(/^site:/);
    }
  });

  it("an EVM identity is accepted with an EVM-shaped address", async () => {
    const p = await makeProject();
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "ethereum",
      tokenAddress: EVM_ADDR,
    });
    expect(r.ok).toBe(true);
    const identity = await resolveConfirmedIdentity(ctx.db, p.id);
    expect(identity).toMatchObject({ chain: "ethereum", tokenAddress: EVM_ADDR });
  });
});

// ---------------------------------------------------------------------
// 2. The conflict guard — the silent-ignore hazard
// ---------------------------------------------------------------------

describe("2. it never creates a second ACTIVE identity", () => {
  it("a DIFFERENT identity is refused — a second row would be silently ignored", async () => {
    // resolveConfirmedIdentity sorts ACTIVE rows by createdAt and returns
    // the FIRST valid one. So a second row does not replace anything and
    // does not conflict loudly: the older record keeps deciding what the
    // project is, and the owner gets no error and no effect.
    const p = await makeProject();
    await plantActiveIdentity(p.id, { chain: "solana", tokenAddress: SOL_MINT });
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT_2,
    });
    expect(r).toMatchObject({ ok: false, refusal: "ACTIVE_IDENTITY_EXISTS" });
    if (r.ok) return;
    // The operator is told what identity actually resolves, not what some
    // row happens to contain.
    expect(r.existing).toMatchObject({ chain: "solana", tokenAddress: SOL_MINT });
  });

  it("an IDENTICAL identity is refused too, rather than duplicated", async () => {
    const p = await makeProject();
    await plantActiveIdentity(p.id, { chain: "solana", tokenAddress: SOL_MINT });
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT,
    });
    expect(r).toMatchObject({ ok: false, refusal: "ACTIVE_IDENTITY_EXISTS" });
  });

  it("a cross-chain identity is refused rather than co-existing", async () => {
    const p = await makeProject();
    await plantActiveIdentity(p.id, { chain: "solana", tokenAddress: SOL_MINT });
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "ethereum",
      tokenAddress: EVM_ADDR,
    });
    expect(r).toMatchObject({ ok: false, refusal: "ACTIVE_IDENTITY_EXISTS" });
  });

  it("NOTHING is superseded, and the existing identity still resolves unchanged", async () => {
    const p = await makeProject();
    await plantActiveIdentity(p.id, { chain: "solana", tokenAddress: SOL_MINT });
    const before = await resolveConfirmedIdentity(ctx.db, p.id);
    await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT_2,
    });
    const after = await resolveConfirmedIdentity(ctx.db, p.id);
    expect(after).toEqual(before);
    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "PROJECT_IDENTITY")));
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.supersededBy === null)).toBe(true);
    expect(rows.every((r) => r.lifecycleState === "ACTIVE")).toBe(true);
  });

  it("a non-ACTIVE identity never blocks, and is never resurrected", async () => {
    const p = await makeProject();
    await ctx.db.insert(projectMemoryItems).values({
      projectId: p.id,
      kind: "PROJECT_IDENTITY",
      content: { chain: "solana", tokenAddress: SOL_MINT_2 },
      lifecycleState: "OBSERVED",
    });
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT,
    });
    expect(r.ok).toBe(true);
    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "PROJECT_IDENTITY")));
    expect(rows.filter((x) => x.lifecycleState === "OBSERVED").length).toBe(1);
    expect(rows.filter((x) => x.lifecycleState === "ACTIVE").length).toBe(1);
  });

  it("a SOURCE_ROUTE for the same project is untouched and does not interfere", async () => {
    const p = await makeProject();
    await ctx.db.insert(projectMemoryItems).values({
      projectId: p.id,
      kind: "SOURCE_ROUTE",
      content: { domain: "docs.example.test", pathPrefix: "/" },
      lifecycleState: "OBSERVED",
    });
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: p.slug, chain: "solana" });
    expect(r.ok).toBe(true);
    const routes = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
    expect(routes.length).toBe(1);
    expect(routes[0].lifecycleState).toBe("OBSERVED");
  });
});

// ---------------------------------------------------------------------
// 3. Validation, fail-closed
// ---------------------------------------------------------------------

describe("3. malformed input is refused, not normalized into something plausible", () => {
  it("an unsupported chain is refused", () => {
    for (const chain of ["hyperliquid", "sui", "bitcoin", "", "SOLANA_MAINNET", "mainnet"]) {
      const r = validateIdentityInput({ projectSlug: "x", chain });
      expect(r.ok, chain).toBe(false);
      if (!r.ok) expect(r.refusal).toBe("UNSUPPORTED_CHAIN");
    }
  });

  it("every supported chain is accepted", () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(validateIdentityInput({ projectSlug: "x", chain }).ok, chain).toBe(true);
    }
  });

  it("a malformed Solana mint is refused", () => {
    for (const token of [
      "not-base58!",
      "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // EVM address under solana
      "abc", // too short
      "I0Ol" + "1".repeat(40), // base58 excludes I, 0, O, l
      "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm" + "extra-too-long-aaaaaaaaaaa",
    ]) {
      const r = validateIdentityInput({ projectSlug: "x", chain: "solana", tokenAddress: token });
      expect(r.ok, token.slice(0, 24)).toBe(false);
      if (!r.ok) expect(r.refusal).toBe("TOKEN_SHAPE_MISMATCH");
    }
  });

  it("a Solana mint filed under an EVM chain is refused — cross-chain contamination", () => {
    const r = validateIdentityInput({ projectSlug: "x", chain: "ethereum", tokenAddress: SOL_MINT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("TOKEN_SHAPE_MISMATCH");
  });

  it("an empty token given explicitly is refused rather than dropped", () => {
    const r = validateIdentityInput({ projectSlug: "x", chain: "solana", tokenAddress: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("EMPTY_TOKEN");
  });

  it("an over-long ticker is refused", () => {
    const r = validateIdentityInput({ projectSlug: "x", chain: "solana", ticker: "T".repeat(33) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("TICKER_TOO_LONG");
  });

  it("EXTRA FIELDS cannot enter content — the schema is strict", () => {
    // `network` is the specific one worth pinning: it is a plausible-
    // sounding field the contract simply does not have, and storing it
    // would create a value nothing reads.
    const r = validateIdentityInput({
      projectSlug: "x",
      chain: "solana",
      // deliberately shaped like a caller passing an unsupported option
      ...({ network: "mainnet", explorer: "solscan.io" } as object),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.content).sort()).toEqual(["chain"]);
    expect(JSON.stringify(r.content)).not.toContain("network");
    expect(JSON.stringify(r.content)).not.toContain("explorer");
  });

  it("what is stored round-trips through the domain parser unchanged", async () => {
    const p = await makeProject();
    await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT,
    });
    const [row] = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "PROJECT_IDENTITY")));
    // The stored blob is readable by the SAME parser production uses; a
    // record this tool writes can never be one the resolver rejects.
    expect(parseProjectIdentity(row.content)).toMatchObject({
      chain: "solana",
      tokenAddress: SOL_MINT,
    });
  });

  it("an unknown project is refused before anything is written", async () => {
    const before = await ctx.db.select().from(projectMemoryItems);
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: "no-such-project-slug",
      chain: "solana",
      tokenAddress: SOL_MINT,
    });
    expect(r).toMatchObject({ ok: false, refusal: "UNKNOWN_PROJECT" });
    const after = await ctx.db.select().from(projectMemoryItems);
    expect(after.length).toBe(before.length);
  });

  it("a refused input writes nothing at all", async () => {
    const p = await makeProject();
    await confirmProjectIdentity(ctx.db, { projectSlug: p.slug, chain: "dogecoin" });
    await confirmProjectIdentity(ctx.db, { projectSlug: p.slug, chain: "solana", tokenAddress: "!!!" });
    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.projectId, p.id));
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// 4. The on-chain gate now sees an identity
// ---------------------------------------------------------------------

describe("4. the identity requirement is satisfied, and nothing beyond it runs", () => {
  it("the gate every on-chain entrypoint applies now passes", async () => {
    // Five owner scripts and the S4 acquisition plan all resolve the
    // identity and refuse when it is null. This is that exact call —
    // and the test stops here, before any transport.
    const p = await makeProject();
    expect(await resolveConfirmedIdentity(ctx.db, p.id)).toBeNull();
    await confirmProjectIdentity(ctx.db, {
      projectSlug: p.slug,
      chain: "solana",
      tokenAddress: SOL_MINT,
    });
    const identity = await resolveConfirmedIdentity(ctx.db, p.id);
    expect(identity).not.toBeNull();
    expect(identity!.chain).toBe("solana");
    // What the plan would then carry into acquisition: address-targeted
    // locators, and no RPC has been issued to produce them.
    expect(explorerLocatorsForIdentity(identity!).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
// 5. The entrypoint's structural boundaries
// ---------------------------------------------------------------------

async function scriptCode(): Promise<string> {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(
    new URL("../scripts/confirm-project-identity.ts", import.meta.url),
    "utf-8",
  );
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

async function moduleSource(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(
    new URL("../src/server/memory/project-identity-confirmation.ts", import.meta.url),
    "utf-8",
  );
}

describe("5. the entrypoint can do one thing", () => {
  it("discovers nothing: no chain, no web, no search, no model", async () => {
    const code = await scriptCode();
    const mod = await moduleSource();
    for (const banned of [
      "onchain-",
      "content-fetcher",
      "rendered-docs",
      "search-gateway",
      "query-proposer",
      "evidence-extractor",
      "anthropic",
      "Anthropic",
      "fetch(",
      "node:http",
      "undici",
      "rpc",
      "Rpc",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
      expect(mod, `module references "${banned}"`).not.toContain(banned);
    }
  });

  it("creates no Evidence and enters no part of S5–S7", async () => {
    const code = await scriptCode();
    const mod = await moduleSource();
    for (const banned of [
      "evidence",
      "component-reconciliation",
      "mechanism-assembl",
      "claim-evaluator",
      "proofs",
      "research-jobs",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
      expect(mod, `module references "${banned}"`).not.toContain(banned);
    }
  });

  it("exposes no --network option, and refuses one loudly", async () => {
    const code = await scriptCode();
    // The contract has no such field; silently dropping it would let an
    // operator believe they had pinned a network.
    expect(code).toContain("network");
    expect(code).toMatch(/refusing/i);
    // And it is never written into content.
    const executable = code
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    expect(executable).not.toMatch(/network\s*:/);
  });

  it("uses the EXISTING lifecycle function rather than its own transitions", async () => {
    const code = await scriptCode();
    const mod = await moduleSource();
    expect(mod).toContain("promoteProjectMemoryItem");
    for (const banned of ['lifecycleState: "CANDIDATE"', 'lifecycleState: "ACTIVE"']) {
      expect(mod, `module writes ${banned} directly`).not.toContain(banned);
      expect(code, `script writes ${banned} directly`).not.toContain(banned);
    }
    expect(mod).toContain('lifecycleState: "OBSERVED"');
  });

  it("supersedes nothing and writes no raw SQL", async () => {
    const code = await scriptCode();
    const mod = await moduleSource();
    for (const banned of ["supersededBy", "SUPERSEDED", "DEPRECATED", "delete(", "update(", "sql`", "execute("]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
      expect(mod, `module references "${banned}"`).not.toContain(banned);
    }
  });

  it("reuses the domain module's validation rather than restating it", async () => {
    const mod = await moduleSource();
    // The shape rules and the chain list live in one place; a second copy
    // would be a second notion of what an identity is.
    expect(mod).toContain("addressShapeMatchesChain");
    expect(mod).toContain("projectIdentityContentSchema");
    expect(mod).toContain("SUPPORTED_CHAINS");
    // And the result is verified through the production resolver.
    expect(mod).toContain("resolveConfirmedIdentity");
  });
});
