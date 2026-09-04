import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projects,
  proofs,
  researchClaimSupport,
  researchComponentResults,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { buildAndPersistProof } from "../src/server/engine/proof-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// S8 — THE PROOF STORE. Persistence, atomicity, binding and re-run safety.
//
// Offline: this suite touches only the local test database. S8 makes no
// model, network, RPC or search call by construction — its import graph
// contains no provider, which the boundary test at the bottom asserts.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

interface Fixture {
  jobId: string;
  userId: string;
  projectId: string;
  sourceId: string;
  evidenceIds: string[];
}

// Builds one job with two Evidence rows: one the component treats as
// SUPPORTING, one it EXCLUDED. Only the first may ever be bound.
async function makeFixture(opts: {
  claimStatus?: string | null;
  componentStatus?: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE";
  componentReasonCodes?: string[];
  withProject?: boolean;
}): Promise<Fixture> {
  const slug = uniq("s8");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "S8 Fixture", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: opts.withProject === false ? undefined : project.id,
    originalQuestion: "q",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });

  const url = `https://s8.example.test/${slug}`;
  const [source] = await ctx.db
    .insert(sources)
    .values({ url, urlHash: uniq("uh"), sourceType: "OTHER" })
    .returning();

  const base = {
    researchJobId: job.id,
    sourceId: source.id,
    patternStep: 6,
    component: "DESTINATION",
    relationship: "SUPPORTS" as const,
    directness: "DIRECT" as const,
    sourceClass: "OFFICIAL_DOCS" as const,
    officiality: "CONFIRMED" as const,
    entityBinding: "CONFIRMED" as const,
    fetchedAt: new Date("2026-08-29T00:00:00Z"),
    retrievedUrl: url,
    contentHash: "sha256:x",
    doesNotProve: "limits",
  };
  const [supporting] = await ctx.db
    .insert(evidence)
    .values({ ...base, summary: "supporting row", fragment: "f1" })
    .returning({ id: evidence.id });
  const [excludedRow] = await ctx.db
    .insert(evidence)
    .values({ ...base, relationship: "CONTEXT", summary: "excluded row", fragment: "f2" })
    .returning({ id: evidence.id });

  await ctx.db.insert(researchComponentResults).values({
    researchJobId: job.id,
    patternStep: 6,
    component: "DESTINATION",
    status: opts.componentStatus ?? "SUPPORTED",
    reasonCodes: opts.componentReasonCodes ?? [],
    supportingEvidenceIds: [supporting.id],
    contradictingEvidenceIds: [],
    excludedEvidence: [{ evidenceId: excludedRow.id, reason: "RELATIONSHIP_NOT_SUPPORTING" }],
    requiresFreshEvidence: false,
  });

  if (opts.claimStatus !== null) {
    await ctx.db.insert(researchClaimSupport).values({
      researchJobId: job.id,
      patternVersion: 1,
      requirementSetVersion: 1,
      intent: "MECHANISM_EXISTENCE",
      status: opts.claimStatus ?? "SUPPORTED",
      reasonCodes: [],
      requirementResults: [
        {
          requirementId: "R1",
          optionality: "REQUIRED",
          status: "SATISFIED",
          reasonCodes: [],
          matchedFlowIds: [],
          blockingGaps: [],
          provenance: {
            flowIds: [],
            componentResultKeys: [{ step: 6, component: "DESTINATION" }],
            evidenceIds: [supporting.id, excludedRow.id],
          },
        },
      ],
      contextGaps: [],
    });
  }

  return {
    jobId: job.id,
    userId: user.id,
    projectId: project.id,
    sourceId: source.id,
    evidenceIds: [supporting.id, excludedRow.id],
  };
}

describe("persistence (items 18, 19, 22, 23, 24, 25)", () => {
  it("18/19. a valid Proof persists exactly once, PRIVATE and DRAFT", async () => {
    const f = await makeFixture({});
    const out = await buildAndPersistProof(ctx.db, f.jobId);
    expect(out.refusal).toBeNull();
    expect(out.proofId).not.toBeNull();

    const rows = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe("PRIVATE");
    expect(rows[0].verificationStatus).toBe("DRAFT");
    expect(rows[0].verdict).toBe("SUPPORTED");
    expect(rows[0].confidence).toBe(80);
    expect(rows[0].researchCutoff).toBeNull();
  }, 30_000);

  it("an INSUFFICIENT_EVIDENCE Proof is valid and keeps its named gaps", async () => {
    const f = await makeFixture({
      claimStatus: "INSUFFICIENT_EVIDENCE",
      componentStatus: "INSUFFICIENT_EVIDENCE",
      componentReasonCodes: ["ALL_EVIDENCE_EXCLUDED"],
    });
    const out = await buildAndPersistProof(ctx.db, f.jobId);
    expect(out.refusal).toBeNull();
    const [row] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId));
    expect(row.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(row.confidence).toBe(60); // reasoned exclusion, no blocking gap
    const layers = JSON.stringify(row.layers);
    expect(layers).toContain("ALL_EVIDENCE_EXCLUDED");
    expect(layers).toContain("RELATIONSHIP_NOT_SUPPORTING");
  }, 30_000);

  it("22/23. ONLY cited Evidence is bound; excluded Evidence is never bound", async () => {
    const f = await makeFixture({});
    const out = await buildAndPersistProof(ctx.db, f.jobId);
    const [supportingId, excludedId] = f.evidenceIds;
    expect(out.boundEvidenceIds).toEqual([supportingId]);

    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, f.jobId));
    const byId = new Map(rows.map((r) => [r.id, r.proofId]));
    expect(byId.get(supportingId)).toBe(out.proofId);
    // Belonging to the job is NOT a reason to bind.
    expect(byId.get(excludedId)).toBeNull();
  }, 30_000);

  it("24. a dangling citation is impossible — the builder only sees ids that exist", async () => {
    const f = await makeFixture({});
    const out = await buildAndPersistProof(ctx.db, f.jobId);
    const existing = new Set(
      (await ctx.db.select({ id: evidence.id }).from(evidence).where(eq(evidence.researchJobId, f.jobId))).map((r) => r.id),
    );
    for (const id of out.draft!.citedEvidenceIds) expect(existing.has(id)).toBe(true);
  }, 30_000);

  it("25. persistence is atomic: a refusal leaves no Proof and no binding", async () => {
    const f = await makeFixture({ claimStatus: null }); // no S7 row
    const out = await buildAndPersistProof(ctx.db, f.jobId);
    expect(out.refusal).toBe("NO_CLAIM_SUPPORT");
    expect(await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId))).toHaveLength(0);
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, f.jobId));
    for (const r of rows) expect(r.proofId).toBeNull();
  }, 30_000);
});

describe("fail closed (item 17)", () => {
  it("17. no S7 -> no Proof, and no placeholder row of any kind", async () => {
    const f = await makeFixture({ claimStatus: null });
    const out = await buildAndPersistProof(ctx.db, f.jobId);
    expect(out.refusal).toBe("NO_CLAIM_SUPPORT");
    expect(out.proofId).toBeNull();
    expect(out.draft).toBeNull();
  }, 30_000);

  it("a job with no project cannot carry a Proof (proofs.project_id is NOT NULL)", async () => {
    const f = await makeFixture({ withProject: false });
    const out = await buildAndPersistProof(ctx.db, f.jobId);
    expect(out.refusal).toBe("NO_PROJECT");
    expect(await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId))).toHaveLength(0);
  }, 30_000);
});

describe("idempotency and historical safety (items 20, 21)", () => {
  it("20. re-running does not duplicate: one row, stable content", async () => {
    const f = await makeFixture({});
    const first = await buildAndPersistProof(ctx.db, f.jobId);
    const second = await buildAndPersistProof(ctx.db, f.jobId);

    expect(second.refusal).toBeNull();
    expect(second.proofId).toBe(first.proofId);
    expect(second.replacedExisting).toBe(true);
    expect(await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId))).toHaveLength(1);
    // Same persisted state in, same Proof out.
    expect(JSON.stringify(second.draft)).toBe(JSON.stringify(first.draft));
  }, 30_000);

  it("21. a REVIEWED or VERIFIED Proof is never silently rewritten", async () => {
    for (const status of ["REVIEWED", "VERIFIED"] as const) {
      const f = await makeFixture({});
      const first = await buildAndPersistProof(ctx.db, f.jobId);
      await ctx.db.update(proofs).set({ verificationStatus: status }).where(eq(proofs.id, first.proofId!));

      const again = await buildAndPersistProof(ctx.db, f.jobId);
      expect(again.refusal, status).toBe("PROOF_NOT_DRAFT");
      expect(again.proofId, status).toBeNull();

      const [row] = await ctx.db.select().from(proofs).where(eq(proofs.id, first.proofId!));
      expect(row.verificationStatus, status).toBe(status);
      expect(row.verdict, status).toBe("SUPPORTED");
    }
  }, 60_000);

  it("a re-run that cites less releases the stale binding rather than leaving it", async () => {
    const f = await makeFixture({});
    const first = await buildAndPersistProof(ctx.db, f.jobId);
    const [supportingId] = f.evidenceIds;
    expect(first.boundEvidenceIds).toEqual([supportingId]);

    // The component no longer treats anything as supporting.
    await ctx.db
      .update(researchComponentResults)
      .set({ supportingEvidenceIds: [] })
      .where(eq(researchComponentResults.researchJobId, f.jobId));

    const second = await buildAndPersistProof(ctx.db, f.jobId);
    expect(second.boundEvidenceIds).toEqual([]);
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, f.jobId));
    for (const r of rows) expect(r.proofId).toBeNull();
  }, 30_000);
});

describe("S8 does not research (items 26, 27, 28)", () => {
  it("26. neither S8 module imports a provider, network, model or RPC surface", async () => {
    const fs = await import("node:fs/promises");
    for (const file of ["proof-store.ts", "proof-builder.ts", "proof-confidence.ts"]) {
      const src = await fs.readFile(new URL(`../src/server/engine/${file}`, import.meta.url), "utf-8");
      for (const banned of [
        "anthropic",
        "Anthropic",
        "evidence-extractor",
        "query-proposer",
        "search-gateway",
        "content-fetcher",
        "onchain-transport",
        "createProductionOnchainRetriever",
        "node:https",
        "fetch(",
        "playwright",
      ]) {
        expect(src, `${file} references "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("27. S8 leaves S5/S6/S7 rows untouched", async () => {
    const f = await makeFixture({});
    const before = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(eq(researchComponentResults.researchJobId, f.jobId));
    const claimBefore = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, f.jobId));

    await buildAndPersistProof(ctx.db, f.jobId);

    const after = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(eq(researchComponentResults.researchJobId, f.jobId));
    const claimAfter = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, f.jobId));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(JSON.stringify(claimAfter)).toBe(JSON.stringify(claimBefore));
  }, 30_000);

  it("28. the persisted layers keep the D-083 contract: seven layers, layer 5 empty", async () => {
    const f = await makeFixture({});
    await buildAndPersistProof(ctx.db, f.jobId);
    const [row] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId));
    const layers = row.layers as { version: number; layers: { layer: number; lines: string[] }[] };
    expect(layers.layers.map((l) => l.layer)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(layers.layers.find((l) => l.layer === 5)!.lines).toEqual([]);
  }, 30_000);
});
