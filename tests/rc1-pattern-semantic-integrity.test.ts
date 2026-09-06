import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  evidence,
  projects,
  researchComponentResults,
  researchPatterns,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import {
  componentRequirementsFor,
  PATTERN_V1_CONTENT,
  PatternConfigurationError,
  PatternSemanticDriftError,
  patternContentSchema,
  type PatternContent,
} from "../src/server/domain/pattern";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RC-1 — PATTERN CONTENT DRIFT MUST FAIL CLOSED.
//
// THE DEFECT, observed in 9 of 12 completed jobs of the frozen 18-question
// panel. The active Pattern row is chosen by identity (topic + ACTIVE +
// version) and validated by shape (patternContentSchema). Neither proves
// content. `structuralObligations` is optional — it must be, so a
// component declaring none behaves exactly as it did before obligations
// existed — so a row seeded before the obligation was added parses
// cleanly, the field simply arrives absent, and the obligation never runs.
// SOURCE_OF_VALUE reached SUPPORTED on documentary allocation sentences
// while SOV.MECHANICAL_PROVENANCE, the rule written to stop exactly that,
// was unreachable in production.
//
// The version number cannot catch it: seed.ts writes with
// onConflictDoNothing on (topic, version), so editing PATTERN_V1_CONTENT
// without bumping the version leaves the stored row frozen, and the
// plan-time cross-check compares version NUMBERS, which still agree.
//
// These tests pin both halves: the pure accessor refuses drift, and the
// production store — the ONE reconciliation entry point — refuses it
// against a real database rather than persisting a result computed under
// weaker semantics.

// A deep clone that survives the jsonb round-trip, so a mutated copy can
// never alias the module constant.
function clonePattern(): PatternContent {
  return JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
}

// The exact shape of the stale production row: everything the current
// Pattern says, minus the obligation the code contract added later.
function staleContent(): PatternContent {
  const c = clonePattern();
  delete (c.componentRequirements!["SOURCE_OF_VALUE"] as { structuralObligations?: unknown })
    .structuralObligations;
  return c;
}

describe("RC-1 §1 — the accessor refuses a Pattern weaker than the code contract", () => {
  it("the stale shape (obligation key absent) throws PatternSemanticDriftError naming what is missing", () => {
    const stale = staleContent();
    // It still parses — that is precisely why shape validation never caught this.
    expect(() => patternContentSchema.parse(stale)).not.toThrow();
    expect(() => componentRequirementsFor(stale, "SOURCE_OF_VALUE")).toThrow(PatternSemanticDriftError);
    try {
      componentRequirementsFor(stale, "SOURCE_OF_VALUE");
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as PatternSemanticDriftError;
      expect(err.name).toBe("PatternSemanticDriftError");
      expect(err.component).toBe("SOURCE_OF_VALUE");
      expect(err.missingObligations).toEqual(["SOV.MECHANICAL_PROVENANCE"]);
      expect(err.message).toContain("SOV.MECHANICAL_PROVENANCE");
    }
  });

  it("an explicitly EMPTY obligation list is drift too — absent and empty weaken identically", () => {
    const c = clonePattern();
    c.componentRequirements!["SOURCE_OF_VALUE"].structuralObligations = [];
    expect(() => componentRequirementsFor(c, "SOURCE_OF_VALUE")).toThrow(PatternSemanticDriftError);
  });

  it("the current code-owned Pattern satisfies its own contract for every component it defines", () => {
    for (const component of Object.keys(PATTERN_V1_CONTENT.componentRequirements ?? {})) {
      expect(() => componentRequirementsFor(PATTERN_V1_CONTENT, component)).not.toThrow();
    }
  });

  it("a SUPERSET is allowed: an unknown extra obligation is already fail-closed by the evaluator", () => {
    const c = clonePattern();
    c.componentRequirements!["SOURCE_OF_VALUE"].structuralObligations = [
      "SOV.MECHANICAL_PROVENANCE",
      "SOME.FUTURE_OBLIGATION",
    ];
    expect(() => componentRequirementsFor(c, "SOURCE_OF_VALUE")).not.toThrow();
  });

  it("a component whose code contract names no obligation is untouched by the guard", () => {
    const c = staleContent();
    for (const component of ["FLOW_PATH", "NET_EFFECT", "DESTINATION", "RECIPIENT", "MECHANISM_SPEC"]) {
      expect(componentRequirementsFor(c, component)).toEqual(
        componentRequirementsFor(PATTERN_V1_CONTENT, component),
      );
    }
  });

  it("a missing entry is still the OTHER, pre-existing failure — the guard did not swallow it", () => {
    const c = clonePattern();
    delete c.componentRequirements!["SOURCE_OF_VALUE"];
    expect(() => componentRequirementsFor(c, "SOURCE_OF_VALUE")).toThrow(PatternConfigurationError);
  });
});

describe("RC-1 §2 — the production reconciliation path, against a real database", () => {
  let ctx: TestContext;
  let topicId: string;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    topicId = topic.id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  // Restore the seeded (code-current) Pattern after any test that drifts it,
  // so ordering can never decide an outcome.
  async function setPatternContent(content: PatternContent): Promise<void> {
    await ctx.db
      .update(researchPatterns)
      .set({ content })
      .where(and(eq(researchPatterns.topicId, topicId), eq(researchPatterns.status, "ACTIVE")));
  }

  async function makeJob(): Promise<string> {
    const slug = uniq("rc1");
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug, name: "RC-1 Fixture", status: "ACTIVE_CORE" })
      .returning();
    const ok = await confirmProjectIdentity(ctx.db, {
      projectSlug: slug,
      chain: "solana",
      tokenAddress: "Mint1111111111111111111111111111111111111111",
    });
    if (!ok.ok) throw new Error("fixture identity failed");
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId,
      projectId: project.id,
      originalQuestion: "where does the revenue come from?",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "source of value" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    await runMemoryPlanningStage(ctx.db, job.id);
    return job.id;
  }

  // The exact false-green input from the live panel: an admissible,
  // SUPPORTS/DIRECT, OFFICIAL_DOCS/CONFIRMED documentary sentence about how
  // revenue is ALLOCATED. Without the obligation this carries
  // SOURCE_OF_VALUE to SUPPORTED on its own.
  async function documentaryRow(jobId: string, step: number, component: string): Promise<string> {
    const [source] = await ctx.db
      .insert(sources)
      .values({
        url: `https://docs.example.test/${uniq("p")}`,
        urlHash: uniq("uh"),
        sourceType: "OFFICIAL_DOCS",
        health: "OK",
      })
      .returning();
    const [row] = await ctx.db
      .insert(evidence)
      .values({
        researchJobId: jobId,
        sourceId: source.id,
        patternStep: step,
        component,
        relationship: "SUPPORTS",
        directness: "DIRECT",
        fragment: "Half of every dollar the protocol earns buys the token on the open market.",
        summary: "revenue is allocated to buybacks",
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        evidenceContractVersion: 2,
        fetchedAt: new Date("2026-09-06T00:00:00.000Z"),
        publishedAt: new Date("2026-09-01T00:00:00.000Z"),
        retrievedUrl: source.url,
        contentHash: uniq("ch"),
      })
      .returning();
    return row.id;
  }

  const NOW = new Date("2026-09-06T00:00:00.000Z");

  it("1. POSITIVE CONTROL — under the seeded code-current Pattern the obligation actually runs", async () => {
    await setPatternContent(PATTERN_V1_CONTENT);
    const jobId = await makeJob();
    await documentaryRow(jobId, 1, "SOURCE_OF_VALUE");

    const result = await reconcileAndPersistComponent(
      ctx.db,
      jobId,
      { step: 1, component: "SOURCE_OF_VALUE" },
      NOW,
    );
    // The documentary row is admissible and establishing, so the component
    // is NOT insufficient — but the obligation is unmet, so it cannot be
    // SUPPORTED either. That gap is the whole point of D-158 Phase 2.
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(result.supportingEvidenceIds.length).toBeGreaterThan(0);
  });

  it("2. THE REGRESSION — under the stale Pattern, SOURCE_OF_VALUE cannot reach SUPPORTED: it refuses", async () => {
    await setPatternContent(staleContent());
    const jobId = await makeJob();
    await documentaryRow(jobId, 1, "SOURCE_OF_VALUE");

    await expect(
      reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW),
    ).rejects.toThrow(PatternSemanticDriftError);

    // AND NOTHING WAS PERSISTED. A refusal that still wrote a row would be
    // the same false green with extra steps.
    const rows = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.component, "SOURCE_OF_VALUE"),
        ),
      );
    expect(rows).toEqual([]);
    await setPatternContent(PATTERN_V1_CONTENT);
  });

  it("3. the refusal is BOUNDED — it names the component and the missing obligation, not a generic failure", async () => {
    await setPatternContent(staleContent());
    const jobId = await makeJob();
    await documentaryRow(jobId, 1, "SOURCE_OF_VALUE");
    try {
      await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(PatternSemanticDriftError);
      const err = e as PatternSemanticDriftError;
      expect(err.component).toBe("SOURCE_OF_VALUE");
      expect(err.missingObligations).toEqual(["SOV.MECHANICAL_PROVENANCE"]);
    } finally {
      await setPatternContent(PATTERN_V1_CONTENT);
    }
  });

  it("4. UNRELATED COMPONENTS ARE NOT BROKEN — FLOW_PATH reconciles identically under both Patterns", async () => {
    await setPatternContent(PATTERN_V1_CONTENT);
    const jobA = await makeJob();
    await documentaryRow(jobA, 2, "FLOW_PATH");
    const current = await reconcileAndPersistComponent(
      ctx.db,
      jobA,
      { step: 2, component: "FLOW_PATH" },
      NOW,
    );

    await setPatternContent(staleContent());
    const jobB = await makeJob();
    await documentaryRow(jobB, 2, "FLOW_PATH");
    const underStale = await reconcileAndPersistComponent(
      ctx.db,
      jobB,
      { step: 2, component: "FLOW_PATH" },
      NOW,
    );
    await setPatternContent(PATTERN_V1_CONTENT);

    // Ordinary reconciliation is untouched: same status, same reason codes,
    // same number of supporting rows. Only the drifted component refuses.
    expect(underStale.status).toBe(current.status);
    expect(underStale.reasonCodes).toEqual(current.reasonCodes);
    expect(underStale.supportingEvidenceIds.length).toBe(current.supportingEvidenceIds.length);
    expect(underStale.excludedEvidence.length).toBe(current.excludedEvidence.length);
    expect(current.status).toBe("SUPPORTED");
  });
});
