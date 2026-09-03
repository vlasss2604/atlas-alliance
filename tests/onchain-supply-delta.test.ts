import { describe, expect, it } from "vitest";

import {
  deriveTotalSupplyDelta,
  TOTAL_SUPPLY_DELTA_DOES_NOT_PROVE,
  type TotalSupplyDeltaOutcome,
} from "../src/server/engine/onchain-supply-delta";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";

// TOTAL SUPPLY DELTA — the pure arithmetic, and nothing else.
//
// `getTokenSupply` can only read the mint's live state: the intent contract
// carries no slot and the method takes none, so a supply CHANGE cannot be
// retrieved. It can only be DERIVED from two observations, which makes the
// comparison itself the capability.
//
// These tests are pure: no database, no provider, no job, no Evidence. They
// construct observations explicitly, which is the whole point of isolating
// this primitive before anything acquires, persists or consumes one.

const MINT = "Mint1111111111111111111111111111111111111111";
const OTHER_MINT = "Mint2222222222222222222222222222222222222222";

function intentFor(mint: string, chain = "solana", network = "mainnet"): OnchainIntent {
  return {
    kind: "TOKEN_SUPPLY",
    chain: chain as OnchainIntent["chain"],
    network: network as OnchainIntent["network"],
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };
}

interface ObservationOptions {
  mint?: string;
  amountRaw?: string;
  decimals?: number;
  slot?: number;
  chain?: string;
  network?: string;
  finality?: "finalized" | "confirmed";
  // Deliberate corruptions, for the fail-closed cases only.
  subjectOverride?: string;
  resultOverride?: OnchainResult;
  providerId?: string;
  retrievedAt?: Date;
}

// An observation exactly as the Solana adapter brands one: the normalized
// TOKEN_SUPPLY result plus the provenance the deterministic observation
// contract requires.
function observation(opts: ObservationOptions = {}): OnchainArtifact {
  const mint = opts.mint ?? MINT;
  const chain = opts.chain ?? "solana";
  const network = opts.network ?? "mainnet";
  const slot = opts.slot ?? 1_000;
  const intent = intentFor(mint, chain, network);
  const result: OnchainResult = opts.resultOverride ?? {
    kind: "TOKEN_SUPPLY",
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
      chain: chain as OnchainArtifact["provenance"]["chain"],
      network: network as OnchainArtifact["provenance"]["network"],
      projectAnchor: mint,
      subjectKind: "token",
      subject: opts.subjectOverride ?? mint,
      slot,
      blockTime: null,
      blockHash: null,
      finality: opts.finality ?? "finalized",
      retrievalMethod: "RPC",
      providerId: opts.providerId ?? "fixture-provider",
      providerMethod: "getTokenSupply",
      requestParams: { subject: mint },
      transactionSignature: null,
      retrievedAt: opts.retrievedAt ?? new Date("2026-09-01T00:00:00.000Z"),
      rawResponseHash: `sha256:raw:${mint}:${slot}`,
      artifactHash: `sha256:art:${mint}:${slot}`,
    },
  });
}

function refusal(outcome: TotalSupplyDeltaOutcome) {
  return outcome.comparable ? null : outcome.reason;
}

// ---------------------------------------------------------------------
// 1/2/3 — the arithmetic itself.
// ---------------------------------------------------------------------

describe("1/2/3. an exact delta in all three directions", () => {
  it("1. a lower supply at a later slot is an exact negative delta", () => {
    const out = deriveTotalSupplyDelta(
      observation({ amountRaw: "1000", slot: 100 }),
      observation({ amountRaw: "990", slot: 200 }),
    );
    expect(out.comparable).toBe(true);
    if (!out.comparable) return;
    expect(out.delta.deltaRaw).toBe("-10");
    expect(out.delta.direction).toBe("DECREASED");
    expect(out.delta.slotSpan).toBe(100);
    expect(out.delta.mint).toBe(MINT);
    expect(out.delta.decimals).toBe(6);
  });

  it("2. a higher supply at a later slot is an exact positive delta", () => {
    const out = deriveTotalSupplyDelta(
      observation({ amountRaw: "990", slot: 100 }),
      observation({ amountRaw: "1000", slot: 200 }),
    );
    expect(out.comparable).toBe(true);
    if (!out.comparable) return;
    expect(out.delta.deltaRaw).toBe("10");
    expect(out.delta.direction).toBe("INCREASED");
  });

  it("3. EQUAL supply at a LATER slot succeeds and is UNCHANGED", () => {
    // The load-bearing case. Two readings of the same value at different
    // slots are two observations, not one duplicate: "supply did not move
    // over this interval" is a finding, and refusing to derive it would
    // make absence of change indistinguishable from absence of data.
    const out = deriveTotalSupplyDelta(
      observation({ amountRaw: "1000", slot: 100 }),
      observation({ amountRaw: "1000", slot: 200 }),
    );
    expect(out.comparable).toBe(true);
    if (!out.comparable) return;
    expect(out.delta.deltaRaw).toBe("0");
    expect(out.delta.direction).toBe("UNCHANGED");
    expect(out.delta.slotSpan).toBe(100);
  });
});

// ---------------------------------------------------------------------
// 4-11 — fail closed, with a typed reason rather than a boolean.
// ---------------------------------------------------------------------

describe("4/5/6/7. two observations must be of the same measurable thing", () => {
  it("4. a different mint is not the same token", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ mint: MINT, slot: 100 }),
          observation({ mint: OTHER_MINT, slot: 200 }),
        ),
      ),
    ).toBe("MINT_MISMATCH");
  });

  it("5. a different network is not the same chain state", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ slot: 100, network: "mainnet" }),
          observation({ slot: 200, network: "devnet" }),
        ),
      ),
    ).toBe("NETWORK_MISMATCH");
  });

  it("6. a different chain is not the same token at all", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ slot: 100, chain: "solana" }),
          observation({ slot: 200, chain: "ethereum" }),
        ),
      ),
    ).toBe("CHAIN_MISMATCH");
  });

  it("7. mismatched decimals means the same raw number means two things", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ slot: 100, decimals: 6 }),
          observation({ slot: 200, decimals: 9 }),
        ),
      ),
    ).toBe("DECIMALS_MISMATCH");
  });
});

describe("8/9. an interval needs a strictly later reading", () => {
  it("8. equal slots are the same chain position, not a span of zero", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ amountRaw: "1000", slot: 100 }),
          observation({ amountRaw: "990", slot: 100 }),
        ),
      ),
    ).toBe("NON_INCREASING_SLOT");
  });

  it("9. a later reading at an EARLIER slot is refused, never reordered", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ amountRaw: "1000", slot: 200 }),
          observation({ amountRaw: "990", slot: 100 }),
        ),
      ),
    ).toBe("NON_INCREASING_SLOT");
  });
});

describe("10/11. a raw supply we would have to guess at is not an observation", () => {
  it("10. malformed integers are refused rather than coerced", () => {
    for (const bad of ["", " 12", "1.5", "1e3", "0x10", "12abc", "007", "+12", "NaN"]) {
      expect(
        refusal(
          deriveTotalSupplyDelta(
            observation({ amountRaw: bad, slot: 100 }),
            observation({ amountRaw: "990", slot: 200 }),
          ),
        ),
        `"${bad}" was accepted`,
      ).toBe("INVALID_RAW_SUPPLY");
    }
  });

  it("11. a negative raw supply is refused", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ amountRaw: "1000", slot: 100 }),
          observation({ amountRaw: "-5", slot: 200 }),
        ),
      ),
    ).toBe("INVALID_RAW_SUPPLY");
  });

  it("a non-TOKEN_SUPPLY observation is refused by kind", () => {
    const notSupply = observation({
      slot: 200,
      resultOverride: {
        kind: "ACCOUNT_INFO",
        address: MINT,
        exists: true,
        ownerProgram: "SysProg11111111111111111111111111111111111",
        executable: false,
        lamports: "1",
        tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
        tokenAccount: null,
      },
    });
    expect(refusal(deriveTotalSupplyDelta(observation({ slot: 100 }), notSupply))).toBe(
      "WRONG_FACT_KIND",
    );
  });

  it("a non-finalized reading may not anchor an interval", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ slot: 100 }),
          observation({ slot: 200, finality: "confirmed" }),
        ),
      ),
    ).toBe("NON_FINALIZED_OBSERVATION");
  });

  it("an invalid slot is named specifically, before the general contract", () => {
    expect(
      refusal(
        deriveTotalSupplyDelta(observation({ slot: -1 }), observation({ slot: 200 })),
      ),
    ).toBe("MISSING_OR_INVALID_SLOT");
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ slot: 1.5 }),
          observation({ slot: 200 }),
        ),
      ),
    ).toBe("MISSING_OR_INVALID_SLOT");
  });

  it("incomplete provenance, and a reading that disagrees with itself, are refused", () => {
    // The existing deterministic observation contract, reused: an
    // observation nobody can re-verify cannot anchor anything.
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ slot: 100, providerId: "" }),
          observation({ slot: 200 }),
        ),
      ),
    ).toBe("INVALID_PROVENANCE");
    // The response names one mint while provenance names another subject.
    expect(
      refusal(
        deriveTotalSupplyDelta(
          observation({ slot: 100, subjectOverride: OTHER_MINT }),
          observation({ slot: 200 }),
        ),
      ),
    ).toBe("INVALID_PROVENANCE");
  });
});

// ---------------------------------------------------------------------
// 12 — exactness.
// ---------------------------------------------------------------------

describe("12. exact integer arithmetic far beyond Number.MAX_SAFE_INTEGER", () => {
  it("loses nothing where floating point would", () => {
    // Nine decimals and a large supply put the raw value well past 2^53.
    const t0 = "9007199254740993000000000"; // deliberately not representable as a double
    const t1 = "9007199254740992999999999"; // exactly one raw unit lower
    const out = deriveTotalSupplyDelta(
      observation({ amountRaw: t0, slot: 100, decimals: 9 }),
      observation({ amountRaw: t1, slot: 200, decimals: 9 }),
    );
    expect(out.comparable).toBe(true);
    if (!out.comparable) return;
    expect(out.delta.deltaRaw).toBe("-1");
    expect(out.delta.direction).toBe("DECREASED");
    // The same subtraction in floating point silently returns zero.
    expect(Number(t1) - Number(t0)).toBe(0);
  });

  it("a huge positive delta is exact too", () => {
    const out = deriveTotalSupplyDelta(
      observation({ amountRaw: "0", slot: 100 }),
      observation({ amountRaw: "340282366920938463463374607431768211455", slot: 200 }),
    );
    expect(out.comparable).toBe(true);
    if (!out.comparable) return;
    expect(out.delta.deltaRaw).toBe("340282366920938463463374607431768211455");
  });
});

// ---------------------------------------------------------------------
// 13/14/15 — what the result carries, and what it must not require.
// ---------------------------------------------------------------------

describe("13. both input observations remain identifiable from the result", () => {
  it("carries each observation's own provenance, neither summarised away", () => {
    const from = observation({ amountRaw: "1000", slot: 100, providerId: "provider-a" });
    const to = observation({ amountRaw: "990", slot: 200, providerId: "provider-b" });
    const out = deriveTotalSupplyDelta(from, to);
    expect(out.comparable).toBe(true);
    if (!out.comparable) return;

    expect(out.delta.from).toEqual({
      amountRaw: "1000",
      slot: 100,
      requestedFinality: "finalized",
      retrievedAt: from.provenance.retrievedAt,
      providerId: "provider-a",
      providerMethod: "getTokenSupply",
      canonicalUri: from.canonicalUri,
      rawResponseHash: from.provenance.rawResponseHash,
      artifactHash: from.provenance.artifactHash,
    });
    expect(out.delta.to.artifactHash).toBe(to.provenance.artifactHash);
    expect(out.delta.to.rawResponseHash).toBe(to.provenance.rawResponseHash);
    expect(out.delta.to.providerId).toBe("provider-b");
    // The two are distinguishable, which is the point.
    expect(out.delta.from.artifactHash).not.toBe(out.delta.to.artifactHash);
  });

  it("reports the chain-ordered interval only — never a wall-clock one", () => {
    const out = deriveTotalSupplyDelta(
      observation({ slot: 100, retrievedAt: new Date("2026-01-01T00:00:00.000Z") }),
      observation({ amountRaw: "990", slot: 200, retrievedAt: new Date("2026-06-01T00:00:00.000Z") }),
    );
    expect(out.comparable).toBe(true);
    if (!out.comparable) return;
    expect(out.delta.slotSpan).toBe(100);
    // retrievedAt is ATLAS's own clock and is carried as provenance, never
    // turned into a derived duration: a TOKEN_SUPPLY artifact has no
    // blockTime, so there is no chain interval in time to report.
    expect(Object.keys(out.delta)).not.toContain("elapsedMs");
    expect(Object.keys(out.delta)).not.toContain("observedSpanMs");
  });
});

describe("14/15. comparability is mathematical, not editorial", () => {
  it("14. age does not affect comparability — an old valid pair stays valid", () => {
    const ancient = deriveTotalSupplyDelta(
      observation({
        amountRaw: "1000",
        slot: 100,
        retrievedAt: new Date("2019-01-01T00:00:00.000Z"),
      }),
      observation({
        amountRaw: "990",
        slot: 200,
        retrievedAt: new Date("2019-02-01T00:00:00.000Z"),
      }),
    );
    const recent = deriveTotalSupplyDelta(
      observation({ amountRaw: "1000", slot: 100 }),
      observation({ amountRaw: "990", slot: 200 }),
    );
    expect(ancient.comparable).toBe(true);
    if (!ancient.comparable || !recent.comparable) return;
    // Identical arithmetic and identical direction — whether the later
    // reading is fresh enough to support a claim in a Proof is a
    // research-policy question for the consumer, not an arithmetic one.
    expect(ancient.delta.deltaRaw).toBe(recent.delta.deltaRaw);
    expect(ancient.delta.direction).toBe(recent.delta.direction);
  });

  it("15. the primitive requires no project identity and no database", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("src/server/engine/onchain-supply-delta.ts", "utf-8");
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const banned of [
      "ConfirmedProjectIdentity",
      "resolveConfirmedIdentity",
      "PROJECT_IDENTITY",
      "validateOnchainBinding",
      "db/client",
      "drizzle",
      "db/schema",
      "researchJobs",
      "evidence",
      "memory_stale_after_days",
      "loadProductConfig",
      "reserveJobBudget",
    ]) {
      expect(code, `the primitive must not reach ${banned}`).not.toContain(banned);
    }
    // It reuses the ONE existing provenance contract rather than a copy.
    expect(code).toContain("isProvenanceComplete");
  });

  it("no project, asset or mechanism is named anywhere in it", async () => {
    const { readFile } = await import("node:fs/promises");
    const lower = (
      await readFile("src/server/engine/onchain-supply-delta.ts", "utf-8")
    ).toLowerCase();
    for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan"]) {
      expect(lower, `must not name "${banned}"`).not.toContain(banned);
    }
    const codeOnly = lower
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(/["'][1-9a-hj-np-za-km-z]{32,44}["']/.test(codeOnly)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// The boundary this primitive must not be allowed to cross by accident.
// ---------------------------------------------------------------------

describe("the primitive is not reachable from production, and claims nothing", () => {
  it("nothing in src imports it", async () => {
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
      if (f.endsWith("onchain-supply-delta.ts")) continue;
      const src = await readFile(f, "utf-8");
      if (src.includes("onchain-supply-delta")) importers.push(f);
    }
    // B2a is the arithmetic alone. Acquisition, persistence, Evidence and
    // NET_EFFECT applicability are all later, separately approved decisions.
    expect(importers).toEqual([]);
  });

  it("it synthesizes no fact kind and states its own limits", async () => {
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    // Unchanged at HEAD: exactly one applicability pair, and no supply-delta
    // fact kind exists.
    expect(facts).not.toContain("SUPPLY_DELTA");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');

    const src = await readFile("src/server/engine/onchain-supply-delta.ts", "utf-8");
    expect(src).not.toContain("onchainFactKind");
    expect(src).not.toContain("APPLICABLE_COMPONENTS_BY_KIND");
    expect(src).not.toContain("NET_EFFECT");

    for (const phrase of [
      "circulating",
      "does not establish that any particular burn, buyback or mechanism caused the change",
      "holder impact",
      "durability",
    ]) {
      expect(TOTAL_SUPPLY_DELTA_DOES_NOT_PROVE).toContain(phrase);
    }
  });
});
