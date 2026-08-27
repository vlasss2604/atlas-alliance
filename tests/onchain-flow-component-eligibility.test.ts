import { describe, expect, it } from "vitest";

import {
  reconcileComponent,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { componentAllowsRule } from "../src/server/engine/onchain-subject-promotion";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";
import type { ExtractedFact } from "../src/server/engine/providers/types";

// FACT TRUTH IS NOT COMPONENT ESTABLISHMENT ELIGIBILITY.
//
// "The project's token was transferred into this account" is deterministically
// true and DIRECT. Offered for FLOW_PATH it is exactly the evidence that
// component asks for. Offered for a burn-execution question it is not, and a
// relationship label alone cannot tell those apart — S5 sorts on
// relationship AND directness AND the component's own state gate.
//
// These tests therefore run the REAL synthesizer into the REAL reconciler,
// per component, using the requirements the shipped pattern actually
// declares. Reasoning from enum names is precisely what would miss this.

const JOB = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-08-27T00:00:00Z");
const FRESHNESS_POLICY = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };

const ANCHOR = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const A = "PartyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const C = "PartyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const C_WSOL = "CwsolAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const C_TOKEN = "CtokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const A_TOKEN = "AtokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function bal(account: string, mint: string, owner: string, amountRaw: string, decimals = 6) {
  return { accountIndex: 0, account, mint, owner, amountRaw, decimals };
}

// A zero-burn reciprocal transaction: exactly the live shape.
function reciprocalTx(over: Partial<TransactionDetailResult> = {}): TransactionDetailResult {
  return {
    kind: "TRANSACTION_DETAIL",
    signature: "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    slot: 441_977_087,
    blockTime: 1_787_800_000,
    succeeded: true,
    burns: [],
    programs: [],
    accountKeys: [],
    tokenInstructions: [
      {
        programId: TOKEN_2022,
        type: "transferChecked",
        mint: ANCHOR,
        account: C_TOKEN,
        destination: A_TOKEN,
        authority: C,
        amountRaw: "17509274333",
        decimals: 6,
        inner: true,
      },
    ],
    lifecycleInstructions: [
      {
        programId: SYSTEM,
        type: "transfer",
        inner: true,
        account: null,
        mint: null,
        owner: null,
        assignedProgram: null,
        payer: A,
        source: A,
        destination: C_WSOL,
        lamports: "850140914",
        tokenProgram: null,
      },
    ],
    preTokenBalances: [
      bal(C_WSOL, WSOL, C, "1", 9),
      bal(A_TOKEN, ANCHOR, A, "0"),
      bal(C_TOKEN, ANCHOR, C, "19957702528399"),
    ],
    postTokenBalances: [
      bal(C_WSOL, WSOL, C, "850140915", 9),
      bal(A_TOKEN, ANCHOR, A, "17509274333"),
      bal(C_TOKEN, ANCHOR, C, "19940193254066"),
    ],
    ...over,
  };
}

// The same transaction, but carrying a genuine burn.
function burnTx(): TransactionDetailResult {
  return reciprocalTx({
    burns: [
      {
        programId: TOKEN_2022,
        instructionType: "BurnChecked",
        mint: ANCHOR,
        sourceAccount: A_TOKEN,
        authority: A,
        amountRaw: "17509274333",
        decimals: 6,
      },
    ],
  });
}

function artifactOf(result: TransactionDetailResult, anchor = ANCHOR): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "tx",
    subject: result.signature,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: `atlas-onchain://solana/mainnet/project/${anchor}/tx/${result.signature}/detail`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "tx",
      subject: result.signature,
      slot: result.slot,
      blockTime: result.blockTime,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "getTransaction",
      requestParams: {},
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:${result.signature}`,
      artifactHash: `sha256:art:${result.signature}:${result.burns.length}`,
      transactionSignature: result.signature,
    },
  });
}

let rowSeq = 0;
function asRow(fact: ExtractedFact): EvidenceRow {
  rowSeq += 1;
  const id = `00000000-0000-0000-0000-${String(rowSeq).padStart(12, "0")}`;
  return {
    id,
    researchJobId: JOB,
    sourceId: `source-${id}`,
    evidenceContractVersion: 2,
    patternStep: fact.step,
    component: fact.component,
    relationship: fact.relationship,
    directness: fact.directness,
    fragment: fact.supportFragment,
    summary: fact.statement,
    // Carried through exactly as synthesized — this is the field the
    // live-state gate reads.
    mechanismState: fact.mechanismState as EvidenceRow["mechanismState"],
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CONFIRMED",
    entityBinding: "CONFIRMED",
    fetchedAt: NOW,
    publishedAt: null,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
  };
}

// The requirements the SHIPPED pattern declares for each component.
const REQUIREMENTS: Record<string, ComponentRequirements> = {
  EXECUTION_EVIDENCE: {
    component: "EXECUTION_EVIDENCE",
    establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
    requiresCurrentState: false,
    requiresLiveMechanismState: true,
    freshnessClass: "MEDIUM_CHANGE",
    tokenStateSensitive: false,
    requiredTokenState: null,
  },
  DESTINATION: {
    component: "DESTINATION",
    establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
    requiresCurrentState: false,
    requiresLiveMechanismState: false,
    freshnessClass: "LOW_CHANGE",
    tokenStateSensitive: true,
    requiredTokenState: null,
  },
  FLOW_PATH: {
    component: "FLOW_PATH",
    establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
    requiresCurrentState: false,
    requiresLiveMechanismState: false,
    freshnessClass: "LOW_CHANGE",
    tokenStateSensitive: false,
    requiredTokenState: null,
  },
};
REQUIREMENTS.RECIPIENT = { ...REQUIREMENTS.DESTINATION, component: "RECIPIENT" };

function reconcileFor(component: string, result: TransactionDetailResult, step = 2) {
  const facts = synthesizeOnchainFacts(artifactOf(result), { step, component });
  const rows = facts.map(asRow);
  return {
    facts,
    rows,
    outcome: reconcileComponent({
      jobId: JOB,
      item: { step, component },
      requirements: REQUIREMENTS[component],
      evidence: rows,
      now: NOW,
      freshnessPolicyDays: FRESHNESS_POLICY,
    }),
  };
}

describe("2. a zero-burn reciprocal transaction cannot establish burn execution", () => {
  const { facts, outcome } = reconcileFor("EXECUTION_EVIDENCE", reciprocalTx(), 4);

  it("the transaction really does contain no burn", () => {
    expect(reciprocalTx().burns).toHaveLength(0);
    expect(facts).toHaveLength(3);
  });

  it("EXECUTION_EVIDENCE does NOT become SUPPORTED from transfer facts alone", () => {
    expect(outcome.status).not.toBe("SUPPORTED");
    expect(outcome.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.supportingEvidenceIds).toHaveLength(0);
  });

  it("every one of the three facts is excluded, and the reason is recorded", () => {
    expect(outcome.excludedEvidence).toHaveLength(3);
    // The component.s OWN state gate fires first and takes all three,
    // before relationship is even consulted. That is a stronger guarantee
    // than the CONTEXT label alone: even the two SUPPORTS legs never reach
    // the establishing pool for this component.
    expect(new Set(outcome.excludedEvidence.map((e) => e.reason))).toEqual(
      new Set(["NOT_CURRENT_STATE_BEARING"]),
    );
  });

  it("the native leg alone cannot establish it", () => {
    const { facts: all } = reconcileFor("EXECUTION_EVIDENCE", reciprocalTx(), 4);
    const out = reconcileComponent({
      jobId: JOB,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      requirements: REQUIREMENTS.EXECUTION_EVIDENCE,
      evidence: [asRow(all[0])],
      now: NOW,
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    expect(out.status).not.toBe("SUPPORTED");
  });

  it("the token leg alone cannot establish it", () => {
    const { facts: all } = reconcileFor("EXECUTION_EVIDENCE", reciprocalTx(), 4);
    const out = reconcileComponent({
      jobId: JOB,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      requirements: REQUIREMENTS.EXECUTION_EVIDENCE,
      evidence: [asRow(all[1])],
      now: NOW,
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    expect(out.status).not.toBe("SUPPORTED");
  });

  it("the paired CONTEXT fact alone cannot establish it", () => {
    const { facts: all } = reconcileFor("EXECUTION_EVIDENCE", reciprocalTx(), 4);
    const out = reconcileComponent({
      jobId: JOB,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      requirements: REQUIREMENTS.EXECUTION_EVIDENCE,
      evidence: [asRow(all[2])],
      now: NOW,
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    expect(out.status).not.toBe("SUPPORTED");
    // For THIS component the state gate excludes it before its CONTEXT
    // relationship is reached; under a component with no state gate the
    // relationship is what keeps it inert. Either way it never establishes.
    expect(out.excludedEvidence[0]?.reason).toBe("NOT_CURRENT_STATE_BEARING");
  });

  it("what closes the door is the component's own live-state gate", () => {
    // The transfer facts carry no mechanismState; EXECUTION_EVIDENCE
    // declares requiresLiveMechanismState. That is the existing mechanism
    // doing the work — no new relationship vocabulary was needed.
    const { facts: all } = reconcileFor("EXECUTION_EVIDENCE", reciprocalTx(), 4);
    expect(all[0].mechanismState).toBeNull();
    expect(all[1].mechanismState).toBeNull();
    expect(REQUIREMENTS.EXECUTION_EVIDENCE.requiresLiveMechanismState).toBe(true);
  });
});

// NOTE on what this block does and does not prove. asRow above sets
// officiality CONFIRMED, which is NOT what production writes for an
// on-chain fact — persistOnchainArtifactAndFacts writes CLAIMED, and
// D-074 caps a component whose best establishing element is CLAIMED at
// PARTIALLY_SUPPORTED. So "SUPPORTED" below isolates the live-state gate,
// which is what this file is about; it is not a claim about the status a
// real burn reaches in a real job. onchain-persisted-burn-evidence.test.ts
// runs that shape against a real persisted artifact.
describe("3. a genuine burn retains its execution support", () => {
  const { facts, outcome } = reconcileFor("EXECUTION_EVIDENCE", burnTx(), 4);

  it("the burn fact still carries LIVE and still establishes", () => {
    const burnFact = facts.find((f) => f.statement.includes("destroying"));
    expect(burnFact).toBeTruthy();
    expect(burnFact!.mechanismState).toBe("LIVE");
    expect(burnFact!.relationship).toBe("SUPPORTS");
    expect(outcome.status).toBe("SUPPORTED");
    expect(outcome.supportingEvidenceIds.length).toBeGreaterThan(0);
  });

  it("the transfer facts beside it are still excluded, not promoted by proximity", () => {
    const burnRowIds = new Set(
      facts
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.statement.includes("destroying"))
        .map(({ i }) => i),
    );
    // Exactly one supporting row: the burn. The reciprocal facts do not
    // ride along with it.
    expect(outcome.supportingEvidenceIds).toHaveLength(burnRowIds.size);
  });
});

// A TRANSFER IS NOT A MECHANISM.
//
// The three components below have no live-state gate, so the gate that
// stops EXECUTION_EVIDENCE cannot help them. What stops them is what their
// contracts actually ask for. FLOW_PATH traces the hops THE VALUE takes
// through the protocol; DESTINATION asks where assets end up AFTER THE
// MECHANISM EXECUTES and whether that destination retains, redistributes or
// retires them; RECIPIENT asks who ULTIMATELY RECEIVES THE ECONOMIC
// BENEFIT. A decoded transfer answers none of those. It reports that an
// amount moved between two accounts whose owners the RPC named.
//
// These were previously SUPPORTS, and each one of them established its
// component alone.
describe("4/5. a transfer cannot establish a mechanism-level component", () => {
  const STEP_OF: Record<string, number> = { FLOW_PATH: 2, DESTINATION: 6, RECIPIENT: 6 };

  for (const component of ["FLOW_PATH", "DESTINATION", "RECIPIENT"]) {
    it(`${component}: is NOT established by the reciprocal transfer facts`, () => {
      const { outcome } = reconcileFor(component, reciprocalTx(), STEP_OF[component]);
      expect(outcome.status).not.toBe("SUPPORTED");
      expect(outcome.status).not.toBe("PARTIALLY_SUPPORTED");
      expect(outcome.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(outcome.supportingEvidenceIds).toHaveLength(0);
    });

    it(`${component}: all three facts are excluded for the same reason`, () => {
      const { facts, outcome } = reconcileFor(component, reciprocalTx(), STEP_OF[component]);
      expect(facts).toHaveLength(3);
      expect(outcome.excludedEvidence).toHaveLength(3);
      expect(new Set(outcome.excludedEvidence.map((e) => e.reason))).toEqual(
        new Set(["RELATIONSHIP_NOT_SUPPORTING"]),
      );
      expect(outcome.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
    });

    it(`${component}: each leg alone establishes nothing either`, () => {
      // Not an artefact of the three arriving together: no single leg can
      // carry the component on its own.
      const step = STEP_OF[component];
      const { facts } = reconcileFor(component, reciprocalTx(), step);
      for (const [i, f] of facts.entries()) {
        const out = reconcileComponent({
          jobId: JOB,
          item: { step, component },
          requirements: REQUIREMENTS[component],
          evidence: [asRow(f)],
          now: NOW,
          freshnessPolicyDays: FRESHNESS_POLICY,
        });
        expect(out.status, `fact ${i}`).toBe("INSUFFICIENT_EVIDENCE");
        expect(out.supportingEvidenceIds, `fact ${i}`).toHaveLength(0);
      }
    });
  }

  it("directness is untouched — the READING is still direct", () => {
    // The correction is on the claim axis only. Downgrading directness
    // would have said the decoded instruction was an inference, which it
    // is not, and would have produced PARTIALLY_SUPPORTED — a weaker
    // version of the same overclaim rather than its absence.
    const { facts } = reconcileFor("FLOW_PATH", reciprocalTx(), 2);
    for (const f of facts) expect(f.directness).toBe("DIRECT");
    for (const f of facts) expect(f.relationship).toBe("CONTEXT");
  });

  it("4b. a transfer with no mechanism binding at all changes nothing", () => {
    // Same mint, same project, confirmed entity binding — and two parties
    // no document has ever named. Entity binding proves the data is about
    // this project's token; it does not make the movement part of the
    // claimed mechanism. If the outcome here differed from the case above,
    // the reconciler would be reading a binding it does not have.
    const unrelated = reciprocalTx({
      tokenInstructions: [
        {
          programId: TOKEN_2022,
          type: "transferChecked",
          mint: ANCHOR,
          account: C_TOKEN,
          destination: A_TOKEN,
          authority: C,
          amountRaw: "1",
          decimals: 6,
          inner: true,
        },
      ],
    });
    for (const component of ["FLOW_PATH", "DESTINATION", "RECIPIENT"]) {
      const { outcome } = reconcileFor(component, unrelated, STEP_OF[component]);
      expect(outcome.status, component).toBe("INSUFFICIENT_EVIDENCE");
      expect(outcome.supportingEvidenceIds, component).toHaveLength(0);
    }
  });

  it("5b. the reciprocal shape survives as recorded context, not as nothing", () => {
    // The facts are still synthesized, still exact, still traceable. The
    // capability is not withdrawn — only its authority to establish.
    const { facts } = reconcileFor("FLOW_PATH", reciprocalTx(), 2);
    expect(facts).toHaveLength(3);
    const text = facts.map((f) => f.statement).join(" ");
    expect(text).toContain("17509.274333"); // formatted, never rounded
    expect(text).toContain("850140914"); // lamports, raw
    expect(text).toContain(ANCHOR);
    expect(facts[2].statement).toContain("The same successful transaction");
  });
});

describe("6/7/8. the remaining boundaries hold", () => {
  it("6. the pairing stays non-causal and names no economic event", () => {
    const { facts } = reconcileFor("FLOW_PATH", reciprocalTx());
    const text = facts.map((f) => f.statement).join(" ").toLowerCase();
    for (const forbidden of ["buyback", "purchase", "swap", "sold", "in exchange for", "burn"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("7. a foreign-mint transfer supports neither flow nor execution", () => {
    const foreign = reciprocalTx({
      tokenInstructions: [
        {
          programId: TOKEN_2022,
          type: "transferChecked",
          mint: "MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
          account: C_TOKEN,
          destination: A_TOKEN,
          authority: C,
          amountRaw: "1",
          decimals: 6,
          inner: true,
        },
      ],
    });
    for (const component of ["FLOW_PATH", "EXECUTION_EVIDENCE"]) {
      const { facts, outcome } = reconcileFor(component, foreign, component === "FLOW_PATH" ? 2 : 4);
      expect(facts, component).toHaveLength(0);
      expect(outcome.status, component).toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("8. a failed transaction establishes nothing anywhere", () => {
    const failed = reciprocalTx({ succeeded: false });
    for (const component of ["FLOW_PATH", "DESTINATION", "EXECUTION_EVIDENCE"]) {
      const { facts, outcome } = reconcileFor(component, failed, component === "FLOW_PATH" ? 2 : 4);
      expect(facts, component).toHaveLength(0);
      expect(outcome.status, component).toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("9. replay is deterministic and provenance is stable", () => {
    const a = synthesizeOnchainFacts(artifactOf(reciprocalTx()), { step: 2, component: "FLOW_PATH" });
    const b = synthesizeOnchainFacts(artifactOf(reciprocalTx()), { step: 2, component: "FLOW_PATH" });
    expect(b).toEqual(a);
    // Every fact quotes this transaction's own signature and slot.
    for (const f of a) {
      expect(f.supportFragment).toContain("SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      expect(f.supportFragment).toContain("441977087");
    }
  });

  it("11. the guard is the fact's own label, not the promotion map", () => {
    // Today only EXECUTION_EVIDENCE may walk a signature to a transaction,
    // so in production these facts are synthesized for that component and
    // its live-state gate stops them. That is a routing accident, not a
    // semantic guarantee: the day FLOW_PATH is granted the same rule, the
    // overclaim would have gone live with no code change. The label is set
    // where the fact is authored, so it holds whatever the map later says.
    expect(componentAllowsRule("EXECUTION_EVIDENCE", "SIGNATURE_TO_TRANSACTION")).toBe(true);
    for (const component of ["FLOW_PATH", "DESTINATION", "RECIPIENT"]) {
      expect(componentAllowsRule(component, "SIGNATURE_TO_TRANSACTION"), component).toBe(false);
    }
    // And the facts carry the safe label regardless of which component
    // asked for them.
    for (const component of ["FLOW_PATH", "DESTINATION", "RECIPIENT", "EXECUTION_EVIDENCE"]) {
      const facts = synthesizeOnchainFacts(artifactOf(reciprocalTx()), { step: 2, component });
      expect(facts.map((f) => f.relationship), component).toEqual(["CONTEXT", "CONTEXT", "CONTEXT"]);
    }
  });

  it("10. burn decoding is untouched — same statement shape as before", () => {
    const { facts } = reconcileFor("EXECUTION_EVIDENCE", burnTx(), 4);
    const burnFact = facts.find((f) => f.statement.includes("destroying"))!;
    expect(burnFact.statement).toContain("executed an SPL Token BurnChecked instruction");
    expect(burnFact.statement).toContain(ANCHOR);
    expect(burnFact.doesNotProve).toContain("does NOT prove who economically funded");
  });
});
