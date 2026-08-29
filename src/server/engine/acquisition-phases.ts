import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { acquiredDocuments } from "../db/schema";
import { isKnownDeadUrl, loadAcquisitionLedger, planQueries } from "./acquisition-ledger";
import { persistAcquiredDocument, replayContentFetcher } from "./acquired-documents";
import type { ComponentWorkItem } from "./contract-view";
import { reserveJobBudget } from "./budget-reservation";
import type { ContentFetcher } from "./providers/content-fetcher";
import type { QueryProposer } from "./providers/query-proposer";
import type { SearchGateway } from "./providers/search-gateway";
import type { ComponentTarget, FetchedDocument } from "./providers/types";
import { resolveSourceRoute } from "./source-authority";
import { canonicalTargetRef, recordTraceEvent } from "./trace-store";

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
  maxQueriesPerComponent: number;
}): Promise<SearchPhaseResult> {
  const out: SearchPhaseResult = {
    executedQueries: [],
    candidateUrls: [],
    dedupedQueries: [],
    budgetRefusedQueries: [],
  };
  const seenCandidates = new Set<string>();

  for (const item of input.items) {
    const target = input.target(item);
    const proposed = await input.queryProposer.proposeQueries({
      target,
      hint: item.component,
      maxQueries: input.maxQueriesPerComponent,
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

// Replays the search phase's candidates for a query. Returns exactly what
// this job already discovered, so the extraction phase reaches the same
// candidate set without a live search call.
export async function prepareExtractionReplaySearch(
  db: Database | Transaction,
  jobId: string,
): Promise<SearchGateway> {
  const ledger = await loadAcquisitionLedger(db, jobId);
  return {
    name: "search-replay",
    async search(query, _target, opts) {
      const urls = ledger.candidatesByQuery.get(canonicalTargetRef(query)) ?? [];
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
    async proposeQueries(input) {
      const key = `${input.target.step}:${input.target.component}`;
      return (byKey.get(key) ?? []).slice(0, input.maxQueries);
    },
  };
}
