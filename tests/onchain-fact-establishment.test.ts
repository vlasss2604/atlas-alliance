import { describe, expect, it } from "vitest";

import {
  componentOwnsTypedEstablishmentQualification,
  reconcileComponent,
  requiresSupplyEffectQualification,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  applicableComponentsForFactKind,
  establishableComponentsForFactKind,
  onchainFactAppliesToComponent,
  onchainFactCanEstablishComponent,
  ONCHAIN_FACT_KINDS,
  type OnchainFactKind,
} from "../src/server/engine/onchain-facts";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";

// GENERIC COMPONENT ESTABLISHMENT HARDENING V1.
//
// Establishment was decided from row PROVENANCE QUALITY alone — class,
// officiality, entity binding, relationship, directness, freshness — and
// never from TOPICAL FITNESS: whether this sort of observation can answer
// this component's question. So `ACCOUNT_INFO` ("the account exists and
// program X owns it") established DESTINATION and RECIPIENT, on evidence
// whose own doesNotProve says role and control "are economic labels, not
// chain facts".
//
// These tests pin the new axis and, just as importantly, pin everything it
// must NOT disturb: cross-component visibility, NET_EFFECT's own B1/B2
// reducer, and every null-kind documentary row.

const JOB = "00000000-0000-0000-0000-0000000000ce";
const NOW = new Date("2026-09-03T00:00:00.000Z");
const FRESHNESS = { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 };

function requirements(component: string, over: Partial<ComponentRequirements> = {}): ComponentRequirements {
  return {
    component,
    establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
    requiresCurrentState: false,
    requiresLiveMechanismState: false,
    freshnessClass: "LOW_CHANGE",
    tokenStateSensitive: false,
    requiredTokenState: null,
    ...over,
  };
}

let seq = 0;
function row(step: number, component: string, over: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = `22222222-2222-2222-2222-${String(seq).padStart(12, "0")}`;
  return {
    id,
    researchJobId: JOB,
    sourceId: `source-${id}`,
    evidenceContractVersion: 2,
    patternStep: step,
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: "the account is the treasury that receives the buyback",
    summary: "treasury receives buybacks",
    mechanismState: null,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: NOW,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...over,
  };
}

function reconcile(step: number, component: string, rows: EvidenceRow[], reqOver: Partial<ComponentRequirements> = {}) {
  return reconcileComponent({
    jobId: JOB,
    item: { step, component },
    requirements: requirements(component, reqOver),
    evidence: rows,
    now: NOW,
    freshnessPolicyDays: FRESHNESS,
  });
}

const STEP_OF: Record<string, number> = {
  SOURCE_OF_VALUE: 1,
  FLOW_PATH: 2,
  MECHANISM_SPEC: 3,
  EXECUTION_EVIDENCE: 4,
  CURRENT_STATE: 5,
  DESTINATION: 6,
  RECIPIENT: 6,
  NET_EFFECT: 7,
  DURABILITY_BASIS: 8,
};

function onchainAt(component: string, kind: OnchainFactKind, over: Partial<EvidenceRow> = {}): EvidenceRow {
  return row(STEP_OF[component], component, { onchainFactKind: kind, ...over });
}

/* ------------------------------------------------------------------ *
 * 1. THE MAP IS TOTAL AND CLOSED
 * ------------------------------------------------------------------ */

describe("establishment map — total, closed, fails closed", () => {
  it("declares every OnchainFactKind explicitly", () => {
    for (const kind of ONCHAIN_FACT_KINDS) {
      expect(establishableComponentsForFactKind(kind), kind).toBeDefined();
      expect(Array.isArray(establishableComponentsForFactKind(kind)), kind).toBe(true);
    }
  });

  it("a string outside the vocabulary establishes nothing", () => {
    expect(onchainFactCanEstablishComponent("BURNED", "NET_EFFECT")).toBe(false);
    expect(onchainFactCanEstablishComponent("", "DESTINATION")).toBe(false);
  });

  it("a null kind is unrestricted — documentary rows are not governed by this axis", () => {
    for (const component of Object.keys(STEP_OF)) {
      expect(onchainFactCanEstablishComponent(null, component), component).toBe(true);
      expect(onchainFactCanEstablishComponent(undefined, component), component).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. THE TWO MAPS ARE INDEPENDENT
 * ------------------------------------------------------------------ */

describe("visibility and establishment are separate axes", () => {
  it("visibility remains exactly one declared pair", () => {
    const visible = ONCHAIN_FACT_KINDS.filter((k) => applicableComponentsForFactKind(k).length > 0);
    expect(visible).toEqual(["BURN"]);
    expect(applicableComponentsForFactKind("BURN")).toEqual(["NET_EFFECT"]);
  });

  it("establishment is broader than visibility and does not mirror it", () => {
    // The regression this design exists to prevent: had establishment reused
    // the visibility map, every kind but BURN would establish nothing at all.
    const establishing = ONCHAIN_FACT_KINDS.filter(
      (k) => establishableComponentsForFactKind(k).length > 0,
    );
    expect(establishing.length).toBeGreaterThan(1);
    expect(establishing).toContain("TOKEN_SUPPLY");
    expect(establishing).toContain("TOKEN_ACCOUNTS_BY_OWNER");
  });

  it("the two predicates disagree exactly where they should", () => {
    // TOKEN_SUPPLY may establish CURRENT_STATE but may never be READ across.
    expect(onchainFactCanEstablishComponent("TOKEN_SUPPLY", "CURRENT_STATE")).toBe(true);
    expect(onchainFactAppliesToComponent("TOKEN_SUPPLY", "CURRENT_STATE")).toBe(false);
    // Null kind: unrestricted for establishment, never visible across.
    expect(onchainFactCanEstablishComponent(null, "NET_EFFECT")).toBe(true);
    expect(onchainFactAppliesToComponent(null, "NET_EFFECT")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. THE RAYDIUM DEFECT
 * ------------------------------------------------------------------ */

describe("ACCOUNT_INFO establishes no economic role", () => {
  for (const component of ["DESTINATION", "RECIPIENT"]) {
    it(`ACCOUNT_INFO alone at ${component} is INSUFFICIENT_EVIDENCE`, () => {
      const r = reconcile(STEP_OF[component], component, [onchainAt(component, "ACCOUNT_INFO")]);
      expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(r.supportingEvidenceIds).toHaveLength(0);
      expect(r.excludedEvidence.map((x) => x.reason)).toContain("FACT_KIND_CANNOT_ESTABLISH");
    });

    it(`${component} stays INSUFFICIENT_EVIDENCE even with officiality CONFIRMED`, () => {
      // Before this change the ONLY thing holding these components below
      // SUPPORTED was the CLAIMED authority label — one label away from
      // asserting a destination from "this account exists".
      const r = reconcile(STEP_OF[component], component, [
        onchainAt(component, "ACCOUNT_INFO", { officiality: "CONFIRMED" }),
      ]);
      expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(r.status).not.toBe("SUPPORTED");
      expect(r.supportingEvidenceIds).toHaveLength(0);
    });
  }

  it("ACCOUNT_TOKEN_RELATION is binding, not a role", () => {
    for (const component of ["DESTINATION", "RECIPIENT"]) {
      const r = reconcile(STEP_OF[component], component, [
        onchainAt(component, "ACCOUNT_TOKEN_RELATION"),
      ]);
      expect(r.status, component).toBe("INSUFFICIENT_EVIDENCE");
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. DESTINATION IS WHERE; RECIPIENT IS WHO
 * ------------------------------------------------------------------ */

describe("a holding locates value; it does not name who receives it", () => {
  for (const kind of ["TOKEN_ACCOUNTS_BY_OWNER", "TOKEN_ACCOUNT_BALANCE"] as const) {
    it(`${kind} may establish DESTINATION`, () => {
      const r = reconcile(6, "DESTINATION", [onchainAt("DESTINATION", kind)]);
      expect(r.status, kind).not.toBe("INSUFFICIENT_EVIDENCE");
      expect(r.supportingEvidenceIds, kind).toHaveLength(1);
      expect(r.excludedEvidence.map((x) => x.reason), kind).not.toContain(
        "FACT_KIND_CANNOT_ESTABLISH",
      );
    });

    it(`${kind} may NOT establish RECIPIENT`, () => {
      const r = reconcile(6, "RECIPIENT", [onchainAt("RECIPIENT", kind)]);
      expect(r.status, kind).toBe("INSUFFICIENT_EVIDENCE");
      expect(r.excludedEvidence.map((x) => x.reason), kind).toContain(
        "FACT_KIND_CANNOT_ESTABLISH",
      );
    });
  }
});

/* ------------------------------------------------------------------ *
 * 5. MOVEMENT, TRANSACTION AND EXCHANGE BOUNDARIES
 * ------------------------------------------------------------------ */

describe("movement is a path, not a receipt", () => {
  it("TOKEN_TRANSFER establishes FLOW_PATH but never RECIPIENT", () => {
    const flow = reconcile(2, "FLOW_PATH", [onchainAt("FLOW_PATH", "TOKEN_TRANSFER")]);
    expect(flow.supportingEvidenceIds).toHaveLength(1);
    expect(flow.status).not.toBe("INSUFFICIENT_EVIDENCE");

    const recipient = reconcile(6, "RECIPIENT", [onchainAt("RECIPIENT", "TOKEN_TRANSFER")]);
    expect(recipient.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("TOKEN_TRANSFER establishes SOURCE_OF_VALUE — D-158's provenance depends on it", () => {
    // The mechanical-provenance obligation binds only to rows the reducer
    // already accepted as ESTABLISHING. Refusing an attributed transfer at
    // SOURCE_OF_VALUE would leave MECHANICAL_PROVENANCE_NOT_ESTABLISHED
    // permanently unclearable, so this cell is load-bearing, not cosmetic.
    expect(onchainFactCanEstablishComponent("TOKEN_TRANSFER", "SOURCE_OF_VALUE")).toBe(true);
  });

  it("NATIVE_TRANSFER establishes FLOW_PATH only", () => {
    expect(onchainFactCanEstablishComponent("NATIVE_TRANSFER", "FLOW_PATH")).toBe(true);
    expect(onchainFactCanEstablishComponent("NATIVE_TRANSFER", "RECIPIENT")).toBe(false);
    expect(onchainFactCanEstablishComponent("NATIVE_TRANSFER", "EXECUTION_EVIDENCE")).toBe(false);
  });

  it("TRANSACTION_DETAIL alone does not establish EXECUTION_EVIDENCE", () => {
    const r = reconcile(4, "EXECUTION_EVIDENCE", [
      onchainAt("EXECUTION_EVIDENCE", "TRANSACTION_DETAIL"),
    ]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence.map((x) => x.reason)).toContain("FACT_KIND_CANNOT_ESTABLISH");
  });

  it("DECODED_EXCHANGE alone does not establish the claimed mechanism executed", () => {
    const r = reconcile(4, "EXECUTION_EVIDENCE", [
      onchainAt("EXECUTION_EVIDENCE", "DECODED_EXCHANGE"),
    ]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    // An exchange executed; that it was THIS project's buyback is a separate
    // claim requiring separate admitted evidence.
    expect(onchainFactCanEstablishComponent("DECODED_EXCHANGE", "EXECUTION_EVIDENCE")).toBe(false);
    expect(onchainFactCanEstablishComponent("DECODED_EXCHANGE", "SOURCE_OF_VALUE")).toBe(false);
  });

  it("RECIPROCAL_ASSET_FLOW and SIGNATURES_FOR_ADDRESS establish nothing", () => {
    for (const kind of ["RECIPROCAL_ASSET_FLOW", "SIGNATURES_FOR_ADDRESS"] as const) {
      expect(establishableComponentsForFactKind(kind), kind).toEqual([]);
    }
  });

  it("ACCOUNT_TOKEN_RELATION_FOREIGN establishes nothing anywhere", () => {
    expect(establishableComponentsForFactKind("ACCOUNT_TOKEN_RELATION_FOREIGN")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 6. TOKEN_SUPPLY / CURRENT_STATE PRESERVED
 * ------------------------------------------------------------------ */

describe("a supply level is current state", () => {
  it("TOKEN_SUPPLY establishes CURRENT_STATE", () => {
    expect(onchainFactCanEstablishComponent("TOKEN_SUPPLY", "CURRENT_STATE")).toBe(true);
    const r = reconcile(5, "CURRENT_STATE", [onchainAt("CURRENT_STATE", "TOKEN_SUPPLY")], {
      requiresCurrentState: false,
    });
    expect(r.excludedEvidence.map((x) => x.reason)).not.toContain("FACT_KIND_CANNOT_ESTABLISH");
    expect(r.supportingEvidenceIds).toHaveLength(1);
  });

  it("TOKEN_SUPPLY does not establish SOURCE_OF_VALUE", () => {
    expect(onchainFactCanEstablishComponent("TOKEN_SUPPLY", "SOURCE_OF_VALUE")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 7. NET_EFFECT IS EXEMPT — ITS OWN REDUCER STAYS THE AUTHORITY
 * ------------------------------------------------------------------ */

describe("NET_EFFECT owns its own typed qualification", () => {
  it("only NET_EFFECT is exempt from the generic gate", () => {
    expect(componentOwnsTypedEstablishmentQualification("NET_EFFECT")).toBe(true);
    expect(requiresSupplyEffectQualification("NET_EFFECT")).toBe(true);
    for (const other of Object.keys(STEP_OF).filter((c) => c !== "NET_EFFECT")) {
      expect(componentOwnsTypedEstablishmentQualification(other), other).toBe(false);
    }
  });

  it("every non-BURN kind stays SUPPORTING evidence at NET_EFFECT", () => {
    // B1's architecture, unchanged: a non-qualifying row remains support and
    // is capped by a reason code — it is never excluded. The generic gate
    // would have emptied this set and, with it, blinded B2.
    const rows = ONCHAIN_FACT_KINDS.map((k) => onchainAt("NET_EFFECT", k));
    const r = reconcileComponent({
      jobId: JOB,
      item: { step: 7, component: "NET_EFFECT" },
      requirements: requirements("NET_EFFECT", {
        establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"],
      }),
      evidence: rows,
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    });
    expect(r.supportingEvidenceIds).toHaveLength(rows.length);
    expect(r.excludedEvidence.map((x) => x.reason)).not.toContain("FACT_KIND_CANNOT_ESTABLISH");
  });

  it("TOTAL_SUPPLY_DELTA stays in the NET_EFFECT establishing pool", () => {
    // evaluateNetSupplyEffect reads BURN and TOTAL_SUPPLY_DELTA out of the
    // establishing set; excluding either would break B2 arithmetic.
    const r = reconcileComponent({
      jobId: JOB,
      item: { step: 7, component: "NET_EFFECT" },
      requirements: requirements("NET_EFFECT", {
        establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"],
      }),
      evidence: [onchainAt("NET_EFFECT", "BURN"), onchainAt("NET_EFFECT", "TOTAL_SUPPLY_DELTA")],
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    });
    expect(r.supportingEvidenceIds).toHaveLength(2);
    expect(r.status).not.toBe("INSUFFICIENT_EVIDENCE");
  });
});

/* ------------------------------------------------------------------ *
 * 8. DOCUMENTARY EVIDENCE IS UNTOUCHED
 * ------------------------------------------------------------------ */

describe("null-kind rows behave exactly as before", () => {
  it("a documentary SUPPORTS/DIRECT row still establishes every component", () => {
    for (const component of ["DESTINATION", "RECIPIENT", "FLOW_PATH", "EXECUTION_EVIDENCE"]) {
      const r = reconcile(STEP_OF[component], component, [
        row(STEP_OF[component], component, {
          sourceClass: "OFFICIAL_DOCS",
          officiality: "CONFIRMED",
          onchainFactKind: null,
        }),
      ]);
      expect(r.supportingEvidenceIds, component).toHaveLength(1);
      expect(r.excludedEvidence.map((x) => x.reason), component).not.toContain(
        "FACT_KIND_CANNOT_ESTABLISH",
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * 9. DURABILITY_BASIS V1
 * ------------------------------------------------------------------ */

describe("durability is a governance question", () => {
  const durability = () =>
    componentRequirementsFor(PATTERN_V1_CONTENT, "DURABILITY_BASIS").establishingClasses;

  it("only GOVERNANCE may establish DURABILITY_BASIS", () => {
    expect(durability()).toEqual(["GOVERNANCE"]);
  });

  it("OFFICIAL_DOCS-only evidence is INSUFFICIENT_EVIDENCE", () => {
    const r = reconcile(8, "DURABILITY_BASIS", [
      row(8, "DURABILITY_BASIS", {
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        summary: "12% of trading fees are used to buy back RAY",
      }),
    ], { establishingClasses: [...durability()] });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence.map((x) => x.reason)).toContain("CLASS_NOT_ADMISSIBLE");
  });

  it("GOVERNANCE evidence still establishes under the ordinary quality gates", () => {
    const r = reconcile(8, "DURABILITY_BASIS", [
      row(8, "DURABILITY_BASIS", {
        sourceClass: "GOVERNANCE",
        officiality: "CONFIRMED",
        summary: "the fee split is fixed by an executed governance vote",
      }),
    ], { establishingClasses: [...durability()] });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 10. RAYDIUM-EQUIVALENT REPLAY
 * ------------------------------------------------------------------ */

describe("Raydium-equivalent replay", () => {
  it("MECHANISM_SPEC stays SUPPORTED from official docs", () => {
    const r = reconcile(3, "MECHANISM_SPEC", [
      row(3, "MECHANISM_SPEC", {
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        summary: "CLMM 84% LP / 12% RAY buyback / 4% treasury",
      }),
    ], { establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"] });
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).toEqual([]);
  });

  it("DESTINATION and RECIPIENT no longer overclaim from account existence", () => {
    // The exact live shape: two System-Program-owned accounts, one filed at
    // each component, SUPPORTS/DIRECT/ONCHAIN_VERIFIABLE/entity CONFIRMED.
    for (const component of ["DESTINATION", "RECIPIENT"]) {
      const r = reconcile(6, component, [
        onchainAt(component, "ACCOUNT_INFO"),
        onchainAt(component, "ACCOUNT_INFO"),
      ]);
      expect(r.status, component).toBe("INSUFFICIENT_EVIDENCE");
      expect(r.status, component).not.toBe("PARTIALLY_SUPPORTED");
    }
  });
});
