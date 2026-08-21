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
  type StaleAfterInput,
} from "./lifecycle";
import { runMemoryPlanningStage } from "./plan-job";

// Golden set (phase-5-plan.md §7.2–7.3, D-049, D-061, D-066). Память сеется
// нами — значит правильный ответ retrieval известен заранее, и метрику
// можно посчитать объективно, а не оценкой на глаз. Контрольная истина
// (reusable/invalidReason) объявляется НЕЗАВИСИМО в сценарии и никогда
// не выводится из вывода планировщика.

// D-061: семь причин непригодности элемента памяти по контрольной истине.
export const INVALID_REASONS = [
  "STALE",
  "LOW_CONFIDENCE",
  "WRONG_PROJECT",
  "UNHEALTHY",
  "UNPROMOTED",
  "WRONG_STEP_MAPPING",
  "CONTRADICTED",
] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

export interface GoldenMemoryFact {
  patternStep: number;
  // D-060: компонент шага Pattern (валидируется триггером БД при сиде).
  component: string;
  claimKey: string;
  statement: string;
  mechanismState?: string | null;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verifiedAt: Date;
  // MEDIUM-1: политика свежести записи — полный интервал (часы/дни/месяцы).
  staleAfter?: StaleAfterInput | null;
  // D-059: health выставляется ПОСЛЕ промоушена прямым update (health —
  // не lifecycle-переход): запись честно прошла жизненный цикл и лишь
  // потом была помечена сомнительной/устаревшей/неверной.
  health?: "OK" | "QUESTIONABLE" | "REVERIFY" | "STALE" | "DEPRECATED";
  confidence: number;
  // false => остаётся CANDIDATE (не промоутится) — сценарий отравления:
  // непроверенный кандидат структурно недоступен retrieval (D-021/D-025).
  promote: boolean;
  // ===== Контрольная истина (D-061) — независимая, не производная =====
  // Может ли этот элемент памяти легитимно закрывать компонент шага.
  reusable: boolean;
  // Обязательна, когда reusable=false: почему элемент непригоден.
  invalidReason?: InvalidReason;
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
  // Пакет исправлений ревью: новые углы приёмки.
  | "mode_boundary" // D-058: DEMO, 1 закрыт + 7 MISSING -> граница доступа
  | "health" // D-059: QUESTIONABLE/REVERIFY/STALE/DEPRECATED
  | "stale_policy" // MEDIUM-1: stale_after в часах и месяцах
  | "component_mapping" // D-060: claim_key не определяет валидность шага
  | "partial_component" // D-060: частичное покрытие многокомпонентного шага
  | "contradiction" // D-062: конфликт mechanism_state
  | "unsafe_reuse"; // D-061: контролируемое небезопасное переиспользование

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
  // Дополнительная объявленная истина для новых углов (проверяется тестом,
  // когда задана).
  expectedRequiredFreshSteps?: number[];
  expectedMissingSteps?: number[];
  // D-061: сценарий-проверка метрики — намеренно небезопасное
  // переиспользование, ДОКАЗЫВАЮЩЕЕ, что false_reuse_rate может стать
  // ненулевой. В acceptance-агрегат не входит (агрегат фильтрует).
  metricValidationOnly?: boolean;
}

export interface FalseReuseDetail {
  step: number;
  memoryIds: string[];
  invalidReasons: InvalidReason[];
}

export interface ScenarioResult {
  scenario: string;
  angle: ScenarioAngle;
  metricValidationOnly: boolean;
  contractOn: ResearchBoundaryContract;
  contractOff: ResearchBoundaryContract;
  modeOn: string;
  modeOff: string;
  // D-066: метрики считаются только там, где определены. null — метрика
  // математически не определена для этого сценария (пустое ожидаемое или
  // пустое предсказанное множество), а не синтетическая единица.
  recall: number | null;
  precision: number | null;
  noiseRate: number;
  // Негативные сценарии (пустое ожидание): отдельная метрика отсутствия
  // ложных срабатываний. null для сценариев с непустым ожиданием.
  noFalsePositives: boolean | null;
  // D-061: счёт по ШАГАМ — шаг закрыт с участием элемента, объявленного
  // контрольной истиной непригодным.
  falseReuseStepCount: number;
  satisfiedStepCount: number;
  falseReuseDetails: FalseReuseDetail[];
  reuseCount: number;
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
  const note = contract.stopConditions.find((s) => s.includes("capability ceiling")) ?? null;
  return { hit: note !== null, note };
}

async function setMemoryEnabled(db: Database, value: boolean): Promise<void> {
  await db
    .insert(productConfig)
    .values({ key: "memory_enabled", value })
    .onConflictDoUpdate({ target: productConfig.key, set: { value } });
}

// Возвращает карту memoryId -> факт сида: по ней false reuse считается из
// КОНТРОЛЬНОЙ истины, а не из вывода планировщика (D-061).
async function seedFacts(
  db: Database,
  projectId: string,
  topicId: string,
  facts: GoldenMemoryFact[],
  adminId: string,
): Promise<Map<string, GoldenMemoryFact>> {
  const byMemoryId = new Map<string, GoldenMemoryFact>();
  if (facts.length === 0) return byMemoryId;
  // Один системный source на сценарий — provenance должна быть предъявима
  // (CLI/владелец хочет видеть, откуда факт), не только memoryId.
  const [source] = await db
    .insert(sources)
    .values({ url: `https://example.com/golden-set/${uid("src")}`, urlHash: uid("srchash") })
    .returning();
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
    byMemoryId.set(id, f);
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
    // health — не lifecycle-переход: выставляется прямым update после
    // (возможного) промоушена. История записи сохраняется (D-059:
    // DEPRECATED исключается из retrieval, но не удаляется).
    if (f.health && f.health !== "OK") {
      await db.update(researchMemory).set({ health: f.health }).where(eq(researchMemory.id, id));
    }
  }
  return byMemoryId;
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
    normalizedTask: { project_slug: projectId, project_slugs: [projectId], task: statementQuery },
    normalizedTaskHash: uid("hash"),
    idempotencyKey: uid("idem"),
    entitlement,
    demoLifetimeProofLimit: 1000,
  });
  const result = await runMemoryPlanningStage(db, job.id);
  const [plan] = await db.select().from(researchPlans).where(eq(researchPlans.id, result.planId));
  return { contract: plan.contract as ResearchBoundaryContract, mode: plan.mode };
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
  const factById = await seedFacts(db, project.id, topicId, scenario.seedFacts, admin.id);

  // Отравленный/непромоутнутый кандидат остаётся CANDIDATE — здесь ничего
  // дополнительно не нужно: promote=false в seedFacts уже это гарантирует.
  if (scenario.foreignProjectSeedFacts?.length) {
    const [foreignProject] = await db
      .insert(projects)
      .values({ slug: uid("foreign"), name: `${scenario.name} (foreign)`, status: "ACTIVE_CORE" })
      .returning();
    const foreignById = await seedFacts(
      db,
      foreignProject.id,
      topicId,
      scenario.foreignProjectSeedFacts,
      admin.id,
    );
    // Чужие факты попадают в ту же карту истины: если изоляция D-042
    // когда-нибудь сломается и чужой факт закроет шаг, false reuse обязан
    // это увидеть (истина сценария помечает их WRONG_PROJECT).
    for (const [id, f] of foreignById) factById.set(id, f);
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

  const on = await planOnce(db, boss, project.id, topicId, entitlement, statementQuery, true);
  const off = await planOnce(db, boss, project.id, topicId, entitlement, statementQuery, false);
  await setMemoryEnabled(db, true); // восстановить дефолт для следующего сценария

  const actualSatisfied = new Set(on.contract.alreadySatisfiedSteps);
  const expectedSatisfied = new Set(scenario.expectedSatisfiedSteps);

  const truePositives = [...actualSatisfied].filter((s) => expectedSatisfied.has(s));
  // D-066: recall определён только при непустом ожидаемом множестве,
  // precision — только при непустом предсказанном. Никаких синтетических
  // единиц: неопределённая метрика — null и в агрегат не входит.
  const recall =
    expectedSatisfied.size === 0 ? null : truePositives.length / expectedSatisfied.size;
  const precision =
    actualSatisfied.size === 0 ? null : truePositives.length / actualSatisfied.size;
  const noise = [...actualSatisfied].filter((s) => !expectedSatisfied.has(s));
  const noiseRate = actualSatisfied.size === 0 ? 0 : noise.length / actualSatisfied.size;
  // Негативные сценарии: явная метрика отсутствия ложных срабатываний.
  const noFalsePositives = expectedSatisfied.size === 0 ? actualSatisfied.size === 0 : null;

  // D-061: false reuse по ШАГАМ. Шаг ложно переиспользован, если он
  // ALREADY_SATISFIED и хотя бы один элемент памяти, обеспечивший это
  // решение (memoryIds решения по шагу), контрольная истина объявила
  // непригодным. Элемент вне контрольного набора тоже считается
  // непригодным — доверять можно только тому, что сеяли сами.
  const falseReuseDetails: FalseReuseDetail[] = [];
  for (const d of on.contract.stepDecisions) {
    if (d.decision !== "ALREADY_SATISFIED") continue;
    const badIds: string[] = [];
    const reasons = new Set<InvalidReason>();
    for (const id of d.memoryIds) {
      const fact = factById.get(id);
      if (!fact) {
        badIds.push(id);
        reasons.add("WRONG_PROJECT"); // элемент не из контролируемого сида
        continue;
      }
      if (!fact.reusable) {
        badIds.push(id);
        if (fact.invalidReason) reasons.add(fact.invalidReason);
      }
    }
    if (badIds.length > 0) {
      falseReuseDetails.push({ step: d.step, memoryIds: badIds, invalidReasons: [...reasons] });
    }
  }

  const ceiling = readCapabilityCeiling(on.contract);

  return {
    scenario: scenario.name,
    angle: scenario.angle,
    metricValidationOnly: scenario.metricValidationOnly ?? false,
    contractOn: on.contract,
    contractOff: off.contract,
    modeOn: on.mode,
    modeOff: off.mode,
    recall,
    precision,
    noiseRate,
    noFalsePositives,
    falseReuseStepCount: falseReuseDetails.length,
    satisfiedStepCount: actualSatisfied.size,
    falseReuseDetails,
    reuseCount: on.contract.reusableEvidence.length,
    stepsSkipped: on.contract.alreadySatisfiedSteps.length,
    stepsRefreshed: on.contract.requiredFreshEvidence.length,
    searchDelta: off.contract.researchBudget.maxSearchQueries - on.contract.researchBudget.maxSearchQueries,
    capabilityCeilingHit: ceiling.hit,
    capabilityCeilingNote: ceiling.note,
  };
}

export interface AggregateMetrics {
  scenarioCount: number;
  // D-066: усреднение только по сценариям, где метрика определена; счётчики
  // делают знаменатель предъявимым.
  recallDefinedCount: number;
  meanRecall: number | null;
  precisionDefinedCount: number;
  meanPrecision: number | null;
  meanNoiseRate: number;
  // Негативные сценарии — отдельная метрика: доля без ложных срабатываний.
  negativeScenarioCount: number;
  noFalsePositiveRate: number | null;
  // ГЛАВНАЯ метрика (D-049/D-061): шаги, закрытые с участием непригодного
  // элемента / все закрытые шаги набора. 0 = условие приёмки.
  falseReuseRate: number;
  falseReuseStepCount: number;
  satisfiedStepCount: number;
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
    list.push({ sourceId: r.sourceId, retrievedUrl: r.retrievedUrl, contentHash: r.contentHash, fragment: r.fragment });
    map.set(r.memoryId, list);
  }
  return map;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

// Acceptance-агрегат. Сценарии metricValidationOnly (контролируемое
// небезопасное переиспользование, D-061) сюда НЕ входят: они проверяют,
// что метрика способна стать ненулевой, а не что система прошла приёмку.
export function aggregateGoldenResults(results: ScenarioResult[]): AggregateMetrics {
  const acceptance = results.filter((r) => !r.metricValidationOnly);
  const n = acceptance.length || 1;

  const recallValues = acceptance
    .map((r) => r.recall)
    .filter((v): v is number => v !== null);
  const precisionValues = acceptance
    .map((r) => r.precision)
    .filter((v): v is number => v !== null);
  const negative = acceptance.filter((r) => r.noFalsePositives !== null);

  const falseReuseSteps = acceptance.reduce((s, r) => s + r.falseReuseStepCount, 0);
  const satisfiedSteps = acceptance.reduce((s, r) => s + r.satisfiedStepCount, 0);

  return {
    scenarioCount: acceptance.length,
    recallDefinedCount: recallValues.length,
    meanRecall: mean(recallValues),
    precisionDefinedCount: precisionValues.length,
    meanPrecision: mean(precisionValues),
    meanNoiseRate: acceptance.reduce((s, r) => s + r.noiseRate, 0) / n,
    negativeScenarioCount: negative.length,
    noFalsePositiveRate:
      negative.length === 0
        ? null
        : negative.filter((r) => r.noFalsePositives === true).length / negative.length,
    falseReuseRate: satisfiedSteps === 0 ? 0 : falseReuseSteps / satisfiedSteps,
    falseReuseStepCount: falseReuseSteps,
    satisfiedStepCount: satisfiedSteps,
    totalStepsSkipped: acceptance.reduce((s, r) => s + r.stepsSkipped, 0),
    totalStepsRefreshed: acceptance.reduce((s, r) => s + r.stepsRefreshed, 0),
    meanSearchDelta: acceptance.reduce((s, r) => s + r.searchDelta, 0) / n,
  };
}
