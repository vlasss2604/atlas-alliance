import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  READER_MEANING_DOES_NOT_PROVE,
  READER_STATE_LABELS,
  deriveReaderMeaning,
  type ReaderState,
} from "../src/client/reader-meaning";
import {
  REASON_CODE_EXPLANATIONS,
  deriveResultLadder,
  findingMicroAnswer,
  reasonExplanation,
} from "../src/client/research-model";

// READER MEANING LAYER V1 — THE EXPLANATION IS SIMPLIFIED, THE EVIDENCE IS NOT.
//
// ATLAS's canonical state is a status, an ordered reason-code list and two
// evidence sets. A person reading a result needs four things from that:
// what was established, what was measured, what contradicts the claim, and
// what remains unproven. This layer answers those four in a closed
// vocabulary and one sentence, over state it is forbidden to change.
//
// The tests below are almost entirely about what the layer must NOT do. A
// presentation layer that quietly upgrades "measured" into "caused", or
// "the sources disagree" into "the project's claim is false", would be a
// worse failure than the raw reason codes it replaces — because the reader
// would have no way to see it happen.

const SOURCE = "src/client/reader-meaning.ts";

// The engine's closed reason vocabulary, as component-reconciler.ts owns it.
// Listed literally for the same reason ui-v2-answer-first.test.ts lists it:
// a new engine reason reaching a reader through this layer with no rule of
// its own is exactly the silent gap these guards exist to prevent.
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
  "SUPPLY_REDUCTION_NOT_ESTABLISHED",
  "NET_SUPPLY_CHANGE_NOT_ESTABLISHED",
  "NET_SUPPLY_CHANGE_NOT_ATTRIBUTED",
  "NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL",
  "CONFLICTING_SUPPLY_DELTA",
] as const;

const NET_EFFECT_SUBJECT = "a durable effect on token supply";
const CUTOFF = "2026-02-01T00:00:00.000Z";

// The four B2 cases, expressed as the component row each one canonically
// produces. Nothing here is invented: the status/reason-code pairs are the
// ones component-reconciler.ts writes, and the evidence sets are the ones it
// fills — the burn stays in the supporting set on a contradiction, which is
// the property that keeps "supply did not fall" from reading as "no burn".
const BURN_ID = "ev-burn";
const DELTA_ID = "ev-delta";

const caseA = {
  status: "PARTIALLY_SUPPORTED",
  reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"],
  supportingEvidenceIds: [BURN_ID],
  contradictingEvidenceIds: [] as string[],
  subject: NET_EFFECT_SUBJECT,
};
const caseB = {
  status: "PARTIALLY_SUPPORTED",
  reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"],
  supportingEvidenceIds: [BURN_ID, DELTA_ID],
  contradictingEvidenceIds: [] as string[],
  subject: NET_EFFECT_SUBJECT,
};
// C (unchanged) and D (increased) are the SAME canonical row: the
// reconciler files both as a contradiction, and the direction never reaches
// a component result. They are written out separately anyway, because the
// property under test is that both produce one honest sentence.
const caseC = {
  status: "CONTRADICTED",
  reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
  supportingEvidenceIds: [BURN_ID],
  contradictingEvidenceIds: [DELTA_ID],
  subject: NET_EFFECT_SUBJECT,
};
const caseD = { ...caseC };

/* ------------------------------------------------------------------ */
/* 1. ESTABLISHED                                                      */
/* ------------------------------------------------------------------ */

describe("reader meaning — what ATLAS established", () => {
  it("TEST 1: a canonical SUPPORTED component reads as established", () => {
    const m = deriveReaderMeaning({
      status: "SUPPORTED",
      reasonCodes: [],
      supportingEvidenceIds: ["ev-1", "ev-2"],
      contradictingEvidenceIds: [],
      subject: "where the value ends up",
    });
    expect(m.state).toBe("ESTABLISHED");
    expect(m.headline).toBe("The checked evidence establishes where the value ends up.");
    expect(m.supportingEvidenceIds).toEqual(["ev-1", "ev-2"]);
  });

  it("TEST 1b: a partial row with a qualifying limitation stays a finding", () => {
    // INSUFFICIENT_AUTHORITY bounds how far a finding reaches; it does not
    // point the other way. Reading it as "not established" would delete a
    // real result, which is the opposite failure to overclaiming and just
    // as wrong.
    const m = deriveReaderMeaning({
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["INSUFFICIENT_AUTHORITY"],
      supportingEvidenceIds: ["ev-1"],
      subject: "the governing decision behind the mechanism",
    });
    expect(m.state).toBe("ESTABLISHED_WITH_LIMITS");
    expect(m.headline).toContain("partly establishes");
  });

  it("TEST 1c: an unrecognised reason code never invents a stronger reading", () => {
    const m = deriveReaderMeaning({
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["SOME_FUTURE_CODE"],
      supportingEvidenceIds: ["ev-1"],
      subject: "where the value ends up",
    });
    // Partial, and said as partial — never ESTABLISHED, and never a headline
    // built out of the unknown code.
    expect(m.state).toBe("ESTABLISHED_WITH_LIMITS");
    expect(m.headline).not.toContain("SOME_FUTURE_CODE");
  });
});

/* ------------------------------------------------------------------ */
/* 2-6. THE FOUR B2 SUPPLY CASES                                       */
/* ------------------------------------------------------------------ */

describe("reader meaning — the B2 supply matrix", () => {
  it("TEST 2: CASE A — a burn with no measured interval leaves net change unestablished", () => {
    const m = deriveReaderMeaning(caseA);
    expect(m.state).toBe("NOT_ESTABLISHED");
    // The positive knowledge leads, the open question follows — never a bare
    // limitation, and never a claim that supply did not fall.
    expect(m.headline).toBe(
      "Burn was confirmed, but the net change in total supply was not established.",
    );
    expect(m.headline).not.toContain("did not decrease");
    expect(m.headline).not.toContain("increase");
  });

  it("TEST 3: CASE B — a measured decrease reads as measured, not attributed", () => {
    const m = deriveReaderMeaning(caseB);
    expect(m.state).toBe("MEASURED_NOT_ATTRIBUTED");
    expect(m.headline).toBe(
      "Burn was confirmed and total supply decreased over the measured period, but the decrease is not attributed to this mechanism.",
    );
  });

  it("TEST 3b: CASE B never becomes an attributed reduction", () => {
    const m = deriveReaderMeaning(caseB);
    expect(m.state).not.toBe("ESTABLISHED");
    expect(m.state).not.toBe("ESTABLISHED_WITH_LIMITS");
    // The attribution vocabulary the state exists to withhold.
    for (const forbidden of [
      "caused",
      "because of",
      "due to",
      "resulted in",
      "led to",
      "thanks to",
      "deflationary",
    ]) {
      expect(m.headline.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 4: CASE C — supply unchanged over the interval is contradicted by measurement", () => {
    const m = deriveReaderMeaning(caseC);
    expect(m.state).toBe("CONTRADICTED_BY_MEASUREMENT");
    expect(m.headline).toBe(
      "Burn was confirmed, but total supply did not decrease over the measured period.",
    );
  });

  it("TEST 5: CASE D — supply increased reads through the same honest sentence", () => {
    const m = deriveReaderMeaning(caseD);
    expect(m.state).toBe("CONTRADICTED_BY_MEASUREMENT");
    // The canonical component row carries "did NOT decrease" and does not
    // carry the direction. Saying "increased" would be inventing the half of
    // the measurement that never reached this layer.
    expect(m.headline).toContain("did not decrease");
    expect(m.headline.toLowerCase()).not.toContain("increased");
  });

  it("TEST 6: an absent measurement is never a contradiction", () => {
    // The distinction the whole layer turns on: A and C differ by what was
    // OBSERVED, and only one of them may read as evidence pointing the other
    // way. Absence of evidence stays absence of evidence.
    expect(deriveReaderMeaning(caseA).state).toBe("NOT_ESTABLISHED");
    expect(deriveReaderMeaning(caseC).state).toBe("CONTRADICTED_BY_MEASUREMENT");

    const noBurn = deriveReaderMeaning({
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["SUPPLY_REDUCTION_NOT_ESTABLISHED"],
      supportingEvidenceIds: ["ev-1"],
      subject: NET_EFFECT_SUBJECT,
    });
    expect(noBurn.state).toBe("NOT_ESTABLISHED");
    expect(noBurn.headline).toBe("Nothing checked here shows tokens being destroyed.");

    const conflicting = deriveReaderMeaning({
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["CONFLICTING_SUPPLY_DELTA"],
      supportingEvidenceIds: [BURN_ID],
      subject: NET_EFFECT_SUBJECT,
    });
    // Two intervals disagreeing settles nothing, so it establishes nothing —
    // and it is not a contradiction of the claim either.
    expect(conflicting.state).toBe("NOT_ESTABLISHED");
  });

  it("TEST 7: a contradiction never says the burn was fake, and never drops it", () => {
    const m = deriveReaderMeaning(caseC);
    const text = `${m.headline} ${m.detail ?? ""}`.toLowerCase();
    for (const forbidden of [
      "fake",
      "lied",
      "lie",
      "scam",
      "fraud",
      "dishonest",
      "misleading",
      "never happened",
      "did not happen",
      "false claim",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // The burn stays visible as established evidence on the contradicted
    // row. What is contradicted is the net reduction, and only that.
    expect(m.supportingEvidenceIds).toEqual([BURN_ID]);
    expect(m.contradictingEvidenceIds).toEqual([DELTA_ID]);
    expect(m.headline).toContain("Burn was confirmed");
  });

  it("TEST 7b: a conflict BETWEEN SOURCES is not a contradiction BY MEASUREMENT", () => {
    // CONFLICTING_STATE is canonically CONTRADICTED too. It means the
    // sources disagree with each other, which measures nothing — so it must
    // not borrow the sentence that a measurement earns.
    const m = deriveReaderMeaning({
      status: "CONTRADICTED",
      reasonCodes: ["CONFLICTING_STATE"],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: ["ev-a", "ev-b"],
      subject: "whether the mechanism is currently active",
    });
    expect(m.state).toBe("NOT_ESTABLISHED");
    expect(m.headline).toBe(
      "The sources disagree about whether the mechanism is currently active.",
    );
    expect(m.contradictingEvidenceIds).toEqual(["ev-a", "ev-b"]);
  });
});

/* ------------------------------------------------------------------ */
/* 8-12. CANONICAL STATE IS READ, NEVER TOUCHED                        */
/* ------------------------------------------------------------------ */

describe("reader meaning — canonical state survives untouched", () => {
  it("TEST 8: no reader state changes the canonical verdict", () => {
    // The projection returns no status field at all, so there is nothing for
    // a consumer to mistake for one — and the row it read still carries its
    // own status afterwards.
    for (const row of [caseA, caseB, caseC]) {
      const before = row.status;
      const m = deriveReaderMeaning(row);
      expect(row.status).toBe(before);
      expect(m).not.toHaveProperty("status");
      expect(m).not.toHaveProperty("verdict");
      expect(m).not.toHaveProperty("confidence");
    }
  });

  it("TEST 9: reason codes are read in order and never mutated", () => {
    const codes = ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED", "INSUFFICIENT_AUTHORITY"];
    const snapshot = [...codes];
    const m = deriveReaderMeaning({ ...caseB, reasonCodes: codes });
    expect(codes).toEqual(snapshot);
    // S5 writes the component-specific code first, and first-recognised
    // wins — the same rule reasonExplanation already applies.
    expect(m.state).toBe("MEASURED_NOT_ATTRIBUTED");
  });

  it("TEST 10: evidence is neither invented nor moved between sides", () => {
    const supporting = [BURN_ID];
    const contradicting = [DELTA_ID];
    const m = deriveReaderMeaning({
      ...caseC,
      supportingEvidenceIds: supporting,
      contradictingEvidenceIds: contradicting,
    });
    expect(m.supportingEvidenceIds).toEqual(supporting);
    expect(m.contradictingEvidenceIds).toEqual(contradicting);
    // A copy, so a consumer cannot write back through it into canonical
    // state; and never a union, which would destroy which side an id is on.
    expect(m.supportingEvidenceIds).not.toBe(supporting);
    expect(m.contradictingEvidenceIds).not.toBe(contradicting);
    expect([...m.supportingEvidenceIds, ...m.contradictingEvidenceIds]).toHaveLength(2);
  });

  it("TEST 11-12: both evidence sets stay exactly as the component row holds them", () => {
    const m = deriveReaderMeaning({
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["INDIRECT_ONLY"],
      supportingEvidenceIds: ["s1", "s2", "s3"],
      contradictingEvidenceIds: ["c1"],
      subject: "the path the value takes through the protocol",
    });
    expect(m.supportingEvidenceIds).toEqual(["s1", "s2", "s3"]);
    expect(m.contradictingEvidenceIds).toEqual(["c1"]);
  });

  it("TEST 12b: a row with no result reads as not established, never as a negative", () => {
    const m = deriveReaderMeaning({ status: null, subject: "where the value ends up" });
    expect(m.state).toBe("NOT_ESTABLISHED");
    expect(m.headline).toBe("Where the value ends up was not established.");
    expect(m.supportingEvidenceIds).toEqual([]);
    expect(m.contradictingEvidenceIds).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 13-15. LANGUAGE                                                     */
/* ------------------------------------------------------------------ */

// Every headline this layer can produce, for the whole engine vocabulary,
// with and without a subject. Language guards run over the WHOLE set rather
// than over a chosen example, so a new template cannot slip past them.
const ALL_HEADLINES: { code: string; headline: string }[] = [];
for (const code of ENGINE_REASON_CODES) {
  for (const status of [
    "SUPPORTED",
    "PARTIALLY_SUPPORTED",
    "CONTRADICTED",
    "INSUFFICIENT_EVIDENCE",
    null,
  ]) {
    for (const subject of [NET_EFFECT_SUBJECT, null]) {
      ALL_HEADLINES.push({
        code,
        headline: deriveReaderMeaning({ status, reasonCodes: [code], subject }).headline,
      });
    }
  }
}

describe("reader meaning — human language", () => {
  it("TEST 13: no internal identifier reaches a reader headline", () => {
    for (const { code, headline } of ALL_HEADLINES) {
      expect(headline, code).not.toContain("_");
      expect(headline.toUpperCase(), code).not.toContain(code);
      // No component name, no status name, no state name.
      for (const internal of [
        "NET_EFFECT",
        "PARTIALLY_SUPPORTED",
        "INSUFFICIENT_EVIDENCE",
        "TOTAL_SUPPLY_DELTA",
        "ONCHAIN_VERIFIABLE",
      ]) {
        expect(headline, internal).not.toContain(internal);
      }
    }
    for (const label of Object.values(READER_STATE_LABELS)) {
      expect(label).not.toContain("_");
    }
  });

  it("TEST 13b: a supplied detail carrying engine vocabulary is dropped, not printed", () => {
    const m = deriveReaderMeaning({
      ...caseB,
      detail: "The component was PARTIALLY_SUPPORTED for this step.",
    });
    expect(m.detail).toBeNull();
    // A clean sentence passes through unchanged — the guard drops leaks, it
    // does not suppress copy.
    const clean = deriveReaderMeaning({
      ...caseB,
      detail: REASON_CODE_EXPLANATIONS.NET_SUPPLY_CHANGE_NOT_ATTRIBUTED,
    });
    expect(clean.detail).toBe(REASON_CODE_EXPLANATIONS.NET_SUPPLY_CHANGE_NOT_ATTRIBUTED);
  });

  it("TEST 14: no investment, price or judgement language anywhere", () => {
    const corpus = [
      ...ALL_HEADLINES.map((h) => h.headline),
      ...Object.values(READER_STATE_LABELS),
    ];
    for (const text of corpus) {
      for (const forbidden of [
        "bullish",
        "bearish",
        "buy",
        "sell",
        "price",
        "valuation",
        "market cap",
        "return",
        "yield",
        "invest",
        "good project",
        "bad project",
        "strong project",
        "risky",
        "deflationary",
        "inflationary",
      ]) {
        expect(text.toLowerCase(), `${forbidden} in "${text}"`).not.toContain(forbidden);
      }
    }
  });

  it("TEST 15: no headline asserts a cause this research did not establish", () => {
    for (const { headline } of ALL_HEADLINES) {
      const lower = headline.toLowerCase();
      for (const causal of [
        "caused",
        "causes",
        "because of",
        "due to",
        "resulted in",
        "results in",
        "led to",
        "leads to",
        "thanks to",
        "proves",
        "proving",
      ]) {
        expect(lower, `${causal} in "${headline}"`).not.toContain(causal);
      }
    }
    // The one place attribution is named, it is named as ABSENT.
    const b = deriveReaderMeaning(caseB);
    expect(b.headline).toContain("not attributed");
  });

  it("TEST 15b: every headline is one plain sentence", () => {
    for (const { code, headline } of ALL_HEADLINES) {
      expect(headline, code).toMatch(/^[A-Z].*\.$/);
      expect(headline.length, code).toBeLessThanOrEqual(140);
      // One idea: no headline stacks a second sentence behind the first.
      expect(headline.replace(/\.$/, ""), code).not.toContain(". ");
    }
  });

  it("TEST 15c: the layer states its own boundary", () => {
    expect(READER_MEANING_DOES_NOT_PROVE.length).toBeGreaterThanOrEqual(4);
    expect(READER_MEANING_DOES_NOT_PROVE.join(" ")).toContain("never replaces the canonical status");
  });
});

/* ------------------------------------------------------------------ */
/* 16-17. AS-OF AND DETERMINISM                                        */
/* ------------------------------------------------------------------ */

describe("reader meaning — as of, and determinism", () => {
  it("TEST 16: the research cutoff is passed through and never invented", () => {
    expect(deriveReaderMeaning({ ...caseB, asOf: CUTOFF }).asOf).toBe(CUTOFF);
    // No cutoff means no cutoff. A clock substituted here would date a
    // reading to the moment it was rendered rather than to the research.
    expect(deriveReaderMeaning(caseB).asOf).toBeNull();
    const src = readFileSync(SOURCE, "utf-8");
    expect(src).not.toContain("Date.now");
    expect(src).not.toContain("new Date");
    expect(src).not.toContain("toISOString");
  });

  it("TEST 17: identical input yields identical output, every time", () => {
    const once = deriveReaderMeaning({ ...caseC, asOf: CUTOFF });
    const twice = deriveReaderMeaning({ ...caseC, asOf: CUTOFF });
    expect(twice).toEqual(once);

    // Evidence-id ORDER is canonical and is carried, not sorted: the order
    // S5 wrote is the order a reader is shown, and re-reading the same row
    // can never reshuffle it.
    const a = deriveReaderMeaning({ ...caseB, supportingEvidenceIds: ["z", "a", "m"] });
    const b = deriveReaderMeaning({ ...caseB, supportingEvidenceIds: ["z", "a", "m"] });
    expect(a.supportingEvidenceIds).toEqual(["z", "a", "m"]);
    expect(b).toEqual(a);
  });

  it("TEST 17b: every engine reason code resolves to a state and a sentence", () => {
    for (const code of ENGINE_REASON_CODES) {
      const m = deriveReaderMeaning({
        status: "PARTIALLY_SUPPORTED",
        reasonCodes: [code],
        subject: NET_EFFECT_SUBJECT,
      });
      expect(m.headline.length, code).toBeGreaterThan(0);
      expect(READER_STATE_LABELS[m.state], code).toBeTruthy();
    }
    const states: ReaderState[] = [
      "ESTABLISHED",
      "ESTABLISHED_WITH_LIMITS",
      "MEASURED_NOT_ATTRIBUTED",
      "CONTRADICTED_BY_MEASUREMENT",
      "NOT_ESTABLISHED",
    ];
    expect(Object.keys(READER_STATE_LABELS).sort()).toEqual([...states].sort());
  });
});

/* ------------------------------------------------------------------ */
/* 18-22. WHAT THIS LAYER IS STRUCTURALLY INCAPABLE OF                 */
/* ------------------------------------------------------------------ */

describe("reader meaning — structural boundaries", () => {
  const src = readFileSync(SOURCE, "utf-8");

  it("TEST 18: no model call", () => {
    for (const forbidden of ["anthropic", "Anthropic", "callModel", "prompt", "claude"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 19: no search, fetch or RPC", () => {
    for (const forbidden of ["fetch(", "http", "Retriever", "rpc", "axios"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 20-21: no Research Memory and no Project Memory", () => {
    for (const forbidden of ["Memory", "memory", "retrieval", "promote"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 22: no project-specific anything", () => {
    for (const forbidden of [
      "pump",
      "PUMP",
      "raydium",
      "Raydium",
      "solana",
      "Solana",
      "projectId",
      "projectSlug",
      "ticker",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("TEST 22b: no database, and no import outside this module's own concern", () => {
    expect(src).not.toContain("drizzle");
    expect(src).not.toContain("../server/");
    // The module imports NOTHING. Its whole input is its argument, which is
    // what makes it testable with plain objects and impossible to couple to
    // an engine stage.
    expect(src).not.toMatch(/^import /m);
  });
});

/* ------------------------------------------------------------------ */
/* THROUGH THE RESULT CONTRACT                                         */
/* ------------------------------------------------------------------ */

describe("reader meaning — carried by the result contract", () => {
  const ladderOf = (row: Record<string, unknown>, asOf: string | null = null) =>
    deriveResultLadder(
      [{ component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED", ...row } as never],
      undefined,
      asOf,
    ).value.find((r) => r.component === "NET_EFFECT")!;

  it("TEST 23: every result row carries its reader meaning, with the Proof's cutoff", () => {
    const row = ladderOf(
      {
        reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"],
        supportingEvidenceIds: [BURN_ID, DELTA_ID],
        contradictingEvidenceIds: [],
      },
      CUTOFF,
    );
    expect(row.readerMeaning.state).toBe("MEASURED_NOT_ATTRIBUTED");
    expect(row.readerMeaning.asOf).toBe(CUTOFF);
    // The canonical badge is untouched — the reader meaning sits above it.
    expect(row.rawStatus).toBe("PARTIALLY_SUPPORTED");
    expect(row.state).toBe("PARTIAL");
    expect(row.stateLabel).toBe("Partly established");
    // `detail` is the reason-code sentence the row already renders, not a
    // second copy of it.
    expect(row.readerMeaning.detail).toBe(
      reasonExplanation(["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"]),
    );
  });

  it("TEST 24: a measured reading leads the collapsed row instead of an evidence summary", () => {
    const row = ladderOf({
      reasonCodes: ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"],
      supportingEvidenceIds: [BURN_ID, DELTA_ID],
    });
    // Without this the row would show whichever admitted summary came first
    // — burying the one thing the measurement added.
    expect(findingMicroAnswer(row, ["The protocol burned 10,000,000 tokens."])).toBe(
      row.readerMeaning.headline,
    );
  });

  it("TEST 25: a measured contradiction is not buried under generic limitation copy", () => {
    const row = deriveResultLadder([
      {
        component: "NET_EFFECT",
        status: "CONTRADICTED",
        reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"],
        supportingEvidenceIds: [BURN_ID],
        contradictingEvidenceIds: [DELTA_ID],
      } as never,
    ]).value.find((r) => r.component === "NET_EFFECT")!;
    expect(row.readerMeaning.state).toBe("CONTRADICTED_BY_MEASUREMENT");
    const micro = findingMicroAnswer(row, []);
    expect(micro).toBe(
      "Burn was confirmed, but total supply did not decrease over the measured period.",
    );
    // The sentence it replaces said only that "the sources point the other
    // way", which reads as doubt about the burn itself.
    expect(micro).not.toContain("point the other way");
    expect(row.rawStatus).toBe("CONTRADICTED");
  });

  it("TEST 26: every other row keeps exactly the copy it had", () => {
    const row = ladderOf({
      reasonCodes: ["INSUFFICIENT_AUTHORITY"],
      supportingEvidenceIds: ["ev-1"],
    });
    expect(row.readerMeaning.state).toBe("ESTABLISHED_WITH_LIMITS");
    // The micro-answer still prefers the engine's own admitted statement.
    expect(findingMicroAnswer(row, ["Fees are routed to the treasury."])).toBe(
      "Fees are routed to the treasury.",
    );
  });
});
