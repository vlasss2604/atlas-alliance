import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { DEFAULT_PRODUCT_CONFIG } from "../config/product";
import type { Database } from "../db/client";
import { productConfig, projects, researchPlans, users } from "../db/schema";
import type { EntitlementSnapshot, ResearchCapability } from "../domain/types";
import { createResearchJob } from "../jobs/research-jobs";
import type { ResearchBoundaryContract } from "./contract";
import { observeMemoryCandidate, promoteToActive } from "./lifecycle";
import { runMemoryPlanningStage } from "./plan-job";

// Golden set (phase-5-plan.md §7.2–7.3, D-049). Память сеется нами — значит
// правильный ответ retrieval известен заранее, и метрику можно посчитать
// объективно, а не оценкой на глаз.

export interface GoldenMemoryFact {
  patternStep: number;
  claimKey: string;
  statement: string;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verifiedAt: Date;
  confidence: number;
  // false => остаётся CANDIDATE (не промоутится) — сценарий отравления:
  // непроверенный кандидат структурно недоступен retrieval (D-021/D-025).
  promote: boolean;
}

export type ScenarioAngle =
  | "norm"
  | "completeness"
  | "freshness"
  | "sufficiency"
  | "capability_boundary"
  | "wording"
  | "poisoning"
  | "cross_project";

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

export interface ScenarioResult {
  scenario: string;
  angle: ScenarioAngle;
  contractOn: ResearchBoundaryContract;
  contractOff: ResearchBoundaryContract;
  modeOn: string;
  modeOff: string;
  recall: number;
  precision: number;
  noiseRate: number;
  falseReuseCount: number;
  reuseCount: number;
  stepsSkipped: number;
  stepsRefreshed: number;
  searchDelta: number;
}

async function setMemoryEnabled(db: Database, value: boolean): Promise<void> {
  await db
    .insert(productConfig)
    .values({ key: "memory_enabled", value })
    .onConflictDoUpdate({ target: productConfig.key, set: { value } });
}

async function seedFacts(
  db: Database,
  projectId: string,
  topicId: string,
  facts: GoldenMemoryFact[],
  adminId: string,
): Promise<void> {
  for (const f of facts) {
    const { id } = await observeMemoryCandidate(db, {
      projectId,
      topicId,
      patternStep: f.patternStep,
      claimKey: f.claimKey,
      statement: f.statement,
      freshnessClass: f.freshnessClass,
      verifiedAt: f.verifiedAt,
      confidence: f.confidence,
      originKind: "GOLDEN_SET",
    });
    if (f.promote) {
      await promoteToActive(db, id, adminId);
    }
  }
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
  await seedFacts(db, project.id, topicId, scenario.seedFacts, admin.id);

  // Отравленный/непромоутнутый кандидат остаётся CANDIDATE — здесь ничего
  // дополнительно не нужно: promote=false в seedFacts уже это гарантирует.
  if (scenario.foreignProjectSeedFacts?.length) {
    const [foreignProject] = await db
      .insert(projects)
      .values({ slug: uid("foreign"), name: `${scenario.name} (foreign)`, status: "ACTIVE_CORE" })
      .returning();
    await seedFacts(db, foreignProject.id, topicId, scenario.foreignProjectSeedFacts, admin.id);
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
  const recall = expectedSatisfied.size === 0 ? 1 : truePositives.length / expectedSatisfied.size;
  const precision = actualSatisfied.size === 0 ? 1 : truePositives.length / actualSatisfied.size;
  const noise = [...actualSatisfied].filter((s) => !expectedSatisfied.has(s));
  const noiseRate = actualSatisfied.size === 0 ? 0 : noise.length / actualSatisfied.size;

  // false reuse: шаг помечен already_satisfied, опираясь на факт, который
  // сид пометил НЕ promote (кандидат) — структурно невозможно (retrieval
  // видит только ACTIVE), но метрика считается из данных, а не из веры
  // в архитектуру: перепроверяем по фактическому reusableEvidence.
  const promotedClaimKeys = new Set(
    scenario.seedFacts.filter((f) => f.promote).map((f) => f.claimKey),
  );
  const falseReuseCount = on.contract.reusableEvidence.filter(
    (e) => !promotedClaimKeys.has(e.claimKey),
  ).length;

  return {
    scenario: scenario.name,
    angle: scenario.angle,
    contractOn: on.contract,
    contractOff: off.contract,
    modeOn: on.mode,
    modeOff: off.mode,
    recall,
    precision,
    noiseRate,
    falseReuseCount,
    reuseCount: on.contract.reusableEvidence.length,
    stepsSkipped: on.contract.alreadySatisfiedSteps.length,
    stepsRefreshed: on.contract.requiredFreshEvidence.length,
    searchDelta: off.contract.researchBudget.maxSearchQueries - on.contract.researchBudget.maxSearchQueries,
  };
}

export interface AggregateMetrics {
  scenarioCount: number;
  meanRecall: number;
  meanPrecision: number;
  meanNoiseRate: number;
  falseReuseRate: number; // ГЛАВНАЯ метрика — 0 = условие приёмки (D-049)
  totalStepsSkipped: number;
  totalStepsRefreshed: number;
  meanSearchDelta: number;
}

export function aggregateGoldenResults(results: ScenarioResult[]): AggregateMetrics {
  const n = results.length || 1;
  const totalReuse = results.reduce((s, r) => s + r.reuseCount, 0);
  const totalFalseReuse = results.reduce((s, r) => s + r.falseReuseCount, 0);
  return {
    scenarioCount: results.length,
    meanRecall: results.reduce((s, r) => s + r.recall, 0) / n,
    meanPrecision: results.reduce((s, r) => s + r.precision, 0) / n,
    meanNoiseRate: results.reduce((s, r) => s + r.noiseRate, 0) / n,
    falseReuseRate: totalReuse === 0 ? 0 : totalFalseReuse / totalReuse,
    totalStepsSkipped: results.reduce((s, r) => s + r.stepsSkipped, 0),
    totalStepsRefreshed: results.reduce((s, r) => s + r.stepsRefreshed, 0),
    meanSearchDelta: results.reduce((s, r) => s + r.searchDelta, 0) / n,
  };
}
