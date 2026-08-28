import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { projects, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import {
  EvidenceExtractorUnavailableError,
  EXTRACTOR_OUTPUT_DIAGNOSTICS,
  isExtractorOutputDiagnostic,
} from "../src/server/engine/providers/evidence-extractor";
import {
  __resetAnthropicEvidenceExtractorClient,
  __setAnthropicEvidenceExtractorClient,
  createAnthropicEvidenceExtractor,
} from "../src/server/engine/providers/evidence-extractor-anthropic";
import type { EvidenceExtractionInput } from "../src/server/engine/providers/evidence-extractor";
import { ModelInputOversizedError, TokenCountUnavailableError } from "../src/server/engine/providers/token-gate";
import type { FetchedDocument, ModelUsage } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor, safeFailureReason } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// CLOSED OBSERVABILITY FOR EVIDENCE-EXTRACTOR GENERATION FAILURES —
// entirely offline; no Anthropic call is made anywhere in this file
// (every client is a stub injected through the __-prefixed test seam).
//
// A live Stage B window (job b3457f0b-…) died with
// FAILED/EVIDENCE_EXTRACTOR_UNAVAILABLE + trace PROVIDER_ERROR and
// nothing persisted could say whether messages.create was refused with a
// 4xx or the output truncated at the max_tokens ceiling — two situations
// whose next actions have nothing in common. This suite pins the closed
// diagnostic that now crosses the boundary on the generation path, and —
// just as hard — what still cannot cross it: raw provider messages, keys,
// request/response bodies, document content, stacks.

// Secrets that must NEVER appear in any operator-facing string. One for
// the provider's raw error text, one planted in the document (= request
// body), one planted in the model's raw output (= response body).
const SECRET = "sk-ant-SECRET_DO_NOT_LEAK";
const DOC_SECRET = "DOCUMENT_CONTENT_SECRET_1b2c";
const OUT_SECRET = "MODEL_OUTPUT_SECRET_9f8e";

function apiError(status: number) {
  // The 5-arg construction the existing S10 suites already use — the raw
  // message deliberately carries the secret so leak assertions are real.
  return new Anthropic.APIError(status, { detail: SECRET }, `boom ${SECRET}`, undefined, undefined);
}

const INPUT: EvidenceExtractionInput = {
  target: {
    step: 6,
    stepName: "Value Destination",
    component: "DESTINATION",
    projectId: "p",
    projectName: "Fixture Project",
    projectSlug: "fixture-project",
  },
  document: {
    finalUrl: "https://docs.example-project.test/doc",
    requestedUrl: "https://docs.example-project.test/doc",
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText: `fee text mentioning the treasury ${DOC_SECRET}`,
    contentHash: "sha256:fixturehash",
    fetchedAt: new Date("2026-08-28T00:00:00Z"),
    byteLength: 100,
  },
};

interface StubCalls {
  count: number;
  create: number;
}

// A stub client over the REAL doExtract path: countTokens under the
// ceiling by default, messages.create driven by the test.
function stubClient(
  create: () => Promise<unknown>,
  calls: StubCalls,
  countTokens: () => Promise<{ input_tokens: number }> = async () => ({ input_tokens: 10 }),
): Anthropic {
  return {
    messages: {
      countTokens: vi.fn(async () => {
        calls.count += 1;
        return countTokens();
      }),
      create: vi.fn(async () => {
        calls.create += 1;
        return create();
      }),
    },
  } as unknown as Anthropic;
}

async function extractFailure(
  create: () => Promise<unknown>,
  onUsage?: (u: ModelUsage) => void,
): Promise<{ err: EvidenceExtractorUnavailableError; calls: StubCalls }> {
  const calls: StubCalls = { count: 0, create: 0 };
  __setAnthropicEvidenceExtractorClient(stubClient(create, calls));
  const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000, onUsage);
  try {
    await extractor.extract(INPUT);
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(EvidenceExtractorUnavailableError);
    return { err: thrown as EvidenceExtractorUnavailableError, calls };
  }
  throw new Error("extract unexpectedly resolved");
}

function modelResponse(text: string, stopReason = "end_turn") {
  return {
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "text", text }],
  };
}

afterEach(() => {
  __resetAnthropicEvidenceExtractorClient();
});

describe("generation: SDK signal -> closed diagnostic at the real doExtract (items 1-8)", () => {
  it("1-6. each provider status maps to its closed class with the trusted integer, message composed from closed values", async () => {
    for (const [status, expected, transient] of [
      [401, "AUTHENTICATION_FAILED", false],
      [403, "PERMISSION_DENIED", false],
      [404, "NOT_FOUND", false],
      [400, "INVALID_REQUEST", false],
      [422, "INVALID_REQUEST", false],
      [429, "RATE_LIMITED", true],
      [500, "PROVIDER_SERVER_ERROR", true],
      [503, "PROVIDER_SERVER_ERROR", true],
    ] as const) {
      const { err, calls } = await extractFailure(async () => {
        throw apiError(status);
      });
      expect(err.diagnostic, String(status)).toBe(expected);
      expect(err.httpStatus, String(status)).toBe(status);
      expect(err.transient, String(status)).toBe(transient);
      expect(err.message).toBe(`generation failed: ${expected}:${status}`);
      expect(err.message).not.toContain(SECRET);
      // doExtract itself makes exactly ONE external generation attempt —
      // retry is owned entirely by s4-executor.ts (BLOCKER-2, D-119).
      expect(calls.create, String(status)).toBe(1);
      __resetAnthropicEvidenceExtractorClient();
    }
  });

  it("7. the SDK's own no-response class -> NETWORK_NO_RESPONSE, no status, transient", async () => {
    const { err } = await extractFailure(async () => {
      throw new Anthropic.APIConnectionError({ message: `no response ${SECRET}` });
    });
    expect(err.diagnostic).toBe("NETWORK_NO_RESPONSE");
    expect(err.httpStatus).toBeNull();
    expect(err.transient).toBe(true);
    expect(err.message).toBe("generation failed: NETWORK_NO_RESPONSE");
  });

  it("8. an unknown error -> UNCLASSIFIED_PROVIDER_ERROR, never a guessed class; transience rule unchanged", async () => {
    const { err } = await extractFailure(async () => {
      throw new Error(`weird ${SECRET}`);
    });
    expect(err.diagnostic).toBe("UNCLASSIFIED_PROVIDER_ERROR");
    expect(err.httpStatus).toBeNull();
    // The PRE-EXISTING shared transience rule (isTransientAnthropicApiError):
    // no distinguishable status -> transient. Pinned, not changed.
    expect(err.transient).toBe(true);
    expect(err.message).toBe("generation failed: UNCLASSIFIED_PROVIDER_ERROR");
  });
});

describe("generation: output-side closed diagnostics come only from their own branches (items 9-11)", () => {
  it("9. stop_reason=max_tokens -> MAX_TOKENS_TRUNCATED, not transient, and usage is NOT captured (existing accounting)", async () => {
    const onUsage = vi.fn();
    const { err, calls } = await extractFailure(async () => modelResponse(`partial ${OUT_SECRET}`, "max_tokens"), onUsage);
    expect(err.diagnostic).toBe("MAX_TOKENS_TRUNCATED");
    expect(err.httpStatus).toBeNull();
    expect(err.transient).toBe(false);
    expect(err.message).toBe("model output truncated (max_tokens)");
    expect(err.message).not.toContain(OUT_SECRET);
    expect(calls.create).toBe(1);
    // The throw happens BEFORE the onUsage capture — an output truncated
    // at the ceiling records no usage. That is the existing accounting
    // contract, deliberately unchanged; this pins it as intentional.
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("10. malformed JSON -> OUTPUT_NOT_JSON, and usage IS captured first", async () => {
    const onUsage = vi.fn();
    const { err } = await extractFailure(async () => modelResponse(`not json {{{ ${OUT_SECRET}`), onUsage);
    expect(err.diagnostic).toBe("OUTPUT_NOT_JSON");
    expect(err.transient).toBe(false);
    expect(err.message).toBe("model output is not valid JSON");
    expect(err.message).not.toContain(OUT_SECRET);
    // JSON-parse failures record usage BEFORE throwing — which is exactly
    // why null usage columns excluded this class for job b3457f0b.
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("11. schema-invalid JSON -> OUTPUT_SCHEMA_INVALID, usage captured, no zod/model text in the message", async () => {
    const onUsage = vi.fn();
    const invalid = JSON.stringify({ facts: [{ step: `bad ${OUT_SECRET}`, component: 1 }] });
    const { err } = await extractFailure(async () => modelResponse(invalid), onUsage);
    expect(err.diagnostic).toBe("OUTPUT_SCHEMA_INVALID");
    expect(err.transient).toBe(false);
    expect(err.message).toBe("model output failed schema validation");
    expect(err.message).not.toContain(OUT_SECRET);
    expect(err.message).not.toContain("Expected");
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});

describe("generation: what did NOT change (items 12-13)", () => {
  it("12. successful extraction is unchanged: valid facts come back, usage captured, one create call", async () => {
    const calls: StubCalls = { count: 0, create: 0 };
    const onUsage = vi.fn();
    const fact = {
      step: 6,
      component: "DESTINATION",
      statement: "fees accrue to the treasury",
      supportFragment: "fee text mentioning the treasury",
      mechanismState: null,
      directness: "DIRECT",
      publishedAt: null,
      doesNotProve: "does not prove execution",
      relationship: "SUPPORTS",
      onchainLocator: null,
      onchainLocators: null,
    };
    __setAnthropicEvidenceExtractorClient(stubClient(async () => modelResponse(JSON.stringify({ facts: [fact] })), calls));
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000, onUsage);
    const facts = await extractor.extract(INPUT);
    expect(facts).toHaveLength(1);
    expect(facts[0].statement).toBe("fees accrue to the treasury");
    expect(calls.create).toBe(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("13. count_tokens still gates first and keeps its OWN diagnostic class: a count failure never becomes a generation class", async () => {
    const calls: StubCalls = { count: 0, create: 0 };
    __setAnthropicEvidenceExtractorClient(
      stubClient(
        async () => modelResponse("{}"),
        calls,
        async () => {
          throw apiError(403);
        },
      ),
    );
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000);
    const rejection = extractor.extract(INPUT);
    await expect(rejection).rejects.toBeInstanceOf(TokenCountUnavailableError);
    await rejection.catch((e: TokenCountUnavailableError) => {
      expect(e.diagnostic).toBe("PERMISSION_DENIED");
      expect(e.httpStatus).toBe(403);
      expect(e.message).toBe("count_tokens failed: PERMISSION_DENIED:403");
    });
    expect(calls.create).toBe(0);

    // And the oversized SKIP is untouched too: over the ceiling, create is
    // never called and the error class is the local ModelInputOversizedError.
    const calls2: StubCalls = { count: 0, create: 0 };
    __setAnthropicEvidenceExtractorClient(
      stubClient(async () => modelResponse("{}"), calls2, async () => ({ input_tokens: 9000 })),
    );
    const extractor2 = createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000);
    await expect(extractor2.extract(INPUT)).rejects.toBeInstanceOf(ModelInputOversizedError);
    expect(calls2.create).toBe(0);
  });
});

describe("the vocabulary itself is closed and membership-checked", () => {
  it("output diagnostics: exactly three values; provider classes and junk are refused by the output gate", () => {
    expect([...EXTRACTOR_OUTPUT_DIAGNOSTICS]).toEqual(["MAX_TOKENS_TRUNCATED", "OUTPUT_NOT_JSON", "OUTPUT_SCHEMA_INVALID"]);
    for (const d of EXTRACTOR_OUTPUT_DIAGNOSTICS) expect(isExtractorOutputDiagnostic(d)).toBe(true);
    for (const bad of ["", "boom", SECRET, "RATE_LIMITED", "MAX_TOKENS_TRUNCATED ", "max_tokens_truncated"]) {
      expect(isExtractorOutputDiagnostic(bad), bad).toBe(false);
    }
  });

  it("safeFailureReason carries the closed diagnostic for generation failures — provider class and output class alike", async () => {
    const { err } = await extractFailure(async () => {
      throw apiError(403);
    });
    expect(safeFailureReason("EVIDENCE_EXTRACTOR", err)).toBe(
      "EVIDENCE_EXTRACTOR_FAILED:EvidenceExtractorUnavailableError:PERMISSION_DENIED:403",
    );
    __resetAnthropicEvidenceExtractorClient();
    const { err: truncated } = await extractFailure(async () => modelResponse("x", "max_tokens"));
    expect(safeFailureReason("EVIDENCE_EXTRACTOR", truncated)).toBe(
      "EVIDENCE_EXTRACTOR_FAILED:EvidenceExtractorUnavailableError:MAX_TOKENS_TRUNCATED",
    );
  });

  it("a resolve-time configuration failure claims NO generation diagnostic (null default)", () => {
    const e = new EvidenceExtractorUnavailableError("ANTHROPIC_API_KEY is not set");
    expect(e.diagnostic).toBeNull();
    expect(safeFailureReason("EVIDENCE_EXTRACTOR", e)).toBe("EVIDENCE_EXTRACTOR_FAILED:EvidenceExtractorUnavailableError");
  });

  it("MUTATION CHECK: a forged out-of-vocabulary diagnostic is refused at the boundary", () => {
    const forged = new EvidenceExtractorUnavailableError("x", false, `INJECTED ${SECRET}; DROP TABLE evidence` as never, 403);
    const reason = safeFailureReason("EVIDENCE_EXTRACTOR", forged);
    expect(reason).toBe("EVIDENCE_EXTRACTOR_FAILED:EvidenceExtractorUnavailableError");
    expect(reason).not.toContain("INJECTED");
    expect(reason).not.toContain(SECRET);
  });

  it("MUTATION CHECK: a forged non-integer httpStatus is dropped, the closed class kept", () => {
    const forged = new EvidenceExtractorUnavailableError("x", false, "PERMISSION_DENIED", 40.3);
    expect(safeFailureReason("EVIDENCE_EXTRACTOR", forged)).toBe(
      "EVIDENCE_EXTRACTOR_FAILED:EvidenceExtractorUnavailableError:PERMISSION_DENIED",
    );
  });

  it("raw provider message, key, document content, response body and stack never cross (items 19-23)", async () => {
    const failures: Array<() => Promise<unknown>> = [
      async () => {
        throw apiError(403);
      },
      async () => {
        throw apiError(503);
      },
      async () => {
        throw new Anthropic.APIConnectionError({ message: SECRET });
      },
      async () => modelResponse(`partial ${OUT_SECRET}`, "max_tokens"),
      async () => modelResponse(`not json ${OUT_SECRET}`),
      async () => modelResponse(JSON.stringify({ facts: [{ oops: OUT_SECRET }] })),
    ];
    for (const create of failures) {
      const { err } = await extractFailure(create);
      const surfaces = [
        err.message,
        safeFailureReason("EVIDENCE_EXTRACTOR", err),
        new CapabilityFatalError("EVIDENCE_EXTRACTOR", safeFailureReason("EVIDENCE_EXTRACTOR", err)).message,
      ];
      for (const s of surfaces) {
        expect(s).not.toContain(SECRET);
        expect(s).not.toContain(DOC_SECRET);
        expect(s).not.toContain(OUT_SECRET);
        expect(s).not.toContain("boom");
        expect(s).not.toContain("at "); // no stack fragment
      }
      __resetAnthropicEvidenceExtractorClient();
    }
  });
});

// ---- the full production boundary, through the real executor ----------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

const DOC_URL = "https://docs.example-project.test/doc";

function fixtureDoc(): FetchedDocument {
  return {
    finalUrl: DOC_URL,
    requestedUrl: DOC_URL,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "Fixture project: the protocol fee accrues directly to the treasury contract",
    contentHash: "sha256:fixturehash",
    fetchedAt: new Date(),
    byteLength: 200,
  };
}

describe("end to end: the terminal line an operator actually sees (items 14-18, 24)", () => {
  async function runWithExtractor(extract: () => Promise<never>) {
    const slug = uniq("gend");
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug, name: "Generation Diagnostic Fixture", status: "ACTIVE_CORE" })
      .returning();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    const calls = { extract: 0 };
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug, ticker: null },
      queryProposer: {
        name: "fixture",
        async proposeQueries() {
          return ["q1"];
        },
      },
      searchGateway: {
        name: "fixture",
        async search() {
          return [{ url: DOC_URL, title: "t", snippet: "s" }];
        },
      },
      contentFetcher: {
        name: "fixture",
        async fetch() {
          return fixtureDoc();
        },
      },
      evidenceExtractor: {
        name: "fixture",
        async extract() {
          calls.extract += 1;
          return extract();
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
    });
    const outcome = executor.execute(ITEM, {
      jobId: job.id,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: 5, maxSourceOpens: 5, maxModelCostMicro: 1_000_000 },
    });
    return { outcome, calls, jobId: job.id };
  }

  async function traceRowsFor(jobId: string) {
    return ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  }

  it("15. a non-transient 4xx stays ONE attempt and the terminal reason now names the closed class", async () => {
    const { err } = await extractFailure(async () => {
      throw apiError(403);
    });
    const { outcome, calls, jobId } = await runWithExtractor(async () => {
      throw err;
    });
    const result = await outcome;
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(result.reason).toContain("EXTRACT_FAILED:PERMISSION_DENIED:403");
    expect(result.reason).not.toContain(SECRET);
    expect(calls.extract).toBe(1);
    const trace = await traceRowsFor(jobId);
    // Attempt cardinality persisted: exactly one real extraction attempt.
    expect(trace.filter((t) => t.operationType === "EXTRACT_ATTEMPTED")).toHaveLength(1);
    // The trace vocabulary is deliberately unchanged (no enum migration —
    // same decision as e7c422c): the closed class travels in the terminal
    // reason, not in a widened reason_code enum.
    const failed = trace.filter((t) => t.operationType === "EXTRACT_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].reasonCode).toBe("PROVIDER_ERROR");
  }, 30_000);

  it("14/16. a transient failure retries exactly once, then CapabilityFatalError names capability EVIDENCE_EXTRACTOR (never _COUNT_TOKENS) and the closed class", async () => {
    const { err } = await extractFailure(async () => {
      throw apiError(429);
    });
    expect(err.transient).toBe(true);
    const { outcome, calls, jobId } = await runWithExtractor(async () => {
      throw err;
    });
    await expect(outcome).rejects.toBeInstanceOf(CapabilityFatalError);
    await outcome.catch((thrown: CapabilityFatalError) => {
      expect(thrown.capability).toBe("EVIDENCE_EXTRACTOR");
      expect(thrown.message).toBe(
        "capability unavailable: EVIDENCE_EXTRACTOR — EVIDENCE_EXTRACTOR_FAILED:EvidenceExtractorUnavailableError:RATE_LIMITED:429",
      );
      expect(thrown.message).not.toContain(SECRET);
    });
    expect(calls.extract).toBe(2);
    const trace = await traceRowsFor(jobId);
    expect(trace.filter((t) => t.operationType === "EXTRACT_ATTEMPTED")).toHaveLength(2);
  }, 30_000);

  it("17. MAX_TOKENS_TRUNCATED does not gain a retry: one attempt, named in the terminal reason", async () => {
    const { err } = await extractFailure(async () => modelResponse("x", "max_tokens"));
    const { outcome, calls } = await runWithExtractor(async () => {
      throw err;
    });
    const result = await outcome;
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(result.reason).toContain("EXTRACT_FAILED:MAX_TOKENS_TRUNCATED");
    expect(calls.extract).toBe(1);
  }, 30_000);

  it("18. OUTPUT_NOT_JSON / OUTPUT_SCHEMA_INVALID stay single-attempt and are named", async () => {
    for (const [make, expected] of [
      [async () => modelResponse(`bad ${OUT_SECRET}`), "EXTRACT_FAILED:OUTPUT_NOT_JSON"],
      [async () => modelResponse(JSON.stringify({ facts: [{ oops: OUT_SECRET }] })), "EXTRACT_FAILED:OUTPUT_SCHEMA_INVALID"],
    ] as const) {
      const { err } = await extractFailure(make);
      const { outcome, calls } = await runWithExtractor(async () => {
        throw err;
      });
      const result = await outcome;
      expect(result.status).toBe("FAILED");
      expect(result.reason).toContain(expected);
      expect(result.reason).not.toContain(OUT_SECRET);
      expect(calls.extract).toBe(1);
      __resetAnthropicEvidenceExtractorClient();
    }
  }, 60_000);

  it("24. a forged diagnostic never reaches the terminal reason: no observation is added at all", async () => {
    const forged = new EvidenceExtractorUnavailableError("x", false, `INJECTED ${SECRET}` as never, 403);
    const { outcome, calls } = await runWithExtractor(async () => {
      throw forged;
    });
    const result = await outcome;
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(result.reason).not.toContain("EXTRACT_FAILED:");
    expect(result.reason).not.toContain("INJECTED");
    expect(result.reason).not.toContain(SECRET);
    expect(calls.extract).toBe(1);
  }, 30_000);
});

describe("25. no project-specific knowledge entered the diagnostic path", () => {
  it("the seam and the live extractor name no project or host", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/providers/evidence-extractor.ts",
      "../src/server/engine/providers/evidence-extractor-anthropic.ts",
    ]) {
      const code = (await fs.readFile(new URL(file, import.meta.url), "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["raydium", "pump", "solscan", "docs.raydium"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
    }
  });
});
