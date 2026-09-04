import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  reconcileComponent,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  applicableComponentsForFactKind,
  onchainFactAppliesToComponent,
  ONCHAIN_FACT_KINDS,
  type OnchainFactKind,
} from "../src/server/engine/onchain-facts";

// TYPED FACT APPLICABILITY — ONE FACT, THE COMPONENTS IT BEARS ON.
//
// A transaction is reachable only through EXECUTION_EVIDENCE's promotion
// chain (it is the only component granted SIGNATURE_TO_TRANSACTION), so a
// BURN — the single observation that destroys tokens — was filed at
// EXECUTION_EVIDENCE and was structurally invisible to NET_EFFECT, whose
// entire question is whether supply changed. B1's gross-reduction reason
// was therefore unclearable in any live run.
//
// The fix is an APPLICABILITY MAP, not a copy: the Evidence row stays
// where it was written, once, and other components may READ it when its
// KIND is declared relevant. These tests pin both halves — that a BURN now
// reaches NET_EFFECT, and that nothing else does.

const JOB = "00000000-0000-0000-0000-0000000000bb";
const NOW = new Date("2026-09-03T00:00:00.000Z");
const FRESHNESS = { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 };

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
// A row as the LIVE path writes it: acquired for EXECUTION_EVIDENCE at
// step 4, exactly what the promotion chain produces.
function executionRow(kind: OnchainFactKind, over: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = `22222222-2222-2222-2222-${String(seq).padStart(12, "0")}`;
  return {
    id,
    researchJobId: JOB,
    sourceId: `source-${id}`,
    evidenceContractVersion: 2,
    patternStep: 4,
    component: "EXECUTION_EVIDENCE",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: `{"kind":"${kind}"}`,
    summary: `a deterministic ${kind} observation`,
    mechanismState: null,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: kind,
    fetchedAt: NOW,
    publishedAt: NOW,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...over,
  };
}

function reconcileNetEffect(rows: EvidenceRow[]) {
  return reconcileComponent({
    jobId: JOB,
    item: { step: 7, component: "NET_EFFECT" },
    requirements: netEffectRequirements(),
    evidence: rows,
    now: NOW,
    freshnessPolicyDays: FRESHNESS,
  });
}

/* ---------------------------------------------------------------- *
 * THE ROUTE THAT NOW EXISTS
 * ---------------------------------------------------------------- */

describe("applicability — a BURN acquired for execution can qualify net effect", () => {
  it("TEST 1 + 7: a BURN filed at EXECUTION_EVIDENCE is read by NET_EFFECT", () => {
    const burn = executionRow("BURN");
    const r = reconcileNetEffect([burn]);

    // It was not excluded as WRONG_COMPONENT despite step 4 vs step 7.
    expect(r.excludedEvidence.find((x) => x.evidenceId === burn.id)).toBeUndefined();
    expect(r.supportingEvidenceIds).toContain(burn.id);
    // B1's gross-reduction reason is CLEARED — the whole point of the round.
    expect(r.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  });

  it("TEST 8 + 9: it establishes a gross event and never full support", () => {
    const r = reconcileNetEffect([executionRow("BURN")]);
    expect(r.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.status).not.toBe("SUPPORTED");
  });

  it("TEST 2: the fact keeps ONE identity and one provenance chain", () => {
    // The same row id is read by both components. Nothing is copied, so
    // there is exactly one Evidence identity and one artifact behind it.
    const burn = executionRow("BURN");
    const net = reconcileNetEffect([burn]);
    const execution = reconcileComponent({
      jobId: JOB,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      requirements: {
        component: "EXECUTION_EVIDENCE",
        establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
        requiresCurrentState: false,
        requiresLiveMechanismState: false,
        freshnessClass: "MEDIUM_CHANGE",
        tokenStateSensitive: false,
        requiredTokenState: null,
      },
      evidence: [burn],
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    });
    expect(net.supportingEvidenceIds).toEqual([burn.id]);
    expect(execution.supportingEvidenceIds).toEqual([burn.id]);
    // Its persisted home is unchanged: still step 4 / EXECUTION_EVIDENCE.
    expect(burn.patternStep).toBe(4);
    expect(burn.component).toBe("EXECUTION_EVIDENCE");
  });

  it("TEST 13: reading a fact twice does not create or count a second one", () => {
    const burn = executionRow("BURN");
    const r = reconcileNetEffect([burn]);
    // One row in, one supporting id out — no duplication, no second
    // artifact reference, no inflated tally.
    expect(r.supportingEvidenceIds).toHaveLength(1);
    expect(new Set(r.supportingEvidenceIds).size).toBe(r.supportingEvidenceIds.length);
    const all = [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds, ...r.excludedEvidence.map((x) => x.evidenceId)];
    expect(new Set(all).size).toBe(all.length);
  });
});

/* ---------------------------------------------------------------- *
 * AND NOTHING ELSE CROSSES
 * ---------------------------------------------------------------- */

describe("applicability — the map is closed, tiny and typed", () => {
  it("TEST 3 + 4 + 5 + 6: no other kind can qualify supply reduction", () => {
    for (const kind of ONCHAIN_FACT_KINDS) {
      if (kind === "BURN") continue;
      const r = reconcileNetEffect([executionRow(kind)]);
      // Not applicable, so not even visible to NET_EFFECT: it is refused
      // at the component gate, which is a REASONED exclusion rather than
      // blind absence — hence ALL_EVIDENCE_EXCLUDED, not NO_EVIDENCE_FOUND.
      expect(onchainFactAppliesToComponent(kind, "NET_EFFECT"), kind).toBe(false);
      expect(r.supportingEvidenceIds, kind).toHaveLength(0);
      expect(r.excludedEvidence.map((x) => x.reason), kind).toContain("WRONG_COMPONENT");
      expect(r.status, kind).toBe("INSUFFICIENT_EVIDENCE");
      // And it never reaches the supply qualifier at all, so it can never
      // be mistaken for a reduction that merely failed to net out.
      expect(r.reasonCodes, kind).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    }
  });

  it("the named boundaries, each on its own", () => {
    // Movement is not destruction; a position is not a history; a level is
    // not a change; a purchase is not a burn.
    for (const kind of [
      "TOKEN_TRANSFER",
      "NATIVE_TRANSFER",
      "TOKEN_ACCOUNT_BALANCE",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "TOKEN_SUPPLY",
      "DECODED_EXCHANGE",
    ] as const) {
      expect(applicableComponentsForFactKind(kind), kind).toEqual([]);
    }
    expect(applicableComponentsForFactKind("BURN")).toEqual(["NET_EFFECT"]);
  });

  it("TEST 11: applicability grants no arbitrary crossover", () => {
    // A BURN is applicable to NET_EFFECT and to nothing else — not to
    // DESTINATION, RECIPIENT, FLOW_PATH or any other component.
    for (const component of [
      "SOURCE_OF_VALUE",
      "FLOW_PATH",
      "MECHANISM_SPEC",
      "GOVERNANCE_BASIS",
      "CURRENT_STATE",
      "DESTINATION",
      "RECIPIENT",
      "DURABILITY_BASIS",
    ]) {
      expect(onchainFactAppliesToComponent("BURN", component), component).toBe(false);
    }
    expect(onchainFactAppliesToComponent("BURN", "NET_EFFECT")).toBe(true);
  });

  it("TEST 12: documentary evidence can never travel this route", () => {
    // A null kind is never applicable, whatever the class or the text —
    // which is what makes the crossover structurally unreachable for any
    // model-extracted, documentary or data-provider row.
    expect(onchainFactAppliesToComponent(null, "NET_EFFECT")).toBe(false);
    expect(onchainFactAppliesToComponent(undefined, "NET_EFFECT")).toBe(false);
    expect(onchainFactAppliesToComponent("", "NET_EFFECT")).toBe(false);
    // A value outside the closed vocabulary is not applicable either.
    expect(onchainFactAppliesToComponent("BURNED", "NET_EFFECT")).toBe(false);

    const documentary = executionRow("BURN", {
      onchainFactKind: null,
      sourceClass: "OFFICIAL_REPORT",
      officiality: "CONFIRMED",
      entityBinding: null,
      fragment: "the project burned tokens and reduced supply",
    });
    const r = reconcileNetEffect([documentary]);
    expect(r.supportingEvidenceIds).toHaveLength(0);
    expect(r.excludedEvidence.find((x) => x.evidenceId === documentary.id)?.reason).toBe(
      "WRONG_COMPONENT",
    );
  });

  it("crossing grants visibility only — every other admission rule still applies", () => {
    // An unbound chain row is still refused by D-134, even though its kind
    // is applicable.
    const unbound = executionRow("BURN", { entityBinding: "UNVERIFIED" });
    const r = reconcileNetEffect([unbound]);
    expect(r.supportingEvidenceIds).toHaveLength(0);
    expect(r.excludedEvidence.find((x) => x.evidenceId === unbound.id)?.reason).toBe(
      "ENTITY_NOT_CONFIRMED",
    );

    // A CONTEXT relationship still cannot establish anything.
    const context = executionRow("BURN", { relationship: "CONTEXT" });
    const r2 = reconcileNetEffect([context]);
    expect(r2.supportingEvidenceIds).toHaveLength(0);
    expect(r2.excludedEvidence.find((x) => x.evidenceId === context.id)?.reason).toBe(
      "RELATIONSHIP_NOT_SUPPORTING",
    );
  });

  it("TEST 10: nothing in the applicability path is project-specific", () => {
    for (const path of [
      "src/server/engine/onchain-facts.ts",
      "src/server/engine/component-reconciler.ts",
      "src/server/jobs/onchain-capability.ts",
    ]) {
      const code = readFileSync(path, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");
      for (const token of ["raydium", "pump", "hyperliquid", "uniswap"]) {
        expect(code.toLowerCase(), `${path}:${token}`).not.toContain(token);
      }
    }
  });

  it("the crossover is keyed on the typed kind, never on text", () => {
    const src = readFileSync("src/server/engine/component-reconciler.ts", "utf-8");
    const block = src.slice(
      src.indexOf("const ownComponent ="),
      src.indexOf('excluded.set(row.id, "WRONG_PROJECT")'),
    );
    expect(block).toContain("onchainFactAppliesToComponent(row.onchainFactKind, item.component)");
    for (const forbidden of ["fragment", "summary", "sourceClass", "classify"]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
  });
});
