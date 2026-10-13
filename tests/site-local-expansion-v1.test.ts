import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { acquiredDocuments, evidence, interpretations, projects, researchAttempts, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { loadAcquisitionLedger } from "../src/server/engine/acquisition-ledger";
import { runFetchPhase, runSearchPhase } from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ComponentTarget, ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import {
  expansionTerms,
  MAX_SITE_LOCAL_PER_ROUTE,
  selectSiteLocalExpansion,
  SITE_LOCAL_PROVIDER,
  tokenize,
  type ConfirmedRoute,
  componentVocabulary,
  orderExpansionForComponent,
  type HarvestedDocument,
} from "../src/server/engine/site-local-expansion";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import { canonicalTargetRef } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// BOUNDED SITE-LOCAL EXPANSION (Research Reliability V1, B1).
//
// An official page that exists inside an already-confirmed route but that
// external search never surfaces is reachable in one click from a page
// the Research already read. The expansion admits at most K same-route
// pages per confirmed route, ranked by lexical overlap with the question,
// as ORDINARY candidates. It follows nothing recursively, nothing on
// another host, nothing outside the confirmed prefix, and nothing that
// shares no term with the question.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const HOST = "docs.expansion.test";
const ROUTE: ConfirmedRoute = { domain: HOST, pathPrefix: "/mechanism", routeClass: "OFFICIAL_DOCS" };
const TERMS = expansionTerms(["does the buyback mechanism reduce token supply and where do repurchased tokens go", "identify the destination of the repurchased tokens"]);
const doc = (url: string, links: { href: string; text: string }[]): HarvestedDocument => ({ url, links });

/* ------------------------------------------------------------------ */
/* 1. SELECTION                                                        */
/* ------------------------------------------------------------------ */

describe("selectSiteLocalExpansion — same route, relevant, bounded, deterministic", () => {
  it("tokenizes the question into a term set without stop words", () => {
    expect(tokenize("Does the BUYBACK mechanism reduce token supply?")).toEqual(["buyback", "mechanism", "reduce", "token", "supply"]);
    expect(TERMS.has("buyback")).toBe(true);
    expect(TERMS.has("the")).toBe(false);
  });

  it("official page only reachable through another official page: a same-route link with question terms is admitted; the source page itself is not", () => {
    const out = selectSiteLocalExpansion({
      documents: [doc(`https://${HOST}/mechanism/`, [{ href: "/mechanism/buyback", text: "Buyback program" }])],
      routes: [ROUTE],
      terms: TERMS,
      known: new Set(),
    });
    expect(out.map((c) => c.url)).toEqual([`https://${HOST}/mechanism/buyback`]);
    expect(out[0].routeClass).toBe("OFFICIAL_DOCS");
    expect(out[0].score).toBeGreaterThan(0);
  });

  it("irrelevant navigation links share no term with the question and are never admitted", () => {
    const out = selectSiteLocalExpansion({
      documents: [doc(`https://${HOST}/mechanism/`, [
        { href: "/mechanism/legal", text: "Legal" },
        { href: "/mechanism/brand-kit", text: "Brand kit" },
        { href: "/mechanism/support", text: "Support" },
      ])],
      routes: [ROUTE],
      terms: TERMS,
      known: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("duplicate links (repeated, fragment-only, trailing slash) are one candidate; already-known and already-fetched urls are excluded", () => {
    const out = selectSiteLocalExpansion({
      documents: [doc(`https://${HOST}/mechanism/`, [
        { href: "/mechanism/buyback", text: "Buyback" },
        { href: "/mechanism/buyback#how", text: "Buyback (how)" },
        { href: `https://${HOST}/mechanism/buyback/`, text: "Buyback" },
        { href: "/mechanism/token-supply", text: "Token supply" },
      ])],
      routes: [ROUTE],
      terms: TERMS,
      known: new Set([canonicalTargetRef(`https://${HOST}/mechanism/token-supply`)]),
    });
    expect(out.map((c) => c.url)).toEqual([`https://${HOST}/mechanism/buyback`]);
  });

  it("host mismatch, redirect target on another host, subdomain, http, external and script links are refused; a path outside the confirmed prefix is refused", () => {
    const out = selectSiteLocalExpansion({
      documents: [doc(`https://${HOST}/mechanism/`, [
        { href: "https://other.example/mechanism/buyback", text: "Buyback" },
        { href: `https://sub.${HOST}/mechanism/buyback`, text: "Buyback" },
        { href: `http://${HOST}/mechanism/buyback`, text: "Buyback" },
        { href: "https://evil.test/mechanism/buyback", text: "Buyback" },
        { href: "javascript:alert(1)", text: "Buyback" },
        { href: "mailto:x@y.test", text: "Buyback" },
        { href: "/blog/buyback", text: "Buyback" },
        { href: "/mechanism/buyback.pdf", text: "Buyback report" },
      ])],
      routes: [ROUTE],
      terms: TERMS,
      known: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("official page first vs late: rank is by overlap then discovery order, capped at K per route, and a late page with more overlap wins its place", () => {
    const links = [
      { href: "/mechanism/token", text: "Token" },
      { href: "/mechanism/supply", text: "Supply" },
      { href: "/mechanism/mechanism", text: "Mechanism" },
      { href: "/mechanism/reduce", text: "Reduce" },
      { href: "/mechanism/repurchased", text: "Repurchased" },
      { href: "/mechanism/buyback-token-supply", text: "Buyback: token supply and destination" },
    ];
    const out = selectSiteLocalExpansion({ documents: [doc(`https://${HOST}/mechanism/`, links)], routes: [ROUTE], terms: TERMS, known: new Set() });
    expect(out.length).toBe(MAX_SITE_LOCAL_PER_ROUTE);
    expect(out[0].url).toBe(`https://${HOST}/mechanism/buyback-token-supply`);
    // Equal scores keep discovery order.
    expect(out.slice(1).map((c) => c.url)).toEqual([`https://${HOST}/mechanism/token`, `https://${HOST}/mechanism/supply`, `https://${HOST}/mechanism/mechanism`]);
    // Two routes, K each — never K in total.
    const other: ConfirmedRoute = { domain: "gov.expansion.test", pathPrefix: "/", routeClass: "GOVERNANCE" };
    const two = selectSiteLocalExpansion({
      documents: [doc(`https://${HOST}/mechanism/`, links), doc("https://gov.expansion.test/", [{ href: "/proposals/buyback", text: "Buyback proposal" }])],
      routes: [ROUTE, other],
      terms: TERMS,
      known: new Set(),
    });
    expect(two.filter((c) => c.domain === HOST).length).toBe(MAX_SITE_LOCAL_PER_ROUTE);
    expect(two.filter((c) => c.domain === other.domain).map((c) => c.url)).toEqual(["https://gov.expansion.test/proposals/buyback"]);
  });

  it("only owner-confirmed documentary classes expand: an explorer or data-provider route never does, and no terms means nothing", () => {
    const explorer: ConfirmedRoute = { domain: HOST, pathPrefix: "/mechanism", routeClass: "ONCHAIN_VERIFIABLE" };
    expect(selectSiteLocalExpansion({ documents: [doc(`https://${HOST}/mechanism/`, [{ href: "/mechanism/buyback", text: "Buyback" }])], routes: [explorer], terms: TERMS, known: new Set() })).toEqual([]);
    expect(selectSiteLocalExpansion({ documents: [doc(`https://${HOST}/mechanism/`, [{ href: "/mechanism/buyback", text: "Buyback" }])], routes: [ROUTE], terms: new Set(), known: new Set() })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. THE FETCH PHASE ADMITS AND OPENS, ONCE                           */
/* ------------------------------------------------------------------ */

const COST: ModelCostProfile = { modelId: "fixture-test-model", inputPriceMicroUsdPerToken: 1, outputPriceMicroUsdPerToken: 5, maxInputTokens: 8_000, maxOutputTokens: 1_536, priceVersion: "test-fixture-not-production" };
const INDEX = `https://${HOST}/mechanism/`;
const BUYBACK = `https://${HOST}/mechanism/buyback`;
const DEEPER = `https://${HOST}/mechanism/buyback/supply-effect`;
const SENTENCE = "Protocol fees are used to buy back the token and bought-back tokens are held at a public address.";

function fixtureDoc(url: string, links: { href: string; text: string }[] = []): FetchedDocument {
  const text = `${SENTENCE} Details for ${url}.`;
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}`,
    fetchedAt: new Date(),
    byteLength: text.length,
    documentLinks: { links: links.map((l) => ({ href: l.href, text: l.text, host: null, heading: null, context: null, resolvedIdentifier: null })), identifiers: [], hosts: [], truncated: false },
  };
}
const CORPUS: Record<string, FetchedDocument> = {
  [INDEX]: fixtureDoc(INDEX, [
    { href: "/mechanism/buyback", text: "Buyback mechanism" },
    { href: "/mechanism/legal", text: "Legal" },
    { href: "https://evil.test/mechanism/buyback", text: "Buyback" },
  ]),
  [BUYBACK]: fixtureDoc(BUYBACK, [{ href: "/mechanism/buyback/supply-effect", text: "Token supply effect" }]),
  [DEEPER]: fixtureDoc(DEEPER),
};

async function makeProject() {
  const slug = uniq("sle");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Expansion Fixture", status: "ACTIVE_CORE" }).returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/mechanism" });
  if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}
async function makeJob(project: { id: string; slug: string }, budget = INTERNAL_ALPHA_V1): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const question = "does the buyback mechanism reduce token supply, and where do repurchased tokens go?";
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: { level: "ARI_CORE", capability: "FRESH_RESEARCH", budget },
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await ctx.db.insert(interpretations).values({
    userId: user.id,
    researchJobId: job.id,
    originalQuestion: question,
    status: "READY",
    result: { status: "READY", project_or_asset: project.slug, related_entities: [], topic: null, task_type: "VERIFY_MECHANISM", research_task: question, understood_summary: null, user_assumptions: [], ambiguities: [], clarification_question: null, route: "DEEP_RESEARCH", normalized_intent: "VALUE_CAPTURE", intent_confidence: 0.9, route_reason: "in scope", needs_fresh_evidence: true, quick_answer: null },
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}
const ITEM: ComponentWorkItem = { step: 6, stepName: "Value Destination", component: "DESTINATION", state: "NO_MEMORY", blockers: [], memoryIds: [], conflictingMemoryIds: [] };
const targetFor = (project: { id: string; name: string; slug: string }) => (item: ComponentWorkItem): ComponentTarget => ({ step: item.step, stepName: item.stepName, component: item.component, projectId: project.id, projectName: project.name, projectSlug: project.slug });

describe("FETCH phase — the expansion admits the relevant same-route page, records it as an ordinary discovery, opens it, and never recurses", () => {
  it("search surfaces only the index; the buyback page is admitted from the index's links, traced as a candidate for admitting components, and opened; the page it links to is NOT followed", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: [ITEM],
      target: targetFor(project),
      queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-index"]; } },
      searchGateway: { name: "fixture-search", async search() { return [{ url: INDEX, title: null, snippet: null }]; } },
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 1,
      maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
      projectId: project.id,
      queryProposerCostProfile: COST,
    });
    const fetched: string[] = [];
    const out = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: {
        name: "fixture-transport",
        async fetch(url: string) {
          fetched.push(url);
          const d = CORPUS[url];
          if (!d) throw new Error("fixture: unknown url " + url);
          return d;
        },
      },
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });
    expect(out.siteLocalCandidates).toEqual([BUYBACK]);
    expect(fetched).toEqual([INDEX, BUYBACK]);
    expect(out.sealedDocumentIds.length).toBe(2);
    // Not recursive: the buyback page's own link was harvested but not
    // admitted in this pass.
    expect(out.harvestedLinks.map((h) => h.url).sort()).toEqual([BUYBACK, INDEX].sort());
    expect(fetched).not.toContain(DEEPER);
    // Recorded exactly like a search discovery: a synthetic executed
    // query for the route, then candidate rows attributed to components
    // whose classes the route establishes — never to a component that
    // cannot admit OFFICIAL_DOCS. Nothing was reserved for it.
    const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
    const synthetic = trace.filter((t) => t.operationType === "SEARCH_EXECUTED" && t.providerName === SITE_LOCAL_PROVIDER);
    expect(synthetic.length).toBe(1);
    expect(synthetic[0].targetRef).toBe(`route:${HOST}/mechanism`);
    expect(synthetic[0].budgetAmount ?? null).toBeNull();
    const candidates = trace.filter((t) => t.operationType === "CANDIDATE_RETURNED" && t.providerName === SITE_LOCAL_PROVIDER);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.targetRef === BUYBACK)).toBe(true);
    const components = new Set(candidates.map((c) => c.component));
    expect(components.has("DESTINATION")).toBe(true);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.searchQueriesReserved).toBe(1);
    // The ledger sees it as DESTINATION's own candidate, so the phased
    // replay and the targeted second pass can reach it.
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    const key = `6:DESTINATION:route:${HOST}/mechanism`;
    expect(ledger.candidatesByQueryComponent.get(key)).toEqual([BUYBACK]);
    expect(ledger.fetchedUrls.has(canonicalTargetRef(BUYBACK))).toBe(true);
    const docs = await ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(docs.map((d) => d.finalUrl).sort()).toEqual([BUYBACK, INDEX].sort());
  }, 60_000);

  it("the opens cap still binds: with room for one open only, the index is sealed and the expansion admits but cannot open", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project, { ...INTERNAL_ALPHA_V1, maxSourceOpens: 1, reservedRecoverySteps: 0 });
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: [ITEM],
      target: targetFor(project),
      queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-index"]; } },
      searchGateway: { name: "fixture-search", async search() { return [{ url: INDEX, title: null, snippet: null }]; } },
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 1,
      maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
      projectId: project.id,
      queryProposerCostProfile: COST,
    });
    const fetched: string[] = [];
    const out = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: { name: "fixture-transport", async fetch(url: string) { fetched.push(url); return CORPUS[url]; } },
      maxSourceOpens: 1,
    });
    expect(fetched).toEqual([INDEX]);
    expect(out.siteLocalCandidates).toEqual([BUYBACK]);
    // Admitted and traced — an UNOPENED candidate the second pass can use.
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(ledger.candidatesByQueryComponent.get(`6:DESTINATION:route:${HOST}/mechanism`)).toEqual([BUYBACK]);
    expect(ledger.fetchedUrls.has(canonicalTargetRef(BUYBACK))).toBe(false);
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* 3. UNPHASED — THE EXECUTOR REACHES THE PAGE THROUGH ITS OWN MACHINERY */
/* ------------------------------------------------------------------ */

describe("unphased executor — an expanded candidate is opened through the existing continuation, not by a new loop", () => {
  it("the index yields no fact; the expansion appends the buyback page; the +1 continuation opens it; Evidence follows", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project, { ...INTERNAL_ALPHA_V1, maxSourceOpens: 12, reservedRecoverySteps: 0 });
    const fetched: string[] = [];
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
      queryProposer: { name: "fixture-proposer", async proposeQueries(input) { return [`${input.target.component} index`]; } },
      searchGateway: { name: "fixture-search", async search() { return [{ url: INDEX, title: null, snippet: null }]; } },
      contentFetcher: { name: "fixture-transport", async fetch(url: string) { fetched.push(url); const d = CORPUS[url]; if (!d) throw new Error("fixture: unknown url " + url); return d; } },
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract(input) {
          if (input.document.finalUrl === INDEX) return [];
          const f: ExtractedFact = { step: input.target.step, component: input.target.component, statement: SENTENCE, supportFragment: SENTENCE, mechanismState: "LIVE", directness: "DIRECT", publishedAt: new Date(Date.now() - 86400000), doesNotProve: "limits", relationship: "SUPPORTS", onchainLocator: null, onchainLocators: null };
          return [f];
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobId, executor, new Date(), { targetedRecovery: "OFF" });
    expect(fetched).toContain(BUYBACK);
    expect(fetched).not.toContain(DEEPER);
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    const expanded = attempts.filter((a) => (a.reason ?? "").includes("SITE_LOCAL_EXPANSION"));
    expect(expanded.length).toBeGreaterThan(0);
    const continued = attempts.filter((a) => (a.reason ?? "").includes("DOCUMENTARY_CANDIDATE_CONTINUATION"));
    expect(continued.length).toBeGreaterThan(0);
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.retrievedUrl === BUYBACK)).toBe(true);
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* 4. PER-COMPONENT SELECTION — WALK POSITION DOES NOT DECIDE          */
/* ------------------------------------------------------------------ */

describe("selection per component: every pending component gets its most relevant page first, wherever in the walk the index was read", () => {
  // The shape of the benchmark's SITE_LOCAL_ONLY variant: a docs index
  // linking one page per component; search surfaces the index only for
  // MECHANISM_SPEC and DESTINATION. The unphased walk reads the index in
  // MECHANISM_SPEC's own attempt (two earlier pages known); the phased
  // FETCH phase reads it after every search (six pages known). Both must
  // admit the two hidden pages.
  const DOCS: ConfirmedRoute = { domain: HOST, pathPrefix: "/docs", routeClass: "OFFICIAL_DOCS" };
  const ORDER = ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "EXECUTION_EVIDENCE", "CURRENT_STATE", "DESTINATION", "RECIPIENT", "NET_EFFECT"] as const;
  const FRAGMENT: Record<(typeof ORDER)[number], string> = {
    SOURCE_OF_VALUE: "swap fees charged on every trade are the only source of protocol revenue",
    FLOW_PATH: "collected swap fees are forwarded from the router to the protocol treasury contract",
    MECHANISM_SPEC: "each epoch the treasury allocates half of the collected fees to the buyback module",
    EXECUTION_EVIDENCE: "the buyback module has executed a purchase in every epoch since launch",
    CURRENT_STATE: "the buyback mechanism is active as of the latest epoch",
    DESTINATION: "tokens purchased by the buyback module are sent to the burn address",
    RECIPIENT: "the burn address is owned by nobody and its balance is removed from circulation",
    NET_EFFECT: "circulating supply declines by the amount burned each epoch",
  };
  const slug = (c: string) => c.toLowerCase().replace(/_/g, "-");
  const page = (c: string) => `https://${HOST}/docs/${slug(c)}`;
  const index = doc(`https://${HOST}/docs/`, ORDER.map((c) => ({ href: `/docs/${slug(c)}`, text: `${c.toLowerCase().replace(/_/g, " ")} — ${FRAGMENT[c].slice(0, 60)}` })));
  const goal = (c: string) => PATTERN_V1_CONTENT.componentRequirements?.[c as keyof NonNullable<typeof PATTERN_V1_CONTENT.componentRequirements>]?.evidenceGoal ?? null;
  const TASK = expansionTerms(["does protocol revenue buy back the token and burn it?"]);
  const CRITICAL = ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION", "NET_EFFECT"];
  // Priority as planSiteLocalExpansion builds it: pending critical (step
  // order), then pending, then the rest.
  const served = (pending: readonly string[]) =>
    [...ORDER]
      .map((c, i) => ({ c, step: i + 1 }))
      .sort((a, b) => {
        const pa = pending.includes(a.c) ? (CRITICAL.includes(a.c) ? 0 : 1) : 2;
        const pb = pending.includes(b.c) ? (CRITICAL.includes(b.c) ? 0 : 1) : 2;
        return pa - pb || a.step - b.step;
      })
      .map(({ c, step }) => ({ key: `${step}:${c}`, vocabulary: componentVocabulary(c, goal(c)) }));

  it("mid-walk (unphased, MECHANISM_SPEC's attempt): every pending component with a specific match takes its own page — six, above the route cap — critical first, and MECHANISM_SPEC's own page leads its order", () => {
    const known = new Set([page("SOURCE_OF_VALUE"), page("FLOW_PATH")].map(canonicalTargetRef));
    const pending = ORDER.slice(2);
    const out = selectSiteLocalExpansion({ documents: [index], routes: [DOCS], terms: TASK, known, components: served(pending) });
    const urls = out.map((c) => c.url);
    // Pending critical components pick first (step order), then the
    // pending rest; the cap bounds only the task-overlap fill, and here
    // there is no room left for one.
    expect(urls).toEqual([page("MECHANISM_SPEC"), page("CURRENT_STATE"), page("DESTINATION"), page("NET_EFFECT"), page("EXECUTION_EVIDENCE"), page("RECIPIENT")]);
    expect(out.length).toBeGreaterThan(MAX_SITE_LOCAL_PER_ROUTE);
    expect(orderExpansionForComponent(out, "3:MECHANISM_SPEC")[0].url).toBe(page("MECHANISM_SPEC"));
    expect(orderExpansionForComponent(out, "6:DESTINATION")[0].url).toBe(page("DESTINATION"));
  });

  it("a term every component shares never makes a page one component's: with only a shared term in common, nothing is picked and the task rule decides", () => {
    // Every vocabulary carries "mechanism"; the docs index's mechanism-spec
    // link is not GOVERNANCE_BASIS's pick on that word alone.
    const gov = { key: "3:GOVERNANCE_BASIS", vocabulary: componentVocabulary("GOVERNANCE_BASIS", goal("GOVERNANCE_BASIS")) };
    const others = ORDER.map((c, i) => ({ key: `${i + 1}:${c}`, vocabulary: componentVocabulary(c, goal(c)) }));
    const out = selectSiteLocalExpansion({ documents: [index], routes: [DOCS], terms: new Set(["nothing"]), known: new Set(), components: [gov, ...others.filter((o) => o.key !== "3:MECHANISM_SPEC")] });
    expect(out.map((c) => c.url)).not.toContain(page("MECHANISM_SPEC"));
  });

  it("pre-walk (phased FETCH, six pages known): the same two hidden pages are admitted", () => {
    const known = new Set(ORDER.filter((c) => c !== "MECHANISM_SPEC" && c !== "DESTINATION").map((c) => canonicalTargetRef(page(c))));
    const out = selectSiteLocalExpansion({ documents: [index], routes: [DOCS], terms: TASK, known, components: served([...ORDER]) });
    expect(out.map((c) => c.url).sort()).toEqual([page("DESTINATION"), page("MECHANISM_SPEC")].sort());
  });

  it("without components the original rule holds: task overlap alone, so a page that shares no term with the question is not admitted", () => {
    const out = selectSiteLocalExpansion({ documents: [index], routes: [DOCS], terms: TASK, known: new Set() });
    for (const c of out) expect(c.score).toBeGreaterThan(0);
    // The room the component rounds leave is filled by this same rule: a
    // component whose vocabulary names exactly one page takes it, and the
    // second slot goes to the best task overlap.
    const one = { key: "6:DESTINATION", vocabulary: new Set(["destination"]) };
    const withOne = selectSiteLocalExpansion({ documents: [index], routes: [DOCS], terms: TASK, known: new Set(), components: [one], maxPerRoute: 2 });
    expect(withOne.map((c) => c.url)).toEqual([page("DESTINATION"), out.filter((c) => c.url !== page("DESTINATION"))[0].url]);
    expect(withOne[1].score).toBeGreaterThan(0);
    // ONE pick per component per selection: with no task terms at all, a
    // component whose vocabulary also matches a second page (recipient,
    // "address") still admits only its best one.
    const two = { key: "6:DESTINATION", vocabulary: new Set(["destination", "address"]) };
    const withTwo = selectSiteLocalExpansion({ documents: [index], routes: [DOCS], terms: new Set(), known: new Set(), components: [two], maxPerRoute: 3 });
    expect(withTwo.map((c) => c.url)).toEqual([page("DESTINATION")]);
  });
});
