import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadProductConfig } from "../src/server/config/product";
import {
  evidence,
  onchainArtifacts,
  productConfig,
  projectMemoryItems,
  projects,
  proofs,
  researchComponentResults,
  researchMemory,
  researchMemoryProvenance,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { extractionUnitKey, observationKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { isFreshOnlyComponent } from "../src/server/engine/memory-evidence-adoption";
import { promoteToActive } from "../src/server/memory/lifecycle";
import {
  VERIFIED_OBSERVATION_CONFIDENCE,
  VERIFIED_OBSERVATION_ORIGIN_KIND,
  writeObservedCandidatesForVerifiedProof,
} from "../src/server/memory/observed-candidates";
import { markProofReviewed, markProofVerified } from "../src/server/memory/verification";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// VERIFIED RESEARCH -> OBSERVED MEMORY CANDIDATES V1 — the full offline
// lifecycle:
//
//   Research A -> Evidence -> Proof -> admin marks VERIFIED
//     -> OBSERVED candidates (eligible supporting documentary rows only)
//     -> controlled promotion to ACTIVE (test fixture, existing path)
//     -> Research B adopts it as ordinary current-job Evidence
//     -> Research B's OWN Proof; verifying B clones nothing back.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
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

const HOST = "docs.observedcandidates.org";
const DOC_URL = `https://${HOST}/docs/value-accrual`;
const FRAGMENT = "protocol fees accrue directly to the treasury contract, which is controlled by the token holders";
const OTHER_FRAGMENT = "the treasury contract receives the protocol fees on every trade";

type RowOverride = {
  fragment?: string;
  sourceClass?: string;
  officiality?: "CONFIRMED" | "CLAIMED";
  directness?: "DIRECT" | "INDIRECT";
  onchainFactKind?: string | null;
  entityBinding?: "CONFIRMED" | "UNVERIFIED" | null;
};

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeAdmin(): Promise<string> {
  const [a] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
  return a.id;
}

async function makeProject(): Promise<{ id: string; slug: string }> {
  const slug = uniq("observed");
  const [p] = await ctx.db.insert(projects).values({ slug, name: "Observed candidates project", status: "ACTIVE_CORE" }).returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  return { id: p.id, slug };
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

async function newJob(projectId: string): Promise<string> {
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
  return job.id;
}

async function insertRow(jobId: string, sourceId: string, item: { step: number; component: string }, o: RowOverride = {}) {
  const fragment = o.fragment ?? FRAGMENT;
  await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId,
      patternStep: item.step,
      component: item.component,
      relationship: "SUPPORTS",
      directness: o.directness ?? "DIRECT",
      fragment,
      summary: "protocol fees accrue to the treasury",
      mechanismState: null,
      sourceClass: (o.sourceClass ?? "OFFICIAL_DOCS") as "OFFICIAL_DOCS",
      officiality: o.officiality ?? "CONFIRMED",
      entityBinding: o.entityBinding ?? null,
      onchainFactKind: (o.onchainFactKind ?? null) as never,
      fetchedAt: new Date(),
      publishedAt: new Date(),
      doesNotProve: "does not prove distribution to holders",
      retrievedUrl: DOC_URL,
      contentHash: `sha256:${uniq("content")}`,
      extractionUnitKey: extractionUnitKey(jobId, sourceId, item.step, item.component, fragment),
    })
    .onConflictDoNothing({ target: evidence.extractionUnitKey, where: sql`${evidence.extractionUnitKey} IS NOT NULL` });
}

// The fixture acquisition: one admitted OFFICIAL_DOCS / CONFIRMED / DIRECT
// row per worked component (canonical unit key, executor's conflict rule),
// plus whatever extra rows `extra` adds for a component.
function fixtureExecutor(
  sourceId: string,
  worked: string[],
  extra: (item: ComponentWorkItem) => RowOverride[] = () => [],
  main: (item: ComponentWorkItem) => RowOverride = () => ({}),
): WorkExecutor {
  return {
    async execute(item, c) {
      worked.push(`${item.step}:${item.component}`);
      await insertRow(c.jobId, sourceId, item, main(item));
      for (const o of extra(item)) await insertRow(c.jobId, sourceId, item, o);
      return { status: "SUCCEEDED", reason: "fixture component completed" };
    },
  };
}

async function proofOf(jobId: string) {
  const [p] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  return p;
}

async function memoryOf(projectId: string) {
  return ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectId)).orderBy(researchMemory.patternStep, researchMemory.component, researchMemory.createdAt);
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

async function countOf(table: typeof onchainArtifacts | typeof projectMemoryItems): Promise<number> {
  const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table);
  return r.n;
}

describe("VERIFIED Research -> OBSERVED Research Memory candidates", () => {
  it("full lifecycle: eligible supporting observations become OBSERVED on verification, idempotently, deduplicated, provenanced; then a later Research adopts the promoted form and builds its OWN Proof", async () => {
    await setMemoryEnabled(false);
    const src = await makeSource();
    const p = await makeProject();
    const admin = await makeAdmin();
    const onchainBefore = await countOf(onchainArtifacts);
    const projectItemsBefore = await countOf(projectMemoryItems);

    // ---- Research A: ordinary acquisition, with two ineligible extras on
    //      FLOW_PATH that S5 still lists as support (mixed eligible +
    //      ineligible, F): a CLAIMED-authority passage and a chain row.
    const workedA: string[] = [];
    const jobA = await newJob(p.id);
    await handleResearchJobTask(
      ctx.db,
      jobA,
      fixtureExecutor(src.id, workedA, (item) =>
        item.component === "FLOW_PATH"
          ? [
              { fragment: "a claimed passage about the waterfall from an unconfirmed page", officiality: "CLAIMED" },
              { fragment: "TOKEN_TRANSFER from the router to the treasury vault in slot 1", sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_TRANSFER", entityBinding: "CONFIRMED" },
            ]
          : [],
      ),
    );
    expect(workedA.length).toBe(10);
    const proofA = await proofOf(jobA);
    expect(proofA).toBeDefined();
    expect(proofA.verificationStatus).toBe("DRAFT");

    // 1. TRIGGER. A SUCCEEDED Research with a DRAFT Proof wrote nothing;
    //    REVIEWED writes nothing; the writer itself refuses a non-VERIFIED
    //    Proof.
    expect(await memoryOf(p.id)).toEqual([]);
    await markProofReviewed(ctx.db, proofA.id, admin);
    expect(await memoryOf(p.id)).toEqual([]);
    await expect(writeObservedCandidatesForVerifiedProof(ctx.db, proofA.id, new Date())).rejects.toThrow(/not VERIFIED/);
    expect(await memoryOf(p.id)).toEqual([]);

    // ---- Verify A (the canonical act) -> OBSERVED candidates.
    const verified = await markProofVerified(ctx.db, proofA.id, admin);
    expect(verified.verificationStatus).toBe("VERIFIED");
    const c = verified.memoryCandidates;
    expect(c.researchJobId).toBe(jobA);

    // 2. ELIGIBILITY — computed from the persisted S5 rows, not hard-coded:
    //    every supporting row of a memory-adoptable component with a
    //    CONFIRMED documentary DIRECT observation is a candidate; nothing
    //    else is.
    const s5Rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobA));
    const supportingByComponent = new Map<string, string[]>();
    for (const r of s5Rows) {
      if (r.status !== "SUPPORTED" && r.status !== "PARTIALLY_SUPPORTED") continue;
      supportingByComponent.set(r.component, r.supportingEvidenceIds as string[]);
    }
    const expectedComponents = [...supportingByComponent.keys()].filter((comp) => !isFreshOnlyComponent(PATTERN_V1_CONTENT, comp)).sort();
    expect(expectedComponents).toEqual(["DESTINATION", "FLOW_PATH", "MECHANISM_SPEC", "RECIPIENT", "SOURCE_OF_VALUE"]);
    // Fresh-only components are excluded BY RULE, not by absence: at least
    // CURRENT_STATE was established from the same documentary row.
    for (const comp of ["CURRENT_STATE", "EXECUTION_EVIDENCE", "NET_EFFECT"]) expect(isFreshOnlyComponent(PATTERN_V1_CONTENT, comp)).toBe(true);
    expect(supportingByComponent.has("CURRENT_STATE")).toBe(true);
    expect(c.refused.filter((r) => r.component === "CURRENT_STATE").map((r) => r.reason)).toEqual(["FRESH_ONLY_COMPONENT"]);
    // The two ineligible FLOW_PATH extras were used as support and refused
    // for their own closed reasons; the CONFIRMED passage became the one
    // FLOW_PATH candidate.
    expect(supportingByComponent.get("FLOW_PATH")!.length).toBe(3);
    expect(c.refused.filter((r) => r.component === "FLOW_PATH").map((r) => r.reason).sort()).toEqual(["OFFICIALITY_NOT_CONFIRMED", "ONCHAIN_FAMILY"]);
    expect(c.created.map((x) => x.component).sort()).toEqual(expectedComponents);
    expect(c.deduplicated).toEqual([]);

    const rows = await memoryOf(p.id);
    expect(rows.length).toBe(expectedComponents.length);
    for (const row of rows) {
      // OBSERVED, never promoted by the writer.
      expect(row.lifecycleState).toBe("OBSERVED");
      expect(row.promotedBy).toBeNull();
      expect(row.originKind).toBe(VERIFIED_OBSERVATION_ORIGIN_KIND);
      // Canonical observation identity — the job-independent core of the
      // unit key of the Evidence row it came from.
      const [origin] = await ctx.db.select().from(evidence).where(eq(evidence.id, c.created.find((x) => x.memoryId === row.id)!.evidenceId));
      expect(row.observationKey).toBe(observationKey(origin.sourceId, origin.patternStep!, origin.component!, origin.fragment));
      expect(origin.extractionUnitKey).toBe(extractionUnitKey(jobA, origin.sourceId, origin.patternStep!, origin.component!, origin.fragment));
      // Nothing conclusive: the statement is the observation's own
      // summary/passage, the confidence is the writer's constant, never
      // the Proof's verdict or confidence.
      expect(row.statement).toBe(origin.summary ?? origin.fragment);
      expect(row.statement).not.toContain(proofA.verdict);
      expect(row.confidence).toBe(VERIFIED_OBSERVATION_CONFIDENCE);
      expect(row.confidence).not.toBe(proofA.confidence);
      // Provenance reaches the original Evidence row and its source.
      const [prov] = await ctx.db.select().from(researchMemoryProvenance).where(eq(researchMemoryProvenance.memoryId, row.id));
      expect(prov).toBeDefined();
      expect(prov.originEvidenceId).toBe(origin.id);
      expect(prov.sourceId).toBe(origin.sourceId);
      expect(prov.retrievedUrl).toBe(origin.retrievedUrl);
      expect(prov.contentHash).toBe(origin.contentHash);
      expect(prov.fragment).toBe(origin.fragment);
      // Only ever from a CONFIRMED documentary DIRECT supporting row.
      expect(origin.officiality).toBe("CONFIRMED");
      expect(origin.sourceClass).toBe("OFFICIAL_DOCS");
      expect(origin.directness).toBe("DIRECT");
      expect(origin.onchainFactKind).toBeNull();
      expect(origin.reusedFromMemoryId).toBeNull();
    }
    // Production Memory stayed disabled throughout; the other families are untouched.
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);
    expect(await countOf(onchainArtifacts)).toBe(onchainBefore);
    expect(await countOf(projectMemoryItems)).toBe(projectItemsBefore);

    // 3. IDEMPOTENT (B). Verifying the same Proof again writes nothing.
    const again = await markProofVerified(ctx.db, proofA.id, admin);
    expect(again.memoryCandidates.created).toEqual([]);
    expect(again.memoryCandidates.deduplicated.map((x) => x.component).sort()).toEqual(expectedComponents);
    expect((await memoryOf(p.id)).length).toBe(expectedComponents.length);

    // 4. SAME OBSERVATION FROM ANOTHER VERIFIED RESEARCH (C): no duplicate.
    const jobA2 = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobA2, fixtureExecutor(src.id, []));
    const v2 = await markProofVerified(ctx.db, (await proofOf(jobA2)).id, admin);
    expect(v2.memoryCandidates.created).toEqual([]);
    expect(v2.memoryCandidates.deduplicated.map((x) => x.component).sort()).toEqual(expectedComponents);
    expect((await memoryOf(p.id)).length).toBe(expectedComponents.length);

    // 5. A GENUINELY DIFFERENT PASSAGE (D): one distinct new candidate.
    const jobA3 = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobA3, fixtureExecutor(src.id, [], () => [], (item) => (item.component === "FLOW_PATH" ? { fragment: OTHER_FRAGMENT } : {})));
    const v3 = await markProofVerified(ctx.db, (await proofOf(jobA3)).id, admin);
    expect(v3.memoryCandidates.created.map((x) => x.component)).toEqual(["FLOW_PATH"]);
    expect(v3.memoryCandidates.created[0].observationKey).toBe(observationKey(src.id, 2, "FLOW_PATH", OTHER_FRAGMENT));
    expect((await memoryOf(p.id)).length).toBe(expectedComponents.length + 1);
    // The DB itself refuses a second live row for the same observation.
    const flowRow = rows.find((r) => r.component === "FLOW_PATH")!;
    await expect(
      ctx.db.insert(researchMemory).values({
        projectId: p.id,
        topicId: flowRow.topicId,
        patternStep: 2,
        component: "FLOW_PATH",
        claimKey: "flow_path",
        statement: "dup",
        freshnessClass: "HIGH_CHANGE",
        verifiedAt: new Date(),
        confidence: 80,
        originKind: "TEST",
        observationKey: flowRow.observationKey,
      }),
    ).rejects.toThrow();

    // 6. CONTROLLED PROMOTION (test fixture, existing admin path) -> ACTIVE.
    //    Only the row we promote changes state; the writer promoted nothing.
    expect((await memoryOf(p.id)).every((r) => r.lifecycleState === "OBSERVED")).toBe(true);
    const promoted = await promoteToActive(ctx.db, flowRow.id, admin);
    expect(promoted.lifecycleState).toBe("ACTIVE");
    expect((await memoryOf(p.id)).filter((r) => r.lifecycleState === "ACTIVE").map((r) => r.id)).toEqual([flowRow.id]);

    // 7. RESEARCH B adopts it through the existing adoption path (memory
    //    enabled only for this controlled fixture): the planner closes
    //    FLOW_PATH, adoption materializes ordinary current-job Evidence
    //    under the SAME unit key a fresh extraction of that passage would
    //    compute, S5 establishes it, and B gets its OWN Proof.
    await setMemoryEnabled(true);
    const workedB: string[] = [];
    const jobB = await newJob(p.id);
    await handleResearchJobTask(ctx.db, jobB, fixtureExecutor(src.id, workedB));
    expect(workedB).not.toContain("2:FLOW_PATH");
    expect(workedB.length).toBe(9);
    const { view: plannedB } = await loadJobContractView(ctx.db, jobB);
    expect(plannedB.reused).toEqual([{ step: 2, component: "FLOW_PATH", memoryIds: [flowRow.id] }]);
    const adoptedRows = await evidenceOf(jobB, "FLOW_PATH");
    expect(adoptedRows.length).toBe(1);
    const adopted = adoptedRows[0];
    expect(adopted.reusedFromMemoryId).toBe(flowRow.id);
    expect(adopted.extractionUnitKey).toBe(extractionUnitKey(jobB, src.id, 2, "FLOW_PATH", FRAGMENT));
    expect(adopted.fragment).toBe(FRAGMENT);
    expect(adopted.sourceClass).toBe("OFFICIAL_DOCS");
    expect(adopted.officiality).toBe("CONFIRMED");
    const s5B = await s5Of(jobB, "FLOW_PATH");
    expect(s5B.status).toBe("SUPPORTED");
    expect(s5B.supportingEvidenceIds).toEqual([adopted.id]);
    const proofB = await proofOf(jobB);
    expect(proofB).toBeDefined();
    expect(proofB.id).not.toBe(proofA.id);
    expect(proofB.researchJobId).toBe(jobB);
    expect(proofB.verificationStatus).toBe("DRAFT");

    // 8. VERIFYING B (E): the adopted row is refused as REUSED_FROM_MEMORY —
    //    no recursive clone of the memory observation — and every other
    //    supporting row deduplicates against the candidates A wrote.
    const vB = await markProofVerified(ctx.db, proofB.id, admin);
    expect(vB.memoryCandidates.created).toEqual([]);
    expect(vB.memoryCandidates.refused.filter((r) => r.component === "FLOW_PATH")).toEqual([
      { evidenceId: adopted.id, step: 2, component: "FLOW_PATH", reason: "REUSED_FROM_MEMORY" },
    ]);
    expect(vB.memoryCandidates.deduplicated.map((x) => x.component).sort()).toEqual(expectedComponents.filter((x) => x !== "FLOW_PATH"));
    const finalRows = await memoryOf(p.id);
    expect(finalRows.length).toBe(expectedComponents.length + 1);
    expect(finalRows.filter((r) => r.component === "FLOW_PATH").length).toBe(2);
    expect(finalRows.filter((r) => r.lifecycleState === "ACTIVE").length).toBe(1);
    await setMemoryEnabled(false);
  });

  it("the writer copies no conclusion and stays inside its family", () => {
    const src = readFileSync("src/server/memory/observed-candidates.ts", "utf-8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const forbidden of ["proof.verdict", "proof.confidence", "verdict:", "onchainArtifacts", "projectMemoryItems", "promoteToActive", "promoteToCandidate", "lifecycleState: \"ACTIVE\"", "lifecycleState: \"CANDIDATE\""]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    for (const literal of ["lido", "pump_fun", "\"CURRENT_STATE\"", "\"NET_EFFECT\"", "\"EXECUTION_EVIDENCE\"", "\"SOURCE_OF_VALUE\""]) {
      expect(code, literal).not.toContain(literal);
    }
    expect(code).toContain("observationKey(");
    expect(code).toContain("copyProvenanceFromEvidence(");
    expect(readFileSync("src/server/memory/verification.ts", "utf-8")).toContain("writeObservedCandidatesForVerifiedProof(tx, proofId");
  });
});
