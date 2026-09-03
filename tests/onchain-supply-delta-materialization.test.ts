import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  evidence,
  evidenceOnchainArtifactInputs,
  onchainArtifacts,
  projects,
  researchAttempts,
  topics,
  users,
} from "../src/server/db/schema";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { persistOnchainArtifact, persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import {
  deriveBurnEventSpan,
  selectBurnSpanningSupplyInterval,
  BURN_SPANNING_INTERVAL_DOES_NOT_PROVE,
} from "../src/server/engine/onchain-burn-spanning-supply-interval";
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

// ONE INTERVAL THAT SPANS EVERY BURN THIS RESEARCH ESTABLISHED.
//
// A Research that finds several burns has no principled way to call one of
// them THE event: picking the latest makes the newest look canonical and
// causal, and picking one per burn produces several deltas sharing endpoints.
// So the burn set is reduced to a span, and the interval is the nearest
// eligible reading on each side of it — strictly outside on both ends.
//
// What these tests pin is that the interval CONTAINS every burn, that a
// reading taken between two burns can never open it, that equality is refused
// at both bounds, and that none of this reaches a verdict.

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

function signatureFor(seed: number): string {
  return `Sig${seed}`.padEnd(66, "1");
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
  const slug = uniq("mat");
  const mint = nextMint();
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Materialization Fixture", status: "ACTIVE_CORE" })
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

function supplyArtifact(mint: string, slot: number, amountRaw: string, decimals = 6): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };
  const result = { kind: "TOKEN_SUPPLY" as const, mint, amountRaw, decimals };
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

function burnArtifact(anchor: string, slot: number, seed: number, burnMint = anchor): OnchainArtifact {
  const signature = signatureFor(seed);
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
    slot,
    blockTime: 1_700_000_000,
    succeeded: true,
    burns: [
      {
        programId: "TokenProg1111111111111111111111111111111111",
        instructionType: "BurnChecked",
        mint: burnMint,
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
      projectAnchor: anchor,
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

// Established exactly as production establishes one: the artifact persisted
// and a deterministic BURN fact filed from it.
async function establishBurn(f: Fixture, slot: number, seed: number, opts: { jobId?: string; burnMint?: string } = {}) {
  await persistOnchainArtifactAndFacts({
    db: ctx.db,
    jobId: opts.jobId ?? f.currentJobId,
    artifact: burnArtifact(f.mint, slot, seed, opts.burnMint ?? f.mint),
    identity: identityFor(f.mint),
    target: EXECUTION,
  });
}

async function observe(jobId: string, mint: string, slot: number, amountRaw: string, decimals = 6) {
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "RESEARCH_JOB", jobId },
    artifact: supplyArtifact(mint, slot, amountRaw, decimals),
    identity: identityFor(mint),
  });
  if (!stored.artifactId) throw new Error(`fixture observe failed: ${stored.rejectedReason}`);
  return stored.artifactId;
}

async function standalone(mint: string, slot: number, amountRaw: string) {
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
    artifact: supplyArtifact(mint, slot, amountRaw),
    identity: identityFor(mint),
  });
  return stored.artifactId;
}

const run = (f: Fixture) =>
  runSupplyDeltaMaterialization(ctx.db, { jobId: f.currentJobId, projectId: f.projectId });

async function deltaRows(jobId: string) {
  return ctx.db
    .select()
    .from(evidence)
    .where(
      and(eq(evidence.researchJobId, jobId), eq(evidence.onchainFactKind, "TOTAL_SUPPLY_DELTA")),
    );
}

async function inputsOf(evidenceId: string) {
  return ctx.db
    .select()
    .from(evidenceOnchainArtifactInputs)
    .where(eq(evidenceOnchainArtifactInputs.evidenceId, evidenceId))
    .orderBy(evidenceOnchainArtifactInputs.ordinal);
}

async function endpointSlots(evidenceId: string): Promise<{ from: number; to: number }> {
  const rows = await ctx.db
    .select({ role: evidenceOnchainArtifactInputs.inputRole, slot: onchainArtifacts.slot })
    .from(evidenceOnchainArtifactInputs)
    .innerJoin(
      onchainArtifacts,
      eq(onchainArtifacts.id, evidenceOnchainArtifactInputs.onchainArtifactId),
    )
    .where(eq(evidenceOnchainArtifactInputs.evidenceId, evidenceId))
    .orderBy(evidenceOnchainArtifactInputs.ordinal);
  return { from: rows[0]!.slot, to: rows[1]!.slot };
}

// ---------------------------------------------------------------------
// 1..7/10. The span, and which readings may bound it.
// ---------------------------------------------------------------------

describe("1..7/10. one interval that contains every burn", () => {
  it("2/3/4/5/6/7. the approved multi-burn worked example: 120 -> 200", async () => {
    const f = await makeFixture();
    await establishBurn(f, 150, 1);
    await establishBurn(f, 180, 2);
    // Historical: 50, 120, 160. 160 sits AFTER the first burn, so it cannot
    // open an interval containing it.
    await observe(f.priorJobId, f.mint, 50, "5000");
    await observe(f.priorJobId, f.mint, 120, "4000");
    await observe(f.priorJobId, f.mint, 160, "3900");
    // Current: 180, 200, 250. 180 EQUALS the last burn's slot and is refused;
    // 250 is valid but farther than 200.
    await observe(f.currentJobId, f.mint, 180, "3800");
    await observe(f.currentJobId, f.mint, 200, "3700");
    await observe(f.currentJobId, f.mint, 250, "3600");

    const out = await run(f);
    expect(out.outcome).toBe("MATERIALIZED");
    expect(out.span).toEqual({ earliestSlot: 150, latestSlot: 180, eventCount: 2 });
    expect(out.fromSlot).toBe(120);
    expect(out.toSlot).toBe(200);

    const rows = await deltaRows(f.currentJobId);
    expect(rows.length).toBe(1);
    expect(await endpointSlots(rows[0]!.id)).toEqual({ from: 120, to: 200 });
  }, 120_000);

  it("1/10. a single burn reduces to the same rule, with no separate semantics", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 3);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.priorJobId, f.mint, 400, "1000");
    await observe(f.currentJobId, f.mint, 600, "900");
    await observe(f.currentJobId, f.mint, 900, "800");

    const out = await run(f);
    expect(out.outcome).toBe("MATERIALIZED");
    expect(out.span).toEqual({ earliestSlot: 500, latestSlot: 500, eventCount: 1 });
    // Nearest before, nearest after — the multi-burn rule with a span of one.
    expect(out.fromSlot).toBe(400);
    expect(out.toSlot).toBe(600);
  }, 120_000);

  it("6. equality is refused at BOTH bounds", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 4);
    await observe(f.priorJobId, f.mint, 500, "1000"); // == earliest burn
    await observe(f.currentJobId, f.mint, 500, "900"); // == latest burn
    expect((await run(f)).outcome).toBe("NO_CURRENT_OBSERVATION_AFTER_SPAN");

    // t1 now exists, and the only historical reading sits AT the burn. The
    // retrieval bound and the eligibility rule agree on refusing it, and the
    // bound fires first — either way no reading may open the interval.
    await observe(f.currentJobId, f.mint, 501, "900");
    expect((await run(f)).outcome).toBe("NO_HISTORICAL_CANDIDATES");

    await observe(f.priorJobId, f.mint, 499, "1000");
    const out = await run(f);
    expect(out.outcome).toBe("MATERIALIZED");
    expect(out.fromSlot).toBe(499);
    expect(out.toSlot).toBe(501);
  }, 120_000);

  it("4. a historical reading between two burns is never t0", async () => {
    const f = await makeFixture();
    await establishBurn(f, 150, 5);
    await establishBurn(f, 180, 6);
    await observe(f.priorJobId, f.mint, 170, "4000"); // between the burns
    await observe(f.currentJobId, f.mint, 200, "3700");
    // It already reflects the burn at 150, so no interval starting there
    // could contain that burn. Refused before it is ever a candidate: the
    // retrieval bound is the EARLIEST burn, and the pure eligibility applies
    // the same rule to anything that does reach it.
    expect((await run(f)).outcome).toBe("NO_HISTORICAL_CANDIDATES");
    expect(await deltaRows(f.currentJobId)).toEqual([]);
  }, 120_000);

  it("the burn span is derived, not chosen — and it is pure", () => {
    const anchor = nextMint();
    const span = deriveBurnEventSpan({
      currentResearchJobId: "job",
      currentProjectAnchor: anchor,
      events: [
        { artifact: burnArtifact(anchor, 700, 7), burnIndex: 0, researchJobId: "job" },
        { artifact: burnArtifact(anchor, 200, 8), burnIndex: 0, researchJobId: "job" },
        { artifact: burnArtifact(anchor, 450, 9), burnIndex: 0, researchJobId: "job" },
      ],
    });
    expect(span).toEqual({ earliestSlot: 200, latestSlot: 700, eventCount: 3 });
  });

  it("21. two readings disagreeing at the chosen boundary slot fail closed", async () => {
    const f = await makeFixture();
    await establishBurn(f, 100, 10);
    await observe(f.priorJobId, f.mint, 50, "1000");
    // Two CURRENT readings at slot 200 reporting different supplies.
    await observe(f.currentJobId, f.mint, 200, "900");
    await observe(f.currentJobId, f.mint, 200, "901");
    const out = await run(f);
    expect(out.outcome).toBe("AMBIGUOUS_CURRENT_OBSERVATION");
    expect(await deltaRows(f.currentJobId)).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 8..14. Which rows may take part at all.
// ---------------------------------------------------------------------

describe("8..14. eligibility, and the outcomes when it is not met", () => {
  it("8. the historical endpoint keeps its own prior job provenance", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 11);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 900, "900");
    const out = await run(f);
    expect(out.outcome).toBe("MATERIALIZED");
    const inputs = await inputsOf(out.evidenceId!);
    const [fromRow] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, inputs[0]!.onchainArtifactId));
    expect(fromRow.researchJobId).toBe(f.priorJobId);
    expect(fromRow.researchJobId).not.toBe(f.currentJobId);
  }, 120_000);

  it("9. a standalone observation is never t0", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 12);
    await standalone(f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 900, "900");
    expect((await run(f)).outcome).toBe("NO_HISTORICAL_CANDIDATES");
    expect(await deltaRows(f.currentJobId)).toEqual([]);
  }, 120_000);

  it("9. and a standalone observation is never t1 either", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 13);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await standalone(f.mint, 900, "900");
    expect((await run(f)).outcome).toBe("NO_CURRENT_OBSERVATION_AFTER_SPAN");
  }, 120_000);

  it("10. a PREVIOUS job's burn does not move this Research's span", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 14);
    await establishBurn(f, 900, 15, { jobId: f.priorJobId });
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 600, "900");
    const out = await run(f);
    expect(out.span).toEqual({ earliestSlot: 500, latestSlot: 500, eventCount: 1 });
    expect(out.toSlot).toBe(600);
  }, 120_000);

  it("11. a burn of an UNRELATED mint does not move the span", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 16);
    await establishBurn(f, 900, 17, { burnMint: nextMint() });
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 600, "900");
    const out = await run(f);
    expect(out.span).toEqual({ earliestSlot: 500, latestSlot: 500, eventCount: 1 });
    expect(out.toSlot).toBe(600);
  }, 120_000);

  it("12. no current-job burn means no delta, and no invented interval", async () => {
    const f = await makeFixture();
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 900, "900");
    const out = await run(f);
    expect(out.outcome).toBe("NO_USABLE_BURN_EVENT");
    expect(out.span).toBeNull();
    expect(await deltaRows(f.currentJobId)).toEqual([]);
  }, 120_000);

  it("13. no historical t0 means no delta", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 18);
    await observe(f.currentJobId, f.mint, 900, "900");
    expect((await run(f)).outcome).toBe("NO_HISTORICAL_CANDIDATES");
  }, 120_000);

  it("14. no reading after the span means no delta — and no extra RPC is asked for", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 19);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 400, "1000"); // before the burn
    const out = await run(f);
    expect(out.outcome).toBe("NO_CURRENT_OBSERVATION_AFTER_SPAN");
    expect(await deltaRows(f.currentJobId)).toEqual([]);
  }, 120_000);

  it("endpoints of different unit scales fail closed", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 20);
    await observe(f.priorJobId, f.mint, 100, "1000", 9);
    await observe(f.currentJobId, f.mint, 900, "900", 6);
    expect((await run(f)).outcome).toBe("NO_ELIGIBLE_HISTORICAL_OBSERVATION");
  }, 120_000);

  it("a project with no confirmed identity materializes nothing", async () => {
    const slug = uniq("noid");
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug, name: "No Identity", status: "ACTIVE_CORE" })
      .returning();
    const jobId = await makeJob(project.id, slug);
    const out = await runSupplyDeltaMaterialization(ctx.db, { jobId, projectId: project.id });
    expect(out.outcome).toBe("NO_ACTIVE_IDENTITY");
  }, 120_000);
});

// ---------------------------------------------------------------------
// 15..20. Directions, provenance and idempotency.
// ---------------------------------------------------------------------

describe("15..20. every direction, one row, two inputs", () => {
  async function materializeWith(fromAmount: string, toAmount: string) {
    const f = await makeFixture();
    await establishBurn(f, 500, 21);
    await observe(f.priorJobId, f.mint, 100, fromAmount);
    await observe(f.currentJobId, f.mint, 900, toAmount);
    return { f, out: await run(f) };
  }

  it("15. a negative delta materializes", async () => {
    const { out } = await materializeWith("1000", "900");
    expect(out.outcome).toBe("MATERIALIZED");
  }, 120_000);

  it("16. a zero delta materializes — not a failure", async () => {
    const { f, out } = await materializeWith("1000", "1000");
    expect(out.outcome).toBe("MATERIALIZED");
    const [row] = await deltaRows(f.currentJobId);
    expect(row.fragment).toContain('"direction":"UNCHANGED"');
    expect(row.fragment).toContain('"deltaRaw":"0"');
  }, 120_000);

  it("17. a positive delta materializes — not a failure", async () => {
    const { f, out } = await materializeWith("900", "1000");
    expect(out.outcome).toBe("MATERIALIZED");
    const [row] = await deltaRows(f.currentJobId);
    expect(row.fragment).toContain('"direction":"INCREASED"');
  }, 120_000);

  it("18/19. one row, exactly FROM and TO, and never a burn", async () => {
    const f = await makeFixture();
    await establishBurn(f, 400, 22);
    await establishBurn(f, 500, 23);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 900, "900");
    const out = await run(f);
    const inputs = await inputsOf(out.evidenceId!);
    expect(inputs.map((r) => r.inputRole)).toEqual(["FROM", "TO"]);
    const kinds = await ctx.db
      .select({ intentKind: onchainArtifacts.intentKind })
      .from(evidenceOnchainArtifactInputs)
      .innerJoin(
        onchainArtifacts,
        eq(onchainArtifacts.id, evidenceOnchainArtifactInputs.onchainArtifactId),
      )
      .where(eq(evidenceOnchainArtifactInputs.evidenceId, out.evidenceId!));
    expect(kinds.map((k) => k.intentKind)).toEqual(["TOKEN_SUPPLY", "TOKEN_SUPPLY"]);
    // The burns are still their own Evidence, untouched.
    const burns = await ctx.db
      .select()
      .from(evidence)
      .where(
        and(eq(evidence.researchJobId, f.currentJobId), eq(evidence.onchainFactKind, "BURN")),
      );
    expect(burns.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("20. rerunning the same job materializes nothing new", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 24);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 900, "900");

    const first = await run(f);
    expect(first.outcome).toBe("MATERIALIZED");
    for (let i = 0; i < 3; i++) {
      const again = await run(f);
      expect(again.outcome).toBe("ALREADY_MATERIALIZED");
      expect(again.evidenceId).toBe(first.evidenceId);
    }
    expect((await deltaRows(f.currentJobId)).length).toBe(1);
    expect((await inputsOf(first.evidenceId!)).length).toBe(2);
  }, 120_000);

  it("22. the writer's own verification still runs and can still refuse", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      "src/server/engine/onchain-supply-delta-materialization.ts",
      "utf-8",
    );
    // Selection composes the one writer; it never reimplements or bypasses it.
    expect(src).toContain("persistTotalSupplyDeltaEvidence(db, {");
    expect(src).not.toContain(".insert(evidence)");
    expect(src).not.toContain("evidenceOnchainArtifactInputs");
    expect(src).toContain("WRITER_REFUSED");
  });
});

// ---------------------------------------------------------------------
// 23..30. What this stage is not allowed to be.
// ---------------------------------------------------------------------

describe("23..30. boundaries", () => {
  const MODULE = "src/server/engine/onchain-supply-delta-materialization.ts";
  const PURE = "src/server/engine/onchain-burn-spanning-supply-interval.ts";

  async function codeOf(file: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(file, "utf-8"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  }

  it("23/24. it acquires nothing: no RPC, no search, no fetch, no model", async () => {
    for (const file of [MODULE, PURE]) {
      const code = await codeOf(file);
      for (const banned of [
        "onchain-retriever",
        "resolveOnchainRetriever",
        "retriever",
        "runStructuredOnchainAcquisition",
        "runPostEventSupplyCompletion",
        "QueryProposer",
        "SearchGateway",
        "ContentFetcher",
        "EvidenceExtractor",
        "anthropic",
        "reserveJobBudget",
        "sourceOpens",
        "fetch(",
        "https://",
      ]) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it("24/25. no loop, no attempt row, no controller re-entry", async () => {
    const code = await codeOf(MODULE);
    for (const banned of ["while (", "researchAttempts", "runResearchController", "setTimeout"]) {
      expect(code, `must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("25. a real materialization creates no research_attempts row", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 25);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 900, "900");
    const before = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, f.currentJobId));
    expect((await run(f)).outcome).toBe("MATERIALIZED");
    const after = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, f.currentJobId));
    expect(after).toEqual(before);
  }, 120_000);

  it("26. run-job runs it after reactivation and post-event supply, before the sweep", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/run-job.ts", "utf-8");
    const reactivation = src.indexOf("await runOnchainReactivationPass(");
    const postEvent = src.indexOf("await runPostEventSupplyCompletion(");
    const materialize = src.indexOf("await runSupplyDeltaMaterialization(");
    const sweep = src.indexOf(
      "await reconcileOutstandingComponents(db, jobId, view.workQueue, now);\n\n  // Phase 6, S6",
    );
    expect(reactivation).toBeGreaterThan(-1);
    expect(postEvent).toBeGreaterThan(reactivation);
    expect(materialize).toBeGreaterThan(postEvent);
    expect(sweep).toBeGreaterThan(materialize);
  });

  it("27/28. applicability is untouched", async () => {
    expect(applicableComponentsForFactKind("TOTAL_SUPPLY_DELTA")).toEqual([]);
    expect(applicableComponentsForFactKind("BURN")).toEqual(["NET_EFFECT"]);
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    expect(facts).not.toContain("TOTAL_SUPPLY_DELTA: [");
  });

  it("29. NET_EFFECT's result is unchanged by the delta being present", async () => {
    const f = await makeFixture();
    await establishBurn(f, 500, 26);
    await observe(f.priorJobId, f.mint, 100, "1000");
    await observe(f.currentJobId, f.mint, 900, "900");

    const before = await reconcileAndPersistComponent(
      ctx.db,
      f.currentJobId,
      { step: 7, component: "NET_EFFECT" },
      NOW,
    );
    expect((await run(f)).outcome).toBe("MATERIALIZED");
    const after = await reconcileAndPersistComponent(
      ctx.db,
      f.currentJobId,
      { step: 7, component: "NET_EFFECT" },
      NOW,
    );
    expect(after?.status).toBe(before?.status);
    expect(after?.reasonCodes).toEqual(before?.reasonCodes);
    expect(after?.supportingEvidenceIds).toEqual(before?.supportingEvidenceIds);
    expect(after?.status).not.toBe("SUPPORTED");
  }, 120_000);

  it("30. no Research Memory is read or written", async () => {
    for (const file of [MODULE, PURE]) {
      const code = await codeOf(file);
      for (const banned of ["server/memory", "researchMemory", "projectMemoryItems"]) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it("11. the span is selection, and its own text says it is never provenance", () => {
    const stated = BURN_SPANNING_INTERVAL_DOES_NOT_PROVE.join(" | ");
    for (const phrase of [
      "does NOT establish that any burn caused the change",
      "the NET of everything that happened between the two slots",
      "a narrower interval does NOT prove less unrelated activity occurred",
      "no burn in the span is made the canonical event of the Proof",
      "the span is selection provenance and is NEVER an establishing input",
    ]) {
      expect(stated).toContain(phrase);
    }
  });

  it("the pure layer composes the proven primitives rather than restating them", async () => {
    const code = await codeOf(PURE);
    expect(code).toContain("filterTemporalSupplyEligibility");
    expect(code).toContain("selectEventAnchoredSupplyObservation");
    expect(code).toContain("deriveTotalSupplyDelta");
    expect(code).toContain("anchorBurnRef");
    // No arithmetic and no ambiguity rule of its own.
    expect(code).not.toContain("BigInt");
    expect(code).not.toContain("ambiguous: true");
    // And the single-event primitive it generalizes still exists.
    const single = await codeOf("src/server/engine/onchain-event-anchored-supply-interval.ts");
    expect(single).toContain("export function selectEventAnchoredSupplyInterval(");
  });

  it("the pure layer is pure", async () => {
    const code = await codeOf(PURE);
    for (const banned of ["drizzle-orm", 'from "../db/', ".select(", ".insert(", "sql`", "Date.now"]) {
      expect(code, `must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("selection cannot be steered by a project name", async () => {
    for (const file of [MODULE, PURE]) {
      const { readFile } = await import("node:fs/promises");
      const lower = (await readFile(file, "utf-8")).toLowerCase();
      for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan"]) {
        expect(lower, `${file} must not name "${banned}"`).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------
// The pure selector, without a database.
// ---------------------------------------------------------------------

describe("the pure span selector", () => {
  const JOB = "11111111-1111-1111-1111-111111111111";
  const PRIOR = "22222222-2222-2222-2222-222222222222";

  function obs(mint: string, slot: number, amountRaw: string, jobId: string) {
    return {
      artifact: supplyArtifact(mint, slot, amountRaw),
      originKind: "RESEARCH_JOB" as const,
      researchJobId: jobId,
    };
  }

  it("7. a farther valid t1 is not selected when a nearer one exists", () => {
    const mint = nextMint();
    const out = selectBurnSpanningSupplyInterval({
      currentResearchJobId: JOB,
      currentProjectAnchor: mint,
      events: [{ artifact: burnArtifact(mint, 180, 30), burnIndex: 0, researchJobId: JOB }],
      current: [obs(mint, 250, "3600", JOB), obs(mint, 200, "3700", JOB)],
      historical: [obs(mint, 120, "4000", PRIOR)],
    });
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    expect(out.interval.to.artifact.provenance.slot).toBe(200);
    expect(out.interval.from.artifact.provenance.slot).toBe(120);
    expect(out.interval.selectionRule).toBe(
      "NEAREST_ELIGIBLE_OBSERVATIONS_STRICTLY_OUTSIDE_BURN_SPAN",
    );
  });

  it("3. the nearest t0 before the EARLIEST burn wins, not the nearest before the latest", () => {
    const mint = nextMint();
    const out = selectBurnSpanningSupplyInterval({
      currentResearchJobId: JOB,
      currentProjectAnchor: mint,
      events: [
        { artifact: burnArtifact(mint, 150, 31), burnIndex: 0, researchJobId: JOB },
        { artifact: burnArtifact(mint, 180, 32), burnIndex: 0, researchJobId: JOB },
      ],
      current: [obs(mint, 200, "3700", JOB)],
      historical: [obs(mint, 120, "4000", PRIOR), obs(mint, 160, "3900", PRIOR)],
    });
    expect(out.selected).toBe(true);
    if (!out.selected) return;
    expect(out.interval.from.artifact.provenance.slot).toBe(120);
    expect(out.interval.span).toEqual({ earliestSlot: 150, latestSlot: 180, eventCount: 2 });
  });

  it("input order cannot change the answer", () => {
    const mint = nextMint();
    const base = {
      currentResearchJobId: JOB,
      currentProjectAnchor: mint,
      events: [
        { artifact: burnArtifact(mint, 150, 33), burnIndex: 0, researchJobId: JOB },
        { artifact: burnArtifact(mint, 180, 34), burnIndex: 0, researchJobId: JOB },
      ],
      current: [obs(mint, 200, "3700", JOB), obs(mint, 250, "3600", JOB)],
      historical: [obs(mint, 50, "5000", PRIOR), obs(mint, 120, "4000", PRIOR)],
    };
    const a = selectBurnSpanningSupplyInterval(base);
    const b = selectBurnSpanningSupplyInterval({
      ...base,
      events: [...base.events].reverse(),
      current: [...base.current].reverse(),
      historical: [...base.historical].reverse(),
    });
    expect(a.selected && b.selected).toBe(true);
    if (!a.selected || !b.selected) return;
    expect(a.interval.delta).toEqual(b.interval.delta);
    expect(a.interval.span).toEqual(b.interval.span);
  });
});
