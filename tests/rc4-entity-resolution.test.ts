import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { projectAliases, projects } from "../src/server/db/schema";
import { resolveProjectSlug } from "../src/server/interpreter/interpret";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RC-4 — "NAME (TICKER)" IS ONE NAME FOR ONE PROJECT.
//
// THE DEFECT, measured on the frozen panel: 4 of 9 Raydium questions never
// reached research because entity resolution refused them. Three surface
// forms, and they did NOT share one cause:
//
//   "Raydium (RAY)"            -> looseKey deletes every non-alphanumeric,
//                                 producing "raydiumray" — a key no slug,
//                                 name, ticker or alias can equal. This is
//                                 a normalisation defect and is fixed here.
//   "RAY"                      -> the catalog carries ticker=null for
//                                 Raydium by an explicit owner decision
//                                 (seed.ts). Missing DATA, not a code bug.
//   "Raydium" + related ["RAY"] -> the primary resolved; the unresolvable
//                                 related entity vetoed the task. The veto
//                                 fired correctly — "RAY" genuinely did not
//                                 resolve — so it is the same data gap.
//
// The normalisation defect was never Raydium-specific: "Pump.fun (PUMP)"
// failed identically, though both halves resolve on their own.
//
// The data gap is now closed by an owner-approved ALIAS, not by a ticker:
// projects.ticker stays null for Raydium, so the catalog still asserts no
// token identity. An alias says one thing only — people call this known
// project by this string. Collisions cannot appear silently: the alias
// index is globally unique, so one alias cannot belong to two projects,
// and an alias colliding with another project's name or ticker resolves to
// PROJECT_AMBIGUOUS rather than being chosen for the user.

describe("RC-4 — project/entity resolution", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe("the qualified form resolves, for every project", () => {
    it.each([
      ["Raydium", "raydium"],
      ["Raydium (RAY)", "raydium"],
      ["Pump.fun", "pump_fun"],
      ["PUMP", "pump_fun"],
      // The form that failed for EVERY catalog project, not just Raydium.
      ["Pump.fun (PUMP)", "pump_fun"],
      ["Hyperliquid (HYPE)", "hyperliquid"],
      ["Uniswap (UNI)", "uniswap"],
    ])("%j resolves to %j", async (text, slug) => {
      const r = await resolveProjectSlug(ctx.db, text);
      expect(r.slug).toBe(slug);
      expect(r.adjustment).toBe("NONE");
    });

    it.each([
      "raydium (ray)",
      "  Raydium   ( RAY )  ",
      "RAYDIUM (RAY)",
    ])("casing and spacing do not change the answer: %j", async (text) => {
      expect((await resolveProjectSlug(ctx.db, text)).slug).toBe("raydium");
    });
  });

  describe("what must still be refused", () => {
    it("an unknown name is unresolved", async () => {
      const r = await resolveProjectSlug(ctx.db, "NOSUCHPROJECT");
      expect(r.slug).toBeNull();
      expect(r.adjustment).toBe("PROJECT_UNRESOLVED");
    });

    it("an unknown ticker inside the qualified form does not rescue an unknown name", async () => {
      const r = await resolveProjectSlug(ctx.db, "Nosuchproject (NOSUCHTICKER)");
      expect(r.slug).toBeNull();
      expect(r.adjustment).toBe("PROJECT_UNRESOLVED");
    });

    it("a ticker two projects can claim stays ambiguous — the server does not choose", async () => {
      // One project's TICKER is another project's NAME: the same loose key
      // reaches two different projects, which is exactly the collision the
      // resolver must refuse rather than guess.
      const collide = uniq("clash").replace(/[^a-z0-9]/gi, "");
      await ctx.db.insert(projects).values({ slug: uniq("a_"), name: `Alpha ${collide}`, ticker: collide, status: "ACTIVE_CORE" });
      await ctx.db.insert(projects).values({ slug: uniq("b_"), name: collide, ticker: null, status: "ACTIVE_CORE" });

      const r = await resolveProjectSlug(ctx.db, collide);
      expect(r.slug).toBeNull();
      expect(r.adjustment).toBe("PROJECT_AMBIGUOUS");
      expect(r.candidates).toHaveLength(2);
    });

    it("a qualified form whose halves name DIFFERENT projects fails closed", async () => {
      // "Uniswap (PUMP)" is not a name — it is two projects in one string.
      const r = await resolveProjectSlug(ctx.db, "Uniswap (PUMP)");
      expect(r.slug).toBeNull();
      expect(r.adjustment).toBe("PROJECT_AMBIGUOUS");
      expect([...r.candidates].sort()).toEqual(["pump_fun", "uniswap"]);
    });
  });

  describe("the owner-approved alias, and what it must not loosen", () => {
    it("'RAY' resolves through the alias, and the catalog still asserts no ticker", async () => {
      expect((await resolveProjectSlug(ctx.db, "RAY")).slug).toBe("raydium");
      const [row] = await ctx.db.select().from(projects).where(eq(projects.slug, "raydium"));
      // The decision the alias deliberately did NOT overturn.
      expect(row.ticker).toBeNull();
    });

    it.each(["ray", "  RAY  ", "Ray"])("the alias is matched without case or spacing: %j", async (text) => {
      expect((await resolveProjectSlug(ctx.db, text)).slug).toBe("raydium");
    });

    it("an alias colliding with another project's name is ambiguous, never silently chosen", async () => {
      const token = `ZZ${uniq("t").replace(/[^a-z0-9]/gi, "")}`;
      const [owner] = await ctx.db
        .insert(projects)
        .values({ slug: uniq("alias_owner_"), name: `Alias Owner ${token}`, status: "ACTIVE_CORE" })
        .returning();
      await ctx.db.insert(projectAliases).values({ projectId: owner.id, alias: token });
      // A different project that simply IS called that.
      await ctx.db.insert(projects).values({ slug: uniq("namesake_"), name: token, status: "ACTIVE_CORE" });

      const r = await resolveProjectSlug(ctx.db, token);
      expect(r.slug).toBeNull();
      expect(r.adjustment).toBe("PROJECT_AMBIGUOUS");
      expect(r.candidates).toHaveLength(2);
    });

    it("one alias cannot belong to two projects — the database refuses it", async () => {
      const token = `ZZ${uniq("u").replace(/[^a-z0-9]/gi, "")}`;
      const [a] = await ctx.db
        .insert(projects)
        .values({ slug: uniq("dup_a_"), name: `Dup A ${token}`, status: "ACTIVE_CORE" })
        .returning();
      const [b] = await ctx.db
        .insert(projects)
        .values({ slug: uniq("dup_b_"), name: `Dup B ${token}`, status: "ACTIVE_CORE" })
        .returning();
      await ctx.db.insert(projectAliases).values({ projectId: a.id, alias: token });
      await expect(
        ctx.db.insert(projectAliases).values({ projectId: b.id, alias: token.toLowerCase() }),
      ).rejects.toThrow();
    });
  });

  describe("the panel's four refusal shapes, reproduced from the persisted interpreter output", () => {
    // Exactly the project_or_asset / related_entities strings the real
    // interpreter produced, read off the stored interpretations — no model
    // call involved. All four now pass entity resolution.
    it("A6-Q2 'Raydium (RAY)' resolves — the normalisation fix", async () => {
      expect((await resolveProjectSlug(ctx.db, "Raydium (RAY)")).slug).toBe("raydium");
    });

    it("A6-Q3 'RAY' resolves — the alias", async () => {
      expect((await resolveProjectSlug(ctx.db, "RAY")).slug).toBe("raydium");
    });

    it("A4-Q2 / A5-Q1: primary AND related entity both resolve to the same project", async () => {
      // The related-entity veto was never the defect — it refused because
      // "RAY" genuinely did not resolve. Now both halves land on one
      // project, so the veto has nothing to refuse and does not fire.
      expect((await resolveProjectSlug(ctx.db, "Raydium")).slug).toBe("raydium");
      expect((await resolveProjectSlug(ctx.db, "RAY")).slug).toBe("raydium");
    });
  });
});
