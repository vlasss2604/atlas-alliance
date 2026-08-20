import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  InterpreterUnavailableError,
  type InterpreterCall,
  type InterpreterGateway,
  type InterpreterInput,
} from "./gateway";
import { buildUserContent, SYSTEM_PROMPT } from "./prompt";
import { interpreterResultSchema, parseInterpreterResult } from "./schema";

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
      message = await client().messages.parse({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(input) }],
        output_config: { format: zodOutputFormat(interpreterResultSchema) },
      });
    } catch (e) {
      throw new InterpreterUnavailableError(
        e instanceof Anthropic.APIError ? `api ${e.status}` : "api call failed",
        e,
      );
    }
    // parsed_output === null означает, что вывод не разобрался в схему —
    // для нас это тот же класс сбоя, что и сетевая ошибка.
    const result = parseInterpreterResult(message.parsed_output);
    return {
      result,
      meta: {
        gateway: "anthropic",
        model,
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
        latencyMs: Date.now() - startedAt,
      },
    };
  },
};

export function __resetAnthropicClient(): void {
  _client = null;
}
