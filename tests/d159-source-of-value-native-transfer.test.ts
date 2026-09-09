import { afterEach, describe, expect, it } from "vitest";

import { reconcileComponent, type EvidenceRow } from "../src/server/engine/component-reconciler";
import {
  __setInstructionRegistryOverlay,
} from "../src/server/engine/onchain-instruction-registry";
import {
  establishableComponentsForFactKind,
  onchainFactCanEstablishComponent,
} from "../src/server/engine/onchain-facts";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import type { EvidenceProvenanceMetadata } from "../src/server/engine/onchain-invocation-provenance";

// D-159 DID NOT OVER-TIGHTEN SOURCE_OF_VALUE.
//
// D-159 gave every deterministic chain observation a TOPICAL FITNESS gate:
// a kind may only establish a component its own doesNotProve says it can
// answer. `NATIVE_TRANSFER` was granted FLOW_PATH and nothing else, while
// `TOKEN_TRANSFER` was granted SOURCE_OF_VALUE explicitly so that D-158's
// mechanical-provenance obligation would stay clearable.
//
// THAT ASYMMETRY IS THE RISK THIS FILE EXISTS TO MEASURE. A protocol whose
// value arrives as NATIVE SOL — a fee swept in lamports rather than in a
// wrapped or SPL asset — produces an attributed `NATIVE_TRANSFER`, not an
// attributed `TOKEN_TRANSFER`. If D-158's obligation could only ever be
// satisfied by a row the D-159 map lets ESTABLISH, then SOURCE_OF_VALUE
// would have become permanently unreachable for every native-fee protocol
// on 2026-09-08, silently, with no reason code saying so.
//
// It did not, and the reason is a placement decision D-159 states in its
// own comments: the fitness gate runs at establishment classification,
// AFTER `survivingAfterHard` is taken, so a CONTEXT chain row carrying
// machine-owned provenance still reaches the structural-obligation pool.
// The obligation's two halves read two DIFFERENT pools, and only the first
// is restricted:
//
//   STEP 1 (which activity is the support about?) — establishing rows only.
//   STEP 2 (is there mechanical provenance for it?) — the whole pool.
//
// So documentation establishes the proposition, the transfer proves the
// mechanics, and the transfer never becomes an economic conclusion. These
// tests hold that separation in place from both sides.

const MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const REVENUE_PROGRAM = "HWfuHYFRvsZUo2Bt6Rm4k7ZVbXunBLTmaBtbDX6jwRQr";
const SECOND_ACTIVITY_PROGRAM = "4Rv8PBoTQL4nnHKKKGnPXn1tGPXcC37Q24vFWTUPd53x";
const REVENUE_ACCOUNT = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
const REFERRAL_ACCOUNT = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const PROTOCOL_VAULT_INDEX = 3;
const CALLER_ACCOUNTS = [
  "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  REVENUE_ACCOUNT,
  REFERRAL_ACCOUNT,
  TOKEN_PROGRAM,
];

const IDENTITY: ConfirmedProjectIdentity = {
  chain: "solana",
  tokenAddress: MINT,
  ticker: "PUMP",
  programs: [
    { activity: "Orbitswap", programId: REVENUE_PROGRAM },
    { activity: "Vault Curve", programId: SECOND_ACTIVITY_PROGRAM },
  ],
};

const SOV = componentRequirementsFor(PATTERN_V1_CONTENT, "SOURCE_OF_VALUE");
const REQUIREMENTS = { component: "SOURCE_OF_VALUE", ...SOV };

const ORBITSWAP_SUPPORT = "Trading fees on Orbitswap accrue to the protocol fee vault.";

// A NATIVE movement, in the shape `toEvidenceProvenance` actually writes
// one: `assetKind: "NATIVE_SOL"` and `mint: null`, because a lamport
// movement has no mint to record.
function nativeProvenance(
  over: Partial<EvidenceProvenanceMetadata> = {},
): EvidenceProvenanceMetadata {
  return {
    callerProgramId: REVENUE_PROGRAM,
    callerMethod: "collect_protocol_fee",
    executingProgramId: "11111111111111111111111111111111",
    callerAccounts: [...CALLER_ACCOUNTS],
    invocationIndex: 0,
    stackHeight: 2,
    refusal: null,
    destination: REVENUE_ACCOUNT,
    assetKind: "NATIVE_SOL",
    mint: null,
    amountRaw: "850140914",
    signature: "sigNativeRevenue",
    slot: 444414083,
    ...over,
  };
}

let seq = 0;
function row(over: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  return {
    id: `d159ev${seq}`,
    researchJobId: "job1",
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
    fetchedAt: new Date("2026-09-01T00:00:00Z"),
    publishedAt: null,
    extractionUnitKey: null,
    contentHash: `d159hash${seq}`,
    ...over,
  };
}

// (1) The documentary side: valid, ordinary, and it LITERALLY names a
// human-confirmed activity. This is the row that establishes the
// proposition, and D-159 leaves it untouched — its kind is null.
function documentaryRow(): EvidenceRow {
  return row({
    fragment: ORBITSWAP_SUPPORT,
    sourceClass: "OFFICIAL_DOCS",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    officiality: "CONFIRMED",
  });
}

// (2) The chain side: exactly what production writes for an ATTRIBUTED
// native transfer — kind NATIVE_TRANSFER, relationship CONTEXT, officiality
// CLAIMED, entity binding CONFIRMED, provenance attached.
function nativeTransferRow(
  meta: EvidenceProvenanceMetadata = nativeProvenance(),
  over: Partial<EvidenceRow> = {},
): EvidenceRow {
  return row({
    relationship: "CONTEXT",
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: "NATIVE_TRANSFER",
    onchainProvenance: meta,
    ...over,
  });
}

function reconcile(evidence: EvidenceRow[], identity: ConfirmedProjectIdentity | null = IDENTITY) {
  return reconcileComponent({
    jobId: "job1",
    item: { step: 1, component: "SOURCE_OF_VALUE" },
    requirements: REQUIREMENTS,
    evidence,
    confirmedIdentity: identity,
    now: new Date("2026-09-05T00:00:00Z"),
    freshnessPolicyDays: { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 },
  });
}

function withQualifyingMethod(indexes: readonly number[] = [PROTOCOL_VAULT_INDEX]): void {
  __setInstructionRegistryOverlay([
    {
      chain: "solana",
      programId: REVENUE_PROGRAM,
      method: "collect_protocol_fee",
      proofApproval: {
        role: "PROTOCOL_VALUE_INFLOW",
        valueRecipient: { kind: "INSTRUCTION_ACCOUNT_INDEX", indexes },
      },
    },
  ]);
}

afterEach(() => {
  __setInstructionRegistryOverlay(null);
});

/* ------------------------------------------------------------------ *
 * §1 — THE PREMISE. The gate really is closed for NATIVE_TRANSFER.
 * ------------------------------------------------------------------ */

describe("D-159 §1 — NATIVE_TRANSFER genuinely cannot establish SOURCE_OF_VALUE", () => {
  // If this ever flips to true, the rest of this file is testing nothing:
  // the scenario would be satisfied the easy way, by establishment, and the
  // separation it guards would have quietly stopped existing.
  it("the map refuses it, while TOKEN_TRANSFER is granted it", () => {
    expect(onchainFactCanEstablishComponent("NATIVE_TRANSFER", "SOURCE_OF_VALUE")).toBe(false);
    expect(onchainFactCanEstablishComponent("TOKEN_TRANSFER", "SOURCE_OF_VALUE")).toBe(true);
    expect(establishableComponentsForFactKind("NATIVE_TRANSFER")).toEqual(["FLOW_PATH"]);
  });

  // D-159's null-kind escape hatch is what keeps the PROPOSITION side of the
  // join working. Documentary rows have no typed kind and are unrestricted.
  it("the documentary row that carries the proposition is untouched by the gate", () => {
    expect(onchainFactCanEstablishComponent(null, "SOURCE_OF_VALUE")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * §2 — THE SCENARIO. All four conditions at once.
 * ------------------------------------------------------------------ */

describe("D-159 §2 — documentation establishes, a native transfer proves the mechanics", () => {
  // THE LOAD-BEARING TEST. Conditions 1-4 of the safety check, together:
  // valid documentary support naming a confirmed activity; a real
  // attributable NATIVE_TRANSFER from that same activity; the transfer
  // non-establishing; and the obligation nonetheless satisfied.
  it("SOURCE_OF_VALUE reaches SUPPORTED with no reason codes", () => {
    withQualifyingMethod();
    const result = reconcile([documentaryRow(), nativeTransferRow()]);
    expect(result.reasonCodes).toEqual([]);
    expect(result.status).toBe("SUPPORTED");
  });

  // CONDITION 3, ASSERTED POSITIVELY. The transfer supplied a machine
  // condition; it did not become an economic conclusion. It is not
  // supporting evidence, and its CLAIMED officiality never became the
  // component's authority.
  it("the transfer stays CONTEXT and never becomes support", () => {
    withQualifyingMethod();
    const doc = documentaryRow();
    const chain = nativeTransferRow();
    const result = reconcile([doc, chain]);

    expect(result.supportingEvidenceIds).toEqual([doc.id]);
    expect(result.supportingEvidenceIds).not.toContain(chain.id);
    expect(result.excludedEvidence.find((e) => e.evidenceId === chain.id)?.reason).toBe(
      "RELATIONSHIP_NOT_SUPPORTING",
    );
    expect(result.reasonCodes).not.toContain("INSUFFICIENT_AUTHORITY");
  });

  // NEGATIVE CONTROL A. The gate is not merely always-green: remove the
  // chain row and the obligation is unmet again.
  it("the documentary row alone is still PARTIAL", () => {
    withQualifyingMethod();
    const result = reconcile([documentaryRow()]);
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  // NEGATIVE CONTROL B. The transfer alone carries no component. Widening
  // the obligation pool gave it sight, not a voice.
  it("the native transfer alone establishes nothing at all", () => {
    withQualifyingMethod();
    const result = reconcile([nativeTransferRow()]);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
  });

  // NEGATIVE CONTROL C. The native asset must still come from the activity
  // the documentary support NAMED. A different confirmed program of the
  // same project is a different activity, and does not qualify.
  it("a native transfer from the project's OTHER activity does not qualify", () => {
    withQualifyingMethod();
    const result = reconcile([
      documentaryRow(),
      nativeTransferRow(nativeProvenance({ callerProgramId: SECOND_ACTIVITY_PROGRAM })),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  // NEGATIVE CONTROL D. The leg check is asset-blind: a native transfer to
  // the referral account of the same qualifying invocation shares the
  // program, the method and the asset, and is still not protocol value.
  it("the referral leg of the same native invocation does not qualify", () => {
    withQualifyingMethod();
    const result = reconcile([
      documentaryRow(),
      nativeTransferRow(nativeProvenance({ destination: REFERRAL_ACCOUNT })),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  // NATIVE SOL IS EXTERNAL VALUE BY CONSTRUCTION. Condition (7) rejects a
  // movement of the project's OWN mint; a lamport movement has no mint, so
  // it can never be the project's own token and is never filtered here.
  it("a native movement is never mistaken for the project's own token", () => {
    withQualifyingMethod();
    const result = reconcile([
      documentaryRow(),
      nativeTransferRow(nativeProvenance({ mint: MINT })),
    ]);
    // Even with a mint field wrongly populated, assetKind NATIVE_SOL means
    // condition (7) does not fire — it tests assetKind === "TOKEN".
    expect(result.status).toBe("SUPPORTED");
  });
});

/* ------------------------------------------------------------------ *
 * §3 — THE PLACEMENT DECISION, TESTED DIRECTLY.
 * ------------------------------------------------------------------ */

describe("D-159 §3 — the fitness gate removes establishment, never the provenance", () => {
  // THE SHARPEST FORM OF CONDITION 4. Here the extractor labels the native
  // transfer SUPPORTS/DIRECT, so D-159's gate fires on it BY NAME and
  // strips it from establishment with FACT_KIND_CANNOT_ESTABLISH.
  //
  // The obligation must STILL be satisfied by that same row. This is what
  // proves the gate runs after `survivingAfterHard` is taken rather than in
  // the hard-exclusion pass — and it is the exact regression that would
  // have made SOURCE_OF_VALUE unreachable had the gate been placed earlier.
  it("a SUPPORTS-labelled native transfer is stripped, and still clears the obligation", () => {
    withQualifyingMethod();
    const doc = documentaryRow();
    const chain = nativeTransferRow(nativeProvenance(), {
      relationship: "SUPPORTS",
      directness: "DIRECT",
    });
    const result = reconcile([doc, chain]);

    // Stripped from establishment, by the D-159 gate specifically.
    expect(result.excludedEvidence.find((e) => e.evidenceId === chain.id)?.reason).toBe(
      "FACT_KIND_CANNOT_ESTABLISH",
    );
    expect(result.supportingEvidenceIds).toEqual([doc.id]);
    // And yet the machine-owned provenance still did its work.
    expect(result.reasonCodes).toEqual([]);
    expect(result.status).toBe("SUPPORTED");
  });

  // THE TWO POOLS ARE NOT THE SAME POOL, AND STEP 1 IS THE RESTRICTED ONE.
  //
  // Here the documentary support names NO confirmed activity, while the
  // D-159-stripped native transfer's own fragment names Orbitswap. There IS
  // establishing evidence, so the obligation genuinely runs — and it must
  // still refuse, because the row that names the activity is not the row
  // that carries the component.
  //
  // This is the boundary of what §3's first test proved: a stripped row may
  // supply PROVENANCE (step 2) and may never supply the PROPOSITION
  // (step 1). Were it able to do both, an on-chain movement would be
  // deciding what the component is about, which is the co-presence reading
  // D-158 exists to remove.
  it("the stripped row supplies provenance but can never bind the activity", () => {
    withQualifyingMethod();
    const doc = row({ fragment: "The protocol earns fees from its products." });
    const chain = nativeTransferRow(nativeProvenance(), {
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: ORBITSWAP_SUPPORT,
    });
    const result = reconcile([doc, chain]);

    expect(result.excludedEvidence.find((e) => e.evidenceId === chain.id)?.reason).toBe(
      "FACT_KIND_CANNOT_ESTABLISH",
    );
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
  });
});

/* ------------------------------------------------------------------ *
 * §4 — RECIPROCAL_ASSET_FLOW REMAINS CONTEXT, AND PROVES NO CAUSALITY.
 * ------------------------------------------------------------------ */

describe("D-159 §4 — two movements in one transaction still prove nothing", () => {
  it("the kind establishes nothing, for any component", () => {
    expect(establishableComponentsForFactKind("RECIPROCAL_ASSET_FLOW")).toEqual([]);
    for (const component of ["SOURCE_OF_VALUE", "FLOW_PATH", "EXECUTION_EVIDENCE", "RECIPIENT"]) {
      expect(
        onchainFactCanEstablishComponent("RECIPROCAL_ASSET_FLOW", component),
        component,
      ).toBe(false);
    }
  });

  // Mislabelled SUPPORTS, it is refused by name rather than by relationship.
  it("a SUPPORTS-labelled pairing is refused at SOURCE_OF_VALUE", () => {
    withQualifyingMethod();
    const pairing = row({
      relationship: "SUPPORTS",
      directness: "DIRECT",
      sourceClass: "ONCHAIN_VERIFIABLE",
      officiality: "CLAIMED",
      entityBinding: "CONFIRMED",
      onchainFactKind: "RECIPROCAL_ASSET_FLOW",
    });
    const result = reconcile([pairing]);
    expect(result.excludedEvidence.find((e) => e.evidenceId === pairing.id)?.reason).toBe(
      "FACT_KIND_CANNOT_ESTABLISH",
    );
    expect(result.status).not.toBe("SUPPORTED");
  });

  // CO-PRESENCE IS NOT ATTRIBUTION. Production never attaches provenance to
  // a reciprocal-flow row — the pairing is derived from balance deltas, not
  // from invocation structure — so it reaches the obligation pool carrying
  // nothing the obligation can read. Batching two unrelated transfers into
  // one transaction therefore cannot manufacture a causal conclusion.
  it("a pairing with no machine-owned provenance cannot satisfy the obligation", () => {
    withQualifyingMethod();
    const pairing = row({
      relationship: "CONTEXT",
      sourceClass: "ONCHAIN_VERIFIABLE",
      officiality: "CLAIMED",
      entityBinding: "CONFIRMED",
      onchainFactKind: "RECIPROCAL_ASSET_FLOW",
      onchainProvenance: null,
    });
    const result = reconcile([documentaryRow(), pairing]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
  });

  // And the refusal is recorded, never guessed around: an attribution the
  // CPI structure could not prove is unmet even though the movement is real
  // and lands in exactly the right account.
  it("a refused attribution on a native transfer is never guessed into a pass", () => {
    withQualifyingMethod();
    const result = reconcile([
      documentaryRow(),
      nativeTransferRow(
        nativeProvenance({ refusal: "NO_STACK_HEIGHT", callerProgramId: null }),
      ),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});
