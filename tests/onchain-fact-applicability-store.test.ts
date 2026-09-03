import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  evidence,
  projects,
  researchComponentResults,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import {
  applicableComponentsForFactKind,
  applicableFactKindsForComponent,
  ONCHAIN_FACT_KINDS,
  type OnchainFactKind,
} from "../src/server/engine/onchain-facts";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// TYPED FACT APPLICABILITY, IN PRODUCTION.
//
// The map and the reconciler were already right. The STORE was not: it
// selected Evidence by (job, step, component) alone, so the one row the map
// exists for — a BURN filed at EXECUTION_EVIDENCE, because a transaction is
// reachable only through that component's promotion chain — was never among
// the rows NET_EFFECT was asked about. The rule passed its unit tests (which
// hand the row to the pure function directly) and could not fire in a live
// run. B1's gross-reduction reason was therefore unclearable, always.
//
// These tests go through `reconcileAndPersistComponent` — the ONE production
// reconciliation entry point — against real rows in a real database, which
// is precisely what the existing pure-function tests could not do.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-03T00:00:00.000Z");
const MINT = "Mint1111111111111111111111111111111111111111";

async function makeJob(): Promise<{ jobId: string; projectId: string }> {
  const slug = uniq("applic");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Applicability Fixture", status: "ACTIVE_CORE" })
    .returning();
  const ok = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!ok.ok) throw new Error("fixture identity failed");
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "does the buyback reduce circulating supply?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "buyback burn" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return { jobId: job.id, projectId: project.id };
}

// A deterministic chain observation, written exactly as
// persistOnchainArtifactAndFacts writes one.
async function onchainRow(
  jobId: string,
  kind: OnchainFactKind,
  over: {
    step?: number;
    component?: string;
    entityBinding?: "CONFIRMED" | "UNVERIFIED";
    directness?: "DIRECT" | "INDIRECT";
    relationship?: "SUPPORTS" | "CONTRADICTS";
  } = {},
): Promise<string> {
  const [source] = await ctx.db
    .insert(sources)
    .values({
      url: `atlas-onchain://solana/mainnet/${uniq("u")}`,
      urlHash: uniq("uh"),
      sourceType: "ONCHAIN",
      health: "OK",
    })
    .returning();
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      sourceId: source.id,
      patternStep: over.step ?? 4,
      component: over.component ?? "EXECUTION_EVIDENCE",
      relationship: over.relationship ?? "SUPPORTS",
      directness: over.directness ?? "DIRECT",
      fragment: `{"kind":"${kind}"}`,
      summary: `a deterministic ${kind} observation`,
      sourceClass: "ONCHAIN_VERIFIABLE",
      officiality: "CLAIMED",
      entityBinding: over.entityBinding ?? "CONFIRMED",
      onchainFactKind: kind,
      evidenceContractVersion: 2,
      fetchedAt: NOW,
      publishedAt: NOW,
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      doesNotProve: "does not establish a net supply change",
    })
    .returning();
  return row.id;
}

// A documentary row for the SAME component — null onchain_fact_kind.
async function documentaryRow(jobId: string, step: number, component: string): Promise<string> {
  const [source] = await ctx.db
    .insert(sources)
    .values({
      url: `https://docs.example.test/${uniq("p")}`,
      urlHash: uniq("uh"),
      sourceType: "OFFICIAL_DOCS",
      health: "OK",
    })
    .returning();
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      sourceId: source.id,
      patternStep: step,
      component,
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: "the protocol burns the tokens it buys back",
      summary: "documented burn",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      evidenceContractVersion: 2,
      fetchedAt: NOW,
      publishedAt: NOW,
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
    })
    .returning();
  return row.id;
}

async function reconcileNetEffect(jobId: string) {
  return reconcileAndPersistComponent(ctx.db, jobId, { step: 7, component: "NET_EFFECT" }, NOW);
}

describe("1/2. a persisted BURN reaches NET_EFFECT through the production store", () => {
  it("1. the BURN filed at EXECUTION_EVIDENCE is loaded and supports NET_EFFECT", async () => {
    const { jobId } = await makeJob();
    const burn = await onchainRow(jobId, "BURN");

    const r = await reconcileNetEffect(jobId);

    expect(r.supportingEvidenceIds).toContain(burn);
    expect(r.excludedEvidence.find((x) => x.evidenceId === burn)).toBeUndefined();
    // B1's gross-reduction reason clears; the NET question stays open.
    expect(r.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(r.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.status).not.toBe("SUPPORTED");
  }, 120_000);

  it("2. ONE Evidence row, not a copy — it keeps its own step, component and provenance", async () => {
    const { jobId } = await makeJob();
    const burn = await onchainRow(jobId, "BURN");
    const before = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));

    await reconcileNetEffect(jobId);
    await reconcileAndPersistComponent(
      ctx.db,
      jobId,
      { step: 4, component: "EXECUTION_EVIDENCE" },
      NOW,
    );

    const after = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(after).toHaveLength(1);
    expect(before).toHaveLength(1);
    expect(after[0]).toStrictEqual(before[0]);
    expect(after[0].id).toBe(burn);
    expect(after[0].patternStep).toBe(4);
    expect(after[0].component).toBe("EXECUTION_EVIDENCE");
    // And it is counted once by each reader, never twice by either.
    const [netRow] = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.component, "NET_EFFECT"),
        ),
      );
    expect([...(netRow.supportingEvidenceIds as string[])]).toEqual([burn]);
  }, 120_000);
});

describe("3/4/5/6/7. nothing else crosses a component boundary", () => {
  it("3. documentary Evidence filed at EXECUTION_EVIDENCE does NOT leak into NET_EFFECT", async () => {
    const { jobId } = await makeJob();
    const doc = await documentaryRow(jobId, 4, "EXECUTION_EVIDENCE");
    const r = await reconcileNetEffect(jobId);
    expect(r.supportingEvidenceIds).not.toContain(doc);
    expect(r.excludedEvidence.find((x) => x.evidenceId === doc)).toBeUndefined();
    // It was never even loaded: NET_EFFECT sees no evidence at all.
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toContain("NO_EVIDENCE_FOUND");
  }, 120_000);

  it("4. an ONCHAIN_VERIFIABLE row with a NULL fact kind does NOT cross", async () => {
    const { jobId } = await makeJob();
    const [source] = await ctx.db
      .insert(sources)
      .values({
        url: `atlas-onchain://solana/mainnet/${uniq("u")}`,
        urlHash: uniq("uh"),
        sourceType: "ONCHAIN",
        health: "OK",
      })
      .returning();
    const [row] = await ctx.db
      .insert(evidence)
      .values({
        researchJobId: jobId,
        sourceId: source.id,
        patternStep: 4,
        component: "EXECUTION_EVIDENCE",
        relationship: "SUPPORTS",
        directness: "DIRECT",
        fragment: "an on-chain row with no typed kind",
        summary: "untyped",
        sourceClass: "ONCHAIN_VERIFIABLE",
        officiality: "CLAIMED",
        entityBinding: "CONFIRMED",
        onchainFactKind: null,
        evidenceContractVersion: 2,
        fetchedAt: NOW,
        retrievedUrl: source.url,
        contentHash: uniq("ch"),
      })
      .returning();
    const r = await reconcileNetEffect(jobId);
    expect(r.supportingEvidenceIds).not.toContain(row.id);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  }, 120_000);

  it("5/6/7. TOKEN_TRANSFER, TOKEN_ACCOUNT_BALANCE and TOKEN_ACCOUNTS_BY_OWNER never cross", async () => {
    for (const kind of [
      "TOKEN_TRANSFER",
      "TOKEN_ACCOUNT_BALANCE",
      "TOKEN_ACCOUNTS_BY_OWNER",
    ] as const) {
      const { jobId } = await makeJob();
      const id = await onchainRow(jobId, kind);
      const r = await reconcileNetEffect(jobId);
      expect(r.supportingEvidenceIds, `${kind} crossed`).not.toContain(id);
      expect(r.status, `${kind} crossed`).toBe("INSUFFICIENT_EVIDENCE");
    }
  }, 120_000);
});

describe("8/9. crossing grants visibility only — every other rule still decides", () => {
  it("8. a BURN whose entity binding is UNVERIFIED is loaded and then excluded", async () => {
    const { jobId } = await makeJob();
    const burn = await onchainRow(jobId, "BURN", { entityBinding: "UNVERIFIED" });
    const r = await reconcileNetEffect(jobId);
    expect(r.supportingEvidenceIds).not.toContain(burn);
    expect(r.excludedEvidence.find((x) => x.evidenceId === burn)).toBeTruthy();
  }, 120_000);

  it("8b. relationship still decides after crossing — a CONTRADICTS BURN never supports", async () => {
    const { jobId } = await makeJob();
    const burn = await onchainRow(jobId, "BURN", { relationship: "CONTRADICTS" });
    const r = await reconcileNetEffect(jobId);
    // It is read, and then judged by the ordinary rules — a CONTRADICTS
    // row never becomes support for the thing it contradicts.
    expect(r.supportingEvidenceIds).not.toContain(burn);
    expect(r.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  }, 120_000);

  it("9. another job's BURN never crosses", async () => {
    const mine = await makeJob();
    const theirs = await makeJob();
    const foreign = await onchainRow(theirs.jobId, "BURN");
    const r = await reconcileNetEffect(mine.jobId);
    expect(r.supportingEvidenceIds).not.toContain(foreign);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  }, 120_000);
});

describe("10. the map stays closed, tiny and project-blind", () => {
  it("the two directions of the map agree, kind by kind", () => {
    for (const kind of ONCHAIN_FACT_KINDS) {
      for (const component of applicableComponentsForFactKind(kind)) {
        expect(applicableFactKindsForComponent(component)).toContain(kind);
      }
    }
    expect([...applicableFactKindsForComponent("NET_EFFECT")]).toEqual(["BURN"]);
    // Exactly one pair exists, and nothing else does.
    const pairs = ONCHAIN_FACT_KINDS.flatMap((k) =>
      applicableComponentsForFactKind(k).map((c) => `${k}->${c}`),
    );
    expect(pairs).toEqual(["BURN->NET_EFFECT"]);
  });

  it("a component with no mapped kind loads exactly what it always loaded", () => {
    expect(applicableFactKindsForComponent("EXECUTION_EVIDENCE")).toEqual([]);
    expect(applicableFactKindsForComponent("DESTINATION")).toEqual([]);
    expect(applicableFactKindsForComponent("MECHANISM_SPEC")).toEqual([]);
  });

  it("the loader names no project, and keys the union on the typed kind alone", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      "src/server/engine/component-reconciliation-store.ts",
      "utf-8",
    );
    const fn = src.slice(
      src.indexOf("async function loadEvidenceRows"),
      src.indexOf("// The one write this module performs"),
    );
    const code = fn
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("applicableFactKindsForComponent(component)");
    expect(code).toContain("inArray(evidence.onchainFactKind");
    // The job boundary is outside the union.
    expect(code).toContain("eq(evidence.researchJobId, jobId)");
    for (const banned of ["pump", "raydium", "solana", "BURN", "NET_EFFECT"]) {
      expect(code, `loader must not name ${banned}`).not.toContain(banned);
    }
  });
});
