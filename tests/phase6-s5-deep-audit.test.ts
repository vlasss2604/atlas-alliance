import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projects,
  researchAttempts,
  researchComponentResults,
  researchPatterns,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { PatternConfigurationError } from "../src/server/domain/pattern";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ContractView } from "../src/server/engine/contract-view";
import {
  reconcileAndPersistComponent,
  reconcileOutstandingComponents,
} from "../src/server/engine/component-reconciliation-store";
import { MissingActivePatternError, runS4ResearchJob } from "../src/server/engine/run-job";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// Phase 6, S5 deep-audit fix package (phase-6-s5-audit.md) — real
// PostgreSQL tests for HIGH-1 (production wiring), HIGH-2 (crash/resume),
// HIGH-4 (ACTIVE Pattern selection), MEDIUM-3 (missing componentRequirements
// is a configuration failure, not an evidentiary conclusion). Deliberately
// exercises the CANONICAL production entry point (runS4ResearchJob) — not
// just runResearchController with a manually-injected reconcile dependency
// — so a regression that removes the production wiring itself is caught
// (§13 of the fix task).

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

async function makePlannedJob(): Promise<{ jobId: string; projectId: string; topicId: string }> {
  const topicId = await activeTopicId();
  const [project] = await ctx.db.insert(projects).values({ slug: uniq("p6s5da"), name: "S5 deep-audit test", status: "ACTIVE_CORE" }).returning();
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
  return { jobId: job.id, projectId: project.id, topicId };
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

async function insertEvidence(jobId: string, sourceId: string, overrides: Partial<typeof evidence.$inferInsert> = {}): Promise<string> {
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

async function s5RowsFor(jobId: string) {
  return ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
}

describe("HIGH-1: S5 встроен в канонический production-путь (runS4ResearchJob), не только тест-путь", () => {
  it("реальный runS4ResearchJob c детерминированным fixture executor'ом -> research_component_results строка появляется без ручного inject reconcile", async () => {
    const { jobId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const rows = await s5RowsFor(jobId);
    expect(rows.length).toBeGreaterThan(0);
    const sourceOfValue = rows.find((r) => r.patternStep === 1 && r.component === "SOURCE_OF_VALUE");
    expect(sourceOfValue?.status).toBe("SUPPORTED");
  });
});

describe("HIGH-2/§12: матрица crash/resume", () => {
  it("A: Evidence + attempt SUCCEEDED уже персистированы, S5-строки нет -> рестарт runS4ResearchJob создаёт S5-строку БЕЗ нового provider-вызова", async () => {
    const { jobId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);

    // Simulate: a PRIOR run already got the S4 attempt to SUCCEEDED and
    // Evidence persisted, but crashed before S5 ever ran (no
    // research_component_results row at all yet) — done directly against
    // the DB, bypassing the executor entirely, exactly as a real crash
    // would leave things.
    await insertEvidence(jobId, sourceId, { patternStep: 1, component: "SOURCE_OF_VALUE" });
    await ctx.db.insert(researchAttempts).values({
      researchJobId: jobId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      attemptNumber: 1,
      status: "SUCCEEDED",
      completedAt: NOW,
    });

    // Every OTHER (step, component) in the work queue is still genuinely
    // pending and the controller is expected to attempt those normally —
    // only SOURCE_OF_VALUE (already SUCCEEDED in a prior "run") must never
    // be re-attempted.
    const attemptedComponents = new Set<string>();
    const executor: WorkExecutor = {
      async execute(item) {
        attemptedComponents.add(`${item.step}:${item.component}`);
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);

    const rows = await s5RowsFor(jobId);
    const sourceOfValue = rows.find((r) => r.patternStep === 1 && r.component === "SOURCE_OF_VALUE");
    expect(sourceOfValue).toBeDefined();
    expect(sourceOfValue?.status).toBe("SUPPORTED");
    // The whole point: the controller never re-attempts an
    // already-SUCCEEDED component (succeededKeys filters it out, exactly
    // as before this fix) — S5 catches up via the sweep, not via a new
    // attempt.
    expect(attemptedComponents.has("1:SOURCE_OF_VALUE")).toBe(false);
  });

  it("B: S5-строка уже существует -> повторный прогон стабилен (upsert, не дублируется, не искажается)", async () => {
    const { jobId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(jobId, sourceId, { patternStep: 1, component: "SOURCE_OF_VALUE" });
    await ctx.db.insert(researchAttempts).values({
      researchJobId: jobId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      attemptNumber: 1,
      status: "SUCCEEDED",
      completedAt: NOW,
    });

    const executor: WorkExecutor = { async execute() { return { status: "SUCCEEDED" }; } };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const first = await s5RowsFor(jobId);
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const second = await s5RowsFor(jobId);

    expect(second.length).toBe(first.length);
    const a = first.find((r) => r.component === "SOURCE_OF_VALUE");
    const b = second.find((r) => r.component === "SOURCE_OF_VALUE");
    expect(b?.status).toBe(a?.status);
    expect(b?.supportingEvidenceIds).toEqual(a?.supportingEvidenceIds);
  });

  it("D: ошибка Pattern-конфигурации при S5-персистенции не притворяется, что S5 завершился успешно (никакой ложной строки не пишется)", async () => {
    const { jobId } = await makePlannedJob();
    await expect(
      reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "A_COMPONENT_NOT_IN_ANY_PATTERN" }, NOW),
    ).rejects.toThrow(PatternConfigurationError);
    const rows = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.patternStep, 1),
          eq(researchComponentResults.component, "A_COMPONENT_NOT_IN_ANY_PATTERN"),
        ),
      );
    expect(rows.length).toBe(0);
  });

  it("E: незавершённая (STARTED, ещё в пределах lease) попытка не реконсилируется свёрткой — существующая семантика S4 recovery не тронута", async () => {
    const { jobId } = await makePlannedJob();
    await ctx.db.insert(researchAttempts).values({
      researchJobId: jobId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      attemptNumber: 1,
      status: "STARTED",
    });
    const view: ContractView = {
      patternVersion: 1,
      mode: "FRESH_RESEARCH",
      capabilityAtStart: "FRESH_RESEARCH",
      capabilityCeilingHit: false,
      workQueue: [
        { step: 1, stepName: "Economic Source", component: "SOURCE_OF_VALUE", state: "NO_MEMORY", blockers: [], memoryIds: [], conflictingMemoryIds: [] },
      ],
      reused: [],
      excludedComponents: [],
      stopConditions: [],
      researchBudget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro: 1_000_000, maxWallClockSec: 300, reservedRecoverySteps: 1 },
      noveltyState: "KNOWN",
    };
    await reconcileOutstandingComponents(ctx.db, jobId, view.workQueue, NOW);
    const rows = await s5RowsFor(jobId);
    expect(rows.length).toBe(0);
  });
});

describe("HIGH-4: S5 выбирает ACTIVE-версию Pattern, а не первую попавшуюся строку", () => {
  it("RETIRED v1 + ACTIVE v2 (v2 с пустым establishingClasses для SOURCE_OF_VALUE) -> реконсиляция идёт по ACTIVE v2, не RETIRED v1", async () => {
    const { jobId, topicId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(jobId, sourceId, { patternStep: 1, component: "SOURCE_OF_VALUE" });

    // Baseline: v1 (the job's own frozen contract.patternVersion) already
    // establishes SOURCE_OF_VALUE via OFFICIAL_DOCS.
    const before = await reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
    expect(before.status).toBe("SUPPORTED");

    // This job's contract is frozen to v1 — cross-checking against a
    // DIFFERENT active version must hard-fail (HIGH-4's version
    // cross-check), not silently reconcile against the wrong Pattern.
    const [v1Row] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, topicId));
    await ctx.db.update(researchPatterns).set({ status: "RETIRED" }).where(eq(researchPatterns.id, v1Row.id));
    await ctx.db.insert(researchPatterns).values({
      topicId,
      version: v1Row.version + 1,
      status: "ACTIVE",
      content: {
        ...(v1Row.content as object),
        componentRequirements: {
          ...(v1Row.content as { componentRequirements: object }).componentRequirements,
          SOURCE_OF_VALUE: { establishingClasses: [], requiresCurrentState: false, requiresLiveMechanismState: false, freshnessClass: "LOW_CHANGE", tokenStateSensitive: false, requiredTokenState: null },
        },
      },
    });

    await expect(reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW)).rejects.toThrow(
      MissingActivePatternError,
    );
  });

  it("контент реконсиляции берётся из ACTIVE-версии, даже когда РАНЕЕ вставленная RETIRED-строка с другим содержимым существует и версия job'а совпадает с ACTIVE (прямой дискриминирующий тест — не маскируется version-кросс-чеком)", async () => {
    // Discriminating test for mutation 6 ("first row instead of ACTIVE"):
    // the earlier HIGH-4 test always has the job's frozen contract
    // DISAGREE with the topic's active version, so a version-mismatch
    // throw fires before row selection even matters — that throw would
    // mask a "first row wins" regression entirely. Here the job's
    // contract.patternVersion IS made to agree with the topic's ACTIVE
    // version, so only the actual row-selection logic decides the
    // outcome — and the RETIRED row (broken content, inserted FIRST) is
    // reachable by "first row, no ORDER BY" but must never be used.
    const topicSlug = uniq("t_high4_row_selection");
    const [topic] = await ctx.db.insert(topics).values({ slug: topicSlug, name: "HIGH-4 row selection", isActive: false }).returning();
    const referenceTopicId = await activeTopicId();
    const [referenceRow] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, referenceTopicId));
    const referenceContent = referenceRow.content as { steps: unknown; requiredComponents: unknown; componentRequirements: Record<string, unknown> };

    // Phase 5's planner.ts hardcodes contract.patternVersion = 1 (frozen,
    // never touched here) — so the ACTIVE row for this test MUST be
    // version 1 for the version-cross-check to legitimately pass; a
    // BROKEN, non-active row at a DIFFERENT version number is inserted
    // FIRST so a "first row, no ACTIVE filter" regression would reach it.
    const brokenContent = {
      ...referenceContent,
      componentRequirements: {
        ...referenceContent.componentRequirements,
        SOURCE_OF_VALUE: { establishingClasses: [], requiresCurrentState: false, requiresLiveMechanismState: false, freshnessClass: "LOW_CHANGE", tokenStateSensitive: false, requiredTokenState: null },
      },
    };
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 99, status: "RETIRED", content: brokenContent });
    // ACTIVE v1, inserted SECOND — the real, correct matrix, at the exact
    // version Phase 5's hardcoded contract.patternVersion expects.
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 1, status: "ACTIVE", content: referenceContent });

    const [project] = await ctx.db.insert(projects).values({ slug: uniq("p6h4row"), name: "HIGH-4 row selection test", status: "ACTIVE_CORE" }).returning();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    // Plans against whatever is ACTIVE at plan time — version 2 — so the
    // job's own frozen contract.patternVersion legitimately agrees with
    // the topic's ACTIVE version. No version-mismatch throw possible here.
    await runMemoryPlanningStage(ctx.db, job.id);

    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(job.id, sourceId, { patternStep: 1, component: "SOURCE_OF_VALUE" });

    const result = await reconcileAndPersistComponent(ctx.db, job.id, { step: 1, component: "SOURCE_OF_VALUE" }, NOW);
    expect(result.status).toBe("SUPPORTED");
  });

  it("детерминизм: несколько версий Pattern вставлены в ОБРАТНОМ физическом порядке -> тот же результат выбора ACTIVE-версии", async () => {
    const topicSlug = uniq("t_high4_order");
    const [topic] = await ctx.db.insert(topics).values({ slug: topicSlug, name: "HIGH-4 order test", isActive: false }).returning();
    const referenceTopicId = await activeTopicId();
    const [referenceRow] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, referenceTopicId));

    // Insert newest-version-first, then older ones — physical row order
    // reversed relative to version order.
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 3, status: "ACTIVE", content: referenceRow.content });
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 2, status: "RETIRED", content: referenceRow.content });
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 1, status: "RETIRED", content: referenceRow.content });

    const { loadActivePatternVersion } = await import("../src/server/engine/active-pattern");
    const version = await loadActivePatternVersion(ctx.db, topic.id);
    expect(version).toBe(3);
  });

  it("нет ACTIVE строки вовсе -> детерминированный отказ MissingActivePatternError, не молчаливый выбор первой строки", async () => {
    const { jobId } = await makePlannedJob();
    const activeVersion = await import("../src/server/engine/active-pattern").then((m) => m);
    void activeVersion;
    const topicId = await activeTopicId();
    await ctx.db.update(researchPatterns).set({ status: "RETIRED" }).where(eq(researchPatterns.topicId, topicId));
    await expect(reconcileAndPersistComponent(ctx.db, jobId, { step: 1, component: "SOURCE_OF_VALUE" }, NOW)).rejects.toThrow(
      MissingActivePatternError,
    );
  });
});

describe("MEDIUM-3: отсутствующий componentRequirements — конфигурационный сбой, не молчаливый INSUFFICIENT_EVIDENCE", () => {
  it("Pattern content БЕЗ ключа componentRequirements вовсе (ровно посеянная до S5 форма) -> PatternConfigurationError, не ложный evidentiary-вывод", async () => {
    const topicSlug = uniq("t_medium3_no_key");
    const [topic] = await ctx.db.insert(topics).values({ slug: topicSlug, name: "MEDIUM-3 no key", isActive: false }).returning();
    const referenceTopicId = await activeTopicId();
    const [referenceRow] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, referenceTopicId));
    const contentWithoutKey = { ...(referenceRow.content as Record<string, unknown>) };
    delete (contentWithoutKey as Record<string, unknown>).componentRequirements;
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 1, status: "ACTIVE", content: contentWithoutKey });

    const [project] = await ctx.db.insert(projects).values({ slug: uniq("p6medium3"), name: "MEDIUM-3 test", status: "ACTIVE_CORE" }).returning();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    await runMemoryPlanningStage(ctx.db, job.id);

    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(job.id, sourceId, { patternStep: 1, component: "SOURCE_OF_VALUE" });

    await expect(reconcileAndPersistComponent(ctx.db, job.id, { step: 1, component: "SOURCE_OF_VALUE" }, NOW)).rejects.toThrow(
      PatternConfigurationError,
    );
  });
});

describe("§11 Pattern migration / existing DB: миграция 0015 добавляет componentRequirements к предсуществующей Pattern v1 строке", () => {
  it("реальная seeded строка (после db:migrate + seed) уже несёт componentRequirements — миграция сработала на этой БД", async () => {
    const topicId = await activeTopicId();
    const [row] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, topicId));
    const content = row.content as { componentRequirements?: Record<string, unknown> };
    expect(content.componentRequirements).toBeDefined();
    expect(Object.keys(content.componentRequirements ?? {}).length).toBe(10);
  });

  it("строка БЕЗ componentRequirements (симулирует до-миграционное состояние) + повторный прогон миграции 0015 -> ключ появляется, существующий контент не потерян", async () => {
    const topicSlug = uniq("t_migration_backfill");
    const [topic] = await ctx.db.insert(topics).values({ slug: topicSlug, name: "Migration backfill test", isActive: false }).returning();
    const referenceTopicId = await activeTopicId();
    const [referenceRow] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, referenceTopicId));
    const contentWithoutKey = { ...(referenceRow.content as Record<string, unknown>) };
    delete (contentWithoutKey as Record<string, unknown>).componentRequirements;
    await ctx.db.insert(researchPatterns).values({ topicId: topic.id, version: 1, status: "ACTIVE", content: contentWithoutKey });

    const fs = await import("node:fs/promises");
    const migrationSql = await fs.readFile(
      "src/server/db/migrations/0015_s5_backfill_component_requirements.sql",
      "utf-8",
    );
    const { sql } = await import("drizzle-orm");
    await ctx.db.execute(sql.raw(migrationSql));

    const [after] = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, topic.id));
    const content = after.content as { steps?: unknown; componentRequirements?: Record<string, unknown> };
    expect(content.componentRequirements).toBeDefined();
    expect(Object.keys(content.componentRequirements ?? {}).length).toBe(10);
    // Existing content (steps etc.) untouched — additive merge, not overwrite.
    expect(content.steps).toEqual((referenceRow.content as { steps: unknown }).steps);
  });
});
