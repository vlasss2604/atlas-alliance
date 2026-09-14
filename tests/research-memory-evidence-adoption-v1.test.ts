import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  productConfig,
  projectMemoryItems,
  projects,
  proofs,
  researchAttempts,
  researchComponentResults,
  researchMechanismAssembly,
  researchMemory,
  researchMemoryProvenance,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { WorkExecutor } from "../src/server/engine/controller";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import {
  MEMORY_ADOPTION_SUFFICIENT_PARTIAL_REASONS,
  adoptReusedMemory,
  isFreshOnlyComponent,
  memoryAdoptionUnitKey,
} from "../src/server/engine/memory-evidence-adoption";
import {
  copyProvenanceFromEvidence,
  observeMemoryCandidate,
  promoteToActive,
} from "../src/server/memory/lifecycle";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH MEMORY -> EVIDENCE ADOPTION V1 — the two-job scenario.
//
// Research A acquires documentary Evidence; a human promotes ONE observation
// of it to ACTIVE Research Memory through the existing lifecycle. Research B
// on the same project: the planner closes the component from memory, the
// adoption path materializes a current-job Evidence row from that exact
// memory row (authority re-resolved, provenance copied, an explicit
// pointer back), the ordinary S5 reducer reconciles it, and the component
// is neither freshly acquired nor reported MISSING. Then the fallback: when
// today's authority makes the same observation inadmissible, adoption does
// not suppress the component — it is freshly acquired and the Proof rests
// on the fresh row.
//
// OLD OBSERVATIONS + NEW OBSERVATIONS -> NEW PROOF. Never OLD PROOF -> NEW.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  // Memory planning is what puts a component on `view.reused`; the test
  // database enables it explicitly (production keeps its own setting).
  await ctx.db
    .insert(productConfig)
    .values({ key: "memory_enabled", value: true })
    .onConflictDoUpdate({ target: productConfig.key, set: { value: true } });
});

afterAll(async () => {
  await ctx.close();
});

const HOST = "docs.memoryadoption.org";
const DOC_URL = `https://${HOST}/docs/value-accrual`;
const FRAGMENT = "protocol fees accrue directly to the treasury contract, which is controlled by the token holders";

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeAdmin(): Promise<string> {
  const [a] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
  return a.id;
}

// A project whose documentation host is a human-confirmed, classified
// OFFICIAL_DOCS route — the state a real onboarded project is in.
async function makeProject(opts: { officialRoute: boolean } = { officialRoute: true }): Promise<{ id: string; slug: string; routeId: string | null }> {
  const slug = uniq("memadopt");
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Memory adoption project", status: "ACTIVE_CORE" })
    .returning();
  if (!opts.officialRoute) return { id: p.id, slug, routeId: null };
  const r = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/docs" });
  expect(r.ok).toBe(true);
  const rows = await ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
  const row = rows.find((x) => x.lifecycleState === "ACTIVE" && JSON.stringify(x.content).includes(HOST));
  const c = await classifySourceRoute(ctx.db, { routeId: row!.id, routeClass: "OFFICIAL_DOCS" });
  expect(c.ok).toBe(true);
  // Classification promotes a REPLACEMENT row and supersedes the original;
  // the ACTIVE classified row is the one a later human act would withdraw.
  const after = await ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, p.id), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
  const active = after.find((x) => x.lifecycleState === "ACTIVE" && JSON.stringify(x.content).includes("OFFICIAL_DOCS"));
  return { id: p.id, slug, routeId: active!.id };
}

async function makeSource(): Promise<{ id: string; url: string }> {
  const [row] = await ctx.db
    .insert(sources)
    .values({ url: DOC_URL, urlHash: `sha256:${DOC_URL}`, sourceType: "OFFICIAL_DOCS" })
    .onConflictDoNothing({ target: sources.urlHash })
    .returning({ id: sources.id });
  if (row) return { id: row.id, url: DOC_URL };
  const [existing] = await ctx.db.select().from(sources).where(eq(sources.urlHash, `sha256:${DOC_URL}`));
  return { id: existing.id, url: DOC_URL };
}

async function newJob(projectId: string): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: await activeTopicId(),
    projectId,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "does protocol revenue reach token holders" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

// The fixture acquisition: every worked component yields one admitted
// OFFICIAL_DOCS / CONFIRMED row from the project's documentation.
function fixtureExecutor(sourceId: string, worked: string[]): WorkExecutor {
  return {
    async execute(item, c) {
      worked.push(`${item.step}:${item.component}`);
      await ctx.db.insert(evidence).values({
        researchJobId: c.jobId,
        proofId: null,
        sourceId,
        patternStep: item.step,
        component: item.component,
        relationship: "SUPPORTS",
        directness: "DIRECT",
        fragment: FRAGMENT,
        summary: "protocol fees accrue to the treasury",
        mechanismState: null,
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        fetchedAt: new Date(),
        publishedAt: new Date(),
        doesNotProve: "does not prove distribution to holders",
        retrievedUrl: DOC_URL,
        contentHash: `sha256:${uniq("content")}`,
        extractionUnitKey: uniq("unit"),
      });
      return { status: "SUCCEEDED", reason: "fixture component completed" };
    },
  };
}

async function evidenceOf(jobId: string, component: string) {
  return ctx.db
    .select()
    .from(evidence)
    .where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, component)));
}

async function s5Of(jobId: string, component: string) {
  const [row] = await ctx.db
    .select()
    .from(researchComponentResults)
    .where(and(eq(researchComponentResults.researchJobId, jobId), eq(researchComponentResults.component, component)));
  return row;
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

async function proofOf(jobId: string) {
  const [p] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  return p;
}

async function attemptsOf(jobId: string): Promise<string[]> {
  const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  return rows.map((r) => `${r.patternStep}:${r.component}`).sort();
}

// Research A, then ONE of its observations promoted through the real
// lifecycle: OBSERVED -> CANDIDATE -> ACTIVE by an ADMIN, provenance copied
// from the origin Evidence row.
async function researchAThenPromote(
  projectId: string,
  sourceId: string,
  step: number,
  component: string,
  opts: { verifiedAt?: Date; withProvenance?: boolean } = {},
): Promise<{ jobA: string; originEvidenceId: string; memoryId: string }> {
  const jobA = await newJob(projectId);
  await handleResearchJobTask(ctx.db, jobA, fixtureExecutor(sourceId, []));
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
    freshnessClass: "LOW_CHANGE",
    verifiedAt: opts.verifiedAt ?? new Date(),
    confidence: 90,
    originKind: "TEST_PROMOTION",
  });
  await promoteToActive(ctx.db, memoryId, admin);
  if (opts.withProvenance !== false) await copyProvenanceFromEvidence(ctx.db, memoryId, origin.id);
  return { jobA, originEvidenceId: origin.id, memoryId };
}

describe("Research Memory -> Evidence adoption — the two-job scenario", () => {
  it("1/2/3/4/5/6. ACTIVE memory is adopted as current-job Evidence, reconciled by ordinary S5 to SUPPORTED, and the component is neither freshly acquired nor MISSING", async () => {
    const p = await makeProject();
    const src = await makeSource();
    const { jobA, originEvidenceId, memoryId } = await researchAThenPromote(p.id, src.id, 2, "FLOW_PATH");

    const worked: string[] = [];
    const jobB = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobB, fixtureExecutor(src.id, worked));

    // The planner closed it and adoption held: no fresh acquisition.
    expect(worked).not.toContain("2:FLOW_PATH");
    expect(await attemptsOf(jobB)).not.toContain("2:FLOW_PATH");
    expect(worked.length).toBe(9);

    // 1. Exactly one current-job Evidence row, from that memory row.
    const rows = await evidenceOf(jobB, "FLOW_PATH");
    expect(rows.length).toBe(1);
    const adopted = rows[0];
    expect(adopted.researchJobId).toBe(jobB);
    expect(adopted.reusedFromMemoryId).toBe(memoryId);
    expect(adopted.extractionUnitKey).toBe(memoryAdoptionUnitKey(jobB, memoryId));
    expect(adopted.proofId).toBeNull();

    // 2/3. Provenance survives, and the chain back to the origin is intact:
    //   adopted -> memory -> provenance -> origin Evidence / source.
    const [mem] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, adopted.reusedFromMemoryId!));
    expect(mem.lifecycleState).toBe("ACTIVE");
    const [prov] = await ctx.db.select().from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, mem.id));
    expect(prov.originEvidenceId).toBe(originEvidenceId);
    const [origin] = await ctx.db.select().from(evidence).where(eq(evidence.id, originEvidenceId));
    expect(origin.researchJobId).toBe(jobA);
    expect(adopted.sourceId).toBe(prov.sourceId);
    expect(adopted.sourceId).toBe(origin.sourceId);
    expect(adopted.retrievedUrl).toBe(prov.retrievedUrl);
    expect(adopted.contentHash).toBe(prov.contentHash);
    expect(adopted.fragment).toBe(origin.fragment);
    expect(adopted.fetchedAt.toISOString()).toBe(prov.fetchedAt.toISOString());
    expect(adopted.relationship).toBe(origin.relationship);
    expect(adopted.directness).toBe(origin.directness);
    expect(adopted.claimKey).toBe("economic_source");

    // 4. Authority is today's: the route is ACTIVE OFFICIAL_DOCS now, so the
    //    adopted row resolves to it — through the resolver, not by copy.
    expect(adopted.sourceClass).toBe("OFFICIAL_DOCS");
    expect(adopted.officiality).toBe("CONFIRMED");
    expect(adopted.entityBinding).toBeNull();

    // 5. Ordinary S5: a result row of job B, resting on the adopted row,
    //    with the SAME status the same observation earned freshly in job A
    //    — SUPPORTED, the one status that is sufficient on its own.
    const s5B = await s5Of(jobB, "FLOW_PATH");
    const s5A = await s5Of(jobA, "FLOW_PATH");
    expect(s5B).toBeDefined();
    expect(s5B.supportingEvidenceIds).toEqual([adopted.id]);
    expect(s5B.status).toBe(s5A.status);
    expect(s5B.status).toBe("SUPPORTED");

    // 6. No MISSING_COMPONENT for the reused component; the assembly sees
    //    exactly what it sees for a freshly researched one.
    const gapsB = await gapsOf(jobB);
    const gapsA = await gapsOf(jobA);
    expect(gapsB).not.toContain("MISSING_COMPONENT@FLOW_PATH");
    expect(gapsB).toEqual(gapsA);

    // A NEW Proof, of this job.
    const proofB = await proofOf(jobB);
    const proofA = await proofOf(jobA);
    expect(proofB).toBeDefined();
    expect(proofB.id).not.toBe(proofA.id);
    expect(proofB.researchJobId).toBe(jobB);
  });

  it("1b. a PARTIALLY_SUPPORTED adoption FAILS CLOSED: SOURCE_OF_VALUE's mechanical-provenance cap is off the allowlist, so the component is freshly acquired and the S5 row rests on the adopted AND the fresh row", async () => {
    const p = await makeProject();
    const src = await makeSource();
    const { memoryId } = await researchAThenPromote(p.id, src.id, 1, "SOURCE_OF_VALUE");

    const worked: string[] = [];
    const jobB = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobB, fixtureExecutor(src.id, worked));

    // Adoption ran and wrote ordinary Evidence of this job from the memory row.
    const rows = await evidenceOf(jobB, "SOURCE_OF_VALUE");
    const adopted = rows.find((r) => r.reusedFromMemoryId === memoryId);
    expect(adopted).toBeDefined();
    expect(adopted!.extractionUnitKey).toBe(memoryAdoptionUnitKey(jobB, memoryId));

    // The reducer capped it for a reason the audit refused to allowlist —
    // fresh work for this very component can name the activity and admit
    // the locator the obligation's chain half needs — so the component was
    // NOT suppressed: it entered fresh acquisition exactly like a control.
    expect(worked).toContain("1:SOURCE_OF_VALUE");
    expect(worked.length).toBe(10);
    expect(await attemptsOf(jobB)).toContain("1:SOURCE_OF_VALUE");
    const fresh = rows.find((r) => r.reusedFromMemoryId === null);
    expect(fresh).toBeDefined();

    const s5B = await s5Of(jobB, "SOURCE_OF_VALUE");
    expect(s5B.status).toBe("PARTIALLY_SUPPORTED");
    expect(s5B.reasonCodes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    for (const code of s5B.reasonCodes as string[]) {
      expect(MEMORY_ADOPTION_SUFFICIENT_PARTIAL_REASONS.has(code as never), code).toBe(false);
    }
    // Old observation + new observation -> the new result rests on both.
    expect([...(s5B.supportingEvidenceIds as string[])].sort()).toEqual([adopted!.id, fresh!.id].sort());
    expect(await gapsOf(jobB)).not.toContain("MISSING_COMPONENT@SOURCE_OF_VALUE");

    // The control: a project with no memory reaches the same component
    // result, and the same component-level gap kind.
    const q = await makeProject();
    const jobC = await newJob(q.id);
    await handleResearchJobTask(ctx.db, jobC, fixtureExecutor(src.id, []));
    expect((await s5Of(jobC, "SOURCE_OF_VALUE")).status).toBe(s5B.status);
    expect(await gapsOf(jobC)).toContain("PARTIAL_COMPONENT@SOURCE_OF_VALUE");
    expect(await gapsOf(jobB)).toContain("PARTIAL_COMPONENT@SOURCE_OF_VALUE");
    expect(await gapsOf(jobB)).not.toContain("MISSING_COMPONENT@SOURCE_OF_VALUE");
  });

  it("7/8. nothing conclusive is copied: a corrupted old S5 row and a corrupted old Proof leave the new job's result exactly what its own Evidence says", async () => {
    const p = await makeProject();
    const src = await makeSource();
    const { jobA } = await researchAThenPromote(p.id, src.id, 1, "SOURCE_OF_VALUE");
    // Poison every conclusion of job A after promotion. If anything were
    // copied, job B would inherit it.
    await ctx.db
      .update(researchComponentResults)
      .set({ status: "CONTRADICTED", reasonCodes: ["POISONED"] })
      .where(and(eq(researchComponentResults.researchJobId, jobA), eq(researchComponentResults.component, "SOURCE_OF_VALUE")));
    await ctx.db.update(proofs).set({ verdict: "SUPPORTED", confidence: 95 }).where(eq(proofs.researchJobId, jobA));

    const jobB = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobB, fixtureExecutor(src.id, []));
    const s5B = await s5Of(jobB, "SOURCE_OF_VALUE");
    expect(s5B.status).toBe("PARTIALLY_SUPPORTED");
    expect(s5B.reasonCodes).not.toContain("POISONED");

    // The control: same executor, a project with no memory at all. Job B's
    // Proof equals the freshly computed one, not the poisoned one.
    const q = await makeProject();
    const jobC = await newJob(q.id);
    await handleResearchJobTask(ctx.db, jobC, fixtureExecutor(src.id, []));
    const proofB = await proofOf(jobB);
    const proofC = await proofOf(jobC);
    expect(proofB.verdict).toBe(proofC.verdict);
    expect(proofB.confidence).toBe(proofC.confidence);
    expect(proofB.verdict === "SUPPORTED" && proofB.confidence === 95).toBe(false);
  });

  it("11a. authority changed since: the adopted row is inadmissible today, the component is freshly acquired, and the Proof rests on the fresh row", async () => {
    const p = await makeProject();
    const src = await makeSource();
    const { memoryId } = await researchAThenPromote(p.id, src.id, 1, "SOURCE_OF_VALUE");
    // The human withdraws the route (ACTIVE -> DEPRECATED is a lawful
    // lifecycle move). The memory row is untouched and still ACTIVE.
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, p.routeId!));

    const worked: string[] = [];
    const jobB = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobB, fixtureExecutor(src.id, worked));

    // Adoption happened — and resolved to today's weakest authority.
    const rows = await evidenceOf(jobB, "SOURCE_OF_VALUE");
    const adopted = rows.find((r) => r.reusedFromMemoryId === memoryId);
    expect(adopted).toBeDefined();
    expect(adopted!.officiality).toBe("CLAIMED");
    expect(adopted!.sourceClass).not.toBe("OFFICIAL_DOCS");

    // Which did not suppress the component: it was freshly acquired.
    expect(worked).toContain("1:SOURCE_OF_VALUE");
    expect(await attemptsOf(jobB)).toContain("1:SOURCE_OF_VALUE");
    const fresh = rows.find((r) => r.reusedFromMemoryId === null);
    expect(fresh).toBeDefined();

    // The final S5 row rests on the fresh row and refuses the adopted one.
    const s5B = await s5Of(jobB, "SOURCE_OF_VALUE");
    expect(s5B.status).toBe("PARTIALLY_SUPPORTED");
    expect(s5B.supportingEvidenceIds).toEqual([fresh!.id]);
    const excluded = (s5B.excludedEvidence as { evidenceId: string; reason: string }[]).map((e) => e.evidenceId);
    expect(excluded).toContain(adopted!.id);
    expect(await gapsOf(jobB)).not.toContain("MISSING_COMPONENT@SOURCE_OF_VALUE");
    expect(await proofOf(jobB)).toBeDefined();
  });

  it("11b. incomplete provenance and stale memory both fall back to fresh acquisition without writing anything", async () => {
    const src = await makeSource();

    // No provenance copied: nothing can be cited, nothing is adopted.
    const p1 = await makeProject();
    await researchAThenPromote(p1.id, src.id, 1, "SOURCE_OF_VALUE", { withProvenance: false });
    const worked1: string[] = [];
    const b1 = await newJob(p1.id);
    await handleResearchJobTask(ctx.db, b1, fixtureExecutor(src.id, worked1));
    expect(worked1).toContain("1:SOURCE_OF_VALUE");
    expect((await evidenceOf(b1, "SOURCE_OF_VALUE")).every((r) => r.reusedFromMemoryId === null)).toBe(true);
    expect((await s5Of(b1, "SOURCE_OF_VALUE")).status).toBe("PARTIALLY_SUPPORTED");

    // Stale: the planner never marks it SATISFIED (REUSE DOES NOT OVERRIDE
    // FRESHNESS), so adoption is never asked and the component is fresh work.
    const p2 = await makeProject();
    await researchAThenPromote(p2.id, src.id, 1, "SOURCE_OF_VALUE", { verifiedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000) });
    const worked2: string[] = [];
    const b2 = await newJob(p2.id);
    await handleResearchJobTask(ctx.db, b2, fixtureExecutor(src.id, worked2));
    expect(worked2).toContain("1:SOURCE_OF_VALUE");
    expect((await evidenceOf(b2, "SOURCE_OF_VALUE")).every((r) => r.reusedFromMemoryId === null)).toBe(true);
  });

  it("9/10. CURRENT_STATE and NET_EFFECT are never closed from documentary memory — fresh-only by Pattern data, not by name", async () => {
    expect(isFreshOnlyComponent(PATTERN_V1_CONTENT, "CURRENT_STATE")).toBe(true);
    expect(isFreshOnlyComponent(PATTERN_V1_CONTENT, "NET_EFFECT")).toBe(true);
    expect(isFreshOnlyComponent(PATTERN_V1_CONTENT, "EXECUTION_EVIDENCE")).toBe(true);
    expect(isFreshOnlyComponent(PATTERN_V1_CONTENT, "SOURCE_OF_VALUE")).toBe(false);
    expect(isFreshOnlyComponent(PATTERN_V1_CONTENT, "GOVERNANCE_BASIS")).toBe(false);

    const p = await makeProject();
    const src = await makeSource();
    // ACTIVE, fresh, confident, fully provenanced memory for both — the
    // planner WILL mark them SATISFIED. Adoption must still refuse.
    const cs = await researchAThenPromote(p.id, src.id, 5, "CURRENT_STATE");
    const admin = await makeAdmin();
    const [neOrigin] = await evidenceOf(cs.jobA, "NET_EFFECT");
    const { id: neMemory } = await observeMemoryCandidate(ctx.db, {
      projectId: p.id,
      topicId: await activeTopicId(),
      patternStep: 7,
      component: "NET_EFFECT",
      claimKey: "net_effect",
      statement: "supply was reduced",
      freshnessClass: "LOW_CHANGE",
      verifiedAt: new Date(),
      confidence: 95,
      originKind: "TEST_PROMOTION",
    });
    await promoteToActive(ctx.db, neMemory, admin);
    await copyProvenanceFromEvidence(ctx.db, neMemory, neOrigin.id);

    const worked: string[] = [];
    const jobB = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobB, fixtureExecutor(src.id, worked));

    const { view: planned } = await loadJobContractView(ctx.db, jobB);
    expect(planned.reused.map((r) => r.component).sort()).toEqual(["CURRENT_STATE", "NET_EFFECT"]);
    expect(worked).toContain("5:CURRENT_STATE");
    expect(worked).toContain("7:NET_EFFECT");
    for (const component of ["CURRENT_STATE", "NET_EFFECT"]) {
      const rows = await evidenceOf(jobB, component);
      expect(rows.length).toBe(1);
      expect(rows[0].reusedFromMemoryId).toBeNull();
    }
  });

  it("12/13. another project's memory, or a row for another step/component, is never adopted — fail closed at the point of materialization", async () => {
    const src = await makeSource();
    const p = await makeProject();
    const { memoryId } = await researchAThenPromote(p.id, src.id, 2, "FLOW_PATH");

    // Another project never even retrieves it (planner scope)…
    const q = await makeProject();
    const worked: string[] = [];
    const jobQ = await newJob(q.id);
    await handleResearchJobTask(ctx.db, jobQ, fixtureExecutor(src.id, worked));
    expect(worked).toContain("2:FLOW_PATH");
    expect((await evidenceOf(jobQ, "FLOW_PATH")).every((r) => r.reusedFromMemoryId === null)).toBe(true);

    // …and a contract that CLAIMED it would be refused by adoption itself.
    // Planned but not run, so the only Evidence in play is what adoption
    // would write.
    const jobQ2 = await newJob(q.id);
    await runMemoryPlanningStage(ctx.db, jobQ2);
    const { view } = await loadJobContractView(ctx.db, jobQ2);
    const forgedCrossProject = await adoptReusedMemory(
      ctx.db,
      jobQ2,
      { ...view, reused: [{ step: 2, component: "FLOW_PATH", memoryIds: [memoryId] }] },
      new Date(),
    );
    expect(forgedCrossProject.adopted).toEqual([]);
    expect(forgedCrossProject.fallback[0].refusals).toEqual([{ memoryId, reason: "MEMORY_SCOPE_MISMATCH" }]);
    expect((await evidenceOf(jobQ2, "FLOW_PATH")).length).toBe(0);

    // Same project, wrong component for the row.
    const jobP = await newJob(p.id);
    await runMemoryPlanningStage(ctx.db, jobP);
    const { view: viewP } = await loadJobContractView(ctx.db, jobP);
    const forgedComponent = await adoptReusedMemory(
      ctx.db,
      jobP,
      { ...viewP, reused: [{ step: 3, component: "MECHANISM_SPEC", memoryIds: [memoryId] }] },
      new Date(),
    );
    expect(forgedComponent.fallback[0].refusals).toEqual([{ memoryId, reason: "MEMORY_SCOPE_MISMATCH" }]);
    expect((await evidenceOf(jobP, "MECHANISM_SPEC")).length).toBe(0);
    // Even after the row has legitimately been adopted for its own
    // component, it cannot be inherited by another one.
    const legit = await adoptReusedMemory(ctx.db, jobP, viewP, new Date());
    expect(legit.adopted.map((a) => a.component)).toEqual(["FLOW_PATH"]);
    const forgedAfter = await adoptReusedMemory(
      ctx.db,
      jobP,
      { ...viewP, reused: [{ step: 3, component: "MECHANISM_SPEC", memoryIds: [memoryId] }] },
      new Date(),
    );
    expect(forgedAfter.fallback[0].refusals).toEqual([{ memoryId, reason: "MEMORY_SCOPE_MISMATCH" }]);
    expect((await evidenceOf(jobP, "MECHANISM_SPEC")).length).toBe(0);
    // MECHANISM_SPEC was already planned work; the refusal adds no second copy.
    expect(forgedComponent.workQueue.filter((w) => w.component === "MECHANISM_SPEC").length).toBe(1);
    // And a refused component that was NOT planned work joins the queue in
    // the contract's own shape, with the reason as a blocker.
    const forgedSov = await adoptReusedMemory(
      ctx.db,
      jobQ2,
      { ...view, reused: [{ step: 2, component: "FLOW_PATH", memoryIds: [memoryId] }], workQueue: view.workQueue.filter((w) => w.component !== "FLOW_PATH") },
      new Date(),
    );
    const item = forgedSov.workQueue.find((w) => w.component === "FLOW_PATH");
    expect(item?.state).toBe("UNUSABLE");
    expect(item?.blockers).toEqual(["MEMORY_ADOPTION_MEMORY_SCOPE_MISMATCH"]);
    expect(forgedSov.workQueue.filter((w) => w.component === "FLOW_PATH").length).toBe(1);
  });

  it("15. idempotent: re-running adoption for the same job adopts nothing twice", async () => {
    const p = await makeProject();
    const src = await makeSource();
    const { memoryId } = await researchAThenPromote(p.id, src.id, 2, "FLOW_PATH");
    const jobB = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobB, fixtureExecutor(src.id, []));
    const before = await evidenceOf(jobB, "FLOW_PATH");
    expect(before.length).toBe(1);

    const { view } = await loadJobContractView(ctx.db, jobB);
    const again = await adoptReusedMemory(ctx.db, jobB, view, new Date());
    const twice = await adoptReusedMemory(ctx.db, jobB, view, new Date());
    expect(again.adopted[0].evidenceIds).toEqual([before[0].id]);
    expect(twice.adopted[0].evidenceIds).toEqual([before[0].id]);
    expect((await evidenceOf(jobB, "FLOW_PATH")).length).toBe(1);
    expect(again.workQueue.map((w) => w.component)).not.toContain("FLOW_PATH");

    // And the database itself refuses a second adopted row for the pair.
    await expect(
      ctx.db.insert(evidence).values({
        researchJobId: jobB,
        proofId: null,
        sourceId: src.id,
        patternStep: 2,
        component: "FLOW_PATH",
        relationship: "SUPPORTS",
        directness: "DIRECT",
        fragment: FRAGMENT,
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        fetchedAt: new Date(),
        retrievedUrl: DOC_URL,
        contentHash: "sha256:dup",
        extractionUnitKey: uniq("unit"),
        reusedFromMemoryId: memoryId,
      }),
    ).rejects.toThrow();
  });

  it("14/16. no chain observation travels through research_memory, and nothing is decided by a project, chain or component name", async () => {
    const src = readFileSync("src/server/engine/memory-evidence-adoption.ts", "utf-8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of [
      "onchain-acquisition",
      "onchain-retriever",
      "onchain-transport",
      "onchain-supply-candidate-store",
      "onchainArtifacts",
      "project_memory_items",
      "projectMemoryItems",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    for (const literal of ["lido", "pump_fun", "ethereum", "solana", "\"CURRENT_STATE\"", "\"NET_EFFECT\"", "\"SOURCE_OF_VALUE\""]) {
      expect(code, literal).not.toContain(literal);
    }
    // Adopted rows are documentary by construction.
    expect(code).toContain("onchainFactKind: null");
    expect(code).toContain("onchainArtifactId: null");
    // The same effective queue on both entry points.
    const runJob = readFileSync("src/server/engine/run-job.ts", "utf-8");
    expect(runJob).toContain("adoptReusedMemory(db, jobId, plannedView, now)");
    const phased = readFileSync("src/server/jobs/acquisition-phase-worker.ts", "utf-8");
    expect(phased).toContain("items: adoption.workQueue");
    // Scope is re-checked on every axis at materialization time.
    expect(code).toContain("memory.projectId !== projectId");
    expect(code).toContain("memory.topicId !== topicId");
    expect(code).toContain("memory.patternStep !== step");
    expect(code).toContain("memory.component !== component");
  });
});
