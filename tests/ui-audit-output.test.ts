import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  auditBoundary,
  auditChecks,
  auditGap,
  auditGaps,
  auditStoodUp,
  composeAudit,
  MAX_GAPS,
  MAX_STOOD_UP,
  proofStateOfRung,
  type AuditComposition,
} from "../src/client/audit-composition";
import { AuditCompositionView, SHORT_REASON } from "../src/client/components/result-blocks/audit-composition";
import { chooseAnalyticalBlocks, proofStateOf, type PlannedBlock } from "../src/client/output-plan";
import { GOLDEN_AUDIT_FIXTURE, OUTPUT_PLAN_FIXTURES, outputPlanFixture } from "../src/client/output-plan-fixtures";
import {
  deriveResultLadder,
  REASON_CODE_EXPLANATIONS,
  resultBriefing,
  type LadderComponentInput,
} from "../src/client/research-model";

// AUDIT OUTPUT V3 — EXCEPTIONS FIRST.
//
// An audit is what deserves attention after the verification: what stood
// up, what is open, what the record contradicts, and the evidence tied to
// those. The main page lists most checks not at all; the complete list is
// one collapsed trail. These tests hold that every state shown is a
// persisted status, every sentence a derivation the research screen
// already runs, a contradiction is never manufactured from a gap, a sparse
// record yields a sparse audit, and nothing is lost: every check is still
// in the trail.

const AUDIT_SRC = "src/client/audit-composition.ts";
const AUDIT_VIEW = "src/client/components/result-blocks/audit-composition.tsx";

function codeOf(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

type Fixture = { input: ReturnType<typeof outputPlanFixture>["input"]; auditComponents?: readonly LadderComponentInput[] };
const fx = (key: string) => outputPlanFixture(key);
const auditOf = (f: Fixture): AuditComposition =>
  composeAudit({ input: f.input, components: f.auditComponents ?? f.input.components, outcomeKind: "VERDICT" });
const htmlOf = (f: Fixture) =>
  renderToStaticMarkup(createElement(AuditCompositionView, { audit: auditOf(f), input: f.input, asOf: "Fixture" }));
const audit = (key: string): AuditComposition => auditOf(fx(key));
const html = (key: string) => htmlOf(fx(key));
const ALL: Fixture[] = [...OUTPUT_PLAN_FIXTURES, GOLDEN_AUDIT_FIXTURE];
const rowsOf = (components: readonly LadderComponentInput[]) => {
  const l = deriveResultLadder(components);
  return [...l.mechanism, ...l.value].filter((r) => r.state !== "NOT_ASSESSED");
};
const row = (component: string, status: string, reasonCodes: string[] = [], coverage?: LadderComponentInput["coverage"]): LadderComponentInput => ({
  component,
  status,
  reasonCodes,
  supportingEvidenceIds: status === "INSUFFICIENT_EVIDENCE" ? [] : ["e"],
  contradictingEvidenceIds: [],
  coverage,
});
function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
const count = (h: string, id: string) => h.match(new RegExp(`data-testid="${id}"`, "g"))?.length ?? 0;

/* ------------------------------------------------------------------ */
/* 1. STRUCTURE — exceptions, not a checklist                          */
/* ------------------------------------------------------------------ */

describe("the audit surfaces exceptions, not every check", () => {
  it("orders verdict → stood up → main gaps → contradictions → evidence → trail, with no checklist and no map beside the verdict", () => {
    for (const f of ALL) {
      const h = htmlOf(f);
      const at = (id: string) => h.indexOf(`data-testid="${id}"`);
      expect(at("audit-verdict-label")).toBeGreaterThan(-1);
      expect(at("block-stood-up")).toBeGreaterThan(at("audit-verdict-label"));
      expect(at("block-main-gaps")).toBeGreaterThan(at("block-stood-up"));
      expect(at("block-contradictions")).toBeGreaterThan(at("block-main-gaps"));
      expect(at("block-audit-trail")).toBeGreaterThan(at("block-contradictions"));
      // The map lives INSIDE the trail, and the trail is collapsed.
      expect(at("block-audit-map")).toBeGreaterThan(at("block-audit-trail"));
      expect(h).toMatch(/<details[^>]*data-testid="block-audit-trail"/);
      expect(h).not.toMatch(/<details[^>]*data-testid="block-audit-trail"[^>]*\sopen/);
      // Gone from the main page: the research answer, any key-checks
      // table, counts dashboard, finding tiles, chip lists, deep-proof block.
      for (const gone of ["block-answer", "block-audit-table", "audit-counts", "audit-fraction", "block-audit-findings", "block-not-verified", "block-deep-proof", "block-claim-reality"]) {
        expect(h, gone).not.toContain(`data-testid="${gone}"`);
      }
    }
  });

  it("every check lives in the trail, once, and the map there lists no rows", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const h = htmlOf(f);
      expect(count(h, "audit-row")).toBe(a.checks.length);
      expect(count(h, "proof-cell")).toBe(0);
      expect(h).toContain('data-testid="proof-coverage"');
      for (const c of a.checks) expect(h, c.component).toContain(escape(c.established));
    }
  });

  it("a sparse record yields a sparse audit: no metric, no flow, no map on the main page, no filler", () => {
    const h = html("D");
    for (const absent of ["block-metrics", "block-flow", "block-chart", "block-timeline", "block-entities", "block-table"]) {
      expect(h, absent).not.toContain(`data-testid="${absent}"`);
    }
    const a = audit("D");
    expect(a.contradictions).toEqual([]);
    expect(h).toContain("No contradiction established.");
    expect(a.gaps.length).toBeGreaterThanOrEqual(2);
    expect(a.gaps.length).toBeLessThanOrEqual(MAX_GAPS);
  });
});

/* ------------------------------------------------------------------ */
/* 2. NOTHING IS DECIDED HERE                                          */
/* ------------------------------------------------------------------ */

describe("the audit asserts nothing of its own", () => {
  it("the verdict is the Proof's, and the summary is the research screen's own lead sentence", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = audit(f.key);
      expect(a.verdict).toBe(f.input.verdict);
      expect(a.confidenceBand).toBe(f.input.confidenceBand);
      const rows = rowsOf(f.input.components);
      const briefing = resultBriefing({
        verdict: f.input.verdict,
        outcomeKind: "VERDICT",
        projectName: null,
        components: f.input.components.map((c) => ({ component: c.component, status: c.status })),
        rows,
      });
      expect(a.summary).toBe(briefing.shortAnswer[0] ?? null);
    }
    expect(codeOf(AUDIT_SRC)).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*(is|was|has|did)[^`]*`/);
  });

  it("every state shown equals the persisted component status, wherever it appears", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const status = new Map((f.auditComponents ?? f.input.components).map((c) => [c.component, c.status]));
      for (const c of a.checks) expect(c.state, `row ${c.component}`).toBe(proofStateOf(status.get(c.component)));
      for (const c of a.stoodUp) expect(c.state, `stood ${c.component}`).toBe(proofStateOf(status.get(c.component)));
      for (const c of a.contradictions) expect(proofStateOf(status.get(c.component)), `contra ${c.component}`).toBe("CONTRADICTED");
      for (const g of a.gaps) {
        const s = proofStateOf(status.get(g.component));
        expect(s === "NOT_ESTABLISHED" || s === "PARTLY_ESTABLISHED", `gap ${g.component}`).toBe(true);
      }
    }
  });

  it("a check is one thing on the page: never both stood up and a gap, never both a gap and a contradiction", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const stood = new Set(a.stoodUp.map((c) => c.component));
      const gaps = new Set(a.gaps.map((g) => g.component));
      const contra = new Set(a.contradictions.map((c) => c.component));
      for (const c of gaps) expect(stood.has(c), c).toBe(false);
      for (const c of contra) expect(gaps.has(c), c).toBe(false);
      for (const c of contra) expect(stood.has(c), c).toBe(false);
    }
  });

  it("invents no severity, risk score, second verdict vocabulary or hero fraction", () => {
    for (const file of [AUDIT_SRC, AUDIT_VIEW]) {
      const src = codeOf(file);
      expect(src, file).not.toMatch(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/);
      expect(src, file).not.toMatch(/risk\s*score|severity|\bscore\b/i);
      expect(src, file).not.toMatch(/fetch\(|anthropic|drizzle|getDb/i);
    }
    for (const f of ALL) expect(htmlOf(f)).not.toMatch(/>\s*\/\s*\d+\s*</);
  });

  it("reads no fragment: every sentence on the page is a row's own", () => {
    expect(codeOf(AUDIT_SRC)).not.toMatch(/fragment|summary\b(?!:)|\.match\(|parseFloat|parseInt/);
    for (const f of ALL) {
      const rows = rowsOf(f.auditComponents ?? f.input.components);
      const own = new Set(rows.flatMap((r) => [r.shows, r.reason, r.limitation].filter((x): x is string => x !== null)));
      const a = auditOf(f);
      for (const c of a.checks) expect(own.has(c.established) || c.established === "—", c.component).toBe(true);
      for (const g of a.gaps) expect(own.has(g.detail) || /was not established\.$|^This was not established\.$/.test(g.detail), g.component).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. WHAT STOOD UP, MAIN GAPS, CONTRADICTIONS                          */
/* ------------------------------------------------------------------ */

describe("what stood up", () => {
  it("is the established checks in ladder order, at most three", () => {
    const checks = auditChecks(rowsOf([
      row("SOURCE_OF_VALUE", "SUPPORTED"),
      row("FLOW_PATH", "SUPPORTED"),
      row("MECHANISM_SPEC", "SUPPORTED"),
      row("GOVERNANCE_BASIS", "SUPPORTED"),
      row("NET_EFFECT", "PARTIALLY_SUPPORTED", ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]),
    ]));
    expect(auditStoodUp(checks).map((c) => c.component)).toEqual(["MECHANISM_SPEC", "GOVERNANCE_BASIS", "SOURCE_OF_VALUE"]);
    expect(MAX_STOOD_UP).toBe(3);
  });

  it("stands the partly-established checks in when nothing was established, and says so when nothing was either", () => {
    const partial = auditChecks(rowsOf([
      row("CURRENT_STATE", "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]),
      row("NET_EFFECT", "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]),
      row("MECHANISM_SPEC", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
    ]));
    expect(auditStoodUp(partial).map((c) => [c.component, c.state])).toEqual([
      ["CURRENT_STATE", "PARTLY_ESTABLISHED"],
      ["NET_EFFECT", "PARTLY_ESTABLISHED"],
    ]);
    expect(auditStoodUp(auditChecks(rowsOf([row("MECHANISM_SPEC", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"])])))).toEqual([]);
    expect(html("D")).not.toContain('data-testid="stood-up-none"');
  });
});

describe("main gaps", () => {
  it("takes one of each open kind in priority order, then rounds again — so four blocked checks do not crowd out the rest", () => {
    const rows = rowsOf([
      row("MECHANISM_SPEC", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
      row("GOVERNANCE_BASIS", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
      row("CURRENT_STATE", "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]),
      row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"),
      row("DESTINATION", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"),
      row("RECIPIENT", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"),
      row("DURABILITY_BASIS", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"),
    ]);
    const gaps = auditGaps(auditBoundary(rows, "VERDICT"));
    expect(gaps.map((g) => [g.component, g.kind])).toEqual([
      ["EXECUTION_EVIDENCE", "COULD_NOT_CHECK"],
      ["MECHANISM_SPEC", "NOT_ESTABLISHED"],
      ["CURRENT_STATE", "PARTLY_ESTABLISHED"],
      ["DESTINATION", "COULD_NOT_CHECK"],
    ]);
    expect(gaps).toHaveLength(MAX_GAPS);
  });

  it("a blocked check is chipped 'Not checked', its short line says the sources could not be opened, and its sentence is the run's limit", () => {
    const rows = rowsOf([row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED")]);
    const a = composeAudit({ input: { ...fx("D").input, components: [{ step: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], supportingEvidenceIds: [], contradictingEvidenceIds: [] }] }, components: [row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED")], outcomeKind: "VERDICT" });
    expect(rows).toHaveLength(1);
    const blocked = renderToStaticMarkup(createElement(AuditCompositionView, { audit: a, input: fx("D").input, asOf: "t" }));
    const gap = blocked.slice(blocked.indexOf('data-testid="gap-item"'), blocked.indexOf('data-testid="gap-detail"'));
    expect(gap).toContain("Sources could not be opened");
    expect(gap).not.toContain("Nothing found in checked sources");
    const h = html("D");
    // Fixture D has no blocked check; the golden one does.
    expect(h).not.toContain('data-kind="COULD_NOT_CHECK"');
    const g = htmlOf(GOLDEN_AUDIT_FIXTURE);
    expect(g).toContain('data-kind="COULD_NOT_CHECK"');
    expect(g).toContain("Not checked");
    expect(g).toContain("limit of the research run, not evidence for or against the project");
  });

  it("still knows the single most important boundary, by the short answer's own priority", () => {
    const rows = rowsOf([
      row("MECHANISM_SPEC", "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]),
      row("GOVERNANCE_BASIS", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
      row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"),
    ]);
    expect(auditGap(rows, auditBoundary(rows, "VERDICT"))?.component).toBe("EXECUTION_EVIDENCE");
  });
});

describe("contradictions", () => {
  it("are only checks the record positively contradicts — a gap is never dressed as one", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const status = new Map((f.auditComponents ?? f.input.components).map((c) => [c.component, c.status]));
      const expected = a.checks.filter((c) => status.get(c.component) === "CONTRADICTED").map((c) => c.component);
      expect(a.contradictions.map((c) => c.component)).toEqual(expected);
    }
    // Fixture D: four open checks and no contradiction. The block says so.
    const h = html("D");
    expect(count(h, "contradiction-item")).toBe(0);
    expect(h).toContain('data-testid="contradictions-none"');
    // Fixture B: one contradiction, shown prominently with its own reason.
    const b = html("B");
    expect(count(b, "contradiction-item")).toBe(1);
    expect(audit("B").contradictions[0].component).toBe("NET_EFFECT");
  });
});

/* ------------------------------------------------------------------ */
/* 4. ANALYTICAL BLOCKS AND EVIDENCE — TIED TO THE FINDINGS            */
/* ------------------------------------------------------------------ */

describe("analytical blocks and evidence serve the findings", () => {
  it("keeps a selector block only when it bears on a gap or a contradiction", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const open = new Set([...a.gaps.map((g) => g.component), ...a.contradictions.map((c) => c.component)]);
      const chosen = chooseAnalyticalBlocks(f.input).orderedBlocks.filter((b) => ["METRIC", "FLOW", "TABLE", "CHART", "TIMELINE"].includes(b.type));
      const expected = chosen.filter((b) => b.refs.components.some((k) => open.has(k.component)));
      expect(a.analytical).toEqual(expected);
      // And never a block the selector did not choose.
      for (const b of a.analytical) expect(chosen).toContainEqual(b);
    }
  });

  it("omits a standalone measure that explains no exception — the real-shaped case", () => {
    // A single supply reading on NET_EFFECT, which is partly established
    // and therefore among what stood up, with the open checks elsewhere.
    const input = {
      ...fx("D").input,
      components: [
        { step: 5, component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["s"], contradictingEvidenceIds: [] },
        { step: 7, component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["s"], contradictingEvidenceIds: [] },
        { step: 3, component: "MECHANISM_SPEC", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], supportingEvidenceIds: [], contradictingEvidenceIds: [] },
      ],
      evidence: [{ ...fx("D").input.evidence[0], id: "s", component: "NET_EFFECT", relationship: "SUPPORTS", directness: "DIRECT", sourceClass: "ONCHAIN_VERIFIABLE" }],
      quantities: [{ evidenceId: "s", observationId: "o", factKind: "TOKEN_SUPPLY", step: 7, component: "NET_EFFECT", mint: "M", decimals: 6, amountRaw: "100", position: null }],
    };
    const plan = chooseAnalyticalBlocks(input);
    expect(plan.orderedBlocks.some((b) => b.type === "METRIC")).toBe(true);
    const a = composeAudit({ input, components: input.components, outcomeKind: "VERDICT", plan });
    expect(a.stoodUp.map((c) => c.component)).toEqual(["CURRENT_STATE", "NET_EFFECT"]);
    expect(a.analytical).toEqual([]);
    const h = renderToStaticMarkup(createElement(AuditCompositionView, { audit: a, input, asOf: "t" }));
    expect(h).not.toContain('data-testid="block-metrics"');
  });

  it("filters the selector's evidence to the selected findings, and falls back to the selector's choice untouched", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      const chosen = chooseAnalyticalBlocks(f.input).orderedBlocks.find((b) => b.type === "EVIDENCE_SNAPSHOT") as Extract<PlannedBlock, { type: "EVIDENCE_SNAPSHOT" }> | undefined;
      if (!chosen) {
        expect(a.evidence).toBeNull();
        continue;
      }
      const byId = new Map(f.input.evidence.map((e) => [e.id, e]));
      const selected = new Set([...a.gaps.map((g) => g.component), ...a.contradictions.map((c) => c.component), ...a.stoodUp.map((c) => c.component)]);
      const tied = chosen.spec.evidenceIds.filter((id) => selected.has(byId.get(id)!.component!));
      expect(a.evidence!.spec.evidenceIds).toEqual(tied.length > 0 ? tied : chosen.spec.evidenceIds);
      // Never an id the selector did not choose.
      for (const id of a.evidence!.spec.evidenceIds) expect(chosen.spec.evidenceIds).toContain(id);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. THE SEVEN AUDIT INVARIANTS                                       */
/* ------------------------------------------------------------------ */

describe("audit safety invariants", () => {
  it("NOT_ESTABLISHED ≠ FALSE: gaps are amber, never red, and never accused", () => {
    expect(proofStateOfRung("UNRESOLVED")).toBe("NOT_ESTABLISHED");
    expect(proofStateOfRung("NOT_HAPPENING")).toBe("CONTRADICTED");
    const h = html("D");
    expect(h).not.toMatch(/data-testid="gap-item"[^>]*data-kind="[^"]*"[^>]*>[\s\S]*?data-state="CONTRADICTED"/);
    expect(h).not.toMatch(/\b(false|fake|lied|misleading|fraud|violat|deceiv)/i);
  });

  it("ABSENCE OF EVIDENCE ≠ EVIDENCE OF ABSENCE: gap details say what was not found, never what is not so", () => {
    for (const g of audit("D").gaps) expect(g.detail).not.toMatch(/does not|did not|is not|no such|never/);
    expect(html("D")).toContain("No contradiction established.");
  });

  it("DOCUMENTED ≠ APPROVED ≠ ACTIVATED ≠ EXECUTING: four rows, four independent states", () => {
    const checks = Object.fromEntries(auditChecks(rowsOf(fx("C").input.components)).map((c) => [c.component, c.state]));
    expect(checks).toEqual({ MECHANISM_SPEC: "ESTABLISHED", GOVERNANCE_BASIS: "ESTABLISHED", CURRENT_STATE: "PARTLY_ESTABLISHED", EXECUTION_EVIDENCE: "NOT_ESTABLISHED" });
  });

  it("TRANSACTION HAPPENED ≠ CLAIMED MECHANISM EXECUTED: the flow, when shown, still breaks where the selector's does", () => {
    const flow = chooseAnalyticalBlocks(fx("E").input).orderedBlocks.find((b) => b.type === "FLOW");
    expect(flow && flow.type === "FLOW" && flow.spec.stages.find((s) => s.step === "EXECUTION")?.state).toBe("NOT_ESTABLISHED");
    expect(audit("E").checks.find((c) => c.component === "EXECUTION_EVIDENCE")!.state).toBe("PARTLY_ESTABLISHED");
  });

  it("ADDRESS EXISTS ≠ ECONOMIC ROLE ESTABLISHED: the audit never renders an entity block", () => {
    for (const f of ALL) expect(htmlOf(f)).not.toContain('data-testid="block-entities"');
  });

  it("BURN ≠ NET DEFLATION: a burn is an execution measure and the net-effect check is the contradiction", () => {
    const a = audit("B");
    const metric = a.analytical.find((b) => b.type === "METRIC");
    const burn = metric && metric.type === "METRIC" ? metric.spec.metrics.find((m) => m.factKind === "BURN") : undefined;
    expect(burn?.step).toBe("EXECUTION");
    expect(a.contradictions.map((c) => c.component)).toEqual(["NET_EFFECT"]);
    expect(a.checks.find((c) => c.component === "EXECUTION_EVIDENCE")!.state).toBe("ESTABLISHED");
  });

  it("MEASUREMENT ≠ CAUSAL ATTRIBUTION: no audit text states a cause", () => {
    for (const f of ALL) {
      expect(htmlOf(f)).not.toMatch(/\bcaused\b/i);
      expect(JSON.stringify(auditOf(f))).not.toMatch(/ATTRIBUTION|CAUSAL/);
    }
  });

  it("no audit presentation strengthens upstream", () => {
    for (const f of ALL) {
      const a = auditOf(f);
      for (const c of (f.auditComponents ?? f.input.components).filter((x) => x.status === "PARTIALLY_SUPPORTED")) {
        expect(a.checks.find((x) => x.component === c.component)!.state, c.component).toBe("PARTLY_ESTABLISHED");
      }
      expect(htmlOf(f)).not.toContain("undefined");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. SHORT FORMS, THE GOLDEN AUDIT, THE DEV ROUTES                    */
/* ------------------------------------------------------------------ */

describe("short forms and fixtures", () => {
  it("every short form is keyed on a code with full copy, in both directions, and never strengthens it", () => {
    for (const [code, short] of Object.entries(SHORT_REASON)) {
      expect(REASON_CODE_EXPLANATIONS[code], code).toBeTruthy();
      expect(short.length, code).toBeLessThanOrEqual(40);
      expect(short, code).not.toMatch(/\b(false|failed|fake|lied|fraud|caused|because|proves?|confirm)/i);
    }
    for (const code of Object.keys(REASON_CODE_EXPLANATIONS)) expect(SHORT_REASON[code], code).toBeTruthy();
  });

  it("the golden audit leads with what stood up, four gaps, and the contradiction — and keeps every analytical block that explains one", () => {
    const a = auditOf(GOLDEN_AUDIT_FIXTURE);
    expect(a.stoodUp.map((c) => c.component)).toEqual(["MECHANISM_SPEC", "SOURCE_OF_VALUE", "FLOW_PATH"]);
    expect(a.gaps.map((g) => [g.component, g.kind])).toEqual([
      ["DESTINATION", "COULD_NOT_CHECK"],
      ["CURRENT_STATE", "NOT_ESTABLISHED"],
      ["GOVERNANCE_BASIS", "PARTLY_ESTABLISHED"],
      ["EXECUTION_EVIDENCE", "PARTLY_ESTABLISHED"],
    ]);
    expect(a.contradictions.map((c) => c.component)).toEqual(["NET_EFFECT"]);
    expect(a.analytical.map((b) => b.type)).toEqual(["METRIC", "TABLE", "CHART", "FLOW", "TIMELINE"]);
    const h = htmlOf(GOLDEN_AUDIT_FIXTURE);
    for (const id of ["block-metrics", "block-flow", "block-table", "block-chart", "block-timeline", "block-evidence", "block-audit-trail"]) expect(h, id).toContain(`data-testid="${id}"`);
    expect(h).not.toContain('data-testid="block-entities"');
  });

  it("both dev routes render the same composition, gated, with the historical warning for a real job", () => {
    const page = readFileSync("app/(app)/dev/output-plan/page.tsx", "utf-8");
    expect(page).toContain('one(params.view) === "audit"');
    expect(page).toContain('process.env.NODE_ENV === "production"');
    expect(page).toContain("real-job-banner");
    expect(page).not.toMatch(/db\.|drizzle|getDb|fetch\(/);
    const showcase = readFileSync("app/(app)/dev/audit-showcase/page.tsx", "utf-8");
    expect(showcase).toContain("composeAudit(");
    expect(showcase).toContain("<AuditCompositionView");
    expect(showcase).toContain("fixture-banner");
    const bridge = readFileSync("src/client/components/result-blocks/real-job-plan.tsx", "utf-8");
    expect(bridge).toContain("composeAudit");
    expect(bridge).toContain("projectName: detail.job.projectName");
  });

  it("the result view is unchanged by the audit mode", () => {
    expect(chooseAnalyticalBlocks(fx("A").input).orderedBlocks.map((b) => b.type)).toEqual([
      "ANSWER", "PROOF_MAP", "METRIC", "FLOW", "TABLE", "CHART", "ENTITY", "TIMELINE", "EVIDENCE_SNAPSHOT", "DEEP_PROOF",
    ]);
  });
});
