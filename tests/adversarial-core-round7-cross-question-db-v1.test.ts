import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  interpretations,
  projects,
  proofs,
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

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 7: CROSS-QUESTION / LOGICAL
// CONSISTENCY, THE PERSISTED RESEARCH.
//
// The pure half (adversarial-core-round7-cross-question-v1) asks every
// intent of one in-memory evidence world. This half asks the same
// questions of the SAME DOCUMENTS through the real S4 executor, the real
// lifecycle and the real Postgres store — one job per intent, each
// acquiring, reducing and proving on its own — and compares what was
// PERSISTED: the S5 rows, the S6 flows, the S7 requirements, the S8 Proof
// and its citations. Fixture providers only: no model, no network, no
// RPC, no spend.
//
// What it must show: related Proofs over one document set share one
// reduced picture (S5 / S6 shapes identical across jobs), obey the same
// implication laws the pure half pins, cite only their own job's rows,
// and never carry another job's Evidence.

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
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const EVM = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";

// A documentary fee -> buyback -> burn mechanism, one page per component.
// NET_EFFECT's page is prose (OFFICIAL_DOCS is not an establishing class
// for it) so the supply question rests on chain data or on nothing.
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
const STATE_OF: Partial<Record<Component, string>> = { MECHANISM_SPEC: "LIVE", EXECUTION_EVIDENCE: "LIVE", CURRENT_STATE: "LIVE", GOVERNANCE_BASIS: "APPROVED", DURABILITY_BASIS: "APPROVED" };

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
  ticker: string | null;
  host: string;
  govHost: string;
  reportHost: string;
}

async function makeProject(opts: { identity?: { chain: "ethereum"; tokenAddress: string } } = {}): Promise<Project> {
  const slug = uniq("r7");
  const name = `Round Seven ${slug.replace(/_/g, " ")}`;
  const host = `docs.${slug.replace(/_/g, "-")}.example`;
  const govHost = `vote.${slug.replace(/_/g, "-")}.example`;
  const reportHost = `reports.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE", ticker: null }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const docsClass = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!docsClass.ok) throw new Error("docs classify failed: " + docsClass.refusal);
  const gov = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: govHost, pathPrefix: "/proposals" });
  if (!gov.ok) throw new Error("gov confirm failed: " + gov.refusal);
  const govClass = await classifySourceRoute(ctx.db, { routeId: gov.itemId, routeClass: "GOVERNANCE" });
  if (!govClass.ok) throw new Error("gov classify failed: " + govClass.refusal);
  const rep = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: reportHost, pathPrefix: "/reports" });
  if (!rep.ok) throw new Error("report confirm failed: " + rep.refusal);
  const repClass = await classifySourceRoute(ctx.db, { routeId: rep.itemId, routeClass: "OFFICIAL_REPORT" });
  if (!repClass.ok) throw new Error("report classify failed: " + repClass.refusal);
  if (opts.identity) {
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: opts.identity.chain, tokenAddress: opts.identity.tokenAddress, ticker: "R7" });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, name, ticker: null, host, govHost, reportHost };
}

interface FactSpec {
  fragment: string;
  mechanismState?: string | null;
  publishedAt?: Date | null;
}
interface Doc {
  url: string;
  text: string;
  facts: Partial<Record<Component, FactSpec[]>>;
}
function canonDocs(project: Project, overrides: Partial<Record<Component, FactSpec[] | null>> = {}): Doc[] {
  const docs: Doc[] = [];
  for (const c of ALL_COMPONENTS) {
    const facts = c in overrides ? overrides[c] : [{ fragment: CANON[c], mechanismState: STATE_OF[c] ?? null }];
    if (facts === null || facts === undefined) continue;
    const gov = c === "GOVERNANCE_BASIS" || c === "DURABILITY_BASIS";
    docs.push({
      url: gov ? `https://${project.govHost}/proposals/${c.toLowerCase()}` : `https://${project.host}/docs/${c.toLowerCase().replace(/_/g, "-")}`,
      text: `${project.name} — ${c.toLowerCase().replace(/_/g, " ")}. ${facts.map((f) => f.fragment).join(" ")}.`,
      facts: { [c]: facts },
    });
  }
  return docs;
}

interface Scenario {
  docs: Doc[];
  intent: Intent;
  chain?: "ENABLED" | "DOCUMENTARY_ONLY";
}

function fetched(url: string, text: string): FetchedDocument {
  return { finalUrl: url, requestedUrl: url, httpStatus: 200, contentType: "text/html", normalizedText: text, contentHash: `sha256:${text.length}:${text.slice(0, 64)}`, fetchedAt: new Date(), byteLength: text.length };
}

function evmFixture() {
  const transport: OnchainRpcTransport = {
    async call(method, params) {
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

function executorFor(project: Project, s: Scenario): WorkExecutor {
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
  const served = new Set<string>();
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    chainAcquisition: s.chain ?? "DOCUMENTARY_ONLY",
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        const c = input.target.component;
        return [`${c} of ${project.name}`, `${project.name} ${c} documentation`, `${project.name} tokenomics ${c}`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query, target) {
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
        const d = byUrl.get(url);
        if (!d) throw new ContentFetchError("HTTP_ERROR", "fixture: unknown url", url, 404);
        return fetched(url, d.text);
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        const d = byUrl.get(input.document.finalUrl);
        if (!d) return [];
        const component = input.target.component as Component;
        return (d.facts[component] ?? []).map(
          (f): ExtractedFact => ({
            step: input.target.step,
            component,
            statement: `${component.toLowerCase().replace(/_/g, " ")}: ${f.fragment}`,
            supportFragment: f.fragment,
            mechanismState: f.mechanismState ?? null,
            directness: "DIRECT",
            publishedAt: f.publishedAt === undefined ? defaultPublishedAt(input.document.finalUrl) : f.publishedAt,
            doesNotProve: "does not prove the size of the effect",
            relationship: "SUPPORTS",
          }),
        );
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

async function newJob(project: Project, intent: Intent): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const question = `same documents, asked as ${intent}`;
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

interface S5Row {
  status: string;
  reasonCodes: string[];
  supporting: string[];
  contradicting: string[];
  excluded: { evidenceId: string; reason: string }[];
}
interface Outcome {
  jobId: string;
  intent: Intent;
  state: string;
  verdict: string | null;
  confidence: number | null;
  claim: string | null;
  claimIntent: string | null;
  requirements: { requirementId: string; status: string; reasonCodes: string[]; evidenceIds: string[]; componentResultKeys: { step: number; component: string }[] }[];
  flowShapes: string[];
  cited: { id: string; component: string; jobId: string }[];
  evidenceIds: string[];
  s5: Record<Component, S5Row | null>;
}

async function research(project: Project, s: Scenario): Promise<Outcome> {
  if (s.chain === "ENABLED") {
    const adapter = evmFixture();
    installOnchainResearchCapability({
      capabilities: new Set(["SEARCH_EXTRACT"]),
      env: { ONCHAIN_RESEARCH_ENABLED: "1", ETHEREUM_MAINNET_RPC_URL: "https://fixture.invalid/rpc" },
      create: (chain, network) => (chain === "ethereum" && network === "mainnet" ? adapter : null),
    });
  }
  const jobId = await newJob(project, s.intent);
  const handled = await handleResearchJobTask(ctx.db, jobId, executorFor(project, s));
  if (!handled.claimed) throw new Error("job not claimed");
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const [asm] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  const flows = (asm?.flows ?? []) as unknown as { lineage: { component: string; evidenceIds: string[] }[]; lifecycle: string; attributes: Record<string, unknown>; edges: { basisComponent: string; executed: boolean }[]; gaps: { kind: string; component: string | null }[]; netEffect: { componentStatus: string } | null }[];
  const flowShapes = flows
    .map((f) => JSON.stringify({ lineage: f.lineage.map((s) => `${s.component}:${s.evidenceIds.length}`), lifecycle: f.lifecycle, attributes: f.attributes, edges: f.edges.map((e) => `${e.basisComponent}${e.executed ? "*" : ""}`), gaps: f.gaps.map((g) => `${g.kind}@${g.component}`), net: f.netEffect?.componentStatus ?? null }))
    .sort();
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
  const cited = proof ? rows.filter((r) => r.proofId === proof.id).map((r) => ({ id: r.id, component: r.component ?? "", jobId: r.researchJobId })) : [];
  const s5rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const s5 = {} as Record<Component, S5Row | null>;
  for (const c of ALL_COMPONENTS) {
    const r = s5rows.find((x) => x.component === c);
    s5[c] = r
      ? { status: r.status, reasonCodes: [...(r.reasonCodes as string[])], supporting: [...(r.supportingEvidenceIds as string[])].sort(), contradicting: [...(r.contradictingEvidenceIds as string[])].sort(), excluded: r.excludedEvidence as { evidenceId: string; reason: string }[] }
      : null;
  }
  const requirementResults = (claim?.requirementResults ?? []) as { requirementId: string; status: string; reasonCodes: string[]; provenance: { evidenceIds: string[]; componentResultKeys: { step: number; component: string }[] } }[];
  return {
    jobId,
    intent: s.intent,
    state: job.state,
    verdict: proof?.verdict ?? null,
    confidence: proof?.confidence ?? null,
    claim: claim?.status ?? null,
    claimIntent: (claim?.intent as string | null) ?? null,
    requirements: requirementResults.map((r) => ({ requirementId: r.requirementId, status: r.status, reasonCodes: r.reasonCodes, evidenceIds: r.provenance.evidenceIds, componentResultKeys: r.provenance.componentResultKeys })),
    flowShapes,
    cited,
    evidenceIds: rows.map((r) => r.id).sort(),
    s5,
  };
}

// The intent-independent picture: status, codes and counts per component
// (row ids differ per job by construction) and the S6 flow shapes.
function reducedShape(o: Outcome) {
  return {
    s5: Object.fromEntries(ALL_COMPONENTS.map((c) => [c, o.s5[c] ? { status: o.s5[c]!.status, reasonCodes: o.s5[c]!.reasonCodes, n: o.s5[c]!.supporting.length, contradicting: o.s5[c]!.contradicting.length, excluded: o.s5[c]!.excluded.map((e) => e.reason).sort() } : null])),
    flows: o.flowShapes,
  };
}
const reqStatus = (o: Outcome, id: string) => o.requirements.find((r) => r.requirementId === id)!;

// The persisted laws — the pure half's L0–L8, read off rows.
function persistedLaws(by: Record<Intent, Outcome>, label: string): void {
  const PRT = by.PROTOCOL_REVENUE_TO_TOKEN;
  for (const i of INTENTS) {
    expect(by[i].state, `${label}: ${i} state`).toBe("SUCCEEDED");
    expect(by[i].claimIntent, `${label}: ${i} claim intent`).toBe(i);
    expect(by[i].verdict, `${label}: ${i} verdict`).not.toBeNull();
    // L0 — one reduced picture per document set.
    expect(reducedShape(by[i]), `${label}: ${i} reduced picture differs from PRT`).toEqual(reducedShape(PRT));
    // Own rows only: every citation and every S5 id is this job's.
    const own = new Set(by[i].evidenceIds);
    for (const c of by[i].cited) {
      expect(c.jobId, `${label}: ${i} cites a foreign row`).toBe(by[i].jobId);
      expect(own.has(c.id)).toBe(true);
    }
    for (const c of ALL_COMPONENTS) for (const id of [...(by[i].s5[c]?.supporting ?? []), ...(by[i].s5[c]?.contradicting ?? [])]) expect(own.has(id), `${label}: ${i} ${c} admits a foreign row`).toBe(true);
    for (const r of by[i].requirements) for (const id of r.evidenceIds) expect(own.has(id), `${label}: ${i} ${r.requirementId} cites a foreign row`).toBe(true);
    // Citations are supporting rows of the component they are cited at.
    for (const c of by[i].cited) {
      const s5 = by[i].s5[c.component as Component];
      expect(s5?.supporting ?? [], `${label}: ${i} cites ${c.id} at ${c.component} which does not support it`).toContain(c.id);
    }
  }
  // No two jobs share an Evidence row.
  const seen = new Map<string, Intent>();
  for (const i of INTENTS) for (const id of by[i].evidenceIds) {
    expect(seen.has(id), `${label}: row ${id} shared by ${seen.get(id)} and ${i}`).toBe(false);
    seen.set(id, i);
  }
  // L1 — PRT ≡ RS ≡ UTL on verdict, band, requirement statuses and codes.
  const claimShape = (o: Outcome) => JSON.stringify({ v: o.verdict, c: o.confidence, claim: o.claim, reqs: o.requirements.map((r) => ({ s: r.status, codes: r.reasonCodes, n: r.evidenceIds.length, keys: r.componentResultKeys })) });
  expect(claimShape(by.REWARD_SOURCE), `${label}: RS != PRT`).toBe(claimShape(PRT));
  expect(claimShape(by.USAGE_TO_TOKEN_LINKAGE), `${label}: UTL != PRT`).toBe(claimShape(PRT));
  // L2 — VALUE_CAPTURE = PRT ∧ BSE, atom by atom (ids differ per job;
  // status, codes, counts and keys do not).
  const atom = (r: Outcome["requirements"][number]) => JSON.stringify({ s: r.status, codes: r.reasonCodes, n: r.evidenceIds.length, keys: r.componentResultKeys });
  expect(atom(reqStatus(by.VALUE_CAPTURE, "VC-1")), `${label}: VC-1 != PRT-1`).toBe(atom(reqStatus(PRT, "PRT-1")));
  expect(atom(reqStatus(by.VALUE_CAPTURE, "VC-2")), `${label}: VC-2 != PRT-2`).toBe(atom(reqStatus(PRT, "PRT-2")));
  expect(atom(reqStatus(by.VALUE_CAPTURE, "VC-3")), `${label}: VC-3 != BSE-1`).toBe(atom(reqStatus(by.BURN_OR_SUPPLY_EFFECT, "BSE-1")));
  const VC = by.VALUE_CAPTURE.verdict;
  const BSE = by.BURN_OR_SUPPLY_EFFECT.verdict;
  if (VC === "SUPPORTED") expect([PRT.verdict, BSE]).toEqual(["SUPPORTED", "SUPPORTED"]);
  expect(VC === "NOT_SUPPORTED", `${label}: refutation law`).toBe(PRT.verdict === "NOT_SUPPORTED" || BSE === "NOT_SUPPORTED");
  expect(VC === "INSUFFICIENT_EVIDENCE", `${label}: insufficiency law`).toBe(PRT.verdict === "INSUFFICIENT_EVIDENCE" && BSE === "INSUFFICIENT_EVIDENCE");
  // L3 — TU-1 is PRT-1.
  expect(atom(reqStatus(by.TOKEN_UTILITY, "TU-1")), `${label}: TU-1 != PRT-1`).toBe(atom(reqStatus(PRT, "PRT-1")));
  // L4 — no supply question is SUPPORTED.
  expect(PRT.s5.NET_EFFECT?.status).not.toBe("SUPPORTED");
  expect(BSE).not.toBe("SUPPORTED");
  expect(VC).not.toBe("SUPPORTED");
  // L5 — the current question rests on CURRENT_STATE.
  const MCS = by.MECHANISM_CURRENT_STATE.verdict;
  if (MCS === "SUPPORTED" || MCS === "PARTIALLY_SUPPORTED") expect(["SUPPORTED", "PARTIALLY_SUPPORTED"]).toContain(PRT.s5.CURRENT_STATE?.status);
  // L7 — ceilings.
  for (const i of INTENTS) expect(by[i].confidence!, `${label}: ${i} above ceiling`).toBeLessThanOrEqual(by[i].verdict === "SUPPORTED" || by[i].verdict === "NOT_SUPPORTED" ? 80 : 60);
}

async function askAll(project: Project, docs: Doc[], chain: Scenario["chain"] = "DOCUMENTARY_ONLY"): Promise<Record<Intent, Outcome>> {
  const out = {} as Record<Intent, Outcome>;
  for (const intent of INTENTS) out[intent] = await research(project, { docs, intent, chain });
  return out;
}
const verdicts = (by: Record<Intent, Outcome>) => Object.fromEntries(INTENTS.map((i) => [i, by[i].verdict])) as Record<Intent, string | null>;

// ====================================================================
describe("P1. one document set, eight persisted Researches", () => {
  it("P1a. the complete documentary buyback -> burn world: every job persists the same reduced picture, obeys the laws, cites only its own rows; the documentary questions hold, the supply question is unanswered (prose is not a supply fact), the current question holds on the fresh official page", async () => {
    const project = await makeProject();
    const by = await askAll(project, canonDocs(project));
    persistedLaws(by, "P1a");
    expect(verdicts(by)).toEqual({
      PROTOCOL_REVENUE_TO_TOKEN: "PARTIALLY_SUPPORTED",
      PASSIVE_HOLDER_OUTCOME: "INSUFFICIENT_EVIDENCE",
      REWARD_SOURCE: "PARTIALLY_SUPPORTED",
      BURN_OR_SUPPLY_EFFECT: "INSUFFICIENT_EVIDENCE",
      MECHANISM_CURRENT_STATE: "SUPPORTED",
      USAGE_TO_TOKEN_LINKAGE: "PARTIALLY_SUPPORTED",
      VALUE_CAPTURE: "PARTIALLY_SUPPORTED",
      TOKEN_UTILITY: "PARTIALLY_SUPPORTED",
    });
    const s5 = by.PROTOCOL_REVENUE_TO_TOKEN.s5;
    expect(s5.SOURCE_OF_VALUE?.reasonCodes).toEqual(["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]);
    expect(s5.NET_EFFECT?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5.NET_EFFECT?.reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    expect(s5.EXECUTION_EVIDENCE?.status).toBe("INSUFFICIENT_EVIDENCE"); // docs are not execution evidence
    expect(s5.CURRENT_STATE?.status).toBe("SUPPORTED");
    // 'is it current?' cites exactly the current-state row of ITS job.
    expect(by.MECHANISM_CURRENT_STATE.cited.map((c) => c.component)).toEqual(["CURRENT_STATE"]);
    expect(by.MECHANISM_CURRENT_STATE.cited.map((c) => c.id)).toEqual(by.MECHANISM_CURRENT_STATE.s5.CURRENT_STATE!.supporting);
  }, 300_000);

  it("P1b. governance approved, no activation, no execution: 'is it current?' INSUFFICIENT in the persisted Proof while the structural questions read as in P1a — APPROVED != ACTIVATED across jobs", async () => {
    const project = await makeProject();
    const docs = canonDocs(project, { CURRENT_STATE: null, EXECUTION_EVIDENCE: null });
    const by = await askAll(project, docs);
    persistedLaws(by, "P1b");
    expect(by.MECHANISM_CURRENT_STATE.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(by.MECHANISM_CURRENT_STATE.s5.CURRENT_STATE?.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    expect(by.PROTOCOL_REVENUE_TO_TOKEN.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(by.PROTOCOL_REVENUE_TO_TOKEN.s5.GOVERNANCE_BASIS?.status).toBe("SUPPORTED");
    for (const i of INTENTS) expect(by[i].verdict, i).not.toBe("NOT_SUPPORTED");
  }, 300_000);

  it("P1c. executed then paused (an OFFICIAL_REPORT of execution, a fresh official PAUSED page): 'is it current?' is NOT_SUPPORTED in its own persisted Proof — HISTORICAL lifecycle, citing that job's current-state and execution rows — while every other question over the same documents keeps its P1a verdict; nothing else is refuted", async () => {
    const project = await makeProject();
    const report: Doc = {
      url: `https://${project.reportHost}/reports/epoch-12`,
      text: `${project.name} — epoch 12 report. ${CANON.EXECUTION_EVIDENCE}.`,
      facts: { EXECUTION_EVIDENCE: [{ fragment: CANON.EXECUTION_EVIDENCE, mechanismState: "LIVE", publishedAt: daysAgo(45) }] },
    };
    const docs = [...canonDocs(project, { EXECUTION_EVIDENCE: null, CURRENT_STATE: [{ fragment: "the buyback mechanism is paused pending a governance review", mechanismState: "PAUSED" }] }), report];
    const by = await askAll(project, docs);
    persistedLaws(by, "P1c");
    const mcs = by.MECHANISM_CURRENT_STATE;
    expect(mcs.s5.CURRENT_STATE?.status).toBe("SUPPORTED");
    expect(mcs.s5.EXECUTION_EVIDENCE?.status).toBe("SUPPORTED");
    expect(mcs.flowShapes.every((f) => f.includes('"lifecycle":"HISTORICAL"'))).toBe(true);
    expect(mcs.verdict).toBe("NOT_SUPPORTED");
    expect(reqStatus(mcs, "MCS-1").reasonCodes).toEqual(["TEMPORAL_SCOPE_MISMATCH"]);
    expect(mcs.cited.map((c) => c.component).sort()).toEqual(["CURRENT_STATE", "EXECUTION_EVIDENCE"]);
    expect(mcs.cited.map((c) => c.id).sort()).toEqual([...mcs.s5.CURRENT_STATE!.supporting, ...mcs.s5.EXECUTION_EVIDENCE!.supporting].sort());
    expect(by.PROTOCOL_REVENUE_TO_TOKEN.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(by.PASSIVE_HOLDER_OUTCOME.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(by.BURN_OR_SUPPLY_EFFECT.verdict).toBe("INSUFFICIENT_EVIDENCE");
    for (const i of INTENTS) if (i !== "MECHANISM_CURRENT_STATE") expect(by[i].verdict, i).not.toBe("NOT_SUPPORTED");
  }, 300_000);
});

// ====================================================================
describe("P2. the same documents with a working chain — the supply and current questions read the chain, the revenue question does not", () => {
  it("P2a. with the EVM identity confirmed and the RPC answering, a TOKEN_SUPPLY reading is persisted for CURRENT_STATE and NET_EFFECT: 'what is supply?' establishes a level beside the docs, 'did supply change?' is PARTIAL with SUPPLY_REDUCTION_NOT_ESTABLISHED, 'is it current?' rests on the official page, and the revenue verdict equals the documentary-only run", async () => {
    const project = await makeProject({ identity: { chain: "ethereum", tokenAddress: EVM } });
    const docsOnly = await research(project, { docs: canonDocs(project), intent: "PROTOCOL_REVENUE_TO_TOKEN" });
    const by = await askAll(project, canonDocs(project), "ENABLED");
    persistedLaws(by, "P2a");
    const s5 = by.BURN_OR_SUPPLY_EFFECT.s5;
    expect(s5.NET_EFFECT?.status).toBe("PARTIALLY_SUPPORTED");
    // The specific supply code first; a chain read is CLAIMED authority by
    // design (D-074), so the general authority caveat follows it.
    expect(s5.NET_EFFECT?.reasonCodes).toEqual(["SUPPLY_REDUCTION_NOT_ESTABLISHED", "INSUFFICIENT_AUTHORITY"]);
    expect(by.BURN_OR_SUPPLY_EFFECT.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(by.BURN_OR_SUPPLY_EFFECT.confidence).toBeLessThanOrEqual(40);
    expect(s5.CURRENT_STATE?.status).toBe("SUPPORTED");
    expect(by.MECHANISM_CURRENT_STATE.verdict).toBe("SUPPORTED");
    // The current question rests on the official page's LIVE state; the
    // state-less reading is cited beside it, never instead of it (Round
    // 6.5, Founder decision 1).
    const chainIds = new Set((await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, by.MECHANISM_CURRENT_STATE.jobId))).filter((r) => r.onchainFactKind !== null).map((r) => r.id));
    expect(chainIds.size).toBeGreaterThan(0);
    const csCited = by.MECHANISM_CURRENT_STATE.cited.filter((c) => c.component === "CURRENT_STATE");
    expect(csCited.some((c) => !chainIds.has(c.id))).toBe(true);
    expect(by.MECHANISM_CURRENT_STATE.s5.CURRENT_STATE?.supporting.some((id) => !chainIds.has(id))).toBe(true);
    expect(by.PROTOCOL_REVENUE_TO_TOKEN.verdict).toBe(docsOnly.verdict);
    expect(by.PROTOCOL_REVENUE_TO_TOKEN.requirements.map((r) => `${r.requirementId}:${r.status}`)).toEqual(docsOnly.requirements.map((r) => `${r.requirementId}:${r.status}`));
    expect(by.VALUE_CAPTURE.verdict).toBe("PARTIALLY_SUPPORTED");
  }, 300_000);
});
