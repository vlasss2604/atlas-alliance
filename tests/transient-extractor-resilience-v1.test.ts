import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projects,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError } from "../src/server/engine/providers/evidence-extractor";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import { ModelInputOversizedError, TokenCountUnavailableError } from "../src/server/engine/providers/token-gate";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// TRANSIENT EXTRACTOR RESILIENCE V1 — option C through the caller-decides
// seam. The live run 06ade56b died as SYSTEM_OR_PROVIDER_FAILURE on ONE
// document's NETWORK_NO_RESPONSE at its first component — the second
// document, after the first had extracted OK; its two FAILED
// MODEL_CALL_ATTEMPTED rows said only PROVIDER_ERROR. These tests pin the
// approved rule with fixture extractors and no provider call:
//
//   - per document, at most 2 generation calls (unchanged);
//   - a document that exhausts that allowance is a document-local
//     EXTRACT_FAILED carrying the typed diagnostic_code, never Evidence,
//     never a contradiction, and the attempt moves on;
//   - N = 2 consecutive such documents, with no successful extraction
//     between them, is CapabilityFatalError exactly as before;
//   - a successful extraction resets the count to 0;
//   - COUNT_TOKENS and configuration failures stay immediately fatal.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-12T00:00:00Z");

type Job = { jobId: string; projectId: string; projectName: string; projectSlug: string };

async function makeJob(): Promise<Job> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("txres");
  const name = "Transient Resilience Test Project";
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: t.id,
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return { jobId: job.id, projectId: project.id, projectName: name, projectSlug: slug };
}

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

function ctxFor(jobId: string) {
  return {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro: 1_000_000 },
  };
}

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

function doc(url: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "Transient Resilience Test Project: the protocol fee accrues directly to the treasury contract",
    contentHash: `sha256:${url}`,
    fetchedAt: NOW,
    byteLength: 200,
  };
}

function validFact(): ExtractedFact {
  return {
    step: 1,
    component: "SOURCE_OF_VALUE",
    statement: "protocol fee accrues to the treasury",
    supportFragment: "the protocol fee accrues directly to the treasury contract",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
  };
}

const U = (n: number) => `https://example.com/doc-${n}`;

function search(urls: string[]): SearchGateway {
  return {
    name: "fixture",
    async search(query) {
      return urls.map((url) => ({ url, title: `result for ${query}`, snippet: "a search snippet, never evidence" }));
    },
  };
}

function fetcher(urls: string[]): ContentFetcher {
  return {
    name: "fixture",
    async fetch(url) {
      if (!urls.includes(url)) throw new ContentFetchError("HTTP_ERROR", "not found in fixture", url);
      return doc(url);
    },
  };
}

const proposer: QueryProposer = { name: "fixture", async proposeQueries() { return ["q1"]; } };

// The same typed error the real extractor throws for the SDK's own
// no-response class: transient, diagnostic NETWORK_NO_RESPONSE, no status.
function networkNoResponse(): EvidenceExtractorUnavailableError {
  return new EvidenceExtractorUnavailableError("simulated no response", true, "NETWORK_NO_RESPONSE", null);
}

// A scripted extractor: `plan` maps a document url to what EVERY call for
// that document does. Records the per-document call count so "no extra
// retry" is provable, not assumed.
type DocBehaviour = "TRANSIENT" | "OK" | "PERMANENT_403" | "OVERSIZED" | "COUNT_TOKENS_DOWN";
function scripted(plan: Record<string, DocBehaviour>) {
  const calls = new Map<string, number>();
  const extractor: EvidenceExtractor = {
    name: "fixture",
    async extract(input) {
      const url = input.document.finalUrl;
      calls.set(url, (calls.get(url) ?? 0) + 1);
      switch (plan[url]) {
        case "OK":
          return [validFact()];
        case "TRANSIENT":
          throw networkNoResponse();
        case "PERMANENT_403":
          throw new EvidenceExtractorUnavailableError("simulated 403", false, "PERMISSION_DENIED", 403);
        case "OVERSIZED":
          throw new ModelInputOversizedError(99_999, 8_000);
        case "COUNT_TOKENS_DOWN":
          throw new TokenCountUnavailableError("simulated count_tokens outage", true, "NETWORK_NO_RESPONSE", null);
        default:
          throw new Error(`unscripted document ${url}`);
      }
    },
  };
  return { extractor, calls: (url: string) => calls.get(url) ?? 0, totalCalls: () => [...calls.values()].reduce((a, b) => a + b, 0) };
}

function executorFor(p: Job, urls: string[], extractor: EvidenceExtractor) {
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    queryProposer: proposer,
    searchGateway: search(urls),
    contentFetcher: fetcher(urls),
    evidenceExtractor: extractor,
  });
}

async function trace(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return [...rows].sort((a, b) => a.sequence - b.sequence);
}

async function evidenceRows(jobId: string) {
  return ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
}

describe("transient extractor resilience — one document is local, two consecutive are fatal", () => {
  it("1. one document transiently fails twice: not fatal, EXTRACT_FAILED persists NETWORK_NO_RESPONSE, the next candidate is reached and yields Evidence", async () => {
    const p = await makeJob();
    const urls = [U(1), U(2)];
    const s = scripted({ [U(1)]: "TRANSIENT", [U(2)]: "OK" });
    const result = await executorFor(p, urls, s.extractor).execute(ITEM, ctxFor(p.jobId));

    // Research did NOT become job-fatal; the later candidate carried it.
    expect(result.status).toBe("SUCCEEDED");
    expect(s.calls(U(1))).toBe(2); // the unchanged allowance, no third call
    expect(s.calls(U(2))).toBe(1);
    expect((await evidenceRows(p.jobId)).map((e) => e.retrievedUrl)).toEqual([U(2)]);

    const rows = await trace(p.jobId);
    const forDoc1 = rows.filter((r) => r.targetRef === U(1));
    expect(forDoc1.filter((r) => r.operationType === "EXTRACT_ATTEMPTED")).toHaveLength(2);
    // Both FAILED attempt rows carry the typed code — the proven gap.
    const failedCalls = forDoc1.filter((r) => r.operationType === "MODEL_CALL_ATTEMPTED" && r.status === "FAILED");
    expect(failedCalls).toHaveLength(2);
    for (const r of failedCalls) {
      expect(r.reasonCode).toBe("PROVIDER_ERROR");
      expect(r.diagnosticCode).toBe("NETWORK_NO_RESPONSE");
    }
    // And so does the document's terminal local row.
    const failed = forDoc1.filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("FAILED");
    expect(failed[0].reasonCode).toBe("PROVIDER_ERROR");
    expect(failed[0].diagnosticCode).toBe("NETWORK_NO_RESPONSE");
    // No Evidence and no contradiction for the failed document.
    expect(forDoc1.filter((r) => r.operationType === "EXTRACT_OK")).toHaveLength(0);
    expect(result.reason).not.toContain("CONTRADICTED");
  });

  it("2. a successful extraction followed by one failed document: prior Evidence stays, the attempt succeeds, and the counter stands at 1 (the next failing document is the fatal one)", async () => {
    const p = await makeJob();
    {
      const urls = [U(1), U(2)];
      const s = scripted({ [U(1)]: "OK", [U(2)]: "TRANSIENT" });
      const result = await executorFor(p, urls, s.extractor).execute(ITEM, ctxFor(p.jobId));
      expect(result.status).toBe("SUCCEEDED");
      expect(s.calls(U(2))).toBe(2);
      expect((await evidenceRows(p.jobId)).map((e) => e.retrievedUrl)).toEqual([U(1)]);
      const failed = (await trace(p.jobId)).filter((r) => r.operationType === "EXTRACT_FAILED" && r.targetRef === U(2));
      expect(failed).toHaveLength(1);
      expect(failed[0].diagnosticCode).toBe("NETWORK_NO_RESPONSE");
    }
    // The counter is observable only through what it does: on the same
    // executor, the very next document exhausting its retry is the second
    // consecutive one, so the job is fatal — proving the count was 1, not 0.
    {
      const p2 = await makeJob();
      const urls = [U(1), U(2), U(3)];
      const s = scripted({ [U(1)]: "OK", [U(2)]: "TRANSIENT", [U(3)]: "TRANSIENT" });
      await expect(executorFor(p2, urls, s.extractor).execute(ITEM, ctxFor(p2.jobId))).rejects.toBeInstanceOf(CapabilityFatalError);
      expect(s.calls(U(2))).toBe(2);
      expect(s.calls(U(3))).toBe(2);
      // The Evidence extracted before the outage is persisted, never deleted.
      expect((await evidenceRows(p2.jobId)).map((e) => e.retrievedUrl)).toEqual([U(1)]);
    }
  });

  it("3. two different consecutive documents each exhaust the retry: CapabilityFatalError('EVIDENCE_EXTRACTOR') naming NETWORK_NO_RESPONSE, both documents' rows persisted, no third document touched", async () => {
    const p = await makeJob();
    const urls = [U(1), U(2), U(3)];
    const s = scripted({ [U(1)]: "TRANSIENT", [U(2)]: "TRANSIENT", [U(3)]: "OK" });
    const outcome = executorFor(p, urls, s.extractor).execute(ITEM, ctxFor(p.jobId));
    await expect(outcome).rejects.toBeInstanceOf(CapabilityFatalError);
    await outcome.catch((e: CapabilityFatalError) => {
      expect(e.capability).toBe("EVIDENCE_EXTRACTOR");
      expect(e.message).toBe(
        "capability unavailable: EVIDENCE_EXTRACTOR — EVIDENCE_EXTRACTOR_FAILED:EvidenceExtractorUnavailableError:NETWORK_NO_RESPONSE",
      );
    });
    expect(s.calls(U(1))).toBe(2);
    expect(s.calls(U(2))).toBe(2);
    expect(s.calls(U(3))).toBe(0);
    expect(s.totalCalls()).toBe(4);
    const rows = await trace(p.jobId);
    const failedCalls = rows.filter((r) => r.operationType === "MODEL_CALL_ATTEMPTED" && r.status === "FAILED");
    expect(failedCalls).toHaveLength(4);
    expect(failedCalls.every((r) => r.diagnosticCode === "NETWORK_NO_RESPONSE")).toBe(true);
    // Both documents have their own EXTRACT_FAILED row with the code.
    const failed = rows.filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed.map((r) => r.targetRef)).toEqual([U(1), U(2)]);
    expect(failed.every((r) => r.diagnosticCode === "NETWORK_NO_RESPONSE")).toBe(true);
    expect(await evidenceRows(p.jobId)).toHaveLength(0);
  });

  it("3b. job level: the same shape still ends as FAILED / SYSTEM_OR_PROVIDER_FAILURE / CapabilityFatalError with no S7 conclusion", async () => {
    const p = await makeJob();
    const urls = [U(1), U(2)];
    const s = scripted({ [U(1)]: "TRANSIENT", [U(2)]: "TRANSIENT" });
    const result = await handleResearchJobTask(ctx.db, p.jobId, executorFor(p, urls, s.extractor));
    expect(result.claimed).toBe(true);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId));
    expect(job.state).toBe("FAILED");
    expect(job.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(job.errorCode).toBe("CapabilityFatalError");
    expect(await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, p.jobId))).toHaveLength(0);
    expect(s.totalCalls()).toBe(4);
  });

  it("3c. consecutive spans attempts of one job run: an attempt whose only document failed, then the next attempt's first document failing, is two consecutive documents — and a fresh executor instance starts at 0", async () => {
    const p = await makeJob();
    const s = scripted({ [U(1)]: "TRANSIENT" });
    // One executor instance = one job run, exactly as worker.ts builds it.
    const executor = executorFor(p, [U(1)], s.extractor);
    // Attempt 1: its only document exhausts the retry -> local FAILED.
    const a = await executor.execute(ITEM, ctxFor(p.jobId));
    expect(a.status).toBe("FAILED");
    expect(a.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(a.reason).toContain("EXTRACT_FAILED:NETWORK_NO_RESPONSE");
    // Attempt 2 on the SAME instance: its first document is the second
    // consecutive one with no success between -> fatal.
    await expect(
      executor.execute({ ...ITEM, component: "MECHANISM_SPEC" }, { ...ctxFor(p.jobId), attemptNumber: 2 }),
    ).rejects.toBeInstanceOf(CapabilityFatalError);
    expect(s.calls(U(1))).toBe(4);
    // A NEW instance (a different job run) carries nothing over: the same
    // single failing document is local again.
    const fresh = executorFor(p, [U(1)], s.extractor);
    const b = await fresh.execute({ ...ITEM, component: "CURRENT_STATE" }, { ...ctxFor(p.jobId), attemptNumber: 3 });
    expect(b.status).toBe("FAILED");
    expect(s.calls(U(1))).toBe(6);
  });

  it("4. success between two failed documents resets the counter: no false capability-fatal outcome", async () => {
    const p = await makeJob();
    const urls = [U(1), U(2), U(3)];
    const s = scripted({ [U(1)]: "TRANSIENT", [U(2)]: "OK", [U(3)]: "TRANSIENT" });
    const result = await executorFor(p, urls, s.extractor).execute(ITEM, ctxFor(p.jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(s.calls(U(1))).toBe(2);
    expect(s.calls(U(2))).toBe(1);
    expect(s.calls(U(3))).toBe(2);
    expect((await evidenceRows(p.jobId)).map((e) => e.retrievedUrl)).toEqual([U(2)]);
    const failed = (await trace(p.jobId)).filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed.map((r) => r.targetRef)).toEqual([U(1), U(3)]);
  });

  it("4b. only a SUCCESSFUL extraction resets: a permanent document-local failure between two transient documents does not", async () => {
    const p = await makeJob();
    const urls = [U(1), U(2), U(3)];
    const s = scripted({ [U(1)]: "TRANSIENT", [U(2)]: "PERMANENT_403", [U(3)]: "TRANSIENT" });
    await expect(executorFor(p, urls, s.extractor).execute(ITEM, ctxFor(p.jobId))).rejects.toBeInstanceOf(CapabilityFatalError);
    expect(s.calls(U(1))).toBe(2);
    expect(s.calls(U(2))).toBe(1); // permanent: never retried, as before
    expect(s.calls(U(3))).toBe(2);
  });

  it("5. permanent document-local failures remain local, single-call, and never count toward the fatal threshold", async () => {
    const p = await makeJob();
    const urls = [U(1), U(2), U(3)];
    const s = scripted({ [U(1)]: "PERMANENT_403", [U(2)]: "OVERSIZED", [U(3)]: "PERMANENT_403" });
    const result = await executorFor(p, urls, s.extractor).execute(ITEM, ctxFor(p.jobId));
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(result.reason).toContain("EXTRACT_FAILED:PERMISSION_DENIED:403");
    expect(s.totalCalls()).toBe(3);
    const rows = await trace(p.jobId);
    const failed = rows.filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed.map((r) => [r.reasonCode, r.diagnosticCode])).toEqual([
      ["PROVIDER_ERROR", "PERMISSION_DENIED:403"],
      ["MODEL_INPUT_OVERSIZED", null],
      ["PROVIDER_ERROR", "PERMISSION_DENIED:403"],
    ]);
    expect(await evidenceRows(p.jobId)).toHaveLength(0);
  });

  it("6. COUNT_TOKENS unavailable stays immediately fatal on the FIRST document: one call, EVIDENCE_EXTRACTOR_COUNT_TOKENS, the next document never touched", async () => {
    const p = await makeJob();
    const urls = [U(1), U(2)];
    const s = scripted({ [U(1)]: "COUNT_TOKENS_DOWN", [U(2)]: "OK" });
    const outcome = executorFor(p, urls, s.extractor).execute(ITEM, ctxFor(p.jobId));
    await expect(outcome).rejects.toBeInstanceOf(CapabilityFatalError);
    await outcome.catch((e: CapabilityFatalError) => {
      expect(e.capability).toBe("EVIDENCE_EXTRACTOR_COUNT_TOKENS");
    });
    expect(s.calls(U(1))).toBe(1);
    expect(s.calls(U(2))).toBe(0);
    const rows = await trace(p.jobId);
    const failedCalls = rows.filter((r) => r.operationType === "MODEL_CALL_ATTEMPTED" && r.status === "FAILED");
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0].diagnosticCode).toBe("NETWORK_NO_RESPONSE");
    // Not a document-local failure: no EXTRACT_FAILED row is written for it.
    expect(rows.filter((r) => r.operationType === "EXTRACT_FAILED")).toHaveLength(0);
  });

  // 6b. Configuration failures (missing exact role/model cost profile,
  // missing credential, unresolvable provider configuration) are preflight
  // CapabilityFatalError BEFORE any document exists — pinned unchanged by
  // tests/s10-final-pre-smoke-closure.test.ts (HIGH-2 A-F) and
  // tests/phase6-s4-executor.test.ts; nothing in this change touches
  // preflight, so those suites are the regression, not a copy here.

  it("8. job level: the first document of the run fails transiently, nothing else yields facts -> a FAILED attempt (BLOCKED coverage), zero Evidence, never a CONTRADICTED component, never a provider-fatal job", async () => {
    const p = await makeJob();
    // Scripted by call order, since every component searches the same
    // fixture url: the first document's two calls fail transiently (its
    // full allowance), every later extraction answers with no facts.
    let calls = 0;
    const extractor: EvidenceExtractor = {
      name: "fixture",
      async extract() {
        calls += 1;
        if (calls <= 2) throw networkNoResponse();
        return [];
      },
    };
    const result = await handleResearchJobTask(ctx.db, p.jobId, executorFor(p, [U(1)], extractor));
    expect(result.claimed).toBe(true);

    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, p.jobId));
    // Not a provider-fatal job: it ran on past the failed document.
    expect(job.terminationReason).not.toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(job.errorCode).not.toBe("CapabilityFatalError");
    expect(calls).toBeGreaterThan(2); // later candidates/attempts were reached

    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, p.jobId));
    const failed = attempts.filter((a) => a.status === "FAILED");
    // Exactly the one attempt whose only document failed is FAILED, and
    // it names the extractor and the typed code. With no SUCCEEDED attempt
    // for that component its coverage is BLOCKED (audit-projection-store's
    // rule), which the reader sees as TECHNICAL — a fact about the run.
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(failed[0].reason).toContain("EXTRACT_FAILED:NETWORK_NO_RESPONSE");
    expect(attempts.some((a) => a.patternStep === failed[0].patternStep && a.component === failed[0].component && a.status === "SUCCEEDED")).toBe(false);

    expect(await evidenceRows(p.jobId)).toHaveLength(0);
    // Missing Evidence is never a contradiction.
    const components = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, p.jobId));
    expect(components.length).toBeGreaterThan(0);
    expect(components.some((c) => c.status === "CONTRADICTED")).toBe(false);
    const claims = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, p.jobId));
    expect(claims.some((c) => c.status === "CONTRADICTED")).toBe(false);
  });
});
