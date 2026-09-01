import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { deriveQuestionFindings, findingExplanation } from "../src/client/research-model";

// THE TOP OF THE RESULT, AS ONE OBJECT.
//
// Three things were wrong with it, all presentation and none of them about
// what the research found:
//
//   The project identity and the question sat in a header ABOVE the panel
//   where the answer began, so the screen read as a banner beside an
//   unrelated result window.
//
//   The question — the one thing a reader most needs on returning to a
//   finished research — was a grey subtitle under a 2.15rem project name.
//   The project names the subject; the question names the task.
//
//   The boundary described ATLAS's workflow ("The evidence stops at…")
//   rather than the reader's knowledge, and the source footnote invited
//   exactly the source arithmetic this product refuses.

const PAGE = "app/(app)/research/[id]/page.tsx";
const page = readFileSync(PAGE, "utf-8");

// Comments legitimately quote the old copy to explain why it is gone, so
// strip them before scanning for it.
const code = page
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* 1-2. ONE COMPOSITION, WITH THE QUESTION IN IT                       */
/* ------------------------------------------------------------------ */

describe("the top of the result is one object", () => {
  it("TEST 1: the question renders inside the primary result panel", () => {
    const panelAt = code.indexOf('data-testid="answer-panel"');
    const questionAt = code.indexOf('data-testid="result-question"');
    const answerAt = code.indexOf('data-testid="answer-text"');
    expect(panelAt).toBeGreaterThan(-1);
    expect(questionAt).toBeGreaterThan(panelAt);
    // And it leads that panel — question, then status, then answer.
    expect(questionAt).toBeLessThan(answerAt);
    expect(code).toContain("{job.originalQuestion}");
  });

  it("TEST 2: the question is the heading, not a weak detached subtitle", () => {
    // It is the h1 of the screen: a question-driven product headlines the
    // question, not the project.
    expect(code).toMatch(/<h1[^>]*data-testid="result-question"/);

    // Above it, the project is an identity line rather than a display
    // heading — the old 2.15rem project name is gone.
    expect(code).not.toContain("sm:text-[2.15rem]");
    expect(code).not.toMatch(/<h1[^>]*>\s*\{projectName\}/);
    expect(code).toContain("{projectName}");

    // The question is set larger than the answer body, and in full text
    // colour — not the dim token it used to be a subtitle in. Scoped to
    // the <h1> tag itself, since the small label above it is legitimately
    // dim.
    const h1 = /<h1([\s\S]*?)>/.exec(code)?.[1] ?? "";
    expect(h1).toContain("text-[1.16rem]");
    expect(h1).toContain("font-semibold");
    expect(h1).not.toContain("var(--atlas-text-dim)");
    // Larger than the answer body it sits above.
    expect(code).toContain("text-[1.02rem]");
  });

  it("TEST 2b: only one heading competes at the top", () => {
    expect((code.match(/<h1/g) ?? [])).toHaveLength(1);
  });
});


/* ------------------------------------------------------------------ */
/* 3-4. THE BOUNDARY DESCRIBES KNOWLEDGE, NOT WORKFLOW                 */
/* ------------------------------------------------------------------ */

describe("the unresolved block names the fact, not the process", () => {
  it("TEST 3: process language is gone from the normal result", () => {
    for (const phrase of [
      "The evidence stops at",
      "evidence collection ends",
      "this stage ends",
      "ATLAS stopped here",
      "At this stage",
    ]) {
      expect(code, phrase).not.toContain(phrase);
    }
  });

  it("TEST 3b: it names the unresolved thing and why", () => {
    const block = code.slice(code.indexOf('data-testid="answer-boundary"'));
    // The unresolved finding's own label, then its canonical explanation.
    expect(block).toContain("{boundary.label}");
    expect(block).toContain("findingExplanation(boundary)");
  });

  it("TEST 4: an evidence gap and a research limitation are labelled differently", () => {
    const block = code.slice(code.indexOf('data-testid="answer-boundary"'));
    expect(block).toContain('boundary.coverage === "BLOCKED" ? "Research limitation" : "Still unresolved"');
  });

  it("TEST 4b: the limitation wording still refuses to blame the project", () => {
    const [blocked] = deriveQuestionFindings(
      [{ label: "Is it running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] }],
      [
        {
          component: "EXECUTION_EVIDENCE",
          status: "INSUFFICIENT_EVIDENCE",
          reasonCodes: ["NO_EVIDENCE_FOUND"],
          coverage: "BLOCKED",
        },
      ],
    );
    const text = findingExplanation(blocked).join(" ");
    expect(text).toContain("Required source access failed");
    expect(text).toContain("not evidence for or against the project");
    // It must never borrow the evidence-gap sentence, which asserts that
    // checking actually happened.
    expect(text).not.toContain("successfully checked");

    // And a genuine gap stays a statement about the evidence.
    const [gap] = deriveQuestionFindings(
      [{ label: "Is it running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] }],
      [
        {
          component: "EXECUTION_EVIDENCE",
          status: "INSUFFICIENT_EVIDENCE",
          reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
          coverage: "COMPLETED",
        },
      ],
    );
    const gapText = findingExplanation(gap).join(" ");
    expect(gapText).toContain("does not establish");
    expect(gapText).not.toContain("Required source access failed");
    expect(gapText).not.toContain("limit of the research run");
  });
});

/* ------------------------------------------------------------------ */
/* 5-7. SOURCE METADATA                                                */
/* ------------------------------------------------------------------ */

describe("the normal result shows what the answer rests on, and nothing else", () => {
  it("TEST 5: the not-used count is gone from the normal result", () => {
    expect(code).not.toContain("not used as evidence");
    expect(code).not.toContain("readDocs - usedDocs");
    expect(code).not.toMatch(/\{readDocs\}\s*\{readDocs === 1/);
  });

  it("TEST 6: it shows only the count of sources used as evidence", () => {
    const meta = code.slice(code.indexOf('data-testid="answer-metadata"'));
    expect(meta.slice(0, 260)).toContain("{usedDocs}");
    expect(meta.slice(0, 260)).toContain("used as evidence");
    // Rendered only when there is something to report.
    expect(code).toContain("{usedDocs > 0 && (");
  });

  it("TEST 6b: the count is a footnote, never styled as a score", () => {
    const meta = code.slice(code.indexOf('data-testid="answer-metadata"') - 400);
    const block = meta.slice(0, 700);
    // Smallest text on the panel, in the dim token — no badge, no tone
    // class, no progress or confidence affordance.
    expect(block).toContain("text-[0.75rem]");
    expect(block).toContain("var(--atlas-text-dim)");
    expect(block).not.toContain("tone-");
    expect(block).not.toContain("confidence");
  });

  it("TEST 7: the full audit keeps the complete accounting", () => {
    const audit = code.slice(code.indexOf("Full research audit"));
    for (const prop of ["readCount={readDocs}", "usedCount={usedDocs}", "excludedDocs", "otherDocs"]) {
      expect(audit, prop).toContain(prop);
    }
    // The section itself still separates refused from merely read.
    const section = readFileSync("src/client/components/evidence-section.tsx", "utf-8");
    expect(section).toContain("Sources ATLAS checked but did not use");
    expect(section).toContain("Other material read");
    expect(section).toContain("read and not used");
  });
});

/* ------------------------------------------------------------------ */
/* 8-12. NOTHING BELOW THE SURFACE MOVED                               */
/* ------------------------------------------------------------------ */

describe("presentation only", () => {
  it("TEST 8: canonical status derivation is untouched", () => {
    const rows = deriveQuestionFindings(
      [
        { label: "A", patternStep: 6, component: "DESTINATION", supportingComponents: [] },
        { label: "B", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
        { label: "C", patternStep: 7, component: "NET_EFFECT", supportingComponents: [] },
      ],
      [
        { component: "DESTINATION", status: "SUPPORTED", coverage: "COMPLETED" },
        { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
        { component: "NET_EFFECT", status: "CONTRADICTED", coverage: "COMPLETED" },
      ],
    );
    expect(rows.map((r) => r.stateLabel)).toEqual([
      "Established",
      "Not established",
      "Evidence indicates otherwise",
    ]);
  });

  it("TEST 9: the question projection contract is unchanged", () => {
    const projection = readFileSync("src/server/engine/question-projection.ts", "utf-8");
    expect(projection).toContain("export const PROJECTION_VERSION = 1");
    expect(projection).toContain("export const MIN_FINDINGS = 2");
    expect(projection).toContain("export const MAX_FINDINGS = 5");
    // The page still consumes it exactly as before.
    expect(code).toContain("questionFindings={detail.questionFindings}");
    expect(code).toContain("evidenceByComponent={evidenceByComponent}");
  });

  it("TEST 10: no model call and no research call reaches the screen", () => {
    for (const file of [PAGE, "src/client/components/result-ladder.tsx", "src/client/research-model.ts"]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("anthropic");
      expect(src, file).not.toContain("generateQuestionProjection");
    }
  });

  it("TEST 11 + 12: the engine and its schema were not touched by this round", () => {
    // The generation hook and its ordering are exactly as the previous
    // round left them.
    const runJob = readFileSync("src/server/engine/run-job.ts", "utf-8");
    expect(runJob).toContain("generateQuestionProjectionSafely(db, jobId)");
    expect(runJob.lastIndexOf("buildAndPersistProof(db, jobId)")).toBeLessThan(
      runJob.indexOf("generateQuestionProjectionSafely(db, jobId)"),
    );
    // And 0040 is still the newest migration.
    const journal = JSON.parse(
      readFileSync("src/server/db/migrations/meta/_journal.json", "utf-8"),
    ) as { entries: { idx: number; tag: string }[] };
    const newest = journal.entries[journal.entries.length - 1];
    expect(newest.tag).toBe("0040_question_projection");
  });
});
