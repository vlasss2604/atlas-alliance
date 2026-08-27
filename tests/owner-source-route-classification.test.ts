import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, projectMemoryItems, projects } from "../src/server/db/schema";
import { evaluateInspectionEligibility } from "../src/server/engine/inspection-eligibility";
import {
  evaluateRefusalRenderEligibility,
  evaluateRenderEligibility,
} from "../src/server/engine/rendered-docs-policy";
import { VALID_ROUTE_CLASSES, resolveSourceRoute } from "../src/server/engine/source-authority";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { promoteProjectMemoryItem } from "../src/server/memory/lifecycle";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// CLASSIFYING A ROUTE IS THE OWNER'S SECOND DECISION.
//
// Confirming that a host belongs to a project and deciding that a page
// carries documentary authority are different judgements, and the second
// should follow reading the page. The confirmation tool deliberately
// assigns no class; this one deliberately cannot confirm a host.
//
// The dangerous part is not the class — it is the TRANSITION. An ACTIVE
// project-memory row is an authoritative human statement, so it is
// REPLACED rather than edited, and `resolveSourceRoute` reports
// `matchedPathPrefix` only when exactly one path-scoped row matched. Two
// co-matching ACTIVE rows — even for an instant — make the prefix vanish,
// and a crash between the two writes would leave it vanished. So the whole
// swap is one transaction, and it is verified against the real resolver
// afterwards rather than argued for.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const HOST = "docs.classify-route.test";
const OTHER_HOST = "gov.classify-route.test";

async function makeProject(): Promise<{ id: string; slug: string }> {
  const slug = uniq("csrc");
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Classify Route Test Project", ticker: null, status: "ACTIVE_CORE" })
    .returning();
  return { id: p.id, slug };
}

// Confirms a route through the real confirmation tool and returns its id —
// so these tests exercise the actual pairing of the two owner acts.
async function confirmed(slug: string, projectId: string, domain: string, prefix: string): Promise<string> {
  const r = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain, pathPrefix: prefix });
  expect(r.ok).toBe(true);
  const rows = await ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, projectId), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
  const row = rows.find(
    (x) => x.lifecycleState === "ACTIVE" && JSON.stringify(x.content).includes(domain),
  );
  return row!.id;
}

const url = (host: string, path = "/") => `https://${host}${path}`;

// ---------------------------------------------------------------------
// 1. The transition itself
// ---------------------------------------------------------------------

describe("1. an exact ACTIVE unclassified route becomes classified", () => {
  it("classifies, preserving domain and prefix exactly", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    const r = await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.domain).toBe(HOST);
    expect(r.pathPrefix).toBe("/docs");
    expect(r.routeClass).toBe("OFFICIAL_DOCS");
  });

  it("REPLACES rather than edits: the original is SUPERSEDED and linked", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    const r = await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
    const old = rows.find((x) => x.id === id)!;
    const created = rows.find((x) => x.id === r.newItemId)!;

    expect(old.lifecycleState).toBe("SUPERSEDED");
    expect(old.supersededBy).toBe(created.id);
    // The original content is untouched — it is history, not a draft.
    expect(old.content).toEqual({ domain: HOST, pathPrefix: "/docs" });

    expect(created.lifecycleState).toBe("ACTIVE");
    expect(created.content).toEqual({
      domain: HOST,
      pathPrefix: "/docs",
      routeClass: "OFFICIAL_DOCS",
    });
    expect(created.supersededBy).toBeNull();
  });

  it("leaves EXACTLY ONE ACTIVE route for that domain", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    const active = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(
        and(
          eq(projectMemoryItems.projectId, p.id),
          eq(projectMemoryItems.kind, "SOURCE_ROUTE"),
          eq(projectMemoryItems.lifecycleState, "ACTIVE"),
        ),
      );
    expect(active.length).toBe(1);
  });

  it("a root-prefix route classifies the same way", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/");
    const r = await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pathPrefix).toBe("/");
    const resolved = await resolveSourceRoute(ctx.db, p.id, url(HOST));
    expect(resolved).toMatchObject({ routeClass: "OFFICIAL_DOCS", matchedPathPrefix: "/" });
  });

  it("every class in the closed enum is supported", async () => {
    for (const cls of VALID_ROUTE_CLASSES) {
      const p = await makeProject();
      const id = await confirmed(p.slug, p.id, HOST, "/docs");
      const r = await classifySourceRoute(ctx.db, { routeId: id, routeClass: cls });
      expect(r.ok, cls).toBe(true);
      const resolved = await resolveSourceRoute(ctx.db, p.id, url(HOST, "/docs"));
      expect(resolved.routeClass).toBe(cls);
    }
  });
});

// ---------------------------------------------------------------------
// 2. The gates, before and after
// ---------------------------------------------------------------------

describe("2. exactly one gate opens, and only for the exact route", () => {
  it("BEFORE: inspection allowed, evidentiary and renderer-as-Evidence refused", async () => {
    const p = await makeProject();
    await confirmed(p.slug, p.id, HOST, "/docs");
    const u = url(HOST, "/docs");
    const route = await resolveSourceRoute(ctx.db, p.id, u);
    expect(route).toMatchObject({
      officiality: "CONFIRMED",
      routeClass: null,
      matchedPathPrefix: "/docs",
    });
    expect(evaluateInspectionEligibility(u, route).eligible).toBe(true);
    // The scope gate alpha-acquire-url applies.
    expect(route.officiality !== "CONFIRMED" || route.routeClass === null).toBe(true);
    expect(
      evaluateRenderEligibility({
        url: u,
        route,
        staticHtmlBytes: 500_000,
        staticTextLength: 5,
        rendererEnabled: true,
      }),
    ).toMatchObject({ eligible: false, reason: "NOT_OFFICIAL_DOCS" });
  });

  it("AFTER: evidentiary and renderer gates pass, inspection closes", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    const u = url(HOST, "/docs");
    const route = await resolveSourceRoute(ctx.db, p.id, u);

    expect(route).toMatchObject({
      officiality: "CONFIRMED",
      routeClass: "OFFICIAL_DOCS",
      // SAME exact prefix — the point of the whole transition.
      matchedPathPrefix: "/docs",
    });
    expect(route.officiality !== "CONFIRMED" || route.routeClass === null).toBe(false);
    expect(
      evaluateRenderEligibility({
        url: u,
        route,
        staticHtmlBytes: 500_000,
        staticTextLength: 5,
        rendererEnabled: true,
      }).eligible,
    ).toBe(true);
    expect(
      evaluateRefusalRenderEligibility({ url: u, route, rendererEnabled: true, httpStatus: 403 })
        .eligible,
    ).toBe(true);
    // Inspection is for the UNDECIDED case; a classified route is no
    // longer one, and correctly stops being an inspection subject.
    expect(evaluateInspectionEligibility(u, route)).toMatchObject({
      eligible: false,
      reason: "ALREADY_CLASSIFIED",
    });
  });

  it("AUTHORITY DOES NOT WIDEN: a url outside the prefix stays outside", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    for (const outside of ["/", "/marketing", "/docsomething", "/other/docs"]) {
      const r = await resolveSourceRoute(ctx.db, p.id, url(HOST, outside));
      // The domain is confirmed host-wide, but the CLASS is path-scoped
      // and does not reach beyond the prefix.
      expect(r.officiality, outside).toBe("CONFIRMED");
      expect(r.routeClass, outside).toBeNull();
      expect(r.matchedPathPrefix, outside).toBeNull();
    }
  });

  it("a url BENEATH the prefix is inside, as segment-bounded matching intends", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    const r = await resolveSourceRoute(ctx.db, p.id, url(HOST, "/docs/fees"));
    expect(r).toMatchObject({ routeClass: "OFFICIAL_DOCS", matchedPathPrefix: "/docs" });
  });

  it("a NEIGHBOURING route resolves byte-identically afterwards", async () => {
    const p = await makeProject();
    const otherId = await confirmed(p.slug, p.id, OTHER_HOST, "/");
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    const before = await resolveSourceRoute(ctx.db, p.id, url(OTHER_HOST));
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    const after = await resolveSourceRoute(ctx.db, p.id, url(OTHER_HOST));
    expect(after).toEqual(before);
    // And the neighbour is still ACTIVE and unclassified.
    const [row] = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.id, otherId));
    expect(row.lifecycleState).toBe("ACTIVE");
    expect(row.supersededBy).toBeNull();
  });

  it("a NON-overlapping route on the SAME domain is unaffected", async () => {
    const p = await makeProject();
    const a = await confirmed(p.slug, p.id, HOST, "/docs");
    // /token does not overlap /docs, so confirmation allows it.
    const r2 = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/token" });
    expect(r2.ok).toBe(true);
    const before = await resolveSourceRoute(ctx.db, p.id, url(HOST, "/token"));
    await classifySourceRoute(ctx.db, { routeId: a, routeClass: "OFFICIAL_DOCS" });
    const after = await resolveSourceRoute(ctx.db, p.id, url(HOST, "/token"));
    expect(after).toEqual(before);
    expect(after.routeClass).toBeNull();
  });
});

// ---------------------------------------------------------------------
// 3. Fail-closed
// ---------------------------------------------------------------------

describe("3. it refuses anything that is not an exact unclassified ACTIVE route", () => {
  it("an unknown route id is refused", async () => {
    const r = await classifySourceRoute(ctx.db, {
      routeId: "00000000-0000-0000-0000-000000000000",
      routeClass: "OFFICIAL_DOCS",
    });
    expect(r).toMatchObject({ ok: false, refusal: "ROUTE_NOT_FOUND" });
  });

  it("the wrong memory kind is refused", async () => {
    const p = await makeProject();
    const [row] = await ctx.db
      .insert(projectMemoryItems)
      .values({
        projectId: p.id,
        kind: "PROJECT_IDENTITY",
        content: { chain: "solana" },
        lifecycleState: "OBSERVED",
      })
      .returning();
    await promoteProjectMemoryItem(ctx.db, row.id);
    const r = await classifySourceRoute(ctx.db, { routeId: row.id, routeClass: "OFFICIAL_DOCS" });
    expect(r).toMatchObject({ ok: false, refusal: "NOT_A_SOURCE_ROUTE" });
  });

  it("a non-ACTIVE route is refused", async () => {
    const p = await makeProject();
    const [row] = await ctx.db
      .insert(projectMemoryItems)
      .values({
        projectId: p.id,
        kind: "SOURCE_ROUTE",
        content: { domain: HOST, pathPrefix: "/docs" },
        lifecycleState: "OBSERVED",
      })
      .returning();
    const r = await classifySourceRoute(ctx.db, { routeId: row.id, routeClass: "OFFICIAL_DOCS" });
    expect(r).toMatchObject({ ok: false, refusal: "ROUTE_NOT_ACTIVE" });
  });

  it("an already-classified route is refused — re-classification is a different decision", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    const first = await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = await classifySourceRoute(ctx.db, {
      routeId: first.newItemId,
      routeClass: "GOVERNANCE",
    });
    expect(again).toMatchObject({ ok: false, refusal: "ALREADY_CLASSIFIED" });
  });

  it("an unsupported class is refused, with no silent fallback", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    for (const cls of ["", "official_docs", "OFFICIAL", "SOCIAL", "ONCHAIN_VERIFIABLE", "DOCS "]) {
      const r = await classifySourceRoute(ctx.db, { routeId: id, routeClass: cls });
      expect(r, cls).toMatchObject({ ok: false, refusal: "UNSUPPORTED_ROUTE_CLASS" });
    }
    // And nothing was written by any of those attempts.
    const [row] = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.id, id));
    expect(row.lifecycleState).toBe("ACTIVE");
    expect(row.content).toEqual({ domain: HOST, pathPrefix: "/docs" });
  });

  it("malformed route content is refused", async () => {
    const p = await makeProject();
    const [row] = await ctx.db
      .insert(projectMemoryItems)
      .values({ projectId: p.id, kind: "SOURCE_ROUTE", content: { notADomain: 1 }, lifecycleState: "OBSERVED" })
      .returning();
    await promoteProjectMemoryItem(ctx.db, row.id);
    const r = await classifySourceRoute(ctx.db, { routeId: row.id, routeClass: "OFFICIAL_DOCS" });
    expect(r).toMatchObject({ ok: false, refusal: "MALFORMED_ROUTE_CONTENT" });
  });

  it("a refusal writes nothing at all", async () => {
    const p = await makeProject();
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    const before = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.projectId, p.id));
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "NOPE" });
    const after = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.projectId, p.id));
    expect(after.length).toBe(before.length);
    expect(after.map((r) => r.lifecycleState).sort()).toEqual(
      before.map((r) => r.lifecycleState).sort(),
    );
  });

  it("nothing unrelated is ever superseded", async () => {
    const p = await makeProject();
    const otherId = await confirmed(p.slug, p.id, OTHER_HOST, "/");
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.projectId, p.id));
    const superseded = rows.filter((r) => r.lifecycleState === "SUPERSEDED");
    expect(superseded.length).toBe(1);
    expect(superseded[0].id).toBe(id);
    expect(rows.find((r) => r.id === otherId)!.lifecycleState).toBe("ACTIVE");
  });

  it("no Evidence is created by classification", async () => {
    const p = await makeProject();
    const before = await ctx.db.select().from(evidence);
    const id = await confirmed(p.slug, p.id, HOST, "/docs");
    await classifySourceRoute(ctx.db, { routeId: id, routeClass: "OFFICIAL_DOCS" });
    const after = await ctx.db.select().from(evidence);
    expect(after.length).toBe(before.length);
  });
});

// ---------------------------------------------------------------------
// 4. The entrypoint's structural boundaries
// ---------------------------------------------------------------------

async function readFile(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf-8");
}

async function scriptCode(): Promise<string> {
  const raw = await readFile("../scripts/classify-source-route.ts");
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("4. the entrypoint can do one thing", () => {
  it("acquires nothing: no fetch, renderer, search, RPC or model", async () => {
    const code = await scriptCode();
    const mod = await readFile("../src/server/memory/source-route-classification.ts");
    for (const banned of [
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
      "onchain",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
      expect(mod, `module references "${banned}"`).not.toContain(banned);
    }
  });

  it("creates no Evidence and enters no part of S5–S7", async () => {
    const code = await scriptCode();
    const mod = await readFile("../src/server/memory/source-route-classification.ts");
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

  it("cannot confirm a host: --domain, --prefix and --project are refused", async () => {
    const code = await scriptCode();
    for (const flag of ["domain", "prefix", "path-prefix", "project"]) {
      expect(code).toContain(flag);
    }
    expect(code).toMatch(/refusing/i);
    // The route is identified by id, never looked up fuzzily.
    expect(code).toContain("route-id");
  });

  it("reuses the lifecycle machinery rather than its own transitions", async () => {
    const mod = await readFile("../src/server/memory/source-route-classification.ts");
    expect(mod).toContain("promoteProjectMemoryItem");
    expect(mod).toContain("supersedeProjectMemoryItem");
    for (const banned of ['lifecycleState: "CANDIDATE"', 'lifecycleState: "ACTIVE"', 'lifecycleState: "SUPERSEDED"']) {
      expect(mod, `module writes ${banned} directly`).not.toContain(banned);
    }
    expect(mod).toContain('lifecycleState: "OBSERVED"');
  });

  it("writes no raw SQL and reuses the closed class vocabulary", async () => {
    const code = await scriptCode();
    const mod = await readFile("../src/server/memory/source-route-classification.ts");
    for (const banned of ["sql`", "execute(", "INSERT INTO", "UPDATE "]) {
      expect(code).not.toContain(banned);
      expect(mod).not.toContain(banned);
    }
    expect(mod).toContain("isValidRouteClass");
    expect(mod).toContain("VALID_ROUTE_CLASSES");
    // And it verifies through the real resolver rather than asserting.
    expect(mod).toContain("resolveSourceRoute");
  });
});
