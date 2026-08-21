import type { GoldenScenario } from "./evaluation";

// Единый источник для acceptance-контуров, использующих golden set:
// tests/phase5-evaluation.test.ts И scripts/eval-memory.ts читают отсюда —
// один список сценариев, ни один не пересчитывает другой.
//
// Исходные 8 углов (phase-5-plan.md §7.4) сохранены; пакет исправлений
// ревью добавляет углы: DEMO 1+7 (D-058), health ×4 (D-059), stale_after
// в часах и месяцах (MEDIUM-1), сопоставление компонента (D-060),
// частичное покрытие многокомпонентного шага (D-060), противоречие
// mechanism_state (D-062), контролируемое небезопасное переиспользование
// (D-061 — metricValidationOnly, в acceptance-агрегат не входит).
//
// Контрольная истина (reusable/invalidReason, expected*Steps) объявлена
// вручную и НЕ выводится из вывода планировщика (D-061).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date();
const FRESH = new Date(NOW.getTime() - 1 * DAY);
const STALE_HIGH_CHANGE = new Date(NOW.getTime() - 30 * DAY); // > default 3d stale_after
const HOURS_20_AGO = new Date(NOW.getTime() - 20 * HOUR);
const HOURS_48_AGO = new Date(NOW.getTime() - 48 * HOUR);
const DAYS_30_AGO = new Date(NOW.getTime() - 30 * DAY);
const DAYS_100_AGO = new Date(NOW.getTime() - 100 * DAY);

export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    name: "norm: свежее знание закрывает часть шагов",
    angle: "norm",
    capability: "FRESH_RESEARCH",
    statementQuery: "does protocol revenue reach token holders",
    seedFacts: [
      { patternStep: 1, component: "SOURCE_OF_VALUE", claimKey: "economic_source", statement: "swap fee is the source", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 2, component: "FLOW_PATH", claimKey: "revenue_waterfall", statement: "fees flow to treasury first", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 92, promote: true, reusable: true },
      // Шаг 3 многокомпонентен (D-060): «механизм описан» и «механизм
      // санкционирован» — разные факты, оба обязаны быть покрыты.
      { patternStep: 3, component: "MECHANISM_SPEC", claimKey: "allocation_mechanism", statement: "buyback mechanism specified in tokenomics docs", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 90, promote: true, reusable: true },
      { patternStep: 3, component: "GOVERNANCE_BASIS", claimKey: "allocation_governance", statement: "buyback approved by governance vote", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 90, promote: true, reusable: true },
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
    expectedMissingSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: "freshness: динамический факт просрочен",
    angle: "freshness",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the buyback mechanism currently active",
    seedFacts: [
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "current_status", statement: "status checked long ago", freshnessClass: "HIGH_CHANGE", verifiedAt: STALE_HIGH_CHANGE, confidence: 99, promote: true, reusable: false, invalidReason: "STALE" },
    ],
    expectedSatisfiedSteps: [], // просрочен -> required_fresh, НЕ already_satisfied
    expectedRequiredFreshSteps: [5],
  },
  {
    // D-058, средняя ветвь (missing=0, requiredFresh>0) end-to-end —
    // канонический пример plan §4.3: всё покрыто, просрочен ТОЛЬКО
    // динамический шаг 5 -> режим TARGETED_REFRESH, исследуется только он.
    name: "targeted refresh (D-058): всё покрыто, просрочен только динамический шаг 5",
    angle: "freshness",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the buyback still active and does value reach the token",
    seedFacts: [
      { patternStep: 1, component: "SOURCE_OF_VALUE", claimKey: "tr_step_1", statement: "tr: source verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 2, component: "FLOW_PATH", claimKey: "tr_step_2", statement: "tr: flow verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 3, component: "MECHANISM_SPEC", claimKey: "tr_step_3", statement: "tr: mechanism verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 3, component: "GOVERNANCE_BASIS", claimKey: "tr_step_3_gov", statement: "tr: governance verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 4, component: "EXECUTION_EVIDENCE", claimKey: "tr_step_4", statement: "tr: execution verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "tr_step_5", statement: "tr: status checked a month ago", freshnessClass: "HIGH_CHANGE", verifiedAt: STALE_HIGH_CHANGE, confidence: 95, promote: true, reusable: false, invalidReason: "STALE" },
      { patternStep: 6, component: "DESTINATION", claimKey: "tr_step_6", statement: "tr: destination verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 6, component: "RECIPIENT", claimKey: "tr_step_6_rec", statement: "tr: recipient verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 7, component: "NET_EFFECT", claimKey: "tr_step_7", statement: "tr: net effect verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 8, component: "DURABILITY_BASIS", claimKey: "tr_step_8", statement: "tr: durability verified", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [1, 2, 3, 4, 6, 7, 8],
    expectedRequiredFreshSteps: [5],
    expectedMissingSteps: [],
  },
  {
    name: "sufficiency: всё свежо и покрыто",
    angle: "sufficiency",
    capability: "FRESH_RESEARCH",
    statementQuery: "full value capture review",
    // Полное покрытие по D-060 — все КОМПОНЕНТЫ всех шагов, включая оба
    // компонента шагов 3 и 6 (10 фактов, не 8 записей «по одной на шаг»).
    seedFacts: [
      { patternStep: 1, component: "SOURCE_OF_VALUE", claimKey: "step_1_claim", statement: "verified fact for step 1", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 2, component: "FLOW_PATH", claimKey: "step_2_claim", statement: "verified fact for step 2", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 3, component: "MECHANISM_SPEC", claimKey: "step_3_claim", statement: "verified fact for step 3 mechanism", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 3, component: "GOVERNANCE_BASIS", claimKey: "step_3_gov_claim", statement: "verified fact for step 3 governance", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 4, component: "EXECUTION_EVIDENCE", claimKey: "step_4_claim", statement: "verified fact for step 4", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "step_5_claim", statement: "verified fact for step 5", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 6, component: "DESTINATION", claimKey: "step_6_claim", statement: "verified fact for step 6 destination", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 6, component: "RECIPIENT", claimKey: "step_6_recipient_claim", statement: "verified fact for step 6 recipient", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 7, component: "NET_EFFECT", claimKey: "step_7_claim", statement: "verified fact for step 7", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
      { patternStep: 8, component: "DURABILITY_BASIS", claimKey: "step_8_claim", statement: "verified fact for step 8", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: "capability boundary: DEMO не получает FRESH_RESEARCH",
    angle: "capability_boundary",
    capability: "TARGETED_REFRESH",
    statementQuery: "brand new project, nothing known",
    seedFacts: [],
    expectedSatisfiedSteps: [],
    expectedMissingSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: "wording: другая формулировка того же claim",
    angle: "wording",
    capability: "FRESH_RESEARCH",
    statementQuery: "does the project burn revenue into the token supply",
    seedFacts: [
      { patternStep: 7, component: "NET_EFFECT", claimKey: "net_token_effect", statement: "Half of protocol revenue is used to burn the token every epoch", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 88, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [7],
  },
  {
    name: "poisoning: заведомо непроверенное знание не закрывает шаг",
    angle: "poisoning",
    capability: "FRESH_RESEARCH",
    statementQuery: "was the buyback actually executed",
    seedFacts: [
      { patternStep: 4, component: "EXECUTION_EVIDENCE", claimKey: "actual_execution", statement: "PLANTED: buyback executed (unverified)", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 99, promote: false, reusable: false, invalidReason: "UNPROMOTED" },
    ],
    expectedSatisfiedSteps: [], // не промоутнут -> CANDIDATE -> невидим retrieval
    expectedMissingSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: "чужой проект: память проекта A не закрывает шаг проекта B",
    angle: "cross_project",
    capability: "FRESH_RESEARCH",
    statementQuery: "durability of the mechanism",
    seedFacts: [],
    foreignProjectSeedFacts: [
      { patternStep: 8, component: "DURABILITY_BASIS", claimKey: "durability", statement: "durable per foreign project's governance", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: false, invalidReason: "WRONG_PROJECT" },
    ],
    expectedSatisfiedSteps: [],
    expectedMissingSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },

  // ===== Пакет исправлений ревью: новые углы =====

  {
    // Обязательная регрессия D-058 (ревью HIGH-1): один закрытый шаг при
    // семи MISSING обязан дать желаемый FRESH_RESEARCH и упереть DEMO в
    // потолок — граница доступа НЕ молчит из-за одного закрытого шага.
    name: "mode boundary (D-058): DEMO, 1 закрыт + 7 MISSING -> граница доступа",
    angle: "mode_boundary",
    capability: "TARGETED_REFRESH", // потолок DEMO
    statementQuery: "does protocol revenue reach token holders",
    seedFacts: [
      { patternStep: 1, component: "SOURCE_OF_VALUE", claimKey: "economic_source", statement: "swap fee is the source", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [1],
    expectedMissingSteps: [2, 3, 4, 5, 6, 7, 8],
  },
  {
    // D-059: QUESTIONABLE извлекается и направляет перепроверку, но шаг
    // НЕ закрывает.
    name: "health QUESTIONABLE: направляет перепроверку, шаг не закрывает",
    angle: "health",
    capability: "FRESH_RESEARCH",
    statementQuery: "how do fees flow through the protocol",
    seedFacts: [
      { patternStep: 2, component: "FLOW_PATH", claimKey: "revenue_waterfall", statement: "fees flow to treasury first (questionable)", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, health: "QUESTIONABLE", reusable: false, invalidReason: "UNHEALTHY" },
    ],
    expectedSatisfiedSteps: [],
    expectedRequiredFreshSteps: [2],
  },
  {
    name: "health REVERIFY: направляет перепроверку, шаг не закрывает",
    angle: "health",
    capability: "FRESH_RESEARCH",
    statementQuery: "was the buyback executed",
    seedFacts: [
      { patternStep: 4, component: "EXECUTION_EVIDENCE", claimKey: "actual_execution", statement: "buyback executed per governance record (reverify)", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, health: "REVERIFY", reusable: false, invalidReason: "UNHEALTHY" },
    ],
    expectedSatisfiedSteps: [],
    expectedRequiredFreshSteps: [4],
  },
  {
    name: "health STALE: направляет перепроверку, шаг не закрывает",
    angle: "health",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the mechanism currently active",
    seedFacts: [
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "current_status", statement: "mechanism active as of last check (stale health)", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, health: "STALE", reusable: false, invalidReason: "UNHEALTHY" },
    ],
    expectedSatisfiedSteps: [],
    expectedRequiredFreshSteps: [5],
  },
  {
    // D-059: DEPRECATED не извлекается вовсе — знание признано НЕВЕРНЫМ,
    // а не устаревшим; шаг становится MISSING. Запись при этом сохраняется
    // в хранилище (история не удаляется).
    name: "health DEPRECATED: исключён из retrieval, шаг MISSING",
    angle: "health",
    capability: "FRESH_RESEARCH",
    statementQuery: "net effect of the mechanism on the token",
    seedFacts: [
      { patternStep: 7, component: "NET_EFFECT", claimKey: "net_token_effect", statement: "DEPRECATED: net effect claim proven wrong", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, health: "DEPRECATED", reusable: false, invalidReason: "UNHEALTHY" },
    ],
    expectedSatisfiedSteps: [],
    expectedMissingSteps: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    // MEDIUM-1, направление «не усекать в ноль»: запись 20 часов от роду с
    // политикой '36 hours' СВЕЖА. Прежний код (EXTRACT(DAY ...)) превращал
    // '36 hours' в 0 дней и делал запись вечно просроченной.
    name: "stale_after 36h: запись моложе политики свежа (интервал не усекается в ноль)",
    angle: "stale_policy",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the mechanism currently active",
    seedFacts: [
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "current_status", statement: "mechanism active, checked 20 hours ago", freshnessClass: "LOW_CHANGE", verifiedAt: HOURS_20_AGO, staleAfter: { hours: 36 }, confidence: 95, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [5],
  },
  {
    // MEDIUM-1, направление «явная политика строже класса»: запись 48 часов
    // от роду с политикой '36 hours' просрочена, хотя фолбэк класса
    // LOW_CHANGE (180 дней) счёл бы её свежей. Явно сохранённая политика
    // записи не подменяется молча.
    name: "stale_after 36h: запись старше политики просрочена (явная политика сильнее класса)",
    angle: "stale_policy",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the mechanism currently active",
    seedFacts: [
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "current_status", statement: "mechanism active, checked 48 hours ago", freshnessClass: "LOW_CHANGE", verifiedAt: HOURS_48_AGO, staleAfter: { hours: 36 }, confidence: 95, promote: true, reusable: false, invalidReason: "STALE" },
    ],
    expectedSatisfiedSteps: [],
    expectedRequiredFreshSteps: [5],
  },
  {
    // MEDIUM-1, месяцы: политика '3 months' на записи 30 дней от роду —
    // свежа, хотя фолбэк HIGH_CHANGE (3 дня) счёл бы её просроченной.
    // Прежний код превращал '3 months' в 0 дней — вечно просрочена.
    name: "stale_after 3mo: месячная политика записи сохраняет смысл",
    angle: "stale_policy",
    capability: "FRESH_RESEARCH",
    statementQuery: "durability of the mechanism",
    seedFacts: [
      { patternStep: 8, component: "DURABILITY_BASIS", claimKey: "durability", statement: "mechanism durable per locked contract, verified a month ago", freshnessClass: "HIGH_CHANGE", verifiedAt: DAYS_30_AGO, staleAfter: { months: 3 }, confidence: 95, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [8],
  },
  {
    // D-060 (ревью MEDIUM-4): claim_key — свободный текст и валидность шага
    // НЕ определяет. Факт с claim_key 'economic_source', легитимно записанный
    // в (шаг 8, DURABILITY_BASIS), закрывает ТОЛЬКО шаг 8 — «чужой» шаг 1
    // остаётся MISSING. Обратное направление (запись economic_source-
    // компонента в шаг 8) отклоняет триггер БД — проверено tests/phase5.
    name: "component mapping (D-060): claim_key не закрывает чужой шаг",
    angle: "component_mapping",
    capability: "FRESH_RESEARCH",
    statementQuery: "value capture durability",
    seedFacts: [
      { patternStep: 8, component: "DURABILITY_BASIS", claimKey: "economic_source", statement: "durability assessment mislabeled with economic_source claim key", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [8],
    expectedMissingSteps: [1, 2, 3, 4, 5, 6, 7],
  },
  {
    // D-060: частичное покрытие многокомпонентных шагов. Шаг 3 покрыт
    // только MECHANISM_SPEC (нет GOVERNANCE_BASIS), шаг 6 — только
    // DESTINATION (нет RECIPIENT): оба -> REQUIRED_FRESH, не satisfied.
    // Сами факты пригодны (reusable) — непригодно ПОКРЫТИЕ шага.
    name: "partial coverage (D-060): многокомпонентный шаг не закрывается одним компонентом",
    angle: "partial_component",
    capability: "FRESH_RESEARCH",
    statementQuery: "allocation mechanism and destination of value",
    seedFacts: [
      { patternStep: 3, component: "MECHANISM_SPEC", claimKey: "allocation_mechanism", statement: "buyback mechanism specified in docs", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 92, promote: true, reusable: true },
      { patternStep: 6, component: "DESTINATION", claimKey: "token_destination", statement: "value lands in the treasury", freshnessClass: "MEDIUM_CHANGE", verifiedAt: FRESH, confidence: 92, promote: true, reusable: true },
    ],
    expectedSatisfiedSteps: [],
    expectedRequiredFreshSteps: [3, 6],
  },
  {
    // D-062: две ACTIVE-записи, обе прошли health и свежесть, один
    // (pattern_step, component), различный mechanism_state -> конфликт.
    // Шаг НЕ закрывается, причина CONTRADICTED, конфликтующие memoryId
    // остаются предъявимыми в контракте.
    name: "contradiction (D-062): конфликт mechanism_state не закрывает шаг",
    angle: "contradiction",
    capability: "FRESH_RESEARCH",
    statementQuery: "is the buyback mechanism currently active",
    seedFacts: [
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "current_status_a", statement: "buyback mechanism is running", mechanismState: "ACTIVE", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 95, promote: true, reusable: false, invalidReason: "CONTRADICTED" },
      { patternStep: 5, component: "CURRENT_STATE", claimKey: "current_status_b", statement: "buyback mechanism is halted", mechanismState: "PAUSED", freshnessClass: "LOW_CHANGE", verifiedAt: FRESH, confidence: 93, promote: true, reusable: false, invalidReason: "CONTRADICTED" },
    ],
    expectedSatisfiedSteps: [],
    expectedRequiredFreshSteps: [5],
  },
  {
    // D-061: контролируемое НЕБЕЗОПАСНОЕ переиспользование — доказательство,
    // что метрика false_reuse МОЖЕТ стать ненулевой. Факт проходит все
    // правила планировщика (ACTIVE, OK, уверенный, в пределах фолбэка
    // LOW_CHANGE=180д), но контрольная истина знает: мир изменился, факт
    // непригоден (STALE). Планировщик закроет шаг — метрика ОБЯЗАНА это
    // поймать. В acceptance-агрегат не входит (metricValidationOnly).
    name: "unsafe reuse (метрика-контроль): планировщик закрывает шаг непригодным фактом",
    angle: "unsafe_reuse",
    metricValidationOnly: true,
    capability: "FRESH_RESEARCH",
    statementQuery: "where does the economic value come from",
    seedFacts: [
      { patternStep: 1, component: "SOURCE_OF_VALUE", claimKey: "economic_source", statement: "fee switch is the source (world changed since verification)", freshnessClass: "LOW_CHANGE", verifiedAt: DAYS_100_AGO, confidence: 95, promote: true, reusable: false, invalidReason: "STALE" },
    ],
    // Объявленная истина: шаг НЕ должен считаться закрытым — но планировщик
    // по своим правилам его закроет; расхождение и есть предмет проверки.
    expectedSatisfiedSteps: [],
  },
];
