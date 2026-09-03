import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  evidence,
  evidenceOnchainArtifactInputs,
  onchainArtifacts,
  projects,
  topics,
  users,
} from "../src/server/db/schema";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { persistOnchainArtifact } from "../src/server/engine/onchain-acquisition";
import {
  ONCHAIN_DOES_NOT_PROVE,
  ONCHAIN_FACT_KINDS,
  applicableComponentsForFactKind,
  applicableFactKindsForComponent,
  GROSS_SUPPLY_REDUCTION_FACT_KINDS,
} from "../src/server/engine/onchain-facts";
import type { PersistedObservation } from "../src/server/engine/onchain-event-anchored-supply-interval";
import { selectEventAnchoredSupplyInterval } from "../src/server/engine/onchain-event-anchored-supply-interval";
import { deriveTotalSupplyDelta } from "../src/server/engine/onchain-supply-delta";
import type { TotalSupplyDelta } from "../src/server/engine/onchain-supply-delta";
import {
  persistTotalSupplyDeltaEvidence,
  totalSupplyDeltaUnitKey,
  TOTAL_SUPPLY_DELTA_COMPONENT,
  TOTAL_SUPPLY_DELTA_STEP,
} from "../src/server/engine/onchain-supply-delta-store";
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

// TOTAL_SUPPLY_DELTA EVIDENCE, AND THE TWO OBSERVATIONS THAT ESTABLISH IT.
//
// Every other deterministic on-chain fact comes from one artifact, and
// `evidence.onchain_artifact_id` says so. A delta is established by a
// historical reading, a current reading and arithmetic, and by neither alone.
// What these tests pin is that the persisted record says exactly that: the
// legacy singular pointer is NULL because no single artifact established it,
// both endpoints are recoverable as rows without parsing any prose, a burn is
// never written as an input, and the fact cannot reach a verdict yet.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-03T00:00:00.000Z");
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";

let mintCounter = 0;
function nextMint(): string {
  mintCounter += 1;
  let tag = "";
  let n = mintCounter;
  do {
    tag = "123456789"[n % 9] + tag;
    n = Math.floor(n / 9);
  } while (n > 0);
  return `Mint${tag}`.padEnd(44, "1");
}

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
  const slug = uniq("delta");
  const mint = nextMint();
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Delta Fixture", status: "ACTIVE_CORE" })
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

function identityFor(mint: string) {
  return { chain: "solana" as const, tokenAddress: mint, ticker: null };
}

function supplyArtifact(opts: {
  mint: string;
  slot: number;
  amountRaw: string;
  decimals?: number;
}): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: opts.mint,
    subjectKind: "token",
    subject: opts.mint,
  };
  const result = {
    kind: "TOKEN_SUPPLY" as const,
    mint: opts.mint,
    amountRaw: opts.amountRaw,
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
      projectAnchor: opts.mint,
      subjectKind: "token",
      subject: opts.mint,
      slot: opts.slot,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTokenSupply",
      requestParams: { subject: opts.mint },
      transactionSignature: null,
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:${opts.mint}:${opts.slot}:${opts.amountRaw}`,
      artifactHash: `sha256:art:${opts.mint}:${opts.slot}:${opts.amountRaw}`,
    },
  });
}

// Persisted through the canonical artifact path, so the endpoint rows are
// exactly the rows production writes.
async function persistObservation(
  jobId: string,
  artifact: OnchainArtifact,
  mint: string,
): Promise<{ onchainArtifactId: string; observation: PersistedObservation }> {
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "RESEARCH_JOB", jobId },
    artifact,
    identity: identityFor(mint),
  });
  if (!stored.artifactId) throw new Error(`fixture persist failed: ${stored.rejectedReason}`);
  return {
    onchainArtifactId: stored.artifactId,
    observation: { artifact, originKind: "RESEARCH_JOB", researchJobId: jobId },
  };
}

interface Interval {
  f: Fixture;
  from: { onchainArtifactId: string; observation: PersistedObservation };
  to: { onchainArtifactId: string; observation: PersistedObservation };
  delta: TotalSupplyDelta;
}

async function makeInterval(opts: {
  fromSlot?: number;
  toSlot?: number;
  fromAmount?: string;
  toAmount?: string;
  f?: Fixture;
}): Promise<Interval> {
  const f = opts.f ?? (await makeFixture());
  const from = await persistObservation(
    f.priorJobId,
    supplyArtifact({
      mint: f.mint,
      slot: opts.fromSlot ?? 100,
      amountRaw: opts.fromAmount ?? "1000",
    }),
    f.mint,
  );
  const to = await persistObservation(
    f.currentJobId,
    supplyArtifact({
      mint: f.mint,
      slot: opts.toSlot ?? 900,
      amountRaw: opts.toAmount ?? "900",
    }),
    f.mint,
  );
  const derived = deriveTotalSupplyDelta(from.observation.artifact, to.observation.artifact);
  if (!derived.comparable) throw new Error(`fixture delta not comparable: ${derived.reason}`);
  return { f, from, to, delta: derived.delta };
}

async function persist(i: Interval, over: Partial<{ delta: TotalSupplyDelta }> = {}) {
  return persistTotalSupplyDeltaEvidence(ctx.db, {
    currentResearchJobId: i.f.currentJobId,
    delta: over.delta ?? i.delta,
    from: i.from,
    to: i.to,
  });
}

async function inputsOf(evidenceId: string) {
  return ctx.db
    .select()
    .from(evidenceOnchainArtifactInputs)
    .where(eq(evidenceOnchainArtifactInputs.evidenceId, evidenceId))
    .orderBy(evidenceOnchainArtifactInputs.ordinal);
}

// ---------------------------------------------------------------------
// 1/2/3/10. Every direction is Evidence, and one interval is one row.
// ---------------------------------------------------------------------

describe("1/2/3/10. all three directions persist identically", () => {
  it("1. a negative delta persists one Evidence row", async () => {
    const i = await makeInterval({ fromAmount: "1000", toAmount: "900" });
    expect(i.delta.direction).toBe("DECREASED");
    const out = await persist(i);
    expect(out).toMatchObject({ persisted: true, created: true });
    const rows = await ctx.db
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.researchJobId, i.f.currentJobId),
          eq(evidence.onchainFactKind, "TOTAL_SUPPLY_DELTA"),
        ),
      );
    expect(rows.length).toBe(1);
  }, 120_000);

  it("2. a zero delta persists one Evidence row — not a failure", async () => {
    const i = await makeInterval({ fromAmount: "1000", toAmount: "1000" });
    expect(i.delta.direction).toBe("UNCHANGED");
    expect(i.delta.deltaRaw).toBe("0");
    const out = await persist(i);
    expect(out.persisted).toBe(true);
  }, 120_000);

  it("3. a positive delta persists one Evidence row — not a failure", async () => {
    const i = await makeInterval({ fromAmount: "900", toAmount: "1000" });
    expect(i.delta.direction).toBe("INCREASED");
    const out = await persist(i);
    expect(out.persisted).toBe(true);
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (out as { evidenceId: string }).evidenceId));
    // No direction is announced as good or bad news.
    expect(row.summary).toContain("(increase)");
    expect(row.relationship).toBe("CONTEXT");
  }, 120_000);

  it("10. exact recomputation of the same interval is idempotent", async () => {
    const i = await makeInterval({});
    const first = await persist(i);
    const second = await persist(i);
    const third = await persist(i);
    expect(first).toMatchObject({ persisted: true, created: true });
    expect(second).toMatchObject({ persisted: true, created: false });
    expect(third).toMatchObject({ persisted: true, created: false });
    const ids = new Set([first, second, third].map((r) => (r as { evidenceId: string }).evidenceId));
    expect(ids.size).toBe(1);
    expect((await inputsOf([...ids][0]!)).length).toBe(2);
  }, 120_000);

  it("11. the same values over a different interval are a different fact", async () => {
    const f = await makeFixture();
    const near = await makeInterval({ f, fromSlot: 100, toSlot: 900, fromAmount: "1000", toAmount: "900" });
    await persist(near);
    // Same two VALUES, different slots — a different observation pair, so a
    // different delta identity. B2b1 already makes the artifacts distinct.
    const far = await makeInterval({ f, fromSlot: 200, toSlot: 950, fromAmount: "1000", toAmount: "900" });
    const out = await persist(far);
    expect(out).toMatchObject({ persisted: true, created: true });
    const rows = await ctx.db
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.researchJobId, f.currentJobId),
          eq(evidence.onchainFactKind, "TOTAL_SUPPLY_DELTA"),
        ),
      );
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.extractionUnitKey)).size).toBe(2);
  }, 120_000);

  it("7. the unit key is the interval's, and never uses a wall clock", () => {
    const key = (fromSlot: number, toSlot: number) =>
      totalSupplyDeltaUnitKey({
        currentResearchJobId: "job",
        fromArtifactHash: "sha256:a",
        fromSlot,
        toArtifactHash: "sha256:b",
        toSlot,
      });
    expect(key(100, 900)).toBe(key(100, 900));
    expect(key(100, 900)).not.toBe(key(101, 900));
    expect(key(100, 900)).not.toBe(key(100, 901));
  });
});

// ---------------------------------------------------------------------
// 4..9. Placement and two-endpoint provenance.
// ---------------------------------------------------------------------

describe("4..9. one derived fact, two establishing inputs", () => {
  it("4. it belongs to the CURRENT job, step 7, NET_EFFECT", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (out as { evidenceId: string }).evidenceId));
    expect(row.researchJobId).toBe(i.f.currentJobId);
    expect(row.patternStep).toBe(TOTAL_SUPPLY_DELTA_STEP);
    expect(row.patternStep).toBe(7);
    expect(row.component).toBe(TOTAL_SUPPLY_DELTA_COMPONENT);
    expect(row.component).toBe("NET_EFFECT");
    expect(row.evidenceContractVersion).toBe(2);
    expect(row.sourceClass).toBe("ONCHAIN_VERIFIABLE");
    expect(row.entityBinding).toBe("CONFIRMED");
  }, 120_000);

  it("5/6. exactly one FROM edge and exactly one TO edge", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const inputs = await inputsOf((out as { evidenceId: string }).evidenceId);
    expect(inputs.map((r) => r.inputRole)).toEqual(["FROM", "TO"]);
    expect(inputs.map((r) => r.ordinal)).toEqual([0, 1]);
  }, 120_000);

  it("5/6. a second FROM, or an input at any other position, is unrepresentable", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const evidenceId = (out as { evidenceId: string }).evidenceId;
    await expect(
      ctx.db.insert(evidenceOnchainArtifactInputs).values({
        evidenceId,
        ordinal: 0,
        inputRole: "FROM",
        onchainArtifactId: i.from.onchainArtifactId,
      }),
    ).rejects.toThrow();
    await expect(
      ctx.db.insert(evidenceOnchainArtifactInputs).values({
        evidenceId,
        ordinal: 2,
        inputRole: "FROM",
        onchainArtifactId: i.from.onchainArtifactId,
      }),
    ).rejects.toThrow();
    await expect(
      ctx.db.insert(evidenceOnchainArtifactInputs).values({
        evidenceId,
        ordinal: 1,
        inputRole: "FROM",
        onchainArtifactId: i.from.onchainArtifactId,
      }),
    ).rejects.toThrow();
  }, 120_000);

  it("7/8/9. FROM is the historical t0, TO is the current t1, and t0 keeps its own job", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const inputs = await inputsOf((out as { evidenceId: string }).evidenceId);
    expect(inputs[0]!.onchainArtifactId).toBe(i.from.onchainArtifactId);
    expect(inputs[1]!.onchainArtifactId).toBe(i.to.onchainArtifactId);

    const [fromRow] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, inputs[0]!.onchainArtifactId));
    const [toRow] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, inputs[1]!.onchainArtifactId));
    // The historical reading is NOT rewritten to look current-job acquired.
    expect(fromRow.researchJobId).toBe(i.f.priorJobId);
    expect(fromRow.researchJobId).not.toBe(i.f.currentJobId);
    expect(toRow.researchJobId).toBe(i.f.currentJobId);
    expect(fromRow.slot).toBeLessThan(toRow.slot);
  }, 120_000);

  it("the legacy singular pointer is NULL, because no single artifact established it", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (out as { evidenceId: string }).evidenceId));
    expect(row.onchainArtifactId).toBeNull();
  }, 120_000);

  it("both endpoints share the one canonical TOKEN_SUPPLY source row", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (out as { evidenceId: string }).evidenceId));
    const [fromRow] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, i.from.onchainArtifactId));
    const [toRow] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, i.to.onchainArtifactId));
    expect(fromRow.sourceId).toBe(toRow.sourceId);
    expect(row.sourceId).toBe(toRow.sourceId);
    expect(row.retrievedUrl).toBe(toRow.canonicalUri);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 12..16/21. Fail closed.
// ---------------------------------------------------------------------

describe("12..16/21. the writer refuses anything it cannot verify", () => {
  it("16. a caller-supplied delta that disagrees with the endpoints is refused", async () => {
    const i = await makeInterval({ fromAmount: "1000", toAmount: "900" });
    const forged: TotalSupplyDelta = { ...i.delta, deltaRaw: "-999999", direction: "DECREASED" };
    expect(await persist(i, { delta: forged })).toEqual({
      persisted: false,
      reason: "DELTA_DISAGREES_WITH_ENDPOINTS",
    });
    expect(await inputsOfJob(i.f.currentJobId)).toEqual([]);
  }, 120_000);

  it("16. a forged direction is refused even when the magnitude is right", async () => {
    const i = await makeInterval({ fromAmount: "1000", toAmount: "900" });
    const forged: TotalSupplyDelta = { ...i.delta, direction: "INCREASED" };
    expect((await persist(i, { delta: forged })).persisted).toBe(false);
  }, 120_000);

  it("13. a wrong mint in the supplied delta is refused", async () => {
    const i = await makeInterval({});
    const forged: TotalSupplyDelta = { ...i.delta, mint: nextMint() };
    expect((await persist(i, { delta: forged })).persisted).toBe(false);
  }, 120_000);

  it("13. two endpoints of DIFFERENT mints are not comparable", async () => {
    const f = await makeFixture();
    const from = await persistObservation(
      f.priorJobId,
      supplyArtifact({ mint: f.mint, slot: 100, amountRaw: "1000" }),
      f.mint,
    );
    const otherMint = nextMint();
    const other = await makeFixture();
    const to = await persistObservation(
      other.currentJobId,
      supplyArtifact({ mint: other.mint, slot: 900, amountRaw: "900" }),
      other.mint,
    );
    expect(
      await persistTotalSupplyDeltaEvidence(ctx.db, {
        currentResearchJobId: other.currentJobId,
        delta: { ...(await makeInterval({})).delta, mint: otherMint },
        from,
        to,
      }),
    ).toEqual({ persisted: false, reason: "DELTA_NOT_COMPARABLE" });
  }, 120_000);

  it("14. a wrong slot in the supplied delta is refused", async () => {
    const i = await makeInterval({});
    const forged: TotalSupplyDelta = {
      ...i.delta,
      from: { ...i.delta.from, slot: i.delta.from.slot + 1 },
    };
    expect((await persist(i, { delta: forged })).persisted).toBe(false);
  }, 120_000);

  it("15. a wrong amount in the supplied delta is refused", async () => {
    const i = await makeInterval({});
    const forged: TotalSupplyDelta = {
      ...i.delta,
      to: { ...i.delta.to, amountRaw: "123456" },
    };
    expect((await persist(i, { delta: forged })).persisted).toBe(false);
  }, 120_000);

  it("12. an endpoint row id that names another observation is refused", async () => {
    const i = await makeInterval({});
    const swapped = await persistTotalSupplyDeltaEvidence(ctx.db, {
      currentResearchJobId: i.f.currentJobId,
      delta: i.delta,
      from: { ...i.from, onchainArtifactId: i.to.onchainArtifactId },
      to: i.to,
    });
    expect(swapped).toEqual({ persisted: false, reason: "ENDPOINT_ROW_MISMATCH" });
  }, 120_000);

  it("12. an endpoint row id that names nothing is refused", async () => {
    const i = await makeInterval({});
    const out = await persistTotalSupplyDeltaEvidence(ctx.db, {
      currentResearchJobId: i.f.currentJobId,
      delta: i.delta,
      from: { ...i.from, onchainArtifactId: "00000000-0000-0000-0000-000000000000" },
      to: i.to,
    });
    expect(out).toEqual({ persisted: false, reason: "ENDPOINT_ROW_NOT_FOUND" });
  }, 120_000);

  it("21. a standalone owner observation is never an eligible t0", async () => {
    const i = await makeInterval({});
    const standalone = {
      ...i.from,
      observation: {
        ...i.from.observation,
        originKind: "STANDALONE_STRUCTURED_OBSERVATION" as const,
        researchJobId: null,
      },
    };
    expect(
      await persistTotalSupplyDeltaEvidence(ctx.db, {
        currentResearchJobId: i.f.currentJobId,
        delta: i.delta,
        from: standalone,
        to: i.to,
      }),
    ).toEqual({ persisted: false, reason: "FROM_NOT_RESEARCH_ORIGIN" });
  }, 120_000);

  it("21. this Research's own earlier reading is not history", async () => {
    const i = await makeInterval({});
    expect(
      await persistTotalSupplyDeltaEvidence(ctx.db, {
        currentResearchJobId: i.f.priorJobId,
        delta: i.delta,
        from: i.from,
        to: i.to,
      }),
    ).toEqual({ persisted: false, reason: "FROM_NOT_PRIOR_RESEARCH_JOB" });
  }, 120_000);

  it("21. t1 must be the reading THIS Research acquired", async () => {
    const i = await makeInterval({});
    const other = await makeFixture();
    expect(
      await persistTotalSupplyDeltaEvidence(ctx.db, {
        currentResearchJobId: other.currentJobId,
        delta: i.delta,
        from: i.from,
        to: i.to,
      }),
    ).toEqual({ persisted: false, reason: "TO_NOT_CURRENT_RESEARCH_JOB" });
  }, 120_000);

  it("a non-increasing interval is refused by the arithmetic itself", async () => {
    const f = await makeFixture();
    const from = await persistObservation(
      f.priorJobId,
      supplyArtifact({ mint: f.mint, slot: 900, amountRaw: "1000" }),
      f.mint,
    );
    const to = await persistObservation(
      f.currentJobId,
      supplyArtifact({ mint: f.mint, slot: 100, amountRaw: "900" }),
      f.mint,
    );
    const derived = deriveTotalSupplyDelta(from.observation.artifact, to.observation.artifact);
    expect(derived.comparable).toBe(false);
    const i = await makeInterval({});
    expect(
      await persistTotalSupplyDeltaEvidence(ctx.db, {
        currentResearchJobId: f.currentJobId,
        delta: i.delta,
        from,
        to,
      }),
    ).toEqual({ persisted: false, reason: "DELTA_NOT_COMPARABLE" });
  }, 120_000);
});

async function inputsOfJob(jobId: string) {
  const rows = await ctx.db
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(eq(evidence.researchJobId, jobId), eq(evidence.onchainFactKind, "TOTAL_SUPPLY_DELTA")),
    );
  return rows;
}

// ---------------------------------------------------------------------
// 17/18/19/27. Lifecycle, and what an audit could recover.
// ---------------------------------------------------------------------

describe("17/18/19/27. lifecycle and recoverability", () => {
  it("17. an endpoint artifact cannot be deleted out from under a delta", async () => {
    const i = await makeInterval({});
    await persist(i);
    await expect(
      ctx.db.delete(onchainArtifacts).where(eq(onchainArtifacts.id, i.from.onchainArtifactId)),
    ).rejects.toThrow();
    await expect(
      ctx.db.delete(onchainArtifacts).where(eq(onchainArtifacts.id, i.to.onchainArtifactId)),
    ).rejects.toThrow();
  }, 120_000);

  it("18. deleting the Evidence takes its inputs with it, and nothing else", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const evidenceId = (out as { evidenceId: string }).evidenceId;
    expect((await inputsOf(evidenceId)).length).toBe(2);
    await ctx.db.delete(evidence).where(eq(evidence.id, evidenceId));
    expect(await inputsOf(evidenceId)).toEqual([]);
    // The observations themselves survive: they are not the fact's children.
    const remaining = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, i.from.onchainArtifactId));
    expect(remaining.length).toBe(1);
  }, 120_000);

  it("19/27. an audit can recover BOTH exact observations without parsing prose", async () => {
    const i = await makeInterval({ fromSlot: 100, toSlot: 900, fromAmount: "1000", toAmount: "900" });
    const out = await persist(i);
    const evidenceId = (out as { evidenceId: string }).evidenceId;

    // Exactly the query a future Audit layer would run: one join, no text.
    const recovered = await ctx.db
      .select({
        role: evidenceOnchainArtifactInputs.inputRole,
        ordinal: evidenceOnchainArtifactInputs.ordinal,
        slot: onchainArtifacts.slot,
        subject: onchainArtifacts.subject,
        finality: onchainArtifacts.finality,
        providerId: onchainArtifacts.providerId,
        rawResponseHash: onchainArtifacts.rawResponseHash,
        artifactHash: onchainArtifacts.artifactHash,
        normalizedResult: onchainArtifacts.normalizedResult,
        researchJobId: onchainArtifacts.researchJobId,
      })
      .from(evidenceOnchainArtifactInputs)
      .innerJoin(
        onchainArtifacts,
        eq(onchainArtifacts.id, evidenceOnchainArtifactInputs.onchainArtifactId),
      )
      .where(eq(evidenceOnchainArtifactInputs.evidenceId, evidenceId))
      .orderBy(evidenceOnchainArtifactInputs.ordinal);

    expect(recovered.map((r) => r.role)).toEqual(["FROM", "TO"]);
    expect(recovered.map((r) => r.slot)).toEqual([100, 900]);
    expect(recovered.map((r) => (r.normalizedResult as { amountRaw: string }).amountRaw)).toEqual([
      "1000",
      "900",
    ]);
    for (const r of recovered) {
      expect(r.subject).toBe(i.f.mint);
      expect(r.finality).toBe("finalized");
      expect(r.rawResponseHash.length).toBeGreaterThan(0);
    }
    expect(recovered[0]!.researchJobId).toBe(i.f.priorJobId);
    expect(recovered[1]!.researchJobId).toBe(i.f.currentJobId);
  }, 120_000);

  it("19. no BURN or event is ever written as a delta input", async () => {
    const f = await makeFixture();
    const i = await makeInterval({ f });
    const out = await persist(i);
    const inputs = await inputsOf((out as { evidenceId: string }).evidenceId);
    expect(inputs.length).toBe(2);
    const kinds = await ctx.db
      .select({ intentKind: onchainArtifacts.intentKind })
      .from(evidenceOnchainArtifactInputs)
      .innerJoin(
        onchainArtifacts,
        eq(onchainArtifacts.id, evidenceOnchainArtifactInputs.onchainArtifactId),
      )
      .where(eq(evidenceOnchainArtifactInputs.evidenceId, (out as { evidenceId: string }).evidenceId));
    expect(kinds.map((k) => k.intentKind)).toEqual(["TOKEN_SUPPLY", "TOKEN_SUPPLY"]);
    // The writer has no seam for one: it names no burn, no event, no
    // containment and no third role.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-supply-delta-store.ts", "utf-8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const banned of ["BURN", "CONTAINED_EVENT", "AnchorBurnEvent", "burnIndex", "signature"]) {
      expect(code, `writer must not reference ${banned}`).not.toContain(banned);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------
// 20/22..26. The boundaries this must not cross.
// ---------------------------------------------------------------------

describe("20/22..26. boundaries", () => {
  const STORE = "src/server/engine/onchain-supply-delta-store.ts";

  async function codeOf(file: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(file, "utf-8"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  }

  it("20. the fact kind names no cause and its ceiling says so", () => {
    expect(ONCHAIN_FACT_KINDS).toContain("TOTAL_SUPPLY_DELTA");
    for (const forbidden of [
      "NET_DEFLATION",
      "SUPPLY_REDUCTION",
      "BUYBACK_SUPPLY_REDUCTION",
      "MECHANISM_SUPPLY_REDUCTION",
    ]) {
      expect(ONCHAIN_FACT_KINDS).not.toContain(forbidden);
    }
    const ceiling = ONCHAIN_DOES_NOT_PROVE.TOTAL_SUPPLY_DELTA;
    for (const phrase of [
      "does not establish WHY the supply changed",
      "that any mechanism, buyback or policy caused any part of the change",
      "the NET of everything that happened between the two slots",
      "It does not establish circulating supply",
      "A decrease is not proof of a burn",
    ]) {
      expect(ceiling).toContain(phrase);
    }
  });

  it("20. a delta is not a gross supply-reduction event", () => {
    expect(GROSS_SUPPLY_REDUCTION_FACT_KINDS).toEqual(["BURN"]);
    expect(GROSS_SUPPLY_REDUCTION_FACT_KINDS).not.toContain("TOTAL_SUPPLY_DELTA");
  });

  it("25. BURN -> NET_EFFECT is still the only applicability pair", async () => {
    expect(applicableComponentsForFactKind("TOTAL_SUPPLY_DELTA")).toEqual([]);
    expect(applicableComponentsForFactKind("BURN")).toEqual(["NET_EFFECT"]);
    expect(applicableFactKindsForComponent("NET_EFFECT")).toEqual(["BURN"]);
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    expect(facts).not.toContain('TOTAL_SUPPLY_DELTA: [');
  });

  it("26. the delta cannot influence NET_EFFECT's status", async () => {
    const i = await makeInterval({});
    await persist(i);
    const result = await reconcileAndPersistComponent(
      ctx.db,
      i.f.currentJobId,
      { step: 7, component: "NET_EFFECT" },
      NOW,
    );
    // Nothing was established by it: CONTEXT never establishes or
    // contradicts, and no applicability route exists either.
    expect(result?.supportingEvidenceIds ?? []).toEqual([]);
    expect(result?.status).not.toBe("SUPPORTED");
  }, 120_000);

  it("26. and it is filed CONTEXT, which reconciliation never counts", async () => {
    const i = await makeInterval({});
    const out = await persist(i);
    const [row] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, (out as { evidenceId: string }).evidenceId));
    expect(row.relationship).toBe("CONTEXT");
    const reconciler = await codeOf("src/server/engine/component-reconciler.ts");
    expect(reconciler).toContain('row.relationship === "SUPPORTS"');
  }, 120_000);

  it("22. no Research Memory is written or read", async () => {
    const code = await codeOf(STORE);
    for (const banned of ["server/memory", "researchMemory", "projectMemoryItems", "memoryId"]) {
      expect(code, `must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("23/24. extractionUnitKey is not changed globally and no artifactHash is redefined", async () => {
    const acquisition = await codeOf("src/server/engine/onchain-acquisition.ts");
    // The shared single-artifact scheme, unchanged: same five inputs, same
    // order, one artifact hash.
    expect(acquisition).toContain("[jobId, artifactHash, String(step), component, fragment]");
    expect(acquisition).toContain("function extractionUnitKey(");
    const store = await codeOf(STORE);
    expect(store).not.toContain("extractionUnitKey(jobId");
    // Neither endpoint's artifactHash is redefined: the store never writes an
    // artifact row, and it only ever READS the two hashes to quote them.
    expect(store).not.toContain(".insert(onchainArtifacts)");
    expect(store).not.toContain("persistOnchainArtifact");
    expect(store).toContain("fromArtifactHash");
    expect(store).toContain("toArtifactHash");
  });

  it("no UI, no applicability, no reconciliation and no RPC in the writer", async () => {
    const code = await codeOf(STORE);
    for (const banned of [
      "APPLICABLE_COMPONENTS_BY_KIND",
      "component-reconcil",
      "claim-evaluator",
      "audit-projection",
      "onchain-retriever",
      "retriever",
      "https://",
      "SUPPORTED",
    ]) {
      expect(code, `must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("the migration is additive: no rewrite, no delete, no merge", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const files = (await readdir("src/server/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(files[files.length - 1]).toBe("0044_total_supply_delta_provenance.sql");
    const sqlText = await readFile(
      "src/server/db/migrations/0044_total_supply_delta_provenance.sql",
      "utf-8",
    );
    for (const banned of ["DROP ", "DELETE FROM", "UPDATE \"", "TRUNCATE", "ALTER COLUMN"]) {
      expect(sqlText, `migration must not contain ${banned}`).not.toContain(banned);
    }
    expect(sqlText).toContain("ADD VALUE 'TOTAL_SUPPLY_DELTA'");
    expect(sqlText).toContain("ON DELETE restrict");
    expect(sqlText).toContain("ON DELETE cascade");
  });

  it("the derivation is B2a's, called rather than reimplemented", async () => {
    const code = await codeOf(STORE);
    expect(code).toContain("deriveTotalSupplyDelta(fromArtifact, toArtifact)");
    // No arithmetic of its own: it compares numbers B2a produced and never
    // computes one.
    expect(code).not.toContain("BigInt");
    expect(code).not.toContain("deltaRaw = ");
    expect(code).not.toContain("- BigInt");
  });

  it("the interval selector still produces exactly the delta this persists", async () => {
    const i = await makeInterval({ fromSlot: 100, toSlot: 900, fromAmount: "1000", toAmount: "900" });
    const event: OnchainArtifact = burnArtifact(i.f.mint, 500);
    const selected = selectEventAnchoredSupplyInterval({
      currentResearchJobId: i.f.currentJobId,
      currentProjectAnchor: i.f.mint,
      event: { artifact: event, burnIndex: 0, researchJobId: i.f.currentJobId },
      current: i.to.observation,
      historical: [i.from.observation],
    });
    expect(selected.selected).toBe(true);
    if (!selected.selected) return;
    // B2b2 selects; this module persists what B2b2 derived, unchanged.
    const out = await persist(i, { delta: selected.interval.delta });
    expect(out.persisted).toBe(true);
  }, 120_000);
});

function burnArtifact(mint: string, slot: number): OnchainArtifact {
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
        amountRaw: "100",
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
      subject: SIGNATURE,
      slot,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: SIGNATURE },
      transactionSignature: SIGNATURE,
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:tx:${mint}`,
      artifactHash: `sha256:art:tx:${mint}`,
    },
  });
}
