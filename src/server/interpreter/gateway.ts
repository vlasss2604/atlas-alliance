import type { InterpreterModelResult } from "./schema";

// AI abstraction layer (02_ARCHITECTURE Часть 2 §4: «ARI не привязан к одной
// AI-модели»). Весь прикладной код Interpreter работает с этим интерфейсом;
// конкретный провайдер подменяется одной переменной окружения.

export interface ClarificationTurn {
  question: string;
  answer: string;
}

export interface InterpreterInput {
  question: string;
  clarificationTurns: ClarificationTurn[];
  language: "RU" | "EN";
  // Чем именно был плох предыдущий ответ модели. Повтор с тем же входом
  // даёт тот же результат, поэтому на второй попытке нарушение контракта
  // передаётся явно (найдено живым прогоном: пропущенный understood_summary).
  contractViolation?: string;
}

export interface ModelMeta {
  gateway: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  attempts: number; // 1 = с первого раза, 2 = после одного повтора
}

export interface InterpreterCall {
  result: InterpreterModelResult;
  meta: Omit<ModelMeta, "attempts">;
}

export interface InterpreterGateway {
  readonly name: string;
  interpret(input: InterpreterInput, model: string): Promise<InterpreterCall>;
}

// Инфраструктурный сбой провайдера (сеть, 5xx, невалидный по схеме ответ).
// Отличается от INVALID: INVALID — валидный вывод модели о вводе,
// это — отсутствие вывода вообще.
export class InterpreterUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    // Перегрузка провайдера (429/5xx) проходит сама: повтор с паузой имеет
    // смысл. Неверный ключ или битый запрос — нет (живой прогон: 529).
    public readonly transient = false,
  ) {
    super(message);
    this.name = "InterpreterUnavailableError";
  }
}

let _override: InterpreterGateway | null = null;

// Только для тестов: подмена gateway без переменных окружения.
export function __setInterpreterGateway(g: InterpreterGateway | null): void {
  _override = g;
}

export async function resolveInterpreterGateway(): Promise<InterpreterGateway> {
  if (_override) return _override;
  const kind = process.env.MODEL_GATEWAY ?? "anthropic";
  if (kind === "fake") {
    // Фейковый провайдер в production запрещён (как dev-bypass Фазы 2):
    // «подставим ответ, если API недоступен» — это обход, а не тестовая среда.
    if (process.env.NODE_ENV === "production") {
      throw new Error("MODEL_GATEWAY=fake is forbidden in production");
    }
    const { fakeGateway } = await import("./fake");
    return fakeGateway;
  }
  const { anthropicGateway } = await import("./anthropic");
  return anthropicGateway;
}
