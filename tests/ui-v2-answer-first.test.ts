import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { EvidenceDocumentCard } from "../src/client/components/evidence-document-card";
import { ResultLadder } from "../src/client/components/result-ladder";
import {
  EXCLUSION_LABELS,
  REASON_CODE_EXPLANATIONS,
  deriveResultLadder,
  exclusionLabel,
  groupEvidenceByDocument,
  jobOutcome,
  sourceClassCaveat,
  reasonExplanation,
  researchAnswer,
} from "../src/client/research-model";

// RESULT UX V2 — ANSWER FIRST, THEN WHY.
//
// The engine had begun producing usable results and the screen was still
// showing engine output: four bare adjectives for the mechanism ladder, a
// gaps panel that printed one identical sentence per gap, an evidence grid
// spanning eight role buckets, a component grid naming Pattern internals,
// and a developer payload offered to every reader. The reader was left to
// assemble "what is the answer, and why did it stop there" themselves.
//
// These tests pin the properties that make the new screen honest rather
// than merely shorter. In particular they pin the two places where being
// shorter would be a LIE: an unresolved step must not read as ATLAS
// failing, and a step whose checking was blocked must not read as a
// finding about the project.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const RESULT_PAGE = "app/(app)/research/[id]/page.tsx";

/* ------------------------------------------------------------------ */
/* 1-2. REASON CODES BECOME SENTENCES, AND ONLY SENTENCES              */
/* ------------------------------------------------------------------ */

// The engine's closed vocabulary, from component-reconciler.ts. If S5 grows
// a code, this list is what fails first — deliberately, because the
// fallback is silence and silence is how the old screen lost the reason in
// the first place.
const ENGINE_REASON_CODES = [
  "NO_EVIDENCE_FOUND",
  "ALL_EVIDENCE_EXCLUDED",
  "MISSING_EXECUTION_EVIDENCE",
  "MISSING_CURRENT_STATE",
  "STALE_CURRENT_STATE",
  "INSUFFICIENT_AUTHORITY",
  "INDIRECT_ONLY",
  "STATE_NOT_FULLY_LIVE",
  "CONFLICTING_STATE",
  "TOKEN_STATE_UNQUALIFIED",
];

describe("V2 — every persisted reason code has human copy", () => {
  it("TEST 1: the mapping covers the engine's whole closed vocabulary", () => {
    const engineSource = readFileSync(
      "src/server/engine/component-reconciler.ts",
      "utf-8",
    );
    // The list above really is the engine's, not a copy that has drifted.
    for (const code of ENGINE_REASON_CODES) {
      expect(engineSource, code).toContain(`| "${code}"`);
      expect(REASON_CODE_EXPLANATIONS[code], code).toBeTruthy();
    }
    expect(Object.keys(REASON_CODE_EXPLANATIONS).sort()).toEqual(
      [...ENGINE_REASON_CODES].sort(),
    );
  });

  it("TEST 1b: each explanation is a sentence, and never restates the code", () => {
    for (const [code, copy] of Object.entries(REASON_CODE_EXPLANATIONS)) {
      expect(copy, code).toMatch(/^[A-Z].*\.$/);
      expect(copy, code).not.toContain("_");
      expect(copy.toUpperCase(), code).not.toContain(code);
      // Never blames ATLAS for what is a fact about the public record.
      expect(copy, code).not.toContain("ATLAS failed");
      expect(copy, code).not.toContain("ATLAS could not verify");
    }
  });

  it("TEST 1c: the first recognised code wins, and an unknown code yields nothing", () => {
    expect(reasonExplanation(["MISSING_EXECUTION_EVIDENCE", "INDIRECT_ONLY"])).toBe(
      REASON_CODE_EXPLANATIONS.MISSING_EXECUTION_EVIDENCE,
    );
    // An unrecognised code must produce NULL, never a de-snaked identifier.
    // A copy gap is a copy bug; it must not become a leak.
    expect(reasonExplanation(["SOMETHING_NEW_S5_LEARNED"])).toBeNull();
    expect(reasonExplanation([])).toBeNull();
    expect(reasonExplanation(null)).toBeNull();
    expect(reasonExplanation([42, { a: 1 }])).toBeNull();
  });

  it("TEST 2: no raw reason code survives to the rendered surface", () => {
    const html = render(
      createElement(ResultLadder, {
        components: ENGINE_REASON_CODES.map((code, i) => ({
          component: [
            "MECHANISM_SPEC",
            "GOVERNANCE_BASIS",
            "CURRENT_STATE",
            "EXECUTION_EVIDENCE",
            "SOURCE_OF_VALUE",
            "FLOW_PATH",
            "DESTINATION",
            "RECIPIENT",
            "NET_EFFECT",
            "DURABILITY_BASIS",
          ][i],
          status: "INSUFFICIENT_EVIDENCE",
          reasonCodes: [code],
          coverage: "COMPLETED" as const,
        })),
      }),
    );
    for (const code of ENGINE_REASON_CODES) {
      expect(html, code).not.toContain(code);
    }
    expect(html).not.toContain("INSUFFICIENT_EVIDENCE");
    expect(html).not.toContain("PARTIALLY_SUPPORTED");
  });
});

/* ------------------------------------------------------------------ */
/* 4. AN EVIDENCE GAP IS NOT ATLAS FAILING                             */
/* ------------------------------------------------------------------ */

describe("V2 — an evidence boundary never reads as a product failure", () => {
  it("TEST 4: unresolved copy describes the evidence, not ATLAS", () => {
    const view = deriveResultLadder([
      {
        component: "EXECUTION_EVIDENCE",
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
        coverage: "COMPLETED",
      },
    ]);
    const row = view.mechanism.find((r) => r.component === "EXECUTION_EVIDENCE");
    expect(row?.stateLabel).toBe("Not established");
    expect(row?.reason).toBe(REASON_CODE_EXPLANATIONS.MISSING_EXECUTION_EVIDENCE);
    // A completed check that found nothing is not a limitation.
    expect(row?.limitation).toBeNull();
  });

  it("TEST 4b: an unresolved row never becomes a claim that the thing is absent", () => {
    const html = render(
      createElement(ResultLadder, {
        components: [
          {
            component: "NET_EFFECT",
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["NO_EVIDENCE_FOUND"],
            coverage: "COMPLETED" as const,
          },
        ],
      }),
    );
    expect(html).toContain("Not established");
    for (const forbidden of [
      "does not exist",
      "there is no",
      "proves there is",
      "ATLAS failed",
      "verification incomplete",
    ]) {
      expect(html.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5-6. TECHNICAL LIMITATION VS EVIDENCE GAP                           */
/* ------------------------------------------------------------------ */

describe("V2 — a blocked check is separated from a completed one", () => {
  it("TEST 5: BLOCKED coverage produces a limitation, distinct from the gap copy", () => {
    const blocked = deriveResultLadder([
      {
        component: "EXECUTION_EVIDENCE",
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["NO_EVIDENCE_FOUND"],
        coverage: "BLOCKED",
      },
    ]).mechanism[0];
    const completed = deriveResultLadder([
      {
        component: "EXECUTION_EVIDENCE",
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["NO_EVIDENCE_FOUND"],
        coverage: "COMPLETED",
      },
    ]).mechanism[0];

    expect(blocked.limitation).toBeTruthy();
    expect(completed.limitation).toBeNull();

    // THE DECISIVE ASSERTION. Both rows carry the same persisted status and
    // the same persisted reason code — the reconciler cannot tell them
    // apart, because it only ever sees Evidence rows and a failed fetch
    // produces none. They must NOT read the same to a person.
    expect(blocked.reason).not.toBe(completed.reason);
    // And the blocked row must not borrow copy asserting the checking
    // happened, which is exactly what the reason code would have implied.
    expect(blocked.reason).not.toContain("sources checked here");
    expect(completed.reason).toContain("sources checked here");
  });

  it("TEST 5b: the limitation is a fact about the run, never about the project", () => {
    const row = deriveResultLadder([
      {
        component: "EXECUTION_EVIDENCE",
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["NO_EVIDENCE_FOUND"],
        coverage: "BLOCKED",
      },
    ]).mechanism[0];
    expect(row.limitation).toContain("not evidence for or against the project");
    expect(row.checkedSummary).toContain("could not be opened");

    // A blocked step is NOT a contradiction and must not be coloured or
    // stated as one — the run failing to look says nothing either way.
    const html = render(
      createElement(ResultLadder, {
        components: [
          {
            component: "EXECUTION_EVIDENCE",
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["NO_EVIDENCE_FOUND"],
            coverage: "BLOCKED" as const,
          },
        ],
      }),
    );
    expect(html).toContain('data-state="UNRESOLVED"');
    expect(html).toContain('data-coverage="BLOCKED"');
    expect(html).not.toContain("Evidence indicates otherwise");

    // The expansion itself renders only once a reader opens the row, and
    // there is no DOM here to click with. What is pinned instead is that a
    // limitation gets its OWN frame rather than becoming one more sentence
    // in the ordinary explanation — the two are mutually exclusive
    // branches, so a blocked step can never read as a finding.
    const src = readFileSync("src/client/components/result-ladder.tsx", "utf-8");
    const limitationAt = src.indexOf('data-testid="ladder-limitation"');
    const explanationAt = src.indexOf('data-testid="finding-explanation"');
    expect(limitationAt).toBeGreaterThan(-1);
    expect(explanationAt).toBeGreaterThan(-1);
    expect(src).toContain("row.limitation ? (");
    expect(limitationAt).toBeLessThan(explanationAt);
    expect(src).toContain("Research limitation");
  });

  it("TEST 6: ambiguous or mixed attempt state never claims the research was complete", () => {
    // PARTIAL is what the projection returns whenever the attempt record is
    // not unambiguous — some succeeded and some failed, or something never
    // reached a terminal status. It must claim NEITHER exhaustiveness nor a
    // blocking failure.
    const partial = deriveResultLadder([
      {
        component: "CURRENT_STATE",
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["MISSING_CURRENT_STATE"],
        coverage: "PARTIAL",
      },
    ]).mechanism[0];
    expect(partial.limitation).toBeNull();
    expect(partial.coverage).toBe("PARTIAL");
    // The reason it does show is a statement about the checked evidence,
    // which stays true whether or not the checking was exhaustive.
    expect(partial.reason).toBe(REASON_CODE_EXPLANATIONS.MISSING_CURRENT_STATE);
    // A statement about what was checked, which stays true whether or not
    // the checking was exhaustive — it never claims completeness.
    expect(partial.reason).toContain("Nothing checked");
  });

  it("TEST 6b: the server projection is conservative in both directions", () => {
    const src = readFileSync("app/api/research-jobs/[id]/route.ts", "utf-8");
    // BLOCKED requires that NOTHING succeeded and something positively
    // failed — the only shape that can honestly be shown as a limitation.
    expect(src).toContain('if (acc.ok === 0 && acc.failed > 0) return "BLOCKED"');
    // COMPLETED requires every attempt to have succeeded; one failure or one
    // non-terminal row downgrades rather than claiming exhaustiveness.
    expect(src).toContain(
      'if (acc.failed === 0 && acc.other === 0) return "COMPLETED"',
    );
    expect(src).toContain('return "PARTIAL"');
    // No provider text crosses the boundary — only the classification.
    expect(src).not.toContain("researchAttempts.reason");
  });
});

/* ------------------------------------------------------------------ */
/* 8-10. TERMINAL OUTCOME PRECEDENCE                                   */
/* ------------------------------------------------------------------ */

describe("V2 — a terminal product state outranks a persisted verdict", () => {
  it("TEST 8: a FAILED job cannot render a verdict merely because a Proof exists", () => {
    // `loadProofForJob` is not gated on job state, so a Proof written before
    // a run broke comes back on the GET. The client used to test the verdict
    // FIRST, so the screen announced a finding about the project when what
    // had actually happened was that the run failed.
    const failed = jobOutcome({ state: "FAILED", verdict: "INSUFFICIENT_EVIDENCE" });
    expect(failed.kind).toBe("FAILED");
    expect(failed.tone).toBe("fault");
    expect(failed.label).toBe("Research failed");
    // The verdict is not destroyed — it stops being the headline.
    expect(failed.verdict).toBe("INSUFFICIENT_EVIDENCE");

    for (const verdict of ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED"]) {
      expect(jobOutcome({ state: "FAILED", verdict }).kind).toBe("FAILED");
    }
  });

  it("TEST 9: CANCELLED stays a non-proof outcome whatever is persisted", () => {
    const cancelled = jobOutcome({ state: "CANCELLED", verdict: "SUPPORTED" });
    expect(cancelled.kind).toBe("CANCELLED");
    expect(cancelled.tone).not.toBe("supported");
  });

  it("TEST 10: a budget limit is coverage, never converted into a negative claim", () => {
    const stopped = jobOutcome({
      state: "BUDGET_LIMIT_REACHED",
      verdict: "INSUFFICIENT_EVIDENCE",
    });
    expect(stopped.kind).toBe("STOPPED_AT_LIMIT");
    // Neutral: stopping early says nothing about the project either way.
    expect(stopped.tone).toBe("neutral");
    expect(stopped.tone).not.toBe("negative");
    expect(stopped.label).not.toContain("Insufficient");
  });

  it("TEST 10b: a genuinely completed run still reports its verdict", () => {
    // The fix must not swallow legitimate results. Only terminal PRODUCT
    // states outrank a verdict; SUCCEEDED is not one of them.
    const ok = jobOutcome({ state: "SUCCEEDED", verdict: "PARTIALLY_SUPPORTED" });
    expect(ok.kind).toBe("VERDICT");
    expect(ok.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(jobOutcome({ state: "SUCCEEDED", verdict: null }).kind).toBe("NO_CONCLUSION");
    expect(jobOutcome({ state: "RUNNING", verdict: "SUPPORTED" }).kind).toBe("IN_PROGRESS");
  });
});

/* ------------------------------------------------------------------ */
/* 11. THE VERBATIM FRAGMENT LEADS                                     */
/* ------------------------------------------------------------------ */

const docItem = (over: Record<string, unknown> = {}) => ({
  id: "ev-1",
  component: "MECHANISM_SPEC",
  summary: "A paraphrase written by the model.",
  fragment: "the literal passage taken from the fetched document",
  doesNotProve: "That the documented thing is executing.",
  sourceClass: "OFFICIAL_DOCS",
  officiality: "CONFIRMED",
  retrievedUrl: "https://docs.example.test/ray/protocol-fees.md",
  sourceTitle: null,
  ...over,
});

// The evidence card's body renders only once a reader opens it, and these
// tests run against static markup with no DOM to click. The ORDER inside
// that body is therefore pinned at the source, which is where the defect
// lived: a single `summary ?? fragment` expression.
const CARD_SRC = readFileSync(
  "src/client/components/evidence-document-card.tsx",
  "utf-8",
);

describe("V2 — the source's own words come before the model's", () => {
  it("TEST 11: the fragment leads, and the model's paraphrase follows it", () => {
    // The defect itself: the paraphrase displaced the literal passage
    // whenever one existed, which is almost always. The fragment is the
    // only artifact on this screen checked against the fetched document
    // rather than generated — it is the reason to believe any of the rest.
    expect(CARD_SRC).not.toContain("item.summary ?? item.fragment");

    const fragmentAt = CARD_SRC.indexOf("{item.fragment}");
    const summaryAt = CARD_SRC.indexOf("{item.summary}");
    expect(fragmentAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeGreaterThan(-1);
    expect(fragmentAt).toBeLessThan(summaryAt);

    // Labelled as the source's words, with the paraphrase named as the
    // reading rather than the evidence.
    expect(CARD_SRC.indexOf("What the source says")).toBeLessThan(
      CARD_SRC.indexOf("What it supports"),
    );
  });

  it("TEST 11b: the fragment is unconditional; the summary is what may be absent", () => {
    // Reversed from before. The fragment always renders; a missing
    // paraphrase simply omits its own block.
    expect(CARD_SRC).toContain("{item.summary && (");
    expect(CARD_SRC).not.toContain("{item.fragment && (");
    // It is a quotation, presented as one.
    expect(CARD_SRC).toContain("<blockquote");
  });

  it("TEST 11c: what a source cannot settle is stated, per class and per fact", () => {
    // The caveat is attached to the CLASS and computed from the group's
    // persisted sourceClass — official documentation settles what a project
    // states, and nothing about whether it happens.
    expect(CARD_SRC).toContain("sourceClassCaveat(group.sourceClass)");
    expect(CARD_SRC).toContain('data-testid="source-class-caveat"');
    // And the per-fact doesNotProve the extractor persisted still renders.
    expect(CARD_SRC).toContain("What it does not establish");
    expect(CARD_SRC).toContain("{item.doesNotProve}");
  });

  it("TEST 11d: every source class carries both what it can and cannot settle", () => {
    const engineSource = readFileSync(
      "src/server/engine/source-authority.ts",
      "utf-8",
    );
    for (const cls of [
      "OFFICIAL_DOCS",
      "GOVERNANCE",
      "ONCHAIN_VERIFIABLE",
      "OFFICIAL_REPORT",
      "DATA_PROVIDER",
      "RESEARCH_MEDIA",
      "SOCIAL",
    ]) {
      expect(engineSource, cls).toContain(cls);
      const caveat = sourceClassCaveat(cls);
      expect(caveat, cls).toBeTruthy();
      expect(caveat!.can, cls).toMatch(/^[A-Z].*\.$/);
      expect(caveat!.cannot, cls).toMatch(/^[A-Z].*\.$/);
      // A capability statement, not a score. No ranking words.
      for (const word in { best: 1, worst: 1, score: 1, rating: 1, trusted: 1 }) {
        expect(caveat!.can.toLowerCase(), cls).not.toContain(word);
        expect(caveat!.cannot.toLowerCase(), cls).not.toContain(word);
      }
    }
    // Official documentation must never be allowed to stand for execution.
    expect(sourceClassCaveat("OFFICIAL_DOCS")!.cannot).toContain(
      "does not establish that the documented thing is happening",
    );
    expect(sourceClassCaveat("UNKNOWN_CLASS")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 12. EXCLUSION LABELS                                                */
/* ------------------------------------------------------------------ */

// The engine's closed ExclusionReason vocabulary, from
// component-reconciler.ts. The client map used to name five reasons, FOUR
// of which the engine never emits — so eleven of the twelve real reasons
// fell through to a de-snaking fallback and rendered as "wrong component",
// "duplicate unit", "superseded by newer".
const ENGINE_EXCLUSION_REASONS = [
  "WRONG_COMPONENT",
  "WRONG_PROJECT",
  "LEGACY_CONTRACT_VERSION",
  "CLASS_NOT_ADMISSIBLE",
  "DIRECTNESS_INSUFFICIENT",
  "RELATIONSHIP_NOT_SUPPORTING",
  "NOT_CURRENT_STATE_BEARING",
  "MISSING_PUBLICATION_DATE",
  "STALE_FOR_CURRENT_STATE",
  "SUPERSEDED_BY_NEWER",
  "DUPLICATE_UNIT",
  "ENTITY_NOT_CONFIRMED",
];

describe("V2 — every exclusion reason the engine emits has real copy", () => {
  it("TEST 12: the mapping covers the engine's whole vocabulary", () => {
    const engineSource = readFileSync(
      "src/server/engine/component-reconciler.ts",
      "utf-8",
    );
    for (const reason of ENGINE_EXCLUSION_REASONS) {
      expect(engineSource, reason).toContain(`| "${reason}"`);
      expect(EXCLUSION_LABELS[reason], reason).toBeTruthy();
      const label = exclusionLabel(reason);
      // A real sentence fragment, not the identifier with its underscores
      // removed. "duplicate unit" is what the fallback produced before.
      expect(label, reason).not.toBe(reason.replace(/_/g, " ").toLowerCase());
      expect(label, reason).toMatch(/^[A-Z]/);
      expect(label, reason).not.toContain("_");
    }
  });

  it("TEST 12b: an unknown reason falls back to a sentence, never to the code", () => {
    const label = exclusionLabel("SOME_FUTURE_REASON");
    expect(label).not.toContain("_");
    expect(label).not.toContain("some future reason");
    expect(label).toBe("Did not meet the evidence standard for this step");
  });

  it("TEST 12c: a refused source says it was read, and that this is not a verdict on it", () => {
    // The label a reader meets, for the reason that used to render as the
    // bare words "duplicate unit".
    expect(exclusionLabel("DUPLICATE_UNIT")).toBe(
      "The same passage was already counted once",
    );
    expect(CARD_SRC).toContain("exclusionLabel(exclusionReason)");
    expect(CARD_SRC).toContain("rested nothing on it");
    expect(CARD_SRC).toContain("not a judgement that it is wrong");

    // "Excluded" is the engine's word and sounds like a verdict on the
    // publisher; what happened is narrower and worth saying plainly.
    const [group] = groupEvidenceByDocument([
      docItem({ exclusionReason: "DUPLICATE_UNIT" }),
    ]);
    const html = render(createElement(EvidenceDocumentCard, { group, role: "EXCLUDED" }));
    expect(html).toContain("Not used");
    expect(html).not.toContain("DUPLICATE_UNIT");
    expect(html).not.toContain(">Excluded<");
  });
});

/* ------------------------------------------------------------------ */
/* 13-15. DEFAULT SCREEN COMPOSITION                                   */
/* ------------------------------------------------------------------ */

describe("V2 — what the default screen does and does not carry", () => {
  it("TEST 13: the deep sections are closed by default and the payload is gated", () => {
    const src = readFileSync(RESULT_PAGE, "utf-8");
    // Deep sections start closed, and proof now reaches a reader through
    // the finding it proves rather than through a page-level control.
    expect(src).toContain("useState(false)");
    expect(src).toContain("evidenceByComponent={evidenceByComponent}");
    // The old screen rendered the component grid, the gaps panel and the
    // reality ladder as three more equal-weight sections. They are gone,
    // and so is the general evidence wall that replaced them.
    expect(src).not.toContain("ComponentBreakdown");
    expect(src).not.toContain("GapsPanel");
    expect(src).not.toContain("RealityCheck");
    expect(src).not.toContain('data-testid="answer-view-evidence"');
  });

  it("TEST 13b: the source count is one fact, counted once, over distinct documents", () => {
    // Caught on the live Raydium result: the answer said "4 sources read,
    // 2 not used" while the evidence header directly below said "2 used as
    // evidence, 8 read and not used". The section had been summing group
    // counts across its role buckets, and a document carrying rows in more
    // than one role appears in more than one bucket. Two numbers for one
    // fact, disagreeing on the same screen.
    const section = readFileSync("src/client/components/evidence-section.tsx", "utf-8");
    expect(section).toContain("readCount");
    expect(section).toContain("usedCount");
    expect(section).toContain("Math.max(0, readCount - usedCount)");
    // The counts must NOT be recomputed from the role buckets in here.
    expect(section).not.toMatch(/otherDocs\.reduce\(/);
    expect(section).not.toMatch(/admittedDocs\.reduce\(/);

    // And the page passes the same two values it renders in the answer.
    const page = readFileSync(RESULT_PAGE, "utf-8");
    expect(page).toContain("readCount={readDocs}");
    expect(page).toContain("usedCount={usedDocs}");
    // `readDocs` is distinct DOCUMENTS, not evidence rows — one document
    // that yielded six facts is one source, never six.
    expect(page).toContain(
      "const readDocs = groupEvidenceByDocument(detail.evidence.map((e) => toItem(e))).length",
    );
  });

  it("TEST 14: evidence provenance is still built from persisted links only", () => {
    const src = readFileSync(RESULT_PAGE, "utf-8");
    // Roles come from S8 citations and S5 component sets, never from text.
    expect(src).toContain("proof?.citations");
    expect(src).toContain("detail.finding.supporting");
    expect(src).toContain("detail.finding.excluded");
    expect(src).toContain('l.role === "EXCLUDED"');
    // The source classes behind a row come from persisted evidence links.
    expect(src).toContain("sourceClassesByComponent");
    expect(src).toContain('if (link.role === "EXCLUDED") continue');
  });

  it("TEST 15: no ladder label, state or reason mentions a named project", () => {
    const surfaces = [
      "src/client/components/result-ladder.tsx",
      "src/client/components/evidence-section.tsx",
      "src/client/research-model.ts",
    ].map((f) => readFileSync(f, "utf-8"));
    // Comments may name the run that exposed a defect; code may not know a
    // project. Strip comments, then look.
    for (const src of surfaces) {
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      for (const token of ["Raydium", "RAY", "pump", "Solana"]) {
        expect(code, token).not.toContain(token);
      }
    }
  });

  it("TEST 15b: the answer never asserts more than the component rows carry", () => {
    // DESTINATION established, EXECUTION_EVIDENCE not. Documentation and a
    // destination must never combine into a claim about execution.
    const text = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      outcomeKind: "VERDICT",
      projectName: "Fixture Project",
      components: [
        { component: "MECHANISM_SPEC", status: "SUPPORTED" },
        { component: "DESTINATION", status: "SUPPORTED" },
        { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" },
        { component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE" },
      ],
    }).join(" ");
    expect(text).toContain("Established:");
    expect(text).toContain("Not established:");
    expect(text.toLowerCase()).not.toContain("burn");
    expect(text.toLowerCase()).not.toContain("is executing");
    expect(text.toLowerCase()).not.toContain("therefore");
  });
});
