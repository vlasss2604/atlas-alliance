import { describe, expect, it } from "vitest";

import {
  bandOfScore,
  computeProofConfidence,
  CONFIDENCE_BANDS,
  CONFIDENCE_SCORES,
  type ConfidenceInput,
} from "../src/server/engine/proof-confidence";

// D-135 — the confidence contract, pinned.
//
// Confidence is a CLOSED ORDINAL BAND expressing structural confidence in
// the verdict. It is never a probability, never a percentage, and never a
// function of the verdict alone. These tests exist mostly to stop it
// drifting into any of those three.

function inp(over: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    verdict: "SUPPORTED",
    hasRequiredBlockingGap: false,
    hasClaimContextGap: false,
    componentResults: [],
    ...over,
  };
}

const ALL_REASON_CODES = [
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
] as const;

describe("the band vocabulary itself (items 1, 13, 14)", () => {
  it("1. exactly four bands with their ratified encodings", () => {
    expect(CONFIDENCE_BANDS).toEqual({ LOW: 20, LIMITED: 40, STRONG: 60, VERY_STRONG: 80 });
    expect([...CONFIDENCE_SCORES]).toEqual([20, 40, 60, 80]);
  });

  it("13/14. 0 and 100 are unreachable from every combination of inputs", () => {
    const verdicts = ["SUPPORTED", "NOT_SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const;
    for (const verdict of verdicts) {
      for (const blocking of [true, false]) {
        for (const context of [true, false]) {
          for (const code of [...ALL_REASON_CODES, undefined]) {
            const out = computeProofConfidence(
              inp({
                verdict,
                hasRequiredBlockingGap: blocking,
                hasClaimContextGap: context,
                componentResults: code ? [{ status: "PARTIALLY_SUPPORTED", reasonCodes: [code] }] : [],
              }),
            );
            expect(out.score).not.toBe(0);
            expect(out.score).not.toBe(100);
            expect(CONFIDENCE_SCORES).toContain(out.score);
            expect(bandOfScore(out.score)).toBe(out.band);
          }
        }
      }
    }
  });
});

describe("verdict ceilings (item 2)", () => {
  it("2. each of the four S7 verdicts has its ratified ceiling when nothing caps it", () => {
    for (const [verdict, score] of [
      ["SUPPORTED", 80],
      ["NOT_SUPPORTED", 80],
      ["PARTIALLY_SUPPORTED", 60],
      ["INSUFFICIENT_EVIDENCE", 60],
    ] as const) {
      const out = computeProofConfidence(inp({ verdict }));
      expect(out.score, verdict).toBe(score);
      expect(out.bindingReasons, verdict).toEqual(["VERDICT_CEILING"]);
    }
  });
});

describe("the non-monotonicity that makes the field informative (items 3-6)", () => {
  it("3. NOT_SUPPORTED can be VERY_STRONG — a positive contradiction is a strong finding", () => {
    const out = computeProofConfidence(
      inp({ verdict: "NOT_SUPPORTED", componentResults: [{ status: "CONTRADICTED", reasonCodes: [] }] }),
    );
    expect(out.band).toBe("VERY_STRONG");
    expect(out.score).toBe(80);
  });

  it("4. INSUFFICIENT_EVIDENCE can be STRONG when the exclusion was reasoned", () => {
    const out = computeProofConfidence(
      inp({
        verdict: "INSUFFICIENT_EVIDENCE",
        componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["ALL_EVIDENCE_EXCLUDED"] }],
      }),
    );
    expect(out.band).toBe("STRONG");
  });

  it("5. PARTIALLY_SUPPORTED can be LIMITED when a required atom is blocked", () => {
    const out = computeProofConfidence(inp({ verdict: "PARTIALLY_SUPPORTED", hasRequiredBlockingGap: true }));
    expect(out.band).toBe("LIMITED");
    expect(out.score).toBe(40);
  });

  it("a reasoned INSUFFICIENT_EVIDENCE OUTRANKS a blocked PARTIALLY_SUPPORTED — confidence is not monotonic in verdict positivity", () => {
    const insufficient = computeProofConfidence(
      inp({
        verdict: "INSUFFICIENT_EVIDENCE",
        componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["ALL_EVIDENCE_EXCLUDED"] }],
      }),
    );
    const partial = computeProofConfidence(inp({ verdict: "PARTIALLY_SUPPORTED", hasRequiredBlockingGap: true }));
    expect(insufficient.score).toBeGreaterThan(partial.score);
  });

  it("confidence is NOT a function of the verdict alone — same verdict, different bands", () => {
    const clean = computeProofConfidence(inp({ verdict: "SUPPORTED" }));
    const limited = computeProofConfidence(
      inp({ verdict: "SUPPORTED", componentResults: [{ status: "SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"] }] }),
    );
    const blocked = computeProofConfidence(inp({ verdict: "SUPPORTED", hasRequiredBlockingGap: true }));
    expect(new Set([clean.score, limited.score, blocked.score]).size).toBe(3);
  });
});

describe("the caps (items 6-10)", () => {
  it("6. NO_EVIDENCE_FOUND is LOW, from any verdict", () => {
    for (const verdict of ["SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const) {
      const out = computeProofConfidence(
        inp({ verdict, componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }] }),
      );
      expect(out.score, verdict).toBe(20);
      expect(out.bindingReasons).toContain("NO_EVIDENCE_FOUND");
    }
  });

  it("7. ALL_EVIDENCE_EXCLUDED alone is NOT equivalent to NO_EVIDENCE_FOUND", () => {
    const reasoned = computeProofConfidence(
      inp({
        verdict: "INSUFFICIENT_EVIDENCE",
        componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["ALL_EVIDENCE_EXCLUDED"] }],
      }),
    );
    const blind = computeProofConfidence(
      inp({
        verdict: "INSUFFICIENT_EVIDENCE",
        componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }],
      }),
    );
    expect(reasoned.score).toBe(60);
    expect(blind.score).toBe(20);
    expect(reasoned.score).toBeGreaterThan(blind.score);
  });

  it("8. a blocking gap on a REQUIRED requirement caps at 40", () => {
    const out = computeProofConfidence(inp({ verdict: "SUPPORTED", hasRequiredBlockingGap: true }));
    expect(out.score).toBe(40);
    expect(out.bindingReasons).toContain("REQUIRED_BLOCKING_GAP");
  });

  it("9. a claim context gap caps at 60 — qualifying, not undermining", () => {
    const out = computeProofConfidence(inp({ verdict: "SUPPORTED", hasClaimContextGap: true }));
    expect(out.score).toBe(60);
    expect(out.bindingReasons).toContain("CLAIM_CONTEXT_GAP");
  });

  it("10. D-074: INSUFFICIENT_AUTHORITY caps at STRONG/60 and never higher", () => {
    for (const verdict of ["SUPPORTED", "NOT_SUPPORTED"] as const) {
      const out = computeProofConfidence(
        inp({ verdict, componentResults: [{ status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"] }] }),
      );
      expect(out.score, verdict).toBe(60);
      expect(out.band, verdict).toBe("STRONG");
    }
  });

  it("a CONTRADICTED component caps at 40 — unless the verdict IS the contradiction", () => {
    const elsewhere = computeProofConfidence(
      inp({ verdict: "SUPPORTED", componentResults: [{ status: "CONTRADICTED", reasonCodes: [] }] }),
    );
    expect(elsewhere.score).toBe(40);
    const isTheFinding = computeProofConfidence(
      inp({ verdict: "NOT_SUPPORTED", componentResults: [{ status: "CONTRADICTED", reasonCodes: [] }] }),
    );
    expect(isTheFinding.score).toBe(80);
  });

  it("the minimum of all applicable caps wins, and only binding caps are reported", () => {
    const out = computeProofConfidence(
      inp({
        verdict: "SUPPORTED",
        hasClaimContextGap: true, // 60
        componentResults: [
          { status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"] }, // 60
          { status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }, // 20 — binds
        ],
      }),
    );
    expect(out.score).toBe(20);
    expect(out.bindingReasons).toEqual(["NO_EVIDENCE_FOUND"]);
    // The 60-caps did not bind, so they are not offered as the explanation.
    expect(out.bindingReasons).not.toContain("INSUFFICIENT_AUTHORITY");
  });
});

describe("exhaustiveness and fail-closed (items 11, 12)", () => {
  it("11. every ResultReasonCode is handled — none falls through as 'no limitation'", () => {
    // The compile-time Record is the real guard; this asserts the runtime
    // behaviour matches, and that the list below stays in step with the
    // union (a new code with no entry would land on the fail-closed path
    // and show up as UNKNOWN_REASON_CODE here).
    for (const code of ALL_REASON_CODES) {
      const out = computeProofConfidence(
        inp({ verdict: "SUPPORTED", componentResults: [{ status: "SUPPORTED", reasonCodes: [code] }] }),
      );
      expect(out.bindingReasons, code).not.toContain("UNKNOWN_REASON_CODE");
      // ALL_EVIDENCE_EXCLUDED is the one deliberate no-cap.
      if (code === "ALL_EVIDENCE_EXCLUDED") expect(out.score, code).toBe(80);
      else expect(out.score, code).toBeLessThan(80);
    }
  });

  it("12. an unknown reason code reaching runtime FAILS CLOSED to LOW, never STRONG", () => {
    const out = computeProofConfidence(
      inp({
        verdict: "SUPPORTED",
        componentResults: [{ status: "SUPPORTED", reasonCodes: ["A_CODE_FROM_A_FUTURE_SCHEMA"] }],
      }),
    );
    expect(out.score).toBe(20);
    expect(out.band).toBe("LOW");
    expect(out.bindingReasons).toContain("UNKNOWN_REASON_CODE");
  });

  it("prototype-chain bait is not mistaken for a known code", () => {
    for (const bait of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const out = computeProofConfidence(
        inp({ verdict: "SUPPORTED", componentResults: [{ status: "SUPPORTED", reasonCodes: [bait] }] }),
      );
      expect(out.score, bait).toBe(20);
      expect(out.bindingReasons, bait).toContain("UNKNOWN_REASON_CODE");
    }
  });
});

describe("purity", () => {
  it("same input, same result — no clock, no randomness", () => {
    const i = inp({ verdict: "PARTIALLY_SUPPORTED", hasClaimContextGap: true });
    expect(JSON.stringify(computeProofConfidence(i))).toBe(JSON.stringify(computeProofConfidence(i)));
  });
});
