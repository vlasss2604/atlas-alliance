import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquiredDocuments, evidence, projects, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  authorityPermitsAcquisition,
  loadAcquiredDocumentForResume,
  markAcquiredDocumentConsumed,
  persistAcquiredDocument,
  replayContentFetcher,
  textSha256,
} from "../src/server/engine/acquired-documents";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { findAdmittedLocator } from "../src/server/engine/documentary-locator-store";
import { resolveOnchainSubject } from "../src/server/engine/onchain-subject-provenance";
import { __setOnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import type { OnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import { TokenCountUnavailableError } from "../src/server/engine/providers/token-gate";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// TWO-STAGE ACQUISITION — Stage A (acquire document, stop) and Stage B
// (extract Evidence from the persisted document). Entirely offline: every
// transport in this file is a fixture, every extractor is a fixture, and
// the on-chain retriever is a counting spy.
//
// The invariant under test everywhere: PERSISTED DOCUMENT != EVIDENCE.
// Stage A may create only an acquired_documents row; Evidence, locators
// and chain provenance can appear only after Stage B runs the ordinary
// production path against that stored document.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  __setOnchainRetriever(null);
  await ctx.close();
});

const HOST = "docs.example-project.test";
const DOC_URL = `https://${HOST}/docs/spec`;
// A structurally valid Solana address, literally present in the document.
const ADDRESS = "So11111111111111111111111111111111111111112";
const DOC_TEXT =
  `Fixture protocol documentation. The protocol fee accrues directly to the ` +
  `treasury contract. Bought-back tokens are held at ${ADDRESS} until governance ` +
  `decides otherwise.`;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

function fixtureDoc(over: Partial<FetchedDocument> = {}): FetchedDocument {
  return {
    finalUrl: DOC_URL,
    requestedUrl: DOC_URL,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText: DOC_TEXT,
    contentHash: "sha256:fixture-raw-bytes-hash",
    fetchedAt: new Date(),
    byteLength: DOC_TEXT.length,
    staticTextLength: DOC_TEXT.length,
    ...over,
  };
}

function goodFact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 1,
    component: "SOURCE_OF_VALUE",
    statement: "protocol fee accrues to the treasury; bought-back tokens are held",
    supportFragment: "The protocol fee accrues directly to the treasury contract",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    onchainLocator: ADDRESS,
    ...over,
  };
}

function spyRetriever() {
  const calls = { n: 0 };
  const retriever: OnchainRetriever = {
    name: "spy",
    supports() {
      calls.n += 1;
      return true;
    },
    async retrieve() {
      calls.n += 1;
      throw new Error("never");
    },
  };
  return { calls, retriever };
}

// One project with a confirmed identity AND a confirmed+classified
// OFFICIAL_DOCS route for the fixture host — created through the REAL
// owner operations, never by hand-writing memory rows.
async function makeClassifiedProject() {
  const slug = uniq("twostage");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Two Stage Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3Qrk111".slice(0, 43) + "1",
  });
  expect(identity.ok).toBe(true);
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: HOST,
    pathPrefix: "/docs",
  });
  if (!confirmed.ok) throw new Error("fixture route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("fixture route classify failed: " + classified.refusal);
  return project;
}

async function makeJob(projectId: string): Promise<string> {
  const { topics } = await import("../src/server/db/schema");
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "q",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement,
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

interface StageDeps {
  contentFetcher: { name: string; fetch: (url: string) => Promise<FetchedDocument> };
  extractor: EvidenceExtractor;
  chain?: "ENABLED" | "DOCUMENTARY_ONLY";
}

function executorFor(project: { id: string; name: string; slug: string }, deps: StageDeps) {
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: { name: "fixture", async proposeQueries() { return ["q"]; } },
    searchGateway: {
      name: "fixture",
      async search() { return [{ url: DOC_URL, title: "t", snippet: "s" }]; },
    },
    contentFetcher: deps.contentFetcher,
    evidenceExtractor: deps.extractor,
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: deps.chain ?? "DOCUMENTARY_ONLY",
  });
}

async function run(project: { id: string; name: string; slug: string }, jobId: string, deps: StageDeps) {
  return executorFor(project, deps).execute(ITEM, {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 5, maxSourceOpens: 5, maxModelCostMicro: 1_000_000 },
  });
}

// STAGE A composition, exactly as scripts/acquire-document.ts wires it:
// real executor, capture-stub extractor, documentary-only chain.
async function runStageA(project: { id: string; name: string; slug: string }) {
  const jobId = await makeJob(project.id);
  const fetchCalls = { n: 0 };
  const captured: { doc: FetchedDocument | null; stubCalls: number } = { doc: null, stubCalls: 0 };
  const outcome = await run(project, jobId, {
    contentFetcher: {
      name: "fixture-transport",
      async fetch() {
        fetchCalls.n += 1;
        return fixtureDoc();
      },
    },
    extractor: {
      name: "document-capture",
      async extract(input) {
        captured.stubCalls += 1;
        captured.doc = input.document;
        return [];
      },
    },
  });
  return { jobId, outcome, captured, fetchCalls };
}

async function evidenceCountFor(jobId: string): Promise<number> {
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
  return rows.length;
}

describe("Stage A — acquire and persist, and NOTHING else exists afterwards", () => {
  it("1/2/3/4/5/6/12. fetches through the transport seam, captures, persists; zero model, zero RPC, zero Evidence, chain locked", async () => {
    const { calls, retriever } = spyRetriever();
    __setOnchainRetriever(retriever);
    const project = await makeClassifiedProject();

    const { jobId, captured, fetchCalls } = await runStageA(project);

    // 1. the transport was exercised and the document captured
    expect(fetchCalls.n).toBe(1);
    expect(captured.doc?.normalizedText).toBe(DOC_TEXT);
    // 2. the only "extractor" was the local capture stub — called once
    expect(captured.stubCalls).toBe(1);
    // 3. documentary-only: the retriever spy was never touched
    expect(calls.n).toBe(0);
    // 4/5. no Evidence, no locators
    expect(await evidenceCountFor(jobId)).toBe(0);
    expect(await findAdmittedLocator(ctx.db, ADDRESS)).toHaveLength(0);

    // persist through the module, with the REAL resolved authority
    const route = await resolveSourceRoute(ctx.db, project.id, DOC_URL);
    const persisted = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: jobId,
      doc: captured.doc!,
      route,
      renderMode: "STATIC",
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    // 6. content-hash-bound: the stored seal is exactly the text's sha256
    expect(persisted.textSha256).toBe(textSha256(DOC_TEXT));

    // 12. chain provenance still locked after Stage A
    const gate = await resolveOnchainSubject(ctx.db, {
      subject: ADDRESS,
      chain: "solana",
      network: "mainnet",
      projectAnchor: ADDRESS,
    });
    expect(gate.eligible).toBe(false);

    // stash for later suites
    stashed = { project, documentId: persisted.id };
  });

  it("persistence refuses an unclassified route and oversized text — fail closed", async () => {
    const project = await makeClassifiedProject();
    const unclassified = { officiality: "CONFIRMED" as const, routeClass: null, observation: null, matchedPathPrefix: "/docs" };
    const a = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: null,
      doc: fixtureDoc(),
      route: unclassified,
      renderMode: "STATIC",
    });
    expect(a).toMatchObject({ ok: false, refusal: "AUTHORITY_NOT_CONFIRMED" });

    const route = await resolveSourceRoute(ctx.db, project.id, DOC_URL);
    const b = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: null,
      doc: fixtureDoc({ normalizedText: "x".repeat(2_000_001) }),
      route,
      renderMode: "STATIC",
    });
    expect(b).toMatchObject({ ok: false, refusal: "TEXT_TOO_LARGE" });
  });
});

let stashed: { project: { id: string; name: string; slug: string }; documentId: string } | null = null;

describe("Stage B — resume against the stored document, through the ordinary path", () => {
  it("7/8/9/10/11/13/20. replays without any external fetch, real extractor seam, Evidence + locators through production, chain unlocks", async () => {
    expect(stashed).not.toBeNull();
    const { project, documentId } = stashed!;

    const loaded = await loadAcquiredDocumentForResume(ctx.db, {
      documentId,
      projectId: project.id,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // 7/20. the ONLY transport is the replay fetcher; count its calls
    const replay = replayContentFetcher(loaded.doc);
    let replayCalls = 0;
    const countingReplay = {
      name: replay.name,
      fetch: async (url: string) => {
        replayCalls += 1;
        return replay.fetch(url);
      },
    };
    // 8. it refuses any OTHER url outright — no external source reachable
    await expect(replay.fetch("https://other.example.test/x")).rejects.toMatchObject({
      reason: "INVALID_URL",
    });

    // 9. the real extractor SEAM: the fixture receives the stored text
    let extractorSawText: string | null = null;
    const jobId = await makeJob(project.id);
    const outcome = await run(project, jobId, {
      contentFetcher: countingReplay,
      extractor: {
        name: "fixture-extractor",
        async extract(input) {
          extractorSawText = input.document.normalizedText;
          return [goodFact()];
        },
      },
    });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(replayCalls).toBe(1);
    expect(extractorSawText).toBe(DOC_TEXT);

    // 10. Evidence persisted through the normal path, with real authority
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceClass).toBe("OFFICIAL_DOCS");
    expect(rows[0].officiality).toBe("CONFIRMED");
    expect(rows[0].onchainArtifactId).toBeNull();

    // 11/13. the locator exists ONLY because Evidence does — and the chain
    // provenance gate now opens through the production admission path
    const admitted = await findAdmittedLocator(ctx.db, ADDRESS);
    expect(admitted.length).toBeGreaterThan(0);
    const gate = await resolveOnchainSubject(ctx.db, {
      subject: ADDRESS,
      chain: "solana",
      network: "mainnet",
      projectAnchor: ADDRESS,
    });
    expect(gate.eligible).toBe(true);

    // mark consumed, as the script does after Evidence > 0
    expect(await markAcquiredDocumentConsumed(ctx.db, documentId, jobId)).toBe(true);
  });

  it("18. a consumed document refuses further resumes, and double-marking is refused atomically", async () => {
    const { project, documentId } = stashed!;
    const again = await loadAcquiredDocumentForResume(ctx.db, {
      documentId,
      projectId: project.id,
    });
    expect(again).toMatchObject({ ok: false, refusal: "ALREADY_CONSUMED" });
    expect(await markAcquiredDocumentConsumed(ctx.db, documentId, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("19. a Stage B model failure leaves the document intact and resumable — and the retry re-fetches nothing", async () => {
    const project = await makeClassifiedProject();
    const { jobId, captured } = await runStageA(project);
    const route = await resolveSourceRoute(ctx.db, project.id, DOC_URL);
    const persisted = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: jobId,
      doc: captured.doc!,
      route,
      renderMode: "STATIC",
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    // First resume: the extractor dies the way the live run died.
    const loaded1 = await loadAcquiredDocumentForResume(ctx.db, {
      documentId: persisted.id,
      projectId: project.id,
    });
    expect(loaded1.ok).toBe(true);
    if (!loaded1.ok) return;
    const failJob = await makeJob(project.id);
    await expect(
      run(project, failJob, {
        contentFetcher: replayContentFetcher(loaded1.doc),
        extractor: {
          name: "dying-extractor",
          async extract() {
            throw new TokenCountUnavailableError("x", false, "RATE_LIMITED", 429);
          },
        },
      }),
    ).rejects.toBeInstanceOf(CapabilityFatalError);
    expect(await evidenceCountFor(failJob)).toBe(0);

    // The document is untouched and still resumable.
    const loaded2 = await loadAcquiredDocumentForResume(ctx.db, {
      documentId: persisted.id,
      projectId: project.id,
    });
    expect(loaded2.ok).toBe(true);
    if (!loaded2.ok) return;

    // Retry succeeds from storage; only the replay transport is called.
    let replayCalls = 0;
    const replay = replayContentFetcher(loaded2.doc);
    const retryJob = await makeJob(project.id);
    const outcome = await run(project, retryJob, {
      contentFetcher: {
        name: replay.name,
        fetch: async (u: string) => {
          replayCalls += 1;
          return replay.fetch(u);
        },
      },
      extractor: { name: "fixture-extractor", async extract() { return [goodFact()]; } },
    });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(replayCalls).toBe(1);
    expect(await evidenceCountFor(retryJob)).toBe(1);
  });

  it("21. documentary-only chain mode still guarantees zero retriever calls on resume, even with admitted locators present", async () => {
    // Admitted locators exist in this database by now (earlier suites).
    const { calls, retriever } = spyRetriever();
    __setOnchainRetriever(retriever);
    const project = await makeClassifiedProject();
    const { captured } = await runStageA(project);
    const jobId = await makeJob(project.id);
    await run(project, jobId, {
      contentFetcher: replayContentFetcher(captured.doc!),
      extractor: { name: "fixture-extractor", async extract() { return [goodFact()]; } },
      chain: "DOCUMENTARY_ONLY",
    });
    expect(calls.n).toBe(0);
    __setOnchainRetriever(null);
  });
});

describe("refusals — every axis fails closed", () => {
  it("14. arbitrary operator input is impossible: the only key is a row id, and an unknown id is refused", async () => {
    const { project } = stashed!;
    const r = await loadAcquiredDocumentForResume(ctx.db, {
      documentId: "00000000-0000-0000-0000-000000000001",
      projectId: project.id,
    });
    expect(r).toMatchObject({ ok: false, refusal: "NOT_FOUND" });
  });

  it("15. another project's document is refused", async () => {
    const projectA = await makeClassifiedProject();
    const projectB = await makeClassifiedProject();
    const { jobId, captured } = await runStageA(projectA);
    const route = await resolveSourceRoute(ctx.db, projectA.id, DOC_URL);
    const persisted = await persistAcquiredDocument(ctx.db, {
      projectId: projectA.id,
      acquiringJobId: jobId,
      doc: captured.doc!,
      route,
      renderMode: "STATIC",
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    const r = await loadAcquiredDocumentForResume(ctx.db, {
      documentId: persisted.id,
      projectId: projectB.id,
    });
    expect(r).toMatchObject({ ok: false, refusal: "PROJECT_MISMATCH" });
  });

  it("16. tampered content is refused by the seal", async () => {
    const project = await makeClassifiedProject();
    const { jobId, captured } = await runStageA(project);
    const route = await resolveSourceRoute(ctx.db, project.id, DOC_URL);
    const persisted = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: jobId,
      doc: captured.doc!,
      route,
      renderMode: "STATIC",
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    await ctx.db
      .update(acquiredDocuments)
      .set({ normalizedText: DOC_TEXT + " QUIETLY EDITED" })
      .where(eq(acquiredDocuments.id, persisted.id));
    const r = await loadAcquiredDocumentForResume(ctx.db, {
      documentId: persisted.id,
      projectId: project.id,
    });
    expect(r).toMatchObject({ ok: false, refusal: "CONTENT_TAMPERED" });
  });

  it("17. the authority snapshot is enforced at load, and the both-ends predicate is the shared one", async () => {
    const project = await makeClassifiedProject();
    // A row whose snapshot claims no routeClass cannot reach extraction —
    // inserted raw precisely because persistAcquiredDocument refuses to
    // create it, so only tampering could.
    const [row] = await ctx.db
      .insert(acquiredDocuments)
      .values({
        projectId: project.id,
        url: DOC_URL,
        finalUrl: DOC_URL,
        httpStatus: 200,
        contentType: "text/markdown",
        byteLength: DOC_TEXT.length,
        staticTextLength: DOC_TEXT.length,
        normalizedText: DOC_TEXT,
        contentHash: "sha256:x",
        textSha256: textSha256(DOC_TEXT),
        renderMode: "STATIC",
        authority: { officiality: "CONFIRMED", routeClass: null, matchedPathPrefix: "/docs" },
      })
      .returning();
    const r = await loadAcquiredDocumentForResume(ctx.db, {
      documentId: row.id,
      projectId: project.id,
    });
    expect(r).toMatchObject({ ok: false, refusal: "SNAPSHOT_AUTHORITY_INVALID" });

    expect(authorityPermitsAcquisition({ officiality: "CONFIRMED", routeClass: "OFFICIAL_DOCS" })).toBe(true);
    expect(authorityPermitsAcquisition({ officiality: "CONFIRMED", routeClass: null })).toBe(false);
    expect(authorityPermitsAcquisition({ officiality: "CLAIMED", routeClass: "OFFICIAL_DOCS" })).toBe(false);
  });
});

describe("22 + mutation boundary — the resume path cannot reach the network", () => {
  it("no project-specific strings in any production file of this feature", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/acquired-documents.ts",
      "../src/server/db/schema/acquired.ts",
      "../scripts/acquire-document.ts",
      "../scripts/extract-from-document.ts",
    ]) {
      const code = (await fs.readFile(new URL(file, import.meta.url), "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["raydium", "pump", "solscan", "docs.raydium", "ddhdoz"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("MUTATION CHECK: neither the module nor Stage B can construct the real network fetcher", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/acquired-documents.ts",
      "../scripts/extract-from-document.ts",
    ]) {
      const code = (await fs.readFile(new URL(file, import.meta.url), "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
      // If someone wires the real transport into the resume path, one of
      // these names must appear — and this test names the regression.
      for (const banned of [
        "safeContentFetcher",
        "resolveContentFetcher",
        "createContentFetcher",
        "createIsolatedRenderedDocsFetcher",
        "node:http",
        "node:https",
        "undici",
      ]) {
        expect(code, `${file} references "${banned}"`).not.toContain(banned);
      }
    }
    // Stage B force-disables the renderer rather than installing one.
    const stageB = await fs.readFile(new URL("../scripts/extract-from-document.ts", import.meta.url), "utf-8");
    expect(stageB).toContain('process.env.RENDERED_DOCS_ENABLED = ""');
    expect(stageB).toContain("__setRenderedDocsFetcher(null)");
    // And Stage B accepts no raw-text input of any kind.
    for (const banned of ["--text", "readFile", "stdin"]) {
      expect(stageB, `stage B accepts ${banned}`).not.toContain(banned);
    }
  });

  it("the persisted row is size-bounded at the database too", async () => {
    const { project } = stashed!;
    await expect(
      ctx.db.insert(acquiredDocuments).values({
        projectId: project.id,
        url: DOC_URL,
        finalUrl: DOC_URL,
        httpStatus: 200,
        contentType: "text/plain",
        byteLength: 1,
        normalizedText: sql`repeat('x', 2000001)` as unknown as string,
        contentHash: "sha256:x",
        textSha256: "sha256:x",
        authority: { officiality: "CONFIRMED", routeClass: "OFFICIAL_DOCS", matchedPathPrefix: "/docs" },
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
