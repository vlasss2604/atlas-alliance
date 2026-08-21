import { z } from "zod";

// Research Boundary Contract (phase-5-plan.md §4.2, D-050, D-056). Место,
// где память СТАНОВИТСЯ планом — не текст в промпте, а структура,
// проверяемая кодом. Строится детерминированным планировщиком (D-052),
// раскладывающим найденное памятью по 8 шагам Pattern v1.

export const NOVELTY_STATES = ["KNOWN", "PARTIALLY_KNOWN", "NOVEL"] as const;
export type NoveltyState = (typeof NOVELTY_STATES)[number];

export const STEP_DECISIONS = [
  "ALREADY_SATISFIED",
  "REQUIRED_FRESH",
  "MISSING",
] as const;
export type StepDecisionKind = (typeof STEP_DECISIONS)[number];

const jobBudgetSchema = z.object({
  maxSearchQueries: z.number().int().positive(),
  maxSourceOpens: z.number().int().positive(),
  maxModelCostMicro: z.number().int().positive(),
  maxWallClockSec: z.number().int().positive(),
  reservedRecoverySteps: z.number().int().min(0),
});

// Одна запись переиспользуемого доказательства — конкретная строка памяти
// с provenance, а не «похожий текст» (§4.2: «Отличие от RAG»).
const reusableEvidenceSchema = z.object({
  memoryId: z.string(),
  step: z.number().int().min(1).max(8),
  // D-060: компонент, который эта запись закрывает — обязателен для аудита
  // "все ли requiredComponents шага действительно покрыты".
  component: z.string(),
  claimKey: z.string(),
  statement: z.string(),
  confidence: z.number().int().min(0).max(100),
});

// Решение по шагу — объяснимо: «почему шаг переиспользован/обновлён»
// (DoD, phase-5-plan.md §10). reason — детерминированная строка кода,
// не свободная генерация модели (D-052).
const stepDecisionSchema = z.object({
  step: z.number().int().min(1).max(8),
  stepName: z.string(),
  decision: z.enum(STEP_DECISIONS),
  reason: z.string(),
  memoryIds: z.array(z.string()),
});

export const researchBoundaryContractSchema = z.object({
  patternVersion: z.number().int().positive(),
  alreadySatisfiedSteps: z.array(z.number().int().min(1).max(8)),
  reusableEvidence: z.array(reusableEvidenceSchema),
  requiredFreshEvidence: z.array(z.number().int().min(1).max(8)),
  missingSteps: z.array(z.number().int().min(1).max(8)),
  excludedScope: z.array(z.string()),
  stopConditions: z.array(z.string()),
  knownInformation: z.array(z.string()),
  researchBudget: jobBudgetSchema,
  noveltyState: z.enum(NOVELTY_STATES),
  // Полная раскладка — источник для §4.2 полей выше и для объяснимости.
  stepDecisions: z.array(stepDecisionSchema).length(8),
});

export type ReusableEvidence = z.infer<typeof reusableEvidenceSchema>;
export type StepDecision = z.infer<typeof stepDecisionSchema>;
export type ResearchBoundaryContract = z.infer<
  typeof researchBoundaryContractSchema
>;

export function parseContract(raw: unknown): ResearchBoundaryContract {
  return researchBoundaryContractSchema.parse(raw);
}
