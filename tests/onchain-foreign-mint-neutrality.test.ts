import { describe, expect, it } from "vitest";

import {
  reconcileComponent,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  AccountInfoResult,
  OnchainArtifact,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";
import type { ExtractedFact } from "../src/server/engine/providers/types";

// FOREIGN-MINT NEUTRALITY, END TO END.
//
// A document may name an address; the chain may answer that the address is
// a token account for somebody else's mint. That answer must never make the
// project's claim look better supported merely because the document
// mentioned it.
//
// These tests do not assert on the relationship label in isolation — a
// label is only as safe as what the reconciler does with it. They take the
// facts the real synthesizer emits and run them through the real
// reconciler, so the guarantee is pinned where it actually has to hold.

const JOB = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-08-27T00:00:00Z");
const FRESHNESS_POLICY = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };

const ANCHOR = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FOREIGN = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SUBJECT = "AcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOLDER = "OwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";

// DESTINATION admits ONCHAIN_VERIFIABLE in the shipped pattern, and is the
// component an account observation is actually offered for.
const TARGET = { step: 6, component: "DESTINATION" };

function artifactFor(result: AccountInfoResult): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "ACCOUNT_INFO",
    chain: "solana",
    network: "mainnet",
    projectAnchor: ANCHOR,
    subjectKind: "account",
    subject: result.address,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: `atlas-onchain://solana/mainnet/project/${ANCHOR}/account/${result.address}/info`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "account",
      subject: result.address,
      slot: 441_840_975,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "getAccountInfo",
      requestParams: { subject: result.address },
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:${result.tokenAccount?.mint ?? "none"}`,
      artifactHash: `sha256:art:${result.tokenAccount?.mint ?? "none"}`,
      transactionSignature: null,
    },
  });
}

const tokenAccountFor = (mint: string): AccountInfoResult => ({
  kind: "ACCOUNT_INFO",
  address: SUBJECT,
  exists: true,
  ownerProgram: SPL_TOKEN,
  executable: false,
  lamports: "2039280",
  tokenAccountRelation: "TOKEN_ACCOUNT_PARSED",
  tokenAccount: { mint, owner: HOLDER, amountRaw: "0", decimals: 6, state: "initialized" },
});

const unresolvedAccount = (): AccountInfoResult => ({
  ...tokenAccountFor(ANCHOR),
  tokenAccountRelation: "TOKEN_PROGRAM_OWNED_UNRESOLVED",
  tokenAccount: null,
});

const systemOwned = (): AccountInfoResult => ({
  kind: "ACCOUNT_INFO",
  address: SUBJECT,
  exists: true,
  ownerProgram: SYSTEM,
  executable: false,
  lamports: "64850000000",
  tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
  tokenAccount: null,
});

// Maps a synthesized fact into the row shape S5 consumes, carrying the
// synthesizer's OWN relationship and directness through unchanged — the
// whole point is that nothing rewrites them on the way.
let rowSeq = 0;
function asEvidenceRow(fact: ExtractedFact): EvidenceRow {
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
    // D-134: an on-chain row must also be bound to this project. The
    // artifact's anchor IS the project's confirmed identity here.
    entityBinding: "CONFIRMED",
    fetchedAt: NOW,
    publishedAt: null,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
  };
}

function requirements(): ComponentRequirements {
  return {
    component: "DESTINATION",
    establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
    requiresCurrentState: false,
    requiresLiveMechanismState: false,
    freshnessClass: "LOW_CHANGE",
    tokenStateSensitive: false,
    requiredTokenState: null,
  };
}

function reconcileFrom(result: AccountInfoResult) {
  const facts = synthesizeOnchainFacts(artifactFor(result), TARGET);
  const rows = facts.map(asEvidenceRow);
  return {
    facts,
    rows,
    outcome: reconcileComponent({
      jobId: JOB,
      item: TARGET,
      requirements: requirements(),
      evidence: rows,
      now: NOW,
      freshnessPolicyDays: FRESHNESS_POLICY,
    }),
  };
}

describe("foreign-mint neutrality — 1. a target-mint fact still supports", () => {
  it("contributes positive support exactly as before", () => {
    const { facts, outcome } = reconcileFrom(tokenAccountFor(ANCHOR));
    expect(facts[1].relationship).toBe("SUPPORTS");
    expect(outcome.status).toBe("SUPPORTED");
    expect(outcome.supportingEvidenceIds.length).toBeGreaterThan(0);
  });
});

describe("foreign-mint neutrality — 2/3/4. a foreign-mint fact contributes nothing", () => {
  const { facts, rows, outcome } = reconcileFrom(tokenAccountFor(FOREIGN));
  // rows[0] is the existence fact (SUPPORTS), rows[1] the relationship.
  const relationRowId = rows[1].id;

  it("the synthesized relationship is not SUPPORTS", () => {
    expect(facts[1].relationship).toBe("CONTEXT");
  });

  it("2. it never appears among supporting evidence", () => {
    expect(outcome.supportingEvidenceIds).not.toContain(relationRowId);
  });

  it("2. the reconciler excludes it as non-supporting, by name", () => {
    const excluded = outcome.excludedEvidence.find((e) => e.evidenceId === relationRowId);
    expect(excluded?.reason).toBe("RELATIONSHIP_NOT_SUPPORTING");
  });

  it("3. it cannot raise reconciliation toward SUPPORTED on its own", () => {
    // The relationship fact ALONE, with no existence fact beside it.
    const alone = reconcileComponent({
      jobId: JOB,
      item: TARGET,
      requirements: requirements(),
      evidence: [asEvidenceRow(facts[1])],
      now: NOW,
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    expect(alone.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(alone.supportingEvidenceIds).toHaveLength(0);
  });

  it("4. it adds nothing to a target-binding assessment that a wrong mint could give", () => {
    // Identical observation except the mint. The foreign one must not
    // produce a supporting row where the target one does.
    const target = reconcileFrom(tokenAccountFor(ANCHOR));
    const foreign = reconcileFrom(tokenAccountFor(FOREIGN));
    expect(target.outcome.supportingEvidenceIds).toHaveLength(2);
    expect(foreign.outcome.supportingEvidenceIds).toHaveLength(1);
  });

  it("it does not CONTRADICT either — a different asset is not a denial", () => {
    // Overstating in the other direction would be just as wrong: the
    // account holding another mint does not refute the project's claim.
    expect(outcome.status).not.toBe("CONTRADICTED");
    expect(outcome.contradictingEvidenceIds).not.toContain(relationRowId);
  });
});

describe("foreign-mint neutrality — 5/6. nothing is invented from ACCOUNT_INFO", () => {
  it("5. an unresolved account produces no mint relationship at all", () => {
    const { facts } = reconcileFrom(unresolvedAccount());
    expect(facts).toHaveLength(1);
    expect(facts.map((f) => f.relationship)).toEqual(["SUPPORTS"]);
    expect(facts[0].statement.toLowerCase()).not.toContain("mint");
  });

  it("6. no burn or execution claim comes from either relation", () => {
    for (const result of [tokenAccountFor(ANCHOR), tokenAccountFor(FOREIGN), systemOwned()]) {
      const { facts } = reconcileFrom(result);
      const text = facts.map((f) => f.statement).join(" ").toLowerCase();
      for (const forbidden of ["burn", "executed", "destroy", "supply"]) {
        expect(text, `${result.tokenAccountRelation}: "${forbidden}"`).not.toContain(forbidden);
      }
      // And none of them is offered for an execution component.
      expect(facts.every((f) => f.component === "DESTINATION")).toBe(true);
    }
  });
});

describe("foreign-mint neutrality — 7. CONTEXT and LIMITS semantics are untouched", () => {
  // Both are excluded identically by the reconciler; this pins that the
  // choice between them carries no behavioural difference, so the label is
  // an expressive choice rather than a load-bearing one.
  const base = asEvidenceRow(synthesizeOnchainFacts(artifactFor(systemOwned()), TARGET)[0]);

  for (const relationship of ["CONTEXT", "LIMITS"] as const) {
    it(`${relationship} never establishes and never contradicts`, () => {
      const out = reconcileComponent({
        jobId: JOB,
        item: TARGET,
        requirements: requirements(),
        evidence: [{ ...base, id: `rel-${relationship}`, relationship }],
        now: NOW,
        freshnessPolicyDays: FRESHNESS_POLICY,
      });
      expect(out.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(out.supportingEvidenceIds).toHaveLength(0);
      expect(out.contradictingEvidenceIds).toHaveLength(0);
      expect(out.excludedEvidence[0]?.reason).toBe("RELATIONSHIP_NOT_SUPPORTING");
    });
  }

  it("a CONTEXT row cannot suppress a genuine supporting row beside it", () => {
    const supporting = asEvidenceRow(
      synthesizeOnchainFacts(artifactFor(tokenAccountFor(ANCHOR)), TARGET)[1],
    );
    const out = reconcileComponent({
      jobId: JOB,
      item: TARGET,
      requirements: requirements(),
      evidence: [supporting, { ...base, id: "ctx-row", relationship: "CONTEXT" }],
      now: NOW,
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    expect(out.status).toBe("SUPPORTED");
    expect(out.supportingEvidenceIds).toContain(supporting.id);
  });
});
