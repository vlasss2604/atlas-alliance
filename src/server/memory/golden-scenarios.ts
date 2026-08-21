import type { GoldenScenario } from "./evaluation";

// Единый источник для acceptance-контуров, использующих golden set:
// tests/phase5-evaluation.test.ts И scripts/eval-memory.ts читают отсюда —
// один список сценариев, ни один не пересчитывает другой. 8 углов —
// ровно те, что перечислены в phase-5-plan.md §7.4.

const NOW = new Date();
const FRESH = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);
const STALE_HIGH_CHANGE = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000); // > default 3d stale_after

export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    name: "norm: свежее знание закрывает часть шагов",
    angle: "norm",
    capability: "FRESH_RESEARCH",
    statementQuery: "does protocol revenue reach token holders",
    seedFacts: [
      { patternStep: 1, claimKey: "economic_source", statement: "swap fee is the source", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true },
      { patternStep: 2, claimKey: "revenue_waterfall", statement: "fees flow to treasury first", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 92, promote: true },
      { patternStep: 3, claimKey: "allocation_mechanism", statement: "governance-approved buyback", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 90, promote: true },
    ],
    expectedSatisfiedSteps: [1, 2, 3],
  },
  {
    name: "completeness: памяти нет вовсе",
    angle: "completeness",
    capability: "FRESH_RESEARCH",
    statementQuery: "does protocol revenue reach token holders",
    seedFacts: [],
    expectedSatisfiedSteps: [],
  },
  {
    name: "freshness: динамический факт просрочен",
    angle: "freshness",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the buyback mechanism currently active",
    seedFacts: [
      { patternStep: 5, claimKey: "current_status", statement: "status checked long ago", freshnessClass: "HIGH_CHANGE", verifiedAt: STALE_HIGH_CHANGE, confidence: 99, promote: true },
    ],
    expectedSatisfiedSteps: [], // просрочен -> required_fresh, НЕ already_satisfied
  },
  {
    name: "sufficiency: всё свежо и покрыто",
    angle: "sufficiency",
    capability: "FRESH_RESEARCH",
    statementQuery: "full value capture review",
    seedFacts: Array.from({ length: 8 }, (_, i) => ({
      patternStep: i + 1,
      claimKey: `step_${i + 1}_claim`,
      statement: `verified fact for step ${i + 1}`,
      freshnessClass: "LOW_CHANGE" as const,
      verifiedAt: FRESH,
      confidence: 95,
      promote: true,
    })),
    expectedSatisfiedSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: "capability boundary: DEMO не получает FRESH_RESEARCH",
    angle: "capability_boundary",
    capability: "TARGETED_REFRESH",
    statementQuery: "brand new project, nothing known",
    seedFacts: [],
    expectedSatisfiedSteps: [],
  },
  {
    name: "wording: другая формулировка того же claim",
    angle: "wording",
    capability: "FRESH_RESEARCH",
    statementQuery: "does the project burn revenue into the token supply",
    seedFacts: [
      { patternStep: 7, claimKey: "net_token_effect", statement: "Half of protocol revenue is used to burn the token every epoch", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 88, promote: true },
    ],
    expectedSatisfiedSteps: [7],
  },
  {
    name: "poisoning: заведомо непроверенное знание не закрывает шаг",
    angle: "poisoning",
    capability: "FRESH_RESEARCH",
    statementQuery: "was the buyback actually executed",
    seedFacts: [
      { patternStep: 4, claimKey: "actual_execution", statement: "PLANTED: buyback executed (unverified)", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 99, promote: false },
    ],
    expectedSatisfiedSteps: [], // не промоутнут -> CANDIDATE -> невидим retrieval
  },
  {
    name: "чужой проект: память проекта A не закрывает шаг проекта B",
    angle: "cross_project",
    capability: "FRESH_RESEARCH",
    statementQuery: "durability of the mechanism",
    seedFacts: [],
    foreignProjectSeedFacts: [
      { patternStep: 8, claimKey: "durability", statement: "durable per foreign project's governance", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true },
    ],
    expectedSatisfiedSteps: [],
  },
];
