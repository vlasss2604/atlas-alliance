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
    // research_task — вход движка, поэтому обязателен ровно там, где
    // движок может стартовать. Объяснение исследовательской задачи
    // не имеет, и требовать её значило бы заставлять модель выдумывать.
    if (r.route === "DEEP_RESEARCH" && !r.research_task?.trim()) {
      fail("DEEP_RESEARCH without research_task");
    }
    if (r.route === "CLARIFICATION_REQUIRED") fail("READY with CLARIFICATION_REQUIRED");
  }
  // Короткий ответ — это ответ, а не отказ: маршруты-объяснения обязаны
  // приходить со статусом READY, иначе UI покажет «не понял» рядом
  // с готовым ответом (найдено живым прогоном, кейс «интернет на Луне»).
  if (
    (r.route === "QUICK_EXPLANATION" || r.route === "NO_RESEARCH_NEEDED") &&
    r.status !== "READY"
  ) {
    fail("explanation route requires READY status");
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
  // Понимание обязано быть предъявимо человеку на главном экране —
  // карточке «вот что я буду исследовать». На экране уточнения оно
  // желательно (промпт требует), но его отсутствие обедняет экран,
  // а не ломает запрос: 502 вместо вопроса — заведомо худший исход
  // (живой прогон: «сравни вот этот и вот этот» — не названо ничего).
  if (r.route === "DEEP_RESEARCH" && !r.understood_summary?.trim()) {
    fail("missing understood_summary");
  }
  // Сравнение без второй сущности — не сравнение (канон atlas-intent).
  if (r.task_type === "COMPARISON" && r.related_entities.length === 0) {
    fail("COMPARISON without a second entity");
  }
  if (r.related_entities.length > 0 && !r.project_or_asset?.trim()) {
    fail("related_entities without a primary entity");
  }
  // Живой прогон (2026-08-23): "Куда на самом деле уходят токены $PUMP,
  // которые pump.fun покупает через buyback, и уменьшает ли это
  // предложение токена?" вернулась с status=OUT_OF_SCOPE/route=
  // OUTSIDE_CURRENT_DOMAIN, но с normalized_intent=MECHANISM_CURRENT_STATE
  // и non-empty research_task, описывающим ровно buyback/supply-effect
  // механизм — тот же вопрос, который модель сама классифицировала как
  // исследовательскую задачу. Это самопротиворечивый вывод модели (не
  // решение сервера и не особый случай языка/проекта): normalized_intent
  // вне UNKNOWN и заполненный research_task не могут сосуществовать с
  // «вне домена». Требуем status===OUT_OF_SCOPE отдельно от route, чтобы
  // не задеть механическую деградацию normalizeModelOutput() (explanation-
  // маршрут без quick_answer → route=OUTSIDE_CURRENT_DOMAIN, status=
  // INVALID, "13b" ниже) — та деградация оставляет старые normalized_intent/
  // research_task нетронутыми и не является этим классом противоречия.
  if (
    r.status === "OUT_OF_SCOPE" &&
    r.route === "OUTSIDE_CURRENT_DOMAIN" &&
    r.normalized_intent !== "UNKNOWN" &&
    r.research_task?.trim()
  ) {
    fail("OUTSIDE_CURRENT_DOMAIN with in-domain normalized_intent and research_task");
  }
}

// Нормализация ДО строгой проверки. Канон atlas-intent прямо требует:
// task_type «не должен превращаться в жёсткую систему, блокирующую валидные
// вопросы». То же для справочных текстов: если модель написала на десяток
// символов длиннее, это не повод отказать пользователю в интерпретации.
// Всё, что решает поведение (status/route/сущности/quick_answer), остаётся
// строгим — там подгонка недопустима.
const EXPLANATION_ROUTES = ["QUICK_EXPLANATION", "NO_RESEARCH_NEEDED"];

function clamp(v: unknown, max: number): unknown {
  return typeof v === "string" && v.length > max ? v.slice(0, max).trimEnd() : v;
}

export function normalizeModelOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };

  // Неизвестный тип задачи — справочное поле: не блокируем вопрос.
  if (r.task_type != null && !TASK_TYPES.includes(r.task_type as never)) {
    r.task_type = "OTHER_RESEARCH";
  }
  // Таблица статусов — наше собственное механическое отображение маршрута,
  // а не суждение модели: маршрут-объяснение по определению READY.
  if (typeof r.route === "string" && EXPLANATION_ROUTES.includes(r.route)) {
    r.status = "READY";
  }
  // Симметрично: route=CLARIFICATION_REQUIRED по определению значит
  // NEEDS_CLARIFICATION (prompt.ts, раздел STATUS) — тот же механический
  // маппинг, что и для маршрутов-объяснений выше, просто раньше был
  // применён только в одну сторону. Живой прогон: модель верно выбрала
  // маршрут (нужен проект), но оставила status=READY — жёсткий отказ
  // схемы ("READY with CLARIFICATION_REQUIRED") ронял честный уточняющий
  // вопрос в 502 вместо показа пользователю.
  if (r.route === "CLARIFICATION_REQUIRED") {
    r.status = "NEEDS_CLARIFICATION";
  }
  // Объяснение без самого объяснения показывать нечего. Это не повод
  // отдать пользователю «сервис недоступен»: честный ответ здесь —
  // «не удалось выделить задачу» (живой прогон: бессмысленный ввод).
  if (
    typeof r.route === "string" &&
    EXPLANATION_ROUTES.includes(r.route) &&
    !(typeof r.quick_answer === "string" && r.quick_answer.trim())
  ) {
    r.route = "OUTSIDE_CURRENT_DOMAIN";
    r.status = "INVALID";
  }
  // quick_answer на OUTSIDE_CURRENT_DOMAIN — декоративное поле: продукт
  // показывает здесь свой фиксированный текст (dict.ask.outOfScope), а не
  // AI-текст (interpret.ts/toView() отдаёт quick_answer только на
  // QUICK_EXPLANATION/NO_RESEARCH_NEEDED). Модель нередко дописывает
  // «почему вне области» — это не решает поведение и не должно ронять
  // честно понятый запрос в 502 (регрессия: «Стоит ли покупать SUI
  // сейчас?» — маршрут определён верно, но лишнее объяснение било по
  // строгому контракту).
  //
  // НЕ распространяем это на DEEP_RESEARCH: там quick_answer рядом с
  // Proof запрещён намеренно и строго (LOCKED D-027, решение владельца
  // №1) — это canary на спутанный вывод модели на самом дорогом
  // маршруте, а не оформление, и его ослаблять нельзя.
  if (r.route === "OUTSIDE_CURRENT_DOMAIN" && r.quick_answer != null) {
    r.quick_answer = null;
  }
  r.route_reason = clamp(r.route_reason, 300);
  r.research_task = clamp(r.research_task, MAX_RESEARCH_TASK_CHARS);
  r.understood_summary = clamp(r.understood_summary, 300);
  r.clarification_question = clamp(r.clarification_question, MAX_CLARIFICATION_CHARS);
  r.quick_answer = clamp(r.quick_answer, MAX_QUICK_ANSWER_CHARS);
  for (const key of ["user_assumptions", "ambiguities", "related_entities"]) {
    const list = r[key];
    if (Array.isArray(list)) {
      const max = key === "related_entities" ? 120 : 200;
      r[key] = list.slice(0, MAX_LIST_ITEMS).map((v) => clamp(v, max));
    }
  }
  return r;
}

export function parseInterpreterResult(raw: unknown): InterpreterModelResult {
  const parsed = interpreterResultSchema.safeParse(normalizeModelOutput(raw));
  if (!parsed.success) {
    throw new InterpreterContractError(
      `schema: ${parsed.error.issues.map((i) => i.path.join(".")).join(",")}`,
    );
  }
  assertConsistent(parsed.data);
  return parsed.data;
}
