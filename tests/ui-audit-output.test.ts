import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  auditBoundary,
  auditChecks,
  auditGap,
  composeAudit,
  proofStateOfRung,
  type AuditComposition,
} from "../src/client/audit-composition";
import { AuditCompositionView, SHORT_REASON } from "../src/client/components/result-blocks/audit-composition";
import { chooseAnalyticalBlocks, proofStateOf } from "../src/client/output-plan";
import { OUTPUT_PLAN_FIXTURES, outputPlanFixture } from "../src/client/output-plan-fixtures";
import {
  deriveResultLadder,
  REASON_CODE_EXPLANATIONS,
  resultBriefing,
  type LadderComponentInput,
} from "../src/client/research-model";

// AUDIT OUTPUT V2 — ONE INSTRUMENT, NOT MANY BOXES.
//
// An audit answers "what is the result, what stood up, what is the main
// gap, what supports that?" from the SAME record, selector and blocks as
// the research result. V2 says it once: a verdict, one sentence, the
// counts, ONE table, one gap. These tests hold that every state shown is a
// persisted status, every sentence is a derivation the research screen
// already runs, the page has no duplicated summary, and the invariants an
// audit is most tempted to break still hold.

const AUDIT_SRC = "src/client/audit-composition.ts";
const AUDIT_VIEW = "src/client/components/result-blocks/audit-composition.tsx";

function codeOf(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const fx = (key: string) => outputPlanFixture(key);
const audit = (key: string): AuditComposition =>
  composeAudit({ input: fx(key).input, components: fx(key).input.components, outcomeKind: "VERDICT" });
const html = (key: string) =>
  renderToStaticMarkup(createElement(AuditCompositionView, { audit: audit(key), input: fx(key).input, asOf: "Fixture" }));
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

/* ------------------------------------------------------------------ */
/* 1. STRUCTURE — fewer sections, no duplicated summary                */
/* ------------------------------------------------------------------ */

describe("the audit is one instrument", () => {
  it("orders verdict → summary → counts → table → gap → analytical → map → evidence → deep, and nothing else at the top", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const h = html(f.key);
      const at = (id: string) => h.indexOf(`data-testid="${id}"`);
      expect(at("audit-verdict-label"), f.key).toBeGreaterThan(-1);
      expect(at("audit-counts"), f.key).toBeGreaterThan(at("audit-verdict-label"));
      expect(at("block-audit-table"), f.key).toBeGreaterThan(at("audit-counts"));
      expect(at("block-audit-gap"), f.key).toBeGreaterThan(at("block-audit-table"));
      expect(at("block-audit-map"), f.key).toBeGreaterThan(at("block-audit-gap"));
      expect(at("block-deep-proof"), f.key).toBeGreaterThan(at("block-audit-map"));
      if (audit(f.key).summary) expect(at("audit-summary"), f.key).toBeLessThan(at("audit-counts"));
      // Gone: the research answer, the finding tiles, the chip list, the
      // separate comparison section, the coverage grid.
      for (const gone of ["block-answer", "block-audit-findings", "block-not-verified", "block-claim-reality", "audit-coverage-grid", "audit-fraction"]) {
        expect(h, `${f.key} ${gone}`).not.toContain(`data-testid="${gone}"`);
      }
    }
  });

  it("the ten statuses appear once above the fold — in the table — and once below, in the map", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const h = html(f.key);
      const n = audit(f.key).checks.length;
      expect(h.match(/data-testid="audit-row"/g)?.length ?? 0, f.key).toBe(n);
      expect(h.match(/data-testid="proof-cell"/g)?.length ?? 0, f.key).toBe(n);
      // The map comes after the analytical blocks and the gap, never beside the verdict.
      expect(h.indexOf('data-testid="block-audit-map"')).toBeGreaterThan(h.indexOf('data-testid="block-audit-gap"'));
    }
  });

  it("a sparse record yields a sparse audit", () => {
    const h = html("D");
    for (const absent of ["block-metrics", "block-flow", "block-chart", "block-timeline", "block-entities"]) {
      expect(h, absent).not.toContain(`data-testid="${absent}"`);
    }
  });

  it("frames the shared depth layers as audit layers without a second component", () => {
    const h = html("A");
    expect(h).toContain("Deep audit");
    expect(h).toContain("Key evidence");
    expect(h).toContain("Where the audit stops");
  });
});

/* ------------------------------------------------------------------ */
/* 2. NOTHING IS DECIDED HERE                                          */
/* ------------------------------------------------------------------ */

describe("the audit asserts nothing of its own", () => {
  it("the verdict is the Proof's verdict, relabelled and nothing more", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      expect(audit(f.key).verdict, f.key).toBe(f.input.verdict);
      expect(audit(f.key).confidenceBand, f.key).toBe(f.input.confidenceBand);
    }
  });

  it("the summary is the research screen's own lead sentence, not a phrasing of ours", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const rows = rowsOf(f.input.components);
      const briefing = resultBriefing({
        verdict: f.input.verdict,
        outcomeKind: "VERDICT",
        projectName: null,
        components: f.input.components.map((c) => ({ component: c.component, status: c.status })),
        rows,
      });
      expect(audit(f.key).summary, f.key).toBe(briefing.shortAnswer[0] ?? null);
    }
    // And the view composes no sentence: the only literal prose in it is
    // the two subordinate notes.
    const src = codeOf(AUDIT_SRC);
    expect(src).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*(is|was|has|did)[^`]*`/);
  });

  it("every state shown equals the persisted component status, in the table, the gap and the map", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = audit(f.key);
      const status = new Map(f.input.components.map((c) => [c.component, c.status]));
      for (const c of a.coverage) expect(c.state, `${f.key} map ${c.component}`).toBe(proofStateOf(status.get(c.component)));
      for (const c of a.checks) expect(c.state, `${f.key} row ${c.component}`).toBe(proofStateOf(status.get(c.component)));
      if (a.gap) {
        const s = proofStateOf(status.get(a.gap.component));
        expect(s === "NOT_ESTABLISHED" || s === "PARTLY_ESTABLISHED", `${f.key} gap ${a.gap.component}`).toBe(true);
      }
    }
  });

  it("the analytical blocks are the selector's, exactly, and never an audit variant", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const plan = chooseAnalyticalBlocks(f.input);
      const chosen = plan.orderedBlocks.filter((b) => ["METRIC", "FLOW", "TABLE", "CHART", "TIMELINE"].includes(b.type));
      expect(audit(f.key).analytical, f.key).toEqual(chosen);
    }
  });

  it("invents no severity, risk score, second verdict vocabulary or hero fraction", () => {
    for (const file of [AUDIT_SRC, AUDIT_VIEW]) {
      const src = codeOf(file);
      expect(src, file).not.toMatch(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/);
      expect(src, file).not.toMatch(/risk\s*score|severity|\bscore\b/i);
      expect(src, file).not.toMatch(/fetch\(|anthropic|drizzle|getDb/i);
    }
    // The counts are a list, not "N / M".
    for (const f of OUTPUT_PLAN_FIXTURES) expect(html(f.key), f.key).not.toMatch(/>\s*\/\s*\d+\s*</);
  });

  it("reads no fragment: every table sentence is a row's own", () => {
    const src = codeOf(AUDIT_SRC);
    expect(src).not.toMatch(/fragment|summary\b(?!:)|\.match\(|parseFloat|parseInt/);
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const rows = rowsOf(f.input.components);
      const own = new Set(rows.flatMap((r) => [r.shows, r.reason, r.limitation].filter((x): x is string => x !== null)));
      for (const c of audit(f.key).checks) {
        expect(own.has(c.established) || c.established === "—", `${f.key} ${c.component}`).toBe(true);
      }
      const g = audit(f.key).gap;
      if (g) expect(own.has(g.detail) || /was not established\.$|^This was not established\.$/.test(g.detail), `${f.key} gap`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE TABLE                                                        */
/* ------------------------------------------------------------------ */

describe("the main audit table", () => {
  it("one row per assessed check, in ladder order, labelled with the ladder's own claim", () => {
    const checks = auditChecks(rowsOf(fx("C").input.components));
    expect(checks.map((c) => c.component)).toEqual(["MECHANISM_SPEC", "GOVERNANCE_BASIS", "CURRENT_STATE", "EXECUTION_EVIDENCE"]);
    expect(checks.map((c) => c.check)).toEqual([
      "The project documents the mechanism",
      "A governing decision authorises it",
      "It is currently active",
      "It has been observed executing",
    ]);
    expect(checks.some((c) => c.component === "NET_EFFECT")).toBe(false);
  });

  it("'what ATLAS found' is a short form of the row's own meaning, with the full sentence in the fold", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const h = html(f.key);
      const a = audit(f.key);
      for (const c of a.checks) expect(h, `${f.key} ${c.component}`).toContain(escape(c.established));
      const founds = [...h.matchAll(/data-testid="audit-found">([^<]*)</g)].map((m) => m[1]);
      expect(founds.length, f.key).toBe(a.checks.length);
      for (const t of founds) {
        expect(t, f.key).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
        expect(t.length, f.key).toBeLessThanOrEqual(60);
      }
    }
  });

  it("every short form is keyed on a code with full copy, in both directions, and never strengthens it", () => {
    for (const [code, short] of Object.entries(SHORT_REASON)) {
      expect(REASON_CODE_EXPLANATIONS[code], code).toBeTruthy();
      expect(short.length, code).toBeLessThanOrEqual(40);
      expect(short, code).not.toMatch(/\b(false|failed|fake|lied|fraud|caused|because|proves?|confirm)/i);
    }
    for (const code of Object.keys(REASON_CODE_EXPLANATIONS)) expect(SHORT_REASON[code], code).toBeTruthy();
  });

  it("a blocked check is chipped 'Not checked' and says so, never 'not established' as a finding", () => {
    const checks = auditChecks(rowsOf([row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED")]));
    expect(checks[0].blocked).toBe(true);
    expect(checks[0].established).toMatch(/limit of the research run/);
    const a = composeAudit({
      input: { ...fx("D").input, components: [{ step: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], supportingEvidenceIds: [], contradictingEvidenceIds: [] }] },
      components: [row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED")],
      outcomeKind: "VERDICT",
    });
    const h = renderToStaticMarkup(createElement(AuditCompositionView, { audit: a, input: fx("D").input, asOf: "t" }));
    expect(h).toMatch(/data-testid="audit-row"[^>]*data-blocked="true"/);
    expect(h).toContain("Not checked");
    expect(h).toContain("Sources could not be opened");
  });
});

/* ------------------------------------------------------------------ */
/* 4. THE GAP                                                          */
/* ------------------------------------------------------------------ */

describe("where the audit stops", () => {
  it("is chosen by the short answer's own priority: blocked, then not established, then partial — ladder order within", () => {
    const rows = rowsOf([
      row("MECHANISM_SPEC", "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]),
      row("GOVERNANCE_BASIS", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
      row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED"),
      row("NET_EFFECT", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
    ]);
    const boundary = auditBoundary(rows, "VERDICT");
    expect(auditGap(rows, boundary)?.component).toBe("EXECUTION_EVIDENCE");
    expect(auditGap(rows, boundary)?.kind).toBe("COULD_NOT_CHECK");
    // No blocked: the first unresolved in ladder order.
    const rows2 = rowsOf([
      row("MECHANISM_SPEC", "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]),
      row("GOVERNANCE_BASIS", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
      row("NET_EFFECT", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
    ]);
    expect(auditGap(rows2, auditBoundary(rows2, "VERDICT"))?.component).toBe("GOVERNANCE_BASIS");
    // No unresolved: the first partial WITH a reason.
    const rows3 = rowsOf([
      row("MECHANISM_SPEC", "SUPPORTED"),
      row("EXECUTION_EVIDENCE", "PARTIALLY_SUPPORTED", ["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]),
      row("NET_EFFECT", "PARTIALLY_SUPPORTED", ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]),
    ]);
    const g3 = auditGap(rows3, auditBoundary(rows3, "VERDICT"));
    expect(g3?.component).toBe("EXECUTION_EVIDENCE");
    expect(g3?.detail).toBe(REASON_CODE_EXPLANATIONS.MECHANICAL_PROVENANCE_NOT_ESTABLISHED);
    // Everything stood: no gap, and the view says so.
    const rows4 = rowsOf([row("MECHANISM_SPEC", "SUPPORTED"), row("SOURCE_OF_VALUE", "SUPPORTED")]);
    expect(auditGap(rows4, auditBoundary(rows4, "VERDICT"))).toBeNull();
  });

  it("is one block with one full sentence, and counts the rest instead of listing them", () => {
    const h = html("D");
    expect(h.match(/data-testid="audit-gap-detail"/g)?.length).toBe(1);
    const a = audit("D");
    expect(a.gap).not.toBeNull();
    expect(h).toContain(escape(a.gap!.detail));
    expect(h).toContain(`${a.boundary.length - 1} other open checks in the table`);
  });

  it("names the fixture's mechanism-execution gap in the words the record uses", () => {
    // Fixture A: nothing unresolved, execution partly established under
    // D-158 — the gap the audit exists to name.
    const g = audit("A").gap!;
    expect(g.component).toBe("EXECUTION_EVIDENCE");
    expect(g.kind).toBe("PARTLY_ESTABLISHED");
    expect(html("A")).toContain("nothing read from the chain ties what happened to the documented mechanism itself");
  });
});

/* ------------------------------------------------------------------ */
/* 5. THE SEVEN AUDIT INVARIANTS                                       */
/* ------------------------------------------------------------------ */

describe("audit safety invariants", () => {
  it("NOT_ESTABLISHED ≠ FALSE: an unestablished check is amber, never red, and never accused", () => {
    expect(proofStateOfRung("UNRESOLVED")).toBe("NOT_ESTABLISHED");
    expect(proofStateOfRung("NOT_HAPPENING")).toBe("CONTRADICTED");
    const h = html("D");
    expect(h.match(/data-testid="audit-row" data-state="CONTRADICTED"/g)).toBeNull();
    expect(h).not.toMatch(/\b(false|fake|lied|misleading|fraud|violat|deceiv)/i);
  });

  it("ABSENCE OF EVIDENCE ≠ EVIDENCE OF ABSENCE: the unresolved rows say what was not found, never what is not so", () => {
    for (const c of audit("D").checks.filter((x) => x.state === "NOT_ESTABLISHED")) {
      expect(c.established).not.toMatch(/does not|did not|is not|no such|never/);
    }
    expect(html("D")).toContain("is not a check that failed");
  });

  it("DOCUMENTED ≠ APPROVED ≠ ACTIVATED ≠ EXECUTING: four rows, four independent states", () => {
    const checks = Object.fromEntries(auditChecks(rowsOf(fx("C").input.components)).map((c) => [c.component, c.state]));
    expect(checks).toEqual({
      MECHANISM_SPEC: "ESTABLISHED",
      GOVERNANCE_BASIS: "ESTABLISHED",
      CURRENT_STATE: "PARTLY_ESTABLISHED",
      EXECUTION_EVIDENCE: "NOT_ESTABLISHED",
    });
  });

  it("TRANSACTION HAPPENED ≠ CLAIMED MECHANISM EXECUTED: the flow still breaks where the selector's does", () => {
    const flow = audit("E").analytical.find((b) => b.type === "FLOW");
    expect(flow && flow.type === "FLOW" && flow.spec.stages.find((s) => s.step === "EXECUTION")?.state).toBe("NOT_ESTABLISHED");
    expect(audit("E").checks.find((c) => c.component === "EXECUTION_EVIDENCE")!.state).toBe("PARTLY_ESTABLISHED");
  });

  it("ADDRESS EXISTS ≠ ECONOMIC ROLE ESTABLISHED: the audit never renders an entity block", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) expect(html(f.key), f.key).not.toContain('data-testid="block-entities"');
  });

  it("BURN ≠ NET DEFLATION: a burn is an execution measure and the net-effect check is its own row", () => {
    const a = audit("B");
    const metric = a.analytical.find((b) => b.type === "METRIC");
    const burn = metric && metric.type === "METRIC" ? metric.spec.metrics.find((m) => m.factKind === "BURN") : undefined;
    expect(burn?.step).toBe("EXECUTION");
    const by = Object.fromEntries(a.checks.map((c) => [c.component, c.state]));
    expect(by.EXECUTION_EVIDENCE).toBe("ESTABLISHED");
    expect(by.NET_EFFECT).toBe("CONTRADICTED");
  });

  it("MEASUREMENT ≠ CAUSAL ATTRIBUTION: no audit text states a cause", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      expect(html(f.key), f.key).not.toMatch(/\bcaused\b/i);
      expect(JSON.stringify(audit(f.key)), f.key).not.toMatch(/ATTRIBUTION|CAUSAL/);
    }
  });

  it("no audit presentation strengthens upstream: a partly established check is never shown established", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      for (const c of f.input.components.filter((x) => x.status === "PARTIALLY_SUPPORTED")) {
        expect(audit(f.key).checks.find((x) => x.component === c.component)!.state, `${f.key} ${c.component}`).toBe("PARTLY_ESTABLISHED");
      }
      expect(html(f.key)).not.toContain("undefined");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. THE DEV ROUTE                                                    */
/* ------------------------------------------------------------------ */

describe("the dev route's audit mode", () => {
  it("is one parameter on the existing route, gated like it, with the historical warning for a real job", () => {
    const page = readFileSync("app/(app)/dev/output-plan/page.tsx", "utf-8");
    expect(page).toContain('one(params.view) === "audit"');
    expect(page).toContain('process.env.NODE_ENV === "production"');
    expect(page).toContain("real-job-banner");
    expect(page).not.toMatch(/db\.|drizzle|getDb|fetch\(/);
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
