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
import type { ClaimRequirementResult, MechanismGapRef } from "../src/server/engine/claim-evaluator";
import { buildAndPersistProof } from "../src/server/engine/proof-store";
import { loadProofForJob } from "../src/server/services/proof-view";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// S9 — THE PRODUCT BOUNDARY.
//
// Offline: this suite touches only the local test database. S9 reads S8
// and recomputes nothing, so most of what these tests pin is what the
// projection must NOT do — reinterpret a verdict, re-derive confidence,
// expose unbound Evidence, fabricate a Proof, or leak engine internals.

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
  supportingId: string;
  excludedId: string;
}

// One job with two Evidence rows — one the component treats as
// SUPPORTING, one it EXCLUDED — plus the S5/S7 rows S8 needs.
async function makeFixture(opts: {
  claimStatus?: string;
  componentStatus?: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE";
  componentReasonCodes?: string[];
  blockingGaps?: MechanismGapRef[];
  requirementStatus?: ClaimRequirementResult["status"];
} = {}): Promise<Fixture> {
  const slug = uniq("s9");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "S9 Fixture", status: "ACTIVE_CORE" })
    .returning();
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

  const url = `https://s9.example.test/${slug}`;
  const [source] = await ctx.db
    .insert(sources)
    .values({ url, urlHash: uniq("uh"), sourceType: "OTHER", title: "Fixture doc", publisher: "Fixture pub" })
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
  const [excluded] = await ctx.db
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
    excludedEvidence: [{ evidenceId: excluded.id, reason: "RELATIONSHIP_NOT_SUPPORTING" }],
    requiresFreshEvidence: false,
  });

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
        optionality: "REQUIRED" as const,
        status: opts.requirementStatus ?? "SATISFIED",
        reasonCodes: [],
        matchedFlowIds: [],
        blockingGaps: opts.blockingGaps ?? [],
        provenance: {
          flowIds: [],
          componentResultKeys: [{ step: 6, component: "DESTINATION" }],
          evidenceIds: [supporting.id, excluded.id],
        },
      },
    ],
    contextGaps: [],
  });

  return {
    jobId: job.id,
    userId: user.id,
    projectId: project.id,
    supportingId: supporting.id,
    excludedId: excluded.id,
  };
}

describe("the DTO reads persisted S8 state and copies it (items 1-6, 14)", () => {
  it("1/2/3/4/6/14. every field is copied exactly from the persisted Proof", async () => {
    const f = await makeFixture();
    const persisted = await buildAndPersistProof(ctx.db, f.jobId);
    expect(persisted.refusal).toBeNull();

    const [row] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId));
    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect(view).not.toBeNull();

    expect(view!.proofId).toBe(row.id);
    expect(view!.researchJobId).toBe(f.jobId);
    expect(view!.projectId).toBe(f.projectId);
    // 2. verdict copied exactly.
    expect(view!.verdict).toBe(row.verdict);
    expect(view!.verdict).toBe("SUPPORTED");
    // 3/4. band and score copied exactly — score is the stored encoding.
    expect(view!.confidence.score).toBe(row.confidence);
    expect(view!.confidence.score).toBe(80);
    expect(view!.confidence.band).toBe("VERY_STRONG");
    // 6. layers copied without reinterpretation.
    expect(JSON.stringify(view!.layers)).toBe(JSON.stringify(row.layers));
    // 14/15. verification state copied exactly; DRAFT is not VERIFIED.
    expect(view!.verificationStatus).toBe(row.verificationStatus);
    expect(view!.verificationStatus).toBe("DRAFT");
    expect(view!.verificationStatus).not.toBe("VERIFIED");
    expect(view!.visibility).toBe("PRIVATE");
  }, 30_000);

  it("5. the score is never formatted as a percentage anywhere in the DTO", async () => {
    const f = await makeFixture();
    await buildAndPersistProof(ctx.db, f.jobId);
    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("%");
    // The score is a number, not a rendered string like "80%".
    expect(typeof view!.confidence.score).toBe("number");
  }, 30_000);

  it("15. a VERIFIED Proof is reported as VERIFIED, and never inferred from confidence", async () => {
    const f = await makeFixture();
    const persisted = await buildAndPersistProof(ctx.db, f.jobId);
    // Same confidence, different verification — proving the two are
    // independent fields rather than one derived from the other.
    const before = await loadProofForJob(ctx.db, f.jobId, f.userId);
    await ctx.db
      .update(proofs)
      .set({ verificationStatus: "VERIFIED" })
      .where(eq(proofs.id, persisted.proofId!));
    const after = await loadProofForJob(ctx.db, f.jobId, f.userId);

    expect(before!.verificationStatus).toBe("DRAFT");
    expect(after!.verificationStatus).toBe("VERIFIED");
    expect(after!.confidence.score).toBe(before!.confidence.score);
  }, 30_000);

  it("a confidence encoding outside the four bands yields band null, never a guessed band", async () => {
    const f = await makeFixture();
    const persisted = await buildAndPersistProof(ctx.db, f.jobId);
    // A row predating D-135 (or hand-written) can hold any 0..100 value.
    await ctx.db.update(proofs).set({ confidence: 55 }).where(eq(proofs.id, persisted.proofId!));
    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect(view!.confidence.score).toBe(55);
    expect(view!.confidence.band).toBeNull();
  }, 30_000);
});

describe("citations come from the binding (items 7, 8)", () => {
  it("7/8. only Proof-bound Evidence is exposed; excluded Evidence is not", async () => {
    const f = await makeFixture();
    const persisted = await buildAndPersistProof(ctx.db, f.jobId);
    expect(persisted.boundEvidenceIds).toEqual([f.supportingId]);

    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect(view!.citations.map((c) => c.evidenceId)).toEqual([f.supportingId]);
    // The excluded row exists on the job but carries no binding, so it is
    // absent because it was never bound — not because a filter hid it.
    const all = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, f.jobId));
    expect(all).toHaveLength(2);
    expect(view!.citations).toHaveLength(1);
  }, 30_000);

  it("the citation projection carries the source's public identity and nothing operational", async () => {
    const f = await makeFixture();
    await buildAndPersistProof(ctx.db, f.jobId);
    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    const c = view!.citations[0];
    expect(c.source.title).toBe("Fixture doc");
    expect(c.source.publisher).toBe("Fixture pub");
    expect(c.summary).toBe("supporting row");
    expect(c.doesNotProve).toBe("limits");
    // 18. no acquisition/provider internals ride along.
    const keys = Object.keys(c);
    for (const banned of ["contentHash", "sourceId", "researchJobId", "extractionUnitKey", "onchainArtifactId", "proofId"]) {
      expect(keys, `citation exposes "${banned}"`).not.toContain(banned);
    }
  }, 30_000);
});

describe("no-proof semantics and privacy (items 11, 12, 13)", () => {
  it("12. a job with no Proof returns null — never a fabricated one", async () => {
    const f = await makeFixture();
    // No buildAndPersistProof call at all.
    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect(view).toBeNull();
    expect(await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId))).toHaveLength(0);
  }, 30_000);

  it("11. reading performs no writes — the Proof and its bindings are untouched", async () => {
    const f = await makeFixture();
    await buildAndPersistProof(ctx.db, f.jobId);
    const before = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId));
    const evBefore = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, f.jobId));

    await loadProofForJob(ctx.db, f.jobId, f.userId);
    await loadProofForJob(ctx.db, f.jobId, f.userId);

    const after = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, f.jobId));
    const evAfter = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, f.jobId));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(JSON.stringify(evAfter)).toBe(JSON.stringify(evBefore));
    expect(after).toHaveLength(1);
  }, 30_000);

  it("13. another user cannot read a private Proof, and cannot tell it apart from absence", async () => {
    const f = await makeFixture();
    await buildAndPersistProof(ctx.db, f.jobId);
    const [stranger] = await ctx.db.insert(users).values({}).returning();

    const owner = await loadProofForJob(ctx.db, f.jobId, f.userId);
    const other = await loadProofForJob(ctx.db, f.jobId, stranger.id);
    expect(owner).not.toBeNull();
    // Identical to the "no Proof yet" answer — guessing an id reveals
    // nothing about whether one exists.
    expect(other).toBeNull();
  }, 30_000);
});

describe("S9 reads S8 and recomputes nothing (items 9, 10, 20)", () => {
  it("9/10. editing the persisted Proof changes the DTO, proving nothing is re-derived", async () => {
    const f = await makeFixture();
    const persisted = await buildAndPersistProof(ctx.db, f.jobId);
    // Write a verdict/confidence pair the engine would never produce for
    // this state. If S9 recomputed anything, it would "correct" them.
    await ctx.db
      .update(proofs)
      .set({ verdict: "NOT_SUPPORTED", confidence: 20 })
      .where(eq(proofs.id, persisted.proofId!));

    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect(view!.verdict).toBe("NOT_SUPPORTED");
    expect(view!.confidence.score).toBe(20);
    expect(view!.confidence.band).toBe("LOW");
    // And the S5/S7 rows still say SUPPORTED — S9 did not reconcile them.
    const [claim] = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, f.jobId));
    expect(claim.status).toBe("SUPPORTED");
  }, 30_000);

  it("20. existing S8 rows are unchanged by any number of reads", async () => {
    const f = await makeFixture();
    const persisted = await buildAndPersistProof(ctx.db, f.jobId);
    const [before] = await ctx.db.select().from(proofs).where(eq(proofs.id, persisted.proofId!));
    for (let i = 0; i < 3; i++) await loadProofForJob(ctx.db, f.jobId, f.userId);
    const [after] = await ctx.db.select().from(proofs).where(eq(proofs.id, persisted.proofId!));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  }, 30_000);
});

describe("the boundary itself (items 16, 17, 19)", () => {
  it("16. the route uses the shared serializer rather than assembling its own Proof", async () => {
    const fs = await import("node:fs/promises");
    const route = await fs.readFile(
      new URL("../app/api/research-jobs/[id]/route.ts", import.meta.url),
      "utf-8",
    );
    expect(route).toContain("loadProofForJob");
    // The route never queries the proofs table itself, so a second
    // representation cannot appear beside the canonical one.
    expect(route).not.toContain("from(proofs)");
    expect(route).not.toContain("proofs.");
  });

  it("17/19. the projection is platform-independent and has no network, model or RPC dependency", async () => {
    const fs = await import("node:fs/promises");
    // Executable code only. The module's own doc comment names Telegram
    // to explain WHY the DTO is platform-independent (D-125), and
    // forbidding that would punish the documentation rather than the
    // coupling — same comment-stripping discipline as the other boundary
    // tests in this repository.
    const src = (await fs.readFile(new URL("../src/server/services/proof-view.ts", import.meta.url), "utf-8"))
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const banned of [
      "telegram",
      "Telegram",
      "initData",
      "chat_id",
      "parse_mode",
      "markdown",
      "anthropic",
      "Anthropic",
      "fetch(",
      "node:https",
      "onchain-transport",
      "search-gateway",
      "content-fetcher",
      "playwright",
    ]) {
      expect(src, `proof-view references "${banned}"`).not.toContain(banned);
    }
  });

  it("the DTO exposes no engine-internal projection a client would have to interpret", async () => {
    const f = await makeFixture({
      componentStatus: "PARTIALLY_SUPPORTED",
      componentReasonCodes: ["INSUFFICIENT_AUTHORITY"],
      claimStatus: "PARTIALLY_SUPPORTED",
      requirementStatus: "PARTIAL",
    });
    await buildAndPersistProof(ctx.db, f.jobId);
    const view = await loadProofForJob(ctx.db, f.jobId, f.userId);
    const keys = Object.keys(view!);
    for (const banned of [
      "claimSupport",
      "requirementResults",
      "components",
      "componentResults",
      "mechanism",
      "flows",
      "unassignedGaps",
      "excludedEvidence",
      "reasonCodes",
      "contextGaps",
    ]) {
      expect(keys, `DTO exposes engine internal "${banned}"`).not.toContain(banned);
    }
  }, 30_000);
});

// ---- offline acceptance over the five ratified verdict/band pairs -----
describe("acceptance: each S8 state projects the Proof it implies", () => {
  it("SUPPORTED / VERY_STRONG (80)", async () => {
    const f = await makeFixture();
    await buildAndPersistProof(ctx.db, f.jobId);
    const v = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect([v!.verdict, v!.confidence.band, v!.confidence.score]).toEqual(["SUPPORTED", "VERY_STRONG", 80]);
    expect(v!.citations).toHaveLength(1);
  }, 30_000);

  it("PARTIALLY_SUPPORTED / STRONG (60) — the D-074 authority ceiling", async () => {
    const f = await makeFixture({
      claimStatus: "PARTIALLY_SUPPORTED",
      requirementStatus: "PARTIAL",
      componentStatus: "PARTIALLY_SUPPORTED",
      componentReasonCodes: ["INSUFFICIENT_AUTHORITY"],
    });
    await buildAndPersistProof(ctx.db, f.jobId);
    const v = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect([v!.verdict, v!.confidence.band, v!.confidence.score]).toEqual([
      "PARTIALLY_SUPPORTED",
      "STRONG",
      60,
    ]);
  }, 30_000);

  it("INSUFFICIENT_EVIDENCE / LIMITED (40) — all excluded with a required blocking gap", async () => {
    const f = await makeFixture({
      claimStatus: "INSUFFICIENT_EVIDENCE",
      requirementStatus: "UNSATISFIED",
      componentStatus: "INSUFFICIENT_EVIDENCE",
      componentReasonCodes: ["ALL_EVIDENCE_EXCLUDED"],
      blockingGaps: [{ flowId: null, kind: "MISSING_COMPONENT", component: "DESTINATION", afterStep: 6 }],
    });
    await buildAndPersistProof(ctx.db, f.jobId);
    const v = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect([v!.verdict, v!.confidence.band, v!.confidence.score]).toEqual([
      "INSUFFICIENT_EVIDENCE",
      "LIMITED",
      40,
    ]);
    // The layers still carry the recorded reasons — absence explains itself.
    expect(JSON.stringify(v!.layers)).toContain("ALL_EVIDENCE_EXCLUDED");
  }, 30_000);

  it("INSUFFICIENT_EVIDENCE / LOW (20) — bare absence", async () => {
    const f = await makeFixture({
      claimStatus: "INSUFFICIENT_EVIDENCE",
      requirementStatus: "UNSATISFIED",
      componentStatus: "INSUFFICIENT_EVIDENCE",
      componentReasonCodes: ["NO_EVIDENCE_FOUND"],
    });
    await buildAndPersistProof(ctx.db, f.jobId);
    const v = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect([v!.verdict, v!.confidence.band, v!.confidence.score]).toEqual([
      "INSUFFICIENT_EVIDENCE",
      "LOW",
      20,
    ]);
  }, 30_000);

  it("NOT_SUPPORTED / VERY_STRONG (80) — a positive contradiction is a strong finding", async () => {
    const f = await makeFixture({
      claimStatus: "NOT_SUPPORTED",
      requirementStatus: "CONTRADICTED",
      componentStatus: "CONTRADICTED",
    });
    await buildAndPersistProof(ctx.db, f.jobId);
    const v = await loadProofForJob(ctx.db, f.jobId, f.userId);
    expect([v!.verdict, v!.confidence.band, v!.confidence.score]).toEqual([
      "NOT_SUPPORTED",
      "VERY_STRONG",
      80,
    ]);
  }, 30_000);
});
