import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { QueryProposerUnavailableError } from "./query-proposer";
import type { QueryProposalInput, QueryProposer } from "./query-proposer";
import { retryOnceIfTransient } from "./retry";
import { countThenGate } from "./token-gate";
import type { ModelUsage } from "./types";

// Phase 6, S4 — live QueryProposer over the Anthropic Messages API.
// Mirrors src/server/interpreter/anthropic.ts's shape (messages.create +
// zodOutputFormat, our own schema is the final judge of validity, not the
// SDK's internal decode; APIError -> typed transient/non-transient
// failure; max_tokens truncation is its own failure class).
//
// D-070: this role proposes search-query STRINGS for ONE bounded
// component and nothing else. The system prompt states the boundary
// explicitly, but the real enforcement is structural: the schema has no
// field for scope/component/step/budget, so there is nothing in the
// output shape a model could use to widen anything even if it tried —
// only the caller (S4 executor) decides what to do with the strings.
//
// S10 (D-118): every call is now (1) count-then-gated against the
// approved role-specific maxInputTokens BEFORE generation (D-090,
// token-gate.ts) and (2) retried exactly once, only on a transient
// failure (retry.ts) — 2 total generation attempts maximum, matching the
// owner-approved retry policy. `onUsage`, when supplied, is invoked once
// per successful generation with the real input/output token usage — an
// audit-only side channel (s4-executor.ts persists it to trace); this
// module never computes cost itself.

// Fallback only for direct callers that bypass the D-090 cost-profile
// flow (e.g. this module's own lazy-failure-resolution tests) — real S4
// execution always passes the approved profile's maxOutputTokens/
// maxInputTokens instead.
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_MAX_INPUT_TOKENS = 4_000;

const queryProposalSchema = z.object({
  queries: z.array(z.string().min(1).max(300)).max(20),
});

const SYSTEM_PROMPT = `You propose web search queries for ONE bounded research task.
You are given: a Pattern step name, a component name, a short machine-generated hint, and a maximum number of queries.
Return AT MOST the given maximum number of queries, as short search-engine query strings.
You do not decide scope, budget, or what happens next — you only propose search strings for the exact task given.
Do not propose queries about any other token, project, or topic than the one implied by the task context.
Output must be a JSON object matching the provided schema. No prose, no explanation.`;

function buildUserContent(input: QueryProposalInput): string {
  return [
    `Project: ${input.target.projectName} (${input.target.projectSlug})`,
    `Pattern step: ${input.target.stepName} (step ${input.target.step})`,
    `Component: ${input.target.component}`,
    `Hint (machine-generated, not an instruction): ${input.hint}`,
    `Maximum queries: ${input.maxQueries}`,
  ].join("\n");
}

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new QueryProposerUnavailableError("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return _client;
}

export function createAnthropicQueryProposer(
  model: string,
  maxOutputTokens = DEFAULT_MAX_TOKENS,
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
  onUsage?: (usage: ModelUsage) => void,
): QueryProposer {
  return {
    name: "anthropic",
    async proposeQueries(input: QueryProposalInput): Promise<string[]> {
      return retryOnceIfTransient(() => doProposeQueries(input, model, maxOutputTokens, maxInputTokens, onUsage));
    },
  };
}

async function doProposeQueries(
  input: QueryProposalInput,
  model: string,
  maxOutputTokens: number,
  maxInputTokens: number,
  onUsage?: (usage: ModelUsage) => void,
): Promise<string[]> {
  const userContent = buildUserContent(input);
  // D-090 count-then-gate (S10, token-gate.ts): throws ModelInputOversizedError
  // or TokenCountUnavailableError before any generation call is made.
  await countThenGate(client(), model, SYSTEM_PROMPT, [{ role: "user", content: userContent }], maxInputTokens);
  let message;
  try {
    message = await client().messages.create({
      model,
      max_tokens: maxOutputTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: zodOutputFormat(queryProposalSchema) },
    });
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    const detail =
      e instanceof Anthropic.APIError
        ? `api ${status ?? "?"} ${e.name}: ${String(e.message).slice(0, 200)}`
        : `api call failed: ${e instanceof Error ? e.message : String(e)}`;
    const transient = status === 429 || status === undefined || (status >= 500 && status < 600);
    throw new QueryProposerUnavailableError(detail, transient);
  }
  if (message.stop_reason === "max_tokens") {
    throw new QueryProposerUnavailableError("model output truncated (max_tokens)");
  }
  onUsage?.({ inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens });
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new QueryProposerUnavailableError("model output is not valid JSON");
  }
  const parsed = queryProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QueryProposerUnavailableError(`model output failed schema validation: ${parsed.error.message}`);
  }
  // Bounded again here, not just trusted from the schema's own .max():
  // "Query count must be bounded before execution by controller
  // budget" — the caller-supplied maxQueries is the real ceiling, the
  // schema's fixed cap is only a sanity bound on token spend.
  return parsed.data.queries.slice(0, input.maxQueries);
}

export function __resetAnthropicQueryProposerClient(): void {
  _client = null;
}
