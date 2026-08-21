import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import {
  demoQuotaReservations,
  evidence,
  projectMemoryItems,
  projects,
  proofs,
  researchJobs,
  researchMemory,
  researchMemoryProvenance,
  researchPatterns,
  sources,
  topics,
  userIdentities,
  users,
} from "../src/server/db/schema";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import {
  copyProvenanceFromEvidence,
  NotAdminError,
  observeMemoryCandidate,
  promoteToActive,
} from "../src/server/memory/lifecycle";
import { markProofVerified } from "../src/server/memory/verification";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function makeUser() {
  const [u] = await ctx.db.insert(users).values({}).returning();
  return u;
}

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function firstDemoProject() {
  const [p] = await ctx.db.select().from(projects).limit(1);
  return p;
}

function pgError(e: unknown): { code?: string; message?: string } {
  const err = e as { code?: string; message?: string; cause?: unknown };
  if (err?.code) return err;
  return (err?.cause as { code?: string; message?: string } | undefined) ?? {};
}

describe("Фаза 5 — Research Memory: миграции, схема, инварианты (chunk A)", () => {
  it("1. Pattern v1 засеян: одна ACTIVE-версия, ровно 8 шагов, контракт совпадает", async () => {
    const topicId = await activeTopicId();
    const rows = await ctx.db
      .select()
      .from(researchPatterns)
      .where(eq(researchPatterns.topicId, topicId));
    const active = rows.filter((r) => r.status === "ACTIVE");
    expect(active.length).toBe(1);
    expect(active[0].version).toBe(1);
    expect(active[0].content).toEqual(PATTERN_V1_CONTENT);
    expect((active[0].content as typeof PATTERN_V1_CONTENT).steps.length).toBe(8);
  });

  it("2. lifecycle: прямая вставка ACTIVE в research_memory отклоняется триггером", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    let error: unknown;
    try {
      await ctx.db.insert(researchMemory).values({
        projectId: project.id,
        topicId,
        patternStep: 3,
        claimKey: "allocation_mechanism",
        statement: "test",
        freshnessClass: "LOW_CHANGE",
        verifiedAt: sql`now()`,
        confidence: 90,
        lifecycleState: "ACTIVE",
        originKind: "TEST",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).message).toMatch(/must be inserted as OBSERVED/);
  });

  it("3. lifecycle: недопустимый переход (OBSERVED -> ACTIVE напрямую) отклоняется", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const [row] = await ctx.db
      .insert(researchMemory)
      .values({
        projectId: project.id,
        topicId,
        patternStep: 1,
        claimKey: "economic_source",
        statement: "test observed",
        freshnessClass: "LOW_CHANGE",
        verifiedAt: sql`now()`,
        confidence: 80,
        originKind: "TEST",
      })
      .returning();
    expect(row.lifecycleState).toBe("OBSERVED");

    let error: unknown;
    try {
      await ctx.db
        .update(researchMemory)
        .set({ lifecycleState: "ACTIVE" })
        .where(eq(researchMemory.id, row.id));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).message).toMatch(/forbidden research_memory lifecycle transition/);
  });

  it("4. lifecycle: переход в ACTIVE без promoted_by отклоняется — переход только человеком", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const [row] = await ctx.db
      .insert(researchMemory)
      .values({
        projectId: project.id,
        topicId,
        patternStep: 2,
        claimKey: "revenue_waterfall",
        statement: "test candidate",
        freshnessClass: "MEDIUM_CHANGE",
        verifiedAt: sql`now()`,
        confidence: 85,
        originKind: "TEST",
      })
      .returning();
    await ctx.db
      .update(researchMemory)
      .set({ lifecycleState: "CANDIDATE" })
      .where(eq(researchMemory.id, row.id));

    let error: unknown;
    try {
      await ctx.db
        .update(researchMemory)
        .set({ lifecycleState: "ACTIVE" })
        .where(eq(researchMemory.id, row.id));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).message).toMatch(/requires promoted_by/);
  });

  it("5. lifecycle: полный путь OBSERVED -> CANDIDATE -> ACTIVE с promoted_by проходит", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const admin = await makeUser();
    const [row] = await ctx.db
      .insert(researchMemory)
      .values({
        projectId: project.id,
        topicId,
        patternStep: 4,
        claimKey: "actual_execution",
        statement: "buybacks executed monthly per governance record",
        freshnessClass: "MEDIUM_CHANGE",
        verifiedAt: sql`now()`,
        confidence: 92,
        originKind: "TEST",
      })
      .returning();
    await ctx.db
      .update(researchMemory)
      .set({ lifecycleState: "CANDIDATE" })
      .where(eq(researchMemory.id, row.id));
    const [promoted] = await ctx.db
      .update(researchMemory)
      .set({ lifecycleState: "ACTIVE", promotedBy: admin.id, promotedAt: sql`now()` })
      .where(eq(researchMemory.id, row.id))
      .returning();
    expect(promoted.lifecycleState).toBe("ACTIVE");
    expect(promoted.promotedBy).toBe(admin.id);
  });

  it("6. lifecycle: project_memory_items — та же защита от прямой ACTIVE-вставки", async () => {
    const project = await firstDemoProject();
    let error: unknown;
    try {
      await ctx.db.insert(projectMemoryItems).values({
        projectId: project.id,
        kind: "SOURCE_ROUTE",
        content: { note: "test" },
        lifecycleState: "ACTIVE",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).message).toMatch(/must be inserted as OBSERVED/);
  });

  it("7. удаление пользователя не ломается системной Research Memory (D-048)", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const admin = await makeUser();
    const [row] = await ctx.db
      .insert(researchMemory)
      .values({
        projectId: project.id,
        topicId,
        patternStep: 5,
        claimKey: "current_status",
        statement: "status verified via governance dashboard",
        freshnessClass: "HIGH_CHANGE",
        verifiedAt: sql`now()`,
        confidence: 88,
        originKind: "TEST",
      })
      .returning();
    await ctx.db
      .update(researchMemory)
      .set({ lifecycleState: "CANDIDATE" })
      .where(eq(researchMemory.id, row.id));
    await ctx.db
      .update(researchMemory)
      .set({ lifecycleState: "ACTIVE", promotedBy: admin.id, promotedAt: sql`now()` })
      .where(eq(researchMemory.id, row.id));

    // Пользователь, который своим Proof породил трассировку provenance —
    // отдельный от admin, чтобы проверить именно копию, а не promoted_by.
    const originUser = await makeUser();
    await ctx.db
      .insert(userIdentities)
      .values({ userId: originUser.id, provider: "TELEGRAM", providerUserId: uniq("tg") });
    const [src] = await ctx.db
      .insert(sources)
      .values({ url: "https://example.com/gov", urlHash: uniq("srch") })
      .returning();
    await ctx.db.insert(researchMemoryProvenance).values({
      memoryId: row.id,
      sourceId: src.id,
      retrievedUrl: "https://example.com/gov#status",
      contentHash: "sha256:copy",
      fragment: "copied fragment, not user text",
      fetchedAt: sql`now()`,
      // Пользователь удалён ниже; след остаётся БЕЗ FK.
      originEvidenceId: crypto.randomUUID(),
    });

    // Удаление admin (promoted_by) не должно падать: SET NULL.
    await ctx.db.delete(users).where(eq(users.id, admin.id));
    // Удаление пользователя, чей Proof когда-то породил трассировку —
    // тоже не должно падать: сама Research Memory не ссылается на users
    // напрямую нигде, кроме promoted_by (уже SET NULL).
    await ctx.db.delete(users).where(eq(users.id, originUser.id));

    const [survivor] = await ctx.db
      .select()
      .from(researchMemory)
      .where(eq(researchMemory.id, row.id));
    expect(survivor.lifecycleState).toBe("ACTIVE");
    expect(survivor.promotedBy).toBeNull(); // SET NULL, знание осталось валидным

    const provenanceRows = await ctx.db
      .select()
      .from(researchMemoryProvenance)
      .where(eq(researchMemoryProvenance.memoryId, row.id));
    expect(provenanceRows.length).toBe(1); // копия пережила удаление обоих users
  });

  it("8. капитал памяти не может ссылаться на память: у provenance нет FK на research_memory кроме memory_id", async () => {
    const rows = await ctx.db.execute(sql`
      SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'research_memory_provenance'
        AND tc.constraint_type = 'FOREIGN KEY'
    `);
    const foreignTables = (rows.rows as { foreign_table: string }[]).map(
      (r) => r.foreign_table,
    );
    expect(foreignTables.sort()).toEqual(["research_memory", "sources"]);
    // origin_evidence_id, единственный след к пользовательскому evidence,
    // не входит в этот список — значит у него нет FK (проверено структурно).
  });

  it("9. индексы, без которых измерение OFF/ON недостоверно, существуют", async () => {
    const rows = await ctx.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('proofs', 'evidence', 'proof_gaps', 'interpretations')
    `);
    const names = (rows.rows as { indexname: string }[]).map((r) => r.indexname);
    for (const expected of [
      "ix_proofs_project_topic",
      "ix_proofs_owner",
      "ix_evidence_proof",
      "ix_evidence_source",
      "ix_proof_gaps_proof",
      "ix_interpretations_research_job",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("10. evidence.freshness_class принимает канонический словарь LOW_CHANGE/MEDIUM_CHANGE/HIGH_CHANGE", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const jobRow = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId,
      projectId: project.id,
      originalQuestion: "x",
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 3,
    });
    const [proofRow] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: jobRow.job.id,
        ownerUserId: user.id,
        projectId: project.id,
        topicId,
        verdict: "SUPPORTED",
        confidence: 80,
        layers: {},
      })
      .returning();
    const [src] = await ctx.db
      .insert(sources)
      .values({ url: "https://example.com/fresh", urlHash: uniq("srch") })
      .returning();
    for (const cls of ["LOW_CHANGE", "MEDIUM_CHANGE", "HIGH_CHANGE"] as const) {
      const [row] = await ctx.db
        .insert(evidence)
        .values({
          proofId: proofRow.id,
          sourceId: src.id,
          relationship: "SUPPORTS",
          fragment: "f",
          fetchedAt: sql`now()`,
          retrievedUrl: "https://example.com/fresh",
          contentHash: "sha256:x",
          freshnessClass: cls,
        })
        .returning();
      expect(row.freshnessClass).toBe(cls);
    }
    await ctx.db.delete(researchJobs).where(eq(researchJobs.id, jobRow.job.id));
    await ctx.db.delete(demoQuotaReservations).where(eq(demoQuotaReservations.userId, user.id));
  });
});

describe("Фаза 5 — lifecycle-код и VERIFIED-механизм (chunk B/C)", () => {
  it("11. observeMemoryCandidate + copyProvenanceFromEvidence + promoteToActive — полный путь прикладным кодом", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const admin = await makeUser();
    await ctx.db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));

    const user = await makeUser();
    const jobRow = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId,
      projectId: project.id,
      originalQuestion: "x",
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 3,
    });
    const [proofRow] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: jobRow.job.id,
        ownerUserId: user.id,
        projectId: project.id,
        topicId,
        verdict: "SUPPORTED",
        confidence: 90,
        layers: {},
        verificationStatus: "VERIFIED",
      })
      .returning();
    const [src] = await ctx.db
      .insert(sources)
      .values({ url: "https://example.com/e2e", urlHash: uniq("srch") })
      .returning();
    const [evidenceRow] = await ctx.db
      .insert(evidence)
      .values({
        proofId: proofRow.id,
        sourceId: src.id,
        relationship: "SUPPORTS",
        fragment: "governance record: buyback executed",
        fetchedAt: sql`now()`,
        retrievedUrl: "https://example.com/e2e#buyback",
        contentHash: "sha256:e2e",
        freshnessClass: "MEDIUM_CHANGE",
      })
      .returning();

    const { id: memoryId } = await observeMemoryCandidate(ctx.db, {
      projectId: project.id,
      topicId,
      patternStep: 3,
      claimKey: "allocation_mechanism",
      statement: "Buyback executed per governance record",
      freshnessClass: "MEDIUM_CHANGE",
      verifiedAt: new Date(),
      confidence: 90,
      originKind: "PROOF_TRACE",
    });
    const [observed] = await ctx.db
      .select()
      .from(researchMemory)
      .where(eq(researchMemory.id, memoryId));
    expect(observed.lifecycleState).toBe("OBSERVED");

    await copyProvenanceFromEvidence(ctx.db, memoryId, evidenceRow.id);
    const [prov] = await ctx.db
      .select()
      .from(researchMemoryProvenance)
      .where(eq(researchMemoryProvenance.memoryId, memoryId));
    expect(prov.originEvidenceId).toBe(evidenceRow.id);
    expect(prov.fragment).toBe("governance record: buyback executed");

    const promoted = await promoteToActive(ctx.db, memoryId, admin.id);
    expect(promoted.lifecycleState).toBe("ACTIVE");
    expect(promoted.promotedBy).toBe(admin.id);

    // Удаление исходного evidence/пользователя не трогает копию.
    await ctx.db.delete(users).where(eq(users.id, user.id));
    const [survivingProv] = await ctx.db
      .select()
      .from(researchMemoryProvenance)
      .where(eq(researchMemoryProvenance.memoryId, memoryId));
    expect(survivingProv).toBeTruthy();
    expect(survivingProv.originEvidenceId).toBe(evidenceRow.id); // след остался, строки уже нет
    const [survivedRow] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, evidenceRow.id));
    expect(survivedRow).toBeUndefined(); // исходный evidence действительно удалён каскадом
  });

  it("12. promoteToActive отклоняется для не-ADMIN пользователя", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const notAdmin = await makeUser();
    const { id: memoryId } = await observeMemoryCandidate(ctx.db, {
      projectId: project.id,
      topicId,
      patternStep: 6,
      claimKey: "token_destination",
      statement: "test",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 70,
      originKind: "TEST",
    });
    await expect(promoteToActive(ctx.db, memoryId, notAdmin.id)).rejects.toThrow(NotAdminError);
    const [row] = await ctx.db
      .select()
      .from(researchMemory)
      .where(eq(researchMemory.id, memoryId));
    expect(row.lifecycleState).toBe("OBSERVED"); // отказ ДО любой мутации состояния
  });

  it("13. markProofVerified: только ADMIN, и только контролируемым действием (D-055)", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const admin = await makeUser();
    await ctx.db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
    const notAdmin = await makeUser();
    const user = await makeUser();
    const jobRow = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId,
      projectId: project.id,
      originalQuestion: "x",
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 3,
    });
    const [proofRow] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: jobRow.job.id,
        ownerUserId: user.id,
        projectId: project.id,
        topicId,
        verdict: "SUPPORTED",
        confidence: 80,
        layers: {},
      })
      .returning();
    expect(proofRow.verificationStatus).toBe("DRAFT"); // никакого автопромоушена моделью

    await expect(markProofVerified(ctx.db, proofRow.id, notAdmin.id)).rejects.toThrow(
      NotAdminError,
    );
    const verified = await markProofVerified(ctx.db, proofRow.id, admin.id);
    expect(verified.verificationStatus).toBe("VERIFIED");
  });
});
