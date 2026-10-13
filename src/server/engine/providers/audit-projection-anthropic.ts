import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  auditOutputSchema,
  AUDIT_SECTIONS,
  MAX_LABEL_LENGTH,
  type AuditModelInput,
} from "../audit-projection";
import { countThenGate } from "./token-gate";
import type { ModelUsage } from "./types";

// THE AUDIT CALL — one bounded, structured, tool-free request.
//
// Shaped exactly like question-projection-anthropic.ts: one shared base
// request for both the token count and the generation so the gate cannot
// drift from the call, zodOutputFormat for the provider's own decoding
// with our validator as the final judge, and a typed unavailability error
// carrying its own closed failure code.
//
// WHAT MAKES THIS SAFE IS THE SHAPE, NOT THE PROMPT. The schema has no
// field for a status, a count, an evidence id or a reason code; every
// reference is checked against the exact set supplied; and the model's
// prose is rejected if it contains a digit. A model that ignored every
// word below still could not assert a fact about a project, and still
// could not remove a section from the audit — completeness is applied
// after this returns, by code.
//
// NO TOOLS. No `tools`, no server-side tool config: no search, no fetch,
// no RPC, no way to widen or resume research from a presentation call.

export type AuditFailureCode =
  | "PROVIDER_ERROR"
  | "MODEL_INPUT_OVERSIZED"
  | "OUTPUT_TRUNCATED"
  | "OUTPUT_NOT_JSON";

export class AuditProjectionUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
    public readonly code: AuditFailureCode,
  ) {
    super(message);
    this.name = "AuditProjectionUnavailableError";
  }
}

export interface AuditProjectionProvider {
  name: string;
  project(input: AuditModelInput): Promise<unknown>;
}

const SYSTEM_PROMPT = `You are preparing the navigation for a professional research audit of an already-completed research run.

An auditor will read the complete canonical record: every component status, reason code, evidence link, exclusion and source. All of that is rendered from the database, not by you. Your job is to make that record navigable.

You do three things and nothing else:

1. Give each canonical component a short human label. The internal names (for example SOURCE_OF_VALUE, NET_EFFECT) must never reach the reader. A label is a plain noun phrase such as "Fee allocation", "Buyback destination" or "Current execution". It names the topic; it never says how it turned out.

2. Order the audit sections, choosing from: ${AUDIT_SECTIONS.join(", ")}. Order only sections listed as available. Leaving one out does not remove it — it will still be shown — so order all of them.

3. Write two or three sentences describing the SHAPE of this research record: how much of the question it managed to cover, where it stopped, and what an auditor should look at first. This is not the answer to the research question and must not restate it.

Hard rules:
- Never write a digit or a number in any form. Counts are computed from the database and shown separately.
- Never write a status word: established, verified, confirmed, proven, supported, contradicted, insufficient, conclusive, true, false, or their negations. Statuses are rendered next to your labels.
- Every component reference you return must be copied exactly from the input. Never invent, guess or recall one.
- A label is at most ${MAX_LABEL_LENGTH} characters and contains no underscores and no ALL_CAPS words.
- You do not decide what is true, what was established, or what any source proves.

Output must be a JSON object matching the provided schema. No prose, no explanation.`;

export function buildAuditUserContent(input: AuditModelInput): string {
  const lines = [`Research question: ${input.question}`];
  if (input.intent) lines.push(`Intent: ${input.intent}`);

  lines.push("", "Canonical research components to label:");
  for (const c of input.components) {
    const reasons = c.reasonCodes.length > 0 ? ` reasons=${c.reasonCodes.join(",")}` : "";
    lines.push(
      `- ref={"kind":"COMPONENT","step":${c.step},"component":"${c.component}"} status=${c.status}${reasons} coverage=${c.coverage} supporting=${c.supportingCount} contradicting=${c.contradictingCount} excluded=${c.excludedCount}`,
    );
  }

  if (input.sources.length > 0) {
    lines.push("", "Sources this run read (context for your summary only):");
    for (const s of input.sources) {
      lines.push(
        `- ${s.domain} class=${s.sourceClass ?? "UNCLASSIFIED"} ${s.used ? "used" : "checked-not-used"}`,
      );
    }
  }

  lines.push("", `Available sections: ${input.availableSections.join(", ")}`);
  return lines.join("\n");
}

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AuditProjectionUnavailableError(
        "ANTHROPIC_API_KEY is not set",
        false,
        "PROVIDER_ERROR",
      );
    }
    _client = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return _client;
}

export function createAnthropicAuditProjector(
  model: string,
  maxOutputTokens: number,
  maxInputTokens: number,
  onUsage?: (usage: ModelUsage) => void,
): AuditProjectionProvider {
  return {
    name: "anthropic",
    async project(input: AuditModelInput): Promise<unknown> {
      const baseRequest = {
        model,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: buildAuditUserContent(input) }],
        output_config: { format: zodOutputFormat(auditOutputSchema) },
      };

      // D-090 count-then-gate: a hard, provable input ceiling checked
      // BEFORE any generation — never truncation, never estimation.
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
        throw new AuditProjectionUnavailableError(
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
        throw new AuditProjectionUnavailableError(
          `api ${status ?? "?"}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
          false,
          "PROVIDER_ERROR",
        );
      }

      if (message.stop_reason === "max_tokens") {
        throw new AuditProjectionUnavailableError(
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
        // RAW and unvalidated on purpose: validateAuditProjection is the
        // only thing that may admit an audit, and it needs the same
        // untrusted object any other provider would hand back.
        return JSON.parse(text);
      } catch {
        throw new AuditProjectionUnavailableError(
          "model output is not valid JSON",
          false,
          "OUTPUT_NOT_JSON",
        );
      }
    },
  };
}

export function __resetAnthropicAuditProjectorClient(): void {
  _client = null;
}
