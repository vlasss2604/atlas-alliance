import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { DeveloperDetails } from "../src/client/components/developer-details";
import { EvidenceDocumentCard } from "../src/client/components/evidence-document-card";
import { RecentProofCard } from "../src/client/components/recent-proof-card";
import { ResearchGroupCard } from "../src/client/components/research-group-card";
import { ResearchProgress } from "../src/client/components/research-progress";
import { ResultLadder } from "../src/client/components/result-ladder";
import { OutcomeBadge, VerdictBadge } from "../src/client/components/verdict-badge";
import {
  deriveProgress,
  deriveResultLadder,
  groupEvidenceByDocument,
  groupResearchRuns,
  jobOutcome,
  researchAnswer,
  verdictTone,
} from "../src/client/research-model";

// UI — the screens are a PROJECTION of persisted research truth.
//
// These tests pin the properties that make that claim true: the live stage
// comes from the engine's own phase, a missing result never becomes a
// negative finding, one acquired document is one source, excluded material
// never appears as support, the answer leads and the analytical structure
// follows, and no screen carries a conclusion about a named project.
//
// Rendering is done with react-dom/server, which the app already depends on —
// no DOM environment and no test-only UI framework was added for this.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const RESULT_PAGE = "app/(app)/research/[id]/page.tsx";

function job(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    state: "SUCCEEDED",
    progressStage: 5,
    memoryStatus: "NOT_USED",
    acquisitionPhase: "EXTRACTING" as const,
    acquisitionPhaseAt: "2026-08-31T17:30:00.000Z",
    terminationReason: "WORK_QUEUE_EXHAUSTED",
    originalQuestion: "Where do the trading fees go?",
    unread: false,
    createdAt: "2026-08-31T17:00:00.000Z",
    finishedAt: "2026-08-31T17:31:00.000Z",
    projectName: "Fixture Project",
    projectSlug: "fixture",
    projectTicker: "FIX",
    verdict: "PARTIALLY_SUPPORTED",
    ...over,
  } as never as import("../src/client/api").ResearchJobListItem;
}

/* ------------------------------------------------------------------ */
/* HOME                                                                */
/* ------------------------------------------------------------------ */

describe("UI — Home", () => {
  it("renders a real completed Proof record, with its persisted verdict", () => {
    const html = render(createElement(RecentProofCard, { job: job() }));
    expect(html).toContain("Fixture Project");
    expect(html).toContain("Where do the trading fees go?");
    expect(html).toContain('data-verdict="PARTIALLY_SUPPORTED"');
    expect(html).toContain(`href="/research/11111111-1111-1111-1111-111111111111"`);
  });

  it("starting research uses the EXISTING interpret → gate → start flow", () => {
    const src = readFileSync("src/client/components/research-composer.tsx", "utf-8");
    expect(src).toContain("api.interpret(");
    expect(src).toContain("api.clarify(");
    expect(src).toContain("api.startResearch(");
    expect(src).toContain("canStartProof");
    expect(src).toContain("proofBlockReason");
    expect(src).toContain("crypto.randomUUID()");
    expect(src).not.toMatch(/fetch\(\s*["'`]\/api\//);
  });
});

/* ------------------------------------------------------------------ */
/* 1-2. RESEARCH HISTORY GROUPING                                      */
/* ------------------------------------------------------------------ */

describe("UI — research history grouping", () => {
  it("TEST 1: repeated runs of the same question collapse into one group", () => {
    const runs = [
      job({ id: "a", createdAt: "2026-08-31T10:00:00Z", finishedAt: "2026-08-31T10:05:00Z" }),
      job({ id: "b", createdAt: "2026-08-31T11:00:00Z", finishedAt: "2026-08-31T11:05:00Z" }),
      job({
        id: "c",
        createdAt: "2026-08-31T12:00:00Z",
        finishedAt: "2026-08-31T12:05:00Z",
        verdict: "INSUFFICIENT_EVIDENCE",
      }),
    ];
    const groups = groupResearchRuns(runs);
    expect(groups).toHaveLength(1);
    expect(groups[0].runCount).toBe(3);
    // One question, three runs — question-level history is preserved, not
    // flattened away.
    expect(groups[0].questions).toHaveLength(1);
    expect(groups[0].questions[0].runs).toHaveLength(3);
    // "Latest" is the newest run, and its outcome is the group's headline.
    expect(groups[0].latest.id).toBe("c");
    expect(groups[0].latestOutcome.verdict).toBe("INSUFFICIENT_EVIDENCE");

    const html = render(createElement(ResearchGroupCard, { group: groups[0] }));
    expect(html).toContain("3 research runs");
    expect(html).toContain("Fixture Project");
  });

  it("TEST 1b: whitespace and case do not split one question", () => {
    const groups = groupResearchRuns([
      job({ id: "a", originalQuestion: "Where do the fees go?" }),
      job({ id: "b", originalQuestion: "  where do   the FEES go?  " }),
    ]);
    expect(groups[0].questions).toHaveLength(1);
  });

  it("TEST 2: materially different questions for one project are NOT merged", () => {
    const groups = groupResearchRuns([
      job({ id: "a", originalQuestion: "Where do the trading fees go?" }),
      job({ id: "b", originalQuestion: "Is the buyback still running today?" }),
      job({ id: "c", originalQuestion: "Where do the trading fees go?" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].runCount).toBe(3);
    // Two distinct questions survive inside the project group.
    expect(groups[0].questions).toHaveLength(2);
    const questions = groups[0].questions.map((q) => q.question).sort();
    expect(questions).toEqual([
      "Is the buyback still running today?",
      "Where do the trading fees go?",
    ]);
  });

  it("TEST 2b: different projects never merge, and identity is the slug", () => {
    const groups = groupResearchRuns([
      job({ id: "a", projectSlug: "one", projectName: "Same Display Name" }),
      job({ id: "b", projectSlug: "two", projectName: "Same Display Name" }),
    ]);
    // Two projects that happen to render the same label stay separate,
    // because grouping is on the slug and not on the display name.
    expect(groups).toHaveLength(2);
  });

  it("TEST 2c: a product FAULT is never presented as a research finding", () => {
    const failed = jobOutcome({ state: "FAILED", verdict: null });
    const insufficient = jobOutcome({ state: "SUCCEEDED", verdict: "INSUFFICIENT_EVIDENCE" });
    // Different kind, different label, different tone — the two must not be
    // collapsed into one meaning.
    expect(failed.kind).toBe("FAILED");
    expect(insufficient.kind).toBe("VERDICT");
    expect(failed.label).not.toBe(insufficient.label);
    expect(failed.tone).not.toBe(insufficient.tone);
    expect(failed.verdict).toBeNull();

    // And the other non-verdict states each read as themselves.
    expect(jobOutcome({ state: "SUCCEEDED", verdict: null }).kind).toBe("NO_CONCLUSION");
    expect(jobOutcome({ state: "CANCELLED", verdict: null }).kind).toBe("CANCELLED");
    expect(jobOutcome({ state: "BUDGET_LIMIT_REACHED", verdict: null }).kind).toBe(
      "STOPPED_AT_LIMIT",
    );
    expect(jobOutcome({ state: "RUNNING", verdict: null }).kind).toBe("IN_PROGRESS");
  });

  it('TEST 2d: "No proof" never reaches a reader', () => {
    for (const state of ["SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"]) {
      const html = render(
        createElement(OutcomeBadge, { job: { state, verdict: null } }),
      );
      expect(html.toLowerCase()).not.toContain("no proof");
    }
    const listHtml = render(createElement(RecentProofCard, { job: job({ verdict: null }) }));
    expect(listHtml.toLowerCase()).not.toContain("no proof");
  });
});

/* ------------------------------------------------------------------ */
/* 3. ANSWER FIRST                                                     */
/* ------------------------------------------------------------------ */

describe("UI — answer first", () => {
  const components = [
    { component: "MECHANISM_SPEC", status: "SUPPORTED" },
    { component: "GOVERNANCE_BASIS", status: "SUPPORTED" },
    { component: "DESTINATION", status: "SUPPORTED" },
    { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" },
    { component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE" },
  ];

  it("TEST 3: the answer leads the screen; everything else is below it", () => {
    const src = readFileSync(RESULT_PAGE, "utf-8");
    const answerAt = src.indexOf('data-testid="answer-panel"');
    const ladderAt = src.indexOf("<ResultLadder");
    const auditAt = src.indexOf('data-testid="progress-slot-finished"');
    const evidenceAt = src.indexOf("<EvidenceSection");
    const devAt = src.indexOf("<DeveloperDetails");
    for (const at of [answerAt, ladderAt, auditAt, evidenceAt, devAt]) {
      expect(at).toBeGreaterThan(-1);
    }
    // Answer → the findings → the full audit → engine internals.
    expect(answerAt).toBeLessThan(ladderAt);
    expect(ladderAt).toBeLessThan(auditAt);
    expect(auditAt).toBeLessThan(devAt);
    // The document inventory is INSIDE the audit now, not a section of the
    // normal result: proof reaches a reader through the finding it proves,
    // so a general source list has no place above this point.
    expect(evidenceAt).toBeGreaterThan(auditAt);
    expect(evidenceAt).toBeLessThan(devAt);
  });

  it("TEST 3b: the answer is plain language, and never claims more than the evidence", () => {
    const sentences = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      outcomeKind: "VERDICT",
      projectName: "Fixture Project",
      components,
    });
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    // THREE, not four. A fourth sentence is the one nobody reaches on a
    // screen meant to be read in half a minute.
    expect(sentences.length).toBeLessThanOrEqual(3);
    const text = sentences.join(" ");
    // The old opening — "3 parts of the chain are established" — was analyst
    // metadata dressed as an answer. It must not come back.
    expect(text).not.toMatch(/\d+ parts? of the chain/);
    expect(text).not.toMatch(/^\d/);

    // THE EPISTEMIC FRAME STILL LEADS, IN ONE WORD INSTEAD OF SEVEN.
    // "Established:" carries exactly what "The checked evidence
    // establishes …" carried — a statement about what the EVIDENCE
    // reached, never about what is true of the world — but reaches the
    // fact itself far sooner. The world-claim collapse is still refused.
    expect(text).toContain("Established:");
    expect(text).toContain("Not established:");
    expect(text).not.toContain("ATLAS verified");
    expect(text).not.toContain("ATLAS could not verify");

    // And the verdict is no longer restated in prose above the facts —
    // the badge beside the answer already says it.
    expect(text).not.toContain("The checked evidence establishes part of what");
    expect(text).not.toContain("but not the whole path");
  });

  it("TEST 3c: every sentence is backed by a persisted component row", () => {
    // A component with NO row contributes nothing at all — it was not
    // assessed, and reporting it as unverified would misdescribe the run.
    const sentences = researchAnswer({
      verdict: "SUPPORTED",
      outcomeKind: "VERDICT",
      projectName: "Fixture Project",
      components: [{ component: "MECHANISM_SPEC", status: "SUPPORTED" }],
    }).join(" ");
    expect(sentences).toContain("documentation specifies");
    expect(sentences).not.toContain("net effect");
    expect(sentences).not.toContain("currently active");
  });

  it("TEST 3d: documentation never becomes execution, and no burn is inferred", () => {
    const sentences = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      outcomeKind: "VERDICT",
      projectName: "Fixture Project",
      components,
    }).join(" ");
    // MECHANISM_SPEC is SUPPORTED and EXECUTION_EVIDENCE is not; the answer
    // may never let the first stand in for the second.
    expect(sentences).toContain("whether the mechanism has actually executed");
    expect(sentences).toMatch(
      /Not established:[^.]*whether the mechanism has actually executed/,
    );
    expect(sentences.toLowerCase()).not.toContain("burn");
    expect(sentences.toLowerCase()).not.toContain("therefore");
    expect(sentences.toLowerCase()).not.toContain("which means");
  });

  it("TEST 3e: a failed run reports a fault, not a finding", () => {
    const sentences = researchAnswer({
      verdict: null,
      outcomeKind: "FAILED",
      projectName: "Fixture Project",
      components,
    }).join(" ");
    expect(sentences).toContain("did not complete");
    expect(sentences).toContain("not a finding about the project");
    expect(sentences).not.toContain("The checked evidence establishes");
  });

  it("TEST 3f: a budget-limited run reads as coverage, never as a negative result", () => {
    // Stopping early says nothing about the project. The wording must not
    // let "we did not finish looking" become "there is nothing there".
    const sentences = researchAnswer({
      verdict: null,
      outcomeKind: "STOPPED_AT_LIMIT",
      projectName: "Fixture Project",
      components,
    }).join(" ");
    expect(sentences).toContain("stopped at its limit");
    expect(sentences).toContain("covering everything");
    expect(sentences.toLowerCase()).not.toContain("not supported");
    expect(sentences.toLowerCase()).not.toContain("does not exist");
  });
});

/* ------------------------------------------------------------------ */
/* LIVE PROGRESS                                                       */
/* ------------------------------------------------------------------ */

describe("UI — live research state", () => {
  const stalePhaseCounter = 2;

  it("a FETCHING job shows the read-evidence stage, not memory", () => {
    const view = deriveProgress({
      state: "RUNNING",
      progressStage: stalePhaseCounter,
      acquisitionPhase: "FETCHING",
    });
    expect(view.source).toBe("ACQUISITION_PHASE");
    expect(view.stages[view.activeIndex].key).toBe("FETCH");
    expect(view.stages[1].state).toBe("DONE");

    const html = render(
      createElement(ResearchProgress, {
        job: { state: "RUNNING", progressStage: stalePhaseCounter, acquisitionPhase: "FETCHING" },
      }),
    );
    expect(html).toContain('data-stage="FETCH" data-state="ACTIVE"');
    expect(html).toContain('data-stage="MEMORY" data-state="DONE"');
  });

  it("an EXTRACTING job shows the verification stage", () => {
    const view = deriveProgress({
      state: "RUNNING",
      progressStage: stalePhaseCounter,
      acquisitionPhase: "EXTRACTING",
    });
    expect(view.stages[view.activeIndex].key).toBe("EXTRACT");
  });

  it("the stage counter is used ONLY before acquisition begins", () => {
    expect(
      deriveProgress({ state: "RUNNING", progressStage: 2, acquisitionPhase: null }).source,
    ).toBe("PROGRESS_STAGE");
    expect(
      deriveProgress({ state: "RUNNING", progressStage: 2, acquisitionPhase: "SEARCHING" })
        .stages[2].state,
    ).toBe("ACTIVE");
  });

  it("TEST 12: live progress is prominent, and TEST 11: finished progress is secondary", () => {
    const src = readFileSync(RESULT_PAGE, "utf-8");
    const liveAt = src.indexOf('data-testid="progress-slot-live"');
    const answerAt = src.indexOf('data-testid="answer-panel"');
    const finishedAt = src.indexOf('data-testid="progress-slot-finished"');
    const evidenceAt = src.indexOf('data-testid="section-evidence"');
    expect(liveAt).toBeGreaterThan(-1);
    expect(finishedAt).toBeGreaterThan(-1);

    // While running, progress sits above the answer slot — it is what the
    // user is waiting on.
    expect(liveAt).toBeLessThan(answerAt);
    // Once finished it is history: below the evidence, and collapsed.
    expect(finishedAt).toBeGreaterThan(evidenceAt);
    const finishedBlock = src.slice(finishedAt - 200, finishedAt + 200);
    expect(finishedBlock).toContain("<details");
    expect(finishedBlock).not.toMatch(/<details[^>]*\sopen/);

    // A terminal job renders no active stage at all.
    const html = render(
      createElement(ResearchProgress, {
        job: { state: "SUCCEEDED", progressStage: 2, acquisitionPhase: "EXTRACTING" },
      }),
    );
    expect(html).not.toContain('data-state="ACTIVE"');
  });
});

/* ------------------------------------------------------------------ */
/* VERDICTS                                                            */
/* ------------------------------------------------------------------ */

describe("UI — verdicts", () => {
  it("verdict badges map to their tone, and only NOT_SUPPORTED is red", () => {
    expect(verdictTone("SUPPORTED")).toBe("supported");
    expect(verdictTone("PARTIALLY_SUPPORTED")).toBe("partial");
    expect(verdictTone("INSUFFICIENT_EVIDENCE")).toBe("insufficient");
    expect(verdictTone("NOT_SUPPORTED")).toBe("negative");
    expect(verdictTone(null)).toBe("neutral");

    const insufficient = render(
      createElement(VerdictBadge, { verdict: "INSUFFICIENT_EVIDENCE" }),
    );
    expect(insufficient).toContain("tone-insufficient");
    expect(insufficient).not.toContain("tone-negative");
    expect(render(createElement(VerdictBadge, { verdict: "NOT_SUPPORTED" }))).toContain(
      "tone-negative",
    );
    // A broken run is neither: its own tone entirely.
    expect(
      render(createElement(OutcomeBadge, { job: { state: "FAILED", verdict: null } })),
    ).toContain("tone-fault");
  });
});

/* ------------------------------------------------------------------ */
/* 4-6. REALITY CHECK SEMANTICS                                        */
/* ------------------------------------------------------------------ */

describe("UI — absence of evidence is not evidence of absence", () => {
  it("TEST 4: an unresolved or unassessed row is never shown as disproven", () => {
    const view = deriveResultLadder([
      { component: "MECHANISM_SPEC", status: "SUPPORTED" },
      { component: "GOVERNANCE_BASIS", status: "INSUFFICIENT_EVIDENCE" },
      // CURRENT_STATE has no row at all.
    ]);
    const byComponent = Object.fromEntries(
      [...view.mechanism, ...view.value].map((r) => [r.component, r.state]),
    );
    expect(byComponent.MECHANISM_SPEC).toBe("VERIFIED");
    expect(byComponent.GOVERNANCE_BASIS).toBe("UNRESOLVED");
    // A component with no persisted result was not tested. It is absent
    // entirely rather than listed greyed-out, because an engine-internal
    // absence rendered beside real findings reads as one more failure.
    expect(byComponent.CURRENT_STATE).toBeUndefined();
    expect(
      [...view.mechanism, ...view.value].some((r) => r.state === "NOT_HAPPENING"),
    ).toBe(false);
  });

  it("TEST 6: \"evidence indicates otherwise\" comes only from a positive contradiction", () => {
    const contradicted = deriveResultLadder([
      { component: "NET_EFFECT", status: "CONTRADICTED" },
    ]);
    const row = contradicted.value.find((r) => r.component === "NET_EFFECT");
    expect(row?.state).toBe("NOT_HAPPENING");
    expect(row?.stateLabel).toBe("Evidence indicates otherwise");
    // And no other status can produce it.
    for (const status of ["INSUFFICIENT_EVIDENCE", "PARTIALLY_SUPPORTED", "SUPPORTED"]) {
      const view = deriveResultLadder([{ component: "NET_EFFECT", status }]);
      expect(view.value.find((r) => r.component === "NET_EFFECT")?.state).not.toBe(
        "NOT_HAPPENING",
      );
    }
  });

  it("TEST 6b: a contradiction stays distinct from an unresolved row, in state and in words", () => {
    const view = deriveResultLadder([
      { component: "NET_EFFECT", status: "CONTRADICTED" },
      { component: "RECIPIENT", status: "INSUFFICIENT_EVIDENCE" },
    ]);
    const contradicted = view.value.find((r) => r.component === "NET_EFFECT");
    const unresolved = view.value.find((r) => r.component === "RECIPIENT");
    expect(contradicted?.state).not.toBe(unresolved?.state);
    expect(contradicted?.stateLabel).not.toBe(unresolved?.stateLabel);
    // The strongest thing a run can say must not be flattened into the
    // weakest. "Not established" means nothing was shown; "evidence
    // indicates otherwise" means something was.
    expect(unresolved?.stateLabel).toBe("Not established");
  });

  it("TEST 5: an established independent finding is never implied impossible by a boundary", () => {
    // The exact shape that was confusing: the mechanism stops at "currently
    // active", while DESTINATION is independently established.
    const components = [
      { component: "MECHANISM_SPEC", status: "SUPPORTED" },
      { component: "GOVERNANCE_BASIS", status: "SUPPORTED" },
      { component: "CURRENT_STATE", status: "INSUFFICIENT_EVIDENCE" },
      { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" },
      { component: "DESTINATION", status: "SUPPORTED" },
    ];
    const view = deriveResultLadder(components);

    // The boundary belongs to the MECHANISM group and is found within it.
    expect(view.boundary?.component).toBe("CURRENT_STATE");
    expect(view.mechanism.map((r) => r.component)).toEqual([
      "MECHANISM_SPEC",
      "GOVERNANCE_BASIS",
      "CURRENT_STATE",
      "EXECUTION_EVIDENCE",
    ]);
    // DESTINATION is NOT in that group, so nothing about the boundary
    // reaches it.
    expect(view.mechanism.some((r) => r.component === "DESTINATION")).toBe(false);
    expect(view.value.find((r) => r.component === "DESTINATION")?.state).toBe("VERIFIED");

    const html = render(createElement(ResultLadder, { components }));
    const mechanismAt = html.indexOf('data-testid="ladder-mechanism"');
    const boundaryAt = html.indexOf('data-testid="ladder-boundary"');
    const valueAt = html.indexOf('data-testid="ladder-value"');
    expect(boundaryAt).toBeGreaterThan(mechanismAt);
    expect(boundaryAt).toBeLessThan(valueAt);
    // The second group is announced as separate rather than as later steps.
    expect(html).toContain("Established separately");
    expect(html).toContain("not later steps of the mechanism above");
    // And it never claims the rest is impossible.
    expect(html).not.toContain("Reality stops here");
  });

  it("TEST 5b: the boundary is only drawn where it is derivable", () => {
    // Nothing established in the mechanism group means there is no
    // established run to end, so no boundary is claimed — otherwise the
    // marker implies the first row was tested and failed.
    const nothing = deriveResultLadder([
      { component: "MECHANISM_SPEC", status: "INSUFFICIENT_EVIDENCE" },
    ]);
    expect(nothing.boundary).toBeNull();
    expect(render(createElement(ResultLadder, { components: [] }))).not.toContain(
      "The evidence stops here",
    );
  });

  it("TEST 4b: an unresolved row reads as a limit of the evidence, never as ATLAS failing", () => {
    const html = render(
      createElement(ResultLadder, {
        components: [
          {
            component: "EXECUTION_EVIDENCE",
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
            coverage: "COMPLETED" as const,
          },
        ],
      }),
    );
    expect(html).toContain("Not established");
    // The old copy said "ATLAS could not verify X" about what is usually a
    // fact concerning the public record, not a shortcoming of the run.
    expect(html).not.toContain("ATLAS could not verify");
    expect(html.toLowerCase()).not.toContain("error");
    expect(html.toLowerCase()).not.toContain("monitor");
  });

  it("TEST 4c: every assessed component is still listed, across the two groups", () => {
    const components = [
      "SOURCE_OF_VALUE",
      "FLOW_PATH",
      "EXECUTION_EVIDENCE",
      "CURRENT_STATE",
      "NET_EFFECT",
    ].map((component) => ({ component, status: "INSUFFICIENT_EVIDENCE" }));
    const view = deriveResultLadder(components);
    expect(view.mechanism.length + view.value.length).toBe(5);
    const html = render(createElement(ResultLadder, { components }));
    expect(html.match(/data-testid="ladder-row"/g) ?? []).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------ */
/* 7-9. EVIDENCE                                                       */
/* ------------------------------------------------------------------ */

const docItem = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "ev-1",
  component: "MECHANISM_SPEC",
  summary: "The documentation states the split.",
  fragment: "raw fragment",
  doesNotProve: null,
  sourceClass: "OFFICIAL_DOCS",
  officiality: "CONFIRMED",
  retrievedUrl: "https://docs.example.test/ray/protocol-fees.md",
  sourceTitle: null,
  ...over,
});

describe("UI — evidence is grouped by document", () => {
  it("TEST 7: one acquired document appears once, however many rows it produced", () => {
    const groups = groupEvidenceByDocument([
      docItem({ id: "a", component: "MECHANISM_SPEC" }),
      docItem({ id: "b", component: "DESTINATION" }),
      docItem({ id: "c", component: "RECIPIENT" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(3);
    expect(groups[0].name).toBe("protocol-fees.md");

    const html = render(
      createElement(EvidenceDocumentCard, { group: groups[0], role: "USED" }),
    );
    expect((html.match(/data-testid="evidence-doc-/g) ?? [])).toHaveLength(1);
  });

  it("TEST 7b: url variants of one document are one document, and two documents stay two", () => {
    const one = groupEvidenceByDocument([
      docItem({ id: "a", retrievedUrl: "https://docs.example.test/ray/protocol-fees.md" }),
      docItem({ id: "b", retrievedUrl: "https://www.docs.example.test/ray/protocol-fees.md#x" }),
    ]);
    expect(one).toHaveLength(1);

    const two = groupEvidenceByDocument([
      docItem({ id: "a", retrievedUrl: "https://docs.example.test/ray/protocol-fees.md" }),
      docItem({ id: "b", retrievedUrl: "https://docs.example.test/ray/ray-buybacks.md" }),
    ]);
    expect(two).toHaveLength(2);
  });

  it("TEST 8: one document may show several supported components", () => {
    const groups = groupEvidenceByDocument([
      docItem({ id: "a", component: "DESTINATION" }),
      docItem({ id: "b", component: "RECIPIENT" }),
      docItem({ id: "c", component: "DESTINATION" }),
    ]);
    expect(groups[0].components).toEqual(["DESTINATION", "RECIPIENT"]);

    const html = render(
      createElement(EvidenceDocumentCard, { group: groups[0], role: "USED" }),
    );
    expect(html).toContain('data-components="DESTINATION,RECIPIENT"');
    // The closed card states HOW MUCH of the mechanism the document carries,
    // not a row of component chips. Those chips rendered `componentLabel`,
    // so "Destination" and "Recipient" — the Pattern's own vocabulary —
    // reappeared here after the ladder above had stopped showing it. Which
    // claims a document touches is named properly once the card is open.
    expect(html).toContain("Supports 2 parts of the mechanism");
    expect(html).not.toContain(">Destination<");
    expect(html).not.toContain(">Recipient<");
  });

  it("TEST 9: excluded sources stay separate and are never labelled as support", () => {
    const groups = groupEvidenceByDocument([
      docItem({
        id: "x",
        sourceClass: "SOCIAL",
        retrievedUrl: "https://blog.example.test/post",
        exclusionReason: "CLASS_NOT_ADMISSIBLE",
      }),
    ]);
    const html = render(
      createElement(EvidenceDocumentCard, { group: groups[0], role: "EXCLUDED" }),
    );
    expect(html).toContain('data-role="EXCLUDED"');
    expect(html).toContain('data-source-class="SOCIAL"');
    expect(html).toContain("Considered for 1 part of the mechanism");
    expect(html).not.toContain("Supports ");
    expect(html).not.toContain(">Used<");
    expect(html).not.toContain(">Supporting<");

    // And the evidence section renders them under their own heading, never
    // merged into the supporting grid. That section now lives at Level 3,
    // closed by default, so the heading is asserted where it is written.
    const src = readFileSync("src/client/components/evidence-section.tsx", "utf-8");
    expect(src).toContain('data-testid="excluded-evidence"');
    expect(src).toContain("Sources ATLAS checked but did not use");
    expect(readFileSync(RESULT_PAGE, "utf-8")).toContain(
      'e.links.find((l) => l.role === "EXCLUDED")',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 10. COMPONENT BREAKDOWN                                             */
/* ------------------------------------------------------------------ */

const TEN_COMPONENTS = [
  "SOURCE_OF_VALUE",
  "FLOW_PATH",
  "MECHANISM_SPEC",
  "GOVERNANCE_BASIS",
  "EXECUTION_EVIDENCE",
  "CURRENT_STATE",
  "DESTINATION",
  "RECIPIENT",
  "NET_EFFECT",
  "DURABILITY_BASIS",
].map((component, i) => ({
  patternStep: i + 1,
  component,
  status: i < 3 ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
}));

describe("UI — the ladder carries every component, without the component grid", () => {
  it("TEST 10: compact by default, and every assessed component is still reachable", () => {
    const html = render(createElement(ResultLadder, { components: TEN_COMPONENTS }));
    // Every one of the ten is present as a row — nothing analytical was
    // dropped when the grid went away.
    expect(html.match(/data-testid="ladder-row"/g) ?? []).toHaveLength(10);
    // Compact by DEFAULT: no expansion is rendered until a row is opened.
    expect(html).not.toContain('data-testid="ladder-expansion"');
  });

  it("TEST 10b: raw reason codes never appear on the user-facing surface", () => {
    const html = render(
      createElement(ResultLadder, {
        components: [
          {
            component: "MECHANISM_SPEC",
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["ALL_EVIDENCE_EXCLUDED", "NO_EVIDENCE_FOUND"],
          },
        ],
      }),
    );
    expect(html).toContain("Not established");
    expect(html).not.toContain("ALL_EVIDENCE_EXCLUDED");
    expect(html).not.toContain("NO_EVIDENCE_FOUND");
    expect(html).not.toContain("INSUFFICIENT_EVIDENCE");
  });

  it("TEST 10c: no internal Pattern component name reaches a rendered label", () => {
    const html = render(createElement(ResultLadder, { components: TEN_COMPONENTS }));
    // The component is carried as a data attribute for keys and test hooks,
    // so strip those before looking at what a reader can actually see.
    const visible = html.replace(/data-component="[^"]*"/g, "");
    for (const name of TEN_COMPONENTS.map((c) => c.component)) {
      expect(visible, name).not.toContain(name);
    }
    // Nor the Pattern's own prose labels, which are precise for an analyst
    // and close to meaningless for a reader ("net effect on what?").
    for (const label of ["Net effect", "Flow path", "Durability basis", "Source of value"]) {
      expect(visible, label).not.toContain(label);
    }
  });
});

/* ------------------------------------------------------------------ */
/* DEVELOPER DETAILS                                                   */
/* ------------------------------------------------------------------ */

const detailFixture = {
  job: {
    id: "22222222-2222-2222-2222-222222222222",
    state: "SUCCEEDED",
    progressStage: 5,
    memoryStatus: "NOT_USED",
    acquisitionPhase: "EXTRACTING" as const,
    acquisitionPhaseAt: null,
    projectName: "Fixture Project",
    projectSlug: "fixture",
    projectTicker: "FIX",
    originalQuestion: "q",
    terminationReason: "WORK_QUEUE_EXHAUSTED",
    errorCode: null,
    origin: "PRODUCT",
    createdAt: "2026-08-31T17:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-08-31T17:31:00.000Z",
  },
  proof: null,
  claimSupport: null,
  mechanism: null,
  execution: {
    attemptedSteps: 8,
    attemptedComponents: 10,
    succeededComponents: 2,
    establishedComponents: 0,
  },
  finding: { componentKeys: [], supporting: [], contradicting: [], excluded: [] },
  questionFindings: null,
  components: [
    {
      patternStep: 3,
      component: "MECHANISM_SPEC",
      status: "INSUFFICIENT_EVIDENCE",
      coverage: "COMPLETED" as const,
      reasonCodes: ["ALL_EVIDENCE_EXCLUDED"],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
    },
  ],
  snapshotEvidenceIds: [],
  evidence: [],
};

describe("UI — developer details", () => {
  it("the engine payload is absent from the normal flow, not merely collapsed", () => {
    // "Collapsed by default" was not enough. A <details> element still
    // renders its summary for every reader on every result, so the last
    // thing after the answer was an invitation labelled "Developer
    // details" — and one click printed the entire response as JSON,
    // reason-code enums included.
    //
    // Server-rendered output is the normal flow: the opt-in is read from
    // the URL in an effect, so it is off here exactly as it is off for a
    // reader who did not ask for it.
    const html = render(createElement(DeveloperDetails, { detail: detailFixture }));
    expect(html).toBe("");
    expect(html).not.toContain("Developer details");
    expect(html).not.toContain("ALL_EVIDENCE_EXCLUDED");
    expect(html).not.toContain("EXTRACTING");
  });

  it("it is gated on an explicit opt-in, and is not renamed into a user-facing audit", () => {
    const src = readFileSync("src/client/components/developer-details.tsx", "utf-8");
    // Still available for development, behind something a reader cannot
    // reach by accident and a shared link does not carry.
    expect(src).toContain('get("debug") === "1"');
    expect(src).toContain("if (!enabled) return null");
    // A JSON dump is not an audit. The audit a reader wants is the evidence
    // section; calling this one would make plumbing look like showing work.
    expect(src).not.toContain("Full technical audit");
    expect(src).not.toContain("Full audit");
  });
});

/* ------------------------------------------------------------------ */
/* 13. NO PROJECT-SPECIFIC CONCLUSION                                  */
/* ------------------------------------------------------------------ */

function uiSourceFiles(): string[] {
  const roots = ["src/client", "app/(app)"];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

// The invariant is about CODE, not prose. A comment may legitimately name
// the run that exposed a bug ("the live Raydium runs showed…"); what must
// never exist is a code path that knows a project. Stripping comments first
// keeps the assertion aimed at the thing it is actually protecting.
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

describe("UI — no project-specific conclusion", () => {
  it("TEST 13: no UI file names a project outside the example QUESTIONS", () => {
    const projectNames = /pump|raydium|hyperliquid|\bhype\b|jito|solana/i;
    const offenders: string[] = [];
    for (const file of uiSourceFiles()) {
      let src = readFileSync(file, "utf-8");
      if (file.endsWith("research-composer.tsx")) {
        src = src.replace(/const EXAMPLES = \[[\s\S]*?\] as const;/, "");
      }
      if (projectNames.test(codeOf(src))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("TEST 13b: no verdict or component status is hardcoded in a screen", () => {
    for (const file of uiSourceFiles()) {
      if (file.includes("research-model")) continue; // the label maps live here
      const src = codeOf(readFileSync(file, "utf-8"));
      expect(src, file).not.toMatch(
        /verdict\s*[:=]\s*["'](SUPPORTED|NOT_SUPPORTED)["'](?!\s*\|)/,
      );
      expect(src, file).not.toMatch(/status\s*[:=]\s*["']SUPPORTED["'](?!\s*\|)/);
    }
  });

  it("TEST 13c: confidence is never rendered as a percentage or probability", () => {
    for (const file of uiSourceFiles()) {
      const src = codeOf(readFileSync(file, "utf-8"));
      expect(src, file).not.toMatch(/confidence[^\n]*%/i);
      expect(src, file).not.toMatch(/probability/i);
    }
  });

  it("TEST 13d: the answer builder makes no model call and infers nothing", () => {
    const src = readFileSync("src/client/research-model.ts", "utf-8");
    // No provider, no fetch, no network of any kind: the answer is a
    // restatement of persisted rows, produced deterministically.
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("anthropic");
    expect(src).not.toContain("Anthropic");
    expect(src).not.toMatch(/import\s+.*from\s+["'](?!\.)/);
  });
});
