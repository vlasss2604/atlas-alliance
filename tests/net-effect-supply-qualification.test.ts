import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  reconcileComponent,
  requiresSupplyEffectQualification,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  GROSS_SUPPLY_REDUCTION_FACT_KINDS,
  isGrossSupplyReductionFact,
  ONCHAIN_FACT_KINDS,
  type OnchainFactKind,
} from "../src/server/engine/onchain-facts";

// NET_EFFECT SUPPLY QUALIFICATION (B1) — buyback is not burn, and burn is
// not net deflation.
//
// THE FALSE POSITIVE THIS CLOSES. NET_EFFECT used to reach SUPPORTED from
// any admissible source class offering a SUPPORTS/DIRECT row, with nothing
// checking that the row was ABOUT a supply reduction. A holding balance, a
// token transfer, a single supply reading and a data provider's sentence
// each satisfied it. The engine could therefore turn "tokens were bought"
// into "supply was reduced".
//
// THE FIX IS TYPED, NEVER LEXICAL. Qualification reads
// `evidence.onchain_fact_kind`, written only by deterministic chain
// synthesis. No test below asserts on prose, and none may: the whole point
// is that the decision cannot be reached from text.
//
// FAIL CLOSED. In B1 NET_EFFECT cannot reach SUPPORTED at all — a burn
// establishes a GROSS reduction event, and net supply change across an
// interval needs an observation this engine cannot yet make. That ceiling
// is deliberate and is asserted here so it cannot be lifted by accident.

const JOB = "00000000-0000-0000-0000-0000000000aa";
const NOW = new Date("2026-09-03T00:00:00.000Z");

const FRESHNESS = { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 };

// Pattern v1's own NET_EFFECT requirements, copied as data — the point of
// the round is that these classes are NOT sufficient on their own.
function netEffectRequirements(): ComponentRequirements {
  return {
    component: "NET_EFFECT",
    establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"],
    requiresCurrentState: false,
    requiresLiveMechanismState: false,
    freshnessClass: "LOW_CHANGE",
    tokenStateSensitive: false,
    requiredTokenState: null,
  };
}

let seq = 0;
function row(over: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = `11111111-1111-1111-1111-${String(seq).padStart(12, "0")}`;
  return {
    id,
    researchJobId: JOB,
    sourceId: `source-${id}`,
    evidenceContractVersion: 2,
    patternStep: 7,
    component: "NET_EFFECT",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    // Deliberately worded like a supply claim. Nothing may read it.
    fragment: "total supply decreased after the buyback and burn",
    summary: "supply fell",
    mechanismState: null,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CONFIRMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: NOW,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...over,
  };
}

function reconcile(rows: EvidenceRow[]) {
  return reconcileComponent({
    jobId: JOB,
    item: { step: 7, component: "NET_EFFECT" },
    requirements: netEffectRequirements(),
    evidence: rows,
    now: NOW,
    freshnessPolicyDays: FRESHNESS,
  });
}

// An on-chain row of a given deterministic kind.
function onchain(kind: OnchainFactKind, over: Partial<EvidenceRow> = {}): EvidenceRow {
  return row({ sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: kind, ...over });
}

/* ---------------------------------------------------------------- *
 * WHAT CANNOT ESTABLISH A SUPPLY REDUCTION
 * ---------------------------------------------------------------- */

describe("net effect — movement, position and level are never a reduction", () => {
  it("TEST 1: a documented buyback alone does not establish supply reduction", () => {
    // OFFICIAL_REPORT is an admissible class for NET_EFFECT, and before B1
    // that alone was enough.
    const r = reconcile([
      row({ sourceClass: "OFFICIAL_REPORT", onchainFactKind: null }),
    ]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  });

  it("TEST 2: an observed purchase is not a reduction", () => {
    // A decoded exchange establishes that an exchange executed. It destroys
    // nothing.
    const r = reconcile([onchain("DECODED_EXCHANGE")]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  });

  it("TEST 3 + 4: a holding at the destination is a position, never a history", () => {
    for (const kind of ["TOKEN_ACCOUNTS_BY_OWNER", "TOKEN_ACCOUNT_BALANCE"] as const) {
      const r = reconcile([onchain(kind)]);
      expect(r.status, kind).toBe("PARTIALLY_SUPPORTED");
      expect(r.reasonCodes, kind).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    }
  });

  it("TEST 5: a transfer is a movement, never a destruction", () => {
    for (const kind of ["TOKEN_TRANSFER", "NATIVE_TRANSFER", "RECIPROCAL_ASSET_FLOW"] as const) {
      const r = reconcile([onchain(kind)]);
      expect(r.status, kind).toBe("PARTIALLY_SUPPORTED");
      expect(r.reasonCodes, kind).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    }
  });

  it("TEST 6: a single token-supply reading is a level, never a change", () => {
    // The one that looks most like an answer and is not: it is the supply
    // AT a slot, with nothing to compare it to.
    const r = reconcile([onchain("TOKEN_SUPPLY")]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  });

  it("even every non-burn kind together establishes no reduction", () => {
    const rows = ONCHAIN_FACT_KINDS.filter((k) => !isGrossSupplyReductionFact(k)).map((k) =>
      onchain(k),
    );
    const r = reconcile(rows);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    // Absence of a burn is not evidence that no burn happened — the row
    // stays supporting evidence and the component stays open, never
    // CONTRADICTED.
    expect(r.status).not.toBe("CONTRADICTED");
    expect(r.supportingEvidenceIds.length).toBe(rows.length);
  });
});

/* ---------------------------------------------------------------- *
 * WHAT A BURN DOES AND DOES NOT ESTABLISH
 * ---------------------------------------------------------------- */

describe("net effect — a burn is a gross event, not net deflation", () => {
  it("TEST 7: a deterministic burn establishes gross reduction, and stops there", () => {
    const r = reconcile([onchain("BURN")]);
    // Gross reduction IS established — the "nothing was destroyed" reason
    // is gone.
    expect(r.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    // And the net question is explicitly still open.
    expect(r.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("TEST 8: a burn alongside mechanism evidence is still not net deflation", () => {
    // Buyback documentation + the purchase + the burn: the strongest chain
    // this engine can currently observe. It is still not a net supply
    // result, because nothing observed what else happened to supply.
    const r = reconcile([
      row({ sourceClass: "OFFICIAL_REPORT", onchainFactKind: null }),
      onchain("DECODED_EXCHANGE"),
      onchain("BURN"),
    ]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  });

  it("TEST 9 + 10: a data provider or an official report cannot bypass qualification", () => {
    // Both classes are admissible for NET_EFFECT and both rows read like a
    // direct supply statement. Neither carries typed supply semantics.
    for (const sourceClass of ["DATA_PROVIDER", "OFFICIAL_REPORT"] as const) {
      const r = reconcile([row({ sourceClass, onchainFactKind: null })]);
      expect(r.status, sourceClass).toBe("PARTIALLY_SUPPORTED");
      expect(r.reasonCodes, sourceClass).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    }
  });

  it("TEST 11: a row with no typed on-chain semantics never qualifies", () => {
    // The generic statement of TESTS 9/10: null kind is read as absence,
    // for every class, however the text reads.
    const r = reconcile([
      row({ sourceClass: "DATA_PROVIDER", onchainFactKind: null, fragment: "circulating supply is down 12% after burns" }),
    ]);
    expect(r.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  });

  it("NET_EFFECT cannot reach SUPPORTED in B1, by any combination", () => {
    // The deliberate fail-closed ceiling. If this ever passes, a positive
    // path was added without the supply-delta capability that justifies it.
    const everything = ONCHAIN_FACT_KINDS.map((k) => onchain(k));
    for (const rows of [
      [onchain("BURN")],
      everything,
      [...everything, row({ sourceClass: "DATA_PROVIDER", onchainFactKind: null })],
    ]) {
      expect(reconcile(rows).status).not.toBe("SUPPORTED");
    }
  });
});

/* ---------------------------------------------------------------- *
 * THE GUARD IS TYPED, GENERIC AND NARROW
 * ---------------------------------------------------------------- */

describe("net effect — the guard reads types, not text, and only NET_EFFECT", () => {
  it("TEST 12: nothing in the qualification path is project-specific", () => {
    for (const path of [
      "src/server/engine/component-reconciler.ts",
      "src/server/engine/onchain-facts.ts",
      "src/server/engine/onchain-acquisition.ts",
    ]) {
      const src = readFileSync(path, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");
      for (const token of ["raydium", "pump", "hyperliquid", "uniswap"]) {
        expect(src.toLowerCase(), `${path}:${token}`).not.toContain(token);
      }
    }
  });

  it("the decision reads the typed kind and never the fragment", () => {
    // B2e moved the decision into its own pure evaluator; the rule it
    // enforces is unchanged and is still typed. The gross-reduction gate is
    // asked of `onchainFactKind`, and the delta's DIRECTION is read from the
    // typed relationship rather than from any text.
    const guard = readFileSync("src/server/engine/net-supply-effect.ts", "utf-8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(guard).toContain("isGrossSupplyReductionFact(r.onchainFactKind)");
    expect(guard).toContain('onchainFactKind === "TOTAL_SUPPLY_DELTA"');
    // No text is consulted: not the fragment, not the summary, not the
    // does-not-prove prose, and no lexical classifier.
    for (const forbidden of ["fragment", "summary", "doesNotProve", "classify", "toLowerCase"]) {
      expect(guard, forbidden).not.toContain(forbidden);
    }
    // And the reconciler still delegates rather than restating it.
    const reconciler = readFileSync("src/server/engine/component-reconciler.ts", "utf-8");
    expect(reconciler).toContain("evaluateNetSupplyEffect({");
  });

  it("BURN is the only gross-reduction kind", () => {
    expect([...GROSS_SUPPLY_REDUCTION_FACT_KINDS]).toEqual(["BURN"]);
    for (const kind of ONCHAIN_FACT_KINDS) {
      expect(isGrossSupplyReductionFact(kind), kind).toBe(kind === "BURN");
    }
    expect(isGrossSupplyReductionFact(null)).toBe(false);
    expect(isGrossSupplyReductionFact(undefined)).toBe(false);
    // A value outside the vocabulary is not a reduction either.
    expect(isGrossSupplyReductionFact("BURNED")).toBe(false);
  });

  it("only NET_EFFECT is gated — other components are untouched", () => {
    expect(requiresSupplyEffectQualification("NET_EFFECT")).toBe(true);
    for (const other of [
      "SOURCE_OF_VALUE",
      "FLOW_PATH",
      "MECHANISM_SPEC",
      "GOVERNANCE_BASIS",
      "EXECUTION_EVIDENCE",
      "CURRENT_STATE",
      "DESTINATION",
      "RECIPIENT",
      "DURABILITY_BASIS",
    ]) {
      expect(requiresSupplyEffectQualification(other), other).toBe(false);
    }

    // And a component that is not gated still reaches SUPPORTED exactly as
    // before, from the same kind of row that cannot carry NET_EFFECT.
    const destination = reconcileComponent({
      jobId: JOB,
      item: { step: 6, component: "DESTINATION" },
      requirements: {
        component: "DESTINATION",
        establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
        requiresCurrentState: false,
        requiresLiveMechanismState: false,
        freshnessClass: "LOW_CHANGE",
        tokenStateSensitive: true,
        requiredTokenState: null,
      },
      evidence: [
        row({
          patternStep: 6,
          component: "DESTINATION",
          onchainFactKind: "TOKEN_ACCOUNTS_BY_OWNER",
          fragment: "the account holds the tokens",
          summary: "held at the address",
        }),
      ],
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    });
    expect(destination.status).toBe("SUPPORTED");
    expect(destination.reasonCodes).toEqual([]);
  });

  it("absence of evidence stays absence, not a negative finding", () => {
    const r = reconcile([]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    // The supply codes describe a qualification that failed on evidence
    // that EXISTS. With no evidence at all they must not appear.
    expect(r.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(r.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  });

  it("both new reasons render as product copy rather than a silent gap", () => {
    const model = readFileSync("src/client/research-model.ts", "utf-8");
    for (const code of ["SUPPLY_REDUCTION_NOT_ESTABLISHED", "NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]) {
      expect(model, code).toContain(`${code}:`);
    }
    // The copy describes the RECORD, never the project: neither sentence
    // may claim supply did not fall.
    const block = model.slice(
      model.indexOf("SUPPLY_REDUCTION_NOT_ESTABLISHED:"),
      model.indexOf("};", model.indexOf("SUPPLY_REDUCTION_NOT_ESTABLISHED:")),
    );
    expect(block).not.toMatch(/supply did not|no reduction occurred|was not reduced/i);
  });
});
