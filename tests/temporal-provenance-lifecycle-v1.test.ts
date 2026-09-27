import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildResultSurface, latestStatedStateOf, stopStatePhrase } from "../src/client/result-surface";
import { resultFixture } from "../src/client/result-surface-fixtures";
import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import { evaluateClaimSupport } from "../src/server/engine/claim-evaluator";
import {
  reconcileComponent,
  trustedTemporalBasisOf,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  assembleMechanism,
  deriveLifecycleStateSignals,
  type AssemblyEvidenceProjection,
} from "../src/server/engine/mechanism-assembler";
import { PUBLISHED_AT_RULE_VERSION } from "../src/server/engine/providers/types";

// UNTRUSTED DOCUMENTARY DATES MUST NOT CREATE CURRENT OR LIFECYCLE TEMPORAL
// TRUTH (Founder-approved temporal provenance marker + Fix 3).
//
// Every case runs the real pure pipeline — reconcile every component, derive
// the lifecycle signals exactly as the assembly store does (option a),
// assemble, and evaluate the "is it current?" question.

const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const older = (days: number) => new Date(NOW.getTime() - days * DAY);
const FRESHNESS = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };
const JOB = "job-temporal";
const STEP: Record<string, number> = {
  SOURCE_OF_VALUE: 1,
  FLOW_PATH: 2,
  MECHANISM_SPEC: 3,
  GOVERNANCE_BASIS: 3,
  EXECUTION_EVIDENCE: 4,
  CURRENT_STATE: 5,
  DESTINATION: 6,
  RECIPIENT: 6,
  NET_EFFECT: 7,
  DURABILITY_BASIS: 8,
};
const ALL = Object.keys(STEP);

let seq = 0;
function row(component: string, o: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = `t${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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
    mechanismState: null,
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    entityBinding: null,
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: older(1),
    // Strict-rule date by default: the rows the engine writes today.
    publishedAtRuleVersion: PUBLISHED_AT_RULE_VERSION,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...o,
  };
}
const cs = (state: string, days: number, o: Partial<EvidenceRow> = {}) =>
  row("CURRENT_STATE", { mechanismState: state, publishedAt: older(days), ...o });
const executed = (days: number, o: Partial<EvidenceRow> = {}) =>
  row("EXECUTION_EVIDENCE", { sourceClass: "OFFICIAL_REPORT", mechanismState: "LIVE", publishedAt: older(days), fragment: "the buyback executed its purchases on schedule", ...o });
const legacy: Partial<EvidenceRow> = { publishedAtRuleVersion: null };

function projection(r: EvidenceRow): AssemblyEvidenceProjection {
  return {
    id: r.id,
    sourceId: r.sourceId,
    extractionUnitKey: r.extractionUnitKey,
    sourceClass: r.sourceClass,
    officiality: r.officiality,
    mechanismState: r.mechanismState,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    fragment: r.fragment,
    summary: r.summary,
    retrievedUrl: `https://docs.example.test/${r.id}`,
    contentHash: r.contentHash,
  };
}

function run(pool: EvidenceRow[]) {
  const pattern = PATTERN_V1_CONTENT;
  const results: ComponentReconciliationResult[] = ALL.map((component) =>
    reconcileComponent({
      jobId: JOB,
      item: { step: STEP[component], component },
      requirements: { component, ...componentRequirementsFor(pattern, component) },
      evidence: pool.filter((r) => r.component === component),
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    }),
  );
  const signals = deriveLifecycleStateSignals({ pattern, componentResults: results, rows: pool });
  const admitted = new Set(results.flatMap((r) => [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds]));
  const assembly = assembleMechanism({
    researchJobId: JOB,
    patternVersion: 1,
    pattern,
    contractView: { patternVersion: 1 },
    componentResults: results,
    admittedEvidence: pool.filter((r) => admitted.has(r.id)).map(projection),
    lifecycleStateSignals: signals,
  });
  const claim = evaluateClaimSupport({
    researchJobId: JOB,
    patternVersion: 1,
    pattern,
    intent: "MECHANISM_CURRENT_STATE",
    taskType: null,
    requirementSetVersion: 1,
    assembly,
  });
  const by = new Map(results.map((r) => [r.component, r]));
  return { results, by, signals, assembly, flow: assembly.flows[0], claim };
}

describe("the marker decides which documentary dates may create temporal truth", () => {
  it("1. strict-rule LIVE with a fresh trusted date → CURRENT", () => {
    const m = run([cs("LIVE", 1)]);
    expect(m.by.get("CURRENT_STATE")!.status).toBe("SUPPORTED");
    expect(m.flow.lifecycle).toBe("CURRENT");
    expect(m.claim.status).toBe("SUPPORTED");
  });

  it("2. legacy LIVE with an apparently fresh but unmarked date → not current", () => {
    const m = run([cs("LIVE", 1, legacy)]);
    const r = m.by.get("CURRENT_STATE")!;
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence.map((x) => x.reason)).toEqual(["MISSING_PUBLICATION_DATE"]);
    expect(m.flow?.lifecycle ?? "NOT_ESTABLISHED").not.toBe("CURRENT");
    expect(m.claim.status).not.toBe("SUPPORTED");
    expect(m.signals).toEqual([]);
  });

  it("3. memory reuse copies the marker exactly (proved end to end in research-memory-observed-candidates-v1)", () => {
    const src = readFileSync("src/server/engine/memory-evidence-adoption.ts", "utf-8");
    expect(src).toContain("publishedAtRuleVersion: origin.publishedAtRuleVersion,");
    expect(src).toContain("publishedAt: origin.publishedAt,");
  });

  it("the extraction path writes the strict-rule marker, and only rule 1 exists", () => {
    expect(PUBLISHED_AT_RULE_VERSION).toBe(1);
    expect(readFileSync("src/server/engine/s4-executor.ts", "utf-8")).toContain("publishedAtRuleVersion: PUBLISHED_AT_RULE_VERSION,");
    const migration = readFileSync("src/server/db/migrations/0059_published_at_rule_version.sql", "utf-8");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "published_at_rule_version" smallint;');
    const statements = migration.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDEFAULT\b/i);
  });
});

describe("Fix 3 — durable stops, non-durable pauses, trusted ordering", () => {
  it("4 + 12. trusted DEPRECATED newer than the execution → HISTORICAL; execution stays SUPPORTED", () => {
    const m = run([executed(400), cs("DEPRECATED", 1)]);
    expect(m.flow.lifecycle).toBe("HISTORICAL");
    expect(m.claim.status).toBe("NOT_SUPPORTED");
    expect(m.by.get("EXECUTION_EVIDENCE")!.status).toBe("SUPPORTED");
    expect(m.flow.latestStatedState).toMatchObject({ state: "DEPRECATED", component: "CURRENT_STATE" });
  });

  it("4b. a trusted DEPRECATED older than the 3-day window still stops the mechanism (durable)", () => {
    const m = run([executed(400), cs("DEPRECATED", 90)]);
    expect(m.by.get("CURRENT_STATE")!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(m.flow.lifecycle).toBe("HISTORICAL");
    expect(m.by.get("EXECUTION_EVIDENCE")!.status).toBe("SUPPORTED");
  });

  it("5. an unmarked DEPRECATED can never produce HISTORICAL", () => {
    for (const days of [1, 90]) {
      const m = run([executed(400), cs("DEPRECATED", days, legacy)]);
      expect(m.flow.lifecycle, String(days)).toBe("NOT_ESTABLISHED");
      expect(m.signals.map((s) => s.state)).toEqual(["LIVE"]);
    }
  });

  it("6. REMOVED behaves exactly like DEPRECATED", () => {
    expect(run([executed(400), cs("REMOVED", 1)]).flow.lifecycle).toBe("HISTORICAL");
    expect(run([executed(400), cs("REMOVED", 90)]).flow.lifecycle).toBe("HISTORICAL");
    expect(run([executed(400), cs("REMOVED", 1, legacy)]).flow.lifecycle).toBe("NOT_ESTABLISHED");
  });

  it("7 + 12. a fresh PAUSED → NOT_ESTABLISHED, never HISTORICAL; paused is surfaced; execution stays SUPPORTED", () => {
    const m = run([executed(400), cs("PAUSED", 1)]);
    expect(m.by.get("CURRENT_STATE")!.currentState).toBe("PAUSED");
    expect(m.flow.lifecycle).toBe("NOT_ESTABLISHED");
    expect(m.claim.status).not.toBe("NOT_SUPPORTED");
    expect(m.flow.latestStatedState).toMatchObject({ state: "PAUSED" });
    expect(m.by.get("EXECUTION_EVIDENCE")!.status).toBe("SUPPORTED");
  });

  it("8. a stale PAUSED → NOT_ESTABLISHED, current state unknown", () => {
    const m = run([executed(400), cs("PAUSED", 40)]);
    expect(m.by.get("CURRENT_STATE")!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(m.flow.lifecycle).toBe("NOT_ESTABLISHED");
    expect(m.flow.latestStatedState).toMatchObject({ state: "PAUSED" });
  });

  it("old LIVE → newer PAUSED at the execution component → NOT_ESTABLISHED", () => {
    const pausedReport = executed(10, { mechanismState: "PAUSED", fragment: "the buyback was paused" });
    const m = run([executed(400), cs("LIVE", 1), pausedReport]);
    expect(m.by.get("EXECUTION_EVIDENCE")!.excludedEvidence.map((x) => x.reason)).toContain("NOT_CURRENT_STATE_BEARING");
    // The CURRENT_STATE LIVE is newer than the pause, so it stands: CURRENT.
    expect(m.flow.lifecycle).toBe("CURRENT");
    const n = run([executed(400), cs("LIVE", 2), executed(1, { mechanismState: "PAUSED", fragment: "the buyback was paused" })]);
    expect(n.flow.lifecycle).toBe("NOT_ESTABLISHED");
  });

  it("9. old LIVE → durable stop → newer FRESH trusted LIVE restores CURRENT", () => {
    const m = run([executed(400), cs("DEPRECATED", 100), cs("LIVE", 1)]);
    expect(m.flow.lifecycle).toBe("CURRENT");
    expect(m.claim.status).toBe("SUPPORTED");
  });

  it("10. old LIVE → durable stop → newer STALE LIVE does not restore CURRENT (and is not HISTORICAL)", () => {
    const m = run([executed(400), cs("DEPRECATED", 100), cs("LIVE", 20)]);
    expect(m.by.get("CURRENT_STATE")!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(m.flow.lifecycle).toBe("NOT_ESTABLISHED");
    expect(m.flow.latestStatedState).toMatchObject({ state: "LIVE" });
  });

  it("11. same-date conflicting states → NOT_ESTABLISHED", () => {
    const m = run([executed(1), cs("DEPRECATED", 1)]);
    expect(m.flow.lifecycle).toBe("NOT_ESTABLISHED");
    expect(m.flow.latestStatedState).toBeUndefined();
  });

  it("D. TEMPORAL_STATE_MISMATCH fires only on a trusted newer durable stop", () => {
    const trusted = run([cs("LIVE", 1), executed(0.5, { mechanismState: "DEPRECATED", fragment: "the buyback was deprecated" })]);
    expect(trusted.flow.gaps.some((g) => g.kind === "TEMPORAL_STATE_MISMATCH")).toBe(true);
    expect(trusted.flow.lifecycle).not.toBe("CURRENT");
    const unmarked = run([cs("LIVE", 1), executed(0.5, { mechanismState: "DEPRECATED", fragment: "the buyback was deprecated", ...legacy })]);
    expect(unmarked.flow.gaps.some((g) => g.kind === "TEMPORAL_STATE_MISMATCH")).toBe(false);
    expect(unmarked.flow.lifecycle).toBe("CURRENT");
  });

  it("E. a result's reported temporal basis is trusted-only; an unmarked execution report reports none", () => {
    expect(run([executed(400)]).by.get("EXECUTION_EVIDENCE")!.temporalBasis?.basisField).toBe("published_at");
    expect(run([executed(400, legacy)]).by.get("EXECUTION_EVIDENCE")!.temporalBasis).toBeNull();
  });
});

describe("what did not change", () => {
  // D-160 replaced the S2 pin: same-state rows never supersede, marked or not.
  it("14. non-temporal same-state rows both stay, marked or not (D-160)", () => {
    const olderLive = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(300), fragment: "fees pay for it (old)" });
    const newerLive = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: older(10), fragment: "fees pay for it (new)" });
    const marked = run([olderLive, newerLive]).by.get("SOURCE_OF_VALUE")!;
    const unmarked = run([{ ...olderLive, ...legacy }, { ...newerLive, ...legacy }]).by.get("SOURCE_OF_VALUE")!;
    expect(unmarked.status).toBe(marked.status);
    expect(unmarked.supportingEvidenceIds).toEqual(marked.supportingEvidenceIds);
    expect(unmarked.excludedEvidence).toEqual(marked.excludedEvidence);
    expect(unmarked.excludedEvidence).toEqual([]);
    expect([...unmarked.supportingEvidenceIds].sort()).toEqual([olderLive.id, newerLive.id].sort());
  });

  it("15. an on-chain row keeps its fetched_at basis and is never a lifecycle signal", () => {
    const chain = row("CURRENT_STATE", {
      sourceClass: "ONCHAIN_VERIFIABLE",
      entityBinding: "CONFIRMED",
      onchainFactKind: "TOKEN_SUPPLY",
      publishedAt: null,
      publishedAtRuleVersion: null,
      mechanismState: "LIVE",
    });
    expect(trustedTemporalBasisOf(chain)).toEqual({ basisField: "fetched_at", at: NOW });
    const m = run([chain]);
    expect(m.by.get("CURRENT_STATE")!.excludedEvidence.map((x) => x.reason)).toEqual(["FACT_KIND_CANNOT_ESTABLISH"]);
    expect(m.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 13 + wording: the surface
// ---------------------------------------------------------------------------

function withCurrentStateEvidence(patch: Record<string, unknown>, flows: unknown[] = []) {
  const base = resultFixture("1").detail;
  const ids = new Set(base.components.find((c) => c.component === "CURRENT_STATE")!.supportingEvidenceIds);
  return {
    ...base,
    // The documentary rows only: the fixture's chain reading is held to its
    // own ceilings and states no lifecycle state.
    evidence: base.evidence.map((e) => (ids.has(e.id) && e.sourceClass !== "ONCHAIN_VERIFIABLE" ? { ...e, ...patch } : e)),
    mechanism: { flows, unassignedGaps: [] },
  };
}

describe("13. the surface never says 'happening now' from an unmarked documentary date", () => {
  it("a saved CURRENT_STATE resting on a stated LIVE with an unmarked date is not established", () => {
    const surface = buildResultSurface(withCurrentStateEvidence({ mechanismState: "LIVE", publishedAtRuleVersion: null }));
    const r = surface.table.find((x) => x.component === "CURRENT_STATE")!;
    expect(r.status).toBe("NOT_ESTABLISHED");
    expect(r.established).toBe("The sources checked carry no publication date that can show this is happening now.");
    expect(surface.answer.sentences.join(" ")).not.toMatch(/confirm[^.]*happening now/);
  });

  it("the same row with a strict-rule date is confirmed as before", () => {
    const surface = buildResultSurface(withCurrentStateEvidence({ mechanismState: "LIVE", publishedAtRuleVersion: 1 }));
    expect(surface.table.find((x) => x.component === "CURRENT_STATE")!.status).toBe("CONFIRMED");
  });

  it("a current state established as PAUSED is said as paused, never 'happening now'", () => {
    const flows = [{ lifecycle: "NOT_ESTABLISHED", latestStatedState: { state: "PAUSED", at: "2026-09-26T00:00:00.000Z" } }];
    const surface = buildResultSurface(withCurrentStateEvidence({ mechanismState: "PAUSED", publishedAtRuleVersion: 1 }, flows));
    const r = surface.table.find((x) => x.component === "CURRENT_STATE")!;
    expect(r.statedStop).toBe("PAUSED");
    expect(r.established).toContain("The latest official state is paused");
    const answer = surface.answer.sentences.join(" ");
    expect(answer).not.toContain("is happening now");
    expect(stopStatePhrase("PAUSED", "the buyback")).toBe("that the buyback is currently paused");
    expect(stopStatePhrase("DEPRECATED", "the buyback")).toBe("that the buyback has been deprecated");
    expect(stopStatePhrase("REMOVED", "the buyback")).toBe("that the buyback has been removed");
  });

  it("a not-established current state says what the latest trusted record said, and that 'now' is unknown", () => {
    const flows = [{ lifecycle: "NOT_ESTABLISHED", latestStatedState: { state: "PAUSED", at: "2026-08-01T00:00:00.000Z" } }];
    const detail = withCurrentStateEvidence({ mechanismState: "PAUSED", publishedAtRuleVersion: 1 }, flows);
    const insufficient = {
      ...detail,
      components: detail.components.map((c) =>
        c.component === "CURRENT_STATE" ? { ...c, status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["STALE_CURRENT_STATE"], supportingEvidenceIds: [] } : c,
      ),
    };
    const r = buildResultSurface(insufficient).table.find((x) => x.component === "CURRENT_STATE")!;
    expect(r.status).toBe("NOT_ESTABLISHED");
    expect(r.established).toMatch(/It was last recorded as paused on .+; its current state is unknown\.$/);
    expect(latestStatedStateOf(flows)).toEqual({ state: "PAUSED", at: "2026-08-01T00:00:00.000Z" });
    expect(latestStatedStateOf([{ lifecycle: "CURRENT" }])).toBeNull();
  });
});
