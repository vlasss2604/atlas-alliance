import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  InterpreterUnavailableError,
  type InterpreterCall,
  type InterpreterGateway,
  type InterpreterInput,
} from "./gateway";
import { buildUserContent, SYSTEM_PROMPT } from "./prompt";
import {
  InterpreterContractError,
  interpreterResultSchema,
  parseInterpreterResult,
} from "./schema";

// Реализация ModelGateway поверх Anthropic Messages API.
// Один лёгкий вызов со structured output (канон atlas-intent: «не три
// агента»). Без extended thinking и без streaming — ответ короткий,
// схема цельная, важна скорость.

const MAX_TOKENS = 1024;

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new InterpreterUnavailableError("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey, maxRetries: 0 }); // повторы — уровнем выше
  }
  return _client;
}

export const anthropicGateway: InterpreterGateway = {
  name: "anthropic",
  async interpret(input: InterpreterInput, model: string): Promise<InterpreterCall> {
    const startedAt = Date.now();
    let message;
    try {
      // messages.create, а не messages.parse: SDK валидирует схему внутри
      // себя и падает раньше, чем мы успеваем поправить справочные поля
      // (нормализация в schema.ts). Схема всё равно передаётся модели как
      // output format — она ведёт декодирование, — но решение о годности
      // ответа принимает наш контракт.
      message = await client().messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(input) }],
        output_config: { format: zodOutputFormat(interpreterResultSchema) },
      });
    } catch (e) {
      // Причина обязана быть видна в логе: «api call failed» не позволяет
      // отличить перегрузку от неверного ключа (найдено живым прогоном).
      const status = e instanceof Anthropic.APIError ? e.status : undefined;
      const detail =
        e instanceof Anthropic.APIError
          ? `api ${status ?? "?"} ${e.name}: ${String(e.message).slice(0, 200)}`
          : `api call failed: ${e instanceof Error ? e.message : String(e)}`;
      const transient =
        status === 429 || status === undefined || (status >= 500 && status < 600);
      throw new InterpreterUnavailableError(detail, e, transient);
    }
    // Обрезание по лимиту токенов даёт невалидный JSON: это отдельный
    // класс сбоя, и в логе он должен называться своим именем.
    if (message.stop_reason === "max_tokens") {
      throw new InterpreterUnavailableError("model output truncated (max_tokens)");
    }
    // Вывод модели — текстовый JSON; невалидный JSON для нас тот же класс
    // сбоя, что и сетевая ошибка: ответа нет.
    const text = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new InterpreterUnavailableError("model output is not valid JSON");
    }
    const meta = {
      inputTokens: message.usage?.input_tokens ?? null,
      outputTokens: message.usage?.output_tokens ?? null,
      latencyMs: Date.now() - startedAt,
    };
    let result;
    try {
      result = parseInterpreterResult(raw);
    } catch (e) {
      // D-123: если это исчерпывающий (второй) вызов и ошибка окажется
      // rescuableScopeContradiction, callModel() (interpret.ts) сможет
      // пропустить кандидата дальше вместо 502 — но тогда его усечённая
      // аудиторская строка не должна терять реальный usage ИМЕННО этого,
      // провалившегося вызова (иначе rescue-строка осталась бы без
      // inputTokens/outputTokens, в отличие от любой обычной успешной).
      if (e instanceof InterpreterContractError) e.meta = meta;
      throw e;
    }
    return {
      result,
      meta: { gateway: "anthropic", model, ...meta },
    };
  },
};

export function __resetAnthropicClient(): void {
  _client = null;
}
