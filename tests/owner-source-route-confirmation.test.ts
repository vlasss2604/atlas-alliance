import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectMemoryItems, projects } from "../src/server/db/schema";
import { evaluateInspectionEligibility } from "../src/server/engine/inspection-eligibility";
import {
  evaluateRefusalRenderEligibility,
  evaluateRenderEligibility,
} from "../src/server/engine/rendered-docs-policy";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import {
  confirmSourceRoute,
  validateDomain,
  validatePathPrefix,
} from "../src/server/memory/source-route-confirmation";
import { promoteProjectMemoryItem } from "../src/server/memory/lifecycle";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// CONFIRMING A ROUTE IS AN OWNER DECISION, AND ONLY ONE OF THEM.
//
// Nothing implemented D-021/D-055 for project_memory_items: every owner
// entrypoint is banned from route management by its own boundary test, and
// the project-item lifecycle function had no caller anywhere. So a domain
// could not be confirmed at all without hand-written SQL.
//
// What this tool must NOT become is the place where classification quietly
// happens too. Confirming that a host belongs to a project and deciding
// that a page carries documentation authority are different judgements,
// and the second should follow reading the page. The tests below pin that
// separation structurally — there is no parameter to reach — rather than
// by convention.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function makeProject(): Promise<{ id: string; slug: string }> {
  const slug = uniq("csr");
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Confirm Route Test Project", ticker: null, status: "ACTIVE_CORE" })
    .returning();
  return { id: p.id, slug };
}

// An ACTIVE route planted the legal way — insert OBSERVED, then use the
// same lifecycle function production uses.
async function plantActiveRoute(projectId: string, content: Record<string, unknown>): Promise<void> {
  const [row] = await ctx.db
    .insert(projectMemoryItems)
    .values({ projectId, kind: "SOURCE_ROUTE", content, lifecycleState: "OBSERVED" })
    .returning();
  await promoteProjectMemoryItem(ctx.db, row.id);
}

const HOST = "docs.confirm-route.test";

// ---------------------------------------------------------------------
// 1. The happy path, and what it grants
// ---------------------------------------------------------------------

describe("1. a valid exact host and prefix becomes ACTIVE, unclassified", () => {
  it("creates one ACTIVE SOURCE_ROUTE with routeClass absent", async () => {
    const p = await makeProject();
    const result = await confirmSourceRoute(ctx.db, {
      projectSlug: p.slug,
      domain: HOST,
      pathPrefix: "/",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
    expect(rows.length).toBe(1);
    expect(rows[0].lifecycleState).toBe("ACTIVE");
    // routeClass is ABSENT, not null-valued: there is no key to fill in.
    expect(rows[0].content).toEqual({ domain: HOST, pathPrefix: "/" });
    expect(Object.keys(rows[0].content as object)).not.toContain("routeClass");
    // Auditability comes from the schema's own fields, not invented ones.
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows[0].kind).toBe("SOURCE_ROUTE");
  });

  it("the resolver agrees: CONFIRMED, routeClass null, the expected prefix", async () => {
    const p = await makeProject();
    const r = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.officiality).toBe("CONFIRMED");
    expect(r.resolved.routeClass).toBeNull();
    expect(r.resolved.matchedPathPrefix).toBe("/");
    expect(r.resolved.observation).toBeNull();

    // Re-read independently of the returned value.
    const again = await resolveSourceRoute(ctx.db, p.id, `https://${HOST}/`);
    expect(again).toMatchObject({ officiality: "CONFIRMED", routeClass: null, matchedPathPrefix: "/" });
  });

  it("opens NON-EVIDENTIARY inspection, and nothing else", async () => {
    const p = await makeProject();
    await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/" });
    const url = `https://${HOST}/`;
    const route = await resolveSourceRoute(ctx.db, p.id, url);

    // Inspection: allowed.
    const inspect = evaluateInspectionEligibility(url, route);
    expect(inspect.eligible).toBe(true);

    // Evidentiary acquisition: the scope gate alpha-acquire-url applies.
    expect(route.officiality !== "CONFIRMED" || route.routeClass === null).toBe(true);

    // Renderer AS EVIDENCE, both entry points: refused.
    expect(
      evaluateRenderEligibility({
        url,
        route,
        staticHtmlBytes: 500_000,
        staticTextLength: 5,
        rendererEnabled: true,
      }),
    ).toMatchObject({ eligible: false, reason: "NOT_OFFICIAL_DOCS" });
    expect(
      evaluateRefusalRenderEligibility({ url, route, rendererEnabled: true, httpStatus: 403 }),
    ).toMatchObject({ eligible: false, reason: "NOT_OFFICIAL_DOCS" });
  });

  it("a root prefix confirms the root and NOTHING beneath it", async () => {
    const p = await makeProject();
    await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/" });
    // The domain is confirmed, so officiality holds host-wide — but the
    // path-scoped grant does not reach a sub-path, so inspection there is
    // refused for want of a matched prefix.
    const sub = await resolveSourceRoute(ctx.db, p.id, `https://${HOST}/api/buybacks`);
    expect(sub.officiality).toBe("CONFIRMED");
    expect(sub.matchedPathPrefix).toBeNull();
    expect(evaluateInspectionEligibility(`https://${HOST}/api/buybacks`, sub)).toMatchObject({
      eligible: false,
      reason: "NO_PATH_PREFIX",
    });
  });

  it("the prefix is stored normalized by the authority's own rule", async () => {
    const p = await makeProject();
    const r = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs/" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pathPrefix).toBe("/docs");
    expect(r.resolved.matchedPathPrefix).toBe("/docs");
  });

  it("www. is stripped so the stored host is the host that will be compared", async () => {
    const p = await makeProject();
    const r = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: `www.${HOST}`, pathPrefix: "/" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.domain).toBe(HOST);
    expect(r.resolved.officiality).toBe("CONFIRMED");
  });
});

// ---------------------------------------------------------------------
// 2. Existing state — the two silent-breakage hazards
// ---------------------------------------------------------------------

describe("2. it refuses rather than damaging existing routes", () => {
  it("a duplicate ACTIVE route is refused", async () => {
    const p = await makeProject();
    await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs" });
    const again = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs" });
    expect(again).toMatchObject({ ok: false, refusal: "DUPLICATE_ACTIVE_ROUTE" });
    // And a trailing slash is the same route, not a second one.
    const slashed = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs/" });
    expect(slashed).toMatchObject({ ok: false, refusal: "DUPLICATE_ACTIVE_ROUTE" });
  });

  it("an OVERLAPPING prefix is refused — it would null the matched prefix of a working route", async () => {
    // resolveSourceRoute reports matchedPathPrefix only when EXACTLY ONE
    // path-scoped row matched. Adding a co-matching row silently disables
    // rendering and inspection for urls both cover.
    const p = await makeProject();
    await plantActiveRoute(p.id, { domain: HOST, pathPrefix: "/docs", routeClass: "OFFICIAL_DOCS" });

    // A prefix beneath the existing one.
    expect(
      await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs/fees" }),
    ).toMatchObject({ ok: false, refusal: "OVERLAPPING_ACTIVE_PREFIX" });

    // And the other direction: a prefix that would swallow the existing one.
    const p2 = await makeProject();
    await plantActiveRoute(p2.id, { domain: HOST, pathPrefix: "/docs/fees", routeClass: "OFFICIAL_DOCS" });
    expect(
      await confirmSourceRoute(ctx.db, { projectSlug: p2.slug, domain: HOST, pathPrefix: "/docs" }),
    ).toMatchObject({ ok: false, refusal: "OVERLAPPING_ACTIVE_PREFIX" });
  });

  it("the existing route it refused to damage still resolves exactly as before", async () => {
    const p = await makeProject();
    await plantActiveRoute(p.id, { domain: HOST, pathPrefix: "/docs", routeClass: "OFFICIAL_DOCS" });
    const before = await resolveSourceRoute(ctx.db, p.id, `https://${HOST}/docs/fees`);
    await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs/fees" });
    const after = await resolveSourceRoute(ctx.db, p.id, `https://${HOST}/docs/fees`);
    expect(after).toEqual(before);
    expect(after.matchedPathPrefix).toBe("/docs");
    expect(after.routeClass).toBe("OFFICIAL_DOCS");
  });

  it("a domain-wide CLASSIFIED route is refused — this one would inherit its class", async () => {
    // routeClass resolves from EVERY matching ACTIVE row, so a domain-wide
    // classified row would hand its class to this url too, and the
    // promise of "unclassified" would be false.
    const p = await makeProject();
    await plantActiveRoute(p.id, { domain: HOST, routeClass: "OFFICIAL_DOCS" });
    expect(
      await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs" }),
    ).toMatchObject({ ok: false, refusal: "WOULD_INHERIT_ROUTE_CLASS" });
  });

  it("a NON-overlapping prefix on the same domain is allowed, and both keep working", async () => {
    // The refusals must not be so broad that a legitimate second route is
    // impossible — /docs and /token coexist in production today.
    const p = await makeProject();
    await plantActiveRoute(p.id, { domain: HOST, pathPrefix: "/docs", routeClass: "OFFICIAL_DOCS" });
    const r = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/token" });
    expect(r.ok).toBe(true);
    expect((await resolveSourceRoute(ctx.db, p.id, `https://${HOST}/docs`)).routeClass).toBe("OFFICIAL_DOCS");
    const other = await resolveSourceRoute(ctx.db, p.id, `https://${HOST}/token`);
    expect(other.routeClass).toBeNull();
    expect(other.matchedPathPrefix).toBe("/token");
  });

  it("a non-ACTIVE route never blocks, and is never resurrected", async () => {
    const p = await makeProject();
    await ctx.db.insert(projectMemoryItems).values({
      projectId: p.id,
      kind: "SOURCE_ROUTE",
      content: { domain: HOST, pathPrefix: "/" },
      lifecycleState: "OBSERVED",
    });
    const r = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/" });
    expect(r.ok).toBe(true);
    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
    // The observed row is untouched — nothing is auto-superseded.
    expect(rows.filter((x) => x.lifecycleState === "OBSERVED").length).toBe(1);
    expect(rows.filter((x) => x.lifecycleState === "ACTIVE").length).toBe(1);
    expect(rows.every((x) => x.supersededBy === null)).toBe(true);
  });

  it("an unknown project is refused before anything is written", async () => {
    const before = await ctx.db.select().from(projectMemoryItems);
    expect(
      await confirmSourceRoute(ctx.db, { projectSlug: "no-such-project-slug", domain: HOST, pathPrefix: "/" }),
    ).toMatchObject({ ok: false, refusal: "UNKNOWN_PROJECT" });
    const after = await ctx.db.select().from(projectMemoryItems);
    expect(after.length).toBe(before.length);
  });
});

// ---------------------------------------------------------------------
// 3. Input validation, fail-closed
// ---------------------------------------------------------------------

describe("3. malformed input is refused, not normalized into something plausible", () => {
  const badDomains: [string, string][] = [
    ["", "EMPTY_DOMAIN"],
    ["https://fees.example.test", "DOMAIN_HAS_SCHEME"],
    ["user:pass@fees.example.test", "DOMAIN_HAS_USERINFO"],
    ["fees.example.test/docs", "DOMAIN_HAS_PATH"],
    ["fees.example.test?x=1", "DOMAIN_HAS_PATH"],
    ["*.example.test", "DOMAIN_HAS_WILDCARD"],
    ["fees.example.test:8443", "DOMAIN_HAS_PORT"],
    ["fees..example.test", "DOMAIN_NOT_A_HOSTNAME"],
    [".example.test", "DOMAIN_NOT_A_HOSTNAME"],
    ["example.test.", "DOMAIN_NOT_A_HOSTNAME"],
    ["fees example.test", "DOMAIN_NOT_A_HOSTNAME"],
    ["-bad.example.test", "DOMAIN_NOT_A_HOSTNAME"],
    ["192.168.1.10", "DOMAIN_IS_IP_LITERAL"],
    ["localhost", "DOMAIN_IS_SINGLE_LABEL"],
    ["github.com", "DOMAIN_IS_SHARED_PLATFORM_BASE"],
    ["medium.com", "DOMAIN_IS_SHARED_PLATFORM_BASE"],
  ];

  it.each(badDomains)("domain %s is refused as %s", (domain, refusal) => {
    const r = validateDomain(domain);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe(refusal);
  });

  it("a subdomain of a shared platform is still allowed — it names a tenant", () => {
    expect(validateDomain("project.gitbook.io")).toMatchObject({ ok: true, domain: "project.gitbook.io" });
  });

  const badPrefixes: [string, string][] = [
    ["", "PREFIX_EMPTY"],
    ["   ", "PREFIX_EMPTY"],
    ["docs", "PREFIX_NOT_ABSOLUTE"],
    ["https://x.test/docs", "PREFIX_HAS_SCHEME_OR_HOST"],
    ["/docs?x=1", "PREFIX_HAS_QUERY_OR_FRAGMENT"],
    ["/docs#a", "PREFIX_HAS_QUERY_OR_FRAGMENT"],
    ["/docs/*", "PREFIX_HAS_WILDCARD"],
    ["/docs/../etc", "PREFIX_HAS_TRAVERSAL"],
    ["/do cs", "PREFIX_HAS_WHITESPACE"],
  ];

  it.each(badPrefixes)("prefix %s is refused as %s", (prefix, refusal) => {
    const r = validatePathPrefix(prefix);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe(refusal);
  });

  it("valid prefixes normalize to what matching will compare", () => {
    expect(validatePathPrefix("/")).toMatchObject({ ok: true, pathPrefix: "/" });
    expect(validatePathPrefix("/docs")).toMatchObject({ ok: true, pathPrefix: "/docs" });
    expect(validatePathPrefix("/docs/")).toMatchObject({ ok: true, pathPrefix: "/docs" });
  });

  it("a malformed input writes nothing", async () => {
    const p = await makeProject();
    await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: "*.bad.test", pathPrefix: "/" });
    await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: HOST, pathPrefix: "/docs/../x" });
    const rows = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.projectId, p.id));
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// 4. The entrypoint's structural boundaries
// ---------------------------------------------------------------------
//
// Read from the source, like the four sibling boundary suites: a
// capability absent from the import graph cannot be invoked by a future
// edit without that edit failing here.

async function scriptSource(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL("../scripts/confirm-source-route.ts", import.meta.url), "utf-8");
}

async function scriptCode(): Promise<string> {
  const raw = await scriptSource();
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("4. the entrypoint can do one thing", () => {
  it("exposes NO route-class option, and assigns no class", async () => {
    const code = await scriptCode();
    // String literals are stripped first, so PRINTING the resolved class —
    // which the tool should do, and does — is not mistaken for setting one.
    // What must not exist is a routeClass being written anywhere.
    const executable = code
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    expect(executable).not.toMatch(/routeClass\s*:/);
    expect(executable).not.toMatch(/routeClass\s*=/);
    expect(code).not.toContain('"OFFICIAL_DOCS"');
    expect(code).not.toContain('"GOVERNANCE"');
    expect(code).not.toContain('"OFFICIAL_REPORT"');
  });

  it("refuses a route-class flag loudly instead of ignoring it", async () => {
    const code = await scriptCode();
    // Reaching for the flag must be an error the operator sees; silently
    // dropping it would let them believe they had classified something.
    expect(code).toContain("route-class");
    expect(code).toMatch(/refusing/i);
  });

  it("uses the EXISTING lifecycle function rather than its own transitions", async () => {
    const code = await scriptCode();
    const moduleSource = await (await import("node:fs/promises")).readFile(
      new URL("../src/server/memory/source-route-confirmation.ts", import.meta.url),
      "utf-8",
    );
    expect(moduleSource).toContain("promoteProjectMemoryItem");
    // No hand-rolled state walk anywhere in either file.
    for (const banned of ['lifecycleState: "CANDIDATE"', 'lifecycleState: "ACTIVE"']) {
      expect(moduleSource, `module writes ${banned} directly`).not.toContain(banned);
      expect(code, `script writes ${banned} directly`).not.toContain(banned);
    }
    // The only state it may insert is the one the database guard permits.
    expect(moduleSource).toContain('lifecycleState: "OBSERVED"');
  });

  it("acquires nothing: no fetch, no renderer, no search, no model", async () => {
    const code = await scriptCode();
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
    }
  });

  it("creates no Evidence and enters no part of S5–S7", async () => {
    const code = await scriptCode();
    for (const banned of [
      "evidence",
      "component-reconciliation",
      "mechanism-assembl",
      "claim-evaluator",
      "proofs",
      "research-jobs",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("does not supersede anything", async () => {
    const code = await scriptCode();
    const moduleSource = await (await import("node:fs/promises")).readFile(
      new URL("../src/server/memory/source-route-confirmation.ts", import.meta.url),
      "utf-8",
    );
    for (const banned of ["supersededBy", "SUPERSEDED", "DEPRECATED", "delete(", "update("]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
      expect(moduleSource, `module references "${banned}"`).not.toContain(banned);
    }
  });

  it("writes no raw SQL", async () => {
    const code = await scriptCode();
    const moduleSource = await (await import("node:fs/promises")).readFile(
      new URL("../src/server/memory/source-route-confirmation.ts", import.meta.url),
      "utf-8",
    );
    for (const banned of ["sql`", "execute(", "INSERT INTO", "UPDATE "]) {
      expect(code).not.toContain(banned);
      expect(moduleSource).not.toContain(banned);
    }
  });
});
