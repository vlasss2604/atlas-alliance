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

// zod-контракт на content (phase-5-plan.md §5.2) — без него blind-регрессия
// будущей Фазы 10 непроверяема: Pattern v1 обязан оставаться ровно 8 шагами
// в фиксированном порядке.
export const patternContentSchema = z.object({
  steps: z.array(patternStepSchema).length(8),
});

export type PatternContent = z.infer<typeof patternContentSchema>;

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
};

// Валидируется на модуле, а не только в сиде: искажённая константа не
// должна молча пройти в продакшен.
patternContentSchema.parse(PATTERN_V1_CONTENT);
