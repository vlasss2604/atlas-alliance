import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { onchainArtifacts, projects, sources, topics, users } from "../src/server/db/schema";
import {
  ACQUISITION_WATERMARK_DOES_NOT_PROVE,
  CURRENT_PROOF_SUPPLY_GATE_DOES_NOT_PROVE,
  gateCurrentProofSupplyAcquisition,
  type CurrentProofSupplyGate,
} from "../src/server/engine/onchain-current-proof-supply-gate";
import type {
  AnchorBurnEvent,
  PersistedObservation,
} from "../src/server/engine/onchain-event-anchored-supply-interval";
import {
  MAX_HISTORICAL_SUPPLY_CANDIDATES,
  loadHistoricalSupplyCandidates,
} from "../src/server/engine/onchain-supply-candidate-store";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// CURRENT-PROOF POST-EVENT SUPPLY ELIGIBILITY.
//
// The policy: a one-shot additional TOKEN_SUPPLY read may be spent only when
// it can help complete the CURRENT Proof. Never to build observation history
// for a future Research.
//
// The distinction these tests exist to pin is the one that policy turns on.
// "A post-event observation is missing" and "a post-event observation would
// help" are different statements, and a first-ever Research of a project is
// exactly where they come apart: the observation is genuinely missing, and
// acquiring it completes nothing, because no PRIOR Research holds a reading
// before the event to pair it with.

const MINT = "Mint1111111111111111111111111111111111111111";
const OLD_MINT = "Mint2222222222222222222222222222222222222222";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_SIGNATURE = "Sig2222222222222222222222222222222222222222222222222222222222222222";
const CURRENT_JOB = "11111111-1111-1111-1111-111111111111";
const PRIOR_JOB = "22222222-2222-2222-2222-222222222222";
const OTHER_PRIOR_JOB = "33333333-3333-3333-3333-333333333333";
const EVENT_SLOT = 500;

function supplyArtifact(opts: {
  slot: number;
  amountRaw?: string;
  mint?: string;
  anchor?: string;
  decimals?: number;
  network?: string;
  finality?: "finalized" | "confirmed";
}): OnchainArtifact {
  const mint = opts.mint ?? MINT;
  const anchor = opts.anchor ?? mint;
  const network = (opts.network ?? "mainnet") as OnchainIntent["network"];
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network,
    projectAnchor: anchor,
    subjectKind: "token",
    subject: mint,
  };
  const result = {
    kind: "TOKEN_SUPPLY" as const,
    mint,
    amountRaw: opts.amountRaw ?? "1000",
    decimals: opts.decimals ?? 6,
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network,
      projectAnchor: anchor,
      subjectKind: "token",
      subject: mint,
      slot: opts.slot,
      blockTime: null,
      blockHash: null,
      finality: opts.finality ?? "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTokenSupply",
      requestParams: { subject: mint },
      transactionSignature: null,
      retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
      rawResponseHash: `sha256:raw:${mint}:${opts.slot}`,
      artifactHash: `sha256:art:${mint}:${result.amountRaw}:${opts.slot}`,
    },
  });
}

function observation(
  opts: Parameters<typeof supplyArtifact>[0] & {
    originKind?: PersistedObservation["originKind"];
    researchJobId?: string | null;
  },
): PersistedObservation {
  return {
    artifact: supplyArtifact(opts),
    originKind: opts.originKind ?? "RESEARCH_JOB",
    researchJobId: opts.researchJobId === undefined ? PRIOR_JOB : opts.researchJobId,
  };
}

// This Research's own reading — the thing a first Research always has, and
// which is exactly what makes it a candidate for a LATER Research without any
// special history-building read.
function current(opts: Parameters<typeof supplyArtifact>[0]): PersistedObservation {
  return { ...observation({ ...opts, researchJobId: CURRENT_JOB }) };
}

function burnArtifact(opts: {
  slot: number;
  mint?: string;
  anchor?: string;
  signature?: string;
  burns?: BurnInstructionRef[];
}): OnchainArtifact {
  const mint = opts.mint ?? MINT;
  const anchor = opts.anchor ?? mint;
  const signature = opts.signature ?? SIGNATURE;
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "tx",
    subject: signature,
  };
  const result = {
    kind: "TRANSACTION_DETAIL" as const,
    signature,
    slot: opts.slot,
    blockTime: 1_700_000_000,
    succeeded: true,
    burns:
      opts.burns ??
      ([
        {
          programId: "TokenProg1111111111111111111111111111111111",
          instructionType: "BurnChecked",
          mint,
          sourceAccount: TOKEN_ACCOUNT,
          authority: null,
          amountRaw: "7723746661",
          decimals: 6,
        },
      ] as BurnInstructionRef[]),
    programs: [],
    accountKeys: [],
    tokenInstructions: [],
    lifecycleInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "tx",
      subject: signature,
      slot: opts.slot,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: signature },
      transactionSignature: signature,
      retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
      rawResponseHash: `sha256:raw:tx:${signature}`,
      artifactHash: `sha256:art:tx:${signature}`,
    },
  });
}

function burnEvent(
  opts: Parameters<typeof burnArtifact>[0] & { burnIndex?: number; researchJobId?: string | null },
): AnchorBurnEvent {
  return {
    artifact: burnArtifact(opts),
    burnIndex: opts.burnIndex ?? 0,
    researchJobId: opts.researchJobId === undefined ? CURRENT_JOB : opts.researchJobId,
  };
}

function gate(over: {
  events?: AnchorBurnEvent[];
  observations?: PersistedObservation[];
  historical?: PersistedObservation[];
  anchor?: string;
}): CurrentProofSupplyGate {
  return gateCurrentProofSupplyAcquisition({
    currentResearchJobId: CURRENT_JOB,
    currentProjectAnchor: over.anchor ?? MINT,
    events: over.events ?? [burnEvent({ slot: EVENT_SLOT })],
    // The ordinary pre-event reading this Research already took.
    observations: over.observations ?? [current({ slot: 400, amountRaw: "1000" })],
    historicalCandidates: over.historical ?? [],
  });
}

// A prior Research's reading, strictly before the event, same token.
const ELIGIBLE_T0 = () => observation({ slot: 100, amountRaw: "5000" });

// ---------------------------------------------------------------------
// 1/2/3. The trigger itself.
// ---------------------------------------------------------------------

describe("1/2/3. a read is permitted only when it completes the CURRENT Proof", () => {
  it("1. prior eligible t0 + burn + no post-event t1 → POST_EVENT_SUPPLY_REQUIRED", () => {
    const g = gate({ historical: [ELIGIBLE_T0()] });
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(g.reason).toBe("EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT");
    expect(g.eligibleHistoricalCandidates).toBe(1);
  });

  it("2. a current-job reading already after the burn → NO_ACTION", () => {
    const g = gate({
      historical: [ELIGIBLE_T0()],
      observations: [current({ slot: 900, amountRaw: "990" })],
    });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("POST_EVENT_OBSERVATION_ALREADY_HELD");
  });

  it("3. a burn with no prior t0 → NO_ACTION, and NOT because one is held", () => {
    const g = gate({ historical: [] });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_HISTORICAL_T0");
    // The distinction the policy turns on: a read would buy nothing today,
    // which is a different statement from "no read is needed".
    expect(g.reason).not.toBe("POST_EVENT_OBSERVATION_ALREADY_HELD");
    expect(g.observation.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
  });

  it("9. a current reading AT the burn's slot does not satisfy the interval", () => {
    const g = gate({
      historical: [ELIGIBLE_T0()],
      observations: [current({ slot: EVENT_SLOT, amountRaw: "990" })],
    });
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
  });

  it("10. a current reading BEFORE the burn does not satisfy it either", () => {
    const g = gate({
      historical: [ELIGIBLE_T0()],
      observations: [current({ slot: 499, amountRaw: "990" })],
    });
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(g.reason).toBe("EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT");
  });

  it("this Research holding NO reading at all is its own required reason", () => {
    const g = gate({ historical: [ELIGIBLE_T0()], observations: [] });
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(g.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
    // With no current reading there is no measurement domain to compare
    // against, and that is reported rather than guessed.
    expect(g.measurementDomain).toBeNull();
  });

  it("11. several prior candidates: existence triggers, and the gate chooses none", () => {
    const g = gate({
      historical: [
        observation({ slot: 100, amountRaw: "5000" }),
        observation({ slot: 300, amountRaw: "4000", researchJobId: OTHER_PRIOR_JOB }),
        observation({ slot: 450, amountRaw: "3000", researchJobId: OTHER_PRIOR_JOB }),
      ],
    });
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(g.eligibleHistoricalCandidates).toBe(3);
    // No winner is named anywhere on the result: selecting t0 is B2b2's
    // decision, made later, against a reading that does not exist yet.
    expect(JSON.stringify(g)).not.toContain("selected");
    expect(Object.keys(g)).not.toContain("historical");
  });
});

// ---------------------------------------------------------------------
// 4/7. The invariant: no future-history building.
// ---------------------------------------------------------------------

describe("4/7. a first Research never spends a read for a future one", () => {
  it("4. burn established, own readings taken, no prior Research → NO_ACTION", () => {
    const g = gate({
      historical: [],
      observations: [
        current({ slot: 100, amountRaw: "1000" }),
        current({ slot: 300, amountRaw: "1000" }),
        current({ slot: 450, amountRaw: "1000" }),
      ],
    });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_HISTORICAL_T0");
  });

  it("its own readings are ineligible as t0 however many it has", () => {
    const own = [
      current({ slot: 100, amountRaw: "1000" }),
      current({ slot: 300, amountRaw: "1000" }),
    ];
    const g = gate({ historical: own, observations: own });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_HISTORICAL_T0");
    expect(g.excludedHistorical.map((e) => e.reason)).toEqual([
      "HISTORICAL_OBSERVATION_NOT_PRIOR_JOB",
      "HISTORICAL_OBSERVATION_NOT_PRIOR_JOB",
    ]);
  });

  it("7. and the SAME reading becomes eligible once it belongs to a prior job", () => {
    // Nothing special is acquired for the future: an ordinary anchor-level
    // reading this Research already takes is exactly what a later Research
    // finds waiting for it.
    const asPrior = observation({ slot: 100, amountRaw: "1000" });
    expect(gate({ historical: [asPrior] }).decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
  });
});

// ---------------------------------------------------------------------
// 5/6/7/8. Eligibility is B2b2's, unchanged.
// ---------------------------------------------------------------------

describe("5/6/7/8. which prior readings may serve as t0", () => {
  it("5. a standalone observation is never eligible", () => {
    const g = gate({
      historical: [
        observation({
          slot: 100,
          originKind: "STANDALONE_STRUCTURED_OBSERVATION",
          researchJobId: null,
        }),
      ],
    });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_HISTORICAL_T0");
    expect(g.excludedHistorical[0]!.reason).toBe("STANDALONE_OBSERVATION_NOT_ELIGIBLE");
  });

  it("6. a prior reading of an OLD mint is not about this project", () => {
    const g = gate({
      historical: [observation({ slot: 100, mint: OLD_MINT, anchor: OLD_MINT })],
    });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.excludedHistorical[0]!.reason).toBe("HISTORICAL_IDENTITY_MISMATCH");
  });

  it("7. a prior reading AT the burn's slot is not strictly before it", () => {
    const g = gate({ historical: [observation({ slot: EVENT_SLOT })] });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.excludedHistorical[0]!.reason).toBe("NO_EVENT_CONTAINING_INTERVAL");
  });

  it("7. and one after it is refused for the same reason", () => {
    const g = gate({ historical: [observation({ slot: EVENT_SLOT + 1 })] });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.excludedHistorical[0]!.reason).toBe("NO_EVENT_CONTAINING_INTERVAL");
  });

  it("8. a prior reading before the burn with different DECIMALS is incomparable", () => {
    const g = gate({ historical: [observation({ slot: 100, decimals: 9 })] });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_HISTORICAL_T0");
    expect(g.excludedHistorical[0]!.reason).toBe("NO_COMPARABLE_HISTORICAL_OBSERVATION");
    expect(g.measurementDomain).toEqual({
      chain: "solana",
      network: "mainnet",
      mint: MINT,
      decimals: 6,
    });
  });

  it("8. a different NETWORK is incomparable too", () => {
    const g = gate({ historical: [observation({ slot: 100, network: "devnet" })] });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.excludedHistorical[0]!.reason).toBe("NO_COMPARABLE_HISTORICAL_OBSERVATION");
  });

  it("a non-finalized prior reading is incomparable", () => {
    const g = gate({ historical: [observation({ slot: 100, finality: "confirmed" })] });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.excludedHistorical[0]!.reason).toBe("NO_COMPARABLE_HISTORICAL_OBSERVATION");
  });

  it("one eligible candidate among many refusals is still enough", () => {
    const g = gate({
      historical: [
        observation({ slot: 100, originKind: "STANDALONE_STRUCTURED_OBSERVATION", researchJobId: null }),
        observation({ slot: EVENT_SLOT + 5 }),
        observation({ slot: 200, amountRaw: "4000" }),
      ],
    });
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(g.eligibleHistoricalCandidates).toBe(1);
    expect(g.historicalCandidatesConsidered).toBe(3);
  });
});

// ---------------------------------------------------------------------
// 12/13/14. The event, and what the answer carries.
// ---------------------------------------------------------------------

describe("12/13/14. the anchor event", () => {
  it("12. an event belonging to another job is not this Research's anchor", () => {
    const g = gate({
      events: [burnEvent({ slot: EVENT_SLOT, researchJobId: PRIOR_JOB })],
      historical: [ELIGIBLE_T0()],
    });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_USABLE_EVENT");
    expect(g.acquisitionWatermark).toBeNull();
  });

  it("13. an event of another mint is refused", () => {
    const g = gate({
      events: [burnEvent({ slot: EVENT_SLOT, mint: OLD_MINT, anchor: OLD_MINT })],
      historical: [ELIGIBLE_T0()],
    });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_USABLE_EVENT");
  });

  it("no event at all is NO_ACTION, never a read", () => {
    const g = gate({ events: [], historical: [ELIGIBLE_T0()] });
    expect(g.decision).toBe("NO_ACTION");
    expect(g.reason).toBe("NO_USABLE_EVENT");
    expect(g.measurementDomain).toBeNull();
  });

  it("16. the watermark is coverage only — it selects no Proof event", () => {
    const g = gate({
      events: [burnEvent({ slot: 200 }), burnEvent({ slot: 700, signature: OTHER_SIGNATURE })],
      historical: [ELIGIBLE_T0()],
    });
    expect(g.acquisitionWatermark?.slot).toBe(700);
    // Both burns remain established; the earlier one is not discarded, and
    // nothing on the result names a canonical event or an attribution.
    expect(g.acquisitionWatermark?.usableEvents).toBe(2);
    const stated = ACQUISITION_WATERMARK_DOES_NOT_PROVE.join(" | ");
    for (const phrase of [
      "NOT the canonical event of the Proof",
      "does NOT attribute the burn to any mechanism",
      "earlier burns are NOT discarded",
      "bounds ACQUISITION COVERAGE only",
    ]) {
      expect(stated).toContain(phrase);
    }
  });

  it("14. the result retains the job, the anchor, the watermark and the reason", () => {
    const g = gate({ historical: [ELIGIBLE_T0()] });
    expect(g.currentResearchJobId).toBe(CURRENT_JOB);
    expect(g.projectAnchor).toBe(MINT);
    expect(g.acquisitionWatermark).toMatchObject({
      slot: EVENT_SLOT,
      usableEvents: 1,
      observedAt: {
        researchJobId: CURRENT_JOB,
        signature: SIGNATURE,
        slot: EVENT_SLOT,
        mint: MINT,
        sourceAccount: TOKEN_ACCOUNT,
        instructionType: "BurnChecked",
      },
    });
    expect(g.reason).toBe("EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT");
    expect(g.observation.eventSlot).toBe(EVENT_SLOT);
  });

  it("the LATEST usable burn anchors the answer, ties broken by signature", () => {
    const g = gate({
      events: [
        burnEvent({ slot: 200 }),
        burnEvent({ slot: 700, signature: OTHER_SIGNATURE }),
      ],
      historical: [observation({ slot: 600, amountRaw: "4000" })],
      observations: [current({ slot: 650, amountRaw: "990" })],
    });
    expect(g.acquisitionWatermark?.slot).toBe(700);
    expect(g.acquisitionWatermark?.usableEvents).toBe(2);
    // 600 < 700, so the candidate is still eligible; 650 is not after 700.
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
  });

  it("V1 anchors on a burn and requires no locator binding", async () => {
    const { readFile } = await import("node:fs/promises");
    // Code only: the module comment says out loud that a locator binding is
    // deliberately NOT required, and that sentence must survive.
    const raw = await readFile("src/server/engine/onchain-current-proof-supply-gate.ts", "utf-8");
    expect(raw).toContain("LOCATOR_BOUND_BURN is NOT required");
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toContain("onchain-locator-bound-burn");
    expect(code).not.toContain("LOCATOR_BOUND_BURN");
  });

  it("determinism: input order cannot change the answer", () => {
    const events = [burnEvent({ slot: 200 }), burnEvent({ slot: 700, signature: OTHER_SIGNATURE })];
    const historical = [observation({ slot: 100 }), observation({ slot: 600, amountRaw: "4" })];
    const observations = [current({ slot: 300, amountRaw: "9" }), current({ slot: 400 })];
    const a = gateCurrentProofSupplyAcquisition({
      currentResearchJobId: CURRENT_JOB,
      currentProjectAnchor: MINT,
      events,
      observations,
      historicalCandidates: historical,
    });
    const b = gateCurrentProofSupplyAcquisition({
      currentResearchJobId: CURRENT_JOB,
      currentProjectAnchor: MINT,
      events: [...events].reverse(),
      observations: [...observations].reverse(),
      historicalCandidates: [...historical].reverse(),
    });
    expect(a.decision).toBe(b.decision);
    expect(a.reason).toBe(b.reason);
    expect(a.acquisitionWatermark).toEqual(b.acquisitionWatermark);
    expect(a.measurementDomain).toEqual(b.measurementDomain);
  });
});

// ---------------------------------------------------------------------
// 15/16/17/18. The boundaries.
// ---------------------------------------------------------------------

describe("15/16/17/18. boundaries", () => {
  const GATE = "src/server/engine/onchain-current-proof-supply-gate.ts";
  const STORE = "src/server/engine/onchain-supply-candidate-store.ts";

  async function codeOf(file: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(file, "utf-8"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  }

  it("15. neither module can reach a chain: no RPC, no transport, no fetch", async () => {
    for (const file of [GATE, STORE]) {
      const code = await codeOf(file);
      for (const banned of [
        "onchain-retriever",
        "onchain-transport",
        "onchain-solana",
        "resolveOnchainRetriever",
        "runStructuredOnchainAcquisition",
        "OnchainRetriever",
        "getTokenSupply",
        "fetch(",
        "https://",
        "axios",
      ]) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it("15. the gate itself touches no database at all", async () => {
    const code = await codeOf(GATE);
    for (const banned of ["drizzle-orm", 'from "../db/', ".select(", ".insert(", "sql`"]) {
      expect(code, `gate must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("16. no source open is reserved, spent or even named", async () => {
    for (const file of [GATE, STORE]) {
      const code = await codeOf(file);
      for (const banned of [
        "reserveJobBudget",
        "budget-reservation",
        "onchain-source-open-reserve",
        "sourceOpens",
        "source_opens",
        "maxSourceOpens",
      ]) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it("16. Budget Reservation V2 is untouched", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8");
    expect(src).toContain("deterministicCeilingForComponent");
    expect(src).toContain("planDeterministicDemand");
    expect(src).not.toContain("post-event");
    expect(src).not.toContain("current-proof");
  });

  it("17. no Evidence, fact kind, reconciliation or NET_EFFECT wiring", async () => {
    for (const file of [GATE, STORE]) {
      const code = await codeOf(file);
      for (const banned of [
        "onchain-facts",
        "component-reconcil",
        "NET_EFFECT",
        "synthesizeOnchainFacts",
        // Nothing here may WRITE Evidence, of any kind.
        ".insert(evidence",
        ".update(evidence",
        "onchainFactKind:",
      ]) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
    // The gate is entirely Evidence-free; the store may only READ which
    // artifact a BURN fact was filed from — that is what "established by
    // this Research" means, and it is a select, never a write.
    expect(await codeOf(GATE)).not.toContain("evidence");
    const store = await codeOf(STORE);
    expect(store).toContain('eq(evidence.onchainFactKind, "BURN")');
    expect(store).not.toContain("SUPPLY_DELTA");
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    // B2d2 changed exactly one thing about this guard: the kind now EXISTS.
    // What must still be true — and is the thing that mattered — is that it
    // grants nothing: no applicability entry, so nothing may read it across
    // components.
    expect(facts).not.toContain("TOTAL_SUPPLY_DELTA: [");
  });

  it("18. no Research Memory", async () => {
    for (const file of [GATE, STORE]) {
      const code = await codeOf(file);
      for (const banned of ["server/memory", "researchMemory", "projectMemoryItems"]) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it("the gate names no project and states its own limits", async () => {
    const { readFile } = await import("node:fs/promises");
    const lower = (await readFile(GATE, "utf-8")).toLowerCase();
    for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan"]) {
      expect(lower, `must not name "${banned}"`).not.toContain(banned);
    }
    const stated = CURRENT_PROOF_SUPPLY_GATE_DOES_NOT_PROVE.join(" | ");
    for (const phrase of [
      "does NOT authorise a read",
      "B2b2 still decides",
      "not the same as that t0 being chosen",
      "no read is ever requested to build observation history for a future Research",
    ]) {
      expect(stated).toContain(phrase);
    }
  });

  it("eligibility is B2b2's, not a second copy of it", async () => {
    const code = await codeOf(GATE);
    expect(code).toContain("filterTemporalSupplyEligibility");
    expect(code).toContain("planPostEventSupplyAcquisition");
    // No restatement of the rules it delegates.
    expect(code).not.toContain("STANDALONE_OBSERVATION_NOT_ELIGIBLE");
    expect(code).not.toContain("HISTORICAL_OBSERVATION_NOT_PRIOR_JOB");
    expect(code).not.toContain("NO_EVENT_CONTAINING_INTERVAL");
  });

  it("nothing outside the closed B2 cluster reaches any member", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const files = [...(await walk("src")), ...(await walk("scripts"))];
    const CLUSTER = [
      "onchain-supply-delta",
      "onchain-event-anchored-supply-interval",
      "onchain-post-event-supply-plan",
      "onchain-current-proof-supply-gate",
      "onchain-supply-candidate-store",
      "onchain-post-event-supply",
      "onchain-supply-delta-store",
      "onchain-burn-spanning-supply-interval",
      "onchain-supply-delta-materialization",
    ];
    // B2c3 opened exactly ONE door into the cluster: run-job.ts calls the
    // post-event completion. Every other member is still reachable only from
    // inside, and the pure arithmetic has no production caller at all.
    // run-job is the only file outside the cluster that may reach into it,
    // and only through the two wired orchestrators — which the cluster-wide
    // guard in onchain-supply-delta.test.ts checks name by name.
    const ENTRY_POINT = "src/server/engine/run-job.ts";
    const outsideImporters: string[] = [];
    for (const f of files) {
      if (CLUSTER.some((m) => f.endsWith(`${m}.ts`))) continue;
      const code = (await readFile(f, "utf-8"))
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      if (f === ENTRY_POINT) continue;
      if (
        code.includes("onchain-current-proof-supply-gate") ||
        code.includes("onchain-supply-candidate-store")
      ) {
        outsideImporters.push(f);
      }
    }
    expect(outsideImporters).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// PART 4 — the loader retrieves rows and chooses nothing.
// ---------------------------------------------------------------------

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

async function makeJob(projectId: string, slug: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "does the buyback actually reduce circulating supply?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "buyback burn" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

async function insertSupplyRow(opts: {
  jobId: string | null;
  sourceId: string | null;
  slot: number;
  amountRaw: string;
  mint?: string;
  intentKind?: string;
}): Promise<void> {
  const mint = opts.mint ?? MINT;
  const intent: OnchainIntent = {
    kind: (opts.intentKind ?? "TOKEN_SUPPLY") as OnchainIntent["kind"],
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };
  await ctx.db.insert(onchainArtifacts).values({
    originKind: opts.jobId === null ? "STANDALONE_STRUCTURED_OBSERVATION" : "RESEARCH_JOB",
    researchJobId: opts.jobId,
    sourceId: opts.sourceId,
    canonicalUri: buildCanonicalOnchainUri(intent),
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
    intentKind: intent.kind,
    slot: opts.slot,
    blockTime: null,
    blockHash: null,
    finality: "finalized",
    transactionSignature: null,
    retrievalMethod: "RPC",
    providerId: "solana-mainnet-rpc",
    providerMethod: "getTokenSupply",
    requestParams: { subject: mint },
    retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
    rawResponseHash: `sha256:raw:${mint}:${opts.slot}:${opts.amountRaw}`,
    artifactHash: `sha256:art:${mint}:${opts.slot}:${opts.amountRaw}`,
    normalizedResult: { kind: "TOKEN_SUPPLY", mint, amountRaw: opts.amountRaw, decimals: 6 },
  });
}

describe("PART 4. the candidate loader retrieves, and decides nothing", () => {
  it("returns only prior-job total-supply rows of this token before the event", async () => {
    const slug = uniq("gate");
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug, name: "Gate Fixture", status: "ACTIVE_CORE" })
      .returning();
    const [source] = await ctx.db
      .insert(sources)
      .values({ url: `https://x.test/${uniq("u")}`, urlHash: uniq("uh"), sourceType: "ONCHAIN" })
      .returning();
    const priorJob = await makeJob(project.id, slug);
    const otherPriorJob = await makeJob(project.id, slug);
    const currentJob = await makeJob(project.id, slug);

    await insertSupplyRow({ jobId: priorJob, sourceId: source.id, slot: 100, amountRaw: "5000" });
    await insertSupplyRow({
      jobId: otherPriorJob,
      sourceId: source.id,
      slot: 300,
      amountRaw: "4000",
    });
    // Excluded: after the event.
    await insertSupplyRow({ jobId: priorJob, sourceId: source.id, slot: 900, amountRaw: "3000" });
    // Excluded: this Research's own reading.
    await insertSupplyRow({ jobId: currentJob, sourceId: source.id, slot: 200, amountRaw: "4500" });
    // Excluded: standalone origin.
    await insertSupplyRow({ jobId: null, sourceId: null, slot: 150, amountRaw: "4800" });
    // Excluded: another token.
    await insertSupplyRow({
      jobId: priorJob,
      sourceId: source.id,
      slot: 120,
      amountRaw: "10",
      mint: OLD_MINT,
    });

    const loaded = await loadHistoricalSupplyCandidates(ctx.db, {
      currentResearchJobId: currentJob,
      projectAnchor: MINT,
      chain: "solana",
      network: "mainnet",
      beforeSlot: EVENT_SLOT,
    });

    // The loader now returns each row's id alongside the observation — a
    // delta writer needs the id to record provenance edges, and the pure
    // layer still judges only the observation.
    const observations = loaded.map((o) => o.observation);
    expect(observations.map((o) => o.artifact.provenance.slot).sort((a, b) => a - b)).toEqual([
      100, 300,
    ]);
    for (const o of loaded) {
      expect(o.onchainArtifactId.length).toBeGreaterThan(0);
      expect(o.observation.originKind).toBe("RESEARCH_JOB");
      expect(o.observation.researchJobId).not.toBe(currentJob);
      expect(o.observation.artifact.result.kind).toBe("TOKEN_SUPPLY");
    }

    // And what it returned feeds the gate unchanged — the loader made no
    // eligibility decision, so the gate is free to reach either answer.
    const g = gateCurrentProofSupplyAcquisition({
      currentResearchJobId: currentJob,
      currentProjectAnchor: MINT,
      events: [
        {
          artifact: burnArtifact({ slot: EVENT_SLOT }),
          burnIndex: 0,
          researchJobId: currentJob,
        },
      ],
      observations: [
        {
          artifact: supplyArtifact({ slot: 400, amountRaw: "4500" }),
          originKind: "RESEARCH_JOB",
          researchJobId: currentJob,
        },
      ],
      historicalCandidates: observations,
    });
    expect(g.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(g.eligibleHistoricalCandidates).toBe(2);
  }, 120_000);

  it("the retrieval bound is generous and takes the newest rows first", async () => {
    expect(MAX_HISTORICAL_SUPPLY_CANDIDATES).toBe(200);
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      "src/server/engine/onchain-supply-candidate-store.ts",
      "utf-8",
    );
    // Ordered by slot only — never by value, and never aggregated.
    expect(src).toContain("desc(onchainArtifacts.slot)");
    expect(src).not.toContain("orderBy(desc(onchainArtifacts.artifactHash)");
    expect(src).not.toContain("groupBy");
    expect(src).not.toContain("max(onchainArtifacts");
    expect(src).not.toContain("sql`");
  });

  it("the loader needed no index and no change to onchain_artifacts", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const files = (await readdir("src/server/db/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // The candidate loader rides the index that already existed, and no
    // migration since has touched the artifact table it reads. (0044 adds the
    // delta's own provenance relation and does not alter this one.)
    const schema = await readFile("src/server/db/schema/engine.ts", "utf-8");
    expect(schema).toContain("ix_onchain_artifacts_uri");
    expect(schema).not.toContain("ix_onchain_artifacts_supply");
    for (const f of files.filter((n) => n > "0043")) {
      const sqlText = await readFile(`src/server/db/migrations/${f}`, "utf-8");
      expect(sqlText, `${f} must not alter onchain_artifacts`).not.toContain(
        'ALTER TABLE "onchain_artifacts"',
      );
    }
  });
});
