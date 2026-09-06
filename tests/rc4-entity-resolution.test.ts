import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projects } from "../src/server/db/schema";
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
// failed identically, though both halves resolve on their own. These tests
// pin the fix and pin the two refusals that remain correct without the
// missing catalog data.

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

  describe("the panel's four refusal shapes, reproduced from the persisted interpreter output", () => {
    // Exactly the project_or_asset strings the real interpreter produced,
    // read off the stored interpretations — no model call involved.
    it("A6-Q2 'Raydium (RAY)' now resolves", async () => {
      expect((await resolveProjectSlug(ctx.db, "Raydium (RAY)")).slug).toBe("raydium");
    });

    it("A6-Q3 'RAY' stays unresolved — the catalog carries no ticker for Raydium", async () => {
      const r = await resolveProjectSlug(ctx.db, "RAY");
      expect(r.slug).toBeNull();
      expect(r.adjustment).toBe("PROJECT_UNRESOLVED");
    });

    it("A4-Q2 / A5-Q1: the primary resolves, the related ticker does not", async () => {
      // The related-entity veto is not the defect: it refused because "RAY"
      // genuinely did not resolve. Both halves are pinned so the day a
      // ticker is added, this test states what changes.
      expect((await resolveProjectSlug(ctx.db, "Raydium")).slug).toBe("raydium");
      expect((await resolveProjectSlug(ctx.db, "RAY")).slug).toBeNull();
    });
  });
});
