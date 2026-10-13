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
  TEST_DATABASE_URL,
  uniq,
  type TestContext,
} from "./phase1-setup";

// LOW-1 fix: derive maintenance/fixture DB URLs from TEST_DATABASE_URL
// (the same env-overridable source every other test uses) instead of a
// hardcoded localhost:5432 assumption — this test must work against
// whatever Postgres the rest of the suite is pointed at (CI runner,
// container, remote instance).
function fixtureDbUrl(dbName: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}
function maintenanceDbUrl(): string {
  return fixtureDbUrl("postgres");
}

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

  it("5. backfill: строки, созданные до 0009, переживают РЕАЛЬНУЮ миграцию 0009 и получают research_job_id (дореформенная фикстура)", async () => {
    // Настоящая дореформенная фикстура: отдельная БД мигрируется ТОЛЬКО
    // миграциями 0000-0008 (evidence ещё без research_job_id, proof_id
    // ещё NOT NULL) — ровно та форма таблицы, что была до Фазы 6. В неё
    // вставляется Evidence старой формы, а затем накатывается ПОЛНЫЙ
    // набор миграций через штатный migrator (drizzle-orm/node-postgres),
    // включая 0009 с его backfill-шагом — не воспроизведённый вручную
    // фрагмент SQL, а тот же путь, которым проходит настоящая продакшн-БД
    // (Phase 6 S0-S3 review fix package: "Do not hand-replay selected
    // migration SQL in place of testing the actual migration").
    const dbName = "atlas_test_evidence_backfill_fixture";
    const adminUrl = maintenanceDbUrl();
    const dbUrl = fixtureDbUrl(dbName);

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    // Копия только 0000-0008 (строго ДО Phase 6 Evidence-миграций 0009+)
    // — то же построение, что уже используется для проверки "миграция на
    // заполненной БД". Numeric-prefix cutoff (не строковый startsWith на
    // одно конкретное имя файла) — так это построение остаётся верным,
    // если позже добавится 0011, 0012, ... без необходимости трогать этот
    // тест снова.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const srcDir = path.resolve(__dirname, "../src/server/db/migrations");
    const preReformDir = path.resolve(__dirname, "../.tmp-pre-0009-migrations");
    const PRE_PHASE6_CUTOFF = 9; // 0009 is the first Phase 6 Evidence migration
    const migrationNumber = (fileOrTag: string): number =>
      Number.parseInt(fileOrTag.slice(0, 4), 10);
    fs.rmSync(preReformDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(preReformDir, "meta"), { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      if (file.endsWith(".sql") && migrationNumber(file) < PRE_PHASE6_CUTOFF) {
        fs.copyFileSync(path.join(srcDir, file), path.join(preReformDir, file));
      }
    }
    const journal = JSON.parse(
      fs.readFileSync(path.join(srcDir, "meta/_journal.json"), "utf-8"),
    );
    journal.entries = journal.entries.filter(
      (e: { tag: string }) => migrationNumber(e.tag) < PRE_PHASE6_CUTOFF,
    );
    fs.writeFileSync(
      path.join(preReformDir, "meta/_journal.json"),
      JSON.stringify(journal, null, 2),
    );
    for (const file of fs.readdirSync(path.join(srcDir, "meta"))) {
      if (file.endsWith("_snapshot.json") && migrationNumber(file) < PRE_PHASE6_CUTOFF) {
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
    // Реальная миграция: полный migrations-каталог (0000-0010, тот же
    // путь, что и продакшн-деплой), через штатный migrator drizzle-orm.
    // pattern_step/component/directness/source_class/officiality теперь
    // nullable (backward-compatible staged schema) именно для того, чтобы
    // эта строка — у которой честного значения для них структурно нет —
    // прошла миграцию, а не отказала. 0010 (R-2) добавляет
    // evidence_contract_version и обязано корректно забэкфиллить эту же
    // строку как version=1 (legacy), а не version=2.
    await migrate(drizzle(client1), { migrationsFolder: srcDir });

    // (5) Evidence переживает миграцию.
    const { rows } = await client1.query(
      `SELECT id, proof_id, research_job_id, pattern_step, component, directness,
              source_class, officiality, evidence_contract_version
         FROM evidence WHERE id = $1`,
      [preReformEvidenceId],
    );
    expect(rows.length).toBe(1);
    // (6) связь Evidence -> Proof пережила миграцию.
    expect(rows[0].proof_id).toBe(proofId);
    // (7) research_job_id детерминированно восстановлен через Evidence -> Proof -> Proof.research_job_id.
    expect(rows[0].research_job_id).toBe(researchJobId);
    // Новые Phase 6 поля, которых у дореформенной строки честно нет,
    // остаются NULL — не изобретённое значение, не отказ миграции.
    expect(rows[0].pattern_step).toBeNull();
    expect(rows[0].component).toBeNull();
    expect(rows[0].directness).toBeNull();
    expect(rows[0].source_class).toBeNull();
    expect(rows[0].officiality).toBeNull();
    // R-2: контракт-версия идентифицирует эту строку как legacy (1), не
    // как Phase 6-совместимую (2) — именно ЭТО отличие и допускает NULL
    // выше, не будучи дырой для новых строк.
    expect(rows[0].evidence_contract_version).toBe(1);

    // (8) D-088 ownership-инварианты после миграции: research_job_id
    // NOT NULL, составной FK evidence_proof_same_job_fk на месте.
    const notNullCheck = await client1.query(
      `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'evidence' AND column_name = 'research_job_id'`,
    );
    expect(notNullCheck.rows[0].is_nullable).toBe("NO");
    const fkCheck = await client1.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'evidence_proof_same_job_fk'`,
    );
    expect(fkCheck.rows.length).toBe(1);

    // Составной FK реально запрещает Evidence на Proof чужого job'а даже
    // для строки, прошедшей через миграцию 0009 (не только для строк,
    // вставленных напрямую через Drizzle в других тестах этого файла).
    const secondUserId = (
      await client1.query(`INSERT INTO users (role) VALUES ('USER') RETURNING id`)
    ).rows[0].id;
    const foreignJobId = (
      await client1.query(
        `INSERT INTO research_jobs (
            user_id, topic_id, project_id, original_question, normalized_task, normalized_task_hash,
            idempotency_key, entitlement_at_start, capability_at_start, budget_at_start, state
          ) VALUES ($1, $2, $3, 'q2', '{}'::jsonb, 'h2', 'i2', 'DEMO', 'TARGETED_REFRESH', '{}'::jsonb, 'QUEUED')
          RETURNING id`,
        [secondUserId, jobId, projectId],
      )
    ).rows[0].id;
    let fkViolation: unknown;
    try {
      // Version-2 defaults kick in here (not specified) — the five
      // classification fields must be supplied or the completeness CHECK
      // would reject this insert before the FK ever gets a chance to;
      // supplying them keeps this assertion isolated to the FK.
      await client1.query(
        `INSERT INTO evidence (proof_id, research_job_id, source_id, relationship, fragment, fetched_at, retrieved_url, content_hash,
                                pattern_step, component, directness, source_class, officiality)
           VALUES ($1, $2, $3, 'SUPPORTS', 'cross-job', now(), 'https://example.com/cross-job', 'sha256:cross-job',
                   1, 'SOURCE_OF_VALUE', 'DIRECT', 'OFFICIAL_DOCS', 'CONFIRMED')`,
        [proofId, foreignJobId, sourceId],
      );
    } catch (e) {
      fkViolation = e;
    }
    expect(pgError(fkViolation).code).toBe("23503");

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

// R-2 (Phase 6 S0-S3 final review): a compatibility discriminator
// (evidence_contract_version) separates legacy Phase 1-5 Evidence
// (version 1, nullable classification — see test 5 above) from Evidence
// written under the Phase 6 contract (version 2, classification
// structurally required). Test 5's migrated legacy row already proves
// the version-1 side of this; the tests below prove the version-2 side
// and that the boundary between them cannot be bypassed from application
// code, only from the migration's own one-time backfill.
describe("Фаза 6, S2/R-2 — новая Evidence обязана нести полную классификацию (evidence_contract_version)", () => {
  it("B1. полная классификация -> принимается, version по умолчанию = 2", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    const [row] = await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(jobId, sourceId), proofId: null })
      .returning();
    expect(row.evidenceContractVersion).toBe(2);
  });

  it("B2. NULL pattern_step в новой Evidence -> отклоняется (CHECK)", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        patternStep: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23514");
  });

  it("B3. NULL component в новой Evidence -> отклоняется (CHECK)", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        component: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23514");
  });

  it("B4. NULL directness в новой Evidence -> отклоняется (CHECK)", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        directness: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23514");
  });

  it("B5. NULL source_class в новой Evidence -> отклоняется (CHECK)", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        sourceClass: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23514");
  });

  it("B6. NULL officiality в новой Evidence -> отклоняется (CHECK)", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        officiality: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23514");
  });

  it("C1. попытка объявить НОВУЮ строку version=1 (обход обязательной классификации) -> отклоняется триггером", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        researchJobId: jobId,
        sourceId,
        proofId: null,
        evidenceContractVersion: 1, // <- попытка обхода: заявить себя legacy
        // Ни одного из пяти классификационных полей — именно то, что
        // version=1 «легитимно» разрешил бы, если бы триггер не стоял.
        relationship: "SUPPORTS",
        fragment: "attempted bypass",
        fetchedAt: sql`now()`,
        retrievedUrl: "https://example.com/bypass",
        contentHash: "sha256:bypass-attempt",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    // RAISE EXCEPTION в plpgsql без явного SQLSTATE -> 'P0001' (raise_exception).
    expect(pgError(error).code).toBe("P0001");
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.length).toBe(0); // ничего не вставилось
  });

  it("C2. попытка ПОНИЗИТЬ существующую version=2 строку до version=1 -> отклоняется триггером", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    const [row] = await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(jobId, sourceId), proofId: null })
      .returning();
    expect(row.evidenceContractVersion).toBe(2);

    let error: unknown;
    try {
      await ctx.db
        .update(evidence)
        .set({ evidenceContractVersion: 1 })
        .where(eq(evidence.id, row.id));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("P0001");

    const [after] = await ctx.db.select().from(evidence).where(eq(evidence.id, row.id));
    expect(after.evidenceContractVersion).toBe(2); // не изменилось
  });

  it("D. D-088 остаётся в силе для version=2 Evidence: JOB_ONLY и PROOF_BOUND(свой job) проходят, чужой job — нет", async () => {
    const own = await makeJobAndSource();
    const foreign = await makeJobAndSource();
    const [ownProof] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: own.jobId,
        ownerUserId: own.userId,
        projectId: own.projectId,
        topicId: own.topicId,
        verdict: "SUPPORTED",
        confidence: 80,
        layers: {},
      })
      .returning();
    const [jobOnly] = await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(own.jobId, own.sourceId), proofId: null })
      .returning();
    expect(jobOnly.researchJobId).toBe(own.jobId);
    const [proofBound] = await ctx.db
      .insert(evidence)
      .values({ ...baseEvidenceValues(own.jobId, own.sourceId), proofId: ownProof.id })
      .returning();
    expect(proofBound.proofId).toBe(ownProof.id);

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
        ...baseEvidenceValues(own.jobId, own.sourceId),
        proofId: foreignProof.id, // чужой job's Proof
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23503");
  });

  it("E. существующий CHECK pattern_step BETWEEN 1 AND 8 остаётся в силе для новой Evidence", async () => {
    const { jobId, sourceId } = await makeJobAndSource();
    let error: unknown;
    try {
      await ctx.db.insert(evidence).values({
        ...baseEvidenceValues(jobId, sourceId),
        proofId: null,
        patternStep: 99,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(pgError(error).code).toBe("23514");
  });
});
