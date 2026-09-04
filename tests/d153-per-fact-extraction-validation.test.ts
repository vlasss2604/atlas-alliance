import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EvidenceExtractorUnavailableError,
  type RejectedFactReport,
} from "../src/server/engine/providers/evidence-extractor";
import {
  __resetAnthropicEvidenceExtractorClient,
  __setAnthropicEvidenceExtractorClient,
  createAnthropicEvidenceExtractor,
} from "../src/server/engine/providers/evidence-extractor-anthropic";

// D-153 — ONE MALFORMED FACT IS NOT A FAILED EXTRACTION.
//
// The response was validated with ONE whole-response schema parse, so a single
// bad field on a single fact destroyed every valid sibling in the same
// response: zod fails the element, the element fails the array, the array
// fails the object, and the caller receives OUTPUT_SCHEMA_INVALID with nothing
// salvaged.
//
// That made research materially unrepeatable. Two runs of the same question
// over BYTE-IDENTICAL official documents disagreed on four components purely
// because one sibling fact's `doesNotProve` came back malformed in one of
// them — the document had not changed, and the component moved between
// SUPPORTED and INSUFFICIENT_EVIDENCE anyway.
//
// These tests run the REAL doExtract path (count → generate → stop_reason →
// parse → validate) against a stub SDK client, so they exercise the real
// schema and the real classifier rather than a re-implementation.

const INPUT = {
  target: {
    step: 6,
    stepName: "Token Destination + Recipient",
    component: "DESTINATION",
    projectId: "p",
    projectName: "Fixture Project",
    projectSlug: "fixture-project",
  },
  document: {
    finalUrl: "https://docs.example-project.test/doc",
    requestedUrl: "https://docs.example-project.test/doc",
    httpStatus: 200,
    contentType: "text/markdown" as const,
    normalizedText: "fee text mentioning the treasury",
    contentHash: "sha256:fixturehash",
    fetchedAt: new Date("2026-09-01T00:00:00Z"),
    byteLength: 100,
  },
};

function validFact(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}

// The exact malformation observed live: `doesNotProve` present but not a
// non-empty string.
const BAD_DOES_NOT_PROVE = validFact({ doesNotProve: 12345 });

function modelResponse(text: string, stopReason = "end_turn") {
  return {
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "text", text }],
  };
}

function stubClient(body: unknown): Anthropic {
  return {
    messages: {
      countTokens: vi.fn(async () => ({ input_tokens: 10 })),
      create: vi.fn(async () => modelResponse(JSON.stringify(body))),
    },
  } as unknown as Anthropic;
}

// Runs the real extractor over a stubbed response, capturing what the
// provider reported as rejected.
async function extract(body: unknown) {
  const rejected: RejectedFactReport[] = [];
  __setAnthropicEvidenceExtractorClient(stubClient(body));
  const extractor = createAnthropicEvidenceExtractor(
    "claude-haiku-4-5",
    1536,
    4000,
    undefined,
    (r) => rejected.push(...r),
  );
  const facts = await extractor.extract(INPUT);
  return { facts, rejected };
}

async function extractFailure(body: unknown) {
  __setAnthropicEvidenceExtractorClient(stubClient(body));
  const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000);
  try {
    await extractor.extract(INPUT);
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(EvidenceExtractorUnavailableError);
    return thrown as EvidenceExtractorUnavailableError;
  }
  throw new Error("extract unexpectedly resolved");
}

afterEach(() => {
  __resetAnthropicEvidenceExtractorClient();
});

describe("D-153 — a malformed fact costs itself and nothing else", () => {
  it("TEST 1: three valid facts all survive", async () => {
    const { facts, rejected } = await extract({
      facts: [
        validFact({ statement: "one" }),
        validFact({ statement: "two" }),
        validFact({ statement: "three" }),
      ],
    });
    expect(facts).toHaveLength(3);
    expect(facts.map((f) => f.statement)).toEqual(["one", "two", "three"]);
    expect(rejected).toEqual([]);
  });

  it("TEST 2: valid / malformed doesNotProve / valid — the two valid survive", async () => {
    const { facts, rejected } = await extract({
      facts: [validFact({ statement: "one" }), BAD_DOES_NOT_PROVE, validFact({ statement: "three" })],
    });
    // This is the whole decision. Before D-153 this returned NOTHING.
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.statement)).toEqual(["one", "three"]);
    // The malformed fact is not among them, under any statement.
    expect(facts.some((f) => typeof f.doesNotProve !== "string")).toBe(false);
    // And it is reported, by index and by the closed code-owned field.
    expect(rejected).toEqual([{ index: 1, field: "FACTS_DOES_NOT_PROVE" }]);
  });

  it("TEST 3: a malformed FIRST fact does not poison later valid siblings", async () => {
    const { facts, rejected } = await extract({
      facts: [BAD_DOES_NOT_PROVE, validFact({ statement: "two" }), validFact({ statement: "three" })],
    });
    expect(facts.map((f) => f.statement)).toEqual(["two", "three"]);
    expect(rejected).toEqual([{ index: 0, field: "FACTS_DOES_NOT_PROVE" }]);
  });

  it("TEST 4: a malformed LAST fact does not poison earlier valid siblings", async () => {
    const { facts, rejected } = await extract({
      facts: [validFact({ statement: "one" }), validFact({ statement: "two" }), BAD_DOES_NOT_PROVE],
    });
    expect(facts.map((f) => f.statement)).toEqual(["one", "two"]);
    expect(rejected).toEqual([{ index: 2, field: "FACTS_DOES_NOT_PROVE" }]);
  });

  it("TEST 5: several malformed facts, of different kinds, still spare the valid ones", async () => {
    const { facts, rejected } = await extract({
      facts: [
        BAD_DOES_NOT_PROVE,
        validFact({ statement: "keep me" }),
        validFact({ directness: "SIDEWAYS" }),
        validFact({ statement: "and me" }),
        "not-an-object",
      ],
    });
    expect(facts.map((f) => f.statement)).toEqual(["keep me", "and me"]);
    expect(rejected).toEqual([
      { index: 0, field: "FACTS_DOES_NOT_PROVE" },
      { index: 2, field: "FACTS_DIRECTNESS" },
      // An element that is not an object at all is a FACTS-shaped failure,
      // the same code the whole-response parse used to give it.
      { index: 4, field: "FACTS" },
    ]);
  });

  it("TEST 6: a missing or malformed doesNotProve is never synthesised", async () => {
    for (const bad of [
      validFact({ doesNotProve: undefined }),
      validFact({ doesNotProve: null }),
      validFact({ doesNotProve: "" }),
      validFact({ doesNotProve: 12345 }),
    ]) {
      const { facts, rejected } = await extract({ facts: [validFact({ statement: "kept" }), bad] });
      // The valid sibling survives...
      expect(facts).toHaveLength(1);
      expect(facts[0].statement).toBe("kept");
      // ...and the malformed one is DROPPED, never repaired into a fact with
      // an invented or defaulted doesNotProve.
      expect(rejected).toHaveLength(1);
      expect(rejected[0].index).toBe(1);
      __resetAnthropicEvidenceExtractorClient();
    }
  });

  it("TEST 7: a malformed envelope still fails closed", async () => {
    for (const [body, field] of [
      ["just a string", "ROOT"],
      [{}, "FACTS"],
      [{ facts: "not-an-array" }, "FACTS"],
      [{ facts: Array.from({ length: 21 }, () => validFact()) }, "FACTS"],
    ] as const) {
      const err = await extractFailure(body);
      expect(err.diagnostic, String(field)).toBe("OUTPUT_SCHEMA_INVALID");
      expect(err.schemaField, String(field)).toBe(field);
      __resetAnthropicEvidenceExtractorClient();
    }
  });

  it("TEST 8: when EVERY fact is invalid, extraction still fails closed", async () => {
    const err = await extractFailure({ facts: [BAD_DOES_NOT_PROVE, BAD_DOES_NOT_PROVE] });
    // Not "found nothing" — the output could not be read, and that keeps the
    // exact failure it always had.
    expect(err.diagnostic).toBe("OUTPUT_SCHEMA_INVALID");
    expect(err.schemaField).toBe("FACTS_DOES_NOT_PROVE");
    expect(err.transient).toBe(false);
  });

  it("TEST 8b: an genuinely EMPTY facts array is still a valid, successful answer", async () => {
    // "This document says nothing for this component" is a normal outcome and
    // must not be confused with "every fact was unreadable".
    const { facts, rejected } = await extract({ facts: [] });
    expect(facts).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("TEST 9 + 10: containment and traceability inputs are passed through untouched", async () => {
    // The extractor does not enforce component containment or traceability —
    // s4-executor does, per fact, AFTER extraction. What must hold here is
    // that a wrong-component or untraceable fact is still RETURNED intact for
    // those checks to reject, rather than being silently altered or dropped
    // by schema validation.
    const { facts } = await extract({
      facts: [
        validFact({ step: 1, component: "SOURCE_OF_VALUE", statement: "other component" }),
        validFact({ supportFragment: "text that is not in the document", statement: "untraceable" }),
      ],
    });
    expect(facts).toHaveLength(2);
    expect(facts[0].step).toBe(1);
    expect(facts[0].component).toBe("SOURCE_OF_VALUE");
    expect(facts[1].supportFragment).toBe("text that is not in the document");

    // And the executor still owns both rejections, unchanged.
    const { readFileSync } = await import("node:fs");
    const exec = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(exec).toContain("REJECTED_WRONG_COMPONENT");
    expect(exec).toContain("REJECTED_NOT_TRACEABLE");
    expect(exec).toContain("fact.step !== target.step || fact.component !== target.component");
    expect(exec).toContain("isTraceable(doc.normalizedText, fact.supportFragment)");
  });

  it("TEST 11: a fully valid response behaves exactly as before", async () => {
    const { facts, rejected } = await extract({ facts: [validFact({ publishedAt: "2026-01-02" })] });
    expect(facts).toHaveLength(1);
    expect(rejected).toEqual([]);
    // publishedAt is still parsed to a Date by the same path.
    expect(facts[0].publishedAt).toBeInstanceOf(Date);
    // An unparseable date is still nulled rather than guessed (D-128).
    const { facts: f2 } = await extract({ facts: [validFact({ publishedAt: "not-a-date" })] });
    expect(f2[0].publishedAt).toBeNull();
  });

  it("TEST 12: nothing here knows about any project, and no raw output escapes", async () => {
    const { readFileSync } = await import("node:fs");
    const codeOf = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const src = codeOf(
      readFileSync("src/server/engine/providers/evidence-extractor-anthropic.ts", "utf-8"),
    );
    expect(src).not.toMatch(/pump|raydium|hyperliquid|jito|solana/i);

    // The rejection report carries a number and a closed field code, and
    // structurally cannot carry model text: this asserts it against a
    // response whose every field is a distinctive marker string.
    const marker = "MODEL-SECRET-VALUE-9f3a";
    const { rejected } = await extract({
      facts: [validFact({ statement: "kept" }), validFact({ doesNotProve: [marker] })],
    });
    expect(JSON.stringify(rejected)).not.toContain(marker);
    expect(Object.keys(rejected[0]).sort()).toEqual(["field", "index"]);
  });
});
