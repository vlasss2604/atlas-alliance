import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  evidence,
  interpretations,
  projects,
  proofs,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import { loadAcquisitionPlan } from "../src/server/engine/acquisition-plan";
import { documentaryReachability } from "../src/server/engine/acquisition-targeting";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import {
  acquisitionBoundaryFromAttempt,
  reconcileComponent,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { EvidenceExtractionInput } from "../src/server/engine/providers/evidence-extractor";
import {
  createEvmOnchainAdapter,
  ERC20_DECIMALS_SELECTOR,
  ERC20_TOTAL_SUPPLY_SELECTOR,
} from "../src/server/engine/providers/onchain-evm";
import { __setOnchainRetriever, type OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { CONFIRMED_ROUTE_ONLY_CLASSES, resolveSourceClass } from "../src/server/engine/source-authority";
import { createNonLiveQuestionProjector } from "../src/server/engine/trace-fixture-executor";
import { installOnchainResearchCapability } from "../src/server/jobs/onchain-capability";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// BOUNDED SEARCH FINALIZATION + ROUTE-AWARE ACQUISITION V1 — regression
// coverage for two Founder-approved semantics (2026-09-15):
//
//   1. SEARCH BUDGET EXHAUSTION != TECHNICAL RESEARCH FAILURE. A refused
//      search reservation closes the component conservatively
//      (SKIPPED / SEARCH_BUDGET_EXHAUSTED → INSUFFICIENT_EVIDENCE on the
//      same reason) and the Research finalizes a bounded Proof from what
//      it actually established. The cap is untouched.
//
//   2. NO EVIDENCE SEARCH THROUGH A PROVABLY UNAVAILABLE SOURCE ROUTE. A
//      component whose every admissible documentary class needs a
//      confirmed route the project lacks (or belongs to the on-chain path
//      that already had its opportunity) spends no proposer call, no
//      search, no fetch, and closes SKIPPED / NO_ADMISSIBLE_ROUTE. Missing
//      route != evidence of absence.
//
// Everything is offline and synthetic. Hosts are fixture hosts, the chain
// is the production EVM adapter over a scripted transport, providers are
// counters. Nothing here raises a ceiling.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setOnchainRetriever(null);
});

const NOW = new Date("2026-09-15T00:00:00.000Z");
const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

/* ------------------------------------------------------------------ */
/* fixture: project, identity, routes, chain, job                       */
/* ------------------------------------------------------------------ */

let tokenSeq = 0;
function nextToken(): string {
  tokenSeq += 1;
  return "0x" + "Cd34".repeat(8) + tokenSeq.toString(16).padStart(8, "0");
}
const SUPPLY_RAW = "1000000000000000000000000000";
const word = (v: bigint | number) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

// The production EVM adapter over a scripted transport: CURRENT_STATE and
// NET_EFFECT establish their TOKEN_SUPPLY on-chain, exactly as A2-prime did.
function installEvm() {
  const calls: string[] = [];
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      calls.push(method);
      if (method === "eth_chainId") return envelope("0x1");
      if (method === "eth_getBlockByNumber") return envelope({ number: "0x1234abc", hash: "0x" + "ef".repeat(32), timestamp: "0x66f2a1c0" });
      if (method === "eth_call") {
        const data = (params[0] as { data: string }).data;
        if (data === ERC20_TOTAL_SUPPLY_SELECTOR) return envelope(word(BigInt(SUPPLY_RAW)));
        if (data === ERC20_DECIMALS_SELECTOR) return envelope(word(18));
      }
      throw new Error(`fixture: unexpected ${method}`);
    },
  };
  const adapter = createEvmOnchainAdapter({ transport, providerId: "fixture-evm-rpc", environment: { chain: "ethereum", network: "mainnet" } });
  installOnchainResearchCapability({
    capabilities: new Set(["SEARCH_EXTRACT"]),
    env: { ONCHAIN_RESEARCH_ENABLED: "1", ETHEREUM_MAINNET_RPC_URL: "https://fixture.invalid/rpc" },
    create: (chain, network) => (chain === "ethereum" && network === "mainnet" ? adapter : null),
  });
  return { calls };
}

type RouteClass = "OFFICIAL_DOCS" | "GOVERNANCE" | "OFFICIAL_REPORT";
interface Fixture {
  id: string;
  name: string;
  slug: string;
  ticker: string | null;
  // Confirmed + classified route hosts, by class.
  hosts: Partial<Record<RouteClass, string>>;
}

async function makeProject(opts: { chain?: "ethereum" | "solana"; routes?: RouteClass[]; identity?: boolean } = {}): Promise<Fixture> {
  const slug = uniq("bsf");
  const name = "Bounded Fixture";
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  if (opts.identity !== false) {
    const identity =
      (opts.chain ?? "ethereum") === "ethereum"
        ? await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "ethereum", tokenAddress: nextToken(), ticker: "T" })
        : await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" });
    if (!identity.ok) throw new Error("identity fixture failed: " + identity.refusal);
  }
  const hosts: Partial<Record<RouteClass, string>> = {};
  for (const cls of opts.routes ?? ["OFFICIAL_DOCS"]) {
    const host = `${cls.toLowerCase().replace(/_/g, "-")}.${uniq("h").replace(/_/g, "-")}.test`;
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
    if (!confirmed.ok) throw new Error(`confirm ${cls} failed: ${confirmed.refusal}`);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: cls });
    if (!classified.ok) throw new Error(`classify ${cls} failed: ${classified.refusal}`);
    hosts[cls] = host;
  }
  return { id: project.id, name, slug, ticker: null, hosts };
}

// A PRODUCT job under the alpha envelope (12 searches / 24 opens / $2), with
// the interpretation A2-prime carried, so SOURCE_OF_VALUE and DESTINATION
// are intent-required exactly as they were live.
async function makeJob(project: Fixture, opts: { maxSearchQueries?: number; enqueue?: boolean } = {}): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const question = "how does value generated by the protocol flow through the DAO, and does any of it reach the token?";
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "value flow to token" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: {
        ...coreEntitlement(),
        budget: { ...INTERNAL_ALPHA_V1, maxSearchQueries: opts.maxSearchQueries ?? INTERNAL_ALPHA_V1.maxSearchQueries },
      },
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
      task_type: "TOKEN_VALUE",
      research_task: "determine whether and how value generated by the protocol reaches token holders",
      understood_summary: null,
      user_assumptions: [],
      ambiguities: [],
      clarification_question: null,
      route: "DEEP_RESEARCH",
      normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN",
      intent_confidence: 0.85,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  if (!opts.enqueue) await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function workItem(jobId: string, component: string): Promise<ComponentWorkItem> {
  const { view } = await loadJobContractView(ctx.db, jobId);
  const item = view.workQueue.find((i) => i.component === component);
  if (!item) throw new Error(`fixture: ${component} is not in the work queue`);
  return item;
}

async function trace(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

async function budget(jobId: string) {
  const [row] = await ctx.db
    .select({ searchQueries: researchJobs.searchQueriesReserved, sourceOpens: researchJobs.sourceOpensReserved, modelCostMicro: researchJobs.modelCostMicroReserved, state: researchJobs.state, terminationReason: researchJobs.terminationReason, errorCode: researchJobs.errorCode })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row;
}

const FRAGMENT = "the protocol fee accrues directly to the treasury contract";

function docFor(url: string, text: string): FetchedDocument {
  return { finalUrl: url, requestedUrl: url, httpStatus: 200, contentType: "text/html", normalizedText: text, contentHash: `sha256:${url}`, fetchedAt: NOW, byteLength: text.length };
}

function factFor(item: { step: number; component: string }): ExtractedFact {
  return {
    step: item.step,
    component: item.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: FRAGMENT,
    mechanismState: "LIVE",
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
  };
}

// The live-shaped documentary providers: a `site:<host>` query returns five
// pages on that host; a generic query returns five social pages (which S5
// excludes as CLASS_NOT_ADMISSIBLE, exactly as A2-prime's did). Every page
// names the project and carries the fragment.
function providers(project: Fixture) {
  const counters = { proposer: 0, search: 0, fetch: 0, extract: 0 };
  const perComponent = new Map<string, { proposer: number; search: number; fetch: number; extract: number }>();
  const bump = (component: string, key: "proposer" | "search" | "fetch" | "extract") => {
    counters[key] += 1;
    const c = perComponent.get(component) ?? { proposer: 0, search: 0, fetch: 0, extract: 0 };
    c[key] += 1;
    perComponent.set(component, c);
  };
  const fetcher: ContentFetcher = {
    name: "live-transport",
    async fetch(url: string) {
      const host = new URL(url).hostname;
      const known = Object.values(project.hosts).includes(host) || host === "twitter.com";
      if (!known) throw new ContentFetchError("HTTP_ERROR", "fixture: 404", url, 404);
      return docFor(url, `${project.name} documentation: ${FRAGMENT}. Page ${url}.`);
    },
  };
  let currentComponent = "";
  const fetchCalls: string[] = [];
  const deps = {
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries() {
        bump(currentComponent, "proposer");
        // Component-specific text, as a live proposer produces — an
        // identical string across components would be a D-152 replay and
        // spend nothing, which is not the live shape.
        const c = currentComponent.toLowerCase().replace(/_/g, "-");
        return [`${c} flow`, `${c} treasury`, `${c} revenue`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query: string) {
        bump(currentComponent, "search");
        // A fixed corpus per host, as a real site has: later components
        // meet pages the job already sealed and replay them unmetered,
        // which is the live open profile (A2-prime: 13 of 24 opens used).
        const m = /^site:(\S+)\s/.exec(query);
        const host = m ? m[1] : "twitter.com";
        return [1, 2, 3].map((i) => ({ url: `https://${host}/docs/page-${i}`, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: fetcher.name,
      async fetch(url: string) {
        bump(currentComponent, "fetch");
        fetchCalls.push(url);
        return fetcher.fetch(url);
      },
    },
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input: EvidenceExtractionInput) {
        bump(currentComponent, "extract");
        return [factFor(input.target)];
      },
    },
  };
  const setComponent = (c: string) => {
    currentComponent = c;
  };
  return { deps, counters, perComponent, fetchCalls, setComponent };
}

function executorFor(project: Fixture, p: ReturnType<typeof providers>) {
  const inner = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    ...p.deps,
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
  // Tags each provider call with the component being executed.
  return {
    async execute(item: ComponentWorkItem, c: Parameters<typeof inner.execute>[1]) {
      p.setComponent(item.component);
      return inner.execute(item, c);
    },
  };
}

async function runWholeJob(project: Fixture, jobId: string) {
  const p = providers(project);
  const executor = executorFor(project, p);
  const result = await handleResearchJobTask(ctx.db, jobId, executor, { questionProjector: createNonLiveQuestionProjector() });
  expect(result).toEqual({ claimed: true });
  return p;
}

async function s5(jobId: string) {
  const rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  return new Map(rows.map((r) => [r.component, r]));
}

async function attempts(jobId: string) {
  return ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
}

/* ------------------------------------------------------------------ */
/* the pure rules                                                       */
/* ------------------------------------------------------------------ */

describe("the reachability rule, asked of the classifier that owns the classes", () => {
  it("only OFFICIAL_DOCS and OFFICIAL_REPORT are assignable solely from a confirmed route; every other class has a public rule", () => {
    expect([...CONFIRMED_ROUTE_ONLY_CLASSES].sort()).toEqual(["OFFICIAL_DOCS", "OFFICIAL_REPORT"]);
    // No route: a docs-looking host is never OFFICIAL_DOCS/OFFICIAL_REPORT.
    for (const url of ["https://docs.some-project.test/x", "https://some-project.test/report.pdf", "https://snapshot.org/#/dao"]) {
      expect(CONFIRMED_ROUTE_ONLY_CLASSES.has(resolveSourceClass(url, "OTHER", null))).toBe(false);
    }
    // Each other class is reachable without any route through a code-owned rule.
    expect(resolveSourceClass("https://snapshot.org/#/dao/proposal/1", "OTHER", null)).toBe("GOVERNANCE");
    expect(resolveSourceClass("https://etherscan.io/token/0xabc", "OTHER", null)).toBe("ONCHAIN_VERIFIABLE");
    expect(resolveSourceClass("https://dune.com/q/1", "OTHER", null)).toBe("DATA_PROVIDER");
    expect(resolveSourceClass("https://twitter.com/x/status/1", "OTHER", null)).toBe("SOCIAL");
    expect(resolveSourceClass("https://example-news.test/a", "NEWS", null)).toBe("RESEARCH_MEDIA");
    // And a route DOES give the two: the same rule the project's confirmed
    // routes exercise (an unclassified fixture host, route class set).
    expect(resolveSourceClass("https://docs.some-project.test/x", "OTHER", "OFFICIAL_DOCS")).toBe("OFFICIAL_DOCS");
    expect(resolveSourceClass("https://some-project.test/report", "OTHER", "OFFICIAL_REPORT")).toBe("OFFICIAL_REPORT");
  });

  it("route-only classes need a confirmed route; ONCHAIN needs the explorer open to be the mechanism; the rest are always reachable; mixed keeps its reachable class; empty is not decided here", () => {
    const none = {};
    const docs = { OFFICIAL_DOCS: ["docs.p.test"] };
    // A. only route-only classes, no route → unreachable.
    expect(documentaryReachability({ establishingClasses: ["OFFICIAL_REPORT"], confirmedRouteDomainsByClass: none, explorerOpenIsTheMechanism: false })).toMatchObject({ reachable: false, unreachableClasses: ["OFFICIAL_REPORT"] });
    expect(documentaryReachability({ establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"], confirmedRouteDomainsByClass: none, explorerOpenIsTheMechanism: false }).reachable).toBe(false);
    // B. the same with the route confirmed → reachable.
    expect(documentaryReachability({ establishingClasses: ["OFFICIAL_DOCS"], confirmedRouteDomainsByClass: docs, explorerOpenIsTheMechanism: false })).toMatchObject({ reachable: true, reachableClasses: ["OFFICIAL_DOCS"] });
    // C. mixed: OFFICIAL_DOCS route present, GOVERNANCE route absent →
    // reachable through the docs route (and GOVERNANCE is itself reachable
    // through code-owned governance portals).
    expect(documentaryReachability({ establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"], confirmedRouteDomainsByClass: docs, explorerOpenIsTheMechanism: false })).toMatchObject({ reachable: true, reachableClasses: ["OFFICIAL_DOCS", "GOVERNANCE"] });
    // GOVERNANCE-only with no route is NOT provably unreachable under the
    // existing model: a governance portal page classifies GOVERNANCE.
    expect(documentaryReachability({ establishingClasses: ["GOVERNANCE"], confirmedRouteDomainsByClass: none, explorerOpenIsTheMechanism: false }).reachable).toBe(true);
    // ONCHAIN alone: reachable only when the explorer open is the mechanism.
    expect(documentaryReachability({ establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedRouteDomainsByClass: none, explorerOpenIsTheMechanism: true }).reachable).toBe(true);
    expect(documentaryReachability({ establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedRouteDomainsByClass: none, explorerOpenIsTheMechanism: false }).reachable).toBe(false);
    // Empty contract: a Pattern matter, not an acquisition boundary.
    expect(documentaryReachability({ establishingClasses: [], confirmedRouteDomainsByClass: none, explorerOpenIsTheMechanism: false }).reachable).toBe(true);
  });

  it("the reducer names the boundary only for a SKIPPED attempt whose reason starts with it, and only when it has no Evidence", () => {
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "SEARCH_BUDGET_EXHAUSTED; source-route observations: X" })).toBe("SEARCH_BUDGET_EXHAUSTED");
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "NO_ADMISSIBLE_ROUTE" })).toBe("NO_ADMISSIBLE_ROUTE");
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT; source-route observations: SEARCH_BUDGET_EXHAUSTED" })).toBeNull();
    expect(acquisitionBoundaryFromAttempt({ status: "FAILED", reason: "SEARCH_BUDGET_EXHAUSTED" })).toBeNull();
    expect(acquisitionBoundaryFromAttempt({ status: "STARTED", reason: null })).toBeNull();
    expect(acquisitionBoundaryFromAttempt(null)).toBeNull();

    const item = { step: 3, component: "MECHANISM_SPEC" };
    const base = {
      jobId: "j",
      item,
      requirements: {
        component: "MECHANISM_SPEC",
        establishingClasses: ["OFFICIAL_DOCS" as const, "GOVERNANCE" as const],
        requiresCurrentState: false,
        requiresLiveMechanismState: false,
        freshnessClass: "LOW_CHANGE" as const,
        tokenStateSensitive: false,
        requiredTokenState: null,
      },
      evidence: [] as EvidenceRow[],
      now: NOW,
      freshnessPolicyDays: { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 },
    };
    expect(reconcileComponent(base)).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] });
    expect(reconcileComponent({ ...base, acquisitionBoundary: "SEARCH_BUDGET_EXHAUSTED" })).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], contradictingEvidenceIds: [] });
    expect(reconcileComponent({ ...base, acquisitionBoundary: "NO_ADMISSIBLE_ROUTE" })).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"], contradictingEvidenceIds: [] });
  });

  it("neither boundary strengthens confidence, and neither is a contradiction or a claim of absence", () => {
    const src = readFileSync("src/server/engine/proof-confidence.ts", "utf-8");
    expect(src).toMatch(/SEARCH_BUDGET_EXHAUSTED: CONFIDENCE_BANDS\.LOW/);
    expect(src).toMatch(/NO_ADMISSIBLE_ROUTE: CONFIDENCE_BANDS\.LOW/);
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    // The route close and the budget close return SKIPPED, never FAILED,
    // never CONTRADICTED, and never NO_EVIDENCE_FOUND.
    expect(executor).toContain('return { status: "SKIPPED", reason: withObservations("NO_ADMISSIBLE_ROUTE"), spent };');
    expect(executor).toContain('return { status: "SKIPPED", reason: withObservations("SEARCH_BUDGET_EXHAUSTED"), spent };');
    // No project, chain, token or component in the rule.
    const targeting = readFileSync("src/server/engine/acquisition-targeting.ts", "utf-8");
    const start = targeting.indexOf("export function documentaryReachability(");
    const body = targeting.slice(start, targeting.indexOf("\n}\n", start));
    expect(body).not.toMatch(/lido|raydium|pump|solana|ethereum|etherscan|solscan|SOURCE_OF_VALUE|MECHANISM_SPEC|EXECUTION_EVIDENCE|GOVERNANCE_BASIS/i);
  });
});

/* ------------------------------------------------------------------ */
/* route-aware acquisition on the real executor                         */
/* ------------------------------------------------------------------ */

describe("route-aware acquisition — the executor spends nothing on a provably unreachable obligation", () => {
  it("A/E. EXECUTION_EVIDENCE (ONCHAIN owned + OFFICIAL_REPORT, no report route): zero proposer, zero search, zero fetch, zero search budget, SKIPPED / NO_ADMISSIBLE_ROUTE → S5 INSUFFICIENT_EVIDENCE [NO_ADMISSIBLE_ROUTE]", async () => {
    installEvm();
    const project = await makeProject({ routes: ["OFFICIAL_DOCS"] });
    const jobId = await makeJob(project);
    const item = await workItem(jobId, "EXECUTION_EVIDENCE");
    const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
    expect(plan.establishingClasses).toEqual(["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"]);
    const p = providers(project);
    const result = await executorFor(project, p).execute(item, {
      jobId,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: 12, maxSourceOpens: 24, maxModelCostMicro: 2_000_000 },
    });
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toMatch(/^NO_ADMISSIBLE_ROUTE/);
    expect(result.reason).toContain("CLASS_REQUIRES_CONFIRMED_ROUTE:OFFICIAL_REPORT");
    expect(p.counters).toEqual({ proposer: 0, search: 0, fetch: 0, extract: 0 });
    const b = await budget(jobId);
    expect(b.searchQueries).toBe(0);
    expect(b.modelCostMicro).toBe(0);
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "MODEL_CALL_SKIPPED" && r.providerKind === "QUERY_PROPOSE")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "SEARCH_EXECUTED" || r.operationType === "FETCH_ATTEMPTED")).toHaveLength(0);
    // No attempt row exists in a bare executor run — insert one shaped as
    // the controller's terminal UPDATE would leave it, then reconcile.
    await ctx.db.insert(researchAttempts).values({ researchJobId: jobId, patternStep: item.step, component: item.component, attemptNumber: 1, status: "SKIPPED", reason: result.reason ?? null, completedAt: NOW });
    const s5row = await reconcileAndPersistComponent(ctx.db, jobId, item, NOW);
    // D. Not a claim that the mechanism is absent: INSUFFICIENT on the
    // named boundary, no contradiction, no exclusion.
    expect(s5row).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"], contradictingEvidenceIds: [], excludedEvidence: [] });
  });

  it("B. the same component with a confirmed OFFICIAL_REPORT route: ordinary acquisition runs", async () => {
    installEvm();
    const project = await makeProject({ routes: ["OFFICIAL_DOCS", "OFFICIAL_REPORT"] });
    const jobId = await makeJob(project);
    const item = await workItem(jobId, "EXECUTION_EVIDENCE");
    const p = providers(project);
    const result = await executorFor(project, p).execute(item, {
      jobId,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: 12, maxSourceOpens: 24, maxModelCostMicro: 2_000_000 },
    });
    expect(result.reason).not.toContain("NO_ADMISSIBLE_ROUTE");
    expect(p.counters.proposer).toBe(1);
    expect(p.counters.search).toBeGreaterThan(0);
    expect(p.fetchCalls.some((u) => new URL(u).hostname === project.hosts.OFFICIAL_REPORT)).toBe(true);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("C. a mixed component (OFFICIAL_DOCS + GOVERNANCE) with the docs route and no governance route still researches through the docs route", async () => {
    installEvm();
    const project = await makeProject({ routes: ["OFFICIAL_DOCS"] });
    const jobId = await makeJob(project);
    const item = await workItem(jobId, "MECHANISM_SPEC");
    const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
    expect(plan.establishingClasses).toEqual(["OFFICIAL_DOCS", "GOVERNANCE"]);
    expect(plan.confirmedRouteDomainsByClass.GOVERNANCE ?? []).toEqual([]);
    const p = providers(project);
    const result = await executorFor(project, p).execute(item, {
      jobId,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: 12, maxSourceOpens: 24, maxModelCostMicro: 2_000_000 },
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).not.toContain("NO_ADMISSIBLE_ROUTE");
    expect(result.reason).toContain("CLASS_REQUIRES_CONFIRMED_ROUTE:GOVERNANCE");
    expect(p.counters.proposer).toBe(1);
    // The docs route was searched and read; the missing governance route
    // suppressed nothing.
    expect(p.fetchCalls.some((u) => new URL(u).hostname === project.hosts.OFFICIAL_DOCS)).toBe(true);
    expect(p.fetchCalls.some((u) => new URL(u).hostname === "twitter.com")).toBe(true);
  });

  it("G/H. no route is created or confirmed by acquisition, and the rule is the same on Solana and on EVM", async () => {
    for (const chain of ["ethereum", "solana"] as const) {
      const project = await makeProject({ chain, routes: ["OFFICIAL_DOCS"] });
      if (chain === "ethereum") installEvm();
      else
        __setOnchainRetriever(
          { name: "fixture-retriever", supports: () => true, retrieve: async () => { throw new Error("fixture: nothing"); } },
          { chain: "solana", network: "mainnet" },
        );
      const jobId = await makeJob(project);
      const item = await workItem(jobId, "EXECUTION_EVIDENCE");
      const before = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
      const p = providers(project);
      const result = await executorFor(project, p).execute(item, {
        jobId,
        attemptNumber: 1,
        isRecoveryAttempt: false,
        budget: { maxSearchQueries: 12, maxSourceOpens: 24, maxModelCostMicro: 2_000_000 },
      });
      expect(result.status, chain).toBe("SKIPPED");
      expect(result.reason, chain).toMatch(/^NO_ADMISSIBLE_ROUTE/);
      expect(p.counters, chain).toEqual({ proposer: 0, search: 0, fetch: 0, extract: 0 });
      // Routes untouched: still exactly the one the fixture confirmed.
      const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
      expect(Object.keys(plan.confirmedRouteDomainsByClass).sort(), chain).toEqual(["OFFICIAL_DOCS"]);
      expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId)), chain).toEqual(before);
      __setOnchainRetriever(null);
    }
  });
});

/* ------------------------------------------------------------------ */
/* bounded search finalization on the real executor                     */
/* ------------------------------------------------------------------ */

describe("bounded search finalization — the executor", () => {
  const ctxFor = (jobId: string, maxSearchQueries: number) => ({
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries, maxSourceOpens: 24, maxModelCostMicro: 2_000_000 },
  });

  it("A. with capacity, behaviour is unchanged", async () => {
    installEvm();
    const project = await makeProject();
    const jobId = await makeJob(project);
    const item = await workItem(jobId, "MECHANISM_SPEC");
    const p = providers(project);
    const result = await executorFor(project, p).execute(item, ctxFor(jobId, 12));
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).not.toContain("SEARCH_BUDGET_EXHAUSTED");
    expect(p.counters.proposer).toBe(1);
    expect(p.counters.search).toBeGreaterThan(0);
  });

  it("B/E/F. axis exactly exhausted before the component: no proposer, no search, no reservation, SKIPPED / SEARCH_BUDGET_EXHAUSTED, cap unchanged", async () => {
    installEvm();
    const project = await makeProject();
    const jobId = await makeJob(project);
    await ctx.db.update(researchJobs).set({ searchQueriesReserved: 12 }).where(eq(researchJobs.id, jobId));
    const item = await workItem(jobId, "MECHANISM_SPEC");
    const p = providers(project);
    const result = await executorFor(project, p).execute(item, ctxFor(jobId, 12));
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toMatch(/^SEARCH_BUDGET_EXHAUSTED/);
    expect(p.counters).toEqual({ proposer: 0, search: 0, fetch: 0, extract: 0 });
    expect((await budget(jobId)).searchQueries).toBe(12);
    const rows = await trace(jobId);
    const skip = rows.filter((r) => r.operationType === "MODEL_CALL_SKIPPED" && r.providerKind === "QUERY_PROPOSE");
    expect(skip).toHaveLength(1);
    expect(skip[0].reasonCode).toBe("SEARCH_QUERY_BUDGET_EXHAUSTED");
    expect(skip[0].budgetAmount).toBe(0);
  });

  it("mid-attempt refusal: the refused query is recorded, no later query is tried, the paid candidates are still read, and the close is bounded", async () => {
    installEvm();
    const project = await makeProject();
    const jobId = await makeJob(project);
    // One unit left for a component that would plan several queries.
    await ctx.db.update(researchJobs).set({ searchQueriesReserved: 11 }).where(eq(researchJobs.id, jobId));
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    const p = providers(project);
    // The last component (full 3-query cap) with one unit left: the first
    // query runs, the second is refused, the third is never tried.
    const result = await executorFor(project, p).execute(item, { ...ctxFor(jobId, 12), workQueueSize: 10, remainingComponents: 1 });
    // Exactly one real search (the unit that was left), the refusal on the
    // next, and the candidates of the paid search read.
    expect(p.counters.search).toBe(1);
    expect(p.counters.fetch).toBeGreaterThan(0);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain("SEARCH_BUDGET_EXHAUSTED");
    expect((await budget(jobId)).searchQueries).toBe(12);
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "SEARCH_EXECUTED" && r.status === "OK")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "SEARCH_EXECUTED" && r.status === "SKIPPED" && r.reasonCode === "SEARCH_QUERY_BUDGET_EXHAUSTED")).toHaveLength(1);
  });

  it("G. the source-open axis keeps its own contract: a refused open still throws after the paid documents are read", async () => {
    installEvm();
    const project = await makeProject();
    const jobId = await makeJob(project);
    await ctx.db.update(researchJobs).set({ sourceOpensReserved: 24 }).where(eq(researchJobs.id, jobId));
    const item = await workItem(jobId, "MECHANISM_SPEC");
    const p = providers(project);
    await expect(executorFor(project, p).execute(item, ctxFor(jobId, 12))).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(p.counters.fetch).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* the whole Research: A2-prime shape, before/after, terminal semantics  */
/* ------------------------------------------------------------------ */

describe("A2-prime shape, whole Research through the worker handler", () => {
  it("1-4. productive components search; the route-unreachable one spends nothing; the 12-search cap holds and the job finalizes WORK_QUEUE_EXHAUSTED with a Proof", async () => {
    const evm = installEvm();
    const project = await makeProject({ routes: ["OFFICIAL_DOCS"] });
    const jobId = await makeJob(project, { enqueue: true });
    const p = await runWholeJob(project, jobId);

    const b = await budget(jobId);
    expect(b.state).toBe("SUCCEEDED");
    expect(b.terminationReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(b.errorCode).toBeNull();
    // The cap is hard and unchanged.
    expect(b.searchQueries).toBeLessThanOrEqual(12);
    expect(p.counters.search).toBe(b.searchQueries);

    const per = p.perComponent;
    const searched = (c: string) => per.get(c)?.search ?? 0;
    // 1-3. the productive documentary components remain searchable.
    for (const c of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "RECIPIENT", "DESTINATION"]) {
      expect(searched(c), c).toBeGreaterThan(0);
      expect(per.get(c)?.proposer, c).toBe(1);
    }
    // 4. the route-unreachable obligation spends nothing.
    expect(per.get("EXECUTION_EVIDENCE")).toBeUndefined();
    // On-chain components establish deterministically, no documentary spend.
    expect(per.get("CURRENT_STATE")).toBeUndefined();
    expect(per.get("NET_EFFECT")).toBeUndefined();
    expect(evm.calls.length).toBeGreaterThan(0);

    // 5. no whole-Research budget stop, no STARTED attempt.
    const att = await attempts(jobId);
    expect(att.every((a) => a.status !== "STARTED")).toBe(true);
    expect(att.find((a) => a.component === "EXECUTION_EVIDENCE")?.status).toBe("SKIPPED");
    expect(att.find((a) => a.component === "EXECUTION_EVIDENCE")?.reason).toMatch(/^NO_ADMISSIBLE_ROUTE/);
    // 6. completed Evidence survives; S5/S7/S8 finalize.
    const s5rows = await s5(jobId);
    expect(s5rows.get("FLOW_PATH")?.status).toBe("SUPPORTED");
    expect(s5rows.get("MECHANISM_SPEC")?.status).toBe("SUPPORTED");
    expect(s5rows.get("EXECUTION_EVIDENCE")).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"] });
    expect(s5rows.get("DURABILITY_BASIS")).toBeDefined();
    const s7 = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(s7).toHaveLength(1);
    const proof = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof).toHaveLength(1);
    expect(proof[0].verificationStatus).toBe("DRAFT");

    // Reported, not asserted as a live prediction: the fixture's own
    // per-component search distribution under the 12-unit cap.
    const table = [...per.entries()].map(([c, v]) => `${c}=${v.search}`).join(" ");
    console.log(`[a2-prime fixture] searches=${b.searchQueries} opens=${b.sourceOpens} proposer=${p.counters.proposer} extract=${p.counters.extract} | ${table}`);
    console.log(`[a2-prime fixture] refused searches=${(await trace(jobId)).filter((r) => r.operationType === "SEARCH_EXECUTED" && r.status === "SKIPPED").length}`);
  }, 60_000);

  it("5-6. with the search cap deliberately below the queue's need, the Research still finalizes: later components close SKIPPED / SEARCH_BUDGET_EXHAUSTED, earlier Evidence survives, no STARTED attempt, a Proof exists", async () => {
    installEvm();
    const project = await makeProject({ routes: ["OFFICIAL_DOCS"] });
    const jobId = await makeJob(project, { enqueue: true, maxSearchQueries: 4 });
    const p = await runWholeJob(project, jobId);

    const b = await budget(jobId);
    // BEFORE (20cd1da): BUDGET_LIMIT_REACHED / BUDGET_EXHAUSTED, the
    // refused component left STARTED, no S5 row for it. AFTER: the
    // ordinary bounded terminal path.
    expect(b.state).toBe("SUCCEEDED");
    expect(b.terminationReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(b.errorCode).toBeNull();
    expect(b.searchQueries).toBe(4);
    expect(p.counters.search).toBe(4);

    const att = await attempts(jobId);
    expect(att.every((a) => a.status !== "STARTED")).toBe(true);
    const bounded = att.filter((a) => a.status === "SKIPPED" && /^SEARCH_BUDGET_EXHAUSTED/.test(a.reason ?? ""));
    expect(bounded.length).toBeGreaterThan(0);
    // No provider call after the axis was spent: every bounded component
    // has neither a proposer call nor a search in the counters.
    for (const a of bounded) {
      const c = p.perComponent.get(a.component);
      expect(c?.proposer ?? 0, a.component).toBe(0);
      expect(c?.search ?? 0, a.component).toBe(0);
    }
    const rows = await trace(jobId);
    const skips = rows.filter((r) => r.operationType === "MODEL_CALL_SKIPPED" && r.reasonCode === "SEARCH_QUERY_BUDGET_EXHAUSTED");
    expect(skips.length).toBe(bounded.filter((a) => (p.perComponent.get(a.component)?.search ?? 0) === 0).length);

    // C/D. earlier Evidence survives and is reduced normally; the bounded
    // components are INSUFFICIENT on the boundary, never contradicted.
    const s5rows = await s5(jobId);
    expect([...s5rows.values()].some((r) => r.status === "SUPPORTED" || r.status === "PARTIALLY_SUPPORTED")).toBe(true);
    for (const a of bounded) {
      expect(s5rows.get(a.component), a.component).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], contradictingEvidenceIds: [] });
    }
    expect([...s5rows.values()].every((r) => r.status !== "CONTRADICTED")).toBe(true);
    const s7 = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(s7).toHaveLength(1);
    expect(await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId))).toHaveLength(1);
  }, 60_000);

  it("C. a component that already holds Evidence is reduced from that Evidence even when its own later search is refused", async () => {
    installEvm();
    const project = await makeProject();
    const jobId = await makeJob(project);
    const item = await workItem(jobId, "SOURCE_OF_VALUE");
    // Attempt 1 with capacity: Evidence lands.
    const p1 = providers(project);
    const first = await executorFor(project, p1).execute(item, { jobId, attemptNumber: 1, isRecoveryAttempt: false, budget: { maxSearchQueries: 12, maxSourceOpens: 24, maxModelCostMicro: 2_000_000 } });
    expect(first.status).toBe("SUCCEEDED");
    const ev = await ctx.db.select().from(evidence).where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, item.component)));
    expect(ev.length).toBeGreaterThan(0);
    // Attempt 2 with the axis spent: bounded close.
    await ctx.db.update(researchJobs).set({ searchQueriesReserved: 12 }).where(eq(researchJobs.id, jobId));
    const p2 = providers(project);
    const second = await executorFor(project, p2).execute(item, { jobId, attemptNumber: 2, isRecoveryAttempt: true, budget: { maxSearchQueries: 12, maxSourceOpens: 24, maxModelCostMicro: 2_000_000 } });
    expect(second.status).toBe("SKIPPED");
    expect(second.reason).toMatch(/^SEARCH_BUDGET_EXHAUSTED/);
    await ctx.db.insert(researchAttempts).values({ researchJobId: jobId, patternStep: item.step, component: item.component, attemptNumber: 2, status: "SKIPPED", reason: second.reason ?? null, completedAt: NOW });
    // The reducer sees the Evidence and evaluates it normally: the boundary
    // never erases prior Evidence and never becomes the reason.
    const s5row = await reconcileAndPersistComponent(ctx.db, jobId, item, NOW);
    expect(s5row.status).not.toBe("INSUFFICIENT_EVIDENCE");
    expect(s5row.reasonCodes).not.toContain("SEARCH_BUDGET_EXHAUSTED");
    expect(s5row.reasonCodes).not.toContain("NO_EVIDENCE_FOUND");
    expect(s5row.supportingEvidenceIds.length).toBeGreaterThan(0);
  });
});
