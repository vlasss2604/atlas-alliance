import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import {
  evidence,
  interpretations,
  onchainArtifacts,
  productConfig,
  projectMemoryItems,
  projects,
  proofs,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  researchMemory,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError } from "../src/server/engine/providers/evidence-extractor";
import { createEvmOnchainAdapter, ERC20_DECIMALS_SELECTOR, ERC20_TOTAL_SUPPLY_SELECTOR } from "../src/server/engine/providers/onchain-evm";
import { __setOnchainRetriever, type OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { installOnchainResearchCapability } from "../src/server/jobs/onchain-capability";
import { promoteToActive } from "../src/server/memory/lifecycle";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { markProofVerified } from "../src/server/memory/verification";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 5: THE FINAL RESULT, BLACK BOX.
//
// One complete research machine per case — question / intent, Pattern,
// planning, acquisition through the REAL S4 executor (fixture proposer,
// search gateway, content fetcher and extractor over deterministic
// documents; the real EVM adapter over a fixture RPC transport where a
// chain is involved), Evidence, S5, S6, S7, S8 — and one question about
// what comes out: can a plausible but adversarial combination of sources,
// Memory, chain data, failures and partial Evidence make the Proof claim
// more than the Evidence proves?
//
// The reference for "more than the Evidence proves" is the Proof of a
// control run that lacks the adversarial ingredient, or the CORE_RULES
// distinction the ingredient tries to blur. Every case reads the final
// persisted Proof, its claim support, its citations and its gaps, never an
// intermediate helper. No provider, no model, no network, no RPC.
//
// Families: 1 strong/weak authority; 2 documentary vs on-chain; 3 partial
// research per intent; 4 technical failure beside valid Evidence; 5 Memory
// vs fresh; 6 project / token ambiguity; 7 temporal; 8 misleading language;
// 9 exclusion pressure; 10 bounded budgets; 11 order independence; 12 the
// independent review.

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
const INTENTS = [
  "PROTOCOL_REVENUE_TO_TOKEN",
  "PASSIVE_HOLDER_OUTCOME",
  "REWARD_SOURCE",
  "BURN_OR_SUPPLY_EFFECT",
  "MECHANISM_CURRENT_STATE",
  "USAGE_TO_TOKEN_LINKAGE",
  "VALUE_CAPTURE",
  "TOKEN_UTILITY",
] as const;
type Intent = (typeof INTENTS)[number];

const DAY_MS = 24 * 3600 * 1000;
const NOW = () => new Date();
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const EVM = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
const EVM_LEGACY = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";
const EVM_WRAPPER = "0x9D03bb2092270648d7480049d0E58d2FcF0E5123";

// The canonical passages, one per component: the "true" documentary story
// of a fee -> treasury -> buyback -> burn mechanism.
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
const STATE_OF: Partial<Record<Component, string>> = {
  MECHANISM_SPEC: "LIVE",
  EXECUTION_EVIDENCE: "LIVE",
  CURRENT_STATE: "LIVE",
};

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
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
  name: string;
  ticker: string | null;
  host: string;
  govHost: string;
  docsRouteId: string;
}

// A real onboarded project: its own docs host (confirmed + classified
// OFFICIAL_DOCS at /docs) and its own governance host (GOVERNANCE at
// /proposals); optionally a confirmed Ethereum identity.
async function makeProject(opts: { name?: string; ticker?: string; host?: string; identity?: string } = {}): Promise<Project> {
  const slug = uniq("r5");
  const name = opts.name ?? `Round Five ${slug.replace(/_/g, " ")}`;
  const host = opts.host ?? `docs.${slug.replace(/_/g, "-")}.example`;
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
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "ethereum", tokenAddress: opts.identity, ticker: opts.ticker ?? "R5" });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, name, ticker: opts.ticker ?? null, host, govHost, docsRouteId: docsClass.newItemId };
}

// ---- documents and facts ---------------------------------------------

interface FactSpec {
  fragment: string;
  relationship?: ExtractedFact["relationship"];
  directness?: ExtractedFact["directness"];
  mechanismState?: string | null;
  publishedAt?: Date | null;
  doesNotProve?: string;
}
interface Doc {
  url: string;
  text: string;
  facts: Partial<Record<Component, FactSpec[]>>;
  fetch?: "ok" | "timeout" | "http404";
  // "fatal": the extractor throws an ordinary error for this document (a
  // local, per-document failure). "outage": the provider itself is down
  // (the typed unavailability the executor escalates).
  extract?: "ok" | "fatal" | "outage";
}

function docsUrl(project: Project, path: string): string {
  return `https://${project.host}/docs/${path}`;
}
function govUrl(project: Project, path: string): string {
  return `https://${project.govHost}/proposals/${path}`;
}
// One official documentation page per component stating the canonical passage.
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
  // Which urls the search returns for each component, in order. Defaults
  // to every document that carries a fact for the component.
  search?: Partial<Record<Component, string[]>>;
  intent?: Intent;
  budget?: Partial<EntitlementSnapshot["budget"]>;
  chain?: "ENABLED" | "DOCUMENTARY_ONLY";
  rpc?: "ok" | "down";
  supplyRaw?: string;
}

function fetched(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}:${text.length}`,
    fetchedAt: NOW(),
    byteLength: text.length,
  };
}

function evmFixture(opts: { supplyRaw: string; down?: boolean }) {
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      if (opts.down) throw new Error("fixture rpc: connection refused");
      if (method === "eth_chainId") return JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" });
      if (method === "eth_getBlockByNumber") {
        return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x1234abc", hash: "0x" + "ef".repeat(32), timestamp: "0x66f2a1c0" } });
      }
      if (method === "eth_call") {
        const data = (params[0] as { data: string }).data;
        const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
        if (data === ERC20_TOTAL_SUPPLY_SELECTOR) return JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(BigInt(opts.supplyRaw)) });
        if (data === ERC20_DECIMALS_SELECTOR) return JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(BigInt(18)) });
      }
      throw new Error(`fixture rpc: unexpected ${method}`);
    },
  };
  return createEvmOnchainAdapter({ transport, providerId: "fixture-evm-rpc", environment: { chain: "ethereum", network: "mainnet" } });
}

// THE REAL S4 EXECUTOR over the scenario's documents.
function executorFor(project: Project, s: Scenario): { executor: WorkExecutor; calls: Record<string, number> } {
  const byUrl = new Map(s.docs.map((d) => [d.url, d]));
  const calls: Record<string, number> = { proposer: 0, search: 0, fetch: 0, extract: 0 };
  const served = new Set<string>();
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
      // The executor targets queries itself (site:<confirmed host>, and the
      // explorer locator for a confirmed identity) and never repeats a
      // query string inside one job. An explorer-locator query returns the
      // scenario's explorer pages; any other query returns the component's
      // documentary pages, once per component.
      async search(query, target) {
        calls.search += 1;
        const component = target.component as Component;
        const isExplorer = /^site:(etherscan\.io|bscscan\.com|polygonscan\.com|solscan\.io|solana\.fm|arbiscan\.io|basescan\.org|snowtrace\.io|optimistic\.etherscan\.io)/.test(query);
        const explorerHost = (url: string) => /^https:\/\/(www\.)?([a-z]+\.)?(etherscan\.io|bscscan\.com|polygonscan\.com|solscan\.io|solana\.fm|arbiscan\.io|basescan\.org|snowtrace\.io)\//.test(url);
        if (isExplorer) {
          return s.docs.filter((d) => explorerHost(d.url)).map((url) => ({ url: url.url, title: null, snippet: null }));
        }
        const key = `${target.step}:${component}`;
        if (served.has(key)) return [];
        served.add(key);
        const urls = s.search?.[component] ?? s.docs.filter((d) => d.facts[component] && !explorerHost(d.url)).map((d) => d.url);
        return urls.map((url) => ({ url, title: null, snippet: null }));
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
        const d = byUrl.get(input.document.finalUrl);
        if (!d) return [];
        if (d.extract === "fatal") throw new Error("fixture extractor: exploded on this document");
        // A rejected credential, exactly as the production extractor throws it.
        if (d.extract === "outage") throw new EvidenceExtractorUnavailableError("generation failed: AUTHENTICATION_FAILED:401", false, "AUTHENTICATION_FAILED", 401);
        const component = input.target.component as Component;
        return (d.facts[component] ?? []).map((f) => ({
          step: input.target.step,
          component,
          statement: `${component.toLowerCase().replace(/_/g, " ")}: ${f.fragment}`,
          supportFragment: f.fragment,
          mechanismState: f.mechanismState ?? null,
          directness: f.directness ?? "DIRECT",
          // A publication date later than the fetch is refused as a date
          // (Round 1, D3/G2), so the default is a day before.
          publishedAt: f.publishedAt === undefined ? daysAgo(1) : f.publishedAt,
          doesNotProve: f.doesNotProve ?? "does not prove the size of the effect",
          relationship: f.relationship ?? "SUPPORTS",
        }));
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
  state: string;
  verdict: string | null;
  confidence: number | null;
  claim: string | null;
  requirements: string[];
  gaps: string[];
  cited: { id: string; component: string; url: string; reused: boolean }[];
  s5: Record<string, { status: string; reasonCodes: string[]; supporting: string[]; excluded: { evidenceId: string; reason: string }[] } | null>;
  calls: Record<string, number>;
}

async function research(project: Project, s: Scenario): Promise<Outcome> {
  if (s.chain === "ENABLED") {
    const adapter = evmFixture({ supplyRaw: s.supplyRaw ?? "1000000000000000000000000000", down: s.rpc === "down" });
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
  return outcomeOf(jobId, calls);
}

async function outcomeOf(jobId: string, calls: Record<string, number> = {}): Promise<Outcome> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  const gaps = new Set<string>();
  for (const f of (asm?.flows ?? []) as { gaps?: { kind: string; component: string }[] }[]) for (const g of f.gaps ?? []) gaps.add(`${g.kind}@${g.component}`);
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
          excluded: r.excludedEvidence as { evidenceId: string; reason: string }[],
        }
      : null;
  }
  return {
    jobId,
    state: job.state,
    verdict: proof?.verdict ?? null,
    confidence: proof?.confidence ?? null,
    claim: claim?.status ?? null,
    requirements: claim ? claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`) : [],
    gaps: [...gaps].sort(),
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
function shapeOf(o: Outcome) {
  const s5 = Object.fromEntries(Object.entries(o.s5).map(([k, v]) => [k, v ? { status: v.status, reasonCodes: v.reasonCodes, n: v.supporting.length } : null]));
  return { verdict: o.verdict, confidence: o.confidence, claim: o.claim, requirements: o.requirements, gaps: o.gaps, citedComponents: o.cited.map((c) => c.component).sort(), s5 };
}
const RANK: Record<string, number> = { NOT_SUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
function noStrongerThan(o: Outcome, ref: Outcome): void {
  expect(o.verdict, `verdict ${o.verdict} vs ${ref.verdict}`).not.toBeNull();
  expect(RANK[o.verdict!]).toBeLessThanOrEqual(RANK[ref.verdict!]);
  if (o.verdict === ref.verdict) expect(o.confidence!).toBeLessThanOrEqual(ref.confidence!);
}
function nonNegative(o: Outcome): void {
  expect(o.verdict).not.toBe("NOT_SUPPORTED");
  expect(o.verdict).not.toBe("CONTRADICTED");
  for (const v of Object.values(o.s5)) if (v) expect(v.status).not.toBe("CONTRADICTED");
}
// Nothing excluded by S5 is ever cited by the Proof.
function citesOnlySupport(o: Outcome): void {
  const excluded = new Set(Object.values(o.s5).flatMap((v) => (v ? v.excluded.map((e) => e.evidenceId) : [])));
  const supporting = new Set(Object.values(o.s5).flatMap((v) => (v ? v.supporting : [])));
  for (const c of o.cited) {
    expect(excluded.has(c.id), `cited excluded row ${c.id}`).toBe(false);
    expect(supporting.has(c.id), `cited row ${c.id} that no S5 row supports`).toBe(true);
  }
}

// ================================================================== 1

describe("F1. strong vs weak source conflict", () => {
  it("F1a. official docs say burn (older); a newer, more detailed unofficial page says stakers: the weak row is inadmissible for DESTINATION, the Proof equals the docs-only control and cites only the docs", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const weak: Doc = {
      url: `https://medium.com/@${project.slug}/deep-dive`,
      text: `${project.name} deep dive. In practice every purchased token is distributed pro rata to stakers on the first day of the following epoch, with the exact split published in the treasury dashboard.`,
      facts: { DESTINATION: [{ fragment: "every purchased token is distributed pro rata to stakers on the first day of the following epoch", publishedAt: daysAgo(0) }] },
    };
    docs.find((d) => d.facts.DESTINATION)!.facts.DESTINATION![0].publishedAt = daysAgo(90);
    const control = await research(project, { docs });
    const attacked = await research(project, { docs: [...docs, weak] });
    expect(attacked.state).toBe("SUCCEEDED");
    expect(shapeOf(attacked)).toEqual(shapeOf(control));
    const weakRow = (await evidenceOf(attacked.jobId, "DESTINATION")).find((r) => r.retrievedUrl === weak.url);
    expect(weakRow).toBeDefined();
    expect(weakRow!.sourceClass).toBe("SOCIAL");
    expect(weakRow!.officiality).toBe("CLAIMED");
    expect(attacked.s5.DESTINATION!.excluded.find((e) => e.evidenceId === weakRow!.id)?.reason).toBe("CLASS_NOT_ADMISSIBLE");
    expect(attacked.cited.map((c) => c.url)).not.toContain(weak.url);
    citesOnlySupport(attacked);
  });

  it("F1b. official docs only address the claim indirectly; the weak page is explicit and DIRECT: the outcome is at most partial, never SUPPORTED, and never stronger than the docs alone", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const dest = docs.find((d) => d.facts.DESTINATION)!;
    dest.text = `${project.name} — destination. The buyback module's purchases are accounted for in the treasury's quarterly report under the heading burned allocation.`;
    dest.facts.DESTINATION = [{ fragment: "accounted for in the treasury's quarterly report under the heading burned allocation", directness: "INDIRECT" }];
    const weak: Doc = {
      url: `https://x.com/${project.slug}/status/1`,
      text: `${project.name}: every purchased token is sent straight to the burn address 0x000...dEaD, verifiably, every epoch.`,
      facts: { DESTINATION: [{ fragment: "every purchased token is sent straight to the burn address 0x000...dEaD, verifiably, every epoch" }] },
    };
    const control = await research(project, { docs });
    const attacked = await research(project, { docs: [...docs, weak] });
    expect(control.s5.DESTINATION!.status).toBe("PARTIALLY_SUPPORTED");
    expect(control.s5.DESTINATION!.reasonCodes).toContain("INDIRECT_ONLY");
    expect(attacked.s5.DESTINATION!.status).toBe("PARTIALLY_SUPPORTED");
    expect(attacked.verdict).not.toBe("SUPPORTED");
    noStrongerThan(attacked, control);
    expect(shapeOf(attacked)).toEqual(shapeOf(control));
    citesOnlySupport(attacked);
  });

  it("F1c. the only source for a required component is unofficial: INSUFFICIENT_EVIDENCE, not NOT_SUPPORTED — the missing bridge is named, the project is not judged", async () => {
    const project = await makeProject();
    const docs = canonDocs(project, ALL_COMPONENTS.filter((c) => c !== "SOURCE_OF_VALUE"));
    const weak: Doc = {
      url: `https://coinmarketcap.com/currencies/${project.slug}/`,
      text: `${project.name} charges swap fees on every trade and those fees are the protocol's only revenue.`,
      facts: { SOURCE_OF_VALUE: [{ fragment: "charges swap fees on every trade and those fees are the protocol's only revenue" }] },
    };
    const o = await research(project, { docs: [...docs, weak] });
    expect(o.state).toBe("SUCCEEDED");
    expect(o.s5.SOURCE_OF_VALUE!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.SOURCE_OF_VALUE!.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
    expect(o.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.requirements).toContain("PRT-1:UNSATISFIED");
    nonNegative(o);
    expect(o.cited.map((c) => c.component)).not.toContain("SOURCE_OF_VALUE");
    citesOnlySupport(o);
  });
});

// ================================================================== 2

describe("F2. documentary vs on-chain", () => {
  it("F2a. docs say burned and supply declines, no chain data: NET_EFFECT is not established from prose; BURN_OR_SUPPLY_EFFECT is INSUFFICIENT_EVIDENCE, never SUPPORTED, never negative", async () => {
    const project = await makeProject();
    const o = await research(project, { docs: canonDocs(project), intent: "BURN_OR_SUPPLY_EFFECT" });
    expect(o.state).toBe("SUCCEEDED");
    expect(o.s5.NET_EFFECT!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.NET_EFFECT!.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
    expect(o.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.requirements).toEqual(["BSE-1:UNSATISFIED"]);
    nonNegative(o);
    expect(o.cited.map((c) => c.component)).not.toContain("NET_EFFECT");
  });

  it("F2b. docs say burned; the chain gives ONE current supply reading: a point-in-time supply is not a supply change — NET_EFFECT stays unestablished, the reading is bound and cited nowhere as a reduction", async () => {
    const project = await makeProject({ identity: EVM });
    const o = await research(project, { docs: canonDocs(project), intent: "BURN_OR_SUPPLY_EFFECT", chain: "ENABLED" });
    expect(o.state).toBe("SUCCEEDED");
    const artifacts = await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, o.jobId));
    expect(artifacts.length).toBeGreaterThan(0);
    const chainRows = (await evidenceOf(o.jobId)).filter((r) => r.onchainFactKind !== null);
    expect(chainRows.length).toBeGreaterThan(0);
    expect(chainRows.every((r) => r.entityBinding === "CONFIRMED" && r.sourceClass === "ONCHAIN_VERIFIABLE")).toBe(true);
    expect(o.s5.NET_EFFECT!.status).not.toBe("SUPPORTED");
    expect(o.requirements[0]).not.toBe("BSE-1:SATISFIED");
    expect(o.verdict).not.toBe("SUPPORTED");
    nonNegative(o);
    citesOnlySupport(o);
  });

  it("F2c. governance says approved, docs describe the mechanism, nothing shows execution: DOCUMENTED and APPROVED do not become EXECUTING — the lifecycle question is not answered CURRENT and the revenue claim carries the execution gap", async () => {
    const project = await makeProject();
    const docs = canonDocs(project, ALL_COMPONENTS.filter((c) => c !== "EXECUTION_EVIDENCE" && c !== "CURRENT_STATE"));
    docs.find((d) => d.facts.MECHANISM_SPEC)!.facts.MECHANISM_SPEC![0].mechanismState = "APPROVED";
    docs.find((d) => d.facts.GOVERNANCE_BASIS)!.facts.GOVERNANCE_BASIS![0].mechanismState = "APPROVED";
    const current = await research(project, { docs, intent: "MECHANISM_CURRENT_STATE" });
    expect(current.verdict).not.toBe("SUPPORTED");
    expect(current.requirements).toEqual(["MCS-1:UNSATISFIED"]);
    nonNegative(current);
    const revenue = await research(project, { docs, intent: "PROTOCOL_REVENUE_TO_TOKEN" });
    expect(revenue.gaps).toContain("MISSING_COMPONENT@EXECUTION_EVIDENCE");
    expect(revenue.s5.EXECUTION_EVIDENCE!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(revenue.verdict).not.toBe("SUPPORTED");
    nonNegative(revenue);
  });

  it("F2d. an explorer transaction page proves an execution happened; nothing establishes what the value is: TRANSACTION HAPPENED is not MECHANISM EXECUTED — the revenue claim stays INSUFFICIENT", async () => {
    const project = await makeProject({ identity: EVM });
    const docs = canonDocs(project, ["DESTINATION", "RECIPIENT", "FLOW_PATH"]);
    const tx: Doc = {
      url: `https://etherscan.io/token/${EVM}`,
      text: `${project.name} token tracker. Transfer of 12,000 tokens from the buyback module to 0x000...dEaD confirmed in block 20000001.`,
      facts: { EXECUTION_EVIDENCE: [{ fragment: "Transfer of 12,000 tokens from the buyback module to 0x000...dEaD confirmed in block 20000001", mechanismState: "LIVE" }] },
    };
    const o = await research(project, { docs: [...docs, tx] });
    // An explorer page opened over HTTP is CLAIMED (D-074: only a chain read
    // is CONFIRMED authority), so the execution is at most partial.
    expect(o.s5.EXECUTION_EVIDENCE!.status).toBe("PARTIALLY_SUPPORTED");
    expect(o.s5.EXECUTION_EVIDENCE!.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
    const txRow = (await evidenceOf(o.jobId, "EXECUTION_EVIDENCE"))[0];
    expect(txRow.entityBinding).toBe("CONFIRMED");
    expect(txRow.officiality).toBe("CLAIMED");
    expect(o.s5.SOURCE_OF_VALUE).toSatisfy((v: Outcome["s5"][string]) => v === null || v.status !== "SUPPORTED");
    expect(o.requirements).toContain("PRT-1:UNSATISFIED");
    expect(o.verdict).toBe("INSUFFICIENT_EVIDENCE");
    nonNegative(o);
  });

  it("F2e. BUYBACK is not BURN: docs say purchased tokens are held in the treasury, nothing says burned — no burn destination, no net effect, the supply claim is not answered", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const dest = docs.find((d) => d.facts.DESTINATION)!;
    dest.text = `${project.name} — destination. tokens purchased by the buyback module are held in the protocol treasury and counted as protocol-owned liquidity.`;
    dest.facts.DESTINATION = [{ fragment: "tokens purchased by the buyback module are held in the protocol treasury and counted as protocol-owned liquidity" }];
    const o = await research(project, { docs, intent: "BURN_OR_SUPPLY_EFFECT" });
    expect(o.s5.DESTINATION!.status).toBe("SUPPORTED");
    expect(o.verdict).not.toBe("SUPPORTED");
    expect(o.requirements).toEqual(["BSE-1:UNSATISFIED"]);
    nonNegative(o);
  });
});

// ================================================================== 3

describe("F3. partial research, every intent", () => {
  // For each intent, the ingredient whose absence must keep the claim from
  // being SUPPORTED, whatever else is strongly established.
  const REMOVE: Record<Intent, Component> = {
    PROTOCOL_REVENUE_TO_TOKEN: "SOURCE_OF_VALUE",
    PASSIVE_HOLDER_OUTCOME: "RECIPIENT",
    REWARD_SOURCE: "SOURCE_OF_VALUE",
    BURN_OR_SUPPLY_EFFECT: "NET_EFFECT",
    MECHANISM_CURRENT_STATE: "CURRENT_STATE",
    USAGE_TO_TOKEN_LINKAGE: "DESTINATION",
    VALUE_CAPTURE: "NET_EFFECT",
    TOKEN_UTILITY: "SOURCE_OF_VALUE",
  };
  for (const intent of INTENTS) {
    it(`F3.${intent}: with ${REMOVE[intent]} absent and everything else strongly documented, the claim is never SUPPORTED, never stronger than the full run, never negative`, async () => {
      const project = await makeProject();
      const full = await research(project, { docs: canonDocs(project), intent });
      const partial = await research(project, { docs: canonDocs(project, ALL_COMPONENTS.filter((c) => c !== REMOVE[intent])), intent });
      expect(partial.state).toBe("SUCCEEDED");
      expect(partial.verdict).not.toBe("SUPPORTED");
      noStrongerThan(partial, full);
      nonNegative(partial);
      expect(partial.s5[REMOVE[intent]]).toSatisfy((v: Outcome["s5"][string]) => v === null || v.status === "INSUFFICIENT_EVIDENCE");
      expect(partial.cited.map((c) => c.component)).not.toContain(REMOVE[intent]);
      citesOnlySupport(partial);
    }, 60_000);
  }

  it("F3.optional: TOKEN_UTILITY's OPTIONAL attribute strongly established while its REQUIRED component is only INDIRECT: the claim is partial, not SUPPORTED", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const sov = docs.find((d) => d.facts.SOURCE_OF_VALUE)!;
    sov.facts.SOURCE_OF_VALUE![0].directness = "INDIRECT";
    const o = await research(project, { docs, intent: "TOKEN_UTILITY" });
    expect(o.s5.RECIPIENT!.status).toBe("SUPPORTED");
    expect(o.s5.SOURCE_OF_VALUE!.status).toBe("PARTIALLY_SUPPORTED");
    expect(o.verdict).not.toBe("SUPPORTED");
    expect(o.requirements.find((r) => r.startsWith("TU-1:"))).not.toBe("TU-1:SATISFIED");
    nonNegative(o);
  });
});

// ================================================================== 4

describe("F4. technical failure beside valid Evidence", () => {
  it("F4a. one document times out, every other fetch succeeds: the component it carried is unestablished with a technical reason, the rest establish, the Proof is built and never negative", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    docs.find((d) => d.facts.DESTINATION)!.fetch = "timeout";
    const o = await research(project, { docs });
    expect(o.state).toBe("SUCCEEDED");
    expect(o.s5.DESTINATION!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.DESTINATION!.reasonCodes).toContain("NO_EVIDENCE_FOUND");
    expect(o.s5.SOURCE_OF_VALUE!.status).not.toBe("INSUFFICIENT_EVIDENCE");
    expect(o.verdict).not.toBe("SUPPORTED");
    nonNegative(o);
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, o.jobId));
    expect(trace.some((t) => t.operationType === "FETCH_FAILED" && t.component === "DESTINATION")).toBe(true);
    citesOnlySupport(o);
  });

  it("F4b. the extractor fails on ONE document: bounded — the component is unestablished, the job completes, the trace records the failure, nothing negative follows", async () => {
    const project = await makeProject();
    const one = canonDocs(project);
    one.find((d) => d.facts.MECHANISM_SPEC)!.extract = "fatal";
    const single = await research(project, { docs: one });
    expect(single.state).toBe("SUCCEEDED");
    expect(single.s5.MECHANISM_SPEC!.status).toBe("INSUFFICIENT_EVIDENCE");
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, single.jobId));
    expect(trace.some((t) => t.operationType === "EXTRACT_FAILED" && t.component === "MECHANISM_SPEC")).toBe(true);
    expect(single.verdict).not.toBe("SUPPORTED");
    nonNegative(single);
    citesOnlySupport(single);
  });

  it("F4b'. ROUND 5.5 (Founder decision B) — the extractor's credential is REJECTED (401) after the first component: the reader being refused is a capability failure, not sources that say nothing — the job ends FAILED / SYSTEM_OR_PROVIDER_FAILURE with no Proof, the Evidence read before stays auditable, and no later component is written as NO_EVIDENCE_FOUND", async () => {
    const project = await makeProject();
    const outage = canonDocs(project);
    for (const d of outage) if (!d.facts.SOURCE_OF_VALUE) d.extract = "outage";
    const o = await research(project, { docs: outage });
    // TECHNICAL FAILURE != PROJECT REALITY. Round 5 pinned the old rule
    // here (document-local 401s, nine NO_EVIDENCE_FOUND components, a
    // SUCCEEDED and therefore verifiable job with a PARTIALLY_SUPPORTED
    // Proof). The Founder decided: a permanent provider rejection of the
    // generation call is capability-fatal, like count_tokens' has always
    // been.
    expect(o.state).toBe("FAILED");
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, o.jobId));
    expect(job.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(o.verdict).toBeNull();
    expect(o.claim).toBeNull();
    // The Evidence read before the refusal is persisted and auditable.
    const sov = await evidenceOf(o.jobId, "SOURCE_OF_VALUE");
    expect(sov.length).toBeGreaterThan(0);
    // Exactly one refusal: fatal on the first refused document, never
    // repeated across the remaining components.
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, o.jobId));
    const refused = trace.filter((t) => t.operationType === "MODEL_CALL_ATTEMPTED" && t.status === "FAILED" && t.diagnosticCode === "AUTHENTICATION_FAILED:401");
    expect(refused.length).toBe(1);
    expect(trace.filter((t) => t.operationType === "EXTRACT_FAILED").length).toBe(0);
    expect(o.calls.extract).toBe(2);
    // No component is represented as "sources say nothing".
    for (const c of ALL_COMPONENTS) {
      if (o.s5[c]) expect(o.s5[c]!.reasonCodes).not.toContain("NO_EVIDENCE_FOUND");
    }
    nonNegative(o);
  });

  it("F4c. the RPC is down after documentary Evidence exists: the chain read fails boundedly, the documentary Proof stands, NET_EFFECT is unestablished, nothing is negative", async () => {
    const project = await makeProject({ identity: EVM });
    const o = await research(project, { docs: canonDocs(project), chain: "ENABLED", rpc: "down" });
    expect(o.state).toBe("SUCCEEDED");
    expect((await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, o.jobId))).length).toBe(0);
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, o.jobId));
    expect(trace.some((t) => t.operationType === "FETCH_FAILED" && t.targetRef?.startsWith("atlas-onchain:"))).toBe(true);
    expect(o.s5.SOURCE_OF_VALUE!.status).not.toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.NET_EFFECT!.status).not.toBe("SUPPORTED");
    expect(o.verdict).not.toBeNull();
    nonNegative(o);
    citesOnlySupport(o);
  });
});

// ================================================================== 5

describe("F5. Memory vs fresh Evidence", () => {
  async function verifiedActive(project: Project, components: readonly Component[]) {
    const admin = await makeAdmin();
    const a = await research(project, { docs: canonDocs(project) });
    expect(a.state).toBe("SUCCEEDED");
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, a.jobId));
    await markProofVerified(ctx.db, proof.id, admin);
    const memory = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, project.id));
    const ids: Record<string, string> = {};
    for (const c of components) {
      const m = memory.find((x) => x.component === c)!;
      await promoteToActive(ctx.db, m.id, admin);
      ids[c] = m.id;
    }
    return { a, ids };
  }

  it("F5a. Memory closes DESTINATION; fresh Evidence for CURRENT_STATE conflicts with the docs (paused vs active, same day): the conflict is honest, adoption is unaffected, provenance separates reused from fresh, and the revenue verdict equals the no-memory control", async () => {
    const project = await makeProject();
    const { ids } = await verifiedActive(project, ["DESTINATION"]);
    const day = daysAgo(0);
    const docs = canonDocs(project);
    docs.find((d) => d.facts.CURRENT_STATE)!.facts.CURRENT_STATE![0].publishedAt = day;
    const status: Doc = {
      url: docsUrl(project, "status"),
      text: `${project.name} — status. the buyback mechanism has been paused pending a security review.`,
      facts: { CURRENT_STATE: [{ fragment: "the buyback mechanism has been paused pending a security review", mechanismState: "PAUSED", publishedAt: day }] },
    };
    const control = await research(project, { docs: [...docs, status] });
    await setMemoryEnabled(true);
    const withMemory = await research(project, { docs: [...docs, status] });
    expect(withMemory.s5.CURRENT_STATE!.status).toBe("CONTRADICTED");
    expect(control.s5.CURRENT_STATE!.status).toBe("CONTRADICTED");
    const dest = await evidenceOf(withMemory.jobId, "DESTINATION");
    expect(dest.length).toBe(1);
    expect(dest[0].reusedFromMemoryId).toBe(ids.DESTINATION);
    expect(withMemory.cited.find((c) => c.component === "DESTINATION")?.reused).toBe(true);
    expect(withMemory.cited.filter((c) => c.component !== "DESTINATION").every((c) => !c.reused)).toBe(true);
    expect(withMemory.calls.fetch).toBe(control.calls.fetch - 1);
    expect(shapeOf(withMemory)).toEqual(shapeOf(control));
    const current = await research(project, { docs: [...docs, status], intent: "MECHANISM_CURRENT_STATE" });
    expect(current.verdict).not.toBe("SUPPORTED");
    expect(current.requirements).toEqual(["MCS-1:UNSATISFIED"]);
  });

  it("F5b. Memory valid at planning, its route withdrawn before adoption, fresh docs on the replacement route: the Proof rests on the fresh row, the adopted row is present but excluded, no double counting", async () => {
    const project = await makeProject();
    const { ids } = await verifiedActive(project, ["DESTINATION"]);
    await setMemoryEnabled(true);
    // The route is withdrawn AFTER Research A but BEFORE B plans; a new
    // docs host is confirmed so fresh acquisition has authority again.
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));
    const newHost = `docs2.${project.slug.replace(/_/g, "-")}.example`;
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: project.slug, domain: newHost, pathPrefix: "/docs" });
    if (!confirmed.ok) throw new Error(confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error(classified.refusal);
    const moved: Project = { ...project, host: newHost };
    const o = await research(moved, { docs: canonDocs(moved) });
    const dest = await evidenceOf(o.jobId, "DESTINATION");
    const adopted = dest.find((r) => r.reusedFromMemoryId === ids.DESTINATION)!;
    const fresh = dest.find((r) => r.reusedFromMemoryId === null)!;
    expect(adopted.officiality).toBe("CLAIMED");
    expect(fresh.officiality).toBe("CONFIRMED");
    expect(o.s5.DESTINATION!.supporting).toEqual([fresh.id]);
    expect(o.s5.DESTINATION!.excluded.map((e) => e.evidenceId)).toContain(adopted.id);
    expect(o.cited.filter((c) => c.component === "DESTINATION").map((c) => c.id)).toEqual([fresh.id]);
    citesOnlySupport(o);
  });

  it("F5c. fresh-only components stay fresh with Memory ON: CURRENT_STATE, EXECUTION_EVIDENCE and NET_EFFECT are never adopted even when ACTIVE rows for them exist", async () => {
    const project = await makeProject();
    const admin = await makeAdmin();
    const a = await research(project, { docs: canonDocs(project) });
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, a.jobId));
    const v = await markProofVerified(ctx.db, proof.id, admin);
    for (const c of ["CURRENT_STATE", "EXECUTION_EVIDENCE", "NET_EFFECT"]) {
      expect(v.memoryCandidates.created.map((x) => x.component)).not.toContain(c);
    }
    for (const c of v.memoryCandidates.created) await promoteToActive(ctx.db, c.memoryId, admin);
    await setMemoryEnabled(true);
    const b = await research(project, { docs: canonDocs(project) });
    for (const c of ["CURRENT_STATE", "EXECUTION_EVIDENCE", "NET_EFFECT"] as const) {
      const rows = await evidenceOf(b.jobId, c);
      expect(rows.every((r) => r.reusedFromMemoryId === null)).toBe(true);
    }
    expect(shapeOf(b)).toEqual(shapeOf(a));
  });
});

// ================================================================== 6

describe("F6. project / token ambiguity", () => {
  it("F6a. explorer pages for the legacy contract, the wrapper, and the same address on BSC, beside the canonical contract's page: only the canonical page binds; every other page is excluded ENTITY_NOT_CONFIRMED and never cited", async () => {
    const project = await makeProject({ identity: EVM, ticker: "AMB" });
    const docs = canonDocs(project, ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION", "RECIPIENT"]);
    const page = (url: string, what: string): Doc => ({
      url,
      text: `${project.name} (AMB) token tracker. ${what}`,
      facts: { EXECUTION_EVIDENCE: [{ fragment: what, mechanismState: "LIVE" }] },
    });
    const canonical = page(`https://etherscan.io/token/${EVM}`, "the buyback module executed a purchase of 9,000 AMB in block 20000100");
    const legacy = page(`https://etherscan.io/token/${EVM_LEGACY}`, "the legacy buyback module executed a purchase of 9,001 AMB in block 19000100");
    const wrapper = page(`https://etherscan.io/token/${EVM_WRAPPER}`, "the wrapper contract executed a purchase of 9,002 AMB in block 20000200");
    const bsc = page(`https://bscscan.com/token/${EVM.toLowerCase()}`, "the buyback module executed a purchase of 9,003 AMB in block 41000000");
    const multi: Doc = {
      url: docsUrl(project, "contracts"),
      text: `${project.name} contracts. Canonical token: ${EVM}. Legacy token (deprecated): ${EVM_LEGACY}. Wrapped token: ${EVM_WRAPPER}. the buyback module executed a purchase in every epoch since launch.`,
      facts: { EXECUTION_EVIDENCE: [{ fragment: "the buyback module executed a purchase in every epoch since launch", mechanismState: "LIVE" }] },
    };
    const o = await research(project, { docs: [...docs, legacy, wrapper, bsc, canonical, multi] });
    expect(o.state).toBe("SUCCEEDED");
    const rows = await evidenceOf(o.jobId, "EXECUTION_EVIDENCE");
    const byUrl = new Map(rows.map((r) => [r.retrievedUrl, r]));
    expect(byUrl.get(canonical.url)!.entityBinding).toBe("CONFIRMED");
    for (const d of [legacy, wrapper, bsc]) {
      const r = byUrl.get(d.url)!;
      expect(r.sourceClass).toBe("ONCHAIN_VERIFIABLE");
      expect(r.entityBinding).toBe("UNVERIFIED");
      // Excluded either on its own binding or because the bound page is
      // newer and supersedes it; never in the support set, never cited.
      expect(["ENTITY_NOT_CONFIRMED", "SUPERSEDED_BY_NEWER"]).toContain(o.s5.EXECUTION_EVIDENCE!.excluded.find((e) => e.evidenceId === r.id)?.reason);
      expect(o.cited.map((c) => c.url)).not.toContain(d.url);
    }
    // The official page that names three contracts is documentary, not
    // on-chain: it cannot establish EXECUTION_EVIDENCE at all.
    const multiRow = byUrl.get(multi.url)!;
    expect(o.s5.EXECUTION_EVIDENCE!.excluded.find((e) => e.evidenceId === multiRow.id)?.reason).toBe("CLASS_NOT_ADMISSIBLE");
    expect(o.s5.EXECUTION_EVIDENCE!.supporting).toEqual([byUrl.get(canonical.url)!.id]);
    citesOnlySupport(o);
  });

  it("F6b. two projects share a ticker: the other project's official page names only the ticker and ITS OWN name — since Round 5.5 (Founder decision A) it is refused WRONG_PROJECT before it becomes Evidence; it establishes nothing and is never cited", async () => {
    const x = await makeProject({ name: "Nova Protocol", ticker: "NOVA" });
    const y = await makeProject({ name: "Nova Finance", ticker: "NOVA" });
    const docsX = canonDocs(x);
    const strayY: Doc = {
      url: docsUrl(y, "destination"),
      text: `Nova Finance (NOVA) — destination. tokens purchased by the buyback module are sent to the burn address.`,
      facts: { DESTINATION: [{ fragment: CANON.DESTINATION }] },
    };
    const o = await research(x, { docs: [...docsX, strayY], search: { DESTINATION: [strayY.url, docsUrl(x, "destination")] } });
    const dest = await evidenceOf(o.jobId, "DESTINATION");
    // Round 5 pinned the old gate here (the bare ticker passed; the row was
    // persisted CLAIMED / SOCIAL and excluded CLASS_NOT_ADMISSIBLE). The
    // page is unrouted for X and carries no anchor of X — only the shared
    // ticker and Y's name — so it is now refused at the gate. The Proof is
    // what it always was: X's own docs establish, nothing of Y is cited.
    expect(dest.find((r) => r.retrievedUrl === strayY.url)).toBeUndefined();
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, o.jobId));
    expect(trace.some((t) => t.operationType === "REJECTED_WRONG_PROJECT" && t.targetRef === strayY.url)).toBe(true);
    expect(dest).toHaveLength(1);
    expect(o.s5.DESTINATION!.supporting).toEqual([dest[0].id]);
    expect(o.cited.map((c) => c.url)).not.toContain(strayY.url);
    citesOnlySupport(o);
  });

  it("F6c. ROUND 5.5 (Founder decision A) — the same shared ticker on a PUBLIC governance platform: the other project's proposal names only the ticker, is refused WRONG_PROJECT before any Evidence exists, and the Proof equals the control — SAME TICKER != SAME PROJECT", async () => {
    const x = await makeProject({ name: "Nova Protocol", ticker: "NOVA" });
    const docsX = canonDocs(x, ALL_COMPONENTS.filter((c) => c !== "GOVERNANCE_BASIS"));
    const strayGov: Doc = {
      url: `https://snapshot.org/#/nova-finance.eth/proposal/0x${"ab".repeat(16)}`,
      text: `Nova Finance (NOVA) governance. NIP-7: the allocation schedule was ratified by the token holder vote.`,
      facts: { GOVERNANCE_BASIS: [{ fragment: "the allocation schedule was ratified by the token holder vote", mechanismState: "APPROVED" }] },
    };
    const control = await research(x, { docs: docsX });
    const o = await research(x, { docs: [...docsX, strayGov], search: { GOVERNANCE_BASIS: [strayGov.url] } });
    // Round 5 pinned the old rule here: the bare ticker passed the naming
    // gate, the page was class GOVERNANCE / CLAIMED, GOVERNANCE_BASIS
    // reached PARTIALLY_SUPPORTED and the confidence cap lifted 20 -> 40.
    // The Founder decided: an unrouted document needs a stronger anchor
    // than the ticker. The page is now refused before it becomes Evidence.
    expect((await evidenceOf(o.jobId, "GOVERNANCE_BASIS")).length).toBe(0);
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, o.jobId));
    expect(trace.some((t) => t.operationType === "REJECTED_WRONG_PROJECT" && t.targetRef === strayGov.url)).toBe(true);
    expect(o.s5.GOVERNANCE_BASIS!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.GOVERNANCE_BASIS!.reasonCodes).toEqual(control.s5.GOVERNANCE_BASIS!.reasonCodes);
    expect(o.verdict).toBe(control.verdict);
    expect(o.confidence).toBe(control.confidence);
    expect(control.confidence).toBe(20);
    expect(shapeOf(o)).toEqual(shapeOf(control));
    expect(o.cited.map((c) => c.url)).not.toContain(strayGov.url);
  });
});

// ================================================================== 7

describe("F7. temporal semantics", () => {
  it("F7a. proposed (old) -> approved (older) -> active (today): only a current-enough active row answers 'is it current?'; the same row dated 30 days ago is stale for CURRENT_STATE and the answer is not CURRENT", async () => {
    const project = await makeProject();
    const base = canonDocs(project, ALL_COMPONENTS.filter((c) => c !== "CURRENT_STATE"));
    const proposed: Doc = { url: govUrl(project, "1-proposal"), text: `${project.name} proposal 1. the buyback mechanism is proposed for activation next quarter.`, facts: { MECHANISM_SPEC: [{ fragment: "the buyback mechanism is proposed for activation next quarter", mechanismState: "PROPOSED", publishedAt: daysAgo(120) }] } };
    const approved: Doc = { url: govUrl(project, "1-result"), text: `${project.name} proposal 1 result. the buyback mechanism was approved by the token holder vote.`, facts: { MECHANISM_SPEC: [{ fragment: "the buyback mechanism was approved by the token holder vote", mechanismState: "APPROVED", publishedAt: daysAgo(90) }] } };
    const activeToday: Doc = { url: docsUrl(project, "current-state"), text: `${project.name} — current state. ${CANON.CURRENT_STATE}.`, facts: { CURRENT_STATE: [{ fragment: CANON.CURRENT_STATE, mechanismState: "LIVE", publishedAt: daysAgo(0) }] } };
    const activeOld: Doc = { ...activeToday, facts: { CURRENT_STATE: [{ fragment: CANON.CURRENT_STATE, mechanismState: "LIVE", publishedAt: daysAgo(30) }] } };
    expect(DEFAULT_PRODUCT_CONFIG.memory_stale_after_days.HIGH_CHANGE).toBe(3);
    const current = await research(project, { docs: [...base, proposed, approved, activeToday], intent: "MECHANISM_CURRENT_STATE" });
    expect(current.s5.CURRENT_STATE!.status).toBe("SUPPORTED");
    expect(current.requirements).toEqual(["MCS-1:SATISFIED"]);
    // proposed -> approved -> active is a progression: the newest dated
    // state wins and the older records are superseded, not in conflict.
    expect(current.s5.MECHANISM_SPEC!.status).toBe("SUPPORTED");
    expect(current.s5.MECHANISM_SPEC!.excluded.map((e) => e.reason).sort()).toEqual(["SUPERSEDED_BY_NEWER", "SUPERSEDED_BY_NEWER"]);
    const stale = await research(project, { docs: [...base, proposed, approved, activeOld], intent: "MECHANISM_CURRENT_STATE" });
    expect(stale.s5.CURRENT_STATE!.excluded.map((e) => e.reason)).toContain("STALE_FOR_CURRENT_STATE");
    expect(stale.s5.CURRENT_STATE!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(stale.verdict).not.toBe("SUPPORTED");
    expect(stale.requirements).toEqual(["MCS-1:UNSATISFIED"]);
    nonNegative(stale);
    noStrongerThan(stale, current);
  });

  it("F7b. old active state, newer deprecated state: recency wins and the mechanism is not current; a historical execution alone never establishes current execution", async () => {
    const project = await makeProject();
    const base = canonDocs(project, ALL_COMPONENTS.filter((c) => c !== "CURRENT_STATE" && c !== "EXECUTION_EVIDENCE"));
    const oldActive: Doc = { url: docsUrl(project, "state-old"), text: `${project.name} — state. ${CANON.CURRENT_STATE}.`, facts: { CURRENT_STATE: [{ fragment: CANON.CURRENT_STATE, mechanismState: "LIVE", publishedAt: daysAgo(1) }] } };
    const newDeprecated: Doc = { url: docsUrl(project, "state-new"), text: `${project.name} — state. the buyback mechanism has been deprecated and replaced by direct staking rewards.`, facts: { CURRENT_STATE: [{ fragment: "the buyback mechanism has been deprecated and replaced by direct staking rewards", mechanismState: "DEPRECATED", publishedAt: daysAgo(0) }] } };
    const historical: Doc = { url: docsUrl(project, "history"), text: `${project.name} — history. ${CANON.EXECUTION_EVIDENCE}.`, facts: { EXECUTION_EVIDENCE: [{ fragment: CANON.EXECUTION_EVIDENCE, mechanismState: "LIVE", publishedAt: daysAgo(400) }] } };
    const o = await research(project, { docs: [...base, oldActive, newDeprecated, historical], intent: "MECHANISM_CURRENT_STATE" });
    expect(o.s5.CURRENT_STATE!.excluded.map((e) => e.reason)).toContain("SUPERSEDED_BY_NEWER");
    expect(o.s5.CURRENT_STATE!.status).not.toBe("CONTRADICTED");
    expect(o.requirements[0]).not.toBe("MCS-1:SATISFIED");
    expect(o.verdict).not.toBe("SUPPORTED");
    const noState = await research(project, { docs: [...base, historical], intent: "MECHANISM_CURRENT_STATE" });
    expect(noState.requirements).toEqual(["MCS-1:UNSATISFIED"]);
    expect(noState.verdict).toBe("INSUFFICIENT_EVIDENCE");
    nonNegative(noState);
  });
});

// ================================================================== 8

describe("F8. misleading language", () => {
  it("F8a. 'supports buybacks', 'may burn', 'intends to distribute', 'authorized', 'allocated': read as INDIRECT or CONTEXT by an honest extractor, none of them establishes; the Core never upgrades them", async () => {
    const project = await makeProject();
    const docs = canonDocs(project, ["FLOW_PATH", "GOVERNANCE_BASIS", "DURABILITY_BASIS"]);
    const vague: Doc = {
      url: docsUrl(project, "overview"),
      text: `${project.name} overview. The protocol supports buybacks funded by fees. The treasury may burn purchased tokens. The DAO intends to distribute a share of revenue to holders. Spending is authorized by governance and allocated per epoch.`,
      facts: {
        SOURCE_OF_VALUE: [{ fragment: "The protocol supports buybacks funded by fees", directness: "INDIRECT" }],
        MECHANISM_SPEC: [{ fragment: "Spending is authorized by governance and allocated per epoch", relationship: "CONTEXT" }],
        DESTINATION: [{ fragment: "The treasury may burn purchased tokens", directness: "INDIRECT" }],
        RECIPIENT: [{ fragment: "The DAO intends to distribute a share of revenue to holders", directness: "INFERRED" }],
      },
    };
    const o = await research(project, { docs: [...docs, vague] });
    expect(o.s5.SOURCE_OF_VALUE!.status).toBe("PARTIALLY_SUPPORTED");
    expect(o.s5.DESTINATION!.status).toBe("PARTIALLY_SUPPORTED");
    expect(o.s5.MECHANISM_SPEC!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.RECIPIENT!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.verdict).not.toBe("SUPPORTED");
    for (const intent of ["PASSIVE_HOLDER_OUTCOME", "BURN_OR_SUPPLY_EFFECT"] as const) {
      const q = await research(project, { docs: [...docs, vague], intent });
      expect(q.verdict).not.toBe("SUPPORTED");
      nonNegative(q);
    }
    citesOnlySupport(o);
  });

  it("F8b. 'held' is not 'received by holders' and 'removed from circulation' is not a measured reduction: the passive-holder claim is not answered by a treasury recipient, the supply claim is not answered by prose", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const rec = docs.find((d) => d.facts.RECIPIENT)!;
    rec.text = `${project.name} — recipient. purchased tokens are held by the protocol treasury multisig on behalf of the DAO.`;
    rec.facts.RECIPIENT = [{ fragment: "purchased tokens are held by the protocol treasury multisig on behalf of the DAO" }];
    const holder = await research(project, { docs, intent: "PASSIVE_HOLDER_OUTCOME" });
    expect(holder.s5.RECIPIENT!.status).toBe("SUPPORTED");
    expect(holder.verdict).not.toBe("SUPPORTED");
    const supply = await research(project, { docs, intent: "BURN_OR_SUPPLY_EFFECT" });
    expect(supply.verdict).not.toBe("SUPPORTED");
    nonNegative(supply);
  });
});

// ================================================================== 9

describe("F9. exclusion pressure", () => {
  it("F9a. many attractive but inadmissible rows and one weak admissible one: the component is at most partial, the Proof cites exactly the weak row, nothing excluded is cited or derived from", async () => {
    const project = await makeProject({ identity: EVM });
    const docs = canonDocs(project, ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION"]);
    // The docs route is withdrawn AFTER those pages are listed: the docs
    // page for RECIPIENT below is CLAIMED. The governance route stays.
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, project.docsRouteId));
    const weakGov: Doc = { url: govUrl(project, "9-recipient"), text: `${project.name} proposal 9. the accounting policy suggests the burn address ends up holding every purchased token.`, facts: { RECIPIENT: [{ fragment: "the accounting policy suggests the burn address ends up holding every purchased token", directness: "INDIRECT" }] } };
    const wrongChain: Doc = { url: `https://bscscan.com/token/${EVM.toLowerCase()}`, text: `${project.name} token. the burn address is owned by nobody and its balance is removed from circulation.`, facts: { RECIPIENT: [{ fragment: CANON.RECIPIENT }] } };
    const social: Doc = { url: `https://x.com/${project.slug}/status/9`, text: `${project.name}: ${CANON.RECIPIENT}.`, facts: { RECIPIENT: [{ fragment: CANON.RECIPIENT }] } };
    const claimedDocs = canonDocs(project, ["RECIPIENT"]);
    const o = await research(project, { docs: [...docs, ...claimedDocs, weakGov, wrongChain, social] });
    expect(o.state).toBe("SUCCEEDED");
    const rows = await evidenceOf(o.jobId, "RECIPIENT");
    expect(rows.length).toBe(4);
    const weakRow = rows.find((r) => r.retrievedUrl === weakGov.url)!;
    expect(o.s5.RECIPIENT!.status).toBe("PARTIALLY_SUPPORTED");
    expect(o.s5.RECIPIENT!.reasonCodes).toContain("INDIRECT_ONLY");
    expect(o.s5.RECIPIENT!.supporting).toEqual([weakRow.id]);
    const excludedReasons = Object.fromEntries(o.s5.RECIPIENT!.excluded.map((e) => [rows.find((r) => r.id === e.evidenceId)!.retrievedUrl, e.reason]));
    expect(excludedReasons[wrongChain.url]).toBe("ENTITY_NOT_CONFIRMED");
    expect(excludedReasons[social.url]).toBe("CLASS_NOT_ADMISSIBLE");
    expect(excludedReasons[claimedDocs[0].url]).toBe("CLASS_NOT_ADMISSIBLE");
    // The withdrawn docs route also makes every other docs page CLAIMED:
    // the revenue claim cannot be SUPPORTED, and the partial RECIPIENT row
    // is the only support the Proof may cite for that component.
    expect(o.verdict).not.toBe("SUPPORTED");
    expect(o.cited.filter((c) => c.component === "RECIPIENT").map((c) => c.id).every((id) => id === weakRow.id)).toBe(true);
    citesOnlySupport(o);
  });
});

// ================================================================== 10

describe("F10. bounded research", () => {
  it("F10a. a tiny source-open budget stops acquisition part way: the job ends in a bounded terminal state with a Proof, established components are cited, unestablished ones stay unestablished with a budget reason, nothing is fabricated", async () => {
    const project = await makeProject();
    const o = await research(project, { docs: canonDocs(project), budget: { maxSourceOpens: 3, maxSearchQueries: 3 } });
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(o.state);
    expect(o.verdict).not.toBeNull();
    expect(o.verdict).not.toBe("SUPPORTED");
    nonNegative(o);
    const established = Object.entries(o.s5).filter(([, v]) => v && (v.status === "SUPPORTED" || v.status === "PARTIALLY_SUPPORTED")).map(([k]) => k);
    const open = Object.entries(o.s5).filter(([, v]) => v === null || v.status === "INSUFFICIENT_EVIDENCE").map(([k]) => k);
    expect(established.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    // Citations are intent-scoped (PRT rests on SOURCE_OF_VALUE and
    // DESTINATION): an established one of those is cited, nothing open is.
    for (const c of established.filter((x) => x === "SOURCE_OF_VALUE" || x === "DESTINATION")) expect(o.cited.map((x) => x.component)).toContain(c);
    for (const c of open) expect(o.cited.map((x) => x.component)).not.toContain(c);
    for (const c of o.cited) expect(established).toContain(c.component);
    const boundedReasons = Object.values(o.s5).flatMap((v) => (v ? v.reasonCodes : []));
    expect(boundedReasons.some((r) => r === "SEARCH_BUDGET_EXHAUSTED" || r === "NO_EVIDENCE_FOUND")).toBe(true);
    citesOnlySupport(o);
    // The full-budget run of the same documents is the ceiling.
    const full = await research(project, { docs: canonDocs(project) });
    noStrongerThan(o, full);
  });

  it("F10b. budget exhausted with the required component already established is still not SUPPORTED when the flow's other required half is unwalked", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const o = await research(project, { docs, search: { SOURCE_OF_VALUE: [docs[0].url] }, budget: { maxSourceOpens: 1, maxSearchQueries: 1 } });
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(o.state);
    expect(o.s5.SOURCE_OF_VALUE!.status).not.toBe("INSUFFICIENT_EVIDENCE");
    expect(o.verdict).not.toBe("SUPPORTED");
    nonNegative(o);
  });
});

// ================================================================== 11

describe("F11. order independence", () => {
  it("F11a. the same documents discovered, fetched and extracted in reversed order yield the same Proof: verdict, confidence, claim, requirements, gaps, S5 picture and cited components", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    const extra: Doc = { url: docsUrl(project, "faq"), text: `${project.name} FAQ. buyback purchases are transferred to the burn address permanently. the burn address balance is removed from circulation.`, facts: { DESTINATION: [{ fragment: "buyback purchases are transferred to the burn address permanently" }], RECIPIENT: [{ fragment: "the burn address balance is removed from circulation", directness: "INDIRECT" }] } };
    const forward = [...docs, extra];
    const reversed = [...forward].reverse();
    const searchFor = (list: Doc[]) => Object.fromEntries(ALL_COMPONENTS.map((c) => [c, list.filter((d) => d.facts[c]).map((d) => d.url)])) as Partial<Record<Component, string[]>>;
    const a = await research(project, { docs: forward, search: searchFor(forward) });
    const b = await research(project, { docs: reversed, search: searchFor(reversed) });
    expect(shapeOf(b)).toEqual(shapeOf(a));
    // Flow ids embed this job's Evidence ids, so they are compared by
    // structure: the same number of flows, the same lineage components.
    const [asmA] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, a.jobId));
    const [asmB] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, b.jobId));
    const lineages = (asm: typeof asmA) => (asm.flows as { lineage: { component: string }[] }[]).map((f) => f.lineage.map((l) => l.component).join(">")).sort();
    expect(lineages(asmB)).toEqual(lineages(asmA));
    expect(b.cited.map((c) => c.url).sort()).toEqual(a.cited.map((c) => c.url).sort());
  });
});

// ================================================================== 12

describe("F12. independent review — sounding more certain than the Evidence", () => {
  it("F12a. one official page repeating the same passage for every component: a single source cannot establish a flow's mechanism beyond what each row proves, the confidence never exceeds the multi-source run, and no component is cited twice for one passage", async () => {
    const project = await makeProject();
    const one: Doc = {
      url: docsUrl(project, "tokenomics"),
      text: `${project.name} tokenomics. ${ALL_COMPONENTS.map((c) => CANON[c]).join(". ")}.`,
      facts: Object.fromEntries(ALL_COMPONENTS.map((c) => [c, [{ fragment: CANON[c], mechanismState: STATE_OF[c] ?? null }]])),
    };
    const single = await research(project, { docs: [one] });
    const multi = await research(project, { docs: canonDocs(project) });
    expect(single.state).toBe("SUCCEEDED");
    // One docs page cannot serve the governance-class components (they are
    // CLASS_NOT_ADMISSIBLE from a docs host); everything a docs page may
    // establish is identical, and the claim is never stronger.
    for (const c of ALL_COMPONENTS) {
      if (c === "GOVERNANCE_BASIS" || c === "DURABILITY_BASIS") {
        expect(single.s5[c]!.status).toBe("INSUFFICIENT_EVIDENCE");
        continue;
      }
      expect({ status: single.s5[c]!.status, reasonCodes: single.s5[c]!.reasonCodes, n: single.s5[c]!.supporting.length }).toEqual({ status: multi.s5[c]!.status, reasonCodes: multi.s5[c]!.reasonCodes, n: multi.s5[c]!.supporting.length });
    }
    noStrongerThan(single, multi);
    expect(single.requirements).toEqual(multi.requirements);
    const rows = await evidenceOf(single.jobId);
    expect(new Set(rows.map((r) => r.extractionUnitKey)).size).toBe(rows.length);
    citesOnlySupport(single);
  });

  it("F12b. the docs assert the conclusion itself ('the mechanism is verifiably deflationary and fully executed on-chain'): assertion is not measurement — the supply claim stays unanswered and the execution claim rests on nothing on-chain", async () => {
    const project = await makeProject({ identity: EVM });
    const docs = canonDocs(project, ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION", "RECIPIENT"]);
    const assertive: Doc = {
      url: docsUrl(project, "proof-of-burn"),
      text: `${project.name} proof of burn. the mechanism is verifiably deflationary and fully executed on-chain every epoch. net supply has decreased by 4.2% since launch as shown on the explorer.`,
      facts: {
        EXECUTION_EVIDENCE: [{ fragment: "the mechanism is verifiably deflationary and fully executed on-chain every epoch", mechanismState: "LIVE" }],
        NET_EFFECT: [{ fragment: "net supply has decreased by 4.2% since launch as shown on the explorer" }],
        CURRENT_STATE: [{ fragment: "fully executed on-chain every epoch", mechanismState: "LIVE" }],
      },
    };
    const o = await research(project, { docs: [...docs, assertive], intent: "VALUE_CAPTURE" });
    expect(o.s5.EXECUTION_EVIDENCE!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.NET_EFFECT!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.requirements).toContain("VC-3:UNSATISFIED");
    expect(o.verdict).not.toBe("SUPPORTED");
    nonNegative(o);
    expect(o.cited.map((c) => c.url)).not.toContain(assertive.url);
    citesOnlySupport(o);
  });
});
