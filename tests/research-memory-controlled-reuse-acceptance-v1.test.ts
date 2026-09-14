import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG, loadProductConfig } from "../src/server/config/product";
import {
  evidence,
  interpretations,
  memoryRetrievals,
  productConfig,
  projectMemoryItems,
  projects,
  proofs,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  researchMemory,
  researchMemoryProvenance,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { extractionUnitKey, observationKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { adoptReusedMemory } from "../src/server/engine/memory-evidence-adoption";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { copyProvenanceFromEvidence, observeMemoryCandidate, promoteToActive } from "../src/server/memory/lifecycle";
import { VERIFIED_OBSERVATION_CONFIDENCE, VERIFIED_OBSERVATION_ORIGIN_KIND } from "../src/server/memory/observed-candidates";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { markProofVerified } from "../src/server/memory/verification";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// CONTROLLED ACTIVE MEMORY REUSE ACCEPTANCE V1.
//
// The complete Research Memory V1 loop on the REAL Research pipeline —
// the worker entry point, the real S4 executor over fixture providers that
// count every acquisition operation, the ordinary S5/S6/S7/S8, the canonical
// verification act, the existing controlled promotion, the planner, the
// adoption path:
//
//   Research A  fresh -> Evidence -> Proof -> VERIFIED -> OBSERVED
//             -> controlled promotion of SELECTED observations -> ACTIVE
//   Research B  same project: consults Memory first, adopts what Memory can
//               safely close, acquires fresh Evidence for everything else,
//               builds its OWN Proof from both.
//
// THE MIXED CASE is the product behaviour under acceptance. Research B's ten
// obligations are arranged so that every way Memory can and cannot help is
// present at once:
//
//   DESTINATION      ACTIVE, healthy, admissible today  -> REUSED, no fresh work
//   RECIPIENT        ACTIVE, but its route was withdrawn -> adopted row inadmissible
//                    today, S5 not established by it     -> FRESH (insufficient adoption)
//   FLOW_PATH        ACTIVE, but past its freshness window -> planner refuses
//                                                           -> FRESH (stale)
//   CURRENT_STATE    ACTIVE row exists, component fresh-only -> FRESH (fresh-only)
//   SOURCE_OF_VALUE, MECHANISM_SPEC   OBSERVED only, never promoted -> FRESH (missing)
//   the rest          no memory at all                     -> FRESH (missing)
//
// CONTROL is the same Research B with Memory disabled. Every count below —
// proposer calls, searches, fetches, extractions, attempts, trace rows, the
// job's own budget ledger — is compared per component: the reused
// obligation costs nothing, every other obligation costs exactly what the
// control pays, and nothing costs more because Memory exists.
//
// DESTINATION is the reused obligation because the fixture question's
// intent (PROTOCOL_REVENUE_TO_TOKEN) rests on SOURCE_OF_VALUE and
// DESTINATION, so the NEW Proof visibly cites the reused observation next
// to fresh Evidence — the combination under acceptance.
//
// Founder policy for this round, held as-is: confidence 80 is metadata the
// planner reads and nothing else; HIGH_CHANGE freshness is the default;
// PARTIALLY_SUPPORTED components may contribute candidates row by row.
//
// No live call anywhere: every provider is a fixture, chain acquisition is
// DOCUMENTARY_ONLY, and the test's own counters prove what ran.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST = "docs.reuseacceptance.org";
const GOV_HOST = "vote.reuseacceptance.org";
const DOCS_PREFIX = `https://${DOCS_HOST}/docs/`;
const GOV_URL = `https://${GOV_HOST}/proposals/burn-allocation`;
const PROJECT_NAME = "Reuse Acceptance Protocol";

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

// One documentation page per component, each stating that component's
// passage — so every component is its own source open, and the reused one
// is a source open Memory saves.
const DOC_FRAGMENTS: Record<Component, string> = {
  SOURCE_OF_VALUE: "swap fees charged on every trade are the only source of protocol revenue",
  FLOW_PATH: "collected swap fees are forwarded from the router to the protocol treasury contract",
  MECHANISM_SPEC: "each epoch the treasury allocates half of the collected fees to the buyback module",
  GOVERNANCE_BASIS: "the allocation schedule was ratified by the token holder vote",
  EXECUTION_EVIDENCE: "the buyback module has executed a purchase in every epoch since launch",
  CURRENT_STATE: "the buyback mechanism is active as of the latest epoch",
  DESTINATION: "tokens purchased by the buyback module are sent to the burn address",
  RECIPIENT: "the burn address is owned by nobody and its balance is removed from circulation",
  NET_EFFECT: "circulating supply declines by the amount burned each epoch",
  DURABILITY_BASIS: "the allocation can only be changed by a further token holder vote",
};
// The governance page states RECIPIENT in its own words — a genuinely
// different passage from the documentation's.
const GOV_FRAGMENTS: Partial<Record<Component, string>> = {
  RECIPIENT: "the proposal directs every purchased token to the burn address, which no party controls",
};
function docUrl(component: Component): string {
  return `${DOCS_PREFIX}${component.toLowerCase().replace(/_/g, "-")}`;
}
function docText(component: Component): string {
  return `${PROJECT_NAME} tokenomics, ${component.toLowerCase().replace(/_/g, " ")}. ${DOC_FRAGMENTS[component]}.`;
}
function componentOfDocUrl(url: string): Component | null {
  return ALL_COMPONENTS.find((c) => docUrl(c) === url) ?? null;
}
const GOV_TEXT = `${PROJECT_NAME} governance proposal. ${Object.values(GOV_FRAGMENTS).join(". ")}.`;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

// ---------------------------------------------------------------- fixtures

async function setMemoryEnabled(value: boolean): Promise<void> {
  await ctx.db
    .insert(productConfig)
    .values({ key: "memory_enabled", value })
    .onConflictDoUpdate({ target: productConfig.key, set: { value } });
}

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeAdmin(): Promise<string> {
  const [a] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
  return a.id;
}

interface Project {
  id: string;
  slug: string;
  name: string;
  ticker: string | null;
  govRouteId: string;
}

// A real onboarded project: a confirmed + classified OFFICIAL_DOCS route on
// the docs host and a confirmed + classified GOVERNANCE route on the vote
// host. The classified GOVERNANCE row is returned so a human can withdraw it.
async function makeProject(): Promise<Project> {
  const slug = uniq("reuse");
  const [p] = await ctx.db.insert(projects).values({ slug, name: PROJECT_NAME, status: "ACTIVE_CORE" }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: DOCS_HOST, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const docsClass = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!docsClass.ok) throw new Error("docs classify failed: " + docsClass.refusal);
  const gov = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: GOV_HOST, pathPrefix: "/proposals" });
  if (!gov.ok) throw new Error("gov confirm failed: " + gov.refusal);
  const govClass = await classifySourceRoute(ctx.db, { routeId: gov.itemId, routeClass: "GOVERNANCE" });
  if (!govClass.ok) throw new Error("gov classify failed: " + govClass.refusal);
  const routes = await ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
  const govActive = routes.find((r) => r.lifecycleState === "ACTIVE" && JSON.stringify(r.content).includes(GOV_HOST) && JSON.stringify(r.content).includes("GOVERNANCE"));
  if (!govActive) throw new Error("no ACTIVE classified GOVERNANCE route");
  return { id: p.id, slug, name: p.name, ticker: p.ticker ?? null, govRouteId: govActive.id };
}

async function newJob(projectId: string, slug: string): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: await activeTopicId(),
      projectId,
      originalQuestion: "does the buyback and burn reduce the token supply?",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "does the buyback and burn reduce the token supply" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  // "Understand the question" — in production the interpreter (a model)
  // writes this row before the job is queued; the fixture writes the same
  // structured result directly. The intent is what S7 evaluates against.
  await ctx.db.insert(interpretations).values({
    userId: user.id,
    researchJobId: job.id,
    originalQuestion: "does the buyback and burn reduce the token supply?",
    status: "READY",
    result: {
      status: "READY",
      project_or_asset: slug,
      related_entities: [],
      topic: null,
      task_type: "VERIFY_MECHANISM",
      research_task: "does the buyback and burn reduce the token supply",
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
  return job.id;
}

function doc(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}`,
    fetchedAt: new Date("2026-09-10T00:00:00Z"),
    byteLength: text.length,
  };
}

type Op = "proposer" | "search" | "fetch" | "extract";
type Counters = Record<Component, Record<Op, number>>;
function emptyCounters(): Counters {
  return Object.fromEntries(ALL_COMPONENTS.map((c) => [c, { proposer: 0, search: 0, fetch: 0, extract: 0 }])) as Counters;
}
function totalOf(c: Counters, op: Op): number {
  return ALL_COMPONENTS.reduce((n, k) => n + c[k][op], 0);
}

// The REAL S4 executor over fixture providers that record every operation
// per component. `urlFor` is the one knob: which page the search returns
// for a component. The extractor returns exactly the passage the fetched
// page states for the target component, DIRECT and SUPPORTS.
function acquisitionExecutor(project: Project, urlFor: (component: Component) => string) {
  const counters = emptyCounters();
  let current: Component = "SOURCE_OF_VALUE";
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        current = input.target.component as Component;
        counters[current].proposer += 1;
        return [`${input.target.component} of ${project.name}`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(_query, target) {
        counters[target.component as Component].search += 1;
        return [{ url: urlFor(target.component as Component), title: null, snippet: null }];
      },
    },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        counters[current].fetch += 1;
        if (url === GOV_URL) return doc(url, GOV_TEXT);
        const c = componentOfDocUrl(url);
        if (c) return doc(url, docText(c));
        throw new Error(`fixture fetch: unexpected url ${url}`);
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        const component = input.target.component as Component;
        counters[component].extract += 1;
        const fragments = input.document.finalUrl === GOV_URL ? GOV_FRAGMENTS : DOC_FRAGMENTS;
        const fragment = fragments[component];
        if (!fragment || !input.document.normalizedText.includes(fragment)) return [];
        const fact: ExtractedFact = {
          step: input.target.step,
          component,
          statement: `${component.toLowerCase().replace(/_/g, " ")}: ${fragment}`,
          supportFragment: fragment,
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
  return { executor, counters };
}

// ------------------------------------------------------------------ reads

async function evidenceOf(jobId: string, component: string) {
  return ctx.db
    .select()
    .from(evidence)
    .where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, component)))
    .orderBy(evidence.createdAt);
}

async function s5Of(jobId: string, component: string) {
  const [row] = await ctx.db
    .select()
    .from(researchComponentResults)
    .where(and(eq(researchComponentResults.researchJobId, jobId), eq(researchComponentResults.component, component)));
  return row;
}

async function proofOf(jobId: string) {
  const [p] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  return p;
}

async function claimSupportOf(jobId: string) {
  const [r] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  return r;
}

async function attemptsOf(jobId: string): Promise<string[]> {
  const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  return rows.map((r) => `${r.patternStep}:${r.component}`).sort();
}

async function traceCountsOf(jobId: string): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ component: researchTraceEvents.component, n: count() })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId))
    .groupBy(researchTraceEvents.component);
  return Object.fromEntries(rows.map((r) => [r.component ?? "(none)", Number(r.n)]));
}

async function gapsOf(jobId: string): Promise<string[]> {
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  const out = new Set<string>();
  for (const f of (asm?.flows ?? []) as { gaps?: { kind: string; component: string }[] }[]) {
    for (const g of f.gaps ?? []) out.add(`${g.kind}@${g.component}`);
  }
  for (const g of (asm?.unassignedGaps ?? []) as { kind: string; component: string }[]) out.add(`${g.kind}@${g.component}`);
  return [...out].sort();
}

async function ledgerOf(jobId: string) {
  const [j] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return {
    state: j.state,
    searchQueriesReserved: j.searchQueriesReserved,
    sourceOpensReserved: j.sourceOpensReserved,
    modelCostMicroReserved: j.modelCostMicroReserved,
  };
}

async function memoryOf(projectId: string) {
  return ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectId)).orderBy(researchMemory.patternStep, researchMemory.component, researchMemory.createdAt);
}

async function countRows(table: typeof researchMemory | typeof researchMemoryProvenance | typeof evidence): Promise<number> {
  const [r] = await ctx.db.select({ n: count() }).from(table);
  return Number(r.n);
}

async function sourceIdOf(url: string): Promise<string> {
  const [s] = await ctx.db.select().from(sources).where(eq(sources.url, url));
  if (!s) throw new Error(`no source row for ${url}`);
  return s.id;
}

// The per-component S5 picture reduced to what a Proof rests on.
async function s5PictureOf(jobId: string) {
  const out: Record<string, { status: string; reasonCodes: string[]; supportingCount: number }> = {};
  for (const c of ALL_COMPONENTS) {
    const r = await s5Of(jobId, c);
    out[c] = {
      status: r.status,
      reasonCodes: [...((r.reasonCodes as string[]) ?? [])].sort(),
      supportingCount: ((r.supportingEvidenceIds as string[]) ?? []).length,
    };
  }
  return out;
}

// -------------------------------------------------------------------- test

describe("CONTROLLED ACTIVE MEMORY REUSE ACCEPTANCE V1 — the loop on the real pipeline", () => {
  it("Research A fresh -> VERIFIED -> OBSERVED -> controlled ACTIVE; Research B reuses only what Memory safely closes, acquires the rest fresh, and builds a new Proof at strictly less acquisition cost than the no-memory control", async () => {
    // 16. Production Memory is OFF by code default, and this database
    //     holds no opt-in until the controlled fixture sets one.
    expect(DEFAULT_PRODUCT_CONFIG.memory_enabled).toBe(false);
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);

    const project = await makeProject();
    const admin = await makeAdmin();
    const FRESH_ONLY = ["CURRENT_STATE", "EXECUTION_EVIDENCE", "NET_EFFECT"] as const;

    // =================================================================
    // RESEARCH A — fresh, through the worker and the real S4 executor.
    // RECIPIENT is established from the governance page; everything else
    // from its own documentation page.
    // =================================================================
    const runA = acquisitionExecutor(project, (c) => (c === "RECIPIENT" ? GOV_URL : docUrl(c)));
    const jobA = await newJob(project.id, project.slug);
    const handledA = await handleResearchJobTask(ctx.db, jobA, runA.executor);
    expect(handledA.claimed).toBe(true);
    expect((await ledgerOf(jobA)).state).toBe("SUCCEEDED");
    expect(await attemptsOf(jobA)).toEqual(ALL_COMPONENTS.map((c) => `${STEP_OF[c]}:${c}`).sort());
    for (const c of ALL_COMPONENTS) {
      expect(runA.counters[c]).toEqual({ proposer: 1, search: 1, fetch: 1, extract: 1 });
      const rows = await evidenceOf(jobA, c);
      expect(rows.length).toBe(1);
      expect(rows[0].officiality).toBe("CONFIRMED");
      expect(rows[0].reusedFromMemoryId).toBeNull();
    }
    const destSourceId = await sourceIdOf(docUrl("DESTINATION"));
    const flowSourceId = await sourceIdOf(docUrl("FLOW_PATH"));
    const sovSourceId = await sourceIdOf(docUrl("SOURCE_OF_VALUE"));
    const govSourceId = await sourceIdOf(GOV_URL);
    const recipientA = (await evidenceOf(jobA, "RECIPIENT"))[0];
    expect(recipientA.sourceId).toBe(govSourceId);
    expect(recipientA.sourceClass).toBe("GOVERNANCE");
    expect((await s5Of(jobA, "RECIPIENT")).status).toBe("SUPPORTED");
    expect((await s5Of(jobA, "DESTINATION")).status).toBe("SUPPORTED");
    expect((await s5Of(jobA, "FLOW_PATH")).status).toBe("SUPPORTED");
    const proofA = await proofOf(jobA);
    expect(proofA).toBeDefined();
    expect(proofA.verificationStatus).toBe("DRAFT");
    // A SUCCEEDED Research with a DRAFT Proof has written no Memory.
    expect(await memoryOf(project.id)).toEqual([]);

    // 1. VERIFIED through the canonical act -> OBSERVED candidates.
    const verifiedA = await markProofVerified(ctx.db, proofA.id, admin);
    expect(verifiedA.verificationStatus).toBe("VERIFIED");
    const createdA = verifiedA.memoryCandidates.created.map((c) => c.component).sort();
    // Every supporting row of an adoptable component is CONFIRMED,
    // documentary and DIRECT here, so the only refusals are the fresh-only
    // components — and only when S5 listed a supporting row for them.
    for (const r of verifiedA.memoryCandidates.refused) {
      expect(FRESH_ONLY).toContain(r.component);
      expect(r.reason).toBe("FRESH_ONLY_COMPONENT");
    }
    for (const c of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION", "RECIPIENT"]) expect(createdA).toContain(c);
    for (const c of FRESH_ONLY) expect(createdA).not.toContain(c);
    const memA = await memoryOf(project.id);
    expect(memA.length).toBe(createdA.length);
    expect(memA.every((m) => m.lifecycleState === "OBSERVED")).toBe(true);
    expect(memA.every((m) => m.originKind === VERIFIED_OBSERVATION_ORIGIN_KIND && m.confidence === VERIFIED_OBSERVATION_CONFIDENCE)).toBe(true);
    // Founder policy 3: a PARTIALLY_SUPPORTED component (SOURCE_OF_VALUE,
    // capped by its mechanical-provenance obligation) contributed its
    // eligible row — the observation, not the verdict.
    expect((await s5Of(jobA, "SOURCE_OF_VALUE")).status).toBe("PARTIALLY_SUPPORTED");
    const sovMemory = memA.find((m) => m.component === "SOURCE_OF_VALUE")!;
    expect(sovMemory.statement).toContain(DOC_FRAGMENTS.SOURCE_OF_VALUE);
    expect(sovMemory.observationKey).toBe(observationKey(sovSourceId, 1, "SOURCE_OF_VALUE", DOC_FRAGMENTS.SOURCE_OF_VALUE));

    // 2. CONTROLLED PROMOTION — the existing admin path, for the SELECTED
    //    observations only. SOURCE_OF_VALUE and MECHANISM_SPEC stay
    //    OBSERVED: Memory never activates on its own.
    const destMem = memA.find((m) => m.component === "DESTINATION")!;
    const flowMem = memA.find((m) => m.component === "FLOW_PATH")!;
    const recipientMem = memA.find((m) => m.component === "RECIPIENT")!;
    expect(destMem.observationKey).toBe(observationKey(destSourceId, 6, "DESTINATION", DOC_FRAGMENTS.DESTINATION));
    expect(flowMem.observationKey).toBe(observationKey(flowSourceId, 2, "FLOW_PATH", DOC_FRAGMENTS.FLOW_PATH));
    expect(recipientMem.observationKey).toBe(observationKey(govSourceId, 6, "RECIPIENT", GOV_FRAGMENTS.RECIPIENT!));
    for (const m of [destMem, flowMem, recipientMem]) {
      expect((await promoteToActive(ctx.db, m.id, admin)).lifecycleState).toBe("ACTIVE");
    }

    // The arranged obstacles, each through a lawful state change:
    //   FLOW_PATH — time passes beyond the HIGH_CHANGE window (3 days).
    expect(flowMem.freshnessClass).toBe("HIGH_CHANGE");
    await ctx.db
      .update(researchMemory)
      .set({ verifiedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) })
      .where(eq(researchMemory.id, flowMem.id));
    //   RECIPIENT — the human withdraws the governance route (ACTIVE ->
    //   DEPRECATED is a lawful lifecycle move). The memory row is untouched.
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.govRouteId));
    //   CURRENT_STATE — an ACTIVE row exists (fixture lifecycle path, with
    //   full provenance from A's own row) for a component that is fresh-only.
    const currentA = (await evidenceOf(jobA, "CURRENT_STATE"))[0];
    const { id: currentMemId } = await observeMemoryCandidate(ctx.db, {
      projectId: project.id,
      topicId: await activeTopicId(),
      patternStep: 5,
      component: "CURRENT_STATE",
      claimKey: "current_state",
      statement: currentA.summary ?? currentA.fragment,
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 95,
      originKind: "TEST_FIXTURE_FRESH_ONLY",
    });
    await promoteToActive(ctx.db, currentMemId, admin);
    await copyProvenanceFromEvidence(ctx.db, currentMemId, currentA.id);
    const activeIds = [destMem.id, flowMem.id, recipientMem.id, currentMemId].sort();
    expect((await memoryOf(project.id)).filter((m) => m.lifecycleState === "ACTIVE").map((m) => m.id).sort()).toEqual(activeIds);

    //   And A's own CONCLUSIONS are corrupted after the fact: if anything
    //   downstream copied A's verdict, confidence or S5 status, B would
    //   show it. (The observation rows and the memory rows are untouched.)
    await ctx.db.update(proofs).set({ verdict: "NOT_SUPPORTED", confidence: 1 }).where(eq(proofs.id, proofA.id));
    await ctx.db
      .update(researchComponentResults)
      .set({ status: "CONTRADICTED" })
      .where(and(eq(researchComponentResults.researchJobId, jobA), eq(researchComponentResults.component, "DESTINATION")));

    const memoryRowsBeforeB = await countRows(researchMemory);
    const provenanceRowsBeforeB = await countRows(researchMemoryProvenance);

    // =================================================================
    // CONTROL — the same Research B with no usable Memory (disabled).
    // =================================================================
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);
    const runC = acquisitionExecutor(project, (c) => docUrl(c));
    const jobC = await newJob(project.id, project.slug);
    await handleResearchJobTask(ctx.db, jobC, runC.executor);
    expect((await ledgerOf(jobC)).state).toBe("SUCCEEDED");
    const { view: viewC } = await loadJobContractView(ctx.db, jobC);
    expect(viewC.reused).toEqual([]);
    expect(viewC.workQueue.length).toBe(10);
    expect(await attemptsOf(jobC)).toEqual(ALL_COMPONENTS.map((c) => `${STEP_OF[c]}:${c}`).sort());
    for (const c of ALL_COMPONENTS) expect(runC.counters[c]).toEqual({ proposer: 1, search: 1, fetch: 1, extract: 1 });
    const [retrievalC] = await ctx.db.select().from(memoryRetrievals).where(eq(memoryRetrievals.researchJobId, jobC));
    expect(retrievalC.retrievedCount).toBe(0);

    // =================================================================
    // RESEARCH B — same project, Memory enabled for the controlled fixture.
    // =================================================================
    await setMemoryEnabled(true);
    const runB = acquisitionExecutor(project, (c) => docUrl(c));
    const jobB = await newJob(project.id, project.slug);
    const handledB = await handleResearchJobTask(ctx.db, jobB, runB.executor);
    expect(handledB.claimed).toBe(true);
    expect((await ledgerOf(jobB)).state).toBe("SUCCEEDED");

    // 3. MEMORY WAS CONSULTED FIRST — before any acquisition: the planning
    //    stage retrieved exactly the four ACTIVE rows and the planner closed
    //    exactly the three that are healthy; FLOW_PATH is memory-informed
    //    fresh work (STALE), and no other component knows of any memory.
    const [retrievalB] = await ctx.db.select().from(memoryRetrievals).where(eq(memoryRetrievals.researchJobId, jobB));
    expect((retrievalB.hits as { memoryId: string }[]).map((h) => h.memoryId).sort()).toEqual(activeIds);
    const { view: plannedB } = await loadJobContractView(ctx.db, jobB);
    expect(plannedB.reused.map((r) => `${r.step}:${r.component}`).sort()).toEqual(["5:CURRENT_STATE", "6:DESTINATION", "6:RECIPIENT"]);
    const flowItem = plannedB.workQueue.find((w) => w.component === "FLOW_PATH")!;
    expect(flowItem.state).toBe("UNUSABLE");
    expect(flowItem.blockers).toEqual(["STALE"]);
    expect(flowItem.memoryIds).toEqual([flowMem.id]);
    for (const w of plannedB.workQueue.filter((w) => w.component !== "FLOW_PATH")) {
      expect(w.state).toBe("NO_MEMORY");
    }

    // 4/6. THE REUSED OBLIGATION — DESTINATION: adopted as ordinary current-
    //    job Evidence with the pointer and the copied provenance, established
    //    by ordinary S5, never attempted, never acquired.
    const destRowsB = await evidenceOf(jobB, "DESTINATION");
    expect(destRowsB.length).toBe(1);
    const adoptedDest = destRowsB[0];
    expect(adoptedDest.reusedFromMemoryId).toBe(destMem.id);
    expect(adoptedDest.researchJobId).toBe(jobB);
    expect(adoptedDest.fragment).toBe(DOC_FRAGMENTS.DESTINATION);
    expect(adoptedDest.sourceId).toBe(destSourceId);
    expect(adoptedDest.retrievedUrl).toBe(docUrl("DESTINATION"));
    expect(adoptedDest.officiality).toBe("CONFIRMED");
    expect(adoptedDest.sourceClass).toBe("OFFICIAL_DOCS");
    expect(adoptedDest.extractionUnitKey).toBe(extractionUnitKey(jobB, destSourceId, 6, "DESTINATION", DOC_FRAGMENTS.DESTINATION));
    const originDest = (await evidenceOf(jobA, "DESTINATION"))[0];
    const [destProv] = await ctx.db.select().from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, destMem.id));
    expect(destProv.originEvidenceId).toBe(originDest.id);
    expect(adoptedDest.contentHash).toBe(destProv.contentHash);
    const s5DestB = await s5Of(jobB, "DESTINATION");
    expect(s5DestB.status).toBe("SUPPORTED");
    expect(s5DestB.supportingEvidenceIds).toEqual([adoptedDest.id]);
    expect(await attemptsOf(jobB)).not.toContain("6:DESTINATION");
    expect(runB.counters.DESTINATION).toEqual({ proposer: 0, search: 0, fetch: 0, extract: 0 });

    // 7. EVERY OTHER OBLIGATION WAS ACQUIRED FRESH, for its own reason.
    //    RECIPIENT — adoption ran (the row exists, resolved to today's
    //    weakest authority), S5 was not established by it, the component
    //    returned to fresh work and the final S5 rests on the fresh row.
    const recipientRowsB = await evidenceOf(jobB, "RECIPIENT");
    const adoptedRecipient = recipientRowsB.find((r) => r.reusedFromMemoryId === recipientMem.id)!;
    const freshRecipient = recipientRowsB.find((r) => r.reusedFromMemoryId === null)!;
    expect(adoptedRecipient).toBeDefined();
    expect(freshRecipient).toBeDefined();
    expect(recipientRowsB.length).toBe(2);
    expect(adoptedRecipient.officiality).toBe("CLAIMED");
    expect(adoptedRecipient.sourceClass).not.toBe("GOVERNANCE");
    expect(freshRecipient.officiality).toBe("CONFIRMED");
    const recipientDocSourceId = await sourceIdOf(docUrl("RECIPIENT"));
    expect(freshRecipient.sourceId).toBe(recipientDocSourceId);
    expect(freshRecipient.fragment).toBe(DOC_FRAGMENTS.RECIPIENT);
    const s5RecipientB = await s5Of(jobB, "RECIPIENT");
    expect(s5RecipientB.supportingEvidenceIds).toEqual([freshRecipient.id]);
    expect(runB.counters.RECIPIENT).toEqual({ proposer: 1, search: 1, fetch: 1, extract: 1 });
    //    FLOW_PATH — stale memory is never adopted; fresh acquisition
    //    re-finds the same passage, which is the same observation.
    const flowRowsB = await evidenceOf(jobB, "FLOW_PATH");
    expect(flowRowsB.length).toBe(1);
    expect(flowRowsB[0].reusedFromMemoryId).toBeNull();
    expect(flowRowsB[0].fragment).toBe(DOC_FRAGMENTS.FLOW_PATH);
    expect(runB.counters.FLOW_PATH).toEqual({ proposer: 1, search: 1, fetch: 1, extract: 1 });
    //    CURRENT_STATE — fresh-only: the ACTIVE row is refused before any
    //    read; nothing adopted, freshly acquired.
    const currentRowsB = await evidenceOf(jobB, "CURRENT_STATE");
    expect(currentRowsB.length).toBe(1);
    expect(currentRowsB[0].reusedFromMemoryId).toBeNull();
    expect(runB.counters.CURRENT_STATE).toEqual({ proposer: 1, search: 1, fetch: 1, extract: 1 });
    //    OBSERVED-only and never-observed components: no memory, fresh.
    for (const c of ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "GOVERNANCE_BASIS", "EXECUTION_EVIDENCE", "NET_EFFECT", "DURABILITY_BASIS"] as const) {
      const rows = await evidenceOf(jobB, c);
      expect(rows.length).toBe(1);
      expect(rows[0].reusedFromMemoryId).toBeNull();
      expect(runB.counters[c]).toEqual({ proposer: 1, search: 1, fetch: 1, extract: 1 });
    }
    expect(await attemptsOf(jobB)).toEqual(ALL_COMPONENTS.filter((c) => c !== "DESTINATION").map((c) => `${STEP_OF[c]}:${c}`).sort());

    // 12. COST / WORK — per component, Memory never pays more than control;
    //     for the reused obligation it pays nothing; in total it pays less.
    for (const c of ALL_COMPONENTS) {
      for (const op of ["proposer", "search", "fetch", "extract"] as const) {
        expect(runB.counters[c][op]).toBeLessThanOrEqual(runC.counters[c][op]);
      }
      if (c !== "DESTINATION") expect(runB.counters[c]).toEqual(runC.counters[c]);
    }
    for (const op of ["proposer", "search", "fetch", "extract"] as const) {
      expect(totalOf(runB.counters, op)).toBe(totalOf(runC.counters, op) - 1);
    }
    const traceB = await traceCountsOf(jobB);
    const traceC = await traceCountsOf(jobC);
    expect(traceB.DESTINATION ?? 0).toBe(0);
    expect(traceC.DESTINATION).toBeGreaterThan(0);
    for (const c of ALL_COMPONENTS) {
      if (c === "DESTINATION") continue;
      expect(traceB[c]).toBe(traceC[c]);
    }
    const ledgerB = await ledgerOf(jobB);
    const ledgerC = await ledgerOf(jobC);
    expect(ledgerB.searchQueriesReserved).toBeLessThan(ledgerC.searchQueriesReserved);
    expect(ledgerB.sourceOpensReserved).toBeLessThan(ledgerC.sourceOpensReserved);
    expect(ledgerB.modelCostMicroReserved).toBeLessThan(ledgerC.modelCostMicroReserved);

    // 5/8/10. A NEW PROOF, of this job, citing the reused observation NEXT
    //     TO fresh Evidence — and not one conclusion of A's in it.
    const proofB = await proofOf(jobB);
    const proofC = await proofOf(jobC);
    expect(proofB).toBeDefined();
    expect(proofB.id).not.toBe(proofA.id);
    expect(proofB.researchJobId).toBe(jobB);
    expect(proofB.verificationStatus).toBe("DRAFT");
    const citedB = await ctx.db.select({ id: evidence.id, component: evidence.component }).from(evidence).where(eq(evidence.proofId, proofB.id));
    const citedC = await ctx.db.select({ id: evidence.id, component: evidence.component }).from(evidence).where(eq(evidence.proofId, proofC.id));
    const freshSovB = (await evidenceOf(jobB, "SOURCE_OF_VALUE"))[0];
    expect(citedB.map((r) => r.id)).toContain(adoptedDest.id);
    expect(citedB.map((r) => r.id)).toContain(freshSovB.id);
    expect(citedB.map((r) => r.id)).not.toContain(adoptedRecipient.id);
    expect(citedB.map((r) => r.id)).not.toContain(originDest.id);
    // The same components are cited as in the control, one row each.
    expect(citedB.map((r) => r.component).sort()).toEqual(citedC.map((r) => r.component).sort());
    // A's corrupted conclusions reached nothing: B equals the control.
    expect(proofB.verdict).toBe(proofC.verdict);
    expect(proofB.confidence).toBe(proofC.confidence);
    expect(proofB.verdict).not.toBe("NOT_SUPPORTED");
    expect(proofB.confidence).not.toBe(1);
    const claimB = await claimSupportOf(jobB);
    const claimC = await claimSupportOf(jobC);
    expect(claimB.status).toBe(claimC.status);
    expect([...claimB.reasonCodes].sort()).toEqual([...claimC.reasonCodes].sort());
    expect(claimB.requirementResults.map((r) => `${r.requirementId}:${r.status}`)).toEqual(claimC.requirementResults.map((r) => `${r.requirementId}:${r.status}`));

    // 9. PROOF QUALITY PARITY — the S5 picture, the assembly's gaps and the
    //    lineage are the control's; the reused observation is the same
    //    canonical observation under the same authority, in the same slot a
    //    fresh extraction takes, with no false branch.
    expect(await s5PictureOf(jobB)).toEqual(await s5PictureOf(jobC));
    const gapsB = await gapsOf(jobB);
    expect(gapsB).toEqual(await gapsOf(jobC));
    expect(gapsB.some((g) => g.startsWith("BRANCH_ATTRIBUTION_UNRESOLVED"))).toBe(false);
    expect(gapsB).not.toContain("MISSING_COMPONENT@DESTINATION");
    const controlDest = (await evidenceOf(jobC, "DESTINATION"))[0];
    expect(controlDest.reusedFromMemoryId).toBeNull();
    expect(observationKey(adoptedDest.sourceId, 6, "DESTINATION", adoptedDest.fragment)).toBe(
      observationKey(controlDest.sourceId, 6, "DESTINATION", controlDest.fragment),
    );
    expect(controlDest.extractionUnitKey).toBe(extractionUnitKey(jobC, destSourceId, 6, "DESTINATION", DOC_FRAGMENTS.DESTINATION));
    for (const axis of ["sourceClass", "officiality", "entityBinding", "relationship", "directness", "sourceId", "retrievedUrl", "fragment", "contentHash"] as const) {
      expect(adoptedDest[axis]).toEqual(controlDest[axis]);
    }
    // No confidence travels with the observation: Evidence carries none,
    // and the Proof's confidence is the control's.
    expect("confidence" in adoptedDest).toBe(false);

    // =================================================================
    // NON-MATCHING PROJECT — another project's Research sees none of it.
    // =================================================================
    const other = await makeProject();
    const jobOther = await newJob(other.id, other.slug);
    await runMemoryPlanningStage(ctx.db, jobOther);
    const [retrievalOther] = await ctx.db.select().from(memoryRetrievals).where(eq(memoryRetrievals.researchJobId, jobOther));
    expect(retrievalOther.retrievedCount).toBe(0);
    expect((await loadJobContractView(ctx.db, jobOther)).view.reused).toEqual([]);

    // =================================================================
    // 11. IDEMPOTENCY / REPEAT.
    // =================================================================
    // Adoption again over the same plan: nothing new, same rows.
    const evidenceRowsAfterB = await countRows(evidence);
    const again = await adoptReusedMemory(ctx.db, jobB, plannedB, new Date());
    expect(again.adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    expect(again.adopted[0].evidenceIds).toEqual([adoptedDest.id]);
    expect(again.fallback.map((f) => `${f.component}:${f.refusals.map((r) => r.reason).join(",")}`).sort()).toEqual([
      "CURRENT_STATE:FRESH_ONLY_COMPONENT",
      "RECIPIENT:NOT_ESTABLISHED",
    ]);
    expect(await countRows(evidence)).toBe(evidenceRowsAfterB);
    // A redelivery of the terminal job does nothing.
    expect(await handleResearchJobTask(ctx.db, jobB, runB.executor)).toEqual({ claimed: false, reason: "NOT_QUEUED" });
    expect(await countRows(evidence)).toBe(evidenceRowsAfterB);
    expect(runB.counters.DESTINATION).toEqual({ proposer: 0, search: 0, fetch: 0, extract: 0 });
    // Nothing in the Research path wrote Memory: counts are as before B.
    expect(await countRows(researchMemory)).toBe(memoryRowsBeforeB);
    expect(await countRows(researchMemoryProvenance)).toBe(provenanceRowsBeforeB);

    // A second identical Research B is deterministic: same queue, same
    // costs, same S5 picture, same verdict, same adopted observation.
    const runB2 = acquisitionExecutor(project, (c) => docUrl(c));
    const jobB2 = await newJob(project.id, project.slug);
    await handleResearchJobTask(ctx.db, jobB2, runB2.executor);
    expect(runB2.counters).toEqual(runB.counters);
    expect(await attemptsOf(jobB2)).toEqual(await attemptsOf(jobB));
    expect(await s5PictureOf(jobB2)).toEqual(await s5PictureOf(jobB));
    expect(await gapsOf(jobB2)).toEqual(gapsB);
    const proofB2 = await proofOf(jobB2);
    expect(proofB2.id).not.toBe(proofB.id);
    expect(proofB2.verdict).toBe(proofB.verdict);
    expect(proofB2.confidence).toBe(proofB.confidence);
    const adoptedDest2 = (await evidenceOf(jobB2, "DESTINATION"))[0];
    expect(adoptedDest2.reusedFromMemoryId).toBe(destMem.id);
    expect(adoptedDest2.extractionUnitKey).toBe(extractionUnitKey(jobB2, destSourceId, 6, "DESTINATION", DOC_FRAGMENTS.DESTINATION));

    // Verifying B: no recursive clone of the adopted observation, no second
    // live row for any observation A already established (the stale
    // FLOW_PATH row included), and exactly ONE genuinely new observation —
    // RECIPIENT as the documentation states it.
    const vB = await markProofVerified(ctx.db, proofB.id, admin);
    expect(vB.memoryCandidates.created.map((c) => c.component)).toEqual(["RECIPIENT"]);
    expect(vB.memoryCandidates.created[0].evidenceId).toBe(freshRecipient.id);
    expect(vB.memoryCandidates.created[0].observationKey).toBe(observationKey(recipientDocSourceId, 6, "RECIPIENT", DOC_FRAGMENTS.RECIPIENT));
    expect(vB.memoryCandidates.refused).toContainEqual({ evidenceId: adoptedDest.id, step: 6, component: "DESTINATION", reason: "REUSED_FROM_MEMORY" });
    expect(vB.memoryCandidates.deduplicated.map((d) => d.memoryId)).toContain(flowMem.id);
    const memAfterVerifyB = await memoryOf(project.id);
    expect(memAfterVerifyB.length).toBe(memA.length + 1 + 1); // + CURRENT_STATE fixture row + RECIPIENT (documentation)
    expect(memAfterVerifyB.filter((m) => m.lifecycleState === "ACTIVE").map((m) => m.id).sort()).toEqual(activeIds);
    expect(memAfterVerifyB.filter((m) => m.component === "DESTINATION").length).toBe(1);
    expect(memAfterVerifyB.filter((m) => m.component === "FLOW_PATH").length).toBe(1);
    const newRecipient = memAfterVerifyB.find((m) => m.component === "RECIPIENT" && m.id !== recipientMem.id)!;
    expect(newRecipient.lifecycleState).toBe("OBSERVED");
    // Verifying B again, and verifying B2, add nothing.
    const vBAgain = await markProofVerified(ctx.db, proofB.id, admin);
    expect(vBAgain.memoryCandidates.created).toEqual([]);
    const vB2 = await markProofVerified(ctx.db, proofB2.id, admin);
    expect(vB2.memoryCandidates.created).toEqual([]);
    expect(vB2.memoryCandidates.refused).toContainEqual({ evidenceId: adoptedDest2.id, step: 6, component: "DESTINATION", reason: "REUSED_FROM_MEMORY" });
    expect((await memoryOf(project.id)).length).toBe(memAfterVerifyB.length);
    // One provenance row per memory row, never more.
    const provPerMemory = await ctx.db
      .select({ memoryId: researchMemoryProvenance.memoryId, n: count() })
      .from(researchMemoryProvenance)
      .where(inArray(researchMemoryProvenance.memoryId, memAfterVerifyB.map((m) => m.id)))
      .groupBy(researchMemoryProvenance.memoryId);
    expect(provPerMemory.length).toBe(memAfterVerifyB.length);
    expect(provPerMemory.every((p) => Number(p.n) === 1)).toBe(true);

    // 16. Production Memory is switched back off and reads as off.
    await setMemoryEnabled(false);
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);
  }, 120_000);
});
