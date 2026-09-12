import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import {
  APPROVAL_BEARING_STATES,
  reconcileComponent,
  requiresGovernanceApproval,
  type ComponentReconciliationResult,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  assembleMechanism,
  type AssemblyEvidenceProjection,
} from "../src/server/engine/mechanism-assembler";
import { computeProofConfidence } from "../src/server/engine/proof-confidence";
import { deriveSourceType, resolveSourceClass } from "../src/server/engine/source-authority";
import { REASON_CODE_EXPLANATIONS } from "../src/client/research-model";

// GOVERNANCE LIFECYCLE SAFETY V1 — PROPOSED != APPROVED != EXECUTING.
//
// The Lido human-owner authority review found that a GOVERNANCE row of ANY
// lifecycle state fully established GOVERNANCE_BASIS ("the decision that
// AUTHORISES the mechanism"), MECHANISM_SPEC, RECIPIENT and
// DURABILITY_BASIS — so an RFC on a project's official forum, once that host
// carried the GOVERNANCE class, would have read as an approved governance
// basis. Pure reducer/assembler tests, no DB, no model, no network. Every
// requirement below is the REAL Pattern data (PATTERN_V1_CONTENT), never a
// hand-built stand-in, so the rule is proven against production semantics.
//
// First principle: evidence is preserved. Every capped component keeps its
// rows in supportingEvidenceIds — what changes is the strength of the
// conclusion they may carry.

const JOB = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-12T00:00:00Z");
const FRESHNESS_POLICY = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

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

// The Lido-hazard shape, generically: a post on an official governance
// forum, extracted as SUPPORTS/DIRECT for the component, describing a
// mechanism that is only proposed. Nothing here names a project or a host.
function forumRow(component: string, overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  const id = overrides.id ?? nextId();
  return {
    id,
    researchJobId: JOB,
    sourceId: overrides.sourceId ?? `source-${id}`,
    evidenceContractVersion: 2,
    patternStep: STEP[component],
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: "we propose that protocol revenue be used to buy back the governance token on a DEX each quarter",
    summary: "proposal: quarterly buybacks funded by protocol revenue",
    mechanismState: "PROPOSED",
    sourceClass: "GOVERNANCE",
    officiality: "CONFIRMED",
    entityBinding: null,
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: NOW,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

function realRequirements(component: string): ComponentRequirements {
  const entry = componentRequirementsFor(PATTERN_V1_CONTENT, component);
  return { component, ...entry };
}

function reconcile(component: string, evidence: EvidenceRow[]): ComponentReconciliationResult {
  return reconcileComponent({
    jobId: JOB,
    item: { step: STEP[component], component },
    requirements: realRequirements(component),
    evidence,
    now: NOW,
    freshnessPolicyDays: FRESHNESS_POLICY,
  });
}

function expectPreserved(r: ComponentReconciliationResult, rows: EvidenceRow[]): void {
  // The first principle: capped, never discarded.
  for (const row of rows) expect(r.supportingEvidenceIds).toContain(row.id);
  expect(r.excludedEvidence).toEqual([]);
}

describe("A/B/C — GOVERNANCE_BASIS: proposal is not authorisation; approval or stronger is", () => {
  it("A. GOVERNANCE + PROPOSED + SUPPORTS/DIRECT does NOT fully establish GOVERNANCE_BASIS — capped, evidence kept", () => {
    const row = forumRow("GOVERNANCE_BASIS");
    const r = reconcile("GOVERNANCE_BASIS", [row]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["PROPOSED_STATE_ONLY", "APPROVAL_NOT_ESTABLISHED"]);
    expectPreserved(r, [row]);
    // NOT_ESTABLISHED != CONTRADICTED: nothing was refuted.
    expect(r.contradictingEvidenceIds).toEqual([]);
  });

  it("B. GOVERNANCE + APPROVED establishes GOVERNANCE_BASIS when every other existing requirement is met", () => {
    const row = forumRow("GOVERNANCE_BASIS", { mechanismState: "APPROVED", fragment: "the vote passed and the buyback programme is approved" });
    const r = reconcile("GOVERNANCE_BASIS", [row]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).toEqual([]);
    expect(r.supportingEvidenceIds).toEqual([row.id]);
  });

  it("C. LIVE and IMPLEMENTING are stronger than APPROVED and remain acceptable; the approval-bearing set is exactly those three", () => {
    for (const state of ["LIVE", "IMPLEMENTING", "live", " approved "]) {
      const r = reconcile("GOVERNANCE_BASIS", [forumRow("GOVERNANCE_BASIS", { mechanismState: state })]);
      expect(r.status, state).toBe("SUPPORTED");
    }
    expect([...APPROVAL_BEARING_STATES].sort()).toEqual(["APPROVED", "IMPLEMENTING", "LIVE"]);
    // Terminal states describe what became of a mechanism, not the decision
    // that authorised it — they fail closed for an authorisation claim.
    for (const state of ["PAUSED", "DEPRECATED", "REMOVED"]) {
      const r = reconcile("GOVERNANCE_BASIS", [forumRow("GOVERNANCE_BASIS", { mechanismState: state })]);
      expect(r.status, state).toBe("PARTIALLY_SUPPORTED");
      expect(r.reasonCodes, state).toEqual(["APPROVAL_NOT_ESTABLISHED"]);
    }
    expect(requiresGovernanceApproval("GOVERNANCE_BASIS")).toBe(true);
    for (const c of Object.keys(STEP).filter((c) => c !== "GOVERNANCE_BASIS")) {
      expect(requiresGovernanceApproval(c), c).toBe(false);
    }
  });
});

describe("D — MECHANISM_SPEC: a PROPOSED design is useful evidence, and never a live mechanism", () => {
  it("the proposed design is preserved as support, capped with PROPOSED_STATE_ONLY, and the flow lifecycle stays NOT_ESTABLISHED", () => {
    const spec = forumRow("MECHANISM_SPEC", { fragment: "the proposed programme would spend 20% of revenue on buybacks every quarter" });
    const r = reconcile("MECHANISM_SPEC", [spec]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["PROPOSED_STATE_ONLY"]);
    expectPreserved(r, [spec]);
    // No approval floor on MECHANISM_SPEC: it describes a design, it does
    // not claim authorisation.
    expect(r.reasonCodes).not.toContain("APPROVAL_NOT_ESTABLISHED");

    // Through the real assembler: the capped spec becomes a qualified
    // MECHANISM node and a PARTIAL_COMPONENT gap; nothing about a proposal
    // moves the lifecycle.
    const projection = (row: EvidenceRow): AssemblyEvidenceProjection => ({
      id: row.id,
      sourceId: row.sourceId,
      extractionUnitKey: row.extractionUnitKey,
      sourceClass: row.sourceClass,
      officiality: row.officiality,
      mechanismState: row.mechanismState,
      publishedAt: row.publishedAt,
      fetchedAt: row.fetchedAt,
      fragment: row.fragment,
      summary: row.summary,
      retrievedUrl: "https://example.test/forum/thread",
      contentHash: row.contentHash,
    });
    const sov = forumRow("SOURCE_OF_VALUE", { mechanismState: "LIVE", sourceClass: "OFFICIAL_DOCS", fragment: "protocol fees are charged on every swap" });
    const sovResult = reconcile("SOURCE_OF_VALUE", [sov]);
    const insufficient = (component: string): ComponentReconciliationResult => ({
      step: STEP[component],
      component,
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["NO_EVIDENCE_FOUND"],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
      currentState: null,
      temporalBasis: null,
      tokenStateMentions: [],
      requiresFreshEvidence: true,
    });
    const assembled = assembleMechanism({
      researchJobId: JOB,
      patternVersion: 1,
      pattern: PATTERN_V1_CONTENT,
      contractView: { patternVersion: 1 },
      componentResults: [
        sovResult,
        insufficient("FLOW_PATH"),
        r,
        insufficient("GOVERNANCE_BASIS"),
        insufficient("EXECUTION_EVIDENCE"),
        insufficient("CURRENT_STATE"),
        insufficient("DESTINATION"),
        insufficient("RECIPIENT"),
        insufficient("NET_EFFECT"),
        insufficient("DURABILITY_BASIS"),
      ],
      admittedEvidence: [projection(sov), projection(spec)],
    });
    expect(assembled.flows.length).toBeGreaterThan(0);
    for (const flow of assembled.flows) {
      expect(flow.lifecycle).toBe("NOT_ESTABLISHED");
      const mechanism = flow.nodes.find((n) => n.kind === "MECHANISM");
      expect(mechanism).toBeDefined();
      expect(mechanism!.componentStatus).toBe("PARTIALLY_SUPPORTED");
      expect(mechanism!.qualifications).toContain("PROPOSED_STATE_ONLY");
      expect(flow.gaps.some((g) => g.kind === "PARTIAL_COMPONENT" && g.component === "MECHANISM_SPEC")).toBe(true);
    }
  });
});

describe("E/F — the lifecycle ladder cannot be climbed by proposal-only evidence", () => {
  it("E. DOCUMENTED -> APPROVED: proposal-only rows never make an authorisation SUPPORTED, whatever their class or count", () => {
    const rows = [
      forumRow("GOVERNANCE_BASIS", { sourceId: "s-forum-1" }),
      forumRow("GOVERNANCE_BASIS", { sourceId: "s-forum-2", fragment: "a second thread proposing the same programme" }),
    ];
    const r = reconcile("GOVERNANCE_BASIS", rows);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("APPROVAL_NOT_ESTABLISHED");
    expectPreserved(r, rows);
    // The rule is about STATE, not class: an official docs page that says
    // the mechanism is proposed is proposal-only for MECHANISM_SPEC too.
    const docs = forumRow("MECHANISM_SPEC", { sourceClass: "OFFICIAL_DOCS", fragment: "a proposed fee switch would route 10% of fees to stakers" });
    const rd = reconcile("MECHANISM_SPEC", [docs]);
    expect(rd.status).toBe("PARTIALLY_SUPPORTED");
    expect(rd.reasonCodes).toEqual(["PROPOSED_STATE_ONLY"]);
  });

  it("F. APPROVED -> EXECUTING: an approved governance basis establishes nothing about execution or current state", () => {
    // Approval on the governance venue, and nothing else on the record.
    const approved = forumRow("GOVERNANCE_BASIS", { mechanismState: "APPROVED" });
    expect(reconcile("GOVERNANCE_BASIS", [approved]).status).toBe("SUPPORTED");
    // The same APPROVED row cannot establish EXECUTION_EVIDENCE (class) —
    // and even an on-chain APPROVED row is not execution (state gate).
    const asExec = forumRow("EXECUTION_EVIDENCE", { mechanismState: "APPROVED" });
    const re = reconcile("EXECUTION_EVIDENCE", [asExec]);
    expect(re.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(re.excludedEvidence).toEqual([{ evidenceId: asExec.id, reason: "CLASS_NOT_ADMISSIBLE" }]);
    const onchainApproved = forumRow("EXECUTION_EVIDENCE", { mechanismState: "APPROVED", sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "CONFIRMED" });
    const ro = reconcile("EXECUTION_EVIDENCE", [onchainApproved]);
    expect(ro.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(ro.excludedEvidence).toEqual([{ evidenceId: onchainApproved.id, reason: "NOT_CURRENT_STATE_BEARING" }]);
    // CURRENT_STATE excludes GOVERNANCE entirely.
    const asCurrent = forumRow("CURRENT_STATE", { mechanismState: "APPROVED" });
    expect(reconcile("CURRENT_STATE", [asCurrent]).excludedEvidence).toEqual([{ evidenceId: asCurrent.id, reason: "CLASS_NOT_ADMISSIBLE" }]);
  });
});

describe("G/H — existing gates intact; non-governance behaviour unchanged", () => {
  it("G. EXECUTION_EVIDENCE still refuses PROPOSED and caps IMPLEMENTING; CURRENT_STATE still reports PROPOSED as a legitimate current state, uncapped", () => {
    const proposed = forumRow("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "CONFIRMED" });
    const rp = reconcile("EXECUTION_EVIDENCE", [proposed]);
    expect(rp.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(rp.reasonCodes).toEqual(["MISSING_EXECUTION_EVIDENCE"]);
    expect(rp.excludedEvidence).toEqual([{ evidenceId: proposed.id, reason: "NOT_CURRENT_STATE_BEARING" }]);

    const implementing = forumRow("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "CONFIRMED", mechanismState: "IMPLEMENTING" });
    const ri = reconcile("EXECUTION_EVIDENCE", [implementing]);
    expect(ri.status).toBe("PARTIALLY_SUPPORTED");
    expect(ri.reasonCodes).toEqual(["STATE_NOT_FULLY_LIVE"]);

    // "Not yet started" IS a current state — the proposal cap must not
    // touch the one component whose question is what the state is.
    const current = forumRow("CURRENT_STATE", { sourceClass: "OFFICIAL_DOCS", fragment: "the buyback programme is proposed and not yet started" });
    const rc = reconcile("CURRENT_STATE", [current]);
    expect(rc.status).toBe("SUPPORTED");
    expect(rc.reasonCodes).toEqual([]);
    expect(rc.currentState).toBe("PROPOSED");
  });

  it("H. rows with no stated lifecycle (UNKNOWN) establish structural components exactly as before; NET_EFFECT keeps its own typed rule", () => {
    for (const [component, sourceClass] of [
      ["MECHANISM_SPEC", "OFFICIAL_DOCS"],
      ["SOURCE_OF_VALUE", "OFFICIAL_DOCS"],
      ["FLOW_PATH", "OFFICIAL_DOCS"],
      ["DESTINATION", "OFFICIAL_DOCS"],
      ["RECIPIENT", "OFFICIAL_DOCS"],
      ["DURABILITY_BASIS", "GOVERNANCE"],
    ] as const) {
      const row = forumRow(component, { sourceClass, mechanismState: null, fragment: "fees accrue to the treasury contract" });
      const r = reconcile(component, [row]);
      expect(r.status, component).not.toBe("INSUFFICIENT_EVIDENCE");
      expect(r.reasonCodes, component).not.toContain("PROPOSED_STATE_ONLY");
      expect(r.reasonCodes, component).not.toContain("APPROVAL_NOT_ESTABLISHED");
      expect(r.supportingEvidenceIds, component).toEqual([row.id]);
    }
    // LIVE documentary evidence is untouched too.
    const live = forumRow("DESTINATION", { sourceClass: "OFFICIAL_DOCS", mechanismState: "LIVE" });
    expect(reconcile("DESTINATION", [live]).status).toBe("SUPPORTED");
    // NET_EFFECT: a PROPOSED data-provider row is capped by the typed
    // supply rule as before, never by the generic proposal cap.
    const net = forumRow("NET_EFFECT", { sourceClass: "DATA_PROVIDER", officiality: "CLAIMED" });
    const rn = reconcile("NET_EFFECT", [net]);
    expect(rn.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(rn.reasonCodes).not.toContain("PROPOSED_STATE_ONLY");
  });

  it("H2. a PROPOSED row beside an UNKNOWN row is still proposal-only (fail closed); beside a LIVE row it is the existing state conflict", () => {
    const proposed = forumRow("RECIPIENT", { sourceId: "s-a" });
    const unknown = forumRow("RECIPIENT", { sourceId: "s-b", mechanismState: null, sourceClass: "OFFICIAL_DOCS" });
    const r = reconcile("RECIPIENT", [proposed, unknown]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("PROPOSED_STATE_ONLY");
    expectPreserved(r, [proposed, unknown]);

    const live = forumRow("RECIPIENT", { sourceId: "s-c", mechanismState: "LIVE", sourceClass: "OFFICIAL_DOCS" });
    const rc = reconcile("RECIPIENT", [proposed, live]);
    expect(rc.status).toBe("CONTRADICTED");
    expect(rc.reasonCodes).toEqual(["CONFLICTING_STATE"]);
  });
});

describe("I/J — code-owned governance platforms are subject to the same rule; UNKNOWN fails closed", () => {
  it("I. a shared governance platform still classifies as GOVERNANCE with no route, and its proposal-state rows are capped like any other", () => {
    for (const url of ["https://snapshot.org/s/dao.eth/proposal/0xabc", "https://www.tally.xyz/gov/dao/proposal/1", "https://commonwealth.im/dao/discussion/1"]) {
      expect(resolveSourceClass(url, deriveSourceType(url), null), url).toBe("GOVERNANCE");
    }
    // Platform rows are CLAIMED (no human-confirmed route): the authority
    // caveat applies as before, and the lifecycle caps sit beside it.
    const platformProposed = forumRow("GOVERNANCE_BASIS", { officiality: "CLAIMED" });
    const rp = reconcile("GOVERNANCE_BASIS", [platformProposed]);
    expect(rp.status).toBe("PARTIALLY_SUPPORTED");
    expect(rp.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY", "PROPOSED_STATE_ONLY", "APPROVAL_NOT_ESTABLISHED"]);
    // A passed vote on the platform: approval established, authority
    // caveat unchanged — the two axes stay independent.
    const platformApproved = forumRow("GOVERNANCE_BASIS", { officiality: "CLAIMED", mechanismState: "APPROVED" });
    const ra = reconcile("GOVERNANCE_BASIS", [platformApproved]);
    expect(ra.status).toBe("PARTIALLY_SUPPORTED");
    expect(ra.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
  });

  it("J. UNKNOWN state (null, or free text the dictionary does not recognise) cannot establish approval, and is never read as a proposal either", () => {
    for (const state of [null, "definitely approved", "the vote passed", "Fee split is determined by DAO configuration"]) {
      const row = forumRow("GOVERNANCE_BASIS", { mechanismState: state });
      const r = reconcile("GOVERNANCE_BASIS", [row]);
      expect(r.status, String(state)).toBe("PARTIALLY_SUPPORTED");
      expect(r.reasonCodes, String(state)).toEqual(["APPROVAL_NOT_ESTABLISHED"]);
      expectPreserved(r, [row]);
    }
  });
});

describe("K — regression modelled on the Lido hazard, stated generically", () => {
  it("an official governance forum thread (GOVERNANCE, CONFIRMED, SUPPORTS/DIRECT, PROPOSED) stays admitted and establishes no authorisation, no recipient, no durability", () => {
    const thread = (component: string) =>
      forumRow(component, {
        fragment: "[RFC] align the governance token with protocol fees: lock the token to steer fee routing; buybacks and dividends keep getting rejected",
        summary: "RFC proposing a fee-alignment mechanism",
      });
    const gov = reconcile("GOVERNANCE_BASIS", [thread("GOVERNANCE_BASIS")]);
    expect(gov.status).toBe("PARTIALLY_SUPPORTED");
    expect(gov.reasonCodes).toEqual(["PROPOSED_STATE_ONLY", "APPROVAL_NOT_ESTABLISHED"]);
    expect(gov.supportingEvidenceIds).toHaveLength(1);

    const recipient = reconcile("RECIPIENT", [thread("RECIPIENT")]);
    expect(recipient.status).toBe("PARTIALLY_SUPPORTED");
    expect(recipient.reasonCodes).toEqual(["PROPOSED_STATE_ONLY"]);
    expect(recipient.supportingEvidenceIds).toHaveLength(1);

    const durability = reconcile("DURABILITY_BASIS", [thread("DURABILITY_BASIS")]);
    expect(durability.status).toBe("PARTIALLY_SUPPORTED");
    expect(durability.reasonCodes).toEqual(["PROPOSED_STATE_ONLY"]);
    expect(durability.supportingEvidenceIds).toHaveLength(1);

    // The Proof's confidence is capped at the missing-structure band by
    // either code, so a proposal-only record can never read as confident.
    const capped = computeProofConfidence({
      verdict: "PARTIALLY_SUPPORTED",
      hasRequiredBlockingGap: false,
      hasClaimContextGap: false,
      componentResults: [{ status: gov.status, reasonCodes: gov.reasonCodes }],
    });
    expect(capped.band).toBe("LIMITED");
    expect(capped.bindingReasons).toContain("PROPOSED_STATE_ONLY");
    expect(capped.bindingReasons).toContain("APPROVAL_NOT_ESTABLISHED");
  });

  it("every new code has reader copy, a confidence cap and a node qualification; the rule names no project or host", () => {
    const reconciler = readFileSync("src/server/engine/component-reconciler.ts", "utf-8");
    const confidence = readFileSync("src/server/engine/proof-confidence.ts", "utf-8");
    const assembler = readFileSync("src/server/engine/mechanism-assembler.ts", "utf-8");
    for (const code of ["PROPOSED_STATE_ONLY", "APPROVAL_NOT_ESTABLISHED"]) {
      expect(reconciler).toContain(`| "${code}"`);
      expect(confidence).toContain(`${code}: CONFIDENCE_BANDS.LIMITED`);
      expect(assembler).toContain(`"${code}",`);
      expect(REASON_CODE_EXPLANATIONS[code]).toMatch(/^[A-Z].*\.$/);
      expect(REASON_CODE_EXPLANATIONS[code]).not.toMatch(/rejected|never|does not exist/i);
    }
    const code = reconciler
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .toLowerCase();
    for (const banned of ["lido", "research.lido", "snapshot", "tally", "raydium", "pump"]) {
      expect(code, banned).not.toContain(banned);
    }
  });
});
