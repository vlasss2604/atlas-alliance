import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import {
  reconcileComponent,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  assembleMechanism,
  classifyDestinationKind,
  classifyRecipientKind,
  deriveLifecycleStateSignals,
} from "../src/server/engine/mechanism-assembler";
import { PUBLISHED_AT_RULE_VERSION } from "../src/server/engine/providers/types";

// Two narrow semantic fixes (Founder decision, closing the offline hardening
// cycle):
//   FIX 1 — PROPOSED / APPROVED != IMPLEMENTING / LIVE. A newer pending row
//           never supersedes an older activated one, however trusted its date.
//   FIX 2 — a passage matching more than one distinct destination or
//           recipient kind is UNKNOWN, never the first match; "burns" is a
//           burn form like "burn", "burned", "burning".

const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const older = (days: number) => new Date(NOW.getTime() - days * DAY);
const FRESHNESS = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };
const JOB = "job-pre-activation";
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
const CLASS: Record<string, EvidenceRow["sourceClass"]> = { GOVERNANCE_BASIS: "GOVERNANCE", EXECUTION_EVIDENCE: "OFFICIAL_REPORT" };

let seq = 0;
function row(component: string, o: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = `p${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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
    sourceClass: CLASS[component] ?? "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    entityBinding: null,
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: older(1),
    publishedAtRuleVersion: PUBLISHED_AT_RULE_VERSION,
    // The builder's rows state their state explicitly: a validated state cue
    // backs it (documentary state-cue contract, mechanism_state_rule_version).
    mechanismStateRuleVersion: 1,
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

function pipeline(pool: EvidenceRow[]) {
  const pattern = PATTERN_V1_CONTENT;
  const results = ALL.map((component) => reconcile(component, pool.filter((r) => r.component === component)));
  const admitted = new Set(results.flatMap((r) => [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds]));
  const assembly = assembleMechanism({
    researchJobId: JOB,
    patternVersion: 1,
    pattern,
    contractView: { patternVersion: 1 },
    componentResults: results,
    admittedEvidence: pool
      .filter((r) => admitted.has(r.id))
      .map((r) => ({
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
      })),
    lifecycleStateSignals: deriveLifecycleStateSignals({ pattern, componentResults: results, rows: pool }),
  });
  return { by: new Map(results.map((r) => [r.component, r])), assembly };
}

const world = (skip: string[] = []) =>
  [
    row("SOURCE_OF_VALUE", { fragment: "protocol fees from trading fund the program" }),
    row("FLOW_PATH", { fragment: "fees are routed by the fee switch contract" }),
    row("MECHANISM_SPEC", { fragment: "the contract executes buybacks weekly" }),
    row("GOVERNANCE_BASIS", { fragment: "governance approved the program", mechanismState: "APPROVED" }),
    row("EXECUTION_EVIDENCE", { fragment: "the buyback executed its purchases on schedule" }),
    row("CURRENT_STATE", { fragment: "the program is live" }),
    row("DESTINATION", { fragment: "bought tokens are burned" }),
    row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" }),
  ].filter((r) => !skip.includes(r.component!));

const supersededIn = (r: ComponentReconciliationResult) =>
  r.excludedEvidence.filter((x) => x.reason === "SUPERSEDED_BY_NEWER").map((x) => x.evidenceId);

describe("FIX 1 — a newer pending state never supersedes an activated one", () => {
  it.each([
    ["LIVE", "PROPOSED"],
    ["LIVE", "APPROVED"],
    ["IMPLEMENTING", "APPROVED"],
    ["IMPLEMENTING", "PROPOSED"],
  ])("%s beside a newer trusted %s: nothing is superseded, both stay visible", (activated, pending) => {
    for (const component of ["DESTINATION", "MECHANISM_SPEC", "GOVERNANCE_BASIS", "CURRENT_STATE"]) {
      // Both inside every component's freshness window, both trusted.
      const a = row(component, { mechanismState: activated, publishedAt: older(2) });
      const b = row(component, { mechanismState: pending, publishedAt: older(1) });
      const r = reconcile(component, [a, b]);
      expect(supersededIn(r), component).toEqual([]);
      // The existing state-conflict semantics decide the pair (the same
      // outcome an undated or legacy-dated pair already had): both rows are
      // presented, neither wins by recency.
      expect(r.status, component).toBe("CONTRADICTED");
      expect([...r.contradictingEvidenceIds].sort(), component).toEqual([a.id, b.id].sort());
    }
  });

  it("the pending row can never become the current state through recency", () => {
    const r = reconcile("CURRENT_STATE", [
      row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: older(2) }),
      row("CURRENT_STATE", { mechanismState: "APPROVED", publishedAt: older(1) }),
    ]);
    expect(r.currentState).not.toBe("APPROVED");
    expect(r.currentState).not.toBe("PROPOSED");
  });

  it.each([
    ["PROPOSED", "APPROVED"],
    ["APPROVED", "IMPLEMENTING"],
    ["IMPLEMENTING", "LIVE"],
    ["PROPOSED", "LIVE"],
  ])("legitimate forward transition %s → newer %s still supersedes (bee0601 rules unchanged)", (from, to) => {
    const a = row("MECHANISM_SPEC", { mechanismState: from, publishedAt: older(20) });
    const b = row("MECHANISM_SPEC", { mechanismState: to, publishedAt: older(1) });
    const r = reconcile("MECHANISM_SPEC", [a, b]);
    expect(supersededIn(r)).toEqual([a.id]);
    expect(r.supportingEvidenceIds).toEqual([b.id]);
  });

  it("bee0601 guards still apply: a legacy-dated forward transition does not supersede", () => {
    const a = row("MECHANISM_SPEC", { mechanismState: "PROPOSED", publishedAt: older(20) });
    const b = row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: older(1), publishedAtRuleVersion: null });
    expect(supersededIn(reconcile("MECHANISM_SPEC", [a, b]))).toEqual([]);
  });

  it("J3: a newer trusted proposal to burn does not erase the live treasury destination, and burn never becomes the current mechanism", () => {
    const treasury = row("DESTINATION", { fragment: "bought tokens go to the treasury", publishedAt: older(30) });
    const proposal = row("DESTINATION", { fragment: "it is proposed that bought tokens be burned", mechanismState: "PROPOSED", publishedAt: older(2) });
    const { by, assembly } = pipeline([...world(["DESTINATION"]), treasury, proposal]);
    const dest = by.get("DESTINATION")!;
    expect(supersededIn(dest)).toEqual([]);
    expect(dest.contradictingEvidenceIds).toContain(treasury.id);
    expect(dest.contradictingEvidenceIds).toContain(proposal.id);
    for (const flow of assembly.flows) expect(flow.attributes.destinationKind).not.toBe("BURN");
  });

  it("J3 with APPROVED: an approved but unexecuted change is visible and is not the current destination", () => {
    const treasury = row("DESTINATION", { fragment: "bought tokens go to the treasury", publishedAt: older(30) });
    const approved = row("DESTINATION", { fragment: "bought tokens will be burned once the proposal is executed", mechanismState: "APPROVED", publishedAt: older(2) });
    const { by, assembly } = pipeline([...world(["DESTINATION"]), treasury, approved]);
    expect(by.get("DESTINATION")!.contradictingEvidenceIds).toContain(approved.id);
    for (const flow of assembly.flows) expect(flow.attributes.destinationKind).not.toBe("BURN");
  });

  it("governance approval does not establish execution", () => {
    // Governance says approved; nothing shows execution and nothing states a
    // current state.
    const { by, assembly } = pipeline([
      ...world(["EXECUTION_EVIDENCE", "CURRENT_STATE"]),
      row("EXECUTION_EVIDENCE", { fragment: "governance approved the buyback", mechanismState: "APPROVED" }),
    ]);
    expect(by.get("EXECUTION_EVIDENCE")!.status).toBe("INSUFFICIENT_EVIDENCE");
    for (const flow of assembly.flows) {
      expect(flow.lifecycle).not.toBe("CURRENT");
      expect(flow.edges.every((e) => !e.executed)).toBe(true);
    }
  });
});

describe("FIX 2 — multi-match classification fails closed", () => {
  it("a single destination match behaves exactly as before", () => {
    expect(classifyDestinationKind("bought tokens are burned")).toBe("BURN");
    expect(classifyDestinationKind("fees go to the protocol treasury")).toBe("TREASURY");
    expect(classifyDestinationKind("paid out to holders every week")).toBe("DISTRIBUTION");
    expect(classifyDestinationKind("added to liquidity")).toBe("LP");
    expect(classifyDestinationKind("nothing is said about where it goes")).toBe("UNKNOWN");
    // The accepted lexical limitation (no negation grammar) is untouched.
    expect(classifyDestinationKind("collected fees are not burned; they are held")).toBe("BURN");
  });

  it.each([
    "70% goes to the treasury and 30% is burned",
    "tokens are held in the treasury before being burned",
    "bought back and held, later added to liquidity",
  ])("several distinct destination kinds → UNKNOWN: %s", (text) => {
    expect(classifyDestinationKind(text)).toBe("UNKNOWN");
  });

  it("two phrases of the SAME kind are still one kind", () => {
    expect(classifyDestinationKind("the protocol treasury holds it; treasury multisig signs")).toBe("TREASURY");
    expect(classifyDestinationKind("burning happens weekly and every batch is burned")).toBe("BURN");
  });

  it("a single recipient match behaves exactly as before", () => {
    expect(classifyRecipientKind("stakers receive the distributed fees")).toBe("STAKER");
    expect(classifyRecipientKind("token holders receive a share")).toBe("PASSIVE_HOLDER");
    expect(classifyRecipientKind("node operators are paid")).toBe("NODE_OPERATOR");
    expect(classifyRecipientKind("no token holder receives anything")).toBe("PASSIVE_HOLDER");
  });

  it.each([
    "stakers and the treasury split the fees",
    "validators and token holders share the rewards",
    "liquidity providers and stakers receive incentives",
  ])("several distinct recipient kinds → UNKNOWN: %s", (text) => {
    expect(classifyRecipientKind(text)).toBe("UNKNOWN");
  });

  it('"burns" is a burn form, consistent with burn / burned / burning', () => {
    for (const text of ["the contract burn tokens", "the contract burns bought tokens", "bought tokens are burned", "burning is weekly"]) {
      expect(classifyDestinationKind(text), text).toBe("BURN");
    }
  });

  it("through the pipeline: a multi-destination passage is preserved as evidence, its kind is unresolved, no single destination is invented", () => {
    const split = row("DESTINATION", { fragment: "70% goes to the treasury and 30% is burned" });
    const { by, assembly } = pipeline([...world(["DESTINATION"]), split]);
    expect(by.get("DESTINATION")!.supportingEvidenceIds).toEqual([split.id]);
    expect(assembly.flows).toHaveLength(1);
    const flow = assembly.flows[0];
    expect(flow.attributes.destinationKind).toBe("UNKNOWN");
    expect(flow.gaps.some((g) => g.kind === "DESTINATION_UNRESOLVED")).toBe(true);
  });

  it("no claim identity is created: two distinct destination passages stay two separate branches", () => {
    const { assembly } = pipeline([
      ...world(["DESTINATION"]),
      row("DESTINATION", { fragment: "bought tokens go to the treasury", publishedAt: older(300) }),
      row("DESTINATION", { fragment: "bought tokens are burned", publishedAt: older(1) }),
    ]);
    expect(assembly.flows.map((f) => f.attributes.destinationKind).sort()).toEqual(["BURN", "TREASURY"]);
  });
});
