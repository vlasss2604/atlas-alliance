import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  evidence,
  evidenceDocumentaryLocators,
  projects,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import {
  admittedLocatorsForJob,
  persistFactLocators,
  validateFactLocators,
} from "../src/server/engine/documentary-locator-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// PROJECT-SCOPED DOCUMENTARY LOCATOR REUSE.
//
// Job-scoped locators were unusable in practice: EXECUTION_EVIDENCE is
// pattern step 4 and DESTINATION is step 6, so the component that needs a
// documented account runs two steps before the one that admits it. A fresh
// job reached the on-chain path with nothing to address.
//
// The fix is reuse across jobs for the SAME confirmed project — and the
// thing worth testing is not that reuse works but that it stays narrow:
// the project boundary, the validation bar and the source-authority bar
// all still hold, and anything unresolvable fails closed.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const ADDRESS = "Reuse1111111111111111111111111111111111111";
const OTHER_ADDRESS = "Reuse2222222222222222222222222222222222222";

async function makeProject(): Promise<string> {
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("reuse"), name: "Reuse Test Project", status: "ACTIVE_CORE" })
    .returning();
  return project.id;
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "does the mechanism actually run?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

interface FactOptions {
  sourceClass?: string;
  officiality?: string;
  sourceHealth?: "OK" | "UNKNOWN" | "BROKEN" | "CHANGED";
  component?: string;
  patternStep?: number;
}

async function admitFact(
  jobId: string,
  address: string,
  opts: FactOptions = {},
): Promise<{ evidenceId: string; sourceId: string }> {
  const [source] = await ctx.db
    .insert(sources)
    .values({
      url: `https://docs.example.test/${uniq("p")}`,
      urlHash: uniq("uh"),
      sourceType: "OFFICIAL_DOCS",
      health: opts.sourceHealth ?? "OK",
    })
    .returning();
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      sourceId: source.id,
      researchJobId: jobId,
      relationship: "SUPPORTS",
      fragment: `tokens are sent to ${address}`,
      summary: "documented account",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: new Date(),
      evidenceContractVersion: 2,
      patternStep: opts.patternStep ?? 6,
      component: opts.component ?? "DESTINATION",
      directness: "DIRECT",
      sourceClass: (opts.sourceClass ?? "OFFICIAL_DOCS") as "OFFICIAL_DOCS",
      officiality: (opts.officiality ?? "CONFIRMED") as "CONFIRMED",
    })
    .returning();
  await persistFactLocators(ctx.db, row.id, [{ value: address, shape: "ADDRESS_LIKE" }]);
  return { evidenceId: row.id, sourceId: source.id };
}

describe("locator reuse — the project is the boundary", () => {
  it("1. a NEW job for the same project sees a locator admitted by an earlier job", async () => {
    const projectId = await makeProject();
    const firstJob = await makeJob(projectId);
    await admitFact(firstJob, ADDRESS);

    const secondJob = await makeJob(projectId);
    const found = await admittedLocatorsForJob(ctx.db, secondJob);
    expect(found.map((f) => f.value)).toContain(ADDRESS);
  });

  it("2. a job for a DIFFERENT project never sees it (mutation check: project boundary)", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const jobA = await makeJob(projectA);
    await admitFact(jobA, ADDRESS);

    const jobB = await makeJob(projectB);
    const found = await admittedLocatorsForJob(ctx.db, jobB);
    expect(found.map((f) => f.value)).not.toContain(ADDRESS);
    // If the project_id predicate were removed, the address above would
    // appear here — this assertion is the whole guard.
    expect(found).toHaveLength(0);
  });

  it("identity is the project id, never a name or ticker", async () => {
    // Two projects with confusingly similar names remain separate.
    const [a] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("twin"), name: "Twin Project", status: "ACTIVE_CORE" })
      .returning();
    const [b] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("twin"), name: "Twin Project", status: "ACTIVE_CORE" })
      .returning();
    const jobA = await makeJob(a.id);
    await admitFact(jobA, ADDRESS);
    const jobB = await makeJob(b.id);
    expect(await admittedLocatorsForJob(ctx.db, jobB)).toHaveLength(0);
  });

  it("a job with no resolvable project fails closed rather than returning everything", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS);
    // A job id that does not exist has no project boundary to enforce.
    expect(await admittedLocatorsForJob(ctx.db, "00000000-0000-0000-0000-000000000000")).toEqual([]);
    expect(await admittedLocatorsForJob(ctx.db, "")).toEqual([]);
  });
});

describe("locator reuse — same project is not enough authority", () => {
  it("3. a REJECTED locator was never persisted and cannot be reused", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    // The validator refuses an address the document does not literally
    // contain; nothing reaches the table at all.
    const outcome = validateFactLocators({
      claimed: [ADDRESS],
      documentText: "this document names no account whatsoever",
    });
    expect(outcome.confirmed).toHaveLength(0);
    expect(outcome.rejected.length).toBeGreaterThan(0);

    const secondJob = await makeJob(projectId);
    expect(await admittedLocatorsForJob(ctx.db, secondJob)).toHaveLength(0);
    expect(jobId).toBeTruthy();
  });

  it("4. a TRUNCATED locator is unrepresentable and so unreusable", async () => {
    const truncated = ADDRESS.slice(0, 20);
    const outcome = validateFactLocators({
      claimed: [truncated],
      documentText: `tokens are sent to ${ADDRESS}`,
    });
    expect(outcome.confirmed).toHaveLength(0);

    // And the database refuses it even if a writer bypassed the validator.
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    const { evidenceId } = await admitFact(jobId, ADDRESS);
    await expect(
      ctx.db.insert(evidenceDocumentaryLocators).values({
        evidenceId,
        ordinal: 9,
        value: truncated,
        shape: "ADDRESS_LIKE",
        literallyPresent: true,
        validationResult: "CONFIRMED",
      }),
    ).rejects.toThrow();
  });

  it("5a. a CLAIMED (not CONFIRMED) source's address is not reusable", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS, { officiality: "CLAIMED" });
    const secondJob = await makeJob(projectId);
    expect(await admittedLocatorsForJob(ctx.db, secondJob)).toHaveLength(0);
  });

  it("5b. a non-documentary source class never hands over a subject", async () => {
    // SOCIAL never independently establishes anything, and that rule does
    // not stop applying because the thing it states is an address.
    for (const cls of ["SOCIAL", "RESEARCH_MEDIA", "DATA_PROVIDER"]) {
      const projectId = await makeProject();
      const jobId = await makeJob(projectId);
      await admitFact(jobId, ADDRESS, { sourceClass: cls });
      const secondJob = await makeJob(projectId);
      expect(
        await admittedLocatorsForJob(ctx.db, secondJob),
        `${cls} was reusable`,
      ).toHaveLength(0);
    }
  });

  it("5c. a BROKEN source is not reusable — provenance must still resolve", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS, { sourceHealth: "BROKEN" });
    const secondJob = await makeJob(projectId);
    expect(await admittedLocatorsForJob(ctx.db, secondJob)).toHaveLength(0);
  });

  it("GOVERNANCE and OFFICIAL_REPORT are documentary and remain reusable", async () => {
    for (const cls of ["GOVERNANCE", "OFFICIAL_REPORT"]) {
      const projectId = await makeProject();
      const jobId = await makeJob(projectId);
      await admitFact(jobId, ADDRESS, { sourceClass: cls });
      const secondJob = await makeJob(projectId);
      expect(
        (await admittedLocatorsForJob(ctx.db, secondJob)).map((l) => l.value),
        `${cls} was not reusable`,
      ).toContain(ADDRESS);
    }
  });
});

describe("locator reuse — nothing is copied or rewritten", () => {
  it("6. the historical Evidence row is untouched by reuse", async () => {
    const projectId = await makeProject();
    const firstJob = await makeJob(projectId);
    const { evidenceId } = await admitFact(firstJob, ADDRESS);
    const [before] = await ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));

    const secondJob = await makeJob(projectId);
    await admittedLocatorsForJob(ctx.db, secondJob);

    const [after] = await ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));
    expect(after).toEqual(before);
    // No Evidence row was created for the second job.
    const forSecond = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.researchJobId, secondJob));
    expect(forSecond).toHaveLength(0);
    // And no locator row was duplicated.
    const locatorRows = await ctx.db
      .select()
      .from(evidenceDocumentaryLocators)
      .where(eq(evidenceDocumentaryLocators.evidenceId, evidenceId));
    expect(locatorRows).toHaveLength(1);
    // The reused subject is still traceable to the original document.
    expect(after.retrievedUrl).toBe(before.retrievedUrl);
  });
});

describe("locator reuse — the ordering blocker is gone", () => {
  it("7. a job needs no DESTINATION step of its own to have a subject", async () => {
    const projectId = await makeProject();
    const firstJob = await makeJob(projectId);
    // Admitted at step 6 / DESTINATION, exactly as the real pattern does.
    await admitFact(firstJob, ADDRESS, { patternStep: 6, component: "DESTINATION" });

    const secondJob = await makeJob(projectId);
    const forNewJob = await admittedLocatorsForJob(ctx.db, secondJob);
    expect(forNewJob.map((l) => l.value)).toContain(ADDRESS);
    // The new job has admitted nothing at all yet.
    expect(
      await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, secondJob)),
    ).toHaveLength(0);
  });

  it("8. EXECUTION_EVIDENCE at step 4 receives a locator admitted at step 6 elsewhere", async () => {
    const projectId = await makeProject();
    const firstJob = await makeJob(projectId);
    await admitFact(firstJob, ADDRESS, { patternStep: 6, component: "DESTINATION" });
    await admitFact(firstJob, OTHER_ADDRESS, { patternStep: 6, component: "DESTINATION" });

    // The lookup is component-agnostic: step 4 asks the same question and
    // gets the same answer, which is what makes the chain reachable.
    const secondJob = await makeJob(projectId);
    const values = (await admittedLocatorsForJob(ctx.db, secondJob)).map((l) => l.value);
    expect(values).toContain(ADDRESS);
    expect(values).toContain(OTHER_ADDRESS);
  });

  it("results are deterministic and deduplicated across facts", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    // The same account documented by two separate facts is one subject.
    await admitFact(jobId, ADDRESS);
    await admitFact(jobId, ADDRESS);
    const secondJob = await makeJob(projectId);
    const first = await admittedLocatorsForJob(ctx.db, secondJob);
    const second = await admittedLocatorsForJob(ctx.db, secondJob);
    expect(first.filter((l) => l.value === ADDRESS)).toHaveLength(1);
    expect(first).toEqual(second);
  });
});

describe("locator reuse — this is Evidence provenance, not Research Memory", () => {
  it("12. the store has no Research Memory dependency", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/documentary-locator-store.ts", import.meta.url),
      "utf-8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const banned of [
      "project_memory_items",
      "projectMemoryItems",
      "memory_enabled",
      "memoryEnabled",
      "server/memory",
      "retrieveMemory",
    ]) {
      expect(code, `locator store references "${banned}"`).not.toContain(banned);
    }
  });

  it("13. no project-specific logic anywhere in the store", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/documentary-locator-store.ts", import.meta.url),
      "utf-8",
    );
    const lower = src.toLowerCase();
    for (const banned of ["pump", "solscan", "buyback", "jupiter", "raydium"]) {
      expect(lower, `locator store mentions "${banned}"`).not.toContain(banned);
    }
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // No hard-coded address of any kind.
    expect(/["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/.test(codeOnly)).toBe(false);
  });
});
