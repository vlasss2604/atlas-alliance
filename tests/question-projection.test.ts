import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ResultLadder } from "../src/client/components/result-ladder";
import { deriveQuestionFindings } from "../src/client/research-model";
import {
  MAX_FINDINGS,
  MIN_FINDINGS,
  PROJECTION_VERSION,
  buildProjectionInput,
  resolveProjectionFindings,
  validateProjection,
  type ProjectionModelInput,
} from "../src/server/engine/question-projection";

// QUESTION-DRIVEN PROOF PROJECTION.
//
// A model chooses which canonical findings matter to the question a person
// asked, orders them, and names them. Canonical research decides
// everything else. These tests pin that boundary from both sides: what the
// model is structurally unable to say, and what it cannot make canonical
// state say on its behalf.
//
// The boundary is not maintained by prompt wording. The output schema has
// no field for a status, a fact, an evidence id or a reason code, and
// every reference is checked against the exact set supplied as input — so
// a model that ignored the entire system prompt still could not assert
// anything about a project.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const COMPONENTS = [
  { patternStep: 1, component: "SOURCE_OF_VALUE", status: "SUPPORTED" },
  { patternStep: 3, component: "MECHANISM_SPEC", status: "SUPPORTED" },
  { patternStep: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" },
  { patternStep: 6, component: "DESTINATION", status: "SUPPORTED" },
  { patternStep: 7, component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED" },
];

function input(over: Partial<ProjectionModelInput> = {}): ProjectionModelInput {
  return {
    ...buildProjectionInput({
      question: "Where do the fees go, and what happens to the bought-back token?",
      intent: "PROTOCOL_REVENUE_TO_TOKEN",
      components: COMPONENTS.map((c) => ({
        ...c,
        reasonCodes: [],
        coverage: "COMPLETED",
        supportingEvidenceIds: ["e1"],
        contradictingEvidenceIds: [],
      })),
      requirements: [
        { requirementId: "PRT-1", kind: "COMPONENT_ESTABLISHED", status: "SATISFIED", evidenceCount: 2 },
        { requirementId: "PRT-2", kind: "FLOW_RELATIONSHIP", status: "UNSATISFIED", evidenceCount: 0 },
      ],
    }),
    ...over,
  };
}

const ref = (step: number, component: string) => ({ kind: "COMPONENT" as const, step, component });

const finding = (label: string, step: number, component: string, supporting: unknown[] = []) => ({
  userFacingLabel: label,
  primaryRef: ref(step, component),
  supportingRefs: supporting,
});

const TWO_GOOD = [
  finding("Where do the fees come from?", 1, "SOURCE_OF_VALUE"),
  finding("Is the mechanism running now?", 4, "EXECUTION_EVIDENCE"),
];

/* ------------------------------------------------------------------ */
/* 1-2. REFERENCES ARE CLOSED                                          */
/* ------------------------------------------------------------------ */

describe("projection — a model may only name what it was given", () => {
  it("TEST 1: a projection over supplied references validates", () => {
    const result = validateProjection({ findings: TWO_GOOD }, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings.map((f) => f.primaryRef.component)).toEqual([
      "SOURCE_OF_VALUE",
      "EXECUTION_EVIDENCE",
    ]);
  });

  it("TEST 2: an invented canonical reference fails closed", () => {
    // The failure mode this guard exists for: a model recalling a
    // plausible component name that this job never produced.
    for (const bad of [
      // A component this job never produced.
      finding("Is it burned?", 9, "TOKEN_BURN_EVIDENCE"),
      // A real component name at the wrong step — the pair is the key, so
      // half a correct reference is still not a reference.
      finding("Where does it go?", 5, "DESTINATION"),
      // A component of the Pattern that this job did not assess.
      finding("Who receives it?", 6, "RECIPIENT"),
    ]) {
      const result = validateProjection({ findings: [TWO_GOOD[0], bad] }, input());
      expect(result.ok, bad.primaryRef.component).toBe(false);
      if (!result.ok) expect(result.rejection, bad.primaryRef.component).toBe("UNKNOWN_REF");
    }

    // A structurally impossible step never even reaches the ref check.
    const outOfRange = validateProjection(
      { findings: [TWO_GOOD[0], finding("Where does it go?", 99, "DESTINATION")] },
      input(),
    );
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.rejection).toBe("SCHEMA_INVALID");
  });

  it("TEST 2b: an invented reference in supportingRefs fails just as closed", () => {
    const result = validateProjection(
      { findings: [TWO_GOOD[0], finding("Is it running?", 4, "EXECUTION_EVIDENCE", [ref(6, "RECIPIENT")])] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("UNKNOWN_REF");
  });

  it("TEST 2c: S7 requirements are context, never referenceable", () => {
    // They are supplied to the model so it knows what the intent demanded,
    // but their status vocabulary differs from the component vocabulary
    // the screen renders, and an UNSATISFIED requirement can have no
    // component and no evidence at all. Referencing one is UNKNOWN_REF.
    const i = input();
    expect(i.requirements.map((r) => r.requirementId)).toEqual(["PRT-1", "PRT-2"]);
    const result = validateProjection(
      { findings: [TWO_GOOD[0], { userFacingLabel: "Fees reach the token?", primaryRef: { kind: "REQUIREMENT", requirementId: "PRT-2" }, supportingRefs: [] }] },
      i,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("SCHEMA_INVALID");
  });
});

/* ------------------------------------------------------------------ */
/* 3-6. THE MODEL CANNOT SPEAK ABOUT TRUTH                             */
/* ------------------------------------------------------------------ */

describe("projection — status is canonical, never model output", () => {
  it("TEST 3: the output schema has no field for a status, fact or evidence id", () => {
    const src = readFileSync("src/server/engine/question-projection.ts", "utf-8");
    // Comments in that block explain WHY a status field must not exist, so
    // they legitimately contain the word — strip them before scanning, or
    // the documentation trips its own guard.
    const schema = src
      .slice(
        src.indexOf("export const projectionFindingSchema"),
        src.indexOf("export const projectionOutputSchema"),
      )
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Three fields, and none of them can carry a claim.
    expect(schema).toContain("userFacingLabel");
    expect(schema).toContain("primaryRef");
    expect(schema).toContain("supportingRefs");
    for (const forbidden of ["status", "verdict", "evidenceId", "reasonCode", "fact", "explanation"]) {
      expect(schema, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 3b: a status supplied by the model is discarded, not honoured", () => {
    // Extra keys are stripped by the schema rather than carried through.
    const result = validateProjection(
      {
        findings: [
          { ...TWO_GOOD[0], status: "SUPPORTED", verdict: "SUPPORTED" },
          { ...TWO_GOOD[1], status: "SUPPORTED" },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const f of result.findings) {
      expect(Object.keys(f).sort()).toEqual(["primaryRef", "supportingRefs", "userFacingLabel"]);
    }
  });

  it("TEST 4: status comes from the canonical component row the finding points at", () => {
    const rows = deriveQuestionFindings(
      [
        { label: "Where do the fees come from?", patternStep: 1, component: "SOURCE_OF_VALUE", supportingComponents: [] },
        { label: "Is the mechanism running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
      ],
      COMPONENTS.map((c) => ({ ...c, coverage: "COMPLETED" as const })),
    );
    expect(rows.map((r) => r.stateLabel)).toEqual(["Established", "Not established"]);
    // The label is the model's; every other word on the row is canonical.
    expect(rows[0].label).toBe("Where do the fees come from?");
  });

  it("TEST 5: a label cannot strengthen an unresolved or partial canonical status", () => {
    // The adversarial case: a flattering label over a canonical row that
    // does not support it. The status beside it is unmoved.
    const rows = deriveQuestionFindings(
      [
        { label: "Bought-back tokens are removed from supply", patternStep: 7, component: "NET_EFFECT", supportingComponents: [] },
        { label: "The buyback runs continuously", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
      ],
      COMPONENTS.map((c) => ({ ...c, coverage: "COMPLETED" as const })),
    );
    expect(rows[0].state).toBe("PARTIAL");
    expect(rows[0].stateLabel).toBe("Partly established");
    expect(rows[1].state).toBe("UNRESOLVED");
    expect(rows[1].stateLabel).toBe("Not established");
    expect(rows.some((r) => r.state === "VERIFIED")).toBe(false);
  });

  it("TEST 5b: a label that states a status is refused outright", () => {
    // A label is presentation. One that asserts a status is a claim, and
    // the canonical status beside it may say the opposite — leaving a
    // reader no way to tell which to believe.
    for (const label of [
      "Buyback execution is established",
      "Supply reduction verified",
      "Destination confirmed",
      "This is not supported",
    ]) {
      const result = validateProjection(
        { findings: [TWO_GOOD[0], finding(label, 4, "EXECUTION_EVIDENCE")] },
        input(),
      );
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.rejection).toBe("LABEL_UNUSABLE");
    }
  });

  it("TEST 6: a contradiction stays a contradiction under any label", () => {
    const rows = deriveQuestionFindings(
      [{ label: "Where does the value end up?", patternStep: 6, component: "DESTINATION", supportingComponents: [] }],
      [{ component: "DESTINATION", status: "CONTRADICTED", coverage: "COMPLETED" }],
    );
    expect(rows[0].state).toBe("NOT_HAPPENING");
    expect(rows[0].stateLabel).toBe("Evidence indicates otherwise");
  });

  it("TEST 7: a technical limitation survives the projection unchanged", () => {
    const rows = deriveQuestionFindings(
      [{ label: "Is the mechanism running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] }],
      [
        {
          component: "EXECUTION_EVIDENCE",
          status: "INSUFFICIENT_EVIDENCE",
          reasonCodes: ["NO_EVIDENCE_FOUND"],
          coverage: "BLOCKED",
        },
      ],
    );
    expect(rows[0].coverage).toBe("BLOCKED");
    expect(rows[0].limitation).toContain("not evidence for or against the project");
    // Still not a contradiction: a run that could not look says nothing.
    expect(rows[0].state).toBe("UNRESOLVED");
  });
});

/* ------------------------------------------------------------------ */
/* 8-9. EVIDENCE BELONGS TO A FINDING                                  */
/* ------------------------------------------------------------------ */

describe("projection — evidence reaches a finding only through canonical provenance", () => {
  it("TEST 8: a finding's evidence counts come from its own component row", () => {
    const rows = deriveQuestionFindings(
      [
        { label: "Where do the fees come from?", patternStep: 1, component: "SOURCE_OF_VALUE", supportingComponents: [] },
        { label: "Is it running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
      ],
      [
        {
          component: "SOURCE_OF_VALUE",
          status: "SUPPORTED",
          coverage: "COMPLETED",
          supportingEvidenceIds: ["e1", "e2"],
          excludedEvidence: [{ evidenceId: "e9", reason: "DUPLICATE_UNIT" }],
        },
        { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
      ],
    );
    expect(rows[0].admittedCount).toBe(2);
    expect(rows[0].refusedCount).toBe(1);
    // The unrelated finding does not inherit any of it.
    expect(rows[1].admittedCount).toBe(0);
    expect(rows[1].refusedCount).toBe(0);
    expect(rows[1].checkedSummary).not.toContain("2");
  });

  it("TEST 9: a finding cannot claim a component that produced no result", () => {
    // A reference that no longer resolves is DROPPED, never rendered
    // against some other row's status.
    const rows = deriveQuestionFindings(
      [
        { label: "Where do the fees come from?", patternStep: 1, component: "SOURCE_OF_VALUE", supportingComponents: [] },
        { label: "How durable is it?", patternStep: 8, component: "DURABILITY_BASIS", supportingComponents: [] },
      ],
      [{ component: "SOURCE_OF_VALUE", status: "SUPPORTED", coverage: "COMPLETED" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].component).toBe("SOURCE_OF_VALUE");
  });

  it("TEST 9b: the server re-resolves a stored projection against live rows", () => {
    const stored = [
      finding("Where do the fees come from?", 1, "SOURCE_OF_VALUE"),
      finding("Is it burned?", 7, "NET_EFFECT"),
    ];
    // NET_EFFECT is gone from this job's canonical rows — a replayed job,
    // a Pattern change. Its finding drops rather than rendering.
    const resolved = resolveProjectionFindings(stored, [{ patternStep: 1, component: "SOURCE_OF_VALUE" }]);
    expect(resolved).toHaveLength(1);
    expect(resolved![0].component).toBe("SOURCE_OF_VALUE");
    // And when nothing resolves at all, the caller gets null and the UI
    // falls back rather than showing an empty "findings" section.
    expect(resolveProjectionFindings(stored, [])).toBeNull();
    expect(resolveProjectionFindings("not-an-array", [])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 10-13. BOUNDS AND FAIL-CLOSED                                       */
/* ------------------------------------------------------------------ */

describe("projection — bounded, and malformed output never renders", () => {
  it("TEST 10: a focused result is a few findings, not the component grid", () => {
    expect(MIN_FINDINGS).toBe(2);
    expect(MAX_FINDINGS).toBe(5);
    const all = COMPONENTS.map((c) => finding(`About ${c.patternStep}`, c.patternStep, c.component));
    // Five is the ceiling and validates; a sixth is refused rather than
    // silently trimmed, because truncating would present overflow as
    // though it had been a deliberate selection.
    expect(validateProjection({ findings: all }, input()).ok).toBe(true);
    const six = validateProjection(
      { findings: [...all, finding("One more", 1, "SOURCE_OF_VALUE")] },
      input(),
    );
    expect(six.ok).toBe(false);
  });

  it("TEST 10b: too few findings has not answered the question", () => {
    const result = validateProjection({ findings: [TWO_GOOD[0]] }, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("TOO_FEW_FINDINGS");
  });

  it("TEST 11: a duplicate primary reference fails closed", () => {
    // One canonical result shown under two names would put one status on
    // the screen twice, as though it were two independent findings.
    const result = validateProjection(
      { findings: [TWO_GOOD[0], finding("Also about fees", 1, "SOURCE_OF_VALUE")] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("DUPLICATE_PRIMARY");
  });

  it("TEST 11b: a finding cannot support itself", () => {
    const result = validateProjection(
      { findings: [TWO_GOOD[0], finding("Is it running?", 4, "EXECUTION_EVIDENCE", [ref(4, "EXECUTION_EVIDENCE")])] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("SELF_SUPPORTING_REF");
  });

  it("TEST 12: malformed output fails closed rather than rendering partially", () => {
    for (const bad of [null, undefined, 42, "text", {}, { findings: null }, { findings: [] }, { findings: [{}] }]) {
      const result = validateProjection(bad, input());
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("TEST 13: a partially-valid projection admits nothing", () => {
    // Half a relevance judgment is not a safer relevance judgment. One
    // bad finding rejects the whole projection and the reader gets the
    // canonical fallback, not a silently shortened list.
    const result = validateProjection(
      { findings: [...TWO_GOOD, finding("Is it burned?", 9, "INVENTED")] },
      input(),
    );
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 14-17. NO HACKS, NO SECOND ENGINE, NO PER-RENDER CALLS              */
/* ------------------------------------------------------------------ */

describe("projection — the boundaries that keep it presentation", () => {
  it("TEST 14: the input carries statuses and ids, never content", () => {
    const i = input();
    const serialised = JSON.stringify(i);
    // No document text, no fragments, no urls, no source bodies.
    expect(serialised).not.toContain("http");
    expect(serialised).not.toContain("fragment");
    expect(serialised).not.toContain("normalizedText");
    // Each component contributes exactly the six compact fields.
    for (const c of i.components) {
      expect(Object.keys(c).sort()).toEqual([
        "component",
        "coverage",
        "evidenceCount",
        "reasonCodes",
        "status",
        "step",
      ]);
    }
  });

  it("TEST 15: no keyword mapping and no project-specific rule exists", () => {
    for (const file of [
      "src/server/engine/question-projection.ts",
      "src/server/engine/question-projection-store.ts",
      "src/server/engine/providers/question-projection-anthropic.ts",
    ]) {
      const src = readFileSync(file, "utf-8");
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      // The model exists precisely so English keyword mapping does not.
      for (const token of ["burn", "buyback", "Raydium", "raydium", "RAY", "pump", "fees"]) {
        expect(code, `${file}:${token}`).not.toContain(token);
      }
      // And no component name is special-cased into relevance.
      for (const token of ["SOURCE_OF_VALUE", "NET_EFFECT", "DESTINATION"]) {
        expect(code, `${file}:${token}`).not.toContain(token);
      }
    }
  });

  it("TEST 16: the provider is tool-free and cannot widen the research", () => {
    const src = readFileSync("src/server/engine/providers/question-projection-anthropic.ts", "utf-8");
    // No tools, no server-side tool config, no fetch of its own.
    expect(src).not.toContain("tools:");
    expect(src).not.toContain("tool_choice");
    expect(src).not.toContain("web_search");
    expect(src).not.toMatch(/\bfetch\(/);
    // One generation call, count-then-gated first.
    expect(src).toContain("countThenGate");
    expect((src.match(/messages\.create\(/g) ?? [])).toHaveLength(1);
  });

  it("TEST 17: only the post-research path can generate; no read path can", () => {
    // The whole cost and repeatability guarantee, expressed structurally.
    const store = readFileSync("src/server/engine/question-projection-store.ts", "utf-8");
    expect(store).toContain("ALREADY_EXISTS");
    expect(store).toContain("projectionVersion, PROJECTION_VERSION");

    // run-job.ts generates, exactly once, after the Proof is built.
    const runJob = readFileSync("src/server/engine/run-job.ts", "utf-8");
    expect(runJob).toContain("generateQuestionProjectionSafely(db, jobId)");
    // The CALL, not the import at the top of the file: the projection is
    // the last thing the job does, strictly after the Proof it arranges.
    expect(runJob.lastIndexOf("buildAndPersistProof(db, jobId)")).toBeLessThan(
      runJob.indexOf("generateQuestionProjectionSafely(db, jobId)"),
    );

    // The result route READS and never generates.
    const route = readFileSync("app/api/research-jobs/[id]/route.ts", "utf-8");
    expect(route).toContain("researchQuestionProjections");
    expect(route).not.toContain("generateQuestionProjection");
    expect(route).not.toContain("question-projection-anthropic");
    // Only a VALID row is projected; a persisted failure stops a retry
    // and is never shown as a research outcome.
    expect(route).toContain('projectionRow?.status === "VALID"');

    // No client file may reach the provider at all.
    for (const file of [
      "src/client/research-model.ts",
      "src/client/components/result-ladder.tsx",
      "app/(app)/research/[id]/page.tsx",
    ]) {
      expect(readFileSync(file, "utf-8"), file).not.toContain("question-projection-anthropic");
    }
  });

  it("TEST 17b: a terminal failure is persisted, so it is never retried", () => {
    const store = readFileSync("src/server/engine/question-projection-store.ts", "utf-8");
    expect(store).toContain('persist("FAILED_MODEL"');
    expect(store).toContain('persist("FAILED_VALIDATION"');
    // Neither stores partial findings.
    expect(store).toContain('persist("FAILED_MODEL", [], ');
    expect(store).toContain('persist("FAILED_VALIDATION", [], ');
  });

  it("TEST 18: a projection failure cannot change the research outcome", () => {
    const store = readFileSync("src/server/engine/question-projection-store.ts", "utf-8");
    // Every failure path RETURNS an outcome; the caller's wrapper swallows
    // even the unexpected. Nothing here writes to a research artifact.
    expect(store).toContain("export async function generateQuestionProjectionSafely");
    expect(store).toContain("catch {\n    return { kind: \"FAILED_MODEL\" };");
    for (const table of [
      "researchJobs)\n      .set",
      "update(proofs",
      "update(researchClaimSupport",
      "update(researchComponentResults",
    ]) {
      expect(store, table).not.toContain(table);
    }
    // The only table it writes is its own.
    expect((store.match(/\.insert\(/g) ?? [])).toHaveLength(1);
    expect(store).toContain(".insert(researchQuestionProjections)");
  });

  it("TEST 19: cost is recorded from the approved catalogue, per call", () => {
    const store = readFileSync("src/server/engine/question-projection-store.ts", "utf-8");
    expect(store).toContain("calculateActualCostMicro(profile, usage)");
    expect(store).toContain("priceVersion");
    // Fails closed when no approved (role, model) profile exists — no
    // call is made at an unpriced ceiling.
    expect(store).toContain("NO_COST_PROFILE");
    const profiles = readFileSync("src/server/engine/model-cost-profile.ts", "utf-8");
    expect(profiles).toContain('catalogueKey("PROJECTION", "claude-haiku-4-5")');
  });
});

/* ------------------------------------------------------------------ */
/* 20. THE SCREEN                                                      */
/* ------------------------------------------------------------------ */

describe("projection — the question shapes the default screen", () => {
  const ladderComponents = COMPONENTS.map((c) => ({ ...c, coverage: "COMPLETED" as const }));

  it("TEST 20: with a projection, only question-relevant findings render", () => {
    const html = render(
      createElement(ResultLadder, {
        components: ladderComponents,
        questionFindings: [
          { label: "Where do the trading fees go?", patternStep: 1, component: "SOURCE_OF_VALUE", supportingComponents: [] },
          { label: "Is the buyback running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
        ],
      }),
    );
    expect(html.match(/data-testid="ladder-row"/g) ?? []).toHaveLength(2);
    expect(html).toContain("Where do the trading fees go?");
    expect(html).toContain("Key findings");
    // The Pattern's own grouping is absent from the default screen.
    expect(html).not.toContain("How the mechanism stands");
    expect(html).not.toContain("What the evidence says about the value");
    // And no internal component vocabulary reaches a label.
    const visible = html.replace(/data-component="[^"]*"/g, "");
    for (const name of COMPONENTS.map((c) => c.component)) {
      expect(visible, name).not.toContain(name);
    }
  });

  it("TEST 20b: without a projection the Pattern ladder is the fallback", () => {
    for (const fallback of [null, undefined, []]) {
      const html = render(
        createElement(ResultLadder, { components: ladderComponents, questionFindings: fallback }),
      );
      expect(html).toContain("How the mechanism stands");
      expect(html).not.toContain("Key findings");
    }
  });

  it("TEST 20c: the full audit still carries every component", () => {
    const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf-8");
    expect(page).toContain("Full research audit");
    expect(page).toContain('data-testid="audit-full-ladder"');
    // The audit ladder is passed the components WITHOUT questionFindings,
    // so it renders the Pattern's own complete grouping.
    const audit = page.slice(page.indexOf('data-testid="audit-full-ladder"'));
    expect(audit.slice(0, 400)).toContain("<ResultLadder");
    expect(audit.slice(0, 400)).not.toContain("questionFindings");
  });

  it("TEST 20d: the stated boundary prefers a hard stop over a partial one", () => {
    const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf-8");
    // A row established by NOTHING is a harder stop than one established
    // in part, even when the projection ordered the partial row first.
    const unresolvedAt = page.indexOf('questionRows.find((r) => r.state === "UNRESOLVED")');
    const partialAt = page.indexOf('questionRows.find((r) => r.state === "PARTIAL")');
    expect(unresolvedAt).toBeGreaterThan(-1);
    expect(partialAt).toBeGreaterThan(-1);
    expect(unresolvedAt).toBeLessThan(partialAt);
    // A contradiction is a finding, not a boundary, and never becomes one.
    const boundaryBlock = page.slice(unresolvedAt - 200, partialAt + 200);
    expect(boundaryBlock).not.toContain("NOT_HAPPENING");
  });

  it("TEST 21: the projection version is what authorises regeneration", () => {
    expect(PROJECTION_VERSION).toBe(1);
    const schema = readFileSync("src/server/db/schema/projection.ts", "utf-8");
    expect(schema).toContain("uq_research_question_projections_job_version");
    const migration = readFileSync("src/server/db/migrations/0040_question_projection.sql", "utf-8");
    expect(migration).toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain("research_job_id");
    expect(migration).toContain("projection_version");
    // Additive only — no existing table or column is touched.
    expect(migration).not.toContain("DROP");
    expect(migration).not.toContain("ALTER TABLE \"proofs\"");
    expect(migration).not.toContain("ALTER TABLE \"research_jobs\"");
  });
});
