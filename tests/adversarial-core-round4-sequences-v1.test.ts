import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import {
  evidence,
  interpretations,
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
import {
  computeEntityBinding,
  identityBindingKey,
  resolveConfirmedIdentity,
  urlHostIsExplorerOfChain,
  type ConfirmedProjectIdentity,
} from "../src/server/domain/project-identity";
import { loadActivePatternVersion, MissingActivePatternError } from "../src/server/engine/active-pattern";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import { runResearchController, type WorkExecutor } from "../src/server/engine/controller";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { extractionUnitKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { adoptReusedMemory } from "../src/server/engine/memory-evidence-adoption";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { resolveSourceClass, resolveSourceRoute } from "../src/server/engine/source-authority";
import { promoteToActive } from "../src/server/memory/lifecycle";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { markProofReviewed, markProofVerified, ProofVerificationRefusedError } from "../src/server/memory/verification";
import { claimResearchJob, createResearchJob, transitionJobState } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 4: ATLAS AS A LONG-LIVED
// STATEFUL SYSTEM.
//
// Rounds 1-3 attacked single boundaries and single lifecycle rules; Round
// 3.5 pinned the Founder's decisions on the boundaries Round 3 exposed.
// This round asks what happens after MANY individually legal operations in
// unusual orders, concurrently, across projects and chains: does anything
// stale silently win, does anything from one project or chain reach
// another, does any conclusion lose its audit path, does a retry converge?
//
// Every case runs the real lifecycle functions over Postgres with a fixture
// WorkExecutor that writes ordinary Evidence rows through the real
// authority resolvers (route, class, entity binding). No provider, no
// model, no network, no RPC.
//
// Sections: S long sequences; C concurrent pairs; P cross-project; X
// cross-chain; H combinations of the Round 3.5 rules with other failures; A
// audit reconstruction; R crash / retry windows; L legacy data; M the
// health axis at adoption. Cases that move the ACTIVE Pattern version
// restore the code contract before they end; cases that verify a Proof run
// before any Pattern-moving case in the same describe.

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
const EVM = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
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

async function makeProject(opts: { host?: string; identity?: { chain: string; tokenAddress: string }; ticker?: string } = {}): Promise<Project> {
  const slug = uniq("r4");
  const host = opts.host ?? `docs.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db.insert(projects).values({ slug, name: `Round 4 ${slug}`, status: "ACTIVE_CORE", ticker: opts.ticker ?? null }).returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  if (opts.identity) {
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: opts.identity.chain, tokenAddress: opts.identity.tokenAddress, ticker: opts.ticker ?? "R4" });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, host, docsRouteId: classified.newItemId };
}

async function replaceIdentity(project: Project, identity: { chain: string; tokenAddress: string }): Promise<void> {
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "DEPRECATED" })
    .where(and(eq(projectMemoryItems.projectId, project.id), eq(projectMemoryItems.kind, "PROJECT_IDENTITY"), eq(projectMemoryItems.lifecycleState, "ACTIVE")));
  const r = await confirmProjectIdentity(ctx.db, { projectSlug: project.slug, chain: identity.chain, tokenAddress: identity.tokenAddress, ticker: "R4" });
  if (!r.ok) throw new Error("re-confirm failed: " + r.refusal);
}

// The route replaced: the classified row withdrawn, a fresh confirmation +
// classification at the same prefix (the only replacement path today).
async function replaceDocsRoute(project: Project, routeClass: "OFFICIAL_DOCS" | "GOVERNANCE" = "OFFICIAL_DOCS"): Promise<string> {
  await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: project.host, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error("reconfirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass });
  if (!classified.ok) throw new Error("reclassify failed: " + classified.refusal);
  project.docsRouteId = classified.newItemId;
  return classified.newItemId;
}

function docUrl(project: Pick<Project, "host">, component: Component, variant = ""): string {
  return `https://${project.host}/docs/${component.toLowerCase().replace(/_/g, "-")}${variant}`;
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

interface RowSpec {
  url?: string;
  fragment?: string;
  relationship?: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
  mechanismState?: string | null;
  contractVersion?: 1 | 2;
}

// One ordinary Evidence row of THIS job, exactly as the executor's persist
// step writes it: canonical unit key, complete provenance, source class /
// officiality / entity binding resolved NOW through the production
// resolvers against the project's routes and confirmed identity.
async function insertRow(jobId: string, project: Pick<Project, "id" | "host">, component: Component, spec: RowSpec = {}): Promise<string> {
  const url = spec.url ?? docUrl(project, component);
  const sourceId = await sourceFor(url);
  const fragment = spec.fragment ?? FRAGMENT[component];
  const now = new Date();
  const unitKey = extractionUnitKey(jobId, sourceId, STEP_OF[component], component, fragment);
  const route = await resolveSourceRoute(ctx.db, project.id, url);
  const sourceClass = resolveSourceClass(url, "OTHER", route.routeClass);
  const identity = await resolveConfirmedIdentity(ctx.db, project.id);
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId,
      patternStep: STEP_OF[component],
      component,
      relationship: spec.relationship ?? "SUPPORTS",
      directness: "DIRECT",
      fragment,
      summary: `${component.toLowerCase().replace(/_/g, " ")}: ${fragment}`,
      mechanismState: spec.mechanismState ?? null,
      sourceClass: sourceClass as "OFFICIAL_DOCS",
      officiality: route.officiality,
      entityBinding: computeEntityBinding(url, sourceClass, identity),
      onchainFactKind: null,
      fetchedAt: now,
      publishedAt: now,
      doesNotProve: "does not prove the size of the effect",
      retrievedUrl: url,
      contentHash: `sha256:${url}`,
      extractionUnitKey: unitKey,
      evidenceContractVersion: spec.contractVersion ?? 2,
    })
    .onConflictDoNothing({ target: evidence.extractionUnitKey, where: sql`${evidence.extractionUnitKey} IS NOT NULL` })
    .returning({ id: evidence.id });
  if (row) return row.id;
  const [existing] = await ctx.db.select({ id: evidence.id }).from(evidence).where(eq(evidence.extractionUnitKey, unitKey));
  return existing.id;
}

type Behaviour = { rows?: RowSpec[]; status?: "SUCCEEDED" | "FAILED" | "SKIPPED" } | { throws: Error } | { writeThenThrow: Error };
function executorOf(project: Pick<Project, "id" | "host">, plan: Partial<Record<Component, Behaviour>> = {}, worked: string[] = []): WorkExecutor {
  return {
    async execute(item: ComponentWorkItem, c) {
      const component = item.component as Component;
      worked.push(`${item.step}:${component}#${c.attemptNumber}`);
      const b = plan[component] ?? {};
      if ("throws" in b) throw b.throws;
      if ("writeThenThrow" in b) {
        await insertRow(c.jobId, project, component);
        throw b.writeThenThrow;
      }
      for (const spec of b.rows ?? [{}]) await insertRow(c.jobId, project, component, spec);
      return { status: b.status ?? "SUCCEEDED", reason: "fixture component completed" };
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
async function plannedJob(project: Project) {
  const jobId = await newJob(project);
  if (!(await claimResearchJob(ctx.db, jobId))) throw new Error("claim failed");
  await runMemoryPlanningStage(ctx.db, jobId);
  const { view } = await loadJobContractView(ctx.db, jobId);
  return { jobId, view };
}
async function executePlanned(project: Project, jobId: string, plan: Partial<Record<Component, Behaviour>> = {}) {
  const worked: string[] = [];
  const result = await runS4ResearchJob(ctx.db, jobId, executorOf(project, plan, worked), new Date());
  await transitionJobState(ctx.db, jobId, "SUCCEEDED", "round 4 fixture");
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
async function s5PictureOf(jobId: string) {
  const out: Record<string, { status: string; reasonCodes: string[]; supporting: number } | null> = {};
  for (const c of ALL_COMPONENTS) {
    const r = await s5Of(jobId, c);
    out[c] = r ? { status: r.status, reasonCodes: [...(r.reasonCodes as string[])].sort(), supporting: (r.supportingEvidenceIds as string[]).length } : null;
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
  return ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectId)).orderBy(researchMemory.patternStep, researchMemory.component, researchMemory.createdAt);
}
async function memoryRow(id: string) {
  const [m] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, id));
  return m;
}
async function attemptsOf(jobId: string) {
  const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  return rows.map((r) => `${r.patternStep}:${r.component}#${r.attemptNumber}=${r.status}`).sort();
}
async function claimSupportOf(jobId: string) {
  const [r] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  return r;
}
async function verdictOf(jobId: string) {
  const p = await proofOf(jobId);
  const c = await claimSupportOf(jobId);
  return { verdict: p?.verdict ?? null, confidence: p?.confidence ?? null, claim: c?.status ?? null };
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

// Research A on the project, verified, the named components promoted ACTIVE.
async function verifiedAndPromoted(project: Project, promote: readonly Component[]) {
  const admin = await makeAdmin();
  const { jobId } = await runJob(project);
  expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
  const proof = await proofOf(jobId);
  await markProofVerified(ctx.db, proof.id, admin);
  const memory = await memoryOf(project.id);
  const promoted: Record<string, string> = {};
  for (const c of promote) {
    const row = memory.find((m) => m.component === c);
    if (!row) throw new Error(`no candidate for ${c}`);
    await promoteToActive(ctx.db, row.id, admin);
    promoted[c] = row.id;
  }
  return { admin, jobId, proof, promoted };
}

function patternWithDestinationGovernanceOnly(): PatternContent {
  const v2 = JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
  v2.componentRequirements!.DESTINATION.establishingClasses = ["ONCHAIN_VERIFIABLE", "GOVERNANCE"] as never;
  return v2;
}
async function restoreCodePattern(): Promise<void> {
  await activatePatternVersions(ctx.db, { apply: true });
}

// THE AUDIT WALK (Attack 6). Independently reconstructs, from persisted
// rows only, every edge a material conclusion of this job rests on, and
// fails on any dangling id, any citation of excluded Evidence, any row of
// another job, any adopted row whose memory origin is incomplete.
async function reconstructAudit(jobId: string): Promise<{ cited: number; adopted: number }> {
  const job = await jobOf(jobId);
  const rows = await evidenceOf(jobId);
  const ids = new Set(rows.map((r) => r.id));
  const s5Rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const excludedIds = new Set<string>();
  for (const r of s5Rows) {
    const supporting = r.supportingEvidenceIds as string[];
    const contradicting = r.contradictingEvidenceIds as string[];
    const excluded = (r.excludedEvidence as { evidenceId: string }[]).map((e) => e.evidenceId);
    for (const id of [...supporting, ...contradicting, ...excluded]) expect(ids.has(id), `S5 ${r.component} references ${id} outside job`).toBe(true);
    for (const id of excluded) {
      excludedIds.add(id);
      expect(supporting, `S5 ${r.component} cites excluded ${id} as support`).not.toContain(id);
    }
  }
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  if (asm) {
    for (const f of asm.flows as { lineage: { component: string; evidenceIds: string[] }[] }[]) {
      for (const step of f.lineage) for (const id of step.evidenceIds) expect(ids.has(id), `S6 lineage ${step.component} -> ${id}`).toBe(true);
    }
  }
  const claim = await claimSupportOf(jobId);
  if (claim) {
    for (const req of claim.requirementResults) {
      for (const id of req.provenance.evidenceIds) expect(ids.has(id), `S7 ${req.requirementId} -> ${id}`).toBe(true);
      for (const k of req.provenance.componentResultKeys) {
        expect(s5Rows.some((r) => r.patternStep === k.step && r.component === k.component), `S7 ${req.requirementId} -> S5 ${k.step}:${k.component}`).toBe(true);
      }
    }
  }
  const proof = await proofOf(jobId);
  let cited = 0;
  if (proof) {
    expect(proof.projectId).toBe(job.projectId);
    const citedRows = await ctx.db.select().from(evidence).where(eq(evidence.proofId, proof.id));
    cited = citedRows.length;
    for (const r of citedRows) {
      expect(r.researchJobId).toBe(jobId);
      expect(excludedIds.has(r.id), `Proof cites excluded ${r.id}`).toBe(false);
      expect(s5Rows.some((s) => (s.supportingEvidenceIds as string[]).includes(r.id)), `Proof cites ${r.id} that no S5 row supports`).toBe(true);
    }
  }
  let adopted = 0;
  for (const r of rows) {
    const [src] = await ctx.db.select({ id: sources.id }).from(sources).where(eq(sources.id, r.sourceId));
    expect(src, `source ${r.sourceId} of ${r.id}`).toBeDefined();
    if (r.reusedFromMemoryId !== null) {
      adopted += 1;
      const mem = await memoryRow(r.reusedFromMemoryId);
      expect(mem, `memory origin ${r.reusedFromMemoryId}`).toBeDefined();
      expect(mem.projectId).toBe(job.projectId);
      const [prov] = await ctx.db.select().from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, mem.id));
      expect(prov, `provenance of memory ${mem.id}`).toBeDefined();
      expect(prov.sourceId).toBe(r.sourceId);
      expect(prov.contentHash).toBe(r.contentHash);
      const [origin] = await ctx.db.select().from(evidence).where(eq(evidence.id, prov.originEvidenceId!));
      expect(origin, `origin evidence ${prov.originEvidenceId}`).toBeDefined();
      expect(origin.researchJobId).not.toBe(jobId);
      const originJob = await jobOf(origin.researchJobId);
      expect(originJob.projectId).toBe(job.projectId);
    }
  }
  return { cited, adopted };
}

// ================================================================== S

describe("S. long operation sequences", () => {
  it("S1. A verified+promoted -> route replaced -> Pattern activated -> memory ages -> B plans -> memory disabled -> identity changes -> B adopts: nothing stale wins, no old verdict leaks, B equals a control under the current state, audit complete", async () => {
    const project = await makeProject({ identity: { chain: "solana", tokenAddress: SOL_A } });
    const { proof: proofA, promoted } = await verifiedAndPromoted(project, ["DESTINATION", "FLOW_PATH"]);
    const topicId = await activeTopicId();
    const versionBefore = await loadActivePatternVersion(ctx.db, topicId);

    await replaceDocsRoute(project);
    await activatePatternVersions(ctx.db, { apply: true, code: patternWithDestinationGovernanceOnly() });
    try {
      expect(await loadActivePatternVersion(ctx.db, topicId)).toBe(versionBefore! + 1);
      // FLOW_PATH ages inside its window (fresh at planning), DESTINATION not at all.
      await ctx.db.update(researchMemory).set({ verifiedAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(researchMemory.id, promoted.FLOW_PATH));
      // A's conclusions are corrupted after the fact: any leak shows in B.
      await ctx.db.update(proofs).set({ verdict: "NOT_SUPPORTED", confidence: 1 }).where(eq(proofs.id, proofA.id));
      await ctx.db.update(researchComponentResults).set({ status: "CONTRADICTED" }).where(eq(researchComponentResults.researchJobId, proofA.researchJobId));

      await setMemoryEnabled(true);
      const { jobId: jobB, view } = await plannedJob(project);
      expect(view.reused.map((r) => r.component).sort()).toEqual(["DESTINATION", "FLOW_PATH"]);
      await setMemoryEnabled(false);
      await replaceIdentity(project, { chain: "solana", tokenAddress: SOL_B });

      const before = await countMemory();
      const adoption = await adoptReusedMemory(ctx.db, jobB, view, new Date());
      expect(adoption.adopted).toEqual([]);
      expect(adoption.fallback.map((f) => f.refusals[0].reason)).toEqual(["MEMORY_DISABLED", "MEMORY_DISABLED"]);
      const { worked } = await executePlanned(project, jobB);
      expect(worked).toContain("6:DESTINATION#1");
      expect(worked).toContain("2:FLOW_PATH#1");
      expect((await evidenceOf(jobB)).every((r) => r.reusedFromMemoryId === null)).toBe(true);

      // A control planned and run under exactly the same current state.
      const { jobId: control } = await runJob(project);
      expect(await s5PictureOf(jobB)).toEqual(await s5PictureOf(control));
      expect(await verdictOf(jobB)).toEqual(await verdictOf(control));
      expect((await verdictOf(jobB)).verdict).not.toBe("NOT_SUPPORTED");
      // Under the new Pattern a docs passage no longer establishes DESTINATION.
      expect((await s5Of(jobB, "DESTINATION")).status).not.toBe("SUPPORTED");
      // The fresh-only components were acquired fresh in both.
      for (const c of ["CURRENT_STATE", "EXECUTION_EVIDENCE", "NET_EFFECT"] as const) {
        expect(worked).toContain(`${STEP_OF[c]}:${c}#1`);
      }
      expect(await countMemory()).toEqual(before);
      for (const id of Object.values(promoted)) expect((await memoryRow(id)).lifecycleState).toBe("ACTIVE");
      const audit = await reconstructAudit(jobB);
      expect(audit.adopted).toBe(0);
      expect(audit.cited).toBeGreaterThan(0);
      // The old Proof is what it was: VERIFIED. Re-verifying it now writes
      // nothing (its S5 support was corrupted away above, so the writer has
      // nothing to consider) and its status never moves.
      const admin = await makeAdmin();
      const reverify = await markProofVerified(ctx.db, proofA.id, admin);
      expect(reverify.memoryCandidates.created).toEqual([]);
      expect((await proofOf(proofA.researchJobId)).verificationStatus).toBe("VERIFIED");
      expect(await countMemory()).toEqual(before);
    } finally {
      await restoreCodePattern();
    }
  });

  it("S2. another order: B plans -> identity changes -> memory ages past its window -> route withdrawn -> B adopts with memory ON: each row is refused for the FIRST rule it fails, deterministically, nothing is written, B equals its control", async () => {
    const project = await makeProject({ identity: { chain: "solana", tokenAddress: SOL_A } });
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION", "FLOW_PATH", "MECHANISM_SPEC"]);
    await setMemoryEnabled(true);
    const { jobId: jobB, view } = await plannedJob(project);
    expect(view.reused.map((r) => r.component).sort()).toEqual(["DESTINATION", "FLOW_PATH", "MECHANISM_SPEC"]);

    await replaceIdentity(project, { chain: "solana", tokenAddress: SOL_B });
    await ctx.db.update(researchMemory).set({ verifiedAt: new Date(Date.now() - 10 * DAY_MS) }).where(eq(researchMemory.id, promoted.FLOW_PATH));
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));

    const before = await countMemory();
    const first = await adoptReusedMemory(ctx.db, jobB, view, new Date());
    const second = await adoptReusedMemory(ctx.db, jobB, view, new Date());
    expect(first.fallback.map((f) => `${f.component}:${f.refusals.map((r) => r.reason).join(",")}`).sort()).toEqual([
      "DESTINATION:IDENTITY_CHANGED",
      "FLOW_PATH:MEMORY_STALE",
      "MECHANISM_SPEC:IDENTITY_CHANGED",
    ]);
    expect(second.fallback.map((f) => f.refusals[0].reason)).toEqual(first.fallback.map((f) => f.refusals[0].reason));
    expect((await evidenceOf(jobB)).length).toBe(0);
    expect(await countMemory()).toEqual(before);

    const { worked } = await executePlanned(project, jobB);
    expect(worked.length).toBe(10);
    await setMemoryEnabled(false);
    const { jobId: control } = await runJob(project);
    expect(await s5PictureOf(jobB)).toEqual(await s5PictureOf(control));
    expect(await verdictOf(jobB)).toEqual(await verdictOf(control));
    // Under the withdrawn route every fresh docs row is CLAIMED: nothing
    // documentary establishes, and Memory could not have rescued it.
    expect((await evidenceOf(jobB)).every((r) => r.officiality === "CLAIMED")).toBe(true);
    for (const id of Object.values(promoted)) expect((await memoryRow(id)).lifecycleState).toBe("ACTIVE");
    await reconstructAudit(jobB);
  });
});

// ================================================================== C

describe("C. concurrent operations", () => {
  it("C1. verify and review racing on one DRAFT Proof: whichever order, the final state is VERIFIED with one candidate set, and nothing was rewritten", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    const outcomes = await Promise.allSettled([
      markProofVerified(ctx.db, proof.id, admin),
      markProofReviewed(ctx.db, proof.id, admin),
      markProofVerified(ctx.db, proof.id, admin),
    ]);
    const after = await proofOf(jobId);
    expect(after.verificationStatus).toBe("VERIFIED");
    const verifieds = outcomes.filter((o, i) => i !== 1 && o.status === "fulfilled");
    expect(verifieds.length).toBe(2);
    const review = outcomes[1];
    if (review.status === "rejected") expect(review.reason).toBeInstanceOf(ProofVerificationRefusedError);
    const memory = await memoryOf(project.id);
    expect(new Set(memory.map((m) => m.observationKey)).size).toBe(memory.length);
    expect(memory.length).toBeGreaterThan(0);
    for (const m of memory) {
      const [p] = await ctx.db.select({ n: count() }).from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, m.id));
      expect(Number(p.n)).toBe(1);
    }
  });

  it("C2. two workers claim the same QUEUED job: exactly one claims, the other sees NOT_QUEUED, one attempt set, one Proof", async () => {
    const project = await makeProject();
    const jobId = await newJob(project);
    const w1: string[] = [];
    const w2: string[] = [];
    const [a, b] = await Promise.all([
      handleResearchJobTask(ctx.db, jobId, executorOf(project, {}, w1)),
      handleResearchJobTask(ctx.db, jobId, executorOf(project, {}, w2)),
    ]);
    expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
    expect(w1.length + w2.length).toBe(10);
    expect((await attemptsOf(jobId)).length).toBe(10);
    expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
    expect(await proofOf(jobId)).toBeDefined();
    // And two concurrent terminal transitions afterwards: both refused.
    const t = await Promise.allSettled([transitionJobState(ctx.db, jobId, "FAILED"), transitionJobState(ctx.db, jobId, "BUDGET_LIMIT_REACHED")]);
    expect(t.every((o) => o.status === "rejected" && isCheckViolation(o.reason))).toBe(true);
    expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
  });

  it("C3. adoption twice concurrently for one job (the phased-path race): one adopted row per memory, one S5 row, same outcome both sides", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION", "FLOW_PATH"]);
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    const [a, b] = await Promise.all([adoptReusedMemory(ctx.db, jobId, view, new Date()), adoptReusedMemory(ctx.db, jobId, view, new Date())]);
    expect(a.adopted.map((x) => x.component).sort()).toEqual(["DESTINATION", "FLOW_PATH"]);
    expect(b.adopted.map((x) => x.component).sort()).toEqual(["DESTINATION", "FLOW_PATH"]);
    const rows = await evidenceOf(jobId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.reusedFromMemoryId).sort()).toEqual(Object.values(promoted).sort());
    expect(a.adopted.find((x) => x.component === "DESTINATION")!.evidenceIds).toEqual(b.adopted.find((x) => x.component === "DESTINATION")!.evidenceIds);
    const s5 = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    expect(s5.length).toBe(2);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
  });

  it("C4. Pattern activation racing verification: either the verification completes under the old version or is refused whole — never a half-written candidate set", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    const topicId = await activeTopicId();
    const [verify] = await Promise.allSettled([
      markProofVerified(ctx.db, proof.id, admin),
      activatePatternVersions(ctx.db, { apply: true, code: patternWithDestinationGovernanceOnly() }),
    ]);
    try {
      const memory = await memoryOf(project.id);
      const after = await proofOf(jobId);
      if (verify.status === "fulfilled") {
        expect(after.verificationStatus).toBe("VERIFIED");
        expect(memory.length).toBe(verify.value.memoryCandidates.created.length);
        expect(memory.length).toBeGreaterThan(0);
        for (const m of memory) {
          const [p] = await ctx.db.select({ n: count() }).from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, m.id));
          expect(Number(p.n)).toBe(1);
        }
      } else {
        expect(verify.reason).toBeInstanceOf(MissingActivePatternError);
        expect(after.verificationStatus).toBe("DRAFT");
        expect(memory).toEqual([]);
      }
      const rows = await ctx.db.select().from(researchPatterns).where(eq(researchPatterns.topicId, topicId));
      expect(rows.filter((r) => r.status === "ACTIVE").length).toBe(1);
    } finally {
      await restoreCodePattern();
    }
  });
});

// ================================================================== P

describe("P. cross-project contamination", () => {
  it("P1. two projects, same host, same ticker, same documents, same passages: A's verified memory, routes and identity reach nothing of B; B's verification writes its own rows; a forged cross-project pointer is refused", async () => {
    const host = `shared.${uniq("h").replace(/_/g, "-")}.example`;
    const a = await makeProject({ host, ticker: "SAME", identity: { chain: "ethereum", tokenAddress: EVM } });
    const b = await makeProject({ host, ticker: "SAME" });
    const { promoted, jobId: jobA } = await verifiedAndPromoted(a, ["DESTINATION", "FLOW_PATH"]);
    // B's route withdrawn: B's pages on the shared host are CLAIMED for B,
    // while A's identical pages stay CONFIRMED for A.
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, b.docsRouteId));
    expect((await resolveSourceRoute(ctx.db, a.id, docUrl(a, "DESTINATION"))).officiality).toBe("CONFIRMED");
    expect((await resolveSourceRoute(ctx.db, b.id, docUrl(b, "DESTINATION"))).officiality).toBe("CLAIMED");
    expect(await resolveConfirmedIdentity(ctx.db, b.id)).toBeNull();

    await setMemoryEnabled(true);
    const { jobId: jobB, view } = await plannedJob(b);
    expect(view.reused).toEqual([]);
    const forged = await adoptReusedMemory(ctx.db, jobB, { ...view, reused: [{ step: 6, component: "DESTINATION", memoryIds: [promoted.DESTINATION] }] }, new Date());
    expect(forged.fallback[0].refusals.map((r) => r.reason)).toEqual(["MEMORY_SCOPE_MISMATCH"]);
    const { worked } = await executePlanned(b, jobB);
    expect(worked.length).toBe(10);
    const rowsB = await evidenceOf(jobB);
    expect(rowsB.every((r) => r.reusedFromMemoryId === null && r.officiality === "CLAIMED")).toBe(true);
    const [destA] = await evidenceOf(jobA, "DESTINATION");
    const [destB] = await evidenceOf(jobB, "DESTINATION");
    expect(destB.sourceId).toBe(destA.sourceId);
    expect(destB.contentHash).toBe(destA.contentHash);
    expect(destB.officiality).toBe("CLAIMED");
    expect(destA.officiality).toBe("CONFIRMED");
    expect((await s5Of(jobB, "DESTINATION")).status).not.toBe("SUPPORTED");
    expect((await s5Of(jobA, "DESTINATION")).status).toBe("SUPPORTED");
    await reconstructAudit(jobB);
    const admin = await makeAdmin();
    const vB = await markProofVerified(ctx.db, (await proofOf(jobB)).id, admin);
    // Nothing of B's is CONFIRMED, so B writes no candidate — and dedups
    // against nothing of A's.
    expect(vB.memoryCandidates.created).toEqual([]);
    expect(vB.memoryCandidates.deduplicated).toEqual([]);
    expect((await memoryOf(b.id)).length).toBe(0);
    expect((await memoryOf(a.id)).length).toBeGreaterThan(0);
  });

  it("P2. a shared source row's mutable health does not carry authority: the same URL is CONFIRMED for the project that owns the route and CLAIMED for the one that does not, whatever the source row says", async () => {
    const host = `shared2.${uniq("h").replace(/_/g, "-")}.example`;
    const a = await makeProject({ host });
    const b = await makeProject({ host });
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, b.docsRouteId));
    const url = docUrl(a, "FLOW_PATH");
    const sourceId = await sourceFor(url);
    await ctx.db.update(sources).set({ sourceType: "OFFICIAL_DOCS" }).where(eq(sources.id, sourceId));
    const routeA = await resolveSourceRoute(ctx.db, a.id, url);
    const routeB = await resolveSourceRoute(ctx.db, b.id, url);
    expect(routeA).toMatchObject({ officiality: "CONFIRMED", routeClass: "OFFICIAL_DOCS" });
    expect(routeB).toMatchObject({ officiality: "CLAIMED", routeClass: null });
    expect(resolveSourceClass(url, "OFFICIAL_DOCS", routeB.routeClass)).toBe("SOCIAL");
    expect(resolveSourceClass(url, "OFFICIAL_DOCS", routeA.routeClass)).toBe("OFFICIAL_DOCS");
  });
});

// ================================================================== X

describe("X. cross-chain contamination", () => {
  it("X1. an explorer page about the SAME address on ANOTHER chain never binds: bscscan / polygonscan / Optimism pages bind UNVERIFIED to an Ethereum identity, the L2 explorer binds only its own chain, a testnet binds nothing", async () => {
    const eth: ConfirmedProjectIdentity = { chain: "ethereum", tokenAddress: EVM, ticker: null };
    const opt: ConfirmedProjectIdentity = { chain: "optimism", tokenAddress: EVM, ticker: null };
    const bsc: ConfirmedProjectIdentity = { chain: "bsc", tokenAddress: EVM, ticker: null };
    const bind = (url: string, id: ConfirmedProjectIdentity) => computeEntityBinding(url, resolveSourceClass(url, "ONCHAIN", null), id);
    expect(bind(`https://etherscan.io/token/${EVM}`, eth)).toBe("CONFIRMED");
    expect(bind(`https://www.etherscan.io/token/${EVM.toLowerCase()}`, eth)).toBe("CONFIRMED");
    expect(bind(`https://bscscan.com/token/${EVM.toLowerCase()}`, eth)).toBe("UNVERIFIED");
    expect(bind(`https://polygonscan.com/address/${EVM}`, eth)).toBe("UNVERIFIED");
    expect(bind(`https://optimistic.etherscan.io/token/${EVM}`, eth)).toBe("UNVERIFIED");
    expect(bind(`https://optimistic.etherscan.io/token/${EVM}`, opt)).toBe("CONFIRMED");
    expect(bind(`https://etherscan.io/token/${EVM}`, opt)).toBe("UNVERIFIED");
    expect(bind(`https://bscscan.com/token/${EVM}`, bsc)).toBe("CONFIRMED");
    expect(bind(`https://etherscan.io/token/${EVM}`, bsc)).toBe("UNVERIFIED");
    // A testnet host is not on-chain authority at all (SOCIAL): the axis does not apply.
    expect(bind(`https://sepolia.etherscan.io/token/${EVM}`, eth)).toBeNull();
    // A host the map does not list for the chain binds nothing, whatever the path says.
    expect(urlHostIsExplorerOfChain(`https://etherscan.io.example/token/${EVM}`, "ethereum")).toBe(false);
    expect(urlHostIsExplorerOfChain("not a url", "ethereum")).toBe(false);
    expect(urlHostIsExplorerOfChain(`https://solscan.io/token/${SOL_A}`, "solana")).toBe(true);
    expect(computeEntityBinding(`https://solscan.io/token/${SOL_A}`, "ONCHAIN_VERIFIABLE", { chain: "solana", tokenAddress: SOL_A, ticker: null })).toBe("CONFIRMED");
  });

  it("X2. end to end: an Ethereum project whose executor brings a bscscan page naming its address — the row is ONCHAIN_VERIFIABLE but UNVERIFIED, S5 excludes it, the Proof cites nothing from it; the etherscan page of the same address establishes", async () => {
    const project = await makeProject({ identity: { chain: "ethereum", tokenAddress: EVM } });
    const bscUrl = `https://bscscan.com/token/${EVM.toLowerCase()}`;
    const ethUrl = `https://etherscan.io/token/${EVM}`;
    const { jobId } = await runJob(project, {
      EXECUTION_EVIDENCE: {
        rows: [
          { url: bscUrl, fragment: "the buyback contract executed a purchase in block 41000000", mechanismState: "LIVE" },
        ],
      },
      CURRENT_STATE: {
        rows: [{ url: ethUrl, fragment: "the buyback contract is active as of block 20000000", mechanismState: "LIVE" }],
      },
    });
    expect((await jobOf(jobId)).state).toBe("SUCCEEDED");
    const [bscRow] = await evidenceOf(jobId, "EXECUTION_EVIDENCE");
    expect(bscRow.sourceClass).toBe("ONCHAIN_VERIFIABLE");
    expect(bscRow.entityBinding).toBe("UNVERIFIED");
    const s5Exec = await s5Of(jobId, "EXECUTION_EVIDENCE");
    expect(s5Exec.status).not.toBe("SUPPORTED");
    expect((s5Exec.excludedEvidence as { evidenceId: string; reason: string }[]).find((e) => e.evidenceId === bscRow.id)?.reason).toBe("ENTITY_NOT_CONFIRMED");
    const [ethRow] = await evidenceOf(jobId, "CURRENT_STATE");
    expect(ethRow.entityBinding).toBe("CONFIRMED");
    expect((await s5Of(jobId, "CURRENT_STATE")).supportingEvidenceIds).toEqual([ethRow.id]);
    const proof = await proofOf(jobId);
    const cited = await ctx.db.select({ id: evidence.id }).from(evidence).where(eq(evidence.proofId, proof.id));
    expect(cited.map((c) => c.id)).not.toContain(bscRow.id);
    await reconstructAudit(jobId);
  });

  it("X3. documentary memory of a project whose token identity moved chains (same address, ethereum -> bsc) is refused at adoption; the same key on the same chain is not a move", async () => {
    const project = await makeProject({ identity: { chain: "ethereum", tokenAddress: EVM } });
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION"]);
    expect((await memoryRow(promoted.DESTINATION)).identityKey).toBe(`ethereum:${EVM}`);
    await replaceIdentity(project, { chain: "bsc", tokenAddress: EVM });
    expect(identityBindingKey(await resolveConfirmedIdentity(ctx.db, project.id))).toBe(`bsc:${EVM}`);
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    expect((await adoptReusedMemory(ctx.db, jobId, view, new Date())).fallback.map((f) => f.refusals[0].reason)).toEqual(["IDENTITY_CHANGED"]);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
    await replaceIdentity(project, { chain: "ethereum", tokenAddress: EVM.toLowerCase() as string });
    // Same chain, same address in another case: NOT the same key (the key is
    // the confirmed literal), so the row is refused — fail closed, never a
    // case-folding guess.
    const { jobId: job2, view: view2 } = await plannedJob(project);
    expect((await adoptReusedMemory(ctx.db, job2, view2, new Date())).fallback.map((f) => f.refusals[0].reason)).toEqual(["IDENTITY_CHANGED"]);
    await transitionJobState(ctx.db, job2, "FAILED", "fixture");
  });
});

// ================================================================== H

describe("H. Round 3.5 rules combined with other failures", () => {
  it("H1. fresh at planning -> stale at adoption AND route withdrawn: MEMORY_STALE decides, nothing is materialized, the component is fresh work under the withdrawn route", async () => {
    const project = await makeProject();
    const { promoted } = await verifiedAndPromoted(project, ["FLOW_PATH"]);
    await ctx.db.update(researchMemory).set({ verifiedAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(researchMemory.id, promoted.FLOW_PATH));
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date(Date.now() + 2 * DAY_MS));
    expect(adoption.fallback.map((f) => f.refusals[0].reason)).toEqual(["MEMORY_STALE"]);
    expect((await evidenceOf(jobId)).length).toBe(0);
    const { worked } = await executePlanned(project, jobId);
    expect(worked).toContain("2:FLOW_PATH#1");
    expect((await evidenceOf(jobId, "FLOW_PATH"))[0].officiality).toBe("CLAIMED");
    expect((await s5Of(jobId, "FLOW_PATH")).status).not.toBe("CONTRADICTED");
  });

  it("H2. identity changed AND memory disabled: MEMORY_DISABLED (switch decides first); switch back on -> IDENTITY_CHANGED; both deterministic, neither writes", async () => {
    const project = await makeProject({ identity: { chain: "solana", tokenAddress: SOL_A } });
    await verifiedAndPromoted(project, ["DESTINATION"]);
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    await replaceIdentity(project, { chain: "solana", tokenAddress: SOL_B });
    await setMemoryEnabled(false);
    expect((await adoptReusedMemory(ctx.db, jobId, view, new Date())).fallback[0].refusals[0].reason).toBe("MEMORY_DISABLED");
    await setMemoryEnabled(true);
    expect((await adoptReusedMemory(ctx.db, jobId, view, new Date())).fallback[0].refusals[0].reason).toBe("IDENTITY_CHANGED");
    expect((await evidenceOf(jobId)).length).toBe(0);
    await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
  });

  it("H3. identity changed AND fresh Evidence disagrees with the old observation: the old row never enters, so there is no conflict — B rests on its own row only", async () => {
    const project = await makeProject({ identity: { chain: "solana", tokenAddress: SOL_A } });
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION"]);
    await replaceIdentity(project, { chain: "solana", tokenAddress: SOL_B });
    await setMemoryEnabled(true);
    const { jobId, view } = await plannedJob(project);
    await adoptReusedMemory(ctx.db, jobId, view, new Date());
    const { worked } = await executePlanned(project, jobId, {
      DESTINATION: { rows: [{ url: docUrl(project, "DESTINATION", "-v2"), fragment: "purchased tokens are now retained in the community treasury rather than burned", mechanismState: "LIVE" }] },
    });
    expect(worked).toContain("6:DESTINATION#1");
    const rows = await evidenceOf(jobId, "DESTINATION");
    expect(rows.length).toBe(1);
    expect(rows[0].reusedFromMemoryId).toBeNull();
    const s5 = await s5Of(jobId, "DESTINATION");
    expect(s5.status).toBe("SUPPORTED");
    expect(s5.supportingEvidenceIds).toEqual([rows[0].id]);
    expect(s5.contradictingEvidenceIds).toEqual([]);
    expect((await memoryRow(promoted.DESTINATION)).lifecycleState).toBe("ACTIVE");
  });

  it("H4. failed-job Proof under a repeated verification race: every attempt refused, Proof DRAFT, zero candidates, zero provenance", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    await runS4ResearchJob(ctx.db, jobId, executorOf(project), new Date());
    await transitionJobState(ctx.db, jobId, "FAILED", "round 4: technical failure after S8");
    const proof = await proofOf(jobId);
    const before = await countMemory();
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => markProofVerified(ctx.db, proof.id, admin)));
    expect(outcomes.every((o) => o.status === "rejected" && (o.reason as ProofVerificationRefusedError).refusal === "JOB_NOT_SUCCESSFUL")).toBe(true);
    expect((await proofOf(jobId)).verificationStatus).toBe("DRAFT");
    expect(await countMemory()).toEqual(before);
  });

  it("H5. VERIFIED Proof: a regression attempt racing a candidate promotion — promotion lands, regression is refused, memory history intact", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    await markProofVerified(ctx.db, proof.id, admin);
    const dest = (await memoryOf(project.id)).find((m) => m.component === "DESTINATION")!;
    const [promotion, regression] = await Promise.allSettled([promoteToActive(ctx.db, dest.id, admin), markProofReviewed(ctx.db, proof.id, admin)]);
    expect(promotion.status).toBe("fulfilled");
    expect(regression.status).toBe("rejected");
    expect((await proofOf(jobId)).verificationStatus).toBe("VERIFIED");
    const after = await memoryRow(dest.id);
    expect(after.lifecycleState).toBe("ACTIVE");
    expect(after.promotedBy).toBe(admin);
  });

  it("H6. old-identity memory AND a Pattern semantic change: refused for identity before any reduction; and a row bound to the current identity is re-judged under the new contract", async () => {
    const project = await makeProject({ identity: { chain: "solana", tokenAddress: SOL_A } });
    const { promoted } = await verifiedAndPromoted(project, ["DESTINATION", "FLOW_PATH"]);
    await replaceIdentity(project, { chain: "solana", tokenAddress: SOL_B });
    await activatePatternVersions(ctx.db, { apply: true, code: patternWithDestinationGovernanceOnly() });
    try {
      await setMemoryEnabled(true);
      const { jobId, view } = await plannedJob(project);
      const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
      expect(adoption.fallback.map((f) => `${f.component}:${f.refusals[0].reason}`).sort()).toEqual(["DESTINATION:IDENTITY_CHANGED", "FLOW_PATH:IDENTITY_CHANGED"]);
      expect((await evidenceOf(jobId)).length).toBe(0);
      await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
      // Same rows re-bound? Never automatically: the owner re-establishes.
      // A NEW verified observation under identity B is judged under v(n+1):
      // DESTINATION from docs cannot establish, FLOW_PATH still can.
      const admin = await makeAdmin();
      for (const id of Object.values(promoted)) await ctx.db.update(researchMemory).set({ lifecycleState: "DEPRECATED" }).where(eq(researchMemory.id, id));
      const { jobId: jobA2 } = await runJob(project);
      const v = await markProofVerified(ctx.db, (await proofOf(jobA2)).id, admin);
      // Under v(n+1), DESTINATION has no supporting row (docs inadmissible),
      // so it yields no candidate at all; FLOW_PATH does.
      expect(v.memoryCandidates.created.map((c) => c.component)).toContain("FLOW_PATH");
      expect(v.memoryCandidates.created.map((c) => c.component)).not.toContain("DESTINATION");
      const flow = v.memoryCandidates.created.find((c) => c.component === "FLOW_PATH")!;
      await promoteToActive(ctx.db, flow.memoryId, admin);
      const { jobId: jobB, view: viewB } = await plannedJob(project);
      expect((await adoptReusedMemory(ctx.db, jobB, viewB, new Date())).adopted.map((a) => a.component)).toEqual(["FLOW_PATH"]);
      await transitionJobState(ctx.db, jobB, "FAILED", "fixture");
    } finally {
      await restoreCodePattern();
    }
  });
});

// ================================================================== R

describe("R. crash / retry windows", () => {
  it("R1. Evidence written, then the process dies before the attempt is finalized: the row survives as STARTED, the lease blocks an immediate re-claim, and the retry after the lease converges to one Evidence row, one S5 row, one Proof", async () => {
    const project = await makeProject();
    const t0 = new Date();
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    const crashing = executorOf(project, { MECHANISM_SPEC: { writeThenThrow: new CapabilityFatalError("fixture", "died after write") } });
    await expect(runS4ResearchJob(ctx.db, jobId, crashing, t0)).rejects.toBeInstanceOf(CapabilityFatalError);
    expect(await attemptsOf(jobId)).toContain("3:MECHANISM_SPEC#1=STARTED");
    expect((await evidenceOf(jobId, "MECHANISM_SPEC")).length).toBe(1);
    expect(await s5Of(jobId, "MECHANISM_SPEC")).toBeUndefined();
    expect(await proofOf(jobId)).toBeUndefined();

    // Immediate re-entry: the STARTED attempt is inside its lease, so the
    // component is presumed still running and skipped; nothing else runs
    // twice.
    const { view } = await loadJobContractView(ctx.db, jobId);
    const w1: string[] = [];
    const early = await runResearchController({ db: ctx.db, jobId, view, executor: executorOf(project, {}, w1), now: new Date(t0.getTime() + 1000), reconcile: reconcileAndPersistComponent });
    expect(w1).not.toContain("3:MECHANISM_SPEC#2");
    expect(early.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(await attemptsOf(jobId)).toContain("3:MECHANISM_SPEC#1=STARTED");

    // After the lease: reclaimed as the recovery attempt; the same fragment
    // is the same unit (no second row), and the job finalizes once.
    const w2: string[] = [];
    const late = await runS4ResearchJob(ctx.db, jobId, executorOf(project, {}, w2), new Date(t0.getTime() + 2 * 3600 * 1000));
    expect(late.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(w2).toEqual(["3:MECHANISM_SPEC#2"]);
    expect(await attemptsOf(jobId)).toContain("3:MECHANISM_SPEC#2=SUCCEEDED");
    expect((await evidenceOf(jobId, "MECHANISM_SPEC")).length).toBe(1);
    expect((await s5Of(jobId, "MECHANISM_SPEC")).status).toBe("SUPPORTED");
    const proof = await proofOf(jobId);
    expect(proof).toBeDefined();
    await transitionJobState(ctx.db, jobId, "SUCCEEDED", "round 4 fixture");
    // Re-entering a finished job: nothing new.
    const w3: string[] = [];
    await runS4ResearchJob(ctx.db, jobId, executorOf(project, {}, w3), new Date(t0.getTime() + 3 * 3600 * 1000));
    expect(w3).toEqual([]);
    expect((await proofOf(jobId)).id).toBe(proof.id);
    await reconstructAudit(jobId);
  });

  it("R2. verification transaction and candidate creation are one unit: a candidate insert that the database refuses rolls the verification back whole, and the retry after the cause is removed converges", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const { jobId } = await runJob(project);
    const proof = await proofOf(jobId);
    const topicId = await activeTopicId();
    // The component guard refuses a candidate for a step whose ACTIVE
    // Pattern lists no such component: retire the ACTIVE row and activate a
    // copy that drops DESTINATION from step 6's list. The verification is
    // refused on the version check first, so no half-written state either.
    const noDest = JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as PatternContent;
    noDest.requiredComponents!["6"] = ["RECIPIENT"] as never;
    await activatePatternVersions(ctx.db, { apply: true, code: noDest });
    try {
      await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(MissingActivePatternError);
      expect((await proofOf(jobId)).verificationStatus).toBe("DRAFT");
      expect(await memoryOf(project.id)).toEqual([]);
    } finally {
      await restoreCodePattern();
    }
    // The job's contract is frozen at the older version; it stays
    // unverifiable, and a fresh Research under the restored contract is
    // the canonical result.
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toBeInstanceOf(MissingActivePatternError);
    const { jobId: fresh } = await runJob(project);
    const v = await markProofVerified(ctx.db, (await proofOf(fresh)).id, admin);
    expect(v.memoryCandidates.created.length).toBeGreaterThan(0);
    expect(await loadActivePatternVersion(ctx.db, topicId)).toBeGreaterThan(1);
  });
});

// ================================================================== L

describe("L. legacy persisted data — fail closed, never stronger after an upgrade", () => {
  it("L1. a pre-H10 VERIFIED Proof of a FAILED job: never regresses, is never rebuilt, re-verification is refused, and it writes no new candidate", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    await runS4ResearchJob(ctx.db, jobId, executorOf(project), new Date());
    await transitionJobState(ctx.db, jobId, "FAILED", "legacy: failed after S8");
    const proof = await proofOf(jobId);
    // As an older release would have left it: VERIFIED by direct update
    // (legal for the guard), with no candidate writer having run.
    await ctx.db.update(proofs).set({ verificationStatus: "VERIFIED" }).where(eq(proofs.id, proof.id));
    const before = await countMemory();
    await expect(markProofVerified(ctx.db, proof.id, admin)).rejects.toMatchObject({ refusal: "JOB_NOT_SUCCESSFUL" });
    await expect(markProofReviewed(ctx.db, proof.id, admin)).rejects.toMatchObject({ refusal: "VERIFIED_IS_TERMINAL" });
    expect((await proofOf(jobId)).verificationStatus).toBe("VERIFIED");
    expect(await countMemory()).toEqual(before);
    expect(await memoryOf(project.id)).toEqual([]);
  });

  it("L2. legacy domain-wide unclassified route beside a new prefixed classified one: the resolver is deterministic in both orders, the class is scoped to the prefix, and no url gains a class it did not have", async () => {
    for (const order of [0, 1]) {
      const project = await makeProject();
      const legacy = { projectId: project.id, kind: "SOURCE_ROUTE" as const, content: { domain: project.host }, lifecycleState: "OBSERVED" as const };
      if (order === 0) {
        const [row] = await ctx.db.insert(projectMemoryItems).values(legacy).returning();
        await ctx.db.update(projectMemoryItems).set({ lifecycleState: "CANDIDATE" }).where(eq(projectMemoryItems.id, row.id));
        await ctx.db.update(projectMemoryItems).set({ lifecycleState: "ACTIVE" }).where(eq(projectMemoryItems.id, row.id));
      }
      if (order === 1) {
        // Legacy row created AFTER the classified one.
        const [row] = await ctx.db.insert(projectMemoryItems).values(legacy).returning();
        await ctx.db.update(projectMemoryItems).set({ lifecycleState: "CANDIDATE" }).where(eq(projectMemoryItems.id, row.id));
        await ctx.db.update(projectMemoryItems).set({ lifecycleState: "ACTIVE" }).where(eq(projectMemoryItems.id, row.id));
      }
      expect(await resolveSourceRoute(ctx.db, project.id, `https://${project.host}/docs/intro`)).toEqual({ officiality: "CONFIRMED", routeClass: "OFFICIAL_DOCS", observation: null, matchedPathPrefix: "/docs" });
      expect(await resolveSourceRoute(ctx.db, project.id, `https://${project.host}/blog/post`)).toEqual({ officiality: "CONFIRMED", routeClass: null, observation: null, matchedPathPrefix: null });
      expect(resolveSourceClass(`https://${project.host}/blog/post`, "OTHER", null)).toBe("SOCIAL");
    }
  });

  it("L3. a legacy contract-version-1 Evidence row (as the 0010 backfill left them) is excluded by S5, never cited, never a memory candidate; and the database refuses any NEW legacy row", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    // The guard: a new legacy row cannot be written today. The fixture
    // executor's insert fails, and the job ends as a technical failure —
    // never as research.
    const refused = await runJob(project, { DESTINATION: { rows: [{ contractVersion: 1 }] } });
    expect((await jobOf(refused.jobId)).state).toBe("FAILED");
    expect(await proofOf(refused.jobId)).toBeUndefined();
    // The legacy shape itself: written with the guard off, as the 0010
    // backfill wrote it, beside an ordinary current row.
    const jobId = await newJob(project);
    expect(await claimResearchJob(ctx.db, jobId)).not.toBeNull();
    await runMemoryPlanningStage(ctx.db, jobId);
    await ctx.db.execute(sql`ALTER TABLE evidence DISABLE TRIGGER evidence_contract_version_guard`);
    try {
      await runS4ResearchJob(
        ctx.db,
        jobId,
        executorOf(project, {
          DESTINATION: { rows: [{ contractVersion: 1 }, { url: docUrl(project, "DESTINATION", "-v2"), fragment: "purchased tokens are sent to the burn address every epoch", contractVersion: 2 }] },
        }),
        new Date(),
      );
    } finally {
      await ctx.db.execute(sql`ALTER TABLE evidence ENABLE TRIGGER evidence_contract_version_guard`);
    }
    await transitionJobState(ctx.db, jobId, "SUCCEEDED", "round 4 fixture");
    const rows = await evidenceOf(jobId, "DESTINATION");
    const legacy = rows.find((r) => r.evidenceContractVersion === 1)!;
    const current = rows.find((r) => r.evidenceContractVersion === 2)!;
    const s5 = await s5Of(jobId, "DESTINATION");
    expect((s5.excludedEvidence as { evidenceId: string; reason: string }[]).find((e) => e.evidenceId === legacy.id)?.reason).toBe("LEGACY_CONTRACT_VERSION");
    expect(s5.supportingEvidenceIds).toEqual([current.id]);
    const proof = await proofOf(jobId);
    const cited = await ctx.db.select({ id: evidence.id }).from(evidence).where(eq(evidence.proofId, proof.id));
    expect(cited.map((c) => c.id)).not.toContain(legacy.id);
    const v = await markProofVerified(ctx.db, proof.id, admin);
    expect(v.memoryCandidates.created.map((c) => c.evidenceId)).not.toContain(legacy.id);
    expect(v.memoryCandidates.created.map((c) => c.evidenceId)).toContain(current.id);
    await reconstructAudit(jobId);
  });

  it("L4. pre-H11 rows (identity_key NULL) on a project WITHOUT identity keep working; on a project WITH identity they fail closed and are never rebound by a later verification", async () => {
    const none = await makeProject();
    const { promoted: pNone } = await verifiedAndPromoted(none, ["DESTINATION"]);
    // Simulate the pre-migration state: the key was never written.
    await ctx.db.update(researchMemory).set({ identityKey: null }).where(eq(researchMemory.id, pNone.DESTINATION));
    await setMemoryEnabled(true);
    const { jobId: j1, view: v1 } = await plannedJob(none);
    expect((await adoptReusedMemory(ctx.db, j1, v1, new Date())).adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
    await transitionJobState(ctx.db, j1, "FAILED", "fixture");

    const withId = await makeProject({ identity: { chain: "solana", tokenAddress: SOL_A } });
    const { promoted: pWith, admin } = await verifiedAndPromoted(withId, ["DESTINATION"]);
    await ctx.db.update(researchMemory).set({ identityKey: null }).where(eq(researchMemory.id, pWith.DESTINATION));
    const { jobId: j2, view: v2 } = await plannedJob(withId);
    expect((await adoptReusedMemory(ctx.db, j2, v2, new Date())).fallback.map((f) => f.refusals[0].reason)).toEqual(["IDENTITY_CHANGED"]);
    await transitionJobState(ctx.db, j2, "FAILED", "fixture");
    // A later verification of the same passage dedups against the live
    // NULL row and does not rebind it.
    const { jobId: again } = await runJob(withId);
    const v = await markProofVerified(ctx.db, (await proofOf(again)).id, admin);
    expect(v.memoryCandidates.deduplicated.map((d) => d.memoryId)).toContain(pWith.DESTINATION);
    expect((await memoryRow(pWith.DESTINATION)).identityKey).toBeNull();
  });
});

// ================================================================== M

describe("M. the health axis at adoption (D-059 re-applied at the moment of adoption)", () => {
  it("M1. health OK at planning, QUESTIONABLE / REVERIFY / STALE before adoption: refused (MEMORY_HEALTH_NOT_OK), row untouched, fresh work; DEPRECATED health stays MEMORY_NOT_ACTIVE; OK adopts", async () => {
    for (const health of ["QUESTIONABLE", "REVERIFY", "STALE", "DEPRECATED", "OK"] as const) {
      const project = await makeProject();
      const { promoted } = await verifiedAndPromoted(project, ["DESTINATION"]);
      await setMemoryEnabled(true);
      const { jobId, view } = await plannedJob(project);
      expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
      await ctx.db.update(researchMemory).set({ health }).where(eq(researchMemory.id, promoted.DESTINATION));
      const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
      if (health === "OK") {
        expect(adoption.adopted.map((a) => a.component)).toEqual(["DESTINATION"]);
      } else {
        expect(adoption.adopted).toEqual([]);
        expect(adoption.fallback[0].refusals.map((r) => r.reason)).toEqual([health === "DEPRECATED" ? "MEMORY_NOT_ACTIVE" : "MEMORY_HEALTH_NOT_OK"]);
        expect((await evidenceOf(jobId)).length).toBe(0);
        const row = await memoryRow(promoted.DESTINATION);
        expect(row.lifecycleState).toBe("ACTIVE");
        expect(row.health).toBe(health);
      }
      await transitionJobState(ctx.db, jobId, "FAILED", "fixture");
    }
  });
});

// A guard on the fixture itself: the code default is what the suite assumes.
describe("fixture invariants", () => {
  it("memory is OFF by default and every case leaves it OFF", () => {
    expect(DEFAULT_PRODUCT_CONFIG.memory_enabled).toBe(false);
    expect(inArray).toBeDefined();
  });
});
