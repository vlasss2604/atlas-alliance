import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import {
  PATTERN_V1_CONTENT,
  requiredComponentsForStep,
} from "../src/server/domain/pattern";
import {
  researchAttempts,
  projects,
  topics,
  users,
} from "../src/server/db/schema";
import {
  buildContractView,
  type ComponentWorkItem,
  type ContractView,
} from "../src/server/engine/contract-view";
import {
  runResearchController,
  type WorkExecutor,
} from "../src/server/engine/controller";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { planResearch } from "../src/server/memory/planner";
import type { RetrievalHit } from "../src/server/memory/retrieval-gateway";
import {
  coreEntitlement,
  demoEntitlement,
  setupTestDatabase,
  uniq,
  type TestContext,
} from "./phase1-setup";

// Phase 6, S3 — ResearchController tests (phase-6-plan.md §19 S3, D-070,
// D-072). Real Postgres: research_attempts persistence (idempotency,
// resume) is exactly the thing under test, so a fake DB would prove
// nothing.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-08-21T00:00:00Z");
const PRIMARY_COMPONENT: Record<number, string> = {
  1: "SOURCE_OF_VALUE",
  2: "FLOW_PATH",
  3: "MECHANISM_SPEC",
  4: "EXECUTION_EVIDENCE",
  5: "CURRENT_STATE",
  6: "DESTINATION",
  7: "NET_EFFECT",
  8: "DURABILITY_BASIS",
};
let hitSeq = 0;
function hit(
  overrides: Partial<RetrievalHit> & Pick<RetrievalHit, "patternStep">,
): RetrievalHit {
  hitSeq += 1;
  return {
    memoryId: `mem_${overrides.patternStep}_${hitSeq}`,
    component: PRIMARY_COMPONENT[overrides.patternStep],
    claimKey: `claim_${overrides.patternStep}`,
    statement: `statement for step ${overrides.patternStep}`,
    mechanismState: null,
    health: "OK",
    freshnessClass: "MEDIUM_CHANGE",
    verifiedAt: NOW,
    dataAsOf: null,
    staleAfterSeconds: null,
    confidence: 90,
    matchedVia: "ontology",
    ...overrides,
  };
}

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db
    .select()
    .from(topics)
    .where(eq(topics.isActive, true));
  return t.id;
}

async function makeJob(entitlement: ReturnType<typeof coreEntitlement>) {
  const topicId = await activeTopicId();
  const [project] = await ctx.db
    .insert(projects)
    .values({
      slug: uniq("p6ctrl"),
      name: "Controller test",
      status: "ACTIVE_CORE",
    })
    .returning();
  const userId = await insertUser();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId,
    topicId,
    projectId: project.id,
    originalQuestion: "q",
    normalizedTask: {
      project_slug: project.slug,
      project_slugs: [project.slug],
      task: "q",
    },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement,
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

async function insertUser(): Promise<string> {
  const [u] = await ctx.db.insert(users).values({}).returning();
  return u.id;
}

// A deterministic fake — always resolves the same way for the same
// component. Used to prove D-070: swapping this for a different
// deterministic fake must not change scope, budget accounting, or stop
// reason, only which attempts succeed.
function fakeExecutor(
  resolve: (item: ComponentWorkItem) => "SUCCEEDED" | "FAILED" | "SKIPPED",
): WorkExecutor {
  return {
    async execute(item) {
      return {
        status: resolve(item),
        reason: `fake: ${item.component}`,
        spent: { searchQueries: 1, sourceOpens: 1, modelCostMicro: 100 },
      };
    },
  };
}

function fullCoverageHits(confidence = 95): RetrievalHit[] {
  return PATTERN_V1_CONTENT.steps.flatMap((s) =>
    requiredComponentsForStep(PATTERN_V1_CONTENT, s.step).map((component) =>
      hit({ patternStep: s.step, component, confidence }),
    ),
  );
}

function plan(
  hits: RetrievalHit[],
  overrides: Partial<Parameters<typeof planResearch>[0]> = {},
) {
  return planResearch({
    memoryEnabled: true,
    hits,
    pattern: PATTERN_V1_CONTENT,
    capabilityAtStart: "FRESH_RESEARCH",
    budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_core,
    config: DEFAULT_PRODUCT_CONFIG,
    now: NOW,
    ...overrides,
  });
}

describe("Фаза 6, S3 — ResearchController (детерминированный скелет)", () => {
  it("1. планирует ТОЛЬКО workQueue из ContractView — reused и excluded не исполняются", async () => {
    const r = plan([
      hit({ patternStep: 3, component: "MECHANISM_SPEC", confidence: 95 }),
    ]);
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    const jobId = await makeJob(coreEntitlement());

    const executed: string[] = [];
    const executor = fakeExecutor((item) => {
      executed.push(`${item.step}:${item.component}`);
      return "SUCCEEDED";
    });

    const result = await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor,
      now: NOW,
    });

    expect(executed).not.toContain("3:MECHANISM_SPEC"); // уже SATISFIED памятью — не исследуется
    expect(executed.length).toBe(view.workQueue.length);
    expect(result.succeeded.length).toBe(view.workQueue.length);
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
  });

  it("2. потолок capability: пустая очередь работы из-за исключённых компонентов -> CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK, executor не вызывается", async () => {
    const r = plan([], {
      capabilityAtStart: "TARGETED_REFRESH",
      budgetAtStart: DEFAULT_PRODUCT_CONFIG.budget_demo,
    });
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "TARGETED_REFRESH",
    });
    const jobId = await makeJob(demoEntitlement());

    let calls = 0;
    const executor: WorkExecutor = {
      async execute() {
        calls++;
        return { status: "SUCCEEDED" };
      },
    };
    const result = await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor,
      now: NOW,
    });

    expect(calls).toBe(0);
    expect(result.stopReason).toBe("CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK");
    expect(result.attemptsThisRun).toBe(0);
  });

  it("3. бюджет: обычный потолок (maxSearchQueries - reservedRecoverySteps попыток) останавливает исполнение", async () => {
    const r = plan([]); // все 10 компонентов MISSING -> все в workQueue
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    const jobId = await makeJob(coreEntitlement());

    const smallBudgetView: ContractView = {
      ...view,
      researchBudget: {
        ...view.researchBudget,
        maxSearchQueries: 3,
        reservedRecoverySteps: 1,
      },
    };
    const executor = fakeExecutor(() => "SUCCEEDED");
    const result = await runResearchController({
      db: ctx.db,
      jobId,
      view: smallBudgetView,
      executor,
      now: NOW,
    });

    // normalCeiling = 3 - 1 = 2 попытки максимум до BUDGET_EXHAUSTED
    expect(result.attemptsThisRun).toBe(2);
    expect(result.stopReason).toBe("BUDGET_EXHAUSTED");
    expect(result.succeeded.length).toBe(2);
  });

  it("4. восстановление в пределах reservedRecoverySteps: повторная попытка проваленного компонента списывается с резерва, не с обычного бюджета", async () => {
    const r = plan([
      hit({ patternStep: 1, component: "SOURCE_OF_VALUE", confidence: 10 }),
    ]); // REQUIRED_FRESH, low confidence -> в очереди
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    const jobId = await makeJob(coreEntitlement());

    // Первая попытка проваливается искусственно.
    let attempt = 0;
    const executor: WorkExecutor = {
      async execute(item) {
        attempt++;
        if (item.step === 1 && attempt === 1)
          return { status: "FAILED", reason: "first try fails" };
        return { status: "SUCCEEDED" };
      },
    };
    const first = await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor,
      now: NOW,
    });
    expect(first.failed.some((i) => i.step === 1)).toBe(true);
    expect(first.recoveryAttemptsUsed).toBe(0); // первая попытка — обычная, не recovery

    // Второй прогон того же job'а: тот же workQueue (step 1 остаётся,
    // т.к. не SUCCEEDED), но теперь это RECOVERY-попытка.
    const second = await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor,
      now: NOW,
    });
    expect(second.recoveryAttemptsUsed).toBe(1);
    expect(second.succeeded.some((i) => i.step === 1)).toBe(true);

    const rows = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    const step1Rows = rows
      .filter((r2) => r2.patternStep === 1)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
    expect(step1Rows.map((r2) => [r2.attemptNumber, r2.status])).toEqual([
      [1, "FAILED"],
      [2, "SUCCEEDED"],
    ]);
  });

  it("5. восстановление исчерпано: попытка сверх reservedRecoverySteps даёт BUDGET_EXHAUSTED, а не бесконечный ретрай", async () => {
    const r = plan([
      hit({ patternStep: 1, component: "SOURCE_OF_VALUE", confidence: 10 }),
    ]);
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    const jobId = await makeJob(coreEntitlement());
    const zeroRecoveryView: ContractView = {
      ...view,
      researchBudget: { ...view.researchBudget, reservedRecoverySteps: 0 },
    };

    const executor: WorkExecutor = {
      async execute() {
        return { status: "FAILED", reason: "always fails" };
      },
    };
    await runResearchController({
      db: ctx.db,
      jobId,
      view: zeroRecoveryView,
      executor,
      now: NOW,
    }); // consumes the one normal attempt
    const second = await runResearchController({
      db: ctx.db,
      jobId,
      view: zeroRecoveryView,
      executor,
      now: NOW,
    });

    expect(second.stopReason).toBe("BUDGET_EXHAUSTED");
    expect(second.attemptsThisRun).toBe(0); // recoveryCeiling=0, никакой попытки не сделано
  });

  it("6. идемпотентность/resume: убитый посередине воркер не повторяет уже успешные компоненты", async () => {
    const r = plan(fullCoverageHits().filter((h) => h.patternStep <= 2)); // steps 1,2 satisfied -> остальные 8 компонентов в очереди
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    const jobId = await makeJob(coreEntitlement());
    const executed: string[] = [];
    const executor = fakeExecutor((item) => {
      executed.push(`${item.step}:${item.component}`);
      return "SUCCEEDED";
    });

    // "Воркер умирает" после 3 попыток.
    const first = await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor,
      now: NOW,
      maxAttemptsThisRun: 3,
    });
    expect(first.stopReason).toBe("INTERRUPTED");
    expect(first.attemptsThisRun).toBe(3);

    // Восстановление: та же ContractView, полный запуск без ограничения.
    const second = await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor,
      now: NOW,
    });
    expect(second.stopReason).toBe("WORK_QUEUE_EXHAUSTED");

    // Каждый компонент исполнен РОВНО один раз в сумме между прогонами —
    // не переисполнен после рестарта.
    const counts = new Map<string, number>();
    for (const e of executed) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const [, count] of counts) expect(count).toBe(1);
    expect(executed.length).toBe(view.workQueue.length);
  });

  it("7. D-070: подмена executor'а на другой детерминированный fake не меняет область, бюджет или stop reason — только исход попыток", async () => {
    const r = plan([]);
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });

    const jobA = await makeJob(coreEntitlement());
    const jobB = await makeJob(coreEntitlement());

    const executorAllSucceed = fakeExecutor(() => "SUCCEEDED");
    const executorAllFail = fakeExecutor(() => "FAILED");

    const resultA = await runResearchController({
      db: ctx.db,
      jobId: jobA,
      view,
      executor: executorAllSucceed,
      now: NOW,
    });
    const resultB = await runResearchController({
      db: ctx.db,
      jobId: jobB,
      view,
      executor: executorAllFail,
      now: NOW,
    });

    // Область (сколько компонентов рассмотрено) и бюджетный учёт (сколько
    // попыток списано) идентичны — отличается только succeeded/failed.
    expect(resultA.attemptsThisRun).toBe(resultB.attemptsThisRun);
    expect(resultA.attemptsThisRun).toBe(view.workQueue.length);
    expect(resultA.stopReason).toBe(resultB.stopReason);
    expect(resultA.succeeded.length).toBe(view.workQueue.length);
    expect(resultB.failed.length).toBe(view.workQueue.length);
  });

  it("8. track attempts: каждая попытка персистится с детерминированной причиной остановки", async () => {
    const r = plan([
      hit({ patternStep: 4, component: "EXECUTION_EVIDENCE", confidence: 95 }),
    ]);
    const view = buildContractView({
      contract: r.contract,
      mode: r.mode,
      capabilityAtStart: "FRESH_RESEARCH",
    });
    const jobId = await makeJob(coreEntitlement());
    const executor = fakeExecutor(() => "SUCCEEDED");

    await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor,
      now: NOW,
    });

    const rows = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    expect(rows.length).toBe(view.workQueue.length);
    for (const row of rows) {
      expect(row.status).toBe("SUCCEEDED");
      expect(row.reason).toMatch(/^fake:/);
      expect(row.completedAt).not.toBeNull();
    }
    // Компонент 4 уже был SATISFIED памятью — попытки по нему нет вовсе.
    expect(
      rows.some(
        (row) =>
          row.patternStep === 4 && row.component === "EXECUTION_EVIDENCE",
      ),
    ).toBe(false);
  });
});
