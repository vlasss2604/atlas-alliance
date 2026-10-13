import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import {
  reconcileComponent,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { PUBLISHED_AT_RULE_VERSION } from "../src/server/engine/providers/types";

// D-160 — the narrow global supersession reliability fix (§8.1 as amended).
// A newer date alone never erases an older fact. A newer row B erases an
// older row A only when A was admitted, the two state DIFFERENT known states,
// both dates are trusted, a CONFIRMED official A is not erased by a
// non-CONFIRMED B, and a memory-adopted B does not erase a fresh A.
//
// Every case runs the real pure reconciler for one component.

const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const older = (days: number) => new Date(NOW.getTime() - days * DAY);
const FRESHNESS = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };
const JOB = "job-supersession";
const STEP: Record<string, number> = {
  SOURCE_OF_VALUE: 1,
  MECHANISM_SPEC: 3,
  GOVERNANCE_BASIS: 3,
  DESTINATION: 6,
  RECIPIENT: 6,
};

let seq = 0;
function row(component: string, o: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = `s${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
  return {
    id,
    researchJobId: JOB,
    sourceId: `src-${id}`,
    evidenceContractVersion: 2,
    patternStep: STEP[component],
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: `${component.toLowerCase()} fragment ${seq}`,
    summary: null,
    mechanismState: "LIVE",
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    entityBinding: null,
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: older(1),
    publishedAtRuleVersion: PUBLISHED_AT_RULE_VERSION,
    reusedFromMemoryId: null,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...o,
  };
}

function reconcile(component: string, rows: EvidenceRow[]): ComponentReconciliationResult {
  return reconcileComponent({
    jobId: JOB,
    item: { step: STEP[component], component },
    requirements: { component, ...componentRequirementsFor(PATTERN_V1_CONTENT, component) },
    evidence: rows,
    now: NOW,
    freshnessPolicyDays: FRESHNESS,
  });
}

const reasonOf = (r: ComponentReconciliationResult, id: string) =>
  r.excludedEvidence.find((x) => x.evidenceId === id)?.reason ?? null;
const supersededIn = (r: ComponentReconciliationResult) =>
  r.excludedEvidence.filter((x) => x.reason === "SUPERSEDED_BY_NEWER").map((x) => x.evidenceId);
const LEGACY = { publishedAtRuleVersion: null } as const;

describe("D-160 A — same-state rows never supersede each other", () => {
  it.each([
    ["SOURCE_OF_VALUE", "LIVE", "OFFICIAL_DOCS"],
    ["GOVERNANCE_BASIS", "APPROVED", "GOVERNANCE"],
    ["DESTINATION", "DEPRECATED", "OFFICIAL_DOCS"],
  ] as const)("%s: %s beside a newer row of the same state keeps both", (component, state, sourceClass) => {
    const a = row(component, { mechanismState: state, sourceClass, publishedAt: older(200) });
    const b = row(component, { mechanismState: state, sourceClass, publishedAt: older(1) });
    const r = reconcile(component, [a, b]);
    expect(supersededIn(r)).toEqual([]);
    expect(reasonOf(r, a.id)).toBeNull();
  });

  it("LIVE → LIVE with trusted dates: both rows support", () => {
    const a = row("DESTINATION", { fragment: "bought tokens go to the treasury", publishedAt: older(300) });
    const b = row("DESTINATION", { fragment: "bought tokens are burned", publishedAt: older(1) });
    const r = reconcile("DESTINATION", [a, b]);
    expect([...r.supportingEvidenceIds].sort()).toEqual([a.id, b.id].sort());
    expect(supersededIn(r)).toEqual([]);
  });

  it("a true duplicate (same source, same fragment) is still collapsed by dedup", () => {
    const a = row("SOURCE_OF_VALUE", { sourceId: "same", extractionUnitKey: null, fragment: "fees fund buybacks", publishedAt: older(10) });
    const b = row("SOURCE_OF_VALUE", { sourceId: "same", extractionUnitKey: null, fragment: "fees fund buybacks", publishedAt: older(1) });
    const r = reconcile("SOURCE_OF_VALUE", [a, b]);
    expect(r.excludedEvidence.map((x) => x.reason)).toEqual(["DUPLICATE_UNIT"]);
    expect(r.supportingEvidenceIds).toHaveLength(1);
  });

  it("the real Lido #4 / #19 shape: distinct same-state official facts no longer disappear by date", () => {
    // Two lido.fi official rows, both LIVE, legacy dates two days apart.
    const socialized = row("RECIPIENT", {
      fragment: "Rewards and penalties are socialized amongst all stETH holders",
      publishedAt: new Date("2026-09-13T08:00:00Z"),
      ...LEGACY,
    });
    const mev = row("RECIPIENT", {
      fragment: "MEV refers to additional rewards",
      publishedAt: new Date("2026-09-15T08:00:00Z"),
      ...LEGACY,
    });
    const r = reconcile("RECIPIENT", [socialized, mev]);
    expect([...r.supportingEvidenceIds].sort()).toEqual([socialized.id, mev.id].sort());
    // Same shape with trusted dates: still two facts, not an update.
    const trustedA = row("SOURCE_OF_VALUE", { fragment: "MEV rewards are sent to the Execution Rewards Vault", publishedAt: older(13) });
    const trustedB = row("SOURCE_OF_VALUE", { fragment: "MEV refers to additional rewards", publishedAt: older(12) });
    const r2 = reconcile("SOURCE_OF_VALUE", [trustedA, trustedB]);
    expect([...r2.supportingEvidenceIds].sort()).toEqual([trustedA.id, trustedB.id].sort());
  });
});

describe("D-160 B/C — different-state supersession requires trusted dates on both rows", () => {
  it("B: PROPOSED → trusted newer LIVE supersedes", () => {
    const a = row("SOURCE_OF_VALUE", { mechanismState: "PROPOSED", publishedAt: older(200) });
    const b = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(1) });
    const r = reconcile("SOURCE_OF_VALUE", [a, b]);
    expect(reasonOf(r, a.id)).toBe("SUPERSEDED_BY_NEWER");
    expect(r.supportingEvidenceIds).toEqual([b.id]);
    expect(r.status).not.toBe("CONTRADICTED");
  });

  it.each([
    ["newer LIVE is legacy-dated", {}, LEGACY],
    ["older PROPOSED is legacy-dated", LEGACY, {}],
    ["both legacy-dated", LEGACY, LEGACY],
  ])("C: %s → no supersession; the conflict stays visible", (_label, oa, ob) => {
    const a = row("SOURCE_OF_VALUE", { mechanismState: "PROPOSED", publishedAt: older(200), ...oa });
    const b = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(1), ...ob });
    const r = reconcile("SOURCE_OF_VALUE", [a, b]);
    expect(supersededIn(r)).toEqual([]);
    expect(r.status).toBe("CONTRADICTED");
    expect(r.reasonCodes).toContain("CONFLICTING_STATE");
  });

  it("C: an undated newer row never supersedes", () => {
    const a = row("SOURCE_OF_VALUE", { mechanismState: "PROPOSED", publishedAt: older(200) });
    const b = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: null });
    expect(supersededIn(reconcile("SOURCE_OF_VALUE", [a, b]))).toEqual([]);
  });

  it("J: same trusted date, different states → conflict, no winner", () => {
    const a = row("SOURCE_OF_VALUE", { mechanismState: "PROPOSED", publishedAt: older(5) });
    const b = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(5) });
    const r = reconcile("SOURCE_OF_VALUE", [a, b]);
    expect(supersededIn(r)).toEqual([]);
    expect(r.status).toBe("CONTRADICTED");
    expect(r.reasonCodes).toContain("CONFLICTING_STATE");
  });
});

describe("D-160 D/K — an older contradiction is removed only by a trusted state change", () => {
  const stop = (o: Partial<EvidenceRow> = {}) =>
    row("DESTINATION", {
      relationship: "CONTRADICTS",
      mechanismState: "DEPRECATED",
      fragment: "the buyback-and-burn was discontinued",
      publishedAt: older(200),
      ...o,
    });
  const burn = (o: Partial<EvidenceRow> = {}) =>
    row("DESTINATION", { fragment: "bought tokens are burned", publishedAt: older(1), ...o });

  it("D: older DEPRECATED contradiction + trusted newer LIVE → lawful transition (D-094), SUPPORTED", () => {
    const a = stop();
    const b = burn();
    const r = reconcile("DESTINATION", [a, b]);
    expect(reasonOf(r, a.id)).toBe("SUPERSEDED_BY_NEWER");
    expect(r.contradictingEvidenceIds).toEqual([]);
    expect(r.status).toBe("SUPPORTED");
  });

  it("K: the same pair with a legacy newer date is NOT strengthened — it stays CONTRADICTED", () => {
    const a = stop();
    const b = burn(LEGACY);
    const r = reconcile("DESTINATION", [a, b]);
    expect(supersededIn(r)).toEqual([]);
    expect(r.status).toBe("CONTRADICTED");
    expect([...r.contradictingEvidenceIds].sort()).toEqual([a.id, b.id].sort());
  });

  it("K: a CLAIMED newer row cannot lift a CONFIRMED contradiction to SUPPORTED", () => {
    const a = stop();
    const b = burn({ officiality: "CLAIMED" });
    const r = reconcile("DESTINATION", [a, b]);
    expect(supersededIn(r)).toEqual([]);
    expect(r.status).toBe("CONTRADICTED");
  });
});

describe("D-160 E/F — authority guardrail (no source-class ranking)", () => {
  it("E: a newer CLAIMED row cannot remove an older CONFIRMED official row", () => {
    const a = row("MECHANISM_SPEC", { mechanismState: "PAUSED", publishedAt: older(100) });
    const b = row("MECHANISM_SPEC", { mechanismState: "LIVE", officiality: "CLAIMED", publishedAt: older(1) });
    const r = reconcile("MECHANISM_SPEC", [a, b]);
    expect(reasonOf(r, a.id)).toBeNull();
    expect(r.status).toBe("CONTRADICTED");
  });

  it("E: a newer row of unknown officiality cannot remove a CONFIRMED one either", () => {
    const a = row("MECHANISM_SPEC", { mechanismState: "PROPOSED", publishedAt: older(100) });
    const b = row("MECHANISM_SPEC", { mechanismState: "LIVE", officiality: null, publishedAt: older(1) });
    expect(supersededIn(reconcile("MECHANISM_SPEC", [a, b]))).toEqual([]);
  });

  it("F: a newer CONFIRMED row supersedes an older CLAIMED one when every other condition passes", () => {
    const a = row("MECHANISM_SPEC", { mechanismState: "PROPOSED", officiality: "CLAIMED", publishedAt: older(100) });
    const b = row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: older(1) });
    const r = reconcile("MECHANISM_SPEC", [a, b]);
    expect(reasonOf(r, a.id)).toBe("SUPERSEDED_BY_NEWER");
    expect(r.supportingEvidenceIds).toEqual([b.id]);
  });

  it.each([
    ["same state", { mechanismState: "PROPOSED" }],
    ["legacy date", { ...LEGACY }],
    ["not DIRECT", { directness: "INDIRECT" as const }],
  ])("F: …and does not when %s", (_label, ob) => {
    const a = row("MECHANISM_SPEC", { mechanismState: "PROPOSED", officiality: "CLAIMED", publishedAt: older(100) });
    const b = row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: older(1), ...ob });
    expect(supersededIn(reconcile("MECHANISM_SPEC", [a, b]))).toEqual([]);
  });

  it("CLAIMED over CLAIMED is not an authority question: ordinary conditions decide", () => {
    const a = row("MECHANISM_SPEC", { mechanismState: "PROPOSED", officiality: "CLAIMED", publishedAt: older(100) });
    const b = row("MECHANISM_SPEC", { mechanismState: "LIVE", officiality: "CLAIMED", publishedAt: older(1) });
    expect(supersededIn(reconcile("MECHANISM_SPEC", [a, b]))).toEqual([a.id]);
  });
});

describe("D-160 G/H — memory guides, fresh evidence verifies", () => {
  const MEM = { reusedFromMemoryId: "mem-0001-0000-4000-8000-000000000000" };

  it("G: a newer memory-adopted row cannot supersede an older fresh row", () => {
    const fresh = row("SOURCE_OF_VALUE", { mechanismState: "PROPOSED", publishedAt: older(100) });
    const adopted = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(1), ...MEM });
    const r = reconcile("SOURCE_OF_VALUE", [fresh, adopted]);
    expect(reasonOf(r, fresh.id)).toBeNull();
    expect(r.status).toBe("CONTRADICTED");
  });

  it("G: memory may still coexist and support beside fresh evidence", () => {
    const fresh = row("SOURCE_OF_VALUE", { publishedAt: older(100) });
    const adopted = row("SOURCE_OF_VALUE", { publishedAt: older(1), ...MEM });
    const r = reconcile("SOURCE_OF_VALUE", [fresh, adopted]);
    expect([...r.supportingEvidenceIds].sort()).toEqual([fresh.id, adopted.id].sort());
  });

  it("H: a fresh newer row supersedes an older memory row under the approved conditions", () => {
    const adopted = row("SOURCE_OF_VALUE", { mechanismState: "PROPOSED", publishedAt: older(100), ...MEM });
    const fresh = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(1) });
    const r = reconcile("SOURCE_OF_VALUE", [adopted, fresh]);
    expect(reasonOf(r, adopted.id)).toBe("SUPERSEDED_BY_NEWER");
    expect(r.supportingEvidenceIds).toEqual([fresh.id]);
  });

  it.each([
    ["the fresh date is legacy", LEGACY],
    ["the fresh row is CLAIMED over CONFIRMED memory", { officiality: "CLAIMED" as const }],
    ["the states are the same", { mechanismState: "PROPOSED" }],
  ])("H: …and not when %s", (_label, ofresh: Partial<EvidenceRow>) => {
    const adopted = row("SOURCE_OF_VALUE", { mechanismState: "PROPOSED", publishedAt: older(100), ...MEM });
    const fresh = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(1), ...ofresh });
    expect(supersededIn(reconcile("SOURCE_OF_VALUE", [adopted, fresh]))).toEqual([]);
  });
});

describe("D-160 I — an already-excluded row keeps its own exclusion reason", () => {
  it("a SOCIAL row stays CLASS_NOT_ADMISSIBLE beside a newer official row", () => {
    const social = row("SOURCE_OF_VALUE", {
      sourceClass: "SOCIAL",
      officiality: "CLAIMED",
      mechanismState: "PROPOSED",
      publishedAt: older(100),
    });
    const official = row("SOURCE_OF_VALUE", { publishedAt: older(1) });
    const r = reconcile("SOURCE_OF_VALUE", [social, official]);
    expect(reasonOf(r, social.id)).toBe("CLASS_NOT_ADMISSIBLE");
    expect(r.supportingEvidenceIds).toEqual([official.id]);
  });
});
