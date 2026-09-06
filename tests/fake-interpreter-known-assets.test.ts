import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fakeGateway } from "../src/server/interpreter/fake";
import type { InterpreterInput } from "../src/server/interpreter/gateway";
import { resolveProjectSlug } from "../src/server/interpreter/interpret";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

// The fake Interpreter gateway is the non-live stand-in that alpha-run and
// the evaluation harness force in place of the model. It classifies
// DEEP_RESEARCH only for a question that names an asset in its closed
// KNOWN_ASSETS list, so a live target missing from that list cannot be
// researched through the harness at all — whatever the production path
// already supports. Both owner-approved live targets must be recognized,
// their canonical names must resolve in the seeded catalog exactly as the
// real Interpreter's server-side resolution would resolve them, and an
// unnamed asset must still fail closed to clarification.

async function classify(question: string) {
  const input: InterpreterInput = { question, clarificationTurns: [], language: "EN" };
  return (await fakeGateway.interpret(input, "fake-model")).result;
}

describe("fake interpreter — known assets", () => {
  it.each(["Pump.fun", "pumpfun", "pump fun", "pump_fun"])(
    "recognizes Pump.fun spelled %j",
    async (name) => {
      const r = await classify(`Where does ${name} revenue actually go?`);
      expect(r.status).toBe("READY");
      expect(r.route).toBe("DEEP_RESEARCH");
      expect(r.project_or_asset).toBe("Pump.fun");
    },
  );

  it.each(["Raydium", "raydium", "RAYDIUM"])("recognizes Raydium spelled %j", async (name) => {
    const r = await classify(`Where do ${name} trading fees go after a swap?`);
    expect(r.status).toBe("READY");
    expect(r.route).toBe("DEEP_RESEARCH");
    expect(r.project_or_asset).toBe("Raydium");
    expect(r.related_entities).toEqual([]);
  });

  it("keeps entity order when both live targets are compared", async () => {
    const r = await classify("Compare Raydium vs Pump.fun on value capture");
    expect(r.project_or_asset).toBe("Raydium");
    expect(r.related_entities).toEqual(["Pump.fun"]);
    expect(r.task_type).toBe("COMPARISON");
  });

  it("an asset outside the list still fails closed to clarification", async () => {
    const r = await classify("Where do Orca trading fees go after a swap?");
    expect(r.status).toBe("NEEDS_CLARIFICATION");
    expect(r.route).toBe("CLARIFICATION_REQUIRED");
    expect(r.project_or_asset).toBeNull();
  });

  it("a bare ticker is not a recognized spelling — no substring guessing", async () => {
    const r = await classify("Do RAY buybacks reduce supply?");
    expect(r.route).toBe("CLARIFICATION_REQUIRED");
    expect(r.project_or_asset).toBeNull();
  });
});

describe("fake interpreter — canonical names resolve in the seeded catalog", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestDatabase();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it.each([
    ["Pump.fun", "pump_fun"],
    ["Raydium", "raydium"],
  ])("%j resolves to slug %j with no adjustment", async (name, slug) => {
    const r = await resolveProjectSlug(ctx.db, name);
    expect(r.slug).toBe(slug);
    expect(r.adjustment).toBe("NONE");
  });
});
