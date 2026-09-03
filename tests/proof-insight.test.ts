import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PROOF_INSIGHT_DOES_NOT_PROVE,
  deriveProofInsight,
  type ProofInsight,
} from "../src/client/proof-insight";
import { researchAnswer } from "../src/client/research-model";

// DETERMINISTIC INSIGHT v1.
//
// One optional sentence, chosen by a closed priority over canonical
// component state, saying the thing a reader could most easily miss from the
// direct Answer. NONE is the normal outcome and a successful one.
//
// Most of what follows tests silence and restraint rather than output: an
// Insight that fires when it has nothing to add, or that upgrades a
// measurement into a cause, would be worse than no Insight surface at all —
// because it sits beside a Proof and borrows its authority.

const SOURCE = "src/client/proof-insight.ts";
const BURN = "ev-burn";
const DELTA = "ev-delta";
const EXCLUDED = "ev-excluded";

const established = [
  { component: "MECHANISM_SPEC", status: "SUPPORTED", supportingEvidenceIds: ["ev-doc"] },
  { component: "EXECUTION_EVIDENCE", status: "SUPPORTED", supportingEvidenceIds: [BURN] },
];

// The two canonical rows the reconciler writes for cases C/D and B.
const contradictedRow = {
  component: "NET_EFFECT",
  status: "CONTRADICTED",
  reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
  supportingEvidenceIds: [BURN],
  contradictingEvidenceIds: [DELTA],
};
const notAttributedRow = {
  component: "NET_EFFECT",
  status: "PARTIALLY_SUPPORTED",
  reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"],
  supportingEvidenceIds: [BURN, DELTA],
  contradictingEvidenceIds: [] as string[],
};

const insightFor = (
  rows: unknown[],
  answerSentences: string[] = [],
  flows: unknown[] = [],
): ProofInsight =>
  deriveProofInsight({ components: rows as never, answerSentences, flows });

// S6 assembly, reduced to the one attribute this module reads.
const flowWithDestination = (destinationKind: string, lifecycle = "CURRENT") => ({
  lifecycle,
  attributes: { destinationKind },
});

// A run where the mechanism is documented, approved and observed running.
const documented = { component: "MECHANISM_SPEC", status: "SUPPORTED", supportingEvidenceIds: ["ev-doc"] };
const approved = { component: "GOVERNANCE_BASIS", status: "SUPPORTED", supportingEvidenceIds: ["ev-gov"] };
const executing = { component: "EXECUTION_EVIDENCE", status: "SUPPORTED", supportingEvidenceIds: [BURN] };
const executionMissing = {
  component: "EXECUTION_EVIDENCE",
  status: "INSUFFICIENT_EVIDENCE",
  reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
  supportingEvidenceIds: [] as string[],
};
const destinationEstablished = {
  component: "DESTINATION",
  status: "SUPPORTED",
  supportingEvidenceIds: ["ev-dest"],
};
const netEffectMissing = {
  component: "NET_EFFECT",
  status: "INSUFFICIENT_EVIDENCE",
  reasonCodes: ["NO_EVIDENCE_FOUND"],
  supportingEvidenceIds: [] as string[],
};
const recipientMissing = {
  component: "RECIPIENT",
  status: "INSUFFICIENT_EVIDENCE",
  reasonCodes: ["NO_EVIDENCE_FOUND"],
  supportingEvidenceIds: [] as string[],
};

/* ------------------------------------------------------------------ */
/* 1-3. WHEN AN INSIGHT EXISTS, AND WHEN IT DOES NOT                   */
/* ------------------------------------------------------------------ */

describe("insight — the two deterministic rules", () => {
  it("TEST 1: a measured contradiction yields one Insight", () => {
    const insight = insightFor([...established, contradictedRow]);
    expect(insight.type).toBe("INSIGHT");
    if (insight.type !== "INSIGHT") return;
    expect(insight.relation).toBe("MEASURED_CONTRADICTION");
    expect(insight.text).toBe(
      "What the measurement contradicts is the reduction in total supply — the burn ATLAS observed is established and is not in question.",
    );
  });

  it("TEST 2: a measured decrease with no attribution yields one Insight", () => {
    const insight = insightFor([...established, notAttributedRow]);
    expect(insight.type).toBe("INSIGHT");
    if (insight.type !== "INSIGHT") return;
    expect(insight.relation).toBe("MEASURED_WITHOUT_ATTRIBUTION");
    expect(insight.text).toContain("does not show that this mechanism is what reduced it");
  });

  it("TEST 3: no material secondary finding yields NONE", () => {
    // An ordinary good run: everything established, nothing measured against
    // it. There is no second meaning to add, so nothing is added.
    expect(insightFor(established).type).toBe("NONE");
    // A burn with no measured interval at all — the strongest case that
    // must NOT produce an Insight, because nothing was measured.
    expect(
      insightFor([
        ...established,
        {
          component: "NET_EFFECT",
          status: "PARTIALLY_SUPPORTED",
          reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"],
          supportingEvidenceIds: [BURN],
        },
      ]).type,
    ).toBe("NONE");
    // Sources disagreeing with each other is not a measurement.
    expect(
      insightFor([
        {
          component: "CURRENT_STATE",
          status: "CONTRADICTED",
          reasonCodes: ["CONFLICTING_STATE"],
          contradictingEvidenceIds: ["a", "b"],
        },
      ]).type,
    ).toBe("NONE");
    // Nothing at all.
    expect(deriveProofInsight({ components: [] }).type).toBe("NONE");
  });
});

/* ------------------------------------------------------------------ */
/* 4-8. IT READS CANONICAL STATE AND CHANGES NOTHING                   */
/* ------------------------------------------------------------------ */

describe("insight — canonical state is read, never touched", () => {
  it("TEST 4-6: no verdict, no status, no evidence is produced or altered", () => {
    const rows = [...established, { ...contradictedRow }];
    const before = JSON.stringify(rows);
    const insight = insightFor(rows);
    // The input is untouched...
    expect(JSON.stringify(rows)).toBe(before);
    // ...and the output carries no verdict, status, confidence or fact.
    expect(insight).not.toHaveProperty("verdict");
    expect(insight).not.toHaveProperty("status");
    expect(insight).not.toHaveProperty("confidence");
    expect(insight).not.toHaveProperty("fact");
    // An Insight is a sentence over ids, never a new evidence object.
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    for (const id of [...insight.supportingEvidenceIds, ...insight.contradictingEvidenceIds]) {
      expect(typeof id).toBe("string");
    }
  });

  it("TEST 7: only canonical evidence of the selected component is cited", () => {
    const insight = insightFor([...established, contradictedRow]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(insight.supportingEvidenceIds).toEqual([BURN]);
    expect(insight.contradictingEvidenceIds).toEqual([DELTA]);
    // Documentary evidence from a NEIGHBOURING component is never cited just
    // because it is nearby.
    expect([...insight.supportingEvidenceIds, ...insight.contradictingEvidenceIds]).not.toContain(
      "ev-doc",
    );
    // The two sides stay apart: which side an id is on IS the finding.
    expect(insight.supportingEvidenceIds).not.toContain(DELTA);
  });

  it("TEST 8: excluded evidence can never be cited", () => {
    const insight = insightFor([
      ...established,
      { ...contradictedRow, excludedEvidence: [{ evidenceId: EXCLUDED, reason: "WRONG_COMPONENT" }] },
    ]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect([...insight.supportingEvidenceIds, ...insight.contradictingEvidenceIds]).not.toContain(
      EXCLUDED,
    );
    // Structurally, not by filtering: the input type has no excluded field,
    // so a refused row has no path into this module at all.
    expect(readFileSync(SOURCE, "utf-8")).not.toContain("excluded");
  });
});

/* ------------------------------------------------------------------ */
/* 9-12. SELECTION IS CLOSED AND DETERMINISTIC                         */
/* ------------------------------------------------------------------ */

describe("insight — one, chosen the same way every time", () => {
  it("TEST 9: a contradiction beats a weaker candidate", () => {
    const insight = insightFor([
      { ...notAttributedRow, component: "AAA_EARLIER_ALPHABETICALLY" },
      contradictedRow,
    ]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(insight.relation).toBe("MEASURED_CONTRADICTION");
  });

  it("TEST 10: at most one Insight, whatever is eligible", () => {
    const insight = insightFor([
      contradictedRow,
      { ...contradictedRow, component: "OTHER_ONE" },
      { ...notAttributedRow, component: "OTHER_TWO" },
    ]);
    expect(insight.type).toBe("INSIGHT");
    // The shape itself admits exactly one: there is no array to grow.
    expect(Array.isArray(insight)).toBe(false);
  });

  it("TEST 11: identical state yields an identical Insight", () => {
    const a = insightFor([...established, contradictedRow]);
    const b = insightFor([...established, contradictedRow]);
    expect(b).toEqual(a);
  });

  it("TEST 12: input order does not change the Insight", () => {
    const rows = [...established, contradictedRow, { ...notAttributedRow, component: "ZZZ_LATER" }];
    const forward = insightFor(rows);
    const reversed = insightFor([...rows].reverse());
    expect(reversed).toEqual(forward);
  });
});

/* ------------------------------------------------------------------ */
/* 13. IT NEVER REPEATS THE ANSWER                                     */
/* ------------------------------------------------------------------ */

describe("insight — a second meaning, or silence", () => {
  it("TEST 13: a sentence the Answer already carries is dropped", () => {
    const insight = insightFor([...established, contradictedRow]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    // Fed back as something the Answer already said, the same state yields
    // nothing at all.
    expect(insightFor([...established, contradictedRow], [insight.text]).type).toBe("NONE");
  });

  it("TEST 13b: it adds to the real Answer rather than repeating it", () => {
    // The real Answer for this exact state, from the real function.
    const answer = researchAnswer({
      verdict: "PARTIALLY_SUPPORTED",
      projectName: "Example Protocol",
      components: [...established, contradictedRow],
    });
    const insight = insightFor([...established, contradictedRow], answer);
    expect(insight.type).toBe("INSIGHT");
    if (insight.type !== "INSIGHT") return;
    // The Answer leads with the measurement; the Insight says what that
    // measurement does NOT reach. Neither sentence is the other.
    expect(answer[0]).toBe(
      "Burn was confirmed, but total supply did not decrease over the measured period.",
    );
    expect(answer).not.toContain(insight.text);
    expect(insight.text).not.toBe(answer[0]);
  });
});

/* ------------------------------------------------------------------ */
/* 14-15. LANGUAGE                                                     */
/* ------------------------------------------------------------------ */

const ALL_TEXTS = [
  insightFor([...established, contradictedRow]),
  insightFor([...established, notAttributedRow]),
]
  .filter((i): i is Extract<ProofInsight, { type: "INSIGHT" }> => i.type === "INSIGHT")
  .map((i) => i.text);

describe("insight — human language", () => {
  it("TEST 14: no investment, advice or judgement language", () => {
    expect(ALL_TEXTS).toHaveLength(2);
    for (const text of ALL_TEXTS) {
      for (const forbidden of [
        "bullish",
        "bearish",
        "buy",
        "sell",
        "price",
        "risk",
        "should",
        "recommend",
        "consider",
        "invest",
        "warning",
        "scam",
        "fake",
        "lied",
        "fraud",
        "deflationary",
        "inflationary",
      ]) {
        expect(text.toLowerCase(), `${forbidden} in "${text}"`).not.toContain(forbidden);
      }
    }
  });

  it("TEST 15: no causal overclaim, and no internal vocabulary", () => {
    for (const text of ALL_TEXTS) {
      const lower = text.toLowerCase();
      for (const causal of [
        "caused by",
        "because of",
        "due to",
        "resulted in",
        "led to",
        "proves that",
        "demonstrates that",
      ]) {
        expect(lower, `${causal} in "${text}"`).not.toContain(causal);
      }
      // No reason code, component name or enum reaches a reader.
      expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      // One idea, one or two sentences, short enough to be read.
      expect(text.length).toBeLessThanOrEqual(200);
      expect(text.split(/(?<=[.!?])\s/).length).toBeLessThanOrEqual(2);
      expect(text).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("TEST 15b: the module states its own boundary", () => {
    expect(PROOF_INSIGHT_DOES_NOT_PROVE.length).toBeGreaterThanOrEqual(4);
    expect(PROOF_INSIGHT_DOES_NOT_PROVE.join(" ")).toContain("never establishes a cause");
  });
});

/* ------------------------------------------------------------------ */
/* 16-22. STRUCTURAL                                                   */
/* ------------------------------------------------------------------ */

describe("insight — structural boundaries", () => {
  const src = readFileSync(SOURCE, "utf-8");

  it("TEST 16: no project hardcoding", () => {
    for (const forbidden of ["pump", "PUMP", "Raydium", "Solana", "HLO", "projectId", "slug"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // And behaviourally: the rule names no component, so any component the
    // engine ever files these reason codes under is treated identically.
    const renamed = insightFor([
      ...established,
      { ...contradictedRow, component: "SOME_OTHER_COMPONENT" },
    ]);
    if (renamed.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(renamed.text).toBe(
      (insightFor([...established, contradictedRow]) as { text: string }).text,
    );
  });

  it("TEST 17-18: no model call, no search, fetch or RPC", () => {
    for (const forbidden of ["anthropic", "callModel", "prompt", "fetch(", "http", "rpc"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 19-20: no Research Memory and no Project Memory", () => {
    for (const forbidden of ["Memory", "memory", "retrieval", "promote"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 20b: no database, no persistence, no new table", () => {
    for (const forbidden of ["drizzle", "insert", "db.", "../server/"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // The only thing it imports is the reader layer — one interpretation of
    // canonical state, consulted rather than duplicated.
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain("./reader-meaning");
  });

  it("TEST 21: a derivation failure leaves the Result intact", () => {
    // Rows that throw when read: the getter is exactly the kind of malformed
    // internal state §13 is about.
    const hostile = [
      contradictedRow,
      new Proxy({} as Record<string, unknown>, {
        get() {
          throw new Error("malformed component row");
        },
      }),
    ];
    expect(() => insightFor(hostile)).not.toThrow();
    expect(insightFor(hostile).type).toBe("NONE");
    // Null and undefined rows are survived too, without a thrown error
    // reaching the page that renders the Proof.
    expect(insightFor([null, undefined, contradictedRow]).type).toBe("INSIGHT");
    expect(
      deriveProofInsight({ components: undefined as never, answerSentences: null }).type,
    ).toBe("NONE");
  });

  it("TEST 22: NONE carries nothing to render", () => {
    const none = insightFor(established);
    expect(none).toEqual({ type: "NONE" });
    // No text, no placeholder, nothing a UI could render as "no insight".
    expect(none).not.toHaveProperty("text");
    expect(JSON.stringify(none)).not.toContain("insight found");
  });
});

/* ------------------------------------------------------------------ */
/* THROUGH THE RESULT SCREEN                                           */
/* ------------------------------------------------------------------ */

describe("insight — how the Result renders it", () => {
  const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf-8");

  it("TEST 23: it is derived from the same canonical rows, and given the answer", () => {
    expect(page).toContain("deriveProofInsight({");
    expect(page).toContain("answerSentences: answer,");
    // S6's assembly reaches it from the same response, or null.
    expect(page).toContain("flows: detail.mechanism?.flows ?? null,");
  });

  it("TEST 24: it renders AFTER the answer, never before it", () => {
    const answerAt = page.indexOf('data-testid="answer-text"');
    const boundaryAt = page.indexOf('data-testid="answer-boundary"');
    const insightAt = page.indexOf('data-testid="proof-insight"');
    expect(answerAt).toBeGreaterThan(-1);
    expect(insightAt).toBeGreaterThan(answerAt);
    expect(insightAt).toBeGreaterThan(boundaryAt);
  });

  it("TEST 25: NONE renders no block, and there is no empty state", () => {
    expect(page).toContain('insight.type === "INSIGHT" &&');
    for (const phrase of ["No insight", "no insight", "No additional insight"]) {
      expect(page, phrase).not.toContain(phrase);
    }
  });
});

/* ------------------------------------------------------------------ */
/* THE THREE LENSES — THE RULES ADDED IN INSIGHT SEARCH v1             */
/* ------------------------------------------------------------------ */

describe("insight — stated vs observed", () => {
  it("TEST 26: approved but not executing yields an execution-gap Insight", () => {
    const insight = insightFor([approved, documented, executionMissing]);
    expect(insight.type).toBe("INSIGHT");
    if (insight.type !== "INSIGHT") return;
    expect(insight.relation).toBe("EXECUTION_GAP");
    expect(insight.lens).toBe("STATED_VS_OBSERVED");
    expect(insight.text).toBe(
      "Governance approved the mechanism, but ATLAS has not established that it is executing.",
    );
    // Governance leads where both a decision and a description exist.
    expect(insight.supportingEvidenceIds).toEqual(["ev-gov"]);
    expect(insight.components).toEqual(["GOVERNANCE_BASIS", "EXECUTION_EVIDENCE"]);
  });

  it("TEST 26b: documentation alone still yields the gap, in its own words", () => {
    const insight = insightFor([documented, executionMissing]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(insight.text).toBe(
      "The mechanism is documented, but ATLAS has not established that it is executing.",
    );
    expect(insight.supportingEvidenceIds).toEqual(["ev-doc"]);
  });

  it("TEST 26c: a component that was never assessed is not an execution gap", () => {
    // No EXECUTION_EVIDENCE row at all. "Not established" would report a gap
    // this research never looked for.
    expect(insightFor([approved, documented]).type).toBe("NONE");
  });
});

describe("insight — value destination", () => {
  it("TEST 27: execution plus a held destination plus no net reduction", () => {
    const insight = insightFor(
      [documented, executing, destinationEstablished, netEffectMissing],
      [],
      [flowWithDestination("TREASURY")],
    );
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(insight.relation).toBe("DESTINATION_HELD");
    expect(insight.lens).toBe("VALUE_DESTINATION");
    expect(insight.text).toBe(
      "Execution is confirmed, and the established destination is the treasury — permanent removal from supply is not established.",
    );
    expect(insight.supportingEvidenceIds).toEqual([BURN, "ev-dest"]);
    // Documentation is not cited: this relationship does not rest on it.
    expect(insight.supportingEvidenceIds).not.toContain("ev-doc");
  });

  it("TEST 27b: a held destination on its own establishes nothing", () => {
    // Net effect established, so there is no gap between execution and
    // removal to point at.
    expect(
      insightFor(
        [documented, executing, destinationEstablished],
        [],
        [flowWithDestination("TREASURY")],
      ).type,
    ).toBe("NONE");
    // A BURN destination is not a "held" destination.
    expect(
      insightFor(
        [documented, executing, destinationEstablished, netEffectMissing],
        [],
        [flowWithDestination("BURN")],
      ).type,
    ).toBe("NONE");
  });

  it("TEST 27c: a historical flow never drives a statement about now", () => {
    expect(
      insightFor(
        [documented, executing, destinationEstablished, netEffectMissing],
        [],
        [flowWithDestination("TREASURY", "HISTORICAL")],
      ).type,
    ).toBe("NONE");
  });

  it("TEST 27d: two current flows disagreeing yields no destination Insight", () => {
    // Nothing here picks the more interesting destination.
    expect(
      insightFor(
        [documented, executing, destinationEstablished, netEffectMissing],
        [],
        [flowWithDestination("TREASURY"), flowWithDestination("DISTRIBUTION")],
      ).type,
    ).toBe("NONE");
  });

  it("TEST 28: execution established with no established recipient", () => {
    const insight = insightFor([documented, executing, recipientMissing]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(insight.relation).toBe("HOLDER_VALUE_NOT_ESTABLISHED");
    expect(insight.text).toBe(
      "The mechanism is observed executing, but ATLAS has not established that the value it moves reaches token holders.",
    );
    expect(insight.supportingEvidenceIds).toEqual([BURN]);
  });
});

/* ------------------------------------------------------------------ */
/* MATERIALITY AND PRIORITY                                            */
/* ------------------------------------------------------------------ */

describe("insight — materiality and the closed priority", () => {
  it("TEST 29: a single-component single-sided restatement is refused", () => {
    // Everything established. There is no join to make.
    expect(insightFor([documented, approved, executing]).type).toBe("NONE");
    // One component short of established, on its own, is what the Answer
    // already says — not a relationship.
    expect(
      insightFor([
        {
          component: "DURABILITY_BASIS",
          status: "PARTIALLY_SUPPORTED",
          reasonCodes: ["INSUFFICIENT_AUTHORITY"],
          supportingEvidenceIds: ["ev-d"],
        },
      ]).type,
    ).toBe("NONE");
  });

  it("TEST 29b: two unrelated components do not make a relationship", () => {
    // Both established, nothing missing: no rule pairs them, and no rule
    // exists that pairs components merely because there are two of them.
    expect(insightFor([documented, destinationEstablished]).type).toBe("NONE");
  });

  it("TEST 29c: a candidate citing no canonical evidence is refused", () => {
    // Approved with no evidence ids at all cannot ground a sentence.
    expect(
      insightFor([
        { component: "GOVERNANCE_BASIS", status: "SUPPORTED", supportingEvidenceIds: [] },
        executionMissing,
      ]).type,
    ).toBe("NONE");
  });

  it("TEST 30: the strongest candidate wins, deterministically", () => {
    // All five rules eligible at once.
    const rows = [
      approved,
      documented,
      executing,
      destinationEstablished,
      recipientMissing,
      contradictedRow,
    ];
    const insight = insightFor(rows, [], [flowWithDestination("TREASURY")]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(insight.relation).toBe("MEASURED_CONTRADICTION");
    // And with the contradiction removed, the next rank takes over rather
    // than a lower one jumping the queue.
    const withoutContradiction = insightFor(
      [approved, documented, executionMissing, recipientMissing],
      [],
      [flowWithDestination("TREASURY")],
    );
    if (withoutContradiction.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(withoutContradiction.relation).toBe("EXECUTION_GAP");
  });

  it("TEST 30b: order invariance holds across the whole rule set", () => {
    const rows = [approved, documented, executing, recipientMissing, notAttributedRow];
    const forward = insightFor(rows, [], [flowWithDestination("TREASURY")]);
    const reversed = insightFor([...rows].reverse(), [], [flowWithDestination("TREASURY")]);
    expect(reversed).toEqual(forward);
  });

  it("TEST 31: the B2 measured-decrease exception is preserved and documented", () => {
    // One component, all evidence on the supporting side: it fails both
    // limbs of the materiality gate and is deliberately kept.
    const insight = insightFor([documented, notAttributedRow]);
    if (insight.type !== "INSIGHT") throw new Error("expected an Insight");
    expect(insight.relation).toBe("MEASURED_WITHOUT_ATTRIBUTION");
    // Still fires when the Answer already led with that component.
    const led = insightFor(
      [documented, notAttributedRow],
      ["Burn was confirmed and total supply decreased over the measured period, but the decrease is not attributed to this mechanism."],
    );
    expect(led.type).toBe("INSIGHT");
    // The exception is stated in the source, not silently applied.
    expect(readFileSync(SOURCE, "utf-8")).toContain("THE ONE DOCUMENTED EXCEPTION");
  });
});

/* ------------------------------------------------------------------ */
/* LANGUAGE, ACROSS EVERY SENTENCE THE MODULE CAN PRODUCE              */
/* ------------------------------------------------------------------ */

describe("insight — every rule's copy holds the line", () => {
  const everySentence = [
    insightFor([approved, documented, executionMissing]),
    insightFor([documented, executionMissing]),
    insightFor([documented, executing, destinationEstablished, netEffectMissing], [], [
      flowWithDestination("TREASURY"),
    ]),
    insightFor([documented, executing, destinationEstablished, netEffectMissing], [], [
      flowWithDestination("BUYBACK_HOLD"),
    ]),
    insightFor([documented, executing, recipientMissing]),
    insightFor([documented, contradictedRow]),
    insightFor([documented, notAttributedRow]),
  ]
    .filter((i): i is Extract<ProofInsight, { type: "INSIGHT" }> => i.type === "INSIGHT")
    .map((i) => i.text);

  it("TEST 32: all seven sentences exist and are distinct", () => {
    expect(everySentence).toHaveLength(7);
    // All seven differ: the two execution-gap texts name their own stated
    // basis, the two held-destination texts name their own destination, and
    // the two supply texts are keyed by different reason codes.
    expect(new Set(everySentence).size).toBe(7);
  });

  it("TEST 33: no advice, no judgement, no accusation, no causal overclaim", () => {
    for (const text of everySentence) {
      const lower = text.toLowerCase();
      for (const forbidden of [
        "bullish",
        "bearish",
        " buy",
        "sell",
        "price",
        "risk",
        "should",
        "recommend",
        "invest",
        "scam",
        "fake",
        "lied",
        "fraud",
        "good project",
        "bad project",
        "failed",
        "deflationary",
        "inflationary",
        "caused by",
        "because of",
        "due to",
        "resulted in",
        "led to",
        "proves that",
      ]) {
        expect(lower, `${forbidden} in "${text}"`).not.toContain(forbidden);
      }
      expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      expect(text.length).toBeLessThanOrEqual(200);
      expect(text).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("TEST 34: every rule reads only S6's classification, never prose", () => {
    const src = readFileSync(SOURCE, "utf-8");
    // The one flow attribute this module reads, and nothing textual.
    expect(src).toContain("destinationKind");
    // No field of an evidence row carrying prose is ever read, and no
    // lexical test of any kind is performed here.
    for (const forbidden of [
      ".fragment",
      ".summary",
      "classify",
      "toLowerCase().includes",
      "PHRASES",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
