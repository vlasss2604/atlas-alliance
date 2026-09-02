import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ResultLadder } from "../src/client/components/result-ladder";
import {
  SOURCE_CLASS_CAVEATS,
  componentClaimLabel,
  deriveQuestionFindings,
  findingExplanation,
  findingMicroAnswer,
  researchAnswer,
  safeClaimLabel,
} from "../src/client/research-model";

// RESULT LANGUAGE — EACH LEVEL MUST EARN THE CLICK THAT REACHED IT.
//
// The structure was right and the writing was not. A reader met the same
// fact three times on the way down:
//
//   Level 1   12% of fees are allocated to buybacks.
//   Level 2   The checked evidence establishes where the value ends up.
//   Level 3   Supports: 12% of fees are allocated to buybacks.
//
// Two of those three lines taught nothing. This file pins the split that
// replaced them — WHAT at Level 1, WHERE IT CAME FROM and WHAT IT CANNOT
// SETTLE at Level 2, the source's own identity and words at Level 3 — and
// pins that shortening the prose did not loosen a single claim.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const LADDER = "src/client/components/result-ladder.tsx";
const MODEL = "src/client/research-model.ts";
const PAGE = "app/(app)/research/[id]/page.tsx";

const REAL_SUMMARY =
  "Bought-back RAY tokens are held by the protocol at a public on-chain address";

const DESTINATION_FINDING = {
  label: "Where does the value go?",
  patternStep: 6,
  component: "DESTINATION",
  supportingComponents: [],
};

function row(over: Record<string, unknown> = {}) {
  const [built] = deriveQuestionFindings(
    [DESTINATION_FINDING],
    [{ component: "DESTINATION", status: "SUPPORTED", coverage: "COMPLETED", ...over }],
    { DESTINATION: ["OFFICIAL_DOCS"] },
  );
  return built;
}

/* ------------------------------------------------------------------ */
/* 1-2. THE BRAND IS NOT THE VOCABULARY                                */
/* ------------------------------------------------------------------ */

describe("the product does not narrate itself", () => {
  it("TEST 1: no rendered heading or sentence introduces ATLAS as an organisation", () => {
    const html = render(
      createElement(ResultLadder, {
        components: [
          { component: "DESTINATION", status: "SUPPORTED", coverage: "COMPLETED" as const },
          {
            component: "EXECUTION_EVIDENCE",
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
            coverage: "COMPLETED" as const,
          },
        ],
        questionFindings: [
          DESTINATION_FINDING,
          { label: "Is it running?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
        ],
        supportingSummariesByComponent: { DESTINATION: [REAL_SUMMARY] },
      }),
    );
    for (const phrase of ["organization ATLAS", "ATLAS organization", "the ATLAS"]) {
      expect(html, phrase).not.toContain(phrase);
    }
    // The reader is already inside the product; the section heading does
    // not need to name it.
    expect(html).toContain("Key findings");
    expect(html).not.toContain("What ATLAS established");
  });

  it("TEST 2: the reason-code vocabulary describes the record, not the researcher", () => {
    // "The sources ATLAS successfully checked …" put the product's name in
    // a sentence about the public record. What matters is what was found,
    // not who was doing the looking.
    const model = readFileSync(MODEL, "utf-8");
    const block = model.slice(
      model.indexOf("export const REASON_CODE_EXPLANATIONS"),
      model.indexOf("export function reasonExplanation"),
    );
    expect(block).not.toContain("ATLAS");
  });
});

/* ------------------------------------------------------------------ */
/* 3-6. EVERY LEVEL ADDS SOMETHING                                     */
/* ------------------------------------------------------------------ */

describe("each level adds information the one above did not have", () => {
  it("TEST 3: Level 1 states the finding; Level 2 states where it came from", () => {
    const built = row();
    const micro = findingMicroAnswer(built, [REAL_SUMMARY]);
    const explanation = findingExplanation(built);

    // WHAT.
    expect(micro).toBe(`${REAL_SUMMARY}.`);
    // WHERE FROM — and not the same sentence again.
    expect(explanation[0]).toBe("This comes from the project's own documentation.");
    expect(explanation).not.toContain(micro);
    expect(explanation.join(" ")).not.toContain(REAL_SUMMARY);
  });

  it("TEST 4: Level 2 never restates the status the badge already carries", () => {
    for (const state of [{}, { status: "PARTIALLY_SUPPORTED" }]) {
      const text = findingExplanation(row(state)).join(" ");
      for (const tautology of [
        "The checked evidence establishes",
        "The checked evidence partly establishes",
        "The checked evidence confirms",
        "The available evidence",
        "Evidence shows",
      ]) {
        expect(text, tautology).not.toContain(tautology);
      }
    }
  });

  it("TEST 5: Level 2 closes on the boundary that source class cannot cross", () => {
    const text = findingExplanation(row()).join(" ");
    expect(text).toContain(
      "Documentation alone does not establish that the documented thing is happening.",
    );
  });

  it("TEST 6: Level 3 drops the paraphrase Level 1 already showed", () => {
    const item = readFileSync(LADDER, "utf-8");
    const card = item.slice(item.indexOf("function EvidenceItem"));
    // `summary` IS the micro-answer's source. Rendering it again under the
    // quotation is the third telling of one fact.
    expect(card).not.toContain("{item.summary}");
    expect(card).not.toContain("Supports:");
    // What it shows instead is new: who published it, and its limits.
    expect(card).toContain("Why this source");
    expect(card).toContain("Source limit");
  });
});

/* ------------------------------------------------------------------ */
/* 7-9. SOURCE TRUST AND PROVENANCE                                    */
/* ------------------------------------------------------------------ */

describe("a source card proves it is a source", () => {
  const card = readFileSync(LADDER, "utf-8").slice(
    readFileSync(LADDER, "utf-8").indexOf("function EvidenceItem"),
  );

  it("TEST 7: it answers who, what kind, what was said, and where to read it", () => {
    // The seven questions a reader must be able to answer without leaving
    // the card. Each maps to something rendered from canonical data.
    expect(card).toContain("Source");                     // labelled as a source
    expect(card).toContain("item.sourceTitle");            // who published it
    expect(card).toContain("sourceClassLabel(item.sourceClass)"); // what kind
    expect(card).toContain("domainOf(item.retrievedUrl)"); // where it lives
    expect(card).toContain("{item.fragment}");             // what it said
    expect(card).toContain("caveat.can");                  // why it matters
    expect(card).toContain("Open source");                 // where to verify
    expect(card).toContain("item.retrievedUrl");
    expect(card).toContain('target="_blank"');
  });

  it("TEST 8: an excerpt is called an excerpt, never presented as the document", () => {
    // Showing an extracted passage under a document-shaped frame would
    // imply the reader is looking at the original page. They are not.
    expect(card).toContain("Relevant excerpt");
    expect(card).toContain("<blockquote");
    // And nothing fabricates a preview of the page itself. Scanned over
    // the RENDER rather than the comments: the Source Snapshot round
    // added a comment saying its icon is "not a preview of the live
    // site", and a ban that a denial trips is measuring documentation
    // instead of what a reader sees. What must not exist is the thing
    // itself — an embedded page, or a captured picture of one.
    const rendered = card
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const fake of ["<iframe", "screenshot", "preview", "thumbnail"]) {
      expect(rendered.toLowerCase(), fake).not.toContain(fake);
    }
    expect(rendered).not.toMatch(/<embed|<object|background-image|<img\b/i);
  });

  it("TEST 9: source classes are visually distinguishable, and never ranked", () => {
    const model = readFileSync(LADDER, "utf-8");
    const chip = model.slice(model.indexOf("function sourceClassChipStyle"));
    // A KIND marker: on-chain, governance and documentation do not look
    // alike, because they answer different kinds of question.
    expect(chip).toContain("ONCHAIN_VERIFIABLE");
    expect(chip).toContain("GOVERNANCE");
    expect(chip).toContain("OFFICIAL_DOCS");
    // Never a score. No numbers, no trust vocabulary, no ordering.
    for (const scoreish of ["score", "rating", "trust", "rank", "%"]) {
      expect(chip.toLowerCase(), scoreish).not.toContain(scoreish);
    }
    // An unrecognised class falls back to neutral rather than guessing.
    expect(chip).toContain("default:");
  });

  it("TEST 9b: every class states both what it shows and what it cannot settle", () => {
    for (const [cls, caveat] of Object.entries(SOURCE_CLASS_CAVEATS)) {
      expect(caveat.from, cls).toMatch(/^This comes from .*\.$/);
      expect(caveat.can, cls).toMatch(/^[A-Z].*\.$/);
      expect(caveat.cannot, cls).toMatch(/^[A-Z].*\.$/);
    }
    // Official documentation may never stand in for execution.
    expect(SOURCE_CLASS_CAVEATS.OFFICIAL_DOCS.cannot).toContain(
      "does not establish that the documented thing is happening",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 10-12. THE SEMANTIC ENVELOPE                                        */
/* ------------------------------------------------------------------ */

describe("a label may rename a finding, never widen it", () => {
  it("TEST 10: NET_EFFECT cannot be labelled as an effect on value or price", () => {
    // OBSERVED LIVE. The projection labelled NET_EFFECT — whose canonical
    // meaning is a durable effect on token SUPPLY — as "the intended
    // effect of buybacks on token value". A reader sees "value" and reads
    // price, which this research never checked.
    const drifted = "What is the intended effect of buybacks on token value?";
    expect(safeClaimLabel("NET_EFFECT", drifted)).toBe(componentClaimLabel("NET_EFFECT"));
    expect(safeClaimLabel("NET_EFFECT", drifted)).toBe("Effect on token supply");

    for (const bad of [
      "Does the buyback raise the token price?",
      "What is the effect on market cap?",
      "What return do holders get?",
      "How much is the token worth after buybacks?",
    ]) {
      expect(safeClaimLabel("NET_EFFECT", bad), bad).toBe("Effect on token supply");
    }

    // A label that stays inside the envelope is left exactly as written.
    const safe = "Are bought-back tokens removed from supply?";
    expect(safeClaimLabel("NET_EFFECT", safe)).toBe(safe);
  });

  it("TEST 11: the other canonical drifts named by the owner are refused too", () => {
    // Where value COMES FROM is not where it goes.
    expect(safeClaimLabel("SOURCE_OF_VALUE", "Where does the revenue end up?")).toBe(
      componentClaimLabel("SOURCE_OF_VALUE"),
    );
    // What is written down is not what is happening.
    expect(safeClaimLabel("MECHANISM_SPEC", "Is the mechanism executing?")).toBe(
      componentClaimLabel("MECHANISM_SPEC"),
    );
    // An authorisation is not an execution.
    expect(safeClaimLabel("GOVERNANCE_BASIS", "Is the approved buyback running?")).toBe(
      componentClaimLabel("GOVERNANCE_BASIS"),
    );
    // An intended destination is not an observed transfer.
    expect(safeClaimLabel("DESTINATION", "Where were the tokens actually transferred?")).toBe(
      componentClaimLabel("DESTINATION"),
    );
  });

  it("TEST 12: the guard is per COMPONENT, never per project", () => {
    const model = readFileSync(MODEL, "utf-8");
    // Comments explain WHY each rule exists and legitimately use the words
    // the rule is about — strip them before scanning the code itself.
    const guard = model
      .slice(
        model.indexOf("const CLAIM_LABEL_FORBIDDEN"),
        model.indexOf("export function safeClaimLabel") + 400,
      )
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // No token, no domain, no project — the identical rule applies to every
    // research this engine will ever run.
    for (const token of ["Raydium", "raydium", "RAY", "pump", "Solana", ".io", "http"]) {
      expect(guard, token).not.toContain(token);
    }
    // And it never inspects the QUESTION — only the label against its own
    // component, which is what keeps it from being a keyword hack.
    expect(guard).not.toContain("question");
    expect(guard).toContain("componentClaimLabel(component)");
  });

  it("TEST 12b: a guarded label reaches the screen already corrected", () => {
    const [built] = deriveQuestionFindings(
      [
        {
          label: "What is the intended effect of buybacks on token value?",
          patternStep: 7,
          component: "NET_EFFECT",
          supportingComponents: [],
        },
      ],
      [{ component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" }],
    );
    expect(built.label).toBe("Effect on token supply");

    const html = render(
      createElement(ResultLadder, {
        components: [
          { component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED", coverage: "COMPLETED" as const },
        ],
        questionFindings: [
          {
            label: "What is the intended effect of buybacks on token value?",
            patternStep: 7,
            component: "NET_EFFECT",
            supportingComponents: [],
          },
        ],
      }),
    );
    expect(html).not.toContain("token value");
    expect(html).toContain("Effect on token supply");
  });
});

/* ------------------------------------------------------------------ */
/* 13-15. ONE VOCABULARY, AND NO WEAKENED CLAIMS                       */
/* ------------------------------------------------------------------ */

describe("one action vocabulary, and nothing strengthened by the rewrite", () => {
  it("TEST 13: the path to a source says SOURCES at every step", () => {
    const ladder = readFileSync(LADDER, "utf-8");
    const page = readFileSync(PAGE, "utf-8");
    expect(ladder).toContain('{open ? "Hide sources" : "Sources"}');
    expect(page).toContain("Sources · {usedDocs}");
    // The old three-names-for-one-idea vocabulary is gone from the normal
    // result: proof, evidence and support were all the same journey.
    const code = ladder
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("Show proof");
    expect(code).not.toContain("Hide proof");
    expect(code).not.toContain("View evidence");
  });

  it("TEST 14: the top answer leads with what was settled, not with its own verdict", () => {
    const text = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      outcomeKind: "VERDICT",
      projectName: "Fixture Project",
      components: [
        { component: "MECHANISM_SPEC", status: "SUPPORTED" },
        { component: "DESTINATION", status: "SUPPORTED" },
        { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" },
      ],
    });
    expect(text[0]).toMatch(/^Established:/);
    expect(text.join(" ")).toContain("Not established:");
    // The badge beside it already says PARTIALLY SUPPORTED; the prose does
    // not spend its first sentence saying so again.
    expect(text.join(" ")).not.toContain("part of what this question asked");
    expect(text.length).toBeLessThanOrEqual(3);
  });

  it("TEST 15: no status was strengthened, and no gap became a negative fact", () => {
    // Partial stays partial.
    const partial = row({ status: "PARTIALLY_SUPPORTED" });
    expect(partial.stateLabel).toBe("Partly established");
    expect(findingExplanation(partial).join(" ")).not.toContain("fully");

    // Unresolved stays unresolved, and never becomes "does not happen".
    const [gap] = deriveQuestionFindings(
      [{ label: "Is it running?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] }],
      [
        {
          component: "EXECUTION_EVIDENCE",
          status: "INSUFFICIENT_EVIDENCE",
          reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
          coverage: "COMPLETED",
        },
      ],
    );
    expect(gap.stateLabel).toBe("Not established");
    const gapText = `${findingMicroAnswer(gap, [])} ${findingExplanation(gap).join(" ")}`;
    for (const forbidden of ["does not happen", "is not happening", "there is no", "proves"]) {
      expect(gapText.toLowerCase(), forbidden).not.toContain(forbidden);
    }

    // A blocked run still reads as coverage, not as a finding.
    const [blocked] = deriveQuestionFindings(
      [{ label: "Is it running?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] }],
      [
        {
          component: "EXECUTION_EVIDENCE",
          status: "INSUFFICIENT_EVIDENCE",
          reasonCodes: ["NO_EVIDENCE_FOUND"],
          coverage: "BLOCKED",
        },
      ],
    );
    expect(findingExplanation(blocked).join(" ")).toContain(
      "not evidence for or against the project",
    );
  });

  it("TEST 16: nothing here reaches a model, a provider or the engine", () => {
    for (const file of [LADDER, MODEL, PAGE]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("anthropic");
      expect(src, file).not.toContain("generateQuestionProjection");
      expect(src, file).not.toMatch(/\bfetch\(/);
    }
    // The projection contract and the newest migration are untouched.
    const projection = readFileSync("src/server/engine/question-projection.ts", "utf-8");
    expect(projection).toContain("export const PROJECTION_VERSION = 1");
    const journal = JSON.parse(
      readFileSync("src/server/db/migrations/meta/_journal.json", "utf-8"),
    ) as { entries: { tag: string }[] };
    // A presentation round may ADD its own derived table; it may never
    // alter an engine-owned one. So this guard is no longer "0040 is
    // still newest" — the Full Research Audit legitimately added 0041 —
    // but the invariant it protected, which is stronger and durable: no
    // migration touches a canonical research table.
    const newest = journal.entries[journal.entries.length - 1];
    const sql = readFileSync(`src/server/db/migrations/${newest.tag}.sql`, "utf-8");
    expect(sql).not.toMatch(
      /ALTER TABLE "(proofs|evidence|research_component_results|research_claim_support|research_attempts|sources|research_question_projections)"/,
    );
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)/i);
  });
});
