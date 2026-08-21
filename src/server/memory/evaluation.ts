import { eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { DEFAULT_PRODUCT_CONFIG } from "../config/product";
import type { Database } from "../db/client";
import {
  productConfig,
  projects,
  researchMemory,
  researchMemoryProvenance,
  researchPlans,
  sources,
  users,
} from "../db/schema";
import type { EntitlementSnapshot, ResearchCapability } from "../domain/types";
import { createResearchJob } from "../jobs/research-jobs";
import type { ResearchBoundaryContract } from "./contract";
import {
  copyProvenance,
  observeMemoryCandidate,
  promoteToActive,
} from "./lifecycle";
import { runMemoryPlanningStage } from "./plan-job";
import type { MemoryHealth } from "./retrieval-gateway";

// Golden set (phase-5-plan.md §7.2–7.3, D-049, corrected D-061/D-066).
// Память сеется нами — значит правильный ответ retrieval известен заранее,
// и метрику можно посчитать объективно, а не оценкой на глаз.

// D-061: причины, по которым КОНТРОЛИРУЕМАЯ истина сценария считает факт
// НЕ переиспользуемым. Ground truth — то, что задал автор сценария, а не
// то, что решил планировщик; см. requirement "Do not tailor expected truth
// labels from planner output."
export const INVALID_REUSE_REASONS = [
  "STALE",
  "LOW_CONFIDENCE",
  "WRONG_PROJECT",
  "UNHEALTHY",
  "UNPROMOTED",
  "WRONG_STEP_MAPPING",
  "CONTRADICTED",
] as const;
export type InvalidReuseReason = (typeof INVALID_REUSE_REASONS)[number];

export interface GoldenMemoryFact {
  patternStep: number;
  // D-060: компонент шага — обязателен, наравне с production-путём
  // observeMemoryCandidate. wrong_step_mapping-сценарии заполняют его
  // компонентом, НЕ входящим в requiredComponents шага (invalidReason
  // WRONG_STEP_MAPPING), а не искажают patternStep.
  component: string;
  claimKey: string;
  statement: string;
  mechanismState?: string | null;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verifiedAt: Date;
  // Postgres interval-литерал (MEDIUM-1 regression: '36 hours', '3 months', …).
  staleAfter?: string | null;
  confidence: number;
  // health по умолчанию OK; сценарии D-059 задают QUESTIONABLE/REVERIFY/
  // STALE/DEPRECATED явно.
  health?: MemoryHealth;
  // false => остаётся CANDIDATE (не промоутится) — сценарий отравления:
  // непроверенный кандидат структурно недоступен retrieval (D-021/D-025).
  promote: boolean;
  // D-061 ground truth: реально ли БЕЗОПАСНО переиспользовать этот факт,
  // если бы он оказался задействован в решении шага. Устанавливается
  // автором сценария, НЕЗАВИСИМО от того, что вернёт планировщик.
  reusable: boolean;
  invalidReason?: InvalidReuseReason;
}

export type ScenarioAngle =
  | "norm"
  | "completeness"
  | "freshness"
  | "sufficiency"
  | "capability_boundary"
  | "wording"
  | "poisoning"
  | "cross_project"
  | "health"
  | "stale_after_interval"
  | "component_mapping"
  | "partial_coverage"
  | "contradiction"
  | "false_reuse";

export interface GoldenScenario {
  name: string;
  angle: ScenarioAngle;
  seedFacts: GoldenMemoryFact[];
  // Факты «чужого проекта» — угол cross_project: сеются в ДРУГОЙ проект и
  // по определению не должны найтись для этого сценария.
  foreignProjectSeedFacts?: GoldenMemoryFact[];
  statementQuery?: string;
  capability: ResearchCapability;
  // Правда сида: какие шаги ОБЯЗАНЫ быть already_satisfied на выходе.
  expectedSatisfiedSteps: number[];
}

export interface FalseReuseDetail {
  step: number;
  memoryIds: string[];
  reasons: InvalidReuseReason[];
}

export interface ScenarioResult {
  scenario: string;
  angle: ScenarioAngle;
  contractOn: ResearchBoundaryContract;
  contractOff: ResearchBoundaryContract;
  modeOn: string;
  modeOff: string;
  // D-066: undefined когда expectedSatisfiedSteps пуст — recall/precision
  // математически не определены на сценарии без положительных ожиданий,
  // синтетическая единица их больше не подменяет.
  recall: number | undefined;
  precision: number | undefined;
  // Отдельная метрика для negative-only сценариев (D-066): не было ли
  // ложных срабатываний, когда ожидаемое множество пусто.
  noFalsePositive: boolean | undefined;
  noiseRate: number;
  // D-061: считается по ШАГАМ (не по memory-записям).
  reuseStepCount: number;
  falseReuseStepCount: number;
  falseReuseDetails: FalseReuseDetail[];
  stepsSkipped: number;
  stepsRefreshed: number;
  searchDelta: number;
  // Читается из contract.stopConditions (planner.ts уже пишет туда честную
  // границу при зажатии режима) — не пересчитывается заново, только читается.
  capabilityCeilingHit: boolean;
  capabilityCeilingNote: string | null;
}

// Планировщик уже кладёт эту строку в stopConditions, когда desiredMode
// превышает capability_at_start (planner.ts). Читаем её здесь, а не
// пересчитываем решение заново — единственный источник истины остаётся один.
function readCapabilityCeiling(contract: ResearchBoundaryContract): {
  hit: boolean;
  note: string | null;
} {
  const note =
    contract.stopConditions.find((s) => s.includes("capability ceiling")) ??
    null;
  return { hit: note !== null, note };
}

async function setMemoryEnabled(db: Database, value: boolean): Promise<void> {
  await db
    .insert(productConfig)
    .values({ key: "memory_enabled", value })
    .onConflictDoUpdate({ target: productConfig.key, set: { value } });
}

// Возвращает memoryId каждого посеянного факта (в исходном порядке) — нужно
// для сборки ground-truth карты memoryId -> reusable (D-061), т.к.
// стабильно связать её можно только по факту вставки, не по claimKey
// (несколько записей могут делить claimKey/component в contradiction-сценариях).
async function seedFacts(
  db: Database,
  projectId: string,
  topicId: string,
  facts: GoldenMemoryFact[],
  adminId: string,
): Promise<string[]> {
  if (facts.length === 0) return [];
  // Один системный source на сценарий — provenance должна быть предъявима
  // (CLI/владелец хочет видеть, откуда факт), не только memoryId.
  const [source] = await db
    .insert(sources)
    .values({
      url: `https://example.com/golden-set/${uid("src")}`,
      urlHash: uid("srchash"),
    })
    .returning();
  const memoryIds: string[] = [];
  for (const f of facts) {
    const { id } = await observeMemoryCandidate(db, {
      projectId,
      topicId,
      patternStep: f.patternStep,
      component: f.component,
      claimKey: f.claimKey,
      statement: f.statement,
      mechanismState: f.mechanismState ?? null,
      freshnessClass: f.freshnessClass,
      verifiedAt: f.verifiedAt,
      staleAfter: f.staleAfter ?? null,
      confidence: f.confidence,
      originKind: "GOLDEN_SET",
    });
    memoryIds.push(id);
    if (f.promote) {
      await promoteToActive(db, id, adminId);
      // Copied-provenance path (§5.1) — тот же код, что использует
      // реальный промоушен, не заглушка для отчёта.
      await copyProvenance(db, {
        memoryId: id,
        sourceId: source.id,
        retrievedUrl: `https://example.com/golden-set/${f.claimKey}`,
        contentHash: `sha256:golden:${f.claimKey}`,
        fragment: f.statement,
        fetchedAt: f.verifiedAt,
      });
    }
    // health по умолчанию из observeMemoryCandidate/промоушена — 'OK'; для
    // сценариев D-059/D-062 явно задаём другое значение здесь одной строкой
    // после вставки, не изобретая отдельный path записи в lifecycle.ts.
    if (f.health && f.health !== "OK") {
      await db
        .update(researchMemory)
        .set({ health: f.health })
        .where(eq(researchMemory.id, id));
    }
  }
  return memoryIds;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function planOnce(
  db: Database,
  boss: PgBoss,
  projectId: string,
  topicId: string,
  entitlement: EntitlementSnapshot,
  statementQuery: string,
  memoryEnabled: boolean,
): Promise<{ contract: ResearchBoundaryContract; mode: string }> {
  await setMemoryEnabled(db, memoryEnabled);
  const [user] = await db.insert(users).values({}).returning();
  const { job } = await createResearchJob(db, boss, {
    userId: user.id,
    topicId,
    projectId,
    originalQuestion: statementQuery,
    normalizedTask: {
      project_slug: projectId,
      project_slugs: [projectId],
      task: statementQuery,
    },
    normalizedTaskHash: uid("hash"),
    idempotencyKey: uid("idem"),
    entitlement,
    demoLifetimeProofLimit: 1000,
  });
  const result = await runMemoryPlanningStage(db, job.id);
  const [plan] = await db
    .select()
    .from(researchPlans)
    .where(eq(researchPlans.id, result.planId));
  return {
    contract: plan.contract as ResearchBoundaryContract,
    mode: plan.mode,
  };
}

export async function runGoldenScenario(
  db: Database,
  boss: PgBoss,
  topicId: string,
  scenario: GoldenScenario,
): Promise<ScenarioResult> {
  const [admin] = await db.insert(users).values({ role: "ADMIN" }).returning();
  const [project] = await db
    .insert(projects)
    .values({ slug: uid("golden"), name: scenario.name, status: "ACTIVE_CORE" })
    .returning();
  const ownMemoryIds = await seedFacts(
    db,
    project.id,
    topicId,
    scenario.seedFacts,
    admin.id,
  );

  // Ground truth (D-061): memoryId -> факт, независимо от того, что решит
  // планировщик. Чужой проект тоже попадает в карту — если бы структурная
  // изоляция когда-нибудь сломалась, метрика обязана это заметить, а не
  // молчать, потому что "по архитектуре так не бывает".
  const groundTruth = new Map<string, GoldenMemoryFact>();
  scenario.seedFacts.forEach((f, i) => groundTruth.set(ownMemoryIds[i], f));

  // Отравленный/непромоутнутый кандидат остаётся CANDIDATE — здесь ничего
  // дополнительно не нужно: promote=false в seedFacts уже это гарантирует.
  if (scenario.foreignProjectSeedFacts?.length) {
    const [foreignProject] = await db
      .insert(projects)
      .values({
        slug: uid("foreign"),
        name: `${scenario.name} (foreign)`,
        status: "ACTIVE_CORE",
      })
      .returning();
    const foreignMemoryIds = await seedFacts(
      db,
      foreignProject.id,
      topicId,
      scenario.foreignProjectSeedFacts,
      admin.id,
    );
    scenario.foreignProjectSeedFacts.forEach((f, i) =>
      groundTruth.set(foreignMemoryIds[i], f),
    );
  }

  const entitlement: EntitlementSnapshot = {
    level: scenario.capability === "FRESH_RESEARCH" ? "ARI_CORE" : "DEMO",
    capability: scenario.capability,
    budget:
      scenario.capability === "FRESH_RESEARCH"
        ? DEFAULT_PRODUCT_CONFIG.budget_core
        : DEFAULT_PRODUCT_CONFIG.budget_demo,
  };
  const statementQuery = scenario.statementQuery ?? scenario.name;

  const on = await planOnce(
    db,
    boss,
    project.id,
    topicId,
    entitlement,
    statementQuery,
    true,
  );
  const off = await planOnce(
    db,
    boss,
    project.id,
    topicId,
    entitlement,
    statementQuery,
    false,
  );
  await setMemoryEnabled(db, true); // восстановить дефолт для следующего сценария

  const actualSatisfied = new Set(on.contract.alreadySatisfiedSteps);
  const expectedSatisfied = new Set(scenario.expectedSatisfiedSteps);

  const truePositives = [...actualSatisfied].filter((s) =>
    expectedSatisfied.has(s),
  );
  // D-066: recall/precision считаются ТОЛЬКО там, где математически
  // определены — пустое ожидаемое множество больше не подменяется на 1.
  const recall =
    expectedSatisfied.size === 0
      ? undefined
      : truePositives.length / expectedSatisfied.size;
  const precision =
    actualSatisfied.size === 0
      ? undefined
      : truePositives.length / actualSatisfied.size;
  const noise = [...actualSatisfied].filter((s) => !expectedSatisfied.has(s));
  const noiseRate =
    actualSatisfied.size === 0 ? 0 : noise.length / actualSatisfied.size;
  // Отдельная метрика для negative-only сценариев (D-066): ожидали пусто —
  // проверяем буквально "не срабатывал ли план ложноположительно".
  const noFalsePositive =
    expectedSatisfied.size === 0 ? actualSatisfied.size === 0 : undefined;

  // D-061: false reuse считается ПО ШАГУ. Шаг ALREADY_SATISFIED — false,
  // если хотя бы один memoryId, на который опирается это решение, помечен
  // контролируемой истиной сценария как НЕ переиспользуемый.
  const satisfiedDecisions = on.contract.stepDecisions.filter(
    (d) => d.decision === "ALREADY_SATISFIED",
  );
  const falseReuseDetails: FalseReuseDetail[] = [];
  for (const d of satisfiedDecisions) {
    const badReasons: InvalidReuseReason[] = [];
    const badMemoryIds: string[] = [];
    for (const memoryId of d.memoryIds) {
      const fact = groundTruth.get(memoryId);
      // Неизвестный планировщику memoryId (не из golden-set) не должен
      // происходить — но если случится, это тоже небезопасное решение.
      if (!fact || fact.reusable === false) {
        badMemoryIds.push(memoryId);
        if (fact?.invalidReason) badReasons.push(fact.invalidReason);
      }
    }
    if (badMemoryIds.length > 0) {
      falseReuseDetails.push({
        step: d.step,
        memoryIds: badMemoryIds,
        reasons: badReasons,
      });
    }
  }

  const ceiling = readCapabilityCeiling(on.contract);

  return {
    scenario: scenario.name,
    angle: scenario.angle,
    contractOn: on.contract,
    contractOff: off.contract,
    modeOn: on.mode,
    modeOff: off.mode,
    recall,
    precision,
    noFalsePositive,
    noiseRate,
    reuseStepCount: satisfiedDecisions.length,
    falseReuseStepCount: falseReuseDetails.length,
    falseReuseDetails,
    stepsSkipped: on.contract.alreadySatisfiedSteps.length,
    stepsRefreshed: on.contract.requiredFreshEvidence.length,
    searchDelta:
      off.contract.researchBudget.maxSearchQueries -
      on.contract.researchBudget.maxSearchQueries,
    capabilityCeilingHit: ceiling.hit,
    capabilityCeilingNote: ceiling.note,
  };
}

export interface AggregateMetrics {
  scenarioCount: number;
  // D-066: усредняется только по сценариям, где значение определено
  // (непустое ожидаемое множество) — количество таких сценариев указано
  // отдельно, чтобы 0/0 было видно, а не молчаливо пропало в делении.
  recallScenarioCount: number;
  precisionScenarioCount: number;
  meanRecall: number | undefined;
  meanPrecision: number | undefined;
  // Доля negative-only сценариев без ложных срабатываний.
  negativeOnlyScenarioCount: number;
  noFalsePositiveRate: number | undefined;
  meanNoiseRate: number;
  falseReuseRate: number; // ГЛАВНАЯ метрика — 0 = условие приёмки (D-049/D-061)
  totalStepsSkipped: number;
  totalStepsRefreshed: number;
  meanSearchDelta: number;
}

export interface ProvenanceView {
  sourceId: string;
  retrievedUrl: string;
  contentHash: string;
  fragment: string | null;
}

// Для отчёта (CLI/владелец): что стоит за reusableEvidence[].memoryId,
// не только сам ID. Чтение уже персистентных строк, ничего не пересчитывает.
export async function fetchProvenanceByMemoryId(
  db: Database,
  memoryIds: string[],
): Promise<Map<string, ProvenanceView[]>> {
  if (memoryIds.length === 0) return new Map();
  const rows = await db
    .select({
      memoryId: researchMemoryProvenance.memoryId,
      sourceId: researchMemoryProvenance.sourceId,
      retrievedUrl: researchMemoryProvenance.retrievedUrl,
      contentHash: researchMemoryProvenance.contentHash,
      fragment: researchMemoryProvenance.fragment,
    })
    .from(researchMemoryProvenance)
    .where(inArray(researchMemoryProvenance.memoryId, memoryIds));
  const map = new Map<string, ProvenanceView[]>();
  for (const r of rows) {
    const list = map.get(r.memoryId) ?? [];
    list.push({
      sourceId: r.sourceId,
      retrievedUrl: r.retrievedUrl,
      contentHash: r.contentHash,
      fragment: r.fragment,
    });
    map.set(r.memoryId, list);
  }
  return map;
}

export function aggregateGoldenResults(
  results: ScenarioResult[],
): AggregateMetrics {
  const n = results.length || 1;
  const totalReuseSteps = results.reduce((s, r) => s + r.reuseStepCount, 0);
  const totalFalseReuseSteps = results.reduce(
    (s, r) => s + r.falseReuseStepCount,
    0,
  );

  const withRecall = results.filter((r) => r.recall !== undefined);
  const withPrecision = results.filter((r) => r.precision !== undefined);
  const negativeOnly = results.filter((r) => r.noFalsePositive !== undefined);

  return {
    scenarioCount: results.length,
    recallScenarioCount: withRecall.length,
    precisionScenarioCount: withPrecision.length,
    meanRecall:
      withRecall.length === 0
        ? undefined
        : withRecall.reduce((s, r) => s + (r.recall ?? 0), 0) /
          withRecall.length,
    meanPrecision:
      withPrecision.length === 0
        ? undefined
        : withPrecision.reduce((s, r) => s + (r.precision ?? 0), 0) /
          withPrecision.length,
    negativeOnlyScenarioCount: negativeOnly.length,
    noFalsePositiveRate:
      negativeOnly.length === 0
        ? undefined
        : negativeOnly.filter((r) => r.noFalsePositive === true).length /
          negativeOnly.length,
    meanNoiseRate: results.reduce((s, r) => s + r.noiseRate, 0) / n,
    falseReuseRate:
      totalReuseSteps === 0 ? 0 : totalFalseReuseSteps / totalReuseSteps,
    totalStepsSkipped: results.reduce((s, r) => s + r.stepsSkipped, 0),
    totalStepsRefreshed: results.reduce((s, r) => s + r.stepsRefreshed, 0),
    meanSearchDelta: results.reduce((s, r) => s + r.searchDelta, 0) / n,
  };
}
