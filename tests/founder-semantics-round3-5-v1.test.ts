import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG, loadProductConfig } from "../src/server/config/product";
import {
  evidence,
  interpretations,
  productConfig,
  projectMemoryItems,
  projects,
  proofs,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMemory,
  researchMemoryProvenance,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { PATTERN_V1_CONTENT, type PatternContent } from "../src/server/domain/pattern";
import { activatePatternVersions } from "../src/server/domain/pattern-activation";
import { computeEntityBinding, identityBindingKey, resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import { MissingActivePatternError } from "../src/server/engine/active-pattern";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { extractionUnitKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { adoptReusedMemory, loadEffectiveJobContractView } from "../src/server/engine/memory-evidence-adoption";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { resolveSourceClass, resolveSourceRoute } from "../src/server/engine/source-authority";
import { promoteToActive } from "../src/server/memory/lifecycle";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import {
  markProofReviewed,
  markProofVerified,
  ProofVerificationRefusedError,
  VERIFIABLE_JOB_STATES,
} from "../src/server/memory/verification";
import { claimResearchJob, createResearchJob, transitionJobState } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask, sweepStaleRunningJobs } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ROUND 3.5 — FOUNDER-APPROVED SEMANTICS, PINNED OVER THE REAL STORE.
//
// Five decisions taken after Round 3, each a rule about what may happen
// BETWEEN two otherwise-correct operations:
//
//   H8   Memory must be fresh at the moment it is adopted, not only when
//        the job was planned. Stale then -> not adopted, fresh fallback.
//   H9   VERIFIED is terminal. A Proof never regresses to REVIEWED / DRAFT.
//   H10  Only a Proof of a job that ended in a successful bounded terminal
//        state (SUCCEEDED, BUDGET_LIMIT_REACHED) may be verified.
//   H11  Documentary Memory is bound to the token identity it was verified
//        under; a replaced identity makes it ineligible for adoption.
//   KILL memory_enabled is re-read immediately before adoption.
//   PAT  (unchanged) a Proof planned under an older Pattern version cannot
//        be verified after a newer one is activated; the transaction rolls
//        back whole.
//
// Every case runs the real lifecycle function over Postgres; the fixture
// WorkExecutor writes ordinary Evidence rows through the real authority
// resolvers. No provider, no model, no network. Sections: A-L the required
// regressions in the Founder's lettering; X the cross-state attacks; N the
// no-false-conclusion assertions (also asserted inline where they belong).
// Section L moves the ACTIVE Pattern version and runs last.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

afterEach(async () => {
  await setMemoryEnabled(false);
});

// ------------------------------------------------------------------ fixture

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
const FRAGMENT: Record<Component, string> = {
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
const SOL_A = "So11111111111111111111111111111111111111112";
const SOL_B = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const DAY_MS = 24 * 3600 * 1000;

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
  host: string;
  docsRouteId: string;
}

async function makeProject(opts: { identity?: string } = {}): Promise<Project> {
  const slug = uniq("r35");
  const host = `docs.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db.insert(projects).values({ slug, name: `Round 3.5 ${slug}`, status: "ACTIVE_CORE" }).returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  if (opts.identity) {
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: opts.identity, ticker: "R35" });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, host, docsRouteId: classified.newItemId };
}

async function replaceIdentity(project: Project, tokenAddress: string): Promise<void> {
  // No supersession act exists for identities: DEPRECATE, then confirm anew.
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "DEPRECATED" })
    .where(and(eq(projectMemoryItems.projectId, project.id), eq(projectMemoryItems.kind, "PROJECT_IDENTITY"), eq(projectMemoryItems.lifecycleState, "ACTIVE")));
  const r = await confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: "solana", tokenAddress, ticker: "R35" });
  if (!r.ok) throw new Error("re-confirm failed: " + r.refusal);
}

function docUrl(project: Pick<Project, "host">, component: Component): string {
  return `https://${project.host}/docs/${component.toLowerCase().replace(/_/g, "-")}`;
}
async function sourceFor(url: string): Promise<string> {
  const urlHash = `sha256:${url}`;
  const [row] = await ctx.db.insert(sources).values({ url, urlHash, sourceType: "OTHER" }).onConflictDoNothing({ target: sources.urlHash }).returning({ id: sources.id });
  if (row) return row.id;
  const [existing] = await ctx.db.select().from(sources).where(eq(sources.urlHash, urlHash));
  return existing.id;
}

async function newJob(project: Pick<Project, "id" | "slug">): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: await activeTopicId(),
      projectId: project.id,
      originalQuestion: "does the buyback and burn reduce the token supply?",
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "does the buyback and burn reduce the token supply" },
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
    originalQuestion: "does the buyback and burn reduce the token supply?",
    status: "READY",
    result: {
      status: "READY",
      project_or_asset: project.slug,
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

// One ordinary documentary Evidence row of THIS job, its authority axes
// resolved through the same calls the real executor makes.
async function insertRow(jobId: string, project: Pick<Project, "id" | "host">, component: Component): Promise<string> {
  const url = docUrl(project, component);
  const sourceId = await sourceFor(url);
  const fragment = FRAGMENT[component];
  const now = new Date();
  const unitKey = extractionUnitKey(jobId, sourceId, STEP_OF[component], component, fragment);
  const route = await resolveSourceRoute(ctx.db, project.id, url);
  const resolvedClass = resolveSourceClass(url, "OTHER", route.routeClass);
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId,
      patternStep: STEP_OF[component],
      component,
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment,
      summary: `${component.toLowerCase().replace(/_/g, " ")}: ${fragment}`,
      mechanismState: null,
      sourceClass: resolvedClass as "OFFICIAL_DOCS",
      officiality: route.officiality,
      entityBinding: computeEntityBinding(url, resolvedClass, null),
      onchainFactKind: null,
      fetchedAt: now,
      publishedAt: now,
      doesNotProve: "does not prove the size of the effect",
      retrievedUrl: url,
      contentHash: `sha256:${url}`,
      extractionUnitKey: unitKey,
    })
    .onConflictDoNothing({ target: evidence.extractionUnitKey, where: sql`${evidence.extractionUnitKey} IS NOT NULL` })
    .returning({ id: evidence.id });
  if (row) return row.id;
  const [existing] = await ctx.db.select({ id: evidence.id }).from(evidence).where(eq(evidence.extractionUnitKey, unitKey));
  return existing.id;
}

type Behaviour = { throws: Error } | { ok: true };
function executorOf(project: Pick<Project, "id" | "host">, plan: Partial<Record<Component, Behaviour>> = {}, worked: string[] = []): WorkExecutor {
  return {
    async execute(item: ComponentWorkItem, c) {
      const component = item.component as Component;
      worked.push(`${item.step}:${component}#${c.attemptNumber}`);
      const b = plan[component];
      if (b && "throws" in b) throw b.throws;
      await insertRow(c.jobId, project, component);
      return { status: "SUCCEEDED", reason: "fixture component completed" };
    },
  };
}

async function runJob(project: Project, plan: Partial<Record<Component, Behaviour>> = {}) {
  const worked: string[] = [];
  const jobId = await newJob(project);
  const handled = await handleResearchJobTask(ctx.db, jobId, executorOf(project, plan, worked));
  if (!handled.claimed) throw new Error("job not claimed");
  return { jobId, worked };
}

// Planned (Memory consulted) but not yet executed — the gap every
// adoption-time rule is about.
async function plannedJob(project: Project) {
  const jobId = await newJob(project);
  if (!(await claimResearchJob(ctx.db, jobId))) throw new Error("claim failed");
  await runMemoryPlanningStage(ctx.db, jobId);
  const { view } = await loadJobContractView(ctx.db, jobId);
  return { jobId, view };
}

async function executePlanned(project: Project, jobId: string) {
  const worked: string[] = [];
  const result = await runS4ResearchJob(ctx.db, jobId, executorOf(project, {}, worked), new Date());
  await transitionJobState(ctx.db, jobId, "SUCCEEDED", "round 3.5 fixture");
  return { worked, result };
}

// ------------------------------------------------------------------- reads

async function jobOf(jobId: string) {
  const [j] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return j;
}
async function proofOf(jobId: string) {
  const [p] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  return p;
}
async function s5Of(jobId: string, component: Component) {
  const [r] = await ctx.db
    .select()
    .from(researchComponentResults)
    .where(and(eq(researchComponentResults.researchJobId, jobId), eq(researchComponentResults.component, component)));
  return r;
}
async function evidenceOf(jobId: string, component?: Component) {
  return ctx.db
    .select()
    .from(evidence)
    .where(component ? and(eq(evidence.researchJobId, jobId), eq(evidence.component, component)) : eq(evidence.researchJobId, jobId))
    .orderBy(evidence.createdAt);
}
async function memoryOf(projectId: string) {
  return ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectId)).orderBy(researchMemory.patternStep, researchMemory.component, researchMemory.createdAt);
}
async function memoryRow(id: string) {
  const [m] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, id));
  return m;
}
async function claimSupportOf(jobId: string) {
  const [r] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  return r;
}
async function countMemory(): Promise<{ memory: number; provenance: number }> {
  const [m] = await ctx.db.select({ n: count() }).from(researchMemory);
  const [p] = await ctx.db.select({ n: count() }).from(researchMemoryProvenance);
  return { memory: Number(m.n), provenance: Number(p.n) };
}
function isCheckViolation(e: unknown): boolean {
  const cause = (e as { cause?: { code?: unknown } })?.cause;
  return (e as { code?: unknown })?.code === "23514" || cause?.code === "23514";
}

// Research A on the project, verified, DESTINATION promoted ACTIVE.
async function verifiedActiveDestination(project: Project) {
  const admin = await makeAdmin();
  const { jobId } = await runJob(project);
  expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
  const proof = await proofOf(jobId);
  const verified = await markProofVerified(ctx.db, proof.id, admin);
  const dest = (await memoryOf(project.id)).find((m) => m.component === "DESTINATION");
  if (!dest) throw new Error("no DESTINATION candidate");
  await promoteToActive(ctx.db, dest.id, admin);
  return { admin, jobId, proof, verified, destId: dest.id };
}

// What a NON-conclusion must look like: the memory row untouched, no
// CONTRADICTED state anywhere in the job, and the project's memory count
// unchanged by the Research path.
async function assertNoFalseConclusion(jobId: string, memoryId: string, before: { memory: number; provenance: number }) {
  const mem = await memoryRow(memoryId);
  expect(mem.lifecycleState).toBe("ACTIVE");
  expect(mem.health).toBe("OK");
  for (const c of ALL_COMPONENTS) {
    const r = await s5Of(jobId, c);
    if (r) expect(r.status).not.toBe("CONTRADICTED");
  }
  const claim = await claimSupportOf(jobId);
  if (claim) {
    expect(claim.status).not.toBe("CONTRADICTED");
    expect(claim.status).not.toBe("NOT_SUPPORTED");
  }
  expect(await countMemory()).toEqual(before);
}

function patternWithDestinationGovernanceOnly(): PatternContent {
  const v2 = JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
  v2.componentRequirements!.DESTINATION.establishingClasses = ["ONCHAIN_VERIFIABLE", "GOVERNANCE"] as never;
  return v2;
}

// ================================================================== H8

describe("H8 — freshness is re-checked at adoption", () => {
  it("A. fresh at plan time, stale before adoption: refused (MEMORY_STALE), no reused Evidence, fresh fallback available, row untouched", async () => {
    const project = await makeProject();
    const { destId } = await verifiedActiveDestination(project);
    expect(DEFAULT_PRODUCT_CONFIG.memory_stale_after_days.HIGH_CHANGE).toBe(3);
    await ctx.db.update(researchMemory).set({ verifiedAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(researchMemory.id, destId));
    const before = await countMemory();

    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date(Date.now() + 2 * DAY_MS));
    expect(adoption.adopted).toEqual([]);
    expect(adoption.fallback.map((f) => `${f.component}:${f.refusals.map((r) => r.reason).join(",")}`)).toEqual(["DESTINATION:MEMORY_STALE"]);
    const item = adoption.workQueue.find((w) => w.component === "DESTINATION")!;
    expect(item).toMatchObject({ state: "NO_MEMORY", blockers: [], memoryIds: [] });
    expect((await evidenceOf(jobId, "DESTINATION")).length).toBe(0);

    // Fresh fallback: the ordinary path acquires the component and the Proof
    // rests on the fresh row. Stale memory is not a contradiction.
    await ctx.db.update(researchMemory).set({ verifiedAt: new Date(Date.now() - 5 * DAY_MS) }).where(eq(researchMemory.id, destId));
    const { worked } = await executePlanned(project, jobId);
    expect(worked).toContain("6:DESTINATION#1");
    const dest = await evidenceOf(jobId, "DESTINATION");
    expect(dest.length).toBe(1);
    expect(dest[0].reusedFromMemoryId).toBeNull();
    expect((await s5Of(jobId, "DESTINATION")).status).toBe("SUPPORTED");
    await assertNoFalseConclusion(jobId, destId, before);
  });

  it("B. fresh at plan time, still fresh at adoption: adopted exactly as before", async () => {
    const project = await makeProject();
    const { destId } = await verifiedActiveDestination(project);
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(adoption.adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    expect(adoption.fallback).toEqual([]);
    const { worked } = await executePlanned(project, jobId);
    expect(worked.some((w) => w.startsWith("6:DESTINATION"))).toBe(false);
    const [dest] = await evidenceOf(jobId, "DESTINATION");
    expect(dest.reusedFromMemoryId).toBe(destId);
    expect((await s5Of(jobId, "DESTINATION")).supportingEvidenceIds).toEqual([dest.id]);
  });

  it("A'. the row's own stale_after policy is honoured at adoption, exactly as at planning", async () => {
    const project = await makeProject();
    const { destId } = await verifiedActiveDestination(project);
    // A 36-hour policy on the row: fresh at 1 day, stale at 2.
    await ctx.db
      .update(researchMemory)
      .set({ staleAfter: sql`make_interval(hours => 36)`, verifiedAt: new Date(Date.now() - DAY_MS) })
      .where(eq(researchMemory.id, destId));
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
    const stillFresh = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(stillFresh.adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    const { jobId: job2, view: view2 } = await plannedJob(project);
    const later = await adoptReusedMemory(ctx.db, job2, view2, new Date(Date.now() + DAY_MS));
    expect(later.fallback.map((f) => f.refusals[0].reason)).toEqual(["MEMORY_STALE"]);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
    await transitionJobState(ctx.db, job2, "FAILED", "fixture");
  });
});

// ================================================================== H9

describe("H9 — VERIFIED is terminal", () => {
  it("C. DRAFT -> VERIFIED, then VERIFIED -> REVIEWED is refused by the act and by the database; DRAFT -> REVIEWED -> VERIFIED still works", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    expect((await markProofReviewed(ctx.db, proof.id, admin)).verificationStatus).toBe("REVIEWED");
    expect((await markProofVerified(ctx.db, proof.id, admin)).verificationStatus).toBe("VERIFIED");
    await expect(markProofReviewed(ctx.db, proof.id, admin)).rejects.toMatchObject({ refusal: "VERIFIED_IS_TERMINAL" });
    for (const weaker of ["REVIEWED", "DRAFT"] as const) {
      await expect(ctx.db.update(proofs).set({ verificationStatus: weaker }).where(eq(proofs.id, proof.id))).rejects.toSatisfy(isCheckViolation);
    }
    const after = await proofOf(jobId);
    expect(after.verificationStatus).toBe("VERIFIED");
    expect(after.verdict).toBe(proof.verdict);
    expect(after.confidence).toBe(proof.confidence);
  });

  it("D. repeated verification of a VERIFIED Proof is idempotent: no row rewrite, same candidate picture, no new memory or provenance", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    const first = await markProofVerified(ctx.db, proof.id, admin);
    const before = await countMemory();
    const rowBefore = await proofOf(jobId);
    const again = await markProofVerified(ctx.db, proof.id, admin);
    expect(again.verificationStatus).toBe("VERIFIED");
    expect(again.memoryCandidates.created).toEqual([]);
    expect(again.memoryCandidates.deduplicated.map((d) => d.memoryId).sort()).toEqual(first.memoryCandidates.created.map((c) => c.memoryId).sort());
    expect(await countMemory()).toEqual(before);
    expect(await proofOf(jobId)).toEqual(rowBefore);
  });
});

// ================================================================== H10

describe("H10 — only a Proof of a successful bounded Research is verifiable", () => {
  it("E. a DRAFT Proof of a SUCCEEDED Research verifies; a BUDGET_LIMIT_REACHED Research's Proof verifies too", async () => {
    expect([...VERIFIABLE_JOB_STATES].sort()).toEqual(["BUDGET_LIMIT_REACHED", "SUCCEEDED"]);
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
    expect((await markProofVerified(ctx.db, (await proofOf(jobId)).id, admin)).verificationStatus).toBe("VERIFIED");

    const { BudgetExhaustedError } = await import("../src/server/engine/budget-exhausted-error");
    const bounded = await runJob(project, { DURABILITY_BASIS: { throws: new BudgetExhaustedError("sourceOpens") } });
    expect((await jobOf(bounded.jobId)).state).toBe("BUDGET_LIMIT_REACHED");
    const boundedProof = await proofOf(bounded.jobId);
    expect(boundedProof).toBeDefined();
    expect((await markProofVerified(ctx.db, boundedProof.id, admin)).verificationStatus).toBe("VERIFIED");
  });

  it("F. a DRAFT Proof of a FAILED technical job is refused (JOB_NOT_SUCCESSFUL), stays persisted as DRAFT, and writes no candidate", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    // The Proof is written by S8 on a run that completed; the terminal
    // state then becomes FAILED through the sweep (a crash before the
    // worker's terminal transaction). See G for the same window end to end.
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    await runS4ResearchJob(ctx.db, jobId, executorOf(project), new Date());
    const proof = await proofOf(jobId);
    expect(proof).toBeDefined();
    await transitionJobState(ctx.db, jobId, "FAILED", "round 3.5: technical failure after S8");
    const before = await countMemory();
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toMatchObject({ refusal: "JOB_NOT_SUCCESSFUL", proofId: proof.id });
    const after = await proofOf(jobId);
    expect(after.verificationStatus).toBe("DRAFT");
    expect(after.verdict).toBe(proof.verdict);
    expect(after.layers).toEqual(proof.layers);
    expect(await countMemory()).toEqual(before);
    expect(await memoryOf(project.id)).toEqual([]);
    // A failed Research is not a negative project finding: the Proof's own
    // verdict is whatever the completed research said, and nothing was
    // rewritten to say otherwise.
    expect(after.verdict).not.toBe("NOT_SUPPORTED");
  });

  it("G. job writes its Proof, then dies before the terminal transaction and is swept FAILED: not verifiable before (RUNNING) or after (FAILED)", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    await runS4ResearchJob(ctx.db, jobId, executorOf(project), new Date());
    const proof = await proofOf(jobId);
    expect((await jobOf(jobId)).state).toBe("RUNNING");
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toMatchObject({ refusal: "JOB_NOT_SUCCESSFUL" });
    await ctx.db.update(researchJobs).set({ startedAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(researchJobs.id, jobId));
    expect(await sweepStaleRunningJobs(ctx.db)).toBeGreaterThanOrEqual(1);
    expect((await jobOf(jobId)).state).toBe("FAILED");
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(ProofVerificationRefusedError);
    expect((await proofOf(jobId)).verificationStatus).toBe("DRAFT");
    expect(await memoryOf(project.id)).toEqual([]);
  });

  it("F'. a job that FAILED mid-queue has no Proof at all; a cancelled or queued job's Proof is refused as well", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const failed = await runJob(project, { MECHANISM_SPEC: { throws: new CapabilityFatalError("fixture", "down") } });
    expect((await jobOf(failed.jobId)).state).toBe("FAILED");
    expect(await proofOf(failed.jobId)).toBeUndefined();

    const queued = await newJob(project);
    const [user] = await ctx.db.select({ userId: researchJobs.userId }).from(researchJobs).where(eq(researchJobs.id, queued));
    const [orphan] = await ctx.db
      .insert(proofs)
      .values({ researchJobId: queued, ownerUserId: user.userId, projectId: project.id, topicId: await activeTopicId(), verdict: "SUPPORTED", confidence: 80, layers: {} })
      .returning();
    await expect(markProofVerified(ctx.db, orphan.id, admin)).rejects.toMatchObject({ refusal: "JOB_NOT_SUCCESSFUL" });
    await transitionJobState(ctx.db, queued, "CANCELLED");
    await expect(markProofVerified(ctx.db, orphan.id, admin)).rejects.toMatchObject({ refusal: "JOB_NOT_SUCCESSFUL" });
    expect((await proofOf(queued)).verificationStatus).toBe("DRAFT");
  });
});

// ================================================================== H11

describe("H11 — documentary memory is bound to the token identity it was verified under", () => {
  it("H. memory under identity A, A deprecated, B confirmed: not adoptable (IDENTITY_CHANGED); row kept ACTIVE, not rebound; fresh Research re-establishes under B", async () => {
    const project = await makeProject({ identity: SOL_A });
    const { destId } = await verifiedActiveDestination(project);
    expect((await memoryRow(destId)).identityKey).toBe(`solana:${SOL_A}`);
    expect(identityBindingKey(await resolveConfirmedIdentity(ctx.db, project.id))).toBe(`solana:${SOL_A}`);
    await replaceIdentity(project, SOL_B);
    expect(identityBindingKey(await resolveConfirmedIdentity(ctx.db, project.id))).toBe(`solana:${SOL_B}`);
    const before = await countMemory();

    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    // The planner does not know about identity; adoption is where it is decided.
    expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(adoption.adopted).toEqual([]);
    expect(adoption.fallback.map((f) => f.refusals.map((r) => r.reason))).toEqual([["IDENTITY_CHANGED"]]);
    expect((await evidenceOf(jobId, "DESTINATION")).length).toBe(0);
    const { worked } = await executePlanned(project, jobId);
    expect(worked).toContain("6:DESTINATION#1");
    const [dest] = await evidenceOf(jobId, "DESTINATION");
    expect(dest.reusedFromMemoryId).toBeNull();
    expect((await s5Of(jobId, "DESTINATION")).status).toBe("SUPPORTED");
    // Identity replacement != the old fact is false; the old row is neither
    // deleted nor rebound.
    const old = await memoryRow(destId);
    expect(old.identityKey).toBe(`solana:${SOL_A}`);
    await assertNoFalseConclusion(jobId, destId, before);

    // Verifying the new Research writes a NEW candidate bound to B (the
    // passage is the same observation, but the live row is A's, so the
    // writer dedups against it — the owner re-establishes by retiring A's).
    const admin = await makeAdmin();
    const vB = await markProofVerified(ctx.db, (await proofOf(jobId)).id, admin);
    expect(vB.memoryCandidates.deduplicated.map((d) => d.memoryId)).toContain(destId);
    await ctx.db.update(researchMemory).set({ lifecycleState: "DEPRECATED" }).where(eq(researchMemory.id, destId));
    const again = await runJob(project);
    const vB2 = await markProofVerified(ctx.db, (await proofOf(again.jobId)).id, admin);
    const reobserved = vB2.memoryCandidates.created.find((c) => c.component === "DESTINATION")!;
    expect(reobserved).toBeDefined();
    expect((await memoryRow(reobserved.memoryId)).identityKey).toBe(`solana:${SOL_B}`);
  });

  it("I. identity unchanged: ordinary adoption unchanged; and a deprecate + re-confirmation of the SAME token is not a replacement", async () => {
    const project = await makeProject({ identity: SOL_A });
    const { destId } = await verifiedActiveDestination(project);
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    expect((await adoptReusedMemory(ctx.db, jobId, view, new Date())).adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");

    await replaceIdentity(project, SOL_A);
    const { jobId: job2, view: view2 } = await plannedJob(project);
    const adoption = await adoptReusedMemory(ctx.db, job2, view2, new Date());
    expect(adoption.adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    expect((await evidenceOf(job2, "DESTINATION"))[0].reusedFromMemoryId).toBe(destId);
    await transitionJobState(ctx.db, job2, "FAILED", "fixture");
  });

  it("I'. a project with no identity: memory bound to nothing is adoptable while the project still has none, and refused once an identity is confirmed", async () => {
    const project = await makeProject();
    const { destId } = await verifiedActiveDestination(project);
    expect((await memoryRow(destId)).identityKey).toBeNull();
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    expect((await adoptReusedMemory(ctx.db, jobId, view, new Date())).adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: "solana", tokenAddress: SOL_A });
    expect(r.ok).toBe(true);
    const { jobId: job2, view: view2 } = await plannedJob(project);
    expect((await adoptReusedMemory(ctx.db, job2, view2, new Date())).fallback.map((f) => f.refusals[0].reason)).toEqual(["IDENTITY_CHANGED"]);
    await transitionJobState(ctx.db, job2, "FAILED", "fixture");
  });
});

// ================================================================== KILL

describe("memory_enabled — re-read immediately before adoption", () => {
  it("J. true at planning, false before adoption: no adoption (MEMORY_DISABLED), no reused Evidence, fresh fallback, Research completes, Memory untouched", async () => {
    const project = await makeProject();
    const { destId } = await verifiedActiveDestination(project);
    const before = await countMemory();
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
    await setMemoryEnabled(false);
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(adoption.adopted).toEqual([]);
    expect(adoption.fallback.map((f) => `${f.component}:${f.refusals.map((r) => r.reason).join(",")}`)).toEqual(["DESTINATION:MEMORY_DISABLED"]);
    expect(adoption.workQueue.find((w) => w.component === "DESTINATION")).toMatchObject({ state: "NO_MEMORY", blockers: [], memoryIds: [] });
    expect((await evidenceOf(jobId, "DESTINATION")).length).toBe(0);
    // The preparation read-back agrees with adoption.
    const effective = await loadEffectiveJobContractView(ctx.db, jobId);
    expect(effective.view.workQueue.some((w) => w.component === "DESTINATION")).toBe(true);
    const { worked, result } = await executePlanned(project, jobId);
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(worked).toContain("6:DESTINATION#1");
    expect((await evidenceOf(jobId)).every((r) => r.reusedFromMemoryId === null)).toBe(true);
    await assertNoFalseConclusion(jobId, destId, before);
    expect(DEFAULT_PRODUCT_CONFIG.memory_enabled).toBe(false);
  });

  it("K. remains true: normal adoption unchanged", async () => {
    const project = await makeProject();
    const { destId } = await verifiedActiveDestination(project);
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(adoption.adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    expect((await evidenceOf(jobId, "DESTINATION"))[0].reusedFromMemoryId).toBe(destId);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
  });
});

// ================================================================== X

describe("X — cross-state attacks", () => {
  it("X1. stale AND switch off: no adoption, deterministic (MEMORY_DISABLED decides first, nothing written either way)", async () => {
    const project = await makeProject();
    const { destId } = await verifiedActiveDestination(project);
    await ctx.db.update(researchMemory).set({ verifiedAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(researchMemory.id, destId));
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    await setMemoryEnabled(false);
    const later = new Date(Date.now() + 2 * DAY_MS);
    const a = await adoptReusedMemory(ctx.db, jobId, view, later);
    const b = await adoptReusedMemory(ctx.db, jobId, view, later);
    expect(a).toEqual(b);
    expect(a.adopted).toEqual([]);
    expect(a.fallback[0].refusals).toEqual([{ memoryId: null, reason: "MEMORY_DISABLED" }]);
    expect((await evidenceOf(jobId)).length).toBe(0);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
  });

  it("X2. identity changed AND memory still fresh: the identity boundary wins, no adoption", async () => {
    const project = await makeProject({ identity: SOL_A });
    const { destId } = await verifiedActiveDestination(project);
    await replaceIdentity(project, SOL_B);
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(adoption.fallback.map((f) => f.refusals[0].reason)).toEqual(["IDENTITY_CHANGED"]);
    expect((await memoryRow(destId)).lifecycleState).toBe("ACTIVE");
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
  });

  it("X3. identity unchanged but the route is superseded: the existing authority re-resolution decides — adopted row CLAIMED, not established, fresh fallback", async () => {
    const project = await makeProject({ identity: SOL_A });
    const { destId } = await verifiedActiveDestination(project);
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(adoption.adopted).toEqual([]);
    expect(adoption.fallback[0].refusals.map((r) => r.reason)).toEqual(["NOT_ESTABLISHED"]);
    const [adopted] = await evidenceOf(jobId, "DESTINATION");
    expect(adopted.reusedFromMemoryId).toBe(destId);
    expect(adopted.officiality).toBe("CLAIMED");
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
  });

  it("X4. a VERIFIED Proof has already produced ACTIVE Memory: an illegal regression attempt mutates neither the Proof nor the Memory history", async () => {
    const project = await makeProject();
    const { proof, destId, admin } = await verifiedActiveDestination(project);
    const memBefore = await memoryRow(destId);
    const before = await countMemory();
    await expect(markProofReviewed(ctx.db, proof.id, admin)).rejects.toMatchObject({ refusal: "VERIFIED_IS_TERMINAL" });
    await expect(ctx.db.update(proofs).set({ verificationStatus: "DRAFT" }).where(eq(proofs.id, proof.id))).rejects.toSatisfy(isCheckViolation);
    expect((await proofOf(proof.researchJobId)).verificationStatus).toBe("VERIFIED");
    expect(await memoryRow(destId)).toEqual(memBefore);
    expect(await countMemory()).toEqual(before);
  });

  it("X5. a FAILED-job Proof with otherwise eligible Evidence: refusal means no OBSERVED candidate at all", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    await runS4ResearchJob(ctx.db, jobId, executorOf(project), new Date());
    // Every documentary component is CONFIRMED, DIRECT, SUPPORTS — eligible.
    const dest = await evidenceOf(jobId, "DESTINATION");
    expect(dest[0].officiality).toBe("CONFIRMED");
    expect((await s5Of(jobId, "DESTINATION")).supportingEvidenceIds).toEqual([dest[0].id]);
    await transitionJobState(ctx.db, jobId, "FAILED", "round 3.5: technical failure after S8");
    const before = await countMemory();
    await expect(markProofVerified(ctx.db, (await proofOf(jobId)).id, admin)).rejects.toMatchObject({ refusal: "JOB_NOT_SUCCESSFUL" });
    expect(await countMemory()).toEqual(before);
    expect(await memoryOf(project.id)).toEqual([]);
  });
});

// ================================================================== V

describe("V — verification audit metadata (Founder, pre-Round 5)", () => {
  it("V1. the transition into VERIFIED records the ADMIN actor and the time; a repeat by another admin rewrites neither; nothing that decides research changes", async () => {
    const project = await makeProject();
    const admin1 = await makeAdmin();
    const admin2 = await makeAdmin();
    const { jobId } = await runJob(project);
    const draft = await proofOf(jobId);
    expect(draft.verifiedBy).toBeNull();
    expect(draft.verifiedAt).toBeNull();
    const t0 = Date.now();
    await markProofVerified(ctx.db, draft.id, admin1);
    const first = await proofOf(jobId);
    expect(first.verifiedBy).toBe(admin1);
    expect(first.verifiedAt).not.toBeNull();
    expect(Math.abs(first.verifiedAt!.getTime() - t0)).toBeLessThan(60_000);
    expect(first.verdict).toBe(draft.verdict);
    expect(first.confidence).toBe(draft.confidence);
    expect(first.layers).toEqual(draft.layers);
    const again = await markProofVerified(ctx.db, draft.id, admin2);
    expect(again.memoryCandidates.created).toEqual([]);
    const second = await proofOf(jobId);
    expect(second.verifiedBy).toBe(admin1);
    expect(second.verifiedAt!.getTime()).toBe(first.verifiedAt!.getTime());
    // The candidate picture and Memory eligibility are unchanged by who
    // verified: the same observations, the same keys.
    const memory = await memoryOf(project.id);
    expect(memory.every((m) => m.originKind === "VERIFIED_RESEARCH")).toBe(true);
    await setMemoryEnabled(true);
    const dest = memory.find((m) => m.component === "DESTINATION")!;
    await promoteToActive(ctx.db, dest.id, admin2);
    const { jobId: jobB, view } = await plannedJob(project);
    expect((await adoptReusedMemory(ctx.db, jobB, view, new Date())).adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    await transitionJobState(ctx.db, jobB, "FAILED", "fixture");
  });

  it("V2. the database guard: VERIFIED cannot be written without an actor and a time, nor with a non-ADMIN actor; the audit columns cannot be rewritten by a regression attempt", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    await expect(ctx.db.update(proofs).set({ verificationStatus: "VERIFIED" }).where(eq(proofs.id, proof.id))).rejects.toSatisfy(isCheckViolation);
    await expect(ctx.db.update(proofs).set({ verificationStatus: "VERIFIED", verifiedBy: admin, verifiedAt: null }).where(eq(proofs.id, proof.id))).rejects.toSatisfy(isCheckViolation);
    await expect(ctx.db.update(proofs).set({ verificationStatus: "VERIFIED", verifiedBy: user.id, verifiedAt: new Date() }).where(eq(proofs.id, proof.id))).rejects.toSatisfy(isCheckViolation);
    expect((await proofOf(jobId)).verificationStatus).toBe("DRAFT");
    await markProofVerified(ctx.db, proof.id, admin);
    const verified = await proofOf(jobId);
    await expect(ctx.db.update(proofs).set({ verificationStatus: "DRAFT", verifiedBy: null, verifiedAt: null }).where(eq(proofs.id, proof.id))).rejects.toSatisfy(isCheckViolation);
    const after = await proofOf(jobId);
    expect(after.verifiedBy).toBe(verified.verifiedBy);
    expect(after.verifiedAt!.getTime()).toBe(verified.verifiedAt!.getTime());
    // Demoting the admin afterwards does not unverify (transition-time check).
    await ctx.db.update(users).set({ role: "USER" }).where(eq(users.id, admin));
    expect((await proofOf(jobId)).verificationStatus).toBe("VERIFIED");
  });
});

// ================================================================== L

describe("L — Pattern version boundary (unchanged rule, runs last)", () => {
  it("L. Pattern changed between Research and verification: verification refuses atomically — Proof DRAFT, zero memory, zero provenance — and an unverifiable old Proof is not a contradiction", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    const before = await countMemory();
    const topicId = await activeTopicId();
    const reports = await activatePatternVersions(ctx.db, { apply: true, code: patternWithDestinationGovernanceOnly() });
    expect(reports.find((r) => r.topicId === topicId)!.action).toBe("ACTIVATED");
    try {
      await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(MissingActivePatternError);
      const after = await proofOf(jobId);
      expect(after.verificationStatus).toBe("DRAFT");
      expect(after.verdict).toBe(proof.verdict);
      expect(await countMemory()).toEqual(before);
      expect(await memoryOf(project.id)).toEqual([]);
    } finally {
      await activatePatternVersions(ctx.db, { apply: true });
    }
    // Back under the code contract the same Proof still cannot be verified:
    // its contract is frozen at the older version. Safe direction, kept.
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(MissingActivePatternError);
    expect((await proofOf(jobId)).verificationStatus).toBe("DRAFT");
  });
});
