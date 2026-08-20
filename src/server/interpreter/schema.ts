import { z } from "zod";

// Контракт Question Interpreter (phase-4-plan §2.1, канон atlas-intent).
// Схема — второй барьер безопасности после промпта: ответ вне схемы не
// существует для системы. Все поля обязательны (structured outputs);
// «нет значения» выражается через null, не через отсутствие ключа.

export const TASK_TYPES = [
  "PROJECT_MECHANISM",
  "PROJECT_REVENUE",
  "TOKEN_VALUE",
  "RISK",
  "CLAIM_VERIFICATION",
  "COMPARISON",
  "CHANGE_OVER_TIME",
  "EXPLANATION",
  "OTHER_RESEARCH",
] as const;

export const RESEARCH_INTENTS = [
  "TOKEN_UTILITY",
  "PASSIVE_HOLDER_OUTCOME",
  "PROTOCOL_REVENUE_TO_TOKEN",
  "USAGE_TO_TOKEN_LINKAGE",
  "REWARD_SOURCE",
  "BURN_OR_SUPPLY_EFFECT",
  "MECHANISM_CURRENT_STATE",
  "VALUE_CAPTURE",
  "SCENARIO_CAUSAL_IMPACT",
  "CLAIM_FACT_CHECK",
  "UNKNOWN",
] as const;

export const QUERY_ROUTES = [
  "DEEP_RESEARCH",
  "QUICK_EXPLANATION",
  "CLARIFICATION_REQUIRED",
  "NO_RESEARCH_NEEDED",
  "OUTSIDE_CURRENT_DOMAIN",
] as const;

export const INTERPRETER_STATUSES = [
  "READY",
  "NEEDS_CLARIFICATION",
  "OUT_OF_SCOPE",
  "INVALID",
] as const;

// Лимиты вывода (phase-4-plan §5.5). Длинный текст модели — не наш случай:
// Interpreter структурирует, а не рассказывает.
export const MAX_QUICK_ANSWER_CHARS = 600;
export const MAX_RESEARCH_TASK_CHARS = 400;
export const MAX_CLARIFICATION_CHARS = 300;
export const MAX_LIST_ITEMS = 6;

// original_question в схеме НЕТ намеренно: оригинал хранит сервер verbatim,
// модель не может переписать его (иначе инъекция подменяет «оригинал» в логе).
export const interpreterResultSchema = z
  .object({
    status: z.enum(INTERPRETER_STATUSES),
    project_or_asset: z.string().max(120).nullable(),
    // ВСЕ остальные названные сущности задачи (сравнение, «X против Y»).
    // Entitlement Gate обязан проверять каждую из них, а не только
    // основную (канон atlas-intent: «не делать половину сравнения»).
    related_entities: z.array(z.string().max(120)).max(4),
    topic: z.string().max(120).nullable(),
    task_type: z.enum(TASK_TYPES).nullable(),
    research_task: z.string().max(MAX_RESEARCH_TASK_CHARS).nullable(),
    // То же понимание, но НА ЯЗЫКЕ ПОЛЬЗОВАТЕЛЯ и человеческими словами.
    // research_task — вход Research Engine (английский research language);
    // показывать его человеку значит вывалить наружу внутреннюю кухню.
    understood_summary: z.string().max(300).nullable(),
    user_assumptions: z.array(z.string().max(200)).max(MAX_LIST_ITEMS),
    ambiguities: z.array(z.string().max(200)).max(MAX_LIST_ITEMS),
    clarification_question: z.string().max(MAX_CLARIFICATION_CHARS).nullable(),
    route: z.enum(QUERY_ROUTES),
    normalized_intent: z.enum(RESEARCH_INTENTS),
    intent_confidence: z.number().min(0).max(1),
    route_reason: z.string().max(300),
    needs_fresh_evidence: z.boolean(),
    quick_answer: z.string().max(MAX_QUICK_ANSWER_CHARS).nullable(),
  })
  .strict();

export type InterpreterModelResult = z.infer<typeof interpreterResultSchema>;
export type InterpreterStatus = (typeof INTERPRETER_STATUSES)[number];
export type QueryRoute = (typeof QUERY_ROUTES)[number];

export class InterpreterContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterpreterContractError";
  }
}

// Согласованность между полями — то, что JSON-схема выразить не может.
// Нарушение = невалидный ответ модели (retry → 502), а не «почти годный»
// результат, который поедет дальше по конвейеру.
export function assertConsistent(r: InterpreterModelResult): void {
  const fail = (m: string) => {
    throw new InterpreterContractError(m);
  };

  if (r.status === "READY") {
    if (!r.research_task?.trim()) fail("READY without research_task");
    if (r.route === "CLARIFICATION_REQUIRED") fail("READY with CLARIFICATION_REQUIRED");
  }
  if (r.status === "NEEDS_CLARIFICATION") {
    if (!r.clarification_question?.trim()) fail("NEEDS_CLARIFICATION without question");
    if (r.route !== "CLARIFICATION_REQUIRED") fail("NEEDS_CLARIFICATION with wrong route");
  }
  if (r.status !== "READY" && r.route === "DEEP_RESEARCH") {
    fail("DEEP_RESEARCH requires READY");
  }
  // Короткий ответ ARI допустим только на маршрутах без исследования
  // (решение владельца №1, вариант A): никакого AI-текста рядом с Proof.
  if (
    r.quick_answer &&
    r.route !== "QUICK_EXPLANATION" &&
    r.route !== "NO_RESEARCH_NEEDED"
  ) {
    fail("quick_answer outside explanation routes");
  }
  if (
    (r.route === "QUICK_EXPLANATION" || r.route === "NO_RESEARCH_NEEDED") &&
    !r.quick_answer?.trim()
  ) {
    fail("explanation route without quick_answer");
  }
  // Понимание обязано быть предъявимо человеку везде, где мы его показываем.
  if (
    (r.route === "DEEP_RESEARCH" || r.route === "CLARIFICATION_REQUIRED") &&
    !r.understood_summary?.trim()
  ) {
    fail("missing understood_summary");
  }
  // Сравнение без второй сущности — не сравнение (канон atlas-intent).
  if (r.task_type === "COMPARISON" && r.related_entities.length === 0) {
    fail("COMPARISON without a second entity");
  }
  if (r.related_entities.length > 0 && !r.project_or_asset?.trim()) {
    fail("related_entities without a primary entity");
  }
}

export function parseInterpreterResult(raw: unknown): InterpreterModelResult {
  const parsed = interpreterResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InterpreterContractError(
      `schema: ${parsed.error.issues.map((i) => i.path.join(".")).join(",")}`,
    );
  }
  assertConsistent(parsed.data);
  return parsed.data;
}
