import { describe, expect, it } from "vitest";

import {
  reconcileComponent,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  synthesizeOnchainFacts,
  type SynthesizedFact,
} from "../src/server/engine/onchain-facts";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

// A BURN OF SOMEBODY ELSE'S TOKEN IS NOT THIS PROJECT'S SUPPLY EVENT.
//
// BURN is the one kind the applicability map declares relevant to
// NET_EFFECT, and §B1 qualifies a gross supply reduction on that kind
// alone — neither asks which mint burned. That was safe only because a
// transaction was reachable exclusively through the signature history of a
// token account for the confirmed mint, so any burn inside one was the
// project's by construction. That containment belongs to the acquisition
// chain, not to the fact, and it disappears the moment a transaction can
// be reached for any other reason.
//
// These tests follow the doctrine of onchain-foreign-mint-neutrality:
// never assert on a relationship label alone. A label is only as good as
// what the reconciler does with it, so every case runs the facts the real
// synthesizer emits through the real reducer.

const JOB = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-09-05T00:00:00Z");
const FRESHNESS_POLICY = { LOW_CHANGE: 3650, MEDIUM_CHANGE: 365, HIGH_CHANGE: 30 };

const ANCHOR = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FOREIGN = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SIGNATURE =
  "44235e2hWBDBQvKpKn9mqkJ1FCnrZhoCBSLocjBDxUdYXB3GDc67RmEh6gciuvXdTrEtTF9S33uiHNcVLS8MEHe2";

// A transaction is reachable only through EXECUTION_EVIDENCE's promotion
// chain, so that is where a burn fact is really filed. NET_EFFECT reads it
// across components through the applicability map, which is exactly the
// path this fix has to hold on.
const EXECUTION = { step: 4, component: "EXECUTION_EVIDENCE" };
const NET_EFFECT = { step: 5, component: "NET_EFFECT" };

function burn(mint: string, index: number): BurnInstructionRef {
  return {
    programId: SPL_TOKEN,
    instructionType: "BurnChecked",
    mint,
    sourceAccount: `TokAcct${index}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    authority: null,
    amountRaw: "1000000",
    decimals: 6,
    instructionIndex: index,
    parentIndex: null,
    stackHeight: 1,
  };
}

function transactionWith(burns: BurnInstructionRef[]): TransactionDetailResult {
  return {
    kind: "TRANSACTION_DETAIL",
    signature: SIGNATURE,
    slot: 444_556_823,
    blockTime: null,
    succeeded: true,
    burns,
    programs: [SPL_TOKEN],
    accountKeys: [],
    tokenInstructions: [],
    lifecycleInstructions: [],
    rawInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
  };
}

function artifactFor(
  result: TransactionDetailResult,
  anchor: string = ANCHOR,
): OnchainArtifact {
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
    canonicalUri: `atlas-onchain://solana/mainnet/project/${anchor}/tx/${result.signature}`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "tx",
      subject: result.signature,
      slot: result.slot,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "getTransaction",
      requestParams: { subject: result.signature },
      retrievedAt: NOW,
      rawResponseHash: "sha256:raw:tx",
      artifactHash: "sha256:art:tx",
      transactionSignature: result.signature,
    },
  });
}

// Carries the synthesizer's OWN relationship, mechanismState and — this is
// what the previous foreign-mint suite did not need — its onchainFactKind,
// because §B1 reads exactly that column.
let rowSeq = 0;
function asEvidenceRow(fact: SynthesizedFact): EvidenceRow {
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
    mechanismState: fact.mechanismState,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CONFIRMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: fact.onchainFactKind,
    fetchedAt: NOW,
    publishedAt: null,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
  };
}

function netEffectRequirements(): ComponentRequirements {
  return {
    component: "NET_EFFECT",
    ...componentRequirementsFor(PATTERN_V1_CONTENT, "NET_EFFECT"),
  };
}

function burnFacts(mints: string[], anchor: string = ANCHOR) {
  return synthesizeOnchainFacts(
    artifactFor(transactionWith(mints.map((m, i) => burn(m, i))), anchor),
    EXECUTION,
  ).filter((f) => f.onchainFactKind === "BURN");
}

// The real reducer, asked the NET_EFFECT question about rows filed at
// EXECUTION_EVIDENCE — the production shape.
function reconcileNetEffect(rows: EvidenceRow[]) {
  return reconcileComponent({
    jobId: JOB,
    item: NET_EFFECT,
    requirements: netEffectRequirements(),
    evidence: rows,
    now: NOW,
    freshnessPolicyDays: FRESHNESS_POLICY,
  });
}

describe("foreign-mint burn — 1. a burn of the project's own mint is untouched", () => {
  it("is still SUPPORTS, still kind BURN, still LIVE", () => {
    const [f] = burnFacts([ANCHOR]);
    expect(f.relationship).toBe("SUPPORTS");
    expect(f.onchainFactKind).toBe("BURN");
    expect(f.mechanismState).toBe("LIVE");
    expect(f.directness).toBe("DIRECT");
  });

  it("its statement and doesNotProve are the ones it always had", () => {
    const [f] = burnFacts([ANCHOR]);
    expect(f.statement).toContain("executed an SPL Token BurnChecked instruction");
    expect(f.statement).toContain(ANCHOR);
    expect(f.statement).not.toContain("NOT this project's confirmed mint");
    expect(f.doesNotProve).toContain("does NOT prove who economically funded");
  });

  it("§B1 still sees a gross supply reduction from it", () => {
    const out = reconcileNetEffect(burnFacts([ANCHOR]).map(asEvidenceRow));
    // A burn happened; what did not happen is a before/after supply
    // reading. That is the same answer §B1 has always given.
    expect(out.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(out.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(out.supportingEvidenceIds.length).toBeGreaterThan(0);
  });
});

describe("foreign-mint burn — 2. a burn of another token establishes nothing here", () => {
  it("the observation still exists, and still says it was a burn", () => {
    const [f] = burnFacts([FOREIGN]);
    expect(f).toBeDefined();
    expect(f.onchainFactKind).toBe("BURN");
    expect(f.statement).toContain("executed an SPL Token BurnChecked instruction");
  });

  it("its relationship is not SUPPORTS", () => {
    const [f] = burnFacts([FOREIGN]);
    expect(f.relationship).not.toBe("SUPPORTS");
    expect(f.relationship).toBe("CONTEXT");
  });

  it("it names the anchor it is NOT, rather than leaving a reader to notice", () => {
    const [f] = burnFacts([FOREIGN]);
    expect(f.statement).toContain(FOREIGN);
    expect(f.statement).toContain(`NOT this project's confirmed mint ${ANCHOR}`);
    expect(f.doesNotProve).toContain("says nothing whatever about this project's supply");
  });

  it("it does not claim this project's mechanism is running", () => {
    const [f] = burnFacts([FOREIGN]);
    expect(f.mechanismState).toBeNull();
  });

  it("the reducer excludes it as non-supporting, by name", () => {
    const rows = burnFacts([FOREIGN]).map(asEvidenceRow);
    const out = reconcileNetEffect(rows);
    expect(
      out.excludedEvidence.find((e) => e.evidenceId === rows[0].id)?.reason,
    ).toBe("RELATIONSHIP_NOT_SUPPORTING");
    expect(out.supportingEvidenceIds).not.toContain(rows[0].id);
  });

  it("IT DOES NOT SATISFY §B1 GROSS SUPPLY REDUCTION", () => {
    const out = reconcileNetEffect(burnFacts([FOREIGN]).map(asEvidenceRow));
    expect(out.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    // With nothing establishing at all, the component cannot even reach the
    // qualification — which is the stronger refusal, not a weaker one.
    expect(out.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("it does not CONTRADICT either — a different asset is not a denial", () => {
    const [f] = burnFacts([FOREIGN]);
    expect(f.relationship).not.toBe("CONTRADICTS");
  });
});

describe("foreign-mint burn — 3. one transaction, both mints", () => {
  it("the project's burn supports and the stranger's does not", () => {
    const facts = burnFacts([ANCHOR, FOREIGN]);
    expect(facts).toHaveLength(2);
    const own = facts.find((f) => f.statement.includes(`of mint ${ANCHOR}`))!;
    const other = facts.find((f) => f.statement.includes(`of mint ${FOREIGN}`))!;
    expect(own.relationship).toBe("SUPPORTS");
    expect(other.relationship).toBe("CONTEXT");
  });

  it("the stranger's burn neither adds to nor suppresses the project's", () => {
    const both = reconcileNetEffect(burnFacts([ANCHOR, FOREIGN]).map(asEvidenceRow));
    const alone = reconcileNetEffect(burnFacts([ANCHOR]).map(asEvidenceRow));
    expect(both.reasonCodes).toEqual(alone.reasonCodes);
    expect(both.status).toBe(alone.status);
    // Exactly one row was admitted: the project's own.
    expect(both.supportingEvidenceIds).toHaveLength(1);
  });

  it("the stranger's burn alone cannot carry NET_EFFECT that the project's would", () => {
    const own = reconcileNetEffect(burnFacts([ANCHOR]).map(asEvidenceRow));
    const other = reconcileNetEffect(burnFacts([FOREIGN]).map(asEvidenceRow));
    expect(own.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(other.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  });
});

describe("foreign-mint burn — 4. cross-component exposure cannot rescue it", () => {
  it("filed at EXECUTION_EVIDENCE and read by NET_EFFECT, it still establishes nothing", () => {
    // This IS the cross-component path: the rows carry component
    // EXECUTION_EVIDENCE and the reducer is asked the NET_EFFECT question.
    // The applicability map lets NET_EFFECT SEE a BURN row; relationship
    // decides whether it may speak, and CONTEXT never may.
    const rows = burnFacts([FOREIGN]).map(asEvidenceRow);
    expect(rows[0].component).toBe("EXECUTION_EVIDENCE");
    const out = reconcileNetEffect(rows);
    expect(out.supportingEvidenceIds).toEqual([]);
    expect(out.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  });

  it("fail closed: with no usable anchor, a burn is foreign", () => {
    // An artifact whose provenance carries no anchor cannot show the burn
    // is ours. Absence of proof is not permission to assume it.
    const [f] = burnFacts([ANCHOR], "");
    expect(f.relationship).toBe("CONTEXT");
    expect(f.statement).toContain("(none confirmed)");
  });
});

describe("foreign-mint burn — 6. the model cannot reach this decision", () => {
  it("both sides of the comparison are machine-owned", async () => {
    // The mint comes from the decoded instruction and the anchor from the
    // artifact's provenance. Asserted structurally: the synthesis reads
    // neither statement nor summary nor any component label to decide it.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/server/engine/onchain-facts.ts", "utf-8");
    const block = src.slice(
      src.indexOf("const burnAnchor = artifact.provenance.projectAnchor"),
      src.indexOf("// RECIPROCAL ASSET FLOW"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("b.mint === burnAnchor");
    expect(block).toContain("artifact.provenance.projectAnchor");
  });

  it("model-authored prose on the row cannot turn a foreign burn into support", () => {
    const rows = burnFacts([FOREIGN]).map(asEvidenceRow);
    // Everything a model could have written, rewritten to claim the anchor.
    rows[0].summary = `Burned ${ANCHOR}, reducing this project's supply`;
    rows[0].fragment = `{"burn":{"mint":"${ANCHOR}"}}`;
    rows[0].component = "NET_EFFECT";
    rows[0].patternStep = 5;
    const out = reconcileNetEffect(rows);
    // relationship is what the synthesizer set, and it is what decides.
    expect(out.supportingEvidenceIds).toEqual([]);
    expect(out.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  });
});
