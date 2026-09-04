import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquiredDocuments,
  evidence,
  projects,
  proofs,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import { replaceNullCharacters } from "../src/server/engine/providers/content-fetcher";
import {
  prepareExtractionReplayFetcher,
  prepareExtractionReplayProposer,
  prepareExtractionReplaySearch,
} from "../src/server/engine/acquisition-phases";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type {
  ExtractedFact,
  FetchedDocument,
} from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import {
  advancePhaseAndEnqueue,
  beginAcquisitionPhases,
  handleExtractingPhase,
  handleFetchingPhase,
  handleSearchingPhase,
  readAcquisitionPhase,
  type PhaseWorkerContext,
} from "../src/server/jobs/acquisition-phase-worker";
import {
  ALL_RESEARCH_QUEUES,
  PHASE_QUEUE,
  RESEARCH_EXTRACT_QUEUE,
  RESEARCH_FETCH_QUEUE,
  RESEARCH_QUEUE,
  type ResearchQueuePayload,
} from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask, PhaseCapabilityMissingError } from "../src/server/jobs/worker";
import {
  loadWorkerCapabilities,
  parseWorkerCapabilities,
  phasesServedBy,
  PHASE_REQUIRED_CAPABILITY,
  workerServesPhase,
  WORKER_CAPABILITIES_ENV,
  type PhaseCapability,
} from "../src/server/jobs/worker-capabilities";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { loadProofForJob } from "../src/server/services/proof-view";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-136 SLICE 2 — the durable queue orchestration, proved OFFLINE.
//
// Slice 1 proved the phase FUNCTIONS in one process. This file proves the
// part that only exists once a job crosses processes: capability-scoped
// roles, a persisted phase, an atomic advance-and-enqueue, closed
// refusals for stale and premature messages, and at-least-once delivery
// that repeats no paid work.
//
// Every provider is a fixture. Nothing here touches the network.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// Polling rather than a fixed sleep: pg-boss decides when it delivers.
async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

const DOC_URL = "https://docs.example-project.test/mechanism";
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

// The two logical worker roles. Capability is DECLARED here exactly as a
// deployment declares it — nothing is inferred from the environment.
const ROLE_A: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("SEARCH_EXTRACT");
const ROLE_B: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("FETCH");

function roleCtx(capabilities: ReadonlySet<PhaseCapability>): PhaseWorkerContext {
  return { db: ctx.db, boss: ctx.boss, capabilities };
}

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

function fixtureDoc(url: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText:
      "Protocol fees are used to buy back the token, and bought-back tokens are held at a public address.",
    contentHash: "sha256:fixture",
    fetchedAt: new Date("2026-08-29T00:00:00Z"),
    byteLength: 120,
  };
}

function validFact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 6,
    component: "DESTINATION",
    statement: "Bought-back tokens are held at a public address.",
    supportFragment: "bought-back tokens are held at a public address",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not establish that any buyback executed",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
    ...over,
  };
}

function fixtureProposer(queries: string[], calls?: { n: number }) {
  return {
    name: "fixture-proposer",
    async proposeQueries() {
      if (calls) calls.n += 1;
      return queries;
    },
  };
}

function fixtureSearch(byQuery: Record<string, string[]>, calls?: { n: number }) {
  return {
    name: "fixture-search",
    async search(query: string) {
      if (calls) calls.n += 1;
      return (byQuery[query] ?? []).map((url) => ({ url, title: null, snippet: null }));
    },
  };
}

function fixtureFetcher(calls: { n: number; urls: string[] }) {
  return {
    name: "fixture-transport",
    async fetch(url: string) {
      calls.n += 1;
      calls.urls.push(url);
      return fixtureDoc(url);
    },
  };
}

const SEARCH_PROVIDERS = () => ({
  queryProposer: fixtureProposer(["q-alpha"]),
  searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }),
});

async function makeClassifiedProject() {
  const slug = uniq("d136q");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D136 Queue Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("fixture identity failed");
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: "docs.example-project.test",
    pathPrefix: "/mechanism",
  });
  if (!confirmed.ok) throw new Error("fixture route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("fixture route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}

// PHASED ADMISSION, exactly as production must do it: create the job
// WITHOUT the entry-queue enqueue, then begin the phases — which sets the
// persisted phase and enqueues the first message in one transaction. A
// phased job must never also carry a single-process entry message, or two
// different pipelines would race for it.
async function makePhasedJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  return job.id;
}

async function phaseOf(jobId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ phase: researchJobs.acquisitionPhase })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row?.phase ?? null;
}

async function jobRow(jobId: string) {
  const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return row;
}

async function countsFor(jobId: string) {
  const [ev, at, ad, pr] = await Promise.all([
    ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId)),
    ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId)),
    ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId)),
    ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId)),
  ]);
  return { evidence: ev.length, attempts: at.length, documents: ad.length, proofs: pr.length };
}

// How many pg-boss messages are currently queued for a job on a queue.
// Read straight from pg-boss's own table: the point of the atomic handoff
// is that this row and the phase advance share a transaction.
async function queuedMessages(queue: string, jobId: string): Promise<number> {
  const rows = await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${queue} AND data->>'jobId' = ${jobId}`,
  );
  return (rows.rows[0] as { n: number }).n;
}

async function extractionExecutor(
  jobId: string,
  project: { id: string; name: string; slug: string },
  counters: { extract: { n: number }; replayUrls: string[] },
) {
  const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
    searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
    contentFetcher: {
      name: replay.fetcher.name,
      // D-137: a wrapper must carry the metering declaration across
      // deliberately. Dropping it would make this counting wrapper look
      // like a live fetcher and be charged — which is the fail-closed
      // direction, and exactly what production wrappers must avoid.
      metering: replay.fetcher.metering,
      fetch: async (url: string) => {
        counters.replayUrls.push(url);
        return replay.fetcher.fetch(url);
      },
    },
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract() {
        counters.extract.n += 1;
        return [validFact()];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

// Runs all three phases in role order, through the handlers only (no
// queue): the shared body of the tests that care about state rather than
// delivery.
async function runAllPhases(
  jobId: string,
  project: { id: string; name: string; slug: string },
  counters = { extract: { n: 0 }, replayUrls: [] as string[] },
  fetchCalls = { n: 0, urls: [] as string[] },
) {
  const search = await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
  const fetch = await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher(fetchCalls));
  const extract = await handleExtractingPhase(roleCtx(ROLE_A), jobId, () =>
    extractionExecutor(jobId, project, counters),
  );
  return { search, fetch, extract, counters, fetchCalls };
}

describe("NUL RELIABILITY — one unstorable character must not strand a job", () => {
  // FOUND LIVE. An external page carried a raw U+0000 through the FETCH
  // path. The write that rejected it threw, the throw escaped the phase
  // into pg-boss, and pg-boss could not persist its OWN failure output on
  // the same character — so the queue item stayed active with no output and
  // the Research stayed RUNNING with no terminal state.

  const NUL = String.fromCharCode(0);

  it("A. a NUL in document text becomes U+FFFD, keeping the text on both sides", () => {
    const out = replaceNullCharacters("before" + NUL + "after");
    expect(out).toBe("before\uFFFDafter");
    // Replaced, not deleted: dropping it would join two words neither
    // source wrote, and would shift every offset after it.
    expect(out).not.toContain(NUL);
    expect(out).toHaveLength("before".length + 1 + "after".length);
  });

  it("B. ordinary Unicode is returned byte for byte", () => {
    for (const sample of [
      "华尔街 Wall Street",
      "emoji 👨‍👩‍👧‍👦 and 🚀",
      "combining: e\u0301 a\u0300 n\u0303",
      "rtl: \u200fمرحبا\u200e and back",
      "nbsp\u00a0zwj\u200djoiner\ufeffbom",
      "",
    ]) {
      expect(replaceNullCharacters(sample), sample).toBe(sample);
    }
  });

  it("G. no other control character is touched — only U+0000 was proved unsafe", () => {
    // Every other C0 control is storable in Postgres, appears in real
    // documents, and is deliberately left alone. Widening this to a range
    // would be altering Evidence text on no evidence at all.
    for (let code = 1; code <= 0x1f; code++) {
      const s = "a" + String.fromCharCode(code) + "b";
      expect(replaceNullCharacters(s), "U+" + code.toString(16)).toBe(s);
    }
    expect(replaceNullCharacters("a\u007fb")).toBe("a\u007fb");
  });

  it("C. a document carrying a NUL seals, and its stored text matches its stored hash", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());

    const result = await handleFetchingPhase(roleCtx(ROLE_B), jobId, {
      name: "nul-transport",
      async fetch(url: string) {
        const base = fixtureDoc(url);
        return { ...base, normalizedText: "华尔街" + NUL + "tail" };
      },
    });
    expect(result.ran).toBe(true);

    const [row] = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(row).toBeTruthy();
    expect(row.normalizedText).toBe("华尔街\uFFFDtail");
    // The seal describes what is stored: textSha256 is computed from the
    // same post-normalisation string the column holds.
    expect(row.textSha256).toBe(
      "sha256:" + createHash("sha256").update(row.normalizedText, "utf8").digest("hex"),
    );
  });

  it("D+E+F. an unexpected throw carrying a NUL ends the job instead of escaping", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());

    // A throw from INSIDE contentFetcher.fetch is already handled — that is
    // the ordinary FETCH_FAILED path. The failure this boundary exists for
    // comes from the seal, after the transport succeeded, where no catch
    // stood. Reproduced with an unstorable finalUrl: a text column rejects
    // it exactly as normalized_text rejected the live document, and unlike
    // document text it is not sanitised, so the throw is genuine.
    const result = await handleFetchingPhase(roleCtx(ROLE_B), jobId, {
      name: "unsealable-transport",
      async fetch(url: string) {
        const base = fixtureDoc(url);
        return { ...base, finalUrl: base.finalUrl + NUL };
      },
    });
    // D — it does not escape. Before the fix this threw straight through to
    // the pg-boss callback, which then could not persist its own failure.
    expect(result.ran).toBe(false);

    // E — the job is terminal, not RUNNING.
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.state).toBe("FAILED");

    // F — recorded honestly as OUR failure, with a code-owned value that no
    // column can reject. TECHNICAL FAILURE != PROJECT REALITY.
    expect(job.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(job.errorCode).toBe("FETCH_PHASE_FAILED");
    expect(job.errorCode).not.toContain(NUL);

    // Nothing was invented: no document sealed, and no FETCH_OK claimed.
    const docs = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(docs).toEqual([]);
    const ok = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    expect(ok.filter((r) => r.operationType === "FETCH_OK")).toEqual([]);
  });

  it("D. the queue callback can therefore only ever receive a code-owned value", () => {
    // Why no separate queue sanitizer is needed. The FETCHING callback is
    // one line: it awaits the dispatcher and passes the result to
    // throwIfCapabilityRefusal, which throws exactly one code-owned error
    // type. With the phase owning its own throws, no external string has a
    // path into what pg-boss serialises.
    const src = readFileSync("src/server/jobs/worker.ts", "utf-8");
    const cb = src.slice(src.indexOf("RESEARCH_FETCH_QUEUE, async"));
    expect(cb.slice(0, 200)).toContain("throwIfCapabilityRefusal(await dispatchFetchQueueMessage");
    expect(new PhaseCapabilityMissingError("FETCHING").message).not.toContain(NUL);
  });
});

describe("D-136 §1 — migration, phase contract and capability vocabulary (items 1, 2, 3, 8, 13)", () => {
  it("1. the phase column is additive: historical rows read as NULL and stay runnable", async () => {
    // Every job that existed before this migration — and every job the
    // single-process path still creates — has no acquisition phase at
    // all. That is what makes the column backward-compatible without a
    // backfill: NULL is a real, meaningful value here, not a gap.
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    expect(await phaseOf(jobId)).toBeNull();

    const legacy = await readAcquisitionPhase(ctx.db, jobId);
    expect(legacy).toEqual({ phase: null, at: null, pendingTargets: 0, sealedDocuments: 0 });

    // job.state is untouched by any of this — the two are separate axes.
    expect((await jobRow(jobId)).state).toBe("QUEUED");
  });

  it("2. a phased job starts in SEARCHING, and the first message is enqueued with it", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);

    expect(await queuedMessages(RESEARCH_QUEUE, jobId)).toBe(0);
    expect(await beginAcquisitionPhases(ctx.db, ctx.boss, jobId)).toBe(true);
    expect(await phaseOf(jobId)).toBe("SEARCHING");
    expect(await queuedMessages(RESEARCH_QUEUE, jobId)).toBe(1);

    // Beginning twice is refused, so a job can never carry two first
    // messages: the guard is the same "WHERE the column is still what I
    // expect" shape the advance uses.
    expect(await beginAcquisitionPhases(ctx.db, ctx.boss, jobId)).toBe(false);
    expect(await queuedMessages(RESEARCH_QUEUE, jobId)).toBe(1);
  });

  it("3/8/13. capability is declared, never inferred, and each phase requires exactly one", () => {
    expect(PHASE_REQUIRED_CAPABILITY).toEqual({
      SEARCHING: "SEARCH_EXTRACT",
      FETCHING: "FETCH",
      EXTRACTING: "SEARCH_EXTRACT",
    });
    // Fail closed: unset, empty, blank and unknown all grant nothing.
    for (const raw of [undefined, null, "", "   ", "ANY", "ADMIN", "SEARCH", "true"]) {
      expect(parseWorkerCapabilities(raw).size).toBe(0);
    }
    expect([...parseWorkerCapabilities("fetch")]).toEqual(["FETCH"]);
    expect([...parseWorkerCapabilities("SEARCH_EXTRACT, FETCH")].sort()).toEqual([
      "FETCH",
      "SEARCH_EXTRACT",
    ]);
    expect(phasesServedBy(ROLE_A)).toEqual(["SEARCHING", "EXTRACTING"]);
    expect(phasesServedBy(ROLE_B)).toEqual(["FETCHING"]);
    expect(workerServesPhase(ROLE_B, "SEARCHING")).toBe(false);
    expect(workerServesPhase(ROLE_A, "FETCHING")).toBe(false);

    // The env var is read from an explicit environment, and from nothing
    // else — no DNS, no address, no reachability probe.
    const envWith = { [WORKER_CAPABILITIES_ENV]: "FETCH" } as unknown as NodeJS.ProcessEnv;
    expect(loadWorkerCapabilities(envWith).has("FETCH")).toBe(true);
    expect(loadWorkerCapabilities({} as unknown as NodeJS.ProcessEnv).size).toBe(0);
  });

  it("the queue topology is one queue per phase, and payloads carry only a job id", async () => {
    expect(PHASE_QUEUE).toEqual({
      SEARCHING: RESEARCH_QUEUE,
      FETCHING: RESEARCH_FETCH_QUEUE,
      EXTRACTING: RESEARCH_EXTRACT_QUEUE,
    });
    expect([...ALL_RESEARCH_QUEUES]).toEqual([RESEARCH_QUEUE, RESEARCH_FETCH_QUEUE, RESEARCH_EXTRACT_QUEUE]);

    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    const rows = await ctx.db.execute(
      sql`SELECT data FROM pgboss.job WHERE data->>'jobId' = ${jobId}`,
    );
    for (const row of rows.rows as { data: ResearchQueuePayload }[]) {
      // The whole payload, exhaustively: nothing but the identifier.
      expect(Object.keys(row.data)).toEqual(["jobId"]);
      expect(row.data.jobId).toBe(jobId);
    }
  });
});

describe("D-136 §2 — capability refusal and phase mismatch fail closed (items 3, 8, 13, 19, 20)", () => {
  it("3/8/13. a worker refuses, without doing anything, every phase it is not configured for", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    // The FETCH-only role may not search.
    const searchOnB = await handleSearchingPhase(roleCtx(ROLE_B), jobId, SEARCH_PROVIDERS());
    expect(searchOnB).toEqual({ ran: false, refusal: "CAPABILITY_NOT_CONFIGURED" });

    // ...and the SEARCH_EXTRACT role may not fetch.
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
    const fetchCalls = { n: 0, urls: [] as string[] };
    const fetchOnA = await handleFetchingPhase(roleCtx(ROLE_A), jobId, fixtureFetcher(fetchCalls));
    expect(fetchOnA).toEqual({ ran: false, refusal: "CAPABILITY_NOT_CONFIGURED" });
    expect(fetchCalls.n).toBe(0);

    // A worker with no configuration at all serves nothing.
    const none = parseWorkerCapabilities(undefined);
    expect(await handleFetchingPhase(roleCtx(none), jobId, fixtureFetcher(fetchCalls))).toEqual({
      ran: false,
      refusal: "CAPABILITY_NOT_CONFIGURED",
    });
    expect(fetchCalls.n).toBe(0);
  });

  it("20. a premature message — a phase whose prerequisites are not committed — fails closed", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    expect(await phaseOf(jobId)).toBe("SEARCHING");

    // FETCHING before SEARCHING committed: refused, no transport call.
    const fetchCalls = { n: 0, urls: [] as string[] };
    expect(await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher(fetchCalls))).toEqual({
      ran: false,
      refusal: "PHASE_MISMATCH",
    });
    expect(fetchCalls.n).toBe(0);

    // EXTRACTING before either: refused, and the controller never starts.
    const counters = { extract: { n: 0 }, replayUrls: [] as string[] };
    expect(
      await handleExtractingPhase(roleCtx(ROLE_A), jobId, () =>
        extractionExecutor(jobId, project, counters),
      ),
    ).toEqual({ ran: false, refusal: "PHASE_MISMATCH" });
    expect((await countsFor(jobId)).attempts).toBe(0);
    expect(counters.extract.n).toBe(0);
  });

  it("19. a stale message for a phase already completed is a closed no-op", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
    expect(await phaseOf(jobId)).toBe("FETCHING");

    // The job has moved on; the old SEARCHING message re-arrives.
    const searchCalls = { n: 0 };
    const stale = await handleSearchingPhase(roleCtx(ROLE_A), jobId, {
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }, searchCalls),
    });
    expect(stale).toEqual({ ran: false, refusal: "PHASE_MISMATCH" });
    expect(searchCalls.n).toBe(0);
    expect(await phaseOf(jobId)).toBe("FETCHING");
  });

  it("a message for a job that is not phased at all, or does not exist, is refused closed", async () => {
    const project = await makeClassifiedProject();
    const unphased = await makePhasedJob(project.id);
    expect(await handleFetchingPhase(roleCtx(ROLE_B), unphased, fixtureFetcher({ n: 0, urls: [] }))).toEqual({
      ran: false,
      refusal: "NOT_PHASED",
    });
    expect(
      await handleFetchingPhase(
        roleCtx(ROLE_B),
        "00000000-0000-0000-0000-000000000000",
        fixtureFetcher({ n: 0, urls: [] }),
      ),
    ).toEqual({ ran: false, refusal: "NOT_FOUND" });
  });
});

describe("D-136 §3 — the atomic advance-and-enqueue (items 5, 6, 11)", () => {
  it("5/6/11. each successful phase advances exactly once and enqueues exactly one next message", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
    expect(await phaseOf(jobId)).toBe("FETCHING");
    expect(await queuedMessages(RESEARCH_FETCH_QUEUE, jobId)).toBe(1);

    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher({ n: 0, urls: [] }));
    expect(await phaseOf(jobId)).toBe("EXTRACTING");
    expect(await queuedMessages(RESEARCH_EXTRACT_QUEUE, jobId)).toBe(1);

    // The advance is conditional on the phase it claims to be leaving, so
    // a second attempt to make the same transition changes nothing and
    // enqueues nothing. This is the whole guarantee against a duplicate
    // delivery producing two next-phase messages.
    expect(await advancePhaseAndEnqueue(ctx.db, ctx.boss, jobId, "FETCHING", "EXTRACTING")).toBe(false);
    expect(await queuedMessages(RESEARCH_EXTRACT_QUEUE, jobId)).toBe(1);
  });

  it("no commit, no message: a failed transaction leaves neither half behind", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    // Force the transaction to fail AFTER the advance would have been
    // written, by advancing to a phase whose queue message cannot be
    // written (an unknown queue name is rejected by pg-boss).
    const before = await phaseOf(jobId);
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx
          .update(researchJobs)
          .set({ acquisitionPhase: "FETCHING" })
          .where(eq(researchJobs.id, jobId));
        await ctx.boss.send("queue-that-does-not-exist", { jobId }, {});
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow();
    // The advance rolled back with the failed enqueue: the job is exactly
    // where it was, and nothing downstream was told otherwise.
    expect(await phaseOf(jobId)).toBe(before);
    expect(await queuedMessages(RESEARCH_FETCH_QUEUE, jobId)).toBe(0);
  });
});

describe("D-136 §4 — phases create no attempts and repeat no paid work (items 4, 7, 9, 10, 12)", () => {
  it("4/10. neither SEARCHING nor FETCHING creates a research attempt or any Evidence", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
    expect(await countsFor(jobId)).toMatchObject({ attempts: 0, evidence: 0, documents: 0, proofs: 0 });

    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher({ n: 0, urls: [] }));
    const afterFetch = await countsFor(jobId);
    expect(afterFetch.attempts).toBe(0);
    expect(afterFetch.evidence).toBe(0);
    expect(afterFetch.proofs).toBe(0);
    // The fetch phase produced exactly the sealed documents and nothing else.
    expect(afterFetch.documents).toBe(1);
  });

  it("9. FETCHING consumes the persisted candidate handoff, not anything the message carried", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());

    const fetchCalls = { n: 0, urls: [] as string[] };
    const result = await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher(fetchCalls));
    expect(result.ran).toBe(true);
    // The url it opened is the one phase 1 persisted — the fetch worker
    // was given only a job id.
    expect(fetchCalls.urls).toEqual([DOC_URL]);
    const [doc] = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(doc.url).toBe(DOC_URL);
  });

  it("7. duplicate SEARCHING delivery repeats no live search", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    const first = { n: 0 };
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, {
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }, first),
    });
    expect(first.n).toBeGreaterThan(0);
    const searchesReserved = (await jobRow(jobId)).searchQueriesReserved;

    // Redelivery while the job has ALREADY advanced is refused outright.
    const second = { n: 0 };
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, {
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }, second),
    });
    expect(second.n).toBe(0);

    // ...and even a redelivery that arrives BEFORE the advance (the phase
    // is still SEARCHING) pays nothing again: the acquisition ledger
    // already knows every query this job executed.
    await ctx.db
      .update(researchJobs)
      .set({ acquisitionPhase: "SEARCHING" })
      .where(eq(researchJobs.id, jobId));
    const third = { n: 0 };
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, {
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }, third),
    });
    expect(third.n).toBe(0);
    expect((await jobRow(jobId)).searchQueriesReserved).toBe(searchesReserved);
  });

  it("12. duplicate FETCHING delivery seals nothing twice and opens no source twice", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());

    const calls = { n: 0, urls: [] as string[] };
    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher(calls));
    expect(calls.n).toBe(1);
    const opensReserved = (await jobRow(jobId)).sourceOpensReserved;

    // Redelivery before the advance is visible: put the phase back and
    // deliver again, exactly as an at-least-once queue would.
    await ctx.db
      .update(researchJobs)
      .set({ acquisitionPhase: "FETCHING" })
      .where(eq(researchJobs.id, jobId));
    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher(calls));
    expect(calls.n).toBe(1);
    expect((await countsFor(jobId)).documents).toBe(1);
    expect((await jobRow(jobId)).sourceOpensReserved).toBe(opensReserved);
  });
});

describe("D-136 §5 — EXTRACTING runs the normal controller exactly once (items 14, 15, 16, 17, 18, 22, 23)", () => {
  it("14/15/16/17. replay providers, one controller run, first attempts only, recovery pool untouched", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    const { counters, fetchCalls } = await runAllPhases(jobId, project);

    // 14. extraction reached documents only through the replay fetcher,
    // and only ever the sealed url. The transport of phase 2 was called
    // once, in phase 2, and never again.
    expect(counters.replayUrls.length).toBeGreaterThan(0);
    expect([...new Set(counters.replayUrls)]).toEqual([DOC_URL]);
    expect(fetchCalls.n).toBe(1);
    expect(counters.extract.n).toBeGreaterThan(0);

    // 15/16/17. every component attempt is a FIRST attempt, and no
    // recovery step was consumed by anything the phases did.
    const attempts = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBeGreaterThan(0);
    // controller.ts derives isRecoveryAttempt as "this component key
    // already has an attempt" — so "every attempt is number 1" is exactly
    // the statement that no recovery step was consumed.
    for (const a of attempts) expect(a.attemptNumber).toBe(1);
    expect(attempts.filter((a) => a.attemptNumber > 1)).toHaveLength(0);
  });

  it("18. duplicate EXTRACTING delivery does not run the controller a second time", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await runAllPhases(jobId, project);

    const attemptsAfterFirst = (await countsFor(jobId)).attempts;
    // The job reached its terminal state at the end of extraction, which
    // is exactly what a redelivered message meets.
    await ctx.db
      .update(researchJobs)
      .set({ state: "SUCCEEDED", finishedAt: new Date() })
      .where(eq(researchJobs.id, jobId));

    const counters = { extract: { n: 0 }, replayUrls: [] as string[] };
    const again = await handleExtractingPhase(roleCtx(ROLE_A), jobId, () =>
      extractionExecutor(jobId, project, counters),
    );
    expect(again).toEqual({ ran: false, refusal: "JOB_NOT_RUNNABLE" });
    expect(counters.extract.n).toBe(0);
    expect((await countsFor(jobId)).attempts).toBe(attemptsAfterFirst);
  });

  it("22/23. one job produces at most one Proof, and S8's contract is unchanged", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await runAllPhases(jobId, project);

    const proofRows = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proofRows).toHaveLength(1);
    const proof = proofRows[0];
    // The S8 contract this round did not touch: a band-valued confidence
    // (D-135), never 0 and never 100, and a persisted verdict.
    expect([20, 40, 60, 80]).toContain(proof.confidence);
    expect(proof.verdict).toBeTruthy();
  });
});

describe("D-136 §6 — failure and resume (items 21, and the crash contract)", () => {
  it("21. a phase failure fabricates no Proof and no Evidence", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    // A phase that throws out of its own body: the proposer is
    // unavailable, so the phase never completes.
    await expect(
      handleSearchingPhase(roleCtx(ROLE_A), jobId, {
        queryProposer: {
          name: "failing-proposer",
          async proposeQueries(): Promise<string[]> {
            throw new Error("provider down");
          },
        },
        searchGateway: fixtureSearch({}),
      }),
    ).rejects.toThrow();

    // Nothing advanced, nothing was fabricated, and no fetch work was
    // enqueued for a phase that never committed.
    expect(await phaseOf(jobId)).toBe("SEARCHING");
    expect(await queuedMessages(RESEARCH_FETCH_QUEUE, jobId)).toBe(0);
    expect(await countsFor(jobId)).toMatchObject({ evidence: 0, proofs: 0, attempts: 0 });
  });

  it("a search whose every query fails advances with nothing, and invents nothing", async () => {
    // Slice 1 semantics, unchanged and worth pinning: a per-query provider
    // failure is RECORDED (a FAILED trace row) rather than thrown, so the
    // phase completes with zero candidates. That is not a fabricated
    // success — there is nothing to fetch, nothing to extract, and the
    // pipeline reaches an honest evidence-less outcome instead of a
    // manufactured one.
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    const result = await handleSearchingPhase(roleCtx(ROLE_A), jobId, {
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: {
        name: "failing-search",
        async search(): Promise<{ url: string; title: string | null; snippet: string | null }[]> {
          throw new Error("provider down");
        },
      },
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.search?.executedQueries).toEqual([]);
      expect(result.search?.candidateUrls).toEqual([]);
    }
    // Nothing to fetch, and nothing invented.
    const fetchCalls = { n: 0, urls: [] as string[] };
    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher(fetchCalls));
    expect(fetchCalls.n).toBe(0);
    expect(await countsFor(jobId)).toMatchObject({ evidence: 0, documents: 0, proofs: 0 });
  });

  it("a partial fetch keeps what it sealed, and the phase still advances on the successful part", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    // Two candidates, one of which the transport refuses.
    const DEAD = "https://docs.example-project.test/mechanism-dead";
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, {
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL, DEAD] }),
    });

    const result = await handleFetchingPhase(roleCtx(ROLE_B), jobId, {
      name: "half-failing-transport",
      async fetch(url: string) {
        if (url === DEAD) throw new Error("unreachable");
        return fixtureDoc(url);
      },
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.fetch?.sealedDocumentIds).toHaveLength(1);
      expect(result.fetch?.failedUrls).toEqual([DEAD]);
    }
    // The successful document is durable, and the failure is remembered
    // as a dead url rather than retried blindly by the next delivery.
    expect((await countsFor(jobId)).documents).toBe(1);
    expect(await phaseOf(jobId)).toBe("EXTRACTING");
  });

  it("a crash between phases resumes from persisted state alone", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());

    // Simulate a process that died right after the advance committed: a
    // brand-new context, holding nothing in memory, picks the job up from
    // the queue and needs no information the database does not have.
    const freshCtx: PhaseWorkerContext = { db: ctx.db, boss: ctx.boss, capabilities: ROLE_B };
    const resumed = await handleFetchingPhase(freshCtx, jobId, fixtureFetcher({ n: 0, urls: [] }));
    expect(resumed.ran).toBe(true);
    expect(await phaseOf(jobId)).toBe("EXTRACTING");
  });
});

describe("D-136 §7 — budgets (item 25)", () => {
  it("25. crossing a queue costs nothing: a redelivered phase reserves no budget at all", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
    const afterSearch = await jobRow(jobId);
    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher({ n: 0, urls: [] }));
    const afterFetch = await jobRow(jobId);

    // Each phase reserved on the SAME job counters, through the same
    // primitives, for the external calls it actually made.
    expect(afterSearch.searchQueriesReserved).toBe(1);
    expect(afterFetch.sourceOpensReserved).toBe(1);
    expect(afterFetch.searchQueriesReserved).toBe(afterSearch.searchQueriesReserved);

    // Redelivering both phases reserves nothing further — the boundary
    // itself is free, which is the guarantee that matters once a job
    // crosses processes.
    await ctx.db
      .update(researchJobs)
      .set({ acquisitionPhase: "SEARCHING" })
      .where(eq(researchJobs.id, jobId));
    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
    await ctx.db
      .update(researchJobs)
      .set({ acquisitionPhase: "FETCHING" })
      .where(eq(researchJobs.id, jobId));
    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher({ n: 0, urls: [] }));

    const afterRedelivery = await jobRow(jobId);
    expect(afterRedelivery.searchQueriesReserved).toBe(afterSearch.searchQueriesReserved);
    expect(afterRedelivery.sourceOpensReserved).toBe(afterFetch.sourceOpensReserved);
  });

  it("the extraction phase charges NOTHING for its replayed acquisition (D-137)", async () => {
    // Slice 2 recorded the opposite as a measured finding: the executor
    // reserved before every provider call and could not tell a replay
    // from a live one, so a phased job paid its acquisition budget twice.
    // D-137 settled it — the budget measures REAL external consumption,
    // and a replay provider declares that it performs none. This test is
    // the same measurement, now stating the corrected behaviour.
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);

    await handleSearchingPhase(roleCtx(ROLE_A), jobId, SEARCH_PROVIDERS());
    await handleFetchingPhase(roleCtx(ROLE_B), jobId, fixtureFetcher({ n: 0, urls: [] }));
    const beforeExtraction = await jobRow(jobId);
    expect(beforeExtraction.searchQueriesReserved).toBe(1);
    expect(beforeExtraction.sourceOpensReserved).toBe(1);

    await handleExtractingPhase(roleCtx(ROLE_A), jobId, () =>
      extractionExecutor(jobId, project, { extract: { n: 0 }, replayUrls: [] }),
    );

    const afterExtraction = await jobRow(jobId);
    // Unchanged on both acquisition axes: the extraction phase searched
    // nothing and opened nothing, so it owes nothing.
    expect(afterExtraction.searchQueriesReserved).toBe(beforeExtraction.searchQueriesReserved);
    expect(afterExtraction.sourceOpensReserved).toBe(beforeExtraction.sourceOpensReserved);
    // The model axis DID move: extraction is real model work, and D-137
    // did not make the extraction phase free.
    expect(afterExtraction.modelCostMicroReserved).toBeGreaterThan(
      beforeExtraction.modelCostMicroReserved,
    );
  });
});

describe("D-136 §8 — the offline queue end-to-end (item 11, 24)", () => {
  it(
    "11/24. two roles, three real pg-boss handoffs, one Proof, read back through S9",
    async () => {
      const project = await makeClassifiedProject();
      const jobId = await makePhasedJob(project.id);

      const counters = { extract: { n: 0 }, replayUrls: [] as string[] };
      const fetchCalls = { n: 0, urls: [] as string[] };
      const seen: string[] = [];

      // ROLE A — the model-side worker: SEARCHING and EXTRACTING.
      await ctx.boss.work<ResearchQueuePayload>(RESEARCH_QUEUE, async ([task]) => {
        if (task.data.jobId !== jobId) return;
        seen.push("SEARCHING");
        await handleSearchingPhase(roleCtx(ROLE_A), task.data.jobId, SEARCH_PROVIDERS());
      });
      await ctx.boss.work<ResearchQueuePayload>(RESEARCH_EXTRACT_QUEUE, async ([task]) => {
        if (task.data.jobId !== jobId) return;
        seen.push("EXTRACTING");
        await handleExtractingPhase(roleCtx(ROLE_A), task.data.jobId, () =>
          extractionExecutor(task.data.jobId, project, counters),
        );
      });

      // ROLE B — the source-side worker: FETCHING only. A different
      // process in production; here, a different capability set, which is
      // the only thing the domain is allowed to know about the difference.
      await ctx.boss.work<ResearchQueuePayload>(RESEARCH_FETCH_QUEUE, async ([task]) => {
        if (task.data.jobId !== jobId) return;
        seen.push("FETCHING");
        await handleFetchingPhase(roleCtx(ROLE_B), task.data.jobId, fixtureFetcher(fetchCalls));
      });

      // One admission, and then nothing but queue handoffs.
      expect(await beginAcquisitionPhases(ctx.db, ctx.boss, jobId)).toBe(true);

      await waitUntil(async () => (await countsFor(jobId)).proofs === 1, 60_000);

      // The three phases ran, in order, each on the role that owns it.
      expect(seen).toEqual(["SEARCHING", "FETCHING", "EXTRACTING"]);
      expect(await phaseOf(jobId)).toBe("EXTRACTING");

      // ONE interpretation-scoped job produced ONE Proof, and the network
      // was touched exactly once per capability: one fixture fetch in
      // phase 2, replays everywhere else.
      expect(fetchCalls.n).toBe(1);
      expect([...new Set(counters.replayUrls)]).toEqual([DOC_URL]);

      // S5, S6, S7 and S8 all ran, in the ordinary places.
      const [s5, s6, s7] = await Promise.all([
        ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId)),
        ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId)),
        ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId)),
      ]);
      expect(s5.length).toBeGreaterThan(0);
      expect(s6).toHaveLength(1);
      expect(s7).toHaveLength(1);

      // 24. S9 reads the resulting Proof with no phase-specific handling:
      // the same owner-scoped projection any other job goes through.
      const owner = (await jobRow(jobId)).userId;
      const view = await loadProofForJob(ctx.db, jobId, owner);
      expect(view).not.toBeNull();
      expect(view?.verdict).toBeTruthy();
      expect(view?.researchJobId).toBe(jobId);

      // First attempts only, all the way through a three-process journey.
      const attempts = await ctx.db
        .select()
        .from(researchAttempts)
        .where(eq(researchAttempts.researchJobId, jobId));
      expect(attempts.length).toBeGreaterThan(0);
      for (const a of attempts) expect(a.attemptNumber).toBe(1);

      // Operator visibility: the phase is readable, with its progress.
      const visible = await readAcquisitionPhase(ctx.db, jobId);
      expect(visible?.phase).toBe("EXTRACTING");
      expect(visible?.sealedDocuments).toBe(1);
      expect(visible?.at).toBeInstanceOf(Date);
    },
    90_000,
  );
});

describe("D-136 §9 — admission and boundaries (items 26, 27, 28, 29)", () => {
  it("26. the phased path changes no entitlement and does not enable public research", async () => {
    const rows = await ctx.db.execute(
      sql`SELECT key, value FROM product_config WHERE key IN ('research_enabled', 'internal_alpha_enabled')`,
    );
    const config = Object.fromEntries((rows.rows as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    // Untouched by this round: the phased architecture works underneath
    // the existing admission, it does not widen it.
    expect(config.research_enabled).toBe(false);
    expect(config.internal_alpha_enabled).toBe(false);

    // And a phased job carries the same frozen entitlement snapshot any
    // other job carries — the phase column adds nothing to it.
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    const job = await jobRow(jobId);
    expect(job.entitlementAtStart).toBe("ARI_CORE");
    expect(job.capabilityAtStart).toBe("FRESH_RESEARCH");
  });

  it("27. the single-process path is untouched: a job with no phase still runs it end to end", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makePhasedJob(project.id);
    // No beginAcquisitionPhases: this is an ordinary, unphased job.
    expect(await phaseOf(jobId)).toBeNull();
    const result = await handleResearchJobTask(ctx.db, jobId);
    expect(result).toEqual({ claimed: true });
    const job = await jobRow(jobId);
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(job.state);
    // Still unphased afterwards — the legacy path never sets a phase.
    expect(job.acquisitionPhase).toBeNull();
  });

  it("28/29. the orchestration names capabilities only — no network product, no project", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/server/jobs/worker-capabilities.ts",
      "src/server/jobs/acquisition-phase-worker.ts",
      "src/server/jobs/queue.ts",
      "src/server/engine/acquisition-phases.ts",
      "src/server/engine/job-contract-view.ts",
    ];
    const forbidden = [
      "mantaray",
      "vpn",
      "proxy",
      "wireguard",
      "openvpn",
      "exit node",
      "geo",
      "region",
      "country",
      "raydium",
      "pump_fun",
      "brave",
      "anthropic",
    ];
    for (const file of files) {
      // Comments are stripped before the check, exactly as Slice 1's own
      // boundary test does it: the invariant is about what the CODE
      // knows. A comment that explains the invariant is documentation of
      // the rule, not a violation of it.
      const code = (await readFile(file, "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const word of forbidden) {
        expect(code, `${file} must not name ${word}`).not.toContain(word);
      }
    }
  });

  it("the orchestration owns no attempt lifecycle and no projection of its own", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/server/jobs/acquisition-phase-worker.ts", "utf-8");
    // It may CALL run-job (the existing controller entrypoint), but it
    // must not touch attempts, the controller, or any S5-S9 store itself.
    expect(source).not.toContain("researchAttempts");
    expect(source).not.toContain("runResearchController");
    expect(source).not.toContain("reconcileAndPersistComponent");
    expect(source).not.toContain("buildAndPersistProof");
    expect(source).not.toContain("evaluateAndPersistClaimSupport");
    expect(source).toContain("runS4ResearchJob");
  });
});
