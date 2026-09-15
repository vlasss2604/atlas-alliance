import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import { interpretations, projects, researchClaimSupport, topics, users } from "../src/server/db/schema";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import { loadAcquisitionPlan } from "../src/server/engine/acquisition-plan";
import { evaluateAndPersistClaimSupport } from "../src/server/engine/claim-support-store";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { assembleAndPersistMechanism } from "../src/server/engine/mechanism-assembly-store";
import { fakeGateway } from "../src/server/interpreter/fake";
import { __setInterpreterGateway } from "../src/server/interpreter/gateway";
import { createInterpretation } from "../src/server/interpreter/interpret";
import { RESEARCH_INTENTS } from "../src/server/interpreter/schema";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import {
  applyOwnerIntentOverride,
  OWNER_INTENT_OVERRIDE_FIELD,
  resolveOwnerIntentOverride,
} from "../scripts/alpha-run";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// OWNER-ONLY INTENT OVERRIDE V1 — the validation-panel harness seam.
//
// The owner CLI (alpha-run) classifies a question with the NON-LIVE fake
// interpreter, which routes every known-asset question to
// PROTOCOL_REVENUE_TO_TOKEN. The frozen validation panel needs the other
// in-scope requirement sets exercised, so the owner may supply the intent
// explicitly. This suite pins the four properties the Founder required:
// explicit, logged on the Research record, inaccessible to product users,
// and unable to alter normal interpretation.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
  __setInterpreterGateway(fakeGateway);
});
afterAll(async () => {
  __setInterpreterGateway(null);
  await ctx.close();
});

const IN_SCOPE = Object.keys(PATTERN_V1_CONTENT.intentRequirements ?? {});

describe("resolution — only the code contract's own in-scope intents", () => {
  it("accepts every intent that has a requirement set, and nothing else", () => {
    expect(IN_SCOPE.length).toBeGreaterThan(0);
    for (const intent of IN_SCOPE) {
      expect(resolveOwnerIntentOverride(intent)).toEqual({ ok: true, intent });
      // Every accepted value is also a member of the interpreter's own enum.
      expect((RESEARCH_INTENTS as readonly string[]).includes(intent), intent).toBe(true);
    }
    // Absent flag: no override, ordinary behaviour.
    expect(resolveOwnerIntentOverride(undefined)).toEqual({ ok: true, intent: null });
    // Interpreter enum members WITHOUT a requirement set are refused —
    // S7 could not evaluate them, so an override to them would be a lie.
    for (const outOfScope of ["UNKNOWN", "SCENARIO_CAUSAL_IMPACT", "CLAIM_FACT_CHECK"]) {
      expect((RESEARCH_INTENTS as readonly string[]).includes(outOfScope)).toBe(true);
      expect(resolveOwnerIntentOverride(outOfScope).ok, outOfScope).toBe(false);
    }
    for (const garbage of ["", "   ", "protocol_revenue_to_token", "VALUE CAPTURE", "NEW_INTENT", "VALUE_CAPTURE; DROP TABLE"]) {
      expect(resolveOwnerIntentOverride(garbage).ok, JSON.stringify(garbage)).toBe(false);
    }
  });
});

async function interpretedQuestion(question: string) {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("aave_override");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Aave", status: "ACTIVE_CORE" }).returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { interpretation } = await createInterpretation(ctx.db, DEFAULT_PRODUCT_CONFIG, { userId: user.id, question });
  expect(interpretation.status).toBe("READY");
  expect(interpretation.route).toBe("DEEP_RESEARCH");
  return { topic, project, user, interpretation };
}

describe("application — the persisted interpretation row carries the override and says so", () => {
  it("replaces the fake interpreter's intent, records from/to/actor/at, and the engine reads the override", async () => {
    const { topic, project, user, interpretation } = await interpretedQuestion("does the Aave buyback reduce the AAVE supply?");
    const [before] = await ctx.db.select({ result: interpretations.result }).from(interpretations).where(eq(interpretations.id, interpretation.id));
    const fakeIntent = (before.result as { normalized_intent: string }).normalized_intent;
    expect(fakeIntent).toBe("PROTOCOL_REVENUE_TO_TOKEN"); // the fake interpreter's fixed answer

    const at = new Date("2026-09-15T12:00:00.000Z");
    const applied = await applyOwnerIntentOverride(ctx.db, interpretation.id, "BURN_OR_SUPPLY_EFFECT", "founder-panel", at);
    expect(applied).toEqual({ from: "PROTOCOL_REVENUE_TO_TOKEN", to: "BURN_OR_SUPPLY_EFFECT" });

    const [after] = await ctx.db.select({ result: interpretations.result }).from(interpretations).where(eq(interpretations.id, interpretation.id));
    const result = after.result as Record<string, unknown>;
    expect(result.normalized_intent).toBe("BURN_OR_SUPPLY_EFFECT");
    expect(result[OWNER_INTENT_OVERRIDE_FIELD]).toEqual({ from: "PROTOCOL_REVENUE_TO_TOKEN", to: "BURN_OR_SUPPLY_EFFECT", actor: "founder-panel", at: at.toISOString() });
    // Nothing else on the row moved.
    for (const key of ["route", "status", "project_slug", "task_type", "research_task", "server_adjustment"]) {
      expect(result[key], key).toEqual((before.result as Record<string, unknown>)[key]);
    }

    // Linked to a job the way alpha-run links it, the engine's own readers
    // see the override: acquisition planning (intent-required components)
    // and S7 (the requirement set evaluated).
    const { job } = await createResearchJob(
      ctx.db,
      ctx.boss,
      {
        userId: user.id,
        topicId: topic.id,
        projectId: project.id,
        originalQuestion: "does the Aave buyback reduce the AAVE supply?",
        normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
        normalizedTaskHash: uniq("hash"),
        idempotencyKey: uniq("idem"),
        entitlement: coreEntitlement(),
        demoLifetimeProofLimit: 1000,
      },
      { skipEnqueue: true },
    );
    await ctx.db.update(interpretations).set({ researchJobId: job.id }).where(eq(interpretations.id, interpretation.id));
    await runMemoryPlanningStage(ctx.db, job.id);
    const plan = await loadAcquisitionPlan(ctx.db, job.id, "NET_EFFECT", project.id);
    expect(plan.intent).toBe("BURN_OR_SUPPLY_EFFECT");
    expect(plan.intentRequired.has("NET_EFFECT")).toBe(true);
    expect(plan.intentRequired.has("SOURCE_OF_VALUE")).toBe(false);
    // S7 needs an S6 assembly, which needs at least one S5 row: reconcile
    // one component (zero Evidence → INSUFFICIENT), assemble, then evaluate.
    await reconcileAndPersistComponent(ctx.db, job.id, { step: 7, component: "NET_EFFECT" }, new Date());
    await assembleAndPersistMechanism(ctx.db, job.id, new Date());
    await evaluateAndPersistClaimSupport(ctx.db, job.id, new Date());
    const [s7] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, job.id));
    expect(s7.intent).toBe("BURN_OR_SUPPLY_EFFECT");
    expect((s7.requirementResults as { requirementId: string }[]).map((r) => r.requirementId)).toEqual(["BSE-1"]);
  });

  it("a missing interpretation is an error, never a fabricated row", async () => {
    await expect(applyOwnerIntentOverride(ctx.db, "00000000-0000-4000-8000-000000000000", "VALUE_CAPTURE", "x")).rejects.toThrow(/no structured result/);
  });
});

describe("isolation — the seam exists only in the owner CLI", () => {
  it("no product path reads the flag or writes the marker; the CLI refuses before the interpretation", () => {
    for (const file of ["src/server/services/start-research.ts", "src/server/interpreter/interpret.ts", "src/server/interpreter/gateway.ts", "src/server/interpreter/anthropic.ts", "src/server/jobs/worker.ts"]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("owner_intent_override");
      expect(src, file).not.toContain("--intent");
      expect(src, file).not.toContain("applyOwnerIntentOverride");
    }
    const cli = readFileSync("scripts/alpha-run.ts", "utf-8");
    const refusal = cli.indexOf("resolveOwnerIntentOverride(args.intent)");
    const interpretation = cli.indexOf("await createInterpretation(db, DEFAULT_PRODUCT_CONFIG");
    const jobCreation = cli.indexOf("await createResearchJob(");
    const application = cli.indexOf("await applyOwnerIntentOverride(db, interp.id");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(interpretation);
    expect(application).toBeGreaterThan(interpretation);
    expect(application).toBeLessThan(jobCreation);
    expect(cli).toContain("intent override:    OWNER");
  });
});
