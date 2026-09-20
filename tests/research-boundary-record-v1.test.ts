import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, proofs, researchAttempts, researchClaimSupport, researchComponentResults, sources, topics, users } from "../src/server/db/schema";
import { buildProof } from "../src/server/engine/proof-builder";
import { buildAndPersistProof } from "../src/server/engine/proof-store";
import {
  deriveResearchBoundary,
  RESEARCH_BOUNDARY_VERSION,
  TECHNICAL_ATTEMPT_REASONS,
  TECHNICAL_COMPONENT_CODES,
  type ResearchBoundary,
} from "../src/server/engine/research-boundary";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH BOUNDARY RECORD (Research Reliability V1, A2).
//
// A Proof now says WHY its record stops where it stops, and keeps two
// kinds of reason apart: TECHNICAL (the bounded Research never inspected
// the admissible material) and SUBSTANTIVE (it did, and the evidence
// stayed short). The Aave live job (2b0f00e4) is the motivating shape:
// eight components INSUFFICIENT_EVIDENCE on SEARCH_BUDGET_EXHAUSTED /
// NO_ADMISSIBLE_ROUTE, two PARTIALLY_SUPPORTED on INSUFFICIENT_AUTHORITY,
// one verdict INSUFFICIENT_EVIDENCE at confidence 20 — indistinguishable,
// on the Proof, from a project that was fully inspected and found empty.
//
// PINNED: derivation from persisted codes only; closed technical
// vocabulary; the conservative default (unknown = substantive); a
// component on both sides when it carries both; no verdict, confidence or
// layer moves; the column is additive and nullable.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

/* ------------------------------------------------------------------ */
/* 1. DERIVATION                                                       */
/* ------------------------------------------------------------------ */

describe("deriveResearchBoundary — from persisted codes, nothing else", () => {
  it("the Aave shape: technical boundaries on the starved components, substantive on the partially supported ones, nothing on a SUPPORTED one", () => {
    const b = deriveResearchBoundary({
      components: [
        { step: 1, component: "SOURCE_OF_VALUE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"] },
        { step: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"] },
        { step: 5, component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"] },
        { step: 7, component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED", reasonCodes: ["SUPPLY_REDUCTION_NOT_ESTABLISHED", "INSUFFICIENT_AUTHORITY"] },
        { step: 8, component: "DURABILITY_BASIS", status: "SUPPORTED", reasonCodes: [] },
      ],
    });
    expect(b.version).toBe(RESEARCH_BOUNDARY_VERSION);
    expect(b.technical).toEqual([
      { step: 1, component: "SOURCE_OF_VALUE", codes: ["SEARCH_BUDGET_EXHAUSTED"] },
      { step: 4, component: "EXECUTION_EVIDENCE", codes: ["NO_ADMISSIBLE_ROUTE"] },
    ]);
    expect(b.substantive).toEqual([
      { step: 5, component: "CURRENT_STATE", codes: ["INSUFFICIENT_AUTHORITY"] },
      { step: 7, component: "NET_EFFECT", codes: ["INSUFFICIENT_AUTHORITY", "SUPPLY_REDUCTION_NOT_ESTABLISHED"] },
    ]);
  });

  it("a component that was inspected and found empty is SUBSTANTIVE (NO_EVIDENCE_FOUND); the same code beside a technical one is not a second finding", () => {
    const inspected = deriveResearchBoundary({
      components: [{ step: 6, component: "DESTINATION", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }],
    });
    expect(inspected.technical).toEqual([]);
    expect(inspected.substantive).toEqual([{ step: 6, component: "DESTINATION", codes: ["NO_EVIDENCE_FOUND"] }]);
    const starved = deriveResearchBoundary({
      components: [{ step: 6, component: "DESTINATION", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND", "SEARCH_BUDGET_EXHAUSTED"] }],
    });
    expect(starved.technical).toEqual([{ step: 6, component: "DESTINATION", codes: ["SEARCH_BUDGET_EXHAUSTED"] }]);
    expect(starved.substantive).toEqual([]);
  });

  it("the executor's own terminal attempt reasons are read: a FAILED extraction or an unfetchable source is technical, and only the latest attempt counts", () => {
    const b = deriveResearchBoundary({
      components: [
        { step: 3, component: "MECHANISM_SPEC", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["EXTRACTION_NOT_COMPLETED"] },
        { step: 6, component: "DESTINATION", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] },
        { step: 2, component: "FLOW_PATH", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] },
      ],
      attempts: [
        { step: 3, component: "MECHANISM_SPEC", status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE; source-route observations: X" },
        { step: 6, component: "DESTINATION", status: "SKIPPED", reason: "NO_SOURCE_COULD_BE_FETCHED; ..." },
        // An earlier failed attempt superseded by a later inspected one.
        { step: 2, component: "FLOW_PATH", status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE" },
        { step: 2, component: "FLOW_PATH", status: "SUCCEEDED", reason: "documents read" },
      ],
    });
    expect(b.technical).toEqual([
      { step: 3, component: "MECHANISM_SPEC", codes: ["EXTRACTION_NOT_COMPLETED"] },
      { step: 6, component: "DESTINATION", codes: ["SOURCE_UNAVAILABLE"] },
    ]);
    expect(b.substantive).toEqual([{ step: 2, component: "FLOW_PATH", codes: ["NO_EVIDENCE_FOUND"] }]);
  });

  it("the technical vocabulary is closed and code-owned; an unknown code is substantive by the conservative rule", () => {
    expect([...TECHNICAL_COMPONENT_CODES].sort()).toEqual(["EXTRACTION_NOT_COMPLETED", "NO_ADMISSIBLE_ROUTE", "SEARCH_BUDGET_EXHAUSTED"]);
    expect(Object.keys(TECHNICAL_ATTEMPT_REASONS).sort()).toEqual([
      "EVIDENCE_EXTRACTOR_UNAVAILABLE",
      "EXTRACTION_NOT_COMPLETED",
      "NO_ADMISSIBLE_ROUTE",
      "NO_QUERIES_PROPOSED",
      "NO_SOURCE_COULD_BE_FETCHED",
      "SEARCH_BUDGET_EXHAUSTED",
    ]);
    const b = deriveResearchBoundary({
      components: [{ step: 9, component: "X", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SOME_FUTURE_CODE"] }],
      attempts: [{ step: 9, component: "X", status: "SKIPPED", reason: "SOME_FUTURE_REASON; note" }],
    });
    expect(b.technical).toEqual([]);
    expect(b.substantive).toEqual([{ step: 9, component: "X", codes: ["SOME_FUTURE_CODE"] }]);
    // No reason at all is still named, never dropped.
    const bare = deriveResearchBoundary({ components: [{ step: 9, component: "X", status: "INSUFFICIENT_EVIDENCE", reasonCodes: [] }] });
    expect(bare.substantive).toEqual([{ step: 9, component: "X", codes: ["NO_EVIDENCE_FOUND"] }]);
  });

  it("a CONTRADICTED component is substantive — a finding, never a technical stop", () => {
    const b = deriveResearchBoundary({
      components: [{ step: 7, component: "NET_EFFECT", status: "CONTRADICTED", reasonCodes: ["DIRECT_CONTRADICTION"] }],
    });
    expect(b.technical).toEqual([]);
    expect(b.substantive).toEqual([{ step: 7, component: "NET_EFFECT", codes: ["DIRECT_CONTRADICTION"] }]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. THE PROOF CARRIES IT, AND NOTHING ELSE MOVES                     */
/* ------------------------------------------------------------------ */

function builderInput(attempts?: { step: number; component: string; status: string; reason: string | null }[]) {
  return {
    researchJobId: "job",
    claimSupport: {
      intent: "PROTOCOL_REVENUE_TO_TOKEN",
      status: "INSUFFICIENT_EVIDENCE" as const,
      reasonCodes: ["REQUIRED_COMPONENT_MISSING" as const],
      requirementResults: [],
      contextGaps: [],
    },
    componentResults: [
      { step: 1, component: "SOURCE_OF_VALUE", status: "INSUFFICIENT_EVIDENCE" as const, reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], supportingEvidenceIds: [], excludedEvidence: [] },
      { step: 5, component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED" as const, reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: [], excludedEvidence: [] },
    ],
    existingEvidenceIds: [],
    attemptOutcomes: attempts,
  };
}

describe("the Proof draft carries the boundary; verdict, confidence and layers are byte-identical with or without it", () => {
  it("the same input yields the same verdict/confidence/layers whether or not attempts are supplied; only boundedBy differs", () => {
    const without = buildProof(builderInput());
    const withAttempts = buildProof(builderInput([{ step: 1, component: "SOURCE_OF_VALUE", status: "SKIPPED", reason: "SEARCH_BUDGET_EXHAUSTED; obs" }]));
    expect(without.proof).not.toBeNull();
    expect(withAttempts.proof).not.toBeNull();
    const a = without.proof!;
    const b = withAttempts.proof!;
    expect(b.verdict).toBe(a.verdict);
    expect(b.confidenceScore).toBe(a.confidenceScore);
    expect(b.confidenceBand).toBe(a.confidenceBand);
    expect(b.layers).toEqual(a.layers);
    expect(b.gaps).toEqual(a.gaps);
    expect(a.boundedBy.technical).toEqual([{ step: 1, component: "SOURCE_OF_VALUE", codes: ["SEARCH_BUDGET_EXHAUSTED"] }]);
    expect(a.boundedBy.substantive).toEqual([{ step: 5, component: "CURRENT_STATE", codes: ["INSUFFICIENT_AUTHORITY"] }]);
    expect(b.boundedBy).toEqual(a.boundedBy);
    // The layers never mention the record: it is a field, not a sentence.
    const text = JSON.stringify(a.layers);
    expect(text).not.toContain("boundedBy");
    expect(text).not.toContain("technical boundary");
  });

  it("persisted: buildAndPersistProof writes proofs.bounded_by from the job's own S5 rows and latest attempts; verdict and confidence are what they were", async () => {
    const slug = uniq("bnd");
    const [project] = await ctx.db.insert(projects).values({ slug, name: "Boundary Fixture", status: "ACTIVE_CORE" }).returning();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    const url = `https://bnd.example.test/${slug}`;
    const [source] = await ctx.db.insert(sources).values({ url, urlHash: uniq("uh"), sourceType: "OTHER" }).returning();
    const [row] = await ctx.db
      .insert(evidence)
      .values({
        researchJobId: job.id,
        sourceId: source.id,
        patternStep: 5,
        component: "CURRENT_STATE",
        relationship: "SUPPORTS",
        directness: "DIRECT",
        sourceClass: "ONCHAIN_VERIFIABLE",
        officiality: "CLAIMED",
        entityBinding: "CONFIRMED",
        fetchedAt: new Date("2026-09-19T00:00:00Z"),
        retrievedUrl: url,
        contentHash: "sha256:x",
        doesNotProve: "limits",
        summary: "supply read",
        fragment: "f1",
      })
      .returning({ id: evidence.id });
    await ctx.db.insert(researchComponentResults).values([
      { researchJobId: job.id, patternStep: 1, component: "SOURCE_OF_VALUE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], supportingEvidenceIds: [], contradictingEvidenceIds: [], excludedEvidence: [], requiresFreshEvidence: true },
      { researchJobId: job.id, patternStep: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"], supportingEvidenceIds: [], contradictingEvidenceIds: [], excludedEvidence: [], requiresFreshEvidence: true },
      { researchJobId: job.id, patternStep: 5, component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: [row.id], contradictingEvidenceIds: [], excludedEvidence: [], requiresFreshEvidence: true },
      { researchJobId: job.id, patternStep: 6, component: "DESTINATION", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], supportingEvidenceIds: [], contradictingEvidenceIds: [], excludedEvidence: [], requiresFreshEvidence: true },
    ]);
    await ctx.db.insert(researchAttempts).values([
      { researchJobId: job.id, patternStep: 1, component: "SOURCE_OF_VALUE", attemptNumber: 1, status: "SKIPPED", reason: "SEARCH_BUDGET_EXHAUSTED; source-route observations: SEARCH_BUDGET_EXHAUSTED" },
      { researchJobId: job.id, patternStep: 4, component: "EXECUTION_EVIDENCE", attemptNumber: 1, status: "SKIPPED", reason: "NO_ADMISSIBLE_ROUTE; ..." },
      { researchJobId: job.id, patternStep: 5, component: "CURRENT_STATE", attemptNumber: 1, status: "SUCCEEDED", reason: "ONCHAIN_EVIDENCE_ESTABLISHED" },
      { researchJobId: job.id, patternStep: 6, component: "DESTINATION", attemptNumber: 1, status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE; x" },
      { researchJobId: job.id, patternStep: 6, component: "DESTINATION", attemptNumber: 2, status: "SUCCEEDED", reason: "documents read, nothing admitted" },
    ]);
    await ctx.db.insert(researchClaimSupport).values({
      researchJobId: job.id,
      patternVersion: 1,
      requirementSetVersion: 1,
      intent: "PROTOCOL_REVENUE_TO_TOKEN",
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["REQUIRED_COMPONENT_MISSING"],
      requirementResults: [],
      contextGaps: [],
    });

    const out = await buildAndPersistProof(ctx.db, job.id);
    expect(out.proofId).not.toBeNull();
    const [stored] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, job.id));
    expect(stored.verdict).toBe("INSUFFICIENT_EVIDENCE");
    const bounded = stored.boundedBy as ResearchBoundary;
    expect(bounded.version).toBe(1);
    expect(bounded.technical).toEqual([
      { step: 1, component: "SOURCE_OF_VALUE", codes: ["SEARCH_BUDGET_EXHAUSTED"] },
      { step: 4, component: "EXECUTION_EVIDENCE", codes: ["NO_ADMISSIBLE_ROUTE"] },
    ]);
    // DESTINATION's latest attempt SUCCEEDED (the earlier FAILED one is
    // superseded), so its NO_EVIDENCE_FOUND stands as substantive.
    expect(bounded.substantive).toEqual([
      { step: 5, component: "CURRENT_STATE", codes: ["INSUFFICIENT_AUTHORITY"] },
      { step: 6, component: "DESTINATION", codes: ["NO_EVIDENCE_FOUND"] },
    ]);
    // Rebuilding is idempotent on the record and moves nothing else.
    const again = await buildAndPersistProof(ctx.db, job.id);
    expect(again.proofId).toBe(out.proofId);
    const [stored2] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, job.id));
    expect(stored2.boundedBy).toEqual(stored.boundedBy);
    expect(stored2.verdict).toBe(stored.verdict);
    expect(stored2.confidence).toBe(stored.confidence);
  });

  it("the column is additive and nullable, and the migration is append-only", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("src/server/db/migrations/0055_proof_research_boundary.sql", "utf-8");
    expect(sql).toContain('ALTER TABLE "proofs" ADD COLUMN "bounded_by" jsonb;');
    expect(sql).not.toMatch(/NOT NULL|DROP|UPDATE|DEFAULT/i);
    const journal = JSON.parse(readFileSync("src/server/db/migrations/meta/_journal.json", "utf-8")) as { entries: { idx: number; tag: string }[] };
    // Append-only: the entry sits at its own index, and every entry after
    // it (0056 carries the B2 acquisition scope) only appends.
    const at = journal.entries.findIndex((e) => e.tag === "0055_proof_research_boundary");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(journal.entries[at].idx).toBe(55);
    for (let i = at + 1; i < journal.entries.length; i += 1) expect(journal.entries[i].idx).toBe(journal.entries[i - 1].idx + 1);
  });
});
