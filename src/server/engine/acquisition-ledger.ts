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
  //
  // JOB-WIDE ON PURPOSE, and used for exactly two things: the acquisition
  // target list (a url worth fetching is worth fetching once for the whole
  // job) and the budget fallback below. It is NOT a component's corpus —
  // see the component-scoped maps that follow.
  candidatesByQuery: ReadonlyMap<string, readonly string[]>;
  // D-152 — THE SAME QUERY ASKED BY TWO COMPONENTS IS TWO DIFFERENT FACTS.
  //
  // Keyed `step:component:canonicalQuery`. A canonical query string is not
  // a unique key for "what this component discovered": several components
  // legitimately propose the same query (a `site:` lookup on the project's
  // mint, for instance), and reuse keyed on the string alone hands one
  // component another component's findings.
  //
  // That is not a theoretical concern. In the live Raydium run the query
  // `site:solscan.io <mint>` was proposed by steps 1, 5 and 6; step 1 ran it,
  // and every later component silently inherited step 1's candidate list —
  // which meant those components never called the search gateway at all, and
  // so never reached the seed-first ordering that puts an approved
  // SOURCE_RESOURCE ahead of search results. An approved document was
  // selected, fetched and sealed, and then shown to nobody, exactly as
  // before that ordering rule existed.
  executedQueryComponents: ReadonlySet<string>;
  candidatesByQueryComponent: ReadonlyMap<string, readonly string[]>;
  // D-146 — which STRATEGIES have already attempted a given canonical
  // url in this job, keyed by the provider name the attempt was traced
  // under.
  //
  // URL-wide "dead" memory was sufficient while one transport existed. It
  // is not once a url can be attempted by several bounded strategies: a
  // worker that died after the direct fetch must let redelivery continue
  // with the NEXT strategy without repeating — or re-paying for — the
  // first. Derived from the same persisted FETCH_ATTEMPTED rows as the
  // rest of the ledger, so it survives crash and redelivery.
  strategiesAttempted: ReadonlyMap<string, ReadonlySet<string>>;
  // How many times each provider name attempted anything in this job.
  // Used for job-level policy ceilings that must survive redelivery.
  attemptsByProvider: ReadonlyMap<string, number>;
  // D-146 Slice 2 — the persisted FAILURE CLASS of each attempt on a
  // given canonical url, in sequence order.
  //
  // Slice 1 could plan the rest of a url's chain only from a failure it
  // watched happen. That made the chain unable to CONTINUE across a
  // delivery boundary: on redelivery the already-attempted strategies are
  // skipped, no live failure occurs, so nothing extended the plan and the
  // url was reported exhausted with a never-attempted strategy still
  // available. Persisting the class is what makes continuation possible
  // without repeating anything — the same rows, read for what they
  // already say.
  //
  // Only the closed diagnostic vocabulary is ever stored here (D-143), so
  // this carries no message, no address and no host-specific text.
  failureDiagnosticsByUrl: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_LEDGER: AcquisitionLedger = {
  executedQueries: new Set(),
  deadUrls: new Set(),
  fetchedUrls: new Set(),
  candidatesByQuery: new Map(),
  executedQueryComponents: new Set(),
  candidatesByQueryComponent: new Map(),
  strategiesAttempted: new Map(),
  attemptsByProvider: new Map(),
  failureDiagnosticsByUrl: new Map(),
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
        providerName: researchTraceEvents.providerName,
        diagnosticCode: researchTraceEvents.diagnosticCode,
        // D-152 — the component a row belongs to. Already persisted on
        // every SEARCH_EXECUTED and CANDIDATE_RETURNED row; the ledger
        // simply stopped reading it.
        patternStep: researchTraceEvents.patternStep,
        component: researchTraceEvents.component,
      })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId))
      .orderBy(sql`${researchTraceEvents.sequence} asc`);

    const executedQueries = new Set<string>();
    const attemptedUrls = new Set<string>();
    const fetchedUrls = new Set<string>();
    const candidatesByQuery = new Map<string, string[]>();
    const executedQueryComponents = new Set<string>();
    const candidatesByQueryComponent = new Map<string, string[]>();
    const strategiesAttempted = new Map<string, Set<string>>();
    const attemptsByProvider = new Map<string, number>();
    const failureDiagnosticsByUrl = new Map<string, string[]>();

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
          if (row.status !== "SKIPPED") {
            executedQueries.add(ref);
            const scoped = componentScopeKey(row.patternStep, row.component, ref);
            if (scoped !== null) executedQueryComponents.add(scoped);
          }
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
          // D-152 — the same candidate, attributed to the component that
          // actually discovered it. The component comes from the row's own
          // columns, never from the query string.
          const scoped = componentScopeKey(row.patternStep, row.component, currentQuery);
          if (scoped !== null) {
            const scopedList = candidatesByQueryComponent.get(scoped) ?? [];
            if (!scopedList.includes(ref)) scopedList.push(ref);
            candidatesByQueryComponent.set(scoped, scopedList);
          }
          break;
        }
        case "FETCH_ATTEMPTED": {
          if (ref) attemptedUrls.add(ref);
          // D-146: the provider name on the row IS the strategy identity.
          // A row without one contributes to the url-wide memory but to
          // no strategy, which is the safe direction: an unnamed attempt
          // never licenses skipping a named one.
          if (ref && row.providerName) {
            const byUrl = strategiesAttempted.get(ref) ?? new Set<string>();
            byUrl.add(row.providerName);
            strategiesAttempted.set(ref, byUrl);
          }
          if (row.providerName) {
            attemptsByProvider.set(
              row.providerName,
              (attemptsByProvider.get(row.providerName) ?? 0) + 1,
            );
          }
          break;
        }
        case "FETCH_OK": {
          if (ref) fetchedUrls.add(ref);
          break;
        }
        case "FETCH_FAILED": {
          // An untyped failure is recorded as such (null), never dropped:
          // "this url failed in a way nothing classified" is exactly the
          // case that must NOT license a fallback, and the planner reads
          // null that way.
          if (!ref) break;
          const list = failureDiagnosticsByUrl.get(ref) ?? [];
          list.push(row.diagnosticCode ?? "");
          failureDiagnosticsByUrl.set(ref, list);
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

    return {
      executedQueries,
      deadUrls,
      fetchedUrls,
      candidatesByQuery,
      executedQueryComponents,
      candidatesByQueryComponent,
      strategiesAttempted,
      attemptsByProvider,
      failureDiagnosticsByUrl,
    };
  } catch {
    // No memory is always safe: the engine simply behaves as it did
    // before this module existed.
    return EMPTY_LEDGER;
  }
}

export interface QueryPlanEntry {
  query: string;
  // False when THIS COMPONENT already ran this exact query in this job (or,
  // when no component scope is given, when the job did).
  needsSearch: boolean;
  // What this component itself already found for the query. Empty when the
  // component has never run it — another component's findings never appear
  // here, because they are not this component's discovery.
  knownCandidates: readonly string[];
  // D-152 — has ANY component in this job already paid a search unit for
  // this query? A budget fact, deliberately separate from the corpus facts
  // above, so the two can never be confused for one another again.
  alreadyPaid: boolean;
  // The job-wide candidates for the query. Usable ONLY as the metered
  // caller's alternative to paying a second time for the same result set;
  // never as a component's corpus.
  jobWideCandidates: readonly string[];
}

export interface QueryScope {
  step: number;
  component: string;
}

// D-152 — the reuse identity. A candidate list belongs to the (step,
// component) that discovered it, for the canonical query that discovered
// it. Returns null when the row carries no component, so an unattributed
// row can never be mistaken for one component's finding.
export function componentScopeKey(
  step: number | null,
  component: string | null,
  canonicalQuery: string,
): string | null {
  if (step === null || component === null) return null;
  return `${step}:${component}:${canonicalQuery}`;
}

// Splits an attempt's intended queries into "must actually search" and
// "already searched in this job — reuse what it found". Order is
// preserved so query priority (targeted before generic) is unchanged.
export function planQueries(
  queries: readonly string[],
  ledger: AcquisitionLedger,
  scope?: QueryScope,
): QueryPlanEntry[] {
  const seenThisAttempt = new Set<string>();
  const out: QueryPlanEntry[] = [];
  for (const raw of queries) {
    const canonical = canonicalTargetRef(raw);
    // A duplicate WITHIN one attempt is also waste, and blendQueries only
    // dedupes exact pre-canonical strings.
    if (seenThisAttempt.has(canonical)) continue;
    seenThisAttempt.add(canonical);

    const alreadyPaid = ledger.executedQueries.has(canonical);
    const scopeKey = scope
      ? componentScopeKey(scope.step, scope.component, canonical)
      : null;
    // Without a scope the caller gets the pre-D-152 behaviour unchanged.
    // With one, "already searched" means "already searched BY THIS
    // COMPONENT" — the only reading under which reusing the result is
    // reusing your own work rather than someone else's.
    const alreadyExecutedHere =
      scopeKey === null
        ? alreadyPaid
        : ledger.executedQueryComponents.has(scopeKey);
    const ownCandidates =
      scopeKey === null
        ? (ledger.candidatesByQuery.get(canonical) ?? [])
        : (ledger.candidatesByQueryComponent.get(scopeKey) ?? []);

    out.push({
      query: raw,
      needsSearch: !alreadyExecutedHere,
      knownCandidates: alreadyExecutedHere ? ownCandidates : [],
      alreadyPaid,
      jobWideCandidates: ledger.candidatesByQuery.get(canonical) ?? [],
    });
  }
  return out;
}

// D-146 — has this exact strategy already attempted this url in this job?
// Attempted means the reservation was taken and the call was made; whether
// it succeeded is a separate question the caller already knows. A strategy
// is never run twice for one url: within a delivery because the chain
// moves forward, across deliveries because this reads persisted trace.
export function strategyAlreadyAttempted(
  url: string,
  providerName: string,
  ledger: AcquisitionLedger,
): boolean {
  return ledger.strategiesAttempted.get(canonicalTargetRef(url))?.has(providerName) ?? false;
}

// D-146 — how many times a provider has been invoked in this job, read
// from persisted trace so a redelivery cannot reset a policy ceiling.
export function providerAttemptCount(providerName: string, ledger: AcquisitionLedger): number {
  return ledger.attemptsByProvider.get(providerName) ?? 0;
}

// D-146 Slice 2 — the failure classes this job has already persisted for
// this url, oldest first. An empty string means the attempt failed with no
// typed class at all, which is preserved rather than dropped: the caller
// must be able to tell "failed, unclassified" from "never failed".
export function persistedFailureDiagnostics(
  url: string,
  ledger: AcquisitionLedger,
): readonly (string | null)[] {
  const raw = ledger.failureDiagnosticsByUrl.get(canonicalTargetRef(url)) ?? [];
  return raw.map((d) => (d === "" ? null : d));
}

// True when this URL is already known to be unfetchable in this job, so
// opening it again would spend a source-open reservation on a proven dead
// end. Fetched-successfully URLs are NOT filtered here: re-reading a
// document is a separate question from re-trying a broken one, and the
// existing per-attempt candidate dedup already covers the common case.
export function isKnownDeadUrl(url: string, ledger: AcquisitionLedger): boolean {
  return ledger.deadUrls.has(canonicalTargetRef(url));
}
