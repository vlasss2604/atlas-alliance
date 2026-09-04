import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  acquiredDocuments,
  projects,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import { runFetchPhase, runSearchPhase } from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import {
  CONTENT_FETCH_FAILURE_REASONS,
  ContentFetchError,
} from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { ComponentTarget, FetchedDocument } from "../src/server/engine/providers/types";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-143 — A FETCH FAILURE THAT CAN STILL BE READ TOMORROW.
//
// A real run failed 17 of 25 targets, every one recorded as
// FETCH_FAILED / PROVIDER_ERROR, and the trace could not say whether that
// was a blocked address, a DNS failure, a timeout or a reset connection.
// The provider had classified each one; runFetchPhase discarded the typed
// error in a bare `catch {}`.
//
// The canonical vocabulary is unchanged — PROVIDER_ERROR remains the one
// public reason for "the provider call failed". The diagnostic sits
// beside it, carries ONLY the provider's own closed codes, and is null
// for anything else.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const TARGET = "https://docs.example-project.test/mechanism";

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
    contentType: "text/markdown",
    normalizedText: "Protocol fees are used to buy back the token.",
    contentHash: "sha256:fixture",
    fetchedAt: new Date("2026-08-30T00:00:00Z"),
    byteLength: 120,
  };
}

async function makeProject() {
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("d143"), name: "D143 Fixture", status: "ACTIVE_CORE" })
    .returning();
  return p;
}

async function makeJob(projectId: string): Promise<string> {
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
      originalQuestion: "q",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

function targetFor(project: { id: string; name: string; slug: string }) {
  return (item: ComponentWorkItem): ComponentTarget => ({
    step: item.step,
    stepName: item.stepName,
    component: item.component,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });
}

// One search pass so the fetch phase has a real persisted target, then a
// fetch pass with the supplied transport.
async function runWithFetcher(contentFetcher: ContentFetcher) {
  const project = await makeProject();
  const jobId = await makeJob(project.id);
  const { view } = await loadJobContractView(ctx.db, jobId);
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue.slice(0, 1),
    target: targetFor(project),
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        return Array.from({ length: input.maxQueries }, (_, i) => `q-${i + 1}`);
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search() {
        return [{ url: TARGET, title: null, snippet: null }];
      },
    },
    maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
    maxResultsPerQuery: 5,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });

  const result = await runFetchPhase({
    db: ctx.db,
    jobId,
    projectId: project.id,
    contentFetcher,
    maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
  });
  return { project, jobId, result };
}

async function fetchRows(jobId: string) {
  return ctx.db
    .select({
      op: researchTraceEvents.operationType,
      status: researchTraceEvents.status,
      reason: researchTraceEvents.reasonCode,
      diagnostic: researchTraceEvents.diagnosticCode,
      target: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
}

function failingFetcher(error: unknown): ContentFetcher {
  return {
    name: "failing-transport",
    async fetch(): Promise<FetchedDocument> {
      throw error;
    },
  };
}

describe("D-143 — a typed fetch failure keeps its category", () => {
  // The three cases the real incident could not distinguish, driven
  // through the actual phase rather than a hand-written row.
  for (const reason of ["NETWORK_ERROR", "DNS_RESOLUTION_FAILED", "BLOCKED_ADDRESS"] as const) {
    it(`${reason} → FETCH_FAILED / PROVIDER_ERROR / diagnosticCode ${reason}`, async () => {
      const { jobId } = await runWithFetcher(
        // The message deliberately carries operational noise ("read
        // ECONNRESET" is what the real probe produced) so the test proves
        // it is NOT what gets stored.
        failingFetcher(new ContentFetchError(reason, "read ECONNRESET", TARGET)),
      );
      const failed = (await fetchRows(jobId)).filter((r) => r.op === "FETCH_FAILED");
      // D-146: NETWORK_ERROR now also earns a bounded fallback, so one
      // url may record several failed attempts. Every one of them must
      // still carry the canonical reason and its own category, and the
      // FIRST is always the direct transport.
      expect(failed.length).toBeGreaterThanOrEqual(1);
      for (const row of failed) {
        expect(row.status).toBe("FAILED");
        expect(row.reason).toBe("PROVIDER_ERROR");
        expect(row.diagnostic).toBe(reason);
      }
    });
  }

  it("D. an untyped error records PROVIDER_ERROR with a null diagnostic", async () => {
    const { jobId } = await runWithFetcher(failingFetcher(new Error("read ECONNRESET")));
    const failed = (await fetchRows(jobId)).filter((r) => r.op === "FETCH_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe("PROVIDER_ERROR");
    expect(failed[0].diagnostic).toBeNull();
  });

  it("E. a successful fetch carries no failure diagnostic", async () => {
    const { jobId } = await runWithFetcher({
      name: "fixture-transport",
      async fetch(url: string) {
        return doc(url);
      },
    });
    const rows = await fetchRows(jobId);
    const ok = rows.filter((r) => r.op === "FETCH_OK");
    expect(ok).toHaveLength(1);
    expect(ok[0].diagnostic).toBeNull();
    // No row of any kind acquired a diagnostic on the success path.
    for (const r of rows) expect(r.diagnostic).toBeNull();
    // ...and the document was still sealed normally.
    const docs = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(docs).toHaveLength(1);
  });
});

describe("D-143 — the diagnostic can only ever hold a code-owned category", () => {
  it("a forged look-alike error cannot smuggle text into the column", async () => {
    // Same shape as ContentFetchError, but not the class: the first gate
    // (instanceof) rejects it, so the diagnostic is null rather than
    // whatever `reason` claimed.
    const forged = { name: "ContentFetchError", reason: "read ECONNRESET at 10.0.0.1", url: TARGET };
    const { jobId } = await runWithFetcher(failingFetcher(forged));
    const failed = (await fetchRows(jobId)).filter((r) => r.op === "FETCH_FAILED");
    expect(failed[0].reason).toBe("PROVIDER_ERROR");
    expect(failed[0].diagnostic).toBeNull();
  });

  it("the writer re-checks membership even when the type system is bypassed", async () => {
    // Second, independent gate: recordTraceEvent is called directly with a
    // value that is not in the closed set. It must be dropped, not stored.
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "FETCH_FAILED",
      providerKind: "FETCH",
      providerName: "x",
      targetRef: TARGET,
      status: "FAILED",
      reasonCode: "PROVIDER_ERROR",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      diagnosticCode: "read ECONNRESET; host=10.0.0.1" as any,
    });
    const [row] = (await fetchRows(jobId)).filter((r) => r.op === "FETCH_FAILED");
    expect(row.diagnostic).toBeNull();
  });

  it("every value the phase can produce is a member of the provider's own set", () => {
    // The diagnostic taxonomy is not a second vocabulary: it IS the
    // provider's closed reason set, nothing added.
    expect([...CONTENT_FETCH_FAILURE_REASONS]).toContain("NETWORK_ERROR");
    expect([...CONTENT_FETCH_FAILURE_REASONS]).toContain("DNS_RESOLUTION_FAILED");
    expect([...CONTENT_FETCH_FAILURE_REASONS]).toContain("BLOCKED_ADDRESS");
    expect([...CONTENT_FETCH_FAILURE_REASONS]).toContain("REDIRECT_TARGET_BLOCKED");
    expect([...CONTENT_FETCH_FAILURE_REASONS]).toContain("TIMEOUT");
    expect([...CONTENT_FETCH_FAILURE_REASONS]).toContain("HTTP_ERROR");
  });
});

describe("D-143 — boundaries (F, G, H)", () => {
  it("F. the column is additive: existing rows and readers are unaffected", async () => {
    // Every trace row this suite did NOT write a diagnostic for reads as
    // null, which is exactly how a historical row reads.
    const { jobId } = await runWithFetcher({
      name: "fixture-transport",
      async fetch(url: string) {
        return doc(url);
      },
    });
    const rows = await fetchRows(jobId);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.diagnostic !== null)).toHaveLength(0);

    // The migration is additive and nullable — no default, no backfill.
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(
      "src/server/db/migrations/0036_d143_fetch_diagnostic_code.sql",
      "utf-8",
    );
    expect(sql).toContain('ADD COLUMN "diagnostic_code" text');
    expect(sql.toUpperCase()).not.toContain("NOT NULL");
    expect(sql.toUpperCase()).not.toContain("DEFAULT");
    expect(sql.toUpperCase()).not.toContain("UPDATE ");
  });

  it("G. phase behaviour and idempotency are unchanged by the diagnostic", async () => {
    const { jobId, project, result } = await runWithFetcher(
      failingFetcher(new ContentFetchError("NETWORK_ERROR", "read ECONNRESET", TARGET)),
    );
    expect(result.failedUrls).toEqual([TARGET]);
    expect(result.sealedDocumentIds).toEqual([]);
    const firstDeliveryFailures = (await fetchRows(jobId)).filter(
      (r) => r.op === "FETCH_FAILED",
    ).length;
    expect(firstDeliveryFailures).toBeGreaterThanOrEqual(1);

    // A redelivery still opens nothing for THIS url: every strategy the
    // failure class permitted has already been attempted and persisted,
    // and D-146 never repeats a strategy for a url.
    const again = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: failingFetcher(new ContentFetchError("TIMEOUT", "x", TARGET)),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });
    expect(again.sealedDocumentIds).toEqual([]);
    expect(again.failedUrls).toEqual([]);
    // The redelivery made no external call at all: the url is reported as
    // exhausted rather than re-attempted.
    expect(again.strategyAttempts).toEqual([]);
    expect(again.exhaustedUrls).toEqual([TARGET]);
    // ...so the second delivery wrote no new diagnostic rows: the row
    // count is whatever the FIRST delivery produced, unchanged.
    const failed = (await fetchRows(jobId)).filter((r) => r.op === "FETCH_FAILED");
    expect(failed.length).toBe(firstDeliveryFailures);
    for (const row of failed) expect(row.diagnostic).toBe("NETWORK_ERROR");
  });

  it("H. no project, domain, VPN or network-product name enters the diagnostic path", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["src/server/engine/trace-store.ts", "src/server/engine/acquisition-phases.ts"]) {
      const code = (await readFile(file, "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const word of ["mantaray", "vpn", "raydium", "docs.raydium", "econnreset", "proxy"]) {
        expect(code, `${file} must not name ${word}`).not.toContain(word);
      }
    }
  });
});
