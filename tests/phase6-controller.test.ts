import { eq, sql } from "drizzle-orm";
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

  // HIGH-1 fix: reservedRecoverySteps must be a JOB-LIFETIME limit,
  // derived from persisted research_attempts, not a per-run counter that
  // resets on every redelivery/restart.
  describe("HIGH-1 — recovery budget is job-lifetime, not per-run", () => {
    function singleComponentView(reservedRecoverySteps: number, maxSearchQueries = 10): ContractView {
      const r = plan([hit({ patternStep: 1, component: "SOURCE_OF_VALUE", confidence: 10 })]); // UNUSABLE -> в очереди
      const view = buildContractView({ contract: r.contract, mode: r.mode, capabilityAtStart: "FRESH_RESEARCH" });
      return {
        ...view,
        workQueue: view.workQueue.filter((c) => c.step === 1 && c.component === "SOURCE_OF_VALUE"),
        excludedComponents: [],
        researchBudget: { ...view.researchBudget, maxSearchQueries, reservedRecoverySteps },
      };
    }
    const alwaysFail: WorkExecutor = { async execute() { return { status: "FAILED", reason: "always fails" }; } };

    it("restart/redelivery: суммарная recovery-ёмкость (=1) не восстанавливается ни одним из множества перезапусков", async () => {
      const view = singleComponentView(1);
      const jobId = await makeJob(coreEntitlement());

      const r1 = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW }); // attempt 1 (normal) — fails
      expect(r1.attemptsThisRun).toBe(1);
      expect(r1.recoveryAttemptsUsed).toBe(0);

      const r2 = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW }); // attempt 2 (recovery) — consumes the 1 reserved slot, fails
      expect(r2.attemptsThisRun).toBe(1);
      expect(r2.recoveryAttemptsUsed).toBe(1);
      expect(r2.stopReason).toBe("WORK_QUEUE_EXHAUSTED");

      // Три дополнительных "рестарта/редеставки" подряд — ни один не
      // должен восстановить исчерпанную recovery-ёмкость или создать
      // ещё одну попытку.
      for (let i = 0; i < 3; i++) {
        const rN = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW });
        expect(rN.attemptsThisRun).toBe(0);
        expect(rN.stopReason).toBe("BUDGET_EXHAUSTED");
        expect(rN.recoveryAttemptsUsed).toBe(1); // остаётся 1, никогда не больше
      }

      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(2); // ровно attempt 1 и attempt 2 — рестарты не создали третью попытку
    });

    it("recovery затем restart: восстановление успевает один раз, дальнейшие рестарты не дают второй попытки", async () => {
      const view = singleComponentView(1);
      const jobId = await makeJob(coreEntitlement());
      let call = 0;
      const failThenSucceed: WorkExecutor = {
        async execute() {
          call++;
          return call === 1 ? { status: "FAILED", reason: "first fails" } : { status: "SUCCEEDED" };
        },
      };
      await runResearchController({ db: ctx.db, jobId, view, executor: failThenSucceed, now: NOW }); // attempt 1 fails
      const recovered = await runResearchController({ db: ctx.db, jobId, view, executor: failThenSucceed, now: NOW }); // attempt 2 (recovery) succeeds
      expect(recovered.succeeded.length).toBe(1);
      expect(recovered.recoveryAttemptsUsed).toBe(1);

      // "Рестарт" после успеха: компонент уже SUCCEEDED -> ничего не
      // делает, recovery-счётчик остаётся историческим (1), не растёт.
      const after = await runResearchController({ db: ctx.db, jobId, view, executor: failThenSucceed, now: NOW });
      expect(after.attemptsThisRun).toBe(0);
      expect(after.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    });

    it("точная граница бюджета: reservedRecoverySteps=2 разрешает РОВНО 2 recovery-попытки за всю жизнь job'а", async () => {
      const view = singleComponentView(2);
      const jobId = await makeJob(coreEntitlement());
      await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW }); // attempt 1 normal
      const r2 = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW }); // attempt 2 recovery #1
      expect(r2.attemptsThisRun).toBe(1);
      const r3 = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW }); // attempt 3 recovery #2 — граница
      expect(r3.attemptsThisRun).toBe(1);
      expect(r3.recoveryAttemptsUsed).toBe(2);
      const r4 = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW }); // за границей
      expect(r4.attemptsThisRun).toBe(0);
      expect(r4.stopReason).toBe("BUDGET_EXHAUSTED");
    });

    it("нулевой резерв: reservedRecoverySteps=0 не разрешает НИ ОДНОЙ recovery-попытки, даже после многих рестартов", async () => {
      const view = singleComponentView(0);
      const jobId = await makeJob(coreEntitlement());
      await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW }); // attempt 1 normal, fails
      for (let i = 0; i < 3; i++) {
        const r = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW });
        expect(r.attemptsThisRun).toBe(0);
        expect(r.stopReason).toBe("BUDGET_EXHAUSTED");
      }
      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(1); // только attempt 1 — никогда вторая попытка
    });

    it("испорченная персистентная история попыток (пропуски/не по порядку) всё равно корректно ограничивает recovery-ёмкость", async () => {
      const view = singleComponentView(1);
      const jobId = await makeJob(coreEntitlement());
      // Вручную создаём "грязную" историю: attempt_number идут не по
      // порядку и содержат пропуск (нет №2), но есть №1 и №5 — оба
      // персистентно существуют до первого настоящего вызова контроллера.
      await ctx.db.insert(researchAttempts).values([
        { researchJobId: jobId, patternStep: 1, component: "SOURCE_OF_VALUE", attemptNumber: 5, status: "FAILED", reason: "stray high attempt number" },
        { researchJobId: jobId, patternStep: 1, component: "SOURCE_OF_VALUE", attemptNumber: 1, status: "FAILED", reason: "normal attempt" },
      ]);
      // Один персистентный recovery-номер (5 > 1) уже занял единственный
      // зарезервированный слот — новый вызов не должен получить попытку.
      const result = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysFail, now: NOW });
      expect(result.attemptsThisRun).toBe(0);
      expect(result.stopReason).toBe("BUDGET_EXHAUSTED");
      expect(result.recoveryAttemptsUsed).toBe(1);
      // Следующая попытка (если бы была создана) обязана нумероваться
      // строго выше максимума уже увиденного (6), не №2 — доказывается
      // косвенно тем, что ни одна новая строка не появилась.
      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(2);
    });
  });

  // MEDIUM-3 fix: the STARTED insert is a real DB-atomic claim
  // (onConflictDoNothing + RETURNING against the unique index). Two
  // concurrent controller invocations racing for the same (job, step,
  // component) attempt must execute the external work exactly once — the
  // loser must never call the executor at all.
  describe("MEDIUM-3 — атомарный claim попытки под конкурентными вызовами", () => {
    it("два параллельных runResearchController на одном job'е с одной и той же ожидающей работой: внешний executor вызывается ровно один раз", async () => {
      const r = plan([hit({ patternStep: 1, component: "SOURCE_OF_VALUE", confidence: 10 })]); // единственный элемент очереди
      const view = buildContractView({ contract: r.contract, mode: r.mode, capabilityAtStart: "FRESH_RESEARCH" });
      const singleItemView: ContractView = {
        ...view,
        workQueue: view.workQueue.filter((c) => c.step === 1 && c.component === "SOURCE_OF_VALUE"),
        excludedComponents: [],
      };
      const jobId = await makeJob(coreEntitlement());

      let executions = 0;
      const countingExecutor: WorkExecutor = {
        async execute() {
          executions++;
          return { status: "SUCCEEDED" };
        },
      };

      const [resultA, resultB] = await Promise.all([
        runResearchController({ db: ctx.db, jobId, view: singleItemView, executor: countingExecutor, now: NOW }),
        runResearchController({ db: ctx.db, jobId, view: singleItemView, executor: countingExecutor, now: NOW }),
      ]);

      // Внешняя работа выполнена РОВНО один раз суммарно между двумя
      // конкурентными вызовами, а не дважды.
      expect(executions).toBe(1);

      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(1); // ровно одна строка попытки, не дубликат
      expect(rows[0].status).toBe("SUCCEEDED");

      // Ровно один из двух вызовов сообщает о фактическом исполнении;
      // другой — либо ничего не сделал (проиграл claim), либо доложил о
      // том же успехе (если его вызов случился уже ПОСЛЕ того, как первый
      // и claim, и запись успеха успели персистироваться) — оба исхода
      // корректны, важно лишь что суммарно исполнение было одно.
      const totalSucceeded = resultA.succeeded.length + resultB.succeeded.length;
      const totalAttempts = resultA.attemptsThisRun + resultB.attemptsThisRun;
      expect(totalAttempts).toBeLessThanOrEqual(2); // никогда больше одной попытки на "владельца" исхода
      expect(totalSucceeded).toBeGreaterThanOrEqual(1);
    });

    it("проигравший claim вызов не тратит бюджет — 10 параллельных вызовов на бюджет с местом ровно под 1 попытку не создают лишних STARTED-строк", async () => {
      const r = plan([hit({ patternStep: 1, component: "SOURCE_OF_VALUE", confidence: 10 })]);
      const view = buildContractView({ contract: r.contract, mode: r.mode, capabilityAtStart: "FRESH_RESEARCH" });
      const singleItemView: ContractView = {
        ...view,
        workQueue: view.workQueue.filter((c) => c.step === 1 && c.component === "SOURCE_OF_VALUE"),
        excludedComponents: [],
        researchBudget: { ...view.researchBudget, maxSearchQueries: 1, reservedRecoverySteps: 0 },
      };
      const jobId = await makeJob(coreEntitlement());
      let executions = 0;
      const countingExecutor: WorkExecutor = {
        async execute() {
          executions++;
          return { status: "SUCCEEDED" };
        },
      };

      await Promise.all(
        Array.from({ length: 10 }, () =>
          runResearchController({ db: ctx.db, jobId, view: singleItemView, executor: countingExecutor, now: NOW }),
        ),
      );

      expect(executions).toBe(1);
      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(1); // ни одна из 9 проигравших попыток claim не создала свою строку
    });
  });

  // R-1 fix (final re-review): sequential/restart accounting (HIGH-1) and
  // the per-component atomic claim (MEDIUM-3) were both correct in
  // isolation, but two CONCURRENT runResearchController invocations could
  // each read the same persisted job-level budget state independently and
  // both authorize a claim against it — over-spending the job-lifetime
  // pool even though no single (step, component) was ever double-executed.
  // The fix makes "read persisted attempts -> check job-level budget ->
  // claim next attempt" one DB-atomic operation per job, via
  // SELECT ... FROM research_jobs WHERE id = $1 FOR UPDATE serializing
  // every concurrent claim transaction for that job.
  describe("R-1 — атомарная job-level авторизация бюджета под конкурентными вызовами", () => {
    function multiComponentView(
      items: Array<{ step: number; component: string }>,
      reservedRecoverySteps: number,
      maxSearchQueries = 10,
      budgetOverrides: Partial<ContractView["researchBudget"]> = {},
    ): ContractView {
      const hits = items.map(({ step, component }) => hit({ patternStep: step, component, confidence: 10 }));
      const r = plan(hits);
      const view = buildContractView({ contract: r.contract, mode: r.mode, capabilityAtStart: "FRESH_RESEARCH" });
      const keys = new Set(items.map((i) => `${i.step}:${i.component}`));
      return {
        ...view,
        workQueue: view.workQueue.filter((c) => keys.has(`${c.step}:${c.component}`)),
        excludedComponents: [],
        researchBudget: { ...view.researchBudget, maxSearchQueries, reservedRecoverySteps, ...budgetOverrides },
      };
    }

    // Tests 1-3 deliberately give EACH concurrent invocation a
    // single-item view for a DIFFERENT (step, component) — not the same
    // shared view — and set debugClaimDelayMs so every invocation's
    // claim transaction genuinely overlaps the others' inside the
    // read-check-insert window. This is what actually exercises R-1: the
    // pre-existing per-component unique index already prevents two
    // invocations from double-claiming the SAME item regardless of any
    // job-level lock, so a test where every invocation races for the
    // SAME item (or races through a shared, identically-ordered pending
    // list) can pass by accident even with no job-level lock at all.
    // Racing genuinely DIFFERENT keys is the only way to isolate what
    // R-1 actually added.
    it("1. reservedRecoverySteps=1, 3 РАЗНЫХ компонента уже провалились один раз, конкурентные вызовы на разные компоненты одновременно -> ровно 1 recovery claim/execution за всю жизнь job'а", async () => {
      const items = [
        { step: 1, component: "SOURCE_OF_VALUE" },
        { step: 2, component: "FLOW_PATH" },
        { step: 3, component: "MECHANISM_SPEC" },
      ];
      const jobId = await makeJob(coreEntitlement());
      await ctx.db.insert(researchAttempts).values(
        items.map(({ step, component }) => ({
          researchJobId: jobId,
          patternStep: step,
          component,
          attemptNumber: 1,
          status: "FAILED" as const,
          reason: "seed: already failed once",
        })),
      );

      let executions = 0;
      const countingExecutor: WorkExecutor = {
        async execute() {
          executions++;
          return { status: "SUCCEEDED" };
        },
      };

      const perItemViews = items.map((i) => multiComponentView([i], 1));
      await Promise.all(
        perItemViews.map((view) =>
          runResearchController({ db: ctx.db, jobId, view, executor: countingExecutor, now: NOW, debugClaimDelayMs: 60 }),
        ),
      );

      expect(executions).toBe(1); // ровно один recovery-claim выигран за всю жизнь job'а
      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      const recoveryRows = rows.filter((r) => r.attemptNumber > 1);
      expect(recoveryRows.length).toBe(1); // не 3 (по одному на компонент), не 0 — ровно граница
    });

    it("2. несколько РАЗНЫХ компонентов делят один recovery-пул (ceiling=2), конкурентные вызовы на разные компоненты одновременно -> персистентные recovery-попытки никогда не превышают потолок", async () => {
      const items = [
        { step: 1, component: "SOURCE_OF_VALUE" },
        { step: 2, component: "FLOW_PATH" },
        { step: 3, component: "MECHANISM_SPEC" },
        { step: 4, component: "EXECUTION_EVIDENCE" },
      ];
      const jobId = await makeJob(coreEntitlement());
      await ctx.db.insert(researchAttempts).values(
        items.map(({ step, component }) => ({
          researchJobId: jobId,
          patternStep: step,
          component,
          attemptNumber: 1,
          status: "FAILED" as const,
          reason: "seed",
        })),
      );
      const alwaysSucceed: WorkExecutor = { async execute() { return { status: "SUCCEEDED" }; } };

      const perItemViews = items.map((i) => multiComponentView([i], 2));
      await Promise.all(
        perItemViews.map((view) =>
          runResearchController({ db: ctx.db, jobId, view, executor: alwaysSucceed, now: NOW, debugClaimDelayMs: 60 }),
        ),
      );

      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      const recoveryRows = rows.filter((r) => r.attemptNumber > 1);
      expect(recoveryRows.length).toBe(2); // ровно потолок, не 4 (по одному на компонент)
    });

    it("3. конкурентная авторизация нормального бюджета на РАЗНЫХ компонентах -> normal-пул тоже не может быть перерасходован", async () => {
      const items = [
        { step: 1, component: "SOURCE_OF_VALUE" },
        { step: 2, component: "FLOW_PATH" },
        { step: 3, component: "MECHANISM_SPEC" },
        { step: 4, component: "EXECUTION_EVIDENCE" },
        { step: 5, component: "CURRENT_STATE" },
      ];
      const jobId = await makeJob(coreEntitlement());
      let executions = 0;
      const countingExecutor: WorkExecutor = {
        async execute() {
          executions++;
          return { status: "SUCCEEDED" };
        },
      };

      // reservedRecoverySteps=0 -> normalCeiling = maxSearchQueries = 2.
      const perItemViews = items.map((i) => multiComponentView([i], 0, 2));
      await Promise.all(
        perItemViews.map((view) =>
          runResearchController({ db: ctx.db, jobId, view, executor: countingExecutor, now: NOW, debugClaimDelayMs: 60 }),
        ),
      );

      expect(executions).toBe(2); // ровно normalCeiling, не 5 (по одному на компонент)
      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(2);
    });

    it("4. рестарт после конкурентных claim'ов -> персистентный учёт остаётся авторитетным, новых попыток не создаётся", async () => {
      const items = [
        { step: 1, component: "SOURCE_OF_VALUE" },
        { step: 2, component: "FLOW_PATH" },
      ];
      const view = multiComponentView(items, 0, 1); // normalCeiling=1
      const jobId = await makeJob(coreEntitlement());
      const alwaysSucceed: WorkExecutor = { async execute() { return { status: "SUCCEEDED" }; } };

      await Promise.all(
        Array.from({ length: 5 }, () =>
          runResearchController({ db: ctx.db, jobId, view, executor: alwaysSucceed, now: NOW }),
        ),
      );
      const rowsAfterConcurrency = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rowsAfterConcurrency.length).toBe(1); // потолок в 1 попытку соблюдён

      // "Рестарт": ещё один, последовательный вызов не должен создать
      // вторую попытку — второй компонент навсегда остаётся неисполненным
      // под этим бюджетом, персистентный учёт (не память процесса)
      // остаётся источником истины.
      const restart = await runResearchController({ db: ctx.db, jobId, view, executor: alwaysSucceed, now: NOW });
      expect(restart.attemptsThisRun).toBe(0);
      expect(restart.stopReason).toBe("BUDGET_EXHAUSTED");
      const rowsAfterRestart = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rowsAfterRestart.length).toBe(1); // не выросло
    });

    it("5. проигранная авторизация/claim -> executor не вызывается, бюджет не тратится (ни своим, ни чужим счётом)", async () => {
      const items = [{ step: 1, component: "SOURCE_OF_VALUE" }];
      const view = multiComponentView(items, 0, 1);
      const jobId = await makeJob(coreEntitlement());
      let executions = 0;
      const countingExecutor: WorkExecutor = {
        async execute() {
          executions++;
          return {
            status: "SUCCEEDED",
            spent: { searchQueries: 7, sourceOpens: 3, modelCostMicro: 1000 },
          };
        },
      };

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          runResearchController({ db: ctx.db, jobId, view, executor: countingExecutor, now: NOW }),
        ),
      );

      expect(executions).toBe(1);
      // Суммарный budgetSpent, зарепорченный по ВСЕМ 8 вызовам вместе,
      // равен тому, что вернул РОВНО один исполнивший вызов — ни один из
      // проигравших не приписал себе (и не задвоил) чужие траты.
      const totalSearchQueries = results.reduce((sum, r) => sum + r.budgetSpent.searchQueries, 0);
      expect(totalSearchQueries).toBe(7);
    });

    it("6. крах после внешнего исполнения, но до терминальной персистенции -> честный at-least-once replay использует recovery-ёмкость и не превышает потолок job'а", async () => {
      const items = [{ step: 1, component: "SOURCE_OF_VALUE" }];
      // maxWallClockSec=60 -> derived lease (120_000ms) is below the
      // ATTEMPT_LEASE_FLOOR_MS (5 min), so the floor governs here: the
      // effective lease is still 5 minutes, never LESS generous than the
      // prior fixed default regardless of how small the job's own
      // wall-clock ceiling is.
      const view = multiComponentView(items, 1, 10, { maxWallClockSec: 60 }); // recoveryCeiling=1
      const jobId = await makeJob(coreEntitlement());

      // Симулируем "крах": строка попытки застряла в STARTED — executor,
      // предположительно, уже отработал, но терминальный UPDATE так и не
      // персистировался. createdAt намеренно старше эффективного lease
      // (здесь: floor = 5 минут) относительно `now` ниже — иначе от
      // честного in-flight конкурента это неотличимо (и не должно быть
      // переисполнено).
      const staleStartedAt = new Date(NOW.getTime() - 6 * 60 * 1000); // 6 минут назад > 5-минутного floor
      await ctx.db.execute(
        sql`INSERT INTO research_attempts (research_job_id, pattern_step, component, attempt_number, status, created_at)
            VALUES (${jobId}, 1, 'SOURCE_OF_VALUE', 1, 'STARTED', ${staleStartedAt.toISOString()})`,
      );

      let executions = 0;
      const countingExecutor: WorkExecutor = {
        async execute() {
          executions++;
          return { status: "SUCCEEDED" };
        },
      };

      const replay = await runResearchController({ db: ctx.db, jobId, view, executor: countingExecutor, now: NOW });
      expect(executions).toBe(1); // reclaim honestly re-executes exactly once
      expect(replay.succeeded.length).toBe(1);
      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(2); // исходная застрявшая STARTED + один replay
      const recoveryRows = rows.filter((r) => r.attemptNumber > 1);
      expect(recoveryRows.length).toBe(1); // replay корректно списан с recovery-ёмкости

      // Потолок job'а (=1) остаётся в силе для ЛЮБЫХ дальнейших рестартов —
      // ёмкость не регенерируется тем, что предыдущая попытка была replay,
      // а не "нормальной" recovery-попыткой.
      const another = await runResearchController({ db: ctx.db, jobId, view, executor: countingExecutor, now: NOW });
      expect(another.attemptsThisRun).toBe(0);
    });

    // S4 test matrix item 17 — this is the "previous missing 'fresh
    // STARTED blocks reclaim' test" the final S0-S3 review called out as
    // needing teeth: a legitimate in-flight attempt inside its VALID
    // DERIVED lease (not the old fixed 5-minute constant) must not be
    // reclaimed. CORE's maxWallClockSec=1200s (20 minutes) means a
    // healthy attempt started 6 minutes ago is nowhere near abandoned —
    // under the old fixed 5-minute lease this would have been WRONGLY
    // reclaimed and double-executed.
    it("7. легитимная свежая STARTED-попытка внутри своего производного lease НЕ подлежит reclaim, даже когда её возраст уже превысил бы старый фиксированный 5-минутный lease", async () => {
      const items = [{ step: 1, component: "SOURCE_OF_VALUE" }];
      const view = multiComponentView(items, 1, 10, { maxWallClockSec: 1200 }); // CORE: 20 minutes
      const jobId = await makeJob(coreEntitlement());

      const sixMinutesAgo = new Date(NOW.getTime() - 6 * 60 * 1000); // > old fixed 5-min lease
      await ctx.db.execute(
        sql`INSERT INTO research_attempts (research_job_id, pattern_step, component, attempt_number, status, created_at)
            VALUES (${jobId}, 1, 'SOURCE_OF_VALUE', 1, 'STARTED', ${sixMinutesAgo.toISOString()})`,
      );

      let executions = 0;
      const countingExecutor: WorkExecutor = {
        async execute() {
          executions++;
          return { status: "SUCCEEDED" };
        },
      };

      const result = await runResearchController({ db: ctx.db, jobId, view, executor: countingExecutor, now: NOW });
      expect(executions).toBe(0); // NOT reclaimed — still within its derived lease
      expect(result.attemptsThisRun).toBe(0);
      const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
      expect(rows.length).toBe(1); // only the original in-flight row — no replay row created
      expect(rows[0].status).toBe("STARTED");
    });
  });
});
