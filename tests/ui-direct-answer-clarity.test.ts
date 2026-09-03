import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { deriveReaderMeaning } from "../src/client/reader-meaning";
import { researchAnswer } from "../src/client/research-model";

// THE DIRECT ANSWER, AND THE ONE THING IT USED TO WITHHOLD.
//
// A reader who asked "does burning actually reduce the supply?" met this at
// the top of a finished result:
//
//   "On a durable effect on token supply, the evidence indicates otherwise."
//
// Every word of that is true. It names the component and the direction of
// the finding and withholds the finding, so the sentence that actually
// answers the question — burn confirmed, supply did not fall over the
// measured period — was reachable only by scrolling into the ladder.
//
// These tests pin the fix and, more importantly, its limits: the answer may
// now say the SPECIFIC thing, and it still may not say anything a component
// row does not already say. The sentence is not written here and is not
// written twice — it is the reader layer's own headline, derived from the
// same canonical status and reason codes as the row it summarises.

const ANSWER_SOURCE = "src/client/research-model.ts";

// One realistic finished run: the mechanism is documented, authorised and
// observed executing, and the supply question is where it stops.
const established = [
  { component: "MECHANISM_SPEC", status: "SUPPORTED" },
  { component: "GOVERNANCE_BASIS", status: "SUPPORTED" },
  { component: "EXECUTION_EVIDENCE", status: "SUPPORTED" },
];

const answerFor = (netEffect: { status: string; reasonCodes: string[] }) =>
  researchAnswer({
    verdict: "PARTIALLY_SUPPORTED",
    projectName: "Example Protocol",
    components: [...established, { component: "NET_EFFECT", ...netEffect }],
  });

/* ------------------------------------------------------------------ */
/* 1-4. THE FOUR B2 CASES, AT THE TOP OF THE SCREEN                    */
/* ------------------------------------------------------------------ */

describe("direct answer — the measured finding leads", () => {
  it("TEST 1: CASE A — a burn with no interval never implies a net reduction", () => {
    const answer = answerFor({
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"],
    });
    const text = answer.join(" ");
    // Nothing was measured, so nothing leads. The answer stays what it was:
    // what the run established, and what it did not.
    expect(text).not.toContain("did not decrease");
    expect(text).not.toContain("decreased over the measured period");
    expect(text.toLowerCase()).not.toContain("reduce");
    expect(text).toContain("Established:");
  });

  it("TEST 2: CASE B — a measured decrease leads, and stays unattributed", () => {
    const answer = answerFor({
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"],
    });
    expect(answer[0]).toBe(
      "Burn was confirmed and total supply decreased over the measured period, but the decrease is not attributed to this mechanism.",
    );
    // The measurement is the lead; what the run established still follows it.
    expect(answer.join(" ")).toContain("Established:");
    expect(answer.join(" ").toLowerCase()).not.toContain("caused");
  });

  it("TEST 3: CASE C — the contradiction leads, and opens with the burn", () => {
    const answer = answerFor({
      status: "CONTRADICTED",
      reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
    });
    expect(answer[0]).toBe(
      "Burn was confirmed, but total supply did not decrease over the measured period.",
    );
    // The sentence it replaced is gone from the answer entirely.
    expect(answer.join(" ")).not.toContain("the evidence indicates otherwise");
    // POSITIVE FACT FIRST: the established half of the sentence comes first.
    expect(answer[0].indexOf("Burn was confirmed")).toBeLessThan(
      answer[0].indexOf("did not decrease"),
    );
  });

  it("TEST 4: CASE D — direction is not inferred, so C and D read alike", () => {
    // The component contract carries "did not decrease" and does NOT carry
    // whether supply was unchanged or higher: the reconciler files both as
    // one contradiction. Nothing here may recover the difference from prose,
    // so the honest sentence covering both is the one that is used.
    const answer = answerFor({
      status: "CONTRADICTED",
      reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
    });
    expect(answer[0].toLowerCase()).not.toContain("increased");
    expect(answer[0]).toContain("did not decrease");
  });
});

/* ------------------------------------------------------------------ */
/* 5-8. WHAT THE ANSWER STILL MAY NOT DO                               */
/* ------------------------------------------------------------------ */

describe("direct answer — the limits it keeps", () => {
  const allAnswers = [
    answerFor({ status: "PARTIALLY_SUPPORTED", reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"] }),
    answerFor({ status: "PARTIALLY_SUPPORTED", reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"] }),
    answerFor({ status: "CONTRADICTED", reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"] }),
    answerFor({ status: "PARTIALLY_SUPPORTED", reasonCodes: ["CONFLICTING_SUPPLY_DELTA"] }),
    answerFor({ status: "PARTIALLY_SUPPORTED", reasonCodes: ["SUPPLY_REDUCTION_NOT_ESTABLISHED"] }),
    answerFor({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }),
    answerFor({ status: "CONTRADICTED", reasonCodes: ["CONFLICTING_STATE"] }),
  ].map((a) => a.join(" "));

  it("TEST 5: no internal reason code or component name reaches the answer", () => {
    for (const text of allAnswers) {
      expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    }
  });

  it("TEST 6: no unsupported causality, and no accusation", () => {
    for (const text of allAnswers) {
      const lower = text.toLowerCase();
      for (const forbidden of [
        "caused",
        "because of",
        "due to",
        "resulted in",
        "led to",
        "proves",
        "fake",
        "lied",
        "scam",
        "failed",
        "inflationary",
        "deflationary",
        "bullish",
        "bearish",
      ]) {
        expect(lower, `${forbidden} in "${text}"`).not.toContain(forbidden);
      }
    }
  });

  it("TEST 7: the canonical verdict is read, never restated as a claim", () => {
    // The answer never renders the verdict string, and a differently
    // verdicted job with identical components produces identical sentences —
    // the badge carries strength, these sentences carry substance.
    const a = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      projectName: "Example Protocol",
      components: [
        ...established,
        { component: "NET_EFFECT", status: "CONTRADICTED", reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"] },
      ],
    });
    const b = researchAnswer({
      verdict: "CONTRADICTED",
      projectName: "Example Protocol",
      components: [
        ...established,
        { component: "NET_EFFECT", status: "CONTRADICTED", reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"] },
      ],
    });
    expect(b).toEqual(a);
    expect(a.join(" ")).not.toContain("PARTIALLY");
  });

  it("TEST 8: the answer is the reader layer's own sentence, not a second one", () => {
    const meaning = deriveReaderMeaning({
      status: "CONTRADICTED",
      reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
      subject: "a durable effect on token supply",
    });
    const answer = answerFor({
      status: "CONTRADICTED",
      reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
    });
    // Byte for byte. Two sentences for one finding on one screen is exactly
    // the second interpretation system this must not become.
    expect(answer[0]).toBe(meaning.headline);
  });

  it("TEST 8b: a component with no reason codes is unchanged by any of this", () => {
    // A conflict BETWEEN SOURCES is not a measurement, so it keeps the
    // general sentence it always had.
    const answer = answerFor({ status: "CONTRADICTED", reasonCodes: ["CONFLICTING_STATE"] });
    expect(answer[0]).toBe(
      "On a durable effect on token supply, the evidence indicates otherwise.",
    );
  });

  it("TEST 8c: an unresolved supply question still reads as unresolved", () => {
    const answer = answerFor({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] });
    const text = answer.join(" ");
    expect(text).toContain("Not established:");
    expect(text).not.toContain("Burn was confirmed");
  });
});

/* ------------------------------------------------------------------ */
/* 9-11. STRUCTURAL                                                    */
/* ------------------------------------------------------------------ */

describe("direct answer — structural boundaries", () => {
  const src = readFileSync(ANSWER_SOURCE, "utf-8");

  it("TEST 9: no model call on this path", () => {
    for (const forbidden of ["anthropic", "callModel", "await fetch"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 10: no new research layer — the answer reads component rows only", () => {
    // The projection this function may consult is the reader layer and
    // nothing else. A second mapping from status/reason codes to copy INSIDE
    // researchAnswer is the thing that must not exist — the canonical
    // reason-code copy table elsewhere in this file is the one that already
    // does, and it stays exactly where it is.
    expect(src).toContain('from "./reader-meaning"');
    const body = src.slice(
      src.indexOf("export function researchAnswer"),
      src.indexOf("function plural("),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("deriveReaderMeaning(");
    // Not one engine reason code is named in the answer's own body: it asks
    // the reader layer what a row MEANS and never decides that itself.
    for (const code of [
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
      "SUPPLY_REDUCTION_NOT_ESTABLISHED",
      "NET_SUPPLY_CHANGE_NOT_ESTABLISHED",
      "NET_SUPPLY_CHANGE_NOT_ATTRIBUTED",
      "NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL",
      "CONFLICTING_SUPPLY_DELTA",
    ]) {
      expect(body, code).not.toContain(code);
    }
  });

  it("TEST 11: no project hardcoding anywhere in the answer", () => {
    const answer = answerFor({
      status: "CONTRADICTED",
      reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
    });
    // The project name is carried as data and never appears in a derived
    // finding sentence.
    expect(answer[0]).not.toContain("Example Protocol");
    // The same components under a different project produce the identical
    // finding sentence — which is the property "no project hardcoding"
    // actually means, and it holds for every project the engine will run.
    const other = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      projectName: "Another Protocol",
      components: [
        ...established,
        {
          component: "NET_EFFECT",
          status: "CONTRADICTED",
          reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
        },
      ],
    });
    expect(other).toEqual(answer);
  });
});
