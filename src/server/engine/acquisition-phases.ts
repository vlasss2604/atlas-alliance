import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { acquiredDocuments, researchTraceEvents } from "../db/schema";
import { isKnownDeadUrl, loadAcquisitionLedger, planQueries } from "./acquisition-ledger";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { componentSearchAllowance } from "./budget-fairness";
import {
  calculateActualCostMicro,
  calculateMaxAuthorizedCostMicro,
  loadModelCostProfile,
} from "./model-cost-profile";
import type { ModelCostProfile } from "./model-cost-profile";
import { loadProductConfig } from "../config/product";
import { researchJobs } from "../db/schema";
import { persistAcquiredDocument, replayContentFetcher } from "./acquired-documents";
import type { ComponentWorkItem } from "./contract-view";
import { reserveJobBudget } from "./budget-reservation";
import type { ContentFetcher } from "./providers/content-fetcher";
import type { QueryProposer } from "./providers/query-proposer";
import type { SearchGateway } from "./providers/search-gateway";
import { isReplayProvider } from "./providers/types";
import type { ComponentTarget, FetchedDocument, ModelUsage } from "./providers/types";
import { resolveSourceRoute } from "./source-authority";
import { canonicalTargetRef, isLossyTargetRef, recordTraceEvent } from "./trace-store";

// D-136 — NETWORK-CAPABILITY PHASES.
//
// The environment cannot run search, source fetch and model extraction
// together: search and the model provider need one network, direct
// first-party fetch needs another. So a job crosses environments in three
// phases, each running exactly ONE live capability and REPLAYING the
// persisted outputs of the phases before it. That is D-128's own
// record-and-replay pattern, generalised from the fetcher to every
// capability.
//
// WHAT THIS MODULE IS NOT. It is not a second controller and not a second
// work queue. It composes existing LEAF primitives — planQueries,
// loadAcquisitionLedger, reserveJobBudget, recordTraceEvent,
// persistAcquiredDocument, resolveSourceRoute — and owns no attempt
// lifecycle, no component scheduling, no stop condition and no
// projection. The controller still runs exactly once, in EXTRACTING, and
// S5-S9 are untouched.
//
// WHY PHASES ARE NOT ATTEMPTS. controller.ts charges any second execution
// of a component key against reservedRecoverySteps, which is 1 for a whole
// job. If a phase were an attempt, the first component would exhaust the
// recovery pool. These functions therefore run OUTSIDE the controller and
// write NO research_attempts rows at all — the same way
// runMemoryPlanningStage already sits outside it.
//
// NO NETWORK IDENTITY IN THE DOMAIN. Nothing here names a VPN, a provider
// brand or a route; a phase names a CAPABILITY. Which process can reach
// what is a deployment fact, asserted by a boundary test.

export interface SearchPhaseResult {
  // D-140 — components that received a fair-share allowance of zero, so
  // no proposer call was made and no query was generated for them. This
  // is bounded coverage, not a failure: the axis is genuinely spent.
  budgetRefusedComponents: string[];
  // Components whose proposer call could not be authorized against the
  // job's model budget. Also no call, also no queries.
  modelRefusedComponents: string[];
  // Real proposer calls made in this pass, and what they were authorized
  // to cost. One reservation per real call, never a flat estimate.
  proposerCalls: number;
  proposerReservedMicro: number;
  // Canonical queries for which a real search call was made in this pass.
  executedQueries: string[];
  // Distinct candidate urls discovered in this pass (already lossy-safe,
  // because they come back through the ledger's own reader).
  candidateUrls: string[];
  // Queries skipped because this job already searched them.
  dedupedQueries: string[];
  // Queries the search-query budget refused.
  budgetRefusedQueries: string[];
}

export interface FetchPhaseResult {
  sealedDocumentIds: string[];
  // Urls skipped because the ledger already knows them dead or fetched.
  skippedUrls: string[];
  // Urls whose fetch was attempted and failed in this pass.
  failedUrls: string[];
  // Urls refused before any transport call (lossy ref, unparseable).
  refusedUrls: string[];
}

// PHASE 1 — SEARCHING (model-side environment).
//
// Proposes queries and searches, and persists nothing but TRACE. The
// candidate handoff to the fetch phase is the trace record itself
// (QUERY_PROPOSED / SEARCH_EXECUTED / CANDIDATE_RETURNED), read back
// through loadAcquisitionLedger — the same typed reader the executor
// already trusts for job-scoped acquisition memory, which switches on a
// closed set of operation types and drops lossy refs fail-closed. No new
// table, and no second parser.
//
// Writes NO Evidence, NO acquired document and NO attempt.
export async function runSearchPhase(input: {
  db: Database | Transaction;
  jobId: string;
  items: readonly ComponentWorkItem[];
  target: (item: ComponentWorkItem) => ComponentTarget;
  queryProposer: QueryProposer;
  searchGateway: SearchGateway;
  maxSearchQueries: number;
  maxResultsPerQuery: number;
  // The per-component upper bound. D-140 makes this a CAP, not a quota:
  // the fair share decides how much of it a component may actually use.
  maxQueriesPerComponent: number;
  // D-140 — the job's own model ceiling. The proposer is a real model
  // call and is charged to the SAME envelope every other model call uses.
  // There is no phase budget.
  maxModelCostMicro: number;
  // The project whose Pattern data decides which components this job's
  // intent requires. Null degrades to "nothing required", never to a
  // guess (loadAcquisitionPlan's own contract).
  projectId: string | null;
  // Test/operational seam, same discipline as S4ExecutorDeps: when absent
  // the production catalogue is used via the model named in product
  // config. Never used to widen anything.
  queryProposerCostProfile?: ModelCostProfile;
  // Supplied by a caller that resolved the proposer with a usage
  // callback, so the audit row can carry real token counts. Absent for a
  // fixture proposer, exactly as in the executor.
  readProposerUsage?: () => ModelUsage | null | undefined;
}): Promise<SearchPhaseResult> {
  const out: SearchPhaseResult = {
    budgetRefusedComponents: [],
    modelRefusedComponents: [],
    proposerCalls: 0,
    proposerReservedMicro: 0,
    executedQueries: [],
    candidateUrls: [],
    dedupedQueries: [],
    budgetRefusedQueries: [],
  };
  const seenCandidates = new Set<string>();

  // The cost profile for this job's proposer role — the production
  // catalogue by default, resolved exactly as s4-executor resolves it.
  const proposerProfile =
    input.queryProposerCostProfile ??
    loadModelCostProfile("QUERY_PROPOSER", (await loadProductConfig(input.db)).query_proposer_model);
  const proposerCostMicro = calculateMaxAuthorizedCostMicro(proposerProfile);

  for (const [index, item] of input.items.entries()) {
    const target = input.target(item);

    // D-140 — FAIR SHARE BEFORE GENERATION.
    //
    // The bug this closes: the phase walked the work queue in Pattern
    // order taking maxQueriesPerComponent each until the axis was gone.
    // On the first real run that gave the first 6 of 10 components 2
    // searches each and the last 4 — including the components the
    // question was actually about — zero. That is precisely the defect
    // D-130 was written to prevent for the single-process executor, so
    // the answer is its allocator, unchanged, not a second one.
    //
    // Everything the allocator needs is read the same way the executor
    // reads it: the live reserved counter (never a stale snapshot), the
    // components still pending AFTER this one, and whether the job's
    // intent requires this component per the Pattern's own data.
    const plan = await loadAcquisitionPlan(input.db, input.jobId, item.component, input.projectId);
    const othersPending = input.items.slice(index + 1);
    const allowance = componentSearchAllowance({
      maxSearchQueries: input.maxSearchQueries,
      alreadyReserved: await currentSearchQueriesReserved(input.db, input.jobId),
      workQueueSize: input.items.length,
      remainingComponents: input.items.length - index,
      isIntentRequired: plan.intentRequired.has(item.component),
      hardCapPerAttempt: input.maxQueriesPerComponent,
      intentRequiredPending: othersPending.filter((c) => plan.intentRequired.has(c.component)).length,
    });

    if (allowance <= 0) {
      // The axis is genuinely spent. Do NOT call the proposer: a live
      // model call producing queries that can never be searched is money
      // spent on nothing, and the QUERY_PROPOSED rows it would write
      // would claim a generation the job could not use. Bounded coverage
      // is the honest outcome (D-130), not universal coverage.
      out.budgetRefusedComponents.push(item.component);
      await recordTraceEvent(input.db, {
        researchJobId: input.jobId,
        operationType: "MODEL_CALL_SKIPPED",
        providerKind: "QUERY_PROPOSE",
        patternStep: item.step,
        component: item.component,
        status: "SKIPPED",
        reasonCode: "SEARCH_QUERY_BUDGET_EXHAUSTED",
        budgetAxis: "searchQueries",
        budgetAmount: 0,
      });
      continue;
    }

    // D-140 — a real proposer call is real external model consumption and
    // is charged to the job's ONE model envelope, before the call, the
    // same way s4-executor charges its own. D-137 keeps the other half of
    // this true: the REPLAY proposer in EXTRACTING declares itself and is
    // charged nothing, so a phased job pays for this generation exactly
    // once.
    const metered = !isReplayProvider(input.queryProposer);
    if (metered) {
      const reserved = await reserveJobBudget(
        input.db,
        input.jobId,
        "modelCostMicro",
        proposerCostMicro,
        input.maxModelCostMicro,
      );
      if (!reserved) {
        out.modelRefusedComponents.push(item.component);
        await recordTraceEvent(input.db, {
          researchJobId: input.jobId,
          operationType: "MODEL_CALL_SKIPPED",
          providerKind: "QUERY_PROPOSE",
          patternStep: item.step,
          component: item.component,
          status: "SKIPPED",
          reasonCode: "MODEL_COST_BUDGET_EXHAUSTED",
          budgetAxis: "modelCostMicro",
          budgetAmount: proposerCostMicro,
        });
        continue;
      }
      out.proposerCalls += 1;
      out.proposerReservedMicro += proposerCostMicro;
    }

    const proposed = await input.queryProposer.proposeQueries({
      target,
      hint: item.component,
      // Never generate more than this component may actually search.
      maxQueries: allowance,
    });

    // The audit row for the real call: what it was authorized to cost and,
    // when the caller wired a usage callback, what it actually used.
    const usage = input.readProposerUsage?.() ?? null;
    await recordTraceEvent(input.db, {
      researchJobId: input.jobId,
      operationType: "MODEL_CALL_ATTEMPTED",
      providerKind: "QUERY_PROPOSE",
      providerName: input.queryProposer.name,
      patternStep: item.step,
      component: item.component,
      status: "OK",
      reasonCode: usage?.unsupportedBillingUsage ? "UNSUPPORTED_BILLING_USAGE" : "NONE",
      budgetAxis: "modelCostMicro",
      budgetAmount: metered ? proposerCostMicro : 0,
      actualInputTokens: usage?.inputTokens ?? null,
      actualOutputTokens: usage?.outputTokens ?? null,
      actualCostMicro:
        usage && !usage.unsupportedBillingUsage ? calculateActualCostMicro(proposerProfile, usage) : null,
    });

    for (const q of proposed) {
      await recordTraceEvent(input.db, {
        researchJobId: input.jobId,
        operationType: "QUERY_PROPOSED",
        providerKind: "QUERY_PROPOSE",
        providerName: input.queryProposer.name,
        patternStep: item.step,
        component: item.component,
        targetRef: q,
        status: "OK",
      });
    }

    // Job-scoped dedup, read fresh per component so a query executed for
    // an earlier component in THIS pass is not paid for twice.
    const ledger = await loadAcquisitionLedger(input.db, input.jobId);
    for (const entry of planQueries(proposed, ledger)) {
      if (!entry.needsSearch) {
        out.dedupedQueries.push(entry.query);
        // A deduped query still contributes what it already found.
        for (const url of entry.knownCandidates) {
          if (!seenCandidates.has(url)) {
            seenCandidates.add(url);
            out.candidateUrls.push(url);
          }
        }
        continue;
      }
      const reserved = await reserveJobBudget(
        input.db,
        input.jobId,
        "searchQueries",
        1,
        input.maxSearchQueries,
      );
      if (!reserved) {
        out.budgetRefusedQueries.push(entry.query);
        await recordTraceEvent(input.db, {
          researchJobId: input.jobId,
          operationType: "SEARCH_EXECUTED",
          providerKind: "SEARCH",
          providerName: input.searchGateway.name,
          patternStep: item.step,
          component: item.component,
          targetRef: entry.query,
          status: "SKIPPED",
          reasonCode: "SEARCH_QUERY_BUDGET_EXHAUSTED",
          budgetAxis: "searchQueries",
          budgetAmount: 1,
        });
        continue;
      }
      let candidates: { url: string }[] = [];
      let failed = false;
      try {
        candidates = await input.searchGateway.search(entry.query, target, {
          maxResults: input.maxResultsPerQuery,
        });
      } catch {
        failed = true;
      }
      await recordTraceEvent(input.db, {
        researchJobId: input.jobId,
        operationType: "SEARCH_EXECUTED",
        providerKind: "SEARCH",
        providerName: input.searchGateway.name,
        patternStep: item.step,
        component: item.component,
        targetRef: entry.query,
        status: failed ? "FAILED" : "OK",
        reasonCode: failed ? "PROVIDER_ERROR" : "NONE",
        budgetAxis: "searchQueries",
        budgetAmount: 1,
      });
      if (failed) continue;
      out.executedQueries.push(entry.query);
      for (const c of candidates) {
        await recordTraceEvent(input.db, {
          researchJobId: input.jobId,
          operationType: "CANDIDATE_RETURNED",
          providerKind: "SEARCH",
          patternStep: item.step,
          component: item.component,
          targetRef: c.url,
          status: "OK",
        });
        if (!seenCandidates.has(c.url)) {
          seenCandidates.add(c.url);
          out.candidateUrls.push(c.url);
        }
      }
    }
  }
  return out;
}

// The live reserved counter for the search axis. Same read the executor
// makes before its own allowance calculation — a stale snapshot would let
// two components believe the same units are still free.
async function currentSearchQueriesReserved(
  db: Database | Transaction,
  jobId: string,
): Promise<number> {
  const [row] = await db
    .select({ reserved: researchJobs.searchQueriesReserved })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row?.reserved ?? 0;
}

// The candidate handoff, read back through the ledger's own typed reader.
// Exported so the fetch phase and its tests ask the SAME rule rather than
// a copy: only CANDIDATE_RETURNED rows contribute, lossy refs are already
// excluded by loadAcquisitionLedger, and urls this job already proved
// dead or already fetched are dropped here.
export async function loadFetchTargets(
  db: Database | Transaction,
  jobId: string,
): Promise<string[]> {
  const ledger = await loadAcquisitionLedger(db, jobId);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const urls of ledger.candidatesByQuery.values()) {
    for (const url of urls) {
      const canonical = canonicalTargetRef(url);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      if (isKnownDeadUrl(url, ledger)) continue;
      if (ledger.fetchedUrls.has(canonical)) continue;
      out.push(url);
    }
  }
  return out;
}

// PHASE 2 — FETCHING (source-side environment).
//
// Consumes ONLY the persisted candidate handoff, fetches through the
// ordinary bounded transport, and seals each document under
// PRODUCT_ACQUISITION. Makes no model call, runs no search, writes no
// Evidence and no attempt.
//
// A url that cannot be parsed is refused before the transport is called —
// the fetcher must never be handed something that was not a real url.
export async function runFetchPhase(input: {
  db: Database;
  jobId: string;
  projectId: string;
  contentFetcher: ContentFetcher;
  maxSourceOpens: number;
}): Promise<FetchPhaseResult> {
  const out: FetchPhaseResult = {
    sealedDocumentIds: [],
    skippedUrls: [],
    failedUrls: [],
    refusedUrls: [],
  };
  const targets = await loadFetchTargets(input.db, input.jobId);

  for (const url of targets) {
    // Fail closed before any transport call.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        out.refusedUrls.push(url);
        continue;
      }
    } catch {
      out.refusedUrls.push(url);
      continue;
    }

    const reserved = await reserveJobBudget(
      input.db,
      input.jobId,
      "sourceOpens",
      1,
      input.maxSourceOpens,
    );
    if (!reserved) {
      out.skippedUrls.push(url);
      continue;
    }

    await recordTraceEvent(input.db, {
      researchJobId: input.jobId,
      operationType: "FETCH_ATTEMPTED",
      providerKind: "FETCH",
      providerName: input.contentFetcher.name,
      targetRef: url,
      status: "OK",
      budgetAxis: "sourceOpens",
      budgetAmount: 1,
    });

    let doc: FetchedDocument;
    try {
      doc = await input.contentFetcher.fetch(url);
    } catch {
      out.failedUrls.push(url);
      await recordTraceEvent(input.db, {
        researchJobId: input.jobId,
        operationType: "FETCH_FAILED",
        providerKind: "FETCH",
        providerName: input.contentFetcher.name,
        targetRef: url,
        status: "FAILED",
        reasonCode: "PROVIDER_ERROR",
      });
      continue;
    }

    // Authority is RESOLVED and recorded, never granted. An unclassified
    // or unconfirmed route is persisted exactly as it resolved.
    const route = await resolveSourceRoute(input.db, input.projectId, doc.finalUrl);
    const stored = await persistAcquiredDocument(input.db, {
      projectId: input.projectId,
      acquiringJobId: input.jobId,
      doc,
      route,
      renderMode: "STATIC",
      admission: "PRODUCT_ACQUISITION",
    });
    if (!stored.ok) {
      out.failedUrls.push(url);
      continue;
    }
    out.sealedDocumentIds.push(stored.id);
    await recordTraceEvent(input.db, {
      researchJobId: input.jobId,
      operationType: "FETCH_OK",
      providerKind: "FETCH",
      providerName: input.contentFetcher.name,
      targetRef: url,
      status: "OK",
    });
  }
  return out;
}

// PHASE 3 INPUT — the replay providers.
//
// Each replays one earlier phase's persisted output, and each REFUSES
// anything it was not given: the extraction environment cannot reach a
// source host, so an accidental live fetch must fail loudly rather than
// silently succeed somewhere it should not.

// Replays this job's own sealed documents. Generalises D-128's
// single-document replayContentFetcher to a set, reusing it per document
// so the "serves exactly this url, errors on anything else" rule is the
// same one, not a second copy.
export async function prepareExtractionReplayFetcher(
  db: Database | Transaction,
  jobId: string,
): Promise<{ fetcher: ContentFetcher; documentCount: number }> {
  const rows = await db
    .select()
    .from(acquiredDocuments)
    .where(eq(acquiredDocuments.acquiringJobId, jobId));

  const byUrl = new Map<string, ContentFetcher>();
  for (const row of rows) {
    const doc: FetchedDocument = {
      finalUrl: row.finalUrl,
      requestedUrl: row.url,
      httpStatus: row.httpStatus,
      // Same narrowing loadAcquiredDocumentForResume already applies to
      // this column — one rule, not a second one.
      contentType: row.contentType as FetchedDocument["contentType"],
      normalizedText: row.normalizedText,
      contentHash: row.contentHash,
      fetchedAt: row.acquiredAt,
      byteLength: row.byteLength,
      staticTextLength: row.staticTextLength ?? undefined,
    };
    const one = replayContentFetcher(doc);
    byUrl.set(canonicalTargetRef(row.url), one);
    byUrl.set(canonicalTargetRef(row.finalUrl), one);
  }

  return {
    documentCount: rows.length,
    fetcher: {
      name: "acquired-document-replay",
      // D-137: every document here was fetched and charged by the FETCH
      // phase. Replaying it performs no external open.
      metering: "REPLAY" as const,
      async fetch(url: string): Promise<FetchedDocument> {
        const one = byUrl.get(canonicalTargetRef(url));
        if (!one) {
          // Fail closed. This is the guarantee that the extraction phase
          // performs no external fetch: a url outside the sealed set has
          // no replay and is never passed to a transport.
          throw new Error(`no sealed document for url in this job: ${url}`);
        }
        return one.fetch(url);
      },
    },
  };
}

// Replays what this job already discovered FOR THIS COMPONENT.
//
// D-141 — the defect this closes, measured on a real run:
//
// The SEARCHING phase asks the proposer for queries and searches them as
// given. The executor does not: buildTargetedQueries (D-129/D-133)
// REPLACES a component's model queries with targeted ones — a
// site:<confirmed-domain> form, or a site:<explorer> <tokenAddress>
// locator. So the two halves of a phased job speak different query
// vocabularies BY DESIGN.
//
// A replay keyed only on the query string therefore answers "I have
// nothing" for a string the SEARCH phase never ran, even when the job's
// own trace holds candidates that phase discovered for exactly this
// component. On the real run every generic query returned 5 candidates
// and every targeted query returned 0, so nine of ten components entered
// extraction with an empty candidate list and reported
// NO_SEARCH_CANDIDATES — while 60 discovered URLs sat in the trace,
// including documents that had been fetched and sealed. The only
// component that produced Evidence was the one whose targeting failed to
// rewrite anything, so its generic query still matched the ledger.
//
// The replay is therefore keyed the way the corpus was actually
// discovered: CANDIDATE_RETURNED rows carry patternStep and component, so
// the gateway can answer for the component being researched. Exact-query
// matches still come first, so a query the phase really did run replays
// byte-for-byte; the component's own corpus fills the rest.
//
// This invents nothing. It admits no URL this job did not discover, for a
// component it did not discover it for; it changes no authority, no
// admissibility and no budget; every downstream check runs unchanged. It
// only stops the extraction phase from being blind to its own findings.
export async function prepareExtractionReplaySearch(
  db: Database | Transaction,
  jobId: string,
): Promise<SearchGateway> {
  const ledger = await loadAcquisitionLedger(db, jobId);

  // The per-component corpus, from the same closed event type the ledger
  // reads. Lossy refs are excluded here exactly as the ledger excludes
  // them: a redacted or truncated ref is not a fetchable URL.
  const rows = await db
    .select({
      operationType: researchTraceEvents.operationType,
      patternStep: researchTraceEvents.patternStep,
      component: researchTraceEvents.component,
      targetRef: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));

  const byComponent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.operationType !== "CANDIDATE_RETURNED") continue;
    if (row.patternStep === null || row.component === null || !row.targetRef) continue;
    if (isLossyTargetRef(row.targetRef)) continue;
    const key = `${row.patternStep}:${row.component}`;
    const list = byComponent.get(key) ?? [];
    if (!list.includes(row.targetRef)) list.push(row.targetRef);
    byComponent.set(key, list);
  }

  return {
    name: "search-replay",
    // D-137: these candidates were discovered and charged by the SEARCH
    // phase. Replaying them performs no external search.
    metering: "REPLAY" as const,
    async search(query, target, opts) {
      const exact = ledger.candidatesByQuery.get(canonicalTargetRef(query)) ?? [];
      const forComponent = byComponent.get(`${target.step}:${target.component}`) ?? [];
      const seen = new Set<string>();
      const urls: string[] = [];
      // Exact-query candidates first — a faithful replay of a query the
      // phase really ran — then the rest of this component's corpus.
      for (const url of [...exact, ...forComponent]) {
        const canonical = canonicalTargetRef(url);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        urls.push(url);
      }
      return urls.slice(0, opts.maxResults).map((url) => ({ url, title: null, snippet: null }));
    },
  };
}

// Replays the search phase's proposed queries per component, so the
// extraction phase does not re-propose (a model call) to rediscover them.
export async function prepareExtractionReplayProposer(
  db: Database | Transaction,
  jobId: string,
): Promise<QueryProposer> {
  const { researchTraceEvents } = await import("../db/schema");
  const rows = await db
    .select({
      operationType: researchTraceEvents.operationType,
      patternStep: researchTraceEvents.patternStep,
      component: researchTraceEvents.component,
      targetRef: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));

  const byKey = new Map<string, string[]>();
  for (const row of rows) {
    // Closed event type only — never an arbitrary trace string.
    if (row.operationType !== "QUERY_PROPOSED") continue;
    if (row.patternStep === null || row.component === null || !row.targetRef) continue;
    const key = `${row.patternStep}:${row.component}`;
    const list = byKey.get(key) ?? [];
    if (!list.includes(row.targetRef)) list.push(row.targetRef);
    byKey.set(key, list);
  }

  return {
    name: "query-replay",
    // D-137: these queries were proposed by a real model call in the
    // SEARCH phase and charged there. Replaying them makes no model call.
    metering: "REPLAY" as const,
    async proposeQueries(input) {
      const key = `${input.target.step}:${input.target.component}`;
      return (byKey.get(key) ?? []).slice(0, input.maxQueries);
    },
  };
}
