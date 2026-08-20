import { and, eq, sql } from "drizzle-orm";

import { HttpError } from "../auth/guards";
import { hitRateLimit } from "../auth/rate-limit";
import type { ProductConfig } from "../config/product";
import type { Database } from "../db/client";
import { interpretations, users } from "../db/schema";
import { evaluateGates, looseKey, type GateDecision } from "../services/gates";
import {
  InterpreterUnavailableError,
  resolveInterpreterGateway,
  type ClarificationTurn,
  type InterpreterInput,
  type ModelMeta,
} from "./gateway";
import {
  InterpreterContractError,
  type InterpreterModelResult,
  type InterpreterStatus,
} from "./schema";

// Лимиты ввода (phase-4-plan §5.5).
export const MAX_QUESTION_CHARS = 2000;
export const MAX_ANSWER_CHARS = 500;

// Rate limit интерпретаций: та же таблица и тот же механизм, что у auth
// (phase-2-plan §2.1) — защита бюджета от скриптового спама.
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 600;

// Максимум 2 уточнения (LOCKED §5): попытка 1 — исходный вопрос,
// попытки 2 и 3 — уточнения. CHECK в БД держит тот же предел.
export const MAX_ATTEMPT = 3;

// Серверная поправка к выводу модели. Модель предполагает — сервер решает
// (phase-4-plan §2.6): каталог проектов, а не LLM, определяет scope.
export type ServerAdjustment = "NONE" | "PROJECT_UNRESOLVED" | "PROJECT_AMBIGUOUS";

export interface StoredInterpretation extends InterpreterModelResult {
  project_slug: string | null;
  // Все сущности задачи после резолюции по каталогу (первая — основная).
  // Гейты проверяют каждую: половина сравнения — не сравнение.
  project_slugs: string[];
  server_adjustment: ServerAdjustment;
}

export interface InterpretationView {
  id: string;
  status: InterpreterStatus;
  attempt: number;
  route: string;
  adjustment: ServerAdjustment;
  clarificationQuestion: string | null;
  // Что уже понято, когда задача ещё не полна: экран уточнения показывает
  // понимание ДО вопроса — «Atlas разобрался», а не «Atlas классифицировал».
  provisionalTask: string | null;
  quickAnswer: string | null;
  understood: {
    // Человеческая формулировка — это то, что видит пользователь.
    summary: string;
    researchTask: string;
    projectSlug: string | null;
    projectOrAsset: string | null;
    taskType: string | null;
    assumptions: string[];
  } | null;
}

export interface GateView {
  scope: GateDecision["scope"];
  entitlement: GateDecision["entitlement"];
  research: GateDecision["research"];
  demo: GateDecision["demo"];
}

export interface InterpretResult {
  interpretation: InterpretationView;
  gates: GateView;
}

function requireEnabled(config: ProductConfig): void {
  if (!config.interpreter_enabled) throw new HttpError(403, "INTERPRETER_DISABLED");
}

function cleanText(value: unknown, max: number, code: string): string {
  if (typeof value !== "string") throw new HttpError(400, "BAD_REQUEST");
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "BAD_REQUEST");
  if (trimmed.length > max) throw new HttpError(400, code);
  return trimmed;
}

async function userLanguage(db: Database, userId: string): Promise<"RU" | "EN"> {
  const [u] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.id, userId));
  return u?.language === "RU" ? "RU" : "EN";
}

// Ровно один повтор (phase-4-plan §2.4). Второй сбой — честное 502:
// строка interpretation НЕ создаётся, сырой ввод никуда не передаётся.
async function callModel(
  input: InterpreterInput,
  model: string,
): Promise<{ result: InterpreterModelResult; meta: ModelMeta }> {
  const gateway = await resolveInterpreterGateway();
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const call = await gateway.interpret(input, model);
      return { result: call.result, meta: { ...call.meta, attempts: attempt } };
    } catch (e) {
      if (e instanceof InterpreterUnavailableError || e instanceof InterpreterContractError) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  console.error(
    "[interpreter] unavailable",
    lastError instanceof Error ? lastError.message : lastError,
  );
  throw new HttpError(502, "INTERPRETER_UNAVAILABLE");
}

// Резолюция проекта — детерминированный серверный код по каталогу
// (projects.slug/name/ticker + project_aliases), без учёта регистра
// и знаков. Модель не может «заявить» проект в scope.
export async function resolveProjectSlug(
  db: Database,
  freeText: string | null,
): Promise<{ slug: string | null; adjustment: ServerAdjustment; candidates: string[] }> {
  const miss = { slug: null, adjustment: "PROJECT_UNRESOLVED" as const, candidates: [] };
  if (!freeText?.trim()) return miss;
  const key = looseKey(freeText);
  if (!key) return miss;

  const rows = (
    await db.execute(sql`
      SELECT DISTINCT p.slug FROM projects p
      WHERE regexp_replace(lower(p.slug), '[^a-z0-9]', '', 'g') = ${key}
         OR regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = ${key}
         OR regexp_replace(lower(coalesce(p.ticker, '')), '[^a-z0-9]', '', 'g') = ${key}
      UNION
      SELECT DISTINCT p.slug FROM project_aliases a
      JOIN projects p ON p.id = a.project_id
      WHERE regexp_replace(lower(a.alias), '[^a-z0-9]', '', 'g') = ${key}
    `)
  ).rows as { slug: string }[];

  if (rows.length === 1) {
    return { slug: rows[0].slug, adjustment: "NONE", candidates: [rows[0].slug] };
  }
  // Несколько разных проектов под одним написанием — сервер не выбирает
  // за пользователя; спрашиваем, какой именно, и НАЗЫВАЕМ варианты,
  // иначе уточнение не может привести ни к какому ответу.
  if (rows.length > 1) {
    return {
      slug: null,
      adjustment: "PROJECT_AMBIGUOUS",
      candidates: rows.map((r) => r.slug),
    };
  }
  return miss;
}

// Резолюция ВСЕХ названных сущностей (основная + related_entities).
// Задача целиком доступна ровно тогда, когда доступна каждая её сущность.
async function resolveAllEntities(
  db: Database,
  result: InterpreterModelResult,
): Promise<{
  slug: string | null;
  slugs: string[];
  adjustment: ServerAdjustment;
  candidates: string[];
}> {
  const primary = await resolveProjectSlug(db, result.project_or_asset);
  const slugs: string[] = primary.slug ? [primary.slug] : [];
  let adjustment = primary.adjustment;
  let candidates = primary.candidates;

  for (const entity of result.related_entities) {
    const other = await resolveProjectSlug(db, entity);
    if (other.slug) {
      if (!slugs.includes(other.slug)) slugs.push(other.slug);
      continue;
    }
    // Нерезолвенная вторая сущность делает недоступной всю задачу:
    // «сравню Pump.fun, а второй проект не буду» — это уже не сравнение.
    if (adjustment === "NONE") {
      adjustment = other.adjustment;
      candidates = other.candidates;
    }
  }
  return { slug: primary.slug, slugs, adjustment, candidates };
}

// Применение серверных решений к выводу модели. Сохранённая строка обязана
// оставаться самосогласованной: статус и маршрут понижаются вместе, иначе
// в журнале LOCKED §5 оседает комбинация, которую схема не допускает
// (adversarial review, LOW-4).
function applyServerDecisions(
  result: InterpreterModelResult,
  resolution: {
    slug: string | null;
    slugs: string[];
    adjustment: ServerAdjustment;
    candidates: string[];
  },
  language: "RU" | "EN",
): { stored: StoredInterpretation; status: InterpreterStatus } {
  const stored: StoredInterpretation = {
    ...result,
    project_slug: resolution.slug,
    project_slugs: resolution.slugs,
    server_adjustment: resolution.adjustment,
  };
  let status = result.status;

  // Понижение статуса — только для маршрута, который может привести
  // к исследованию. QUICK_EXPLANATION / NO_RESEARCH_NEEDED проекта
  // в каталоге не требуют: они и не запускают Proof.
  const allResolved =
    !!resolution.slug && resolution.slugs.length === result.related_entities.length + 1;
  if (status === "READY" && result.route === "DEEP_RESEARCH" && !allResolved) {
    if (resolution.adjustment === "PROJECT_AMBIGUOUS") {
      status = "NEEDS_CLARIFICATION";
      stored.route = "CLARIFICATION_REQUIRED";
      // Вопрос от сервера, а не от модели: без названных вариантов
      // уточнение не может привести ни к какому ответу.
      stored.clarification_question = ambiguityQuestion(resolution.candidates, language);
    } else {
      status = "OUT_OF_SCOPE";
      stored.route = "OUTSIDE_CURRENT_DOMAIN";
    }
    stored.status = status;
  }
  return { stored, status };
}

// Серверная копия — не текст модели. Финальное утверждение — за владельцем.
function ambiguityQuestion(candidates: string[], language: "RU" | "EN"): string {
  const list = candidates.join(", ");
  return language === "RU"
    ? `Под этим названием у нас несколько проектов: ${list}. О каком из них речь?`
    : `Several projects match that name: ${list}. Which one do you mean?`;
}

function toView(row: {
  id: string;
  status: InterpreterStatus;
  attempt: number;
  result: StoredInterpretation;
}): InterpretationView {
  const r = row.result;
  return {
    id: row.id,
    status: row.status,
    attempt: row.attempt,
    route: r.route,
    adjustment: r.server_adjustment,
    clarificationQuestion:
      row.status === "NEEDS_CLARIFICATION" ? r.clarification_question : null,
    provisionalTask:
      row.status === "NEEDS_CLARIFICATION" ? (r.understood_summary?.trim() || null) : null,
    quickAnswer:
      r.route === "QUICK_EXPLANATION" || r.route === "NO_RESEARCH_NEEDED"
        ? r.quick_answer
        : null,
    understood:
      row.status === "READY" && r.research_task
        ? {
            // Показываем человеческую формулировку; research_task —
            // внутренний вход движка, он наружу не идёт.
            summary: r.understood_summary?.trim() || r.research_task,
            researchTask: r.research_task,
            projectSlug: r.project_slug,
            projectOrAsset: r.project_or_asset,
            taskType: r.task_type,
            assumptions: r.user_assumptions,
          }
        : null,
  };
}

async function gatesFor(
  db: Database,
  config: ProductConfig,
  userId: string,
  status: InterpreterStatus,
  stored: StoredInterpretation,
): Promise<GateView> {
  const decision = await evaluateGates(db, config, {
    userId,
    status,
    route: stored.route,
    projectSlugs: stored.project_slugs,
  });
  return {
    scope: decision.scope,
    entitlement: decision.entitlement,
    research: decision.research,
    demo: decision.demo,
  };
}

export async function createInterpretation(
  db: Database,
  config: ProductConfig,
  input: { userId: string; question: unknown },
): Promise<InterpretResult> {
  requireEnabled(config);
  const question = cleanText(input.question, MAX_QUESTION_CHARS, "QUESTION_TOO_LONG");
  await hitRateLimit(db, `interp:${input.userId}`, RATE_LIMIT, RATE_WINDOW_SEC);

  const language = await userLanguage(db, input.userId);
  const { result, meta } = await callModel(
    { question, clarificationTurns: [], language },
    config.interpreter_model,
  );

  const resolution = await resolveAllEntities(db, result);
  const { stored, status } = applyServerDecisions(result, resolution, language);

  const [row] = await db
    .insert(interpretations)
    .values({
      userId: input.userId,
      // Оригинал хранится verbatim: цепочка Original Question → Interpreter
      // Result → Proof (LOCKED §5) не должна зависеть от вывода модели.
      originalQuestion: question,
      status,
      attempt: 1,
      result: stored,
      modelMeta: meta,
    })
    .returning({ id: interpretations.id });

  return {
    interpretation: toView({ id: row.id, status, attempt: 1, result: stored }),
    gates: await gatesFor(db, config, input.userId, status, stored),
  };
}

export async function clarifyInterpretation(
  db: Database,
  config: ProductConfig,
  input: { userId: string; parentId: string; answer: unknown },
): Promise<InterpretResult> {
  requireEnabled(config);
  const answer = cleanText(input.answer, MAX_ANSWER_CHARS, "ANSWER_TOO_LONG");

  const [parent] = await db
    .select()
    .from(interpretations)
    .where(
      and(
        eq(interpretations.id, input.parentId),
        eq(interpretations.userId, input.userId),
      ),
    );
  if (!parent) throw new HttpError(404, "NOT_FOUND");
  if (parent.status !== "NEEDS_CLARIFICATION") {
    throw new HttpError(409, "CLARIFICATION_NOT_EXPECTED");
  }
  if (parent.attempt >= MAX_ATTEMPT) {
    // Вторая неудачная попытка — конец flow (канон atlas-intent).
    throw new HttpError(409, "CLARIFICATION_LIMIT");
  }
  // Дешёвая проверка ДО платного вызова модели: двойное нажатие и вторая
  // вкладка не должны оплачивать вызов, который БД всё равно отвергнет
  // (adversarial review, LOW-6). Настоящий барьер — уникальный индекс ниже.
  const [existingChild] = await db
    .select({ id: interpretations.id })
    .from(interpretations)
    .where(eq(interpretations.parentId, parent.id));
  if (existingChild) throw new HttpError(409, "CLARIFICATION_ALREADY_ANSWERED");

  await hitRateLimit(db, `interp:${input.userId}`, RATE_LIMIT, RATE_WINDOW_SEC);

  // Цепочка предыдущих уточнений — вход модели; всё как данные.
  const turns: ClarificationTurn[] = [];
  const chain: typeof parent[] = [parent];
  let cursor = parent;
  while (cursor.parentId) {
    const [prev] = await db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, cursor.parentId));
    if (!prev) break;
    chain.unshift(prev);
    cursor = prev;
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    const asked = (chain[i].result as StoredInterpretation | null)?.clarification_question;
    const answered = chain[i + 1].clarificationAnswer;
    if (asked && answered) turns.push({ question: asked, answer: answered });
  }
  // Ответ пользователя передаётся модели ВСЕГДА, даже если вопрос задал
  // сервер и текста вопроса в строке модели нет: иначе вход повторного
  // вызова совпадает с предыдущим и уточнение не может ничего изменить
  // (adversarial review, MEDIUM-3).
  const parentQuestion = (parent.result as StoredInterpretation | null)
    ?.clarification_question;
  turns.push({
    question: parentQuestion ?? "Which project or asset do you mean?",
    answer,
  });

  const language = await userLanguage(db, input.userId);
  const { result, meta } = await callModel(
    { question: chain[0].originalQuestion, clarificationTurns: turns, language },
    config.interpreter_model,
  );

  const resolution = await resolveAllEntities(db, result);
  const { stored, status } = applyServerDecisions(result, resolution, language);

  const attempt = parent.attempt + 1;
  let row: { id: string } | undefined;
  try {
    [row] = await db
      .insert(interpretations)
      .values({
        userId: input.userId,
        parentId: parent.id,
        originalQuestion: chain[0].originalQuestion,
        clarificationAnswer: answer,
        status,
        attempt,
        result: stored,
        modelMeta: meta,
      })
      .returning({ id: interpretations.id });
  } catch (e) {
    // Гонка двойного clarify: частичный уникальный индекс пропустит
    // ровно одного ребёнка (DoD-4).
    const constraint = (e as { cause?: { constraint?: string } }).cause?.constraint;
    if (constraint === "uq_interpretations_one_child") {
      throw new HttpError(409, "CLARIFICATION_ALREADY_ANSWERED");
    }
    throw e;
  }

  return {
    interpretation: toView({ id: row!.id, status, attempt, result: stored }),
    gates: await gatesFor(db, config, input.userId, status, stored),
  };
}
