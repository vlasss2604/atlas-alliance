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
/* 1. THE SWITCH ON THE PRODUCT PAGE                                   */
/* ------------------------------------------------------------------ */

describe("the result page carries Research | Verification", () => {
  const code = codeOf(PAGE);

  it("has one switch with exactly the two modes, inside the result header, and defaults to Research", () => {
    expect(code).toContain('data-testid="view-switch"');
    expect(code).toContain("data-testid={`view-${o.key}`}");
    expect(code).toMatch(/label: "Research"/);
    expect(code).toMatch(/label: "Verification"/);
    // Default Research: the URL initialiser returns it for anything but
    // an explicit `?view=verification`, and the server render has no URL.
    expect(code).toContain('if (typeof window === "undefined") return "research";');
    expect(code).toContain('get("view") === "verification" ? "verification" : "research"');
    expect(code).toContain("useState<ResultView>(viewFromLocation)");
    // The switch lives inside the answer panel, under the identity and
    // above the question — so switching never hides who or what.
    const panelAt = code.indexOf('data-testid="answer-panel"');
    const switchAt = code.indexOf("<ViewSwitch");
    const questionAt = code.indexOf('data-testid="result-question"');
    expect(switchAt).toBeGreaterThan(panelAt);
    expect(switchAt).toBeLessThan(questionAt);
    // Two placements, one control: beside the identity from `sm`, full
    // width beneath it on a handset.
    expect(code).toContain('className="hidden sm:inline-flex"');
    expect(code).toContain('className="mt-4 inline-flex w-full sm:hidden"');
    // Both placements are gated on the same condition, so a failed or
    // cancelled run — a fault, not a finding — offers no verification.
    expect((code.match(/\{verifiable && <ViewSwitch/g) ?? []).length).toBe(2);
    expect(code).toContain('outcome.kind !== "FAILED" && outcome.kind !== "CANCELLED"');
    expect(code).toContain('const shown: ResultView = verifiable ? view : "research";');
  });

  it("the Research view is untouched: identity, question, badges, answer, briefing, ladder all still render in that mode", () => {
    for (const id of ["answer-panel", "result-question", "confidence-band", "answer-text", "answer-metadata", "audit-entry"]) {
      expect(code, id).toContain(`data-testid="${id}"`);
    }
    expect(code).toMatch(/shown === "research" && \(\s*<ResultBriefing/);
    expect(code).toMatch(/shown === "research" && \(\s*<ResultLadder/);
    // The Verification view renders the approved composition for the SAME
    // detail, and only where there is a result to verify.
    expect(code).toMatch(/shown === "verification" && \(\s*<div data-testid="verification-view">\s*<JobVerification detail=\{detail\} \/>/);
  });

  it("view state is local and mirrored into ?view= with the History API — the switch never navigates and never fetches", () => {
    expect(code).toContain('get("view") === "verification"');
    expect(code).toContain("window.history.replaceState(");
    expect(code).not.toMatch(/router\.(push|replace)\(/);
    expect(code).not.toContain("useSearchParams");
    expect(code).not.toContain("useEffect(() => {\n    setView");
    // The only reads of the job are the ones the page always made.
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
    expect(bridge).toContain("<JobVerification detail={detail} historicalNote={false} />");
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

  it("states the historical-semantics note on the product surface, and lets the dev bridge (which has its own banner) suppress it", () => {
    const h = render(detailOf("A"));
    expect(count(h, "verification-historical-note")).toBe(1);
    expect(h).toContain("not");
    expect(h).toContain("re-derived here");
    expect(count(render(detailOf("A"), false), "verification-historical-note")).toBe(0);
    // The note precedes the composition.
    expect(h.indexOf('data-testid="verification-historical-note"')).toBeLessThan(h.indexOf('data-testid="audit-composition"'));
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
