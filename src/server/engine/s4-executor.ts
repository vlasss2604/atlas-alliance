import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { loadProductConfig } from "../config/product";
import type { Database, Transaction } from "../db/client";
import { evidence, sources } from "../db/schema";
import { reserveJobBudget } from "./budget-reservation";
import type { ComponentWorkItem } from "./contract-view";
import type { WorkExecutionResult, WorkExecutor } from "./controller";
import {
  ModelCostProfileMissingError,
  boundInputText,
  calculateMaxAuthorizedCostMicro,
  loadModelCostProfile,
} from "./model-cost-profile";
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
//     locked precedence (routeClass only at step 6, after every public
//     class has had a chance to positively recognize the domain).
//   D-090: every model call (QueryProposer, EvidenceExtractor) is priced
//     from an approved, version-controlled cost profile BEFORE it is
//     reserved or made — bound input -> bound output -> price -> reserve
//     -> call. No profile for the configured model -> no call
//     (MODEL_COST_PROFILE_MISSING, fail closed).

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
// model claims about itself.
function isTraceable(documentText: string, supportFragment: string): boolean {
  if (supportFragment.trim().length === 0) return false;
  return normalizeForContainment(documentText).includes(normalizeForContainment(supportFragment));
}

// Word-boundary tokenizer — splits on anything that isn't ASCII
// alphanumeric, lowercased. "arbitrage", "arb-itrage" and "ARBITRAGE" all
// tokenize to one token ("arbitrage"), never containing "arb" as a
// sub-token, so an exact-token comparison structurally cannot match a
// short identifier merely because it appears as a substring of a longer,
// unrelated word.
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
// boundary-aware identity check. Always runs against the FULL fetched
// text (not the D-090 model-visible bounded copy) — this is a pure code
// check with no model cost, so bounding it would only weaken detection
// for a project name mentioned late in a long document.
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

// D-090: resolves the approved cost profile for `modelId`, or returns a
// typed failure reason instead of throwing past this boundary — the ONE
// place execute() decides "no profile -> no call" for a given role.
function resolveCostProfile(modelId: string): { ok: true; profile: ModelCostProfile } | { ok: false; reason: string } {
  try {
    return { ok: true, profile: loadModelCostProfile(modelId) };
  } catch (e) {
    if (e instanceof ModelCostProfileMissingError) return { ok: false, reason: e.message };
    throw e;
  }
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

      // §7.2a rule 2 (D-089): an invalid routeClass value is ignored, not
      // a job failure, but the fact of ignoring it is observed. Collected
      // across every source touched this attempt and folded into the
      // final result's `reason` — the existing, already-approved
      // per-attempt observation channel (research_attempts.reason), not a
      // new learning system.
      const invalidRouteClassObservations = new Set<string>();
      function withObservations(reason: string): string {
        if (invalidRouteClassObservations.size === 0) return reason;
        return `${reason}; routeClass ignored (invalid): ${[...invalidRouteClassObservations].join(", ")}`;
      }

      // D-090 step 1: determine configured model for each role. Same
      // config keys product.ts/loadProductConfig already define
      // (query_proposer_model/evidence_extractor_model) — the same D-026
      // "model changes by key, not deploy" principle this file already
      // followed, now also driving which cost profile applies.
      const config = await loadProductConfig(deps.db);

      // --- 1. QueryProposer -----------------------------------------------
      const queryProposerProfileResult = resolveCostProfile(config.query_proposer_model);
      if (!queryProposerProfileResult.ok) {
        return { status: "FAILED", reason: queryProposerProfileResult.reason, spent };
      }
      const queryProposerProfile = queryProposerProfileResult.profile;
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

      const queryProposer =
        deps.queryProposer ?? (await resolveQueryProposer(config.query_proposer_model, queryProposerProfile.maxOutputTokens));
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
      const searchGateway = deps.searchGateway ?? resolveSearchGateway();
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
      const contentFetcher = deps.contentFetcher ?? resolveContentFetcher();
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
      // D-090 fail-closed: resolved ONCE for this attempt, before any
      // EvidenceExtractor call is made — already-incurred search/fetch
      // spend above is preserved either way (MEDIUM-2 discipline).
      const evidenceExtractorProfileResult = resolveCostProfile(config.evidence_extractor_model);
      if (!evidenceExtractorProfileResult.ok) {
        return { status: "FAILED", reason: evidenceExtractorProfileResult.reason, spent };
      }
      const evidenceExtractorProfile = evidenceExtractorProfileResult.profile;
      const evidenceExtractorCostMicro = calculateMaxAuthorizedCostMicro(evidenceExtractorProfile);
      const evidenceExtractor =
        deps.evidenceExtractor ??
        (await resolveEvidenceExtractor(config.evidence_extractor_model, evidenceExtractorProfile.maxOutputTokens));
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

        // §8 INPUT BOUNDING (D-090): deterministically bound what the
        // model actually sees to the SAME numbers the reservation above
        // was priced with — "ограничить -> оценить -> зарезервировать ->
        // вызвать". The extractor only ever sees this bounded copy.
        const boundedText = boundInputText(doc.normalizedText, evidenceExtractorProfile);
        const boundedDoc = { ...doc, normalizedText: boundedText };

        const extractResult = await callProvider("EVIDENCE_EXTRACTOR", () =>
          evidenceExtractor.extract({ target, document: boundedDoc }),
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
        // additionally required in that case). Containment runs against
        // the FULL document text, not the D-090 bounded copy (see
        // documentNamesProject's own doc comment).
        const sourceInfo = await findOrCreateSource(deps.db, doc.finalUrl);
        const route = await resolveSourceRoute(deps.db, deps.project.id, doc.finalUrl);
        if (route.invalidRouteClassObserved) {
          invalidRouteClassObservations.add(route.invalidRouteClassObserved);
        }
        const projectContained =
          route.officiality === "CONFIRMED" || documentNamesProject(doc.normalizedText, deps.project);
        if (!projectContained) continue; // wrong-project document — never persisted, regardless of what the extractor claims

        // D-089/§7.2a: exact locked precedence — routeClass only supplies
        // the class at step 6, after every public/project-independent
        // class has had a chance to positively recognize the domain.
        const sourceClass = resolveSourceClass(doc.finalUrl, sourceInfo.sourceType, route.routeClass);

        for (const fact of facts) {
          // D-070/D-072 structural containment: a fact for any OTHER
          // step/component is not "extra scope generously offered" — it
          // is discarded outright. The model has no path from here to
          // the controller, the work queue, or any other component.
          if (fact.step !== target.step || fact.component !== target.component) continue;
          // §7/D-076: no traceable excerpt in the actual (D-090 bounded)
          // document the extractor was shown -> not Evidence, regardless
          // of how confident the model sounds. A support fragment outside
          // the bounded, model-visible portion is unseen content — it is
          // correct to drop it, not to fabricate evidence from it (§8).
          if (!isTraceable(boundedDoc.normalizedText, fact.supportFragment)) continue;

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
