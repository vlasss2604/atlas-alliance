import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projects,
  researchComponentResults,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { runResearchController } from "../src/server/engine/controller";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ContractView } from "../src/server/engine/contract-view";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// Phase 6, S5 — persistence + controller-integration tests
// (phase-6-s5-plan.md §11.3, §17, §19 of the task). Real PostgreSQL —
// exercises the ACTUAL seeded Pattern v1 componentRequirements matrix
// (src/server/domain/pattern.ts), not a hand-built fixture, so these tests
// also double as a regression check that the matrix data itself round-trips
// through the DB and componentRequirementsFor() correctly.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-08-22T00:00:00Z");

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeJob(): Promise<{ jobId: string; projectId: string }> {
  const topicId = await activeTopicId();
  const slug = uniq("p6s5");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "S5 Test Project", status: "ACTIVE_CORE" }).returning();
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
  return { jobId: job.id, projectId: project.id };
}

async function makeSource(url: string): Promise<string> {
  const urlHash = `sha256:${url}`;
  const [row] = await ctx.db
    .insert(sources)
    .values({ url, urlHash, sourceType: "OFFICIAL_DOCS" })
    .onConflictDoNothing({ target: sources.urlHash })
    .returning({ id: sources.id });
  if (row) return row.id;
  const [existing] = await ctx.db.select().from(sources).where(eq(sources.urlHash, urlHash));
  return existing.id;
}

async function insertEvidence(
  jobId: string,
  sourceId: string,
  overrides: Partial<typeof evidence.$inferInsert> = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: "the protocol fee accrues directly to the treasury contract",
      summary: "protocol fee accrues to the treasury",
      mechanismState: null,
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      fetchedAt: NOW,
      publishedAt: NOW,
      doesNotProve: "does not prove distribution to holders",
      retrievedUrl: "https://example.com/docs",
      contentHash: `hash-${Math.random()}`,
      extractionUnitKey: `unit-${Math.random()}`,
      ...overrides,
    })
    .returning({ id: evidence.id });
  return row.id;
}

describe("Фаза 6, S5 — персистенция (research_component_results)", () => {
  it("reconcileAndPersistComponent пишет одну строку с реальной seeded Pattern v1 матрицей (SOURCE_OF_VALUE)", async () => {
    const { jobId } = await makeJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const evId = await insertEvidence(jobId, sourceId);

    const result = await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
    expect(result.status).toBe("SUPPORTED");
    expect(result.supportingEvidenceIds).toEqual([evId]);

    const [row] = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.patternStep, 1),
          eq(researchComponentResults.component, "SOURCE_OF_VALUE"),
        ),
      );
    expect(row).toBeDefined();
    expect(row.status).toBe("SUPPORTED");
    expect(row.supportingEvidenceIds).toEqual([evId]);
    expect(row.requiresFreshEvidence).toBe(false);
  });

  it("upsert — повторный вызов не плодит строк (§11.3, один семантический ряд на job/step/component)", async () => {
    const { jobId } = await makeJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(jobId, sourceId);

    await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
    await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);

    const rows = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.patternStep, 1),
          eq(researchComponentResults.component, "SOURCE_OF_VALUE"),
        ),
      );
    expect(rows.length).toBe(1);
  });

  it("удаление строки + повторный прогон из того же Evidence -> идентичный результат (§11.3 производная проекция)", async () => {
    const { jobId } = await makeJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(jobId, sourceId, { officiality: "CLAIMED" });

    const before = await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
    await ctx.db.delete(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    const after = await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);

    expect(after).toEqual(before);
    expect(after.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("нет Evidence вовсе -> персистируется успешный INSUFFICIENT_EVIDENCE, не ошибка", async () => {
    const { jobId } = await makeJob();
    const result = await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    const [row] = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.patternStep, 1),
          eq(researchComponentResults.component, "SOURCE_OF_VALUE"),
        ),
      );
    expect(row.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("SOCIAL-класс не устанавливает SOURCE_OF_VALUE даже через реальную seeded матрицу (D-074, интеграционная проверка Y/B)", async () => {
    const { jobId } = await makeJob();
    const socialUrl = `https://x.com/${uniq("handle")}`;
    const socialSourceId = await makeSource(socialUrl);
    await ctx.db.update(sources).set({ sourceType: "OTHER" }).where(eq(sources.id, socialSourceId));
    await insertEvidence(jobId, socialSourceId, { sourceClass: "SOCIAL", retrievedUrl: socialUrl });

    const result = await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.excludedEvidence[0].reason).toBe("CLASS_NOT_ADMISSIBLE");
  });

  it("реальная seeded матрица GOVERNANCE_BASIS допускает ТОЛЬКО GOVERNANCE — OFFICIAL_DOCS (допустимый для многих ДРУГИХ компонентов) не устанавливает его (D-095 через персистенцию, не через ручной fixture)", async () => {
    // Discriminating test: componentRequirementsFor() must read the REAL
    // per-component Pattern matrix, not a generic "everything except
    // SOCIAL" fallback — GOVERNANCE_BASIS's establishingClasses is
    // narrower (["GOVERNANCE"] only) than most other components', so a
    // hard-coded permissive default that happens to still exclude SOCIAL
    // would NOT be caught by any test that only tries a SOCIAL row.
    const { jobId } = await makeJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(jobId, sourceId, {
      patternStep: 3,
      component: "GOVERNANCE_BASIS",
      sourceClass: "OFFICIAL_DOCS",
    });

    const result = await reconcileAndPersistComponent(ctx.db, jobId, { step: 3, component: "GOVERNANCE_BASIS" }, NOW);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.excludedEvidence[0].reason).toBe("CLASS_NOT_ADMISSIBLE");
  });
});

describe("Фаза 6, S5 — интеграция с контроллером (§19 задачи)", () => {
  const ITEM: ComponentWorkItem = {
    step: 1,
    stepName: "Economic Source",
    component: "SOURCE_OF_VALUE",
    state: "NO_MEMORY",
    blockers: [],
    memoryIds: [],
    conflictingMemoryIds: [],
  };

  function viewFor(item: ComponentWorkItem): ContractView {
    return {
      patternVersion: 1,
      mode: "FRESH_RESEARCH",
      capabilityAtStart: "FRESH_RESEARCH",
      capabilityCeilingHit: false,
      workQueue: [item],
      reused: [],
      excludedComponents: [],
      stopConditions: [],
      researchBudget: {
        maxSearchQueries: 10,
        maxSourceOpens: 10,
        maxModelCostMicro: 1_000_000,
        maxWallClockSec: 300,
        reservedRecoverySteps: 1,
      },
      noveltyState: "KNOWN",
    };
  }

  it("контроллер вызывает reconcile ПОСЛЕ успешного attempt и персистирует результат (S4 Evidence acquisition -> S5)", async () => {
    const { jobId } = await makeJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);

    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED", spent: { searchQueries: 1, sourceOpens: 1, authorizedModelCostMicro: 0 } };
      },
    };

    const result = await runResearchController({
      db: ctx.db,
      jobId,
      view: viewFor(ITEM),
      executor,
      now: NOW,
      reconcile: reconcileAndPersistComponent,
    });
    expect(result.succeeded.length).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.patternStep, 1),
          eq(researchComponentResults.component, "SOURCE_OF_VALUE"),
        ),
      );
    expect(row).toBeDefined();
    expect(row.status).toBe("SUPPORTED");
  });

  it("контроллер вызывает reconcile даже после FAILED attempt — отсутствие новых Evidence остаётся честным INSUFFICIENT_EVIDENCE (D-084)", async () => {
    const { jobId } = await makeJob();

    const executor: WorkExecutor = {
      async execute() {
        return { status: "FAILED", reason: "NO_SEARCH_CANDIDATES" };
      },
    };

    await runResearchController({
      db: ctx.db,
      jobId,
      view: viewFor(ITEM),
      executor,
      now: NOW,
      reconcile: reconcileAndPersistComponent,
    });

    const [row] = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.patternStep, 1),
          eq(researchComponentResults.component, "SOURCE_OF_VALUE"),
        ),
      );
    expect(row).toBeDefined();
    expect(row.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("без reconcile-хука (S3/S4 поведение до S5) — ни одной строки research_component_results не появляется", async () => {
    const { jobId } = await makeJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);

    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };

    await runResearchController({ db: ctx.db, jobId, view: viewFor(ITEM), executor, now: NOW });

    const rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    expect(rows.length).toBe(0);
  });

  it("reconcile-хук не меняет собственный исход попытки (status/spent/budget контроллера идентичны без хука)", async () => {
    const { jobId: jobA } = await makeJob();
    const { jobId: jobB } = await makeJob();
    const sourceIdA = await makeSource(`https://example.com/${uniq("doc")}`);
    const sourceIdB = await makeSource(`https://example.com/${uniq("doc")}`);

    const makeExecutor = (sourceId: string): WorkExecutor => ({
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED", spent: { searchQueries: 2, sourceOpens: 1, authorizedModelCostMicro: 500 } };
      },
    });

    const withReconcile = await runResearchController({
      db: ctx.db,
      jobId: jobA,
      view: viewFor(ITEM),
      executor: makeExecutor(sourceIdA),
      now: NOW,
      reconcile: reconcileAndPersistComponent,
    });
    const withoutReconcile = await runResearchController({
      db: ctx.db,
      jobId: jobB,
      view: viewFor(ITEM),
      executor: makeExecutor(sourceIdB),
      now: NOW,
    });

    expect(withReconcile.stopReason).toBe(withoutReconcile.stopReason);
    expect(withReconcile.budgetSpent).toEqual(withoutReconcile.budgetSpent);
    expect(withReconcile.succeeded.length).toBe(withoutReconcile.succeeded.length);
  });
});
