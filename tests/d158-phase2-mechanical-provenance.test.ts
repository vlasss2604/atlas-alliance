import { afterEach, describe, expect, it } from "vitest";

import { reconcileComponent, type EvidenceRow } from "../src/server/engine/component-reconciler";
import {
  __setInstructionRegistryOverlay,
  discriminator,
  KNOWN_INSTRUCTION_METHODS,
  proofApprovalForMethod,
} from "../src/server/engine/onchain-instruction-registry";
import {
  deriveTransferProvenance,
  toEvidenceProvenance,
} from "../src/server/engine/onchain-invocation-provenance";
import type { TransactionDetailResult } from "../src/server/engine/providers/onchain-types";
import { evaluateStructuralObligations } from "../src/server/engine/structural-obligation";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import type { EvidenceProvenanceMetadata } from "../src/server/engine/onchain-invocation-provenance";

// D-158 PHASE 2 — SOURCE_OF_VALUE CANNOT GO GREEN ON DOCUMENTARY EVIDENCE.
//
// The live PUMP job reached SOURCE_OF_VALUE = SUPPORTED from four
// OFFICIAL_DOCS sentences that all described how revenue is ALLOCATED,
// while the component's evidenceGoal asks what PRODUCES it. Class, polarity
// and directness cannot separate those propositions. A machine-owned
// provenance obligation can, and every fixture here is built from fields no
// model can author.
//
// The positive control is the load-bearing test: a gate that is always
// PARTIAL would satisfy every negative case and be worthless.

const MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
// FIXTURE PROGRAMS ARE SYNTHETIC, AND THAT IS THE POINT.
//
// A test that names a REAL program under an activity label states a
// real-world mapping nobody confirmed. These addresses are valid Solana
// pubkeys derived from fixed strings, belong to no deployed program, and
// carry no claim about any project. The activity names below are
// fictional for the same reason.
//
// The one real program id in this file is RAYDIUM_CLMM, and it appears in
// exactly one test — the one asserting what the SHIPPED registry says
// about it, where a synthetic address would assert nothing.
const REVENUE_PROGRAM = "HWfuHYFRvsZUo2Bt6Rm4k7ZVbXunBLTmaBtbDX6jwRQr";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const OTHER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const UNCONFIRMED_PROGRAM = "BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi";
const WSOL = "So11111111111111111111111111111111111111112";
const REVENUE_ACCOUNT = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
// Paid by the SAME instruction, in the same asset, caused by the same
// program under the same method — and not protocol value receipt.
const REFERRAL_ACCOUNT = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// The invoking instruction's own account list, in the order the program is
// handed it. The IDL position — not a name, not prose — is what identifies
// the protocol's vault, and index 4 holds an account that is paid by the
// same instruction and is NOT it.
const PROTOCOL_VAULT_INDEX = 3;
const CALLER_ACCOUNTS = [
  "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  REVENUE_ACCOUNT,
  REFERRAL_ACCOUNT,
  TOKEN_PROGRAM,
];

// TWO confirmed activities, because one activity cannot show the
// difference between "a confirmed program of this project" and "the
// confirmed program of the activity the support is about".
const SECOND_ACTIVITY_PROGRAM = "4Rv8PBoTQL4nnHKKKGnPXn1tGPXcC37Q24vFWTUPd53x";
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

function provenance(over: Partial<EvidenceProvenanceMetadata> = {}): EvidenceProvenanceMetadata {
  return {
    callerProgramId: REVENUE_PROGRAM,
    callerMethod: "collect_protocol_fee",
    executingProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    callerAccounts: [...CALLER_ACCOUNTS],
    invocationIndex: 0,
    stackHeight: 2,
    refusal: null,
    destination: REVENUE_ACCOUNT,
    assetKind: "TOKEN",
    mint: WSOL,
    amountRaw: "1000000",
    signature: "sigRevenue",
    slot: 444414083,
    ...over,
  };
}

// The proposition side of the join, in the shape production writes it:
// ordinary documentary support whose LITERAL passage names a confirmed
// activity. Declared once because nearly every positive case needs it.
const ORBITSWAP_SUPPORT = "Trading fees on Orbitswap accrue to the protocol fee vault.";

let seq = 0;
function row(over: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  return {
    id: `ev${seq}`,
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
    contentHash: `hash${seq}`,
    ...over,
  };
}

// The four verbatim documentary rows from the live PUMP job, each labelled
// by the model exactly as it labelled them there.
function pumpDocumentaryRows(): EvidenceRow[] {
  return [
    "50% of protocol revenue is allocated to token buybacks.",
    "Half of every dollar Pump.fun earns buys $PUMP on the open market, then burns it forever.",
    "As of 28 Apr 2026, 50% of revenue is programmatically locked and allocated to be burned for one year.",
    "Total bought back and burnt $448.19M / 164.16B $PUMP burned / Total supply offset 16.416%",
  ].map((fragment) => row({ fragment }));
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

// The positive control needs a method carrying the inflow approval. No
// such program has been independently confirmed for this repository, and
// inventing one in production data to make a test pass would be the worst
// possible reason to add a registry entry — so the overlay seam is used.
//
// An approval names BOTH what the method may help prove and which of its
// accounts receives protocol value. The second half is what stops a
// referral leg of the same invocation from qualifying.
function withQualifyingMethod(
  indexes: readonly number[] = [PROTOCOL_VAULT_INDEX],
): void {
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

// The two halves of the join, as the reducer would hand them over.
function supportView(fragment: string) {
  return {
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED" as const,
    entityBinding: null,
    onchainProvenance: null,
    establishesComponent: true,
    supportFragment: fragment,
  };
}

function provenanceView(meta: EvidenceProvenanceMetadata) {
  return {
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED" as const,
    entityBinding: "CONFIRMED" as const,
    onchainProvenance: meta,
    // CONTEXT in production: it supplies a machine condition, never support.
    establishesComponent: false,
    supportFragment: null,
  };
}

afterEach(() => __setInstructionRegistryOverlay(null));

describe("D-158 P2 §A — the historical PUMP false green is structurally impossible", () => {
  it("TEST A: the four documentary rows cannot make SOURCE_OF_VALUE SUPPORTED", () => {
    const result = reconcile(pumpDocumentaryRows());
    expect(result.status).not.toBe("SUPPORTED");
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    // The documentary rows are still CREDITED — they say what the project
    // claims. What they cannot do is carry the causal component.
    expect(result.supportingEvidenceIds.length).toBeGreaterThan(0);
  });

  it("holds even when the model labels every row perfectly for the component", () => {
    // Every row SUPPORTS/DIRECT/OFFICIAL_DOCS/CONFIRMED, i.e. the best a
    // model can possibly assert. The gate does not read any of that.
    const rows = pumpDocumentaryRows();
    for (const r of rows) {
      expect(r.relationship).toBe("SUPPORTS");
      expect(r.directness).toBe("DIRECT");
    }
    expect(reconcile(rows).status).not.toBe("SUPPORTED");
  });
});

describe("D-158 P2 §B — a stronger source pair still cannot prove the causal origin", () => {
  it("TEST B: OFFICIAL_DOCS allocation + DATA_PROVIDER revenue total is not SUPPORTED", () => {
    const rows = [
      row({ fragment: "50% of protocol revenue is allocated to token buybacks." }),
      row({
        fragment: "The protocol generated $100M of total revenue.",
        sourceClass: "DATA_PROVIDER",
        officiality: "CLAIMED",
      }),
    ];
    const result = reconcile(rows);
    expect(result.status).not.toBe("SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("an OFFICIAL_REPORT revenue total alone is equally insufficient — and refused EARLIER", () => {
    // OFFICIAL_REPORT is not in SOURCE_OF_VALUE's establishingClasses, so
    // the ORDINARY rules exclude the row before any obligation is reached.
    // The outcome is stronger than an unmet obligation, not weaker: there
    // is nothing to partially support, so the component is INSUFFICIENT.
    const result = reconcile([
      row({
        fragment: "The protocol generated $100M of total revenue.",
        sourceClass: "OFFICIAL_REPORT",
      }),
    ]);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
  });
});

describe("D-158 P2 §C-G — every structural condition is load-bearing", () => {
  function onchainRow(p: EvidenceProvenanceMetadata): EvidenceRow {
    return row({
      sourceClass: "ONCHAIN_VERIFIABLE",
      officiality: "CLAIMED",
      entityBinding: "CONFIRMED",
      onchainFactKind: "TOKEN_TRANSFER",
      onchainProvenance: p,
    });
  }

  it("TEST C: co-presence — an unattributed transfer never satisfies it", () => {
    withQualifyingMethod();
    const result = reconcile([
      onchainRow(provenance({ callerProgramId: null, refusal: "NO_STACK_HEIGHT" })),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("TEST D: correct program, method with no approved role", () => {
    // No overlay. This assertion is about the REAL shipped registry entry —
    // Raydium CLMM's swap_v2, which carries no approval because a swap is
    // not protocol inflow — so it uses the real program id deliberately.
    expect(proofApprovalForMethod("solana", RAYDIUM_CLMM, "swap_v2")).toBeNull();
    // The fixture program then stands in for "a confirmed program of this
    // project whose method has no approval".
    const result = reconcile([onchainRow(provenance({ callerMethod: "swap_v2" }))]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("TEST E: the qualifying method name under an unconfirmed program", () => {
    withQualifyingMethod();
    const result = reconcile([
      onchainRow(provenance({ callerProgramId: UNCONFIRMED_PROGRAM })),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("a confirmed program of ANOTHER project is not this project's activity", () => {
    withQualifyingMethod();
    const result = reconcile([onchainRow(provenance({ callerProgramId: OTHER_PROGRAM }))]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("TEST F: movement of the project's OWN token is not external value inflow", () => {
    // This is what stops a buyback or a burn from reading as revenue.
    withQualifyingMethod();
    const result = reconcile([onchainRow(provenance({ mint: MINT }))]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("TEST G: a refused/unknown CPI attribution is never guessed into a pass", () => {
    withQualifyingMethod();
    for (const refusal of [
      "NO_STACK_HEIGHT",
      "NO_PARENT_INDEX",
      "PARENT_NOT_FOUND",
      "NO_ENCLOSING_INVOCATION",
      "INCONSISTENT_DEPTH",
    ] as const) {
      const result = reconcile([onchainRow(provenance({ refusal }))]);
      expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    }
  });

  it("an unbound on-chain row cannot satisfy it — D-134 excludes it first", () => {
    // entityBinding UNVERIFIED is already fatal at the ordinary
    // establishment gate (ENTITY_NOT_CONFIRMED), so the row never reaches
    // the obligation. Asserted as the earlier refusal it actually is
    // rather than restated as an obligation failure it is not.
    withQualifyingMethod();
    const result = reconcile([
      row({
        sourceClass: "ONCHAIN_VERIFIABLE",
        officiality: "CLAIMED",
        entityBinding: "UNVERIFIED",
        onchainProvenance: provenance(),
      }),
    ]);
    expect(result.status).not.toBe("SUPPORTED");
    expect(result.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
    // And directly: the obligation itself refuses an unbound row too,
    // even alongside support that binds the activity correctly.
    expect(
      evaluateStructuralObligations(
        SOV.structuralObligations,
        [
          supportView(ORBITSWAP_SUPPORT),
          {
            sourceClass: "ONCHAIN_VERIFIABLE",
            officiality: "CLAIMED",
            entityBinding: "UNVERIFIED",
            onchainProvenance: provenance(),
            establishesComponent: false,
            supportFragment: null,
          },
        ],
        { confirmedIdentity: IDENTITY },
      ),
    ).toHaveLength(1);
  });

  it("no confirmed identity, or no confirmed programs, leaves it unmet", () => {
    withQualifyingMethod();
    const p = onchainRow(provenance());
    expect(reconcile([p], null).reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(
      reconcile([p], { ...IDENTITY, programs: [] }).reasonCodes,
    ).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});

describe("D-158 P2 §H — POSITIVE CONTROL: the gate is not merely always PARTIAL", () => {
  it("TEST H: a fully qualifying machine-owned observation MEETS the obligation", () => {
    withQualifyingMethod();
    const unmet = evaluateStructuralObligations(
      SOV.structuralObligations,
      [
        // Both halves: support that names the activity, and provenance for
        // that activity's confirmed program.
        supportView(ORBITSWAP_SUPPORT),
        provenanceView(provenance()),
      ],
      { confirmedIdentity: IDENTITY },
    );
    // The obligation itself is MET. Whether the COMPONENT then reaches
    // SUPPORTED is a separate question, answered below.
    expect(unmet).toEqual([]);
  });

  it("with the obligation met, no MECHANICAL_PROVENANCE reason is emitted", () => {
    withQualifyingMethod();
    const result = reconcile([
      row({ fragment: ORBITSWAP_SUPPORT }),
      row({
        sourceClass: "ONCHAIN_VERIFIABLE",
        officiality: "CLAIMED",
        entityBinding: "CONFIRMED",
        onchainFactKind: "TOKEN_TRANSFER",
        onchainProvenance: provenance(),
      }),
    ]);
    expect(result.reasonCodes).not.toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("the obligation being met does not by itself create support", () => {
    // SUBTRACTIVE ONLY: with no establishing evidence at all, a met
    // obligation cannot manufacture a component.
    withQualifyingMethod();
    const result = reconcile([]);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toContain("NO_EVIDENCE_FOUND");
    expect(result.reasonCodes).not.toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});

describe("D-158 P2 §I — a model cannot forge its way past the gate", () => {
  it("TEST I: documentary prose naming the provenance vocabulary changes nothing", () => {
    const forged = [
      row({
        fragment:
          `callerProgramId=${REVENUE_PROGRAM} callerMethod=collect_protocol_fee ` +
          "PROTOCOL_VALUE_INFLOW mechanical provenance established",
        summary: "PROTOCOL_VALUE_INFLOW mechanical provenance established by collect_protocol_fee",
      }),
    ];
    withQualifyingMethod();
    const result = reconcile(forged);
    expect(result.status).not.toBe("SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("a documentary row cannot borrow provenance by claiming an on-chain class", () => {
    // Even if a row's class were somehow wrong, provenance is null on a
    // model-extracted row and null is never permissive.
    withQualifyingMethod();
    const result = reconcile([
      row({ sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "CONFIRMED", onchainProvenance: null }),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("the obligation evaluator's row view exposes no model-AUTHORED field", async () => {
    // THE BOUNDARY MOVED ONCE, DELIBERATELY, AND THIS IS WHERE IT NOW SITS.
    //
    // The view may carry the LITERAL RETRIEVED PASSAGE, because the
    // activity join has to read the document's own words. It must never
    // carry what the model WROTE: not its restatement of the passage
    // (statement, summary), not its caveat prose (doesNotProve), not its
    // labels (relationship, directness, mechanismState).
    //
    // The distinction is the whole trust boundary: a model chooses which
    // passage to quote; it does not choose what the passage says.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/server/engine/structural-obligation.ts", "utf-8");
    // Comments are stripped FIRST. This module's own prose names the
    // forbidden fields in order to explain why they are forbidden; the
    // question here is what the CODE declares and reads.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const view = code.slice(
      code.indexOf("export interface ObligationEvidenceView"),
      code.indexOf("export interface ObligationContext"),
    );
    expect(view.length).toBeGreaterThan(0);
    expect(view).toContain("supportFragment");
    const MODEL_AUTHORED = [
      "statement",
      "summary",
      "relationship",
      "directness",
      "doesNotProve",
      "mechanismState",
    ];
    for (const field of MODEL_AUTHORED) {
      expect(view, field).not.toContain(field);
    }

    // And the module does not reach any of them anywhere else either.
    for (const field of MODEL_AUTHORED) {
      expect(code, field).not.toContain(field);
    }
  });
});

describe("D-158 P2 §J-K — isolation and backward compatibility", () => {
  it("TEST K: components declaring no obligations behave exactly as before", () => {
    for (const component of [
      "FLOW_PATH",
      "MECHANISM_SPEC",
      "DESTINATION",
      "RECIPIENT",
      "NET_EFFECT",
      "EXECUTION_EVIDENCE",
      "CURRENT_STATE",
      "GOVERNANCE_BASIS",
      "DURABILITY_BASIS",
    ]) {
      const req = componentRequirementsFor(PATTERN_V1_CONTENT, component);
      // Only SOURCE_OF_VALUE carries one in this phase.
      expect(req.structuralObligations).toBeUndefined();
      expect(evaluateStructuralObligations(req.structuralObligations, [], { confirmedIdentity: null })).toEqual([]);
    }
  });

  it("TEST J: qualifying provenance does not change an unrelated component", () => {
    withQualifyingMethod();
    const req = { component: "FLOW_PATH", ...componentRequirementsFor(PATTERN_V1_CONTENT, "FLOW_PATH") };
    const withProvenance = reconcileComponent({
      jobId: "job1",
      item: { step: 2, component: "FLOW_PATH" },
      requirements: req,
      evidence: [
        row({
          component: "FLOW_PATH",
          patternStep: 2,
          sourceClass: "OFFICIAL_DOCS",
          onchainProvenance: provenance(),
        }),
      ],
      confirmedIdentity: IDENTITY,
      now: new Date("2026-09-05T00:00:00Z"),
      freshnessPolicyDays: { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 },
    });
    const without = reconcileComponent({
      jobId: "job1",
      item: { step: 2, component: "FLOW_PATH" },
      requirements: req,
      evidence: [
        row({ component: "FLOW_PATH", patternStep: 2, sourceClass: "OFFICIAL_DOCS" }),
      ],
      confirmedIdentity: IDENTITY,
      now: new Date("2026-09-05T00:00:00Z"),
      freshnessPolicyDays: { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 },
    });
    expect(withProvenance.status).toBe(without.status);
    expect(withProvenance.reasonCodes).toEqual(without.reasonCodes);
  });

  it("SOURCE_OF_VALUE is the only component carrying an obligation in this phase", () => {
    const withObligations = Object.entries(PATTERN_V1_CONTENT.componentRequirements ?? {})
      .filter(([, r]) => (r as { structuralObligations?: string[] }).structuralObligations?.length)
      .map(([c]) => c);
    expect(withObligations).toEqual(["SOURCE_OF_VALUE"]);
  });

  it("no SHIPPED registry entry claims an inflow approval it cannot substantiate", () => {
    // The overlay is a test seam; production ships the table itself. Two
    // things must hold of it, forever:
    //
    //   1. An approval that names no receiving position is not usable.
    //      The type makes the pairing mandatory; this pins that an empty
    //      index list is never shipped as a way around it.
    //   2. Today no entry carries an approval at all, because approving
    //      one requires a human to read that program's IDL. That is the
    //      intended gate, not an omission.
    for (const entry of KNOWN_INSTRUCTION_METHODS) {
      if (entry.proofApproval === undefined) continue;
      expect(entry.proofApproval.valueRecipient.indexes.length).toBeGreaterThan(0);
    }
    expect(KNOWN_INSTRUCTION_METHODS.filter((e) => e.proofApproval !== undefined)).toEqual([]);
  });

  it("an unimplemented obligation id fails closed rather than passing silently", () => {
    const unmet = evaluateStructuralObligations(["SOV.NOT_IMPLEMENTED"], [], {
      confirmedIdentity: IDENTITY,
    });
    expect(unmet).toHaveLength(1);
  });
});

// Base58, so a fixture's instruction data is the REAL discriminator bytes
// rather than a string that merely looks like them.
function base58(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leading = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading += "1";
  }
  return leading + digits.reverse().map((d) => ALPHABET[d]).join("");
}

// ONE INVOCATION OF THE QUALIFYING METHOD, PAYING TWO PLACES.
//
// Built as a real TransactionDetailResult and run through the production
// derivation, not as hand-written metadata — the point is that the caller's
// account list and the decoded method come from the chain shape itself.
function collectFeesTransaction(
  legs: { destination: string; amountRaw: string }[],
): TransactionDetailResult {
  return {
    kind: "TRANSACTION_DETAIL",
    signature: "sigCollect",
    slot: 444414083,
    blockTime: null,
    succeeded: true,
    burns: [],
    programs: [],
    accountKeys: [],
    tokenInstructions: legs.map((leg, i) => ({
      programId: TOKEN_PROGRAM,
      type: "transfer",
      mint: WSOL,
      account: "3LzT9tqZJ1uKxvxHRbHTCeAxrQ2y7bJ7YQ1WZBbPqcqL",
      destination: leg.destination,
      authority: null,
      amountRaw: leg.amountRaw,
      decimals: 6,
      inner: true,
      instructionIndex: i,
      parentIndex: 0,
      stackHeight: 2,
    })) as never,
    lifecycleInstructions: [],
    rawInstructions: [
      {
        programId: REVENUE_PROGRAM,
        accounts: [...CALLER_ACCOUNTS],
        data: base58(
          Buffer.concat([discriminator("global:collect_protocol_fee"), Buffer.alloc(8)]),
        ),
        inner: false,
        instructionIndex: 0,
        parentIndex: null,
        stackHeight: 1,
      },
    ],
    preTokenBalances: [],
    postTokenBalances: [],
  };
}

function onchainContextRow(meta: EvidenceProvenanceMetadata): EvidenceRow {
  // Exactly the shape production writes: a movement fact is CONTEXT
  // because movement is not a mechanism, and a chain read is CLAIMED
  // because it is not the project's own published statement.
  return row({
    relationship: "CONTEXT",
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: "TOKEN_TRANSFER",
    onchainProvenance: meta,
  });
}

function documentaryRow(): EvidenceRow {
  return row({
    fragment: "Trading fees on Orbitswap accrue to the protocol fee vault.",
    sourceClass: "OFFICIAL_DOCS",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    officiality: "CONFIRMED",
  });
}

function viewOf(r: EvidenceRow) {
  return {
    sourceClass: r.sourceClass,
    officiality: r.officiality,
    entityBinding: r.entityBinding,
    onchainProvenance: r.onchainProvenance ?? null,
    // These rows are the CONTEXT movement rows: never establishing, and
    // their fragment is machine-written JSON that names no activity.
    establishesComponent: false,
    supportFragment: r.fragment ?? null,
  };
}

describe("D-158 P2 CORRECTION §1 — the obligation reads the persisted pool, not the establishing set", () => {
  // THE PRODUCTION-SHAPED POSITIVE CONTROL. Every field is what the live
  // system actually writes: documentary support from OFFICIAL_DOCS, and a
  // machine-owned chain observation that is CONTEXT and CLAIMED.
  //
  // If this is not SUPPORTED, the obligation is unsatisfiable in
  // production and the gate is a permanent downgrade rather than a proof
  // requirement.
  it("documentary support + a CONTEXT/CLAIMED on-chain row with valid provenance reaches SUPPORTED", () => {
    withQualifyingMethod();
    const result = reconcile([documentaryRow(), onchainContextRow(provenance())]);
    expect(result.reasonCodes).toEqual([]);
    expect(result.status).toBe("SUPPORTED");
  });

  it("the satisfying row stays CONTEXT: it never becomes establishing or best-establishing", () => {
    withQualifyingMethod();
    const doc = documentaryRow();
    const chain = onchainContextRow(provenance());
    const result = reconcile([doc, chain]);

    // It supplied a machine condition. It did not become support.
    expect(result.supportingEvidenceIds).toEqual([doc.id]);
    expect(result.supportingEvidenceIds).not.toContain(chain.id);
    expect(
      result.excludedEvidence.find((e) => e.evidenceId === chain.id)?.reason,
    ).toBe("RELATIONSHIP_NOT_SUPPORTING");
    // And its CLAIMED officiality did not become the component's authority:
    // the documentary row is still the best establishing row.
    expect(result.reasonCodes).not.toContain("INSUFFICIENT_AUTHORITY");
  });

  it("the widened pool did not weaken the gate: the same documentary row alone is still PARTIAL", () => {
    withQualifyingMethod();
    const result = reconcile([documentaryRow()]);
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("a CONTEXT row cannot carry a component on its own — no ordinary support, no status", () => {
    // The pool change gives the obligation sight of the row. It gives the
    // row no voice: with nothing else present the component has no
    // establishing evidence at all.
    withQualifyingMethod();
    const result = reconcile([onchainContextRow(provenance())]);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
  });

  it("a row from another job in the pool cannot satisfy this job's obligation", () => {
    withQualifyingMethod();
    const foreign = onchainContextRow(provenance());
    foreign.researchJobId = "someOtherJob";
    const result = reconcile([documentaryRow(), foreign]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});

describe("D-158 P2 CORRECTION §2 — same qualifying method is not the same economic leg", () => {
  // THE MANDATORY ADVERSARIAL FIXTURE. One invocation of the approved
  // method pays 90 units to the protocol vault and 10 to a referrer. Both
  // legs are caused by the correct program, under the correct method, in
  // an external asset. Only the first is protocol value receipt.
  const PROTOCOL_LEG = { destination: REVENUE_ACCOUNT, amountRaw: "90000000" };
  const REFERRAL_LEG = { destination: REFERRAL_ACCOUNT, amountRaw: "10000000" };

  function rowsFrom(t: TransactionDetailResult): EvidenceRow[] {
    return deriveTransferProvenance(t)
      .filter((x) => x.attribution !== null)
      .map((x) => onchainContextRow(toEvidenceProvenance(x)));
  }

  it("the fixture derives both legs, identically attributed and identically decoded", () => {
    withQualifyingMethod();
    const derived = deriveTransferProvenance(
      collectFeesTransaction([PROTOCOL_LEG, REFERRAL_LEG]),
    );
    expect(derived).toHaveLength(2);
    for (const t of derived) {
      // Every condition EXCEPT the leg is satisfied by both.
      expect(t.attribution?.callerProgramId).toBe(REVENUE_PROGRAM);
      expect(t.callerMethod).toBe("collect_protocol_fee");
      expect(t.callerAccounts).toEqual(CALLER_ACCOUNTS);
      expect(t.asset).toEqual({ kind: "TOKEN", mint: WSOL, decimals: 6 });
    }
    expect(derived.map((t) => t.destination)).toEqual([REVENUE_ACCOUNT, REFERRAL_ACCOUNT]);
  });

  it("the protocol leg satisfies the obligation", () => {
    withQualifyingMethod();
    const [protocolRow] = rowsFrom(collectFeesTransaction([PROTOCOL_LEG]));
    expect(
      evaluateStructuralObligations(
        SOV.structuralObligations,
        [supportView(ORBITSWAP_SUPPORT), viewOf(protocolRow)],
        { confirmedIdentity: IDENTITY },
      ),
    ).toEqual([]);
  });

  it("THE REFERRAL LEG DOES NOT — same program, same method, same asset", () => {
    withQualifyingMethod();
    const [referralRow] = rowsFrom(collectFeesTransaction([REFERRAL_LEG]));
    const unmet = evaluateStructuralObligations(
      SOV.structuralObligations,
      [supportView(ORBITSWAP_SUPPORT), viewOf(referralRow)],
      { confirmedIdentity: IDENTITY },
    );
    expect(unmet).toHaveLength(1);
    expect(unmet[0].reason).toBe("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("both legs present: the component is SUPPORTED, and the referral leg is not what did it", () => {
    withQualifyingMethod();
    const both = rowsFrom(collectFeesTransaction([PROTOCOL_LEG, REFERRAL_LEG]));
    expect(both).toHaveLength(2);
    expect(reconcile([documentaryRow(), ...both]).reasonCodes).toEqual([]);
  });

  it("REMOVE THE PROTOCOL LEG, LEAVING ONLY THE REFERRAL: obligation UNMET", () => {
    withQualifyingMethod();
    const referralOnly = rowsFrom(collectFeesTransaction([REFERRAL_LEG]));
    expect(referralOnly).toHaveLength(1);
    const result = reconcile([documentaryRow(), ...referralOnly]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("an approval that cannot name a leg is UNKNOWN, and unknown is unmet", () => {
    // Index 99 does not exist in the invocation's account list. A rule the
    // actual transaction cannot resolve must fail closed rather than fall
    // back to "any destination".
    withQualifyingMethod([99]);
    const result = reconcile([
      documentaryRow(),
      ...rowsFrom(collectFeesTransaction([PROTOCOL_LEG])),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("provenance with no recorded caller accounts cannot resolve a leg", () => {
    withQualifyingMethod();
    const result = reconcile([
      documentaryRow(),
      onchainContextRow(provenance({ callerAccounts: null })),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("a transfer to an account the invocation never named cannot qualify", () => {
    withQualifyingMethod();
    const result = reconcile([
      documentaryRow(),
      onchainContextRow(
        provenance({ destination: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" }),
      ),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});

describe("D-158 P2 — ON-CHAIN OFFICIALITY IS UNCHANGED, AND NO LONGER BLOCKING", () => {
  // The previous report named on-chain officiality CLAIMED as a blocker.
  // It is not one, and the policy is untouched: an obligation is not an
  // establishing relationship, so a CLAIMED row that only supplies a
  // machine condition never becomes the component's authority. The
  // authority rule is exercised exactly as it always was — on the
  // ordinary establishing rows.
  it("an on-chain row that is the ONLY support still faces the ordinary authority rule", () => {
    // This row is SUPPORTS, so it IS establishing — and CLAIMED. Nothing
    // about obligations changes that, and nothing here weakens it.
    withQualifyingMethod();
    const result = reconcile([
      row({
        sourceClass: "ONCHAIN_VERIFIABLE",
        officiality: "CLAIMED",
        entityBinding: "CONFIRMED",
        onchainFactKind: "TOKEN_TRANSFER",
        onchainProvenance: provenance(),
      }),
    ]);
    // Its own fragment names no confirmed activity, so the activity join
    // is unmet too — both codes stand, and neither was weakened to let the
    // other through.
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(result.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("satisfying an obligation never raises a row's officiality", () => {
    withQualifyingMethod();
    const chain = onchainContextRow(provenance());
    expect(chain.officiality).toBe("CLAIMED");
    reconcile([documentaryRow(), chain]);
    expect(chain.officiality).toBe("CLAIMED");
  });
});

describe("D-158 P2 CORRECTION §3 — same project is not the same activity", () => {
  // Provenance for the confirmed program of ONE activity, reusable.
  function provenanceFor(programId: string): EvidenceProvenanceMetadata {
    return provenance({ callerProgramId: programId });
  }

  function withBothActivitiesApproved(): void {
    // Both confirmed programs carry the same qualifying method, so the
    // ONLY thing that can separate them is which activity the support is
    // about. If the join were weak, both would pass everywhere.
    __setInstructionRegistryOverlay(
      [REVENUE_PROGRAM, SECOND_ACTIVITY_PROGRAM].map((programId) => ({
        chain: "solana" as const,
        programId,
        method: "collect_protocol_fee",
        proofApproval: {
          role: "PROTOCOL_VALUE_INFLOW" as const,
          valueRecipient: { kind: "INSTRUCTION_ACCOUNT_INDEX" as const, indexes: [PROTOCOL_VAULT_INDEX] },
        },
      })),
    );
  }

  const CURVE_SUPPORT = "Vault curve revenue is a source of protocol revenue.";

  it("THE COUNTEREXAMPLE: documentary about Vault Curve + provenance for Orbitswap is NOT supported", () => {
    withBothActivitiesApproved();
    const result = reconcile([
      row({ fragment: CURVE_SUPPORT }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ]);
    // Two true facts about two different activities compose into nothing.
    expect(result.status).not.toBe("SUPPORTED");
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("add provenance for the activity the support is actually about, and the binding is satisfied", () => {
    withBothActivitiesApproved();
    const result = reconcile([
      row({ fragment: CURVE_SUPPORT }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
      onchainContextRow(provenanceFor(SECOND_ACTIVITY_PROGRAM)),
    ]);
    expect(result.reasonCodes).toEqual([]);
    expect(result.status).toBe("SUPPORTED");
  });

  it("the mirror case holds too — Orbitswap support needs Orbitswap provenance", () => {
    withBothActivitiesApproved();
    expect(
      reconcile([
        row({ fragment: ORBITSWAP_SUPPORT }),
        onchainContextRow(provenanceFor(SECOND_ACTIVITY_PROGRAM)),
      ]).reasonCodes,
    ).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(
      reconcile([
        row({ fragment: ORBITSWAP_SUPPORT }),
        onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
      ]).reasonCodes,
    ).toEqual([]);
  });

  it("MULTI-ACTIVITY: a fragment naming BOTH may be carried by the one that has provenance", () => {
    // The support itself names A and B. Only B has qualifying provenance.
    // The component may use B — and the SAME fragment is what legitimately
    // carries ordinary support, so the proposition and the mechanism are
    // still about one activity a human confirmed.
    withBothActivitiesApproved();
    const result = reconcile([
      row({
        fragment:
          "Protocol revenue comes from the Vault Curve at launch and from Orbitswap once a token graduates.",
      }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ]);
    expect(result.reasonCodes).toEqual([]);
    expect(result.status).toBe("SUPPORTED");
  });

  it("MULTI-ACTIVITY: nothing is inferred about an activity the fragment does not name", () => {
    // A third confirmed activity, unmentioned by the support. Its
    // provenance must not carry a proposition that never referred to it.
    const THIRD_PROGRAM = "4jGrnJmpr8JRLVzD3AZYo9sgVGvjmVqJERpFwgQarBsF";
    __setInstructionRegistryOverlay([
      {
        chain: "solana",
        programId: THIRD_PROGRAM,
        method: "collect_protocol_fee",
        proofApproval: {
          role: "PROTOCOL_VALUE_INFLOW",
          valueRecipient: { kind: "INSTRUCTION_ACCOUNT_INDEX", indexes: [PROTOCOL_VAULT_INDEX] },
        },
      },
    ]);
    const identity: ConfirmedProjectIdentity = {
      ...IDENTITY,
      programs: [...(IDENTITY.programs ?? []), { activity: "Perpetuals", programId: THIRD_PROGRAM }],
    };
    const result = reconcile(
      [
        row({ fragment: "Protocol revenue comes from the Vault Curve and from Orbitswap." }),
        onchainContextRow(provenanceFor(THIRD_PROGRAM)),
      ],
      identity,
    );
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("support naming NO confirmed activity cannot reach full support, however good the provenance", () => {
    // Same project, real qualifying provenance, and support that is
    // genuinely SUPPORTS/DIRECT — but it names no confirmed activity, so
    // there is no proposition to attach the mechanism to.
    withBothActivitiesApproved();
    const result = reconcile([
      row({ fragment: "The protocol earns a fee on every swap." }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ]);
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("only an ESTABLISHING row may bind the activity — an excluded row naming it cannot", () => {
    // A CONTEXT row naming Orbitswap is not what carries the component, so
    // it cannot decide what the component is about either.
    withBothActivitiesApproved();
    const result = reconcile([
      row({ fragment: CURVE_SUPPORT }),
      row({ fragment: ORBITSWAP_SUPPORT, relationship: "CONTEXT" }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("MODEL FORGERY: prose claiming another activity cannot move the binding", () => {
    // The model's summary asserts Orbitswap. The literal passage says
    // Vault Curve. Provenance exists only for Orbitswap. If summary were
    // read, this would go green.
    withBothActivitiesApproved();
    const result = reconcile([
      row({
        fragment: CURVE_SUPPORT,
        summary: "Orbitswap generated revenue for the protocol",
      }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");

    // And the converse: the literal passage is what binds, so provenance
    // for the activity IT names is what satisfies the obligation.
    expect(
      reconcile([
        row({
          fragment: CURVE_SUPPORT,
          summary: "Orbitswap generated revenue for the protocol",
        }),
        onchainContextRow(provenanceFor(SECOND_ACTIVITY_PROGRAM)),
      ]).reasonCodes,
    ).toEqual([]);
  });

  it("a model cannot bind by writing the activity name into a component or class label", () => {
    // Nothing but the literal passage is searched. A row labelled every
    // way the model can label it, whose passage names no activity, binds
    // to nothing.
    withBothActivitiesApproved();
    const result = reconcile([
      row({
        fragment: "Revenue accrues to the treasury.",
        summary: "Orbitswap Orbitswap Orbitswap",
        mechanismState: "Orbitswap",
      }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ]);
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("matching is literal and boundary-anchored, not fuzzy", () => {
    withBothActivitiesApproved();
    // Case and punctuation are normalised — the same three tokens.
    expect(
      reconcile([
        row({ fragment: "Fees from orbit-swap accrue to the vault." }),
        onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
      ]).reasonCodes,
    ).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(
      reconcile([
        row({ fragment: "Fees from ORBITSWAP accrue to the vault." }),
        onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
      ]).reasonCodes,
    ).toEqual([]);
    // A name inside a longer word is not that name.
    expect(
      reconcile([
        row({ fragment: "Revenue from the vaultcurvexyz module." }),
        onchainContextRow(provenanceFor(SECOND_ACTIVITY_PROGRAM)),
      ]).reasonCodes,
    ).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });

  it("a HUMAN-CONFIRMED alias binds; an unconfirmed synonym does not", () => {
    withBothActivitiesApproved();
    const withAlias: ConfirmedProjectIdentity = {
      ...IDENTITY,
      programs: [
        { activity: "Orbitswap", programId: REVENUE_PROGRAM, aliases: ["Orbit AMM"] },
        { activity: "Vault Curve", programId: SECOND_ACTIVITY_PROGRAM },
      ],
    };
    const evidence = () => [
      row({ fragment: "Trading fees on the Orbit AMM accrue to the protocol fee vault." }),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ];
    // Without the human-confirmed alias, "Orbit AMM" is just words.
    expect(reconcile(evidence()).reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    // With it, the same passage binds.
    expect(reconcile(evidence(), withAlias).reasonCodes).toEqual([]);
  });

  it("the historical PUMP documentary rows still bind to nothing", () => {
    // The regression that started all of this: none of the four sentences
    // names a confirmed activity, so even with real provenance present
    // they cannot reach full support.
    withBothActivitiesApproved();
    const result = reconcile([
      ...pumpDocumentaryRows(),
      onchainContextRow(provenanceFor(REVENUE_PROGRAM)),
    ]);
    expect(result.status).toBe("PARTIALLY_SUPPORTED");
    expect(result.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
  });
});
