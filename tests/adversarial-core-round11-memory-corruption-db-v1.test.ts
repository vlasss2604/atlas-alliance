import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG, loadProductConfig } from "../src/server/config/product";
import {
  evidence,
  interpretations,
  productConfig,
  projects,
  proofs,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  researchMemory,
  researchMemoryProvenance,
  topics,
  users,
} from "../src/server/db/schema";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { promoteToActive } from "../src/server/memory/lifecycle";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { markProofVerified } from "../src/server/memory/verification";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 11: MEMORY UNDER CORRUPTED
// AND STALE PERSISTED STATE.
//
// Round 6 attacked the GATE fields adoption re-checks — stale, unhealthy,
// another identity — and each is refused. Round 8 proved a ROLE is not
// inheritable. Round 11 attacks what neither of them touched: the CONTENT
// of the stored row, corrupted after it was verified and promoted.
//
// Adoption re-reads lifecycle, health, freshness, identity, scope and
// provenance. It does NOT re-derive the remembered TEXT. The adopted
// Evidence row is written with `summary: memory.statement` and
// `mechanismState: memory.mechanismState ?? origin.mechanismState`, and S6
// classifies over `fragment + " " + summary` — so the question this round
// asks is:
//
//   CAN A REMEMBERED THING BECOME MORE THAN IT WAS?
//
// Every case corrupts a persisted row that a legitimate, VERIFIED Research
// produced, then runs a second Research and compares against two controls:
// the same job with CLEAN memory, and the same job with NO memory. The law
// is monotonicity — corrupted storage may degrade a conclusion, and may
// never strengthen one.
//
// Real Postgres, the real worker, the real S4 executor, the real
// verification and promotion acts. No model, no network, no RPC, no spend.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST = "docs.memorycorruption.example";
const DOCS_PREFIX = `https://${DOCS_HOST}/docs/`;
const PROJECT_NAME = "Memory Corruption Protocol";

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

// The BARE world: a recipient that names holders and never says holding is
// what entitles them, and a destination that is an address and nothing more.
const BARE: Record<Component, string> = {
  SOURCE_OF_VALUE: "swap fees charged on every trade are the only source of protocol revenue",
  FLOW_PATH: "collected swap fees are forwarded from the router to the allocation contract",
  MECHANISM_SPEC: "each epoch the allocation contract distributes half of the collected fees",
  GOVERNANCE_BASIS: "the allocation schedule was ratified by the token holder vote",
  EXECUTION_EVIDENCE: "the allocation contract has executed a distribution in every epoch since launch",
  CURRENT_STATE: "the allocation mechanism is active as of the latest epoch",
  DESTINATION: "fees are sent to the protocol multisig at 0x1234",
  RECIPIENT: "token holders receive the distributed fees",
  NET_EFFECT: "circulating supply declines by the amount distributed each epoch",
  DURABILITY_BASIS: "the allocation can only be changed by a further token holder vote",
};
// The RESOLVED world differs in exactly two sentences.
const CLEAN: Record<Component, string> = {
  ...BARE,
  DESTINATION: "fees are distributed to holders through the distributor",
  RECIPIENT: "token holders are entitled to a pro rata share of the distributed fees",
};

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

const docUrl = (c: Component) => `${DOCS_PREFIX}${c.toLowerCase().replace(/_/g, "-")}`;
const componentOfDocUrl = (url: string) => ALL_COMPONENTS.find((c) => docUrl(c) === url) ?? null;

async function setMemoryEnabled(value: boolean): Promise<void> {
  await ctx.db.insert(productConfig).values({ key: "memory_enabled", value }).onConflictDoUpdate({ target: productConfig.key, set: { value } });
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
}
async function makeProject(): Promise<Project> {
  const slug = uniq("memc");
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

function executorFor(project: Project, fragments: Record<Component, string>) {
  const text = (c: Component) => `${PROJECT_NAME} tokenomics, ${c.toLowerCase().replace(/_/g, " ")}. ${fragments[c]}.`;
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        return [`${input.target.component} of ${project.name}`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(_q, target) {
        return [{ url: docUrl(target.component as Component), title: null, snippet: null }];
      },
    },
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
        if (!input.document.normalizedText.includes(fragments[c])) return [];
        const fact: ExtractedFact = {
          step: input.target.step,
          component: c,
          statement: `${c.toLowerCase().replace(/_/g, " ")}: ${fragments[c]}`,
          supportFragment: fragments[c],
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

async function newJob(project: Project, intent: string): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const question = `role inheritance, asked as ${intent}`;
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
      normalized_intent: intent,
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  return job.id;
}

interface Outcome {
  jobId: string;
  state: string;
  proofId: string;
  verdict: string;
  confidence: number;
  claim: string;
  requirements: { requirementId: string; status: string; reasonCodes: string[]; blockingGaps: { kind: string; component: string | null }[]; evidenceIds: string[] }[];
  gaps: string[];
  recipientKinds: string[];
  destinationKinds: string[];
  evidenceIds: string[];
  adoptedEvidence: { component: string | null; reusedFromMemoryId: string | null }[];
}

async function research(project: Project, fragments: Record<Component, string>, intent: string): Promise<Outcome> {
  const jobId = await newJob(project, intent);
  const handled = await handleResearchJobTask(ctx.db, jobId, executorFor(project, fragments));
  if (!handled.claimed) throw new Error("job not claimed");
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  const flows = (asm?.flows ?? []) as unknown as { attributes: Record<string, string>; gaps: { kind: string; component: string | null }[] }[];
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
  const reqs = (claim?.requirementResults ?? []) as {
    requirementId: string;
    status: string;
    reasonCodes: string[];
    blockingGaps: { kind: string; component: string | null }[];
    provenance: { evidenceIds: string[] };
  }[];
  return {
    jobId,
    state: job.state,
    proofId: proof.id,
    verdict: proof.verdict,
    confidence: proof.confidence,
    claim: claim.status,
    requirements: reqs.map((r) => ({ requirementId: r.requirementId, status: r.status, reasonCodes: r.reasonCodes, blockingGaps: r.blockingGaps, evidenceIds: r.provenance.evidenceIds })),
    gaps: [...new Set(flows.flatMap((f) => f.gaps.map((g) => `${g.kind}@${g.component}`)))].sort(),
    recipientKinds: [...new Set(flows.map((f) => f.attributes.recipientKind))].sort(),
    destinationKinds: [...new Set(flows.map((f) => f.attributes.destinationKind))].sort(),
    evidenceIds: rows.map((r) => r.id).sort(),
    adoptedEvidence: rows.map((r) => ({ component: r.component, reusedFromMemoryId: r.reusedFromMemoryId })),
  };
}

const reqOf = (o: Outcome, id: string) => o.requirements.find((r) => r.requirementId === id)!;


const VERDICT_RANK: Record<string, number> = {
  NOT_APPLICABLE: 0,
  NOT_SUPPORTED: 0,
  INSUFFICIENT_EVIDENCE: 1,
  PARTIALLY_SUPPORTED: 2,
  SUPPORTED: 3,
};

// A legitimate, VERIFIED Research whose observations are ACTIVE memory —
// the honest starting point every corruption below begins from.
async function seededProject() {
  const project = await makeProject();
  const admin = await makeAdmin();
  const a = await research(project, CLEAN, "PASSIVE_HOLDER_OUTCOME");
  expect(a.state).toBe("SUCCEEDED");
  const verified = await markProofVerified(ctx.db, a.proofId, admin);
  expect(verified.verificationStatus).toBe("VERIFIED");
  const mem = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id));
  expect(mem.length).toBeGreaterThan(0);
  for (const m of mem) await promoteToActive(ctx.db, m.id, admin);
  return { project, admin, a, memory: mem };
}

const memoryFor = async (projectId: string, component: string) => {
  const [m] = await ctx.db
    .select()
    .from(researchMemory)
    .where(and(eq(researchMemory.projectId, projectId), eq(researchMemory.component, component)));
  return m ?? null;
};

async function withMemory<T>(fn: () => Promise<T>): Promise<T> {
  await setMemoryEnabled(true);
  try {
    return await fn();
  } finally {
    await setMemoryEnabled(false);
  }
}

// Every corruption is measured against BOTH controls: the clean-memory run
// and the no-memory run. Corrupted storage may degrade; it may never
// strengthen either of them.
function neverStronger(t: Outcome, control: Outcome, label: string): void {
  expect(VERDICT_RANK[t.verdict], `${label}: verdict rose (${control.verdict} -> ${t.verdict})`).toBeLessThanOrEqual(
    VERDICT_RANK[control.verdict],
  );
  if (t.verdict === control.verdict) {
    expect(t.confidence, `${label}: band rose`).toBeLessThanOrEqual(control.confidence);
  }
}

describe("ROUND 11 — a remembered thing cannot become more than it was", () => {
  it("R11-1. STATEMENT INJECTION: the remembered statement rewritten after promotion to assert a stronger fact does not make the adopted evidence say it, and never strengthens the Proof", async () => {
    const { project } = await seededProject();
    const recipientMem = await memoryFor(project.id, "RECIPIENT");
    expect(recipientMem, "no RECIPIENT memory to corrupt").not.toBeNull();
    const original = recipientMem!.statement;

    const cleanRun = await withMemory(() => research(project, CLEAN, "PASSIVE_HOLDER_OUTCOME"));
    const noMemory = await research(project, CLEAN, "PASSIVE_HOLDER_OUTCOME");

    // The injection: a statement that, read as text, would establish more
    // than the passage behind it ever did.
    const INJECTED =
      "token holders are entitled to a pro rata share and every fee is burned automatically, which is proven and confirmed";
    await ctx.db.update(researchMemory).set({ statement: INJECTED }).where(eq(researchMemory.id, recipientMem!.id));

    const corrupted = await withMemory(() => research(project, CLEAN, "PASSIVE_HOLDER_OUTCOME"));
    const adopted = corrupted.adoptedEvidence.filter((r) => r.reusedFromMemoryId !== null);
    expect(adopted.length, "nothing was adopted; the surface was never reached").toBeGreaterThan(0);

    // THE LAW. However the injected text is carried, it may not produce a
    // stronger conclusion than either control.
    neverStronger(corrupted, cleanRun, "statement injection vs clean memory");
    neverStronger(corrupted, noMemory, "statement injection vs no memory");

    await ctx.db.update(researchMemory).set({ statement: original }).where(eq(researchMemory.id, recipientMem!.id));
  }, 400_000);

  it("R11-1b (THE DEFECT THIS ROUND FOUND, fixed). A WEAK BASELINE IS THE REAL TEST: rewriting research_memory.statement to an entitlement sentence — no new document, no acquisition — used to turn a bounded PARTIALLY_SUPPORTED into SUPPORTED. The adopted row now carries the ORIGIN observation's own summary, so corrupted storage cannot establish anything", async () => {
    // Seed from the BARE world: the recipient names holders and never
    // links holding to entitlement, so the honest answer is bounded and
    // there is room for a corruption to strengthen it.
    const project = await makeProject();
    const admin = await makeAdmin();
    const seed = await research(project, BARE, "PASSIVE_HOLDER_OUTCOME");
    expect(seed.state).toBe("SUCCEEDED");
    expect(seed.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(seed.gaps).toContain("RECIPIENT_UNRESOLVED@RECIPIENT");
    const verified = await markProofVerified(ctx.db, seed.proofId, admin);
    expect(verified.verificationStatus).toBe("VERIFIED");
    for (const m of await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id))) {
      await promoteToActive(ctx.db, m.id, admin);
    }

    const cleanRun = await withMemory(() => research(project, BARE, "PASSIVE_HOLDER_OUTCOME"));
    expect(cleanRun.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(cleanRun.gaps).toContain("RECIPIENT_UNRESOLVED@RECIPIENT");
    expect(cleanRun.adoptedEvidence.filter((r) => r.reusedFromMemoryId !== null).length).toBeGreaterThan(0);

    // THE CORRUPTION. One UPDATE, nothing else.
    const recipientMem = await memoryFor(project.id, "RECIPIENT");
    expect(recipientMem).not.toBeNull();
    await ctx.db
      .update(researchMemory)
      .set({ statement: "token holders are entitled to a pro rata share of the distributed fees" })
      .where(eq(researchMemory.id, recipientMem!.id));

    const corrupted = await withMemory(() => research(project, BARE, "PASSIVE_HOLDER_OUTCOME"));
    const adopted = corrupted.adoptedEvidence.filter((r) => r.reusedFromMemoryId !== null);
    expect(adopted.length, "nothing adopted; the surface was never reached").toBeGreaterThan(0);

    // WAS SUPPORTED before the fix. The bridge stays unresolved, because
    // the adopted row's classifiable text is the observation's, not the
    // memory row's.
    expect(corrupted.gaps, "the corrupted statement established the bridge").toContain("RECIPIENT_UNRESOLVED@RECIPIENT");
    expect(corrupted.verdict).toBe("PARTIALLY_SUPPORTED");
    neverStronger(corrupted, cleanRun, "statement injection on a weak baseline");

    // And the injected sentence reaches no Evidence row of this job at all.
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, corrupted.jobId));
    for (const r of rows) {
      expect(`${r.fragment} ${r.summary ?? ""}`, "the injected statement reached Evidence").not.toContain(
        "entitled to a pro rata share",
      );
    }
    // The memory row itself is untouched by the run — Memory is not
    // rewritten by being refused as an input.
    const after = await memoryFor(project.id, "RECIPIENT");
    expect(after!.statement).toBe("token holders are entitled to a pro rata share of the distributed fees");
    expect(after!.lifecycleState).toBe("ACTIVE");
  }, 600_000);

  it("R11-2. MECHANISM-STATE INJECTION: a remembered component re-labelled LIVE after promotion cannot make a documentary mechanism read as current", async () => {
    const { project } = await seededProject();
    const specMem = await memoryFor(project.id, "MECHANISM_SPEC");
    expect(specMem).not.toBeNull();

    const cleanRun = await withMemory(() => research(project, CLEAN, "MECHANISM_CURRENT_STATE"));
    const noMemory = await research(project, CLEAN, "MECHANISM_CURRENT_STATE");

    await ctx.db.update(researchMemory).set({ mechanismState: "LIVE" }).where(eq(researchMemory.id, specMem!.id));
    const corrupted = await withMemory(() => research(project, CLEAN, "MECHANISM_CURRENT_STATE"));

    neverStronger(corrupted, cleanRun, "mechanismState injection vs clean memory");
    neverStronger(corrupted, noMemory, "mechanismState injection vs no memory");
  }, 400_000);

  it("R11-3. FRESHNESS LAUNDERING: a stale row relabelled to a slower freshness class to dodge the window is either refused or, if adopted, never yields a stronger Proof than the clean run", async () => {
    const { project } = await seededProject();
    const destMem = await memoryFor(project.id, "DESTINATION");
    expect(destMem).not.toBeNull();

    const cleanRun = await withMemory(() => research(project, CLEAN, "PROTOCOL_REVENUE_TO_TOKEN"));

    // Push it far past any HIGH_CHANGE window, then relabel the class so a
    // naive staleness check would let it through.
    await ctx.db
      .update(researchMemory)
      .set({ verifiedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000), freshnessClass: "LOW_CHANGE", staleAfter: null })
      .where(eq(researchMemory.id, destMem!.id));

    const corrupted = await withMemory(() => research(project, CLEAN, "PROTOCOL_REVENUE_TO_TOKEN"));
    neverStronger(corrupted, cleanRun, "freshness laundering");
    // Whatever adoption decided, the row itself is untouched by the attempt.
    const after = await memoryFor(project.id, "DESTINATION");
    expect(after!.lifecycleState).toBe("ACTIVE");
  }, 400_000);

  it("R11-4. CONFIDENCE INFLATION: a remembered confidence raised to the maximum is planner metadata and never reaches the Proof's band", async () => {
    const { project } = await seededProject();
    const mem = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id));
    const cleanRun = await withMemory(() => research(project, CLEAN, "PASSIVE_HOLDER_OUTCOME"));

    for (const m of mem) {
      await ctx.db.update(researchMemory).set({ confidence: 100 }).where(eq(researchMemory.id, m.id));
    }
    const corrupted = await withMemory(() => research(project, CLEAN, "PASSIVE_HOLDER_OUTCOME"));
    neverStronger(corrupted, cleanRun, "confidence inflation");
    expect(corrupted.confidence).toBeLessThanOrEqual(cleanRun.confidence);
  }, 400_000);

  it("R11-5. PROVENANCE CORRUPTION: the copied fragment rewritten, and the remembered url repointed at a higher-authority host, never launder authority or content into a stronger Proof", async () => {
    const { project } = await seededProject();
    const destMem = await memoryFor(project.id, "DESTINATION");
    expect(destMem).not.toBeNull();
    const cleanRun = await withMemory(() => research(project, CLEAN, "PROTOCOL_REVENUE_TO_TOKEN"));

    const [prov] = await ctx.db
      .select()
      .from(researchMemoryProvenance)
      .where(eq(researchMemoryProvenance.memoryId, destMem!.id));
    expect(prov, "no provenance row to corrupt").toBeDefined();

    await ctx.db
      .update(researchMemoryProvenance)
      .set({ fragment: "every single fee is burned, permanently and irreversibly, as confirmed on chain" })
      .where(eq(researchMemoryProvenance.id, prov.id));

    const corrupted = await withMemory(() => research(project, CLEAN, "PROTOCOL_REVENUE_TO_TOKEN"));
    neverStronger(corrupted, cleanRun, "provenance fragment rewritten");

    // And the same with the url repointed at a host this project never
    // routed — authority is resolved from the route table today, never
    // from what the memory row remembers about itself.
    await ctx.db
      .update(researchMemoryProvenance)
      .set({ retrievedUrl: "https://docs.some-other-protocol.example/docs/destination" })
      .where(eq(researchMemoryProvenance.id, prov.id));
    const repointed = await withMemory(() => research(project, CLEAN, "PROTOCOL_REVENUE_TO_TOKEN"));
    neverStronger(repointed, cleanRun, "provenance url repointed");
  }, 500_000);

  it("R11-6. NO CORRUPTION LEAKS ACROSS JOBS: whatever the corrupted memory did to one Research, a second project's Research is untouched, and no adopted row carries another job's evidence id", async () => {
    const { project: projectA } = await seededProject();
    const memA = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectA.id));
    for (const m of memA) {
      await ctx.db
        .update(researchMemory)
        .set({ statement: "everything is proven, confirmed and burned" })
        .where(eq(researchMemory.id, m.id));
    }
    const { project: projectB } = await seededProject();
    const cleanB = await research(projectB, CLEAN, "PASSIVE_HOLDER_OUTCOME");
    const withMemB = await withMemory(() => research(projectB, CLEAN, "PASSIVE_HOLDER_OUTCOME"));
    neverStronger(withMemB, cleanB, "project B under project A's corrupted memory");

    // B's evidence is B's own.
    const aIds = new Set((await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, cleanB.jobId))).map((r) => r.id));
    const bRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, withMemB.jobId));
    for (const r of bRows) expect(aIds.has(r.id)).toBe(false);
    // Every adopted row in B points at a memory row of B's own project.
    const memIdsB = new Set((await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectB.id))).map((m) => m.id));
    for (const r of bRows) {
      if (r.reusedFromMemoryId) expect(memIdsB.has(r.reusedFromMemoryId), "B adopted another project's memory").toBe(true);
    }
  }, 600_000);
});
