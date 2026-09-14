import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG, INTERNAL_ALPHA_V1, loadProductConfig, productConfigSchema } from "../src/server/config/product";
import {
  evidence,
  productConfig,
  projects,
  researchClaimSupport,
  researchComponentResults,
  researchMechanismAssembly,
  researchMemory,
  researchMemoryProvenance,
  proofs,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { extractionUnitKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { adoptReusedMemory } from "../src/server/engine/memory-evidence-adoption";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import {
  copyProvenanceFromEvidence,
  observeMemoryCandidate,
  promoteToActive,
} from "../src/server/memory/lifecycle";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH MEMORY FALLBACK SEMANTIC PARITY V1.
//
// 1. LINEAGE IDENTITY. An adopted memory row and a fresh re-extraction of
//    the same source fragment are ONE extraction unit and must land on one
//    logical lineage slot — never a fork, never a BRANCH_ATTRIBUTION_
//    UNRESOLVED the control has no reason to carry. Genuinely different
//    passages, and genuine conflicts, stay distinct.
// 2. PROPOSER HINT PARITY. Once a component falls back, the executor is
//    handed the control's own work item, so the proposer receives the same
//    hint and the same allowance.
// 3. MEMORY FAILS CLOSED BY DEFAULT. No persisted opt-in means OFF.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  await setMemoryEnabled(true);
});

afterAll(async () => {
  await ctx.close();
});

async function setMemoryEnabled(value: boolean): Promise<void> {
  await ctx.db
    .insert(productConfig)
    .values({ key: "memory_enabled", value })
    .onConflictDoUpdate({ target: productConfig.key, set: { value } });
}

const HOST = "docs.fallbackparity.org";
const DOC_URL = `https://${HOST}/docs/value`;
const FRAGMENT = "protocol fees accrue directly to the treasury contract, which is controlled by the token holders";
const OTHER_FRAGMENT = "every swap routes its fee to the treasury contract before any other allocation is made";
const CONFLICT_FRAGMENT = "the fee switch to the treasury was removed by the last upgrade and no fees accrue there today";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

type RowOverride = { fragment?: string; relationship?: "SUPPORTS" | "CONTRADICTS"; mechanismState?: string | null; directness?: "DIRECT" | "INDIRECT" };

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeAdmin(): Promise<string> {
  const [a] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
  return a.id;
}

async function makeProject(): Promise<{ id: string; slug: string; name: string }> {
  const slug = uniq("fbparity");
  const [p] = await ctx.db.insert(projects).values({ slug, name: "Fallback parity project", status: "ACTIVE_CORE" }).returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  return { id: p.id, slug, name: p.name };
}

async function makeSource(): Promise<{ id: string }> {
  const [row] = await ctx.db
    .insert(sources)
    .values({ url: DOC_URL, urlHash: `sha256:${DOC_URL}`, sourceType: "OFFICIAL_DOCS" })
    .onConflictDoNothing({ target: sources.urlHash })
    .returning({ id: sources.id });
  if (row) return { id: row.id };
  const [existing] = await ctx.db.select().from(sources).where(eq(sources.urlHash, `sha256:${DOC_URL}`));
  return { id: existing.id };
}

async function newJob(projectId: string, opts: { plan: boolean } = { plan: false }): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: await activeTopicId(),
      projectId,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "does protocol revenue reach token holders" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  if (opts.plan) await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

// The fixture acquisition, persisted exactly as s4-executor persists a
// fact: the canonical unit key and the same conflict rule (a unit this job
// already holds is a no-op). `rowFor` lets one component carry a different
// passage, relationship or state.
function fixtureExecutor(sourceId: string, worked: string[], rowFor: (item: ComponentWorkItem) => RowOverride = () => ({})): WorkExecutor {
  return {
    async execute(item, c) {
      worked.push(`${item.step}:${item.component}`);
      const o = rowFor(item);
      const fragment = o.fragment ?? FRAGMENT;
      await ctx.db
        .insert(evidence)
        .values({
          researchJobId: c.jobId,
          proofId: null,
          sourceId,
          patternStep: item.step,
          component: item.component,
          relationship: o.relationship ?? "SUPPORTS",
          directness: o.directness ?? "DIRECT",
          fragment,
          summary: "protocol fees accrue to the treasury",
          mechanismState: o.mechanismState ?? null,
          sourceClass: "OFFICIAL_DOCS",
          officiality: "CONFIRMED",
          fetchedAt: new Date(),
          publishedAt: new Date(),
          doesNotProve: "does not prove distribution to holders",
          retrievedUrl: DOC_URL,
          contentHash: `sha256:${uniq("content")}`,
          extractionUnitKey: extractionUnitKey(c.jobId, sourceId, item.step, item.component, fragment),
        })
        .onConflictDoNothing({ target: evidence.extractionUnitKey, where: sql`${evidence.extractionUnitKey} IS NOT NULL` });
      return { status: "SUCCEEDED", reason: "fixture component completed" };
    },
  };
}

async function evidenceOf(jobId: string, component: string) {
  return ctx.db.select().from(evidence).where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, component)));
}

async function s5Of(jobId: string, component: string) {
  const [row] = await ctx.db
    .select()
    .from(researchComponentResults)
    .where(and(eq(researchComponentResults.researchJobId, jobId), eq(researchComponentResults.component, component)));
  return row;
}

async function assemblyOf(jobId: string) {
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  const gaps = new Set<string>();
  const flows = (asm?.flows ?? []) as { gaps?: { kind: string; component: string }[] }[];
  for (const f of flows) for (const g of f.gaps ?? []) gaps.add(`${g.kind}@${g.component}`);
  for (const g of (asm?.unassignedGaps ?? []) as { kind: string; component: string }[]) gaps.add(`${g.kind}@${g.component}`);
  return { flowCount: flows.length, gaps: [...gaps].sort() };
}

// S7 and S8, reduced to what a reader compares: status and reasons, the
// per-requirement statuses, the verdict and the confidence.
async function downstreamOf(jobId: string) {
  const [cs] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const [p] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  return {
    claimStatus: cs?.status ?? null,
    claimReasons: [...((cs?.reasonCodes ?? []) as string[])].sort(),
    requirements: ((cs?.requirementResults ?? []) as { requirementId: string; status: string }[])
      .map((r) => `${r.requirementId}:${r.status}`)
      .sort(),
    verdict: p?.verdict ?? null,
    confidence: p?.confidence ?? null,
  };
}

// Research A, then ONE of its observations promoted to ACTIVE memory.
async function researchAThenPromote(
  projectId: string,
  sourceId: string,
  step: number,
  component: string,
  opts: { mechanismState?: string | null } = {},
): Promise<{ jobA: string; originEvidenceId: string; memoryId: string }> {
  const jobA = await newJob(projectId);
  await handleResearchJobTask(
    ctx.db,
    jobA,
    fixtureExecutor(sourceId, [], (item) => (item.component === component ? { mechanismState: opts.mechanismState ?? null } : {})),
  );
  const [origin] = await evidenceOf(jobA, component);
  expect(origin).toBeDefined();
  const admin = await makeAdmin();
  const { id: memoryId } = await observeMemoryCandidate(ctx.db, {
    projectId,
    topicId: await activeTopicId(),
    patternStep: step,
    component,
    claimKey: "economic_source",
    statement: origin.summary ?? origin.fragment,
    mechanismState: opts.mechanismState ?? null,
    freshnessClass: "LOW_CHANGE",
    verifiedAt: new Date(),
    confidence: 90,
    originKind: "TEST_PROMOTION",
  });
  await promoteToActive(ctx.db, memoryId, admin);
  await copyProvenanceFromEvidence(ctx.db, memoryId, origin.id);
  return { jobA, originEvidenceId: origin.id, memoryId };
}

describe("1. lineage identity across memory adoption and fresh acquisition", () => {
  // SOURCE_OF_VALUE is the component whose adoption always falls back under
  // the fixture (its mechanical-provenance cap is off the allowlist), so
  // fallback fresh work re-acquires the component in every case below.
  const STEP = 1;
  const COMPONENT = "SOURCE_OF_VALUE";

  it("A + B + E. control has no false branch; same fragment from memory + fresh acquisition is ONE unit, ONE slot, and S5/S6/S7/S8 equal the control; provenance intact", async () => {
    const src = await makeSource();
    const control = await makeProject();
    const fb = await makeProject();
    const { jobA, originEvidenceId, memoryId } = await researchAThenPromote(fb.id, src.id, STEP, COMPONENT);

    const workedC: string[] = [];
    const workedF: string[] = [];
    const jobC = await newJob(control.id);
    const jobF = await newJob(fb.id);
    await handleResearchJobTask(ctx.db, jobC, fixtureExecutor(src.id, workedC));
    await handleResearchJobTask(ctx.db, jobF, fixtureExecutor(src.id, workedF));

    // A. The control: single row per component, no branch anywhere.
    const asmC = await assemblyOf(jobC);
    expect(asmC.gaps.some((g) => g.startsWith("BRANCH_ATTRIBUTION_UNRESOLVED@"))).toBe(false);
    expect(asmC.flowCount).toBe(1);

    // B. Fallback: the component WAS freshly acquired...
    expect(workedF).toEqual(workedC);
    expect(workedF).toContain(`${STEP}:${COMPONENT}`);
    // ...the adopted row is present with its pointer, and the fresh
    // re-acquisition of the identical passage was the same unit — the
    // canonical key a fresh extraction computes — so it produced no second
    // row and no second slot.
    const rowsF = await evidenceOf(jobF, COMPONENT);
    const adopted = rowsF.find((r) => r.reusedFromMemoryId === memoryId);
    expect(adopted).toBeDefined();
    const canonical = extractionUnitKey(jobF, src.id, STEP, COMPONENT, FRAGMENT);
    expect(adopted!.extractionUnitKey).toBe(canonical);
    expect(rowsF.length).toBe(1);
    // The same passage extracted in the control got the same key SHAPE for
    // its own job — identity is (job, source, step, component, fragment).
    const [rowC] = await evidenceOf(jobC, COMPONENT);
    expect(rowC.extractionUnitKey).toBe(extractionUnitKey(jobC, src.id, STEP, COMPONENT, FRAGMENT));

    // S5 / S6 / S7 / S8 — the fallback equals the control.
    const s5C = await s5Of(jobC, COMPONENT);
    const s5F = await s5Of(jobF, COMPONENT);
    expect(s5F.status).toBe(s5C.status);
    expect(s5F.reasonCodes).toEqual(s5C.reasonCodes);
    expect(s5F.supportingEvidenceIds).toEqual([adopted!.id]);
    const asmF = await assemblyOf(jobF);
    expect(asmF).toEqual(asmC);
    expect(asmF.gaps.some((g) => g.startsWith("BRANCH_ATTRIBUTION_UNRESOLVED@"))).toBe(false);
    expect(await downstreamOf(jobF)).toEqual(await downstreamOf(jobC));
    expect((await downstreamOf(jobF)).verdict).not.toBeNull();

    // E. Provenance: adopted -> memory -> provenance -> origin Evidence of
    // job A, and the origin's own source.
    expect(adopted!.reusedFromMemoryId).toBe(memoryId);
    const [mem] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, memoryId));
    expect(mem.lifecycleState).toBe("ACTIVE");
    const [prov] = await ctx.db.select().from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, memoryId));
    expect(prov.originEvidenceId).toBe(originEvidenceId);
    const [origin] = await ctx.db.select().from(evidence).where(eq(evidence.id, originEvidenceId));
    expect(origin.researchJobId).toBe(jobA);
    expect(adopted!.sourceId).toBe(prov.sourceId);
    expect(adopted!.sourceId).toBe(origin.sourceId);
    expect(adopted!.fragment).toBe(origin.fragment);
    expect(adopted!.retrievedUrl).toBe(prov.retrievedUrl);
    expect(adopted!.contentHash).toBe(prov.contentHash);
  });

  it("C. fresh acquisition finds a genuinely different passage: two units, two slots, lineage stays distinct", async () => {
    const src = await makeSource();
    const control = await makeProject();
    const fb = await makeProject();
    const { memoryId } = await researchAThenPromote(fb.id, src.id, STEP, COMPONENT);

    const jobC = await newJob(control.id);
    const jobF = await newJob(fb.id);
    await handleResearchJobTask(ctx.db, jobC, fixtureExecutor(src.id, []));
    await handleResearchJobTask(
      ctx.db,
      jobF,
      fixtureExecutor(src.id, [], (item) => (item.component === COMPONENT ? { fragment: OTHER_FRAGMENT } : {})),
    );

    const rowsF = await evidenceOf(jobF, COMPONENT);
    expect(rowsF.length).toBe(2);
    const adopted = rowsF.find((r) => r.reusedFromMemoryId === memoryId)!;
    const fresh = rowsF.find((r) => r.reusedFromMemoryId === null)!;
    expect(adopted).toBeDefined();
    expect(fresh).toBeDefined();
    expect(fresh.extractionUnitKey).toBe(extractionUnitKey(jobF, src.id, STEP, COMPONENT, OTHER_FRAGMENT));
    expect(adopted.extractionUnitKey).not.toBe(fresh.extractionUnitKey);
    // Both establish; the reducer keeps both (no DUPLICATE_UNIT).
    const s5F = await s5Of(jobF, COMPONENT);
    expect([...(s5F.supportingEvidenceIds as string[])].sort()).toEqual([adopted.id, fresh.id].sort());
    expect(((s5F.excludedEvidence ?? []) as { reason: string }[]).some((e) => e.reason === "DUPLICATE_UNIT")).toBe(false);
    // Two distinct observations are two lineage slots: the assembler forks
    // where the control (one observation) does not.
    const asmC = await assemblyOf(jobC);
    const asmF = await assemblyOf(jobF);
    expect(asmC.flowCount).toBe(1);
    expect(asmF.flowCount).toBe(2);
  });

  it("D. fresh Evidence genuinely conflicts with the adopted observation: not collapsed, ordinary contradiction semantics apply", async () => {
    // FLOW_PATH carries mechanism state in the fixture: the adopted row says
    // LIVE, the fresh row (another passage) says REMOVED and contradicts.
    const STATE_STEP = 2;
    const STATE_COMPONENT = "FLOW_PATH";
    const src = await makeSource();
    const fb = await makeProject();
    const { memoryId } = await researchAThenPromote(fb.id, src.id, STATE_STEP, STATE_COMPONENT, { mechanismState: "LIVE" });

    // Adoption alone: SUPPORTED by the adopted LIVE row -> the component is
    // closed. Force the conflict through the ordinary path by running the
    // job with an executor that, for this component, writes the
    // contradicting passage — a component memory closed is never worked, so
    // the fresh row is inserted directly the way a later extraction would.
    const jobF = await newJob(fb.id, { plan: true });
    const { view } = await loadJobContractView(ctx.db, jobF);
    const adoption = await adoptReusedMemory(ctx.db, jobF, view, new Date());
    expect(adoption.adopted.map((a) => a.component)).toEqual([STATE_COMPONENT]);
    const adopted = (await evidenceOf(jobF, STATE_COMPONENT)).find((r) => r.reusedFromMemoryId === memoryId)!;
    expect(adopted.mechanismState).toBe("LIVE");

    const worked: string[] = [];
    const conflicting = fixtureExecutor(src.id, worked, () => ({ fragment: CONFLICT_FRAGMENT, relationship: "CONTRADICTS", mechanismState: "REMOVED" }));
    await conflicting.execute(
      { step: STATE_STEP, stepName: "Revenue Waterfall", component: STATE_COMPONENT, state: "NO_MEMORY", blockers: [], memoryIds: [], conflictingMemoryIds: [] },
      { jobId: jobF, attemptNumber: 1, isRecoveryAttempt: false, budget: INTERNAL_ALPHA_V1 },
    );
    const rows = await evidenceOf(jobF, STATE_COMPONENT);
    expect(rows.length).toBe(2);
    const fresh = rows.find((r) => r.reusedFromMemoryId === null)!;
    expect(fresh.extractionUnitKey).not.toBe(adopted.extractionUnitKey);

    // The ordinary reducer over both rows: a genuine state conflict.
    const { reconcileAndPersistComponent } = await import("../src/server/engine/component-reconciliation-store");
    const result = await reconcileAndPersistComponent(ctx.db, jobF, { step: STATE_STEP, component: STATE_COMPONENT }, new Date());
    expect(result.status).toBe("CONTRADICTED");
    expect(result.reasonCodes).toEqual(["CONFLICTING_STATE"]);
    expect([...result.contradictingEvidenceIds].sort()).toEqual([adopted.id, fresh.id].sort());
    expect(result.supportingEvidenceIds).toEqual([]);
  });
});

describe("2. fallback proposer hint parity", () => {
  it("the executor hands the proposer the same hint and allowance for a fallback component as for the no-memory control", async () => {
    const src = await makeSource();
    const control = await makeProject();
    const fb = await makeProject();
    // SOURCE_OF_VALUE: adoption reduces to PARTIALLY_SUPPORTED and falls
    // back; it also plans no deterministic chain locators, so the proposer
    // is genuinely called.
    const { memoryId } = await researchAThenPromote(fb.id, src.id, 1, "SOURCE_OF_VALUE");

    const jobC = await newJob(control.id, { plan: true });
    const jobF = await newJob(fb.id, { plan: true });
    const { view: viewC } = await loadJobContractView(ctx.db, jobC);
    const { view: viewF } = await loadJobContractView(ctx.db, jobF);
    expect(viewF.reused.map((r) => r.component)).toEqual(["SOURCE_OF_VALUE"]);
    const adoptionC = await adoptReusedMemory(ctx.db, jobC, viewC, new Date());
    const adoptionF = await adoptReusedMemory(ctx.db, jobF, viewF, new Date());
    expect(adoptionF.fallback.map((f) => f.component)).toEqual(["SOURCE_OF_VALUE"]);
    // The memory failure stays inspectable on the outcome and the rows...
    expect(adoptionF.fallback[0].memoryIds).toEqual([memoryId]);
    expect(adoptionF.fallback[0].refusals.map((r) => r.reason)).toEqual(["NOT_ESTABLISHED"]);
    expect((await evidenceOf(jobF, "SOURCE_OF_VALUE"))[0].reusedFromMemoryId).toBe(memoryId);
    // ...and never on the work item the executor sees.
    const itemC = adoptionC.workQueue.find((w) => w.component === "SOURCE_OF_VALUE")!;
    const itemF = adoptionF.workQueue.find((w) => w.component === "SOURCE_OF_VALUE")!;
    expect(itemF).toEqual(itemC);
    expect(adoptionF.workQueue.map((w) => `${w.step}:${w.component}`)).toEqual(adoptionC.workQueue.map((w) => `${w.step}:${w.component}`));

    const doc = (): Awaited<ReturnType<ContentFetcher["fetch"]>> => ({
      finalUrl: DOC_URL,
      requestedUrl: DOC_URL,
      httpStatus: 200,
      contentType: "text/markdown",
      normalizedText: `Fixture documentation. ${FRAGMENT}.`,
      contentHash: "sha256:fixture-raw-bytes-hash",
      fetchedAt: new Date(),
      byteLength: 200,
      staticTextLength: 200,
    });
    function executorFor(project: { id: string; name: string; slug: string }, calls: Array<{ hint: string; maxQueries: number; component: string }>, searches: string[]) {
      return createS4WorkExecutor({
        db: ctx.db,
        project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
        queryProposer: {
          name: "fixture-proposer",
          async proposeQueries(input) {
            calls.push({ hint: input.hint, maxQueries: input.maxQueries, component: input.target.component });
            return ["treasury fee accrual"];
          },
        },
        searchGateway: {
          name: "fixture-search",
          async search(query) {
            searches.push(query);
            return [{ url: DOC_URL, title: null, snippet: null }];
          },
        },
        contentFetcher: { name: "fixture-fetch", async fetch() { return doc(); } },
        evidenceExtractor: { name: "fixture-extract", async extract() { return []; } },
        queryProposerCostProfile: COST,
        evidenceExtractorCostProfile: COST,
        chainAcquisition: "DOCUMENTARY_ONLY",
      });
    }
    const runCtx = (jobId: string, queue: ComponentWorkItem[]) => ({
      jobId,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries, maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens, maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro },
      workQueueSize: queue.length,
      remainingComponents: queue.length,
      pendingComponents: queue.slice(1).map((w) => w.component),
    });
    const callsC: Array<{ hint: string; maxQueries: number; component: string }> = [];
    const callsF: typeof callsC = [];
    const searchesC: string[] = [];
    const searchesF: string[] = [];
    const resultC = await executorFor(control, callsC, searchesC).execute(itemC, runCtx(jobC, adoptionC.workQueue));
    const resultF = await executorFor(fb, callsF, searchesF).execute(itemF, runCtx(jobF, adoptionF.workQueue));

    expect(callsC.length).toBe(1);
    expect(callsF).toEqual(callsC);
    expect(callsC[0].hint).toBe("state=NO_MEMORY; blockers=none");
    expect(searchesF).toEqual(searchesC);
    expect(resultF.status).toBe(resultC.status);
  });
});

describe("3. Research Memory fails closed by default", () => {
  it("the code default is OFF, a missing key parses as OFF, explicit values are honoured", () => {
    expect(DEFAULT_PRODUCT_CONFIG.memory_enabled).toBe(false);
    const { memory_enabled: _dropped, ...withoutKey } = DEFAULT_PRODUCT_CONFIG;
    void _dropped;
    expect(productConfigSchema.parse(withoutKey).memory_enabled).toBe(false);
    expect(productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, memory_enabled: false }).memory_enabled).toBe(false);
    expect(productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, memory_enabled: true }).memory_enabled).toBe(true);
  });

  it("a database with no persisted opt-in row is OFF; the seeded default is OFF; an explicit true row enables it for controlled paths", async () => {
    // No row at all.
    await ctx.db.delete(productConfig).where(eq(productConfig.key, "memory_enabled"));
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);
    // What `seed` writes.
    await ctx.db.insert(productConfig).values({ key: "memory_enabled", value: DEFAULT_PRODUCT_CONFIG.memory_enabled });
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);

    // OFF is honoured by the planner: ACTIVE memory exists and nothing is reused.
    const src = await makeSource();
    const p = await makeProject();
    await setMemoryEnabled(true);
    await researchAThenPromote(p.id, src.id, 2, "FLOW_PATH");
    await setMemoryEnabled(false);
    const off = await newJob(p.id, { plan: true });
    expect((await loadJobContractView(ctx.db, off)).view.reused).toEqual([]);
    // The explicit opt-in still works where a controlled path sets it.
    await setMemoryEnabled(true);
    const on = await newJob(p.id, { plan: true });
    expect((await loadJobContractView(ctx.db, on)).view.reused.map((r) => r.component)).toEqual(["FLOW_PATH"]);
  });
});
