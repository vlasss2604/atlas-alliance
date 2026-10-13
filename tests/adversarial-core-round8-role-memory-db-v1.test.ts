import { eq } from "drizzle-orm";
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

// ROUND 8, THE PERSISTED HALF — A ROLE IS NOT INHERITABLE.
//
// The pure half proves that an established component whose economic ROLE
// is unresolved cannot satisfy a role-dependent requirement. This half
// asks the one question the pure chain cannot: can a role be inherited
// through RESEARCH MEMORY?
//
// The attack. Research A establishes a recipient that only NAMES holders
// and a destination that is only an ADDRESS. Its Proof is bounded, is
// VERIFIED by the canonical act, and its observations are promoted to
// ACTIVE memory. Research B then ADOPTS those rows instead of acquiring
// them. If anything downstream carried A's conclusion rather than A's
// OBSERVATION — a remembered verdict, a remembered attribute, a
// remembered "this component was good enough" — B would answer a question
// A never answered, from evidence that never said it.
//
// A's conclusions are deliberately corrupted before B runs (verdict
// rewritten to SUPPORTED, confidence to 99, the S5 status to SUPPORTED),
// so any leak is visible rather than merely absent.
//
// The control is the same loop over a recipient that DOES state the
// holding -> entitlement bridge: adoption must not lose a role either.
//
// Real Postgres, the real worker, the real S4 executor over fixture
// providers, the real verification and promotion acts. No model, no
// network, no RPC, no spend.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST = "docs.roleinheritance.example";
const DOCS_PREFIX = `https://${DOCS_HOST}/docs/`;
const PROJECT_NAME = "Role Inheritance Protocol";

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
const RESOLVED: Record<Component, string> = {
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
  const slug = uniq("role");
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

describe("ROUND 8 (persisted) — a role is not inheritable through Research Memory", () => {
  it("R8-DB-1. an unresolved role survives the whole Memory loop: A bounded -> VERIFIED -> ACTIVE -> B adopts the same observations and is bounded for the same reason, with A's corrupted conclusions nowhere in it", async () => {
    expect(DEFAULT_PRODUCT_CONFIG.memory_enabled).toBe(false);
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);
    const project = await makeProject();
    const admin = await makeAdmin();

    // ---------------------------------------------------------- RESEARCH A
    const a = await research(project, BARE, "PASSIVE_HOLDER_OUTCOME");
    expect(a.state).toBe("SUCCEEDED");
    // The recipient IS established and IS classified; the bridge is not.
    expect(a.recipientKinds).toEqual(["PASSIVE_HOLDER"]);
    expect(a.gaps).toContain("RECIPIENT_UNRESOLVED@RECIPIENT");
    expect(a.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(reqOf(a, "PHO-1").status).toBe("PARTIAL");
    expect(reqOf(a, "PHO-1").reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(reqOf(a, "PHO-1").blockingGaps.map((g) => g.kind)).toEqual(["RECIPIENT_UNRESOLVED"]);
    // Bounded, not uncited: the recipient rows are still the atom's basis.
    expect(reqOf(a, "PHO-1").evidenceIds.length).toBeGreaterThan(0);

    // A VERIFIED bounded Proof still produces observations — an observation
    // is what a passage SAID, never what the Proof concluded.
    const [proofA] = await ctx.db.select().from(proofs).where(eq(proofs.id, a.proofId));
    expect(proofA.verificationStatus).toBe("DRAFT");
    const verified = await markProofVerified(ctx.db, a.proofId, admin);
    expect(verified.verificationStatus).toBe("VERIFIED");
    const mem = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id));
    const recipientMem = mem.find((m) => m.component === "RECIPIENT");
    expect(recipientMem, "no RECIPIENT observation from a bounded Proof").toBeDefined();
    // The remembered thing is the sentence, not the verdict.
    expect(recipientMem!.statement).toContain(BARE.RECIPIENT);
    expect(JSON.stringify(recipientMem!)).not.toContain("PARTIALLY_SUPPORTED");
    for (const m of mem) await promoteToActive(ctx.db, m.id, admin);

    // A's CONCLUSIONS are corrupted after the fact. Anything downstream
    // that copied a verdict instead of reading evidence will now show it.
    await ctx.db.update(proofs).set({ verdict: "SUPPORTED", confidence: 99 }).where(eq(proofs.id, a.proofId));
    await ctx.db.update(researchComponentResults).set({ status: "SUPPORTED", reasonCodes: [] }).where(eq(researchComponentResults.researchJobId, a.jobId));

    // ---------------------------------------------------------- RESEARCH B
    await setMemoryEnabled(true);
    const b = await research(project, BARE, "PASSIVE_HOLDER_OUTCOME");
    await setMemoryEnabled(false);
    expect(b.state).toBe("SUCCEEDED");
    expect(b.proofId).not.toBe(a.proofId);

    // Memory was actually used — otherwise this test proves nothing.
    const adopted = b.adoptedEvidence.filter((r) => r.reusedFromMemoryId !== null);
    expect(adopted.length, "Research B adopted nothing; the attack surface was never reached").toBeGreaterThan(0);

    // And the role gate held on the adopted rows, for the same reason.
    expect(b.recipientKinds).toEqual(["PASSIVE_HOLDER"]);
    expect(b.gaps).toContain("RECIPIENT_UNRESOLVED@RECIPIENT");
    expect(b.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(reqOf(b, "PHO-1").status).toBe("PARTIAL");
    expect(reqOf(b, "PHO-1").reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(b.confidence).not.toBe(99);

    // B cites only its own rows.
    const aIds = new Set(a.evidenceIds);
    for (const id of reqOf(b, "PHO-1").evidenceIds) expect(aIds.has(id), "B rests on A's Evidence row").toBe(false);
  }, 180_000);

  it("R8-DB-2. the same loop over a destination that is only an ADDRESS: A and B both bound the revenue question on DESTINATION_UNRESOLVED, and the established destination rows stay cited on both sides", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();

    const a = await research(project, BARE, "PROTOCOL_REVENUE_TO_TOKEN");
    expect(a.state).toBe("SUCCEEDED");
    expect(a.destinationKinds).toEqual(["UNKNOWN"]);
    expect(a.gaps).toContain("DESTINATION_UNRESOLVED@DESTINATION");
    expect(reqOf(a, "PRT-2").status).toBe("PARTIAL");
    expect(reqOf(a, "PRT-2").reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(reqOf(a, "PRT-2").evidenceIds.length).toBeGreaterThan(0);
    expect(a.verdict).not.toBe("SUPPORTED");

    const verified = await markProofVerified(ctx.db, a.proofId, admin);
    expect(verified.verificationStatus).toBe("VERIFIED");
    for (const m of await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id))) {
      await promoteToActive(ctx.db, m.id, admin);
    }
    await ctx.db.update(proofs).set({ verdict: "SUPPORTED", confidence: 99 }).where(eq(proofs.id, a.proofId));

    await setMemoryEnabled(true);
    const b = await research(project, BARE, "PROTOCOL_REVENUE_TO_TOKEN");
    await setMemoryEnabled(false);
    expect(b.adoptedEvidence.filter((r) => r.reusedFromMemoryId !== null).length).toBeGreaterThan(0);
    expect(b.destinationKinds).toEqual(["UNKNOWN"]);
    expect(reqOf(b, "PRT-2").status).toBe("PARTIAL");
    expect(reqOf(b, "PRT-2").reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(reqOf(b, "PRT-2").evidenceIds.length).toBeGreaterThan(0);
    expect(b.verdict).not.toBe("SUPPORTED");
    expect(b.confidence).not.toBe(99);
  }, 180_000);

  it("R8-DB-3. adoption does not LOSE a role either: over the resolved world, A and B both establish the bridge and the recognised destination kind, and B's verdict is A's", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();

    const a = await research(project, RESOLVED, "PASSIVE_HOLDER_OUTCOME");
    expect(a.state).toBe("SUCCEEDED");
    expect(a.recipientKinds).toEqual(["PASSIVE_HOLDER"]);
    expect(a.gaps).not.toContain("RECIPIENT_UNRESOLVED@RECIPIENT");
    expect(a.verdict).toBe("SUPPORTED");
    expect(reqOf(a, "PHO-1").status).toBe("SATISFIED");

    await markProofVerified(ctx.db, a.proofId, admin);
    for (const m of await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id))) {
      await promoteToActive(ctx.db, m.id, admin);
    }

    await setMemoryEnabled(true);
    const b = await research(project, RESOLVED, "PASSIVE_HOLDER_OUTCOME");
    await setMemoryEnabled(false);
    expect(b.adoptedEvidence.filter((r) => r.reusedFromMemoryId !== null).length).toBeGreaterThan(0);
    expect(b.gaps).not.toContain("RECIPIENT_UNRESOLVED@RECIPIENT");
    expect(b.verdict).toBe("SUPPORTED");
    expect(reqOf(b, "PHO-1").status).toBe("SATISFIED");
    expect(b.confidence).toBe(a.confidence);
  }, 180_000);
});
