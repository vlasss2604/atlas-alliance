import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ResultBriefing } from "../src/client/components/result-briefing";
import {
  deriveResultLadder,
  researchAnswer,
  resultBriefing,
  unresolvedFrom,
  type LadderComponentInput,
  type ResultRow,
} from "../src/client/research-model";

// HUMAN RESULT SUMMARY V1 — UNDERSTANDING BEFORE PROOF.
//
// The top of a finished result said "Partially supported" and then, at
// most, three sentences that never mentioned a partially-established
// finding at all: `researchAnswer`'s verdict path reads SUPPORTED,
// CONTRADICTED and INSUFFICIENT_EVIDENCE and skips PARTIALLY_SUPPORTED
// entirely. On the ordinary shape of a real result — mostly partial — the
// summary was nearly empty, and a reader had to work through the whole
// Proof to learn what had been found.
//
// This layer adds a short answer, a key-findings table and a "still open"
// list ABOVE the existing detail. It removes nothing, and it decides
// nothing: every cell is derived from a persisted component status, a
// persisted reason code, or the coverage classification.
//
// These tests hold the two things that make it safe to put a summary at
// the top of a result: it never says more than the rows below it, and no
// free-text evidence summary can reach it.

const BRIEFING = "src/client/components/result-briefing.tsx";
const MODEL = "src/client/research-model.ts";
const PAGE = "app/(app)/research/[id]/page.tsx";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// The real persisted Evidence summary from the acceptance job — already
// admitted, already linked to DESTINATION. It is the exact sentence this
// layer must never promote into a system-level claim, so it is the fixture
// for the free-text guard rather than an invented string.
const PROTOCOL_HELD_SUMMARY =
  "Bought-back RAY tokens are held by the protocol at a public on-chain address: DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz";

// A RAYDIUM-EQUIVALENT RESULT, IN THE SHAPE A REAL RUN PRODUCES.
//
// Documented and authorised, value origin and path partly settled,
// execution and its consequences not reached. This is the mixed case the
// old summary handled worst, because five of its ten components are the
// one status that summary never mentioned.
const RAYDIUM: LadderComponentInput[] = [
  { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
  { component: "GOVERNANCE_BASIS", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" },
  { component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" },
  { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
  { component: "SOURCE_OF_VALUE", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" },
  { component: "FLOW_PATH", status: "SUPPORTED", coverage: "COMPLETED" },
  { component: "DESTINATION", status: "SUPPORTED", coverage: "COMPLETED" },
  { component: "RECIPIENT", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
  { component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
  { component: "DURABILITY_BASIS", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" },
];

function rowsFor(components: LadderComponentInput[]): ResultRow[] {
  const ladder = deriveResultLadder(components);
  return [...ladder.mechanism, ...ladder.value];
}

function briefingFor(
  components: LadderComponentInput[],
  over: Partial<Parameters<typeof resultBriefing>[0]> = {},
) {
  return resultBriefing({
    verdict: "PARTIALLY_SUPPORTED",
    outcomeKind: "VERDICT",
    projectName: "Raydium",
    components: components.map((c) => ({ component: c.component, status: c.status })),
    rows: rowsFor(components),
    ...over,
  });
}

// Every internal token a reader must never meet in the summary.
const ENUMS = [
  "PARTIALLY_SUPPORTED",
  "INSUFFICIENT_EVIDENCE",
  "SUPPORTED",
  "CONTRADICTED",
  "SOURCE_OF_VALUE",
  "EXECUTION_EVIDENCE",
  "NET_EFFECT",
  "DURABILITY_BASIS",
  "FLOW_PATH",
  "MECHANISM_SPEC",
  "GOVERNANCE_BASIS",
  "CURRENT_STATE",
  "DESTINATION",
  "RECIPIENT",
];

/* ------------------------------------------------------------------ */
/* 1. THE RAYDIUM-EQUIVALENT PARTIAL RESULT                            */
/* ------------------------------------------------------------------ */

describe("TEST 1 — a partial result is answered, not merely graded", () => {
  it("the short answer states substance rather than restating the verdict", () => {
    const { shortAnswer } = briefingFor(RAYDIUM);
    const text = shortAnswer.join(" ");

    // Three to six sentences, and genuinely more than the old ceiling of
    // three — the partial findings now have a sentence of their own.
    expect(shortAnswer.length).toBeGreaterThanOrEqual(3);
    expect(shortAnswer.length).toBeLessThanOrEqual(6);

    // It answers, in ordinary words, rather than repeating the badge.
    expect(text).toContain("Established:");
    expect(text).toContain("Partly established:");
    expect(text).toContain("Not established:");
    expect(text).toContain("what the project's own documentation specifies");
    expect(text).toContain("whether the mechanism has actually executed");

    // And it never says the thing the badge already said.
    expect(text).not.toContain("The evidence is partially supported");
    for (const enumToken of ENUMS) {
      expect(text, enumToken).not.toContain(enumToken);
    }
  });

  it("THE REGRESSION THIS CLOSES: the old answer skipped partial findings entirely", () => {
    // `researchAnswer`'s verdict path reads three statuses and not the
    // fourth, so on this result five components contributed nothing to the
    // summary. This is not a criticism of that function — it is why the
    // briefing exists, pinned so the gap cannot silently return.
    const old = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      outcomeKind: "VERDICT",
      projectName: "Raydium",
      components: RAYDIUM.map((c) => ({ component: c.component, status: c.status })),
    }).join(" ");
    expect(old).not.toContain("Partly established");

    expect(briefingFor(RAYDIUM).shortAnswer.join(" ")).toContain("Partly established:");
  });

  it("the key findings table draws the distinctions the question turns on", () => {
    const { keyFindings } = briefingFor(RAYDIUM);
    const by = new Map(keyFindings.map((f) => [f.component, f]));

    // Documented, but not observed executing — the distinction a reader
    // most needs and the one a bare verdict destroys.
    expect(by.get("MECHANISM_SPEC")?.result).toBe("Established");
    expect(by.get("EXECUTION_EVIDENCE")?.result).toBe("Not established");
    expect(by.get("CURRENT_STATE")?.result).toBe("Partly established");
    expect(by.get("DESTINATION")?.result).toBe("Established");
    expect(by.get("RECIPIENT")?.result).toBe("Not established");
    expect(by.get("NET_EFFECT")?.result).toBe("Not established");
    expect(by.get("DURABILITY_BASIS")?.result).toBe("Partly established");

    // Destination and recipient are separately graded, which is the
    // engine's own split: where value lands is not who receives it.
    expect(by.get("DESTINATION")?.result).not.toBe(by.get("RECIPIENT")?.result);
  });

  it("every rendered check is a claim, never a component enum", () => {
    const { keyFindings } = briefingFor(RAYDIUM);
    const html = render(
      createElement(ResultBriefing, { keyFindings, unresolved: briefingFor(RAYDIUM).unresolved, unresolvedMore: 0 }),
    );
    for (const f of keyFindings) {
      expect(f.check).not.toBe(f.component);
      expect(f.check).not.toMatch(/^[A-Z_]+$/);
    }
    for (const enumToken of ENUMS) {
      // The component travels as a data attribute for keys and tests. It is
      // never reader-facing text, so it may appear in an attribute and
      // nowhere else.
      const visible = html.replace(/data-component="[^"]*"/g, "");
      expect(visible, enumToken).not.toContain(enumToken);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. MIXED STATUSES                                                   */
/* ------------------------------------------------------------------ */

describe("TEST 2 — mixed component statuses each render as themselves", () => {
  it("all four states appear, each with its own label and tone", () => {
    const mixed: LadderComponentInput[] = [
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
      { component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" },
      { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
      { component: "NET_EFFECT", status: "CONTRADICTED", coverage: "COMPLETED" },
    ];
    const { keyFindings } = briefingFor(mixed);
    expect(keyFindings.map((f) => f.result)).toEqual([
      "Established",
      "Partly established",
      "Not established",
      "Evidence indicates otherwise",
    ]);
    expect(keyFindings.map((f) => f.tone)).toEqual([
      "supported",
      "partial",
      "insufficient",
      "negative",
    ]);
  });

  it("a component with no persisted row is absent, never rendered as a failure", () => {
    // NOT_ASSESSED means the run did not test it. Listing it would ask a
    // reader to interpret an engine-internal absence as a finding.
    const { keyFindings } = briefingFor([
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
    ]);
    expect(keyFindings.map((f) => f.component)).toEqual(["MECHANISM_SPEC"]);
    expect(keyFindings.some((f) => f.result === "Not assessed")).toBe(false);
  });

  it("the table renders one row per assessed check", () => {
    const { keyFindings, unresolved } = briefingFor(RAYDIUM);
    const html = render(createElement(ResultBriefing, { keyFindings, unresolved, unresolvedMore: 0 }));
    expect(html.split('data-testid="key-finding-row"').length - 1).toBe(RAYDIUM.length);
  });
});

/* ------------------------------------------------------------------ */
/* 3. NOT ESTABLISHED IS NOT A NEGATIVE CLAIM                          */
/* ------------------------------------------------------------------ */

describe("TEST 3 — an evidence gap never becomes a fact about the project", () => {
  it("unresolved copy says what was not established, never that it is untrue", () => {
    const { shortAnswer, keyFindings, unresolved } = briefingFor(RAYDIUM);
    const html = render(createElement(ResultBriefing, { keyFindings, unresolved, unresolvedMore: 0 }));
    const all = `${shortAnswer.join(" ")} ${html}`;

    expect(unresolved.length).toBeGreaterThan(0);
    expect(all).toContain("Not established");

    // The forms that would convert absence of evidence into evidence of
    // absence. None may appear anywhere in this layer.
    for (const negative of [
      "does not happen",
      "does not exist",
      "did not happen",
      "no buyback",
      "is not real",
      "is false",
      "never happens",
    ]) {
      expect(all.toLowerCase(), negative).not.toContain(negative);
    }
  });

  it("the section frames the gap as ATLAS's reach, not the project's conduct", () => {
    const { keyFindings, unresolved } = briefingFor(RAYDIUM);
    const html = render(createElement(ResultBriefing, { keyFindings, unresolved, unresolvedMore: 0 }));
    expect(html).toContain("Not enough evidence to settle these");
    expect(html).toContain("not a finding that they are untrue");
  });

  it("a blocked check is a limit of the RUN, and says so", () => {
    const blocked: LadderComponentInput[] = [
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
      { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "BLOCKED" },
    ];
    const { unresolved, shortAnswer } = briefingFor(blocked);
    const item = unresolved.find((u) => u.component === "EXECUTION_EVIDENCE");
    expect(item?.blocked).toBe(true);
    expect(item?.detail).toContain("not evidence for or against the project");
    // A blocked check outranks an ordinary gap as THE limitation to name.
    const text = shortAnswer.join(" ");
    expect(text).toContain("Main limitation");
    expect(text).toContain("Required source access failed");
    // THE SUBJECT IS THE NOUN PHRASE, NOT THE CLAIM LABEL. Splicing the
    // ladder label in would read "Main limitation — It has been observed
    // executing: …", which asserts the opposite of what is meant.
    expect(text).toContain("Main limitation — whether the mechanism has actually executed:");
    expect(text).not.toContain("Main limitation — It has been observed executing");
  });

  it("an ordinary gap names its persisted reason code as the limitation", () => {
    const { shortAnswer } = briefingFor([
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
      {
        component: "EXECUTION_EVIDENCE",
        status: "INSUFFICIENT_EVIDENCE",
        coverage: "COMPLETED",
        reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
      },
    ]);
    const text = shortAnswer.join(" ");
    // The engine's own copy for that code, not a sentence written here.
    expect(text).toContain(
      "The mechanism is described, but nothing checked shows it actually running.",
    );
    // Four sentences: established, not established, and the limitation.
    expect(shortAnswer.length).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ */
/* 4. CONTRADICTED IS NOT A GAP                                        */
/* ------------------------------------------------------------------ */

describe("TEST 4 — a contradiction is distinguished from missing evidence", () => {
  const contradicted: LadderComponentInput[] = [
    { component: "NET_EFFECT", status: "CONTRADICTED", coverage: "COMPLETED" },
    { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
  ];

  it("the two states have different labels, tones and sentences", () => {
    const { keyFindings, shortAnswer } = briefingFor(contradicted);
    const net = keyFindings.find((f) => f.component === "NET_EFFECT");
    const exec = keyFindings.find((f) => f.component === "EXECUTION_EVIDENCE");

    expect(net?.result).toBe("Evidence indicates otherwise");
    expect(exec?.result).toBe("Not established");
    expect(net?.tone).toBe("negative");
    expect(exec?.tone).toBe("insufficient");

    const text = shortAnswer.join(" ");
    expect(text).toContain("the evidence indicates otherwise");
    expect(text).toContain("Not established:");
  });

  it("a contradicted check is NOT listed as still open", () => {
    // "Still open" means the evidence did not reach a conclusion. A
    // contradiction IS a conclusion — the strongest one a run can make —
    // and filing it as unresolved would understate it.
    const { unresolved } = briefingFor(contradicted);
    expect(unresolved.map((u) => u.component)).toEqual(["EXECUTION_EVIDENCE"]);
  });

  it("the contradiction leads the answer, ahead of what was merely settled", () => {
    const { shortAnswer } = briefingFor([
      ...contradicted,
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
    ]);
    const text = shortAnswer.join(" ");
    expect(text.indexOf("indicates otherwise")).toBeLessThan(text.indexOf("Established:"));
  });
});

/* ------------------------------------------------------------------ */
/* 5. A FULLY SUPPORTED RESULT                                         */
/* ------------------------------------------------------------------ */

describe("TEST 5 — a supported-only result carries no gap language", () => {
  const supported: LadderComponentInput[] = [
    { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
    { component: "CURRENT_STATE", status: "SUPPORTED", coverage: "COMPLETED" },
    { component: "DESTINATION", status: "SUPPORTED", coverage: "COMPLETED" },
  ];

  it("it states what was established and opens nothing", () => {
    const { shortAnswer, keyFindings, unresolved } = briefingFor(supported, {
      verdict: "SUPPORTED",
    });
    expect(shortAnswer.join(" ")).toContain("Established:");
    expect(shortAnswer.join(" ")).not.toContain("Not established");
    expect(shortAnswer.join(" ")).not.toContain("Partly established");
    expect(unresolved).toEqual([]);
    expect(keyFindings.every((f) => f.result === "Established")).toBe(true);
  });

  it("the still-open section does not render at all", () => {
    const { keyFindings, unresolved } = briefingFor(supported, { verdict: "SUPPORTED" });
    const html = render(createElement(ResultBriefing, { keyFindings, unresolved, unresolvedMore: 0 }));
    expect(html).not.toContain('data-testid="unresolved-section"');
    expect(html).toContain('data-testid="key-findings"');
  });
});

/* ------------------------------------------------------------------ */
/* 6-7. FAILED RUNS — 7f80ebb IS NOT REGRESSED                         */
/* ------------------------------------------------------------------ */

describe("TEST 6 — FAILED with substantive findings keeps its established behaviour", () => {
  const partialFailure: LadderComponentInput[] = [
    { component: "FLOW_PATH", status: "SUPPORTED", coverage: "COMPLETED" },
    { component: "SOURCE_OF_VALUE", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" },
    { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "PARTIAL" },
  ];

  it("the short answer is byte-for-byte what researchAnswer produces", () => {
    // The briefing DELEGATES on this path rather than re-deriving it. A
    // failed run's wording took a live regression (job b7ee4952) to get
    // right; a second implementation of it would be a second chance to get
    // it wrong.
    const input = {
      verdict: "PARTIALLY_SUPPORTED",
      outcomeKind: "FAILED" as const,
      projectName: "Raydium",
      components: partialFailure.map((c) => ({ component: c.component, status: c.status })),
    };
    expect(briefingFor(partialFailure, input).shortAnswer).toEqual(researchAnswer(input));
  });

  it("what survived the failure is still named, and the fault stays on the run", () => {
    const text = briefingFor(partialFailure, {
      outcomeKind: "FAILED",
    }).shortAnswer.join(" ");
    expect(text).toContain("did not complete");
    expect(text).toContain("did not answer the whole question");
    expect(text).toContain("Before it failed it established");
    expect(text).toContain("it is not a finding about the project");
  });

  it("NO still-open list on a failed run, and the rows below still carry everything", () => {
    // On a completed run an unresolved row means "attempted, came back
    // short". On a FAILED one it may equally be a component the run never
    // reached, so naming it as a research result would report the fault as
    // a finding. Nothing is hidden: the key findings table is unchanged.
    const b = briefingFor(partialFailure, { outcomeKind: "FAILED" });
    expect(b.unresolved).toEqual([]);
    expect(b.keyFindings.map((f) => f.component)).toContain("EXECUTION_EVIDENCE");
    expect(b.keyFindings.find((f) => f.component === "FLOW_PATH")?.result).toBe("Established");
  });
});

describe("TEST 7 — FAILED with nothing substantive keeps its exact wording", () => {
  const emptyFailure: LadderComponentInput[] = [
    { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "PARTIAL" },
  ];

  it("the two original sentences are returned unchanged", () => {
    const text = briefingFor(emptyFailure, {
      outcomeKind: "FAILED",
      projectName: "Raydium",
    }).shortAnswer;
    expect(text).toEqual([
      "This research run did not complete, so it established nothing about Raydium.",
      "The failure is a problem with the run itself — it is not a finding about the project.",
    ]);
  });

  it("no established/partly-established claim is manufactured from nothing", () => {
    const b = briefingFor(emptyFailure, { outcomeKind: "FAILED" });
    const text = b.shortAnswer.join(" ");
    expect(text).not.toContain("Established:");
    expect(text).not.toContain("Partly established:");
    expect(b.unresolved).toEqual([]);
  });

  it("cancelled and in-progress runs delegate too", () => {
    for (const kind of ["CANCELLED", "IN_PROGRESS"] as const) {
      const input = {
        verdict: null,
        outcomeKind: kind,
        projectName: "Raydium",
        components: RAYDIUM.map((c) => ({ component: c.component, status: c.status })),
      };
      expect(briefingFor(RAYDIUM, input).shortAnswer).toEqual(researchAnswer(input));
      expect(unresolvedFrom(rowsFor(RAYDIUM), kind)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 8. NO FREE TEXT REACHES THE TOP OF THE RESULT                       */
/* ------------------------------------------------------------------ */

describe("TEST 8 — an admitted source sentence never becomes an ATLAS conclusion", () => {
  it("PROTOCOL-HELD RAY: the summary cannot appear anywhere in the briefing", () => {
    // This sentence has no typed system-level carrier. It is a source's
    // statement, and at the top of a result there is no attribution beside
    // it — so it would read as ATLAS's own finding about protocol
    // holdings. The briefing takes no summaries at all, and this pins the
    // consequence rather than the mechanism.
    const b = briefingFor(RAYDIUM);
    const html = render(
      createElement(ResultBriefing, { keyFindings: b.keyFindings, unresolved: b.unresolved, unresolvedMore: b.unresolvedMore }),
    );
    const all = `${b.shortAnswer.join(" ")} ${html}`;
    expect(all).not.toContain(PROTOCOL_HELD_SUMMARY);
    expect(all).not.toContain("DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz");
    expect(all.toLowerCase()).not.toContain("protocol-held");
    expect(all.toLowerCase()).not.toContain("held by the protocol");
  });

  it("no unsupported claim of holding, burning, receiving or benefit appears", () => {
    const b = briefingFor(RAYDIUM);
    const html = render(
      createElement(ResultBriefing, { keyFindings: b.keyFindings, unresolved: b.unresolved, unresolvedMore: b.unresolvedMore }),
    );
    const all = `${b.shortAnswer.join(" ")} ${html}`.toLowerCase();
    for (const claim of [
      "burned",
      "burnt",
      "tokens are held",
      "holders benefit",
      "benefits holders",
      "accrues to holders",
      "is currently executing",
      "has executed",
      "buys back",
    ]) {
      expect(all, claim).not.toContain(claim);
    }
  });

  it("STRUCTURAL: the briefing has no path to evidence text at all", () => {
    // Comments stripped, so this asserts what the component DOES rather
    // than what its prose happens to discuss — the doc comment above it
    // names these very fields in order to explain why they are absent.
    const code = readFileSync(BRIEFING, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // It cannot reach a summary, a fragment or an evidence row: none of
    // those names is imported, typed or referenced.
    for (const forbidden of [
      "supportingSummaries",
      "findingMicroAnswer",
      "EvidenceItemLike",
      "fragment",
      "summary",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // The word "evidence" DOES appear, and must: the still-open copy says
    // there was not enough of it. That is reader-facing prose about what
    // the run reached, not a data path to an evidence row.
    expect(code).toContain("Not enough evidence to settle these");
    // And the page hands it three derived props, nothing evidential.
    const page = readFileSync(PAGE, "utf-8");
    for (const prop of [
      "keyFindings={briefing.keyFindings}",
      "unresolved={briefing.unresolved}",
      "unresolvedMore={briefing.unresolvedMore}",
    ]) {
      expect(page, prop).toContain(prop);
    }
  });

  it("STRUCTURAL: the status index carries only a label and a state", () => {
    // The explanatory third column is gone. A KeyFinding now has exactly
    // four fields, none of which can hold a sentence written by a model:
    // the component (never rendered), the ladder's own claim label, the
    // canonical state label, and its tone.
    const { keyFindings } = briefingFor(RAYDIUM);
    for (const f of keyFindings) {
      expect(Object.keys(f).sort()).toEqual(["check", "component", "result", "tone"]);
    }
    const model = readFileSync(MODEL, "utf-8");
    expect(model).not.toContain("establishedCell");
  });

  it("the unresolved detail is still a typed field, never a summary", () => {
    // "Still open" is the one place the briefing prints a sentence, and it
    // comes from the row's own limitation or persisted reason code.
    const model = readFileSync(MODEL, "utf-8");
    expect(model).toContain("detail: (blocked ? r.limitation : r.reason) ?? fallback");
  });
});

/* ------------------------------------------------------------------ */
/* 9. THE LAYER SITS ABOVE THE PROOF, AND CHANGES NOTHING BELOW        */
/* ------------------------------------------------------------------ */

describe("the deep result is intact beneath the new layer", () => {
  it("the ladder, the audit entry and the developer details all still render", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain("<ResultLadder");
    expect(page.split("<ResultLadder").length - 1).toBe(1);
    expect(page).toContain('data-testid="audit-entry"');
    expect(page).toContain("<DeveloperDetails");
    expect(page).toContain("<ResearchProgress");
    // And the briefing is ABOVE the ladder, not instead of it.
    expect(page.indexOf("<ResultBriefing")).toBeLessThan(page.indexOf("<ResultLadder"));
  });

  it("the briefing summarises the SAME rows the ladder renders", () => {
    // Deriving from a different set would let the top of the page disagree
    // with the detail underneath it — the one failure this layer must not
    // have.
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain(
      "questionRows.length > 0 ? questionRows : [...ladder.mechanism, ...ladder.value]",
    );
  });

  it("PRESENTATION ONLY: no model call, no research call, no new persistence", () => {
    for (const file of [BRIEFING, MODEL]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("anthropic");
      expect(src, file).not.toContain("generateQuestionProjection");
      expect(src, file).not.toContain("db.");
      expect(src, file).not.toContain("fetch(");
    }
  });

  it("no status is computed in the briefing: it maps, never decides", () => {
    // Every result string in the table is one of the four canonical state
    // labels the ladder already uses, so a reader meets one vocabulary.
    const { keyFindings } = briefingFor(RAYDIUM);
    const canonical = new Set([
      "Established",
      "Partly established",
      "Not established",
      "Evidence indicates otherwise",
    ]);
    for (const f of keyFindings) {
      expect(canonical.has(f.result), f.result).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 10. CLEANUP V1 — MOBILE-SAFE, SHORT, AND SAID ONCE                  */
/* ------------------------------------------------------------------ */

// Seen on the live Raydium result at 430px: the index needed 544px inside a
// 364px panel, so its third column — the only one carrying substance — sat
// off-screen behind a sideways scroll. The same screen said "The sources
// checked here carried nothing on this point." six times.
//
// These tests hold the fixes: two columns that cannot overflow, three open
// items at most, and one statement of the limitation.

describe("CLEANUP — the index cannot overflow a phone", () => {
  const brief = () => readFileSync(BRIEFING, "utf-8");

  it("the table is width-bound, and nothing can widen it", () => {
    const code = brief()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // `table-fixed w-full` bounds the table to its panel and wraps cells.
    expect(code).toContain("w-full table-fixed");
    // The three things that reintroduced the sideways scroll last time.
    expect(code).not.toContain("min-w-");
    expect(code).not.toContain("overflow-x-auto");
    expect(code).not.toContain("whitespace-nowrap");
  });

  it("there are exactly two columns, and no explanatory third", () => {
    const code = brief();
    expect(code).toContain("<col className=\"w-[66%]\" />");
    expect(code).toContain("<col className=\"w-[34%]\" />");
    // The header row and the substance column are both gone.
    expect(code).not.toContain("What ATLAS established");
    expect(code).not.toContain("<thead>");
  });

  it("each rendered row has one label cell and one status cell", () => {
    const b = briefingFor(RAYDIUM);
    const html = render(
      createElement(ResultBriefing, {
        keyFindings: b.keyFindings,
        unresolved: b.unresolved,
        unresolvedMore: b.unresolvedMore,
      }),
    );
    expect(html.split('data-testid="key-finding-row"').length - 1).toBe(RAYDIUM.length);
    expect(html.split('data-testid="key-finding-result"').length - 1).toBe(RAYDIUM.length);
    // Two <td> per row and no more.
    const rowChunk = html.split('data-testid="key-finding-row"')[1] ?? "";
    expect((rowChunk.split("</td>").length - 1) >= 2).toBe(true);
  });

  it("every component status still reaches the index", () => {
    // Shrinking the index must not drop a finding. All ten are present,
    // each with its canonical state label.
    const { keyFindings } = briefingFor(RAYDIUM);
    expect(keyFindings).toHaveLength(RAYDIUM.length);
    expect(new Set(keyFindings.map((f) => f.component))).toEqual(
      new Set(RAYDIUM.map((c) => c.component)),
    );
    const canonical = new Set([
      "Established",
      "Partly established",
      "Not established",
      "Evidence indicates otherwise",
    ]);
    for (const f of keyFindings) expect(canonical.has(f.result), f.result).toBe(true);
  });
});

describe("CLEANUP — Still open shows three, and counts the rest", () => {
  it("four open checks render three items and one count", () => {
    // The live Raydium run leaves four open. Printing all four made the
    // section a second ladder.
    const fourOpen: LadderComponentInput[] = [
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
      { component: "GOVERNANCE_BASIS", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
      { component: "CURRENT_STATE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
      { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
      { component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
    ];
    const b = briefingFor(fourOpen);
    expect(b.unresolved).toHaveLength(3);
    expect(b.unresolvedMore).toBe(1);

    const html = render(
      createElement(ResultBriefing, {
        keyFindings: b.keyFindings,
        unresolved: b.unresolved,
        unresolvedMore: b.unresolvedMore,
      }),
    );
    expect(html.split('data-testid="unresolved-item"').length - 1).toBe(3);
    expect(html).toContain("and 1 more below");
    // NOTHING IS HIDDEN. The fourth is still in the index above.
    expect(b.keyFindings.map((f) => f.component)).toContain("NET_EFFECT");
  });

  it("three or fewer open checks show no count at all", () => {
    const b = briefingFor([
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
      { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", coverage: "COMPLETED" },
    ]);
    expect(b.unresolvedMore).toBe(0);
    const html = render(
      createElement(ResultBriefing, {
        keyFindings: b.keyFindings,
        unresolved: b.unresolved,
        unresolvedMore: b.unresolvedMore,
      }),
    );
    expect(html).not.toContain('data-testid="unresolved-more"');
    expect(html).not.toContain("more below");
  });

  it("the count is never negative and the cap is the only reason to hide", () => {
    for (const n of [0, 1, 2, 3]) {
      const comps: LadderComponentInput[] = [
        { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
        ...["GOVERNANCE_BASIS", "CURRENT_STATE", "EXECUTION_EVIDENCE"]
          .slice(0, n)
          .map((component) => ({
            component,
            status: "INSUFFICIENT_EVIDENCE",
            coverage: "COMPLETED" as const,
          })),
      ];
      const b = briefingFor(comps);
      expect(b.unresolvedMore, `n=${n}`).toBe(0);
      expect(b.unresolved.length, `n=${n}`).toBe(n);
    }
  });

  it("a FAILED run still shows no open list and no count", () => {
    const b = briefingFor(RAYDIUM, { outcomeKind: "FAILED" });
    expect(b.unresolved).toEqual([]);
    expect(b.unresolvedMore).toBe(0);
  });
});

describe("CLEANUP — the limitation is stated once", () => {
  it("the answer panel no longer carries its own unresolved callout", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page).not.toContain('data-testid="answer-boundary"');
    expect(page).not.toContain("Still unresolved");
    expect(page).not.toContain("Research limitation");
    // And the row it fed is no longer picked out for a third treatment.
    expect(page).not.toContain("const boundary =");
    expect(page).not.toContain("findingExplanation");
  });

  it("the limitation survives in the short answer, where it now lives alone", () => {
    const { shortAnswer } = briefingFor([
      { component: "MECHANISM_SPEC", status: "SUPPORTED", coverage: "COMPLETED" },
      {
        component: "EXECUTION_EVIDENCE",
        status: "INSUFFICIENT_EVIDENCE",
        coverage: "COMPLETED",
        reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
      },
    ]);
    const text = shortAnswer.join(" ");
    expect(text).toContain("Main limitation —");
    expect(text).toContain("The mechanism is described, but nothing checked shows it actually running.");
    // Said once in the answer, not twice.
    expect(text.split("Main limitation").length - 1).toBe(1);
  });

  it("the deep Proof below is untouched by any of this", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page.split("<ResultLadder").length - 1).toBe(1);
    expect(page).toContain('data-testid="audit-entry"');
    expect(page).toContain("<DeveloperDetails");
    expect(page).toContain("questionFindings={detail.questionFindings}");
    expect(page).toContain("evidenceByComponent={evidenceByComponent}");
    expect(page).toContain("supportingSummariesByComponent={supportingSummariesByComponent}");
    expect(page.indexOf("<ResultBriefing")).toBeLessThan(page.indexOf("<ResultLadder"));
  });
});

describe("CLEANUP — the index borrows the ladder's own status treatment", () => {
  it("the status colours match the ladder's, value for value", () => {
    // The index first used the product's `.tone` pill. `.tone` sets
    // `white-space: nowrap`, so "PARTLY ESTABLISHED" rendered 161px wide
    // inside a 124px cell and pushed past the right edge of a 430px
    // viewport — `table-fixed` bounds the table, not a child that refuses
    // to wrap. The index now uses the same weight-and-case treatment the
    // ladder gives its own row states.
    //
    // Two files therefore hold the same four colours. This reads both so
    // they cannot drift into two palettes for one meaning.
    const brief = readFileSync(BRIEFING, "utf-8");
    const ladder = readFileSync("src/client/components/result-ladder.tsx", "utf-8");
    const ladderColors = ladder.slice(
      ladder.indexOf("function stateColor"),
      ladder.indexOf("function StateIcon"),
    );
    for (const [tone, hex] of [
      ["supported", "#5eead4"],
      ["partial", "#c4b5fd"],
      ["negative", "#fca5a5"],
      ["insufficient", "#fcd34d"],
    ] as const) {
      expect(brief, tone).toContain(`${tone}: "${hex}"`);
      expect(ladderColors, hex).toContain(hex);
    }
  });

  it("the index renders no tone pill, so nothing in it can refuse to wrap", () => {
    const code = readFileSync(BRIEFING, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("tone tone-");
    expect(code).not.toContain("className={`tone");
  });
});
