import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { loadProductConfig } from "../config/product";
import type { Database, Transaction } from "../db/client";
import { evidence, sources } from "../db/schema";
import { reserveJobBudget } from "./budget-reservation";
import type { ComponentWorkItem } from "./contract-view";
import type { WorkExecutionResult, WorkExecutor } from "./controller";
import { ModelCostProfileMissingError, calculateMaxAuthorizedCostMicro, loadModelCostProfile } from "./model-cost-profile";
import type { ModelCostProfile } from "./model-cost-profile";
import { resolveContentFetcher } from "./providers/content-fetcher";
import type { ContentFetcher } from "./providers/content-fetcher";
import { resolveEvidenceExtractor } from "./providers/evidence-extractor";
import type { EvidenceExtractor } from "./providers/evidence-extractor";
import { resolveQueryProposer } from "./providers/query-proposer";
import type { QueryProposer } from "./providers/query-proposer";
import { resolveSearchGateway } from "./providers/search-gateway";
import type { SearchGateway } from "./providers/search-gateway";
import type { ComponentTarget, ExtractedFact } from "./providers/types";
import { resolveSourceClass, resolveSourceRoute, deriveSourceType } from "./source-authority";

// Phase 6, S4 — the real bounded execution pipeline:
//   ComponentWorkItem -> QueryProposer -> SearchGateway -> ContentFetcher
//   -> EvidenceExtractor -> persisted Evidence candidates
//
// D-070, restated for this file specifically: every provider call in
// here receives ONLY a bounded ComponentTarget/query/document — never the
// contract, the job, the budget object, or anything that could let it
// widen scope. What each provider returns is validated and re-scoped in
// CODE before it can affect anything durable (evidence rows) or anything
// the controller sees (WorkExecutionResult.status/spent). A provider's
// output is data to be checked, never an instruction to be obeyed —
// exactly the same posture this file takes toward fetched document text
// (§16, self-check 3) as toward a hostile QueryProposer/EvidenceExtractor
// response: the containment is structural, not a matter of the model's
// good behavior.
//
// S4 fix summary (this file, cumulative across review rounds):
//   BLOCKER-1: sourceClass/officiality are computed here deterministically
//     (source-authority.ts) — the model is never asked for them.
//   BLOCKER-2/HIGH-1: every real external action (search call, source
//     open, model call) atomically reserves its unit against
//     research_jobs.*Reserved (budget-reservation.ts) BEFORE the call.
//   HIGH-2/HIGH-A: a fact is only persisted if the FETCHED DOCUMENT itself
//     names the target project (boundary-aware, not substring), or its
//     source domain is a human-CONFIRMED SOURCE_ROUTE for the project.
//   MEDIUM-1: each persisted Evidence row carries a deterministic
//     extraction-unit identity; a replayed identical extraction is a
//     no-op insert.
//   MEDIUM-2: every provider call site catches ANY error and turns it
//     into controller-visible typed accounting.
//   D-089: OFFICIAL_DOCS/GOVERNANCE/OFFICIAL_REPORT are reachable only via
//     an explicit, human-set routeClass on the SAME ACTIVE SOURCE_ROUTE
//     row that produced CONFIRMED — resolveSourceClass enforces the exact
//     locked precedence, and never for a bare shared multi-tenant
//     platform domain (source-authority.ts).
//   D-090: every model call (QueryProposer, EvidenceExtractor) is priced
//     from an approved, version-controlled cost profile BEFORE it is
//     reserved or made. S4 FINAL ACCEPTANCE FIX — the production profile
//     catalogue is intentionally EMPTY until S10 (see
//     model-cost-profile.ts): no live model call is currently possible,
//     for EITHER role, without a test-injected fixture profile. Every
//     resolver (cost profile, SearchGateway, ContentFetcher) is checked
//     in one PREFLIGHT step before any budget is reserved (MEDIUM-4/LOW-1)
//     — a missing prerequisite fails the attempt for zero cost, not after
//     paid work already happened.

// Per-attempt cap on how many search queries a single attempt may
// propose — a LOCAL shaping bound, not a budget ceiling. The real ceiling
// (maxSearchQueries as an actual SearchGateway call count, job-lifetime)
// is enforced by reserveJobBudget() below, independently of this number.
const MAX_QUERIES_PER_ATTEMPT = 3;
const MAX_SEARCH_RESULTS_PER_QUERY = 5;
// Local shaping bound on how many candidates one attempt will even try to
// open — the real ceiling is reserveJobBudget("sourceOpens", ...).
const MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT = 6;

export interface S4ExecutorDeps {
  db: Database | Transaction;
  // HIGH-2: immutable project identity, loaded once by the caller (the
  // job's own project never changes mid-job) and threaded into every
  // provider call as part of ComponentTarget.
  project: { id: string; name: string; slug: string; ticker: string | null };
  // Test/operational seams — default to the real resolvers. Never used to
  // widen scope, only to inject fixtures in tests (same discipline as
  // __setX() elsewhere in the provider seams). D-090's cost-profile
  // lookup/reservation flow runs identically whether or not these are
  // overridden — only the actual provider CALL is swapped for a fixture.
  queryProposer?: QueryProposer;
  searchGateway?: SearchGateway;
  contentFetcher?: ContentFetcher;
  evidenceExtractor?: EvidenceExtractor;
  // S4 FINAL ACCEPTANCE FIX (items 3/4) — TEST/FIXTURE cost profiles,
  // structurally SEPARATE from the production catalogue in
  // model-cost-profile.ts (which is intentionally empty until S10). When
  // set, these bypass the production lookup for that one role only, so a
  // test can exercise real arithmetic/reservation/maxOutputTokens-wiring
  // behavior without claiming anything about real Anthropic billing
  // safety. Never set outside tests.
  queryProposerCostProfile?: ModelCostProfile;
  evidenceExtractorCostProfile?: ModelCostProfile;
}

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function normalizeForContainment(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// D-076/§7: a fact is only traceable Evidence if its quoted excerpt
// actually appears in the document it claims to come from. A model
// asserting something the document does not contain is invention, not
// extraction — this is the code-level check, independent of anything the
// model claims about itself. Always checked against the EXACT text the
// extractor was given (item 6/12.D) — this file no longer truncates that
// text before the call, so "the document" and "what the model saw" are
// the same value; if a future round reintroduces input bounding, this
// check must move to whatever bounded copy is actually sent.
function isTraceable(documentText: string, supportFragment: string): boolean {
  if (supportFragment.trim().length === 0) return false;
  return normalizeForContainment(documentText).includes(normalizeForContainment(supportFragment));
}

// Word-boundary tokenizer — splits on anything that isn't ASCII
// alphanumeric, lowercased. "arbitrage", "arb-itrage" and "ARBITRAGE" all
// tokenize to one token ("arbitrage"), never containing "arb" as a
// sub-token, so an exact-token comparison structurally cannot match a
// short identifier merely because it appears as a substring of a longer,
// unrelated word. ASCII-only by design (item 15) — non-ASCII project
// identity (Cyrillic/CJK project names) is a known, deliberately deferred
// gap: it fails SAFE (a false negative — containment is refused, never
// wrongly granted), not a reason to reopen S4 scope here.
function tokenize(s: string): string[] {
  return normalizeForContainment(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// HIGH-A: `documentTokens.includes(needle)` (a prior implementation)
// admitted incidental substrings — a ticker like "ARB" matched inside
// "arbitrary"/"arbitrage"/"arbiter", "UNI" inside "university"/"unique",
// etc. Containment must be a real lexical identity, not an arbitrary
// substring. `phrase`'s own tokens must appear as a CONSECUTIVE, exact-
// token run in the document's tokens — this is boundary-safe for both a
// single-token identifier (a ticker) and a multi-token phrase (a project
// name/slug), and needs no special-casing for very short tickers: a
// 2-character token can only ever equal another 2-character token, never
// appear "inside" a longer one.
function containsIdentityPhrase(documentTokens: string[], phrase: string): boolean {
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.length === 0) return false;
  outer: for (let i = 0; i + phraseTokens.length <= documentTokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (documentTokens[i + j] !== phraseTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

// HIGH-2/HIGH-A: deterministic, non-fuzzy project containment. A document
// is "about" the target project only if it literally names the project —
// by its canonical name, canonical slug, or exact ticker token — never
// because a search result or an extractor's rewritten summary says so, and
// never because a short identifier merely appears as a substring of some
// other word. This intentionally does NOT attempt semantic understanding
// of what the document is "really about"; it is a structural, code-owned,
// boundary-aware identity check.
function documentNamesProject(
  documentText: string,
  project: { name: string; slug: string; ticker: string | null },
): boolean {
  const documentTokens = tokenize(documentText);
  const candidates = [project.name, project.slug, project.ticker ?? ""].filter((c) => c.trim().length > 0);
  return candidates.some((c) => containsIdentityPhrase(documentTokens, c));
}

function extractionUnitKey(
  jobId: string,
  sourceId: string,
  step: number,
  component: string,
  supportFragment: string,
): string {
  return createHash("sha256")
    .update(`${jobId}|${sourceId}|${step}|${component}|${normalizeForContainment(supportFragment)}`)
    .digest("hex");
}

async function findOrCreateSource(
  db: Database | Transaction,
  url: string,
): Promise<{ id: string; sourceType: "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN" | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER" }> {
  const urlHash = hashUrl(url);
  const [existing] = await db.select().from(sources).where(eq(sources.urlHash, urlHash));
  if (existing) return { id: existing.id, sourceType: existing.sourceType };
  // HIGH-B: sourceType is populated deterministically from the URL at the
  // moment this global, shared source row is first created — never left
  // at the bare column default, and never revisited per-project (the row
  // is reused across jobs/projects, D-088 territory).
  const [created] = await db
    .insert(sources)
    .values({ url, urlHash, sourceType: deriveSourceType(url) })
    .onConflictDoNothing({ target: sources.urlHash })
    .returning({ id: sources.id, sourceType: sources.sourceType });
  if (created) return created;
  // Lost a race to insert the same URL concurrently — the winner's row
  // is now readable.
  const [afterRace] = await db.select().from(sources).where(eq(sources.urlHash, urlHash));
  if (!afterRace) throw new Error(`findOrCreateSource: source disappeared for ${url}`);
  return { id: afterRace.id, sourceType: afterRace.sourceType };
}

// MEDIUM-2: converts anything an external provider call throws (its own
// typed error class OR an ordinary/unexpected Error) into a uniform typed
// outcome, so no exception ever escapes an execute() call from one of
// these four provider boundaries. `label` identifies which boundary threw,
// for an honest, specific reason string.
async function callProvider<T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `${label}: ${message}` };
  }
}

// D-090: resolves the cost profile for `modelId` — test-injected fixture
// profile first (structurally separate from production, items 3/4), else
// the production catalogue (intentionally empty until S10). Returns a
// typed failure reason instead of throwing past this boundary.
function resolveCostProfile(
  modelId: string,
  fixture: ModelCostProfile | undefined,
): { ok: true; profile: ModelCostProfile } | { ok: false; reason: string } {
  if (fixture) return { ok: true, profile: fixture };
  try {
    return { ok: true, profile: loadModelCostProfile(modelId) };
  } catch (e) {
    if (e instanceof ModelCostProfileMissingError) return { ok: false, reason: e.message };
    throw e;
  }
}

interface Preflight {
  queryProposerProfile: ModelCostProfile;
  evidenceExtractorProfile: ModelCostProfile;
  searchGateway: SearchGateway;
  contentFetcher: ContentFetcher;
  queryProposer: QueryProposer;
  evidenceExtractor: EvidenceExtractor;
}

// MEDIUM-4/LOW-1 (S4 final acceptance fix): every resolver this attempt
// will need — cost profiles AND providers, for every stage — is resolved
// and verified HERE, before a single reservation is made. A resolver that
// throws (missing BRAVE_SEARCH_API_KEY, MODEL_GATEWAY=fake with no
// fixture, a missing cost profile) becomes a deterministic, zero-cost
// FAILED result instead of an uncaught exception escaping after
// already-reserved/spent budget (the exact "QueryProposer reserved, then
// SearchGateway resolution throws uncaught" scenario the review names).
async function preflight(
  deps: S4ExecutorDeps,
  config: { query_proposer_model: string; evidence_extractor_model: string },
): Promise<{ ok: true; value: Preflight } | { ok: false; reason: string }> {
  const qp = resolveCostProfile(config.query_proposer_model, deps.queryProposerCostProfile);
  if (!qp.ok) return { ok: false, reason: qp.reason };

  const ep = resolveCostProfile(config.evidence_extractor_model, deps.evidenceExtractorCostProfile);
  if (!ep.ok) return { ok: false, reason: ep.reason };

  let searchGateway: SearchGateway;
  try {
    searchGateway = deps.searchGateway ?? resolveSearchGateway();
  } catch (e) {
    return { ok: false, reason: `SEARCH_GATEWAY: ${e instanceof Error ? e.message : String(e)}` };
  }

  let contentFetcher: ContentFetcher;
  try {
    contentFetcher = deps.contentFetcher ?? resolveContentFetcher();
  } catch (e) {
    return { ok: false, reason: `CONTENT_FETCHER: ${e instanceof Error ? e.message : String(e)}` };
  }

  let queryProposer: QueryProposer;
  try {
    queryProposer = deps.queryProposer ?? (await resolveQueryProposer(config.query_proposer_model, qp.profile.maxOutputTokens));
  } catch (e) {
    return { ok: false, reason: `QUERY_PROPOSER: ${e instanceof Error ? e.message : String(e)}` };
  }

  let evidenceExtractor: EvidenceExtractor;
  try {
    evidenceExtractor =
      deps.evidenceExtractor ?? (await resolveEvidenceExtractor(config.evidence_extractor_model, ep.profile.maxOutputTokens));
  } catch (e) {
    return { ok: false, reason: `EVIDENCE_EXTRACTOR: ${e instanceof Error ? e.message : String(e)}` };
  }

  return {
    ok: true,
    value: {
      queryProposerProfile: qp.profile,
      evidenceExtractorProfile: ep.profile,
      searchGateway,
      contentFetcher,
      queryProposer,
      evidenceExtractor,
    },
  };
}

// Item 13: a normalized, bounded, safe-to-persist code for why routeClass
// ended up absent despite a matching CONFIRMED row — never the raw jsonb
// value a human typed (no unbounded dump into research_attempts.reason,
// no secrets).
function observationCode(observation: "INVALID_ROUTE_CLASS" | "SOURCE_ROUTE_CONFLICT"): string {
  return observation;
}

export function createS4WorkExecutor(deps: S4ExecutorDeps): WorkExecutor {
  return {
    async execute(item: ComponentWorkItem, ctx): Promise<WorkExecutionResult> {
      const target: ComponentTarget = {
        step: item.step,
        stepName: item.stepName,
        component: item.component,
        projectId: deps.project.id,
        projectName: deps.project.name,
        projectSlug: deps.project.slug,
      };
      // Code-composed, deterministic — never free model text folded back
      // into control flow (D-070).
      const hint = `state=${item.state}; blockers=${item.blockers.join(", ") || "none"}`;

      const spent = { searchQueries: 0, sourceOpens: 0, authorizedModelCostMicro: 0 };

      // §7.2a rule 2 (D-089) / MEDIUM-2: a bounded, safe observation code
      // (never a raw human-typed value) collected across every source
      // touched this attempt and folded into the final result's `reason`
      // — the existing, already-approved per-attempt observation channel
      // (research_attempts.reason), not a new learning system.
      const observations = new Set<string>();
      function withObservations(reason: string): string {
        if (observations.size === 0) return reason;
        return `${reason}; source-route observations: ${[...observations].join(", ")}`;
      }

      // D-090 step 1: determine configured model for each role. Same
      // config keys product.ts/loadProductConfig already define
      // (query_proposer_model/evidence_extractor_model) — the same D-026
      // "model changes by key, not deploy" principle this file already
      // followed, now also driving which cost profile applies.
      const config = await loadProductConfig(deps.db);

      // MEDIUM-4/LOW-1: resolve every provider and cost profile THIS
      // ATTEMPT could need, before any reservation, so a resolver failure
      // is always zero-cost and always a typed FAILED result.
      const pre = await preflight(deps, config);
      if (!pre.ok) {
        return { status: "FAILED", reason: pre.reason, spent };
      }
      const { queryProposerProfile, evidenceExtractorProfile, searchGateway, contentFetcher, queryProposer, evidenceExtractor } =
        pre.value;

      // --- 1. QueryProposer -----------------------------------------------
      const queryProposerCostMicro = calculateMaxAuthorizedCostMicro(queryProposerProfile);
      const queryProposerReserved = await reserveJobBudget(
        deps.db,
        ctx.jobId,
        "modelCostMicro",
        queryProposerCostMicro,
        ctx.budget.maxModelCostMicro,
      );
      if (!queryProposerReserved) {
        return { status: "SKIPPED", reason: "MODEL_COST_BUDGET_EXHAUSTED_BEFORE_QUERY_PROPOSAL", spent };
      }
      spent.authorizedModelCostMicro += queryProposerCostMicro;

      const proposeResult = await callProvider("QUERY_PROPOSER", () =>
        queryProposer.proposeQueries({ target, hint, maxQueries: MAX_QUERIES_PER_ATTEMPT }),
      );
      if (!proposeResult.ok) {
        return { status: "FAILED", reason: proposeResult.reason, spent };
      }
      // Bounded again here regardless of what the proposer promised —
      // "Query count must be bounded before execution by controller
      // budget" (§2). Also drop empty/whitespace-only strings — never
      // trust shape beyond the type.
      const queries = proposeResult.value
        .filter((q) => typeof q === "string" && q.trim().length > 0)
        .slice(0, MAX_QUERIES_PER_ATTEMPT);
      if (queries.length === 0) {
        return { status: "SKIPPED", reason: "NO_QUERIES_PROPOSED", spent };
      }

      // --- 2. SearchGateway -------------------------------------------------
      // BLOCKER-2: each real SearchGateway call atomically reserves ONE
      // unit of the job's real, job-lifetime maxSearchQueries ceiling
      // BEFORE it is made — not a per-attempt local budget. Once the
      // reservation is refused, this attempt stops issuing MORE queries;
      // queries already issued (and their results) stand.
      const candidateUrls = new Map<string, { url: string }>();
      let searchBudgetExhausted = false;
      // LOW-A: keep the most recent typed provider failure reason around
      // so a terminal SKIPPED/FAILED result can surface it for
      // observability, instead of only a generic NO_SEARCH_CANDIDATES/
      // NO_SOURCE_COULD_BE_FETCHED reason that hides WHY every candidate/
      // query failed. No secret/response-body content — callProvider's
      // reason string is already `${label}: ${message}`.
      let lastSearchFailureReason: string | null = null;
      for (const query of queries) {
        const reserved = await reserveJobBudget(
          deps.db,
          ctx.jobId,
          "searchQueries",
          1,
          ctx.budget.maxSearchQueries,
        );
        if (!reserved) {
          searchBudgetExhausted = true;
          break;
        }
        spent.searchQueries += 1;
        const searchResult = await callProvider("SEARCH_GATEWAY", () =>
          searchGateway.search(query, target, { maxResults: MAX_SEARCH_RESULTS_PER_QUERY }),
        );
        if (!searchResult.ok) {
          lastSearchFailureReason = searchResult.reason;
          continue; // one query's failure doesn't fail the whole attempt
        }
        for (const r of searchResult.value) {
          // A search result is a candidate URL ONLY — never Evidence
          // (§3, D-076). title/snippet are discarded here entirely; they
          // never reach evidence-extractor or persistence.
          if (typeof r.url === "string" && r.url.length > 0) {
            candidateUrls.set(r.url, { url: r.url });
          }
        }
      }
      if (candidateUrls.size === 0) {
        // LOW-A: prefer the actual typed provider failure reason over the
        // generic label when one exists — the search budget being
        // exhausted is a distinct, higher-priority reason worth keeping
        // as-is since it isn't a provider failure at all.
        const reason = searchBudgetExhausted
          ? "SEARCH_QUERY_BUDGET_EXHAUSTED"
          : (lastSearchFailureReason ?? "NO_SEARCH_CANDIDATES");
        return { status: "FAILED", reason, spent };
      }

      // --- 3. ContentFetcher (already the accepted S1 SSRF-safe impl) ------
      const fetchedDocs: Awaited<ReturnType<ContentFetcher["fetch"]>>[] = [];
      let opensAttempted = 0;
      let lastFetchFailureReason: string | null = null;
      for (const { url } of candidateUrls.values()) {
        if (opensAttempted >= MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT) break;
        const reserved = await reserveJobBudget(deps.db, ctx.jobId, "sourceOpens", 1, ctx.budget.maxSourceOpens);
        if (!reserved) break; // job-lifetime source-open ceiling reached
        opensAttempted += 1;
        const fetchResult = await callProvider("CONTENT_FETCHER", () => contentFetcher.fetch(url));
        if (!fetchResult.ok) {
          lastFetchFailureReason = fetchResult.reason;
          continue; // typed/unexpected fetch failure — try the next candidate
        }
        fetchedDocs.push(fetchResult.value);
        spent.sourceOpens += 1;
      }
      if (fetchedDocs.length === 0) {
        return {
          status: "FAILED",
          reason: lastFetchFailureReason ?? "NO_SOURCE_COULD_BE_FETCHED",
          spent,
        };
      }

      // --- 4. EvidenceExtractor ----------------------------------------------
      const evidenceExtractorCostMicro = calculateMaxAuthorizedCostMicro(evidenceExtractorProfile);
      const insertedEvidenceIds: string[] = [];
      let extractionFailures = 0;
      for (const doc of fetchedDocs) {
        const reserved = await reserveJobBudget(
          deps.db,
          ctx.jobId,
          "modelCostMicro",
          evidenceExtractorCostMicro,
          ctx.budget.maxModelCostMicro,
        );
        if (!reserved) break; // job-lifetime model-cost ceiling reached
        spent.authorizedModelCostMicro += evidenceExtractorCostMicro;

        // Item 6 (S4 final acceptance fix): no input bounding — the
        // extractor is given the document text exactly as fetched. See
        // model-cost-profile.ts's module comment for why a chars/token
        // heuristic was removed rather than kept as a claimed guarantee.
        const extractResult = await callProvider("EVIDENCE_EXTRACTOR", () =>
          evidenceExtractor.extract({ target, document: doc }),
        );
        if (!extractResult.ok) {
          extractionFailures += 1;
          continue;
        }
        const facts: ExtractedFact[] = extractResult.value;

        // HIGH-2: this document is only eligible to produce Evidence for
        // THIS project if it literally names the project, OR its source
        // domain is a human-CONFIRMED SOURCE_ROUTE for the project
        // (computed below, per-source — a confirmed domain IS the
        // project's own domain by definition, so text-mention is not
        // additionally required in that case).
        const sourceInfo = await findOrCreateSource(deps.db, doc.finalUrl);
        const route = await resolveSourceRoute(deps.db, deps.project.id, doc.finalUrl);
        if (route.observation) observations.add(observationCode(route.observation));
        const projectContained =
          route.officiality === "CONFIRMED" || documentNamesProject(doc.normalizedText, deps.project);
        if (!projectContained) continue; // wrong-project document — never persisted, regardless of what the extractor claims

        // D-089/§7.2a: exact locked precedence — routeClass only supplies
        // the class at step 6, after every public/project-independent
        // class (and every shared multi-tenant platform base domain) has
        // had a chance to positively recognize/exclude the domain.
        const sourceClass = resolveSourceClass(doc.finalUrl, sourceInfo.sourceType, route.routeClass);

        for (const fact of facts) {
          // D-070/D-072 structural containment: a fact for any OTHER
          // step/component is not "extra scope generously offered" — it
          // is discarded outright. The model has no path from here to
          // the controller, the work queue, or any other component.
          if (fact.step !== target.step || fact.component !== target.component) continue;
          // §7/D-076/item 12.D: no traceable excerpt in the EXACT document
          // text the extractor was given -> not Evidence, regardless of
          // how confident the model sounds. A project name or a support
          // fragment that exists only OUTSIDE what the model actually saw
          // must never silently validate model Evidence.
          if (!isTraceable(doc.normalizedText, fact.supportFragment)) continue;

          // MEDIUM-1: deterministic identity for THIS extracted unit —
          // a replayed identical (job, source, step, component, fragment)
          // extraction is a no-op, not a duplicate row.
          const unitKey = extractionUnitKey(ctx.jobId, sourceInfo.id, fact.step, fact.component, fact.supportFragment);
          const [row] = await deps.db
            .insert(evidence)
            .values({
              researchJobId: ctx.jobId,
              proofId: null, // JOB_ONLY (D-088) — no Proof exists yet; S5+ territory
              sourceId: sourceInfo.id,
              patternStep: fact.step,
              component: fact.component,
              relationship: fact.relationship,
              directness: fact.directness,
              fragment: fact.supportFragment,
              summary: fact.statement,
              mechanismState: fact.mechanismState,
              // BLOCKER-1: never fact.sourceClass/fact.officiality — those
              // fields don't exist on ExtractedFact. Computed above,
              // deterministically, by source-authority.ts.
              sourceClass,
              officiality: route.officiality,
              fetchedAt: doc.fetchedAt,
              publishedAt: fact.publishedAt,
              doesNotProve: fact.doesNotProve,
              retrievedUrl: doc.finalUrl,
              contentHash: doc.contentHash,
              extractionUnitKey: unitKey,
            })
            .onConflictDoNothing({
              target: evidence.extractionUnitKey,
              where: sql`${evidence.extractionUnitKey} IS NOT NULL`,
            })
            .returning({ id: evidence.id });
          if (row) insertedEvidenceIds.push(row.id);
        }
      }

      if (insertedEvidenceIds.length > 0) {
        return {
          status: "SUCCEEDED",
          reason: withObservations(
            `extracted ${insertedEvidenceIds.length} evidence candidate(s) from ${fetchedDocs.length} document(s)`,
          ),
          spent,
        };
      }
      if (extractionFailures > 0 && extractionFailures === fetchedDocs.length) {
        return { status: "FAILED", reason: withObservations("EVIDENCE_EXTRACTOR_UNAVAILABLE"), spent };
      }
      return { status: "SKIPPED", reason: withObservations("NO_TRACEABLE_FACTS_FOR_COMPONENT"), spent };
    },
  };
}
