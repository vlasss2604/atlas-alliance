import { describe, expect, it } from "vitest";

import {
  PATTERN_V1_CONTENT,
  componentRequirementsFor,
} from "../src/server/domain/pattern";
import {
  reconcileComponent,
  type ComponentRequirements,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

// A REAL BURN THAT IS ALREADY ON DISK.
//
// The fixture below is not invented. It is the normalized_result of
// onchain_artifacts row 8ccbbac0-96d7-4dbf-91c9-ece29d62ec0e, copied
// verbatim from the local database, together with that row's own
// provenance columns. The transaction is a single Token-2022 BurnChecked
// that destroyed a token account's entire balance of the project's
// confirmed mint.
//
// Two questions are asked of it here, both offline and both through the
// real code:
//
//   1. what fact does the deterministic synthesizer make of it, and
//   2. can that fact establish EXECUTION_EVIDENCE in the real reconciler.
//
// What is NOT asserted anywhere below: that the burn belongs to any
// mechanism, that anything funded it, or that it relates to any other
// transaction. The artifact is standalone — owned by no research job — and
// this file deliberately does not pretend otherwise. See the last describe
// block for what that costs.

const ANCHOR = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_ACCOUNT = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
const AUTHORITY = "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c";
const SIGNATURE =
  "5R5LhLdHyzDJtFgHFG4UdkwNh66iGhf7Y2XVaagMi5XadQB1cbRJP66EqkKyao9FBmYPVB3gyCinb6vy3RwdUPSF";
const SLOT = 441_840_980;
const AMOUNT_RAW = "7723746661";

// The artifact row's own provenance columns, verbatim.
const RETRIEVED_AT = new Date("2026-08-26T10:04:19.804Z");
const RAW_HASH = "sha256:a3e22c49f42d9af4c1209a01beceee4a481dd9a182bc646566479d7edbff014d";
const ARTIFACT_HASH = "sha256:4a9d2394874829b4a2d9e0aec035832d010fc5d4577cc4fbb2ab99b52c1ff712";
const CANONICAL_URI = `atlas-onchain://solana/mainnet/project/${ANCHOR}/tx/${SIGNATURE}/detail`;

// EXACTLY the stored JSON. The stored row has no `lifecycleInstructions`
// key at all — it was written before that field existed, which is its own
// finding and is pinned in the last describe block below.
const STORED_RESULT = {
  kind: "TRANSACTION_DETAIL",
  slot: SLOT,
  burns: [
    {
      mint: ANCHOR,
      decimals: 6,
      amountRaw: AMOUNT_RAW,
      authority: AUTHORITY,
      programId: TOKEN_2022,
      sourceAccount: TOKEN_ACCOUNT,
      instructionType: "BurnChecked",
    },
  ],
  programs: [TOKEN_2022],
  blockTime: 1_787_737_826,
  signature: SIGNATURE,
  succeeded: true,
  accountKeys: [AUTHORITY, ANCHOR, TOKEN_ACCOUNT, TOKEN_2022],
  preTokenBalances: [
    {
      mint: ANCHOR,
      owner: AUTHORITY,
      account: TOKEN_ACCOUNT,
      decimals: 6,
      amountRaw: AMOUNT_RAW,
      accountIndex: 2,
    },
  ],
  postTokenBalances: [
    {
      mint: ANCHOR,
      owner: AUTHORITY,
      account: TOKEN_ACCOUNT,
      decimals: 6,
      amountRaw: "0",
      accountIndex: 2,
    },
  ],
  tokenInstructions: [
    {
      mint: ANCHOR,
      type: "burnChecked",
      inner: false,
      account: TOKEN_ACCOUNT,
      decimals: 6,
      amountRaw: AMOUNT_RAW,
      authority: AUTHORITY,
      programId: TOKEN_2022,
      destination: null,
    },
  ],
} as const;

// The same transaction as today's adapter would project it. The added
// value is derived, not invented: the transaction contains exactly ONE
// instruction — the burnChecked above, on the only program it invokes —
// and a burn is not an account-lifecycle instruction, so the only possible
// value is the empty array.
function storedResult(): TransactionDetailResult {
  return {
    ...(JSON.parse(JSON.stringify(STORED_RESULT)) as TransactionDetailResult),
    lifecycleInstructions: [],
  };
}

function artifact(result: TransactionDetailResult): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: ANCHOR,
    subjectKind: "tx",
    subject: SIGNATURE,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: CANONICAL_URI,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "tx",
      subject: SIGNATURE,
      slot: SLOT,
      blockTime: 1_787_737_826,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: SIGNATURE },
      retrievedAt: RETRIEVED_AT,
      rawResponseHash: RAW_HASH,
      artifactHash: ARTIFACT_HASH,
      transactionSignature: SIGNATURE,
    },
  });
}

const STEP = 4;
const COMPONENT = "EXECUTION_EVIDENCE";
const JOB = "44444444-4444-4444-4444-444444444444";
const SOURCE = "55555555-5555-5555-5555-555555555555";
const FRESHNESS_POLICY = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };

// The requirements the SHIPPED pattern declares — read from Pattern data,
// never hand-copied, so an edit to CORE cannot silently pass this test.
function requirements(component: string): ComponentRequirements {
  const entry = componentRequirementsFor(PATTERN_V1_CONTENT, component);
  return {
    component,
    establishingClasses: entry.establishingClasses,
    requiresCurrentState: entry.requiresCurrentState,
    requiresLiveMechanismState: entry.requiresLiveMechanismState,
    freshnessClass: entry.freshnessClass,
    tokenStateSensitive: entry.tokenStateSensitive,
    requiredTokenState: entry.requiredTokenState,
  };
}

// The row EXACTLY as persistOnchainArtifactAndFacts would write it: class
// set by code after binding, officiality CLAIMED (a chain read is not the
// project's own published claim), entityBinding CONFIRMED, fetchedAt from
// the artifact's own retrievedAt — NOT from "now".
let rowSeq = 0;
function asRow(fact: ReturnType<typeof synthesizeOnchainFacts>[number]): EvidenceRow {
  rowSeq += 1;
  return {
    id: `11111111-1111-1111-1111-${String(rowSeq).padStart(12, "0")}`,
    researchJobId: JOB,
    sourceId: SOURCE,
    evidenceContractVersion: 2,
    patternStep: fact.step,
    component: fact.component,
    relationship: fact.relationship,
    directness: fact.directness,
    fragment: fact.supportFragment,
    summary: fact.statement,
    mechanismState: fact.mechanismState as EvidenceRow["mechanismState"],
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "CONFIRMED",
    onchainFactKind: fact.onchainFactKind,
    fetchedAt: RETRIEVED_AT,
    publishedAt: fact.publishedAt,
    extractionUnitKey: `unit-${rowSeq}`,
    contentHash: RAW_HASH,
  };
}

describe("1. the persisted artifact really is a burn", () => {
  const result = storedResult();

  it("one decoded BurnChecked of the project's confirmed mint", () => {
    expect(result.succeeded).toBe(true);
    expect(result.burns).toHaveLength(1);
    const b = result.burns[0];
    expect(b.instructionType).toBe("BurnChecked");
    expect(b.mint).toBe(ANCHOR);
    expect(b.programId).toBe(TOKEN_2022);
    expect(b.amountRaw).toBe(AMOUNT_RAW);
    expect(b.decimals).toBe(6);
    expect(b.sourceAccount).toBe(TOKEN_ACCOUNT);
    expect(b.authority).toBe(AUTHORITY);
  });

  it("the account's entire balance went to zero, and the numbers reconcile", () => {
    const pre = result.preTokenBalances.find((x) => x.account === TOKEN_ACCOUNT)!;
    const post = result.postTokenBalances.find((x) => x.account === TOKEN_ACCOUNT)!;
    expect(pre.amountRaw).toBe(AMOUNT_RAW);
    expect(post.amountRaw).toBe("0");
    expect(BigInt(pre.amountRaw) - BigInt(result.burns[0].amountRaw!)).toBe(BigInt(post.amountRaw));
  });

  it("the burn is the whole transaction — one program, one instruction", () => {
    // Which is why lifecycleInstructions can only be [] for this one.
    expect(result.programs).toEqual([TOKEN_2022]);
    expect(result.tokenInstructions).toHaveLength(1);
    expect(result.tokenInstructions[0].type).toBe("burnChecked");
    expect(result.lifecycleInstructions).toEqual([]);
  });
});

describe("2. what the real synthesizer makes of it", () => {
  const facts = synthesizeOnchainFacts(artifact(storedResult()), { step: STEP, component: COMPONENT });

  it("exactly one fact — the burn, and no flow facts alongside it", () => {
    // No native leg exists in this transaction, so the reciprocal-flow
    // derivation contributes nothing. The burn stands alone.
    expect(facts).toHaveLength(1);
  });

  it("SUPPORTS, DIRECT, and mechanismState LIVE", () => {
    const f = facts[0];
    expect(f.relationship).toBe("SUPPORTS");
    expect(f.directness).toBe("DIRECT");
    expect(f.mechanismState).toBe("LIVE");
    expect(f.publishedAt).toBeNull();
    expect(f.step).toBe(STEP);
    expect(f.component).toBe(COMPONENT);
  });

  it("the statement carries the signature, slot, amount, mint and account", () => {
    const s = facts[0].statement;
    expect(s).toContain(SIGNATURE);
    expect(s).toContain(String(SLOT));
    expect(s).toContain("BurnChecked");
    expect(s).toContain("7723.746661"); // formatted, never rounded
    expect(s).toContain(ANCHOR);
    expect(s).toContain(TOKEN_ACCOUNT);
    expect(s).toContain("destroying");
  });

  it("the fragment is a literal slice of the artifact's own JSON", () => {
    const fragment = JSON.parse(facts[0].supportFragment) as Record<string, unknown>;
    expect(fragment.signature).toBe(SIGNATURE);
    expect(fragment.slot).toBe(SLOT);
    expect(fragment.burn).toEqual(storedResult().burns[0]);
  });

  it("the limits say plainly what a burn does not prove", () => {
    const d = facts[0].doesNotProve;
    expect(d).toContain("does NOT prove who economically funded");
    expect(d).toContain("does NOT prove the burned tokens came from a buyback");
    expect(d).toContain("requires separate admitted evidence");
  });

  it("no economic verdict appears in the statement", () => {
    const s = facts[0].statement.toLowerCase();
    for (const forbidden of ["buyback", "buy back", "purchase", "bought", "revenue", "supply", "swap"]) {
      expect(s, forbidden).not.toContain(forbidden);
    }
  });
});

describe("3. the real reconciler, on the row production would have written", () => {
  const facts = synthesizeOnchainFacts(artifact(storedResult()), { step: STEP, component: COMPONENT });
  const rows = facts.map(asRow);
  const outcome = reconcileComponent({
    jobId: JOB,
    item: { step: STEP, component: COMPONENT },
    requirements: requirements(COMPONENT),
    evidence: rows,
    now: new Date("2026-08-27T00:00:00Z"),
    freshnessPolicyDays: FRESHNESS_POLICY,
  });

  it("EXECUTION_EVIDENCE is ESTABLISHED — and capped at PARTIALLY_SUPPORTED", () => {
    // The burn row IS the establishing element: it survives every gate and
    // is returned as supporting. What it cannot do is reach SUPPORTED,
    // because D-074 (LOCKED) caps any component whose best establishing
    // element carries officiality CLAIMED — and production writes CLAIMED
    // for every on-chain fact, deliberately: a canonical chain read is not
    // the project's own published claim.
    expect(outcome.status).toBe("PARTIALLY_SUPPORTED");
    expect(outcome.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
    expect(outcome.supportingEvidenceIds).toEqual([rows[0].id]);
    expect(outcome.excludedEvidence).toHaveLength(0);
    expect(outcome.contradictingEvidenceIds).toHaveLength(0);
  });

  it("the cap is the officiality axis alone, not the burn", () => {
    // Same row, officiality CONFIRMED: SUPPORTED. Nothing else changes.
    // This is what isolates the cap — and it is why a test that hands the
    // reconciler a CONFIRMED on-chain row is testing a shape production
    // never writes.
    const confirmed = { ...rows[0], officiality: "CONFIRMED" as const };
    const out = reconcileComponent({
      jobId: JOB,
      item: { step: STEP, component: COMPONENT },
      requirements: requirements(COMPONENT),
      evidence: [confirmed],
      now: new Date("2026-08-27T00:00:00Z"),
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    expect(out.status).toBe("SUPPORTED");
    expect(out.reasonCodes).toEqual([]);
  });

  it("there is no route from an on-chain URI to CONFIRMED officiality", () => {
    // resolveSourceRoute matches a human-approved SOURCE_ROUTE by
    // HOSTNAME. A canonical atlas-onchain:// URI has no hostname, so the
    // cap is not an oversight that a configuration change could lift.
    expect(CANONICAL_URI.startsWith("atlas-onchain://")).toBe(true);
    expect(CANONICAL_URI).not.toContain(".");
  });

  it("it passes the live-state gate, which is what ordinary transfers cannot", () => {
    const req = requirements(COMPONENT);
    expect(req.requiresLiveMechanismState).toBe(true);
    expect(req.establishingClasses).toContain("ONCHAIN_VERIFIABLE");
    expect(outcome.currentState).toBe("LIVE");
  });

  it("no freshness window applies, so a days-old retrieval is not stale", () => {
    // EXECUTION_EVIDENCE sets requiresCurrentState=false. The temporal
    // basis is still recorded, and it is the artifact's OWN retrievedAt —
    // reuse can never make evidence look fresher than it is.
    expect(requirements(COMPONENT).requiresCurrentState).toBe(false);
    expect(outcome.temporalBasis?.basisField).toBe("fetched_at");
    expect(outcome.temporalBasis?.at).toBe(RETRIEVED_AT.toISOString());
    expect(outcome.requiresFreshEvidence).toBe(false);
  });

  it("an unbound row of the same fact establishes nothing", () => {
    // Entity binding is the axis that keeps a chain read about SOME
    // project from establishing THIS one's component.
    const unbound = { ...rows[0], id: "99999999-9999-9999-9999-999999999999", entityBinding: "UNVERIFIED" as const };
    const out = reconcileComponent({
      jobId: JOB,
      item: { step: STEP, component: COMPONENT },
      requirements: requirements(COMPONENT),
      evidence: [unbound],
      now: new Date("2026-08-27T00:00:00Z"),
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    expect(out.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.excludedEvidence[0]?.reason).toBe("ENTITY_NOT_CONFIRMED");
  });
});

describe("4. what SUPPORTED here does not reach", () => {
  const facts = synthesizeOnchainFacts(artifact(storedResult()), { step: STEP, component: COMPONENT });
  const rows = facts.map(asRow);

  // The burn establishes step 4, and reaches exactly ONE other component.
  //
  // NET_EFFECT is deliberately absent from this list. A transaction can be
  // reached only through EXECUTION_EVIDENCE's promotion chain, so filing
  // the burn there and nowhere else made the one observation that destroys
  // tokens structurally invisible to the component whose whole question is
  // whether supply changed. A closed, typed applicability map now lets
  // NET_EFFECT READ this row — without copying it — and the case below
  // pins both that it arrives and that it establishes nothing more than a
  // gross event. Every other component still gets no drift at all.
  for (const [component, step] of [
    ["SOURCE_OF_VALUE", 1],
    ["FLOW_PATH", 2],
    ["MECHANISM_SPEC", 3],
    ["GOVERNANCE_BASIS", 3],
    ["DESTINATION", 6],
    ["RECIPIENT", 6],
    ["DURABILITY_BASIS", 8],
  ] as const) {
    it(`${component} is not established by this burn row`, () => {
      const out = reconcileComponent({
        jobId: JOB,
        item: { step, component },
        // The row still names step 4 / EXECUTION_EVIDENCE, so the
        // component check excludes it — a fact does not drift to whichever
        // component would find it convenient.
        requirements: requirements(component),
        evidence: rows,
        now: new Date("2026-08-27T00:00:00Z"),
        freshnessPolicyDays: FRESHNESS_POLICY,
      });
      expect(out.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(out.supportingEvidenceIds).toHaveLength(0);
    });
  }

  it("NET_EFFECT reads this burn, and still establishes only a gross event", () => {
    const out = reconcileComponent({
      jobId: JOB,
      item: { step: 7, component: "NET_EFFECT" },
      requirements: requirements("NET_EFFECT"),
      evidence: rows,
      now: new Date("2026-08-27T00:00:00Z"),
      freshnessPolicyDays: FRESHNESS_POLICY,
    });
    // The row arrives — by typed applicability, not by drifting: it is
    // still persisted at step 4 / EXECUTION_EVIDENCE and was not copied.
    expect(out.supportingEvidenceIds.length).toBeGreaterThan(0);
    const burnRow = rows.find((r) => r.onchainFactKind === "BURN");
    expect(burnRow).toBeDefined();
    expect(burnRow!.patternStep).toBe(4);
    expect(burnRow!.component).toBe("EXECUTION_EVIDENCE");
    expect(out.supportingEvidenceIds).toContain(burnRow!.id);

    // And it establishes a GROSS reduction only. A real burn on a real
    // mint still may not become net deflation.
    expect(out.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(out.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(out.status).toBe("PARTIALLY_SUPPORTED");
    expect(out.status).not.toBe("SUPPORTED");
  });

  it("nothing in the fact mentions any other transaction", () => {
    // The acquisition-shaped transaction at a later slot is a separate
    // observation. Nothing here reaches it, and nothing may connect them.
    const text = `${facts[0].statement} ${facts[0].supportFragment}`;
    expect(text).not.toContain("441977087");
    expect(text).not.toContain("17509274333");
  });
});

describe("5. the stored artifact cannot simply be replayed", () => {
  it("the stored JSON has no lifecycleInstructions key at all", () => {
    expect("lifecycleInstructions" in STORED_RESULT).toBe(false);
  });

  it("replaying it through today's synthesizer throws", () => {
    // Not a live defect: production always synthesizes from an artifact
    // the adapter just built, and the adapter always emits the field. It
    // is a PRECONDITION for any future artifact-reuse bridge — a stored
    // normalized_result is whatever the adapter produced on the day, and
    // the artifact row carries no contract version to check that against.
    const stale = JSON.parse(JSON.stringify(STORED_RESULT)) as TransactionDetailResult;
    expect(() =>
      synthesizeOnchainFacts(artifact(stale), { step: STEP, component: COMPONENT }),
    ).toThrow();
  });
});
