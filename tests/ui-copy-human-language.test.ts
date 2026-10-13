import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResearchAudit } from "../src/client/components/research-audit";
import { ResearchResult } from "../src/client/components/research-result";
import { researchAnswer } from "../src/client/research-model";
import {
  BOUNDARY_COPY,
  BOUNDARY_NEVER,
  buildResultSurface,
  FORBIDDEN_SURFACE_TOKENS,
  RESULT_STATE_WORDS,
  ROW_LIMIT_COPY,
  statementPhraseFor,
} from "../src/client/result-surface";
import { RESULT_FIXTURES, resultFixture } from "../src/client/result-surface-fixtures";

// THE FINAL COPY ROUND — HUMAN LANGUAGE, EXACT TRUTH.
//
// Every sentence a reader meets on the result, in the audit's research
// points and in a non-verdict outcome is now stated as a fact about the
// evidence — "The sources confirm …", "There is evidence …, but it is not
// fully confirmed. <why>", "The available evidence does not show …" —
// never as something ATLAS "established". These pins hold the two things
// that must both stay true: the words are a person's, and no sentence is
// stronger than the persisted row beneath it.

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
// Visible text only: tags stripped, and with them every title attribute,
// so the record's canonical vocabulary carried on a tooltip is not
// mistaken for copy.
const visibleText = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const ENGINE_PHRASES = [
  "ATLAS established",
  "could not establish",
  "Partially established",
  "partially established",
  "mechanism established",
  "Partially confirmed",
  "Not established",
  "Source of value",
  "Current state",
  "Net effect",
  "Flow path",
  "configured limit",
];

/* ------------------------------------------------------------------ */
/* 1. NO ENGINE VOCABULARY ON ANY USER-FACING SURFACE                   */
/* ------------------------------------------------------------------ */

describe("human language on every surface", () => {
  it("the result and the audit's research points show none of the engine's phrases, on every fixture", () => {
    for (const f of RESULT_FIXTURES) {
      const { detail } = resultFixture(f.key);
      const result = visibleText(render(createElement(ResearchResult, { detail, jobId: detail.job.id })));
      const auditHtml = render(createElement(ResearchAudit, { detail, jobId: detail.job.id, projection: null }));
      // The technical record is the engine's own ledger, by design; the
      // research points above it are the reader's surface.
      const points = visibleText(auditHtml.slice(0, auditHtml.indexOf('data-testid="technical-record"')));
      for (const phrase of [...ENGINE_PHRASES, ...FORBIDDEN_SURFACE_TOKENS]) {
        expect(result, `${f.key}/result: ${phrase}`).not.toContain(phrase);
        expect(points, `${f.key}/audit: ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it("the state words a reader sees are plain, and the audit uses the same ones as the result", () => {
    expect(RESULT_STATE_WORDS).toEqual({
      CONFIRMED: "Verified",
      PARTIAL: "Partly verified",
      NOT_ESTABLISHED: "Unresolved",
      CONTRADICTED: "Contradicted",
    });
    const { detail } = resultFixture("2");
    const audit = visibleText(render(createElement(ResearchAudit, { detail, jobId: detail.job.id, projection: null })));
    expect(audit).toContain("Partly verified");
    expect(audit).not.toContain("Partially confirmed");
  });

  it("the non-verdict answer (failed, cancelled, stopped) speaks of the evidence, not of ATLAS", () => {
    const components = [
      { component: "SOURCE_OF_VALUE", status: "SUPPORTED" },
      { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" },
    ];
    for (const outcomeKind of ["STOPPED_AT_LIMIT", "NO_CONCLUSION", "FAILED"] as const) {
      const text = researchAnswer({ verdict: null, outcomeKind, projectName: "Fixture Protocol", components }).join(" ");
      for (const phrase of ["established", "Not established", "could not establish"]) expect(text, outcomeKind).not.toContain(phrase);
    }
    const stopped = researchAnswer({ verdict: null, outcomeKind: "STOPPED_AT_LIMIT", projectName: "Fixture Protocol", components }).join(" ");
    expect(stopped).toContain("The available evidence does not show");
  });
});

/* ------------------------------------------------------------------ */
/* 2. THE ANSWER: FACT-FIRST, AND NEVER STRONGER THAN THE ROWS          */
/* ------------------------------------------------------------------ */

describe("the executive answer", () => {
  it("states what the sources confirm, and lists exactly the confirmed checks — never a partial or an open one", () => {
    for (const f of RESULT_FIXTURES) {
      const surface = buildResultSurface(resultFixture(f.key).detail);
      if (surface.outcomeKind !== "VERDICT") continue;
      const confirmed = surface.answer.sentences.find((s) => s.startsWith("The sources confirm "));
      const confirmedRows = surface.table.filter((r) => r.status === "CONFIRMED");
      if (confirmedRows.length === 0) {
        expect(confirmed, f.key).toBeUndefined();
        continue;
      }
      expect(confirmed, f.key).toBeDefined();
      for (const r of surface.table.filter((r) => r.status !== "CONFIRMED")) {
        expect(confirmed!, `${f.key}: ${r.component}`).not.toContain(statementPhraseFor(r.component, "the buyback"));
      }
    }
  });

  it("a partly verified check is never a bare 'partial': the sentence says what there is evidence for, that it is not fully confirmed, and why", () => {
    const surface = buildResultSurface(resultFixture("2").detail);
    const partial = surface.answer.sentences.find((s) => s.startsWith("There is evidence "));
    expect(partial).toBeDefined();
    expect(partial).toContain(", but it is not fully confirmed.");
    // The reason follows, and it is the persisted reason of the leading row.
    const lead = surface.table.filter((r) => r.status === "PARTIAL")[0];
    expect(lead.row.reason).toBeTruthy();
    expect(partial).toContain(lead.row.reason!);
    expect(partial).not.toMatch(/\bpartial(ly)?\b/i);
  });

  it("what the evidence does not show is said as such — never as absence, never as contradiction", () => {
    for (const key of ["3", "4", "5"]) {
      const text = buildResultSurface(resultFixture(key).detail).answer.sentences.join(" ");
      expect(text, key).toContain("The available evidence does not show ");
      for (const stronger of ["does not exist", "is not happening", "never", "the evidence points the other way", "not supported"]) {
        expect(text.toLowerCase(), `${key}: ${stronger}`).not.toContain(stronger);
      }
    }
  });

  it("a contradiction stays explicit and stays its own sentence", () => {
    const surface = buildResultSurface(resultFixture("6").detail);
    expect(surface.table.some((r) => r.status === "CONTRADICTED")).toBe(true);
    expect(surface.answer.sentences[0]).toMatch(/^On .*, the evidence points the other way\.$/);
    expect(surface.answer.sentences[0]).not.toContain("does not show");
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE THREE BOUNDARIES STAY DISTINCT, IN A READER'S WORDS           */
/* ------------------------------------------------------------------ */

describe("the boundary language", () => {
  it("a research limit, a missing source route and an evidence gap are three different sentences", () => {
    expect(BOUNDARY_COPY.TECHNICAL).toBe("The research limit was reached before all relevant sources could be checked.");
    expect(BOUNDARY_COPY.CONFIGURATION).toBe("ATLAS currently lacks a source route that can independently verify this point.");
    expect(BOUNDARY_COPY.SUBSTANTIVE).toBe("The available evidence does not settle this.");
    expect(ROW_LIMIT_COPY.TECHNICAL).toBe("The research limit was reached before this could be checked.");
    expect(ROW_LIMIT_COPY.CONFIGURATION).toBe(BOUNDARY_COPY.CONFIGURATION);
    expect(new Set(Object.values(BOUNDARY_COPY)).size).toBe(3);
    // What each must never be read as, still said.
    expect(BOUNDARY_NEVER.TECHNICAL).toContain("not a finding about the project");
    expect(BOUNDARY_NEVER.CONFIGURATION).toContain("not a finding that the mechanism is not executing");
    expect(BOUNDARY_NEVER.SUBSTANTIVE).toContain("not proof that the thing is absent");
  });

  it("the answer carries the technical sentence on a technical boundary, the capability sentence on a configuration boundary, and neither on an evidence gap", () => {
    const technical = buildResultSurface(resultFixture("4").detail).answer.sentences.join(" ");
    const configuration = buildResultSurface(resultFixture("5").detail).answer.sentences.join(" ");
    const substantive = buildResultSurface(resultFixture("3").detail).answer.sentences.join(" ");
    expect(technical).toContain("The research limit was reached before all relevant sources could be checked.");
    expect(technical).not.toContain("source route");
    expect(configuration).toContain("ATLAS currently lacks a source route that can independently verify this for Fixture Protocol.");
    expect(configuration).not.toContain("research limit");
    expect(substantive).not.toContain("research limit");
    expect(substantive).not.toContain("source route");
  });

  it("the rows say the same boundary in the same words, and the unclear section repeats none of a row's substantive sentence", () => {
    const { detail } = resultFixture("4");
    const surface = buildResultSurface(detail);
    const blocked = surface.table.filter((r) => r.status === "NOT_ESTABLISHED" && r.boundary?.kind === "TECHNICAL");
    expect(blocked.length).toBeGreaterThan(0);
    for (const r of blocked) expect(r.established).toBe(ROW_LIMIT_COPY.TECHNICAL);
    const html = render(createElement(ResearchResult, { detail, jobId: detail.job.id }));
    const unclear = visibleText(html.slice(html.indexOf('data-testid="unclear-section"')));
    expect(unclear).toContain("The research limit was reached before");
    expect(unclear).toContain(BOUNDARY_NEVER.TECHNICAL);
  });
});
