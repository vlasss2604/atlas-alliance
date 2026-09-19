import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResearchJobDetail } from "../src/client/api";
import { composeAudit } from "../src/client/audit-composition";
import { AuditCompositionView } from "../src/client/components/result-blocks/audit-composition";
import { JobVerification } from "../src/client/components/job-verification";
import { chooseAnalyticalBlocks, inputFromResearchJobDetail } from "../src/client/output-plan";
import { outputPlanFixture } from "../src/client/output-plan-fixtures";
import { verdictLabel } from "../src/client/research-model";

// PRODUCT VERIFICATION TAB V1 — RESEARCH | VERIFICATION ON THE REAL RESULT.
//
// Two readings of ONE loaded payload. The switch changes which composition
// renders and nothing else: no second request, no recomputation, no
// research run, no model. These tests hold that the product page carries
// the switch, defaults to Research, keeps the identity and the question
// above both views, renders the approved Verification composition through
// a pure projection of the detail payload, and that a sparse job stays
// sparse there.

const PAGE = "app/(app)/research/[id]/page.tsx";
const VERIFICATION = "src/client/components/job-verification.tsx";
const BRIDGE = "src/client/components/result-blocks/real-job-plan.tsx";

function codeOf(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// A detail payload in the shape the result endpoint returns, built from a
// selector fixture so the same record can be checked through both paths.
function detailOf(key: string, overrides: Partial<ResearchJobDetail["job"]> = {}): ResearchJobDetail {
  const f = outputPlanFixture(key);
  return {
    job: {
      id: `job-${key}`,
      state: "COMPLETED",
      projectName: "Fixture project",
      projectTicker: "FIX",
      originalQuestion: f.input.question.text,
      createdAt: "2026-03-01T00:00:00.000Z",
      finishedAt: "2026-03-02T00:00:00.000Z",
      ...overrides,
    },
    proof: { verdict: f.input.verdict, confidence: { band: f.input.confidenceBand, score: 40 } },
    claimSupport: { intent: f.input.question.intent },
    mechanism: { flows: f.input.flows, unassignedGaps: [] },
    questionFindings: null,
    components: f.input.components.map((c) => ({
      patternStep: c.step,
      component: c.component,
      status: c.status,
      reasonCodes: [...c.reasonCodes],
      supportingEvidenceIds: [...c.supportingEvidenceIds],
      contradictingEvidenceIds: [...c.contradictingEvidenceIds],
      excludedEvidence: [],
      coverage: "COMPLETED",
    })),
    evidence: f.input.evidence.map((e) => ({ ...e, hasSnapshot: false, links: [], sourceType: "WEB", dataAsOf: null, valueSource: null, sourcePublisher: null })),
    quantities: [],
    snapshotEvidenceIds: [],
  } as unknown as ResearchJobDetail;
}

const render = (detail: ResearchJobDetail, historicalNote?: boolean) =>
  renderToStaticMarkup(createElement(JobVerification, { detail, historicalNote }));
const count = (h: string, id: string) => h.match(new RegExp(`data-testid="${id}"`, "g"))?.length ?? 0;

/* ------------------------------------------------------------------ */
/* 1. ONE RESEARCH OBJECT ON THE PRODUCT PAGE                          */
/* ------------------------------------------------------------------ */

// FOUNDER DECISION (2026-09-19, after the first live UI acceptance): a
// finished result is ONE object. The Research | Verification switch is
// gone; the verification composition is read further down the same page,
// behind the one disclosure that also holds the ladder and the audit.
describe("the result page is one Research object — no competing modes", () => {
  const code = codeOf(PAGE);

  it("carries no mode switch and no view state; the first screen is answer, proof map, key evidence, not-established", () => {
    expect(code).not.toContain('data-testid="view-switch"');
    expect(code).not.toContain("<ViewSwitch");
    expect(code).not.toContain("ResultView");
    expect(code).not.toContain('label: "Verification"');
    const panelAt = code.indexOf('data-testid="answer-panel"');
    const mapAt = code.indexOf("<ProofMap rows={briefing.keyFindings}");
    const evidenceAt = code.indexOf("<KeyEvidence items={keyEvidence}");
    const openAt = code.indexOf("<NotEstablished limitation={limitation}");
    const deepAt = code.indexOf('data-testid="full-evidence"');
    expect(panelAt).toBeGreaterThan(-1);
    expect(mapAt).toBeGreaterThan(panelAt);
    expect(evidenceAt).toBeGreaterThan(mapAt);
    expect(openAt).toBeGreaterThan(evidenceAt);
    expect(deepAt).toBeGreaterThan(openAt);
  });

  it("the answer panel keeps identity, question, verdict, confidence, answer and the sources footnote", () => {
    for (const id of ["answer-panel", "result-question", "confidence-band", "answer-text", "answer-metadata"]) {
      expect(code, id).toContain(`data-testid="${id}"`);
    }
    // The answer's limitation sentence moves to the boundary block; nothing
    // is dropped (splitMainLimitation is total).
    expect(code).toContain("const { answer, limitation } = splitMainLimitation(briefing.shortAnswer);");
    expect(code).toContain("{answer.map((s) => (");
  });

  it("everything deeper sits behind ONE disclosure: the ladder, the verification composition, the audit entry and the research process", () => {
    const deep = code.slice(code.indexOf('data-testid="full-evidence"'), code.indexOf("</details>"));
    expect(deep).toContain("<ResultLadder");
    expect(deep).toContain('data-testid="verification-view"');
    expect(deep).toContain("<JobVerification detail={detail} />");
    expect(deep).toContain('data-testid="audit-entry"');
    expect(deep).toContain("<ResearchProgress job={job} />");
    expect(deep).toContain('data-testid="progress-slot-finished"');
    // Exactly one ladder, one verification composition, one audit entry.
    expect((code.match(/<ResultLadder/g) ?? []).length).toBe(1);
    expect((code.match(/<JobVerification detail=\{detail\} \/>/g) ?? []).length).toBe(1);
    expect((code.match(/data-testid="audit-entry"/g) ?? []).length).toBe(1);
    // A failed or cancelled run has nothing to verify: the composition is
    // gated, the rest of the disclosure is not.
    expect(code).toContain('outcome.kind !== "FAILED" && outcome.kind !== "CANCELLED"');
    expect(deep).toMatch(/\{verifiable && \(\s*<div data-testid="verification-view">/);
  });

  it("a legacy ?view=verification link opens the disclosure; nothing navigates, nothing fetches", () => {
    expect(code).toContain('view === "verification" || view === "full"');
    expect(code).toContain("useState<boolean>(deepOpenFromLocation)");
    expect(code).toContain("open={deepOpen}");
    expect(code).not.toContain("window.history.replaceState(");
    expect(code).not.toMatch(/router\.(push|replace)\(/);
    expect(code).not.toContain("useSearchParams");
    expect((code.match(/\.getResearchJob\(/g) ?? []).length).toBe(2);
    expect(code).not.toMatch(/prepareAudit|startResearch|api\.research\(|fetch\(/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. THE VERIFICATION PROJECTION IS PURE                              */
/* ------------------------------------------------------------------ */

describe("JobVerification is a pure projection of the detail payload", () => {
  it("makes no request, calls no model, imports nothing from the server, and the dev bridge reuses it", () => {
    const src = readFileSync(VERIFICATION, "utf-8");
    expect(src).not.toMatch(/fetch\(|api\.|authenticate|anthropic|drizzle|getDb|useEffect|useState/);
    expect(src).not.toMatch(/from\s+["'][^"']*server\//);
    expect(src).toContain("inputFromResearchJobDetail(detail)");
    expect(src).toContain("chooseAnalyticalBlocks(input)");
    expect(src).toContain("composeAudit(");
    const bridge = readFileSync(BRIDGE, "utf-8");
    expect(bridge).toContain("<JobVerification detail={detail} />");
    expect(bridge).not.toContain("composeAudit(");
  });

  it("renders exactly the composition the selector and composeAudit produce for the same payload", () => {
    for (const key of ["A", "B", "D", "E"]) {
      const detail = detailOf(key);
      const input = inputFromResearchJobDetail(detail);
      const plan = chooseAnalyticalBlocks(input);
      const expected = renderToStaticMarkup(
        createElement(AuditCompositionView, {
          audit: composeAudit({
            input,
            components: detail.components.map((c) => ({
              component: c.component,
              status: c.status,
              reasonCodes: c.reasonCodes,
              supportingEvidenceIds: c.supportingEvidenceIds,
              contradictingEvidenceIds: c.contradictingEvidenceIds,
              excludedEvidence: c.excludedEvidence,
              coverage: c.coverage,
            })),
            outcomeKind: "VERDICT",
            projectName: detail.job.projectName,
            plan,
          }),
          input,
          asOf: detail.job.finishedAt!,
        }),
      );
      const h = render(detail, false);
      expect(h).toContain(expected);
      expect(count(h, "audit-composition")).toBe(1);
    }
  });

  it("a sparse job stays sparse: no chain, no signals, no contradiction panel", () => {
    const h = render(detailOf("D"));
    for (const absent of ["block-claim-chain", "block-flow", "block-metrics", "block-table", "block-chart", "block-timeline", "contradiction-item"]) {
      expect(h, absent).not.toContain(`data-testid="${absent}"`);
    }
    expect(h).toContain("No contradiction established.");
    expect(count(h, "block-verification-stops")).toBe(1);
  });

  // HISTORICAL WARNING — BEFORE → AFTER. The note was on by default, so the
  // first fresh current-semantics run was labelled historical the minute it
  // finished. The payload carries no semantics version and none is
  // invented: the component states the note only when a caller that KNOWS
  // the record is historical asks for it; the product route never asks,
  // and no date cutoff decides.
  it("does not claim a fresh product Verification is historical: the note is opt-in, absent by default, and the product page never opts in", () => {
    const fresh = detailOf("A", { createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    expect(count(render(fresh), "verification-historical-note")).toBe(0);
    expect(render(fresh)).not.toContain("semantics in force when this research ran");
    // Age is not a signal either way: an old finishedAt gets no note
    // without the explicit flag — nothing here guesses from a date.
    expect(count(render(detailOf("A")), "verification-historical-note")).toBe(0);
    expect(count(render(detailOf("A"), false), "verification-historical-note")).toBe(0);
    // The product page passes no flag.
    const page = codeOf(PAGE);
    expect(page).toContain("<JobVerification detail={detail} />");
    expect(page).not.toContain("historicalNote");
    const src = codeOf(VERIFICATION);
    expect(src).toContain("historicalNote = false");
    expect(src).not.toMatch(/Date\.now|new Date|cutoff|CUTOFF/);
  });

  it("a route that knows its record is historical can still carry the explicit warning", () => {
    const h = render(detailOf("A"), true);
    expect(count(h, "verification-historical-note")).toBe(1);
    expect(h).toContain("re-derived here");
    // The note precedes the composition.
    expect(h.indexOf('data-testid="verification-historical-note"')).toBeLessThan(h.indexOf('data-testid="audit-composition"'));
    // The dev bridge states it through its own banner, once, on a route
    // that renders only real earlier runs.
    const devRoute = readFileSync("app/(app)/dev/output-plan/page.tsx", "utf-8");
    expect(devRoute).toContain('data-testid="real-job-banner"');
    expect(devRoute).toContain("historical record");
  });

  it("a terminal product state outranks a persisted verdict, the rule the Research view already applies", () => {
    const label = verdictLabel(outputPlanFixture("B").input.verdict);
    const h = render(detailOf("B"));
    expect(h).toContain('data-testid="audit-verdict-label"');
    expect(h).toContain(label);
    // A run stopped at its budget limit keeps whatever verdict it persisted
    // — `jobOutcome` decides, not this component.
    const stopped = render(detailOf("B", { state: "BUDGET_LIMIT_REACHED" }));
    expect(stopped).toContain(label);
    // The page never renders Verification for a failed or cancelled run
    // (pinned above); should a caller do so, the composition still
    // presents the outcome's verdict rather than the Proof row's.
    const src = readFileSync(VERIFICATION, "utf-8");
    expect(src).toContain("verdict: outcome.verdict");
  });
});
