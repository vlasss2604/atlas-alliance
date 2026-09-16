import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import {
  evidence,
  interpretations,
  memoryRetrievals,
  onchainArtifacts,
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
  researchPatterns,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { PATTERN_V1_CONTENT, type PatternContent } from "../src/server/domain/pattern";
import { activatePatternVersions } from "../src/server/domain/pattern-activation";
import { computeEntityBinding, resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import { loadActivePatternVersion, MissingActivePatternError } from "../src/server/engine/active-pattern";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import { evaluateAndPersistClaimSupport } from "../src/server/engine/claim-support-store";
import { reconcileOutstandingComponents } from "../src/server/engine/component-reconciliation-store";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { extractionUnitKey, observationKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { assembleAndPersistMechanism } from "../src/server/engine/mechanism-assembly-store";
import { adoptReusedMemory } from "../src/server/engine/memory-evidence-adoption";
import { loadHistoricalSupplyCandidates } from "../src/server/engine/onchain-supply-candidate-store";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { buildAndPersistProof } from "../src/server/engine/proof-store";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { resolveSourceClass, resolveSourceRoute } from "../src/server/engine/source-authority";
import {
  copyProvenanceFromEvidence,
  NotAdminError,
  observeMemoryCandidate,
  promoteProjectMemoryItem,
  promoteToActive,
} from "../src/server/memory/lifecycle";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { markProofReviewed, markProofVerified, ProofVerificationRefusedError } from "../src/server/memory/verification";
import { claimResearchJob, createResearchJob, transitionJobState } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask, sweepStaleRunningJobs } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 3: THE DB-BACKED STATEFUL CORE.
//
// Rounds 1 and 2 attacked the pure reducers. This round attacks what
// PERSISTS between two otherwise-correct operations: Proof verification,
// Research Memory candidate creation, promotion, adoption, project identity,
// source routes, the Pattern, attempts and jobs, and the transaction and
// idempotency seams between them. Every case runs the REAL lifecycle
// function over the REAL Postgres store — the worker entry point, the
// canonical verification act, the admin promotion, the planner, the
// adoption path, the owner confirmation tools, the Pattern activation
// lifecycle — with a fixture WorkExecutor that writes ordinary Evidence rows
// and never touches a provider. No model, no search, no fetch, no RPC.
//
// The question of the round: can ATLAS become unsafe because the world
// changed BETWEEN Research A and Research B?
//
// Sections: A verified -> candidate; B observed -> active; C active ->
// adoption; D identity; E source routes; F Pattern; G job / attempt terminal
// states; H transaction / idempotency; I cross-project contamination; J the
// H7 provenance boundary; K the independent pass over state the plan did
// not name. Section F changes the topic's ACTIVE Pattern version and runs
// LAST: a job planned under an earlier version can never be verified after
// a later one is activated (case F1 pins exactly that), so nothing after F
// may depend on a job created before it.

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
// The documentary components Research Memory may ever close under Pattern v1.
const ADOPTABLE = ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION", "RECIPIENT"] as const;

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

// A real onboarded project: its own docs host, confirmed at /docs and
// classified OFFICIAL_DOCS through the two owner tools. `host` may be shared
// between projects on purpose (section I).
async function makeProject(opts: { host?: string; ticker?: string; classify?: boolean } = {}): Promise<Project> {
  const slug = uniq("r3");
  const host = opts.host ?? `docs.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug, name: `Round 3 ${slug}`, status: "ACTIVE_CORE", ticker: opts.ticker ?? null })
    .returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  let docsRouteId = confirmed.itemId;
  if (opts.classify !== false) {
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
    docsRouteId = classified.newItemId;
  }
  return { id: p.id, slug, host, docsRouteId };
}

function docUrl(project: Pick<Project, "host">, component: Component, variant = ""): string {
  return `https://${project.host}/docs/${component.toLowerCase().replace(/_/g, "-")}${variant}`;
}

async function sourceFor(url: string): Promise<string> {
  const urlHash = `sha256:${url}`;
  const [row] = await ctx.db
    .insert(sources)
    .values({ url, urlHash, sourceType: "OTHER" })
    .onConflictDoNothing({ target: sources.urlHash })
    .returning({ id: sources.id });
  if (row) return row.id;
  const [existing] = await ctx.db.select().from(sources).where(eq(sources.urlHash, urlHash));
  return existing.id;
}

async function newJob(project: Pick<Project, "id" | "slug">, intent = "PROTOCOL_REVENUE_TO_TOKEN"): Promise<string> {
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
      normalized_intent: intent,
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  return job.id;
}

interface RowSpec {
  url?: string;
  fragment?: string;
  sourceClass?: string;
  officiality?: "CONFIRMED" | "CLAIMED";
  directness?: "DIRECT" | "INDIRECT";
  relationship?: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
  mechanismState?: string | null;
  publishedAt?: Date | null;
}

// One ordinary documentary Evidence row of THIS job, written the way the
// executor's persist step writes one: canonical unit key, complete
// provenance, and the two authority axes resolved through the SAME three
// calls the real executor makes (the project's ACTIVE routes NOW, the class
// NOW, the binding NOW) — so a route the human withdraws between two
// Research runs changes the fresh row exactly as it changes the adopted one.
// A spec may pin either axis to stage an ineligible row beside eligible ones.
async function insertRow(jobId: string, project: Pick<Project, "id" | "host">, component: Component, spec: RowSpec = {}): Promise<string> {
  const url = spec.url ?? docUrl(project, component);
  const sourceId = await sourceFor(url);
  const fragment = spec.fragment ?? FRAGMENT[component];
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
      relationship: spec.relationship ?? "SUPPORTS",
      directness: spec.directness ?? "DIRECT",
      fragment,
      summary: `${component.toLowerCase().replace(/_/g, " ")}: ${fragment}`,
      mechanismState: spec.mechanismState ?? null,
      sourceClass: (spec.sourceClass ?? resolvedClass) as "OFFICIAL_DOCS",
      officiality: spec.officiality ?? route.officiality,
      entityBinding: computeEntityBinding(url, spec.sourceClass ?? resolvedClass, null),
      onchainFactKind: null,
      fetchedAt: now,
      publishedAt: spec.publishedAt === undefined ? now : spec.publishedAt,
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

type Behaviour =
  | { rows?: RowSpec[]; status?: "SUCCEEDED" | "FAILED" | "SKIPPED"; reason?: string }
  | { throws: Error };

// The fixture WorkExecutor: per component, either write the given rows (one
// default CONFIRMED docs row when none are given) and return the given
// status, or throw — exactly the two ways a real executor ends an attempt.
function executorOf(project: Pick<Project, "id" | "host">, plan: Partial<Record<Component, Behaviour>> = {}, worked: string[] = []): WorkExecutor {
  return {
    async execute(item: ComponentWorkItem, c) {
      const component = item.component as Component;
      worked.push(`${item.step}:${component}#${c.attemptNumber}`);
      const b = plan[component] ?? {};
      if ("throws" in b) throw b.throws;
      for (const spec of b.rows ?? [{}]) await insertRow(c.jobId, project, component, spec);
      return { status: b.status ?? "SUCCEEDED", reason: b.reason ?? "fixture component completed" };
    },
  };
}

async function runJob(project: Project, plan: Partial<Record<Component, Behaviour>> = {}, intent?: string): Promise<{ jobId: string; worked: string[] }> {
  const worked: string[] = [];
  const jobId = await newJob(project, intent);
  const handled = await handleResearchJobTask(ctx.db, jobId, executorOf(project, plan, worked));
  if (!handled.claimed) throw new Error("job not claimed");
  return { jobId, worked };
}

// A job walked to the end of S8 WITHOUT the worker's terminal transaction —
// the crash window every stateful case in section G opens on purpose.
async function runJobWithoutTerminal(project: Project, plan: Partial<Record<Component, Behaviour>> = {}, now = new Date()) {
  const worked: string[] = [];
  const jobId = await newJob(project);
  const claimed = await claimResearchJob(ctx.db, jobId);
  if (!claimed) throw new Error("claim failed");
  await runMemoryPlanningStage(ctx.db, jobId);
  const result = await runS4ResearchJob(ctx.db, jobId, executorOf(project, plan, worked), now);
  return { jobId, worked, result };
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
async function s5PictureOf(jobId: string) {
  const out: Record<string, { status: string; reasonCodes: string[]; supporting: number } | null> = {};
  for (const c of ALL_COMPONENTS) {
    const r = await s5Of(jobId, c);
    out[c] = r
      ? { status: r.status, reasonCodes: [...(r.reasonCodes as string[])].sort(), supporting: (r.supportingEvidenceIds as string[]).length }
      : null;
  }
  return out;
}
async function evidenceOf(jobId: string, component?: Component) {
  return ctx.db
    .select()
    .from(evidence)
    .where(component ? and(eq(evidence.researchJobId, jobId), eq(evidence.component, component)) : eq(evidence.researchJobId, jobId))
    .orderBy(evidence.createdAt);
}
async function memoryOf(projectId: string) {
  return ctx.db
    .select()
    .from(researchMemory)
    .where(eq(researchMemory.projectId, projectId))
    .orderBy(researchMemory.patternStep, researchMemory.component, researchMemory.createdAt);
}
async function provenanceCountOf(memoryId: string): Promise<number> {
  const [r] = await ctx.db.select({ n: count() }).from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, memoryId));
  return Number(r.n);
}
async function attemptsOf(jobId: string) {
  const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  return rows.map((r) => `${r.patternStep}:${r.component}#${r.attemptNumber}=${r.status}`).sort();
}
async function claimSupportOf(jobId: string) {
  const [r] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  return r;
}
async function assemblyOf(jobId: string) {
  const [r] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  return r;
}
async function gapsOf(jobId: string): Promise<string[]> {
  const asm = await assemblyOf(jobId);
  const out = new Set<string>();
  for (const f of (asm?.flows ?? []) as { gaps?: { kind: string; component: string }[] }[]) {
    for (const g of f.gaps ?? []) out.add(`${g.kind}@${g.component}`);
  }
  for (const g of (asm?.unassignedGaps ?? []) as { kind: string; component: string }[]) out.add(`${g.kind}@${g.component}`);
  return [...out].sort();
}
async function citedOf(proofId: string) {
  return ctx.db.select({ id: evidence.id, component: evidence.component }).from(evidence).where(eq(evidence.proofId, proofId));
}
async function activeIdentityRows(projectId: string) {
  return ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, projectId), eq(projectMemoryItems.kind, "PROJECT_IDENTITY"), eq(projectMemoryItems.lifecycleState, "ACTIVE")));
}
async function activeRouteRows(projectId: string) {
  return ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, projectId), eq(projectMemoryItems.kind, "SOURCE_ROUTE"), eq(projectMemoryItems.lifecycleState, "ACTIVE")));
}
async function insertActiveRoute(projectId: string, content: Record<string, unknown>): Promise<string> {
  const [row] = await ctx.db.insert(projectMemoryItems).values({ projectId, kind: "SOURCE_ROUTE", content, lifecycleState: "OBSERVED" }).returning();
  await promoteProjectMemoryItem(ctx.db, row.id);
  return row.id;
}

// Research A on a fresh project, verified, with the named components promoted
// ACTIVE through the real admin path. The common prologue of sections B–C.
async function verifiedAndPromoted(project: Project, promote: readonly Component[], plan: Partial<Record<Component, Behaviour>> = {}) {
  const admin = await makeAdmin();
  const { jobId } = await runJob(project, plan);
  expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
  const proof = await proofOf(jobId);
  const verified = await markProofVerified(ctx.db, proof.id, admin);
  const memory = await memoryOf(project.id);
  const promoted: Record<string, string[]> = {};
  for (const c of promote) {
    const rows = memory.filter((m) => m.component === c);
    if (rows.length === 0) throw new Error(`no OBSERVED memory for ${c}`);
    for (const m of rows) expect((await promoteToActive(ctx.db, m.id, admin)).lifecycleState).toBe("ACTIVE");
    promoted[c] = rows.map((m) => m.id);
  }
  return { admin, jobId, proof, verified, memory, promoted };
}

// Drizzle wraps the driver error; the SQLSTATE sits on the cause.
function sqlState(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const direct = (e as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (e as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}
function isUniqueViolation(e: unknown): boolean {
  return sqlState(e) === "23505";
}
function isCheckViolation(e: unknown): boolean {
  return sqlState(e) === "23514";
}

// Pattern v1 with ONE semantic change: DESTINATION may no longer be
// established from OFFICIAL_DOCS. Everything else, byte for byte.
function patternWithDestinationGovernanceOnly(): PatternContent {
  const v2 = JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
  v2.componentRequirements!.DESTINATION.establishingClasses = ["ONCHAIN_VERIFIABLE", "GOVERNANCE"] as never;
  return v2;
}
async function restoreCodePattern(): Promise<void> {
  await activatePatternVersions(ctx.db, { apply: true });
}

// ================================================================== A

describe("A. VERIFIED -> OBSERVED candidates over the real store", () => {
  it("A1. verifying the same Proof three times CONCURRENTLY, then again, yields one live row per observation, one provenance copy each, and only eligible rows", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    // MECHANISM_SPEC carries an eligible row AND two ineligible ones beside
    // it (CLAIMED, INDIRECT); SOURCE_OF_VALUE is PARTIALLY_SUPPORTED by its
    // obligation. Both still yield exactly their eligible rows.
    const { jobId } = await runJob(project, {
      MECHANISM_SPEC: {
        rows: [
          {},
          { url: `https://claimed.${project.host}/x`, fragment: "a claimed restatement of the allocation rule", officiality: "CLAIMED", sourceClass: "SOCIAL" },
          { url: docUrl(project, "MECHANISM_SPEC", "-indirect"), fragment: "the allocation is implied by the fee table", directness: "INDIRECT" },
        ],
      },
    });
    expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
    const proof = await proofOf(jobId);
    expect(proof.verificationStatus).toBe("DRAFT");
    expect(await memoryOf(project.id)).toEqual([]);

    const results = await Promise.all([
      markProofVerified(ctx.db, proof.id, admin),
      markProofVerified(ctx.db, proof.id, admin),
      markProofVerified(ctx.db, proof.id, admin),
    ]);
    for (const r of results) expect(r.verificationStatus).toBe("VERIFIED");
    const again = await markProofVerified(ctx.db, proof.id, admin);
    expect(again.memoryCandidates.created).toEqual([]);

    const memory = await memoryOf(project.id);
    const keys = new Set(memory.map((m) => m.observationKey));
    expect(keys.size).toBe(memory.length);
    expect(memory.every((m) => m.lifecycleState === "OBSERVED")).toBe(true);
    // Across the three concurrent calls exactly one created each observation.
    const createdAll = results.flatMap((r) => r.memoryCandidates.created.map((c) => c.observationKey));
    expect(new Set(createdAll).size).toBe(createdAll.length);
    expect(createdAll.length).toBe(memory.length);
    for (const m of memory) expect(await provenanceCountOf(m.id)).toBe(1);
    // Only the adoptable, eligible rows: never a fresh-only component, never
    // the CLAIMED or INDIRECT rows beside the eligible one.
    for (const m of memory) expect(ADOPTABLE).toContain(m.component);
    const mechRows = memory.filter((m) => m.component === "MECHANISM_SPEC");
    expect(mechRows.length).toBe(1);
    expect(mechRows[0].statement).toContain(FRAGMENT.MECHANISM_SPEC);
    // The CLAIMED row never reached the writer (S5 excluded it, so it is not
    // "supporting"); the INDIRECT row IS a supporting row of a
    // PARTIALLY_SUPPORTED-capable set and is refused by the allowlist.
    const mechS5 = await s5Of(jobId, "MECHANISM_SPEC");
    expect((mechS5.supportingEvidenceIds as string[]).length).toBe(2);
    const refusals = again.memoryCandidates.refused.map((r) => `${r.component}:${r.reason}`).sort();
    expect(refusals).toContain("MECHANISM_SPEC:DIRECTNESS_NOT_DIRECT");
    expect(refusals).toContain("CURRENT_STATE:FRESH_ONLY_COMPONENT");
    expect(refusals.every((r) => r.endsWith(":FRESH_ONLY_COMPONENT") || r === "MECHANISM_SPEC:DIRECTNESS_NOT_DIRECT")).toBe(true);
    expect(refusals.some((r) => r.includes("OFFICIALITY"))).toBe(false);
    // A verified Proof is immutable to S8 from now on.
    expect((await buildAndPersistProof(ctx.db, jobId)).refusal).toBe("PROOF_NOT_DRAFT");
  });

  it("A2. a supporting Evidence row that disappears before verification is skipped, not fabricated and not fatal; the rest still become candidates", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const [flow] = await evidenceOf(jobId, "FLOW_PATH");
    expect((await s5Of(jobId, "FLOW_PATH")).supportingEvidenceIds).toEqual([flow.id]);
    await ctx.db.delete(evidence).where(eq(evidence.id, flow.id));

    const verified = await markProofVerified(ctx.db, (await proofOf(jobId)).id, admin);
    const created = verified.memoryCandidates.created.map((c) => c.component);
    expect(created).not.toContain("FLOW_PATH");
    expect(created).toContain("DESTINATION");
    expect(verified.memoryCandidates.refused.map((r) => r.evidenceId)).not.toContain(flow.id);
    expect((await memoryOf(project.id)).some((m) => m.component === "FLOW_PATH")).toBe(false);
  });

  it("A3. a candidate whose ORIGIN Evidence row is deleted after creation is never adopted: the component returns to fresh work, the memory row is untouched", async () => {
    const project = await makeProject();
    const { promoted, jobId: jobA } = await verifiedAndPromoted(project, ["DESTINATION"]);
    const [originDest] = await evidenceOf(jobA, "DESTINATION");
    await ctx.db.delete(evidence).where(eq(evidence.id, originDest.id));

    await setMemoryEnabled(true);
    const { jobId: jobB, worked } = await runJob(project);
    expect((await jobOf(jobB)).state).toBe("SUCCEEDED");
    const { view } = await loadJobContractView(ctx.db, jobB);
    expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
    const destB = await evidenceOf(jobB, "DESTINATION");
    expect(destB.length).toBe(1);
    expect(destB[0].reusedFromMemoryId).toBeNull();
    expect(worked).toContain("6:DESTINATION#1");
    expect((await s5Of(jobB, "DESTINATION")).status).toBe("SUPPORTED");
    const again = await adoptReusedMemory(ctx.db, jobB, view, new Date());
    expect(again.fallback[0].refusals.map((r) => r.reason)).toEqual(["ORIGIN_EVIDENCE_MISSING"]);
    const [mem] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, promoted.DESTINATION[0]));
    expect(mem.lifecycleState).toBe("ACTIVE");
  });
});

// ================================================================== B

describe("B. OBSERVED -> ACTIVE promotion", () => {
  it("B1. promoting an already-ACTIVE row again is a no-op: the first human decision stays on record, and two admins racing to promote produce exactly one promotion", async () => {
    const project = await makeProject();
    const admin1 = await makeAdmin();
    const admin2 = await makeAdmin();
    const { jobId } = await runJob(project);
    await markProofVerified(ctx.db, (await proofOf(jobId)).id, admin1);
    const memory = await memoryOf(project.id);
    const dest = memory.find((m) => m.component === "DESTINATION")!;
    const flow = memory.find((m) => m.component === "FLOW_PATH")!;

    // Sequential repeat by a different admin.
    const first = await promoteToActive(ctx.db, dest.id, admin1);
    expect(first.promotedBy).toBe(admin1);
    const [afterFirst] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, dest.id));
    const second = await promoteToActive(ctx.db, dest.id, admin2);
    expect(second.lifecycleState).toBe("ACTIVE");
    expect(second.promotedBy).toBe(admin1);
    const [afterSecond] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, dest.id));
    expect(afterSecond.promotedBy).toBe(admin1);
    expect(afterSecond.promotedAt!.getTime()).toBe(afterFirst.promotedAt!.getTime());

    // Concurrent first promotion by two admins.
    const outcomes = await Promise.allSettled([promoteToActive(ctx.db, flow.id, admin1), promoteToActive(ctx.db, flow.id, admin2)]);
    const [flowAfter] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, flow.id));
    expect(flowAfter.lifecycleState).toBe("ACTIVE");
    expect([admin1, admin2]).toContain(flowAfter.promotedBy);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled") as PromiseFulfilledResult<{ promotedBy: string | null }>[];
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const f of fulfilled) expect(f.value.promotedBy).toBe(flowAfter.promotedBy);
    for (const o of outcomes) if (o.status === "rejected") expect(isCheckViolation(o.reason)).toBe(true);
  });

  it("B2. no lifecycle shortcut: DEPRECATED and SUPERSEDED rows cannot be promoted, a non-admin cannot promote, and a demoted admin's earlier promotion stands", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { jobId } = await runJob(project);
    await markProofVerified(ctx.db, (await proofOf(jobId)).id, admin);
    const memory = await memoryOf(project.id);
    const [a, b, c] = memory;

    await expect(promoteToActive(ctx.db, a.id, user.id)).rejects.toBeInstanceOf(NotAdminError);
    expect((await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, a.id)))[0].lifecycleState).toBe("OBSERVED");

    await ctx.db.update(researchMemory).set({ lifecycleState: "DEPRECATED" }).where(eq(researchMemory.id, b.id));
    await expect(promoteToActive(ctx.db, b.id, admin)).rejects.toSatisfy(isCheckViolation);
    expect((await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, b.id)))[0].lifecycleState).toBe("DEPRECATED");

    await promoteToActive(ctx.db, c.id, admin);
    await ctx.db.update(researchMemory).set({ lifecycleState: "SUPERSEDED" }).where(eq(researchMemory.id, c.id));
    await expect(promoteToActive(ctx.db, c.id, admin)).rejects.toSatisfy(isCheckViolation);
    expect((await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, c.id)))[0].lifecycleState).toBe("SUPERSEDED");

    // Direct insert of anything but OBSERVED is refused by the guard.
    await expect(
      ctx.db.insert(researchMemory).values({
        projectId: project.id,
        topicId: await activeTopicId(),
        patternStep: 6,
        component: "DESTINATION",
        claimKey: "destination",
        statement: "x",
        freshnessClass: "LOW_CHANGE",
        verifiedAt: new Date(),
        confidence: 80,
        originKind: "ROUND3",
        lifecycleState: "ACTIVE",
        promotedBy: admin,
      }),
    ).rejects.toSatisfy(isCheckViolation);

    // Demotion after the fact does not un-promote (transition-time check).
    await promoteToActive(ctx.db, a.id, admin);
    await ctx.db.update(users).set({ role: "USER" }).where(eq(users.id, admin));
    expect((await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, a.id)))[0].lifecycleState).toBe("ACTIVE");
  });

  it("B3. one LIVE row per observation: a second live row with the same key is refused; once the first is DEPRECATED, re-verification re-observes it and promotion yields exactly one ACTIVE row", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId: jobA } = await runJob(project);
    await markProofVerified(ctx.db, (await proofOf(jobA)).id, admin);
    const dest = (await memoryOf(project.id)).find((m) => m.component === "DESTINATION")!;
    await expect(
      ctx.db.insert(researchMemory).values({
        projectId: project.id,
        topicId: dest.topicId,
        patternStep: 6,
        component: "DESTINATION",
        claimKey: "destination",
        statement: "duplicate",
        freshnessClass: "LOW_CHANGE",
        verifiedAt: new Date(),
        confidence: 80,
        originKind: "ROUND3",
        observationKey: dest.observationKey,
      }),
    ).rejects.toSatisfy(isUniqueViolation);

    await ctx.db.update(researchMemory).set({ lifecycleState: "DEPRECATED" }).where(eq(researchMemory.id, dest.id));
    const { jobId: jobA2 } = await runJob(project);
    const v2 = await markProofVerified(ctx.db, (await proofOf(jobA2)).id, admin);
    const reobserved = v2.memoryCandidates.created.find((c) => c.component === "DESTINATION")!;
    expect(reobserved).toBeDefined();
    expect(reobserved.observationKey).toBe(dest.observationKey);
    expect(reobserved.memoryId).not.toBe(dest.id);
    await promoteToActive(ctx.db, reobserved.memoryId, admin);
    const destRows = (await memoryOf(project.id)).filter((m) => m.component === "DESTINATION");
    expect(destRows.map((m) => m.lifecycleState).sort()).toEqual(["ACTIVE", "DEPRECATED"]);
  });

  it("B4. two ACTIVE observations of the same fact from two sources do not strengthen a later Research beyond a single fresh observation", async () => {
    const project = await makeProject();
    const twoDest: Behaviour = { rows: [{}, { url: docUrl(project, "DESTINATION", "-faq"), fragment: "buyback purchases are transferred to the burn address permanently" }] };
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION"], { DESTINATION: twoDest });
    expect(promoted.DESTINATION.length).toBe(2);

    // Two controls: the same two observations acquired fresh (parity), and a
    // single fresh observation (the "strengthening" comparison).
    const { jobId: controlTwo } = await runJob(project, { DESTINATION: twoDest });
    const { jobId: controlOne } = await runJob(project);
    await setMemoryEnabled(true);
    const { jobId: jobB, worked } = await runJob(project);
    const destB = await evidenceOf(jobB, "DESTINATION");
    expect(destB.map((r) => r.reusedFromMemoryId).sort()).toEqual([...promoted.DESTINATION].sort());
    expect(worked.some((w) => w.startsWith("6:DESTINATION"))).toBe(false);
    const s5B = await s5Of(jobB, "DESTINATION");
    expect(s5B.status).toBe("SUPPORTED");
    expect((s5B.supportingEvidenceIds as string[]).length).toBe(2);
    expect(await s5PictureOf(jobB)).toEqual(await s5PictureOf(controlTwo));
    expect(await gapsOf(jobB)).toEqual(await gapsOf(controlTwo));
    const proofB = await proofOf(jobB);
    for (const control of [controlTwo, controlOne]) {
      const proofC = await proofOf(control);
      expect(proofB.verdict).toBe(proofC.verdict);
      expect(proofB.confidence).toBe(proofC.confidence);
      expect((await claimSupportOf(jobB)).status).toBe((await claimSupportOf(control)).status);
    }
    // Multiplicity never removes a gap the single observation leaves open.
    const gapsOne = await gapsOf(controlOne);
    const gapsB = await gapsOf(jobB);
    for (const g of gapsOne) expect(gapsB).toContain(g);
  });
});

// ================================================================== C

describe("C. ACTIVE memory -> adoption, with the world changed in between", () => {
  it("C1. route ACTIVE at creation, DEPRECATED before adoption: the adopted row is CLAIMED today, establishes nothing, and Research B equals the no-memory control under the same withdrawn route", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION", "FLOW_PATH"]);
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));

    const { jobId: control } = await runJob(project);
    await setMemoryEnabled(true);
    const { jobId: jobB, worked } = await runJob(project);
    expect((await jobOf(jobB)).state).toBe("SUCCEEDED");
    const destB = await evidenceOf(jobB, "DESTINATION");
    const adopted = destB.find((r) => r.reusedFromMemoryId === promoted.DESTINATION[0])!;
    expect(adopted).toBeDefined();
    expect(adopted.officiality).toBe("CLAIMED");
    expect(adopted.sourceClass).not.toBe("OFFICIAL_DOCS");
    expect(worked).toContain("6:DESTINATION#1");
    expect(worked).toContain("2:FLOW_PATH#1");
    const s5 = await s5Of(jobB, "DESTINATION");
    expect(s5.supportingEvidenceIds as string[]).not.toContain(adopted.id);
    expect(await s5PictureOf(jobB)).toEqual(await s5PictureOf(control));
    const proofB = await proofOf(jobB);
    const proofC = await proofOf(control);
    expect(proofB.verdict).toBe(proofC.verdict);
    expect(proofB.confidence).toBe(proofC.confidence);
    expect((await citedOf(proofB.id)).map((r) => r.id)).not.toContain(adopted.id);
  });

  it("C2. source class changed before adoption (docs path re-classified GOVERNANCE): the adopted row carries today's class, is excluded by the component's admissibility, and the component is acquired fresh", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION"]);
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));
    const reconfirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: project.host, pathPrefix: "/docs" });
    expect(reconfirmed.ok).toBe(true);
    const reclassified = await classifySourceRoute(ctx.db, { routeId: (reconfirmed as { itemId: string }).itemId, routeClass: "GOVERNANCE" });
    expect(reclassified.ok).toBe(true);

    const { jobId: control } = await runJob(project);
    await setMemoryEnabled(true);
    const { jobId: jobB, worked } = await runJob(project);
    const destB = await evidenceOf(jobB, "DESTINATION");
    const adopted = destB.find((r) => r.reusedFromMemoryId === promoted.DESTINATION[0])!;
    expect(adopted.officiality).toBe("CONFIRMED");
    expect(adopted.sourceClass).toBe("GOVERNANCE");
    expect(worked).toContain("6:DESTINATION#1");
    const s5 = await s5Of(jobB, "DESTINATION");
    expect(s5.supportingEvidenceIds as string[]).not.toContain(adopted.id);
    expect((s5.excludedEvidence as { evidenceId: string }[]).map((e) => e.evidenceId)).toContain(adopted.id);
    expect(await s5PictureOf(jobB)).toEqual(await s5PictureOf(control));
    expect((await proofOf(jobB)).confidence).toBe((await proofOf(control)).confidence);
  });

  it("C3. H11 — documentary memory is bound to the token identity it was verified under: after the identity is replaced, an ACTIVE observation is refused (IDENTITY_CHANGED), the row is untouched, and the component is acquired fresh", async () => {
    const project = await makeProject();
    const mintA = "So11111111111111111111111111111111111111112";
    const mintB = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
    const identityA = await confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: "solana", tokenAddress: mintA, ticker: "R3" });
    expect(identityA.ok).toBe(true);
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION"]);
    // No lifecycle act supersedes an identity today; the only replacement
    // path is a manual DEPRECATE followed by a fresh confirmation.
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, (identityA as { itemId: string }).itemId));
    const identityB = await confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: "solana", tokenAddress: mintB, ticker: "R3" });
    expect(identityB.ok).toBe(true);
    expect((await resolveConfirmedIdentity(ctx.db, project.id))?.tokenAddress).toBe(mintB);

    await setMemoryEnabled(true);
    const { jobId: jobB, worked } = await runJob(project);
    expect((await jobOf(jobB)).state).toBe("SUCCEEDED");
    const destB = await evidenceOf(jobB, "DESTINATION");
    expect(destB.length).toBe(1);
    expect(destB[0].reusedFromMemoryId).toBeNull();
    expect(worked).toContain("6:DESTINATION#1");
    const { view } = await loadJobContractView(ctx.db, jobB);
    const again = await adoptReusedMemory(ctx.db, jobB, view, new Date());
    expect(again.fallback.map((f) => f.refusals.map((r) => r.reason))).toEqual([["IDENTITY_CHANGED"]]);
    const [mem] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, promoted.DESTINATION[0]));
    expect(mem.lifecycleState).toBe("ACTIVE");
    expect(mem.identityKey).toBe(`solana:${mintA}`);
    // The memory family never holds a chain observation; nothing adopted here
    // carries a chain kind or artifact.
    for (const row of await evidenceOf(jobB)) {
      expect(row.onchainFactKind).toBeNull();
      expect(row.onchainArtifactId).toBeNull();
    }
  });

  it("C4. H8 — freshness is re-checked at adoption: an observation fresh at planning that crosses its window before adoption is refused (MEMORY_STALE), stays ACTIVE, and the component is fresh work", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["FLOW_PATH"]);
    const flowId = promoted.FLOW_PATH[0];
    // HIGH_CHANGE window is 3 days: verified 2 days ago is fresh at plan time.
    expect(DEFAULT_PRODUCT_CONFIG.memory_stale_after_days.HIGH_CHANGE).toBe(3);
    await ctx.db.update(researchMemory).set({ verifiedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) }).where(eq(researchMemory.id, flowId));

    await setMemoryEnabled(true);
    const jobB = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobB)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobB);
    const { view } = await loadJobContractView(ctx.db, jobB);
    expect(view.reused.map((r) => r.component)).toEqual(["FLOW_PATH"]);
    const tenDaysLater = new Date(Date.now() + 10 * 24 * 3600 * 1000);
    const adoption = await adoptReusedMemory(ctx.db, jobB, view, tenDaysLater);
    expect(adoption.adopted).toEqual([]);
    expect(adoption.fallback.map((f) => `${f.component}:${f.refusals.map((r) => r.reason).join(",")}`)).toEqual(["FLOW_PATH:MEMORY_STALE"]);
    expect(adoption.workQueue.some((w) => w.component === "FLOW_PATH" && w.state === "NO_MEMORY")).toBe(true);
    expect((await evidenceOf(jobB, "FLOW_PATH")).length).toBe(0);
    const [mem] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, flowId));
    expect(mem.lifecycleState).toBe("ACTIVE");
    await transitionJobState(ctx.db, jobB, "FAILED", "round 3 fixture: case ends here");
  });

  it("C5. two ACTIVE observations that disagree on mechanism state are CONTRADICTED at planning: nothing is adopted and the component is fresh work", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId: jobA } = await runJob(project);
    const [mechA] = await evidenceOf(jobA, "MECHANISM_SPEC");
    const topicId = await activeTopicId();
    const ids: string[] = [];
    for (const state of ["LIVE", "PAUSED"]) {
      const { id } = await observeMemoryCandidate(ctx.db, {
        projectId: project.id,
        topicId,
        patternStep: 3,
        component: "MECHANISM_SPEC",
        claimKey: "mechanism_spec",
        statement: `mechanism ${state}`,
        mechanismState: state,
        freshnessClass: "LOW_CHANGE",
        verifiedAt: new Date(),
        confidence: 95,
        originKind: "ROUND3_FIXTURE",
      });
      await copyProvenanceFromEvidence(ctx.db, id, mechA.id);
      await promoteToActive(ctx.db, id, admin);
      ids.push(id);
    }
    await setMemoryEnabled(true);
    const { jobId: jobB, worked } = await runJob(project);
    const { view } = await loadJobContractView(ctx.db, jobB);
    expect(view.reused).toEqual([]);
    const item = view.workQueue.find((w) => w.component === "MECHANISM_SPEC")!;
    expect(item.state).toBe("CONTRADICTED");
    expect([...item.conflictingMemoryIds].sort()).toEqual([...ids].sort());
    expect(worked).toContain("3:MECHANISM_SPEC#1");
    expect((await evidenceOf(jobB, "MECHANISM_SPEC")).every((r) => r.reusedFromMemoryId === null)).toBe(true);
  });

  it("C6. H9 — VERIFIED is terminal: the origin Proof cannot be moved back to REVIEWED (code and database guard), its derived ACTIVE memory is untouched, and a rewritten verdict on the old Proof reaches nothing in Research B", async () => {
    const project = await makeProject();
    const { proof: proofA, promoted, admin } = await verifiedAndPromoted(project, ["DESTINATION"]);
    await expect(markProofReviewed(ctx.db, proofA.id, admin)).rejects.toBeInstanceOf(ProofVerificationRefusedError);
    await expect(ctx.db.update(proofs).set({ verificationStatus: "DRAFT" }).where(eq(proofs.id, proofA.id))).rejects.toSatisfy(isCheckViolation);
    expect((await proofOf(proofA.researchJobId)).verificationStatus).toBe("VERIFIED");
    await ctx.db.update(proofs).set({ verdict: "NOT_SUPPORTED", confidence: 1 }).where(eq(proofs.id, proofA.id));
    const memory = await memoryOf(project.id);
    expect(memory.find((m) => m.id === promoted.DESTINATION[0])!.lifecycleState).toBe("ACTIVE");

    const { jobId: control } = await runJob(project);
    await setMemoryEnabled(true);
    const { jobId: jobB } = await runJob(project);
    const [destB] = await evidenceOf(jobB, "DESTINATION");
    expect(destB.reusedFromMemoryId).toBe(promoted.DESTINATION[0]);
    const proofB = await proofOf(jobB);
    expect(proofB.verdict).toBe((await proofOf(control)).verdict);
    expect(proofB.confidence).toBe((await proofOf(control)).confidence);
    expect(proofB.verdict).not.toBe("NOT_SUPPORTED");
    expect((await buildAndPersistProof(ctx.db, proofA.researchJobId)).refusal).toBe("PROOF_NOT_DRAFT");
    const reverified = await markProofVerified(ctx.db, proofA.id, admin);
    expect(reverified.memoryCandidates.created).toEqual([]);
    expect((await memoryOf(project.id)).length).toBe(memory.length);
  });

  it("C7. KILL SWITCH — memory disabled between planning and execution: nothing is adopted (MEMORY_DISABLED), no reused row is written, the component is acquired fresh, and the Research still completes", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION"]);
    await setMemoryEnabled(true);
    const jobB = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobB)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobB);
    const { view } = await loadJobContractView(ctx.db, jobB);
    expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
    await setMemoryEnabled(false);
    const worked: string[] = [];
    const result = await runS4ResearchJob(ctx.db, jobB, executorOf(project, {}, worked), new Date());
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const destB = await evidenceOf(jobB, "DESTINATION");
    expect(destB.length).toBe(1);
    expect(destB[0].reusedFromMemoryId).toBeNull();
    expect(worked).toContain("6:DESTINATION#1");
    expect((await s5Of(jobB, "DESTINATION")).status).toBe("SUPPORTED");
    const again = await adoptReusedMemory(ctx.db, jobB, view, new Date());
    expect(again.fallback.map((f) => f.refusals.map((r) => r.reason))).toEqual([["MEMORY_DISABLED"]]);
    const [mem] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, promoted.DESTINATION[0]));
    expect(mem.lifecycleState).toBe("ACTIVE");
    await transitionJobState(ctx.db, jobB, "SUCCEEDED", "round 3 fixture");
  });
});

// ================================================================== D

describe("D. project identity lifecycle", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const SOL2 = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
  const EVM = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";

  it("D1. one ACTIVE identity: a second — same ticker/other contract, same contract/other chain, or byte-identical — is refused, and a cross-chain shape never enters", async () => {
    const project = await makeProject();
    const first = await confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: "ethereum", tokenAddress: EVM, ticker: "TKN" });
    expect(first.ok).toBe(true);
    for (const attempt of [
      { chain: "ethereum", tokenAddress: "0x9D03bb2092270648d7480049d0E58d2FcF0E5123", ticker: "TKN" },
      { chain: "bsc", tokenAddress: EVM, ticker: "TKN" },
      { chain: "ethereum", tokenAddress: EVM, ticker: "TKN" },
    ]) {
      const r = await confirmProjectIdentity(ctx.db, { projectSlug: project.slug, ...attempt });
      expect(r.ok).toBe(false);
      expect((r as { refusal: string }).refusal).toBe("ACTIVE_IDENTITY_EXISTS");
    }
    expect((await activeIdentityRows(project.id)).length).toBe(1);
    const other = await makeProject();
    const shape = await confirmProjectIdentity(ctx.db, { projectSlug: other.slug, chain: "solana", tokenAddress: EVM });
    expect((shape as { refusal: string }).refusal).toBe("TOKEN_SHAPE_MISMATCH");
    expect((await activeIdentityRows(other.id)).length).toBe(0);
  });

  it("D2. two CONCURRENT confirmations cannot both succeed: exactly one ACTIVE identity, exactly one ACTIVE route, and the resolver reports the one that won", async () => {
    const project = await makeProject();
    const identityOutcomes = await Promise.all([
      confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: "solana", tokenAddress: SOL }),
      confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: "solana", tokenAddress: SOL2 }),
    ]);
    const identityRows = await activeIdentityRows(project.id);
    expect(identityRows.length).toBe(1);
    const winners = identityOutcomes.filter((o) => o.ok);
    expect(winners.length).toBe(1);
    const resolved = await resolveConfirmedIdentity(ctx.db, project.id);
    expect(resolved?.tokenAddress).toBe((winners[0] as { content: { tokenAddress: string } }).content.tokenAddress);
    const loser = identityOutcomes.find((o) => !o.ok) as { refusal: string };
    expect(loser.refusal).toBe("ACTIVE_IDENTITY_EXISTS");

    const routeOutcomes = await Promise.all([
      confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: `gov.${project.host}`, pathPrefix: "/proposals" }),
      confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: `gov.${project.host}`, pathPrefix: "/proposals" }),
    ]);
    const govRows = (await activeRouteRows(project.id)).filter((r) => JSON.stringify(r.content).includes(`gov.${project.host}`));
    expect(govRows.length).toBe(1);
    expect(routeOutcomes.filter((o) => o.ok).length).toBe(1);
    expect((routeOutcomes.find((o) => !o.ok) as { refusal: string }).refusal).toBe("DUPLICATE_ACTIVE_ROUTE");
    const resolvedRoute = await resolveSourceRoute(ctx.db, project.id, `https://gov.${project.host}/proposals/1`);
    expect(resolvedRoute.matchedPathPrefix).toBe("/proposals");

    // Two concurrent classifications of the one route: one replacement, one refusal.
    const govRouteId = govRows[0].id;
    const classifyOutcomes = await Promise.all([
      classifySourceRoute(ctx.db, { routeId: govRouteId, routeClass: "GOVERNANCE" }),
      classifySourceRoute(ctx.db, { routeId: govRouteId, routeClass: "GOVERNANCE" }),
    ]);
    expect(classifyOutcomes.filter((o) => o.ok).length).toBe(1);
    expect((classifyOutcomes.find((o) => !o.ok) as { refusal: string }).refusal).toBe("ROUTE_NOT_ACTIVE");
    const govAfter = (await activeRouteRows(project.id)).filter((r) => JSON.stringify(r.content).includes(`gov.${project.host}`));
    expect(govAfter.length).toBe(1);
    expect((govAfter[0].content as { routeClass?: string }).routeClass).toBe("GOVERNANCE");
    expect(await resolveSourceRoute(ctx.db, project.id, `https://gov.${project.host}/proposals/1`)).toEqual({
      officiality: "CONFIRMED",
      routeClass: "GOVERNANCE",
      observation: null,
      matchedPathPrefix: "/proposals",
    });
  });

  it("D3. historical on-chain observations are keyed by chain + token address, never by project: an old token's readings do not serve a new token, and a same-address token on another chain is invisible", async () => {
    const project = await makeProject();
    const { jobId: producer } = await runJob(project);
    const [asker] = await ctx.db.insert(researchJobs).values({ ...(await jobOf(producer)), id: undefined as never, idempotencyKey: uniq("idem"), normalizedTaskHash: uniq("h") }).returning();
    const rpcSourceId = await sourceFor("https://rpc.round3.example/");
    const insertArtifact = async (chain: "ethereum" | "bsc", anchor: string, slot: number, jobId = producer) => {
      const intent = { kind: "TOKEN_SUPPLY" as const, chain, network: "mainnet" as const, projectAnchor: anchor, subjectKind: "token", subject: anchor };
      await ctx.db.insert(onchainArtifacts).values({
        originKind: "RESEARCH_JOB",
        researchJobId: jobId,
        sourceId: rpcSourceId,
        canonicalUri: buildCanonicalOnchainUri(intent as never),
        chain,
        network: "mainnet",
        projectAnchor: anchor,
        subjectKind: "token",
        subject: anchor,
        intentKind: "TOKEN_SUPPLY",
        slot,
        finality: "finalized",
        retrievalMethod: "rpc",
        providerId: "round3-fixture",
        providerMethod: "getTokenSupply",
        requestParams: {},
        retrievedAt: new Date(),
        rawResponseHash: uniq("raw"),
        artifactHash: uniq("artifact"),
        normalizedResult: { kind: "TOKEN_SUPPLY", mint: anchor, amountRaw: "1000", decimals: 18 },
      });
    };
    const OLD = EVM;
    const NEW = "0x9D03bb2092270648d7480049d0E58d2FcF0E5123";
    await insertArtifact("ethereum", OLD, 100);
    await insertArtifact("bsc", OLD, 100);
    await insertArtifact("ethereum", OLD, 300);

    const q = (chain: "ethereum" | "bsc", anchor: string) =>
      loadHistoricalSupplyCandidates(ctx.db, { currentResearchJobId: asker.id, projectAnchor: anchor, chain, network: "mainnet", beforeSlot: 200 });
    const ethOld = await q("ethereum", OLD);
    expect(ethOld.length).toBe(1);
    expect(ethOld[0].observation.artifact.intent.chain).toBe("ethereum");
    expect(ethOld[0].observation.artifact.provenance.slot).toBe(100);
    expect((await q("bsc", OLD)).length).toBe(1);
    expect((await q("ethereum", NEW)).length).toBe(0);
    // A job's own readings are never its history.
    expect((await loadHistoricalSupplyCandidates(ctx.db, { currentResearchJobId: producer, projectAnchor: OLD, chain: "ethereum", network: "mainnet", beforeSlot: 200 })).length).toBe(0);
  });
});

// ================================================================== E

describe("E. source route lifecycle and the resolver", () => {
  it("E1. overlapping ACTIVE prefixes resolve deterministically regardless of insertion order: different classes -> CONFIRMED with no class (conflict); same class -> the class, with no single matched prefix", async () => {
    const results: string[] = [];
    for (const order of [0, 1]) {
      const project = await makeProject({ classify: false });
      await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));
      const rows = [
        { domain: project.host, pathPrefix: "/docs", routeClass: "OFFICIAL_DOCS" },
        { domain: project.host, pathPrefix: "/docs/gov", routeClass: "GOVERNANCE" },
      ];
      for (const r of order === 0 ? rows : [...rows].reverse()) await insertActiveRoute(project.id, r);
      const inner = await resolveSourceRoute(ctx.db, project.id, `https://${project.host}/docs/gov/vote-1`);
      const outer = await resolveSourceRoute(ctx.db, project.id, `https://${project.host}/docs/intro`);
      results.push(JSON.stringify({ inner, outer }));
      expect(inner).toEqual({ officiality: "CONFIRMED", routeClass: null, observation: "SOURCE_ROUTE_CONFLICT", matchedPathPrefix: null });
      expect(outer).toEqual({ officiality: "CONFIRMED", routeClass: "OFFICIAL_DOCS", observation: null, matchedPathPrefix: "/docs" });
    }
    expect(results[0]).toBe(results[1]);

    const same = await makeProject({ classify: false });
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, same.docsRouteId));
    await insertActiveRoute(same.id, { domain: same.host, pathPrefix: "/docs", routeClass: "OFFICIAL_DOCS" });
    await insertActiveRoute(same.id, { domain: same.host, pathPrefix: "/docs/api", routeClass: "OFFICIAL_DOCS" });
    expect(await resolveSourceRoute(ctx.db, same.id, `https://${same.host}/docs/api/v1`)).toEqual({
      officiality: "CONFIRMED",
      routeClass: "OFFICIAL_DOCS",
      observation: null,
      matchedPathPrefix: null,
    });
    // A route of another project on the same host confers nothing here.
    const stranger = await makeProject({ host: same.host });
    expect((await resolveSourceRoute(ctx.db, stranger.id, `https://${same.host}/docs/api/v1`)).matchedPathPrefix).toBe("/docs");
  });

  it("E2. a SUPERSEDED route never strengthens: after classification only the replacement resolves, and once the replacement is withdrawn the host is CLAIMED again — the superseded original does not resurface", async () => {
    const project = await makeProject({ classify: false });
    const url = `https://${project.host}/docs/x`;
    expect(await resolveSourceRoute(ctx.db, project.id, url)).toMatchObject({ officiality: "CONFIRMED", routeClass: null, matchedPathPrefix: "/docs" });
    const classified = await classifySourceRoute(ctx.db, { routeId: project.docsRouteId, routeClass: "OFFICIAL_DOCS" });
    expect(classified.ok).toBe(true);
    const { newItemId, supersededItemId } = classified as { newItemId: string; supersededItemId: string };
    expect(supersededItemId).toBe(project.docsRouteId);
    const [old] = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.id, supersededItemId));
    expect(old.lifecycleState).toBe("SUPERSEDED");
    expect(old.supersededBy).toBe(newItemId);
    expect((await resolveSourceRoute(ctx.db, project.id, url)).routeClass).toBe("OFFICIAL_DOCS");
    // Classifying again: the old id is not ACTIVE, the new id is already classified.
    expect((await classifySourceRoute(ctx.db, { routeId: supersededItemId, routeClass: "OFFICIAL_DOCS" }) as { refusal: string }).refusal).toBe("ROUTE_NOT_ACTIVE");
    expect((await classifySourceRoute(ctx.db, { routeId: newItemId, routeClass: "GOVERNANCE" }) as { refusal: string }).refusal).toBe("ALREADY_CLASSIFIED");
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, newItemId));
    expect(await resolveSourceRoute(ctx.db, project.id, url)).toEqual({ officiality: "CLAIMED", routeClass: null, observation: null, matchedPathPrefix: null });
    expect((await activeRouteRows(project.id)).length).toBe(0);
  });

  it("E3. classification that would change ANOTHER route's resolution is rolled back whole: no replacement row, the original still ACTIVE and unclassified", async () => {
    const project = await makeProject({ classify: false });
    // An overlapping unclassified sibling the confirmation tool would refuse
    // — inserted directly, as a hand-written or legacy row could be.
    const sibling = await insertActiveRoute(project.id, { domain: project.host, pathPrefix: "/docs/api" });
    const before = await activeRouteRows(project.id);
    expect(before.length).toBe(2);
    const outcome = await classifySourceRoute(ctx.db, { routeId: project.docsRouteId, routeClass: "OFFICIAL_DOCS" });
    expect(outcome.ok).toBe(false);
    expect((outcome as { refusal: string }).refusal).toBe("RESOLUTION_WOULD_CHANGE");
    const after = await activeRouteRows(project.id);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    const [docs] = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.id, project.docsRouteId));
    expect(docs.lifecycleState).toBe("ACTIVE");
    expect((docs.content as { routeClass?: string }).routeClass).toBeUndefined();
    const [sib] = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.id, sibling));
    expect(sib.lifecycleState).toBe("ACTIVE");
    const [allRows] = await ctx.db.select({ n: count() }).from(projectMemoryItems).where(eq(projectMemoryItems.projectId, project.id));
    expect(Number(allRows.n)).toBe(2);
    expect((await resolveSourceRoute(ctx.db, project.id, `https://${project.host}/docs/api/x`)).routeClass).toBeNull();
  });

  it("E4. sequential duplicate / overlapping confirmation is refused by the tool, and a domain-wide classified row blocks a narrower confirmation that would inherit its class", async () => {
    const project = await makeProject();
    expect((await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: project.host, pathPrefix: "/docs" }) as { refusal: string }).refusal).toBe("DUPLICATE_ACTIVE_ROUTE");
    expect((await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: project.host, pathPrefix: "/docs/api" }) as { refusal: string }).refusal).toBe("OVERLAPPING_ACTIVE_PREFIX");
    const wide = await makeProject({ classify: false });
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, wide.docsRouteId));
    await insertActiveRoute(wide.id, { domain: wide.host, routeClass: "OFFICIAL_DOCS" });
    expect((await confirmSourceRoute(ctx.db, { projectSlug: wide.slug, domain: wide.host, pathPrefix: "/blog" }) as { refusal: string }).refusal).toBe("WOULD_INHERIT_ROUTE_CLASS");
  });
});

// ================================================================== G

describe("G. job / attempt terminal states", () => {
  it("G1. a technical failure mid-queue ends the job FAILED with nothing substantive derived: finished components keep their Evidence and S5 rows, the cut-off attempt stays STARTED, no S6/S7/S8", async () => {
    const project = await makeProject();
    const { jobId, worked } = await runJob(project, { MECHANISM_SPEC: { throws: new CapabilityFatalError("fixture-extractor", "EvidenceExtractorUnavailableError") } });
    const job = await jobOf(jobId);
    expect(job.state).toBe("FAILED");
    expect(job.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(job.errorCode).toBe("CapabilityFatalError");
    expect(worked).toEqual(["1:SOURCE_OF_VALUE#1", "2:FLOW_PATH#1", "3:MECHANISM_SPEC#1"]);
    expect(await attemptsOf(jobId)).toEqual(["1:SOURCE_OF_VALUE#1=SUCCEEDED", "2:FLOW_PATH#1=SUCCEEDED", "3:MECHANISM_SPEC#1=STARTED"]);
    expect((await evidenceOf(jobId, "SOURCE_OF_VALUE")).length).toBe(1);
    expect((await evidenceOf(jobId, "FLOW_PATH")).length).toBe(1);
    expect((await s5Of(jobId, "FLOW_PATH")).status).toBe("SUPPORTED");
    expect(await s5Of(jobId, "MECHANISM_SPEC")).toBeUndefined();
    expect(await assemblyOf(jobId)).toBeUndefined();
    expect(await claimSupportOf(jobId)).toBeUndefined();
    expect(await proofOf(jobId)).toBeUndefined();
    expect((await buildAndPersistProof(ctx.db, jobId)).refusal).toBe("NO_CLAIM_SUPPORT");
    // The terminal state is final: a redelivery does nothing, no transition is legal.
    expect(await handleResearchJobTask(ctx.db, jobId, executorOf(project))).toEqual({ claimed: false, reason: "NOT_QUEUED" });
    await expect(transitionJobState(ctx.db, jobId, "SUCCEEDED")).rejects.toSatisfy(isCheckViolation);
  });

  it("G2. budget exhaustion mid-queue finalizes honestly and exactly once: BUDGET_LIMIT_REACHED, a Proof with the unwalked components as gaps, no attempt rows for them, and re-finalization changes nothing", async () => {
    const project = await makeProject();
    const { jobId, worked } = await runJob(project, { GOVERNANCE_BASIS: { throws: new BudgetExhaustedError("sourceOpens") } });
    const job = await jobOf(jobId);
    expect(job.state).toBe("BUDGET_LIMIT_REACHED");
    expect(job.terminationReason).toBe("BUDGET_EXHAUSTED");
    expect(worked.length).toBe(4);
    const attempts = await attemptsOf(jobId);
    expect(attempts.length).toBe(4);
    expect(attempts).toContain("3:GOVERNANCE_BASIS#1=STARTED");
    const proof = await proofOf(jobId);
    expect(proof).toBeDefined();
    expect(proof.verificationStatus).toBe("DRAFT");
    expect(await s5Of(jobId, "DESTINATION")).toBeUndefined();
    expect(await gapsOf(jobId)).toContain("DESTINATION_UNRESOLVED@DESTINATION");
    const before = { proof, s5: await s5PictureOf(jobId), gaps: await gapsOf(jobId), cited: (await citedOf(proof.id)).map((c) => c.id).sort() };
    const { view } = await loadJobContractView(ctx.db, jobId);
    await reconcileOutstandingComponents(ctx.db, jobId, view.workQueue, new Date());
    await assembleAndPersistMechanism(ctx.db, jobId, new Date());
    await evaluateAndPersistClaimSupport(ctx.db, jobId, new Date());
    const again = await buildAndPersistProof(ctx.db, jobId);
    expect(again.proofId).toBe(proof.id);
    expect(again.replacedExisting).toBe(true);
    const after = await proofOf(jobId);
    expect({ verdict: after.verdict, confidence: after.confidence, layers: after.layers }).toEqual({ verdict: before.proof.verdict, confidence: before.proof.confidence, layers: before.proof.layers });
    expect(await s5PictureOf(jobId)).toEqual(before.s5);
    expect(await gapsOf(jobId)).toEqual(before.gaps);
    expect((await citedOf(proof.id)).map((c) => c.id).sort()).toEqual(before.cited);
    expect(await handleResearchJobTask(ctx.db, jobId, executorOf(project))).toEqual({ claimed: false, reason: "NOT_QUEUED" });
  });

  it("G3. retry after partial persisted work: the recovery attempt numbers itself after history, earlier Evidence is kept, the component's S5 row is rewritten from the new attempt and the DRAFT Proof is replaced in place", async () => {
    const project = await makeProject();
    const now = new Date();
    const run1 = await runJobWithoutTerminal(project, { MECHANISM_SPEC: { rows: [], status: "FAILED", reason: "fixture: nothing extracted" } }, now);
    const jobId = run1.jobId;
    expect(run1.result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect((await jobOf(jobId)).state).toBe("RUNNING");
    const proof1 = await proofOf(jobId);
    expect(proof1).toBeDefined();
    expect((await s5Of(jobId, "MECHANISM_SPEC")).status).toBe("INSUFFICIENT_EVIDENCE");
    const gaps1 = await gapsOf(jobId);
    expect(gaps1).toContain("MISSING_COMPONENT@MECHANISM_SPEC");
    const evidence1 = (await evidenceOf(jobId)).map((r) => r.id).sort();

    const worked2: string[] = [];
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    const result2 = await runS4ResearchJob(ctx.db, jobId, executorOf(project, {}, worked2), later);
    expect(result2.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(worked2).toEqual(["3:MECHANISM_SPEC#2"]);
    expect(await attemptsOf(jobId)).toContain("3:MECHANISM_SPEC#1=FAILED");
    expect(await attemptsOf(jobId)).toContain("3:MECHANISM_SPEC#2=SUCCEEDED");
    expect((await s5Of(jobId, "MECHANISM_SPEC")).status).toBe("SUPPORTED");
    const evidence2 = (await evidenceOf(jobId)).map((r) => r.id).sort();
    for (const id of evidence1) expect(evidence2).toContain(id);
    expect(evidence2.length).toBe(evidence1.length + 1);
    const proof2 = await proofOf(jobId);
    expect(proof2.id).toBe(proof1.id);
    expect(proof2.verificationStatus).toBe("DRAFT");
    // The gap the failed attempt left is closed by the recovery attempt's
    // own Evidence; the Proof is the same row, rewritten from current state.
    const gaps2 = await gapsOf(jobId);
    expect(gaps2).not.toContain("MISSING_COMPONENT@MECHANISM_SPEC");
    for (const g of gaps2) expect(gaps1).toContain(g);
    expect(proof2.layers).not.toEqual(proof1.layers);
    await transitionJobState(ctx.db, jobId, "SUCCEEDED", "round 3 fixture");
  });

  it("G4. H10 — the crash window after S8: a job swept FAILED after its Proof was written keeps that DRAFT Proof for audit, and verification refuses it (JOB_NOT_SUCCESSFUL) without writing a candidate", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJobWithoutTerminal(project);
    const proof = await proofOf(jobId);
    expect(proof).toBeDefined();
    // Not terminal yet: not verifiable either.
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toMatchObject({ refusal: "JOB_NOT_SUCCESSFUL" });
    await ctx.db.update(researchJobs).set({ startedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) }).where(eq(researchJobs.id, jobId));
    expect(await sweepStaleRunningJobs(ctx.db)).toBeGreaterThanOrEqual(1);
    const job = await jobOf(jobId);
    expect(job.state).toBe("FAILED");
    expect((await proofOf(jobId)).id).toBe(proof.id);
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(ProofVerificationRefusedError);
    const after = await proofOf(jobId);
    expect(after.verificationStatus).toBe("DRAFT");
    expect(after.verdict).toBe(proof.verdict);
    expect(await memoryOf(project.id)).toEqual([]);
  });
});

// ================================================================== I

describe("I. cross-project contamination", () => {
  it("I1. same ticker, same source url, same fragment, same document hash in two projects: neither project's memory, evidence or retrieval reaches the other, and each verification writes its own rows", async () => {
    const host = `shared.${uniq("h").replace(/_/g, "-")}.example`;
    const x = await makeProject({ host, ticker: "DUP" });
    const y = await makeProject({ host, ticker: "DUP" });
    const { promoted: promotedX, jobId: jobX } = await verifiedAndPromoted(x, ["DESTINATION", "FLOW_PATH", "MECHANISM_SPEC"]);
    const [destX] = await evidenceOf(jobX, "DESTINATION");

    await setMemoryEnabled(true);
    const { jobId: jobY, worked } = await runJob(y);
    expect((await jobOf(jobY)).state).toBe("SUCCEEDED");
    const [retrieval] = await ctx.db.select().from(memoryRetrievals).where(eq(memoryRetrievals.researchJobId, jobY));
    expect(retrieval.retrievedCount).toBe(0);
    expect((await loadJobContractView(ctx.db, jobY)).view.reused).toEqual([]);
    expect(worked.length).toBe(10);
    const rowsY = await evidenceOf(jobY);
    expect(rowsY.every((r) => r.reusedFromMemoryId === null)).toBe(true);
    const [destY] = await evidenceOf(jobY, "DESTINATION");
    // The very same observation, physically: same source row, same passage,
    // same content hash — and still another project's Evidence.
    expect(destY.sourceId).toBe(destX.sourceId);
    expect(destY.contentHash).toBe(destX.contentHash);
    expect(observationKey(destY.sourceId, 6, "DESTINATION", destY.fragment)).toBe(observationKey(destX.sourceId, 6, "DESTINATION", destX.fragment));

    // A contract naming X's memory row for Y's job is refused at materialization.
    const forged = await adoptReusedMemory(
      ctx.db,
      jobY,
      { ...(await loadJobContractView(ctx.db, jobY)).view, reused: [{ step: 6, component: "DESTINATION", memoryIds: [promotedX.DESTINATION[0]] }] },
      new Date(),
    );
    expect(forged.adopted).toEqual([]);
    expect(forged.fallback[0].refusals.map((r) => r.reason)).toEqual(["MEMORY_SCOPE_MISMATCH"]);
    expect((await evidenceOf(jobY, "DESTINATION")).length).toBe(1);

    const admin = await makeAdmin();
    const vY = await markProofVerified(ctx.db, (await proofOf(jobY)).id, admin);
    expect(vY.memoryCandidates.created.map((c) => c.component)).toContain("DESTINATION");
    expect(vY.memoryCandidates.deduplicated).toEqual([]);
    const memX = await memoryOf(x.id);
    const memY = await memoryOf(y.id);
    expect(memY.every((m) => m.projectId === y.id)).toBe(true);
    const destKeyX = memX.find((m) => m.component === "DESTINATION")!.observationKey;
    const destKeyY = memY.find((m) => m.component === "DESTINATION")!.observationKey;
    expect(destKeyX).toBe(destKeyY);
    expect(memX.find((m) => m.component === "DESTINATION")!.id).not.toBe(memY.find((m) => m.component === "DESTINATION")!.id);
  });
});

// ================================================================== J

describe("J. the H7 provenance boundary over persisted state", () => {
  // Equal publication dates: neither row is strictly newer, so supersession
  // (recency wins, H4) cannot resolve the disagreement — it is a conflict.
  const SAME_DAY = new Date(Date.now() - 60_000);
  it("J1. a state CONFLICT is NOT_SUPPORTED with no cited Evidence, but every hop of the audit path is persisted: Proof gap -> component -> S5 row -> contradicting Evidence ids -> Evidence rows of this job", async () => {
    const project = await makeProject();
    const { jobId } = await runJob(
      project,
      {
        CURRENT_STATE: {
          rows: [
            { mechanismState: "LIVE", publishedAt: SAME_DAY },
            { url: docUrl(project, "CURRENT_STATE", "-status"), fragment: "the buyback mechanism has been paused pending review", mechanismState: "PAUSED", publishedAt: SAME_DAY },
          ],
        },
      },
      // "Is the mechanism current?" — the one intent whose verdict rests on
      // CURRENT_STATE, so the conflict is what decides the answer.
      "MECHANISM_CURRENT_STATE",
    );
    expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
    const s5 = await s5Of(jobId, "CURRENT_STATE");
    expect(s5.status).toBe("CONTRADICTED");
    expect(s5.reasonCodes).toEqual(["CONFLICTING_STATE"]);
    expect(s5.supportingEvidenceIds).toEqual([]);
    const contradicting = s5.contradictingEvidenceIds as string[];
    expect(contradicting.length).toBe(2);
    const rows = await ctx.db.select().from(evidence).where(inArray(evidence.id, contradicting));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.researchJobId === jobId && r.component === "CURRENT_STATE")).toBe(true);
    expect(rows.map((r) => r.mechanismState).sort()).toEqual(["LIVE", "PAUSED"]);

    expect(await gapsOf(jobId)).toContain("CONTRADICTED_COMPONENT@CURRENT_STATE");
    // S6 turns the conflict into lifecycle NOT_ESTABLISHED; S7's lifecycle
    // requirement is UNSATISFIED (TEMPORAL_SCOPE_MISMATCH) and the verdict is
    // INSUFFICIENT_EVIDENCE — a non-conclusion, never a negative one. The
    // requirement's own provenance is empty here (its basis component is not
    // on the flow, and S7 never re-reads S5); the persisted link to the rows
    // is the Proof's gap layer naming the component, and the S5 row.
    const claim = await claimSupportOf(jobId);
    expect(claim.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(claim.requirementResults.map((r) => `${r.requirementId}:${r.status}:${r.reasonCodes.join("+")}`)).toEqual(["MCS-1:UNSATISFIED:TEMPORAL_SCOPE_MISMATCH"]);
    const proof = await proofOf(jobId);
    expect(proof.verdict).toBe("INSUFFICIENT_EVIDENCE");
    const cited = await citedOf(proof.id);
    expect(cited.map((c) => c.component)).not.toContain("CURRENT_STATE");
    const layer6 = (proof.layers as { layers: { layer: number; lines: string[] }[] }).layers.find((l) => l.layer === 6)!;
    expect(layer6.lines).toContain("CONFLICTING_STATE at component CURRENT_STATE");
    // The verdict never rests on the conflict: nothing about CURRENT_STATE
    // is SUPPORTED anywhere, and no adopted or foreign row is involved.
    expect(rows.every((r) => r.reusedFromMemoryId === null)).toBe(true);
  });
});

describe("J. (continued) a required-component conflict", () => {
  const SAME_DAY = new Date(Date.now() - 60_000);
  it("J2. a state CONFLICT on a REQUIRED component is NOT_SUPPORTED: the requirement names the component result and the refuting rows in its provenance, the Proof cites none of them, and every id resolves to this job's rows", async () => {
    const project = await makeProject();
    const { jobId } = await runJob(project, {
      SOURCE_OF_VALUE: {
        rows: [
          { mechanismState: "LIVE", publishedAt: SAME_DAY },
          { url: docUrl(project, "SOURCE_OF_VALUE", "-status"), fragment: "fee collection has been paused by the operator", mechanismState: "PAUSED", publishedAt: SAME_DAY },
        ],
      },
    });
    const s5 = await s5Of(jobId, "SOURCE_OF_VALUE");
    expect(s5.status).toBe("CONTRADICTED");
    const contradicting = s5.contradictingEvidenceIds as string[];
    expect(contradicting.length).toBe(2);
    const rows = await ctx.db.select().from(evidence).where(inArray(evidence.id, contradicting));
    expect(rows.every((r) => r.researchJobId === jobId && r.component === "SOURCE_OF_VALUE")).toBe(true);
    const claim = await claimSupportOf(jobId);
    expect(claim.status).toBe("NOT_SUPPORTED");
    const prt1 = claim.requirementResults.find((r) => r.requirementId === "PRT-1")!;
    const shape = JSON.stringify(prt1);
    expect(prt1.status, shape).toBe("CONTRADICTED");
    expect(prt1.provenance.componentResultKeys, shape).toContainEqual({ step: 1, component: "SOURCE_OF_VALUE" });
    // S7 keeps the refuting rows in the requirement's provenance; S8 cites
    // support only (H7), so they surface as this blocking gap, not a citation.
    expect([...prt1.provenance.evidenceIds].sort(), shape).toEqual([...contradicting].sort());
    expect(prt1.blockingGaps.map((g) => `${g.kind}@${g.component}`), shape).toContain("CONTRADICTED_COMPONENT@SOURCE_OF_VALUE");
    const proof = await proofOf(jobId);
    expect((await citedOf(proof.id)).map((c) => c.component)).not.toContain("SOURCE_OF_VALUE");
    const layer6 = (proof.layers as { layers: { layer: number; lines: string[] }[] }).layers.find((l) => l.layer === 6)!;
    expect(layer6.lines).toContain("CONFLICTING_STATE at component SOURCE_OF_VALUE");
    expect(layer6.lines).toContain("CONTRADICTED_COMPONENT at component SOURCE_OF_VALUE");
    expect(proof.verdict).toBe("NOT_SUPPORTED");
  });
});

// ================================================================== K

describe("K. independent pass — persisted state the plan did not name", () => {
  it("K1. the health axis of an ACTIVE row is honoured at planning: DEPRECATED health is never retrieved, STALE health blocks reuse, and neither row is adopted", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION", "FLOW_PATH"]);
    await ctx.db.update(researchMemory).set({ health: "DEPRECATED" }).where(eq(researchMemory.id, promoted.DESTINATION[0]));
    await ctx.db.update(researchMemory).set({ health: "STALE" }).where(eq(researchMemory.id, promoted.FLOW_PATH[0]));
    await setMemoryEnabled(true);
    const { jobId, worked } = await runJob(project);
    const [retrieval] = await ctx.db.select().from(memoryRetrievals).where(eq(memoryRetrievals.researchJobId, jobId));
    const hitIds = (retrieval.hits as { memoryId: string }[]).map((h) => h.memoryId);
    expect(hitIds).not.toContain(promoted.DESTINATION[0]);
    expect(hitIds).toContain(promoted.FLOW_PATH[0]);
    const { view } = await loadJobContractView(ctx.db, jobId);
    expect(view.reused).toEqual([]);
    const flowItem = view.workQueue.find((w) => w.component === "FLOW_PATH")!;
    expect(flowItem.state).toBe("UNUSABLE");
    expect(flowItem.blockers).toEqual(["HEALTH_STALE"]);
    expect(worked).toContain("6:DESTINATION#1");
    expect(worked).toContain("2:FLOW_PATH#1");
    expect((await evidenceOf(jobId)).every((r) => r.reusedFromMemoryId === null)).toBe(true);
    // Lifecycle untouched: health is a separate axis, not a state change.
    const rows = await ctx.db.select().from(researchMemory).where(inArray(researchMemory.id, [promoted.DESTINATION[0], promoted.FLOW_PATH[0]]));
    expect(rows.every((r) => r.lifecycleState === "ACTIVE")).toBe(true);
  });
});

// ================================================================== F

describe("F. Pattern lifecycle against existing state (runs last: it moves the ACTIVE version)", () => {
  it("F1. a Proof of a job planned under the previous Pattern version cannot be verified after activation: the transaction rolls back whole (Proof DRAFT, zero memory, zero provenance)", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    const topicId = await activeTopicId();
    const before = await loadActivePatternVersion(ctx.db, topicId);
    const reports = await activatePatternVersions(ctx.db, { apply: true, code: patternWithDestinationGovernanceOnly() });
    expect(reports.find((r) => r.topicId === topicId)!.action).toBe("ACTIVATED");
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(before! + 1);

    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(MissingActivePatternError);
    expect((await proofOf(jobId)).verificationStatus).toBe("DRAFT");
    expect(await memoryOf(project.id)).toEqual([]);
    const [prov] = await ctx.db.select({ n: count() }).from(researchMemoryProvenance);
    const provBefore = Number(prov.n);
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(MissingActivePatternError);
    expect(Number((await ctx.db.select({ n: count() }).from(researchMemoryProvenance))[0].n)).toBe(provBefore);
    await restoreCodePattern();
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(before! + 2);
  });

  it("F2. Pattern semantic change before adoption: memory observed under vN is re-judged under vN+1 at adoption, cannot establish, and Research B equals a control planned under vN+1", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION", "FLOW_PATH"]);
    const topicId = await activeTopicId();
    const reports = await activatePatternVersions(ctx.db, { apply: true, code: patternWithDestinationGovernanceOnly() });
    expect(reports.find((r) => r.topicId === topicId)!.action).toBe("ACTIVATED");
    try {
      const { jobId: control } = await runJob(project);
      expect((await jobOf(control)).state).toBe("SUCCEEDED");
      expect((await s5Of(control, "DESTINATION")).status).not.toBe("SUPPORTED");
      await setMemoryEnabled(true);
      const { jobId: jobB, worked } = await runJob(project);
      expect((await jobOf(jobB)).state).toBe("SUCCEEDED");
      const { view } = await loadJobContractView(ctx.db, jobB);
      expect(view.reused.map((r) => r.component).sort()).toEqual(["DESTINATION", "FLOW_PATH"]);
      const destB = await evidenceOf(jobB, "DESTINATION");
      const adopted = destB.find((r) => r.reusedFromMemoryId === promoted.DESTINATION[0])!;
      expect(adopted).toBeDefined();
      expect(adopted.sourceClass).toBe("OFFICIAL_DOCS");
      const s5 = await s5Of(jobB, "DESTINATION");
      expect(s5.status).not.toBe("SUPPORTED");
      expect(s5.supportingEvidenceIds as string[]).not.toContain(adopted.id);
      expect((s5.excludedEvidence as { evidenceId: string }[]).map((e) => e.evidenceId)).toContain(adopted.id);
      expect(worked).toContain("6:DESTINATION#1");
      // FLOW_PATH's contract did not change: still adopted, still no fresh work.
      expect(worked.some((w) => w.startsWith("2:FLOW_PATH"))).toBe(false);
      expect((await s5Of(jobB, "FLOW_PATH")).supportingEvidenceIds as string[]).toEqual([(await evidenceOf(jobB, "FLOW_PATH"))[0].id]);
      expect(await s5PictureOf(jobB)).toEqual(await s5PictureOf(control));
      expect((await proofOf(jobB)).verdict).toBe((await proofOf(control)).verdict);
      expect((await proofOf(jobB)).confidence).toBe((await proofOf(control)).confidence);
    } finally {
      await restoreCodePattern();
    }
  });

  it("F3. the version is one row: a second ACTIVE row is refused, a presentation-only change activates nothing, repeated activation is a no-op, and an activation between planning and execution fails the job with no Proof", async () => {
    const topicId = await activeTopicId();
    const active = await loadActivePatternVersion(ctx.db, topicId);
    await expect(
      ctx.db.insert(researchPatterns).values({ topicId, version: 900 + active!, status: "ACTIVE", content: PATTERN_V1_CONTENT }),
    ).rejects.toSatisfy(isUniqueViolation);
    const presentation = JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
    presentation.steps[0].question = "Where does the value actually come from, in plain words?";
    const dry = await activatePatternVersions(ctx.db, { apply: true, code: presentation });
    expect(dry.find((r) => r.topicId === topicId)!.action).toBe("NONE");
    expect((await activatePatternVersions(ctx.db, { apply: true })).find((r) => r.topicId === topicId)!.action).toBe("NONE");
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(active);

    const project = await makeProject();
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    await activatePatternVersions(ctx.db, { apply: true, code: patternWithDestinationGovernanceOnly() });
    try {
      await expect(runS4ResearchJob(ctx.db, jobId, executorOf(project), new Date())).rejects.toThrow(/CONTRACT_INVALID.*patternVersion/);
      expect(await attemptsOf(jobId)).toEqual([]);
      expect(await proofOf(jobId)).toBeUndefined();
      await transitionJobState(ctx.db, jobId, "FAILED", "round 3 fixture");
    } finally {
      await restoreCodePattern();
    }
  });

  it("F4. a malformed stored ACTIVE Pattern fails planning closed (job FAILED, no attempt, no Proof) and activation replaces it with the code contract", async () => {
    const topicId = await activeTopicId();
    const active = await loadActivePatternVersion(ctx.db, topicId);
    await ctx.db.update(researchPatterns).set({ status: "RETIRED" }).where(and(eq(researchPatterns.topicId, topicId), eq(researchPatterns.status, "ACTIVE")));
    const malformed = { ...(JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as Record<string, unknown>), steps: [] };
    await ctx.db.insert(researchPatterns).values({ topicId, version: active! + 1, status: "ACTIVE", content: malformed });
    try {
      const project = await makeProject();
      const { jobId } = await runJob(project);
      const job = await jobOf(jobId);
      expect(job.state).toBe("FAILED");
      expect(job.errorCode).toBe("MEMORY_PLANNING_FAILED");
      expect(await attemptsOf(jobId)).toEqual([]);
      expect(await proofOf(jobId)).toBeUndefined();
    } finally {
      const reports = await activatePatternVersions(ctx.db, { apply: true });
      expect(reports.find((r) => r.topicId === topicId)!.verdict!.reason).toBe("CONTENT_INVALID");
      expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(active! + 2);
    }
  });
});
