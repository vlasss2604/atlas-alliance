import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6, S4 final implementation (D-090, phase-6-plan.md §5.6) —
// cost-profile arithmetic and the "bounded output actually reaches the
// provider call" wiring. No live credentials used: the Anthropic SDK
// class itself is mocked so this test proves the REQUEST SHAPE this
// codebase builds, not anything about the real API.

import {
  ModelCostProfileMissingError,
  boundInputText,
  calculateMaxAuthorizedCostMicro,
  loadModelCostProfile,
  maxInputCharsFor,
} from "../src/server/engine/model-cost-profile";

describe("Фаза 6, S4 — D-090: model-cost-profile арифметика", () => {
  it("loadModelCostProfile: известная модель -> профиль с положительными полями", () => {
    const profile = loadModelCostProfile("claude-haiku-4-5");
    expect(profile.modelId).toBe("claude-haiku-4-5");
    expect(profile.maxInputTokens).toBeGreaterThan(0);
    expect(profile.maxOutputTokens).toBeGreaterThan(0);
    expect(profile.inputPriceMicroUsdPerToken).toBeGreaterThan(0);
    expect(profile.outputPriceMicroUsdPerToken).toBeGreaterThan(0);
  });

  it("loadModelCostProfile: неизвестная модель -> ModelCostProfileMissingError (fail closed)", () => {
    expect(() => loadModelCostProfile("some-model-nobody-approved")).toThrow(ModelCostProfileMissingError);
    try {
      loadModelCostProfile("some-model-nobody-approved");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelCostProfileMissingError);
      expect((e as ModelCostProfileMissingError).message).toContain("MODEL_COST_PROFILE_MISSING");
      expect((e as ModelCostProfileMissingError).modelId).toBe("some-model-nobody-approved");
    }
  });

  it("calculateMaxAuthorizedCostMicro: точная целочисленная формула maxInput*inputPrice + maxOutput*outputPrice", () => {
    const profile = {
      modelId: "test-model",
      inputPriceMicroUsdPerToken: 3,
      outputPriceMicroUsdPerToken: 7,
      maxInputTokens: 1000,
      maxOutputTokens: 200,
      priceVersion: "test",
    };
    expect(calculateMaxAuthorizedCostMicro(profile)).toBe(1000 * 3 + 200 * 7);
  });

  it("calculateMaxAuthorizedCostMicro: реальный профиль никогда не занижает (round upward) — boundary при простых числах", () => {
    // A profile whose prices don't divide evenly into a round number —
    // this is the case D-090 explicitly warns about ("avoid floating
    // point money errors"). Integer arithmetic here means there is no
    // fractional remainder to accidentally round down in the first place.
    const profile = {
      modelId: "test-model-odd",
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

  it("boundInputText: текст короче потолка -> не изменяется", () => {
    const profile = loadModelCostProfile("claude-haiku-4-5");
    const short = "a short document";
    expect(boundInputText(short, profile)).toBe(short);
  });

  it("boundInputText: текст длиннее потолка -> усекается детерминированно до maxInputCharsFor(profile)", () => {
    const profile = loadModelCostProfile("claude-haiku-4-5");
    const maxChars = maxInputCharsFor(profile);
    const long = "x".repeat(maxChars + 5000);
    const bounded = boundInputText(long, profile);
    expect(bounded.length).toBe(maxChars);
    expect(bounded).toBe(long.slice(0, maxChars));
  });

  it("boundInputText: ровно на границе -> не усекается (off-by-one)", () => {
    const profile = loadModelCostProfile("claude-haiku-4-5");
    const maxChars = maxInputCharsFor(profile);
    const exact = "y".repeat(maxChars);
    expect(boundInputText(exact, profile)).toBe(exact);
    expect(boundInputText(exact, profile).length).toBe(maxChars);
  });

  it("boundInputText: на единицу длиннее границы -> усекается на 1 символ", () => {
    const profile = loadModelCostProfile("claude-haiku-4-5");
    const maxChars = maxInputCharsFor(profile);
    const overByOne = "z".repeat(maxChars + 1);
    const bounded = boundInputText(overByOne, profile);
    expect(bounded.length).toBe(maxChars);
  });
});

// --- wiring: the approved profile's maxOutputTokens actually reaches the
// provider's max_tokens field. The Anthropic SDK class is mocked (no live
// credentials, no network) — this proves the request THIS CODEBASE
// builds, matching the discipline every other S4 provider test in this
// suite already uses (deterministic fixtures, no live internet/model).
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

describe("Фаза 6, S4 — D-090: maxOutputTokens доходит до провайдерского вызова (bounded output)", () => {
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
        normalizedText: "some bounded text",
        contentHash: "sha256:x",
        fetchedAt: new Date("2026-08-22T00:00:00Z"),
        byteLength: 10,
      },
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].max_tokens).toBe(444);
  });
});
