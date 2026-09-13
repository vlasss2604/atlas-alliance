import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, onchainArtifacts, productConfig, projects, researchJobs, topics, users } from "../src/server/db/schema";
import {
  findReusableSameJobArtifact,
  persistOnchainArtifactAndFacts,
} from "../src/server/engine/onchain-acquisition";
import {
  selectEventAnchoredSupplyInterval,
  type AnchorBurnEvent,
} from "../src/server/engine/onchain-event-anchored-supply-interval";
import { runPostEventSupplyCompletion } from "../src/server/engine/onchain-post-event-supply";
import {
  loadCurrentJobBurnEvents,
  loadCurrentJobSupplyObservations,
  loadHistoricalSupplyCandidates,
} from "../src/server/engine/onchain-supply-candidate-store";
import { runSupplyDeltaMaterialization } from "../src/server/engine/onchain-supply-delta-materialization";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type { OnchainArtifact, OnchainIntent, OnchainResult } from "../src/server/engine/providers/onchain-types";
import {
  isResearchAcquisitionOrigin,
  REAL_RESEARCH_ACQUISITION_ORIGINS,
} from "../src/server/engine/research-acquisition-origin";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { observeTokenSupply } from "../scripts/onchain-observe-token-supply";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// OWNER OBSERVATION ORIGIN V1 — an operator-run observation is not a
// Research acquisition, and never becomes another job's historical t0.
//
// THE PROVEN BUG. The persisting owner scripts create a research_jobs row
// because Evidence requires one. With the default origin, PRODUCT, their
// TOKEN_SUPPLY artifact satisfied the historical supply loader's whole
// eligibility shape (RESEARCH_JOB origin, a job id, a different job), so a
// later Research could take an operator's probe reading as its t0. The
// distinction belongs to the PRODUCING JOB: origin OWNER_OBSERVATION, and a
// positive allowlist of the origins that ARE Research acquisitions.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
  await ctx.db.update(productConfig).set({ value: true }).where(eq(productConfig.key, "internal_alpha_enabled"));
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-03T00:00:00.000Z");
const WALLET = "Wa11et11111111111111111111111111111111111111";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const BURN_SLOT = 500;
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
  return `Mint${tag}`.padEnd(44, "z");
}

interface Fixture {
  id: string;
  slug: string;
  mint: string;
}

async function makeProject(): Promise<Fixture> {
  const slug = uniq("own");
  const mint = nextMint();
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Owner Origin Fixture", status: "ACTIVE_CORE" }).returning();
  const ok = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: mint });
  if (!ok.ok) throw new Error("fixture identity failed");
  return { id: project.id, slug, mint };
}

const identityFor = (mint: string) => ({ chain: "solana" as const, tokenAddress: mint, ticker: null });

async function makeJob(f: Fixture, origin?: "PRODUCT" | "OWNER_MANUAL_ALPHA" | "OWNER_OBSERVATION"): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: f.id,
    originalQuestion: "does the buyback actually reduce circulating supply?",
    normalizedTask: { project_slug: f.slug, project_slugs: [f.slug], task: "buyback burn" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
    ...(origin === undefined ? {} : { origin }),
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

function artifactFor(intent: OnchainIntent, result: OnchainResult, slot: number, salt = ""): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: intent.projectAnchor,
      subjectKind: intent.subjectKind,
      subject: intent.subject,
      slot,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "fixture",
      requestParams: { subject: intent.subject },
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:${result.kind}:${intent.subject}:${slot}${salt}`,
      artifactHash: `sha256:art:${result.kind}:${intent.subject}:${slot}${salt}`,
      transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
    },
  });
}

function supplyIntent(mint: string): OnchainIntent {
  return { kind: "TOKEN_SUPPLY", chain: "solana", network: "mainnet", projectAnchor: mint, subjectKind: "token", subject: mint };
}

function supplyArtifact(mint: string, slot: number, amountRaw = "1000"): OnchainArtifact {
  return artifactFor(supplyIntent(mint), { kind: "TOKEN_SUPPLY", mint, amountRaw, decimals: 6 }, slot, `:${amountRaw}`);
}

function burnTransaction(mint: string, slot: number): OnchainArtifact {
  const intent: OnchainIntent = { kind: "TRANSACTION_DETAIL", chain: "solana", network: "mainnet", projectAnchor: mint, subjectKind: "tx", subject: SIGNATURE };
  return artifactFor(
    intent,
    {
      kind: "TRANSACTION_DETAIL",
      signature: SIGNATURE,
      slot,
      blockTime: 1_700_000_000,
      succeeded: true,
      burns: [
        { programId: "TokenProg1111111111111111111111111111111111", instructionType: "BurnChecked", mint, sourceAccount: TOKEN_ACCOUNT, authority: WALLET, amountRaw: "7723746661", decimals: 6 },
      ],
      programs: [],
      accountKeys: [WALLET, mint, TOKEN_ACCOUNT],
      tokenInstructions: [],
      lifecycleInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    slot,
  );
}

async function establishBurn(f: Fixture, jobId: string): Promise<void> {
  await persistOnchainArtifactAndFacts({ db: ctx.db, jobId, artifact: burnTransaction(f.mint, BURN_SLOT), identity: identityFor(f.mint), target: EXECUTION });
}

async function establishSupply(f: Fixture, jobId: string, slot: number, amountRaw: string): Promise<void> {
  const stored = await persistOnchainArtifactAndFacts({ db: ctx.db, jobId, artifact: supplyArtifact(f.mint, slot, amountRaw), identity: identityFor(f.mint), target: NET_EFFECT });
  if (stored.rejectedReason !== null) throw new Error(`fixture supply refused: ${stored.rejectedReason}`);
}

// A prior reading acquired by a job of the given origin, at `slot`.
async function priorSupplyWithOrigin(f: Fixture, origin: "PRODUCT" | "OWNER_MANUAL_ALPHA" | "OWNER_OBSERVATION", slot: number, amountRaw = "5000"): Promise<string> {
  const jobId = await makeJob(f, origin);
  await establishSupply(f, jobId, slot, amountRaw);
  return jobId;
}

// The real probe, with a fixture retriever that answers a Solana reading at
// `slot` — exactly what an operator run persists.
async function ownerProbe(f: Fixture, slot: number, amountRaw = "5000"): Promise<{ jobId: string; artifactId: string }> {
  const out = await observeTokenSupply({
    db: ctx.db,
    boss: ctx.boss,
    projectSlug: f.slug,
    liveAllowlist: new Set([f.slug]),
    resolveRetriever: () => ({
      name: "fixture",
      supports: () => true,
      retrieve: async () => supplyArtifact(f.mint, slot, amountRaw),
    }),
  });
  if (!out.ok) throw new Error(`probe refused: ${out.refusal} ${out.detail}`);
  return { jobId: out.jobId, artifactId: out.artifactId };
}

async function historicalFor(f: Fixture, currentJobId: string, beforeSlot = BURN_SLOT) {
  return loadHistoricalSupplyCandidates(ctx.db, { currentResearchJobId: currentJobId, projectAnchor: f.mint, chain: "solana", network: "mainnet", beforeSlot });
}

// ---------------------------------------------------------------------
// The allowlist, and the origin the owner scripts write.
// ---------------------------------------------------------------------

describe("REAL_RESEARCH_ACQUISITION_ORIGINS — a positive allowlist", () => {
  it("4. admits exactly PRODUCT and OWNER_MANUAL_ALPHA; OWNER_OBSERVATION and any unknown origin fail closed", () => {
    expect([...REAL_RESEARCH_ACQUISITION_ORIGINS].sort()).toEqual(["OWNER_MANUAL_ALPHA", "PRODUCT"]);
    expect(isResearchAcquisitionOrigin("PRODUCT")).toBe(true);
    expect(isResearchAcquisitionOrigin("OWNER_MANUAL_ALPHA")).toBe(true);
    expect(isResearchAcquisitionOrigin("OWNER_OBSERVATION")).toBe(false);
    for (const future of ["FUTURE_ORIGIN", "BATCH_REPLAY", "", "product"]) {
      expect(isResearchAcquisitionOrigin(future), future).toBe(false);
    }
    // The loader applies the SET, never an exclusion of one value.
    const store = readFileSync("src/server/engine/onchain-supply-candidate-store.ts", "utf-8");
    expect(store).toContain("inArray(researchJobs.origin, [...REAL_RESEARCH_ACQUISITION_ORIGINS])");
    expect(store).not.toMatch(/ne\(researchJobs\.origin/);
    expect(store).not.toContain('"OWNER_OBSERVATION"');
  });

  it("10 + 11. every persisting owner script — on-chain and documentary — creates its job as OWNER_OBSERVATION", () => {
    for (const script of [
      "scripts/onchain-observe-token-supply.ts",
      "scripts/onchain-observe-account.ts",
      "scripts/onchain-observe-token-accounts.ts",
      "scripts/acquire-document.ts",
      "scripts/alpha-acquire-url.ts",
      "scripts/extract-from-document.ts",
    ]) {
      const src = readFileSync(script, "utf-8");
      expect((src.match(/createResearchJob\(/g) ?? []).length, script).toBe(1);
      expect(src, script).toContain('origin: "OWNER_OBSERVATION"');
    }
    // The real Research creators do NOT carry it: the product path, the
    // admin manual-alpha path (OWNER_MANUAL_ALPHA), and alpha-run, which
    // drives the full Research handler and whose observations must stay
    // reusable.
    for (const creator of ["src/server/services/start-research.ts", "src/server/services/start-owner-alpha-research.ts", "scripts/alpha-run.ts"]) {
      expect(readFileSync(creator, "utf-8"), creator).not.toContain("OWNER_OBSERVATION");
    }
    // 12. no chain or project anywhere in the rule.
    const rule = readFileSync("src/server/engine/research-acquisition-origin.ts", "utf-8").toLowerCase();
    for (const banned of ["solana", "ethereum", "lido", "pump", "raydium", "morpho", "token_supply", "task_hash", "taskhash"]) {
      expect(rule, banned).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------
// 1–3. The historical loader: the proven bug, closed; real Research kept.
// ---------------------------------------------------------------------

describe("historical TOKEN_SUPPLY candidates — only Research acquisitions", () => {
  it("1. THE PROVEN BUG: an owner TOKEN_SUPPLY probe yields ZERO historical candidates for a later Research", async () => {
    const f = await makeProject();
    const probe = await ownerProbe(f, 100);
    // The probe's job is OWNER_OBSERVATION and its artifact IS a persisted
    // RESEARCH_JOB-origin row — the exact shape that used to qualify.
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, probe.jobId));
    expect(job.origin).toBe("OWNER_OBSERVATION");
    const [row] = await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.id, probe.artifactId));
    expect(row).toMatchObject({ originKind: "RESEARCH_JOB", researchJobId: probe.jobId, intentKind: "TOKEN_SUPPLY", slot: 100 });
    const laterJob = await makeJob(f);
    expect(await historicalFor(f, laterJob)).toEqual([]);
  });

  it("2. a PRODUCT prior Research reading remains eligible, exactly as before", async () => {
    const f = await makeProject();
    const prior = await priorSupplyWithOrigin(f, "PRODUCT", 100);
    const laterJob = await makeJob(f);
    const candidates = await historicalFor(f, laterJob);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].observation).toMatchObject({ originKind: "RESEARCH_JOB", researchJobId: prior });
    expect(candidates[0].observation.artifact.provenance.slot).toBe(100);
  });

  it("3. an OWNER_MANUAL_ALPHA prior full Research reading remains eligible", async () => {
    const f = await makeProject();
    const prior = await priorSupplyWithOrigin(f, "OWNER_MANUAL_ALPHA", 100);
    const laterJob = await makeJob(f);
    const candidates = await historicalFor(f, laterJob);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].observation.researchJobId).toBe(prior);
  });

  it("mixed history: only the Research readings come back; the owner probe between them is absent", async () => {
    const f = await makeProject();
    const product = await priorSupplyWithOrigin(f, "PRODUCT", 100);
    await ownerProbe(f, 200);
    const alpha = await priorSupplyWithOrigin(f, "OWNER_MANUAL_ALPHA", 300);
    const laterJob = await makeJob(f);
    const candidates = await historicalFor(f, laterJob);
    expect(candidates.map((c) => c.observation.researchJobId)).toEqual([alpha, product]);
    expect(candidates.map((c) => c.observation.artifact.provenance.slot)).toEqual([300, 100]);
  });

  it("a persisted-but-orphaned artifact (no job row) is not a candidate either — the join is inner", async () => {
    const f = await makeProject();
    const laterJob = await makeJob(f);
    const intent = supplyIntent(f.mint);
    // A RESEARCH_JOB-shaped row whose job never existed cannot be inserted
    // (FK), so the inner join is exercised through the standalone shape
    // instead: null job id, excluded before the join can even apply.
    await ctx.db.insert(onchainArtifacts).values({
      originKind: "STANDALONE_STRUCTURED_OBSERVATION",
      researchJobId: null,
      sourceId: null,
      canonicalUri: buildCanonicalOnchainUri(intent),
      chain: "solana",
      network: "mainnet",
      projectAnchor: f.mint,
      subjectKind: "token",
      subject: f.mint,
      intentKind: "TOKEN_SUPPLY",
      slot: 100,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      transactionSignature: null,
      retrievalMethod: "RPC",
      providerId: "owner-script",
      providerMethod: "getTokenSupply",
      requestParams: { subject: f.mint },
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:standalone:${f.mint}`,
      artifactHash: `sha256:art:standalone:${f.mint}`,
      normalizedResult: { kind: "TOKEN_SUPPLY", mint: f.mint, amountRaw: "1", decimals: 6 },
    });
    expect(await historicalFor(f, laterJob)).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 5–7. Every consumer of the loader.
// ---------------------------------------------------------------------

describe("consumers — selector, post-event completion, materialization", () => {
  it("5. the event-anchored selector never sees the owner observation: with it as the only history, nothing is selected", async () => {
    const f = await makeProject();
    await ownerProbe(f, 100);
    const jobId = await makeJob(f);
    await establishBurn(f, jobId);
    await establishSupply(f, jobId, 900, "990");
    const events = await loadCurrentJobBurnEvents(ctx.db, { currentResearchJobId: jobId, projectAnchor: f.mint });
    const current = await loadCurrentJobSupplyObservations(ctx.db, { currentResearchJobId: jobId, projectAnchor: f.mint, chain: "solana", network: "mainnet" });
    const historical = await historicalFor(f, jobId);
    expect(events).toHaveLength(1);
    expect(current).toHaveLength(1);
    expect(historical).toEqual([]);
    const event: AnchorBurnEvent = events[0];
    const outcome = selectEventAnchoredSupplyInterval({
      currentResearchJobId: jobId,
      currentProjectAnchor: f.mint,
      event,
      current: current[0].observation,
      historical: historical.map((h) => h.observation),
    });
    expect(outcome.selected).toBe(false);
    // And the same run with a PRODUCT prior at the same slot IS selected —
    // the refusal above is the origin, not the shape.
    const g = await makeProject();
    await priorSupplyWithOrigin(g, "PRODUCT", 100);
    const gJob = await makeJob(g);
    await establishBurn(g, gJob);
    await establishSupply(g, gJob, 900, "990");
    const gEvents = await loadCurrentJobBurnEvents(ctx.db, { currentResearchJobId: gJob, projectAnchor: g.mint });
    const gCurrent = await loadCurrentJobSupplyObservations(ctx.db, { currentResearchJobId: gJob, projectAnchor: g.mint, chain: "solana", network: "mainnet" });
    const gHistorical = await historicalFor(g, gJob);
    const gOutcome = selectEventAnchoredSupplyInterval({
      currentResearchJobId: gJob,
      currentProjectAnchor: g.mint,
      event: gEvents[0],
      current: gCurrent[0].observation,
      historical: gHistorical.map((h) => h.observation),
    });
    expect(gOutcome.selected).toBe(true);
  }, 120_000);

  it("6. post-event completion: an owner probe is not a t0, so no RPC is issued (NO_HISTORICAL_T0); a PRODUCT prior still triggers exactly one", async () => {
    const f = await makeProject();
    await ownerProbe(f, 100);
    const jobId = await makeJob(f);
    await establishBurn(f, jobId);
    await establishSupply(f, jobId, 400, "1000");
    const asked: OnchainIntent[] = [];
    const retriever = {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent) => {
        asked.push(intent);
        return supplyArtifact(f.mint, 900, "990");
      },
    };
    const result = await runPostEventSupplyCompletion(ctx.db, { jobId, projectId: f.id, maxSourceOpens: 24, retriever });
    expect(asked).toEqual([]);
    expect(result.outcome).toBe("NO_ACTION");
    expect(result.gate?.reason).toBe("NO_HISTORICAL_T0");

    const g = await makeProject();
    await priorSupplyWithOrigin(g, "PRODUCT", 100);
    const gJob = await makeJob(g);
    await establishBurn(g, gJob);
    await establishSupply(g, gJob, 400, "1000");
    const gAsked: OnchainIntent[] = [];
    const gResult = await runPostEventSupplyCompletion(ctx.db, {
      jobId: gJob,
      projectId: g.id,
      maxSourceOpens: 24,
      retriever: { name: "fixture", supports: () => true, retrieve: async (i: OnchainIntent) => { gAsked.push(i); return supplyArtifact(g.mint, 900, "990"); } },
    });
    expect(gAsked).toHaveLength(1);
    expect(gResult.outcome).toBe("ACQUIRED");
  }, 120_000);

  it("7. supply-delta materialization: an owner probe cannot open the interval; a PRODUCT prior can", async () => {
    const f = await makeProject();
    await ownerProbe(f, 100);
    const jobId = await makeJob(f);
    await establishBurn(f, jobId);
    await establishSupply(f, jobId, 900, "990");
    const out = await runSupplyDeltaMaterialization(ctx.db, { jobId, projectId: f.id });
    expect(out.evidenceId).toBeNull();
    expect(out.outcome).not.toBe("MATERIALIZED");

    const g = await makeProject();
    await priorSupplyWithOrigin(g, "PRODUCT", 100, "1000");
    const gJob = await makeJob(g);
    await establishBurn(g, gJob);
    await establishSupply(g, gJob, 900, "990");
    const gOut = await runSupplyDeltaMaterialization(ctx.db, { jobId: gJob, projectId: g.id });
    expect(gOut.evidenceId).not.toBeNull();
    expect(gOut.fromSlot).toBe(100);
    expect(gOut.toSlot).toBe(900);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 8–9. What must not change.
// ---------------------------------------------------------------------

describe("unchanged — same-job reuse, current-job loading, and Research Memory", () => {
  it("8. same-job reuse is job-scoped and origin-blind: a Research job reuses its own reading; an owner job reuses its own; neither sees the other", async () => {
    const f = await makeProject();
    const probe = await ownerProbe(f, 100);
    const research = await makeJob(f);
    await establishSupply(f, research, 200, "1000");
    // Wait: TOKEN_SUPPLY is deliberately NOT a reusable intent kind within a
    // job (it is slot-sensitive), so same-job reuse answers null for both —
    // the point pinned here is that the answer is decided by the kind and
    // the job, never by origin, and never crosses jobs.
    expect(await findReusableSameJobArtifact(ctx.db, research, supplyIntent(f.mint))).toBeNull();
    expect(await findReusableSameJobArtifact(ctx.db, probe.jobId, supplyIntent(f.mint))).toBeNull();
    // Current-job loading is unchanged and still returns the owner job's own
    // reading to the owner job — it is persisted and inspectable.
    const own = await loadCurrentJobSupplyObservations(ctx.db, { currentResearchJobId: probe.jobId, projectAnchor: f.mint, chain: "solana", network: "mainnet" });
    expect(own.map((o) => o.onchainArtifactId)).toEqual([probe.artifactId]);
    const researchOwn = await loadCurrentJobSupplyObservations(ctx.db, { currentResearchJobId: research, projectAnchor: f.mint, chain: "solana", network: "mainnet" });
    expect(researchOwn).toHaveLength(1);
    expect(researchOwn[0].onchainArtifactId).not.toBe(probe.artifactId);
  });

  it("9. the Research Memory lifecycle does not read job origin — VERIFIED promotion is untouched by this rule", () => {
    for (const file of ["src/server/memory/lifecycle.ts", "src/server/memory/plan-job.ts", "src/server/memory/retrieval-gateway.ts"]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("OWNER_OBSERVATION");
      expect(src, file).not.toContain("REAL_RESEARCH_ACQUISITION_ORIGINS");
      expect(src, file).not.toMatch(/researchJobs\.origin/);
    }
    // The only readers of job origin are the worker's executor choice and
    // the owner-alpha routing, exactly as before, plus the historical loader.
    const readers = ["src/server/jobs/worker.ts", "src/server/jobs/owner-alpha-routing.ts", "src/server/engine/onchain-supply-candidate-store.ts"];
    for (const file of readers) {
      expect(readFileSync(file, "utf-8"), file).toMatch(/\.origin\b|researchJobs\.origin/);
    }
  });

  it("the owner job's Evidence exists and is inspectable — exclusion is from reuse, not from persistence", async () => {
    const f = await makeProject();
    const probe = await ownerProbe(f, 100);
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, probe.jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ onchainArtifactId: probe.artifactId, sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "CONFIRMED" });
  });
});
