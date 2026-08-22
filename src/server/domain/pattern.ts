import { z } from "zod";

// Pattern v1 — скелет Research Boundary Contract (phase-5-plan.md §4.1,
// canonical §14). 8 шагов Token Value Capture. CORE управляется человеком
// (D-022): переход v1→v2 — ручной, с регрессией; этот файл не меняется
// исполнением Фазы 5, только читается планировщиком и сидом.

export const PATTERN_STEP_NAMES = [
  "Economic Source",
  "Revenue Waterfall",
  "Allocation Mechanism",
  "Actual Execution",
  "Current Status + Freshness",
  "Token Destination + Recipient",
  "Net Token Effect",
  "Durability",
] as const;

export type PatternStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const patternStepSchema = z.object({
  step: z.number().int().min(1).max(8),
  name: z.string().min(1),
  question: z.string().min(1),
});

// D-060: компоненты шага живут в research_patterns.content — внутри CORE,
// который меняет человек (D-022). Ключ — номер шага строкой (jsonb),
// значение — фиксированный список компонентов, каждый из которых обязан
// быть покрыт пригодной памятью, чтобы шаг стал ALREADY_SATISFIED.
// Это контракт ТОЛЬКО Token Value Capture Pattern v1 — универсальная
// онтология не вводится.
const requiredComponentsSchema = z
  .record(z.string(), z.array(z.string().min(1)).min(1))
  .superRefine((rec, ctx) => {
    const keys = Object.keys(rec).sort();
    const expected = ["1", "2", "3", "4", "5", "6", "7", "8"];
    if (keys.length !== 8 || keys.some((k, i) => k !== expected[i])) {
      ctx.addIssue({
        code: "custom",
        message: `requiredComponents must cover exactly steps 1..8, got: ${keys.join(",")}`,
      });
    }
  });

// Phase 6, S5 (phase-6-s5-plan.md §5, §11.1, D-095) — ComponentRequirements
// live in Pattern/CORE content, additively, keyed by COMPONENT NAME (not
// step — a component name is unique across the whole Pattern v1 matrix).
// `ComponentReconciler` (component-reconciler.ts) CONSUMES this and never
// invents a fallback: a component absent from this record has NO Pattern
// requirement, which componentRequirementsFor() below represents as an
// empty establishingClasses set — nothing establishes it, not a coded
// default standing in for one (S5 plan §5, acceptance scenario Y).
const evidenceSourceClassSchema = z.enum([
  "ONCHAIN_VERIFIABLE",
  "OFFICIAL_DOCS",
  "GOVERNANCE",
  "OFFICIAL_REPORT",
  "DATA_PROVIDER",
  "RESEARCH_MEDIA",
  "SOCIAL",
]);

const freshnessClassSchema = z.enum(["LOW_CHANGE", "MEDIUM_CHANGE", "HIGH_CHANGE"]);

const componentRequirementsEntrySchema = z.object({
  // §5 — the only source of establishment/contradiction/supersession
  // authority for this component (D-093: no global sourceClass ranking
  // exists anywhere else). Empty array is a legal, meaningful value: the
  // component structurally cannot be established (scenario Y).
  establishingClasses: z.array(evidenceSourceClassSchema),
  // §6.2 — whether establishing this component additionally requires a
  // provable currency basis (published_at inside the freshness window, or
  // fetched_at for ONCHAIN_VERIFIABLE).
  requiresCurrentState: z.boolean(),
  // §6.3 — whether establishing this component additionally requires the
  // establishing element's own normalized mechanism_state to indicate the
  // mechanism is actually LIVE (IMPLEMENTING downgrades to
  // PARTIALLY_SUPPORTED/STATE_NOT_FULLY_LIVE; PROPOSED/APPROVED/anything
  // else does not establish at all). Distinct from requiresCurrentState:
  // EXECUTION_EVIDENCE needs this gate without the freshness-window gate
  // (§5 table: "нет (но §6.3)").
  requiresLiveMechanismState: z.boolean(),
  freshnessClass: freshnessClassSchema,
  // §9.1 condition 1.
  tokenStateSensitive: z.boolean(),
  // §9.1 condition 3 — exact normalized-string equality only; S5 never
  // infers it. null = equality not established by Pattern data (the
  // common case for Pattern v1, which is not query-specific).
  requiredTokenState: z.string().min(1).nullable(),
});

export type ComponentRequirementsEntry = z.infer<typeof componentRequirementsEntrySchema>;

// Optional — a Pattern predating S5 (or any content JSON missing this key
// entirely) parses fine; componentRequirementsFor() below is what actually
// enforces "missing means no requirement", not this schema's optionality.
const componentRequirementsSchema = z.record(z.string(), componentRequirementsEntrySchema).optional();

// zod-контракт на content (phase-5-plan.md §5.2) — без него blind-регрессия
// будущей Фазы 10 непроверяема: Pattern v1 обязан оставаться ровно 8 шагами
// в фиксированном порядке.
export const patternContentSchema = z.object({
  steps: z.array(patternStepSchema).length(8),
  requiredComponents: requiredComponentsSchema,
  componentRequirements: componentRequirementsSchema,
});

export type PatternContent = z.infer<typeof patternContentSchema>;

export function requiredComponentsForStep(
  pattern: PatternContent,
  step: number,
): string[] {
  return pattern.requiredComponents[String(step)] ?? [];
}

// D-095: the reconciler-facing accessor. A component with no entry gets a
// neutral, non-establishing shape — NOT a code-invented authority list.
// establishingClasses: [] is the only thing that makes that neutral: it
// structurally cannot establish anything (CLASS_NOT_ADMISSIBLE for every
// row), it does not silently grant or forbid anything else.
const NO_REQUIREMENT: ComponentRequirementsEntry = {
  establishingClasses: [],
  requiresCurrentState: false,
  requiresLiveMechanismState: false,
  freshnessClass: "LOW_CHANGE",
  tokenStateSensitive: false,
  requiredTokenState: null,
};

export function componentRequirementsFor(
  pattern: PatternContent,
  component: string,
): ComponentRequirementsEntry {
  return pattern.componentRequirements?.[component] ?? NO_REQUIREMENT;
}

export const PATTERN_V1_CONTENT: PatternContent = {
  steps: [
    {
      step: 1,
      name: "Economic Source",
      question: "Where does the economic value the project claims come from?",
    },
    {
      step: 2,
      name: "Revenue Waterfall",
      question: "How does that value flow through the protocol before it reaches anyone?",
    },
    {
      step: 3,
      name: "Allocation Mechanism",
      question: "What mechanism decides how much of that value goes to the token?",
    },
    {
      step: 4,
      name: "Actual Execution",
      question: "Has that mechanism actually been executed, not just specified?",
    },
    {
      step: 5,
      name: "Current Status + Freshness",
      question: "Is the mechanism currently active, and how recently was that verified?",
    },
    {
      step: 6,
      name: "Token Destination + Recipient",
      question: "Where does the value land once it reaches the token — burn, buyback, staking, treasury?",
    },
    {
      step: 7,
      name: "Net Token Effect",
      question: "What is the net effect on the token after accounting for emissions and dilution?",
    },
    {
      step: 8,
      name: "Durability",
      question: "Is this mechanism durable, or contingent on conditions that could reverse it?",
    },
  ],
  // D-060: два многокомпонентных шага — намеренное содержательное суждение
  // (phase-5-plan.md §4.1a): «механизм описан» и «механизм санкционирован» —
  // разные факты (шаг 3); «куда ушла ценность» и «кто её держит» — тоже
  // разные (шаг 6). Остальные шесть шагов однокомпонентны.
  requiredComponents: {
    "1": ["SOURCE_OF_VALUE"],
    "2": ["FLOW_PATH"],
    "3": ["MECHANISM_SPEC", "GOVERNANCE_BASIS"],
    "4": ["EXECUTION_EVIDENCE"],
    "5": ["CURRENT_STATE"],
    "6": ["DESTINATION", "RECIPIENT"],
    "7": ["NET_EFFECT"],
    "8": ["DURABILITY_BASIS"],
  },
  // Phase 6, S5 (phase-6-s5-plan.md §5, matrix already approved by the
  // plan and reproduced here verbatim as Pattern DATA, D-095). SOCIAL
  // appears in no row — no component is establishable by it, however many
  // SOCIAL rows accumulate (D-074). requiresLiveMechanismState is set for
  // exactly the two components §6.3 names (CURRENT_STATE, EXECUTION_EVIDENCE);
  // requiresCurrentState (the freshness-window gate, §6.2) is set for
  // CURRENT_STATE only, per the table's own "нет (но §6.3)" annotation for
  // EXECUTION_EVIDENCE. tokenStateSensitive marks the three components
  // D-096 names explicitly (RECIPIENT, DESTINATION, NET_EFFECT).
  // requiredTokenState is null everywhere — Pattern v1 is not
  // query-specific; a real requiredTokenState is a test/S6 concept, never
  // invented here.
  componentRequirements: {
    SOURCE_OF_VALUE: {
      establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE", "ONCHAIN_VERIFIABLE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
    },
    FLOW_PATH: {
      establishingClasses: ["OFFICIAL_DOCS", "ONCHAIN_VERIFIABLE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
    },
    MECHANISM_SPEC: {
      establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
    },
    GOVERNANCE_BASIS: {
      establishingClasses: ["GOVERNANCE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
    },
    EXECUTION_EVIDENCE: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
      requiresCurrentState: false,
      requiresLiveMechanismState: true,
      freshnessClass: "MEDIUM_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
    },
    CURRENT_STATE: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "OFFICIAL_REPORT"],
      requiresCurrentState: true,
      // §6.3: CURRENT_STATE reports whatever the current state actually IS
      // (LIVE, DEPRECATED, PAUSED, ... are all legitimate answers) — it is
      // NOT gated to only LIVE. requiresLiveMechanismState stays false here;
      // it is EXECUTION_EVIDENCE's gate (below), not this component's.
      requiresLiveMechanismState: false,
      freshnessClass: "HIGH_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
    },
    DESTINATION: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: true,
      requiredTokenState: null,
    },
    RECIPIENT: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "GOVERNANCE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: true,
      requiredTokenState: null,
    },
    NET_EFFECT: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: true,
      requiredTokenState: null,
    },
    DURABILITY_BASIS: {
      establishingClasses: ["GOVERNANCE", "OFFICIAL_DOCS"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
    },
  },
};

// Валидируется на модуле, а не только в сиде: искажённая константа не
// должна молча пройти в продакшен.
patternContentSchema.parse(PATTERN_V1_CONTENT);
