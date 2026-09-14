import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  evidence,
  productConfig,
  projects,
  researchAttempts,
  researchComponentResults,
  researchMechanismAssembly,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { loadFetchTargets, runSearchPhase } from "../src/server/engine/acquisition-phases";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { extractionUnitKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import {
  MEMORY_ADOPTION_SUFFICIENT_PARTIAL_REASONS,
  adoptReusedMemory,
  isMemoryAdoptionSufficient,
  loadEffectiveJobContractView,
} from "../src/server/engine/memory-evidence-adoption";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { resolveOnchainSourceOpenReserve } from "../src/server/engine/onchain-source-open-reserve";
import type { ComponentTarget } from "../src/server/engine/providers/types";
import { selectApprovedSeedTargets } from "../src/server/engine/source-resource-seeds";
import {
  copyProvenanceFromEvidence,
  observeMemoryCandidate,
  promoteToActive,
} from "../src/server/memory/lifecycle";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH MEMORY ADOPTION HARDENING V1.
//
// ISSUE 1 — sufficiency fails closed. SUPPORTED suppresses fresh acquisition;
// PARTIALLY_SUPPORTED does so only when its complete, exact reason set is on
// an explicit positive allowlist of proven structural ceilings. The audit
// found none, so the production allowlist is empty; the set semantics are
// proven here with a hypothetical list, and the production list is proven
// to refuse every reason code the reducer can emit — including any code
// added after this test was written.
//
// ISSUE 2 — true fresh fallback parity. A component the planner closed from
// memory and adoption then could not establish must regain EXACTLY the
// acquisition opportunity a control job (memory never satisfied it) gives
// it: work-queue membership and position, approved-resource seeding, search
// preparation, fetch targets, the on-chain source-open reserve — and it
// must keep that membership for the whole job, even after its own fresh
// work turns the S5 row SUPPORTED with the adopted row among the support.

let ctx: TestContext;
let componentVocabulary: Set<string>;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  componentVocabulary = await loadActivePatternComponents(ctx.db);
  await ctx.db
    .insert(productConfig)
    .values({ key: "memory_enabled", value: true })
    .onConflictDoUpdate({ target: productConfig.key, set: { value: true } });
});

afterAll(async () => {
  await ctx.close();
});

const HOST = "docs.adoptionparity.org";
const DOC_URL = `https://${HOST}/docs/flow-path`;
const SEARCH_HIT_URL = `https://${HOST}/docs/waterfall`;
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const FRAGMENT = "fees collected by the router are forwarded to the protocol vault before any distribution";
const STEP = 2;
const COMPONENT = "FLOW_PATH";
const KEY = `${STEP}:${COMPONENT}`;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

function keysOf(items: readonly ComponentWorkItem[]): string[] {
  return items.map((i) => `${i.step}:${i.component}`);
}

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeAdmin(): Promise<string> {
  const [a] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
  return a.id;
}

// A project in the state a real onboarded project is in: confirmed chain
// identity (so the on-chain reserve has something to protect), a confirmed
// + classified OFFICIAL_DOCS route, and one human-approved resource under it
// for the component under test.
async function makeProject(): Promise<{ id: string; slug: string; name: string }> {
  const slug = uniq("parity");
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Adoption parity project", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
  if (!identity.ok) throw new Error("identity fixture failed");
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  const resource = await registerSourceResource(
    ctx.db,
    { projectSlug: slug, url: DOC_URL, componentKeys: [COMPONENT] },
    componentVocabulary,
  );
  if (!resource.ok) throw new Error("resource fixture failed");
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

async function newJob(projectId: string, opts: { plan: boolean }): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: await activeTopicId(),
      projectId,
      originalQuestion: "how does protocol value flow to the token?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "how does protocol value flow to the token" },
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

// The fixture acquisition: every worked component yields one admitted
// OFFICIAL_DOCS / CONFIRMED row from the project's documentation, with the
// directness and passage the caller chooses, persisted under the SAME
// canonical unit identity and conflict rule the real executor uses.
function fixtureExecutor(
  sourceId: string,
  worked: string[],
  directness: "DIRECT" | "INDIRECT",
  fragment: string = FRAGMENT,
): WorkExecutor {
  return {
    async execute(item, c) {
      worked.push(`${item.step}:${item.component}`);
      await ctx.db
        .insert(evidence)
        .values({
          researchJobId: c.jobId,
          proofId: null,
          sourceId,
          patternStep: item.step,
          component: item.component,
          relationship: "SUPPORTS",
          directness,
          fragment,
          summary: "router fees are forwarded to the protocol vault",
          mechanismState: null,
          sourceClass: "OFFICIAL_DOCS",
          officiality: "CONFIRMED",
          fetchedAt: new Date(),
          publishedAt: new Date(),
          doesNotProve: "does not prove the vault distributes anything",
          retrievedUrl: DOC_URL,
          contentHash: `sha256:${uniq("content")}`,
          extractionUnitKey: extractionUnitKey(c.jobId, sourceId, item.step, item.component, fragment),
        })
        .onConflictDoNothing({ target: evidence.extractionUnitKey, where: sql`${evidence.extractionUnitKey} IS NOT NULL` });
      return { status: "SUCCEEDED", reason: "fixture component completed" };
    },
  };
}

const FRESH_FRAGMENT = "after the swap completes the router transfers the collected fee to the vault account";

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

async function attemptsOf(jobId: string): Promise<string[]> {
  const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  return rows.map((r) => `${r.patternStep}:${r.component}`).sort();
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

// Every trace row this job wrote for the component, reduced to the fields
// that describe the acquisition opportunity: what was done, by which
// provider role, against which target, with what budget. Ids and sequence
// numbers differ between jobs by construction and are not compared.
async function traceSignature(jobId: string, component: string): Promise<string[]> {
  const rows = await ctx.db
    .select()
    .from(researchTraceEvents)
    .where(and(eq(researchTraceEvents.researchJobId, jobId), eq(researchTraceEvents.component, component)));
  return rows
    .map((r) =>
      [r.operationType, r.providerKind, r.providerName, r.patternStep, r.status, r.reasonCode, r.budgetAxis, r.budgetAmount, r.targetRef].join("|"),
    )
    .sort();
}

// Research A on `projectId` with the given directness, then its FLOW_PATH
// observation promoted through the real lifecycle to ACTIVE memory.
async function researchAThenPromote(
  projectId: string,
  sourceId: string,
  directness: "DIRECT" | "INDIRECT",
): Promise<{ jobA: string; memoryId: string }> {
  const jobA = await newJob(projectId, { plan: false });
  await handleResearchJobTask(ctx.db, jobA, fixtureExecutor(sourceId, [], directness));
  const [origin] = await evidenceOf(jobA, COMPONENT);
  expect(origin).toBeDefined();
  expect(origin.directness).toBe(directness);
  const admin = await makeAdmin();
  const { id: memoryId } = await observeMemoryCandidate(ctx.db, {
    projectId,
    topicId: await activeTopicId(),
    patternStep: STEP,
    component: COMPONENT,
    claimKey: "value_flow",
    statement: origin.summary ?? origin.fragment,
    freshnessClass: "LOW_CHANGE",
    verifiedAt: new Date(),
    confidence: 90,
    originKind: "TEST_PROMOTION",
  });
  await promoteToActive(ctx.db, memoryId, admin);
  await copyProvenanceFromEvidence(ctx.db, memoryId, origin.id);
  return { jobA, memoryId };
}

// The deterministic search preparation, exactly as the SEARCHING phase runs
// it, with a fixture proposer that records what it was asked for.
async function prepareSearch(
  project: { id: string; name: string; slug: string },
  jobId: string,
  items: ComponentWorkItem[],
): Promise<Array<{ component: string; hint: string; maxQueries: number }>> {
  const calls: Array<{ component: string; hint: string; maxQueries: number }> = [];
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items,
    target: (item: ComponentWorkItem): ComponentTarget => ({
      step: item.step,
      stepName: item.stepName,
      component: item.component,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
    }),
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        calls.push({ component: input.target.component, hint: input.hint, maxQueries: input.maxQueries });
        return Array.from({ length: input.maxQueries }, (_, i) => `q-${i + 1}`);
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search() {
        return [{ url: SEARCH_HIT_URL, title: null, snippet: null }];
      },
    },
    maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
    maxResultsPerQuery: 5,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });
  return calls;
}

describe("ISSUE 1 — memory sufficiency fails closed", () => {
  const ADOPTED = "adopted-evidence-id";
  const OTHER = "some-other-evidence-id";
  const HYPOTHETICAL: ReadonlySet<string> = new Set(["HYPOTHETICAL_STABLE_CEILING"]);

  it("SUPPORTED remains sufficient — when the adopted row is among the support", () => {
    expect(isMemoryAdoptionSufficient({ status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: [ADOPTED] }, [ADOPTED])).toBe(true);
    expect(isMemoryAdoptionSufficient({ status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: [OTHER, ADOPTED] }, [ADOPTED])).toBe(true);
    // A SUPPORTED earned by other Evidence of the job says nothing about the memory.
    expect(isMemoryAdoptionSufficient({ status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: [OTHER] }, [ADOPTED])).toBe(false);
    expect(isMemoryAdoptionSufficient({ status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: [] }, [ADOPTED])).toBe(false);
  });

  it("an allowlisted PARTIALLY_SUPPORTED may remain sufficient — only as a complete, exact reason set", () => {
    const partial = (reasonCodes: string[]) => ({ status: "PARTIALLY_SUPPORTED" as const, reasonCodes, supportingEvidenceIds: [ADOPTED] });
    expect(isMemoryAdoptionSufficient(partial(["HYPOTHETICAL_STABLE_CEILING"]), [ADOPTED], HYPOTHETICAL)).toBe(true);
    expect(isMemoryAdoptionSufficient(partial(["HYPOTHETICAL_STABLE_CEILING", "HYPOTHETICAL_STABLE_CEILING"]), [ADOPTED], HYPOTHETICAL)).toBe(true);
    // Established by someone else's row: still not the memory's doing.
    expect(isMemoryAdoptionSufficient({ ...partial(["HYPOTHETICAL_STABLE_CEILING"]), supportingEvidenceIds: [OTHER] }, [ADOPTED], HYPOTHETICAL)).toBe(false);
  });

  it("a non-allowlisted PARTIALLY_SUPPORTED restores acquisition", () => {
    const partial = (reasonCodes: string[]) => ({ status: "PARTIALLY_SUPPORTED" as const, reasonCodes, supportingEvidenceIds: [ADOPTED] });
    expect(isMemoryAdoptionSufficient(partial(["INSUFFICIENT_AUTHORITY"]), [ADOPTED], HYPOTHETICAL)).toBe(false);
    expect(isMemoryAdoptionSufficient(partial(["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]), [ADOPTED], HYPOTHETICAL)).toBe(false);
  });

  it("an unknown / future reason restores acquisition, and an empty reason set on a partial row is malformed and fails closed", () => {
    const partial = (reasonCodes: string[]) => ({ status: "PARTIALLY_SUPPORTED" as const, reasonCodes, supportingEvidenceIds: [ADOPTED] });
    expect(isMemoryAdoptionSufficient(partial(["SOME_REASON_ADDED_NEXT_YEAR"]), [ADOPTED], HYPOTHETICAL)).toBe(false);
    expect(isMemoryAdoptionSufficient(partial([]), [ADOPTED], HYPOTHETICAL)).toBe(false);
  });

  it("mixed reasons fail closed unless the complete exact set is proven safe", () => {
    const partial = (reasonCodes: string[]) => ({ status: "PARTIALLY_SUPPORTED" as const, reasonCodes, supportingEvidenceIds: [ADOPTED] });
    expect(isMemoryAdoptionSufficient(partial(["HYPOTHETICAL_STABLE_CEILING", "INDIRECT_ONLY"]), [ADOPTED], HYPOTHETICAL)).toBe(false);
    expect(isMemoryAdoptionSufficient(partial(["INDIRECT_ONLY", "HYPOTHETICAL_STABLE_CEILING"]), [ADOPTED], HYPOTHETICAL)).toBe(false);
    expect(isMemoryAdoptionSufficient(partial(["HYPOTHETICAL_STABLE_CEILING", "SOME_REASON_ADDED_NEXT_YEAR"]), [ADOPTED], HYPOTHETICAL)).toBe(false);
    const two: ReadonlySet<string> = new Set(["HYPOTHETICAL_STABLE_CEILING", "INDIRECT_ONLY"]);
    expect(isMemoryAdoptionSufficient(partial(["HYPOTHETICAL_STABLE_CEILING", "INDIRECT_ONLY"]), [ADOPTED], two)).toBe(true);
  });

  it("no other status is ever sufficient", () => {
    for (const status of ["INSUFFICIENT_EVIDENCE", "CONTRADICTED"] as const) {
      expect(isMemoryAdoptionSufficient({ status, reasonCodes: [], supportingEvidenceIds: [ADOPTED] }, [ADOPTED], HYPOTHETICAL)).toBe(false);
      expect(isMemoryAdoptionSufficient({ status, reasonCodes: ["HYPOTHETICAL_STABLE_CEILING"], supportingEvidenceIds: [ADOPTED] }, [ADOPTED], HYPOTHETICAL)).toBe(false);
    }
  });

  it("the PRODUCTION allowlist is empty: every reason code the reducer can emit — and any added later — restores acquisition", () => {
    expect(MEMORY_ADOPTION_SUFFICIENT_PARTIAL_REASONS.size).toBe(0);
    // Read the closed union from the reducer's own source, so a code added
    // after this test was written is covered without editing the test.
    const src = readFileSync("src/server/engine/component-reconciler.ts", "utf-8");
    const start = src.indexOf("export type ResultReasonCode =");
    expect(start).toBeGreaterThan(0);
    // Union members are `| "CODE"` lines, interleaved with comment lines;
    // the last member ends the statement with `;`.
    const codes: string[] = [];
    for (const line of src.slice(start).split("\n").slice(1)) {
      if (line.trim().startsWith("//")) continue;
      const m = /^\s*\|\s*"([A-Z_]+)"\s*(;?)/.exec(line);
      if (!m) break;
      codes.push(m[1]);
      if (m[2] === ";") break;
    }
    expect(codes).toContain("MECHANICAL_PROVENANCE_NOT_ESTABLISHED");
    expect(codes).toContain("INSUFFICIENT_AUTHORITY");
    expect(codes.length).toBeGreaterThanOrEqual(18);
    for (const code of codes) {
      expect(MEMORY_ADOPTION_SUFFICIENT_PARTIAL_REASONS.has(code as never), code).toBe(false);
      expect(
        isMemoryAdoptionSufficient({ status: "PARTIALLY_SUPPORTED", reasonCodes: [code], supportingEvidenceIds: [ADOPTED] }, [ADOPTED]),
        code,
      ).toBe(false);
    }
  });
});

describe("ISSUE 2 — control-vs-fallback fresh acquisition parity", () => {
  it("a component memory closed and adoption could not establish regains EXACTLY the control's acquisition preparation, and keeps it for the job's lifetime", async () => {
    const src = await makeSource();

    // CONTROL: no memory at all. FALLBACK: ACTIVE memory whose observation
    // is INDIRECT, so adoption reduces it to PARTIALLY_SUPPORTED
    // (INDIRECT_ONLY) — a reason off the allowlist. HOLDS: the same
    // observation DIRECT, so adoption reduces to SUPPORTED and the
    // component is genuinely closed — the contrast that shows the
    // assertions below bite.
    const control = await makeProject();
    const fb = await makeProject();
    const holds = await makeProject();
    const { memoryId } = await researchAThenPromote(fb.id, src.id, "INDIRECT");
    const { memoryId: holdsMemoryId } = await researchAThenPromote(holds.id, src.id, "DIRECT");

    const jobC = await newJob(control.id, { plan: true });
    const jobF = await newJob(fb.id, { plan: true });
    const jobH = await newJob(holds.id, { plan: true });

    // --- the planner, before adoption -----------------------------------
    const { view: plannedC } = await loadJobContractView(ctx.db, jobC);
    const { view: plannedF } = await loadJobContractView(ctx.db, jobF);
    const { view: plannedH } = await loadJobContractView(ctx.db, jobH);
    expect(plannedC.reused).toEqual([]);
    expect(keysOf(plannedC.workQueue)).toContain(KEY);
    expect(plannedF.reused).toEqual([{ step: STEP, component: COMPONENT, memoryIds: [memoryId] }]);
    expect(keysOf(plannedF.workQueue)).not.toContain(KEY);
    expect(plannedH.reused).toEqual([{ step: STEP, component: COMPONENT, memoryIds: [holdsMemoryId] }]);

    // --- adoption ---------------------------------------------------------
    const adoptionC = await adoptReusedMemory(ctx.db, jobC, plannedC, new Date());
    const adoptionF = await adoptReusedMemory(ctx.db, jobF, plannedF, new Date());
    const adoptionH = await adoptReusedMemory(ctx.db, jobH, plannedH, new Date());
    expect(adoptionC.adopted).toEqual([]);
    expect(adoptionC.fallback).toEqual([]);

    // Adoption wrote ordinary current-job Evidence in BOTH memory jobs...
    const adoptedF = (await evidenceOf(jobF, COMPONENT)).find((r) => r.reusedFromMemoryId === memoryId);
    expect(adoptedF).toBeDefined();
    expect(adoptedF!.directness).toBe("INDIRECT");
    // ...HOLDS is sufficient (SUPPORTED, by the adopted row)...
    expect(adoptionH.adopted.map((a) => a.component)).toEqual([COMPONENT]);
    expect(adoptionH.adopted[0].status).toBe("SUPPORTED");
    expect(keysOf(adoptionH.workQueue)).not.toContain(KEY);
    // ...FALLBACK is not: PARTIALLY_SUPPORTED on INDIRECT_ONLY fails closed.
    expect(adoptionF.adopted).toEqual([]);
    expect(adoptionF.fallback.map((f) => f.component)).toEqual([COMPONENT]);
    expect(adoptionF.fallback[0].status).toBe("PARTIALLY_SUPPORTED");
    expect(adoptionF.fallback[0].evidenceIds).toEqual([adoptedF!.id]);
    expect(adoptionF.fallback[0].refusals).toEqual([{ memoryId: null, reason: "NOT_ESTABLISHED" }]);
    const s5F = await s5Of(jobF, COMPONENT);
    expect(s5F.status).toBe("PARTIALLY_SUPPORTED");
    expect(s5F.reasonCodes).toEqual(["INDIRECT_ONLY"]);
    expect(s5F.supportingEvidenceIds).toEqual([adoptedF!.id]);

    // 1. WORK QUEUE — membership AND position equal the control's.
    expect(keysOf(adoptionF.workQueue)).toEqual(keysOf(adoptionC.workQueue));
    expect(keysOf(adoptionF.workQueue)).toEqual(keysOf(plannedC.workQueue));
    // The fallback item IS the control's item: nothing downstream (the
    // executor's proposer hint included) can tell them apart. The reason
    // lives on the adoption outcome, not on the acquisition path.
    const itemF = adoptionF.workQueue.find((w) => w.component === COMPONENT)!;
    expect(itemF).toEqual(plannedC.workQueue.find((w) => w.component === COMPONENT));
    expect(itemF.state).toBe("NO_MEMORY");
    expect(itemF.blockers).toEqual([]);
    expect(adoptionF.fallback[0].memoryIds).toEqual([memoryId]);

    // The read-back the downstream preparation steps use derives the SAME
    // effective queue from persisted state alone.
    const effF = await loadEffectiveJobContractView(ctx.db, jobF);
    expect(keysOf(effF.view.workQueue)).toEqual(keysOf(plannedC.workQueue));
    const effH = await loadEffectiveJobContractView(ctx.db, jobH);
    expect(keysOf(effH.view.workQueue)).not.toContain(KEY);
    expect(keysOf((await loadEffectiveJobContractView(ctx.db, jobC)).view.workQueue)).toEqual(keysOf(plannedC.workQueue));

    // 2. SOURCE / RESOURCE SEEDS — the approved resource is routed to the
    //    component in the fallback exactly as in the control, and not at
    //    all where memory genuinely closed it.
    const seedsC = await selectApprovedSeedTargets(ctx.db, jobC, control.id);
    const seedsF = await selectApprovedSeedTargets(ctx.db, jobF, fb.id);
    const seedsH = await selectApprovedSeedTargets(ctx.db, jobH, holds.id);
    const seedShape = (s: (typeof seedsC)[number]) => ({ url: s.canonicalUrl, routeClass: s.routeClass, componentKeys: [...s.componentKeys], routedFor: [...s.routedFor] });
    expect(seedsC.length).toBe(1);
    expect(seedsC[0].routedFor).toContainEqual({ step: STEP, component: COMPONENT });
    expect(seedsF.map(seedShape)).toEqual(seedsC.map(seedShape));
    expect(seedsH.flatMap((s) => s.routedFor.map((r) => r.component))).not.toContain(COMPONENT);
    expect(await traceSignature(jobF, COMPONENT)).toEqual(await traceSignature(jobC, COMPONENT));
    expect((await traceSignature(jobC, COMPONENT)).some((s) => s.startsWith("SOURCE_RESOURCE_SELECTED|"))).toBe(true);
    expect((await traceSignature(jobH, COMPONENT)).some((s) => s.startsWith("SOURCE_RESOURCE_SELECTED|"))).toBe(false);

    // 3. ON-CHAIN SOURCE-OPEN RESERVE — the fallback component holds
    //    exactly the protection the control's does; the closed one holds none.
    const reserveArgs = (jobId: string, projectId: string) => ({ jobId, projectId, maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens });
    const reserveC = await resolveOnchainSourceOpenReserve(ctx.db, reserveArgs(jobC, control.id));
    const reserveF = await resolveOnchainSourceOpenReserve(ctx.db, reserveArgs(jobF, fb.id));
    const reserveH = await resolveOnchainSourceOpenReserve(ctx.db, reserveArgs(jobH, holds.id));
    expect(reserveF).toEqual(reserveC);
    expect(reserveC.planned).toBe(true);
    expect(reserveC.reserved).toBeGreaterThan(0);
    // On Pattern v1 every component that carries protected on-chain demand
    // is fresh-only (never closed from memory), so the genuinely closed
    // component changes nothing here either. The consumer reads the
    // effective queue regardless (pinned by source below), so a Pattern
    // that gives an adoptable component chain demand inherits the parity.
    expect(reserveH).toEqual(reserveC);
    expect(Object.keys(reserveC.demandByComponent)).not.toContain(COMPONENT);
    // The same, under the post-controller declaration.
    expect(await resolveOnchainSourceOpenReserve(ctx.db, { ...reserveArgs(jobF, fb.id), documentaryAcquisitionFinished: true })).toEqual(
      await resolveOnchainSourceOpenReserve(ctx.db, { ...reserveArgs(jobC, control.id), documentaryAcquisitionFinished: true }),
    );

    // 4. SEARCH PREPARATION — the proposer is asked for the component with
    //    the same hint and the same allowance, the same trace is written,
    //    and the same fetch targets come out.
    const callsC = await prepareSearch(control, jobC, adoptionC.workQueue);
    const callsF = await prepareSearch(fb, jobF, adoptionF.workQueue);
    expect(callsF).toEqual(callsC);
    expect(callsC.some((c) => c.component === COMPONENT)).toBe(true);
    const callsH = await prepareSearch(holds, jobH, adoptionH.workQueue);
    expect(callsH.some((c) => c.component === COMPONENT)).toBe(false);
    expect(await traceSignature(jobF, COMPONENT)).toEqual(await traceSignature(jobC, COMPONENT));
    expect((await traceSignature(jobC, COMPONENT)).some((s) => s.startsWith("QUERY_PROPOSED|"))).toBe(true);
    const targetsC = await loadFetchTargets(ctx.db, jobC, control.id);
    const targetsF = await loadFetchTargets(ctx.db, jobF, fb.id);
    expect(targetsF).toEqual(targetsC);
    expect(targetsC).toContain(DOC_URL);
    expect(targetsC).toContain(SEARCH_HIT_URL);
    // Preparation spent nothing that reaches a network: no fetch, no
    // attempt, and no Evidence beyond the adopted row.
    expect(await attemptsOf(jobF)).toEqual([]);
    expect((await evidenceOf(jobF, COMPONENT)).length).toBe(1);

    // 5. LIFETIME MEMBERSHIP — run the whole Research in both projects,
    //    with fresh work finding a genuinely NEW passage (a distinct unit).
    //    The fallback component is freshly acquired; its fresh DIRECT row
    //    and the adopted INDIRECT row now reduce to SUPPORTED with the
    //    adopted row among the support — the sufficiency rule alone would
    //    now call it adopted — and the effective queue STILL lists it, as
    //    the control's does, because it was handed to fresh work.
    const workedC: string[] = [];
    const workedF: string[] = [];
    const runC = await newJob(control.id, { plan: false });
    const runF = await newJob(fb.id, { plan: false });
    await handleResearchJobTask(ctx.db, runC, fixtureExecutor(src.id, workedC, "DIRECT", FRESH_FRAGMENT));
    await handleResearchJobTask(ctx.db, runF, fixtureExecutor(src.id, workedF, "DIRECT", FRESH_FRAGMENT));
    expect(workedF).toEqual(workedC);
    expect(workedF).toContain(KEY);
    expect(await attemptsOf(runF)).toEqual(await attemptsOf(runC));

    const adoptedRun = (await evidenceOf(runF, COMPONENT)).find((r) => r.reusedFromMemoryId === memoryId)!;
    const freshRun = (await evidenceOf(runF, COMPONENT)).find((r) => r.reusedFromMemoryId === null)!;
    expect(adoptedRun).toBeDefined();
    expect(freshRun).toBeDefined();
    const s5Run = await s5Of(runF, COMPONENT);
    expect(s5Run.status).toBe("SUPPORTED");
    expect([...(s5Run.supportingEvidenceIds as string[])].sort()).toEqual([adoptedRun.id, freshRun.id].sort());
    expect(
      isMemoryAdoptionSufficient(
        { status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: s5Run.supportingEvidenceIds as string[] },
        [adoptedRun.id],
      ),
    ).toBe(true);
    const effRunF = await loadEffectiveJobContractView(ctx.db, runF);
    const effRunC = await loadEffectiveJobContractView(ctx.db, runC);
    expect(keysOf(effRunF.view.workQueue)).toContain(KEY);
    expect(keysOf(effRunF.view.workQueue)).toEqual(keysOf(effRunC.view.workQueue));
    expect(
      await resolveOnchainSourceOpenReserve(ctx.db, { ...reserveArgs(runF, fb.id), documentaryAcquisitionFinished: true }),
    ).toEqual(await resolveOnchainSourceOpenReserve(ctx.db, { ...reserveArgs(runC, control.id), documentaryAcquisitionFinished: true }));
    expect((await s5Of(runC, COMPONENT)).status).toBe("SUPPORTED");
    expect(await gapsOf(runF)).not.toContain(`MISSING_COMPONENT@${COMPONENT}`);
    // NOT asserted: whole-assembly equality with the control — by design
    // here, since fresh work found a genuinely different passage, the two
    // units are two lineage slots. Same-passage re-acquisition collapsing
    // to one slot is proven in research-memory-fallback-parity-v1.test.ts.

    // And where memory genuinely closed the component, it stays closed for
    // the job's lifetime too: never worked, never attempted, never MISSING.
    const workedH: string[] = [];
    const runH = await newJob(holds.id, { plan: false });
    await handleResearchJobTask(ctx.db, runH, fixtureExecutor(src.id, workedH, "DIRECT"));
    expect(workedH).not.toContain(KEY);
    expect(workedH.length).toBe(workedC.length - 1);
    expect(await attemptsOf(runH)).not.toContain(KEY);
    expect(keysOf((await loadEffectiveJobContractView(ctx.db, runH)).view.workQueue)).not.toContain(KEY);
    expect(await gapsOf(runH)).not.toContain(`MISSING_COMPONENT@${COMPONENT}`);
  });

  it("the downstream preparation consumers read the effective queue, not the planned one", () => {
    const seeds = readFileSync("src/server/engine/source-resource-seeds.ts", "utf-8");
    const reserve = readFileSync("src/server/engine/onchain-source-open-reserve.ts", "utf-8");
    for (const file of [seeds, reserve]) {
      const code = file.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code).toContain("loadEffectiveJobContractView(");
      expect(code).not.toContain("loadJobContractView(");
    }
    // The two entry points still derive the effective queue through adoption.
    expect(readFileSync("src/server/engine/run-job.ts", "utf-8")).toContain("adoptReusedMemory(db, jobId, plannedView, now)");
    expect(readFileSync("src/server/jobs/acquisition-phase-worker.ts", "utf-8")).toContain("items: adoption.workQueue");
  });
});
