import { writeFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { PATTERN_V1_CONTENT, criticalComponentsFor } from "../src/server/domain/pattern";
import type { EntitlementSnapshot } from "../src/server/domain/types";
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
  topics,
  users,
} from "../src/server/db/schema";
import { prepareExtractionReplayFetcher, prepareExtractionReplayProposer, prepareExtractionReplaySearch } from "../src/server/engine/acquisition-phases";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError } from "../src/server/engine/providers/evidence-extractor";
import { createEvmOnchainAdapter, ERC20_DECIMALS_SELECTOR, ERC20_TOTAL_SUPPLY_SELECTOR } from "../src/server/engine/providers/onchain-evm";
import { __setOnchainRetriever, type OnchainRpcTransport } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ResearchBoundary } from "../src/server/engine/research-boundary";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { planTargetedRecovery, type TargetedRecoveryPlan } from "../src/server/engine/targeted-recovery";
import { beginAcquisitionPhases, handleExtractingPhase, handleFetchingPhase, handleSearchingPhase, type PhaseWorkerContext } from "../src/server/jobs/acquisition-phase-worker";
import { installOnchainResearchCapability, uninstallOnchainResearchCapability } from "../src/server/jobs/onchain-capability";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { parseWorkerCapabilities, type PhaseCapability } from "../src/server/jobs/worker-capabilities";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ECONOMICS RESEARCH RELIABILITY BENCHMARK V1 (permanent).
//
// Ten scenario families of Token Value Capture questions, each run under
// adversarial variants of source discovery and provider behaviour, in the
// unphased executor and (for a subset) the phased three-worker pipeline.
// Every run is a whole Research through the production controller,
// reducer, assembler, claim evaluator and Proof builder on fixture
// providers — no network, no model, $0.
//
// WHAT IS MEASURED PER RUN
//   critical nodes attempted        the intent's critical proof path (B3):
//                                   a node counts as attempted when its
//                                   latest attempt searched, opened or
//                                   extracted, or closed on a substantive
//                                   (not technical) boundary
//   technical critical at finalize  critical components whose Proof
//                                   boundary record still carries a
//                                   technical code — the C2 measurement
//   calls                           proposer / search / fetch / extract / rpc
//   cost + latency model            calls x per-call price and latency
//   S5 / S7 / S8                    statuses, claim status, verdict
//   parity                          phased vs unphased S5 status map
//
// SEVERITY (audit model): CRITICAL = a verdict stronger than the scenario
// allows or a component established that the corpus never supports;
// MAJOR = a critical node the corpus makes reachable in this variant that
// ended not established, or a technical boundary left on a critical node
// with a reachable path; MINOR = never asserted here (redundancy). The
// suite fails on any CRITICAL or MAJOR and prints the full table.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setOnchainRetriever(null);
  uninstallOnchainResearchCapability();
});

/* ------------------------------------------------------------------ */
/* FIXTURE VOCABULARY                                                  */
/* ------------------------------------------------------------------ */

const COMPONENTS = [
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
type Component = (typeof COMPONENTS)[number];
const GOV_COMPONENTS: ReadonlySet<string> = new Set(["GOVERNANCE_BASIS", "DURABILITY_BASIS"]);
const DAY_MS = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const COST: ModelCostProfile = { modelId: "fixture-test-model", inputPriceMicroUsdPerToken: 1, outputPriceMicroUsdPerToken: 5, maxInputTokens: 8_000, maxOutputTokens: 1_536, priceVersion: "test-fixture-not-production" };
const EVM = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
// Per-call model price from the live Aave/Lido runs ($0.18 / 22 calls) and
// the modelled latencies of the perf harness; a structural estimate.
const PRICE_PER_MODEL_CALL_USD = 0.008;
const LAT = { proposer: 1.5, search: 0.4, fetch: 0.8, extract: 2.5 };

interface FactSpec {
  fragment: string;
  mechanismState?: string | null;
  relationship?: ExtractedFact["relationship"];
  publishedAt?: Date | null;
}
interface Page {
  url: string;
  text: string;
  facts: Partial<Record<Component, FactSpec[]>>;
  links?: { href: string; text: string }[];
  fetch?: "ok" | "http404";
}
interface Scenario {
  key: string;
  title: string;
  intent: string;
  question: string;
  chain?: "solana" | "ethereum" | null;
  facts: Partial<Record<Component, FactSpec>>;
  // Components the corpus positively supports and a correct Research must
  // establish (SUPPORTED or PARTIALLY_SUPPORTED).
  mustEstablish: Component[];
  // Components that must never end SUPPORTED (the corpus denies or omits).
  mustNotSupport: Component[];
  // Verdicts a correct bounded Research may reach.
  verdictAllowed: string[];
}

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
const LIVE: Partial<Record<Component, string>> = { MECHANISM_SPEC: "LIVE", EXECUTION_EVIDENCE: "LIVE", CURRENT_STATE: "LIVE" };
function canon(over: Partial<Record<Component, FactSpec | null>> = {}): Partial<Record<Component, FactSpec>> {
  const out: Partial<Record<Component, FactSpec>> = {};
  for (const c of COMPONENTS) {
    if (c in over) {
      if (over[c]) out[c] = over[c]!;
      continue;
    }
    out[c] = { fragment: CANON[c], mechanismState: LIVE[c] ?? null };
  }
  return out;
}

const SCENARIOS: Scenario[] = [
  {
    key: "S01",
    title: "revenue -> holders",
    intent: "PROTOCOL_REVENUE_TO_TOKEN",
    question: "does protocol revenue reach token holders through an active mechanism?",
    facts: canon({
      MECHANISM_SPEC: { fragment: "each epoch the treasury distributes half of the collected fees to token holders pro rata", mechanismState: "LIVE" },
      DESTINATION: { fragment: "the distributed fees are sent to every token holder's wallet pro rata" },
      RECIPIENT: { fragment: "passive token holders receive the distribution without staking or voting" },
      NET_EFFECT: { fragment: "the distribution does not change circulating supply" },
    }),
    mustEstablish: ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"],
    mustNotSupport: [],
    verdictAllowed: ["SUPPORTED", "PARTIALLY_SUPPORTED"],
  },
  {
    key: "S02",
    title: "revenue -> buyback -> treasury",
    intent: "PROTOCOL_REVENUE_TO_TOKEN",
    question: "does protocol revenue buy back the token, and does the bought-back token go to a treasury?",
    facts: canon({
      DESTINATION: { fragment: "tokens purchased by the buyback module are sent to the protocol treasury reserve" },
      RECIPIENT: { fragment: "the treasury reserve is controlled by the DAO and holds the purchased tokens" },
      NET_EFFECT: { fragment: "the purchased tokens are held in the treasury and circulating supply is not reduced" },
    }),
    mustEstablish: ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"],
    mustNotSupport: [],
    verdictAllowed: ["SUPPORTED", "PARTIALLY_SUPPORTED"],
  },
  {
    key: "S03",
    title: "revenue -> buyback -> burn",
    intent: "VALUE_CAPTURE",
    question: "does protocol revenue buy back the token and burn it?",
    facts: canon(),
    mustEstablish: ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"],
    mustNotSupport: [],
    verdictAllowed: ["SUPPORTED", "PARTIALLY_SUPPORTED"],
  },
  {
    key: "S04",
    title: "buyback without burn",
    intent: "VALUE_CAPTURE",
    question: "does the buyback reduce token supply, or are the repurchased tokens kept?",
    facts: canon({
      DESTINATION: { fragment: "tokens purchased by the buyback module are transferred to the ecosystem reserve and are not burned" },
      RECIPIENT: { fragment: "the ecosystem reserve holds the repurchased tokens for grants and staking rewards" },
      NET_EFFECT: { fragment: "the repurchased tokens remain in existence and total supply is unchanged" },
    }),
    mustEstablish: ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"],
    mustNotSupport: [],
    verdictAllowed: ["SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"],
  },
  {
    key: "S05",
    title: "burn + issuance",
    intent: "BURN_OR_SUPPLY_EFFECT",
    question: "is token supply reduced on net when burns coexist with new issuance?",
    facts: canon({
      NET_EFFECT: { fragment: "tokens are burned each epoch while new tokens are issued to validators; the net change in supply is not reported" },
    }),
    // EXECUTION_EVIDENCE is never documentary-establishable (OFFICIAL_REPORT
    // / on-chain only); the corpus can establish the mechanism.
    mustEstablish: ["MECHANISM_SPEC"],
    mustNotSupport: [],
    verdictAllowed: ["SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"],
  },
  {
    key: "S06",
    title: "governance approved but not executing",
    intent: "MECHANISM_CURRENT_STATE",
    question: "is the fee switch approved, and is it currently executing?",
    facts: canon({
      MECHANISM_SPEC: { fragment: "the fee switch directs a share of protocol fees to the token treasury once activated", mechanismState: "APPROVED" },
      GOVERNANCE_BASIS: { fragment: "the fee switch proposal passed the token holder vote", mechanismState: "APPROVED" },
      EXECUTION_EVIDENCE: null,
      CURRENT_STATE: { fragment: "the fee switch is approved but has not been activated; no fees are being directed yet", mechanismState: "APPROVED" },
      DESTINATION: { fragment: "once activated, the fee share would be sent to the token treasury" },
      NET_EFFECT: null,
    }),
    mustEstablish: ["MECHANISM_SPEC", "GOVERNANCE_BASIS"],
    mustNotSupport: ["EXECUTION_EVIDENCE"],
    verdictAllowed: ["PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE", "NOT_SUPPORTED"],
  },
  {
    key: "S07",
    title: "documented but not activated",
    intent: "MECHANISM_CURRENT_STATE",
    question: "is the documented buyback mechanism actually live?",
    facts: canon({
      MECHANISM_SPEC: { fragment: "the buyback module is described in the design documentation and is proposed for a future release", mechanismState: "PROPOSED" },
      GOVERNANCE_BASIS: null,
      EXECUTION_EVIDENCE: null,
      CURRENT_STATE: { fragment: "the buyback module has not been deployed or activated", mechanismState: "PROPOSED" },
      NET_EFFECT: null,
    }),
    mustEstablish: ["MECHANISM_SPEC"],
    mustNotSupport: ["EXECUTION_EVIDENCE", "GOVERNANCE_BASIS"],
    verdictAllowed: ["PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE", "NOT_SUPPORTED"],
  },
  {
    key: "S08",
    title: "unclear token destination",
    intent: "PROTOCOL_REVENUE_TO_TOKEN",
    question: "where do the repurchased tokens end up?",
    facts: canon({ DESTINATION: null, RECIPIENT: null, NET_EFFECT: null }),
    mustEstablish: ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE"],
    mustNotSupport: ["DESTINATION"],
    verdictAllowed: ["PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"],
  },
  {
    key: "S09",
    title: "Solana full path",
    intent: "VALUE_CAPTURE",
    question: "does protocol revenue buy back and burn the token on Solana?",
    chain: "solana",
    facts: canon(),
    mustEstablish: ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"],
    mustNotSupport: [],
    verdictAllowed: ["SUPPORTED", "PARTIALLY_SUPPORTED"],
  },
  {
    key: "S10",
    title: "EVM full path",
    intent: "PROTOCOL_REVENUE_TO_TOKEN",
    question: "does protocol revenue reach the token on Ethereum through a buyback?",
    chain: "ethereum",
    facts: canon({ DESTINATION: { fragment: "tokens purchased by the buyback module are sent to the protocol treasury reserve" } }),
    mustEstablish: ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"],
    mustNotSupport: [],
    verdictAllowed: ["SUPPORTED", "PARTIALLY_SUPPORTED"],
  },
];

const VARIANTS = [
  "BASELINE",
  "OFFICIAL_LATE",
  "WEAK_BEFORE_STRONG",
  "SITE_LOCAL_ONLY",
  "STALE",
  "CONTRADICTION",
  "UNAVAILABLE_404",
  "TRANSIENT",
  "CHAIN_EARLY",
  "CRITICAL_LATE",
  "REORDER",
  "MEMORY_ON",
] as const;
type Variant = (typeof VARIANTS)[number];
const PHASED_VARIANTS: Variant[] = ["BASELINE", "OFFICIAL_LATE", "SITE_LOCAL_ONLY", "CRITICAL_LATE"];

/* ------------------------------------------------------------------ */
/* CORPUS BUILDER                                                      */
/* ------------------------------------------------------------------ */

interface Project {
  id: string;
  slug: string;
  name: string;
  host: string;
  govHost: string;
}
interface Corpus {
  pages: Page[];
  // Search results per component, in order (urls). Absent = the pages
  // carrying facts for the component, in page order.
  search: Partial<Record<Component, string[]>>;
  // Extractor transient failure once (TRANSIENT variant).
  transientOnce: boolean;
  memoryOn: boolean;
  // Components the variant makes unreachable (excluded from mustEstablish).
  unreachable: Set<Component>;
}

function officialUrl(p: Project, c: Component): string {
  const slug = c.toLowerCase().replace(/_/g, "-");
  return GOV_COMPONENTS.has(c) ? `https://${p.govHost}/proposals/${slug}` : `https://${p.host}/docs/${slug}`;
}

function buildCorpus(s: Scenario, p: Project, v: Variant): Corpus {
  const pages: Page[] = [];
  const search: Partial<Record<Component, string[]>> = {};
  const unreachable = new Set<Component>();
  const stale = v === "STALE";
  for (const c of COMPONENTS) {
    const f = s.facts[c];
    if (!f) continue;
    pages.push({
      url: officialUrl(p, c),
      text: `${p.name} — ${c.toLowerCase().replace(/_/g, " ")}. ${f.fragment}.`,
      facts: { [c]: [{ ...f, publishedAt: stale ? daysAgo(400) : (f.publishedAt ?? daysAgo(1)) }] },
    });
  }
  const official = (c: Component) => pages.find((pg) => pg.facts[c])?.url ?? null;
  if (stale) for (const c of ["CURRENT_STATE", "EXECUTION_EVIDENCE"] as Component[]) unreachable.add(c);
  switch (v) {
    case "OFFICIAL_LATE": {
      for (const c of COMPONENTS) {
        const u = official(c);
        if (!u) continue;
        const noise = [1, 2, 3].map((i) => `https://news.example.test/${s.key.toLowerCase()}/${c.toLowerCase()}-${i}`);
        for (const n of noise) pages.push({ url: n, text: `${p.name} news ${n}`, facts: {} });
        search[c] = [...noise, u];
      }
      break;
    }
    case "WEAK_BEFORE_STRONG": {
      for (const c of COMPONENTS) {
        const u = official(c);
        const f = s.facts[c];
        if (!u || !f) continue;
        const weak = `https://blog.example.test/${s.key.toLowerCase()}/${c.toLowerCase()}`;
        pages.push({ url: weak, text: `${p.name} blog. ${f.fragment}.`, facts: { [c]: [{ ...f, publishedAt: daysAgo(2) }] } });
        search[c] = [weak, u];
      }
      break;
    }
    case "SITE_LOCAL_ONLY": {
      // Search finds only the docs index for the two critical documentary
      // components; their official pages are reachable through the index's
      // links alone (bounded site-local expansion, K = 4 per route). Every
      // other page is found by search as usual.
      const index = `https://${p.host}/docs/`;
      const hidden: Component[] = ["MECHANISM_SPEC", "DESTINATION"];
      const links = COMPONENTS.filter((c) => official(c) && !GOV_COMPONENTS.has(c)).map((c) => ({ href: `/docs/${c.toLowerCase().replace(/_/g, "-")}`, text: `${c.toLowerCase().replace(/_/g, " ")} — ${(s.facts[c]?.fragment ?? "").slice(0, 60)}` }));
      pages.push({ url: index, text: `${p.name} documentation index`, facts: {}, links });
      for (const c of hidden) if (official(c)) search[c] = [index];
      break;
    }
    case "CONTRADICTION": {
      const u = official("DESTINATION");
      if (u) {
        const contra = `https://${p.host}/docs/destination-notice`;
        pages.push({ url: contra, text: `${p.name} notice: the repurchased tokens are burned, not held.`, facts: { DESTINATION: [{ fragment: "the repurchased tokens are burned rather than sent to any reserve or holder", relationship: "CONTRADICTS", publishedAt: daysAgo(1) }] } });
        search.DESTINATION = [u, contra];
        unreachable.add("DESTINATION");
      }
      break;
    }
    case "UNAVAILABLE_404": {
      const u = official("MECHANISM_SPEC");
      if (u) {
        const pg = pages.find((x) => x.url === u)!;
        pg.fetch = "http404";
        unreachable.add("MECHANISM_SPEC");
      }
      break;
    }
    case "CRITICAL_LATE": {
      // MECHANISM_SPEC's own search finds nothing; its official page is
      // surfaced only by the LAST component's search.
      const u = official("MECHANISM_SPEC");
      if (u) {
        search.MECHANISM_SPEC = [];
        search.DURABILITY_BASIS = [...(official("DURABILITY_BASIS") ? [official("DURABILITY_BASIS")!] : []), u];
      }
      break;
    }
    case "REORDER": {
      for (const c of COMPONENTS) {
        const urls = pages.filter((pg) => pg.facts[c]).map((pg) => pg.url).reverse();
        if (urls.length > 0) search[c] = urls;
      }
      break;
    }
    default:
      break;
  }
  return { pages, search, transientOnce: v === "TRANSIENT", memoryOn: v === "MEMORY_ON", unreachable };
}

/* ------------------------------------------------------------------ */
/* PROVIDERS                                                           */
/* ------------------------------------------------------------------ */

interface Counters {
  proposer: number;
  search: number;
  fetch: number;
  extract: number;
  rpc: number;
}

function fetchedDoc(pg: Page): FetchedDocument {
  return {
    finalUrl: pg.url,
    requestedUrl: pg.url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: pg.text,
    contentHash: `sha256:${pg.url}:${pg.text.length}`,
    fetchedAt: new Date(),
    byteLength: pg.text.length,
    documentLinks: pg.links ? { links: pg.links.map((l) => ({ href: l.href, text: l.text, host: null, heading: null, context: null, resolvedIdentifier: null })), identifiers: [], hosts: [], truncated: false } : null,
  };
}

function providers(project: Project, corpus: Corpus, c: Counters) {
  const byUrl = new Map(corpus.pages.map((pg) => [pg.url, pg]));
  let transientLeft = corpus.transientOnce ? 1 : 0;
  return {
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input: { target: { component: string } }) {
        c.proposer += 1;
        const comp = input.target.component;
        return [`${comp} of ${project.name}`, `${project.name} ${comp} documentation`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(_query: string, target: { component: string }) {
        c.search += 1;
        const comp = target.component as Component;
        const urls = corpus.search[comp] ?? corpus.pages.filter((pg) => pg.facts[comp]).map((pg) => pg.url);
        return urls.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        c.fetch += 1;
        const pg = byUrl.get(url);
        if (!pg) throw new ContentFetchError("HTTP_ERROR", "fixture: unknown url", url, 404);
        if (pg.fetch === "http404") throw new ContentFetchError("HTTP_ERROR", "fixture: gone", url, 404);
        return fetchedDoc(pg);
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input: { target: { step: number; component: string }; document: FetchedDocument }) {
        c.extract += 1;
        if (transientLeft > 0) {
          transientLeft -= 1;
          throw new EvidenceExtractorUnavailableError("generation failed: NETWORK_NO_RESPONSE", true, "NETWORK_NO_RESPONSE", null);
        }
        const pg = byUrl.get(input.document.finalUrl);
        if (!pg) return [];
        const comp = input.target.component as Component;
        return (pg.facts[comp] ?? []).map(
          (f): ExtractedFact => ({
            step: input.target.step,
            component: comp,
            statement: `${comp.toLowerCase().replace(/_/g, " ")}: ${f.fragment}`,
            supportFragment: f.fragment,
            mechanismState: f.mechanismState ?? null,
            directness: "DIRECT",
            publishedAt: f.publishedAt ?? daysAgo(1),
            doesNotProve: "does not prove the size of the effect",
            relationship: f.relationship ?? "SUPPORTS",
            onchainLocator: null,
            onchainLocators: null,
          }),
        );
      },
    },
  };
}

function installChain(scenario: Scenario, variant: Variant, c: Counters): void {
  const chain = scenario.chain ?? (variant === "CHAIN_EARLY" ? "ethereum" : null);
  if (!chain) return;
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  const envelope = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
  const transport: OnchainRpcTransport = {
    async call(method, params) {
      c.rpc += 1;
      if (method === "eth_chainId") return envelope("0x1");
      if (method === "eth_getBlockByNumber") return envelope({ number: "0x1234abc", hash: "0x" + "ef".repeat(32), timestamp: "0x66f2a1c0" });
      if (method === "eth_call") {
        const data = (params[0] as { data: string }).data;
        if (data === ERC20_TOTAL_SUPPLY_SELECTOR) return envelope(word(BigInt("1000000000000000000000000000")));
        if (data === ERC20_DECIMALS_SELECTOR) return envelope(word(BigInt(18)));
      }
      throw new Error(`fixture rpc: unexpected ${method}`);
    },
  };
  if (chain === "ethereum") {
    const adapter = createEvmOnchainAdapter({ transport, providerId: "fixture-evm-rpc", environment: { chain: "ethereum", network: "mainnet" } });
    installOnchainResearchCapability({
      capabilities: new Set(["SEARCH_EXTRACT"]),
      env: { ONCHAIN_RESEARCH_ENABLED: "1", ETHEREUM_MAINNET_RPC_URL: "https://fixture.invalid/rpc" },
      create: (ch, net) => (ch === "ethereum" && net === "mainnet" ? adapter : null),
    });
  }
}

/* ------------------------------------------------------------------ */
/* JOBS AND RUNS                                                       */
/* ------------------------------------------------------------------ */

async function makeProject(scenario: Scenario, variant: Variant): Promise<Project> {
  const slug = uniq("bm");
  const name = `Bench ${scenario.key} ${slug.slice(-6)}`;
  const host = `docs.${slug.replace(/_/g, "-")}.example`;
  const govHost = `vote.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const docsClass = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!docsClass.ok) throw new Error("docs classify failed: " + docsClass.refusal);
  const gov = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: govHost, pathPrefix: "/proposals" });
  if (!gov.ok) throw new Error("gov confirm failed: " + gov.refusal);
  const govClass = await classifySourceRoute(ctx.db, { routeId: gov.itemId, routeClass: "GOVERNANCE" });
  if (!govClass.ok) throw new Error("gov classify failed: " + govClass.refusal);
  const chain = scenario.chain ?? (variant === "CHAIN_EARLY" ? "ethereum" : null);
  if (chain === "ethereum") {
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "ethereum", tokenAddress: EVM, ticker: "BM" });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  } else if (chain === "solana") {
    const r = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT, ticker: "BM" });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, name, host, govHost };
}

async function newJob(project: Project, scenario: Scenario, opts: { enqueue?: boolean } = {}): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const base = coreEntitlement();
  const entitlement: EntitlementSnapshot = { ...base, budget: { ...INTERNAL_ALPHA_V1 } };
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: scenario.question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: scenario.question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: !opts.enqueue },
  );
  await ctx.db.insert(interpretations).values({
    userId: user.id,
    researchJobId: job.id,
    originalQuestion: scenario.question,
    status: "READY",
    result: {
      status: "READY",
      project_or_asset: project.slug,
      related_entities: [],
      topic: null,
      task_type: "VERIFY_MECHANISM",
      research_task: scenario.question,
      understood_summary: null,
      user_assumptions: [],
      ambiguities: [],
      clarification_question: null,
      route: "DEEP_RESEARCH",
      normalized_intent: scenario.intent,
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  return job.id;
}

async function setMemoryEnabled(value: boolean): Promise<void> {
  await ctx.db.insert(productConfig).values({ key: "memory_enabled", value }).onConflictDoUpdate({ target: productConfig.key, set: { value } });
}

interface RunResult {
  jobId: string;
  scenario: string;
  variant: Variant;
  runtime: "UNPHASED" | "PHASED";
  state: string;
  verdict: string | null;
  claim: string | null;
  s5: Record<string, string>;
  critical: string[];
  criticalAttempted: number;
  configBounded: string[];
  technicalCritical: string[];
  recovery: { planned: number; attempts: number } | null;
  // C1 DECISION DATA — critical components whose FIRST attempt closed on
  // the spent search axis, with their final S5 status; and the envelope
  // actually reserved at finalize (search/opens) against its ceilings.
  searchBoundedCritical: string[];
  envelope: string;
  // C2 DECISION DATA — unresolved critical components for which a known
  // admissible path (sealed-unextracted, unopened candidate, unexplored
  // confirmed route) was STILL available when the job finalized, read
  // through the second-pass planner in audit mode.
  unexploredAtFinalize: string[];
  // C2 split: the subset of unexploredAtFinalize whose critical node never
  // had a recovery attempt at all — the completion defect proper. What is
  // left after the one bounded recovery ran is the one-recovery maximum
  // by design (never a third pass), not a node the Research skipped.
  unexploredWithoutRecovery: string[];
  calls: Counters;
  costUsd: number;
  latencyModelSec: number;
  severity: { level: "CRITICAL" | "MAJOR"; note: string }[];
}

function unphasedExecutor(project: Project, corpus: Corpus, c: Counters, chainEnabled: boolean): WorkExecutor {
  const p = providers(project, corpus, c);
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    chainAcquisition: chainEnabled ? "ENABLED" : "DOCUMENTARY_ONLY",
    ...p,
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

const ROLE_SE: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("SEARCH_EXTRACT");
const ROLE_FETCH: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("FETCH");
const roleCtx = (capabilities: ReadonlySet<PhaseCapability>): PhaseWorkerContext => ({ db: ctx.db, boss: ctx.boss, capabilities });

async function runOne(scenario: Scenario, variant: Variant, runtime: "UNPHASED" | "PHASED"): Promise<RunResult> {
  const c: Counters = { proposer: 0, search: 0, fetch: 0, extract: 0, rpc: 0 };
  const project = await makeProject(scenario, variant);
  const corpus = buildCorpus(scenario, project, variant);
  await setMemoryEnabled(corpus.memoryOn);
  installChain(scenario, variant, c);
  const chainEnabled = scenario.chain !== undefined && scenario.chain !== null || variant === "CHAIN_EARLY";
  let jobId: string;
  let recovery: RunResult["recovery"] = null;
  try {
    if (runtime === "UNPHASED") {
      jobId = await newJob(project, scenario);
      const executor = unphasedExecutor(project, corpus, c, chainEnabled);
      const handled = await handleResearchJobTask(ctx.db, jobId, executor);
      if (!handled.claimed) throw new Error("job not claimed");
    } else {
      jobId = await newJob(project, scenario, { enqueue: true });
      await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
      const p = providers(project, corpus, c);
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        await handleSearchingPhase(roleCtx(ROLE_SE), jobId, { queryProposer: p.queryProposer, searchGateway: p.searchGateway, queryProposerCostProfile: COST });
        await handleFetchingPhase(roleCtx(ROLE_FETCH), jobId, p.contentFetcher);
        const extract = await handleExtractingPhase(roleCtx(ROLE_SE), jobId, (replay) =>
          createS4WorkExecutor({
            db: ctx.db,
            project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
            chainAcquisition: chainEnabled ? "ENABLED" : "DOCUMENTARY_ONLY",
            queryProposer: replay.queryProposer,
            searchGateway: replay.searchGateway,
            contentFetcher: replay.contentFetcher,
            evidenceExtractor: p.evidenceExtractor,
            queryProposerCostProfile: COST,
            evidenceExtractorCostProfile: COST,
          }),
        );
        if (!extract.ran) throw new Error("phased extraction refused: " + extract.refusal);
        if (extract.controller?.targetedRecovery) {
          recovery = { planned: extract.controller.targetedRecovery.items.length, attempts: extract.controller.targetedRecoveryAttempts ?? 0 };
        }
        if (extract.advancedTo === null) break;
      }
      // The worker would finalize the job state here; the phased handler
      // already persisted S5..S8. Mark SUCCEEDED the way the worker does
      // for a WORK_QUEUE_EXHAUSTED controller stop.
      await ctx.db.update(researchJobs).set({ state: "SUCCEEDED", terminationReason: "WORK_QUEUE_EXHAUSTED", finishedAt: new Date() }).where(eq(researchJobs.id, jobId));
    }
  } finally {
    await setMemoryEnabled(false);
  }
  return collect(scenario, variant, runtime, jobId, corpus, c, recovery);
}

async function collect(scenario: Scenario, variant: Variant, runtime: RunResult["runtime"], jobId: string, corpus: Corpus, c: Counters, recovery: RunResult["recovery"]): Promise<RunResult> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const s5rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
  const s5: Record<string, string> = {};
  for (const r of s5rows) s5[r.component] = r.status;
  const critical = criticalComponentsFor(PATTERN_V1_CONTENT, scenario.intent);
  const bounded = (proof?.boundedBy ?? { technical: [], substantive: [] }) as ResearchBoundary;
  const technicalCritical = bounded.technical.filter((t) => critical.includes(t.component)).map((t) => t.component);
  // Attempted: the latest attempt did real work, or closed substantively.
  const latest = new Map<string, (typeof attempts)[number]>();
  for (const a of attempts) {
    const cur = latest.get(a.component);
    if (!cur || a.attemptNumber > cur.attemptNumber) latest.set(a.component, a);
  }
  let criticalAttempted = 0;
  const configBounded: string[] = [];
  for (const comp of critical) {
    const a = latest.get(comp);
    if (!a) continue;
    const worked = a.searchQueriesSpent > 0 || a.sourceOpensSpent > 0 || a.modelCostMicroSpent > 0 || rows.some((r) => r.component === comp);
    const technical = technicalCritical.includes(comp);
    // A component with NO admissible route in this project's configuration
    // (no owner-confirmed route for its only establishing classes) has
    // nothing to attempt; it is bounded by configuration, not skipped.
    const entry = bounded.technical.find((t) => t.component === comp);
    const configurationBounded = entry !== undefined && entry.codes.length > 0 && entry.codes.every((code) => code === "NO_ADMISSIBLE_ROUTE");
    if (configurationBounded) configBounded.push(comp);
    if (worked || !technical || configurationBounded) criticalAttempted += 1;
  }
  const searchBoundedCritical: string[] = [];
  for (const comp of critical) {
    const first = attempts.find((a) => a.component === comp && a.attemptNumber === 1);
    if (!first) continue;
    const head = (first.reason ?? "").split(";")[0].trim();
    if (first.status === "SKIPPED" && head === "SEARCH_BUDGET_EXHAUSTED") searchBoundedCritical.push(`${comp}:${s5[comp] ?? "no row"}`);
  }
  const budget = job.budgetAtStart as { maxSearchQueries: number; maxSourceOpens: number };
  const envelope = `s${job.searchQueriesReserved}/${budget.maxSearchQueries} o${job.sourceOpensReserved}/${budget.maxSourceOpens}`;
  const { view } = await loadJobContractView(ctx.db, jobId);
  const audit = await planTargetedRecovery(ctx.db, jobId, job.projectId, view.workQueue, { audit: true });
  const unexploredAtFinalize = (audit?.items ?? []).map((i) => {
    const kinds = new Map<string, number>();
    for (const p of i.paths) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
    return `${i.component}[${[...kinds].map(([k, n]) => `${k}=${n}`).join(",")}]`;
  });
  const unexploredWithoutRecovery = (audit?.items ?? []).filter((i) => (latest.get(i.component)?.attemptNumber ?? 0) <= 1).map((i) => i.component);
  const modelCalls = c.proposer + c.extract;
  const costUsd = modelCalls * PRICE_PER_MODEL_CALL_USD;
  const latencyModelSec = c.proposer * LAT.proposer + (c.search * LAT.search) / 4 + (c.fetch * LAT.fetch) / 4 + (c.extract * LAT.extract) / 4;
  if (!recovery && runtime === "UNPHASED") {
    const second = attempts.filter((a) => a.attemptNumber === 2);
    if (second.length > 0) recovery = { planned: second.length, attempts: second.length };
  }

  const severity: RunResult["severity"] = [];
  const verdict = proof?.verdict ?? null;
  if (verdict && !scenario.verdictAllowed.includes(verdict)) severity.push({ level: "CRITICAL", note: `verdict ${verdict} not in ${scenario.verdictAllowed.join("/")}` });
  for (const comp of scenario.mustNotSupport) if (s5[comp] === "SUPPORTED") severity.push({ level: "CRITICAL", note: `${comp} SUPPORTED against the corpus` });
  for (const comp of scenario.mustEstablish) {
    if (corpus.unreachable.has(comp)) continue;
    if (s5[comp] === "SUPPORTED" || s5[comp] === "PARTIALLY_SUPPORTED") continue;
    severity.push({ level: "MAJOR", note: `${comp} not established (${s5[comp] ?? "no row"}) though reachable` });
  }
  for (const entry of bounded.technical) {
    if (!critical.includes(entry.component)) continue;
    if (corpus.unreachable.has(entry.component as Component)) continue;
    // NO_ADMISSIBLE_ROUTE is a configuration boundary (no owner-confirmed
    // route for the only establishing classes), not a path left unread.
    if (entry.codes.every((code) => code === "NO_ADMISSIBLE_ROUTE")) continue;
    severity.push({ level: "MAJOR", note: `${entry.component} left on a technical boundary with a reachable path (${entry.codes.join(",")})` });
  }
  return {
    jobId,
    scenario: scenario.key,
    variant,
    runtime,
    state: job.state,
    verdict,
    claim: claim?.status ?? null,
    s5,
    critical,
    criticalAttempted,
    configBounded,
    technicalCritical,
    recovery,
    searchBoundedCritical,
    envelope,
    unexploredAtFinalize,
    unexploredWithoutRecovery,
    calls: c,
    costUsd,
    latencyModelSec,
    severity,
  };
}

/* ------------------------------------------------------------------ */
/* THE MATRIX                                                          */
/* ------------------------------------------------------------------ */

const results: RunResult[] = [];

describe("ECONOMICS RESEARCH RELIABILITY BENCHMARK V1", () => {
  for (const scenario of SCENARIOS) {
    for (const variant of VARIANTS) {
      it(`${scenario.key} ${scenario.title} — ${variant} — UNPHASED`, async () => {
        const r = await runOne(scenario, variant, "UNPHASED");
        results.push(r);
        expect(r.state).toBe("SUCCEEDED");
        expect(r.verdict, "a Proof exists").not.toBeNull();
        expect(r.severity.map((s) => `${s.level}: ${s.note}`)).toEqual([]);
        expect(r.criticalAttempted, `critical nodes attempted ${r.criticalAttempted}/${r.critical.length}`).toBe(r.critical.length);
      }, 180_000);
    }
    for (const variant of PHASED_VARIANTS) {
      it(`${scenario.key} ${scenario.title} — ${variant} — PHASED`, async () => {
        const r = await runOne(scenario, variant, "PHASED");
        results.push(r);
        expect(r.verdict, "a Proof exists").not.toBeNull();
        expect(r.severity.map((s) => `${s.level}: ${s.note}`)).toEqual([]);
        expect(r.criticalAttempted).toBe(r.critical.length);
        // PARITY: the unphased run of the same scenario/variant reached
        // the same S5 statuses per component.
        const twin = results.find((x) => x.scenario === scenario.key && x.variant === variant && x.runtime === "UNPHASED");
        expect(twin).toBeDefined();
        expect(r.s5).toEqual(twin!.s5);
      }, 240_000);
    }
  }

  it("REPORT — the benchmark table (structure + cost + latency model + C1/C2 data)", () => {
    const lines: string[] = [];
    lines.push("scenario | variant | runtime | verdict | claim | crit attempted | tech-critical | recovery | search-bounded crit (first pass:final) | envelope | unexplored@finalize | proposer/search/fetch/extract/rpc | $ | lat s");
    let totalCritical = 0;
    let totalAttempted = 0;
    let runsWithRecovery = 0;
    let runsWithTechnicalCritical = 0;
    for (const r of results) {
      totalCritical += r.critical.length;
      totalAttempted += r.criticalAttempted;
      if (r.recovery) runsWithRecovery += 1;
      if (r.technicalCritical.length > 0) runsWithTechnicalCritical += 1;
      lines.push(
        `${r.scenario} | ${r.variant} | ${r.runtime} | ${r.verdict} | ${r.claim} | ${r.criticalAttempted}/${r.critical.length} | ${r.technicalCritical.join(",") || "-"} | ${r.recovery ? `${r.recovery.attempts}/${r.recovery.planned}` : "-"} | ${r.searchBoundedCritical.join(",") || "-"} | ${r.envelope} | ${r.unexploredAtFinalize.join(",") || "-"} | ${r.calls.proposer}/${r.calls.search}/${r.calls.fetch}/${r.calls.extract}/${r.calls.rpc} | ${r.costUsd.toFixed(3)} | ${r.latencyModelSec.toFixed(1)}`,
      );
    }
    lines.push(`runs: ${results.length}; critical attempted: ${totalAttempted}/${totalCritical} (${((100 * totalAttempted) / Math.max(1, totalCritical)).toFixed(1)}%)`);
    lines.push(`runs needing the targeted second pass: ${runsWithRecovery}; runs finalizing with a technical boundary on a critical node: ${runsWithTechnicalCritical}`);
    // C1 / C2 decision data (measured, not asserted).
    const searchBoundedRuns = results.filter((r) => r.searchBoundedCritical.length > 0);
    const searchBoundedNodes = results.reduce((n, r) => n + r.searchBoundedCritical.length, 0);
    const searchBoundedRecovered = results.reduce((n, r) => n + r.searchBoundedCritical.filter((x) => /:(SUPPORTED|PARTIALLY_SUPPORTED)$/.test(x)).length, 0);
    const envelopeSpent = results.filter((r) => /^s(\d+)\/(\d+) /.test(r.envelope) && r.envelope.replace(/^s(\d+)\/(\d+) .*$/, "$1") === r.envelope.replace(/^s(\d+)\/(\d+) .*$/, "$2"));
    const unexploredRuns = results.filter((r) => r.unexploredAtFinalize.length > 0);
    lines.push(`C1: critical nodes whose first attempt closed SEARCH_BUDGET_EXHAUSTED: ${searchBoundedNodes} in ${searchBoundedRuns.length} runs; of those nodes established by finalize: ${searchBoundedRecovered}; runs with the search envelope fully reserved at finalize: ${envelopeSpent.length}`);
    lines.push(`C2: runs finalizing with an unresolved critical node AND a known admissible path still unexplored: ${unexploredRuns.length}${unexploredRuns.length > 0 ? " — " + unexploredRuns.map((r) => `${r.scenario}/${r.variant}/${r.runtime}: ${r.unexploredAtFinalize.join(",")}`).join("; ") : ""}`);
    const unrecoveredRuns = results.filter((r) => r.unexploredWithoutRecovery.length > 0);
    lines.push(`C2 split — of those, nodes for which NO recovery attempt ever ran (the completion defect): ${unrecoveredRuns.length} runs${unrecoveredRuns.length > 0 ? " — " + unrecoveredRuns.map((r) => `${r.scenario}/${r.variant}/${r.runtime}: ${r.unexploredWithoutRecovery.join(",")}`).join("; ") : ""}; paths left after the ONE bounded recovery ran (one-recovery maximum by design): ${unexploredRuns.length - unrecoveredRuns.length} runs`);
    const avgCost = results.reduce((n, r) => n + r.costUsd, 0) / Math.max(1, results.length);
    const avgLat = results.reduce((n, r) => n + r.latencyModelSec, 0) / Math.max(1, results.length);
    lines.push(`avg model cost/run $${avgCost.toFixed(3)}; avg modelled latency ${avgLat.toFixed(1)} s`);
    const report = "ECONOMICS RESEARCH RELIABILITY BENCHMARK V1\n" + lines.join("\n") + "\n";
    console.log("\n" + report);
    // The table is the C1/C2 measurement; a reporter that swallows test
    // stdout must not swallow it. ATLAS_BENCH_REPORT_PATH names a file to
    // receive it (unset in CI and in the ordinary run).
    if (process.env.ATLAS_BENCH_REPORT_PATH) writeFileSync(process.env.ATLAS_BENCH_REPORT_PATH, report);
    expect(totalAttempted).toBe(totalCritical);
    expect(results.every((r) => r.severity.length === 0)).toBe(true);
  });
});

// Debug hook for scratch diagnostics (not part of the matrix).
export function __bench() {
  return { ctx: () => ctx, SCENARIOS, runOne };
}
