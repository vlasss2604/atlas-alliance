import { afterEach, describe, expect, it } from "vitest";

import { reconcileComponent, type EvidenceRow } from "../src/server/engine/component-reconciler";
import {
  __setInstructionRegistryOverlay,
  discriminator,
} from "../src/server/engine/onchain-instruction-registry";
import {
  applicableComponentsForFactKind,
  onchainFactAppliesToComponent,
} from "../src/server/engine/onchain-facts";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import type { EvidenceProvenanceMetadata } from "../src/server/engine/onchain-invocation-provenance";

// D-158 STEP 1 — ORDINARY VISIBILITY IS NOT OBLIGATION VISIBILITY.
//
// The strongest causal record this system produces is synthesized where a
// transaction is reachable, which is EXECUTION_EVIDENCE. The obligation
// that needs it belongs to SOURCE_OF_VALUE. Ordinary reconciliation is
// right to refuse a movement fact the run of another component — and that
// refusal was also hiding the row from the obligation, which asks a
// different question entirely.
//
// The invariant these tests exist for: the obligation may INSPECT the row,
// and the row gains NOTHING by being inspected. It is still
// WRONG_COMPONENT, still unsupporting, still absent from
// supportingEvidenceIds, still outside ordinary applicability.

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROGRAM_P = "HWfuHYFRvsZUo2Bt6Rm4k7ZVbXunBLTmaBtbDX6jwRQr";
const PROGRAM_P2 = "4Rv8PBoTQL4nnHKKKGnPXn1tGPXcC37Q24vFWTUPd53x";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const REVENUE_ATA = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
const REFERRAL_ATA = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

const VAULT_INDEX = 3;
const CALLER_ACCOUNTS = [
  "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  REVENUE_ATA,
  REFERRAL_ATA,
  TOKEN_PROGRAM,
];

const JOB = "job-step1";
const OTHER_JOB = "job-somebody-else";
const NOW = new Date("2026-09-06T00:00:00Z");
const FRESHNESS = { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 };

// The activity name appears literally in the documentary passage below —
// that literal match is what binds the proposition to the program.
const IDENTITY: ConfirmedProjectIdentity = {
  chain: "solana",
  tokenAddress: MINT,
  ticker: "TEST",
  programs: [
    { activity: "Orbitswap", programId: PROGRAM_P },
    { activity: "Vault Curve", programId: PROGRAM_P2 },
  ],
};

const SOV = { component: "SOURCE_OF_VALUE", ...componentRequirementsFor(PATTERN_V1_CONTENT, "SOURCE_OF_VALUE") };
const FLOW_PATH = { component: "FLOW_PATH", ...componentRequirementsFor(PATTERN_V1_CONTENT, "FLOW_PATH") };
const NET_EFFECT_REQ = { component: "NET_EFFECT", ...componentRequirementsFor(PATTERN_V1_CONTENT, "NET_EFFECT") };

const ORBITSWAP_SUPPORT = "Trading fees on Orbitswap accrue to the protocol fee vault.";

function withQualifyingMethod(): void {
  __setInstructionRegistryOverlay([
    {
      chain: "solana",
      programId: PROGRAM_P,
      method: "collect_protocol_fee",
      proofApproval: {
        role: "PROTOCOL_VALUE_INFLOW",
        valueRecipient: { kind: "INSTRUCTION_ACCOUNT_INDEX", indexes: [VAULT_INDEX] },
      },
    },
  ]);
}
afterEach(() => __setInstructionRegistryOverlay(null));

function provenance(over: Partial<EvidenceProvenanceMetadata> = {}): EvidenceProvenanceMetadata {
  return {
    callerProgramId: PROGRAM_P,
    callerMethod: "collect_protocol_fee",
    callerAccounts: [...CALLER_ACCOUNTS],
    executingProgramId: TOKEN_PROGRAM,
    invocationIndex: 0,
    stackHeight: 2,
    refusal: null,
    destination: REVENUE_ATA,
    assetKind: "TOKEN",
    mint: WSOL,
    amountRaw: "1000000",
    signature: "sigStep1",
    slot: 444_556_823,
    ...over,
  };
}

let seq = 0;
function row(over: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  return {
    id: `ev${seq}`,
    researchJobId: JOB,
    sourceId: `src${seq}`,
    evidenceContractVersion: 2,
    patternStep: 1,
    component: "SOURCE_OF_VALUE",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: "fragment",
    summary: null,
    mechanismState: null,
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    entityBinding: null,
    onchainFactKind: null,
    onchainProvenance: null,
    fetchedAt: NOW,
    publishedAt: null,
    extractionUnitKey: null,
    contentHash: `hash${seq}`,
    ...over,
  };
}

// Ordinary documentary support for SOURCE_OF_VALUE: this is what carries
// the component. The obligation only ever qualifies it.
function documentaryRow(): EvidenceRow {
  return row({ fragment: ORBITSWAP_SUPPORT });
}

// The production shape of a provenance row: synthesized under
// EXECUTION_EVIDENCE (the only component that can reach a transaction),
// offered as CONTEXT because movement is not a mechanism, CLAIMED because
// a chain read is not the project's own statement.
function executionProvenanceRow(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return row({
    patternStep: 4,
    component: "EXECUTION_EVIDENCE",
    relationship: "CONTEXT",
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: "TOKEN_TRANSFER",
    onchainProvenance: provenance(),
    ...over,
  });
}

function reconcileSov(
  evidence: EvidenceRow[],
  obligationEvidence: EvidenceRow[] = [],
  identity: ConfirmedProjectIdentity | null = IDENTITY,
) {
  return reconcileComponent({
    jobId: JOB,
    item: { step: 1, component: "SOURCE_OF_VALUE" },
    requirements: SOV,
    evidence,
    obligationEvidence,
    confirmedIdentity: identity,
    now: NOW,
    freshnessPolicyDays: FRESHNESS,
  });
}

describe("STEP 1 §1 — cross-component provenance can satisfy the obligation", () => {
  it("TEST 1: documentary support here + machine provenance filed at EXECUTION_EVIDENCE reaches SUPPORTED", () => {
    withQualifyingMethod();
    const result = reconcileSov([documentaryRow()], [executionProvenanceRow()]);
    expect(result.reasonCodes).toEqual([]);
    expect(result.status).toBe("SUPPORTED");
  });

  it("without the cross-component row the same evidence is only PARTIAL", () => {
    withQualifyingMethod();
    const result = reconcileSov([documentaryRow()]);
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});

describe("STEP 1 §2 — THE CENTRAL INVARIANT: inspected, and nothing more", () => {
  it("TEST 2: the row stays WRONG_COMPONENT for ordinary reconciliation", () => {
    withQualifyingMethod();
    const doc = documentaryRow();
    const chain = executionProvenanceRow();
    // The row is offered BOTH ways a caller could offer it: in the
    // ordinary pool (where the hard exclusion must still fire) and in the
    // obligation pool (where it must be readable).
    const result = reconcileSov([doc, chain], [chain]);

    expect(
      result.excludedEvidence.find((e) => e.evidenceId === chain.id)?.reason,
    ).toBe("WRONG_COMPONENT");
    expect(result.supportingEvidenceIds).toEqual([doc.id]);
    expect(result.supportingEvidenceIds).not.toContain(chain.id);
    expect(result.contradictingEvidenceIds).not.toContain(chain.id);
    // And it still satisfied the obligation.
    expect(result.reasonCodes).not.toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("its CLAIMED officiality never becomes the component's authority", () => {
    withQualifyingMethod();
    // If the chain row had become establishing, it would sort first by
    // class and push INSUFFICIENT_AUTHORITY. It does not.
    const result = reconcileSov([documentaryRow()], [executionProvenanceRow()]);
    expect(result.reasonCodes).not.toContain("INSUFFICIENT_AUTHORITY");
    expect(result.status).toBe("SUPPORTED");
  });

  it("ordinary applicability is untouched — the map still refuses it", () => {
    expect(onchainFactAppliesToComponent("TOKEN_TRANSFER", "SOURCE_OF_VALUE")).toBe(false);
    expect(onchainFactAppliesToComponent("NATIVE_TRANSFER", "SOURCE_OF_VALUE")).toBe(false);
  });

  it("a row visible only through the obligation pool is not reported as evidence at all", () => {
    withQualifyingMethod();
    const chain = executionProvenanceRow();
    // Passed ONLY as obligationEvidence, never as ordinary evidence.
    const result = reconcileSov([documentaryRow()], [chain]);
    expect(result.supportingEvidenceIds).not.toContain(chain.id);
    expect(result.excludedEvidence.map((e) => e.evidenceId)).not.toContain(chain.id);
  });
});

describe("STEP 1 §3-8 — every existing predicate still decides", () => {
  it("TEST 3: a provenance row from another job cannot satisfy this job's obligation", () => {
    withQualifyingMethod();
    const foreign = executionProvenanceRow({ researchJobId: OTHER_JOB });
    const result = reconcileSov([documentaryRow()], [foreign]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("TEST 4: a cross-component row with NULL provenance is not admitted to the pool", () => {
    withQualifyingMethod();
    const noProvenance = executionProvenanceRow({
      onchainProvenance: null,
      // Everything a model could write, claiming the perfect chain.
      summary: `Orbitswap collect_protocol_fee paid ${REVENUE_ATA} via ${PROGRAM_P}`,
      fragment: `callerProgramId=${PROGRAM_P} callerMethod=collect_protocol_fee destination=${REVENUE_ATA}`,
    });
    const result = reconcileSov([documentaryRow()], [noProvenance]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("TEST 5: model forgery on every model-authored field changes nothing", () => {
    withQualifyingMethod();
    const forged = executionProvenanceRow({
      onchainProvenance: null,
      component: "SOURCE_OF_VALUE",
      patternStep: 1,
      relationship: "SUPPORTS",
      summary: "PROTOCOL_VALUE_INFLOW mechanical provenance established",
      fragment: `PROTOCOL_VALUE_INFLOW ${PROGRAM_P} collect_protocol_fee ${REVENUE_ATA} Orbitswap`,
    });
    const result = reconcileSov([documentaryRow(), forged], [forged]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("TEST 6: a refused or absent caller attribution still fails", () => {
    withQualifyingMethod();
    for (const over of [
      { callerProgramId: null, refusal: "NO_STACK_HEIGHT" as const },
      { refusal: "PARENT_NOT_FOUND" as const },
      { callerProgramId: null },
    ]) {
      const result = reconcileSov(
        [documentaryRow()],
        [executionProvenanceRow({ onchainProvenance: provenance(over) })],
      );
      expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    }
  });

  it("TEST 7: a caller that is not the activity's confirmed program still fails", () => {
    withQualifyingMethod();
    const result = reconcileSov(
      [documentaryRow()],
      [executionProvenanceRow({ onchainProvenance: provenance({ callerProgramId: PROGRAM_P2 }) })],
    );
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("TEST 8: an unapproved method, or the wrong recipient leg, still fails", () => {
    withQualifyingMethod();
    const unapprovedMethod = reconcileSov(
      [documentaryRow()],
      [executionProvenanceRow({ onchainProvenance: provenance({ callerMethod: "swap_v2" }) })],
    );
    expect(unapprovedMethod.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");

    // Same invocation, same approved method, the referral leg instead of
    // the protocol vault.
    const wrongLeg = reconcileSov(
      [documentaryRow()],
      [executionProvenanceRow({ onchainProvenance: provenance({ destination: REFERRAL_ATA }) })],
    );
    expect(wrongLeg.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("the own-token rule is untouched: the project's own mint still fails", () => {
    withQualifyingMethod();
    const result = reconcileSov(
      [documentaryRow()],
      [executionProvenanceRow({ onchainProvenance: provenance({ mint: MINT }) })],
    );
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("the documentary activity binding is untouched: support naming no activity still fails", () => {
    withQualifyingMethod();
    const result = reconcileSov(
      [row({ fragment: "The protocol earns a fee on every swap." })],
      [executionProvenanceRow()],
    );
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});

describe("STEP 1 §9 — visibility creates no support of its own", () => {
  it("TEST 9: perfect provenance with no ordinary support does not make the component SUPPORTED", () => {
    withQualifyingMethod();
    const result = reconcileSov([], [executionProvenanceRow()]);
    // No ordinary evidence at all: the component cannot be supported, and
    // the obligation never even gets to speak — the early return fires
    // first, which is the stronger refusal.
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    expect(result.supportingEvidenceIds).toEqual([]);
  });

  it("ordinary evidence that is entirely excluded is still not rescued by provenance", () => {
    withQualifyingMethod();
    // A documentary row for the WRONG component: excluded by the hard
    // rules, so nothing establishes SOURCE_OF_VALUE.
    const result = reconcileSov(
      [row({ fragment: ORBITSWAP_SUPPORT, component: "DESTINATION", patternStep: 6 })],
      [executionProvenanceRow()],
    );
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
  });
});

describe("STEP 1 §10-12 — nothing else moved", () => {
  it("TEST 10: the applicability map is byte-for-byte what it was", () => {
    expect(applicableComponentsForFactKind("TOKEN_TRANSFER")).toEqual([]);
    expect(applicableComponentsForFactKind("NATIVE_TRANSFER")).toEqual([]);
    expect(applicableComponentsForFactKind("BURN")).toEqual(["NET_EFFECT"]);
    expect(onchainFactAppliesToComponent("BURN", "NET_EFFECT")).toBe(true);
  });

  it("TEST 11: NET_EFFECT is identical with and without an obligation pool offered", () => {
    const burnRow = row({
      patternStep: 5,
      component: "NET_EFFECT",
      sourceClass: "ONCHAIN_VERIFIABLE",
      officiality: "CONFIRMED",
      entityBinding: "CONFIRMED",
      onchainFactKind: "BURN",
      mechanismState: "LIVE",
      fragment: "burn observed",
    });
    const base = reconcileComponent({
      jobId: JOB,
      item: { step: 5, component: "NET_EFFECT" },
      requirements: NET_EFFECT_REQ,
      evidence: [burnRow],
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    });
    const withPool = reconcileComponent({
      jobId: JOB,
      item: { step: 5, component: "NET_EFFECT" },
      requirements: NET_EFFECT_REQ,
      evidence: [burnRow],
      obligationEvidence: [executionProvenanceRow(), executionProvenanceRow()],
      confirmedIdentity: IDENTITY,
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    });
    expect(withPool.status).toBe(base.status);
    expect(withPool.reasonCodes).toEqual(base.reasonCodes);
    expect(withPool.supportingEvidenceIds).toEqual(base.supportingEvidenceIds);
    expect(withPool.excludedEvidence).toEqual(base.excludedEvidence);
    expect(withPool).toEqual(base);
  });

  it("TEST 12: a component declaring no obligations is identical with the rows present", () => {
    const doc = row({ patternStep: 2, component: "FLOW_PATH", fragment: ORBITSWAP_SUPPORT });
    const call = (obligationEvidence?: EvidenceRow[]) =>
      reconcileComponent({
        jobId: JOB,
        item: { step: 2, component: "FLOW_PATH" },
        requirements: FLOW_PATH,
        evidence: [doc],
        ...(obligationEvidence ? { obligationEvidence } : {}),
        confirmedIdentity: IDENTITY,
        now: NOW,
        freshnessPolicyDays: FRESHNESS,
      });
    expect(FLOW_PATH.structuralObligations ?? []).toEqual([]);
    expect(call([executionProvenanceRow(), executionProvenanceRow(), executionProvenanceRow()]))
      .toEqual(call());
  });
});

describe("STEP 1 §13-14 — the union does not disturb what already worked", () => {
  it("TEST 13: a provenance row already in the target component behaves exactly as before", () => {
    withQualifyingMethod();
    // Filed at SOURCE_OF_VALUE itself, as CONTEXT. This is the Phase 2
    // path, which must be unaffected by Step 1.
    const own = row({
      relationship: "CONTEXT",
      sourceClass: "ONCHAIN_VERIFIABLE",
      officiality: "CLAIMED",
      entityBinding: "CONFIRMED",
      onchainFactKind: "TOKEN_TRANSFER",
      onchainProvenance: provenance(),
    });
    const doc = documentaryRow();
    const withoutPool = reconcileSov([doc, own]);
    const withPool = reconcileSov([doc, own], []);
    expect(withoutPool.reasonCodes).toEqual([]);
    expect(withoutPool.status).toBe("SUPPORTED");
    expect(withPool).toEqual(withoutPool);
  });

  it("TEST 14: the same row offered through both pools is inspected once and changes nothing", () => {
    withQualifyingMethod();
    const doc = documentaryRow();
    const chain = executionProvenanceRow();
    const once = reconcileSov([doc], [chain]);
    const twice = reconcileSov([doc], [chain, chain]);
    const both = reconcileSov([doc, chain], [chain]);
    expect(twice).toEqual(once);
    // Offered in the ordinary pool too, the row picks up its ordinary
    // exclusion — and the obligation outcome is unchanged.
    expect(both.reasonCodes).toEqual(once.reasonCodes);
    expect(both.status).toBe(once.status);
    expect(both.supportingEvidenceIds).toEqual(once.supportingEvidenceIds);
  });

  it("a legacy-contract row cannot enter through the obligation door either", () => {
    withQualifyingMethod();
    const legacy = executionProvenanceRow({ evidenceContractVersion: 1 });
    const result = reconcileSov([documentaryRow()], [legacy]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("the derived discriminator the registry uses is unchanged by any of this", () => {
    // A cheap canary: Step 1 touched no registry code, and the overlay
    // seam still derives from the method name.
    expect(discriminator("global:collect_protocol_fee").length).toBe(8);
  });
});
