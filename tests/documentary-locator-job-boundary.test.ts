import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  evidence,
  evidenceDocumentaryLocators,
  onchainArtifacts,
  onchainDerivedSubjects,
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
import {
  eligibleSubjects,
  runStructuredOnchainAcquisition,
  selectOnchainIntents,
} from "../src/server/engine/onchain-acquisition";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type { OnchainArtifact, OnchainIntent } from "../src/server/engine/providers/onchain-types";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// THE DOCUMENTARY LOCATOR BOUNDARY IS THE JOB.
//
// An earlier round scoped admitted locators to the PROJECT, so a fresh
// research job silently consumed an address a previous job had established.
// That is reuse of a research conclusion, made without any of the things
// reuse requires — no freshness bound, no revalidation, no revocation act,
// and no provenance on the returned value, so a Proof could not say whether
// an address was found in THIS run or inherited. Until an explicit Research
// Memory design exists, the honest boundary is the job.
//
// Two things this file must keep separate, because only one of them is
// bounded here:
//
//   CONFIRMED PROJECT IDENTITY  a stored fact about what the project IS.
//                               Still supplies the token-level anchor.
//   DOCUMENTARY LOCATOR         a research conclusion about where a
//                               mechanism runs. Job-scoped from now on.
//
// The other load-bearing claims are about what does NOT happen: no
// historical fallback, no standalone-observation adoption, no address from
// text, and not one validation or authority bar relaxed by the narrowing.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

// Shaped like real Solana addresses because the schema CHECK requires it —
// no project, no chain fixture and no known address appears anywhere here.
const ADDRESS = "Locator11111111111111111111111111111111111";
const OTHER_ADDRESS = "Locator22222222222222222222222222222222222";
const HISTORICAL = "Historic111111111111111111111111111111111";
const MINT = "Mint1111111111111111111111111111111111111111";
const IDENTITY: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: MINT, ticker: "TST" };

async function makeProject(): Promise<string> {
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("locbound"), name: "Locator Boundary Project", status: "ACTIVE_CORE" })
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

// ---------------------------------------------------------------------
// The boundary itself.
// ---------------------------------------------------------------------

describe("1/2/3/10. the job is the boundary", () => {
  it("1. a locator established by THIS job is available to it", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS);
    const found = await admittedLocatorsForJob(ctx.db, jobId);
    expect(found.map((f) => f.value)).toEqual([ADDRESS]);
  });

  it("2/10. a locator established ONLY by a previous job of the SAME project is NOT available", async () => {
    const projectId = await makeProject();
    const firstJob = await makeJob(projectId);
    await admitFact(firstJob, ADDRESS);

    const secondJob = await makeJob(projectId);
    // The mutation check for this whole round: swap the job predicate back
    // to the project and this assertion is the one that fails.
    expect(await admittedLocatorsForJob(ctx.db, secondJob)).toEqual([]);
    // And the first job did not lose it — nothing was revoked, only the
    // cross-job reach was withdrawn.
    expect((await admittedLocatorsForJob(ctx.db, firstJob)).map((l) => l.value)).toEqual([ADDRESS]);
  });

  it("3. a locator from ANOTHER project is not available either", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const jobA = await makeJob(projectA);
    await admitFact(jobA, ADDRESS);
    const jobB = await makeJob(projectB);
    expect(await admittedLocatorsForJob(ctx.db, jobB)).toEqual([]);
  });

  it("identity is the job id, never a name, ticker or slug", async () => {
    const [a] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("twin"), name: "Twin Project", status: "ACTIVE_CORE" })
      .returning();
    const jobOne = await makeJob(a.id);
    const jobTwo = await makeJob(a.id);
    await admitFact(jobOne, ADDRESS);
    // Same project, same name, same slug — and still not shared.
    expect(await admittedLocatorsForJob(ctx.db, jobTwo)).toEqual([]);
  });

  it("an unresolvable job fails closed rather than returning everything", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS);
    expect(await admittedLocatorsForJob(ctx.db, "00000000-0000-0000-0000-000000000000")).toEqual([]);
    expect(await admittedLocatorsForJob(ctx.db, "")).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Not one validation or authority bar was relaxed by the narrowing.
// ---------------------------------------------------------------------

describe("4/5/6. the same job is not enough authority", () => {
  it("4. a locator the document does not LITERALLY contain never reaches the table", async () => {
    const outcome = validateFactLocators({
      claimed: [ADDRESS],
      documentText: "this document names no account whatsoever",
    });
    expect(outcome.confirmed).toHaveLength(0);
    expect(outcome.rejected.length).toBeGreaterThan(0);

    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    expect(await admittedLocatorsForJob(ctx.db, jobId)).toEqual([]);
  });

  it("4b. a TRUNCATED locator is unrepresentable, in this job as in any other", async () => {
    const truncated = ADDRESS.slice(0, 20);
    expect(
      validateFactLocators({ claimed: [truncated], documentText: `sent to ${ADDRESS}` }).confirmed,
    ).toHaveLength(0);

    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    const { evidenceId } = await admitFact(jobId, ADDRESS);
    // The database refuses it even if a writer bypassed the validator.
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

  it("5. an UNCONFIRMED locator is unrepresentable, and the query restates it anyway", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    const { evidenceId } = await admitFact(jobId, ADDRESS);
    // Layer one: the table itself cannot hold a non-CONFIRMED locator, in
    // this job or any other.
    await expect(
      ctx.db.insert(evidenceDocumentaryLocators).values({
        evidenceId,
        ordinal: 5,
        value: OTHER_ADDRESS,
        shape: "ADDRESS_LIKE",
        literallyPresent: false,
        validationResult: "REJECTED",
      }),
    ).rejects.toThrow();
    expect((await admittedLocatorsForJob(ctx.db, jobId)).map((l) => l.value)).toEqual([ADDRESS]);

    // Layer two: the query still asks for the validator's verdict itself,
    // so the guarantee survives someone loosening that CHECK.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/documentary-locator-store.ts", import.meta.url),
      "utf-8",
    );
    const fn = src.slice(src.indexOf("export async function admittedLocatorsForJob"));
    expect(fn).toContain("eq(evidenceDocumentaryLocators.literallyPresent, true)");
    expect(fn).toContain('eq(evidenceDocumentaryLocators.validationResult, "CONFIRMED")');
  });

  it("5b. a CLAIMED (not CONFIRMED) source's address is refused in its own job", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS, { officiality: "CLAIMED" });
    expect(await admittedLocatorsForJob(ctx.db, jobId)).toEqual([]);
  });

  it("6. a non-documentary source class never hands over a subject", async () => {
    for (const cls of ["SOCIAL", "RESEARCH_MEDIA", "DATA_PROVIDER"]) {
      const projectId = await makeProject();
      const jobId = await makeJob(projectId);
      await admitFact(jobId, ADDRESS, { sourceClass: cls });
      expect(await admittedLocatorsForJob(ctx.db, jobId), `${cls} was admitted`).toEqual([]);
    }
  });

  it("6b. a BROKEN source is refused — provenance must still resolve", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS, { sourceHealth: "BROKEN" });
    expect(await admittedLocatorsForJob(ctx.db, jobId)).toEqual([]);
  });

  it("GOVERNANCE and OFFICIAL_REPORT stay documentary and stay admissible", async () => {
    for (const cls of ["GOVERNANCE", "OFFICIAL_REPORT"]) {
      const projectId = await makeProject();
      const jobId = await makeJob(projectId);
      await admitFact(jobId, ADDRESS, { sourceClass: cls });
      expect(
        (await admittedLocatorsForJob(ctx.db, jobId)).map((l) => l.value),
        `${cls} was refused`,
      ).toEqual([ADDRESS]);
    }
  });
});

// ---------------------------------------------------------------------
// Provenance.
// ---------------------------------------------------------------------

describe("11. a current-job locator remains attributable", () => {
  it("carries the evidence, source and job that established it", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    const { evidenceId, sourceId } = await admitFact(jobId, ADDRESS);

    const [locator] = await admittedLocatorsForJob(ctx.db, jobId);
    expect(locator).toEqual({
      value: ADDRESS,
      shape: "ADDRESS_LIKE",
      evidenceId,
      sourceId,
      researchJobId: jobId,
    });
    // The attribution is real, not a label: it resolves back to the exact
    // document this job read.
    const [row] = await ctx.db.select().from(evidence).where(eq(evidence.id, locator.evidenceId));
    expect(row.researchJobId).toBe(jobId);
    const [src] = await ctx.db.select().from(sources).where(eq(sources.id, locator.sourceId));
    expect(row.retrievedUrl).toBe(src.url);
  });

  it("provenance is deterministic when two facts document the same account", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    const a = await admitFact(jobId, ADDRESS);
    const b = await admitFact(jobId, ADDRESS);
    const first = await admittedLocatorsForJob(ctx.db, jobId);
    const second = await admittedLocatorsForJob(ctx.db, jobId);
    // One subject, not two reads — and the SAME provenance every time.
    expect(first).toHaveLength(1);
    expect(first).toEqual(second);
    expect([a.evidenceId, b.evidenceId]).toContain(first[0].evidenceId);
  });

  it("nothing is copied or rewritten by reading it", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    const { evidenceId } = await admitFact(jobId, ADDRESS);
    const [before] = await ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));
    await admittedLocatorsForJob(ctx.db, jobId);
    const [after] = await ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));
    expect(after).toEqual(before);
    const locatorRows = await ctx.db
      .select()
      .from(evidenceDocumentaryLocators)
      .where(eq(evidenceDocumentaryLocators.evidenceId, evidenceId));
    expect(locatorRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Identity is a different thing and keeps working.
// ---------------------------------------------------------------------

function fixtureArtifact(intent: OnchainIntent): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result: { kind: "TOKEN_SUPPLY", mint: MINT, amountRaw: "1000", decimals: 6 },
    normalizedText: '{"kind":"TOKEN_SUPPLY"}',
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: intent.subjectKind,
      subject: intent.subject,
      slot: 500,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "fixture",
      requestParams: { subject: intent.subject },
      retrievedAt: new Date(),
      rawResponseHash: `sha256:raw:${intent.subject}`,
      artifactHash: `sha256:art:${intent.subject}`,
      transactionSignature: null,
    },
  });
}

function fixtureRetriever() {
  const asked: OnchainIntent[] = [];
  return {
    asked,
    retriever: {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent): Promise<OnchainArtifact> => {
        asked.push(intent);
        return fixtureArtifact(intent);
      },
    },
  };
}

describe("7/12. confirmed project identity is NOT a documentary locator", () => {
  it("7. token-level reads still resolve from the confirmed identity alone", () => {
    // No locator anywhere, and the anchor is still addressable.
    expect(eligibleSubjects(IDENTITY, [])).toEqual([{ subject: MINT, isAnchor: true }]);
    const intents = selectOnchainIntents({
      component: "NET_EFFECT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity: IDENTITY,
      locators: [],
      maxIntents: 4,
    });
    expect(intents.map((i) => i.kind)).toEqual(["TOKEN_SUPPLY"]);
    expect(intents[0].subject).toBe(MINT);
  });

  it("12. a fresh run plans TOKEN_SUPPLY from identity but NOT an account read of a historical address", async () => {
    const projectId = await makeProject();
    const previousJob = await makeJob(projectId);
    // A previous run of the SAME project documented an account.
    await admitFact(previousJob, HISTORICAL, { patternStep: 6, component: "DESTINATION" });

    const freshJob = await makeJob(projectId);
    const locators = (await admittedLocatorsForJob(ctx.db, freshJob)).map((l) => ({
      address: l.value,
      origin: "ADMITTED_EVIDENCE_SOURCE" as const,
    }));
    expect(locators).toEqual([]);

    // Token-level: still planned, from identity.
    const tokenLevel = await fixtureRetriever();
    const supply = await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId: freshJob,
      attemptId: null,
      item: { step: 7, component: "NET_EFFECT" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: IDENTITY },
      locators,
      maxSourceOpens: 24,
      retriever: tokenLevel.retriever,
    });
    expect(tokenLevel.asked.map((i) => i.kind)).toEqual(["TOKEN_SUPPLY"]);
    expect(tokenLevel.asked.every((i) => i.subject === MINT)).toBe(true);
    expect(supply.evidenceIds.length).toBeGreaterThan(0);

    // Account-level: NOT planned. No subject, so no call at all — and in
    // particular never the historical address.
    const accountLevel = await fixtureRetriever();
    const execution = await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId: freshJob,
      attemptId: null,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: IDENTITY },
      locators,
      maxSourceOpens: 24,
      retriever: accountLevel.retriever,
    });
    expect(accountLevel.asked).toEqual([]);
    expect(accountLevel.asked.map((i) => i.subject)).not.toContain(HISTORICAL);
    expect(execution.evidenceIds).toEqual([]);
    expect(execution.sourceOpensSpent).toBe(0);
    // A visible acquisition boundary, not a finding about the project.
    expect(execution.observations).toEqual([]);
  }, 120_000);

  it("12b. the SAME job admitting the address makes the account read planned again", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    await admitFact(jobId, ADDRESS, { patternStep: 6, component: "DESTINATION" });
    const locators = (await admittedLocatorsForJob(ctx.db, jobId)).map((l) => ({
      address: l.value,
      origin: "ADMITTED_EVIDENCE_SOURCE" as const,
    }));
    const intents = selectOnchainIntents({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity: IDENTITY,
      locators,
      maxIntents: 4,
    });
    expect(intents.map((i) => i.subject)).toEqual([ADDRESS]);
  });
});

// ---------------------------------------------------------------------
// Nothing else may become a subject.
// ---------------------------------------------------------------------

describe("8/10. no fallback of any kind", () => {
  it("8. a standalone on-chain observation is never adopted as a locator", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);

    // An owner-script observation: no research job, no source, and a
    // derived subject recorded against it. This is exactly the shape a
    // "just use what we already observed" fallback would reach for.
    const [artifact] = await ctx.db
      .insert(onchainArtifacts)
      .values({
        originKind: "STANDALONE_STRUCTURED_OBSERVATION",
        researchJobId: null,
        sourceId: null,
        canonicalUri: `atlas-onchain://solana/mainnet/project/${MINT}/account/${HISTORICAL}/info`,
        chain: "solana",
        network: "mainnet",
        projectAnchor: MINT,
        subjectKind: "account",
        subject: HISTORICAL,
        intentKind: "ACCOUNT_INFO",
        slot: 500,
        finality: "finalized",
        retrievalMethod: "RPC",
        providerId: "owner-script",
        providerMethod: "getAccountInfo",
        requestParams: { subject: HISTORICAL },
        retrievedAt: new Date(),
        rawResponseHash: uniq("raw"),
        artifactHash: uniq("art"),
        normalizedResult: { kind: "ACCOUNT_INFO" },
      })
      .returning();
    await ctx.db.insert(onchainDerivedSubjects).values({
      onchainArtifactId: artifact.id,
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subject: OTHER_ADDRESS,
      subjectKind: "TOKEN_ACCOUNT",
      parentSubject: HISTORICAL,
      derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER",
      bindingStatus: "CONFIRMED",
      observedSlot: 500,
      retrievedAt: new Date(),
    });

    // Neither the observed subject nor the derived one becomes a locator.
    expect(await admittedLocatorsForJob(ctx.db, jobId)).toEqual([]);
    const intents = selectOnchainIntents({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity: IDENTITY,
      locators: [],
      maxIntents: 4,
    });
    expect(intents).toEqual([]);
  }, 120_000);

  it("10. an address stated in text that no Evidence row admitted is not a subject", async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    // Evidence exists, and it even mentions an address in its fragment —
    // but no validated locator row was written for it.
    const [source] = await ctx.db
      .insert(sources)
      .values({
        url: `https://docs.example.test/${uniq("p")}`,
        urlHash: uniq("uh"),
        sourceType: "OFFICIAL_DOCS",
        health: "OK",
      })
      .returning();
    await ctx.db.insert(evidence).values({
      sourceId: source.id,
      researchJobId: jobId,
      relationship: "SUPPORTS",
      fragment: `tokens are sent to ${OTHER_ADDRESS}`,
      summary: "documented account",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: new Date(),
      evidenceContractVersion: 2,
      patternStep: 6,
      component: "DESTINATION",
      directness: "DIRECT",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
    });
    expect(await admittedLocatorsForJob(ctx.db, jobId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 9. Generic, and still not Research Memory.
// ---------------------------------------------------------------------

describe("9. no project hardcoding, and no Research Memory", () => {
  it("the store has no Research Memory dependency", async () => {
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
      // And no freshness/reuse policy sneaking in through the back door.
      "freshness",
      "ttl",
      "maxAgeDays",
    ]) {
      expect(code, `locator store references "${banned}"`).not.toContain(banned);
    }
  });

  it("no project-specific logic anywhere in the store", async () => {
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
    expect(/["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/.test(codeOnly)).toBe(false);
  });

  it("the query is scoped by the job id and nothing else", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/documentary-locator-store.ts", import.meta.url),
      "utf-8",
    );
    const fn = src.slice(src.indexOf("export async function admittedLocatorsForJob"));
    const code = fn
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("eq(researchJobs.id, jobId)");
    // The predicate that made a fresh Proof inherit an old run's address.
    expect(code).not.toContain("projectId");
  });
});
