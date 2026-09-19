import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  interpretations,
  productConfig,
  projects,
  proofs,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  topics,
  users,
} from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import { createEvmOnchainAdapter, ERC20_DECIMALS_SELECTOR, ERC20_TOTAL_SUPPLY_SELECTOR } from "../src/server/engine/providers/onchain-evm";
import { __setOnchainRetriever, type OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { installOnchainResearchCapability } from "../src/server/jobs/onchain-capability";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ROUND 6.5 — FOUNDER SEMANTIC HARDENING, THE PERSISTED RESEARCH.
//
// Founder decision 1 (2026-09-16), on Round 6's F8b:
//
//   TECHNICAL FAILURE != STRONGER PROJECT REALITY. Technical degradation
//   must never make the semantic Research result stronger.
//
// The defect: a deterministic TOKEN_SUPPLY reading closed CURRENT_STATE's
// acquisition (ONCHAIN_EVIDENCE_ESTABLISHED) although it carries no
// mechanism state, so the official current-state page was never read
// while the chain worked — and was read when the RPC was down. The
// correction (s4-executor.ts, step 0b): a chain read closes a component
// only when its rows carry the state the component reports (Pattern:
// requiresCurrentState / requiresLiveMechanismState); otherwise the rows
// stay and the documentary pass runs within the same bounds, and the
// attempt closes on the rows it holds. Founder decision 3 (the D-101
// over-splitting correction) is what lets the two CURRENT_STATE rows —
// two slots, a fork — leave the revenue claim exactly where the RPC-down
// world leaves it.
//
// Real S4 executor, real lifecycle, real Postgres; fixture providers only
// (no model, no network, no RPC, no spend). Not an adversarial round; does
// not count toward the two clean rounds.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(async () => {
  __setOnchainRetriever(null);
  await ctx.db.insert(productConfig).values({ key: "memory_enabled", value: false }).onConflictDoUpdate({ target: productConfig.key, set: { value: false } });
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

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

interface Project {
  id: string;
  slug: string;
  name: string;
  host: string;
  govHost: string;
}

async function makeProject(): Promise<Project> {
  const slug = uniq("r65");
  const name = `Round Six Five ${slug.replace(/_/g, " ")}`;
  const host = `docs.${slug.replace(/_/g, "-")}.example`;
  const govHost = `vote.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE", ticker: null }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const docsClass = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!docsClass.ok) throw new Error("docs classify failed: " + docsClass.refusal);
  const gov = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: govHost, pathPrefix: "/proposals" });
  if (!gov.ok) throw new Error("gov confirm failed: " + gov.refusal);
  const govClass = await classifySourceRoute(ctx.db, { routeId: gov.itemId, routeClass: "GOVERNANCE" });
  if (!govClass.ok) throw new Error("gov classify failed: " + govClass.refusal);
  const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "ethereum", tokenAddress: EVM, ticker: "R65" });
  if (!r.ok) throw new Error("identity failed: " + r.refusal);
  return { id: p.id, slug, name, host, govHost };
}

interface FactSpec {
  fragment: string;
  mechanismState?: string | null;
}
interface Doc {
  url: string;
  text: string;
  facts: Partial<Record<Component, FactSpec[]>>;
  extract?: "ok" | "empty";
}
function canonDocs(project: Project): Doc[] {
  return ALL_COMPONENTS.map((c) => ({
    url: c === "GOVERNANCE_BASIS" || c === "DURABILITY_BASIS" ? `https://${project.govHost}/proposals/${c.toLowerCase()}` : `https://${project.host}/docs/${c.toLowerCase().replace(/_/g, "-")}`,
    text: `${project.name} — ${c.toLowerCase().replace(/_/g, " ")}. ${CANON[c]}.`,
    facts: { [c]: [{ fragment: CANON[c], mechanismState: STATE_OF[c] ?? null }] },
  }));
}

interface Scenario {
  docs: Doc[];
  intent?: Intent;
  rpc?: "ok" | "down";
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

interface Calls {
  proposer: number;
  search: number;
  fetch: number;
  extract: number;
  fetchedUrls: string[];
}

function executorFor(project: Project, s: Scenario): { executor: WorkExecutor; calls: Calls } {
  const byUrl = new Map(s.docs.map((d) => [d.url, d]));
  // The fixture's default publication date is DETERMINISTIC and monotone
  // in document order: yesterday, plus one second per document. It used
  // to be the clock at extraction time, which encoded the sequential
  // extraction order into the supersession order; under overlapped
  // extraction (speed+cost pass 2) that order is a scheduling race. The
  // production extractor reads publication dates from the document, never
  // from the clock.
  const defaultPublishedAtBase = daysAgo(1).getTime();
  const defaultPublishedAt = (finalUrl: string): Date => new Date(defaultPublishedAtBase + Math.max(0, [...byUrl.keys()].indexOf(finalUrl)) * 1000);
  const calls: Calls = { proposer: 0, search: 0, fetch: 0, extract: 0, fetchedUrls: [] };
  const served = new Set<string>();
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    chainAcquisition: "ENABLED",
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
        if (isExplorer) return [];
        const key = `${target.step}:${component}`;
        if (served.has(key)) return [];
        served.add(key);
        return s.docs.filter((d) => d.facts[component]).map((d) => ({ url: d.url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        calls.fetch += 1;
        calls.fetchedUrls.push(url);
        const d = byUrl.get(url);
        if (!d) throw new ContentFetchError("HTTP_ERROR", "fixture: unknown url", url, 404);
        return fetched(url, d.text);
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        calls.extract += 1;
        const d = byUrl.get(input.document.finalUrl);
        if (!d || d.extract === "empty") return [];
        const component = input.target.component as Component;
        return (d.facts[component] ?? []).map(
          (f): ExtractedFact => ({
            step: input.target.step,
            component,
            statement: `${component.toLowerCase().replace(/_/g, " ")}: ${f.fragment}`,
            supportFragment: f.fragment,
            mechanismState: f.mechanismState ?? null,
            directness: "DIRECT",
            publishedAt: defaultPublishedAt(input.document.finalUrl),
            doesNotProve: "does not prove the size of the effect",
            relationship: "SUPPORTS",
          }),
        );
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
  return { executor, calls };
}

async function newJob(project: Project, intent: Intent): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
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
  terminationReason: string | null;
  verdict: string | null;
  confidence: number | null;
  claim: string | null;
  requirements: string[];
  gaps: string[];
  flows: number;
  cited: { id: string; component: string }[];
  s5: Record<string, { status: string; reasonCodes: string[]; supporting: string[]; currentState: string | null } | null>;
  calls: Calls;
}

async function research(project: Project, s: Scenario): Promise<Outcome> {
  const adapter = evmFixture({ down: s.rpc === "down" });
  installOnchainResearchCapability({
    capabilities: new Set(["SEARCH_EXTRACT"]),
    env: { ONCHAIN_RESEARCH_ENABLED: "1", ETHEREUM_MAINNET_RPC_URL: "https://fixture.invalid/rpc" },
    create: (chain, network) => (chain === "ethereum" && network === "mainnet" ? adapter : null),
  });
  const { executor, calls } = executorFor(project, s);
  const jobId = await newJob(project, s.intent ?? "PROTOCOL_REVENUE_TO_TOKEN");
  const handled = await handleResearchJobTask(ctx.db, jobId, executor);
  if (!handled.claimed) throw new Error("job not claimed");
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  const gaps = new Set<string>();
  const flows = (asm?.flows ?? []) as { gaps?: { kind: string; component: string }[] }[];
  for (const f of flows) for (const g of f.gaps ?? []) gaps.add(`${g.kind}@${g.component}`);
  for (const g of (asm?.unassignedGaps ?? []) as { kind: string; component: string }[]) gaps.add(`${g.kind}@${g.component}`);
  const cited = proof ? (await ctx.db.select().from(evidence).where(eq(evidence.proofId, proof.id))).map((r) => ({ id: r.id, component: r.component ?? "" })) : [];
  const s5rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const s5: Outcome["s5"] = {};
  for (const c of ALL_COMPONENTS) {
    const r = s5rows.find((x) => x.component === c);
    s5[c] = r ? { status: r.status, reasonCodes: [...(r.reasonCodes as string[])].sort(), supporting: [...(r.supportingEvidenceIds as string[])].sort(), currentState: r.currentState } : null;
  }
  return {
    jobId,
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
async function attemptsOf(jobId: string, component: Component) {
  return ctx.db
    .select()
    .from(researchAttempts)
    .where(and(eq(researchAttempts.researchJobId, jobId), eq(researchAttempts.component, component)))
    .orderBy(researchAttempts.attemptNumber);
}

const VERDICT_RANK: Record<string, number> = { NOT_SUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const STATUS_RANK: Record<string, number> = { CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const REQ_RANK: Record<string, number> = { CONTRADICTED: 0, UNSATISFIED: 0, PARTIAL: 1, SATISFIED: 2 };

// t is no stronger than c on any axis.
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
const docUrl = (project: Project, c: Component) => `https://${project.host}/docs/${c.toLowerCase().replace(/_/g, "-")}`;

// ====================================================================
describe("Decision 1 — TECHNICAL FAILURE != STRONGER PROJECT REALITY (F8b)", () => {
  it("A. RPC UP vs RPC DOWN on the same evidence world, for the state, revenue and supply intents: the RPC-DOWN Research is never stronger than the RPC-UP one on verdict, confidence, any S5 status or any requirement — the Round 6 inversion (INSUFFICIENT up, SUPPORTED down) is gone", async () => {
    for (const intent of ["MECHANISM_CURRENT_STATE", "PROTOCOL_REVENUE_TO_TOKEN", "BURN_OR_SUPPLY_EFFECT"] as const) {
      const project = await makeProject();
      const up = await research(project, { docs: canonDocs(project), intent });
      const down = await research(project, { docs: canonDocs(project), intent, rpc: "down" });
      expect(up.state, intent).toBe("SUCCEEDED");
      expect(down.state, intent).toBe("SUCCEEDED");
      noStrongerThan(down, up, `${intent}: down vs up`);
      nonNegative(up);
      nonNegative(down);
      // The RPC-down world invents nothing: no artifact, no chain row.
      expect((await evidenceOf(down.jobId)).every((r) => r.onchainArtifactId === null), intent).toBe(true);
    }
  });

  it("B. CURRENT_STATE on EVM with the chain UP: the TOKEN_SUPPLY reading is persisted AND the official current-state page is read — both rows support the component, it is SUPPORTED with a LIVE state, 'is it current?' is answered exactly as with the RPC down, and the attempt names why the documentary pass went on", async () => {
    const project = await makeProject();
    const up = await research(project, { docs: canonDocs(project), intent: "MECHANISM_CURRENT_STATE" });
    const down = await research(project, { docs: canonDocs(project), intent: "MECHANISM_CURRENT_STATE", rpc: "down" });
    // Both rows, both supporting.
    const csUp = await evidenceOf(up.jobId, "CURRENT_STATE");
    expect(csUp.map((r) => [r.sourceClass, r.onchainFactKind, r.mechanismState]).sort()).toEqual([
      ["OFFICIAL_DOCS", null, "LIVE"],
      ["ONCHAIN_VERIFIABLE", "TOKEN_SUPPLY", null],
    ]);
    expect(up.s5.CURRENT_STATE!.supporting.sort()).toEqual(csUp.map((r) => r.id).sort());
    expect(up.s5.CURRENT_STATE!.status).toBe("SUPPORTED");
    expect(up.s5.CURRENT_STATE!.currentState).toBe("LIVE");
    expect(up.calls.fetchedUrls).toContain(docUrl(project, "CURRENT_STATE"));
    // The question: answered the same way on both sides.
    expect(up.verdict).toBe("SUPPORTED");
    expect(up.requirements).toEqual(["MCS-1:SATISFIED"]);
    expect(down.verdict).toBe(up.verdict);
    expect(down.requirements).toEqual(up.requirements);
    expect(down.confidence).toBeLessThanOrEqual(up.confidence!);
    // The attempt: one, SUCCEEDED, the documentary pass extracted, and the
    // reason says why the chain read did not close the component.
    const attempts = await attemptsOf(up.jobId, "CURRENT_STATE");
    expect(attempts.map((a) => a.status)).toEqual(["SUCCEEDED"]);
    expect(attempts[0].reason).toContain("ONCHAIN_EVIDENCE_WITHOUT_MECHANISM_STATE");
    expect(attempts[0].reason).toMatch(/extracted 1 evidence candidate/);
    // The chain row is cited as support for the state beside the page,
    // never instead of it.
    expect(up.cited.filter((c) => c.component === "CURRENT_STATE").length).toBe(2);
  });

  it("B2. the same pair for the revenue intent — the live EVM shape Round 6 measured: the two CURRENT_STATE rows are two slots and the lineage forks there, yet the page rows after the fork attach to both branches, the supply reading attaches to its own, and PRT-2 is exactly the RPC-down world's (PARTIAL, never UNSATISFIED). Decisions 1 and 3 together", async () => {
    const project = await makeProject();
    const up = await research(project, { docs: canonDocs(project), intent: "PROTOCOL_REVENUE_TO_TOKEN" });
    const down = await research(project, { docs: canonDocs(project), intent: "PROTOCOL_REVENUE_TO_TOKEN", rpc: "down" });
    expect(up.s5.CURRENT_STATE!.status).toBe("SUPPORTED");
    expect(up.s5.CURRENT_STATE!.supporting.length).toBe(2);
    expect(up.flows).toBeGreaterThan(down.flows);
    // Round 6 measured DESTINATION / RECIPIENT / NET_EFFECT / DURABILITY_BASIS
    // all BRANCH_ATTRIBUTION_UNRESOLVED after this fork. Now: the page rows
    // name no branch and continue the trunk on both; the NET_EFFECT reading
    // shares its source with the chain slot and attaches to THAT branch
    // (§13.4 outcome 1), so the page-only branch carries the one honest
    // gap — it has no reading of its own — and nothing else does.
    for (const c of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "GOVERNANCE_BASIS", "DESTINATION", "RECIPIENT", "DURABILITY_BASIS"]) {
      expect(up.gaps, c).not.toContain(`BRANCH_ATTRIBUTION_UNRESOLVED@${c}`);
    }
    expect(up.gaps).toContain("PARTIAL_COMPONENT@NET_EFFECT");
    expect(up.requirements).toEqual(down.requirements);
    expect(up.confidence).toBe(down.confidence);
    expect(up.requirements.find((r) => r.startsWith("PRT-2:"))).toBe("PRT-2:PARTIAL");
    expect(up.verdict).toBe(down.verdict);
    noStrongerThan(down, up, "revenue: down vs up");
    for (const c of ALL_COMPONENTS) {
      if (c === "NET_EFFECT" || c === "CURRENT_STATE") continue;
      expect([up.s5[c]!.status, up.s5[c]!.reasonCodes], c).toEqual([down.s5[c]!.status, down.s5[c]!.reasonCodes]);
    }
  });

  it("B3. the documentary pass finds nothing (the current-state page yields no facts): the attempt still closes SUCCEEDED on the chain row it holds — never SKIPPED, never a recovery retry of work already done — S5 reads the reading alone (PARTIALLY_SUPPORTED / INSUFFICIENT_AUTHORITY, no state), and the job SUCCEEDS", async () => {
    const project = await makeProject();
    const docs = canonDocs(project);
    docs.find((d) => d.facts.CURRENT_STATE)!.extract = "empty";
    const up = await research(project, { docs, intent: "MECHANISM_CURRENT_STATE" });
    expect(up.state).toBe("SUCCEEDED");
    const attempts = await attemptsOf(up.jobId, "CURRENT_STATE");
    expect(attempts.map((a) => a.status)).toEqual(["SUCCEEDED"]);
    expect(attempts[0].reason).toMatch(/^ONCHAIN_EVIDENCE_ESTABLISHED; documentary pass SKIPPED: /);
    expect(attempts[0].reason).toContain("ONCHAIN_EVIDENCE_WITHOUT_MECHANISM_STATE");
    expect(up.calls.fetchedUrls).toContain(docUrl(project, "CURRENT_STATE"));
    const cs = await evidenceOf(up.jobId, "CURRENT_STATE");
    expect(cs.map((r) => [r.sourceClass, r.onchainFactKind])).toEqual([["ONCHAIN_VERIFIABLE", "TOKEN_SUPPLY"]]);
    expect(up.s5.CURRENT_STATE!.status).toBe("PARTIALLY_SUPPORTED");
    expect(up.s5.CURRENT_STATE!.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
    expect(up.s5.CURRENT_STATE!.currentState).toBeNull();
    expect(up.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(up.requirements).toEqual(["MCS-1:UNSATISFIED"]);
    nonNegative(up);
  });

  it("B4. BOUNDED RESEARCH PRESERVED — a chain read that carries what its component reports still closes the component: NET_EFFECT reports no state, so its TOKEN_SUPPLY reading closes acquisition as before (ONCHAIN_EVIDENCE_ESTABLISHED, the NET_EFFECT page is never bought); the RPC-UP Research opens no more documents than the RPC-DOWN one, and every extra open belongs to the RPC-DOWN world", async () => {
    const project = await makeProject();
    const up = await research(project, { docs: canonDocs(project), intent: "PROTOCOL_REVENUE_TO_TOKEN" });
    const down = await research(project, { docs: canonDocs(project), intent: "PROTOCOL_REVENUE_TO_TOKEN", rpc: "down" });
    const ne = await attemptsOf(up.jobId, "NET_EFFECT");
    expect(ne.map((a) => a.status)).toEqual(["SUCCEEDED"]);
    expect(ne[0].reason).toMatch(/^ONCHAIN_EVIDENCE_ESTABLISHED/);
    expect(ne[0].reason).not.toContain("documentary pass");
    expect(up.calls.fetchedUrls).not.toContain(docUrl(project, "NET_EFFECT"));
    expect((await evidenceOf(up.jobId, "NET_EFFECT")).every((r) => r.sourceClass === "ONCHAIN_VERIFIABLE")).toBe(true);
    // Bounds: the chain-up world reads the current-state page (Decision 1)
    // and skips the net-effect page (the pre-emption kept); the chain-down
    // world reads both. Never more opens with the chain working.
    expect(up.calls.fetch).toBeLessThanOrEqual(down.calls.fetch);
    expect(up.calls.search).toBeLessThanOrEqual(down.calls.search);
    expect(up.calls.extract).toBeLessThanOrEqual(down.calls.extract);
    expect(down.calls.fetchedUrls).toContain(docUrl(project, "NET_EFFECT"));
    expect(down.calls.fetchedUrls).toContain(docUrl(project, "CURRENT_STATE"));
  });
});

// ====================================================================
describe("No false semantics", () => {
  it("TECHNICAL FAILURE != STRONGER PROJECT REALITY: with the RPC down, no component is stronger than with the chain up; the chain row is never a state; the state is always the page's", async () => {
    const project = await makeProject();
    const up = await research(project, { docs: canonDocs(project), intent: "MECHANISM_CURRENT_STATE" });
    const down = await research(project, { docs: canonDocs(project), intent: "MECHANISM_CURRENT_STATE", rpc: "down" });
    noStrongerThan(down, up, "state: down vs up");
    for (const r of await evidenceOf(up.jobId)) {
      if (r.sourceClass === "ONCHAIN_VERIFIABLE") expect(r.mechanismState).toBeNull();
    }
    expect(up.s5.CURRENT_STATE!.currentState).toBe("LIVE");
    expect(down.s5.CURRENT_STATE!.currentState).toBe("LIVE");
  });
});
