import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";

import { projects, researchPatterns, researchPlans, topics, users } from "../src/server/db/schema";
import { PATTERN_V1_CONTENT, patternContentSchema, type PatternContent } from "../src/server/domain/pattern";
import { MissingActivePatternError } from "../src/server/engine/active-pattern";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// PLANNING MUST READ THE ACTIVE PATTERN — ALL OF IT, FROM ONE ROW.
//
// THE LATENT TRAP. plan-job.ts read Pattern content by topic alone: no
// status filter, no ORDER BY. With more than one row per topic it returned
// whichever the heap yielded first, so planning could take its `steps` and
// `requiredComponents` from a RETIRED or DRAFT Pattern while freezing the
// ACTIVE version number into the contract — two different Patterns for one
// job. It stayed invisible only while every version happened to carry
// identical steps, which is exactly the condition that stops holding the
// first time a semantic version changes either field.
//
// These tests make the selection observable. A decoy Pattern carries a
// different step name and a different required component, both of which
// travel verbatim into the frozen contract (stepDecisions[].stepName and
// stepDecisions[].components[].component), so the contract itself says
// which row planning actually read.

// Schema-valid, deliberately distinguishable from the real Pattern.
function decoyContent(): PatternContent {
  const c = JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
  c.steps[0] = { ...c.steps[0], name: "DECOY STEP" };
  c.requiredComponents["1"] = ["DECOY_COMPONENT"];
  // A decoy that does not parse would prove nothing — the real read parses
  // whatever row it picks, so the decoy has to be just as valid.
  return patternContentSchema.parse(c);
}

describe("plan-time Pattern selection respects ACTIVE semantics", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  });
  afterAll(async () => {
    await ctx.close();
  });

  async function makeTopic(): Promise<string> {
    const [topic] = await ctx.db
      .insert(topics)
      .values({ slug: uniq("pat_sel"), name: "pattern selection", isActive: false })
      .returning();
    return topic.id;
  }

  async function addPattern(
    topicId: string,
    version: number,
    status: "ACTIVE" | "DRAFT" | "RETIRED",
    content: PatternContent,
  ): Promise<void> {
    await ctx.db.insert(researchPatterns).values({ topicId, version, status, content });
  }

  async function planJobForTopic(topicId: string): Promise<string> {
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("pat_sel_p"), name: "pattern selection", status: "ACTIVE_CORE" })
      .returning();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId,
      projectId: project.id,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    await runMemoryPlanningStage(ctx.db, job.id);
    return job.id;
  }

  async function frozenContract(jobId: string) {
    const [plan] = await ctx.db
      .select()
      .from(researchPlans)
      .where(eq(researchPlans.researchJobId, jobId))
      .orderBy(desc(researchPlans.version))
      .limit(1);
    return plan.contract as {
      patternVersion: number;
      stepDecisions: { step: number; stepName: string; components: { component: string }[] }[];
    };
  }

  it("1. ACTIVE v2 is selected when v1 is RETIRED — content AND version come from v2", async () => {
    const topicId = await makeTopic();
    await addPattern(topicId, 1, "RETIRED", decoyContent());
    await addPattern(topicId, 2, "ACTIVE", PATTERN_V1_CONTENT);

    const contract = await frozenContract(await planJobForTopic(topicId));
    expect(contract.patternVersion).toBe(2);
    const step1 = contract.stepDecisions.find((s) => s.step === 1)!;
    expect(step1.stepName).toBe(PATTERN_V1_CONTENT.steps[0].name);
    expect(step1.components.map((c) => c.component)).toEqual(PATTERN_V1_CONTENT.requiredComponents["1"]);
    expect(step1.stepName).not.toBe("DECOY STEP");
    expect(step1.components.map((c) => c.component)).not.toContain("DECOY_COMPONENT");
  });

  it("2. a DRAFT-only topic is refused — DRAFT never satisfies an ACTIVE lookup", async () => {
    const topicId = await makeTopic();
    await addPattern(topicId, 1, "DRAFT", PATTERN_V1_CONTENT);
    await expect(planJobForTopic(topicId)).rejects.toThrow(MissingActivePatternError);
  });

  it("3. a RETIRED-only topic is refused — RETIRED never satisfies an ACTIVE lookup", async () => {
    const topicId = await makeTopic();
    await addPattern(topicId, 1, "RETIRED", PATTERN_V1_CONTENT);
    await expect(planJobForTopic(topicId)).rejects.toThrow(MissingActivePatternError);
  });

  it("4. non-ACTIVE rows cannot supply steps or requiredComponents, even at a HIGHER version", async () => {
    // The discriminating arrangement: ACTIVE is the LOWEST version, and the
    // decoys sit above it. "First row" would be arbitrary and "highest
    // version" would pick a decoy — only the ACTIVE predicate is right, so
    // this fails under either wrong heuristic rather than passing by luck.
    const topicId = await makeTopic();
    await addPattern(topicId, 1, "ACTIVE", PATTERN_V1_CONTENT);
    await addPattern(topicId, 2, "DRAFT", decoyContent());
    await addPattern(topicId, 3, "RETIRED", decoyContent());

    const contract = await frozenContract(await planJobForTopic(topicId));
    expect(contract.patternVersion).toBe(1);
    for (const step of contract.stepDecisions) {
      expect(step.stepName).not.toBe("DECOY STEP");
      expect(step.components.map((c) => c.component)).not.toContain("DECOY_COMPONENT");
    }
    const step1 = contract.stepDecisions.find((s) => s.step === 1)!;
    expect(step1.components.map((c) => c.component)).toEqual(PATTERN_V1_CONTENT.requiredComponents["1"]);
  });

  it("5. the ordinary single-ACTIVE case is unchanged", async () => {
    const topicId = await makeTopic();
    await addPattern(topicId, 1, "ACTIVE", PATTERN_V1_CONTENT);

    const contract = await frozenContract(await planJobForTopic(topicId));
    expect(contract.patternVersion).toBe(1);
    expect(contract.stepDecisions).toHaveLength(8);
    expect(contract.stepDecisions.map((s) => s.stepName)).toEqual(
      PATTERN_V1_CONTENT.steps.map((s) => s.name),
    );
    for (const step of contract.stepDecisions) {
      expect(step.components.map((c) => c.component)).toEqual(
        PATTERN_V1_CONTENT.requiredComponents[String(step.step)],
      );
    }
  });
});
