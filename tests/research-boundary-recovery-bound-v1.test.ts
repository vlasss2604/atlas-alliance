import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { interpretations, projects, proofs, researchAttempts, researchClaimSupport, researchComponentResults, topics, users } from "../src/server/db/schema";
import { loadFetchTargets, runFetchPhase } from "../src/server/engine/acquisition-phases";
import { generateAuditProjectionSafely } from "../src/server/engine/audit-projection-store";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { PATTERN_V1_CONTENT, criticalComponentsFor } from "../src/server/domain/pattern";
import { buildProof } from "../src/server/engine/proof-builder";
import { buildAndPersistProof } from "../src/server/engine/proof-store";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { generateQuestionProjectionSafely } from "../src/server/engine/question-projection-store";
import { deriveResearchBoundary, KNOWN_PATHS_UNEXPLORED, RECOVERY_BOUND_REACHED, technicalCodeForAttemptHead, type ResearchBoundary } from "../src/server/engine/research-boundary";
import type { ClaimReasonCode, ClaimRequirementResult, ClaimSupportStatus, MechanismGapRef } from "../src/server/engine/claim-evaluator";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { auditRemainingKnownPaths, TARGETED_RECOVERY_BOUNDS } from "../src/server/engine/targeted-recovery";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH RELIABILITY V1 — FINAL OFFLINE ACCEPTANCE: THE BOUNDARY INVARIANT.
//
// A Research that stops must let a later reader tell, from the persisted
// Proof alone and without any model:
//
//   A. SUBSTANTIVE EXHAUSTION — every known admissible path was attempted
//      and the evidence still did not establish the component: "we looked
//      and could not establish it";
//   B. TECHNICAL / BOUNDED EXHAUSTION — a known admissible path was still
//      open when the configured bounded Research stopped (the one recovery
//      spent its opens / extractions; a route had no admissible
//      configuration; a provider failed): "the research limit was reached
//      before every relevant path was exhausted".
//
// `proofs.bounded_by` (A2) carries the split. This file pins the one
// addition the acceptance audit required: an unresolved critical
// component with known paths still open after its one bounded recovery
// used to read as substantive (its recovery closed "nothing traceable",
// S5 said NO_EVIDENCE_FOUND / STALE_CURRENT_STATE), indistinguishable
// from A. It now carries RECOVERY_BOUND_REACHED — or
// KNOWN_PATHS_UNEXPLORED when no recovery ever ran — with the remaining
// paths by kind. Verdict and confidence are untouched.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const HOST = "docs.boundary-invariant.test";
const SENTENCE = "Protocol fees are used to buy back the token and bought-back tokens are held at a public address.";
const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
const GENEROUS_BUDGET = { ...INTERNAL_ALPHA_V1, maxSearchQueries: 40, maxSourceOpens: 60, reservedRecoverySteps: 1 };
const INTENT = "PROTOCOL_REVENUE_TO_TOKEN";
const CRITICAL = new Set(criticalComponentsFor(PATTERN_V1_CONTENT, INTENT));
const DAY_MS = 24 * 3600 * 1000;

function ownUrls(component: string, query: string): string[] {
  const slug = component.toLowerCase().replace(/_/g, "-");
  const n = query.endsWith("mechanism") ? 1 : 2;
  return [`https://${HOST}/mechanism/${slug}-${n}`, `https://${HOST}/mechanism/${slug}-${n}-b`];
}
const OVERVIEW = `https://${HOST}/mechanism/overview`;
function fixtureDoc(url: string): FetchedDocument {
  const text = `${SENTENCE} Details for ${url}.`;
  return { finalUrl: url, requestedUrl: url, httpStatus: 200, contentType: "text/markdown", normalizedText: text, contentHash: `sha256:${url}`, fetchedAt: new Date(), byteLength: text.length };
}
function fact(step: number, component: string, ageDays: number): ExtractedFact {
  return { step, component, statement: SENTENCE, supportFragment: SENTENCE, mechanismState: "LIVE", directness: "DIRECT", publishedAt: new Date(Date.now() - ageDays * DAY_MS), doesNotProve: "does not establish that any buyback executed", relationship: "SUPPORTS", onchainLocator: null, onchainLocators: null };
}
const fresh = (step: number, component: string) => fact(step, component, 1);
const stale = (step: number, component: string) => fact(step, component, 400);

async function makeProject(opts: { confirmedRoute: boolean } = { confirmedRoute: true }) {
  const slug = uniq("bi");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Boundary Invariant", status: "ACTIVE_CORE" }).returning();
  if (opts.confirmedRoute) {
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/mechanism" });
    if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  }
  return { id: project.id, name: project.name, slug };
}

async function makeJob(project: { id: string; slug: string }, budget = GENEROUS_BUDGET): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const question = "does protocol revenue buy back the token, and where does it go?";
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: { level: "ARI_CORE", capability: "FRESH_RESEARCH", budget },
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await ctx.db.insert(interpretations).values({
    userId: user.id,
    researchJobId: job.id,
    originalQuestion: question,
    status: "READY",
    result: {
      status: "READY",
      project_or_asset: project.slug,
      related_entities: [],
      topic: null,
      task_type: "VERIFY_MECHANISM",
      research_task: question,
      understood_summary: null,
      user_assumptions: [],
      ambiguities: [],
      clarification_question: null,
      route: "DEEP_RESEARCH",
      normalized_intent: INTENT,
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

function executor(
  project: { id: string; name: string; slug: string },
  opts: {
    search: (query: string, component: string) => string[];
    fetch?: (url: string) => FetchedDocument;
    extract: (url: string, step: number, component: string) => ExtractedFact[];
  },
) {
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        return [`${input.target.component} mechanism`, `${input.target.component} tokenomics`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query, target) {
        return opts.search(query, target.component).map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture-transport",
      async fetch(url: string) {
        return (opts.fetch ?? fixtureDoc)(url);
      },
    },
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        return opts.extract(input.document.finalUrl, input.target.step, input.target.component);
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: "DOCUMENTARY_ONLY",
  });
}

const searchOwn = (query: string, component: string) => ownUrls(component, query.replace(/^site:\S+\s+/, ""));

async function proofOf(jobId: string) {
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  expect(proof).toBeDefined();
  return { proof, bounded: proof.boundedBy as ResearchBoundary };
}
async function attemptsOf(jobId: string) {
  return ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
}
async function s5Of(jobId: string) {
  const rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  return new Map(rows.map((r) => [r.component, r]));
}
const entryFor = (side: ResearchBoundary["technical"], component: string) => side.find((e) => e.component === component) ?? null;

/* ------------------------------------------------------------------ */
/* 1 + 5. RECOVERY EXHAUSTED, KNOWN PATHS REMAIN → TECHNICAL MARKER    */
/* ------------------------------------------------------------------ */

describe("B — bounded exhaustion: an unresolved critical component with known paths still open after its one recovery carries a technical marker", () => {
  it("stale/excluded Evidence on every read + recovery spent + sealed route documents unread → RECOVERY_BOUND_REACHED with the remaining paths; the stale finding stays on the substantive side; verdict and confidence unchanged by the marker", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      executor(project, {
        search: searchOwn,
        // Every page yields only a stale observation for CURRENT_STATE and
        // a fresh one for everything else: CURRENT_STATE is excluded at
        // S5 on every read, and after its one recovery (three
        // extractions) the other components' sealed pages remain unread
        // for it.
        extract: (_url, step, component) => (component === "CURRENT_STATE" ? [stale(step, component)] : [fresh(step, component)]),
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const att = await attemptsOf(jobId);
    expect(att.filter((a) => a.component === "CURRENT_STATE").map((a) => a.attemptNumber).sort()).toEqual([1, 2]);
    const s5 = await s5Of(jobId);
    expect(s5.get("CURRENT_STATE")?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5.get("CURRENT_STATE")?.reasonCodes as string[]).toContain("STALE_CURRENT_STATE");

    // The audit read the Proof builder makes: paths remain, recovery spent.
    const audit = await auditRemainingKnownPaths(ctx.db, jobId, project.id);
    const open = audit.find((a) => a.component === "CURRENT_STATE");
    expect(open).toBeDefined();
    expect(open!.recoverySpent).toBe(true);
    expect(open!.paths.some((p) => p.kind === "SEALED_UNEXTRACTED" && p.count > 0)).toBe(true);

    // PERSISTED: the Proof's boundary record names the limit of the run.
    const { proof, bounded } = await proofOf(jobId);
    const tech = entryFor(bounded.technical, "CURRENT_STATE");
    expect(tech).not.toBeNull();
    expect(tech!.codes).toContain(RECOVERY_BOUND_REACHED);
    expect(tech!.codes).not.toContain(KNOWN_PATHS_UNEXPLORED);
    expect(tech!.remainingPaths).toBeDefined();
    expect(tech!.remainingPaths!.some((p) => p.kind === "SEALED_UNEXTRACTED" && p.count > 0)).toBe(true);
    // The stale observation is a real finding about the record and stays
    // visible as such — the two sides coexist.
    const subst = entryFor(bounded.substantive, "CURRENT_STATE");
    expect(subst).not.toBeNull();
    expect(subst!.codes).toContain("STALE_CURRENT_STATE");
    // Verdict / confidence are canonical semantics: the marker is a label
    // on why the record stops, and the same input without the audit read
    // yields the same verdict, confidence and layers.
    const rows = [...s5.values()].map((r) => ({ step: r.patternStep, component: r.component, status: r.status, reasonCodes: r.reasonCodes as string[], supportingEvidenceIds: r.supportingEvidenceIds as string[], excludedEvidence: r.excludedEvidence as { evidenceId: string; reason: string }[] }));
    const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    const claimSupport = { intent: claim.intent, status: claim.status as ClaimSupportStatus, reasonCodes: (claim.reasonCodes ?? []) as ClaimReasonCode[], requirementResults: (claim.requirementResults ?? []) as ClaimRequirementResult[], contextGaps: (claim.contextGaps ?? []) as MechanismGapRef[] };
    const withMarker = buildProof({ researchJobId: jobId, claimSupport, componentResults: rows, existingEvidenceIds: [], remainingPaths: audit });
    const without = buildProof({ researchJobId: jobId, claimSupport, componentResults: rows, existingEvidenceIds: [] });
    expect(withMarker.proof).not.toBeNull();
    expect(without.proof).not.toBeNull();
    expect(withMarker.proof!.verdict).toBe(without.proof!.verdict);
    expect(withMarker.proof!.confidenceScore).toBe(without.proof!.confidenceScore);
    expect(withMarker.proof!.confidenceBand).toBe(without.proof!.confidenceBand);
    expect(withMarker.proof!.layers).toEqual(without.proof!.layers);
    expect(proof.verdict).toBe(without.proof!.verdict);
    expect(proof.confidence).toBe(without.proof!.confidenceScore);
    // The only difference is the marker itself.
    expect(entryFor(without.proof!.boundedBy.technical, "CURRENT_STATE")).toBeNull();
    expect(entryFor(withMarker.proof!.boundedBy.technical, "CURRENT_STATE")?.codes).toContain(RECOVERY_BOUND_REACHED);
    // Genuinely resolved critical components carry no boundary at all.
    for (const comp of CRITICAL) {
      if (comp === "CURRENT_STATE") continue;
      if (s5.get(comp)?.status === "SUPPORTED") {
        expect(entryFor(bounded.technical, comp), comp).toBeNull();
        expect(entryFor(bounded.substantive, comp), comp).toBeNull();
      }
    }
  }, 180_000);

  it("6: projection helpers cannot erase the distinction — generating the question and audit projections and rebuilding the DRAFT Proof leave the persisted marker byte-identical", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    await runS4ResearchJob(
      ctx.db,
      jobId,
      executor(project, { search: searchOwn, extract: (_url, step, component) => (component === "CURRENT_STATE" ? [stale(step, component)] : [fresh(step, component)]) }),
      new Date(),
    );
    const before = await proofOf(jobId);
    expect(entryFor(before.bounded.technical, "CURRENT_STATE")?.codes).toContain(RECOVERY_BOUND_REACHED);
    await generateQuestionProjectionSafely(ctx.db, jobId);
    await generateAuditProjectionSafely(ctx.db, jobId);
    const afterProjections = await proofOf(jobId);
    expect(afterProjections.bounded).toEqual(before.bounded);
    const rebuilt = await buildAndPersistProof(ctx.db, jobId);
    expect(rebuilt.proofId).toBe(before.proof.id);
    const afterRebuild = await proofOf(jobId);
    expect(afterRebuild.bounded).toEqual(before.bounded);
    expect(afterRebuild.proof.verdict).toBe(before.proof.verdict);
    expect(afterRebuild.proof.confidence).toBe(before.proof.confidence);
  }, 180_000);

  it("known paths and NO recovery ever ran → KNOWN_PATHS_UNEXPLORED (derivation), so a job that stopped before its second pass is not read as checked", () => {
    const components = [{ step: 5, component: "CURRENT_STATE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }];
    const withRecovery = deriveResearchBoundary({ components, remainingPaths: [{ step: 5, component: "CURRENT_STATE", recoverySpent: true, paths: [{ kind: "SEALED_UNEXTRACTED", count: 4 }] }] });
    expect(withRecovery.technical).toEqual([{ step: 5, component: "CURRENT_STATE", codes: [RECOVERY_BOUND_REACHED], remainingPaths: [{ kind: "SEALED_UNEXTRACTED", count: 4 }] }]);
    expect(withRecovery.substantive).toEqual([]);
    const withoutRecovery = deriveResearchBoundary({ components, remainingPaths: [{ step: 5, component: "CURRENT_STATE", recoverySpent: false, paths: [{ kind: "UNOPENED_CANDIDATE", count: 2 }] }] });
    expect(withoutRecovery.technical).toEqual([{ step: 5, component: "CURRENT_STATE", codes: [KNOWN_PATHS_UNEXPLORED], remainingPaths: [{ kind: "UNOPENED_CANDIDATE", count: 2 }] }]);
    // Zero remaining paths is no marker at all — the substantive reading stands.
    const none = deriveResearchBoundary({ components, remainingPaths: [{ step: 5, component: "CURRENT_STATE", recoverySpent: true, paths: [{ kind: "SEALED_UNEXTRACTED", count: 0 }] }] });
    expect(none.technical).toEqual([]);
    expect(none.substantive).toEqual([{ step: 5, component: "CURRENT_STATE", codes: ["NO_EVIDENCE_FOUND"] }]);
    // A SUPPORTED component never carries one, whatever the audit says.
    const supported = deriveResearchBoundary({ components: [{ step: 5, component: "CURRENT_STATE", status: "SUPPORTED", reasonCodes: [] }], remainingPaths: [{ step: 5, component: "CURRENT_STATE", recoverySpent: true, paths: [{ kind: "SEALED_UNEXTRACTED", count: 4 }] }] });
    expect(supported.technical).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. SUBSTANTIVE EXHAUSTION CONTROL                                   */
/* ------------------------------------------------------------------ */

describe("A — substantive exhaustion: every known admissible path attempted, evidence still insufficient → substantive only, no technical marker", () => {
  it("one shared official page, read for every component, nothing for CURRENT_STATE → NO_EVIDENCE_FOUND stands as substantive; no known path remains; no recovery is planned", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      executor(project, {
        // Every query, scoped or generic, finds the one overview page.
        search: () => [OVERVIEW],
        extract: (_url, step, component) => (component === "CURRENT_STATE" ? [] : [fresh(step, component)]),
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const s5 = await s5Of(jobId);
    expect(s5.get("CURRENT_STATE")?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5.get("CURRENT_STATE")?.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    const audit = await auditRemainingKnownPaths(ctx.db, jobId, project.id);
    expect(audit.find((a) => a.component === "CURRENT_STATE")).toBeUndefined();
    const { bounded } = await proofOf(jobId);
    expect(entryFor(bounded.technical, "CURRENT_STATE")).toBeNull();
    expect(entryFor(bounded.substantive, "CURRENT_STATE")?.codes).toEqual(["NO_EVIDENCE_FOUND"]);
    // Nothing to recover through: one attempt.
    const att = await attemptsOf(jobId);
    expect(att.filter((a) => a.component === "CURRENT_STATE").map((a) => a.attemptNumber)).toEqual([1]);
  }, 180_000);

  it("the same, when the last known pages are consumed BY the recovery: after it nothing remains, so the boundary is substantive, not RECOVERY_BOUND_REACHED", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    const own = [`https://${HOST}/mechanism/current-state-a`, `https://${HOST}/mechanism/current-state-b`];
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      executor(project, {
        // Every component finds the overview; CURRENT_STATE also finds two
        // pages of its own. Three pages in all: whatever its first attempt
        // opens, the one recovery (3 opens / 3 extractions) can finish.
        search: (_q, component) => (component === "CURRENT_STATE" ? [OVERVIEW, ...own] : [OVERVIEW]),
        extract: (_url, step, component) => (component === "CURRENT_STATE" ? [] : [fresh(step, component)]),
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const s5 = await s5Of(jobId);
    expect(s5.get("CURRENT_STATE")?.status).toBe("INSUFFICIENT_EVIDENCE");
    const audit = await auditRemainingKnownPaths(ctx.db, jobId, project.id);
    expect(audit.find((a) => a.component === "CURRENT_STATE")).toBeUndefined();
    const { bounded } = await proofOf(jobId);
    expect(entryFor(bounded.technical, "CURRENT_STATE")).toBeNull();
    expect(entryFor(bounded.substantive, "CURRENT_STATE")?.codes).toEqual(["NO_EVIDENCE_FOUND"]);
    const att = await attemptsOf(jobId);
    expect(Math.max(...att.filter((a) => a.component === "CURRENT_STATE").map((a) => a.attemptNumber))).toBeLessThanOrEqual(2);
    expect(TARGETED_RECOVERY_BOUNDS.extractions).toBeGreaterThanOrEqual(own.length);
  }, 180_000);
});

/* ------------------------------------------------------------------ */
/* 3. CONFIGURATION BOUNDARY CONTROL                                   */
/* ------------------------------------------------------------------ */

describe("configuration boundary: no admissible route → NO_ADMISSIBLE_ROUTE, never a finding about the project", () => {
  // A component the executor closes SKIPPED / NO_ADMISSIBLE_ROUTE needs
  // every one of its classes unreachable (no confirmed route for a
  // route-only class, the explorer open not the mechanism for
  // ONCHAIN_VERIFIABLE) — the benchmark's CHAIN_EARLY variant produces it
  // end to end (EXECUTION_EVIDENCE). Here the persisted shape is written
  // as the executor writes it, on a project with no confirmed route and a
  // Research that discovered nothing for the component, and the Proof is
  // built from it.
  it("a project without a confirmed route, a component closed NO_ADMISSIBLE_ROUTE: technical [NO_ADMISSIBLE_ROUTE], no remaining-path marker (there is no known path), nothing substantive", async () => {
    const project = await makeProject({ confirmedRoute: false });
    const jobId = await makeJob(project);
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      executor(project, {
        search: (query, component) => (component === "CURRENT_STATE" ? [] : searchOwn(query, component)),
        extract: (_url, step, component) => [fresh(step, component)],
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const s5 = await s5Of(jobId);
    const row = s5.get("CURRENT_STATE")!;
    expect(row.status).toBe("INSUFFICIENT_EVIDENCE");
    await ctx.db.update(researchComponentResults).set({ reasonCodes: ["NO_ADMISSIBLE_ROUTE"] }).where(eq(researchComponentResults.id, row.id));
    await ctx.db
      .update(researchAttempts)
      .set({ status: "SKIPPED", reason: "NO_ADMISSIBLE_ROUTE; source-route observations: CLASS_REQUIRES_CONFIRMED_ROUTE:OFFICIAL_DOCS, CLASS_REQUIRES_CONFIRMED_ROUTE:OFFICIAL_REPORT" })
      .where(eq(researchAttempts.researchJobId, jobId));
    await buildAndPersistProof(ctx.db, jobId);
    const { bounded } = await proofOf(jobId);
    const tech = entryFor(bounded.technical, "CURRENT_STATE");
    expect(tech).not.toBeNull();
    expect(tech!.codes).toEqual(["NO_ADMISSIBLE_ROUTE"]);
    expect(tech!.remainingPaths).toBeUndefined();
    expect(entryFor(bounded.substantive, "CURRENT_STATE")).toBeNull();
    const audit = await auditRemainingKnownPaths(ctx.db, jobId, project.id);
    expect(audit.find((a) => a.component === "CURRENT_STATE")).toBeUndefined();
  }, 180_000);

  it("derivation: NO_ADMISSIBLE_ROUTE is technical whether it comes from S5 or from the attempt, and never becomes RECOVERY_BOUND_REACHED without a known path", () => {
    const fromS5 = deriveResearchBoundary({ components: [{ step: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"] }] });
    expect(fromS5.technical).toEqual([{ step: 4, component: "EXECUTION_EVIDENCE", codes: ["NO_ADMISSIBLE_ROUTE"] }]);
    expect(fromS5.substantive).toEqual([]);
    const fromAttempt = deriveResearchBoundary({
      components: [{ step: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }],
      attempts: [{ step: 4, component: "EXECUTION_EVIDENCE", status: "SKIPPED", reason: "NO_ADMISSIBLE_ROUTE; source-route observations: x" }],
      remainingPaths: [{ step: 4, component: "EXECUTION_EVIDENCE", recoverySpent: false, paths: [] }],
    });
    expect(fromAttempt.technical).toEqual([{ step: 4, component: "EXECUTION_EVIDENCE", codes: ["NO_ADMISSIBLE_ROUTE"] }]);
    expect(fromAttempt.substantive).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. PROVIDER FAILURE CONTROL                                         */
/* ------------------------------------------------------------------ */

describe("provider failure: no source could be opened → SOURCE_UNAVAILABLE, technical", () => {
  it("every open fails (HTTP 404) → the components close NO_SOURCE_COULD_BE_FETCHED and the record says SOURCE_UNAVAILABLE; dead candidates are not 'known paths'", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      executor(project, {
        search: searchOwn,
        fetch: (url) => {
          throw new ContentFetchError("HTTP_ERROR", "fixture: gone", url, 404);
        },
        extract: () => [],
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const att = await attemptsOf(jobId);
    // The executor names the failure class it saw (safeFailureReason):
    // `CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:404`.
    const unavailable = att.filter((a) => a.status === "FAILED" && (a.reason ?? "").startsWith("CONTENT_FETCHER_FAILED")).map((a) => a.component);
    expect(unavailable.length).toBeGreaterThan(0);
    const { bounded } = await proofOf(jobId);
    const s5 = await s5Of(jobId);
    for (const comp of new Set(unavailable)) {
      expect(s5.get(comp)?.status, comp).toBe("INSUFFICIENT_EVIDENCE");
      const tech = entryFor(bounded.technical, comp);
      expect(tech, comp).not.toBeNull();
      expect(tech!.codes, comp).toContain("SOURCE_UNAVAILABLE");
      expect(tech!.codes, comp).not.toContain(RECOVERY_BOUND_REACHED);
      expect(entryFor(bounded.substantive, comp), comp).toBeNull();
    }
  }, 180_000);

  it("derivation: every provider-failure head the executor writes is technical, keyed by its label; an unknown head is not", () => {
    expect(technicalCodeForAttemptHead("CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:404")).toBe("SOURCE_UNAVAILABLE");
    expect(technicalCodeForAttemptHead("CONTENT_FETCHER_FAILED:ContentFetchError")).toBe("SOURCE_UNAVAILABLE");
    expect(technicalCodeForAttemptHead("SEARCH_GATEWAY_FAILED:Error")).toBe("SEARCH_UNAVAILABLE");
    expect(technicalCodeForAttemptHead("QUERY_PROPOSER_FAILED:Error")).toBe("NO_QUERIES_PROPOSED");
    expect(technicalCodeForAttemptHead("EVIDENCE_EXTRACTOR_FAILED:Error")).toBe("EXTRACTION_NOT_COMPLETED");
    expect(technicalCodeForAttemptHead("NO_SOURCE_COULD_BE_FETCHED")).toBe("SOURCE_UNAVAILABLE");
    expect(technicalCodeForAttemptHead("NO_TRACEABLE_FACTS_FOR_COMPONENT")).toBeNull();
    expect(technicalCodeForAttemptHead("NO_SEARCH_CANDIDATES")).toBeNull();
    expect(technicalCodeForAttemptHead("SOMETHING_ELSE_FAILED:Error")).toBeNull();
    const b = deriveResearchBoundary({
      components: [{ step: 3, component: "MECHANISM_SPEC", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }],
      attempts: [{ step: 3, component: "MECHANISM_SPEC", status: "FAILED", reason: "CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:404; source-route observations: x" }],
    });
    expect(b.technical).toEqual([{ step: 3, component: "MECHANISM_SPEC", codes: ["SOURCE_UNAVAILABLE"] }]);
    expect(b.substantive).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* THE PHASED FETCH AT ITS CEILING IS DETERMINISTIC                    */
/* ------------------------------------------------------------------ */

describe("phased FETCH at the source-open ceiling: the urls that get the last units are the first in target order, under concurrency", () => {
  // Measured on the benchmark (S05 / OFFICIAL_LATE / PHASED at 24/24): two
  // runs of the same code sealed different documents, because each
  // in-flight url reserved its open only after its own async prologue.
  // First opens are now reserved in start order.
  async function seedCandidates(jobId: string, urls: string[]) {
    await recordTraceEvent(ctx.db, { researchJobId: jobId, operationType: "SEARCH_EXECUTED", providerKind: "SEARCH", patternStep: 3, component: "MECHANISM_SPEC", targetRef: "mechanism spec", status: "OK", budgetAxis: "searchQueries", budgetAmount: 1 });
    for (const url of urls) {
      await recordTraceEvent(ctx.db, { researchJobId: jobId, operationType: "CANDIDATE_RETURNED", providerKind: "SEARCH", patternStep: 3, component: "MECHANISM_SPEC", targetRef: url, status: "OK" });
    }
  }
  const jitteredFetcher = () => ({
    name: "fixture-transport",
    async fetch(url: string) {
      // Out-of-order completion on purpose: order must come from the
      // reservation, never from who finished first.
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 25)));
      return fixtureDoc(url);
    },
  });

  it("with 8 candidates and a ceiling of 3, every run seals exactly the first three targets — at concurrency 4 and at concurrency 1", async () => {
    const project = await makeProject();
    const urls = Array.from({ length: 8 }, (_, i) => `https://${HOST}/mechanism/page-${i + 1}`);
    const prior = process.env.ATLAS_ACQUISITION_CONCURRENCY;
    try {
      for (const concurrency of ["4", "1", "4"]) {
        process.env.ATLAS_ACQUISITION_CONCURRENCY = concurrency;
        const jobId = await makeJob(project);
        await seedCandidates(jobId, urls);
        const targets = await loadFetchTargets(ctx.db, jobId, project.id);
        expect(targets).toHaveLength(8);
        const out = await runFetchPhase({ db: ctx.db, jobId, projectId: project.id, contentFetcher: jitteredFetcher(), maxSourceOpens: 3 });
        const sealed = out.strategyAttempts.map((a) => a.url);
        expect(sealed, `concurrency ${concurrency}`).toEqual(targets.slice(0, 3));
        expect(out.sealedDocumentIds, `concurrency ${concurrency}`).toHaveLength(3);
      }
    } finally {
      if (prior === undefined) delete process.env.ATLAS_ACQUISITION_CONCURRENCY;
      else process.env.ATLAS_ACQUISITION_CONCURRENCY = prior;
    }
  }, 120_000);
});
