import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, sources } from "../db/schema";
import { reserveJobBudget } from "./budget-reservation";
import type { ComponentWorkItem } from "./contract-view";
import type { WorkExecutionResult, WorkExecutor } from "./controller";
import { resolveContentFetcher } from "./providers/content-fetcher";
import type { ContentFetcher } from "./providers/content-fetcher";
import { resolveEvidenceExtractor } from "./providers/evidence-extractor";
import type { EvidenceExtractor } from "./providers/evidence-extractor";
import { resolveQueryProposer } from "./providers/query-proposer";
import type { QueryProposer } from "./providers/query-proposer";
import { resolveSearchGateway } from "./providers/search-gateway";
import type { SearchGateway } from "./providers/search-gateway";
import type { ComponentTarget, ExtractedFact } from "./providers/types";
import { deriveSourceClass, resolveOfficiality } from "./source-authority";

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
// S4 review fix summary (this file):
//   BLOCKER-1: sourceClass/officiality are computed here deterministically
//     (source-authority.ts) — the model is never asked for them (see
//     providers/types.ts, ExtractedFact no longer has these fields).
//   BLOCKER-2/HIGH-1: every real external action (search call, source
//     open, model call) atomically reserves its unit against
//     research_jobs.*Reserved (budget-reservation.ts) BEFORE the call —
//     not a claim-time snapshot, not a post-hoc clamp.
//   HIGH-2: a fact is only persisted if the FETCHED DOCUMENT itself
//     names the target project (or its source domain is a CONFIRMED
//     SOURCE_ROUTE for the project) — never because the extractor's
//     rewritten statement merely says so.
//   MEDIUM-1: each persisted Evidence row carries a deterministic
//     extraction-unit identity; a replayed identical extraction is a
//     no-op insert (DB-enforced), not a duplicate row.
//   MEDIUM-2: every provider call site catches ANY error (not just the
//     provider's own typed class) and turns it into controller-visible
//     typed accounting — no unexpected exception escapes execute()
//     leaving an attempt stuck STARTED with lost audit trail. Bugs in
//     this file's OWN logic (outside a provider call site) are not
//     caught here and still propagate.

// Per-attempt cap on how many search queries a single attempt may
// propose — a LOCAL shaping bound, not a budget ceiling. The real ceiling
// (maxSearchQueries as an actual SearchGateway call count, job-lifetime)
// is enforced by reserveJobBudget() below, independently of this number.
const MAX_QUERIES_PER_ATTEMPT = 3;
const MAX_SEARCH_RESULTS_PER_QUERY = 5;
// Local shaping bound on how many candidates one attempt will even try to
// open — the real ceiling is reserveJobBudget("sourceOpens", ...).
const MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT = 6;

// Conservative flat per-call cost reservation (§13: "If exact model cost
// cannot be known before execution, use the approved conservative
// reservation/accounting policy") — Haiku-class calls on a short, bounded
// prompt/schema; deliberately over- rather than under-estimated. Reserved
// BEFORE the call via reserveJobBudget(); never refunded afterward — a
// simple, ceiling-safe, deterministic policy (see budget-reservation.ts
// module comment on "not a free retry").
const ESTIMATED_QUERY_PROPOSER_COST_MICRO = 5_000;
const ESTIMATED_EVIDENCE_EXTRACTOR_COST_MICRO = 15_000;

export interface S4ExecutorDeps {
  db: Database | Transaction;
  // HIGH-2: immutable project identity, loaded once by the caller (the
  // job's own project never changes mid-job) and threaded into every
  // provider call as part of ComponentTarget.
  project: { id: string; name: string; slug: string; ticker: string | null };
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

// HIGH-2: deterministic, non-fuzzy project containment. A document is
// "about" the target project only if it literally names the project (by
// name, slug, or ticker) — never because a search result or an
// extractor's rewritten summary says so. This intentionally does NOT
// attempt semantic understanding of what the document is "really about";
// it is a structural, code-owned substring check.
function documentNamesProject(
  documentText: string,
  project: { name: string; slug: string; ticker: string | null },
): boolean {
  const normalizedDoc = normalizeForContainment(documentText);
  const candidates = [project.name, project.slug.replace(/[_-]/g, " "), project.ticker ?? ""];
  return candidates.some((c) => {
    const needle = normalizeForContainment(c);
    return needle.length >= 3 && normalizedDoc.includes(needle);
  });
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
  const [created] = await db
    .insert(sources)
    .values({ url, urlHash })
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

      const spent = { searchQueries: 0, sourceOpens: 0, modelCostMicro: 0 };

      // --- 1. QueryProposer -----------------------------------------------
      const queryProposerReserved = await reserveJobBudget(
        deps.db,
        ctx.jobId,
        "modelCostMicro",
        ESTIMATED_QUERY_PROPOSER_COST_MICRO,
        ctx.budget.maxModelCostMicro,
      );
      if (!queryProposerReserved) {
        return { status: "SKIPPED", reason: "MODEL_COST_BUDGET_EXHAUSTED_BEFORE_QUERY_PROPOSAL", spent };
      }
      spent.modelCostMicro += ESTIMATED_QUERY_PROPOSER_COST_MICRO;

      const queryProposer = deps.queryProposer ?? (await resolveQueryProposer());
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
        if (!searchResult.ok) continue; // one query's failure doesn't fail the whole attempt
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
        return {
          status: "FAILED",
          reason: searchBudgetExhausted ? "SEARCH_QUERY_BUDGET_EXHAUSTED" : "NO_SEARCH_CANDIDATES",
          spent,
        };
      }

      // --- 3. ContentFetcher (already the accepted S1 SSRF-safe impl) ------
      const contentFetcher = deps.contentFetcher ?? resolveContentFetcher();
      const fetchedDocs: Awaited<ReturnType<ContentFetcher["fetch"]>>[] = [];
      let opensAttempted = 0;
      for (const { url } of candidateUrls.values()) {
        if (opensAttempted >= MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT) break;
        const reserved = await reserveJobBudget(deps.db, ctx.jobId, "sourceOpens", 1, ctx.budget.maxSourceOpens);
        if (!reserved) break; // job-lifetime source-open ceiling reached
        opensAttempted += 1;
        const fetchResult = await callProvider("CONTENT_FETCHER", () => contentFetcher.fetch(url));
        if (!fetchResult.ok) continue; // typed/unexpected fetch failure — try the next candidate
        fetchedDocs.push(fetchResult.value);
        spent.sourceOpens += 1;
      }
      if (fetchedDocs.length === 0) {
        return { status: "FAILED", reason: "NO_SOURCE_COULD_BE_FETCHED", spent };
      }

      // --- 4. EvidenceExtractor ----------------------------------------------
      const evidenceExtractor = deps.evidenceExtractor ?? (await resolveEvidenceExtractor());
      const insertedEvidenceIds: string[] = [];
      let extractionFailures = 0;
      for (const doc of fetchedDocs) {
        const reserved = await reserveJobBudget(
          deps.db,
          ctx.jobId,
          "modelCostMicro",
          ESTIMATED_EVIDENCE_EXTRACTOR_COST_MICRO,
          ctx.budget.maxModelCostMicro,
        );
        if (!reserved) break; // job-lifetime model-cost ceiling reached
        spent.modelCostMicro += ESTIMATED_EVIDENCE_EXTRACTOR_COST_MICRO;

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
        const officiality = await resolveOfficiality(deps.db, deps.project.id, doc.finalUrl);
        const projectContained = officiality === "CONFIRMED" || documentNamesProject(doc.normalizedText, deps.project);
        if (!projectContained) continue; // wrong-project document — never persisted, regardless of what the extractor claims

        const sourceClass = deriveSourceClass(doc.finalUrl, sourceInfo.sourceType);

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
              // fields no longer exist on ExtractedFact. Computed above,
              // deterministically, by source-authority.ts.
              sourceClass,
              officiality,
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
          reason: `extracted ${insertedEvidenceIds.length} evidence candidate(s) from ${fetchedDocs.length} document(s)`,
          spent,
        };
      }
      if (extractionFailures > 0 && extractionFailures === fetchedDocs.length) {
        return { status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE", spent };
      }
      return { status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT", spent };
    },
  };
}
