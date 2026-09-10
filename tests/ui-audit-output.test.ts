import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  auditBoundary,
  auditChecks,
  auditFindings,
  composeAudit,
  MAX_AUDIT_FINDINGS,
  proofStateOfRung,
  type AuditComposition,
} from "../src/client/audit-composition";
import { AuditCompositionView } from "../src/client/components/result-blocks/audit-composition";
import { chooseAnalyticalBlocks, proofStateOf, type AnalyticalOutputInputV1 } from "../src/client/output-plan";
import { OUTPUT_PLAN_FIXTURES, outputPlanFixture } from "../src/client/output-plan-fixtures";
import { SHORT_REASON } from "../src/client/components/result-blocks/audit-composition";
import { deriveResultLadder, REASON_CODE_EXPLANATIONS, type LadderComponentInput } from "../src/client/research-model";

// AUDIT OUTPUT V1 — A COMPOSITION MODE, NOT A SECOND ENGINE.
//
// An audit answers "what exactly was checked, where did it not line up, and
// what could not be verified?" from the SAME record, the SAME selector and
// the SAME blocks as the research result. These tests hold that: every
// state the audit shows is a persisted status read through the derivations
// the research screen already runs; nothing is scored, nothing is inferred,
// and no sentence strengthens what upstream said. And they hold the seven
// invariants an audit is most tempted to break, because an audit is where
// "not established" is most likely to be read as "false".

const AUDIT_SRC = "src/client/audit-composition.ts";
const AUDIT_VIEW = "src/client/components/result-blocks/audit-composition.tsx";

// These files explain at length what they refuse to do, and a guard that
// read the prose would forbid naming the thing being kept out. So it reads
// the code.
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

/* ------------------------------------------------------------------ */
/* 1. STRUCTURE — an audit is not the research page with a new title   */
/* ------------------------------------------------------------------ */

describe("the audit is structurally a different page", () => {
  it("leads with verdict, coverage and findings, and never with the research answer", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const h = html(f.key);
      const at = (id: string) => h.indexOf(`data-testid="${id}"`);
      expect(at("block-audit-verdict"), f.key).toBeGreaterThan(-1);
      // Coverage sits INSIDE the masthead as a compact grid; the full map
      // is a depth layer after everything that is scanned.
      expect(at("audit-coverage-grid"), f.key).toBeGreaterThan(at("block-audit-verdict"));
      expect(at("block-audit-findings"), f.key).toBeGreaterThan(at("audit-coverage-grid"));
      expect(at("block-claim-reality"), f.key).toBeGreaterThan(at("block-audit-findings"));
      expect(at("block-not-verified"), f.key).toBeGreaterThan(at("block-claim-reality"));
      expect(at("block-proof-map"), f.key).toBeGreaterThan(at("block-not-verified"));
      expect(at("block-deep-proof"), f.key).toBeGreaterThan(at("block-proof-map"));
      // One cell per check, in the grid.
      expect(h.match(/data-testid="coverage-cell"/g)?.length ?? 0, f.key).toBe(audit(f.key).coverage.length);
      // The research answer block is absent: an audit does not open with prose.
      expect(h, f.key).not.toContain('data-testid="block-answer"');
    }
  });

  it("frames the shared layers as audit layers without a second component", () => {
    const h = html("A");
    expect(h).toContain("Deep audit");
    expect(h).toContain("Key evidence");
    expect(h).toContain("Claim vs reality");
    expect(h).toContain("What could not be verified");
  });

  it("a sparse record yields a sparse audit", () => {
    const h = html("D");
    for (const absent of ["block-metrics", "block-flow", "block-chart", "block-timeline", "block-entities"]) {
      expect(h, absent).not.toContain(`data-testid="${absent}"`);
    }
    // But the audit-specific structure is all there.
    for (const present of ["block-audit-verdict", "block-audit-findings", "block-claim-reality", "block-not-verified", "block-evidence", "block-deep-proof"]) {
      expect(h, present).toContain(`data-testid="${present}"`);
    }
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

  it("every state shown equals the persisted component status, in every block", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = audit(f.key);
      const status = new Map(f.input.components.map((c) => [c.component, c.status]));
      for (const c of a.coverage) expect(c.state, `${f.key} map ${c.component}`).toBe(proofStateOf(status.get(c.component)));
      for (const c of a.checks) expect(c.state, `${f.key} check ${c.component}`).toBe(proofStateOf(status.get(c.component)));
      for (const x of a.findings) expect(x.state, `${f.key} finding ${x.component}`).toBe(proofStateOf(status.get(x.component)));
      for (const b of a.boundary) {
        const s = proofStateOf(status.get(b.component));
        if (b.kind === "PARTLY_ESTABLISHED") expect(s, `${f.key} boundary ${b.component}`).toBe("PARTLY_ESTABLISHED");
        else expect(s, `${f.key} boundary ${b.component}`).toBe("NOT_ESTABLISHED");
      }
    }
  });

  it("the analytical blocks are the selector's, exactly, and never an audit variant", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const plan = chooseAnalyticalBlocks(f.input);
      const chosen = plan.orderedBlocks.filter((b) => ["METRIC", "FLOW", "TABLE", "CHART", "TIMELINE"].includes(b.type));
      expect(audit(f.key).analytical, f.key).toEqual(chosen);
      expect(audit(f.key).evidence, f.key).toEqual(plan.orderedBlocks.find((b) => b.type === "EVIDENCE_SNAPSHOT") ?? null);
      expect(audit(f.key).deep, f.key).toEqual(plan.orderedBlocks.find((b) => b.type === "DEEP_PROOF") ?? null);
    }
  });

  it("invents no severity, risk score or second verdict vocabulary", () => {
    for (const file of [AUDIT_SRC, AUDIT_VIEW]) {
      const src = codeOf(file);
      expect(src, file).not.toMatch(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/);
      expect(src, file).not.toMatch(/risk\s*score|severity|\bscore\b/i);
      expect(src, file).not.toMatch(/fetch\(|anthropic|drizzle|getDb/i);
    }
  });

  it("reads no fragment and composes no sentence: every finding sentence is a row's own", () => {
    const src = codeOf(AUDIT_SRC);
    expect(src).not.toMatch(/fragment|summary|\.match\(|parseFloat|parseInt/);
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const rows = rowsOf(f.input.components);
      const own = new Set(rows.flatMap((r) => [r.shows, r.reason, r.limitation].filter((x): x is string => x !== null)));
      for (const x of audit(f.key).findings) expect(own.has(x.sentence), `${f.key} ${x.component}`).toBe(true);
      for (const b of audit(f.key).boundary) {
        // Boundary details are the row's reason/limitation or the ladder's
        // own fallback sentence — never composed here.
        expect(own.has(b.detail) || /was not established\.$|^This was not established\.$/.test(b.detail), `${f.key} ${b.component}: ${b.detail}`).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. MAIN FINDINGS                                                    */
/* ------------------------------------------------------------------ */

describe("main findings", () => {
  const row = (component: string, status: string, reasonCodes: string[] = [], coverage?: LadderComponentInput["coverage"]): LadderComponentInput => ({
    component,
    status,
    reasonCodes,
    supportingEvidenceIds: status === "INSUFFICIENT_EVIDENCE" ? [] : ["e"],
    contradictingEvidenceIds: [],
    coverage,
  });

  it("orders contradicted, then partly established, then not established — in ladder order within each", () => {
    const findings = auditFindings(
      rowsOf([
        row("SOURCE_OF_VALUE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
        row("MECHANISM_SPEC", "PARTIALLY_SUPPORTED", ["INSUFFICIENT_AUTHORITY"]),
        row("NET_EFFECT", "CONTRADICTED"),
        row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["MISSING_EXECUTION_EVIDENCE"]),
        row("GOVERNANCE_BASIS", "PARTIALLY_SUPPORTED", ["INDIRECT_ONLY"]),
      ]),
    );
    expect(findings.map((f) => [f.component, f.state])).toEqual([
      ["NET_EFFECT", "CONTRADICTED"],
      ["MECHANISM_SPEC", "PARTLY_ESTABLISHED"],
      ["GOVERNANCE_BASIS", "PARTLY_ESTABLISHED"],
      ["EXECUTION_EVIDENCE", "NOT_ESTABLISHED"],
      ["SOURCE_OF_VALUE", "NOT_ESTABLISHED"],
    ]);
  });

  it("is capped, and an established check is never a finding", () => {
    const many = rowsOf(
      ["MECHANISM_SPEC", "GOVERNANCE_BASIS", "CURRENT_STATE", "EXECUTION_EVIDENCE", "SOURCE_OF_VALUE", "FLOW_PATH", "DESTINATION"].map((c) =>
        row(c, "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]),
      ),
    );
    expect(auditFindings(many)).toHaveLength(MAX_AUDIT_FINDINGS);
    const allGood = rowsOf(["MECHANISM_SPEC", "SOURCE_OF_VALUE"].map((c) => row(c, "SUPPORTED")));
    expect(auditFindings(allGood)).toEqual([]);
    expect(renderToStaticMarkup(createElement(AuditCompositionView, {
      audit: composeAudit({ input: { ...fx("A").input, components: allGood.map((r) => ({ step: 1, component: r.component, status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["e"], contradictingEvidenceIds: [] })) }, components: allGood.map((r) => row(r.component, "SUPPORTED")), outcomeKind: "VERDICT" }),
      input: fx("A").input,
      asOf: "t",
    }))).toContain('data-testid="audit-no-findings"');
  });

  it("a gap with no persisted reason is not a finding — nothing is written to fill it", () => {
    const findings = auditFindings(rowsOf([row("SOURCE_OF_VALUE", "INSUFFICIENT_EVIDENCE", [])]));
    expect(findings).toEqual([]);
  });

  it("a BLOCKED check is never a finding: a fetch failure is not something learned about the project", () => {
    const rows = rowsOf([row("EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"], "BLOCKED")]);
    expect(auditFindings(rows)).toEqual([]);
    const boundary = auditBoundary(rows, "VERDICT");
    expect(boundary).toHaveLength(1);
    expect(boundary[0].kind).toBe("COULD_NOT_CHECK");
    expect(boundary[0].detail).toMatch(/could not|limit of the research run/i);
    expect(boundary[0].detail).not.toMatch(/project (does|did) not|false/i);
  });
});

/* ------------------------------------------------------------------ */
/* 4. CLAIM VS REALITY                                                 */
/* ------------------------------------------------------------------ */

describe("claim vs reality", () => {
  it("one row per assessed check, labelled with the ladder's own claim sentence", () => {
    const checks = auditChecks(rowsOf(fx("C").input.components));
    expect(checks.map((c) => c.component)).toEqual(["MECHANISM_SPEC", "GOVERNANCE_BASIS", "CURRENT_STATE", "EXECUTION_EVIDENCE"]);
    expect(checks.map((c) => c.check)).toEqual([
      "The project documents the mechanism",
      "A governing decision authorises it",
      "It is currently active",
      "It has been observed executing",
    ]);
    // A component with no persisted result is not a row: it was not checked.
    expect(auditChecks(rowsOf(fx("C").input.components)).some((c) => c.component === "NET_EFFECT")).toBe(false);
  });

  it("the established column is the row's own sentence: shows where reached, reason where not, limitation where blocked", () => {
    const checks = auditChecks(rowsOf([
      { component: "MECHANISM_SPEC", status: "SUPPORTED", supportingEvidenceIds: ["e"] },
      { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["MISSING_EXECUTION_EVIDENCE"] },
      { component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], coverage: "BLOCKED" },
    ]));
    const by = Object.fromEntries(checks.map((c) => [c.component, c]));
    expect(by.MECHANISM_SPEC.established).toMatch(/^The checked evidence establishes /);
    expect(by.EXECUTION_EVIDENCE.established).toBe("The mechanism is described, but nothing checked shows it actually running.");
    expect(by.NET_EFFECT.established).toMatch(/limit of the research run/);
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
    // Every finding on the sparse fixture is a gap, and none is a contradiction.
    expect(h.match(/data-testid="audit-finding" data-state="CONTRADICTED"/g)).toBeNull();
    expect(h).not.toMatch(/\b(false|fake|lied|misleading|fraud|violat|deceiv)/i);
  });

  it("ABSENCE OF EVIDENCE ≠ EVIDENCE OF ABSENCE: NO_EVIDENCE_FOUND lands in the boundary as not established", () => {
    const b = audit("D").boundary.filter((x) => x.kind === "NOT_ESTABLISHED");
    expect(b.length).toBeGreaterThan(0);
    for (const x of b) expect(x.detail).not.toMatch(/does not|did not|is not|no such|never/);
    expect(html("D")).toContain("Absence of evidence is not evidence of absence.");
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

  it("TRANSACTION HAPPENED ≠ CLAIMED MECHANISM EXECUTED: the audit's flow still breaks where the selector's does", () => {
    const flow = audit("E").analytical.find((b) => b.type === "FLOW");
    expect(flow && flow.type === "FLOW" && flow.spec.stages.find((s) => s.step === "EXECUTION")?.state).toBe("NOT_ESTABLISHED");
    // And the execution check reads its persisted status, not the transfer.
    expect(auditChecks(rowsOf(fx("E").input.components)).find((c) => c.component === "EXECUTION_EVIDENCE")!.state).toBe("PARTLY_ESTABLISHED");
    expect(html("E")).toContain("nothing read from the chain ties what happened to the documented mechanism itself");
  });

  it("ADDRESS EXISTS ≠ ECONOMIC ROLE ESTABLISHED: no audit renders an entity block the selector declined", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const declined = chooseAnalyticalBlocks(f.input).rejected.some((r) => r.type === "ENTITY");
      if (declined) expect(html(f.key), f.key).not.toContain('data-testid="block-entities"');
    }
    // The audit never renders ENTITY at all in V1, even where the selector chose one.
    expect(html("A")).not.toContain('data-testid="block-entities"');
  });

  it("BURN ≠ NET DEFLATION: a burn is an execution measure and the net-effect check is a separate row", () => {
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
      const h = html(f.key);
      expect(h, f.key).not.toMatch(/\bcaused\b|\battribut(ed|ion) to the mechanism\b.*established/i);
      expect(JSON.stringify(audit(f.key)), f.key).not.toMatch(/ATTRIBUTION|CAUSAL/);
    }
  });

  it("no audit presentation strengthens upstream: a partly established check is never shown established", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const h = html(f.key);
      const partial = f.input.components.filter((c) => c.status === "PARTIALLY_SUPPORTED").map((c) => c.component);
      for (const c of partial) {
        // The check row for a partly established component carries its state
        // label, and the composition never emits "Established" for it.
        const state = audit(f.key).checks.find((x) => x.component === c)!.state;
        expect(state, `${f.key} ${c}`).toBe("PARTLY_ESTABLISHED");
      }
      expect(h).not.toContain("undefined");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. THE DEV ROUTE                                                    */
/* ------------------------------------------------------------------ */

describe("the dev route's audit mode", () => {
  it("is one parameter on the existing route, gated like it, with the same historical warning for a real job", () => {
    const page = readFileSync("app/(app)/dev/output-plan/page.tsx", "utf-8");
    expect(page).toContain('one(params.view) === "audit"');
    expect(page).toContain('process.env.NODE_ENV === "production"');
    expect(page).toContain("real-job-banner");
    expect(page).not.toMatch(/db\.|drizzle|getDb|fetch\(/);
    const bridge = readFileSync("src/client/components/result-blocks/real-job-plan.tsx", "utf-8");
    expect(bridge).toContain("composeAudit");
    expect(bridge).toContain("api.getResearchJob");
  });

  it("the result view is unchanged by the audit mode", () => {
    const input: AnalyticalOutputInputV1 = fx("A").input;
    const plan = chooseAnalyticalBlocks(input);
    expect(plan.orderedBlocks.map((b) => b.type)).toEqual([
      "ANSWER", "PROOF_MAP", "METRIC", "FLOW", "TABLE", "CHART", "ENTITY", "TIMELINE", "EVIDENCE_SNAPSHOT", "DEEP_PROOF",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. COMPRESSION IS VISUAL, NEVER SEMANTIC                            */
/* ------------------------------------------------------------------ */

describe("the compressed audit folds text; it does not remove it", () => {
  it("every short form is keyed on a code that has a full sentence, and never strengthens it", () => {
    for (const [code, short] of Object.entries(SHORT_REASON)) {
      expect(REASON_CODE_EXPLANATIONS[code], code).toBeTruthy();
      expect(short, code).toMatch(/^[A-Z]/);
      expect(short.length, code).toBeLessThanOrEqual(40);
      // Describes the record, never the project: no verdict words, no
      // accusation, no cause.
      expect(short, code).not.toMatch(/\b(false|failed|fake|lied|fraud|caused|because|proves?|confirm)/i);
      expect(short, code).not.toContain("_");
    }
    // And every code with copy has a short form, so a tile never falls
    // back to a clamped sentence for a reason the product already names.
    for (const code of Object.keys(REASON_CODE_EXPLANATIONS)) {
      expect(SHORT_REASON[code], code).toBeTruthy();
    }
  });

  it("every finding tile keeps its full sentence in the DOM beneath the short form", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = audit(f.key);
      const h = html(f.key);
      const tiles = h.match(/data-testid="audit-finding"/g)?.length ?? 0;
      expect(tiles, f.key).toBe(a.findings.length);
      expect(h.match(/data-testid="finding-sentence"/g)?.length ?? 0, f.key).toBe(a.findings.length);
      for (const x of a.findings) expect(h, `${f.key} ${x.component}`).toContain(escape(x.sentence));
    }
  });

  it("every claim row keeps its full sentence in the fold, and shows a short form above it", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = audit(f.key);
      const h = html(f.key);
      expect(h.match(/data-testid="claim-row"/g)?.length ?? 0, f.key).toBe(a.checks.length);
      for (const c of a.checks) expect(h, `${f.key} ${c.component}`).toContain(escape(c.established));
      // The short "found" cell is never a raw code and never a sentence
      // written here: it is a phrase, a short form, or a state label.
      const founds = [...h.matchAll(/data-testid="claim-found">([^<]*)</g)].map((m) => m[1]);
      for (const text of founds) expect(text, f.key).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    }
  });

  it("every boundary chip carries its full detail, and the three kinds stay apart", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = audit(f.key);
      const h = html(f.key);
      expect(h.match(/data-testid="boundary-item"/g)?.length ?? 0, f.key).toBe(a.boundary.length);
      for (const b of a.boundary) expect(h, `${f.key} ${b.component}`).toContain(escape(b.detail));
      // A blocked check is chipped "Not checked", never "Not established".
      const blocked = a.boundary.filter((b) => b.kind === "COULD_NOT_CHECK");
      if (blocked.length > 0) expect(h).toContain("Not checked");
    }
  });

  it("the masthead is a fraction and a distribution, not a paragraph", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = audit(f.key);
      const h = html(f.key);
      const established = a.coverage.filter((c) => c.state === "ESTABLISHED").length;
      expect(h, f.key).toContain('data-testid="audit-fraction"');
      expect(h, f.key).toMatch(new RegExp(`>${established}</span><span[^>]*>/ ${a.coverage.length}</span>`));
      const chips = h.match(/data-testid="audit-distribution"[\s\S]*?<\/ul>/)?.[0] ?? "";
      const shown = [...chips.matchAll(/data-state="([A-Z_]+)"/g)].map((m) => m[1]);
      const nonZero = ["ESTABLISHED", "PARTLY_ESTABLISHED", "CONTRADICTED", "NOT_ESTABLISHED"].filter(
        (s) => a.coverage.some((c) => c.state === s),
      );
      expect(shown, f.key).toEqual(nonZero);
      // Subordinate, still present.
      expect(h, f.key).toContain("Coverage counts checks, not quality.");
    }
  });
});

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
