import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6, S4 final implementation (D-090, phase-6-plan.md §5.6) —
// cost-profile arithmetic and the "maxOutputTokens actually reaches the
// provider call" wiring. No live credentials used: the Anthropic SDK
// class itself is mocked so this test proves the REQUEST SHAPE this
// codebase builds, not anything about the real API.
//
// S10 (live-provider-enablement.md §3/§4, D-118): the production
// catalogue is no longer empty — it now holds exactly the two owner-
// approved role-qualified profiles (QUERY_PROPOSER + EVIDENCE_EXTRACTOR,
// both claude-haiku-4-5). Every OTHER (role, model) combination —
// including the WRONG role for the SAME model id — still fails closed
// exactly as before S10; that fail-closed discipline is what this suite
// now proves, rather than "every model id fails" (which stopped being
// true once S10 populated the catalogue).

import {
  ModelCostProfileMissingError,
  calculateActualCostMicro,
  calculateMaxAuthorizedCostMicro,
  loadModelCostProfile,
} from "../src/server/engine/model-cost-profile";

describe("Фаза 6/S10, D-090/D-118 — production cost profile catalogue: role-qualified, fail-closed вне двух утверждённых записей", () => {
  it("loadModelCostProfile: QUERY_PROPOSER + claude-haiku-4-5 -> утверждённый профиль (maxInputTokens=4000)", () => {
    const profile = loadModelCostProfile("QUERY_PROPOSER", "claude-haiku-4-5");
    expect(profile.modelId).toBe("claude-haiku-4-5");
    expect(profile.maxInputTokens).toBe(4000);
    expect(profile.maxOutputTokens).toBe(512);
    expect(profile.priceVersion).toBe("anthropic-2026-08");
  });

  it("loadModelCostProfile: EVIDENCE_EXTRACTOR + claude-haiku-4-5 -> утверждённый профиль (maxInputTokens=48000)", () => {
    const profile = loadModelCostProfile("EVIDENCE_EXTRACTOR", "claude-haiku-4-5");
    expect(profile.modelId).toBe("claude-haiku-4-5");
    expect(profile.maxInputTokens).toBe(48000);
    expect(profile.maxOutputTokens).toBe(1536);
    expect(profile.priceVersion).toBe("anthropic-2026-08");
  });

  it("owner decision §3 — роль-квалификация не даёт перепутать профили: QUERY_PROPOSER и EVIDENCE_EXTRACTOR профили РАЗНЫЕ для ОДНОЙ modelId", () => {
    const qp = loadModelCostProfile("QUERY_PROPOSER", "claude-haiku-4-5");
    const ee = loadModelCostProfile("EVIDENCE_EXTRACTOR", "claude-haiku-4-5");
    expect(qp.maxInputTokens).not.toBe(ee.maxInputTokens);
    expect(qp.maxOutputTokens).not.toBe(ee.maxOutputTokens);
  });

  it("ЛЮБАЯ другая (role, modelId) комбинация -> ModelCostProfileMissingError (fail closed)", () => {
    const cases: Array<["QUERY_PROPOSER" | "EVIDENCE_EXTRACTOR", string]> = [
      ["QUERY_PROPOSER", "claude-sonnet-5"],
      ["QUERY_PROPOSER", "claude-opus-5"],
      ["EVIDENCE_EXTRACTOR", "claude-sonnet-5"],
      ["QUERY_PROPOSER", "some-model-nobody-approved"],
    ];
    for (const [role, modelId] of cases) {
      expect(() => loadModelCostProfile(role, modelId)).toThrow(ModelCostProfileMissingError);
    }
  });

  it("ModelCostProfileMissingError несёт role, modelId и MODEL_COST_PROFILE_MISSING в сообщении", () => {
    try {
      loadModelCostProfile("QUERY_PROPOSER", "claude-opus-5");
      throw new Error("expected loadModelCostProfile to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelCostProfileMissingError);
      expect((e as ModelCostProfileMissingError).message).toContain("MODEL_COST_PROFILE_MISSING");
      expect((e as ModelCostProfileMissingError).role).toBe("QUERY_PROPOSER");
      expect((e as ModelCostProfileMissingError).modelId).toBe("claude-opus-5");
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

describe("S10 (D-118) — calculateActualCostMicro: audit-only actual cost, SAME profile prices, никогда не бюджетный авторитет", () => {
  it("точная целочисленная формула usage.input*inputPrice + usage.output*outputPrice", () => {
    const profile = {
      modelId: "fixture-test-model",
      inputPriceMicroUsdPerToken: 1,
      outputPriceMicroUsdPerToken: 5,
      maxInputTokens: 4000,
      maxOutputTokens: 512,
      priceVersion: "test",
    };
    expect(calculateActualCostMicro(profile, { inputTokens: 100, outputTokens: 20 })).toBe(100 * 1 + 20 * 5);
  });

  it("actual usage может быть МЕНЬШЕ maxAuthorizedCostMicro — это ожидаемо, не расхождение", () => {
    const profile = {
      modelId: "fixture-test-model",
      inputPriceMicroUsdPerToken: 1,
      outputPriceMicroUsdPerToken: 5,
      maxInputTokens: 4000,
      maxOutputTokens: 512,
      priceVersion: "test",
    };
    const reserved = calculateMaxAuthorizedCostMicro(profile);
    const actual = calculateActualCostMicro(profile, { inputTokens: 50, outputTokens: 10 });
    expect(actual).toBeLessThan(reserved);
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
//
// S10 (D-118): count-then-gate now runs BEFORE every generation call
// (token-gate.ts) — the mock's `countTokens` must resolve with a count
// safely under the profile's maxInputTokens for these tests to reach the
// `messages.create` call they're actually testing.
const createMock = vi.fn();
const countTokensMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock, countTokens: countTokensMock };
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
    countTokensMock.mockReset();
    countTokensMock.mockResolvedValue({ input_tokens: 10 });
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("createAnthropicQueryProposer(model, maxOutputTokens) -> messages.create() получает ТОТ ЖЕ max_tokens", async () => {
    vi.resetModules();
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
      content: [{ type: "text", text: JSON.stringify({ queries: ["q1"] }) }],
    });
    const { createAnthropicQueryProposer, __resetAnthropicQueryProposerClient } = await import(
      "../src/server/engine/providers/query-proposer-anthropic"
    );
    __resetAnthropicQueryProposerClient();
    const proposer = createAnthropicQueryProposer("claude-haiku-4-5", 777, 4000);
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
      usage: { input_tokens: 10, output_tokens: 0 },
      content: [{ type: "text", text: JSON.stringify({ facts: [] }) }],
    });
    const { createAnthropicEvidenceExtractor, __resetAnthropicEvidenceExtractorClient } = await import(
      "../src/server/engine/providers/evidence-extractor-anthropic"
    );
    __resetAnthropicEvidenceExtractorClient();
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 444, 48000);
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
