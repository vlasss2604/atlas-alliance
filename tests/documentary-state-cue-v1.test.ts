import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildResultSurface } from "../src/client/result-surface";
import { resultFixture } from "../src/client/result-surface-fixtures";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import {
  MECHANISM_STATE_RULE_VERSION,
  mechanismStateRuleVersionFor,
  stateOfCue,
} from "../src/server/domain/mechanism-state-cue";
import {
  reconcileComponent,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { deriveLifecycleStateSignals } from "../src/server/engine/mechanism-assembler";
import { EVIDENCE_EXTRACTOR_SYSTEM_PROMPT } from "../src/server/engine/providers/evidence-extractor-anthropic";
import { isTraceable } from "../src/server/engine/s4-executor";

// THE DOCUMENTARY STATE-CUE CONTRACT (Founder-approved).
// PRESENT TENSE ≠ CURRENT STATE. DOCUMENTED ≠ EXECUTING. CURRENT_STATE needs
// an explicit, validated state cue AND trusted temporal provenance.

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const older = (days: number) => new Date(NOW.getTime() - days * DAY);
const FRESHNESS = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };
const JOB = "job-state-cue";
const STEP: Record<string, number> = { MECHANISM_SPEC: 3, EXECUTION_EVIDENCE: 4, CURRENT_STATE: 5 };

// What the executor persists for a fact: the marker is computed by the SAME
// function the executor calls, with the SAME literal check.
const markerFor = (mechanismState: string | null, stateCue: string | null, fragment: string) =>
  mechanismStateRuleVersionFor({ mechanismState, stateCue, supportFragment: fragment, isLiteral: isTraceable });

let seq = 0;
function row(component: string, fragment: string, mechanismState: string | null, stateCue: string | null, o: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = `c${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
  return {
    id,
    researchJobId: JOB,
    sourceId: `src-${id}`,
    evidenceContractVersion: 2,
    patternStep: STEP[component],
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment,
    summary: null,
    mechanismState,
    mechanismStateRuleVersion: markerFor(mechanismState, stateCue, fragment),
    sourceClass: component === "EXECUTION_EVIDENCE" ? "OFFICIAL_REPORT" : "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    entityBinding: null,
    onchainFactKind: null,
    fetchedAt: NOW,
    // A fresh, strict-rule publication date: trusted temporal provenance.
    publishedAt: older(1),
    publishedAtRuleVersion: 1,
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
const cs = (rows: EvidenceRow[]) => reconcile("CURRENT_STATE", rows);
const reasonOf = (r: ComponentReconciliationResult, id: string) => r.excludedEvidence.find((x) => x.evidenceId === id)?.reason;

// Verbatim from Wave 1A (job fd1252ef): the CLMM fee-split table row and the
// buyback sentence, both extracted with mechanism_state = LIVE.
const WAVE_1A_TABLE = "| CLMM | 84% | 12% | 4% |";
const WAVE_1A_SENTENCE = "12% of Raydium trading fees are used to buy back RAY.";

describe("1. the code-owned cue table: explicit state language only, exactly one state", () => {
  it("explicit cues map to their canonical state", () => {
    expect(stateOfCue("is currently live")).toBe("LIVE");
    expect(stateOfCue("is now active")).toBe("LIVE");
    expect(stateOfCue("has been paused since March")).toBe("PAUSED");
    expect(stateOfCue("is deprecated")).toBe("DEPRECATED");
    expect(stateOfCue("was removed")).toBe("REMOVED");
    expect(stateOfCue("is being rolled out")).toBe("IMPLEMENTING");
    expect(stateOfCue("has been approved")).toBe("APPROVED");
    expect(stateOfCue("is proposed")).toBe("PROPOSED");
  });

  it("present tense, tables, allocations and execution reports are not cues", () => {
    for (const notACue of [
      "are used to buy back RAY",
      WAVE_1A_SENTENCE,
      WAVE_1A_TABLE,
      "rewards are sent to the vault",
      "the balance updates automatically",
      "bought back 1,000 RAY on 3 May 2026",
      "executed",
      "burned",
      "completed the buyback",
    ]) {
      expect(stateOfCue(notACue), notACue).toBeNull();
    }
  });

  it("negation, condition, modal or future refuse a cue — polarity is never flipped into a state", () => {
    for (const refused of [
      "is not live",
      "is no longer active",
      "has not been paused",
      "will be live",
      "is expected to be live",
      "if the module is active",
      "may be paused",
    ]) {
      expect(stateOfCue(refused), refused).toBeNull();
    }
  });

  it("a cue must be literal in the fragment and name the SAME state the model assigned", () => {
    const fragment = "The buyback module is currently live on mainnet.";
    expect(markerFor("LIVE", "is currently live", fragment)).toBe(MECHANISM_STATE_RULE_VERSION);
    // Not in the fragment (no paraphrase, no fuzzy matching).
    expect(markerFor("LIVE", "is live now", fragment)).toBeNull();
    // Literal, but it states a different state than the label.
    expect(markerFor("PAUSED", "is currently live", fragment)).toBeNull();
    // A label with no cue, and a cue with no state, get no marker.
    expect(markerFor("LIVE", null, fragment)).toBeNull();
    expect(markerFor(null, "is currently live", fragment)).toBeNull();
    expect(markerFor("UNKNOWN", "is currently live", fragment)).toBeNull();
  });
});

describe("2. CURRENT_STATE needs an explicit cue AND a trusted date", () => {
  it("generic present tense does NOT establish LIVE: '12% of trading fees are used to buy back RAY'", () => {
    const r1 = row("CURRENT_STATE", WAVE_1A_SENTENCE, "LIVE", "are used to buy back RAY");
    expect(r1.mechanismStateRuleVersion).toBeNull();
    const r = cs([r1]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.currentState).toBeNull();
    expect(reasonOf(r, r1.id)).toBe("NOT_CURRENT_STATE_BEARING");
  });

  it("Wave 1A: the CLMM fee table no longer bears LIVE, even with a trusted publication date", () => {
    const table = row("CURRENT_STATE", WAVE_1A_TABLE, "LIVE", null);
    const r = cs([table]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.currentState).toBeNull();
    expect(r.supportingEvidenceIds).toEqual([]);
  });

  it("an explicit 'is currently live' + a trusted date establishes the current LIVE state", () => {
    const live = row("CURRENT_STATE", "The buyback module is currently live on mainnet.", "LIVE", "is currently live");
    expect(live.mechanismStateRuleVersion).toBe(1);
    const r = cs([live]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.currentState).toBe("LIVE");
    expect(r.supportingEvidenceIds).toEqual([live.id]);
  });

  it("an explicit LIVE cue WITHOUT a trusted date cannot establish CURRENT_STATE", () => {
    const fragment = "The buyback module is currently live on mainnet.";
    for (const undated of [
      row("CURRENT_STATE", fragment, "LIVE", "is currently live", { publishedAtRuleVersion: null }),
      row("CURRENT_STATE", fragment, "LIVE", "is currently live", { publishedAt: null }),
    ]) {
      const r = cs([undated]);
      expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(reasonOf(r, undated.id)).toBe("MISSING_PUBLICATION_DATE");
    }
  });

  it("a trusted date WITHOUT an explicit cue cannot establish CURRENT_STATE", () => {
    const uncued = row("CURRENT_STATE", "The buyback module runs every epoch.", "LIVE", null);
    const r = cs([uncued]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(reasonOf(r, uncued.id)).toBe("NOT_CURRENT_STATE_BEARING");
  });

  it("historical 'bought back X on date Y' does not establish CURRENT_STATE", () => {
    const hist = row("CURRENT_STATE", "The treasury bought back 1,000 RAY on 3 May 2026.", "LIVE", "bought back 1,000 RAY on 3 May 2026");
    expect(hist.mechanismStateRuleVersion).toBeNull();
    const r = cs([hist]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.currentState).toBeNull();
  });

  it("explicit PAUSED / DEPRECATED / REMOVED cues keep their real state", () => {
    for (const [state, fragment, cue] of [
      ["PAUSED", "Buybacks have been paused since March pending review.", "have been paused since March"],
      ["DEPRECATED", "The v1 buyback module is deprecated.", "is deprecated"],
      ["REMOVED", "The fee switch was removed in the v3 upgrade.", "was removed"],
    ] as const) {
      const r = cs([row("CURRENT_STATE", fragment, state, cue)]);
      expect(r.status, state).toBe("SUPPORTED");
      expect(r.currentState, state).toBe(state);
    }
    // A negated cue states no state at all — never the opposite one.
    const negated = row("CURRENT_STATE", "Buybacks have not been paused.", "PAUSED", "have not been paused");
    expect(negated.mechanismStateRuleVersion).toBeNull();
    expect(cs([negated]).currentState).toBeNull();
  });

  it("legacy NULL rows fail closed — a gap, never a contradiction", () => {
    const legacy = row("CURRENT_STATE", "The module is currently live.", "LIVE", null, { mechanismStateRuleVersion: null });
    expect(cs([legacy]).status).toBe("INSUFFICIENT_EVIDENCE");
    // Beside a cued state, an uncued conflicting label neither contradicts nor moves it.
    const cued = row("CURRENT_STATE", "The buyback module is currently live on mainnet.", "LIVE", "is currently live");
    const uncuedStop = row("CURRENT_STATE", "The v1 docs describe the module.", "DEPRECATED", null, { publishedAt: older(0.5) });
    const r = cs([cued, uncuedStop]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.currentState).toBe("LIVE");
    expect(r.contradictingEvidenceIds).toEqual([]);
  });
});

describe("3. the lifecycle reads only cued documentary states", () => {
  it("an uncued trusted stop is not a lifecycle signal; a cued one is", () => {
    const uncued = row("CURRENT_STATE", "The v1 buyback docs.", "DEPRECATED", null);
    const cued = row("CURRENT_STATE", "The v1 buyback module is deprecated.", "DEPRECATED", "is deprecated");
    const result = cs([uncued, cued]);
    const signals = deriveLifecycleStateSignals({ pattern: PATTERN_V1_CONTENT, componentResults: [result], rows: [uncued, cued] });
    expect(signals.map((s) => s.evidenceId)).toEqual([cued.id]);
  });
});

describe("4. what this task deliberately did NOT change", () => {
  it("EXECUTION_EVIDENCE gating is unchanged: its live gate still reads the label (Founder §5 — reported, not changed)", () => {
    const report = row("EXECUTION_EVIDENCE", "The buyback executed its purchases on schedule.", "LIVE", null);
    expect(report.mechanismStateRuleVersion).toBeNull();
    expect(reconcile("EXECUTION_EVIDENCE", [report]).status).toBe("SUPPORTED");
  });

  it("components that do not ask about the present are unchanged", () => {
    const spec = row("MECHANISM_SPEC", WAVE_1A_SENTENCE, "LIVE", null);
    expect(reconcile("MECHANISM_SPEC", [spec]).status).toBe("SUPPORTED");
  });

  it("a chain row's state is code-written and keeps its own path", () => {
    const src = readFileSync("src/server/engine/component-reconciler.ts", "utf-8");
    expect(src).toContain("if (row.onchainFactKind !== null && row.onchainFactKind !== undefined) return state;");
    expect(src).toContain("if (!requirements.requiresCurrentState) return state;");
  });
});

describe("5. the surface follows the same rule for persisted results", () => {
  function withCurrentStateEvidence(patch: Record<string, unknown>) {
    const base = resultFixture("1").detail;
    const ids = new Set(base.components.find((c) => c.component === "CURRENT_STATE")!.supportingEvidenceIds);
    return {
      ...base,
      evidence: base.evidence.map((e) => (ids.has(e.id) && e.sourceClass !== "ONCHAIN_VERIFIABLE" ? { ...e, ...patch } : e)),
      mechanism: { flows: [], unassignedGaps: [] },
    };
  }

  it("a saved CURRENT_STATE resting on an uncued LIVE with a trusted date is not 'happening now'", () => {
    const surface = buildResultSurface(withCurrentStateEvidence({ mechanismState: "LIVE", publishedAtRuleVersion: 1, mechanismStateRuleVersion: null }));
    const r = surface.table.find((x) => x.component === "CURRENT_STATE")!;
    expect(r.status).toBe("NOT_ESTABLISHED");
    expect(surface.answer.sentences.join(" ")).not.toMatch(/confirm[^.]*happening now/);
  });

  it("the same row with a validated cue is confirmed", () => {
    const surface = buildResultSurface(withCurrentStateEvidence({ mechanismState: "LIVE", publishedAtRuleVersion: 1, mechanismStateRuleVersion: 1 }));
    expect(surface.table.find((x) => x.component === "CURRENT_STATE")!.status).toBe("CONFIRMED");
  });
});

describe("6. contract plumbing: extractor, executor, Memory, migration", () => {
  it("the extractor is told the contract and has the field", () => {
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("STATE CUE.");
    expect(EVIDENCE_EXTRACTOR_SYSTEM_PROMPT).toContain("Present tense is not a state");
    const src = readFileSync("src/server/engine/providers/evidence-extractor-anthropic.ts", "utf-8");
    expect(src).toMatch(/stateCue: z\s*\.string\(\)\s*\.nullable\(\)\s*\.optional\(\)/);
  });

  it("the executor keeps the raw state and computes the marker with its own traceability check", () => {
    const src = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(src).toContain("mechanismState: fact.mechanismState,");
    expect(src).toMatch(/mechanismStateRuleVersion: mechanismStateRuleVersionFor\(\{[\s\S]*?isLiteral: isTraceable,/);
  });

  it("Memory copies the marker exactly (proved end to end in research-memory-observed-candidates-v1)", () => {
    const src = readFileSync("src/server/engine/memory-evidence-adoption.ts", "utf-8");
    expect(src).toContain("mechanismStateRuleVersion: origin.mechanismStateRuleVersion,");
    expect(src).not.toContain("mechanismStateRuleVersionFor");
  });

  it("the migration only adds a nullable column — no default, no backfill, no historical row mutated", () => {
    const sql = readFileSync("src/server/db/migrations/0061_mechanism_state_rule_version.sql", "utf-8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim().length > 0);
    expect(statements).toEqual(['ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "mechanism_state_rule_version" smallint;']);
    const journal = JSON.parse(readFileSync("src/server/db/migrations/meta/_journal.json", "utf-8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.at(-1)).toMatchObject({ idx: 61, tag: "0061_mechanism_state_rule_version" });
  });
});

describe("7. the cue must sit in an ASSERTED sentence, not only be a clean phrase", () => {
  // The four false positives found by the offline corpus audit: each cue is
  // clean on its own, so the cue-only check accepted it.
  const CORPUS_FALSE_POSITIVES: [string, string, string][] = [
    ["LIVE", "is live", "All participants have the same opportunity to buy and sell once the token is live, aiming to promote transparency."],
    ["LIVE", "is active", "If the fee switch is active, 12% of fees are used to buy back RAY."],
    ["LIVE", "is live", "The buyback module will not launch until the vault is live."],
    ["LIVE", "is enabled", "The fee switch is enabled only after governance approval."],
  ];

  it("conditional, contingent, negated-future and dependent sentences get no marker", () => {
    for (const [state, cue, fragment] of CORPUS_FALSE_POSITIVES) {
      expect(stateOfCue(cue), cue).toBe(state);
      expect(isTraceable(fragment, cue), fragment).toBe(true);
      expect(markerFor(state, cue, fragment), fragment).toBeNull();
    }
  });

  it("explicit asserted states still pass", () => {
    for (const [state, cue, fragment] of [
      ["LIVE", "is currently live", "The module is currently live."],
      ["LIVE", "is now active", "The buyback module is now active on mainnet."],
      ["PAUSED", "is paused", "The module is paused."],
      ["PAUSED", "has been paused", "The module has been paused since March."],
      ["PAUSED", "have been paused since March", "Buybacks have been paused since March pending review."],
      ["DEPRECATED", "is deprecated", "The v1 module is deprecated."],
      ["REMOVED", "was removed", "The fee switch was removed in the v3 upgrade."],
    ] as const) {
      expect(markerFor(state, cue, fragment), fragment).toBe(MECHANISM_STATE_RULE_VERSION);
    }
  });

  it("the sentence is the scope: a qualifier in ANOTHER sentence does not refuse, one in the same sentence does", () => {
    expect(markerFor("LIVE", "is currently live", "The module is currently live. Rewards will be distributed monthly.")).toBe(1);
    expect(markerFor("LIVE", "is currently live", "The module is currently live and will be paused next month.")).toBeNull();
    // A version number is not a sentence end.
    expect(markerFor("LIVE", "is live", "Raydium v1.5 is live.")).toBe(1);
  });

  it("a question asserts nothing", () => {
    expect(markerFor("LIVE", "is live", "So the vault is live?")).toBeNull();
  });

  it("every occurrence must be asserted; a cue that cannot be located on word boundaries is refused", () => {
    expect(markerFor("LIVE", "is live", "The vault is live. If the pool is live, fees accrue.")).toBeNull();
    // Literal by substring ("this live"), but no word-bounded occurrence.
    expect(markerFor("LIVE", "is live", "Watch this live stream.")).toBeNull();
  });

  it("CURRENT_STATE: a conditional cue with a trusted date establishes nothing", () => {
    const [, cue, fragment] = CORPUS_FALSE_POSITIVES[1];
    const conditional = row("CURRENT_STATE", fragment, "LIVE", cue);
    expect(conditional.mechanismStateRuleVersion).toBeNull();
    const r = cs([conditional]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.currentState).toBeNull();
    expect(reasonOf(r, conditional.id)).toBe("NOT_CURRENT_STATE_BEARING");
  });
});
