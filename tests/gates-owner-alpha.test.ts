import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG, type ProductConfig } from "../src/server/config/product";
import { users } from "../src/server/db/schema";
import { evaluateGates } from "../src/server/services/gates";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function makeUser(role: "USER" | "ADMIN" = "USER"): Promise<string> {
  const [u] = await ctx.db.insert(users).values({ role }).returning();
  return u.id;
}

function config(overrides: Partial<ProductConfig> = {}): ProductConfig {
  return { ...DEFAULT_PRODUCT_CONFIG, ...overrides };
}

// evaluateGates (gates.ts) — Owner Manual Alpha App Test (D-124) preview
// parity: the interpretation preview must expose research=AVAILABLE for an
// eligible ADMIN under the same conditions startOwnerManualAlphaResearch /
// owner-alpha-routing.ts actually require, and must never diverge from
// ordinary DISABLED behavior for anyone else or once research is public.
describe("evaluateGates — Owner Manual Alpha preview parity (D-124)", () => {
  it("A. USER + research_enabled=false → DISABLED", async () => {
    const userId = await makeUser("USER");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: true }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: ["pump_fun"] },
    );
    expect(gates.research).toBe("DISABLED");
  });

  it("B. ADMIN + research_enabled=false + internal_alpha_enabled=true + allowlisted pump_fun → AVAILABLE", async () => {
    const userId = await makeUser("ADMIN");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: true }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: ["pump_fun"] },
    );
    expect(gates.research).toBe("AVAILABLE");
    expect(gates.scope).toBe("SUPPORTED");
  });

  it("C. ADMIN + research_enabled=false + internal_alpha_enabled=false → DISABLED", async () => {
    const userId = await makeUser("ADMIN");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: false }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: ["pump_fun"] },
    );
    expect(gates.research).toBe("DISABLED");
  });

  it("D. ADMIN + non-allowlisted project (uniswap, in scope but not in INTERNAL_ALPHA_LIVE_PROJECT_SLUGS) → DISABLED", async () => {
    const userId = await makeUser("ADMIN");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: true }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: ["uniswap"] },
    );
    expect(gates.scope).toBe("SUPPORTED"); // uniswap is in scope — only the allowlist blocks it
    expect(gates.research).toBe("DISABLED");
  });

  it("G. research_enabled=true → USER and ADMIN both get ordinary AVAILABLE, no owner-alpha special-casing", async () => {
    const userId = await makeUser("USER");
    const adminId = await makeUser("ADMIN");
    const cfg = config({ research_enabled: true, internal_alpha_enabled: true });
    const userGates = await evaluateGates(ctx.db, cfg, {
      userId,
      status: "READY",
      route: "DEEP_RESEARCH",
      projectSlugs: ["pump_fun"],
    });
    const adminGates = await evaluateGates(ctx.db, cfg, {
      userId: adminId,
      status: "READY",
      route: "DEEP_RESEARCH",
      projectSlugs: ["pump_fun"],
    });
    expect(userGates.research).toBe("AVAILABLE");
    expect(adminGates.research).toBe("AVAILABLE");
  });
});
