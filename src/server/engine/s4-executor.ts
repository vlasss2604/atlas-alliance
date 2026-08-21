import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, sources } from "../db/schema";
import type { ComponentWorkItem } from "./contract-view";
import type { WorkExecutionResult, WorkExecutor } from "./controller";
import { ContentFetchError, resolveContentFetcher } from "./providers/content-fetcher";
import type { ContentFetcher } from "./providers/content-fetcher";
import { EvidenceExtractorUnavailableError, resolveEvidenceExtractor } from "./providers/evidence-extractor";
import type { EvidenceExtractor } from "./providers/evidence-extractor";
import { QueryProposerUnavailableError, resolveQueryProposer } from "./providers/query-proposer";
import type { QueryProposer } from "./providers/query-proposer";
import { resolveSearchGateway, SearchProviderUnavailableError } from "./providers/search-gateway";
import type { SearchGateway } from "./providers/search-gateway";
import type { ComponentTarget, ExtractedFact } from "./providers/types";

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

// Per-attempt caps — deliberately NOT derived from the job's
// maxSearchQueries (that dimension already gates ATTEMPT COUNT in
// controller.ts's claimAttempt; reusing it here as a per-call query cap
// would conflate two different meanings of the same budget field). These
// are small, fixed, conservative bounds on how much work ONE attempt may
// generate, independent of how many attempts the job has left.
const MAX_QUERIES_PER_ATTEMPT = 3;
const MAX_SEARCH_RESULTS_PER_QUERY = 5;
const MAX_SOURCE_OPENS_PER_ATTEMPT = 3;

// Conservative flat per-call cost reservation (§13: "If exact model cost
// cannot be known before execution, use the approved conservative
// reservation/accounting policy") — Haiku-class calls on a short, bounded
// prompt/schema; deliberately over- rather than under-estimated so the
// persisted job-lifetime total never quietly runs ahead of reality.
const ESTIMATED_QUERY_PROPOSER_COST_MICRO = 5_000;
const ESTIMATED_EVIDENCE_EXTRACTOR_COST_MICRO = 15_000;

export interface S4ExecutorDeps {
  db: Database | Transaction;
  // Test/operational seams — default to the real resolvers. Never used to
  // widen scope, only to inject fixtures in tests (same discipline as
  // __setX() elsewhere in the provider seams).
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

async function findOrCreateSource(
  db: Database | Transaction,
  url: string,
): Promise<string> {
  const urlHash = hashUrl(url);
  const [existing] = await db.select().from(sources).where(eq(sources.urlHash, urlHash));
  if (existing) return existing.id;
  const [created] = await db
    .insert(sources)
    .values({ url, urlHash })
    .onConflictDoNothing({ target: sources.urlHash })
    .returning({ id: sources.id });
  if (created) return created.id;
  // Lost a race to insert the same URL concurrently — the winner's row
  // is now readable.
  const [afterRace] = await db.select().from(sources).where(eq(sources.urlHash, urlHash));
  if (!afterRace) throw new Error(`findOrCreateSource: source disappeared for ${url}`);
  return afterRace.id;
}

export function createS4WorkExecutor(deps: S4ExecutorDeps): WorkExecutor {
  return {
    async execute(item: ComponentWorkItem, ctx): Promise<WorkExecutionResult> {
      const target: ComponentTarget = {
        step: item.step,
        stepName: item.stepName,
        component: item.component,
      };
      // Code-composed, deterministic — never free model text folded back
      // into control flow (D-070).
      const hint = `state=${item.state}; blockers=${item.blockers.join(", ") || "none"}`;

      const spent = { searchQueries: 0, sourceOpens: 0, modelCostMicro: 0 };
      let modelCostRemaining = ctx.remainingBudget.modelCostMicro;

      // --- 1. QueryProposer ---------------------------------------------
      const queryProposer = deps.queryProposer ?? (await resolveQueryProposer());
      if (modelCostRemaining < ESTIMATED_QUERY_PROPOSER_COST_MICRO) {
        return { status: "SKIPPED", reason: "MODEL_COST_BUDGET_EXHAUSTED_BEFORE_QUERY_PROPOSAL", spent };
      }
      let proposedQueries: string[];
      try {
        proposedQueries = await queryProposer.proposeQueries({
          target,
          hint,
          maxQueries: MAX_QUERIES_PER_ATTEMPT,
        });
      } catch (e) {
        if (e instanceof QueryProposerUnavailableError) {
          return { status: "FAILED", reason: `QUERY_PROPOSER_UNAVAILABLE: ${e.message}`, spent };
        }
        throw e;
      }
      spent.modelCostMicro += ESTIMATED_QUERY_PROPOSER_COST_MICRO;
      modelCostRemaining -= ESTIMATED_QUERY_PROPOSER_COST_MICRO;
      // Bounded again here regardless of what the proposer promised —
      // "Query count must be bounded before execution by controller
      // budget" (§2). Also drop empty/whitespace-only strings — never
      // trust shape beyond the type.
      const queries = proposedQueries
        .filter((q) => typeof q === "string" && q.trim().length > 0)
        .slice(0, MAX_QUERIES_PER_ATTEMPT);
      if (queries.length === 0) {
        return { status: "SKIPPED", reason: "NO_QUERIES_PROPOSED", spent };
      }

      // --- 2. SearchGateway -----------------------------------------------
      const searchGateway = deps.searchGateway ?? resolveSearchGateway();
      const candidateUrls = new Map<string, { url: string }>();
      for (const query of queries) {
        spent.searchQueries += 1; // cost of issuing the call, regardless of outcome
        try {
          const results = await searchGateway.search(query, target, {
            maxResults: MAX_SEARCH_RESULTS_PER_QUERY,
          });
          for (const r of results) {
            // A search result is a candidate URL ONLY — never Evidence
            // (§3, D-076). title/snippet are discarded here entirely;
            // they never reach evidence-extractor or persistence.
            if (typeof r.url === "string" && r.url.length > 0) {
              candidateUrls.set(r.url, { url: r.url });
            }
          }
        } catch (e) {
          if (e instanceof SearchProviderUnavailableError) {
            // One query's provider failure doesn't fail the whole
            // attempt outright — try the remaining queries first.
            continue;
          }
          throw e;
        }
      }
      if (candidateUrls.size === 0) {
        return { status: "FAILED", reason: "NO_SEARCH_CANDIDATES", spent };
      }

      // --- 3. ContentFetcher (already the accepted S1 SSRF-safe impl) ----
      const contentFetcher = deps.contentFetcher ?? resolveContentFetcher();
      const fetchedDocs: Awaited<ReturnType<ContentFetcher["fetch"]>>[] = [];
      let sourceOpensRemaining = Math.min(MAX_SOURCE_OPENS_PER_ATTEMPT, ctx.remainingBudget.sourceOpens);
      for (const { url } of candidateUrls.values()) {
        if (sourceOpensRemaining <= 0) break;
        try {
          const doc = await contentFetcher.fetch(url);
          fetchedDocs.push(doc);
          spent.sourceOpens += 1;
          sourceOpensRemaining -= 1;
        } catch (e) {
          if (e instanceof ContentFetchError) continue; // typed fetch failure — try the next candidate
          throw e;
        }
      }
      if (fetchedDocs.length === 0) {
        return { status: "FAILED", reason: "NO_SOURCE_COULD_BE_FETCHED", spent };
      }

      // --- 4. EvidenceExtractor -------------------------------------------
      const evidenceExtractor = deps.evidenceExtractor ?? (await resolveEvidenceExtractor());
      const insertedEvidenceIds: string[] = [];
      let extractionFailures = 0;
      for (const doc of fetchedDocs) {
        if (modelCostRemaining < ESTIMATED_EVIDENCE_EXTRACTOR_COST_MICRO) break;
        let facts: ExtractedFact[];
        try {
          facts = await evidenceExtractor.extract({ target, document: doc });
        } catch (e) {
          if (e instanceof EvidenceExtractorUnavailableError) {
            extractionFailures += 1;
            continue;
          }
          throw e;
        }
        spent.modelCostMicro += ESTIMATED_EVIDENCE_EXTRACTOR_COST_MICRO;
        modelCostRemaining -= ESTIMATED_EVIDENCE_EXTRACTOR_COST_MICRO;

        for (const fact of facts) {
          // D-070/D-072 structural containment: a fact for any OTHER
          // step/component is not "extra scope generously offered" — it
          // is discarded outright. The model has no path from here to
          // the controller, the work queue, or any other component.
          if (fact.step !== target.step || fact.component !== target.component) continue;
          // §7/D-076: no traceable excerpt in the actual fetched
          // document -> not Evidence, regardless of how confident the
          // model sounds.
          if (!isTraceable(doc.normalizedText, fact.supportFragment)) continue;

          const sourceId = await findOrCreateSource(deps.db, doc.finalUrl);
          const [row] = await deps.db
            .insert(evidence)
            .values({
              researchJobId: ctx.jobId,
              proofId: null, // JOB_ONLY (D-088) — no Proof exists yet; S5+ territory
              sourceId,
              patternStep: fact.step,
              component: fact.component,
              relationship: fact.relationship,
              directness: fact.directness,
              fragment: fact.supportFragment,
              summary: fact.statement,
              mechanismState: fact.mechanismState,
              sourceClass: fact.sourceClass,
              officiality: fact.officiality,
              fetchedAt: doc.fetchedAt,
              publishedAt: fact.publishedAt,
              doesNotProve: fact.doesNotProve,
              retrievedUrl: doc.finalUrl,
              contentHash: doc.contentHash,
            })
            .returning({ id: evidence.id });
          insertedEvidenceIds.push(row.id);
        }
      }

      if (insertedEvidenceIds.length > 0) {
        return {
          status: "SUCCEEDED",
          reason: `extracted ${insertedEvidenceIds.length} evidence candidate(s) from ${fetchedDocs.length} document(s)`,
          spent,
        };
      }
      if (extractionFailures > 0) {
        return { status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE", spent };
      }
      return { status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT", spent };
    },
  };
}
