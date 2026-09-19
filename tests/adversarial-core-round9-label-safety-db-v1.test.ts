import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  interpretations,
  projects,
  proofs,
  researchComponentResults,
  researchJobs,
  researchQuestionProjections,
  topics,
  users,
} from "../src/server/db/schema";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { PROJECTION_VERSION, resolveProjectionFindings } from "../src/server/engine/question-projection";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { deriveQuestionFindings } from "../src/client/research-model";
import { labelSafety, neutralLabelFor } from "../src/shared/projection-label-safety";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ROUND 9, PERSISTED — STORAGE IS NOT TRUSTED (Founder decision A3).
//
// A safety rule enforced only when writing is not a rule. Rows written
// before the rule existed still render; a row an attacker or a bug can
// reach still renders. So the label guard runs again on the way out, and
// this file proves it against a REAL persisted projection row that is
// deliberately corrupted after the job succeeded — the legacy and the
// tampered case at once.
//
// What must hold: whatever is in storage, the rendered page stays bounded
// by the structured record. An unsafe label is neutralised to the
// component's own canonical name; the pointer, and therefore the status
// the reader sees, is untouched.
//
// Real Postgres, the real worker, the real S4 executor over fixture
// providers. No model, no network, no RPC, no spend.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST = "docs.labelsafety.example";
const PROJECT_NAME = "Label Safety Protocol";
const ALL_COMPONENTS = [
  "SOURCE_OF_VALUE",
  "FLOW_PATH",
  "MECHANISM_SPEC",
  "GOVERNANCE_BASIS",
  "EXECUTION_EVIDENCE",
  "CURRENT_STATE",
  "DESTINATION",
  "RECIPIENT",
  "NET_EFFECT",
  "DURABILITY_BASIS",
] as const;
type Component = (typeof ALL_COMPONENTS)[number];
const STEP_OF: Record<Component, number> = {
  SOURCE_OF_VALUE: 1,
  FLOW_PATH: 2,
  MECHANISM_SPEC: 3,
  GOVERNANCE_BASIS: 3,
  EXECUTION_EVIDENCE: 4,
  CURRENT_STATE: 5,
  DESTINATION: 6,
  RECIPIENT: 6,
  NET_EFFECT: 7,
  DURABILITY_BASIS: 8,
};
const FRAGMENTS: Record<Component, string> = {
  SOURCE_OF_VALUE: "swap fees charged on every trade are the only source of protocol revenue",
  FLOW_PATH: "collected swap fees are forwarded from the router to the allocation contract",
  MECHANISM_SPEC: "each epoch the allocation contract distributes half of the collected fees",
  GOVERNANCE_BASIS: "the allocation schedule was ratified by the token holder vote",
  EXECUTION_EVIDENCE: "the allocation contract has executed a distribution in every epoch since launch",
  CURRENT_STATE: "the allocation mechanism is active as of the latest epoch",
  DESTINATION: "fees are distributed to holders through the distributor",
  RECIPIENT: "token holders are entitled to a pro rata share of the distributed fees",
  NET_EFFECT: "circulating supply declines by the amount distributed each epoch",
  DURABILITY_BASIS: "the allocation can only be changed by a further token holder vote",
};

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

const docUrl = (c: Component) => `https://${DOCS_HOST}/docs/${c.toLowerCase().replace(/_/g, "-")}`;
const componentOfDocUrl = (url: string) => ALL_COMPONENTS.find((c) => docUrl(c) === url) ?? null;

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeProject() {
  const slug = uniq("label");
  const [p] = await ctx.db.insert(projects).values({ slug, name: PROJECT_NAME, status: "ACTIVE_CORE" }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: DOCS_HOST, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const cls = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!cls.ok) throw new Error("docs classify failed: " + cls.refusal);
  return { id: p.id, slug, name: p.name, ticker: p.ticker ?? null };
}

function doc(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${text.length}:${text.slice(0, 64)}`,
    fetchedAt: new Date(),
    byteLength: text.length,
  };
}

function executorFor(project: { id: string; slug: string; name: string; ticker: string | null }) {
  const text = (c: Component) => `${PROJECT_NAME} tokenomics, ${c.toLowerCase().replace(/_/g, " ")}. ${FRAGMENTS[c]}.`;
  return createS4WorkExecutor({
    db: ctx.db,
    project,
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: { name: "fixture-proposer", async proposeQueries(input) { return [`${input.target.component} of ${project.name}`]; } },
    searchGateway: { name: "fixture-search", async search(_q, target) { return [{ url: docUrl(target.component as Component), title: null, snippet: null }]; } },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        const c = componentOfDocUrl(url);
        if (!c) throw new Error(`fixture fetch: unexpected url ${url}`);
        return doc(url, text(c));
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        const c = input.target.component as Component;
        if (!input.document.normalizedText.includes(FRAGMENTS[c])) return [];
        const fact: ExtractedFact = {
          step: input.target.step,
          component: c,
          statement: `${c.toLowerCase().replace(/_/g, " ")}: ${FRAGMENTS[c]}`,
          supportFragment: FRAGMENTS[c],
          mechanismState: null,
          directness: "DIRECT",
          publishedAt: null,
          doesNotProve: "does not prove the size of the effect",
          relationship: "SUPPORTS",
        };
        return [fact];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

async function runJob(project: { id: string; slug: string; name: string; ticker: string | null }): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const question = "does revenue reach the token?";
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: await activeTopicId(),
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
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
      normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN",
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  const handled = await handleResearchJobTask(ctx.db, job.id, executorFor(project));
  if (!handled.claimed) throw new Error("job not claimed");
  return job.id;
}

// Exactly what the detail route does on the way out.
async function renderedFindings(jobId: string) {
  const componentRows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const components = componentRows.map((r) => ({ patternStep: r.patternStep, component: r.component }));
  const [row] = await ctx.db.select().from(researchQuestionProjections).where(eq(researchQuestionProjections.researchJobId, jobId));
  const resolved = row?.status === "VALID" ? resolveProjectionFindings(row.findings, components) : null;
  const ladderInput = componentRows.map((r) => ({
    component: r.component,
    status: r.status,
    reasonCodes: r.reasonCodes as string[],
    supportingEvidenceIds: r.supportingEvidenceIds as string[],
    contradictingEvidenceIds: r.contradictingEvidenceIds as string[],
  }));
  return { resolved, rows: resolved ? deriveQuestionFindings(resolved, ladderInput) : [], componentRows };
}

const UNSAFE_LABELS = [
  "revenue is proven",
  "50% of all fees reach the token",
  "holders definitely receive value",
  "supply decreased over the interval",
  "significant revenue",
];

describe("ROUND 9 (persisted) — an unsafe stored label never strengthens the rendered page", () => {
  it("R9-DB-1. a persisted projection corrupted with claim-shaped labels renders neutral copy, keeps every pointer, and leaves every status exactly as the record has it", async () => {
    const project = await makeProject();
    const jobId = await runJob(project);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.state).toBe("SUCCEEDED");
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof).toBeDefined();

    const componentRows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    const targets = componentRows.slice(0, UNSAFE_LABELS.length);
    expect(targets.length).toBe(UNSAFE_LABELS.length);

    // THE LEGACY / TAMPERED ROW. Written straight into storage, exactly as
    // a row predating the rule or a corrupted one would be.
    await ctx.db.delete(researchQuestionProjections).where(eq(researchQuestionProjections.researchJobId, jobId));
    await ctx.db.insert(researchQuestionProjections).values({
      researchJobId: jobId,
      projectionVersion: PROJECTION_VERSION,
      patternVersion: 1,
      status: "VALID",
      findings: targets.map((t, i) => ({
        userFacingLabel: UNSAFE_LABELS[i],
        primaryRef: { kind: "COMPONENT", step: t.patternStep, component: t.component },
        supportingRefs: [],
      })),
    });

    const { resolved, rows } = await renderedFindings(jobId);
    expect(resolved).not.toBeNull();
    expect(resolved!.length).toBe(targets.length);

    // Not one unsafe label survives, on either hop.
    for (const f of resolved!) {
      expect(UNSAFE_LABELS).not.toContain(f.label);
      expect(labelSafety(f.component, f.label).safe, f.label).toBe(true);
      expect(f.label).toBe(neutralLabelFor(f.component));
    }
    for (const r of rows) expect(labelSafety(null, r.label).safe, r.label).toBe(true);
    const renderedText = JSON.stringify(rows);
    for (const bad of UNSAFE_LABELS) expect(renderedText).not.toContain(bad);

    // The POINTERS are untouched — neutralising copy never moves a finding.
    expect(resolved!.map((f) => `${f.patternStep}:${f.component}`)).toEqual(targets.map((t) => `${t.patternStep}:${t.component}`));

    // And the page is still bounded by the record: every rendered row's
    // state is the persisted status of its own component, unchanged.
    const statusByComponent = new Map(componentRows.map((r) => [r.component, r.status]));
    for (const r of rows) {
      expect(statusByComponent.has(r.component), r.component).toBe(true);
      expect(["VERIFIED", "PARTIAL", "NOT_HAPPENING", "UNRESOLVED"]).toContain(r.state);
    }
  }, 180_000);

  it("R9-DB-2. safe stored labels are passed through unchanged over the same persisted job — the rule neutralises claims, not copy in general", async () => {
    const project = await makeProject();
    const jobId = await runJob(project);
    const componentRows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    const targets = componentRows.slice(0, 2);
    const safeLabels = ["where the revenue comes from", "the route the fees take"];

    await ctx.db.delete(researchQuestionProjections).where(eq(researchQuestionProjections.researchJobId, jobId));
    await ctx.db.insert(researchQuestionProjections).values({
      researchJobId: jobId,
      projectionVersion: PROJECTION_VERSION,
      patternVersion: 1,
      status: "VALID",
      findings: targets.map((t, i) => ({
        userFacingLabel: safeLabels[i],
        primaryRef: { kind: "COMPONENT", step: t.patternStep, component: t.component },
        supportingRefs: [],
      })),
    });

    const { resolved } = await renderedFindings(jobId);
    expect(resolved!.map((f) => f.label)).toEqual(safeLabels);
  }, 180_000);

  it("R9-DB-3. a corrupted projection cannot smuggle a reference either: a label pointing at another job's component resolves to nothing and the page falls back to the canonical result", async () => {
    const projectA = await makeProject();
    const jobA = await runJob(projectA);
    const projectB = await makeProject();
    const jobB = await runJob(projectB);
    const bRows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobB));

    await ctx.db.delete(researchQuestionProjections).where(eq(researchQuestionProjections.researchJobId, jobA));
    await ctx.db.insert(researchQuestionProjections).values({
      researchJobId: jobA,
      projectionVersion: PROJECTION_VERSION,
      patternVersion: 1,
      status: "VALID",
      // Job A's projection, pointing at a step/component pair that does not
      // exist on job A, plus one that does but with an unsafe label.
      findings: [
        { userFacingLabel: "where the revenue comes from", primaryRef: { kind: "COMPONENT", step: 42, component: "NOT_A_COMPONENT" }, supportingRefs: [] },
        { userFacingLabel: "revenue is proven", primaryRef: { kind: "COMPONENT", step: bRows[0].patternStep, component: bRows[0].component }, supportingRefs: [] },
      ],
    });

    const { resolved, rows } = await renderedFindings(jobA);
    // The invented reference is dropped; the surviving one is neutralised.
    expect(resolved!.length).toBe(1);
    expect(resolved![0].label).toBe(neutralLabelFor(resolved![0].component));
    for (const r of rows) expect(labelSafety(null, r.label).safe).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("revenue is proven");
  }, 180_000);
});
