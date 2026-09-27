import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ResearchJobDetail } from "../src/client/api";
import { SHORT_REASON } from "../src/client/components/result-blocks/audit-composition";
import { REASON_CODE_EXPLANATIONS } from "../src/client/research-model";
import { buildResultSurface, KNOWN_STATED_STATES } from "../src/client/result-surface";
import { resultFixture } from "../src/client/result-surface-fixtures";
import { MECHANISM_STATES } from "../src/server/domain/mechanism-state";
import { reconcileComponent, type EvidenceRow } from "../src/server/engine/component-reconciler";
import { EVIDENCE_EXTRACTOR_SYSTEM_PROMPT } from "../src/server/engine/providers/evidence-extractor-anthropic";

// TEMPORAL RELIABILITY (Founder-approved Fixes 1, 2, 4).
//
//   FRESH DOCUMENT ≠ CURRENT CLAIM
//   HISTORICAL TOTAL + FRESH PAGE DATE ≠ HAPPENING NOW
//   HISTORICAL EXECUTION ≠ EXECUTING NOW

const NOW = new Date("2026-09-27T12:00:00.000Z");
const FRESHNESS = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };

let seq = 0;
function row(over: Partial<EvidenceRow>): EvidenceRow {
  seq += 1;
  return {
    id: `row-${String(seq).padStart(4, "0")}`,
    researchJobId: "job",
    sourceId: `src-${seq}`,
    evidenceContractVersion: 2,
    patternStep: 5,
    component: "CURRENT_STATE",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: `fragment ${seq}`,
    summary: `summary ${seq}`,
    mechanismState: null,
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    entityBinding: null,
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: null,
    extractionUnitKey: null,
    contentHash: `hash-${seq}`,
    ...over,
  };
}

const CURRENT_STATE = {
  component: "CURRENT_STATE",
  establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "OFFICIAL_REPORT"] as const,
  requiresCurrentState: true,
  requiresLiveMechanismState: false,
  freshnessClass: "HIGH_CHANGE" as const,
  tokenStateSensitive: false,
  requiredTokenState: null,
};
const MECHANISM_SPEC = {
  component: "MECHANISM_SPEC",
  establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"] as const,
  requiresCurrentState: false,
  requiresLiveMechanismState: false,
  freshnessClass: "LOW_CHANGE" as const,
  tokenStateSensitive: false,
  requiredTokenState: null,
};
const GOVERNANCE_BASIS = { ...MECHANISM_SPEC, component: "GOVERNANCE_BASIS", establishingClasses: ["GOVERNANCE"] as const };

function reconcile(requirements: typeof CURRENT_STATE | typeof MECHANISM_SPEC | typeof GOVERNANCE_BASIS, step: number, rows: EvidenceRow[]) {
  return reconcileComponent({
    jobId: "job",
    item: { step, component: requirements.component },
    requirements: { ...requirements, establishingClasses: [...requirements.establishingClasses] },
    evidence: rows.map((r) => ({ ...r, component: requirements.component, patternStep: step })),
    now: NOW,
    freshnessPolicyDays: FRESHNESS,
  });
}

// ---------------------------------------------------------------------------
// FIX 1 — CURRENT_STATE requires a known stated state
// ---------------------------------------------------------------------------

describe("Fix 1: a fresh page date alone never establishes CURRENT_STATE", () => {
  it("a freshly dated row stating no known state establishes nothing (UNKNOWN and null alike)", () => {
    for (const mechanismState of [null, "UNKNOWN", "Historical cumulative total as of September 4, 2026"]) {
      const r = reconcile(CURRENT_STATE, 5, [row({ mechanismState, publishedAt: new Date("2026-09-26T00:00:00Z") })]);
      expect(r.status, String(mechanismState)).toBe("INSUFFICIENT_EVIDENCE");
      expect(r.reasonCodes).toEqual(["MISSING_CURRENT_STATE"]);
      expect(r.excludedEvidence.map((x) => x.reason)).toEqual(["NOT_CURRENT_STATE_BEARING"]);
    }
  });

  it("every known stated state still answers CURRENT_STATE, as that state", () => {
    for (const state of ["LIVE", "IMPLEMENTING", "PAUSED", "DEPRECATED", "REMOVED"]) {
      const r = reconcile(CURRENT_STATE, 5, [row({ mechanismState: state, publishedAt: new Date("2026-09-26T00:00:00Z") })]);
      expect(r.status, state).toBe("SUPPORTED");
      expect(r.currentState, state).toBe(state);
    }
  });

  it("stale, undated and wrong-kind rows keep the exclusion reason they always had", () => {
    const stale = reconcile(CURRENT_STATE, 5, [row({ mechanismState: null, publishedAt: new Date("2025-01-01T00:00:00Z") })]);
    expect(stale.excludedEvidence.map((x) => x.reason)).toEqual(["STALE_FOR_CURRENT_STATE"]);
    expect(stale.reasonCodes).toEqual(["STALE_CURRENT_STATE"]);
    const undated = reconcile(CURRENT_STATE, 5, [row({ mechanismState: null, publishedAt: null })]);
    expect(undated.excludedEvidence.map((x) => x.reason)).toEqual(["MISSING_PUBLICATION_DATE"]);
    const level = reconcile(CURRENT_STATE, 5, [
      row({ sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "CONFIRMED", onchainFactKind: "TOKEN_SUPPLY" }),
    ]);
    expect(level.excludedEvidence.map((x) => x.reason)).toEqual(["FACT_KIND_CANNOT_ESTABLISH"]);
  });

  it("a component that does not ask about now is unchanged: an undated, stateless docs row still establishes MECHANISM_SPEC", () => {
    const r = reconcile(MECHANISM_SPEC, 3, [row({ mechanismState: null })]);
    expect(r.status).toBe("SUPPORTED");
  });

  it("the pump_fun shape: four real fragments, one day before the fetch, no known state → not established", () => {
    // The fragments and free-text states of saved job 9e06ca4f-…, verbatim.
    const published = new Date("2026-09-04T00:00:00.000Z");
    const fetched = new Date("2026-09-05T04:51:04.156Z");
    const at = new Date("2026-09-05T21:00:00.000Z");
    const rows = [
      ["ACTIVE_BUYBACK_AND_BURN", "Every buyback, burned forever\n\nHalf of every dollar Pump.fun earns buys $PUMP on the open market, then burns it forever."],
      ["CUMULATIVE_BURN_TOTAL", "Total bought back and burnt\n$448.21M\n164.17B $PUMP burned"],
      ["PROGRAMMATIC_50PCT_ALLOCATION", "As of 28 Apr 2026, 50% of revenue is programmatically locked and allocated to be burned for one year."],
      ["DAILY_BUYBACK_ACTIVE", "Total USD deployed to buy & burn $PUMP, since launch.\n\nCumulative buybacks\n$448.21M"],
    ].map(([state, fragment]) => row({ mechanismState: state, fragment, publishedAt: published, fetchedAt: fetched }));
    const r = reconcileComponent({
      jobId: "job",
      item: { step: 5, component: "CURRENT_STATE" },
      requirements: { ...CURRENT_STATE, establishingClasses: [...CURRENT_STATE.establishingClasses] },
      evidence: rows,
      now: at,
      freshnessPolicyDays: FRESHNESS,
    });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["MISSING_CURRENT_STATE"]);
    expect(new Set(r.excludedEvidence.map((x) => x.reason))).toEqual(new Set(["NOT_CURRENT_STATE_BEARING"]));
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — legacy display safeguard
// ---------------------------------------------------------------------------

function legacyCurrentState(state: string | null): ResearchJobDetail {
  const base = resultFixture("1").detail;
  const cs = base.components.find((c) => c.component === "CURRENT_STATE")!;
  const ids = new Set(cs.supportingEvidenceIds);
  return {
    ...base,
    evidence: base.evidence.map((e) => (ids.has(e.id) ? { ...e, mechanismState: state } : e)),
  };
}

describe("Fix 1: a saved CURRENT_STATE resting only on rows with no known state is shown as not established", () => {
  it("the client's known-state vocabulary is exactly the engine's, minus UNKNOWN", () => {
    expect([...KNOWN_STATED_STATES].sort()).toEqual(MECHANISM_STATES.filter((s) => s !== "UNKNOWN").sort());
  });

  it("free-text / null states → NOT_ESTABLISHED with the honest limit; the saved record is not changed", () => {
    for (const state of [null, "CUMULATIVE_BURN_TOTAL", "Historical cumulative total as of September 4, 2026"]) {
      const detail = legacyCurrentState(state);
      const persisted = JSON.stringify(detail.components);
      const surface = buildResultSurface(detail);
      const row = surface.table.find((r) => r.component === "CURRENT_STATE")!;
      expect(row.status, String(state)).toBe("NOT_ESTABLISHED");
      expect(row.established).toBe(
        "The sources checked do not state whether this is happening now; a recent page date alone cannot show it.",
      );
      expect(row.established).not.toMatch(/happening now\.$/);
      expect(JSON.stringify(detail.components)).toBe(persisted);
    }
  });

  it("a saved row stating a known state is shown exactly as before", () => {
    const surface = buildResultSurface(legacyCurrentState("live"));
    expect(surface.table.find((r) => r.component === "CURRENT_STATE")!.status).toBe("CONFIRMED");
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — publishedAt is document metadata only
// ---------------------------------------------------------------------------

describe("Fix 2: the extractor is told exactly what publishedAt is", () => {
  it("only an explicit publication or last-updated date of the document itself, else null", () => {
    const p = EVIDENCE_EXTRACTOR_SYSTEM_PROMPT;
    expect(p).toContain("PUBLICATION DATE. publishedAt is DOCUMENT METADATA");
    expect(p).toContain("explicit\npublication date or explicit last-updated date");
    expect(p).toContain("If the document states no such date, set publishedAt\nto null");
    for (const forbidden of [
      "the date the document was fetched",
      "any date mentioned inside the facts or excerpts",
      '"as of" date',
      "a governance vote, proposal or execution date",
      "a transaction or block date",
    ]) {
      expect(p, forbidden).toContain(forbidden);
    }
    expect(p).toContain("An \"as of\" date is\nevidence content, not publication metadata.");
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — temporally honest wording
// ---------------------------------------------------------------------------

describe("Fix 4: execution evidence is worded as historical", () => {
  it("no client surface says the mechanism 'has been observed executing'", () => {
    for (const file of ["src/client/research-model.ts", "src/client/result-surface.ts", "src/client/result-showcase-fixture.ts"]) {
      expect(readFileSync(file, "utf-8"), file).not.toContain("observed executing");
    }
    expect(readFileSync("src/client/research-model.ts", "utf-8")).toContain(
      '{ component: "EXECUTION_EVIDENCE", label: "Execution has been observed" }',
    );
  });

  it("a confirmed or partly confirmed execution row states its evidence date and that it does not show continuation", () => {
    const surface = buildResultSurface(resultFixture("2").detail);
    const row = surface.table.find((r) => r.component === "EXECUTION_EVIDENCE")!;
    expect(["CONFIRMED", "PARTIAL"]).toContain(row.status);
    expect(row.established).toMatch(/The supporting evidence is dated .+: it shows that execution had happened by then, not that it continues now\.$/);
  });
});

describe("Fix 4: an approval later withdrawn is named, not rendered as 'no approval seen'", () => {
  const approved = () => row({ sourceClass: "GOVERNANCE", mechanismState: "APPROVED", publishedAt: new Date("2024-01-01T00:00:00Z") });
  const withdrawn = (state: string) => row({ sourceClass: "GOVERNANCE", mechanismState: state, publishedAt: new Date("2026-06-01T00:00:00Z") });

  it("earlier APPROVED superseded by a newer PAUSED / DEPRECATED / REMOVED → APPROVAL_LATER_WITHDRAWN", () => {
    for (const state of ["PAUSED", "DEPRECATED", "REMOVED"]) {
      const r = reconcile(GOVERNANCE_BASIS, 3, [approved(), withdrawn(state)]);
      expect(r.status, state).toBe("PARTIALLY_SUPPORTED");
      expect(r.reasonCodes, state).toEqual(["APPROVAL_LATER_WITHDRAWN"]);
    }
  });

  it("without an earlier approval, or with a newer approval-bearing row, the old behaviour stands", () => {
    expect(reconcile(GOVERNANCE_BASIS, 3, [withdrawn("DEPRECATED")]).reasonCodes).toEqual(["APPROVAL_NOT_ESTABLISHED"]);
    expect(reconcile(GOVERNANCE_BASIS, 3, [row({ sourceClass: "GOVERNANCE", mechanismState: null })]).reasonCodes).toEqual([
      "APPROVAL_NOT_ESTABLISHED",
    ]);
    const reapproved = reconcile(GOVERNANCE_BASIS, 3, [approved(), withdrawn("LIVE")]);
    expect(reapproved.status).toBe("SUPPORTED");
    expect(reapproved.reasonCodes).toEqual([]);
  });

  it("the reason has its own copy and short form, and neither denies the earlier approval", () => {
    expect(REASON_CODE_EXPLANATIONS.APPROVAL_LATER_WITHDRAWN).toContain("An earlier governance record approved this");
    expect(SHORT_REASON.APPROVAL_LATER_WITHDRAWN).toBe("Approved earlier · later withdrawn");
    expect(SHORT_REASON.APPROVAL_LATER_WITHDRAWN).not.toMatch(/no approval/i);
  });
});
