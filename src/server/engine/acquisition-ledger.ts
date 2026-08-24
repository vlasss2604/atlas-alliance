import { eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchTraceEvents } from "../db/schema";
import { canonicalTargetRef, isLossyTargetRef } from "./trace-store";

// ACQUISITION MINIMUM SAFE V1 (B) — job-scoped acquisition memory.
//
// The defect this closes: acquisition was stateless per component. Each
// component proposed queries, searched, and fetched with no knowledge of
// what the SAME JOB had already tried. In one real run the identical
// query ran SEVEN times across six components, returning the same five
// candidate URLs every time, and the same explorer URLs were re-fetched
// seventeen times after the first attempt had already proven them
// unopenable. Roughly ten of twelve search units and every source-open
// reservation after the first bought zero new information — and the axis
// they exhausted was the one that ended the job.
//
// SOURCE OF TRUTH: research_trace_events, which already persists exactly
// this history (SEARCH_EXECUTED / CANDIDATE_RETURNED / FETCH_OK /
// FETCH_FAILED with target_ref, ordered by `sequence`). No new table, no
// second observability model, no schema change — the audit asked for the
// existing persisted state to be reused if it could safely serve, and it
// can. Because the ledger is derived from persisted rows rather than
// in-memory state, it survives a crash/restart and spans attempts and
// recovery attempts automatically.
//
// MATCHING: trace redacts credential parameters and bounds length, so a
// raw URL is compared through canonicalTargetRef() — the same
// transformation applied when the row was written — making equality exact
// rather than approximate.
//
// SAFETY DIRECTION: every rule here only ever SKIPS work already proven
// spent or dead. It can never admit evidence, never change a source
// class, never alter admissibility, and never widen a budget. Where a
// signal is ambiguous the ledger stays silent (spend the unit) rather
// than guessing (skip a possibly-good source) — a wrongly skipped source
// is a research-quality loss, a wrongly spent unit is only a cost.

export interface AcquisitionLedger {
  // Canonical query strings for which a real search call already happened
  // in this job (successful or not — the unit was spent either way).
  executedQueries: ReadonlySet<string>;
  // Canonical URLs whose fetch was attempted and never once succeeded.
  deadUrls: ReadonlySet<string>;
  // Canonical URLs already fetched successfully in this job.
  fetchedUrls: ReadonlySet<string>;
  // Candidate URLs previously discovered by a given canonical query, so a
  // deduped query still contributes what it found instead of silently
  // shrinking the component's candidate pool.
  candidatesByQuery: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_LEDGER: AcquisitionLedger = {
  executedQueries: new Set(),
  deadUrls: new Set(),
  fetchedUrls: new Set(),
  candidatesByQuery: new Map(),
};

// Reconstructs the ledger from this job's own trace. Degrade-never-throw,
// exactly like acquisition-plan.ts: acquisition memory is an optimisation
// and must never be able to fail a job that would otherwise have run.
export async function loadAcquisitionLedger(
  db: Database | Transaction,
  jobId: string,
): Promise<AcquisitionLedger> {
  try {
    const rows = await db
      .select({
        sequence: researchTraceEvents.sequence,
        operationType: researchTraceEvents.operationType,
        targetRef: researchTraceEvents.targetRef,
        status: researchTraceEvents.status,
      })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId))
      .orderBy(sql`${researchTraceEvents.sequence} asc`);

    const executedQueries = new Set<string>();
    const attemptedUrls = new Set<string>();
    const fetchedUrls = new Set<string>();
    const candidatesByQuery = new Map<string, string[]>();

    // CANDIDATE_RETURNED rows are written by the executor immediately
    // after the SEARCH_EXECUTED row for the query that produced them, in
    // one sequential loop, so the most recent SEARCH_EXECUTED in sequence
    // order is the owning query. Ordering by `sequence` (the trace's own
    // monotonic per-job counter) is what makes this reconstruction
    // deterministic rather than timestamp-racy.
    let currentQuery: string | null = null;

    for (const row of rows) {
      const ref = row.targetRef;
      switch (row.operationType) {
        case "SEARCH_EXECUTED": {
          if (!ref) break;
          currentQuery = ref;
          // A SKIPPED row means the call was refused before it happened
          // (budget denial) — no unit was spent, so it is not "executed".
          if (row.status !== "SKIPPED") executedQueries.add(ref);
          if (!candidatesByQuery.has(ref)) candidatesByQuery.set(ref, []);
          break;
        }
        case "CANDIDATE_RETURNED": {
          if (!ref || currentQuery === null) break;
          // A trace ref is a REDACTED, length-bounded copy. Comparing
          // against it is exact, but REUSING it as a URL is not: a
          // credential parameter comes back as [REDACTED] and a long URL
          // comes back truncated, so fetching it would request a
          // different resource than the one that was discovered. Lossy
          // refs are therefore never offered as reusable candidates —
          // the query is still deduped, only its candidate list is
          // (correctly) incomplete.
          if (isLossyTargetRef(ref)) break;
          const list = candidatesByQuery.get(currentQuery);
          if (list && !list.includes(ref)) list.push(ref);
          break;
        }
        case "FETCH_ATTEMPTED": {
          if (ref) attemptedUrls.add(ref);
          break;
        }
        case "FETCH_OK": {
          if (ref) fetchedUrls.add(ref);
          break;
        }
        default:
          break;
      }
    }

    // Dead = attempted at least once and never once succeeded. A URL that
    // failed and later succeeded is deliberately NOT dead: the successful
    // outcome is the more informative one.
    const deadUrls = new Set<string>();
    for (const url of attemptedUrls) {
      if (!fetchedUrls.has(url)) deadUrls.add(url);
    }

    return { executedQueries, deadUrls, fetchedUrls, candidatesByQuery };
  } catch {
    // No memory is always safe: the engine simply behaves as it did
    // before this module existed.
    return EMPTY_LEDGER;
  }
}

export interface QueryPlanEntry {
  query: string;
  // False when this job already spent a search unit on this exact query.
  needsSearch: boolean;
  // Candidates this query is already known to return (empty unless deduped).
  knownCandidates: readonly string[];
}

// Splits an attempt's intended queries into "must actually search" and
// "already searched in this job — reuse what it found". Order is
// preserved so query priority (targeted before generic) is unchanged.
export function planQueries(
  queries: readonly string[],
  ledger: AcquisitionLedger,
): QueryPlanEntry[] {
  const seenThisAttempt = new Set<string>();
  const out: QueryPlanEntry[] = [];
  for (const raw of queries) {
    const canonical = canonicalTargetRef(raw);
    // A duplicate WITHIN one attempt is also waste, and blendQueries only
    // dedupes exact pre-canonical strings.
    if (seenThisAttempt.has(canonical)) continue;
    seenThisAttempt.add(canonical);
    const alreadyExecuted = ledger.executedQueries.has(canonical);
    out.push({
      query: raw,
      needsSearch: !alreadyExecuted,
      knownCandidates: alreadyExecuted ? (ledger.candidatesByQuery.get(canonical) ?? []) : [],
    });
  }
  return out;
}

// True when this URL is already known to be unfetchable in this job, so
// opening it again would spend a source-open reservation on a proven dead
// end. Fetched-successfully URLs are NOT filtered here: re-reading a
// document is a separate question from re-trying a broken one, and the
// existing per-attempt candidate dedup already covers the common case.
export function isKnownDeadUrl(url: string, ledger: AcquisitionLedger): boolean {
  return ledger.deadUrls.has(canonicalTargetRef(url));
}
