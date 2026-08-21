import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import {
  demoQuotaReservations,
  evidence,
  memoryRetrievals,
  productConfig,
  projectMemoryItems,
  projects,
  proofs,
  researchJobs,
  researchMemory,
  researchMemoryProvenance,
  researchPatterns,
  researchPlans,
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
import { structuredMemoryRetrievalGateway } from "../src/server/memory/retrieval-gateway";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, demoEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

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

// D-065: промоушен в ACTIVE санкционирует ADMIN — и на уровне БД тоже.
async function makeAdmin() {
  const [u] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
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
        component: "MECHANISM_SPEC",
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
        component: "SOURCE_OF_VALUE",
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
        component: "FLOW_PATH",
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

  it("5. lifecycle: полный путь OBSERVED -> CANDIDATE -> ACTIVE с promoted_by-ADMIN проходит", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const admin = await makeAdmin();
    const [row] = await ctx.db
      .insert(researchMemory)
      .values({
        projectId: project.id,
        topicId,
        patternStep: 4,
        component: "EXECUTION_EVIDENCE",
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

  it("5a. D-065: прямой SQL-промоушен с обычным (не-ADMIN) пользователем в promoted_by отклоняется БД", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    const normalUser = await makeUser(); // role = USER
    const [row] = await ctx.db
      .insert(researchMemory)
      .values({
        projectId: project.id,
        topicId,
        patternStep: 4,
        component: "EXECUTION_EVIDENCE",
        claimKey: "actual_execution_d065",
        statement: "attacker tries to promote via direct SQL",
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

    // Ровно атака из ревью MEDIUM-5: promoted_by непустой, но актёр не ADMIN.
    // Раньше проходило — роль проверял только assertAdmin в приложении.
    let error: unknown;
    try {
      await ctx.db
        .update(researchMemory)
        .set({ lifecycleState: "ACTIVE", promotedBy: normalUser.id, promotedAt: sql`now()` })
        .where(eq(researchMemory.id, row.id));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).message).toMatch(/ADMIN/);
    const [after] = await ctx.db
      .select()
      .from(researchMemory)
      .where(eq(researchMemory.id, row.id));
    expect(after.lifecycleState).toBe("CANDIDATE"); // переход не произошёл
  });

  it("5b. D-060: пара (pattern_step, component), не принадлежащая активному Pattern, отклоняется при записи", async () => {
    const topicId = await activeTopicId();
    const project = await firstDemoProject();
    // Ровно атака из ревью MEDIUM-4, теперь на уровне компонента: попытка
    // записать компонент шага 1 в шаг 8 («Durability»).
    let error: unknown;
    try {
      await ctx.db.insert(researchMemory).values({
        projectId: project.id,
        topicId,
        patternStep: 8,
        component: "SOURCE_OF_VALUE",
        claimKey: "economic_source",
        statement: "wrong mapping attack",
        freshnessClass: "LOW_CHANGE",
        verifiedAt: sql`now()`,
        confidence: 90,
        originKind: "TEST",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).message).toMatch(/does not belong to pattern step/);

    // Неизвестный компонент отклоняется тоже.
    let error2: unknown;
    try {
      await ctx.db.insert(researchMemory).values({
        projectId: project.id,
        topicId,
        patternStep: 8,
        component: "MADE_UP_COMPONENT",
        claimKey: "durability",
        statement: "unknown component attack",
        freshnessClass: "LOW_CHANGE",
        verifiedAt: sql`now()`,
        confidence: 90,
        originKind: "TEST",
      });
    } catch (e) {
      error2 = e;
    }
    expect(error2).toBeDefined();
    expect(pgError(error2).message).toMatch(/does not belong to pattern step/);
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
    const admin = await makeAdmin();
    const [row] = await ctx.db
      .insert(researchMemory)
      .values({
        projectId: project.id,
        topicId,
        patternStep: 5,
        component: "CURRENT_STATE",
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
      component: "MECHANISM_SPEC",
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
      component: "DESTINATION",
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

async function activateMemory(
  ctx2: TestContext,
  input: Parameters<typeof observeMemoryCandidate>[1],
): Promise<string> {
  const [admin] = await ctx2.db.insert(users).values({ role: "ADMIN" }).returning();
  const { id } = await observeMemoryCandidate(ctx2.db, input);
  return (await promoteToActive(ctx2.db, id, admin.id)).id;
}

describe("Фаза 5 — MemoryRetrievalGateway: structured retrieval (chunk D)", () => {
  it("14. ontology-путь находит засеянное знание по (project, topic); чужой проект не находит", async () => {
    const topicId = await activeTopicId();
    const [projectA, projectB] = await ctx.db.select().from(projects).limit(2);
    const memId = await activateMemory(ctx, {
      projectId: projectA.id,
      topicId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      claimKey: "economic_source",
      statement: "Protocol charges a 0.3% swap fee as its economic source",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 95,
      originKind: "TEST",
    });

    const hitsA = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: projectA.id, topicId },
      { topKPerStep: 5 },
    );
    expect(hitsA.some((h) => h.memoryId === memId)).toBe(true);

    const hitsB = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: projectB.id, topicId },
      { topKPerStep: 5 },
    );
    expect(hitsB.some((h) => h.memoryId === memId)).toBe(false); // изоляция D-042
  });

  it("15. supplementary text recall (fts/trgm) находит по формулировке, ontology-фильтр (claimKeys) её не находит", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db.select().from(projects).limit(1);
    const memId = await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 7,
      component: "NET_EFFECT",
      claimKey: "net_token_effect",
      statement: "Half of protocol revenue is used to burn the token every epoch",
      freshnessClass: "MEDIUM_CHANGE",
      verifiedAt: new Date(),
      confidence: 88,
      originKind: "TEST",
    });

    // Узкий ontology-запрос по чужому claim_key не находит запись напрямую...
    const narrow = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: project.id, topicId, claimKeys: ["allocation_mechanism"] },
      { topKPerStep: 5 },
    );
    expect(narrow.some((h) => h.memoryId === memId)).toBe(false);

    // ...но находится по свободному тексту (иная формулировка того же claim, §3.2).
    const withText = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      {
        projectId: project.id,
        topicId,
        claimKeys: ["allocation_mechanism"],
        statementQuery: "does the project burn revenue into the token",
      },
      { topKPerStep: 5 },
    );
    const hit = withText.find((h) => h.memoryId === memId);
    expect(hit).toBeTruthy();
    expect(hit?.matchedVia).toBe("fts");
  });

  it("16. Top-K на шаг ограничивает выдачу (порог из конфига, не хардкод)", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db.select().from(projects).limit(1);
    for (let i = 0; i < 4; i += 1) {
      await activateMemory(ctx, {
        projectId: project.id,
        topicId,
        patternStep: 8,
        component: "DURABILITY_BASIS",
        claimKey: `durability_${i}`,
        statement: `Durability note ${i}`,
        freshnessClass: "LOW_CHANGE",
        verifiedAt: new Date(),
        confidence: 60 + i,
        originKind: "TEST",
      });
    }
    const hits = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: project.id, topicId, claimKeys: ["durability_0", "durability_1", "durability_2", "durability_3"] },
      { topKPerStep: 2 },
    );
    const step8 = hits.filter((h) => h.patternStep === 8);
    expect(step8.length).toBe(2);
    // Top-K оставляет наиболее уверенные записи.
    expect(step8.every((h) => h.confidence >= 62)).toBe(true);
  });

  it("16a. D-059: health='DEPRECATED' исключён из retrieval целиком, но запись сохраняется в хранилище", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("depr"), name: "Deprecated Health Project", status: "ACTIVE_CORE" })
      .returning();
    const memId = await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 7,
      component: "NET_EFFECT",
      claimKey: "net_token_effect",
      statement: "net effect claim later proven wrong",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 95,
      originKind: "TEST",
    });
    // health — не lifecycle-переход; прямое выставление допустимо.
    await ctx.db
      .update(researchMemory)
      .set({ health: "DEPRECATED" })
      .where(eq(researchMemory.id, memId));

    const hits = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: project.id, topicId },
      { topKPerStep: 5 },
    );
    expect(hits.some((h) => h.memoryId === memId)).toBe(false); // исключён из retrieval

    const [stored] = await ctx.db
      .select()
      .from(researchMemory)
      .where(eq(researchMemory.id, memId));
    expect(stored).toBeTruthy(); // история сохранена, не удалена
    expect(stored.health).toBe("DEPRECATED");
    expect(stored.lifecycleState).toBe("ACTIVE");
  });

  it("16b. D-059: QUESTIONABLE/REVERIFY/STALE извлекаются (направляют перепроверку) и несут health в hit", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("health"), name: "Health Project", status: "ACTIVE_CORE" })
      .returning();
    const memId = await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 2,
      component: "FLOW_PATH",
      claimKey: "revenue_waterfall",
      statement: "flow path, questionable now",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 95,
      originKind: "TEST",
    });
    await ctx.db
      .update(researchMemory)
      .set({ health: "QUESTIONABLE" })
      .where(eq(researchMemory.id, memId));

    const hits = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: project.id, topicId },
      { topKPerStep: 5 },
    );
    const hit = hits.find((h) => h.memoryId === memId);
    expect(hit).toBeTruthy();
    expect(hit?.health).toBe("QUESTIONABLE");
  });

  it("16c. MEDIUM-1: stale_after '36 hours' и '3 months' читаются целиком, а не усекаются в 0 дней", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("interval"), name: "Interval Project", status: "ACTIVE_CORE" })
      .returning();
    const hoursId = await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 5,
      component: "CURRENT_STATE",
      claimKey: "current_status_36h",
      statement: "policy of 36 hours",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      staleAfter: { hours: 36 },
      confidence: 95,
      originKind: "TEST",
    });
    const monthsId = await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 8,
      component: "DURABILITY_BASIS",
      claimKey: "durability_3mo",
      statement: "policy of 3 months",
      freshnessClass: "HIGH_CHANGE",
      verifiedAt: new Date(),
      staleAfter: { months: 3 },
      confidence: 95,
      originKind: "TEST",
    });

    const hits = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: project.id, topicId },
      { topKPerStep: 5 },
    );
    const hours = hits.find((h) => h.memoryId === hoursId);
    const months = hits.find((h) => h.memoryId === monthsId);
    // Прежний код давал 0 для обоих ('36 hours' -> 0 дней, '3 months' -> 0
    // дней), делая записи вечно просроченными.
    expect(hours?.staleAfterSeconds).toBe(36 * 60 * 60);
    expect(months?.staleAfterSeconds).toBe(90 * 24 * 60 * 60); // Postgres: месяц = 30 дней
  });

  it("16d. L-1 (D-052): порядок и состав retrieval детерминированы при равной уверенности", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("determ"), name: "Determinism Project", status: "ACTIVE_CORE" })
      .returning();
    // Четыре записи одного шага с РАВНОЙ уверенностью — прежний ORDER BY
    // без tiebreaker'а позволял составу Top-K меняться между прогонами.
    for (let i = 0; i < 4; i += 1) {
      await activateMemory(ctx, {
        projectId: project.id,
        topicId,
        patternStep: 8,
        component: "DURABILITY_BASIS",
        claimKey: `durability_eq_${i}`,
        statement: `Equal-confidence durability note ${i}`,
        freshnessClass: "LOW_CHANGE",
        verifiedAt: new Date(),
        confidence: 80,
        originKind: "TEST",
      });
    }
    const run1 = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: project.id, topicId },
      { topKPerStep: 2 },
    );
    const run2 = await structuredMemoryRetrievalGateway.retrieve(
      ctx.db,
      { projectId: project.id, topicId },
      { topKPerStep: 2 },
    );
    expect(run1.map((h) => h.memoryId)).toEqual(run2.map((h) => h.memoryId));
    // Tiebreaker — id по возрастанию: состав воспроизводим, не «какие успели».
    const ids = run1.filter((h) => h.patternStep === 8).map((h) => h.memoryId);
    expect(ids).toEqual([...ids].sort());
  });
});

async function setMemoryConfig(ctx2: TestContext, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    await ctx2.db
      .insert(productConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: productConfig.key, set: { value } });
  }
}

async function makeJob(
  ctx2: TestContext,
  opts: { projectId: string; topicId: string; entitlement: ReturnType<typeof coreEntitlement> },
) {
  const user = await ctx2.db.insert(users).values({}).returning().then((r) => r[0]);
  return createResearchJob(ctx2.db, ctx2.boss, {
    userId: user.id,
    topicId: opts.topicId,
    projectId: opts.projectId,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "value capture investigation" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: opts.entitlement,
    demoLifetimeProofLimit: 3,
  });
}

describe("Фаза 5 — планировщик поверх job'ов: runMemoryPlanningStage (chunk F/G)", () => {
  it("17. память меняет план: тот же вопрос с памятью и без неё даёт структурно разные контракты", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("proj17"), name: "Test Project 17", status: "ACTIVE_CORE" })
      .returning();
    await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      claimKey: "economic_source",
      statement: "0.3% swap fee is the economic source",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 95,
      originKind: "TEST",
    });
    // Шаг 3 многокомпонентен (D-060) — закрывается только покрытием ОБОИХ
    // компонентов: механизм описан И санкционирован.
    await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 3,
      component: "MECHANISM_SPEC",
      claimKey: "allocation_mechanism",
      statement: "governance-approved buyback mechanism",
      freshnessClass: "MEDIUM_CHANGE",
      verifiedAt: new Date(),
      confidence: 92,
      originKind: "TEST",
    });
    await activateMemory(ctx, {
      projectId: project.id,
      topicId,
      patternStep: 3,
      component: "GOVERNANCE_BASIS",
      claimKey: "allocation_governance",
      statement: "buyback sanctioned by governance vote #42",
      freshnessClass: "MEDIUM_CHANGE",
      verifiedAt: new Date(),
      confidence: 91,
      originKind: "TEST",
    });

    await setMemoryConfig(ctx, { memory_enabled: true });
    const jobOn = await makeJob(ctx, { projectId: project.id, topicId, entitlement: coreEntitlement() });
    const withMemory = await runMemoryPlanningStage(ctx.db, jobOn.job.id);

    await setMemoryConfig(ctx, { memory_enabled: false });
    const jobOff = await makeJob(ctx, { projectId: project.id, topicId, entitlement: coreEntitlement() });
    const withoutMemory = await runMemoryPlanningStage(ctx.db, jobOff.job.id);
    await setMemoryConfig(ctx, { memory_enabled: true }); // восстановить для следующих тестов

    const [planOn] = await ctx.db.select().from(researchPlans).where(eq(researchPlans.id, withMemory.planId));
    const [planOff] = await ctx.db.select().from(researchPlans).where(eq(researchPlans.id, withoutMemory.planId));
    const contractOn = planOn.contract as { alreadySatisfiedSteps: number[]; missingSteps: number[] };
    const contractOff = planOff.contract as { alreadySatisfiedSteps: number[]; missingSteps: number[] };

    // Структурно разные, поимённо — не просто "разный текст".
    expect(contractOn.alreadySatisfiedSteps.sort()).toEqual([1, 3]);
    expect(contractOff.alreadySatisfiedSteps).toEqual([]);
    expect(contractOff.missingSteps.length).toBe(8);
    // D-058: остальные шаги подлинно MISSING -> режим FRESH_RESEARCH
    // (тип оставшейся работы); закрытые шаги при этом остаются закрытыми
    // в контракте — объём работы описывает контракт, не режим.
    expect(planOn.mode).toBe("FRESH_RESEARCH");
    expect(planOff.mode).toBe("FRESH_RESEARCH");
    expect(withMemory.memoryUsed).toBe(true);
    expect(withoutMemory.memoryUsed).toBe(false);
    expect(withMemory.memoryStatus).toBe("USED");
    expect(withoutMemory.memoryStatus).toBe("NOT_USED");

    // memory_retrievals — сырьё для оценки OFF/ON, привязано к правильному плану.
    const [retrievalOn] = await ctx.db
      .select()
      .from(memoryRetrievals)
      .where(eq(memoryRetrievals.researchJobId, jobOn.job.id));
    expect(retrievalOn.planId).toBe(withMemory.planId);
    expect(retrievalOn.retrievedCount).toBeGreaterThanOrEqual(2);
  });

  it("18. capability ceiling: DEMO не может получить FRESH_RESEARCH даже если план решил бы иначе", async () => {
    const topicId = await activeTopicId();
    const [freshProject] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("proj18"), name: "Test Project 18", status: "ACTIVE_CORE" })
      .returning();
    await setMemoryConfig(ctx, { memory_enabled: true });
    // Ничего не засеяно для этого проекта -> desiredMode был бы FRESH_RESEARCH.
    const job = await makeJob(ctx, {
      projectId: freshProject.id,
      topicId,
      entitlement: demoEntitlement(), // capability = demo_max_capability = TARGETED_REFRESH
    });
    const result = await runMemoryPlanningStage(ctx.db, job.job.id);
    expect(result.mode).toBe("TARGETED_REFRESH");

    const [plan] = await ctx.db.select().from(researchPlans).where(eq(researchPlans.id, result.planId));
    expect(plan.mode).toBe("TARGETED_REFRESH");
    const contract = plan.contract as { stopConditions: string[] };
    expect(contract.stopConditions.some((s) => s.includes("capability ceiling"))).toBe(true);
  });

  it("19. memory_status доезжает до job и отражает реальность (USED_AND_REVERIFIED при просроченном факте)", async () => {
    const topicId = await activeTopicId();
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("proj19"), name: "Test Project 19", status: "ACTIVE_CORE" })
      .returning();
    const staleMemId = (
      await ctx.db
        .insert(researchMemory)
        .values({
          projectId: project.id,
          topicId,
          patternStep: 5,
          component: "CURRENT_STATE",
          claimKey: "current_status_reverify_test",
          statement: "status checked long ago",
          freshnessClass: "HIGH_CHANGE",
          verifiedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // старше HIGH_CHANGE default (3d)
          confidence: 90,
          originKind: "TEST",
        })
        .returning()
    )[0].id;
    const admin = await ctx.db.insert(users).values({ role: "ADMIN" }).returning().then((r) => r[0]);
    await promoteToActive(ctx.db, staleMemId, admin.id);

    await setMemoryConfig(ctx, { memory_enabled: true });
    const job = await makeJob(ctx, { projectId: project.id, topicId, entitlement: coreEntitlement() });
    const result = await runMemoryPlanningStage(ctx.db, job.job.id);
    expect(result.memoryStatus).toBe("USED_AND_REVERIFIED");

    const [jobRow] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, job.job.id));
    expect(jobRow.memoryStatus).toBe("USED_AND_REVERIFIED");
    expect(jobRow.progressStage).toBe(2);
  });
});
