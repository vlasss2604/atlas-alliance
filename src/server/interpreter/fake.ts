import {
  InterpreterUnavailableError,
  type InterpreterCall,
  type InterpreterGateway,
  type InterpreterInput,
} from "./gateway";
import { parseInterpreterResult, type InterpreterModelResult } from "./schema";

// Детерминированный gateway для тестов/dev/CI без API-ключа.
// Это НЕ «подставим ответ, если API недоступен»: реализация выбирается
// явным MODEL_GATEWAY=fake и запрещена в production (gateway.ts).
// Контракт тот же: результат проходит ту же валидацию схемы.

type Script = (input: InterpreterInput) => unknown;

const scripts: Script[] = [];

// Тестовый сценарий на один вызов: очередь ответов «как если бы модель
// вернула вот это» — включая заведомо испорченные, чтобы проверить,
// что сервер их не пропускает.
export function __pushFakeScript(s: Script): void {
  scripts.push(s);
}

export function __clearFakeScripts(): void {
  scripts.length = 0;
}

let failOnce = 0;

// Имитация инфраструктурного сбоя провайдера (для теста retry-политики).
export function __failNextCalls(n: number): void {
  failOnce = n;
}

// Каноническое имя → написания, которые встречаются в вопросах.
const KNOWN_ASSETS: Record<string, string[]> = {
  "Pump.fun": ["pump\\.fun", "pumpfun", "pump fun", "pump_fun"],
  Hyperliquid: ["hyperliquid"],
  Uniswap: ["uniswap"],
  Aave: ["aave"],
  SUI: ["sui"],
  TAO: ["tao"],
  Bitcoin: ["bitcoin"],
};

const base = (): InterpreterModelResult => ({
  status: "INVALID",
  project_or_asset: null,
  related_entities: [],
  topic: null,
  task_type: null,
  research_task: null,
  understood_summary: null,
  user_assumptions: [],
  ambiguities: [],
  clarification_question: null,
  route: "OUTSIDE_CURRENT_DOMAIN",
  normalized_intent: "UNKNOWN",
  intent_confidence: 0.2,
  route_reason: "fake gateway",
  needs_fresh_evidence: false,
  quick_answer: null,
});

// Все названные сущности в порядке появления: сравнение обязано
// донести до сервера обе стороны, а не только первую.
function findAssets(text: string): string[] {
  const lower = text.toLowerCase();
  const found: { name: string; at: number }[] = [];
  for (const [canonical, variants] of Object.entries(KNOWN_ASSETS)) {
    let earliest = -1;
    for (const v of variants) {
      const m = new RegExp(`\\b${v}\\b`).exec(lower);
      if (m && (earliest < 0 || m.index < earliest)) earliest = m.index;
    }
    if (earliest >= 0) found.push({ name: canonical, at: earliest });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

function findAsset(text: string): string | null {
  return findAssets(text)[0] ?? null;
}

function decide(input: InterpreterInput): InterpreterModelResult {
  const all = [
    input.question,
    ...input.clarificationTurns.map((t) => t.answer),
  ].join(" ");
  const lower = all.toLowerCase();
  const r = base();

  if (/ignore (all )?previous|system prompt|you are now|act as/i.test(lower)) {
    return { ...r, route_reason: "no research task in instruction-like input" };
  }
  if (all.trim().length < 3 || !/[a-zа-я]/i.test(all)) {
    return { ...r, route_reason: "no meaningful content" };
  }
  if (/(луне|moon).*(интернет|internet)|(интернет|internet).*(луне|moon)/.test(lower)) {
    return {
      ...r,
      status: "READY",
      route: "NO_RESEARCH_NEEDED",
      project_or_asset: findAsset(all),
      task_type: "OTHER_RESEARCH",
      research_task: "No established causal link to research.",
      understood_summary: "Вы спрашиваете о событии, которое не связано с этим токеном.",
      normalized_intent: "SCENARIO_CAUSAL_IMPACT",
      intent_confidence: 0.9,
      route_reason: "no established causal link",
      quick_answer: "Такой связи не существует — исследовать здесь нечего.",
    };
  }
  if (/staking|стейкинг/.test(lower) && /(safe|безопас|надёж|надеж)/.test(lower)) {
    return {
      ...r,
      status: "READY",
      route: "QUICK_EXPLANATION",
      project_or_asset: findAsset(all),
      topic: "Token Value Capture",
      task_type: "EXPLANATION",
      research_task: "Explain the category difference between staking and safety.",
      understood_summary: "Вы хотите понять, говорит ли наличие стейкинга о надёжности проекта.",
      normalized_intent: "TOKEN_UTILITY",
      intent_confidence: 0.8,
      route_reason: "category mistake",
      quick_answer:
        "Наличие стейкинга не говорит о безопасности проекта: это разные категории.",
    };
  }
  if (/(погод|weather|футбол|football|рецепт)/.test(lower)) {
    return {
      ...r,
      status: "OUT_OF_SCOPE",
      route: "OUTSIDE_CURRENT_DOMAIN",
      route_reason: "outside Token Value Capture",
    };
  }

  const assets = findAssets(all);
  const asset = assets[0] ?? null;
  if (!asset) {
    return {
      ...r,
      status: "NEEDS_CLARIFICATION",
      route: "CLARIFICATION_REQUIRED",
      topic: "Token Value Capture",
      ambiguities: ["project is not named"],
      understood_summary:
        "Вы хотите понять, создаёт ли проект реальную экономическую ценность и доходит ли она до держателей токена.",
      clarification_question: "О каком проекте или токене идёт речь?",
      normalized_intent: "UNKNOWN",
      intent_confidence: 0.4,
      route_reason: "project not named",
    };
  }

  const related = assets.slice(1);
  const isComparison =
    related.length > 0 && /(сравн|compare|vs\b|против)/.test(lower);
  return {
    ...r,
    status: "READY",
    route: "DEEP_RESEARCH",
    project_or_asset: asset,
    related_entities: related,
    topic: "Token Value Capture",
    task_type: isComparison ? "COMPARISON" : "TOKEN_VALUE",
    research_task: isComparison
      ? `Compare how value reaches token holders across ${assets.join(" and ")}.`
      : `Determine whether and how value generated by ${asset} reaches token holders.`,
    understood_summary: isComparison
      ? `Вы хотите сравнить, как ценность доходит до держателей токена: ${assets.join(" и ")}.`
      : `Вы хотите понять, доходит ли ценность, которую создаёт ${asset}, до держателей токена.`,
    user_assumptions: /зарабатыва|revenue|доход/.test(lower)
      ? ["the project generates revenue"]
      : [],
    normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN",
    intent_confidence: 0.85,
    route_reason: "mechanism question within the trained domain",
    needs_fresh_evidence: true,
  };
}

export const fakeGateway: InterpreterGateway = {
  name: "fake",
  async interpret(input: InterpreterInput, model: string): Promise<InterpreterCall> {
    if (failOnce > 0) {
      failOnce -= 1;
      throw new InterpreterUnavailableError("fake failure");
    }
    const script = scripts.shift();
    const raw = script ? script(input) : decide(input);
    return {
      result: parseInterpreterResult(raw),
      meta: {
        gateway: "fake",
        model,
        inputTokens: null,
        outputTokens: null,
        latencyMs: 0,
      },
    };
  },
};
