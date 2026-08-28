import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  demoQuotaReservations,
  evidence,
  productConfig,
  projects,
  proofs,
  researchJobs,
  researchJobTransitions,
  sources,
  subscriptions,
  topics,
  userIdentities,
  users,
} from "../src/server/db/schema";
import { seed } from "../src/server/db/seed";
import {
  ActiveJobExistsError,
  createResearchJob,
  DemoQuotaExceededError,
  resolveDemoReservation,
  transitionJobState,
} from "../src/server/jobs/research-jobs";
import {
  coreEntitlement,
  demoEntitlement,
  setupTestDatabase,
  uniq,
  type TestContext,
} from "./phase1-setup";

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

function jobInput(userId: string, topicId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    topicId,
    originalQuestion: "Does the token capture value?",
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: demoEntitlement(),
    demoLifetimeProofLimit: 3,
    ...overrides,
  };
}

// Полный жизненный цикл: job -> терминальное состояние + разрешение резервации,
// чтобы освободить слот «один активный job» для следующего теста.
async function finishJob(
  jobId: string,
  outcome: "SUCCEEDED" | "FAILED" | "CANCELLED",
  quota?: "CONSUMED" | "RELEASED",
) {
  await ctx.db.transaction(async (tx) => {
    const [job] = await tx.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    if (job.state === "QUEUED" && outcome !== "CANCELLED") {
      await transitionJobState(tx, jobId, "RUNNING");
    }
    await transitionJobState(tx, jobId, outcome);
    if (quota) {
      await resolveDemoReservation(tx, jobId, quota);
    }
  });
}

describe("Phase 1 DoD", () => {
  // DoD 1: миграции на чистой БД выполняет setup; здесь — идемпотентность сида.
  it("1. repeated seed does not duplicate data", async () => {
    const before = {
      topics: (await ctx.db.select().from(topics)).length,
      projects: (await ctx.db.select().from(projects)).length,
      config: (await ctx.db.select().from(productConfig)).length,
    };
    await seed(ctx.db);
    expect((await ctx.db.select().from(topics)).length).toBe(before.topics);
    expect((await ctx.db.select().from(projects)).length).toBe(before.projects);
    expect((await ctx.db.select().from(productConfig)).length).toBe(before.config);
    expect(before.projects).toBe(4);
  });

  it("2. duplicate (provider, provider_user_id) identity is rejected", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    await ctx.db
      .insert(userIdentities)
      .values({ userId: u1.id, provider: "TELEGRAM", providerUserId: "tg_1" });
    await expect(
      ctx.db
        .insert(userIdentities)
        .values({ userId: u2.id, provider: "TELEGRAM", providerUserId: "tg_1" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("3. same (user_id, idempotency_key) returns the same job", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const input = jobInput(user.id, topicId);
    const first = await createResearchJob(ctx.db, ctx.boss, input);
    const second = await createResearchJob(ctx.db, ctx.boss, {
      ...input,
      normalizedTaskHash: uniq("hash"),
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    await finishJob(first.job.id, "CANCELLED", "RELEASED");
  });

  it("4. duplicate active task conflicts; after terminal state a new one is allowed", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const hash = uniq("hash");
    const first = await createResearchJob(
      ctx.db,
      ctx.boss,
      jobInput(user.id, topicId, { normalizedTaskHash: hash }),
    );
    await expect(
      createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId, { normalizedTaskHash: hash })),
    ).rejects.toBeInstanceOf(ActiveJobExistsError);

    await finishJob(first.job.id, "CANCELLED", "RELEASED");
    const again = await createResearchJob(
      ctx.db,
      ctx.boss,
      jobInput(user.id, topicId, { normalizedTaskHash: hash }),
    );
    expect(again.created).toBe(true);
    await finishJob(again.job.id, "CANCELLED", "RELEASED");
  });

  it("5. admission counts RESERVED + CONSUMED; 4th start at limit 3 is rejected", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();

    // 2 CONSUMED + 1 висящий RESERVED = 3 занятых слота (CONSUMED всего 2!)
    for (let i = 0; i < 2; i++) {
      const r = await createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId));
      await finishJob(r.job.id, "SUCCEEDED", "CONSUMED");
    }
    const held = await createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId));

    // Четвёртый старт отклонён по квоте, хотя CONSUMED = 2 < 3.
    await expect(
      createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId)),
    ).rejects.toBeInstanceOf(DemoQuotaExceededError);

    // Конкурентная серия на свежем пользователе: инварианты держат гонку —
    // принято не больше, чем позволяют квота и «один активный job».
    const fresh = await makeUser();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        createResearchJob(ctx.db, ctx.boss, jobInput(fresh.id, topicId)),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBe(1); // один активный job на пользователя
    const [{ occupied }] = (
      await ctx.db.execute(sql`
        SELECT count(*)::int AS occupied FROM demo_quota_reservations
        WHERE user_id = ${fresh.id} AND state IN ('RESERVED','CONSUMED')
      `)
    ).rows as [{ occupied: number }];
    expect(occupied).toBeLessThanOrEqual(3);

    await finishJob(held.job.id, "CANCELLED", "RELEASED");
  });

  it("6. RELEASED frees the slot; CONSUMED can never be released", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();

    for (let i = 0; i < 3; i++) {
      const r = await createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId));
      await finishJob(r.job.id, i === 0 ? "FAILED" : "SUCCEEDED", i === 0 ? "RELEASED" : "CONSUMED");
    }
    // 2 CONSUMED + 1 RELEASED -> слот свободен, третий запуск проходит.
    const r4 = await createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId));
    expect(r4.created).toBe(true);
    await finishJob(r4.job.id, "SUCCEEDED", "CONSUMED");

    // Теперь 3 CONSUMED — лимит исчерпан навсегда.
    await expect(
      createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId)),
    ).rejects.toBeInstanceOf(DemoQuotaExceededError);

    // CONSUMED -> RELEASED запрещён триггером.
    await expect(
      ctx.db
        .update(demoQuotaReservations)
        .set({ state: "RELEASED" })
        .where(and(eq(demoQuotaReservations.userId, user.id), eq(demoQuotaReservations.state, "CONSUMED"))),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("7. second Proof for the same job is rejected", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const [project] = await ctx.db.select().from(projects).limit(1);
    const r = await createResearchJob(
      ctx.db,
      ctx.boss,
      jobInput(user.id, topicId, { entitlement: coreEntitlement() }),
    );
    const proofRow = {
      researchJobId: r.job.id,
      ownerUserId: user.id,
      projectId: project.id,
      topicId,
      verdict: "INSUFFICIENT_EVIDENCE" as const,
      confidence: 40,
      layers: { simple_answer: "test" },
    };
    await ctx.db.insert(proofs).values(proofRow);
    await expect(ctx.db.insert(proofs).values(proofRow)).rejects.toMatchObject({
      cause: { code: "23505", constraint: "uq_proofs_research_job" },
    });
    await finishJob(r.job.id, "CANCELLED");
  });

  it("8. deleting a user cascades user-owned data and keeps system knowledge", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const [project] = await ctx.db.select().from(projects).limit(1);
    await ctx.db
      .insert(userIdentities)
      .values({ userId: user.id, provider: "TELEGRAM", providerUserId: uniq("tg") });
    await ctx.db.insert(subscriptions).values({
      userId: user.id,
      status: "ACTIVE",
      validFrom: sql`now()`,
      validUntil: sql`now() + interval '30 days'`,
    });
    const r = await createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId));
    const [proofRow] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: r.job.id,
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
      .values({ url: "https://example.com/doc", urlHash: uniq("srch") })
      .returning();
    await ctx.db.insert(evidence).values({
      researchJobId: proofRow.researchJobId,
      proofId: proofRow.id,
      sourceId: src.id,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      directness: "DIRECT",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      relationship: "SUPPORTS",
      fragment: "original fragment",
      fetchedAt: sql`now()`,
      retrievedUrl: "https://example.com/doc#section",
      contentHash: "sha256:test",
    });

    const projectsBefore = (await ctx.db.select().from(projects)).length;
    await ctx.db.delete(users).where(eq(users.id, user.id));

    for (const [table, name] of [
      [userIdentities, "user_identities"],
      [subscriptions, "subscriptions"],
      [researchJobs, "research_jobs"],
      [demoQuotaReservations, "demo_quota_reservations"],
      [proofs, "proofs"],
      [evidence, "evidence"],
    ] as const) {
      const rows = await ctx.db.execute(
        sql`SELECT count(*)::int AS n FROM ${table}
            WHERE ${sql.raw(name === "proofs" ? "owner_user_id" : name === "evidence" ? "proof_id" : "user_id")}::text
                  = ${name === "evidence" ? proofRow.id : user.id}`,
      );
      expect((rows.rows[0] as { n: number }).n, name).toBe(0);
    }
    expect((await ctx.db.select().from(projects)).length).toBe(projectsBefore);
    expect((await ctx.db.select().from(sources).where(eq(sources.id, src.id))).length).toBe(1);
    expect((await ctx.db.select().from(topics)).length).toBeGreaterThan(0);
  });

  it("9. pg-boss enqueue is transactional: rollback leaves no task, commit exactly one", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const countTasks = async () =>
      ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'research'`))
        .rows[0] as { n: number }).n;

    const before = await countTasks();
    await expect(
      ctx.db.transaction(async (tx) => {
        const [job] = await tx
          .insert(researchJobs)
          .values({
            userId: user.id,
            topicId,
            originalQuestion: "q",
            normalizedTaskHash: uniq("hash"),
            idempotencyKey: uniq("idem"),
            entitlementAtStart: "ARI_CORE",
            capabilityAtStart: "FRESH_RESEARCH",
            budgetAtStart: coreEntitlement().budget,
          })
          .returning();
        const { enqueueResearchJobInTx } = await import("../src/server/jobs/queue");
        await enqueueResearchJobInTx(ctx.boss, tx, job.id);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(await countTasks()).toBe(before);

    const r = await createResearchJob(
      ctx.db,
      ctx.boss,
      jobInput(user.id, topicId, { entitlement: coreEntitlement() }),
    );
    expect(await countTasks()).toBe(before + 1);
    await finishJob(r.job.id, "CANCELLED");
  });

  it("10. only one active job per user, enforced by the database", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const results = await Promise.allSettled([
      createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId, { entitlement: coreEntitlement() })),
      createResearchJob(ctx.db, ctx.boss, jobInput(user.id, topicId, { entitlement: coreEntitlement() })),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(ActiveJobExistsError);

    const winner = (ok[0] as PromiseFulfilledResult<{ job: { id: string } }>).value.job.id;
    await finishJob(winner, "CANCELLED");
    const next = await createResearchJob(
      ctx.db,
      ctx.boss,
      jobInput(user.id, topicId, { entitlement: coreEntitlement() }),
    );
    expect(next.created).toBe(true);
    await finishJob(next.job.id, "CANCELLED");
  });

  it("11. forbidden state transitions raise; allowed chain logs exactly 2 rows", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const r = await createResearchJob(
      ctx.db,
      ctx.boss,
      jobInput(user.id, topicId, { entitlement: coreEntitlement() }),
    );

    await transitionJobState(ctx.db, r.job.id, "RUNNING");
    await transitionJobState(ctx.db, r.job.id, "SUCCEEDED");

    // SUCCEEDED -> RUNNING запрещён.
    await expect(transitionJobState(ctx.db, r.job.id, "RUNNING")).rejects.toMatchObject({
      cause: { code: "23514" },
    });
    // Терминальное -> QUEUED тоже (прямым UPDATE, мимо примитива).
    await expect(
      ctx.db.update(researchJobs).set({ state: "QUEUED" }).where(eq(researchJobs.id, r.job.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const log = await ctx.db
      .select()
      .from(researchJobTransitions)
      .where(eq(researchJobTransitions.jobId, r.job.id));
    expect(log.length).toBe(2);
    expect(log.map((l) => `${l.fromState}->${l.toState}`)).toEqual([
      "QUEUED->RUNNING",
      "RUNNING->SUCCEEDED",
    ]);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, r.job.id));
    expect(job.startedAt).not.toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect(job.unread).toBe(true);
  });

  it("12. transitions journal is append-only and auto-written by trigger", async () => {
    const user = await makeUser();
    const topicId = await activeTopicId();
    const r = await createResearchJob(
      ctx.db,
      ctx.boss,
      jobInput(user.id, topicId, { entitlement: coreEntitlement() }),
    );
    // Прямой UPDATE state мимо примитива всё равно журналируется триггером.
    await ctx.db.update(researchJobs).set({ state: "RUNNING" }).where(eq(researchJobs.id, r.job.id));
    const log = await ctx.db
      .select()
      .from(researchJobTransitions)
      .where(eq(researchJobTransitions.jobId, r.job.id));
    expect(log.length).toBe(1);

    await expect(
      ctx.db.update(researchJobTransitions).set({ note: "tamper" }).where(eq(researchJobTransitions.id, log[0].id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      ctx.db.delete(researchJobTransitions).where(eq(researchJobTransitions.id, log[0].id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await finishJob(r.job.id, "CANCELLED");
  });

  it("13. at most one entitling subscription per user; historical rows coexist", async () => {
    const user = await makeUser();
    const base = {
      userId: user.id,
      validFrom: sql`now()`,
      validUntil: sql`now() + interval '30 days'`,
    };
    await ctx.db.insert(subscriptions).values({ ...base, status: "EXPIRED" });
    await ctx.db.insert(subscriptions).values({ ...base, status: "ACTIVE" });
    // ACTIVE + EXPIRED сосуществуют; вторая entitling — нет.
    await expect(
      ctx.db.insert(subscriptions).values({ ...base, status: "CANCEL_AT_PERIOD_END" }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "uq_subscriptions_one_entitling" },
    });
    // После истечения entitling-строки новая ACTIVE допустима.
    await ctx.db
      .update(subscriptions)
      .set({ status: "EXPIRED" })
      .where(and(eq(subscriptions.userId, user.id), eq(subscriptions.status, "ACTIVE")));
    await ctx.db.insert(subscriptions).values({ ...base, status: "CANCEL_AT_PERIOD_END" });
    const rows = await ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
    expect(rows.length).toBe(3);
  });
});
