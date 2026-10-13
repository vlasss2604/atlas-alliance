import { describe, expect, it } from "vitest";

import {
  auditCounts,
  proofStateOfRung,
  auditStoodUp,
  composeAudit,
  MAX_GAPS,
  MAX_STOOD_UP,
  type AuditComposition,
} from "../src/client/audit-composition";
import { chooseAnalyticalBlocks, type AnalyticalOutputInputV1 } from "../src/client/output-plan";
import { OUTPUT_PLAN_FIXTURES, GOLDEN_AUDIT_FIXTURE, outputPlanFixture } from "../src/client/output-plan-fixtures";
import { deriveResultLadder, type LadderComponentInput } from "../src/client/research-model";
import { deriveQuestionFindings } from "../src/client/research-model";
import { isLabelSafe, labelSafety, neutralLabelFor } from "../src/shared/projection-label-safety";
import {
  allowedRefKeys,
  buildProjectionInput,
  MAX_FINDINGS,
  MIN_FINDINGS,
  refKey,
  resolveProjectionFindings,
  validateProjection,
  type ProjectionModelInput,
} from "../src/server/engine/question-projection";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 9: THE OUTPUT BOUNDARY.
//
// Every previous round stopped at the Proof. Rounds 1–6 asked whether the
// Proof was right, Round 7 whether two Proofs agreed, Round 8 whether a
// role could be manufactured inside one. None of them looked at the last
// hop — from the persisted record to the sentence a paying reader
// actually reads.
//
// That hop has its own way of lying, and it is not the reducer's:
//
//   a PARTLY established check presented where an established one belongs
//   a blocked check counted as a check that was made
//   a gap rendered as a contradiction
//   a count that becomes a score
//   a model-authored label that makes a claim the record does not support
//   a stored label resolved against some OTHER row's status
//   a weaker Proof producing a stronger-looking page
//   one job's projection rendering on another job
//
// The question this round asks, of every surface between the Proof and
// the screen: CAN A READER BE SHOWN MORE THAN THE RECORD PROVES?
//
// Production functions only — the real `composeAudit`, the real ladder,
// the real projection validator and resolver. Pure: no DB, no model, no
// network, no spend. Not a replay of Round 8: nothing here touches roles,
// entitlement, destinations or the assembler.

type Fixture = { input: ReturnType<typeof outputPlanFixture>["input"]; auditComponents?: readonly LadderComponentInput[] };
const ALL: Fixture[] = [...OUTPUT_PLAN_FIXTURES, GOLDEN_AUDIT_FIXTURE];
const auditOf = (f: Fixture): AuditComposition =>
  composeAudit({ input: f.input, components: f.auditComponents ?? f.input.components, outcomeKind: "VERDICT" });

const row = (component: string, status: string, reasonCodes: string[] = [], coverage?: LadderComponentInput["coverage"]): LadderComponentInput => ({
  component,
  status,
  reasonCodes,
  supportingEvidenceIds: status === "INSUFFICIENT_EVIDENCE" ? [] : ["e"],
  contradictingEvidenceIds: status === "CONTRADICTED" ? ["c"] : [],
  coverage,
});

const COMPONENTS = ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "EXECUTION_EVIDENCE", "CURRENT_STATE", "DESTINATION", "RECIPIENT", "NET_EFFECT"] as const;

// ====================================================================
describe("A. THE PROJECTION LABEL GUARD — what claims actually survive it", () => {
  const input: ProjectionModelInput = buildProjectionInput({
    question: "do holders receive value?",
    intent: "PASSIVE_HOLDER_OUTCOME",
    components: COMPONENTS.map((c, i) => ({
      patternStep: i + 1,
      component: c,
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["INSUFFICIENT_AUTHORITY"],
      coverage: "COVERED",
      supportingEvidenceIds: ["e1"],
      contradictingEvidenceIds: [],
    })),
    requirements: [{ requirementId: "PHO-1", kind: "FLOW_ATTRIBUTE", status: "PARTIAL", evidenceCount: 1 }],
  });
  const refOf = (i: number) => ({ kind: "COMPONENT" as const, step: i + 1, component: COMPONENTS[i] });
  const withLabels = (labels: string[]) => ({
    findings: labels.map((userFacingLabel, i) => ({ userFacingLabel, primaryRef: refOf(i), supportingRefs: [] })),
  });

  it("A1. the guard rejects every status word it names — that part holds", () => {
    for (const word of ["established", "supported", "not supported", "contradicted", "verified", "proven", "confirmed", "insufficient", "unestablished", "disproven"]) {
      const r = validateProjection(withLabels([`revenue is ${word}`, "a second finding"]), input);
      expect(r.ok, word).toBe(false);
      if (!r.ok) expect(r.rejection, word).toBe("LABEL_UNUSABLE");
    }
  });

  it("A2 (FIXED, Founder decision). PRESENTATION MUST NOT CREATE NEW TRUTH: a label may not add certainty, magnitude, direction or economic meaning the record does not carry — each refused on its own named axis", () => {
    const byAxis: [string, string][] = [
      ["MAGNITUDE", "50% of all fees reach the token"],
      ["MAGNITUDE", "every epoch burns 1,000,000 tokens"],
      ["MAGNITUDE", "significant revenue"],
      ["MAGNITUDE", "large treasury balance"],
      ["CERTAINTY", "holders definitely receive value"],
      ["CERTAINTY", "yes, revenue reaches the token"],
      ["CERTAINTY", "the buyback is real and ongoing"],
      ["CERTAINTY", "fees are never sent to holders"],
      ["DIRECTION", "supply decreased over the interval"],
      ["DIRECTION", "revenue is growing"],
      ["STATUS", "revenue is proven"],
    ];
    for (const [axis, claim] of byAxis) {
      const r = validateProjection(withLabels([claim, "a second finding"]), input);
      expect(r.ok, `${axis}: ${claim}`).toBe(false);
      if (!r.ok) expect(r.rejection, claim).toBe("LABEL_UNUSABLE");
      const direct = labelSafety(null, claim);
      expect(direct.safe, claim).toBe(false);
      if (!direct.safe) expect(direct.rejection, claim).toBe(axis);
    }
  });

  it("A2b. the economic envelope is per component: a label outside a component's canonical meaning is refused for THAT component and is ordinary copy elsewhere", () => {
    expect(labelSafety("NET_EFFECT", "the effect on token value").safe).toBe(false);
    expect(labelSafety("NET_EFFECT", "the effect on token supply").safe).toBe(true);
    expect(labelSafety("SOURCE_OF_VALUE", "where the fees end up").safe).toBe(false);
    expect(labelSafety("SOURCE_OF_VALUE", "where the fees come from").safe).toBe(true);
    expect(labelSafety("MECHANISM_SPEC", "the buyback is live").safe).toBe(false);
  });

  it("A2c. a NEUTRAL record still gets ordinary naming copy: names, questions and identifiers with digits inside a word are not refused", () => {
    for (const label of [
      "where the revenue comes from",
      "what the fees pay for",
      "who receives the distribution",
      "ERC-20 supply",
      "v2 revenue split",
      "the route from fees to the token",
    ]) {
      expect(labelSafety(null, label).safe, label).toBe(true);
    }
    const ok = validateProjection(withLabels(["where the revenue comes from", "what the fees pay for"]), input);
    expect(ok.ok).toBe(true);
  });

  it("A3 (FIXED, Founder decision). THE RULE RUNS ON READ TOO: a stored label that would strengthen the page is NEUTRALISED to the component's own canonical name, and the safe twin is passed through untouched", () => {
    const live = COMPONENTS.map((c, i) => ({ patternStep: i + 1, component: c }));
    const unsafe = [
      { userFacingLabel: "revenue is proven", primaryRef: refOf(0), supportingRefs: [] },
      { userFacingLabel: "50% of fees reach the token", primaryRef: refOf(1), supportingRefs: [] },
      { userFacingLabel: "holders definitely receive value", primaryRef: refOf(2), supportingRefs: [] },
    ];
    const resolved = resolveProjectionFindings(unsafe, live)!;
    expect(resolved.length).toBe(3);
    for (const f of resolved) {
      expect(labelSafety(f.component, f.label).safe, f.label).toBe(true);
      expect(f.label).toBe(neutralLabelFor(f.component));
    }
    // The pointer survives the neutralisation — only the copy is replaced.
    expect(resolved.map((f) => f.component)).toEqual([COMPONENTS[0], COMPONENTS[1], COMPONENTS[2]]);

    // A safe stored label is returned exactly as stored.
    const safe = [{ userFacingLabel: "where the revenue comes from", primaryRef: refOf(0), supportingRefs: [] }];
    expect(resolveProjectionFindings(safe, live)![0].label).toBe("where the revenue comes from");
  });

  it("A3b. the renderer applies the identical rule, so an unsafe label cannot reach a row even if it reached the payload", () => {
    const components = COMPONENTS.map((c) => ({ component: c, status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["e"], contradictingEvidenceIds: [] }));
    const rows = deriveQuestionFindings(
      [
        { label: "50% of fees reach the token", patternStep: 1, component: "SOURCE_OF_VALUE", supportingComponents: [] },
        { label: "where the revenue comes from", patternStep: 1, component: "FLOW_PATH", supportingComponents: [] },
      ],
      components,
    );
    for (const r of rows) expect(labelSafety(null, r.label).safe, r.label).toBe(true);
    expect(rows.some((r) => r.label === "50% of fees reach the token")).toBe(false);
    expect(rows.some((r) => r.label === "where the revenue comes from")).toBe(true);
  });

  it("A3c. order, duplication and permutation do not change which labels are safe", () => {
    const live = COMPONENTS.map((c, i) => ({ patternStep: i + 1, component: c }));
    const stored = [
      { userFacingLabel: "50% of fees reach the token", primaryRef: refOf(0), supportingRefs: [] },
      { userFacingLabel: "where the revenue comes from", primaryRef: refOf(1), supportingRefs: [] },
    ];
    const a = resolveProjectionFindings(stored, live)!.map((f) => f.label);
    const b = resolveProjectionFindings([...stored].reverse(), live)!.map((f) => f.label).reverse();
    expect(a).toEqual(b);
    const dup = resolveProjectionFindings([...stored, ...stored], live)!;
    expect(dup.length).toBe(2);
    for (const f of dup) expect(labelSafety(f.component, f.label).safe).toBe(true);
  });
});

// ====================================================================
describe("B. REFERENCE CLOSURE — a label may never be rendered against another row's status", () => {
  const live = COMPONENTS.map((c, i) => ({ patternStep: i + 1, component: c }));
  const input: ProjectionModelInput = buildProjectionInput({
    question: "q",
    intent: "PROTOCOL_REVENUE_TO_TOKEN",
    components: live.map((c) => ({ ...c, status: "SUPPORTED", reasonCodes: [], coverage: "COVERED", supportingEvidenceIds: ["e"], contradictingEvidenceIds: [] })),
    requirements: [{ requirementId: "PRT-1", kind: "COMPONENT_ESTABLISHED", status: "SATISFIED", evidenceCount: 1 }],
  });

  it("B1. an invented, drifted or requirement-shaped reference is rejected, never rendered", () => {
    const bad = [
      { kind: "COMPONENT" as const, step: 1, component: "NOT_A_COMPONENT" },
      { kind: "COMPONENT" as const, step: 42, component: "SOURCE_OF_VALUE" },
      { kind: "COMPONENT" as const, step: 1, component: "PRT-1" },
    ];
    for (const primaryRef of bad) {
      const r = validateProjection({ findings: [{ userFacingLabel: "a", primaryRef, supportingRefs: [] }, { userFacingLabel: "b", primaryRef: { kind: "COMPONENT", step: 2, component: "FLOW_PATH" }, supportingRefs: [] }] }, input);
      expect(r.ok, JSON.stringify(primaryRef)).toBe(false);
      if (!r.ok) expect(r.rejection).toBe("UNKNOWN_REF");
    }
    expect(allowedRefKeys(input).has(refKey({ kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }))).toBe(true);
  });

  it("B2. a finding whose canonical row has vanished is DROPPED, never re-pointed at a surviving row", () => {
    const stored = [
      { userFacingLabel: "the source of value", primaryRef: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [] },
      { userFacingLabel: "a component this Pattern no longer has", primaryRef: { kind: "COMPONENT", step: 9, component: "GONE" }, supportingRefs: [] },
    ];
    const resolved = resolveProjectionFindings(stored, live)!;
    expect(resolved.map((f) => f.component)).toEqual(["SOURCE_OF_VALUE"]);
    // The surviving finding kept ITS OWN key — the vanished one did not
    // slide onto it.
    expect(resolved[0].patternStep).toBe(1);
  });

  it("B3. when EVERY finding drops, the resolver returns null so the UI falls back to the canonical result rather than rendering an empty answer", () => {
    const stored = [{ userFacingLabel: "gone", primaryRef: { kind: "COMPONENT", step: 9, component: "GONE" }, supportingRefs: [] }];
    expect(resolveProjectionFindings(stored, live)).toBeNull();
    expect(resolveProjectionFindings([], live)).toBeNull();
    expect(resolveProjectionFindings("not an array", live)).toBeNull();
    expect(resolveProjectionFindings([{ nonsense: true }], live)).toBeNull();
  });

  it("B4. CROSS-JOB LEAKAGE: a projection written for one job resolves to nothing against another job's component rows", () => {
    const otherJobRows = [{ patternStep: 3, component: "GOVERNANCE_BASIS" }];
    const stored = [
      { userFacingLabel: "where the revenue comes from", primaryRef: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [] },
      { userFacingLabel: "where it goes", primaryRef: { kind: "COMPONENT", step: 6, component: "DESTINATION" }, supportingRefs: [] },
    ];
    expect(resolveProjectionFindings(stored, otherJobRows)).toBeNull();
  });

  it("B5. a finding never corroborates itself, and never counts one row twice", () => {
    const self = { findings: [{ userFacingLabel: "a", primaryRef: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [{ kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }] }, { userFacingLabel: "b", primaryRef: { kind: "COMPONENT", step: 2, component: "FLOW_PATH" }, supportingRefs: [] }] };
    const r1 = validateProjection(self, input);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.rejection).toBe("SELF_SUPPORTING_REF");

    const dup = { findings: [{ userFacingLabel: "a", primaryRef: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [] }, { userFacingLabel: "b", primaryRef: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [] }] };
    const r2 = validateProjection(dup, input);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.rejection).toBe("DUPLICATE_PRIMARY");

    // And a duplicate SUPPORTING ref is de-duplicated, never counted twice.
    const dupSupport = { findings: [
      { userFacingLabel: "a", primaryRef: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [{ kind: "COMPONENT", step: 2, component: "FLOW_PATH" }, { kind: "COMPONENT", step: 2, component: "FLOW_PATH" }] },
      { userFacingLabel: "b", primaryRef: { kind: "COMPONENT", step: 3, component: "MECHANISM_SPEC" }, supportingRefs: [] },
    ] };
    const r3 = validateProjection(dupSupport, input);
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.findings[0].supportingRefs.length).toBe(1);
  });

  it("B6. the count bounds fail closed in both directions — an overflowing answer is never silently trimmed into looking deliberate", () => {
    const many = { findings: COMPONENTS.slice(0, MAX_FINDINGS + 1).map((c, i) => ({ userFacingLabel: `finding ${"x".repeat(i + 1)}`, primaryRef: { kind: "COMPONENT" as const, step: i + 1, component: c }, supportingRefs: [] })) };
    const rMany = validateProjection(many, input);
    expect(rMany.ok).toBe(false);
    if (!rMany.ok) expect(rMany.rejection).toBe("TOO_MANY_FINDINGS");

    const few = { findings: [{ userFacingLabel: "only one", primaryRef: { kind: "COMPONENT" as const, step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [] }] };
    const rFew = validateProjection(few, input);
    expect(rFew.ok).toBe(false);
    if (!rFew.ok) expect(rFew.rejection).toBe("TOO_FEW_FINDINGS");
    expect(MIN_FINDINGS).toBeLessThan(MAX_FINDINGS);
  });

  it("B7. the model is never handed anything it could copy a fact from: the projection input carries statuses, codes and counts — no fragments, urls, evidence ids or document text", () => {
    const serialized = JSON.stringify(input);
    expect(serialized).not.toMatch(/http|fragment|supportFragment|evidenceId|e1"/);
    for (const c of input.components) {
      expect(Object.keys(c).sort()).toEqual(["component", "coverage", "evidenceCount", "reasonCodes", "status", "step"]);
    }
  });
});

// ====================================================================
describe("C. THE PAGE NEVER OUTRUNS THE RECORD", () => {
  it("C1. WHAT STOOD UP contains only checks whose persisted state actually stood: established, or — when nothing was established — partly established, and never a blocked one", () => {
    const worlds: LadderComponentInput[][] = [
      COMPONENTS.map((c) => row(c, "SUPPORTED")),
      COMPONENTS.map((c) => row(c, "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"])),
      COMPONENTS.map((c) => row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED")),
      COMPONENTS.map((c, i) => (i % 2 ? row(c, "SUPPORTED") : row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"))),
      [...COMPONENTS.slice(0, 4).map((c) => row(c, "PARTIALLY_SUPPORTED", ["INDIRECT_ONLY"])), row("NET_EFFECT", "CONTRADICTED", ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"])],
    ];
    for (const components of worlds) {
      const a = composeAudit({ input: { ...outputPlanFixture("D").input, components: components.map((c) => ({ step: 1, component: c.component, status: c.status, reasonCodes: [...(c.reasonCodes ?? [])] as string[], supportingEvidenceIds: [...(c.supportingEvidenceIds ?? [])] as string[], contradictingEvidenceIds: [...(c.contradictingEvidenceIds ?? [])] as string[] })) }, components, outcomeKind: "VERDICT" });
      const label = components.map((c) => c.status).join(",");
      for (const s of a.stoodUp) {
        expect(s.blocked, `${label}: a blocked check stood up`).toBe(false);
        expect(["ESTABLISHED", "PARTLY_ESTABLISHED"], `${label}: ${s.state} stood up`).toContain(s.state);
      }
      // The substitution is only ever a substitution: a partly-established
      // check appears under WHAT STOOD UP only when NOTHING was established.
      if (a.stoodUp.some((s) => s.state === "PARTLY_ESTABLISHED")) {
        expect(a.checks.some((c) => !c.blocked && c.state === "ESTABLISHED"), `${label}: partly stood in while something was established`).toBe(false);
      }
      // And it is always distinguishable — the state travels with it.
      for (const s of a.stoodUp) expect(typeof s.state).toBe("string");
      expect(a.stoodUp.length).toBeLessThanOrEqual(MAX_STOOD_UP);
      expect(a.gaps.length).toBeLessThanOrEqual(MAX_GAPS);
    }
  });

  it("C2. COUNTS ARE AN INDEX, NOT A SCORE: a blocked check is counted as NOT CHECKED and never as established or not-established, and the five counts sum to exactly the number of checks", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const c = a.counts;
      const total = c.established + c.partlyEstablished + c.contradicted + c.notEstablished + c.notChecked;
      expect(total, "counts do not index the checks").toBe(a.checks.length);
      expect(c.notChecked).toBe(a.checks.filter((x) => x.blocked).length);
      for (const k of ["established", "partlyEstablished", "contradicted", "notEstablished"] as const) {
        expect(c[k]).toBe(a.checks.filter((x) => !x.blocked && x.state === proofStateFor(k)).length);
      }
    }
    // A wholly blocked record reports zero of everything except notChecked.
    const blocked = COMPONENTS.map((c) => row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"));
    const counts = auditCounts(
      composeAudit({ input: { ...outputPlanFixture("D").input, components: blocked.map((c) => ({ step: 1, component: c.component, status: c.status, reasonCodes: [...(c.reasonCodes ?? [])] as string[], supportingEvidenceIds: [], contradictingEvidenceIds: [] })) }, components: blocked, outcomeKind: "VERDICT" }).checks,
    );
    expect(counts.established).toBe(0);
    expect(counts.notEstablished).toBe(0);
    expect(counts.notChecked).toBeGreaterThan(0);
  });

  it("C3. A CONTRADICTION IS NEVER MANUFACTURED FROM A GAP: every contradiction shown rests on a persisted CONTRADICTED state, and a record with no contradicted row shows none", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      for (const k of a.contradictions) expect(k.state).toBe("CONTRADICTED");
      const persistedContradictions = a.checks.filter((c) => !c.blocked && c.state === "CONTRADICTED").length;
      expect(a.contradictions.length).toBeLessThanOrEqual(persistedContradictions);
    }
    // A record made entirely of absence yields no contradiction at all.
    const absent = COMPONENTS.map((c) => row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]));
    const a = composeAudit({ input: { ...outputPlanFixture("D").input, components: absent.map((c) => ({ step: 1, component: c.component, status: c.status, reasonCodes: [...(c.reasonCodes ?? [])] as string[], supportingEvidenceIds: [], contradictingEvidenceIds: [] })) }, components: absent, outcomeKind: "VERDICT" });
    expect(a.contradictions).toEqual([]);
    expect(a.counts.contradicted).toBe(0);
  });

  it("C4. NOTHING IS LOST AND NOTHING IS DOUBLE-COUNTED: every check is in the trail exactly once, and a check shown under WHAT STOOD UP is not also listed as still open", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const names = a.checks.map((c) => c.component);
      expect(new Set(names).size, "a check appears twice in the trail").toBe(names.length);
      const standing = new Set(a.stoodUp.map((s) => s.component));
      for (const o of a.open) expect(standing.has(o.component), `${o.component} is both standing and open`).toBe(false);
      for (const s of a.stoodUp) expect(names).toContain(s.component);
      for (const g of a.gaps) expect(names).toContain(g.component);
    }
  });
});

// ====================================================================
describe("D. A WEAKER RECORD NEVER MAKES A STRONGER PAGE", () => {
  // The same eight components, degraded one rung at a time. Each world is
  // strictly weaker than the one before it.
  const LADDER: { name: string; rows: () => LadderComponentInput[] }[] = [
    { name: "all established", rows: () => COMPONENTS.map((c) => row(c, "SUPPORTED")) },
    { name: "half established", rows: () => COMPONENTS.map((c, i) => (i < 4 ? row(c, "SUPPORTED") : row(c, "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]))) },
    { name: "all partly", rows: () => COMPONENTS.map((c) => row(c, "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"])) },
    { name: "half partly, half absent", rows: () => COMPONENTS.map((c, i) => (i < 4 ? row(c, "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]) : row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]))) },
    { name: "all absent", rows: () => COMPONENTS.map((c) => row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"])) },
    { name: "all blocked", rows: () => COMPONENTS.map((c) => row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED")) },
  ];
  const compose = (rows: LadderComponentInput[]) =>
    composeAudit({
      input: { ...outputPlanFixture("D").input, components: rows.map((c) => ({ step: 1, component: c.component, status: c.status, reasonCodes: [...(c.reasonCodes ?? [])] as string[], supportingEvidenceIds: [...(c.supportingEvidenceIds ?? [])] as string[], contradictingEvidenceIds: [...(c.contradictingEvidenceIds ?? [])] as string[] })) },
      components: rows,
      outcomeKind: "VERDICT",
    });

  it("D1. down the whole ladder, the number of ESTABLISHED checks never rises and the number of unresolved ones never falls", () => {
    let prevEstablished = Number.POSITIVE_INFINITY;
    let prevResolved = Number.POSITIVE_INFINITY;
    for (const rung of LADDER) {
      const a = compose(rung.rows());
      const resolved = a.counts.established + a.counts.partlyEstablished;
      expect(a.counts.established, `${rung.name}: established rose`).toBeLessThanOrEqual(prevEstablished);
      expect(resolved, `${rung.name}: resolved rose`).toBeLessThanOrEqual(prevResolved);
      prevEstablished = a.counts.established;
      prevResolved = resolved;
    }
  });

  it("D2. the weakest records say the least: an all-absent and an all-blocked record present nothing as standing", () => {
    for (const name of ["all absent", "all blocked"]) {
      const a = compose(LADDER.find((l) => l.name === name)!.rows());
      expect(a.stoodUp, `${name}: something stood up`).toEqual([]);
      expect(a.counts.established, name).toBe(0);
      expect(a.counts.partlyEstablished, name).toBe(0);
      expect(a.contradictions, name).toEqual([]);
    }
  });

  it("D3. the page is a function of the record alone: the same rows in any order compose to the identical page", () => {
    for (const rung of LADDER) {
      const control = JSON.stringify(compose(rung.rows()));
      for (let k = 0; k < 8; k++) {
        const rows = rung.rows();
        for (let i = rows.length - 1; i > 0; i--) {
          const j = (i * 5 + k * 11 + 1) % (i + 1);
          [rows[i], rows[j]] = [rows[j], rows[i]];
        }
        expect(JSON.stringify(compose(rows)), `${rung.name} permutation ${k}`).toBe(control);
      }
    }
  });

  it("D4. the summary sentence is a derivation of the record, and a record with nothing to say says nothing rather than something reassuring", () => {
    for (const rung of LADDER) {
      const a = compose(rung.rows());
      if (a.summary === null) continue;
      // Never an unqualified promise when nothing stood up.
      if (a.stoodUp.length === 0) {
        expect(a.summary.toLowerCase(), `${rung.name}: reassuring summary with nothing standing`).not.toMatch(
          /\bis established\b|\bis supported\b|\bis proven\b|\bis confirmed\b|\bis verified\b/,
        );
      }
    }
  });
});

// ====================================================================
describe("E. THE LADDER ITSELF NEVER INVENTS A STATE", () => {
  it("E1. the two vocabularies never blur: the ladder's internal RealityState is mapped into the reader's four-word ProofState by one total function, an unrecognised persisted status never becomes a positive state, and NOT_ASSESSED renders as no state at all rather than as a weak one", () => {
    const READER_WORDS = ["ESTABLISHED", "PARTLY_ESTABLISHED", "NOT_ESTABLISHED", "CONTRADICTED"];
    const seen = new Set<string>();
    for (const status of ["SUPPORTED", "PARTIALLY_SUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE", "SOMETHING_NEW", "supported", ""]) {
      const l = deriveResultLadder(COMPONENTS.map((c) => row(c, status)));
      for (const r of [...l.mechanism, ...l.value]) {
        seen.add(r.state);
        const rendered = proofStateOfRung(r.state);
        // Every rung either maps into the reader's closed four words, or
        // maps to null and is not rendered as a state at all. There is no
        // third outcome, and no rung invents a fifth word.
        expect(rendered === null || READER_WORDS.includes(rendered), `${status} -> ${r.state} -> ${rendered}`).toBe(true);
        if (r.state === "NOT_ASSESSED") expect(rendered, "NOT_ASSESSED rendered as a state").toBeNull();
      }
    }
    // An unrecognised or empty persisted status is never read as positive.
    for (const status of ["SOMETHING_NEW", "supported", ""]) {
      const l = deriveResultLadder(COMPONENTS.map((c) => row(c, status)));
      for (const r of [...l.mechanism, ...l.value]) {
        expect(r.state, `${status} became ${r.state}`).not.toBe("VERIFIED");
        expect(proofStateOfRung(r.state), `${status} rendered as ESTABLISHED`).not.toBe("ESTABLISHED");
      }
    }
    // The ladder actually exercised more than one rung state, so the
    // assertions above are not vacuous.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("E2. auditStoodUp honours its cap and its precedence under every mixture, including one established beside seven partly", () => {
    const mixed = [row("SOURCE_OF_VALUE", "SUPPORTED"), ...COMPONENTS.slice(1).map((c) => row(c, "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]))];
    const a = composeAudit({
      input: { ...outputPlanFixture("D").input, components: mixed.map((c) => ({ step: 1, component: c.component, status: c.status, reasonCodes: [...(c.reasonCodes ?? [])] as string[], supportingEvidenceIds: [...(c.supportingEvidenceIds ?? [])] as string[], contradictingEvidenceIds: [] })) },
      components: mixed,
      outcomeKind: "VERDICT",
    });
    expect(a.stoodUp.every((s) => s.state === "ESTABLISHED")).toBe(true);
    expect(a.stoodUp.length).toBe(1);
    // And the cap holds when there are more established checks than slots.
    const all = COMPONENTS.map((c) => row(c, "SUPPORTED"));
    const capped = auditStoodUp(
      composeAudit({ input: { ...outputPlanFixture("D").input, components: all.map((c) => ({ step: 1, component: c.component, status: c.status, reasonCodes: [], supportingEvidenceIds: ["e"], contradictingEvidenceIds: [] })) }, components: all, outcomeKind: "VERDICT" }).checks,
    );
    expect(capped.length).toBe(MAX_STOOD_UP);
  });
});

function proofStateFor(k: "established" | "partlyEstablished" | "contradicted" | "notEstablished"): string {
  return k === "established" ? "ESTABLISHED" : k === "partlyEstablished" ? "PARTLY_ESTABLISHED" : k === "contradicted" ? "CONTRADICTED" : "NOT_ESTABLISHED";
}

// ====================================================================
describe("F. AN EXCLUDED ROW IS NOT A MEASUREMENT — the defect this round found", () => {
  // S5 EXCLUSION DOES NOT REWRITE THE ROW. A reading refused for an
  // unconfirmed entity binding, a withdrawn route, supersession or a
  // foreign job still carries relationship "SUPPORTS": the refusal lives
  // in the component's excludedEvidence, which the presentation layer
  // never receives. A check on the relationship label alone therefore
  // admitted exactly the rows S5 threw out.
  const onchainRow = (id: string) => ({
    id,
    patternStep: 5,
    component: "CURRENT_STATE",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CONFIRMED",
    fragment: '{"kind":"TOKEN_SUPPLY"}',
    summary: null,
    doesNotProve: null,
    mechanismState: null,
    publishedAt: null,
    observedAt: null,
    fetchedAt: "2026-03-02T09:00:00.000Z",
    retrievedUrl: "https://rpc.example/supply",
    sourceTitle: null,
  });

  const world = (supporting: string[]): AnalyticalOutputInputV1 => ({
    question: { text: "did supply change?", intent: "BURN_OR_SUPPLY_EFFECT", relevantComponents: [] },
    verdict: supporting.length > 0 ? "PARTIALLY_SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    confidenceBand: "LOW",
    components: [
      {
        step: 5,
        component: "CURRENT_STATE",
        status: supporting.length > 0 ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
        reasonCodes: supporting.length > 0 ? [] : ["ALL_EVIDENCE_EXCLUDED"],
        supportingEvidenceIds: supporting,
        contradictingEvidenceIds: [],
      },
    ],
    evidence: [onchainRow("q1")],
    flows: [],
    quantities: [
      {
        evidenceId: "q1",
        observationId: "artifact-1",
        factKind: "TOKEN_SUPPLY",
        step: 5,
        component: "CURRENT_STATE",
        mint: "FOREIGNMINT111111111111111111111111111111111",
        decimals: 9,
        amountRaw: "123456789",
        position: null,
      },
    ],
    entities: [],
  });

  const blocksOf = (input: AnalyticalOutputInputV1) => chooseAnalyticalBlocks(input).orderedBlocks.map((b) => b.type);
  const metricOf = (input: AnalyticalOutputInputV1) =>
    chooseAnalyticalBlocks(input).orderedBlocks.find((b) => b.type === "METRIC");

  it("F1. a reading the component EXCLUDED is never rendered as a measurement, and never as an ESTABLISHED one — the admitted twin still is", () => {
    const excluded = world([]);
    const admitted = world(["q1"]);

    // The defect: before this fix both produced the identical METRIC tile
    // with state ESTABLISHED, because only `relationship` was consulted.
    expect(metricOf(excluded), "an excluded reading was rendered as a measurement").toBeUndefined();
    expect(blocksOf(excluded)).not.toContain("METRIC");

    // The legitimate case is untouched.
    const m = metricOf(admitted);
    expect(m).toBeDefined();
    expect((m!.spec as { metrics: { amountRaw: string; state: string }[] }).metrics[0].amountRaw).toBe("123456789");
    expect((m!.spec as { metrics: { state: string }[] }).metrics[0].state).toBe("ESTABLISHED");
  });

  it("F2. the same rule covers the evidence snapshot: an excluded row is not shown as evidence, while the admitted twin is", () => {
    const excluded = chooseAnalyticalBlocks(world([]));
    const admitted = chooseAnalyticalBlocks(world(["q1"]));
    const snapOf = (p: ReturnType<typeof chooseAnalyticalBlocks>) => p.orderedBlocks.find((b) => b.type === "EVIDENCE_SNAPSHOT");
    expect(snapOf(excluded), "an excluded row was shown as evidence").toBeUndefined();
    expect(excluded.rejected.some((r) => r.type === "EVIDENCE_SNAPSHOT" && r.reason === "NO_ADMITTED_EVIDENCE")).toBe(true);
    expect(snapOf(admitted)).toBeDefined();
  });

  it("F3. admission is COMPONENT-SCOPED: a reading that legitimately supports one component is not a measurement for a component that excluded it", () => {
    const base = world(["q1"]);
    const crossed: AnalyticalOutputInputV1 = {
      ...base,
      components: [
        { step: 5, component: "CURRENT_STATE", status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["q1"], contradictingEvidenceIds: [] },
        { step: 7, component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["ALL_EVIDENCE_EXCLUDED"], supportingEvidenceIds: [], contradictingEvidenceIds: [] },
      ],
      // The very same reading, now claimed for the component that refused it.
      quantities: [{ ...base.quantities[0], step: 7, component: "NET_EFFECT" }],
    };
    expect(metricOf(crossed), "a component that excluded a reading still quoted its number").toBeUndefined();
  });

  it("F4. a row that was never in ANY component's sets — a CONTEXT row, a row for a component this job never assessed — is not a measurement either", () => {
    const base = world(["q1"]);
    const context: AnalyticalOutputInputV1 = {
      ...base,
      components: [{ step: 5, component: "CURRENT_STATE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: [], supportingEvidenceIds: [], contradictingEvidenceIds: [] }],
      evidence: [{ ...onchainRow("q1"), relationship: "CONTEXT" }],
    };
    expect(metricOf(context)).toBeUndefined();

    const unassessed: AnalyticalOutputInputV1 = { ...base, components: [] };
    expect(metricOf(unassessed)).toBeUndefined();
  });

  it("F5. ordering and duplication do not revive an excluded reading, and adding MORE excluded readings never produces a measurement", () => {
    const many: AnalyticalOutputInputV1 = {
      ...world([]),
      evidence: ["q1", "q2", "q3"].map(onchainRow),
      quantities: ["q1", "q2", "q3"].map((id, i) => ({
        evidenceId: id,
        observationId: `artifact-${i}`,
        factKind: "TOKEN_SUPPLY",
        step: 5,
        component: "CURRENT_STATE",
        mint: "FOREIGNMINT111111111111111111111111111111111",
        decimals: 9,
        amountRaw: `${100 + i}`,
        position: null,
      })),
    };
    expect(metricOf(many)).toBeUndefined();
    const reversed: AnalyticalOutputInputV1 = { ...many, evidence: [...many.evidence].reverse(), quantities: [...many.quantities].reverse() };
    expect(metricOf(reversed)).toBeUndefined();
  });
});
