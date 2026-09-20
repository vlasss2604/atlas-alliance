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
const RESULT = "src/client/components/research-result.tsx";
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
  const page = codeOf(PAGE);
  const code = codeOf(RESULT);

  it("carries no mode switch and no view state; the surface is question and answer, what ATLAS found, sources, what remains unclear, then the door into the audit", () => {
    for (const c of [page, code]) {
      expect(c).not.toContain('data-testid="view-switch"');
      expect(c).not.toContain("<ViewSwitch");
      expect(c).not.toContain("ResultView");
      expect(c).not.toContain('label: "Verification"');
    }
    expect(page).toContain("<ResearchResult detail={detail} jobId={jobId} />");
    const panelAt = code.indexOf("<AnswerPanel");
    const tableAt = code.indexOf("<FindingsTable rows={surface.table} />");
    const sourcesAt = code.indexOf("<SourcesSection cards={surface.keyEvidence} />");
    const openAt = code.indexOf("<UnclearSection groups={surface.boundary} />");
    const doorAt = code.indexOf('data-testid="audit-entry"');
    expect(panelAt).toBeGreaterThan(-1);
    expect(tableAt).toBeGreaterThan(panelAt);
    expect(sourcesAt).toBeGreaterThan(tableAt);
    expect(openAt).toBeGreaterThan(sourcesAt);
    expect(doorAt).toBeGreaterThan(openAt);
    // Nothing deeper on this surface: no proof map, no ladder, no
    // verification composition, no evidence pile.
    for (const gone of ["<ProofChainView", "<ResultLadder", "<JobVerification", "<DeepEvidence", "<KeyEvidencePanel", "<BoundaryPanel"]) {
      expect(code, gone).not.toContain(gone);
    }
  });

  it("the answer panel keeps identity, question, answer and the checked-on line", () => {
    for (const id of ["answer-panel", "result-question", "answer-text", "answer-meta", "answer-checked"]) {
      expect(code, id).toContain(`data-testid="${id}"`);
    }
    // The sentences are the surface model's own derivation; the component
    // writes none of them.
    expect(code).toContain("{surface.answer.sentences.map((s) => (");
  });

  it("nothing deeper sits on the result: the audit is its own route, entered through exactly one door", () => {
    expect((code.match(/data-testid="audit-entry"/g) ?? []).length).toBe(1);
    expect(code).toContain("href={`/research/${jobId}/audit`}");
    for (const gone of ["<ResultLadder", "<JobVerification", "<ResearchProgress", "<details", 'data-testid="full-evidence"', 'data-testid="verification-view"', 'data-testid="progress-slot-finished"']) {
      expect(code, gone).not.toContain(gone);
    }
  });

  it("carries no view state at all; nothing navigates, nothing fetches", () => {
    for (const gone of ["deepOpenFromLocation", "deepOpen", "?view=", 'view === "verification"']) {
      expect(page, gone).not.toContain(gone);
    }
    expect(code).not.toContain("deepOpen");
    for (const c of [page, code]) {
      expect(c).not.toContain("window.history.replaceState(");
      expect(c).not.toMatch(/router\.(push|replace)\(/);
      expect(c).not.toContain("useSearchParams");
      expect(c).not.toMatch(/prepareAudit|startResearch|api\.research\(|fetch\(/);
    }
    expect((page.match(/\.getResearchJob\(/g) ?? []).length).toBe(2);
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
    // The product surface no longer renders the composition at all, and
    // passes no flag anywhere.
    const result = codeOf(RESULT);
    expect(result).not.toContain("<JobVerification");
    expect(result).not.toContain("historicalNote");
    expect(codeOf(PAGE)).not.toContain("historicalNote");
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
