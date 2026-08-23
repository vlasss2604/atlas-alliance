import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6, S4 final implementation (D-090, phase-6-plan.md §5.6) —
// cost-profile arithmetic and the "maxOutputTokens actually reaches the
// provider call" wiring. No live credentials used: the Anthropic SDK
// class itself is mocked so this test proves the REQUEST SHAPE this
// codebase builds, not anything about the real API.
//
// S4 FINAL ACCEPTANCE FIX: the production cost-profile catalogue is
// intentionally EMPTY until S10 (see model-cost-profile.ts's module
// comment) — there is no mathematically honest hard bound on model INPUT
// in this codebase today, and a chars/token heuristic is not one either.
// loadModelCostProfile() therefore fails closed for EVERY model id,
// production included. Fixture ModelCostProfile object literals used
// below (arbitrary numbers, never "claude-haiku-4-5") prove arithmetic
// and wiring only — they never claim anything about real Anthropic
// billing safety (item 4's TEST/FIXTURE vs OWNER-APPROVED PRODUCTION
// distinction).

import { ModelCostProfileMissingError, calculateMaxAuthorizedCostMicro, loadModelCostProfile } from "../src/server/engine/model-cost-profile";

describe("Фаза 6, S4 — D-090: production cost profile catalogue — EMPTY до S10 (fail closed)", () => {
  it("loadModelCostProfile: ЛЮБАЯ модель, включая claude-haiku-4-5, -> ModelCostProfileMissingError", () => {
    for (const modelId of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "some-model-nobody-approved"]) {
      expect(() => loadModelCostProfile(modelId)).toThrow(ModelCostProfileMissingError);
    }
  });

  it("ModelCostProfileMissingError несёт modelId и MODEL_COST_PROFILE_MISSING в сообщении", () => {
    try {
      loadModelCostProfile("claude-haiku-4-5");
      throw new Error("expected loadModelCostProfile to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelCostProfileMissingError);
      expect((e as ModelCostProfileMissingError).message).toContain("MODEL_COST_PROFILE_MISSING");
      expect((e as ModelCostProfileMissingError).modelId).toBe("claude-haiku-4-5");
    }
  });
});

describe("Фаза 6, S4 — D-090: calculateMaxAuthorizedCostMicro — чистая арифметика (FIXTURE-профили, не production)", () => {
  it("точная целочисленная формула maxInput*inputPrice + maxOutput*outputPrice", () => {
    const profile = {
      modelId: "fixture-test-model",
      inputPriceMicroUsdPerToken: 3,
      outputPriceMicroUsdPerToken: 7,
      maxInputTokens: 1000,
      maxOutputTokens: 200,
      priceVersion: "test",
    };
    expect(calculateMaxAuthorizedCostMicro(profile)).toBe(1000 * 3 + 200 * 7);
  });

  it("реальный профиль никогда не занижает (round upward) — boundary при простых числах", () => {
    // A profile whose prices don't divide evenly into a round number —
    // this is the case D-090 explicitly warns about ("avoid floating
    // point money errors"). Integer arithmetic here means there is no
    // fractional remainder to accidentally round down in the first place.
    const profile = {
      modelId: "fixture-test-model-odd",
      inputPriceMicroUsdPerToken: 7,
      outputPriceMicroUsdPerToken: 11,
      maxInputTokens: 333,
      maxOutputTokens: 97,
      priceVersion: "test",
    };
    const expected = 333 * 7 + 97 * 11;
    expect(calculateMaxAuthorizedCostMicro(profile)).toBe(expected);
    expect(Number.isInteger(calculateMaxAuthorizedCostMicro(profile))).toBe(true);
  });
});

// --- wiring: an approved profile's maxOutputTokens actually reaches the
// provider's max_tokens field, at the direct createAnthropicX() unit
// level. The Anthropic SDK class is mocked (no live credentials, no
// network) — this proves the request THIS CODEBASE builds, not anything
// about the real API. See phase6-s4-executor.test.ts's D-090 suite (item
// 12.B) for the SAME property proven through the real executor path
// (cost profile -> executor -> resolver -> provider request), which this
// unit-level test alone does not cover.
const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock };
    static APIError = class extends Error {};
  }
  return { default: FakeAnthropic };
});

vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: () => ({ type: "json_schema" }),
}));

describe("Фаза 6, S4 — D-090: maxOutputTokens доходит до провайдерского вызова (unit-level createAnthropicX)", () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    createMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("createAnthropicQueryProposer(model, maxOutputTokens) -> messages.create() получает ТОТ ЖЕ max_tokens", async () => {
    vi.resetModules();
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ queries: ["q1"] }) }],
    });
    const { createAnthropicQueryProposer, __resetAnthropicQueryProposerClient } = await import(
      "../src/server/engine/providers/query-proposer-anthropic"
    );
    __resetAnthropicQueryProposerClient();
    const proposer = createAnthropicQueryProposer("claude-haiku-4-5", 777);
    await proposer.proposeQueries({
      target: { step: 1, stepName: "S", component: "C", projectId: "p", projectName: "Proj", projectSlug: "proj" },
      hint: "h",
      maxQueries: 3,
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].max_tokens).toBe(777);
  });

  it("createAnthropicEvidenceExtractor(model, maxOutputTokens) -> messages.create() получает ТОТ ЖЕ max_tokens", async () => {
    vi.resetModules();
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ facts: [] }) }],
    });
    const { createAnthropicEvidenceExtractor, __resetAnthropicEvidenceExtractorClient } = await import(
      "../src/server/engine/providers/evidence-extractor-anthropic"
    );
    __resetAnthropicEvidenceExtractorClient();
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 444);
    await extractor.extract({
      target: { step: 1, stepName: "S", component: "C", projectId: "p", projectName: "Proj", projectSlug: "proj" },
      document: {
        finalUrl: "https://example.com/doc",
        requestedUrl: "https://example.com/doc",
        httpStatus: 200,
        contentType: "text/html",
        normalizedText: "some visible text",
        contentHash: "sha256:x",
        fetchedAt: new Date("2026-08-22T00:00:00Z"),
        byteLength: 10,
      },
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].max_tokens).toBe(444);
  });
});
