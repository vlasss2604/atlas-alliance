import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  projectionOutputSchema,
  MAX_FINDINGS,
  MIN_FINDINGS,
  type ProjectionModelInput,
} from "../question-projection";
import { countThenGate } from "./token-gate";
import type { ModelUsage } from "./types";

// THE PROJECTION CALL — one bounded, structured, tool-free request.
//
// Deliberately shaped like query-proposer-anthropic.ts: one shared base
// request used for BOTH the token count and the generation, so the gate
// and the call cannot drift apart; zodOutputFormat for the provider's own
// decoding, with our schema as the final judge; a typed unavailability
// error carrying transience so the caller decides policy.
//
// WHAT MAKES THIS SAFE IS THE SHAPE, NOT THE PROMPT.
//
// The system prompt below tells the model it is not deciding truth. That
// is worth saying, but it is not what enforces it. What enforces it is
// that the output schema has no field for a status, a fact, an evidence
// id or a reason code, and that every reference it returns is checked
// against the exact set it was given. A model that ignored every word of
// this prompt still could not assert anything about a project.
//
// NO TOOLS. This provider passes no `tools` and no server-side tool
// config, so there is no search, no fetch, no RPC and no way to widen the
// research. It sees a compact status summary and returns pointers.

export type ProjectionFailureCode =
  | "PROVIDER_ERROR"
  | "MODEL_INPUT_OVERSIZED"
  | "OUTPUT_TRUNCATED"
  | "OUTPUT_NOT_JSON";

export class QuestionProjectionUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
    public readonly code: ProjectionFailureCode,
  ) {
    super(message);
    this.name = "QuestionProjectionUnavailableError";
  }
}

export interface QuestionProjectionProvider {
  name: string;
  project(input: ProjectionModelInput): Promise<unknown>;
}

const SYSTEM_PROMPT = `You organise an already-completed research result around the question a person actually asked.

You are given the question, and a compact summary of canonical research findings. Each finding is identified by a stable reference and carries a status that was decided by the research engine.

Your ONLY job is to choose which findings matter for answering THIS question, order them, and give each a short label in ordinary words.

You do NOT decide what is true. You do NOT decide any status. You do not have, and will not be given, the evidence itself.

Rules:
- Return between ${MIN_FINDINGS} and ${MAX_FINDINGS} findings.
- Every reference you return MUST be copied exactly from the input. Never invent, guess or recall a reference.
- Choose a finding because it materially helps answer the question, not because it appears in the input.
- INCLUDE findings whose status is unresolved, partial or contradicted when they matter to the question. Where the evidence stops is often the most important part of an answer. Do not select only established findings.
- A label is a short question or noun phrase a non-expert understands, for example "Where does the bought-back token go?" or "Is the mechanism running now?".
- A label must NOT contain a status word and must NOT assert anything. Never write "established", "verified", "supported", "confirmed", "proven" or their negations. The status is displayed separately and is not yours to state.
- Use the person's own framing where the input supports it. Do not use internal component names.
- primaryRef is the single canonical finding the row is about. supportingRefs are other input references that belong under the same row.

Output must be a JSON object matching the provided schema. No prose, no explanation.`;

export function buildProjectionUserContent(input: ProjectionModelInput): string {
  const lines = [`Question: ${input.question}`];
  if (input.intent) lines.push(`Intent: ${input.intent}`);

  if (input.requirements.length > 0) {
    lines.push("", "Requirements this question's intent asked the engine to settle:");
    for (const r of input.requirements) {
      lines.push(
        `- ref={"kind":"REQUIREMENT","requirementId":"${r.requirementId}"} kind=${r.kind} status=${r.status} evidence=${r.evidenceCount}`,
      );
    }
  }

  lines.push("", "Canonical research findings:");
  for (const c of input.components) {
    const reasons = c.reasonCodes.length > 0 ? ` reasons=${c.reasonCodes.join(",")}` : "";
    lines.push(
      `- ref={"kind":"COMPONENT","step":${c.step},"component":"${c.component}"} status=${c.status}${reasons} coverage=${c.coverage} evidence=${c.evidenceCount}`,
    );
  }
  return lines.join("\n");
}

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new QuestionProjectionUnavailableError(
        "ANTHROPIC_API_KEY is not set",
        false,
        "PROVIDER_ERROR",
      );
    }
    _client = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return _client;
}

export function createAnthropicQuestionProjector(
  model: string,
  maxOutputTokens: number,
  maxInputTokens: number,
  onUsage?: (usage: ModelUsage) => void,
): QuestionProjectionProvider {
  return {
    name: "anthropic",
    async project(input: ProjectionModelInput): Promise<unknown> {
      const baseRequest = {
        model,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: buildProjectionUserContent(input) }],
        output_config: { format: zodOutputFormat(projectionOutputSchema) },
      };

      // D-090 count-then-gate: a hard, provable input ceiling checked
      // BEFORE any generation, never truncation or estimation.
      try {
        await countThenGate(
          client(),
          baseRequest.model,
          baseRequest.system,
          baseRequest.messages,
          baseRequest.output_config,
          maxInputTokens,
        );
      } catch (e) {
        throw new QuestionProjectionUnavailableError(
          `input gate: ${e instanceof Error ? e.message : String(e)}`,
          false,
          "MODEL_INPUT_OVERSIZED",
        );
      }

      let message;
      try {
        message = await client().messages.create({ ...baseRequest, max_tokens: maxOutputTokens });
      } catch (e) {
        const status = e instanceof Anthropic.APIError ? e.status : undefined;
        throw new QuestionProjectionUnavailableError(
          `api ${status ?? "?"}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
          false,
          "PROVIDER_ERROR",
        );
      }

      if (message.stop_reason === "max_tokens") {
        throw new QuestionProjectionUnavailableError(
          "model output truncated (max_tokens)",
          false,
          "OUTPUT_TRUNCATED",
        );
      }

      const unsupportedBillingUsage =
        (message.usage.cache_creation_input_tokens ?? 0) > 0 ||
        (message.usage.cache_read_input_tokens ?? 0) > 0;
      onUsage?.({
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        unsupportedBillingUsage,
      });

      const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      try {
        // Returned RAW and unvalidated on purpose. The deterministic
        // validator in question-projection.ts is the only thing that may
        // admit a projection, and it needs the same untrusted object a
        // caller would get from any other provider.
        return JSON.parse(text);
      } catch {
        throw new QuestionProjectionUnavailableError(
          "model output is not valid JSON",
          false,
          "OUTPUT_NOT_JSON",
        );
      }
    },
  };
}

export function __resetAnthropicQuestionProjectorClient(): void {
  _client = null;
}
