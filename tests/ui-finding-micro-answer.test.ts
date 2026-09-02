import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ResultLadder } from "../src/client/components/result-ladder";
import {
  deriveQuestionFindings,
  findingExplanation,
  findingMicroAnswer,
  type LadderComponentInput,
} from "../src/client/research-model";

// THE COLLAPSED FINDING NOW ANSWERS ITS OWN QUESTION.
//
// It used to read:
//
//   Where does trading fee revenue go?          Established
//   The checked evidence establishes where the value ends up.
//
// The badge already said "Established"; the sentence said it again in
// longer words and never said where the value goes. A reader had to open
// every finding just to learn what was found, which turned expansion into
// a retrieval step rather than the "why?" it is meant to be.
//
// The badge carries STRENGTH. The micro-answer carries SUBSTANCE. These
// tests pin that split, and pin that gaining substance did not cost any
// of the safety the previous rounds bought.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const LADDER = "src/client/components/result-ladder.tsx";
const MODEL = "src/client/research-model.ts";
const PAGE = "app/(app)/research/[id]/page.tsx";

// A real persisted Evidence summary from the acceptance job — already
// admitted, already linked to DESTINATION, not written for this test.
const REAL_SUMMARY =
  "Bought-back RAY tokens are held by the protocol at a public on-chain address: DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz";

function row(over: Partial<LadderComponentInput> & { component: string }) {
  const [built] = deriveQuestionFindings(
    [{ label: "Q", patternStep: 6, component: over.component, supportingComponents: [] }],
    [{ status: "SUPPORTED", coverage: "COMPLETED", ...over }],
  );
  return built;
}

/* ------------------------------------------------------------------ */
/* 1-2. SUBSTANCE, NOT A STATUS PARAPHRASE                             */
/* ------------------------------------------------------------------ */

describe("an established finding states what was found", () => {
  it("TEST 1: the micro-answer is the engine's own admitted statement", () => {
    const answer = findingMicroAnswer(row({ component: "DESTINATION" }), [REAL_SUMMARY]);
    expect(answer).toBe(`${REAL_SUMMARY}.`);
    // It answers the question rather than grading it.
    expect(answer).not.toContain("The checked evidence");
    expect(answer).not.toContain("Established");
  });

  it("TEST 2: the generic preamble is gone wherever a real statement exists", () => {
    for (const state of [
      { status: "SUPPORTED" },
      { status: "PARTIALLY_SUPPORTED" },
    ]) {
      const answer = findingMicroAnswer(
        row({ component: "DESTINATION", ...state }),
        [REAL_SUMMARY],
      );
      for (const tautology of [
        "The checked evidence establishes",
        "The checked evidence confirms",
        "The checked evidence partly establishes",
        "The available evidence",
        "Evidence shows",
      ]) {
        expect(answer, tautology).not.toContain(tautology);
      }
    }
  });

  it("TEST 2b: with no admitted statement, the row says NOTHING rather than a tautology", () => {
    // It used to fall back to "The checked evidence establishes where the
    // value ends up" — which is the badge and the question restated, and
    // no fact at all. A line that teaches the reader nothing costs them a
    // line; the question and the status stand alone, and the expansion
    // supplies where it came from.
    expect(findingMicroAnswer(row({ component: "DESTINATION" }), [])).toBeNull();
    expect(findingMicroAnswer(row({ component: "DESTINATION", status: "PARTIALLY_SUPPORTED" }), []))
      .toBeNull();
  });

  it("TEST 2c: the expansion still cannot repeat the collapsed row's sentence", () => {
    const src = readFileSync(LADDER, "utf-8");
    expect(src).toContain("findingExplanation(row).filter((s) => s !== microAnswer)");
    // The guard now has nothing to catch on the established path, because
    // the two levels no longer draw from the same sentence at all: the row
    // carries the admitted statement, the expansion carries provenance and
    // the boundary. It stays as a structural backstop.
    const built = row({ component: "DESTINATION" });
    const micro = findingMicroAnswer(built, [REAL_SUMMARY]);
    expect(findingExplanation(built)).not.toContain(micro);
  });
});

/* ------------------------------------------------------------------ */
/* 3-6. EVERY OTHER STATUS SAYS ONLY WHAT IT MAY                       */
/* ------------------------------------------------------------------ */

describe("the micro-answer never says more than the canonical result", () => {
  it("TEST 3: an unresolved finding states what remains unknown", () => {
    const answer = findingMicroAnswer(
      row({ component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" }),
      // Even handed a supporting statement, an unresolved row must not
      // borrow it — nothing was established for it to state.
      [REAL_SUMMARY],
    );
    expect(answer).toBe("Whether the mechanism has actually executed was not established.");
    expect(answer).not.toContain("Bought-back");
  });

  it("TEST 4: a technical limitation never becomes a claim about the project", () => {
    const answer = findingMicroAnswer(
      row({
        component: "EXECUTION_EVIDENCE",
        status: "INSUFFICIENT_EVIDENCE",
        coverage: "BLOCKED",
        reasonCodes: ["NO_EVIDENCE_FOUND"],
      }),
      [REAL_SUMMARY],
    );
    expect(answer).toBe(
      "Whether the mechanism has actually executed could not be checked in this research run.",
    );
    // Not "does not happen", and not the evidence-gap wording either —
    // this run could not look, which is a different fact.
    expect(answer).not.toContain("was not established");
    expect(answer!.toLowerCase()).not.toContain("does not");
    // The full reason stays in the expansion, not on the collapsed row.
    expect(answer).not.toContain("Required source access failed");
  });

  it("TEST 5: a partial result is never rendered as fully established", () => {
    const partial = row({ component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED" });
    expect(partial.stateLabel).toBe("Partly established");
    // The badge carries the strength; the sentence carries the substance,
    // and the sentence itself asserts no strength at all.
    const answer = findingMicroAnswer(partial, [REAL_SUMMARY]);
    expect(answer).toBe(`${REAL_SUMMARY}.`);
    expect(answer).not.toContain("Established");
    expect(answer).not.toContain("fully");
  });

  it("TEST 6: a contradiction stays distinct, and stays about the evidence", () => {
    const answer = findingMicroAnswer(
      row({ component: "NET_EFFECT", status: "CONTRADICTED" }),
      [REAL_SUMMARY],
    );
    expect(answer).toBe(
      "On a durable effect on token supply, the sources point the other way.",
    );
    // The strongest thing a run can say is still a statement about what
    // the SOURCES show, never a bare assertion of the negative.
    expect(answer).toContain("the sources");
    expect(answer).not.toContain("was not established");
  });
});

/* ------------------------------------------------------------------ */
/* 7. THE SEMANTIC GUARD                                               */
/* ------------------------------------------------------------------ */

describe("a micro-answer cannot broaden its canonical claim", () => {
  it("TEST 7: it is grounded only in evidence linked to its OWN component", () => {
    // Structural, not a filter: the row is handed
    // supportingSummariesByComponent[its own component] and can reach no
    // other key, so one finding cannot answer another's question.
    const src = readFileSync(LADDER, "utf-8");
    expect(src).toContain(
      "supportingSummaries: supportingSummariesByComponent?.[row.component] ?? []",
    );
    expect(src).not.toContain("supportingSummariesByComponent[");

    // And the page builds it from SUPPORTING links only — a contradicting
    // or refused row can never become a finding's answer.
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain('if (link.role === "SUPPORTING" && e.summary)');
    expect(page).toContain('if (link.role === "EXCLUDED") continue');
  });

  it("TEST 7b: the phrase used is the component's own, never a broader one", () => {
    // SOURCE_OF_VALUE must not become "where the money goes", and
    // NET_EFFECT must not become "effect on price".
    expect(findingMicroAnswer(row({ component: "SOURCE_OF_VALUE", status: "INSUFFICIENT_EVIDENCE" }), [])).toBe(
      "Where the economic value comes from was not established.",
    );
    expect(findingMicroAnswer(row({ component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE" }), [])).toBe(
      "A durable effect on token supply was not established.",
    );
    // Not price, not value-in-general.
    const netEffect = findingMicroAnswer(row({ component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE" }), []);
    expect(netEffect!.toLowerCase()).not.toContain("price");
  });

  it("TEST 7c: an over-long statement is declined, never truncated", () => {
    // A summary is admitted Evidence. Cutting it mid-clause could change
    // what it says, so the fallback is used instead.
    const long = `${"x".repeat(260)}.`;
    // Declined, and with no tautology to fall back to, the row simply
    // carries no micro-answer line.
    expect(findingMicroAnswer(row({ component: "DESTINATION" }), [long])).toBeNull();
    // One sentence is taken from a multi-sentence summary, not all of it.
    expect(
      findingMicroAnswer(row({ component: "DESTINATION" }), ["First part. Second part."]),
    ).toBe("First part.");
  });
});

/* ------------------------------------------------------------------ */
/* 8-12. NOTHING ELSE MOVED                                            */
/* ------------------------------------------------------------------ */

describe("presentation only", () => {
  it("TEST 8 + 9: no project-specific mapping and no keyword rule", () => {
    const model = readFileSync(MODEL, "utf-8");
    const fn = model.slice(
      model.indexOf("export function findingMicroAnswer"),
      model.indexOf("function capitalise"),
    );
    // The selection is by canonical order and status alone — it never
    // inspects the text of a summary or the name of a project.
    for (const token of ["Raydium", "RAY", "buyback", "burn", "fees", "includes(", "match("]) {
      expect(fn, token).not.toContain(token);
    }
    // And no component is special-cased into a different sentence.
    for (const token of ["DESTINATION", "NET_EFFECT", "SOURCE_OF_VALUE"]) {
      expect(fn, token).not.toContain(token);
    }
  });

  it("TEST 10: no model call was added", () => {
    for (const file of [MODEL, LADDER, PAGE]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("anthropic");
      expect(src, file).not.toContain("generateQuestionProjection");
    }
    const model = readFileSync(MODEL, "utf-8");
    const fn = model.slice(
      model.indexOf("export function findingMicroAnswer"),
      model.indexOf("function capitalise"),
    );
    expect(fn).not.toContain("await");
    expect(fn).not.toContain("fetch(");
  });

  it("TEST 11 + 12: projection and engine contracts are untouched", () => {
    const projection = readFileSync("src/server/engine/question-projection.ts", "utf-8");
    expect(projection).toContain("export const PROJECTION_VERSION = 1");
    expect(projection).toContain("export const MIN_FINDINGS = 2");
    const runJob = readFileSync("src/server/engine/run-job.ts", "utf-8");
    expect(runJob).toContain("generateQuestionProjectionSafely(db, jobId)");
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

  it("TEST 13: the collapsed row renders the micro-answer beside its badge", () => {
    const html = render(
      createElement(ResultLadder, {
        components: [
          { component: "DESTINATION", status: "SUPPORTED", coverage: "COMPLETED" as const },
          {
            component: "EXECUTION_EVIDENCE",
            status: "INSUFFICIENT_EVIDENCE",
            coverage: "COMPLETED" as const,
          },
        ],
        questionFindings: [
          { label: "Where does the value go?", patternStep: 6, component: "DESTINATION", supportingComponents: [] },
          { label: "Is it running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
        ],
        supportingSummariesByComponent: { DESTINATION: [REAL_SUMMARY] },
      }),
    );
    // Both rows are CLOSED, and both already carry their answer.
    expect(html.match(/data-open="false"/g) ?? []).toHaveLength(2);
    expect(html.match(/data-testid="finding-micro-answer"/g) ?? []).toHaveLength(2);
    expect(html).toContain(REAL_SUMMARY);
    expect(html).toContain("Whether the mechanism has actually executed was not established.");
    // The status badge still states the strength, separately.
    expect(html).toContain("Established");
    expect(html).toContain("Not established");
    // And no expansion is rendered until a row is opened.
    expect(html).not.toContain('data-testid="ladder-expansion"');
  });
});
