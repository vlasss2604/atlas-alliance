import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { evidence, onchainArtifacts, projects, topics, users } from "../src/server/db/schema";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import {
  evaluateNetSupplyEffect,
  NET_SUPPLY_EFFECT_DOES_NOT_PROVE,
} from "../src/server/engine/net-supply-effect";
import { persistOnchainArtifact, persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import { applicableComponentsForFactKind } from "../src/server/engine/onchain-facts";
import { runSupplyDeltaMaterialization } from "../src/server/engine/onchain-supply-delta-materialization";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// NET_EFFECT CONSUMES A MEASURED SUPPLY INTERVAL.
//
// Two deterministic observations answer two different questions. A BURN says
// a gross destruction event occurred; a DELTA says how total supply changed
// across a measured interval — the NET of everything that happened in it.
// Neither says the researched mechanism caused anything, and the whole point
// of these tests is that no combination of them ever says so either.
//
// The ceiling is the thing to defend: a measured DECREASE is the strongest
// outcome available and it is still a limitation, because clearing the last
// reason code is what reaches SUPPORTED, and SUPPORTED would assert the
// causal claim nobody has evidence for.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-03T00:00:00.000Z");
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const EXECUTION = { step: 4, component: "EXECUTION_EVIDENCE" };
const NET_EFFECT = { step: 7, component: "NET_EFFECT" };

let mintCounter = 0;
function nextMint(): string {
  mintCounter += 1;
  let tag = "";
  let n = mintCounter;
  do {
    tag = "123456789"[n % 9] + tag;
    n = Math.floor(n / 9);
  } while (n > 0);
  // Padded with a character the tag itself can never contain: padding with
  // "1" made "Mint2" + 39 ones and "Mint21" + 38 ones the SAME address, so
  // two fixtures silently shared a mint and each other's observations.
  return `Mint${tag}`.padEnd(44, "z");
}
const signatureFor = (seed: number) => `Sig${seed}`.padEnd(66, "1");

interface Fixture {
  projectId: string;
  slug: string;
  mint: string;
  priorJobId: string;
  currentJobId: string;
}

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
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function makeFixture(): Promise<Fixture> {
  const slug = uniq("b2e");
  const mint = nextMint();
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "B2e Fixture", status: "ACTIVE_CORE" })
    .returning();
  const ok = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: mint,
  });
  if (!ok.ok) throw new Error("fixture identity failed");
  return {
    projectId: project.id,
    slug,
    mint,
    priorJobId: await makeJob(project.id, slug),
    currentJobId: await makeJob(project.id, slug),
  };
}

const identityFor = (mint: string) => ({ chain: "solana" as const, tokenAddress: mint, ticker: null });

function supplyArtifact(mint: string, slot: number, amountRaw: string): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };
  const result = { kind: "TOKEN_SUPPLY" as const, mint, amountRaw, decimals: 6 };
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
      slot,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTokenSupply",
      requestParams: { subject: mint },
      transactionSignature: null,
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:${mint}:${slot}:${amountRaw}`,
      artifactHash: `sha256:art:${mint}:${slot}:${amountRaw}`,
    },
  });
}

function burnArtifact(mint: string, slot: number, seed: number, amountRaw = "10000000000000"): OnchainArtifact {
  const signature = signatureFor(seed);
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "tx",
    subject: signature,
  };
  const result = {
    kind: "TRANSACTION_DETAIL" as const,
    signature,
    slot,
    blockTime: 1_700_000_000,
    succeeded: true,
    burns: [
      {
        programId: "TokenProg1111111111111111111111111111111111",
        instructionType: "BurnChecked",
        mint,
        sourceAccount: TOKEN_ACCOUNT,
        authority: null,
        amountRaw,
        decimals: 6,
      },
    ] as BurnInstructionRef[],
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
      subject: signature,
      slot,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: signature },
      transactionSignature: signature,
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:tx:${signature}`,
      artifactHash: `sha256:art:tx:${signature}`,
    },
  });
}

async function establishBurn(f: Fixture, slot: number, seed: number, amountRaw?: string) {
  await persistOnchainArtifactAndFacts({
    db: ctx.db,
    jobId: f.currentJobId,
    artifact: burnArtifact(f.mint, slot, seed, amountRaw),
    identity: identityFor(f.mint),
    target: EXECUTION,
  });
}

async function observe(jobId: string, mint: string, slot: number, amountRaw: string) {
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "RESEARCH_JOB", jobId },
    artifact: supplyArtifact(mint, slot, amountRaw),
    identity: identityFor(mint),
  });
  if (!stored.artifactId) throw new Error(`observe failed: ${stored.rejectedReason}`);
  return stored.artifactId;
}

const reconcile = (f: Fixture) =>
  reconcileAndPersistComponent(ctx.db, f.currentJobId, NET_EFFECT, NOW);

async function deltaEvidenceId(jobId: string): Promise<string | null> {
  const rows = await ctx.db
    .select()
    .from(evidence)
    .where(
      and(eq(evidence.researchJobId, jobId), eq(evidence.onchainFactKind, "TOTAL_SUPPLY_DELTA")),
    );
  return rows[0]?.id ?? null;
}

async function burnEvidenceIds(jobId: string): Promise<string[]> {
  const rows = await ctx.db
    .select()
    .from(evidence)
    .where(and(eq(evidence.researchJobId, jobId), eq(evidence.onchainFactKind, "BURN")));
  return rows.map((r) => r.id);
}

// The whole approved flow: burn established, interval observed, delta
// materialized by the production materializer, then reconciled.
async function research(opts: {
  fromAmount: string;
  toAmount: string;
  withBurn?: boolean;
  burnAmount?: string;
}): Promise<Fixture> {
  const f = await makeFixture();
  if (opts.withBurn !== false) await establishBurn(f, 500, mintCounter, opts.burnAmount);
  await observe(f.priorJobId, f.mint, 100, opts.fromAmount);
  await observe(f.currentJobId, f.mint, 900, opts.toAmount);
  await runSupplyDeltaMaterialization(ctx.db, { jobId: f.currentJobId, projectId: f.projectId });
  return f;
}

// ---------------------------------------------------------------------
// 1..4/16. The approved four-case matrix.
// ---------------------------------------------------------------------

describe("1..4/16. the four-case matrix", () => {
  it("A/1. burn, no delta → PARTIALLY_SUPPORTED, net change not established", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 101);
    const result = await reconcile(f);
    expect(result?.status).toBe("PARTIALLY_SUPPORTED");
    expect(result?.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(result?.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
    expect(await deltaEvidenceId(f.currentJobId)).toBeNull();
  }, 120_000);

  it("B/2. burn + DECREASED → PARTIALLY_SUPPORTED, measured but not attributed", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "900" });
    const result = await reconcile(f);
    expect(result?.status).toBe("PARTIALLY_SUPPORTED");
    expect(result?.status).not.toBe("SUPPORTED");
    expect(result?.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
    // The old limitation is REPLACED, not accumulated alongside.
    expect(result?.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    // The measurement is visible as support, and so is the burn.
    const delta = await deltaEvidenceId(f.currentJobId);
    expect(result?.supportingEvidenceIds).toContain(delta);
    for (const burn of await burnEvidenceIds(f.currentJobId)) {
      expect(result?.supportingEvidenceIds).toContain(burn);
    }
    expect(result?.contradictingEvidenceIds).toEqual([]);
  }, 120_000);

  it("C/3. burn + UNCHANGED → CONTRADICTED", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "1000" });
    const result = await reconcile(f);
    expect(result?.status).toBe("CONTRADICTED");
    expect(result?.reasonCodes).toEqual(["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"]);
  }, 120_000);

  it("D/4. burn + INCREASED → CONTRADICTED", async () => {
    const f = await research({ fromAmount: "900", toAmount: "1000" });
    const result = await reconcile(f);
    expect(result?.status).toBe("CONTRADICTED");
    expect(result?.reasonCodes).toEqual(["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"]);
  }, 120_000);

  it("16. NO reachable combination of burn and delta reaches SUPPORTED", async () => {
    for (const [from, to] of [
      ["1000", "900"],
      ["1000", "1000"],
      ["900", "1000"],
      ["1000", "999999999"],
      ["999999999", "1"],
    ]) {
      const f = await research({ fromAmount: from, toAmount: to });
      const result = await reconcile(f);
      expect(result?.status, `${from} -> ${to}`).not.toBe("SUPPORTED");
    }
    // And burn-only, and delta-only.
    const burnOnly = await makeFixture();
    await establishBurn(burnOnly, 500, 199);
    expect((await reconcile(burnOnly))?.status).not.toBe("SUPPORTED");
    const deltaOnly = await research({ fromAmount: "1000", toAmount: "900", withBurn: false });
    expect((await reconcile(deltaOnly))?.status).not.toBe("SUPPORTED");
  }, 180_000);
});

// ---------------------------------------------------------------------
// 5/6/7/8. The burn gate, and technical absence.
// ---------------------------------------------------------------------

describe("5..8. a delta alone is a number, not a finding", () => {
  it("5. DECREASED without a burn does not produce the B2 outcome", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "900", withBurn: false });
    // Nothing was materialized at all: the materializer refuses without a burn.
    expect(await deltaEvidenceId(f.currentJobId)).toBeNull();
    const result = await reconcile(f);
    expect(result?.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
    expect(result?.status).not.toBe("SUPPORTED");
  }, 120_000);

  it("6/7. a delta reaching reconciliation without a burn still cannot be read", async () => {
    // Belt and braces at the reconciler itself, not just the materializer:
    // the burn gate is asked FIRST, so no delta of any direction produces a
    // burn-offset interpretation on its own.
    for (const relationship of ["SUPPORTS", "CONTRADICTS"] as const) {
      const effect = evaluateNetSupplyEffect({
        establishing:
          relationship === "SUPPORTS"
            ? [{ id: "d", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship }]
            : [],
        contradictionCapable: [{ id: "d", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship }],
      });
      expect(effect.kind).toBe("NO_GROSS_REDUCTION");
    }
  });

  it("8. a technical absence of delta is never CONTRADICTED", async () => {
    // Every B2 refusal path lands here: no historical t0, no post-span t1,
    // incomparable endpoints, an unavailable provider, an exhausted budget.
    const noHistory = await makeFixture();
    await establishBurn(noHistory, 500, 102);
    await observe(noHistory.currentJobId, noHistory.mint, 900, "900");
    await runSupplyDeltaMaterialization(ctx.db, {
      jobId: noHistory.currentJobId,
      projectId: noHistory.projectId,
    });
    expect(await deltaEvidenceId(noHistory.currentJobId)).toBeNull();
    const a = await reconcile(noHistory);
    expect(a?.status).toBe("PARTIALLY_SUPPORTED");
    expect(a?.status).not.toBe("CONTRADICTED");
    expect(a?.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");

    const noCurrent = await makeFixture();
    await establishBurn(noCurrent, 500, 103);
    await observe(noCurrent.priorJobId, noCurrent.mint, 100, "1000");
    await runSupplyDeltaMaterialization(ctx.db, {
      jobId: noCurrent.currentJobId,
      projectId: noCurrent.projectId,
    });
    expect(await deltaEvidenceId(noCurrent.currentJobId)).toBeNull();
    const b = await reconcile(noCurrent);
    expect(b?.status).not.toBe("CONTRADICTED");
    expect(b?.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  }, 180_000);
});

// ---------------------------------------------------------------------
// 9..15. Provenance, ambiguity and idempotency.
// ---------------------------------------------------------------------

describe("9..15. provenance and fail-closed behaviour", () => {
  it("9. the delta's endpoint provenance survives being consumed", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "900" });
    const delta = await deltaEvidenceId(f.currentJobId);
    const result = await reconcile(f);
    expect(result?.supportingEvidenceIds).toContain(delta);
    // NET_EFFECT -> delta Evidence -> FROM / TO artifacts, by relation only.
    const { evidenceOnchainArtifactInputs } = await import("../src/server/db/schema");
    const endpoints = await ctx.db
      .select({
        role: evidenceOnchainArtifactInputs.inputRole,
        slot: onchainArtifacts.slot,
        job: onchainArtifacts.researchJobId,
      })
      .from(evidenceOnchainArtifactInputs)
      .innerJoin(
        onchainArtifacts,
        eq(onchainArtifacts.id, evidenceOnchainArtifactInputs.onchainArtifactId),
      )
      .where(eq(evidenceOnchainArtifactInputs.evidenceId, delta!))
      .orderBy(evidenceOnchainArtifactInputs.ordinal);
    expect(endpoints.map((e) => e.role)).toEqual(["FROM", "TO"]);
    expect(endpoints.map((e) => e.slot)).toEqual([100, 900]);
    expect(endpoints[0]!.job).toBe(f.priorJobId);
    expect(endpoints[1]!.job).toBe(f.currentJobId);
  }, 120_000);

  it("10. a negative delta lands in supportingEvidenceIds", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "900" });
    const result = await reconcile(f);
    expect(result?.supportingEvidenceIds).toContain(await deltaEvidenceId(f.currentJobId));
  }, 120_000);

  it("11. a zero delta lands in contradictingEvidenceIds", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "1000" });
    const result = await reconcile(f);
    expect(result?.contradictingEvidenceIds).toEqual([await deltaEvidenceId(f.currentJobId)]);
  }, 120_000);

  it("12. a positive delta lands in contradictingEvidenceIds", async () => {
    const f = await research({ fromAmount: "900", toAmount: "1000" });
    const result = await reconcile(f);
    expect(result?.contradictingEvidenceIds).toEqual([await deltaEvidenceId(f.currentJobId)]);
  }, 120_000);

  it("13. the burn stays visible as gross-reduction support even when contradicted", async () => {
    const f = await research({ fromAmount: "900", toAmount: "1000" });
    const result = await reconcile(f);
    expect(result?.status).toBe("CONTRADICTED");
    const burns = await burnEvidenceIds(f.currentJobId);
    expect(burns.length).toBeGreaterThan(0);
    for (const burn of burns) {
      expect(result?.supportingEvidenceIds).toContain(burn);
    }
    // The three output sets stay disjoint.
    const overlap = (result?.supportingEvidenceIds ?? []).filter((id) =>
      (result?.contradictingEvidenceIds ?? []).includes(id),
    );
    expect(overlap).toEqual([]);
    const excludedIds = (result?.excludedEvidence ?? []).map((e) => e.evidenceId);
    expect(excludedIds).not.toContain(await deltaEvidenceId(f.currentJobId));
  }, 120_000);

  it("14. conflicting delta directions fail closed and never pick a favourite", () => {
    const effect = evaluateNetSupplyEffect({
      establishing: [
        { id: "burn", onchainFactKind: "BURN", relationship: "SUPPORTS" },
        { id: "down", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "SUPPORTS" },
      ],
      contradictionCapable: [{ id: "up", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS" }],
    });
    expect(effect.kind).toBe("CONFLICTING_INTERVALS");
    if (effect.kind !== "CONFLICTING_INTERVALS") return;
    // BOTH are named. Neither is silently dropped, and no direction wins.
    expect([...effect.deltaEvidenceIds].sort()).toEqual(["down", "up"]);
  });

  it("14. and a conflicted record is a limitation, never CONTRADICTED or SUPPORTED", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "900" });
    const delta = await deltaEvidenceId(f.currentJobId);
    const [row] = await ctx.db.select().from(evidence).where(eq(evidence.id, delta!));
    // A second, opposite interval — reachable only through corruption, which
    // is exactly why it must be surfaced rather than resolved.
    await ctx.db.insert(evidence).values({
      ...row,
      id: undefined as unknown as string,
      relationship: "CONTRADICTS",
      extractionUnitKey: `${row.extractionUnitKey}-conflict`,
      contentHash: `${row.contentHash}-conflict`,
    });
    const result = await reconcile(f);
    expect(result?.reasonCodes).toContain("CONFLICTING_SUPPLY_DELTA");
    expect(result?.status).toBe("PARTIALLY_SUPPORTED");
    expect(result?.status).not.toBe("CONTRADICTED");
    expect(result?.reasonCodes).not.toContain("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
  }, 120_000);

  it("15. an exact duplicate delta does not change the outcome", async () => {
    const f = await research({ fromAmount: "1000", toAmount: "900" });
    const before = await reconcile(f);
    // Rerunning the materializer is idempotent by interval identity.
    await runSupplyDeltaMaterialization(ctx.db, { jobId: f.currentJobId, projectId: f.projectId });
    const after = await reconcile(f);
    expect(after?.status).toBe(before?.status);
    expect(after?.reasonCodes).toEqual(before?.reasonCodes);
    expect(after?.supportingEvidenceIds).toEqual(before?.supportingEvidenceIds);
  }, 120_000);
});

// ---------------------------------------------------------------------
// PUMP-shaped semantic regression examples.
// ---------------------------------------------------------------------

describe("the three pinned worked examples", () => {
  it("A. burn 10M, 1.00B -> 990M → PARTIALLY_SUPPORTED, measured not attributed", async () => {
    const f = await research({
      fromAmount: "1000000000000000",
      toAmount: "990000000000000",
      burnAmount: "10000000000000",
    });
    const result = await reconcile(f);
    expect(result?.status).toBe("PARTIALLY_SUPPORTED");
    expect(result?.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (await deltaEvidenceId(f.currentJobId))!));
    expect(row.fragment).toContain('"deltaRaw":"-10000000000000"');
    expect(row.fragment).toContain('"direction":"DECREASED"');
    // The delta never claims the burn caused it.
    expect(row.summary).not.toMatch(/burn|buyback|mechanism|caused/i);
    expect(row.doesNotProve).toContain("caused any part of the change");
  }, 120_000);

  it("B. burn 10M, 1.00B -> 1.00B → CONTRADICTED", async () => {
    const f = await research({
      fromAmount: "1000000000000000",
      toAmount: "1000000000000000",
      burnAmount: "10000000000000",
    });
    const result = await reconcile(f);
    expect(result?.status).toBe("CONTRADICTED");
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (await deltaEvidenceId(f.currentJobId))!));
    expect(row.fragment).toContain('"direction":"UNCHANGED"');
    expect(row.summary).toContain("did not change");
  }, 120_000);

  it("C. burn 10M, 1.00B -> 1.05B → CONTRADICTED", async () => {
    const f = await research({
      fromAmount: "1000000000000000",
      toAmount: "1050000000000000",
      burnAmount: "10000000000000",
    });
    const result = await reconcile(f);
    expect(result?.status).toBe("CONTRADICTED");
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (await deltaEvidenceId(f.currentJobId))!));
    expect(row.fragment).toContain('"deltaRaw":"50000000000000"');
    expect(row.summary).toContain("(increase)");
  }, 120_000);
});

// ---------------------------------------------------------------------
// 17..24. Boundaries.
// ---------------------------------------------------------------------

describe("17..24. boundaries", () => {
  async function codeOf(file: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(file, "utf-8"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  }

  it("17/18. applicability is untouched — the delta is already filed at NET_EFFECT", async () => {
    // Cross-component applicability exists so a BURN filed at
    // EXECUTION_EVIDENCE can be read by NET_EFFECT. A delta is written at
    // step 7 / NET_EFFECT itself, so it needs no such route and none was
    // added.
    expect(applicableComponentsForFactKind("TOTAL_SUPPLY_DELTA")).toEqual([]);
    expect(applicableComponentsForFactKind("BURN")).toEqual(["NET_EFFECT"]);
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    expect(facts).not.toContain("TOTAL_SUPPLY_DELTA: [");
  });

  it("19/22. no Research Memory and no model judgment", async () => {
    for (const file of [
      "src/server/engine/net-supply-effect.ts",
      "src/server/engine/component-reconciler.ts",
    ]) {
      const code = await codeOf(file);
      for (const banned of ["server/memory", "researchMemory", "anthropic", "queryProposer"]) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
    // The direction is read from a typed field, never from the fragment.
    const effect = await codeOf("src/server/engine/net-supply-effect.ts");
    expect(effect).not.toContain("fragment");
    expect(effect).not.toContain("JSON.parse");
    expect(effect).not.toContain("toLowerCase");
    expect(effect).toContain('relationship === "CONTRADICTS"');
  });

  it("21. no project is named anywhere in the new semantics", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "src/server/engine/net-supply-effect.ts",
      "src/server/engine/component-reconciler.ts",
      "src/server/engine/onchain-supply-delta-store.ts",
    ]) {
      const lower = (await readFile(file, "utf-8")).toLowerCase();
      for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan"]) {
        expect(lower, `${file} must not name "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("23. every new reason code has bounded user-facing copy and a confidence cap", async () => {
    const { readFile } = await import("node:fs/promises");
    const client = await readFile("src/client/research-model.ts", "utf-8");
    const confidence = await readFile("src/server/engine/proof-confidence.ts", "utf-8");
    for (const code of [
      "NET_SUPPLY_CHANGE_NOT_ATTRIBUTED",
      "NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL",
      "CONFLICTING_SUPPLY_DELTA",
    ]) {
      expect(client, `${code} needs user-facing copy`).toContain(`${code}:`);
      expect(confidence, `${code} needs a confidence cap`).toContain(`${code}: CONFIDENCE_BANDS`);
    }
    // And the copy never claims a cause or accuses anyone.
    const copy = client.slice(client.indexOf("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED:"));
    const sentences = copy.slice(0, 1200);
    for (const banned of ["buyback reduced", "caused", "lied", "fake", "deflation"]) {
      expect(sentences, `copy must not say "${banned}"`).not.toContain(banned);
    }
  });

  it("24. BURN-only behaviour is backward compatible", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 104);
    const result = await reconcile(f);
    expect(result?.status).toBe("PARTIALLY_SUPPORTED");
    expect(result?.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    // And a component with no gross reduction at all is unchanged too.
    const none = await makeFixture();
    await ctx.db.insert(evidence).values({
      researchJobId: none.currentJobId,
      sourceId: (
        await ctx.db
          .select()
          .from(evidence)
          .where(eq(evidence.researchJobId, f.currentJobId))
      )[0]!.sourceId,
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: "the treasury holds tokens",
      retrievedUrl: "https://docs.example.test/x",
      contentHash: uniq("ch"),
      fetchedAt: NOW,
      evidenceContractVersion: 2,
      patternStep: 7,
      component: "NET_EFFECT",
      sourceClass: "OFFICIAL_REPORT",
      officiality: "CONFIRMED",
    });
    const other = await reconcileAndPersistComponent(ctx.db, none.currentJobId, NET_EFFECT, NOW);
    expect(other?.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(other?.status).not.toBe("SUPPORTED");
  }, 120_000);

  it("the pure evaluator states its own ceiling", () => {
    const stated = NET_SUPPLY_EFFECT_DOES_NOT_PROVE.join(" | ");
    for (const phrase of [
      "a measured decrease does NOT establish that the researched mechanism caused it",
      "a measured increase does NOT establish that any burn was fake or that anyone lied",
      "an unchanged supply does NOT establish which issuance offset the burn",
      "an absent interval is a limit on what was observed",
    ]) {
      expect(stated).toContain(phrase);
    }
  });

  it("the evaluator is pure and total over its five outcomes", () => {
    const burn = { id: "b", onchainFactKind: "BURN" as const, relationship: "SUPPORTS" as const };
    expect(evaluateNetSupplyEffect({ establishing: [], contradictionCapable: [] }).kind).toBe(
      "NO_GROSS_REDUCTION",
    );
    expect(evaluateNetSupplyEffect({ establishing: [burn], contradictionCapable: [] }).kind).toBe(
      "NO_MEASURED_INTERVAL",
    );
    expect(
      evaluateNetSupplyEffect({
        establishing: [burn, { id: "d", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "SUPPORTS" }],
        contradictionCapable: [],
      }).kind,
    ).toBe("MEASURED_DECREASE");
    expect(
      evaluateNetSupplyEffect({
        establishing: [burn],
        contradictionCapable: [
          { id: "d", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS" },
        ],
      }).kind,
    ).toBe("MEASURED_NOT_REDUCED");
  });
});
