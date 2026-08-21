import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projects,
  proofs,
  researchJobs,
  researchMemory,
  researchMemoryProvenance,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import {
  createResearchJob,
  transitionJobState,
} from "../src/server/jobs/research-jobs";
import {
  observeMemoryCandidate,
  promoteToActive,
} from "../src/server/memory/lifecycle";
import {
  coreEntitlement,
  setupTestDatabase,
  uniq,
  type TestContext,
} from "./phase1-setup";

// Phase 6, S2 — Evidence ownership tests (D-088, phase-6-plan.md §6.3a).
// These are the eight tests the plan requires BEFORE any engine code
// relies on the new evidence.research_job_id / evidence.proof_id shape.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

function pgError(e: unknown): { code?: string; message?: string } {
  const err = e as { code?: string; message?: string; cause?: unknown };
  if (err?.code) return err;
  return (err?.cause as { code?: string; message?: string } | undefined) ?? {};
}

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db
    .select()
    .from(topics)
    .where(eq(topics.isActive, true));
  return t.id;
}

async function makeJobAndSource(): Promise<{
  jobId: string;
  sourceId: string;
  projectId: string;
  topicId: string;
  userId: string;
}> {
  const topicId = await activeTopicId();
  const [project] = await ctx.db
    .insert(projects)
    .values({
      slug: uniq("p6ev"),
      name: "Evidence ownership test",
      status: "ACTIVE_CORE",
    })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId,
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: {
      project_slug: project.slug,
      project_slugs: [project.slug],
      task: "x",
    },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  const [source] = await ctx.db
    .insert(sources)
    .values({
      url: `https://example.com/${uniq("doc")}`,
      urlHash: uniq("urlhash"),
    })
    .returning();
  return {
    jobId: job.id,
    sourceId: source.id,
    projectId: project.id,
    topicId,
    userId: user.id,
  };
}

function baseEvidenceValues(jobId: string, sourceId: string) {
  return {
    researchJobId: jobId,
    sourceId,
    patternStep: 1 as const,
    component: "SOURCE_OF_VALUE",
    directness: "DIRECT" as const,
    sourceClass: "OFFICIAL_DOCS" as const,
    officiality: "CONFIRMED" as const,
    relationship: "SUPPORTS" as const,
    fragment: "protocol fee accrues to the treasury",
    fetchedAt: sql`now()`,
    retrievedUrl: "https://example.com/doc#fee",
    contentHash: "sha256:ownership-test",
  };
}

describe("Фаза 6, S2 — владение Evidence (D-088, §6.3a)", () => {
  it("1. JOB_ONLY: вставка с proof_id IS NULL и валидным job — проходит", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    const [row] = await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(jobId, sourceId), proofId: null })
      .returning();
    expect(row.researchJobId).toBe(jobId);
    expect(row.proofId).toBeNull();
  });

  it("2. PROOF_BOUND: привязка к Proof своего job'а — проходит", async () => {
    const { jobId, sourceId, projectId, topicId, userId } =
      await makeJobAndSource();
    const [proof] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: jobId,
        ownerUserId: userId,
        projectId,
        topicId,
        verdict: "SUPPORTED",
        confidence: 80,
        layers: {},
      })
      .returning();
    const [row] = await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(jobId, sourceId), proofId: proof.id })
      .returning();
    expect(row.proofId).toBe(proof.id);
    expect(row.researchJobId).toBe(jobId);
  });

  it("3. привязка к Proof ЧУЖОГО job'а отклоняется БД (составной FK)", async () => {
    const own = await makeJobAndSource();
    const foreign = await makeJobAndSource();
    const [foreignProof] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: foreign.jobId,
        ownerUserId: foreign.userId,
        projectId: foreign.projectId,
        topicId: foreign.topicId,
        verdict: "SUPPORTED",
        confidence: 80,
        layers: {},
      })
      .returning();

    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(own.jobId, own.sourceId), // own job...
        proofId: foreignProof.id, // ...but a foreign job's Proof
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23503"); // foreign_key_violation
  });

  it("4. вставка без research_job_id отклоняется БД", async () => {
    const { sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        sourceId,
        patternStep: 1,
        component: "SOURCE_OF_VALUE",
        directness: "DIRECT",
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        relationship: "SUPPORTS",
        fragment: "x",
        fetchedAt: sql`now()`,
        retrievedUrl: "https://example.com/no-job",
        contentHash: "sha256:no-job",
        // researchJobId omitted — must be rejected, ORPHAN must be impossible
      } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23502"); // not_null_violation
  });

  it("5. backfill: строки, созданные до 0009, сохраняют свой Proof и получают его research_job_id (дореформенная фикстура)", async () => {
    // Настоящая дореформенная фикстура: отдельная БД мигрируется ТОЛЬКО
    // миграциями 0000-0008 (evidence ещё без research_job_id, proof_id
    // ещё NOT NULL) — ровно та форма таблицы, что была до Фазы 6. В неё
    // вставляется Evidence старой формы, а затем накатывается ПОЛНЫЙ
    // набор миграций, включая 0009 с его backfill-шагом.
    const dbName = "atlas_test_evidence_backfill_fixture";
    const adminUrl = "postgres://atlas:atlas@localhost:5432/postgres";
    const dbUrl = `postgres://atlas:atlas@localhost:5432/${dbName}`;

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    // Копия только 0000-0008 (без 0009) — то же построение, что уже
    // используется для проверки "миграция на заполненной БД".
    const fs = await import("node:fs");
    const path = await import("node:path");
    const srcDir = path.resolve(__dirname, "../src/server/db/migrations");
    const preReformDir = path.resolve(__dirname, "../.tmp-pre-0009-migrations");
    fs.rmSync(preReformDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(preReformDir, "meta"), { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      if (file.endsWith(".sql") && !file.startsWith("0009")) {
        fs.copyFileSync(path.join(srcDir, file), path.join(preReformDir, file));
      }
    }
    const journal = JSON.parse(
      fs.readFileSync(path.join(srcDir, "meta/_journal.json"), "utf-8"),
    );
    journal.entries = journal.entries.filter(
      (e: { tag: string }) => !e.tag.startsWith("0009"),
    );
    fs.writeFileSync(
      path.join(preReformDir, "meta/_journal.json"),
      JSON.stringify(journal, null, 2),
    );
    for (const file of fs.readdirSync(path.join(srcDir, "meta"))) {
      if (file.endsWith("_snapshot.json") && !file.startsWith("0009")) {
        fs.copyFileSync(
          path.join(srcDir, "meta", file),
          path.join(preReformDir, "meta", file),
        );
      }
    }

    const client1 = new Client({ connectionString: dbUrl });
    await client1.connect();
    await migrate(drizzle(client1), { migrationsFolder: preReformDir });

    // Дореформенная вставка: proof_id NOT NULL, никакого research_job_id.
    const jobId = (
      await client1.query(
        `INSERT INTO topics (slug, name, is_active) VALUES ('t_backfill', 'T', true) RETURNING id`,
      )
    ).rows[0].id;
    const userId = (
      await client1.query(
        `INSERT INTO users (role) VALUES ('USER') RETURNING id`,
      )
    ).rows[0].id;
    const projectId = (
      await client1.query(
        `INSERT INTO projects (slug, name, status) VALUES ('backfill_proj', 'P', 'ACTIVE_CORE') RETURNING id`,
      )
    ).rows[0].id;
    const researchJobId = (
      await client1.query(
        `INSERT INTO research_jobs (
            user_id, topic_id, project_id, original_question, normalized_task, normalized_task_hash,
            idempotency_key, entitlement_at_start, capability_at_start, budget_at_start, state
          ) VALUES ($1, $2, $3, 'q', '{}'::jsonb, 'h1', 'i1', 'DEMO', 'TARGETED_REFRESH', '{}'::jsonb, 'QUEUED')
          RETURNING id`,
        [userId, jobId, projectId],
      )
    ).rows[0].id;
    const proofId = (
      await client1.query(
        `INSERT INTO proofs (research_job_id, owner_user_id, project_id, topic_id, verdict, confidence, layers)
           VALUES ($1, $2, $3, $4, 'SUPPORTED', 80, '{}'::jsonb) RETURNING id`,
        [researchJobId, userId, projectId, jobId],
      )
    ).rows[0].id;
    const sourceId = (
      await client1.query(
        `INSERT INTO sources (url, url_hash) VALUES ('https://example.com/pre-reform', 'urlhash_backfill') RETURNING id`,
      )
    ).rows[0].id;
    const preReformEvidenceId = (
      await client1.query(
        `INSERT INTO evidence (proof_id, source_id, relationship, fragment, fetched_at, retrieved_url, content_hash)
           VALUES ($1, $2, 'SUPPORTS', 'pre-reform fragment', now(), 'https://example.com/pre-reform#f', 'sha256:pre-reform')
           RETURNING id`,
        [proofId, sourceId],
      )
    ).rows[0].id;
    // Именно шаги backfill'а 0009 — не файл целиком: остальные NOT NULL
    // колонки §6.2 (pattern_step, component, ...) у ЭТОЙ строки в
    // принципе не могут иметь честного значения (их источника не
    // существовало до Фазы 6) и корректно отказали бы, если бы миграция
    // применялась к БД, где такая — реально никогда не возникающая —
    // строка есть (phase-6-plan.md §0.2: evidence не пишется ни одной
    // production-функцией до Фазы 6). Тест изолирует ИМЕННО backfill
    // research_job_id (D-088), который безопасен и без этого допущения.
    await client1.query(
      `ALTER TABLE evidence DROP CONSTRAINT evidence_proof_id_proofs_id_fk`,
    );
    await client1.query(
      `ALTER TABLE evidence ALTER COLUMN proof_id DROP NOT NULL`,
    );
    await client1.query(`ALTER TABLE evidence ADD COLUMN research_job_id uuid`);
    await client1.query(
      `UPDATE evidence e SET research_job_id = p.research_job_id FROM proofs p WHERE p.id = e.proof_id`,
    );
    await client1.query(
      `ALTER TABLE evidence ALTER COLUMN research_job_id SET NOT NULL`,
    );

    const { rows } = await client1.query(
      `SELECT proof_id, research_job_id FROM evidence WHERE id = $1`,
      [preReformEvidenceId],
    );
    expect(rows[0].proof_id).toBe(proofId);
    expect(rows[0].research_job_id).toBe(researchJobId); // корректно заполнено backfill'ом

    await client1.end();
    const admin2 = new Client({ connectionString: adminUrl });
    await admin2.connect();
    await admin2.query(`DROP DATABASE ${dbName}`);
    await admin2.end();
    fs.rmSync(preReformDir, { recursive: true, force: true });
  }, 30_000);

  it("6. удаление Proof уносит его Evidence; JOB_ONLY-строки того же job'а остаются", async () => {
    const { jobId, sourceId, projectId, topicId, userId } =
      await makeJobAndSource();
    const [proof] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: jobId,
        ownerUserId: userId,
        projectId,
        topicId,
        verdict: "SUPPORTED",
        confidence: 80,
        layers: {},
      })
      .returning();
    const [bound] = await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(jobId, sourceId), proofId: proof.id })
      .returning();
    const [jobOnly] = await ctx.db
      .insert(evidence)
      .values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        claimKey: "job_only_survivor",
      })
      .returning();

    await ctx.db.delete(proofs).where(eq(proofs.id, proof.id));

    const remaining = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.researchJobId, jobId));
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(bound.id); // унесено каскадом с Proof
    expect(remainingIds).toContain(jobOnly.id); // JOB_ONLY пережило удаление Proof
  });

  it("7. удаление аккаунта: job и Evidence уходят каскадом, research_memory и его provenance живы (расширение D-048)", async () => {
    const { jobId, sourceId, projectId, topicId, userId } =
      await makeJobAndSource();
    await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(jobId, sourceId), proofId: null })
      .returning();

    const [admin] = await ctx.db
      .insert(users)
      .values({ role: "ADMIN" })
      .returning();
    const { id: memoryId } = await observeMemoryCandidate(ctx.db, {
      projectId,
      topicId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      claimKey: "d048_ext",
      statement: "system memory survives account deletion",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 90,
      originKind: "TEST",
    });
    await promoteToActive(ctx.db, memoryId, admin.id);
    const [source2] = await ctx.db
      .insert(sources)
      .values({
        url: `https://example.com/${uniq("prov")}`,
        urlHash: uniq("provhash"),
      })
      .returning();
    await ctx.db.insert(researchMemoryProvenance).values({
      memoryId,
      sourceId: source2.id,
      retrievedUrl: "https://example.com/prov",
      contentHash: "sha256:prov",
      fetchedAt: new Date(),
    });

    await ctx.db.delete(users).where(eq(users.id, userId));

    const jobsAfter = await ctx.db
      .select()
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    const evidenceAfter = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.researchJobId, jobId));
    expect(jobsAfter.length).toBe(0); // job уходит с пользователем
    expect(evidenceAfter.length).toBe(0); // Evidence этого job'а уходит каскадом

    const memAfter = await ctx.db
      .select()
      .from(researchMemory)
      .where(eq(researchMemory.id, memoryId));
    const provAfter = await ctx.db
      .select()
      .from(researchMemoryProvenance)
      .where(eq(researchMemoryProvenance.memoryId, memoryId));
    expect(memAfter.length).toBe(1); // системная память не привязана к пользователю
    expect(provAfter.length).toBe(1); // provenance — копия, не ссылка (D-048)
  });

  it("8. job завершился без Proof (BUDGET_LIMIT_REACHED): собранное Evidence остаётся читаемым, не теряется", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    const [row] = await ctx.db
      .insert(evidence)
      .values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        claimKey: "budget_limit_survivor",
      })
      .returning();

    // Граф переходов (0001_state_machine.sql) требует QUEUED -> RUNNING
    // прежде RUNNING -> BUDGET_LIMIT_REACHED; прямой QUEUED -> терминал
    // запрещён БД так же строго, как и любой другой недопустимый переход.
    await transitionJobState(ctx.db, jobId, "RUNNING", "test setup");
    await transitionJobState(
      ctx.db,
      jobId,
      "BUDGET_LIMIT_REACHED",
      "budget exhausted before any Proof",
    );

    const [after] = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, row.id));
    expect(after).toBeTruthy();
    expect(after.proofId).toBeNull();
    expect(after.researchJobId).toBe(jobId);
  });

  it("9. ORPHAN структурно невозможен: ни NULL research_job_id, ни отсутствующий job не проходят", async () => {
    // Уже покрыто тестом 4 (NULL research_job_id) и существующей FK-защитой
    // (несуществующий research_job_id — foreign_key_violation); здесь —
    // явная проверка второго случая для полноты требования §6.3a.
    const { sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues("00000000-0000-0000-0000-000000000000", sourceId),
        proofId: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23503");
  });

  it("10. CHECK: пустой retrieved_url/content_hash отклоняется (D-076, не только NOT NULL)", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        retrievedUrl: "", // пустая строка — НЕ NULL, но и не provenance
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23514"); // check_violation
  });
});
