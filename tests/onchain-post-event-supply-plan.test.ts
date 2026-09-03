import { describe, expect, it } from "vitest";

import {
  planPostEventSupplyAcquisition,
  POST_EVENT_SUPPLY_PLAN_DOES_NOT_PROVE,
  type PostEventSupplyPlan,
} from "../src/server/engine/onchain-post-event-supply-plan";
import {
  selectEventAnchoredSupplyInterval,
  type AnchorBurnEvent,
  type PersistedObservation,
} from "../src/server/engine/onchain-event-anchored-supply-interval";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";

// POST-EVENT SUPPLY PLANNER.
//
// A TOKEN_SUPPLY observation carries the node's CONTEXT slot at read time; a
// BURN carries the slot of the transaction that contained it. Two different
// clocks, and the interval selector compares them strictly. These tests pin
// the one question this planner answers — does this Research already hold an
// observation strictly after the event — and, just as importantly, pin what
// answering it must NOT be taken to mean.
//
// Pure: no database, no provider, no budget, no job.

const MINT = "Mint1111111111111111111111111111111111111111";
const OTHER_MINT = "Mint2222222222222222222222222222222222222222";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const CURRENT_JOB = "11111111-1111-1111-1111-111111111111";
const PRIOR_JOB = "22222222-2222-2222-2222-222222222222";

function supplyArtifact(opts: {
  slot: number;
  amountRaw?: string;
  mint?: string;
  anchor?: string;
  decimals?: number;
  finality?: "finalized" | "confirmed";
}): OnchainArtifact {
  const mint = opts.mint ?? MINT;
  const anchor = opts.anchor ?? mint;
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
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
      network: "mainnet",
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
      artifactHash: `sha256:art:${mint}:${result.amountRaw}`,
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
    researchJobId: opts.researchJobId === undefined ? CURRENT_JOB : opts.researchJobId,
  };
}

function burnArtifact(opts: {
  slot: number;
  mint?: string;
  anchor?: string;
  burns?: BurnInstructionRef[];
}): OnchainArtifact {
  const mint = opts.mint ?? MINT;
  const anchor = opts.anchor ?? mint;
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "tx",
    subject: SIGNATURE,
  };
  const result = {
    kind: "TRANSACTION_DETAIL" as const,
    signature: SIGNATURE,
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
      subject: SIGNATURE,
      slot: opts.slot,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: SIGNATURE },
      transactionSignature: SIGNATURE,
      retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
      rawResponseHash: "sha256:raw:tx",
      artifactHash: "sha256:art:tx",
    },
  });
}

function event(opts: {
  slot: number;
  mint?: string;
  anchor?: string;
  burns?: BurnInstructionRef[];
  burnIndex?: number;
  researchJobId?: string | null;
}): AnchorBurnEvent {
  return {
    artifact: burnArtifact(opts),
    burnIndex: opts.burnIndex ?? 0,
    researchJobId: opts.researchJobId === undefined ? CURRENT_JOB : opts.researchJobId,
  };
}

function plan(over: {
  events?: AnchorBurnEvent[];
  observations?: PersistedObservation[];
  anchor?: string;
}): PostEventSupplyPlan {
  return planPostEventSupplyAcquisition({
    currentResearchJobId: CURRENT_JOB,
    currentProjectAnchor: over.anchor ?? MINT,
    events: over.events ?? [event({ slot: 500 })],
    observations: over.observations ?? [],
  });
}

// ---------------------------------------------------------------------
// The gap the planner exists to detect.
// ---------------------------------------------------------------------

describe("the temporal gap", () => {
  it("an observation strictly after the event means nothing is required", () => {
    const out = plan({ observations: [observation({ slot: 900 })] });
    expect(out.decision).toBe("NO_ACTION");
    expect(out.reason).toBe("POST_EVENT_OBSERVATION_ALREADY_HELD");
    expect(out.eventSlot).toBe(500);
    expect(out.newestObservationSlot).toBe(900);
  });

  it("every observation before the event means one is required", () => {
    const out = plan({
      observations: [observation({ slot: 100 }), observation({ slot: 400, amountRaw: "1001" })],
    });
    expect(out.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(out.reason).toBe("EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT");
    expect(out.newestObservationSlot).toBe(400);
  });

  it("an observation AT the event's slot does not satisfy it — strict, fail closed", () => {
    const out = plan({ observations: [observation({ slot: 500 })] });
    expect(out.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(out.reason).toBe("EVERY_CURRENT_OBSERVATION_AT_OR_BEFORE_EVENT");
  });

  it("one slot after the event is enough — nothing about wall clock", () => {
    const out = plan({ observations: [observation({ slot: 501 })] });
    expect(out.decision).toBe("NO_ACTION");
  });

  it("no supply observation at all is a distinct required reason", () => {
    const out = plan({ observations: [] });
    expect(out.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(out.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
    expect(out.newestObservationSlot).toBeNull();
  });

  it("the GREATEST event slot decides, so one answer covers every event", () => {
    const out = plan({
      events: [event({ slot: 200 }), event({ slot: 900 }), event({ slot: 400 })],
      observations: [observation({ slot: 500 })],
    });
    expect(out.eventSlot).toBe(900);
    expect(out.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(out.usableEvents).toBe(3);
  });
});

// ---------------------------------------------------------------------
// No event, no question.
// ---------------------------------------------------------------------

describe("without a usable event there is nothing to position against", () => {
  it("an empty event list is NO_ACTION, never a required read", () => {
    const out = plan({ events: [], observations: [] });
    expect(out.decision).toBe("NO_ACTION");
    expect(out.reason).toBe("NO_USABLE_EVENT");
    expect(out.eventSlot).toBeNull();
  });

  it("an event from another job is not this Research's anchor", () => {
    const out = plan({ events: [event({ slot: 500, researchJobId: PRIOR_JOB })] });
    expect(out.reason).toBe("NO_USABLE_EVENT");
    expect(out.usableEvents).toBe(0);
    expect(out.eventsConsidered).toBe(1);
  });

  it("a standalone-origin event (null job) is refused", () => {
    const out = plan({ events: [event({ slot: 500, researchJobId: null })] });
    expect(out.reason).toBe("NO_USABLE_EVENT");
  });

  it("a burn of another mint is refused", () => {
    const out = plan({ events: [event({ slot: 500, mint: OTHER_MINT, anchor: OTHER_MINT })] });
    expect(out.reason).toBe("NO_USABLE_EVENT");
  });

  it("a burn whose anchor disagrees with its own mint is refused, never a coin toss", () => {
    const out = plan({ events: [event({ slot: 500, mint: MINT, anchor: OTHER_MINT })] });
    expect(out.reason).toBe("NO_USABLE_EVENT");
  });

  it("a burnIndex naming nothing is refused", () => {
    const out = plan({ events: [event({ slot: 500, burnIndex: 3 })] });
    expect(out.reason).toBe("NO_USABLE_EVENT");
  });

  it("a burn with no source account is refused", () => {
    const out = plan({
      events: [
        event({
          slot: 500,
          burns: [
            {
              programId: "TokenProg1111111111111111111111111111111111",
              instructionType: "BurnChecked",
              mint: MINT,
              sourceAccount: "",
              authority: null,
              amountRaw: "1",
              decimals: 6,
            },
          ] as BurnInstructionRef[],
        }),
      ],
    });
    expect(out.reason).toBe("NO_USABLE_EVENT");
  });

  it("a non-transaction artifact is not an event", () => {
    const out = plan({
      events: [{ artifact: supplyArtifact({ slot: 500 }), burnIndex: 0, researchJobId: CURRENT_JOB }],
    });
    expect(out.reason).toBe("NO_USABLE_EVENT");
  });

  it("no supply observation plus no event is still NO_ACTION, not a read", () => {
    const out = plan({ events: [], observations: [] });
    expect(out.decision).toBe("NO_ACTION");
  });

  it("one unusable event among usable ones does not change the answer", () => {
    const out = plan({
      events: [event({ slot: 900, researchJobId: PRIOR_JOB }), event({ slot: 300 })],
      observations: [observation({ slot: 400 })],
    });
    expect(out.eventSlot).toBe(300);
    expect(out.usableEvents).toBe(1);
    expect(out.decision).toBe("NO_ACTION");
  });
});

// ---------------------------------------------------------------------
// Which observations may count as t1 at all.
// ---------------------------------------------------------------------

describe("only this Research's own comparable observations count", () => {
  it("a prior job's observation is not t1, however new it is", () => {
    const out = plan({ observations: [observation({ slot: 9_000, researchJobId: PRIOR_JOB })] });
    expect(out.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
    expect(out.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
    expect(out.observationsConsidered).toBe(1);
    expect(out.comparableObservations).toBe(0);
  });

  it("a standalone observation is not t1 — owner activity does not move a Proof", () => {
    const out = plan({
      observations: [
        observation({
          slot: 9_000,
          originKind: "STANDALONE_STRUCTURED_OBSERVATION",
          researchJobId: null,
        }),
      ],
    });
    expect(out.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
  });

  it("a non-finalized observation is not comparable", () => {
    const out = plan({ observations: [observation({ slot: 9_000, finality: "confirmed" })] });
    expect(out.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
  });

  it("an observation of another mint is not this project's t1", () => {
    const out = plan({
      observations: [observation({ slot: 9_000, mint: OTHER_MINT, anchor: OTHER_MINT })],
    });
    expect(out.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
  });

  it("an observation whose anchor disagrees with its own mint is refused", () => {
    const out = plan({
      observations: [observation({ slot: 9_000, mint: MINT, anchor: OTHER_MINT })],
    });
    expect(out.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
  });

  it("a non-supply artifact is not an observation", () => {
    const out = plan({
      observations: [
        { artifact: burnArtifact({ slot: 9_000 }), originKind: "RESEARCH_JOB", researchJobId: CURRENT_JOB },
      ],
    });
    expect(out.reason).toBe("NO_COMPARABLE_CURRENT_OBSERVATION");
  });

  it("foreign candidates are counted, not silently dropped", () => {
    const out = plan({
      observations: [
        observation({ slot: 100 }),
        observation({ slot: 9_000, researchJobId: PRIOR_JOB }),
        observation({ slot: 9_001, originKind: "STANDALONE_STRUCTURED_OBSERVATION", researchJobId: null }),
      ],
    });
    expect(out.observationsConsidered).toBe(3);
    expect(out.comparableObservations).toBe(1);
    expect(out.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
  });
});

// ---------------------------------------------------------------------
// It must agree with the selector it exists to serve.
// ---------------------------------------------------------------------

describe("the planner and the interval selector never disagree about t1", () => {
  const cases: { obsSlot: number; eventSlot: number }[] = [
    { obsSlot: 499, eventSlot: 500 },
    { obsSlot: 500, eventSlot: 500 },
    { obsSlot: 501, eventSlot: 500 },
  ];

  for (const c of cases) {
    it(`observation at ${c.obsSlot} vs event at ${c.eventSlot}`, () => {
      const current = observation({ slot: c.obsSlot, amountRaw: "990" });
      const anchorEvent = event({ slot: c.eventSlot });
      const planned = planPostEventSupplyAcquisition({
        currentResearchJobId: CURRENT_JOB,
        currentProjectAnchor: MINT,
        events: [anchorEvent],
        observations: [current],
      });
      const selected = selectEventAnchoredSupplyInterval({
        currentResearchJobId: CURRENT_JOB,
        currentProjectAnchor: MINT,
        event: anchorEvent,
        current,
        historical: [
          {
            artifact: supplyArtifact({ slot: 100, amountRaw: "1000" }),
            originKind: "RESEARCH_JOB",
            researchJobId: PRIOR_JOB,
          },
        ],
      });
      // The planner says "already held" exactly when the selector is able
      // to accept that observation as t1.
      const selectorAcceptedT1 =
        selected.selected ||
        selected.reason !== "EVENT_NOT_STRICTLY_BEFORE_CURRENT_OBSERVATION";
      expect(planned.decision === "NO_ACTION").toBe(selectorAcceptedT1);
    });
  }

  it("NO_ACTION does not mean a delta exists — t0 is a separate question", () => {
    const anchorEvent = event({ slot: 500 });
    const current = observation({ slot: 900, amountRaw: "990" });
    expect(
      planPostEventSupplyAcquisition({
        currentResearchJobId: CURRENT_JOB,
        currentProjectAnchor: MINT,
        events: [anchorEvent],
        observations: [current],
      }).decision,
    ).toBe("NO_ACTION");
    // Same inputs, no historical candidate: the interval still refuses.
    const selected = selectEventAnchoredSupplyInterval({
      currentResearchJobId: CURRENT_JOB,
      currentProjectAnchor: MINT,
      event: anchorEvent,
      current,
      historical: [],
    });
    expect(selected.selected).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Determinism, and the boundary it must not cross.
// ---------------------------------------------------------------------

describe("determinism and boundaries", () => {
  it("the same inputs in any order give the same answer", () => {
    const events = [event({ slot: 300 }), event({ slot: 700 })];
    const observations = [observation({ slot: 200 }), observation({ slot: 650, amountRaw: "999" })];
    const a = planPostEventSupplyAcquisition({
      currentResearchJobId: CURRENT_JOB,
      currentProjectAnchor: MINT,
      events,
      observations,
    });
    const b = planPostEventSupplyAcquisition({
      currentResearchJobId: CURRENT_JOB,
      currentProjectAnchor: MINT,
      events: [...events].reverse(),
      observations: [...observations].reverse(),
    });
    expect(a).toEqual(b);
  });

  it("the result is ONE decision — there is no shape in which two reads fit", () => {
    const out = plan({ observations: [] });
    expect(Array.isArray((out as unknown as { requests?: unknown }).requests)).toBe(false);
    expect(typeof out.decision).toBe("string");
    expect(Object.keys(out).filter((k) => k.toLowerCase().includes("count"))).toEqual([]);
  });

  it("REQUIRED states necessity, never authorization", () => {
    for (const phrase of [
      "it does NOT authorise a read",
      "does NOT establish that budget exists",
      "t0 is a separate question",
      "WIDENS the interval and proves nothing extra",
    ]) {
      expect(POST_EVENT_SUPPLY_PLAN_DOES_NOT_PROVE.join(" | ")).toContain(phrase);
    }
  });

  it("no database, provider, budget, model or reconciliation import", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("src/server/engine/onchain-post-event-supply-plan.ts", "utf-8");
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const banned of [
      "drizzle-orm",
      'from "../db/',
      ".select(",
      ".insert(",
      "sql`",
      "reserveJobBudget",
      "budget-reservation",
      "onchain-retriever",
      "runStructuredOnchainAcquisition",
      "onchain-reactivation",
      "component-reconcil",
      "onchain-facts",
      "recordTraceEvent",
      "anthropic",
      "NET_EFFECT",
      "Date.now",
      "toLowerCase",
    ]) {
      expect(code, `pure module must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("it names no project and synthesizes no fact kind", async () => {
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).not.toContain("SUPPLY_DELTA");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    const lower = (
      await readFile("src/server/engine/onchain-post-event-supply-plan.ts", "utf-8")
    ).toLowerCase();
    for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan"]) {
      expect(lower, `must not name "${banned}"`).not.toContain(banned);
    }
  });

  it("nothing outside the closed B2 cluster reaches it", async () => {
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
    ];
    const isMember = (f: string) => CLUSTER.some((m) => f.endsWith(`${m}.ts`));
    const outsideImporters: string[] = [];
    for (const f of files) {
      if (isMember(f)) continue;
      const code = (await readFile(f, "utf-8"))
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      if (code.includes("onchain-post-event-supply-plan")) outsideImporters.push(f);
    }
    expect(outsideImporters).toEqual([]);
  });
});
