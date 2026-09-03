import { describe, expect, it } from "vitest";

import {
  EVENT_ANCHORED_SUPPLY_INTERVAL_DOES_NOT_PROVE,
  filterTemporalSupplyEligibility,
  selectEventAnchoredSupplyInterval,
  type EventAnchoredSupplyIntervalOutcome,
  type PersistedObservation,
} from "../src/server/engine/onchain-event-anchored-supply-interval";
import { deriveTotalSupplyDelta } from "../src/server/engine/onchain-supply-delta";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainIntent,
  TokenSupplyResult,
} from "../src/server/engine/providers/onchain-types";

// EVENT-ANCHORED SUPPLY INTERVAL.
//
// The interval a delta spans decides what the delta means, and the easy rule
// — "compare against whatever ATLAS last observed" — makes the answer a
// function of our own observation cadence rather than of the world. V1
// therefore anchors on a deterministic event established by this Research:
// the interval must contain it, and among those that do, the narrowest wins.
//
// These tests are pure: no database, no provider, no job. Most of them pin
// what must be REFUSED, because that is where an interval rule goes wrong.

const MINT = "Mint1111111111111111111111111111111111111111";
const OLD_MINT = "Mint2222222222222222222222222222222222222222";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const CURRENT_JOB = "11111111-1111-1111-1111-111111111111";
const PRIOR_JOB = "22222222-2222-2222-2222-222222222222";
const OTHER_PRIOR_JOB = "33333333-3333-3333-3333-333333333333";

function supplyArtifact(opts: {
  slot: number;
  amountRaw?: string;
  mint?: string;
  decimals?: number;
  finality?: "finalized" | "confirmed";
  retrievedAt?: Date;
}): OnchainArtifact {
  const mint = opts.mint ?? MINT;
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
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
      projectAnchor: mint,
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
      retrievedAt: opts.retrievedAt ?? new Date("2026-09-01T00:00:00.000Z"),
      rawResponseHash: `sha256:raw:${mint}:${opts.slot}`,
      artifactHash: `sha256:art:${mint}:${result.amountRaw}:${result.decimals}`,
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

function burnArtifact(opts: { slot: number; mint?: string; burns?: BurnInstructionRef[] }): OnchainArtifact {
  const mint = opts.mint ?? MINT;
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
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
      projectAnchor: mint,
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

function run(over: {
  eventSlot?: number;
  eventMint?: string;
  eventJob?: string | null;
  eventBurns?: BurnInstructionRef[];
  currentSlot?: number;
  currentMint?: string;
  currentJobOnRow?: string | null;
  currentOrigin?: PersistedObservation["originKind"];
  currentAmount?: string;
  currentFinality?: "finalized" | "confirmed";
  historical?: PersistedObservation[];
  anchor?: string;
}): EventAnchoredSupplyIntervalOutcome {
  return selectEventAnchoredSupplyInterval({
    currentResearchJobId: CURRENT_JOB,
    currentProjectAnchor: over.anchor ?? MINT,
    event: {
      artifact: burnArtifact({
        slot: over.eventSlot ?? 500,
        mint: over.eventMint ?? MINT,
        burns: over.eventBurns,
      }),
      burnIndex: 0,
      researchJobId: over.eventJob === undefined ? CURRENT_JOB : over.eventJob,
    },
    current: {
      artifact: supplyArtifact({
        slot: over.currentSlot ?? 900,
        amountRaw: over.currentAmount ?? "990",
        mint: over.currentMint ?? MINT,
        finality: over.currentFinality,
      }),
      originKind: over.currentOrigin ?? "RESEARCH_JOB",
      researchJobId: over.currentJobOnRow === undefined ? CURRENT_JOB : over.currentJobOnRow,
    },
    historical: over.historical ?? [observation({ slot: 100, amountRaw: "1000" })],
  });
}

function refusal(o: EventAnchoredSupplyIntervalOutcome) {
  return o.selected ? null : o.reason;
}

// ---------------------------------------------------------------------
// 1/2/3 — the rule itself.
// ---------------------------------------------------------------------

describe("1/2/3. the narrowest interval that still contains the event", () => {
  it("1. a prior-job t0 before the burn and a current t1 after it -> success", () => {
    const out = run({});
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    expect(out.interval.ordering).toEqual({
      historicalSlot: 100,
      eventSlot: 500,
      currentSlot: 900,
    });
    expect(out.interval.selectionRule).toBe("GREATEST_ELIGIBLE_SLOT_STRICTLY_BEFORE_EVENT");
    expect(out.interval.delta.deltaRaw).toBe("-10");
  });

  it("2/3. the GREATEST eligible slot before the event wins; the earliest does not", () => {
    const out = run({
      historical: [
        observation({ slot: 100, amountRaw: "5000" }),
        observation({ slot: 400, amountRaw: "1000" }),
        observation({ slot: 250, amountRaw: "3000" }),
      ],
    });
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    expect(out.interval.ordering.historicalSlot).toBe(400);
    expect(out.interval.historical.amountRaw).toBe("1000");
    // The earliest would have produced a completely different number.
    expect(out.interval.delta.deltaRaw).toBe("-10");
    expect(out.interval.eligibleCandidates).toBe(3);
    expect(out.interval.candidatesConsidered).toBe(3);
  });
});

// ---------------------------------------------------------------------
// 4/5/10/11 — eligibility, including the product policies.
// ---------------------------------------------------------------------

describe("4/5/10/11. who may take part at all", () => {
  it("4. a technically perfect STANDALONE observation is refused — product policy", () => {
    const standalone = observation({
      slot: 400,
      amountRaw: "1000",
      originKind: "STANDALONE_STRUCTURED_OBSERVATION",
      researchJobId: null,
    });
    // Its chain data is impeccable; it is still not eligible in V1.
    expect(deriveTotalSupplyDelta(standalone.artifact, supplyArtifact({ slot: 900, amountRaw: "990" })).comparable).toBe(true);
    const out = run({ historical: [standalone] });
    expect(refusal(out)).toBe("STANDALONE_OBSERVATION_NOT_ELIGIBLE");
    if (out.selected) return;
    expect(out.excluded).toEqual([{ index: 0, reason: "STANDALONE_OBSERVATION_NOT_ELIGIBLE" }]);
  });

  it("5. an earlier observation from the CURRENT job is not a historical one", () => {
    const out = run({
      historical: [observation({ slot: 400, amountRaw: "1000", researchJobId: CURRENT_JOB })],
    });
    expect(refusal(out)).toBe("HISTORICAL_OBSERVATION_NOT_PRIOR_JOB");
  });

  it("a valid PRIOR-job observation is eligible — approved product semantics", () => {
    const out = run({ historical: [observation({ slot: 400, amountRaw: "1000", researchJobId: OTHER_PRIOR_JOB })] });
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    // Its ORIGINAL job id survives; it is never rewritten to look current.
    expect(out.interval.historical.researchJobId).toBe(OTHER_PRIOR_JOB);
    expect(out.interval.current.researchJobId).toBe(CURRENT_JOB);
    expect(out.interval.historical.researchJobId).not.toBe(out.interval.current.researchJobId);
  });

  it("10. a candidate on the OLD mint is refused even though it is self-consistent", () => {
    const out = run({ historical: [observation({ slot: 400, amountRaw: "1000", mint: OLD_MINT })] });
    expect(refusal(out)).toBe("HISTORICAL_IDENTITY_MISMATCH");
  });

  it("11. a t1 that does not match the current ACTIVE identity is refused", () => {
    expect(refusal(run({ currentMint: OLD_MINT }))).toBe("CURRENT_IDENTITY_MISMATCH");
  });

  it("t1 must be a usable observation, of this job, of research origin", () => {
    expect(refusal(run({ currentFinality: "confirmed" }))).toBe("INVALID_CURRENT_OBSERVATION");
    expect(refusal(run({ currentOrigin: "STANDALONE_STRUCTURED_OBSERVATION", currentJobOnRow: null }))).toBe(
      "CURRENT_OBSERVATION_NOT_RESEARCH_ORIGIN",
    );
    expect(refusal(run({ currentJobOnRow: PRIOR_JOB }))).toBe("CURRENT_OBSERVATION_NOT_CURRENT_JOB");
  });
});

// ---------------------------------------------------------------------
// 6/7/8/9 — containment, strict on both sides.
// ---------------------------------------------------------------------

describe("6/7/8/9. strict event containment", () => {
  it("6. a candidate AFTER the burn cannot start an interval containing it", () => {
    const out = run({ historical: [observation({ slot: 700, amountRaw: "1000" })] });
    expect(refusal(out)).toBe("NO_EVENT_CONTAINING_INTERVAL");
  });

  it("7. a candidate AT the burn slot is refused — the left bound is strict", () => {
    // A burn at t0's slot is already reflected in t0's reading, so the delta
    // would not contain it and calling that containment would be false.
    const out = run({ historical: [observation({ slot: 500, amountRaw: "1000" })] });
    expect(refusal(out)).toBe("NO_EVENT_CONTAINING_INTERVAL");
  });

  it("8. a burn AT t1's slot fails closed for now", () => {
    // Whether a finalized read at slot S includes slot S's transactions has
    // not been validated against a live node. Until it is, equality on the
    // right bound is refused rather than assumed.
    expect(refusal(run({ eventSlot: 900, currentSlot: 900 }))).toBe(
      "EVENT_NOT_STRICTLY_BEFORE_CURRENT_OBSERVATION",
    );
  });

  it("9. a burn AFTER t1 is outside the interval entirely", () => {
    expect(refusal(run({ eventSlot: 950, currentSlot: 900 }))).toBe(
      "EVENT_NOT_STRICTLY_BEFORE_CURRENT_OBSERVATION",
    );
  });

  it("the event must be this job's, this mint's, and a real decoded burn", () => {
    expect(refusal(run({ eventJob: PRIOR_JOB }))).toBe("EVENT_NOT_CURRENT_JOB");
    expect(refusal(run({ eventMint: OLD_MINT }))).toBe("EVENT_MINT_MISMATCH");
    expect(refusal(run({ eventBurns: [] }))).toBe("INVALID_EVENT");
  });
});

// ---------------------------------------------------------------------
// 12/13 — no fallback, ever.
// ---------------------------------------------------------------------

describe("12/13. refusals are typed, and nothing falls back", () => {
  it("12. a valid prior candidate that is NOT comparable with t1 is excluded", () => {
    const out = run({
      historical: [observation({ slot: 400, amountRaw: "1000", decimals: 9 })],
    });
    expect(refusal(out)).toBe("NO_COMPARABLE_HISTORICAL_OBSERVATION");
  });

  it("13. no qualifying t0 -> typed refusal, and no fallback of any kind", () => {
    expect(refusal(run({ historical: [] }))).toBe("NO_HISTORICAL_CANDIDATES");
    // A mixture in which everything fails reports the NEAREST miss rather
    // than the first rejection — and selects nothing.
    const out = run({
      historical: [
        observation({ slot: 400, originKind: "STANDALONE_STRUCTURED_OBSERVATION", researchJobId: null }),
        observation({ slot: 700, amountRaw: "1000" }),
      ],
    });
    expect(refusal(out)).toBe("NO_EVENT_CONTAINING_INTERVAL");
    if (out.selected) return;
    expect(out.excluded).toEqual([
      { index: 0, reason: "STANDALONE_OBSERVATION_NOT_ELIGIBLE" },
      { index: 1, reason: "NO_EVENT_CONTAINING_INTERVAL" },
    ]);
  });

  it("two eligible candidates at one slot that DISAGREE are never silently resolved", () => {
    const out = run({
      historical: [
        observation({ slot: 400, amountRaw: "1000", researchJobId: PRIOR_JOB }),
        observation({ slot: 400, amountRaw: "2000", researchJobId: OTHER_PRIOR_JOB }),
      ],
    });
    expect(refusal(out)).toBe("AMBIGUOUS_HISTORICAL_OBSERVATION");
  });

  it("two jobs recording the SAME reading at one slot resolve deterministically", () => {
    const out = run({
      historical: [
        observation({ slot: 400, amountRaw: "1000", researchJobId: PRIOR_JOB }),
        observation({ slot: 400, amountRaw: "1000", researchJobId: OTHER_PRIOR_JOB }),
      ],
    });
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    expect(out.interval.delta.deltaRaw).toBe("-10");
  });
});

// ---------------------------------------------------------------------
// 14-19 — the result, and what it must carry.
// ---------------------------------------------------------------------

describe("14/15/16/17. the delta is recomputed, and all three directions are valid", () => {
  it("14. the selected pair reproduces B2a exactly", () => {
    const t0 = observation({ slot: 400, amountRaw: "1000" });
    const out = run({ historical: [t0], currentAmount: "990" });
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    const direct = deriveTotalSupplyDelta(t0.artifact, supplyArtifact({ slot: 900, amountRaw: "990" }));
    expect(direct.comparable).toBe(true);
    if (!direct.comparable) return;
    expect(out.interval.delta).toEqual(direct.delta);
  });

  it("15/16/17. DECREASED, UNCHANGED and INCREASED are all valid measurements", () => {
    const cases: [string, string, string][] = [
      ["1000", "990", "DECREASED"],
      ["1000", "1000", "UNCHANGED"],
      ["1000", "1010", "INCREASED"],
    ];
    for (const [t0Amount, t1Amount, direction] of cases) {
      const out = run({
        historical: [observation({ slot: 400, amountRaw: t0Amount })],
        currentAmount: t1Amount,
      });
      expect(out.selected, `${direction} was refused`).toBe(true);
      if (!out.selected) continue;
      expect(out.interval.delta.direction).toBe(direction);
    }
  });
});

describe("18/19. provenance and age", () => {
  it("18. the result retains both job ids, both observations and the burn", () => {
    const out = run({ historical: [observation({ slot: 400, amountRaw: "1000", researchJobId: PRIOR_JOB })] });
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    const i = out.interval;
    expect(i.historical.researchJobId).toBe(PRIOR_JOB);
    expect(i.current.researchJobId).toBe(CURRENT_JOB);
    expect(i.currentResearchJobId).toBe(CURRENT_JOB);
    expect(i.historical.artifactHash).toBe("sha256:art:" + MINT + ":1000:6");
    expect(i.historical.rawResponseHash).toBe(`sha256:raw:${MINT}:400`);
    expect(i.current.rawResponseHash).toBe(`sha256:raw:${MINT}:900`);
    expect(i.event.signature).toBe(SIGNATURE);
    expect(i.event.slot).toBe(500);
    expect(i.event.artifactHash).toBe("sha256:art:tx");
    expect(i.event.sourceAccount).toBe(TOKEN_ACCOUNT);
    expect(i.ordering).toEqual({ historicalSlot: 400, eventSlot: 500, currentSlot: 900 });
    expect(i.projectAnchor).toBe(MINT);
  });

  it("19. the AGE of t0 does not affect eligibility", () => {
    // An old t0 is often the intended start of the interval. Age is
    // disclosed metadata, never a hard eligibility rule — and no day
    // threshold is invented anywhere.
    const ancient = observation({
      slot: 400,
      amountRaw: "1000",
      retrievedAt: new Date("2019-01-01T00:00:00.000Z"),
    });
    const recent = observation({
      slot: 400,
      amountRaw: "1000",
      retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const a = run({ historical: [ancient] });
    const b = run({ historical: [recent] });
    expect(a.selected).toBe(true);
    expect(b.selected).toBe(true);
    if (!a.selected || !b.selected) return;
    expect(a.interval.delta.deltaRaw).toBe(b.interval.delta.deltaRaw);
    // And the age IS carried, so a consumer can disclose it.
    expect(a.interval.historical.retrievedAt.getUTCFullYear()).toBe(2019);
  });
});

// ---------------------------------------------------------------------
// The semantic invariant: the interval is a CHOICE, and it is exposed.
// ---------------------------------------------------------------------

describe("SEMANTIC. the answer depends on what was available, and says so", () => {
  it("changing only the candidate set changes the selected interval AND the number", () => {
    const far = observation({ slot: 100, amountRaw: "5000" });
    const near = observation({ slot: 400, amountRaw: "1000" });

    const onlyFar = run({ historical: [far] });
    const both = run({ historical: [far, near] });
    expect(onlyFar.selected).toBe(true);
    expect(both.selected).toBe(true);
    if (!onlyFar.selected || !both.selected) return;

    // Same chain, same event, same t1 — different available history, and a
    // different measured interval AND a different delta. This is exactly why
    // the interval must travel with the number.
    expect(onlyFar.interval.ordering.historicalSlot).toBe(100);
    expect(both.interval.ordering.historicalSlot).toBe(400);
    expect(onlyFar.interval.delta.deltaRaw).toBe("-4010");
    expect(both.interval.delta.deltaRaw).toBe("-10");
    expect(onlyFar.interval.delta.deltaRaw).not.toBe(both.interval.delta.deltaRaw);

    // Both results expose the interval and how many candidates there were,
    // so neither can be read as a timeless global truth.
    for (const r of [onlyFar.interval, both.interval]) {
      expect(r.ordering.historicalSlot).toBeLessThan(r.ordering.eventSlot);
      expect(r.ordering.eventSlot).toBeLessThan(r.ordering.currentSlot);
      expect(r.eligibleCandidates).toBeGreaterThan(0);
      expect(r.selectionRule).toBe("GREATEST_ELIGIBLE_SLOT_STRICTLY_BEFORE_EVENT");
    }
  });

  it("the stated ceiling refuses every causal reading", () => {
    for (const phrase of [
      "does NOT establish that the burn caused the change",
      "does NOT establish that any buyback or mechanism caused the burn",
      "the change is the NET of everything that happened in it",
      "circulating supply",
      "never shows that none did",
    ]) {
      expect(EVENT_ANCHORED_SUPPLY_INTERVAL_DOES_NOT_PROVE).toContain(phrase);
    }
  });
});

// ---------------------------------------------------------------------
// 20/21 — boundaries.
// ---------------------------------------------------------------------

describe("20/21. pure, unwired, and nothing to fall back on", () => {
  it("21. no database, model, reconciliation or memory import", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(
      "src/server/engine/onchain-event-anchored-supply-interval.ts",
      "utf-8",
    );
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
      "component-reconcil",
      "onchain-facts",
      "server/memory",
      "projectMemoryItems",
      "resolveConfirmedIdentity",
      "anthropic",
      "NET_EFFECT",
      "toLowerCase",
      "includes(",
    ]) {
      expect(code, `pure module must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("20. nothing in src or scripts imports it — no production wiring", async () => {
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
    const importers: string[] = [];
    for (const f of files) {
      if (f.endsWith("onchain-event-anchored-supply-interval.ts")) continue;
      const src = await readFile(f, "utf-8");
      if (src.includes("onchain-event-anchored-supply-interval")) importers.push(f);
    }
    expect(importers).toEqual([]);
  });

  it("no fact kind, no applicability change, no project name", async () => {
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).not.toContain("SUPPLY_DELTA");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    const lower = (
      await readFile("src/server/engine/onchain-event-anchored-supply-interval.ts", "utf-8")
    ).toLowerCase();
    for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan"]) {
      expect(lower, `must not name "${banned}"`).not.toContain(banned);
    }
  });

  it("eligibility and selection are separable, and eligibility never chooses", () => {
    const { eligible, excluded } = filterTemporalSupplyEligibility({
      currentResearchJobId: CURRENT_JOB,
      currentProjectAnchor: MINT,
      eventSlot: 500,
      current: supplyArtifact({ slot: 900, amountRaw: "990" }) as OnchainArtifact & {
        result: TokenSupplyResult;
      },
      historical: [
        observation({ slot: 100, amountRaw: "5000" }),
        observation({ slot: 400, amountRaw: "1000" }),
        observation({ slot: 700, amountRaw: "900" }),
      ],
    });
    // It returns EVERY eligible candidate, in input order, and picks none.
    expect(eligible.map((e) => e.slot)).toEqual([100, 400]);
    expect(excluded).toEqual([{ index: 2, reason: "NO_EVENT_CONTAINING_INTERVAL" }]);
  });
});
