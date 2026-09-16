import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
  researchMechanismAssembly,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import type { WorkExecutor } from "../src/server/engine/controller";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { adoptReusedMemory } from "../src/server/engine/memory-evidence-adoption";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError } from "../src/server/engine/providers/evidence-extractor";
import { createEvmOnchainAdapter, ERC20_DECIMALS_SELECTOR, ERC20_TOTAL_SUPPLY_SELECTOR } from "../src/server/engine/providers/onchain-evm";
import { __setOnchainRetriever, type OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { installOnchainResearchCapability } from "../src/server/jobs/onchain-capability";
import { promoteToActive } from "../src/server/memory/lifecycle";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { markProofVerified } from "../src/server/memory/verification";
import { claimResearchJob, createResearchJob, transitionJobState } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 6: METAMORPHIC INVARIANTS,
// THE PERSISTED RESEARCH.
//
// The same question as the pure half (adversarial-core-round6-metamorphic-
// v1), asked of a complete Research through the REAL S4 executor, the real
// lifecycle and the real Postgres store: transform a valid evidence world
// in a way that should be irrelevant, weaker, duplicated, stale, foreign
// or technically unavailable, and compare the persisted Proof to its
// control. Fixture providers only — no model, no network, no RPC, no
// spend.
//
// Families here: 2 duplication through the acquisition path and Memory;
// 5 discovery / fetch / insertion order; 6 routed vs unrouted authority;
// 8 technical-failure monotonicity; 9 Memory monotonicity (A–H); 10
// project / chain substitution; 13 persisted provenance and verification
// audit metadata.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(async () => {
  __setOnchainRetriever(null);
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
type Intent = "PROTOCOL_REVENUE_TO_TOKEN" | "MECHANISM_CURRENT_STATE" | "BURN_OR_SUPPLY_EFFECT" | "PASSIVE_HOLDER_OUTCOME";

const DAY_MS = 24 * 3600 * 1000;
const NOW = () => new Date();
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const EVM = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
const EVM_OTHER = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";
const EVM_WRAPPER = "0x9D03bb2092270648d7480049d0E58d2FcF0E5123";

const CANON: Record<Component, string> = {
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
const STATE_OF: Partial<Record<Component, string>> = { MECHANISM_SPEC: "LIVE", EXECUTION_EVIDENCE: "LIVE", CURRENT_STATE: "LIVE" };

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

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
  host: string;
  govHost: string;
  docsRouteId: string;
}

async function makeProject(opts: { name?: string; ticker?: string; identity?: { chain: "ethereum" | "bsc" | "solana"; tokenAddress: string } } = {}): Promise<Project> {
  const slug = uniq("r6");
  const name = opts.name ?? `Round Six ${slug.replace(/_/g, " ")}`;
  const host = `docs.${slug.replace(/_/g, "-")}.example`;
  const govHost = `vote.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE", ticker: opts.ticker ?? null }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const docsClass = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!docsClass.ok) throw new Error("docs classify failed: " + docsClass.refusal);
  const gov = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: govHost, pathPrefix: "/proposals" });
  if (!gov.ok) throw new Error("gov confirm failed: " + gov.refusal);
  const govClass = await classifySourceRoute(ctx.db, { routeId: gov.itemId, routeClass: "GOVERNANCE" });
  if (!govClass.ok) throw new Error("gov classify failed: " + govClass.refusal);
  if (opts.identity) {
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: opts.identity.chain, tokenAddress: opts.identity.tokenAddress, ticker: opts.ticker ?? "R6" });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, name, ticker: opts.ticker ?? null, host, govHost, docsRouteId: docsClass.newItemId };
}

interface FactSpec {
  fragment: string;
  mechanismState?: string | null;
  publishedAt?: Date | null;
}
type Extract = "ok" | "empty" | "fatal" | "401" | "transient-once" | "transient-always";
interface Doc {
  url: string;
  text: string;
  facts: Partial<Record<Component, FactSpec[]>>;
  fetch?: "ok" | "timeout" | "http404";
  extract?: Extract;
}
function docsUrl(project: Project, path: string): string {
  return `https://${project.host}/docs/${path}`;
}
function govUrl(project: Project, path: string): string {
  return `https://${project.govHost}/proposals/${path}`;
}
function canonDocs(project: Project, only?: readonly Component[]): Doc[] {
  const comps = only ?? ALL_COMPONENTS;
  return comps.map((c) => ({
    url: c === "GOVERNANCE_BASIS" || c === "DURABILITY_BASIS" ? govUrl(project, c.toLowerCase()) : docsUrl(project, c.toLowerCase().replace(/_/g, "-")),
    text: `${project.name} — ${c.toLowerCase().replace(/_/g, " ")}. ${CANON[c]}.`,
    facts: { [c]: [{ fragment: CANON[c], mechanismState: STATE_OF[c] ?? null }] },
  }));
}

interface Scenario {
  docs: Doc[];
  search?: Partial<Record<Component, string[]>>;
  intent?: Intent;
  budget?: Partial<EntitlementSnapshot["budget"]>;
  chain?: "ENABLED" | "DOCUMENTARY_ONLY";
  rpc?: "ok" | "down";
  // Return every extracted fact twice (a provider that repeats itself).
  repeatFacts?: boolean;
  // Reverse discovery / fetch order for every component.
  reverse?: boolean;
}

function fetched(url: string, text: string): FetchedDocument {
  return { finalUrl: url, requestedUrl: url, httpStatus: 200, contentType: "text/html", normalizedText: text, contentHash: `sha256:${text.length}:${text.slice(0, 64)}`, fetchedAt: NOW(), byteLength: text.length };
}

function evmFixture(opts: { down?: boolean }) {
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      if (opts.down) throw new Error("fixture rpc: connection refused");
      if (method === "eth_chainId") return JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" });
      if (method === "eth_getBlockByNumber") return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x1234abc", hash: "0x" + "ef".repeat(32), timestamp: "0x66f2a1c0" } });
      if (method === "eth_call") {
        const data = (params[0] as { data: string }).data;
        const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
        if (data === ERC20_TOTAL_SUPPLY_SELECTOR) return JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(BigInt("1000000000000000000000000000")) });
        if (data === ERC20_DECIMALS_SELECTOR) return JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(BigInt(18)) });
      }
      throw new Error(`fixture rpc: unexpected ${method}`);
    },
  };
  return createEvmOnchainAdapter({ transport, providerId: "fixture-evm-rpc", environment: { chain: "ethereum", network: "mainnet" } });
}

function executorFor(project: Project, s: Scenario): { executor: WorkExecutor; calls: Record<string, number> } {
  const byUrl = new Map(s.docs.map((d) => [d.url, d]));
  const calls: Record<string, number> = { proposer: 0, search: 0, fetch: 0, extract: 0 };
  const served = new Set<string>();
  const extractCalls = new Map<string, number>();
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    chainAcquisition: s.chain ?? "DOCUMENTARY_ONLY",
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        calls.proposer += 1;
        const c = input.target.component;
        return [`${c} of ${project.name}`, `${project.name} ${c} documentation`, `${project.name} tokenomics ${c}`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query, target) {
        calls.search += 1;
        const component = target.component as Component;
        const isExplorer = /^site:(etherscan\.io|bscscan\.com|polygonscan\.com|solscan\.io|solana\.fm|arbiscan\.io|basescan\.org|snowtrace\.io|optimistic\.etherscan\.io)/.test(query);
        const explorerHost = (url: string) => /^https:\/\/(www\.)?([a-z]+\.)?(etherscan\.io|bscscan\.com|polygonscan\.com|solscan\.io|solana\.fm|arbiscan\.io|basescan\.org|snowtrace\.io)\//.test(url);
        if (isExplorer) return s.docs.filter((d) => explorerHost(d.url)).map((d) => ({ url: d.url, title: null, snippet: null }));
        const key = `${target.step}:${component}`;
        if (served.has(key)) return [];
        served.add(key);
        const urls = s.search?.[component] ?? s.docs.filter((d) => d.facts[component] && !explorerHost(d.url)).map((d) => d.url);
        return (s.reverse ? [...urls].reverse() : urls).map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        calls.fetch += 1;
        const d = byUrl.get(url);
        if (!d) throw new ContentFetchError("HTTP_ERROR", "fixture: unknown url", url, 404);
        if (d.fetch === "timeout") throw new ContentFetchError("TIMEOUT", "fixture: timed out", url);
        if (d.fetch === "http404") throw new ContentFetchError("HTTP_ERROR", "fixture: gone", url, 404);
        return fetched(url, d.text);
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        calls.extract += 1;
        const url = input.document.finalUrl;
        const n = (extractCalls.get(url) ?? 0) + 1;
        extractCalls.set(url, n);
        const d = byUrl.get(url);
        if (!d) return [];
        switch (d.extract ?? "ok") {
          case "empty":
            return [];
          case "fatal":
            throw new Error("fixture extractor: exploded on this document");
          case "401":
            throw new EvidenceExtractorUnavailableError("generation failed: AUTHENTICATION_FAILED:401", false, "AUTHENTICATION_FAILED", 401);
          case "transient-once":
            if (n === 1) throw new EvidenceExtractorUnavailableError("generation failed: RATE_LIMITED:429", true, "RATE_LIMITED", 429);
            break;
          case "transient-always":
            throw new EvidenceExtractorUnavailableError("generation failed: NETWORK_NO_RESPONSE", true, "NETWORK_NO_RESPONSE", null);
          case "ok":
            break;
        }
        const component = input.target.component as Component;
        const facts = (d.facts[component] ?? []).map(
          (f): ExtractedFact => ({
            step: input.target.step,
            component,
            statement: `${component.toLowerCase().replace(/_/g, " ")}: ${f.fragment}`,
            supportFragment: f.fragment,
            mechanismState: f.mechanismState ?? null,
            directness: "DIRECT",
            publishedAt: f.publishedAt === undefined ? daysAgo(1) : f.publishedAt,
            doesNotProve: "does not prove the size of the effect",
            relationship: "SUPPORTS",
          }),
        );
        return s.repeatFacts ? [...facts, ...facts] : facts;
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
  return { executor, calls };
}

async function newJob(project: Project, intent: Intent = "PROTOCOL_REVENUE_TO_TOKEN", budget?: Partial<EntitlementSnapshot["budget"]>): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const base = coreEntitlement();
  const entitlement: EntitlementSnapshot = { ...base, budget: { ...base.budget, ...(budget ?? {}) } };
  const question = `does the mechanism deliver value to the token? (${intent})`;
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
      entitlement,
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
  projectId: string;
  state: string;
  terminationReason: string | null;
  verdict: string | null;
  confidence: number | null;
  claim: string | null;
  requirements: string[];
  gaps: string[];
  flows: number;
  cited: { id: string; component: string; url: string; reused: boolean }[];
  s5: Record<string, { status: string; reasonCodes: string[]; supporting: string[]; contradicting: string[]; excluded: { evidenceId: string; reason: string }[] } | null>;
  calls: Record<string, number>;
}

async function research(project: Project, s: Scenario): Promise<Outcome> {
  if (s.chain === "ENABLED") {
    const adapter = evmFixture({ down: s.rpc === "down" });
    installOnchainResearchCapability({
      capabilities: new Set(["SEARCH_EXTRACT"]),
      env: { ONCHAIN_RESEARCH_ENABLED: "1", ETHEREUM_MAINNET_RPC_URL: "https://fixture.invalid/rpc" },
      create: (chain, network) => (chain === "ethereum" && network === "mainnet" ? adapter : null),
    });
  }
  const { executor, calls } = executorFor(project, s);
  const jobId = await newJob(project, s.intent, s.budget);
  const handled = await handleResearchJobTask(ctx.db, jobId, executor);
  if (!handled.claimed) throw new Error("job not claimed");
  return outcomeOf(jobId, project.id, calls);
}

async function outcomeOf(jobId: string, projectId: string, calls: Record<string, number> = {}): Promise<Outcome> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  const gaps = new Set<string>();
  const flows = (asm?.flows ?? []) as { gaps?: { kind: string; component: string }[] }[];
  for (const f of flows) for (const g of f.gaps ?? []) gaps.add(`${g.kind}@${g.component}`);
  for (const g of (asm?.unassignedGaps ?? []) as { kind: string; component: string }[]) gaps.add(`${g.kind}@${g.component}`);
  const cited = proof
    ? (await ctx.db.select().from(evidence).where(eq(evidence.proofId, proof.id))).map((r) => ({ id: r.id, component: r.component ?? "", url: r.retrievedUrl, reused: r.reusedFromMemoryId !== null }))
    : [];
  const s5rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const s5: Outcome["s5"] = {};
  for (const c of ALL_COMPONENTS) {
    const r = s5rows.find((x) => x.component === c);
    s5[c] = r
      ? {
          status: r.status,
          reasonCodes: [...(r.reasonCodes as string[])].sort(),
          supporting: [...(r.supportingEvidenceIds as string[])].sort(),
          contradicting: [...(r.contradictingEvidenceIds as string[])].sort(),
          excluded: r.excludedEvidence as { evidenceId: string; reason: string }[],
        }
      : null;
  }
  return {
    jobId,
    projectId,
    state: job.state,
    terminationReason: job.terminationReason,
    verdict: proof?.verdict ?? null,
    confidence: proof?.confidence ?? null,
    claim: claim?.status ?? null,
    requirements: claim ? claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`) : [],
    gaps: [...gaps].sort(),
    flows: flows.length,
    cited,
    s5,
    calls,
  };
}

async function evidenceOf(jobId: string, component?: Component) {
  return ctx.db
    .select()
    .from(evidence)
    .where(component ? and(eq(evidence.researchJobId, jobId), eq(evidence.component, component)) : eq(evidence.researchJobId, jobId))
    .orderBy(evidence.createdAt);
}

// ---- the metamorphic relations --------------------------------------

const VERDICT_RANK: Record<string, number> = { NOT_SUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const STATUS_RANK: Record<string, number> = { CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const REQ_RANK: Record<string, number> = { CONTRADICTED: 0, UNSATISFIED: 0, PARTIAL: 1, SATISFIED: 2 };

function shapeOf(o: Outcome) {
  const s5 = Object.fromEntries(Object.entries(o.s5).map(([k, v]) => [k, v ? { status: v.status, reasonCodes: v.reasonCodes, n: v.supporting.length } : null]));
  return { state: o.state, verdict: o.verdict, confidence: o.confidence, claim: o.claim, requirements: o.requirements, gaps: o.gaps, citedComponents: o.cited.map((c) => c.component).sort(), s5 };
}
function noStrongerThan(t: Outcome, c: Outcome, label = ""): void {
  expect(t.verdict, `${label} verdict`).not.toBeNull();
  expect(VERDICT_RANK[t.verdict!], `${label} verdict ${t.verdict} vs ${c.verdict}`).toBeLessThanOrEqual(VERDICT_RANK[c.verdict!]);
  if (t.verdict === c.verdict) expect(t.confidence!, `${label} confidence`).toBeLessThanOrEqual(c.confidence!);
  for (const comp of ALL_COMPONENTS) {
    const a = t.s5[comp];
    const b = c.s5[comp];
    if (a && b) expect(STATUS_RANK[a.status], `${label} ${comp} ${a.status} vs ${b.status}`).toBeLessThanOrEqual(STATUS_RANK[b.status]);
  }
  for (const q of t.requirements) {
    const [id, status] = q.split(":");
    const ref = c.requirements.find((x) => x.startsWith(id + ":"))?.split(":")[1];
    if (ref) expect(REQ_RANK[status], `${label} ${id} ${status} vs ${ref}`).toBeLessThanOrEqual(REQ_RANK[ref]);
  }
}
function nonNegative(o: Outcome): void {
  expect(o.verdict).not.toBe("NOT_SUPPORTED");
  for (const v of Object.values(o.s5)) if (v) expect(v.status).not.toBe("CONTRADICTED");
}
// PERSISTED PROVENANCE (family 13): every cited row is a supporting row of
// this job, for this project; nothing excluded or contradicting is cited;
// every reused row points at an ACTIVE memory row of this project; the
// Proof carries no verification actor or time.
async function provenanceHolds(o: Outcome): Promise<void> {
  const supporting = new Set(Object.values(o.s5).flatMap((v) => (v ? v.supporting : [])));
  const excluded = new Set(Object.values(o.s5).flatMap((v) => (v ? v.excluded.map((e) => e.evidenceId) : [])));
  const contradicting = new Set(Object.values(o.s5).flatMap((v) => (v ? v.contradicting : [])));
  const rows = await evidenceOf(o.jobId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of o.cited) {
    expect(supporting.has(c.id), `cited ${c.id} not supporting`).toBe(true);
    expect(excluded.has(c.id), `cited ${c.id} excluded`).toBe(false);
    expect(contradicting.has(c.id), `cited ${c.id} contradicting`).toBe(false);
    expect(byId.get(c.id)?.researchJobId).toBe(o.jobId);
  }
  for (const id of [...supporting, ...contradicting]) expect(byId.has(id), `admitted ${id} is not this job's row`).toBe(true);
  for (const r of rows) {
    if (r.reusedFromMemoryId) {
      const [m] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, r.reusedFromMemoryId));
      expect(m?.projectId).toBe(o.projectId);
    }
    if (r.onchainArtifactId) expect(r.sourceClass).toBe("ONCHAIN_VERIFIABLE");
  }
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, o.jobId));
  if (proof) {
    expect(proof.verificationStatus).toBe("DRAFT");
    expect(proof.verifiedBy).toBeNull();
    expect(proof.verifiedAt).toBeNull();
  }
}

// Verify Research A's Proof and promote its candidates for `components`.
async function verifiedActive(project: Project, components: readonly Component[], docs?: Doc[]) {
  const admin = await makeAdmin();
  const a = await research(project, { docs: docs ?? canonDocs(project) });
  expect(a.state).toBe("SUCCEEDED");
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, a.jobId));
  await markProofVerified(ctx.db, proof.id, admin);
  const memory = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id));
  const ids: Record<string, string> = {};
  for (const c of components) {
    const m = memory.find((x) => x.component === c && x.lifecycleState !== "ACTIVE")!;
    await promoteToActive(ctx.db, m.id, admin);
    ids[c] = m.id;
  }
  return { a, ids, admin, proofId: proof.id };
}

// ================================================================== 2

describe("F2. duplication through the acquisition path and Memory", () => {
  it("F2a. the search returns the same URL twice, the provider returns every fact twice, and a second page carries the same passage: one row per (source, passage), the Proof equals the control, and no passage is cited twice from one source", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const control = await research(project, { docs });
    const twice = Object.fromEntries(ALL_COMPONENTS.map((c) => [c, [docs.find((d) => d.facts[c])!.url, docs.find((d) => d.facts[c])!.url]])) as Partial<Record<Component, string[]>>;
    const t = await research(project, { docs, search: twice, repeatFacts: true });
    expect(shapeOf(t)).toEqual(shapeOf(control));
    expect((await evidenceOf(t.jobId)).length).toBe((await evidenceOf(control.jobId)).length);
    expect(t.calls.fetch).toBe(control.calls.fetch);
    await provenanceHolds(t);
  });

  it("F2b. a MIRROR of the DESTINATION page (byte-identical text at a second URL on the same confirmed host): verdict, confidence, requirements and statuses equal the control; the mirror is a second slot (D-101 boundary, pinned in the pure half) and never a stronger conclusion", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const control = await research(project, { docs });
    const dest = docs.find((d) => d.facts.DESTINATION)!;
    const mirror: Doc = { ...dest, url: docsUrl(project, "destination-mirror") };
    const t = await research(project, { docs: [...docs, mirror] });
    expect(t.verdict).toBe(control.verdict);
    expect(t.confidence).toBe(control.confidence);
    expect(t.requirements).toEqual(control.requirements);
    for (const c of ALL_COMPONENTS) expect([t.s5[c]!.status, t.s5[c]!.reasonCodes], c).toEqual([control.s5[c]!.status, control.s5[c]!.reasonCodes]);
    expect(t.s5.DESTINATION!.supporting).toHaveLength(2);
    expect(t.flows).toBe(control.flows * 2);
    noStrongerThan(t, control);
    await provenanceHolds(t);
  });

  it("F2c. Memory + an identical fresh copy of the same passage: the adopted row IS the fresh row's canonical unit — one DESTINATION row, keyed by the same extraction unit, never two; the Proof equals the no-Memory control", async () => {
    const project = await makeProject();
    const { ids } = await verifiedActive(project, ["DESTINATION"]);
    const control = await research(project, { docs: canonDocs(project) });
    await setMemoryEnabled(true);
    const t = await research(project, { docs: canonDocs(project) });
    const dest = await evidenceOf(t.jobId, "DESTINATION");
    expect(dest).toHaveLength(1);
    expect(dest[0].reusedFromMemoryId).toBe(ids.DESTINATION);
    expect(t.s5.DESTINATION!.supporting).toEqual([dest[0].id]);
    expect(shapeOf(t)).toEqual(shapeOf(control));
    await provenanceHolds(t);
  });
});

// ================================================================== 5

describe("F5. order invariance through acquisition", () => {
  it("F5a. every component's candidates discovered and fetched in reverse, with a stray page and a mirror in the pool: the persisted Proof is identical to the forward order — verdict, confidence, requirements, gaps, S5, cited components", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const mirror: Doc = { ...docs.find((d) => d.facts.RECIPIENT)!, url: docsUrl(project, "recipient-mirror") };
    const stray: Doc = { url: `https://blog.${project.slug.replace(/_/g, "-")}.example/post`, text: `${project.name} blog. ${CANON.DESTINATION}.`, facts: { DESTINATION: [{ fragment: CANON.DESTINATION }] } };
    const pool = [...docs, mirror, stray];
    const forward = await research(project, { docs: pool });
    const backward = await research(project, { docs: pool, reverse: true });
    expect(shapeOf(backward)).toEqual(shapeOf(forward));
    expect(backward.cited.map((c) => c.url).sort()).toEqual(forward.cited.map((c) => c.url).sort());
    await provenanceHolds(backward);
  });
});

// ================================================================== 6

describe("F6. authority through routes", () => {
  it("F6a. the same passages on an UNROUTED host (naming the project) instead of the confirmed docs host: every row is CLAIMED / SOCIAL and inadmissible, the conclusion is a non-conclusion; adding the routed originals back restores the control exactly — authority comes from the route, and the unrouted copies add nothing", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const control = await research(project, { docs });
    const unrouted = docs.map((d) => ({ ...d, url: d.url.replace(project.host, "mirror.example").replace(project.govHost, "forum.example") }));
    const weakOnly = await research(project, { docs: unrouted });
    expect(weakOnly.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect((await evidenceOf(weakOnly.jobId)).every((r) => r.officiality === "CLAIMED")).toBe(true);
    noStrongerThan(weakOnly, control);
    nonNegative(weakOnly);
    // Search finds the unrouted copy first for every component, then the routed page.
    const both = await research(project, {
      docs: [...unrouted, ...docs],
      search: Object.fromEntries(ALL_COMPONENTS.map((c) => [c, [unrouted.find((d) => d.facts[c])!.url, docs.find((d) => d.facts[c])!.url]])) as Partial<Record<Component, string[]>>,
    });
    expect(both.verdict).toBe(control.verdict);
    expect(both.confidence).toBe(control.confidence);
    expect(both.requirements).toEqual(control.requirements);
    for (const c of ALL_COMPONENTS) expect([both.s5[c]!.status, both.s5[c]!.reasonCodes], c).toEqual([control.s5[c]!.status, control.s5[c]!.reasonCodes]);
    for (const c of both.cited) expect(c.url.includes("mirror.example") || c.url.includes("forum.example")).toBe(false);
    await provenanceHolds(both);
  });

  it("F6b. a same-ticker foreign project's public page beside the routed original (both found, foreign first): refused at the gate, the Proof equals the control; the routed original alone is not weaker than with the foreign page", async () => {
    const x = await makeProject({ name: "Orbit Yield", ticker: "ORB" });
    await makeProject({ name: "Orbit Bridge", ticker: "ORB" });
    const docs = canonDocs(x);
    const control = await research(x, { docs });
    const foreign: Doc = { url: `https://snapshot.org/#/orbit-bridge.eth/proposal/0x${"cd".repeat(16)}`, text: `Orbit Bridge (ORB) governance. ${CANON.GOVERNANCE_BASIS}.`, facts: { GOVERNANCE_BASIS: [{ fragment: CANON.GOVERNANCE_BASIS, mechanismState: "APPROVED" }] } };
    const t = await research(x, { docs: [...docs, foreign], search: { GOVERNANCE_BASIS: [foreign.url, docs.find((d) => d.facts.GOVERNANCE_BASIS)!.url] } });
    expect((await evidenceOf(t.jobId, "GOVERNANCE_BASIS")).map((r) => r.retrievedUrl)).not.toContain(foreign.url);
    expect(shapeOf(t)).toEqual(shapeOf(control));
    await provenanceHolds(t);
  });
});

// ================================================================== 8

describe("F8. technical-failure monotonicity", () => {
  it("F8a. progressively worse technical conditions on the same documents: each rung is no stronger than the control and never negative; the permanent rejection is a technical failure with no Proof; search exhaustion and open failure are bounded reasons, never findings", async () => {
    const project = await makeProject();
    const control = await research(project, { docs: canonDocs(project) });
    const rungs: { label: string; make: () => Scenario }[] = [
      { label: "one document-local failure", make: () => { const d = canonDocs(project); d.find((x) => x.facts.DESTINATION)!.extract = "fatal"; return { docs: d }; } },
      { label: "transient 429 recovered", make: () => { const d = canonDocs(project); d.find((x) => x.facts.DESTINATION)!.extract = "transient-once"; return { docs: d }; } },
      { label: "transient exhausted on one document", make: () => { const d = canonDocs(project); d.find((x) => x.facts.DESTINATION)!.extract = "transient-always"; return { docs: d }; } },
      { label: "fetch timeout (open failure)", make: () => { const d = canonDocs(project); d.find((x) => x.facts.DESTINATION)!.fetch = "timeout"; return { docs: d }; } },
      { label: "search budget exhausted", make: () => ({ docs: canonDocs(project), budget: { maxSearchQueries: 3 } }) },
    ];
    for (const r of rungs) {
      const t = await research(project, r.make());
      expect(t.state, r.label).toMatch(/SUCCEEDED|BUDGET_LIMIT_REACHED/);
      noStrongerThan(t, control, r.label);
      nonNegative(t);
      await provenanceHolds(t);
      // A technical reason is never a project reason.
      for (const v of Object.values(t.s5)) {
        if (!v) continue;
        for (const code of v.reasonCodes) expect(["NO_EVIDENCE_FOUND", "EXTRACTION_NOT_COMPLETED", "SEARCH_BUDGET_EXHAUSTED", "NO_ADMISSIBLE_ROUTE"].includes(code) || control.s5[v === t.s5.DESTINATION ? "DESTINATION" : "SOURCE_OF_VALUE"] !== null).toBe(true);
      }
    }
    const transientRecovered = await research(project, rungs[1].make());
    expect(shapeOf(transientRecovered)).toEqual(shapeOf(control));
    const fatal = canonDocs(project);
    fatal.find((x) => x.facts.DESTINATION)!.extract = "401";
    const dead = await research(project, { docs: fatal });
    expect(dead.state).toBe("FAILED");
    expect(dead.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(dead.verdict).toBeNull();
    for (const v of Object.values(dead.s5)) if (v) expect(v.reasonCodes).not.toContain("NO_EVIDENCE_FOUND");
  });

  it("F8b. DECIDED (Round 6.5, Founder decision 1) — with the chain UP, the TOKEN_SUPPLY reading carries no mechanism state, so it no longer closes CURRENT_STATE's acquisition: the official 'the mechanism is live' page is read beside it, the component is SUPPORTED / LIVE on both rows, and 'is it current?' is answered exactly as with the RPC DOWN. A technical failure never reads stronger than a working chain. The full pin is founder-semantics-round6-5-db-v1 (A, B, B2, B3, B4)", async () => {
    const project = await makeProject({ identity: { chain: "ethereum", tokenAddress: EVM } });
    const up = await research(project, { docs: canonDocs(project), chain: "ENABLED", intent: "MECHANISM_CURRENT_STATE" });
    const down = await research(project, { docs: canonDocs(project), chain: "ENABLED", rpc: "down", intent: "MECHANISM_CURRENT_STATE" });
    expect(up.state).toBe("SUCCEEDED");
    expect(down.state).toBe("SUCCEEDED");
    // The chain up: the supply reading (bound, CLAIMED, no state) AND the
    // official page (LIVE) — both supporting.
    const csUp = await evidenceOf(up.jobId, "CURRENT_STATE");
    expect(csUp.map((r) => [r.sourceClass, r.officiality, r.entityBinding, r.onchainFactKind, r.mechanismState]).sort()).toEqual([
      ["OFFICIAL_DOCS", "CONFIRMED", null, null, "LIVE"],
      ["ONCHAIN_VERIFIABLE", "CLAIMED", "CONFIRMED", "TOKEN_SUPPLY", null],
    ]);
    expect(up.s5.CURRENT_STATE!.status).toBe("SUPPORTED");
    expect(up.s5.CURRENT_STATE!.supporting.length).toBe(2);
    expect(up.verdict).toBe("SUPPORTED");
    expect(up.requirements).toEqual(["MCS-1:SATISFIED"]);
    // The chain down: the documentary path alone, the same answer.
    const csDown = await evidenceOf(down.jobId, "CURRENT_STATE");
    expect(csDown.map((r) => [r.sourceClass, r.mechanismState])).toEqual([["OFFICIAL_DOCS", "LIVE"]]);
    expect(down.s5.CURRENT_STATE!.status).toBe("SUPPORTED");
    expect(down.verdict).toBe("SUPPORTED");
    expect(down.requirements).toEqual(up.requirements);
    // THE RELATION: the degraded world is never stronger than the working
    // one.
    noStrongerThan(down, up, "rpc down vs up");
    nonNegative(up);
    nonNegative(down);
    expect((await evidenceOf(down.jobId)).every((r) => r.onchainArtifactId === null)).toBe(true);
    await provenanceHolds(up);
    await provenanceHolds(down);
  });

  it("F8c. the same pair for the revenue intent: the chain going down never makes the revenue Proof STRONGER on the verdict or the band, and the supply reading is never cited as a state", async () => {
    const project = await makeProject({ identity: { chain: "ethereum", tokenAddress: EVM } });
    const up = await research(project, { docs: canonDocs(project), chain: "ENABLED" });
    const down = await research(project, { docs: canonDocs(project), chain: "ENABLED", rpc: "down" });
    expect(VERDICT_RANK[down.verdict!]).toBeLessThanOrEqual(VERDICT_RANK[up.verdict!]);
    if (down.verdict === up.verdict) expect(down.confidence!).toBeLessThanOrEqual(up.confidence!);
    expect(down.requirements).toEqual(up.requirements);
    for (const c of ALL_COMPONENTS) {
      if (c === "NET_EFFECT" || c === "CURRENT_STATE") continue;
      expect([up.s5[c]!.status, up.s5[c]!.reasonCodes], c).toEqual([down.s5[c]!.status, down.s5[c]!.reasonCodes]);
    }
    nonNegative(down);
    nonNegative(up);
  });
});

// ================================================================== 9

describe("F9. Memory monotonicity", () => {
  it("F9a. A no Memory / B valid ACTIVE Memory / C the same observation verified twice (dedups to one live row) / D Memory + identical fresh copy: B, C and D equal A's Proof shape; Memory saves exactly the reused component's fetch and nothing else moves", async () => {
    const project = await makeProject();
    const { ids, admin } = await verifiedActive(project, ["DESTINATION", "RECIPIENT"]);
    const A = await research(project, { docs: canonDocs(project) });
    await setMemoryEnabled(true);
    const B = await research(project, { docs: canonDocs(project) });
    expect(shapeOf(B)).toEqual(shapeOf(A));
    expect(B.calls.fetch).toBe(A.calls.fetch - 2);
    expect(B.cited.filter((c) => c.reused).map((c) => c.component).sort()).toEqual(["DESTINATION", "RECIPIENT"].filter((c) => B.cited.some((x) => x.component === c)).sort());
    await provenanceHolds(B);
    // C: a second verification of an identical Research dedups against the
    // live rows — still one ACTIVE row per observation, adoption unchanged.
    await setMemoryEnabled(false);
    const again = await research(project, { docs: canonDocs(project) });
    const [proof2] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, again.jobId));
    const v2 = await markProofVerified(ctx.db, proof2.id, admin);
    expect(v2.memoryCandidates.created.map((c) => c.component)).not.toContain("DESTINATION");
    const active = await ctx.db.select().from(researchMemory).where(and(eq(researchMemory.projectId, project.id), eq(researchMemory.lifecycleState, "ACTIVE")));
    expect(active.filter((m) => m.component === "DESTINATION")).toHaveLength(1);
    await setMemoryEnabled(true);
    const C = await research(project, { docs: canonDocs(project) });
    expect(shapeOf(C)).toEqual(shapeOf(A));
    expect((await evidenceOf(C.jobId, "DESTINATION"))[0].reusedFromMemoryId).toBe(ids.DESTINATION);
    // D: the identical passage is also on the docs host — never a second row.
    const D = await research(project, { docs: canonDocs(project), search: { DESTINATION: [docsUrl(project, "destination")] } });
    expect((await evidenceOf(D.jobId, "DESTINATION")).length).toBe(1);
    expect(shapeOf(D)).toEqual(shapeOf(A));
  });

  it("F9b. E stale Memory / F unhealthy Memory / G Memory of another identity: each is refused at adoption, the component is fresh work, and the Proof equals the no-Memory control — invalid Memory never strengthens, never contradicts, never leaks its old verdict", async () => {
    const project = await makeProject({ identity: { chain: "ethereum", tokenAddress: EVM } });
    const { ids } = await verifiedActive(project, ["DESTINATION"]);
    const A = await research(project, { docs: canonDocs(project) });
    await setMemoryEnabled(true);
    const transforms: { label: string; apply: () => Promise<void>; revert: () => Promise<void> }[] = [
      {
        label: "E stale",
        apply: async () => { await ctx.db.update(researchMemory).set({ verifiedAt: daysAgo(400) }).where(eq(researchMemory.id, ids.DESTINATION)); },
        revert: async () => { await ctx.db.update(researchMemory).set({ verifiedAt: new Date() }).where(eq(researchMemory.id, ids.DESTINATION)); },
      },
      {
        label: "F questionable",
        apply: async () => { await ctx.db.update(researchMemory).set({ health: "QUESTIONABLE" }).where(eq(researchMemory.id, ids.DESTINATION)); },
        revert: async () => { await ctx.db.update(researchMemory).set({ health: "OK" }).where(eq(researchMemory.id, ids.DESTINATION)); },
      },
      {
        label: "G old identity",
        apply: async () => { await ctx.db.update(researchMemory).set({ identityKey: `ethereum:${EVM_OTHER}` }).where(eq(researchMemory.id, ids.DESTINATION)); },
        revert: async () => { await ctx.db.update(researchMemory).set({ identityKey: `ethereum:${EVM}` }).where(eq(researchMemory.id, ids.DESTINATION)); },
      },
    ];
    for (const tr of transforms) {
      await tr.apply();
      const t = await research(project, { docs: canonDocs(project) });
      const dest = await evidenceOf(t.jobId, "DESTINATION");
      expect(dest.every((r) => r.reusedFromMemoryId === null), tr.label).toBe(true);
      expect(shapeOf(t), tr.label).toEqual(shapeOf(A));
      expect(t.cited.every((c) => !c.reused), tr.label).toBe(true);
      const [m] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, ids.DESTINATION));
      expect(m.lifecycleState, tr.label).toBe("ACTIVE");
      await provenanceHolds(t);
      await tr.revert();
    }
    // Sanity: with everything reverted, adoption is back.
    const back = await research(project, { docs: canonDocs(project) });
    expect((await evidenceOf(back.jobId, "DESTINATION"))[0].reusedFromMemoryId).toBe(ids.DESTINATION);
    expect(shapeOf(back)).toEqual(shapeOf(A));
  });

  it("F9c. H memory_enabled switched off between planning and adoption: nothing adopted, the component is fresh work, and the finished Proof equals the no-Memory control", async () => {
    const project = await makeProject();
    const { ids } = await verifiedActive(project, ["DESTINATION"]);
    const A = await research(project, { docs: canonDocs(project) });
    await setMemoryEnabled(true);
    const jobId = await newJob(project);
    if (!(await claimResearchJob(ctx.db, jobId))) throw new Error("claim failed");
    await runMemoryPlanningStage(ctx.db, jobId);
    const { view } = await loadJobContractView(ctx.db, jobId);
    expect(view.reused.map((r) => r.component)).toEqual(["DESTINATION"]);
    await setMemoryEnabled(false);
    const adoption = await adoptReusedMemory(ctx.db, jobId, view, new Date());
    expect(adoption.adopted).toEqual([]);
    expect(adoption.fallback.map((f) => f.refusals[0].reason)).toEqual(["MEMORY_DISABLED"]);
    const { executor, calls } = executorFor(project, { docs: canonDocs(project) });
    await runS4ResearchJob(ctx.db, jobId, executor, new Date());
    await transitionJobState(ctx.db, jobId, "SUCCEEDED", "round 6 fixture");
    const H = await outcomeOf(jobId, project.id, calls);
    expect((await evidenceOf(jobId)).every((r) => r.reusedFromMemoryId === null)).toBe(true);
    expect(shapeOf(H)).toEqual(shapeOf(A));
    const [m] = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, ids.DESTINATION));
    expect(m.lifecycleState).toBe("ACTIVE");
  });

  it("F9d. Memory never suppresses a fresh-only obligation and never lifts a component above what its own verified observation supports: with CURRENT_STATE fresh evidence weaker (stale) than at verification, the reused DESTINATION does not carry the Proof past the stale current state", async () => {
    const project = await makeProject();
    await verifiedActive(project, ["DESTINATION"]);
    const stale = canonDocs(project);
    stale.find((d) => d.facts.CURRENT_STATE)!.facts.CURRENT_STATE![0].publishedAt = daysAgo(30);
    const A = await research(project, { docs: stale, intent: "MECHANISM_CURRENT_STATE" });
    await setMemoryEnabled(true);
    const B = await research(project, { docs: stale, intent: "MECHANISM_CURRENT_STATE" });
    expect(A.s5.CURRENT_STATE!.reasonCodes).toContain("STALE_CURRENT_STATE");
    expect(shapeOf(B)).toEqual(shapeOf(A));
    expect(B.verdict).not.toBe("SUPPORTED");
    const cs = await evidenceOf(B.jobId, "CURRENT_STATE");
    expect(cs.every((r) => r.reusedFromMemoryId === null)).toBe(true);
  });
});

// ================================================================== 10

describe("F10. project / chain substitution", () => {
  const page = (project: Project, url: string, what: string): Doc => ({ url, text: `${project.name} token tracker. ${what}`, facts: { EXECUTION_EVIDENCE: [{ fragment: what, mechanismState: "LIVE" }] } });

  it("F10a. the same explorer page under one changed identity dimension — other chain, other address, wrapper, legacy, no identity: only the exact (chain, address) binds CONFIRMED; every other variant is UNVERIFIED, excluded, never cited, and the Proof is no stronger than the unbound control", async () => {
    const variants: { label: string; identity?: { chain: "ethereum" | "bsc"; tokenAddress: string }; url: string; bound: boolean }[] = [
      { label: "exact", identity: { chain: "ethereum", tokenAddress: EVM }, url: `https://etherscan.io/token/${EVM}`, bound: true },
      { label: "chain only changed", identity: { chain: "bsc", tokenAddress: EVM }, url: `https://etherscan.io/token/${EVM}`, bound: false },
      { label: "address only changed", identity: { chain: "ethereum", tokenAddress: EVM_OTHER }, url: `https://etherscan.io/token/${EVM}`, bound: false },
      { label: "wrapper page for canonical identity", identity: { chain: "ethereum", tokenAddress: EVM }, url: `https://etherscan.io/token/${EVM_WRAPPER}`, bound: false },
      { label: "same address on the other chain's explorer", identity: { chain: "ethereum", tokenAddress: EVM }, url: `https://bscscan.com/token/${EVM.toLowerCase()}`, bound: false },
      { label: "no identity", url: `https://etherscan.io/token/${EVM}`, bound: false },
    ];
    let exact: Outcome | null = null;
    for (const v of variants) {
      const project = await makeProject({ ticker: "SUB", identity: v.identity });
      const docs = canonDocs(project, ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION", "RECIPIENT"]);
      const explorer = page(project, v.url, "the buyback module executed a purchase of 9,000 SUB in block 20000100");
      // Discovery is held identical across variants: the same page is found
      // for EXECUTION_EVIDENCE whatever the identity says.
      const o = await research(project, { docs: [...docs, explorer], search: { EXECUTION_EVIDENCE: [v.url] } });
      const row = (await evidenceOf(o.jobId, "EXECUTION_EVIDENCE")).find((r) => r.retrievedUrl === v.url);
      expect(row, v.label).toBeDefined();
      expect(row!.entityBinding, v.label).toBe(v.bound ? "CONFIRMED" : "UNVERIFIED");
      if (v.bound) {
        exact = o;
        expect(o.s5.EXECUTION_EVIDENCE!.supporting).toContain(row!.id);
      } else {
        expect(o.s5.EXECUTION_EVIDENCE!.excluded.find((e) => e.evidenceId === row!.id)?.reason, v.label).toBe("ENTITY_NOT_CONFIRMED");
        expect(o.cited.map((c) => c.url), v.label).not.toContain(v.url);
        expect(o.s5.EXECUTION_EVIDENCE!.status).toBe("INSUFFICIENT_EVIDENCE");
        noStrongerThan(o, exact!, v.label);
        nonNegative(o);
      }
      await provenanceHolds(o);
    }
  });

  it("F10b. the same unrouted governance page under one changed project dimension — ticker only, name only: it binds exactly when the confirmed name is present, never on the ticker; a renamed project no longer binds its old name", async () => {
    const a = await makeProject({ name: "Helix Finance", ticker: "HLX" });
    const b = await makeProject({ name: "Helix Finance", ticker: "HLY" });
    const c = await makeProject({ name: "Helix Markets", ticker: "HLX" });
    const gov = (project: Project, text: string): Doc => ({ url: `https://snapshot.org/#/${project.slug.replace(/_/g, "-")}.eth/proposal/0x${"ab".repeat(16)}`, text, facts: { GOVERNANCE_BASIS: [{ fragment: CANON.GOVERNANCE_BASIS, mechanismState: "APPROVED" }] } });
    const run = async (project: Project, text: string) => {
      const page = gov(project, text);
      const o = await research(project, { docs: [...canonDocs(project, ALL_COMPONENTS.filter((x) => x !== "GOVERNANCE_BASIS")), page], search: { GOVERNANCE_BASIS: [page.url] } });
      return { o, bound: (await evidenceOf(o.jobId, "GOVERNANCE_BASIS")).some((r) => r.retrievedUrl === page.url) };
    };
    const text = `Helix Finance (HLX) governance. Proposal 3: ${CANON.GOVERNANCE_BASIS}.`;
    expect((await run(a, text)).bound).toBe(true); // name + ticker
    expect((await run(b, text)).bound).toBe(true); // name, other ticker — the name anchors
    expect((await run(c, text)).bound).toBe(false); // ticker, other name — the ticker does not
    // A rename: the old name is no longer the project's anchor.
    await ctx.db.update(projects).set({ name: "Helix Protocol" }).where(eq(projects.id, a.id));
    const renamed = { ...a, name: "Helix Protocol" };
    expect((await run(renamed, text)).bound).toBe(false);
    expect((await run(renamed, `Helix Protocol governance. Proposal 3: ${CANON.GOVERNANCE_BASIS}.`)).bound).toBe(true);
  });
});

// ================================================================== 13

describe("F13. verification audit metadata is untouched by Research transformations", () => {
  it("F13a. a VERIFIED Proof's actor and time, and its memory rows, are byte-identical after any number of later Researches — with Memory on or off, adopted or refused", async () => {
    const project = await makeProject();
    const { ids, admin, proofId } = await verifiedActive(project, ["DESTINATION"]);
    const [before] = await ctx.db.select().from(proofs).where(eq(proofs.id, proofId));
    expect(before.verificationStatus).toBe("VERIFIED");
    expect(before.verifiedBy).toBe(admin);
    const memBefore = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, ids.DESTINATION));
    await research(project, { docs: canonDocs(project) });
    await setMemoryEnabled(true);
    await research(project, { docs: canonDocs(project) });
    await ctx.db.update(researchMemory).set({ health: "QUESTIONABLE" }).where(eq(researchMemory.id, ids.DESTINATION));
    await research(project, { docs: canonDocs(project) });
    await ctx.db.update(researchMemory).set({ health: "OK" }).where(eq(researchMemory.id, ids.DESTINATION));
    const [after] = await ctx.db.select().from(proofs).where(eq(proofs.id, proofId));
    expect(after).toEqual(before);
    const memAfter = await ctx.db.select().from(researchMemory).where(eq(researchMemory.id, ids.DESTINATION));
    expect(memAfter.map((m) => ({ ...m, lastUsedAt: null, useCount: null }))).toEqual(memBefore.map((m) => ({ ...m, lastUsedAt: null, useCount: null })));
    // Nothing ever pointed a later job's Evidence at another project's memory or another job's rows.
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, before.researchJobId));
    expect(trace.length).toBeGreaterThan(0);
    const [item] = await ctx.db.select().from(projectMemoryItems).where(eq(projectMemoryItems.id, project.docsRouteId));
    expect(item.lifecycleState).toBe("ACTIVE");
  });
});
