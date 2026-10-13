import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MECHANISM_STATES, normalizeMechanismState } from "../src/server/domain/mechanism-state";
import {
  __resetAnthropicEvidenceExtractorClient,
  __setAnthropicEvidenceExtractorClient,
  buildEvidenceExtractorUserContent,
  createAnthropicEvidenceExtractor,
  EVIDENCE_EXTRACTOR_SYSTEM_PROMPT,
  evidenceExtractorOutputFormat,
} from "../src/server/engine/providers/evidence-extractor-anthropic";
import {
  EvidenceExtractorUnavailableError,
  type EvidenceExtractionInput,
  type RejectedFactReport,
} from "../src/server/engine/providers/evidence-extractor";

// GOVERNANCE STATE EXTRACTION GUIDANCE V1 — the extraction channel speaks
// the reducer's lifecycle dictionary.
//
// GOVERNANCE LIFECYCLE SAFETY V1 made S5 read mechanism_state honestly:
// PROPOSED != APPROVED != EXECUTING, UNKNOWN fails closed. But the wire
// field was free text and the prompt never mentioned lifecycle, so a
// document that said "the vote passed" came back as prose the normalizer
// could only read as UNKNOWN — a conservative false negative on every
// governance component. These tests pin the contract that closes that gap
// and, just as hard, what the contract must NOT do: no state may be
// inferred from source class, domain, route authority, project or
// component. Entirely offline: the client is a stub over the REAL
// doExtract path; no provider is ever called.

const INPUT: EvidenceExtractionInput = {
  target: {
    step: 3,
    stepName: "Mechanism",
    component: "GOVERNANCE_BASIS",
    projectId: "p",
    projectName: "Fixture Project",
    projectSlug: "fixture-project",
  },
  document: {
    finalUrl: "https://forum.example-project.test/t/rfc-fee-alignment/1",
    requestedUrl: "https://forum.example-project.test/t/rfc-fee-alignment/1",
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "[RFC] Align the token with protocol fees. Seeking feedback before a vote.",
    contentHash: "sha256:fixturehash",
    fetchedAt: new Date("2026-09-12T00:00:00Z"),
    byteLength: 100,
  },
};

function stubClient(create: () => Promise<unknown>): Anthropic {
  return {
    messages: {
      countTokens: vi.fn(async () => ({ input_tokens: 10 })),
      create: vi.fn(async () => create()),
    },
  } as unknown as Anthropic;
}

function modelResponse(body: unknown) {
  return {
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

function fact(mechanismState: unknown, overrides: Record<string, unknown> = {}) {
  return {
    step: 3,
    component: "GOVERNANCE_BASIS",
    statement: "a fee-alignment mechanism was put forward",
    supportFragment: "[RFC] Align the token with protocol fees. Seeking feedback before a vote.",
    mechanismState,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove the proposal was approved",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
    ...overrides,
  };
}

// Drives the real extractor over a stubbed model answer and returns what
// was admitted and what was rejected.
async function extract(body: unknown): Promise<{ facts: { mechanismState: string | null }[]; rejected: RejectedFactReport[] }> {
  const rejected: RejectedFactReport[] = [];
  __setAnthropicEvidenceExtractorClient(stubClient(async () => modelResponse(body)));
  const extractor = createAnthropicEvidenceExtractor("fixture-model", 1536, 4000, undefined, (r) => rejected.push(...r));
  const facts = await extractor.extract(INPUT);
  return { facts, rejected };
}

afterEach(() => {
  __resetAnthropicEvidenceExtractorClient();
});

// The mechanismState property as the structured-output grammar sees it,
// found by walking the exact object the generation call sends.
function wireMechanismStateSchema(): unknown {
  const format = evidenceExtractorOutputFormat() as unknown as { schema?: unknown; json_schema?: unknown };
  const root = (format.schema ?? format.json_schema ?? format) as Record<string, unknown>;
  const find = (node: unknown, key: string): unknown => {
    if (node === null || typeof node !== "object") return undefined;
    const obj = node as Record<string, unknown>;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const hit = find(v, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return find(root, "mechanismState");
}

describe("A — the extractor contract exposes exactly the reducer's canonical vocabulary", () => {
  it("the canonical dictionary is the eight states the reducer already recognised, nothing invented here", () => {
    expect([...MECHANISM_STATES]).toEqual(["PROPOSED", "APPROVED", "IMPLEMENTING", "LIVE", "DEPRECATED", "REMOVED", "PAUSED", "UNKNOWN"]);
  });

  it("the structured-output schema carries the dictionary on mechanismState (string or null) — the same object the generation call sends", () => {
    const node = wireMechanismStateSchema() as { anyOf?: { type?: string; description?: string }[] };
    expect(node.anyOf).toBeDefined();
    const branch = node.anyOf!.find((b) => b.type === "string");
    expect(branch?.description).toContain(`exactly one of: ${MECHANISM_STATES.join(", ")}`);
    expect(node.anyOf!.some((b) => b.type === "null")).toBe(true);
    // Not a grammar enum: this SDK build renders zod enums as description
    // hints only (see `directness`), so an enum here would constrain
    // nothing and merely reject facts on parse. The wire stays tolerant
    // and the normalizer is the gate.
    expect(JSON.stringify(node)).not.toContain('"enum"');
    // The vocabulary lives on exactly one fact field.
    const whole = JSON.stringify(evidenceExtractorOutputFormat());
    expect(whole.split("exactly one of: PROPOSED").length - 1).toBe(1);
  });

  it("the system prompt names every canonical state, from the dictionary itself, and no state outside it", () => {
    for (const state of MECHANISM_STATES) expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain(state);
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain(`exactly one of: ${MECHANISM_STATES.join(", ")}`);
    for (const invented of ["ACTIVE", "EXECUTING", "REJECTED", "PLANNED", "ANNOUNCED", "PENDING", "ENACTED"]) {
      expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT, invented).not.toMatch(new RegExp(`\\b${invented}\\b`));
    }
  });
});

describe("B–F — each canonical state round-trips the real extraction path and normalizes to itself", () => {
  it("B. PROPOSED — proposal / RFC / draft / discussion language is the PROPOSED rung", async () => {
    const { facts, rejected } = await extract({ facts: [fact("PROPOSED")] });
    expect(rejected).toEqual([]);
    expect(facts[0].mechanismState).toBe("PROPOSED");
    expect(normalizeMechanismState(facts[0].mechanismState)).toBe("PROPOSED");
    const guidance = EVIDENCE_EXTRACTOR_SYSTEM_PROMPT;
    for (const cue of ["proposal", "RFC", "draft", "discussion", "request for feedback", "has not been approved"]) {
      expect(guidance, cue).toContain(cue);
    }
  });

  it("C. APPROVED — vote passed / formally authorised is APPROVED, and the guidance says so", async () => {
    const { facts } = await extract({ facts: [fact("APPROVED", { supportFragment: "the vote passed and the programme is approved" })] });
    expect(normalizeMechanismState(facts[0].mechanismState)).toBe("APPROVED");
    for (const cue of ["vote passed", "formally authorised", "decision was taken"]) {
      expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT, cue).toContain(cue);
    }
  });

  it("D. approved-but-not-live is APPROVED, never LIVE — the ladder is stated rung by rung", async () => {
    const { facts } = await extract({ facts: [fact("APPROVED", { supportFragment: "approved by governance; deployment is not yet scheduled" })] });
    expect(normalizeMechanismState(facts[0].mechanismState)).toBe("APPROVED");
    expect(normalizeMechanismState(facts[0].mechanismState)).not.toBe("LIVE");
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("saying nothing that establishes it is deployed or operating");
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain(
      "a proposal is not an approval,\nan approval is not an implementation, and an implementation is not a live mechanism",
    );
  });

  it("E. IMPLEMENTING — explicit rollout underway", async () => {
    const { facts } = await extract({ facts: [fact("IMPLEMENTING", { supportFragment: "the approved fee switch is being rolled out this quarter" })] });
    expect(normalizeMechanismState(facts[0].mechanismState)).toBe("IMPLEMENTING");
    for (const cue of ["being implemented, deployed or rolled out", "underway rather than complete"]) {
      expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT, cue).toContain(cue);
    }
  });

  it("F. LIVE — explicit active / operating-now language can be LIVE; PAUSED / DEPRECATED / REMOVED only when directly stated", async () => {
    const { facts } = await extract({ facts: [fact("LIVE", { supportFragment: "the fee switch is active and distributes fees every epoch" })] });
    expect(normalizeMechanismState(facts[0].mechanismState)).toBe("LIVE");
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("directly states that the mechanism is active, in force or operating now");
    for (const terminal of ["PAUSED", "DEPRECATED", "REMOVED"] as const) {
      const r = await extract({ facts: [fact(terminal)] });
      expect(normalizeMechanismState(r.facts[0].mechanismState)).toBe(terminal);
    }
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("only when the excerpt directly states that the mechanism is paused, deprecated or");
  });
});

describe("G — ambiguity falls back to UNKNOWN; an off-vocabulary wire value is refused, never read as a state", () => {
  it("UNKNOWN and null both travel and both normalize to UNKNOWN; the guidance names ambiguity, history and inference as UNKNOWN", async () => {
    const { facts } = await extract({ facts: [fact("UNKNOWN"), fact(null, { statement: "second" })] });
    expect(facts.map((f) => normalizeMechanismState(f.mechanismState))).toEqual(["UNKNOWN", "UNKNOWN"]);
    for (const cue of ["wording is ambiguous", "historical context with no clear present state", "infer the state rather than read it", "never the most likely state"]) {
      expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT, cue).toContain(cue);
    }
  });

  it("a wire value outside the dictionary is still admitted as Evidence and fails closed to UNKNOWN in the normalizer — never read as a state, never rejected for the state word alone", async () => {
    const { facts, rejected } = await extract({
      facts: [fact("PROPOSED"), fact("probably approved", { statement: "second" }), fact("approved by vote", { statement: "third" })],
    });
    expect(rejected).toEqual([]);
    expect(facts).toHaveLength(3);
    expect(facts.map((f) => normalizeMechanismState(f.mechanismState))).toEqual(["PROPOSED", "UNKNOWN", "UNKNOWN"]);
    // A non-string value is still a shape violation of the fact and is
    // refused through the existing D-153 path with the closed field code.
    const r = await extract({ facts: [fact("PROPOSED"), fact(42, { statement: "second" })] });
    expect(r.facts).toHaveLength(1);
    expect(r.rejected).toEqual([{ index: 1, field: "FACTS_MECHANISM_STATE" }]);
    __setAnthropicEvidenceExtractorClient(stubClient(async () => modelResponse({ facts: [fact(["LIVE"])] })));
    const extractor = createAnthropicEvidenceExtractor("fixture-model", 1536, 4000);
    await expect(extractor.extract(INPUT)).rejects.toMatchObject({
      diagnostic: "OUTPUT_SCHEMA_INVALID",
      schemaField: "FACTS_MECHANISM_STATE",
    } satisfies Partial<EvidenceExtractorUnavailableError>);
  });
});

describe("H/I — nothing the model is given can carry a state, and the guidance forbids inferring one", () => {
  it("H. the model is never told the source class, officiality or route — GOVERNANCE cannot imply APPROVED because GOVERNANCE is not in the input", () => {
    const content = buildEvidenceExtractorUserContent({
      ...INPUT,
      target: { ...INPUT.target, researchTask: "does protocol revenue reach token holders?", evidenceGoal: "find the governing decision" },
    });
    for (const label of ["GOVERNANCE\n", "sourceClass", "officiality", "CONFIRMED", "CLAIMED", "routeClass", "OFFICIAL_DOCS", "authority"]) {
      expect(content, label).not.toContain(label);
    }
    // The schema has no field through which a class could be asked for
    // or returned either.
    const whole = JSON.stringify(evidenceExtractorOutputFormat());
    for (const field of ["sourceClass", "officiality", "routeClass", "approved", "authority"]) {
      expect(whole, field).not.toContain(field);
    }
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("A post on a governance forum is not an approved decision because it appears there");
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("not from the kind of source this is, the site it comes from, the\nproject, the component being researched");
  });

  it("I. official documentation does not imply LIVE, and the prompt names no project", () => {
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("a documentation page is not\nan operating mechanism because it documents one");
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("an official page is not a live state because it is official");
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).not.toMatch(/lido|pump|raydium|morpho|hyperliquid|solana|snapshot|tally/i);
  });
});

describe("J — the deterministic normalizer still fails closed on everything outside the dictionary", () => {
  it("free-form, partial, decorated and empty values are UNKNOWN; only exact dictionary words (after trim/uppercase) are states", () => {
    for (const raw of ["definitely live", "approved by vote", "PROPOSED_AND_APPROVED", "", "  ", "live now", "Fee split is set by the DAO", "not live"]) {
      expect(normalizeMechanismState(raw), raw).toBe("UNKNOWN");
    }
    expect(normalizeMechanismState(null)).toBe("UNKNOWN");
    for (const state of MECHANISM_STATES) {
      expect(normalizeMechanismState(state)).toBe(state);
      expect(normalizeMechanismState(` ${state.toLowerCase()} `)).toBe(state);
    }
  });
});
