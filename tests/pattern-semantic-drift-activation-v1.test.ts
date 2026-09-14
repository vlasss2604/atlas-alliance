import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { researchPatterns, topics } from "../src/server/db/schema";
import { PATTERN_V1_CONTENT, type PatternContent } from "../src/server/domain/pattern";
import {
  PATTERN_PRESENTATION_ONLY_FIELDS,
  activatePatternVersions,
  canonicalPatternJson,
  patternActivationRequired,
  patternSemanticDifferences,
  patternSemanticFingerprint,
} from "../src/server/domain/pattern-activation";
import { loadActivePatternVersion } from "../src/server/engine/active-pattern";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

// PATTERN SEMANTIC-DRIFT ACTIVATION V1.
//
// The activation script used to activate a successor only when the
// production gate refused the ACTIVE row for a missing structural
// obligation; every other difference was printed and ignored. This suite
// pins the new rule: the code contract must replace the ACTIVE row whenever
// their SEMANTIC contracts differ — anything a Research decision or a
// provider instruction reads — and never for the one presentation-only
// field. Case F is the exact content atlas_dev's ACTIVE v2 row carried on
// 2026-09-14, captured to a fixture: it admits OFFICIAL_DOCS for
// DURABILITY_BASIS, which D-159 narrowed to GOVERNANCE.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// A deep, jsonb-shaped clone: key order scrambled the way Postgres may
// return it, so the comparison is proven order-independent.
function jsonbLike(content: PatternContent): PatternContent {
  const scramble = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scramble);
    if (v !== null && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort().reverse()) out[k] = scramble(src[k]);
      return out;
    }
    return v;
  };
  return scramble(JSON.parse(JSON.stringify(content))) as PatternContent;
}

function clone(): PatternContent {
  return JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
}

const LIDO_V2 = JSON.parse(readFileSync("tests/fixtures/atlas-dev-lido-pattern-v2-2026-09-06.json", "utf-8")) as PatternContent;

describe("the rule — what forces activation and what does not", () => {
  it("A. a semantically identical Pattern (jsonb key order, byte order irrelevant) requires no activation", () => {
    const v = patternActivationRequired(jsonbLike(PATTERN_V1_CONTENT));
    expect(v.required).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.differences).toEqual([]);
    expect(v.storedFingerprint).toBe(v.codeFingerprint);
    expect(patternSemanticFingerprint(jsonbLike(PATTERN_V1_CONTENT))).toBe(patternSemanticFingerprint(PATTERN_V1_CONTENT));
  });

  it("B. a dropped structural obligation is refused by the production gate and requires activation", () => {
    const stored = clone();
    delete stored.componentRequirements!.SOURCE_OF_VALUE.structuralObligations;
    const v = patternActivationRequired(stored);
    expect(v.required).toBe(true);
    expect(v.reason).toBe("GATE_REFUSED");
    expect(v.gateRefusal).toContain("PatternSemanticDriftError");
    expect(v.differences.some((d) => d.includes("SOURCE_OF_VALUE.structuralObligations"))).toBe(true);
  });

  it("C. a changed admissible source class with identical obligations requires activation", () => {
    const stored = clone();
    stored.componentRequirements!.DURABILITY_BASIS.establishingClasses = ["GOVERNANCE", "OFFICIAL_DOCS"];
    const v = patternActivationRequired(stored);
    expect(v.required).toBe(true);
    expect(v.reason).toBe("SEMANTIC_DRIFT");
    expect(v.gateRefusal).toBeNull();
    expect(v.differences).toEqual([
      'DIFFERS       content.componentRequirements.DURABILITY_BASIS.establishingClasses: db=["GOVERNANCE","OFFICIAL_DOCS"] code=["GOVERNANCE"]',
    ]);
  });

  it("D. every other proof-semantic field forces activation: freshness, currency gate, token-state rule, evidence goal, work queue, step order, claim requirements", () => {
    const cases: Array<[string, (c: PatternContent) => void]> = [
      ["freshnessClass", (c) => { c.componentRequirements!.FLOW_PATH.freshnessClass = "HIGH_CHANGE"; }],
      ["requiresCurrentState", (c) => { c.componentRequirements!.CURRENT_STATE.requiresCurrentState = false; }],
      ["requiresLiveMechanismState", (c) => { c.componentRequirements!.EXECUTION_EVIDENCE.requiresLiveMechanismState = false; }],
      ["tokenStateSensitive", (c) => { c.componentRequirements!.RECIPIENT.tokenStateSensitive = false; }],
      ["requiredTokenState", (c) => { c.componentRequirements!.DESTINATION.requiredTokenState = "BURNED"; }],
      ["evidenceGoal", (c) => { c.componentRequirements!.SOURCE_OF_VALUE.evidenceGoal = "anything about revenue"; }],
      ["requiredComponents", (c) => { c.requiredComponents["6"] = ["DESTINATION"]; }],
      ["step order", (c) => { const s = c.steps; [s[0].step, s[1].step] = [s[1].step, s[0].step]; }],
      ["step name (prompt title)", (c) => { c.steps[1].name = "Value Waterfall"; }],
      ["intent requirement optionality", (c) => { c.intentRequirements!.PROTOCOL_REVENUE_TO_TOKEN.requirements[1].optionality = "OPTIONAL"; }],
      ["intent requirement removed", (c) => { delete c.intentRequirements!.BURN_OR_SUPPLY_EFFECT; }],
      ["component entry removed", (c) => { delete c.componentRequirements!.NET_EFFECT; }],
    ];
    for (const [label, mutate] of cases) {
      const stored = clone();
      mutate(stored);
      const v = patternActivationRequired(stored);
      expect(v.required, label).toBe(true);
      expect(v.differences.length, label).toBeGreaterThan(0);
    }
  });

  it("E. the presentation-only step question does not force activation, and nothing else is exempt", () => {
    expect(PATTERN_PRESENTATION_ONLY_FIELDS).toEqual(["steps[].question"]);
    const stored = clone();
    for (const s of stored.steps) s.question = `${s.question} (reworded for the screen)`;
    const v = patternActivationRequired(stored);
    expect(v.required).toBe(false);
    expect(v.differences).toEqual([]);
    expect(patternSemanticDifferences(stored, PATTERN_V1_CONTENT)).toEqual([]);
    // A field the schema does not know is semantic by default — a stored
    // row carrying an extra key is not the code contract.
    const extra = clone() as PatternContent & { rendering?: unknown };
    extra.rendering = { theme: "dark" };
    expect(patternActivationRequired(extra).required).toBe(true);
  });

  it("F. the atlas_dev Lido ACTIVE v2 content (2026-09-06) is drifted against the current code contract on exactly the D-159 rule", () => {
    const v = patternActivationRequired(LIDO_V2);
    expect(v.required).toBe(true);
    expect(v.reason).toBe("SEMANTIC_DRIFT");
    expect(v.differences).toEqual([
      'DIFFERS       content.componentRequirements.DURABILITY_BASIS.establishingClasses: db=["GOVERNANCE","OFFICIAL_DOCS"] code=["GOVERNANCE"]',
    ]);
    // Same shape, same fingerprint: the fixture is the row, not a paraphrase.
    const rebuilt = clone();
    rebuilt.componentRequirements!.DURABILITY_BASIS.establishingClasses = ["GOVERNANCE", "OFFICIAL_DOCS"];
    expect(patternSemanticFingerprint(LIDO_V2)).toBe(patternSemanticFingerprint(rebuilt));
  });

  it("the rule is generic: no project, topic or job name appears in the activation module", () => {
    const src = readFileSync("src/server/domain/pattern-activation.ts", "utf-8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const forbidden of ["lido", "Lido", "LIDO", "a118fb74", "4c9996b9"]) expect(src).not.toContain(forbidden);
  });
});

describe("the activation lifecycle over a database", () => {
  async function activeTopicId(): Promise<string> {
    const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    return t.id;
  }

  it("dry run reports what it would do; apply retires the drifted row unchanged and activates the code contract; a second run has nothing to do", async () => {
    const topicId = await activeTopicId();
    // Put the database in atlas_dev's shape: v1 RETIRED (seed), v2 ACTIVE
    // with the captured drifted content.
    await ctx.db.update(researchPatterns).set({ status: "RETIRED" }).where(eq(researchPatterns.topicId, topicId));
    const [v2] = await ctx.db.insert(researchPatterns).values({ topicId, version: 2, status: "ACTIVE", content: LIDO_V2 }).returning();
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(2);

    const dry = await activatePatternVersions(ctx.db, { apply: false });
    const dryReport = dry.find((r) => r.topicId === topicId)!;
    expect(dryReport.action).toBe("WOULD_ACTIVATE");
    expect(dryReport.activeVersion).toBe(2);
    expect(dryReport.nextVersion).toBe(3);
    expect(dryReport.verdict!.reason).toBe("SEMANTIC_DRIFT");
    // Nothing written.
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(2);
    expect((await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, topicId))).length).toBe(2);

    const applied = await activatePatternVersions(ctx.db, { apply: true });
    const report = applied.find((r) => r.topicId === topicId)!;
    expect(report.action).toBe("ACTIVATED");
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(3);
    const rows = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, topicId));
    const after2 = rows.find((r) => r.version === 2)!;
    const after3 = rows.find((r) => r.version === 3)!;
    expect(after2.id).toBe(v2.id);
    expect(after2.status).toBe("RETIRED");
    expect(canonicalPatternJson(after2.content)).toBe(canonicalPatternJson(LIDO_V2));
    expect(after3.status).toBe("ACTIVE");
    expect(patternActivationRequired(after3.content).required).toBe(false);
    expect(rows.filter((r) => r.status === "ACTIVE").length).toBe(1);

    const again = await activatePatternVersions(ctx.db, { apply: true });
    expect(again.find((r) => r.topicId === topicId)!.action).toBe("NONE");
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(3);
  });
});
