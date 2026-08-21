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

// zod-контракт на content (phase-5-plan.md §5.2) — без него blind-регрессия
// будущей Фазы 10 непроверяема: Pattern v1 обязан оставаться ровно 8 шагами
// в фиксированном порядке.
export const patternContentSchema = z.object({
  steps: z.array(patternStepSchema).length(8),
  requiredComponents: requiredComponentsSchema,
});

export type PatternContent = z.infer<typeof patternContentSchema>;

export function requiredComponentsForStep(
  pattern: PatternContent,
  step: number,
): string[] {
  return pattern.requiredComponents[String(step)] ?? [];
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
};

// Валидируется на модуле, а не только в сиде: искажённая константа не
// должна молча пройти в продакшен.
patternContentSchema.parse(PATTERN_V1_CONTENT);
