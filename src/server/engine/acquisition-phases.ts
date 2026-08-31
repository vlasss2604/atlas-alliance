import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { acquiredDocuments, researchTraceEvents } from "../db/schema";
import {
  loadAcquisitionLedger,
  persistedFailureDiagnostics,
  planQueries,
  providerAttemptCount,
  strategyAlreadyAttempted,
} from "./acquisition-ledger";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { loadJobContractView } from "./job-contract-view";
import { loadEligibleSourceResources } from "../memory/source-resource";
import { componentSearchAllowance } from "./budget-fairness";
import {
  calculateActualCostMicro,
  calculateMaxAuthorizedCostMicro,
  loadModelCostProfile,
} from "./model-cost-profile";
import type { ModelCostProfile } from "./model-cost-profile";
import { loadProductConfig } from "../config/product";
import { researchJobs } from "../db/schema";
import {
  persistAcquiredDocument,
  replayContentFetcher,
  textSha256,
  type AcquisitionStrategy,
} from "./acquired-documents";
import { docsPayloadRecoveryEligible } from "./docs-payload-eligibility";
import {
  evaluateRefusalRenderEligibility,
  evaluateRenderEligibility,
  RENDER_ON_REFUSAL_STATUSES,
  routeEligibility,
} from "./rendered-docs-policy";
import {
  RenderedDocsError,
  isRenderedDocsFailureReason,
  renderedDocsAvailable,
  renderedDocsEnabled,
  resolveRenderedDocsFetcher,
} from "./providers/rendered-docs-fetcher";
import type { ComponentWorkItem } from "./contract-view";
import { reserveJobBudget } from "./budget-reservation";
import { ContentFetchError } from "./providers/content-fetcher";
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
  // D-146 — urls whose every eligible strategy had already been attempted
  // in an earlier delivery, so this pass performed no external call.
  exhaustedUrls: string[];
  // Every real external strategy invocation this pass made, in order.
  strategyAttempts: Array<{ url: string; strategy: AcquisitionStrategy }>;
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
// D-148 — WHAT THIS RESEARCH STILL NEEDS, as component names.
//
// The boundary contract's own work queue: the components the planner did
// NOT mark satisfied from memory. Using it rather than the whole pattern is
// what keeps a seeded resource question-bounded — a project's curated
// sources are eligible because they serve something this job is actually
// missing, not merely because they exist.
//
// Degrade-never-throw, exactly like the ledger it sits beside: acquisition
// memory is an optimisation and must never fail a job that would otherwise
// run. No readable contract, no seeds.
async function neededComponents(
  db: Database | Transaction,
  jobId: string,
): Promise<Set<string>> {
  try {
    const { view } = await loadJobContractView(db, jobId);
    return new Set(view.workQueue.map((item) => item.component));
  } catch {
    return new Set();
  }
}

export async function loadFetchTargets(
  db: Database | Transaction,
  jobId: string,
  projectId?: string | null,
): Promise<string[]> {
  const ledger = await loadAcquisitionLedger(db, jobId);
  const out: string[] = [];
  const seen = new Set<string>();

  // D-148 — HUMAN-APPROVED RESOURCES GO FIRST.
  //
  // Search discovery is not the only thing ATLAS knows. Where a human has
  // already approved an exact url as worth fetching for this project, and
  // that url STILL resolves through an ACTIVE classified route, it should
  // not depend on a search engine rediscovering it — which is exactly what
  // failed: search returned an unclassified sibling path, the classified
  // resource was never fetched, and every fact from that document was
  // correctly admitted at the weakest source class there is.
  //
  // (Named that way on purpose: a D-141 boundary test asserts this module
  // contains no source-class token at all, and it is right to — deciding
  // what a document is worth is the authority layer's job, never the
  // planner's. This code only causes a url to be researched.)
  //
  // Order is the whole of the priority rule: seeds enter the SAME bounded
  // list before search candidates, so wherever the existing ceilings cut,
  // they cut the unclassified tail first. Relevance is not overridden —
  // eligibility already required the resource to serve a component this
  // job still needs.
  //
  // Seeds spend the ordinary source-open budget like any other target. No
  // ceiling moves because a project has curated sources.
  if (projectId) {
    const seeds = await loadEligibleSourceResources(
      db,
      projectId,
      await neededComponents(db, jobId),
    );
    for (const url of seeds) {
      const canonical = canonicalTargetRef(url);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      if (ledger.fetchedUrls.has(canonical)) continue;
      out.push(url);
    }
  }

  for (const urls of ledger.candidatesByQuery.values()) {
    for (const url of urls) {
      const canonical = canonicalTargetRef(url);
      // Dedup is canonical and shared with the seeds above, so a url known
      // both ways is one target and one budget spend, never two.
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      // D-146 — a url leaves the target list when it has been ACQUIRED,
      // not when one strategy failed on it. Which strategies remain
      // eligible is decided per url by the chain, from persisted trace,
      // so a failed strategy is still never repeated.
      if (ledger.fetchedUrls.has(canonical)) continue;
      out.push(url);
    }
  }
  return out;
}

// D-146 — THE BOUNDED ACQUISITION CHAIN.
//
// Provider names are the strategy identity everywhere: in the trace row
// that records the attempt, in the ledger that remembers which strategies
// a url has already had, and in the job-level render ceiling. DIRECT_HTTP
// keeps the transport's own name so every pre-D-146 row still reads as
// the strategy it was.
const STRATEGY_PROVIDER: Record<AcquisitionStrategy, string> = {
  DIRECT_HTTP: "safe-http",
  CONTENT_NEGOTIATION: "content-negotiation",
  ISOLATED_RENDER: "isolated-render",
};

// At most two strategies beyond the first for one url (owner-ratified).
const MAX_FALLBACK_ATTEMPTS_PER_URL = 2;
// A job-level ceiling on real renders, counted from persisted trace so a
// redelivery cannot reset it. This is a POLICY ceiling only — the
// sourceOpens reservation remains the single budget authority.
const MAX_RENDER_ATTEMPTS_PER_JOB = 4;

// WHICH FAILURES JUSTIFY WHICH FALLBACK.
//
// A fallback is justified by the failure CLASS, never by hope. The two
// security refusals terminate the chain outright: every strategy shares
// the same address classifier, so another transport could only "succeed"
// by weakening the boundary the first one correctly enforced — that is
// the one thing a fallback must never become.
//
// Deterministic refusals (a malformed url, an unsupported scheme, a
// redirect loop, an oversized body, a 404 or a 5xx) end the chain too:
// the server or the policy already answered, and asking again through a
// different pipe cannot change the answer.
//
// What remains is the honest middle: a connection that broke mid-message
// or timed out (the class where a complete document demonstrably exists
// but this transport could not finish it), a representation this fetcher
// cannot read, and the refusal statuses the canonical render-on-refusal
// policy already recognises.
export function plannedFallbacks(
  diagnostic: string | null,
  httpStatus: number | null,
): AcquisitionStrategy[] {
  switch (diagnostic) {
    // SECURITY STOP. Never anything after these.
    case "BLOCKED_ADDRESS":
    case "REDIRECT_TARGET_BLOCKED":
      return [];
    // The transport could not finish a message the origin was sending.
    case "NETWORK_ERROR":
    case "TIMEOUT":
      return ["CONTENT_NEGOTIATION", "ISOLATED_RENDER"];
    // This fetcher cannot read what was offered; ask for a representation
    // it can. A browser would face the same allowlist, so no render.
    case "UNSUPPORTED_CONTENT_TYPE":
      return ["CONTENT_NEGOTIATION"];
    // The server answered, and the answer decides. Only the canonical
    // refusal statuses admit the renderer.
    case "HTTP_ERROR":
      return httpStatus !== null && RENDER_ON_REFUSAL_STATUS_SET.has(httpStatus)
        ? ["ISOLATED_RENDER"]
        : [];
    // Deterministic policy refusals, resolver failure, and anything
    // untyped: fail closed with no fallback. (Environmental classes may
    // earn a later re-attempt under D-146 Slice 3; that is a separate
    // decision and is deliberately not implemented here.)
    default:
      return [];
  }
}

// Read from the canonical policy module rather than restated here.
const RENDER_ON_REFUSAL_STATUS_SET = RENDER_ON_REFUSAL_STATUSES;

// PHASE 2 — FETCHING (source-side environment).
//
// Consumes ONLY the persisted candidate handoff and seals each document
// under PRODUCT_ACQUISITION. Makes no model call, runs no search, writes
// no Evidence and no attempt.
//
// D-146: each url is acquired through a BOUNDED CHAIN of at most three
// code-owned strategies, stopping at the first complete document. The
// phased path thereby gains the recovery abilities the single-process
// executor already had — Stage-0 embedded-payload recovery, render on
// refusal, render on an SPA shell — by reusing those exact primitives,
// plus one new representation preference on the same transport.
//
// What the chain never does: accept an incomplete document, continue past
// a security refusal, invent a url the search phase did not find, or let
// a successful transport promote authority.
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
    exhaustedUrls: [],
    strategyAttempts: [],
  };
  const targets = await loadFetchTargets(input.db, input.jobId, input.projectId);

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

    const outcome = await acquireOneUrl(input, url, out);
    if (outcome === "BUDGET_EXHAUSTED") break;
  }
  return out;
}

type UrlOutcome = "SEALED" | "FAILED" | "EXHAUSTED" | "BUDGET_EXHAUSTED";

// One url, one bounded chain. Returns how the url ended, so the caller can
// stop the whole phase when the job's source-open axis is spent.
async function acquireOneUrl(
  input: {
    db: Database;
    jobId: string;
    projectId: string;
    contentFetcher: ContentFetcher;
    maxSourceOpens: number;
  },
  url: string,
  out: FetchPhaseResult,
): Promise<UrlOutcome> {
  // The route is resolved BEFORE any transport call because two decisions
  // depend on it up front: whether Stage-0 recovery may be requested on
  // the very same fetch, and whether the renderer is even eligible. It is
  // re-resolved on the document's finalUrl at seal time — a redirect must
  // not let a pre-fetch decision speak for where the transport landed.
  const preFetchRoute = await resolveSourceRoute(input.db, input.projectId, url);
  const recoverEmbeddedPayloads = docsPayloadRecoveryEligible(preFetchRoute);
  const rendererEnabled = renderedDocsEnabled() && renderedDocsAvailable();

  const plan: AcquisitionStrategy[] = ["DIRECT_HTTP"];

  // D-146 Slice 2 — REBUILD THE PLAN FROM WHAT IS PERSISTED, before the
  // first attempt of this delivery.
  //
  // The chain is per url, not per delivery. A delivery that finds
  // DIRECT_HTTP and CONTENT_NEGOTIATION already attempted has no live
  // failure to learn from, so without this the plan would never grow past
  // its first entry and the url would be reported exhausted while a
  // strategy that has NEVER been attempted was still owed to it. That is
  // not a retry: nothing already tried is tried again. It is the same
  // chain, continuing.
  //
  // Only the persisted CLASS is consulted, and it decides exactly what a
  // live failure of that class would have decided. The HTTP status is not
  // persisted (D-143 stores the category alone, deliberately), so a
  // reconstructed HTTP_ERROR is planned with a null status — which
  // plannedFallbacks answers with no fallback. That is the fail-closed
  // direction: a refusal-status render is earned inside the delivery that
  // saw the refusal, and never inferred afterwards from a class that
  // cannot distinguish 403 from 404.
  {
    const priorLedger = await loadAcquisitionLedger(input.db, input.jobId);
    for (const diagnostic of persistedFailureDiagnostics(url, priorLedger)) {
      if (plan.length > MAX_FALLBACK_ATTEMPTS_PER_URL) break;
      for (const next of plannedFallbacks(diagnostic, null)) {
        if (!plan.includes(next)) plan.push(next);
      }
    }
  }

  let attempted = 0;
  let lastDiagnostic: string | null = null;
  // Per url, never module state: two urls — or two jobs sharing a
  // process — must never be able to read each other's last failure.
  let lastHttpStatus: number | null = null;

  for (let i = 0; i < plan.length; i++) {
    const strategy = plan[i];
    const providerName = STRATEGY_PROVIDER[strategy];

    // Ledger is re-read per attempt: another delivery may have run this
    // exact strategy for this url already, and a strategy is never run
    // twice for one url.
    const ledger = await loadAcquisitionLedger(input.db, input.jobId);
    if (strategyAlreadyAttempted(url, providerName, ledger)) continue;

    if (strategy === "ISOLATED_RENDER") {
      if (!rendererEnabled) continue;
      if (providerAttemptCount(providerName, ledger) >= MAX_RENDER_ATTEMPTS_PER_JOB) continue;
      // Which question to ask depends on HOW the chain got here, and both
      // questions are the canonical ones.
      //
      // After an HTTP refusal there IS a status, and the existing
      // render-on-refusal policy owns which statuses qualify — that
      // policy is preserved exactly. After a transport failure there is
      // no status at all: the message never completed. Asking the refusal
      // policy there would always answer NOT_A_RENDERABLE_REFUSAL and the
      // renderer could never finish a document the origin was genuinely
      // sending — so that case asks the shared ROUTE gate instead, which
      // is the same https + CONFIRMED + OFFICIAL_DOCS + matched-prefix
      // test both existing policies are built on. No third notion of
      // renderability is introduced, and the route bar is not lowered.
      const eligibility =
        lastHttpStatus !== null
          ? evaluateRefusalRenderEligibility({
              url,
              route: preFetchRoute,
              rendererEnabled,
              httpStatus: lastHttpStatus,
            })
          : routeEligibility(url, preFetchRoute, rendererEnabled);
      if (!eligibility.eligible) continue;
      const rendered = await attemptRender(input, url, eligibility, out);
      if (rendered === "BUDGET_EXHAUSTED") return "BUDGET_EXHAUSTED";
      if (rendered === "SEALED") return "SEALED";
      attempted += 1;
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
      return "BUDGET_EXHAUSTED";
    }

    await recordTraceEvent(input.db, {
      researchJobId: input.jobId,
      operationType: "FETCH_ATTEMPTED",
      providerKind: "FETCH",
      providerName,
      targetRef: url,
      status: "OK",
      budgetAxis: "sourceOpens",
      budgetAmount: 1,
    });
    out.strategyAttempts.push({ url, strategy });
    attempted += 1;

    let doc: FetchedDocument;
    try {
      doc = await input.contentFetcher.fetch(url, {
        // Stage-0 is NOT a strategy and takes no reservation of its own:
        // it is deterministic processing of the very response this fetch
        // is already making, requested on the same call, exactly as the
        // single-process executor requests it.
        ...(recoverEmbeddedPayloads ? { recoverEmbeddedPayloads: true } : {}),
        ...(strategy === "CONTENT_NEGOTIATION"
          ? { acceptPreference: "TEXT_REPRESENTATION" as const }
          : {}),
      });
    } catch (e) {
      // D-143 — canonical reason stays PROVIDER_ERROR; the provider's own
      // categorical code survives beside it.
      const typed = e instanceof ContentFetchError ? e : null;
      lastDiagnostic = typed?.reason ?? null;
      lastHttpStatus = typed?.httpStatus ?? null;
      await recordTraceEvent(input.db, {
        researchJobId: input.jobId,
        operationType: "FETCH_FAILED",
        providerKind: "FETCH",
        providerName,
        targetRef: url,
        status: "FAILED",
        reasonCode: "PROVIDER_ERROR",
        diagnosticCode: typed ? typed.reason : null,
      });

      // Plan the rest of the chain from the failure class, once, and only
      // as far as the per-url bound allows.
      if (attempted <= MAX_FALLBACK_ATTEMPTS_PER_URL) {
        for (const next of plannedFallbacks(lastDiagnostic, lastHttpStatus)) {
          if (!plan.includes(next)) plan.push(next);
        }
      }
      continue;
    }

    const sealed = await sealDocument(input, url, doc, strategy, out, preFetchRoute, rendererEnabled);
    if (sealed === "BUDGET_EXHAUSTED") return "BUDGET_EXHAUSTED";
    if (sealed === "SEALED") return "SEALED";
    // A refused seal is a failure for this url; no other strategy can fix
    // a document the seal store itself rejected.
    return "FAILED";
  }

  if (attempted === 0) {
    // Every strategy this url is owed has now been attempted at some
    // point in this job's life. Exhausted is a statement about the URL's
    // whole chain, never about one delivery's share of it.
    out.exhaustedUrls.push(url);
    return "EXHAUSTED";
  }
  out.failedUrls.push(url);
  return "FAILED";
}

// Seals a complete document, after giving the canonical render-upgrade
// policy its say: a static response that is a substantial HTML shell with
// almost no text is exactly what the renderer exists to finish, and that
// judgement is the existing shared one, not a second detector.
async function sealDocument(
  input: {
    db: Database;
    jobId: string;
    projectId: string;
    maxSourceOpens: number;
  },
  url: string,
  doc: FetchedDocument,
  strategy: AcquisitionStrategy,
  out: FetchPhaseResult,
  preFetchRoute: Awaited<ReturnType<typeof resolveSourceRoute>>,
  rendererEnabled: boolean,
): Promise<UrlOutcome> {
  let finalDoc = doc;
  let finalStrategy = strategy;

  const upgrade = evaluateRenderEligibility({
    url: doc.finalUrl,
    route: preFetchRoute,
    staticHtmlBytes: doc.byteLength,
    staticTextLength: doc.staticTextLength ?? doc.normalizedText.length,
    rendererEnabled,
  });
  if (upgrade.eligible) {
    const ledger = await loadAcquisitionLedger(input.db, input.jobId);
    const providerName = STRATEGY_PROVIDER.ISOLATED_RENDER;
    if (
      providerAttemptCount(providerName, ledger) < MAX_RENDER_ATTEMPTS_PER_JOB &&
      !strategyAlreadyAttempted(doc.finalUrl, providerName, ledger)
    ) {
      const reserved = await reserveJobBudget(
        input.db,
        input.jobId,
        "sourceOpens",
        1,
        input.maxSourceOpens,
      );
      if (reserved) {
        await recordTraceEvent(input.db, {
          researchJobId: input.jobId,
          operationType: "FETCH_ATTEMPTED",
          providerKind: "FETCH",
          providerName,
          targetRef: doc.finalUrl,
          status: "OK",
          budgetAxis: "sourceOpens",
          budgetAmount: 1,
        });
        out.strategyAttempts.push({ url: doc.finalUrl, strategy: "ISOLATED_RENDER" });
        try {
          const rendered = await resolveRenderedDocsFetcher().render(doc.finalUrl, {
            confirmedHost: upgrade.confirmedHost,
            matchedPathPrefix: upgrade.matchedPathPrefix,
          });
          rendered.staticTextLength = doc.staticTextLength ?? doc.normalizedText.length;
          finalDoc = rendered;
          finalStrategy = "ISOLATED_RENDER";
        } catch (e) {
          // Fail closed, exactly as the executor does: a failed render is
          // never evidence and never fails the acquisition — the complete
          // static document stands.
          await recordRenderFailure(input, doc.finalUrl, e);
        }
      }
    }
  }

  // Authority is RESOLVED and recorded, never granted — and never by the
  // strategy that happened to succeed.
  const route = await resolveSourceRoute(input.db, input.projectId, finalDoc.finalUrl);
  const stored = await persistAcquiredDocument(input.db, {
    projectId: input.projectId,
    acquiringJobId: input.jobId,
    doc: finalDoc,
    route,
    renderMode: finalStrategy === "ISOLATED_RENDER" ? "RENDERED" : "STATIC",
    acquisitionStrategy: finalStrategy,
    admission: "PRODUCT_ACQUISITION",
  });
  if (!stored.ok) {
    out.failedUrls.push(url);
    return "FAILED";
  }
  out.sealedDocumentIds.push(stored.id);
  await recordTraceEvent(input.db, {
    researchJobId: input.jobId,
    operationType: "FETCH_OK",
    providerKind: "FETCH",
    providerName: STRATEGY_PROVIDER[finalStrategy],
    targetRef: url,
    status: "OK",
  });
  return "SEALED";
}

// The renderer as a FALLBACK strategy (after a transport or refusal
// failure), as opposed to the upgrade path above.
async function attemptRender(
  input: {
    db: Database;
    jobId: string;
    projectId: string;
    maxSourceOpens: number;
  },
  url: string,
  eligibility: { eligible: true; confirmedHost: string; matchedPathPrefix: string },
  out: FetchPhaseResult,
): Promise<UrlOutcome> {
  const providerName = STRATEGY_PROVIDER.ISOLATED_RENDER;
  const reserved = await reserveJobBudget(
    input.db,
    input.jobId,
    "sourceOpens",
    1,
    input.maxSourceOpens,
  );
  if (!reserved) {
    out.skippedUrls.push(url);
    return "BUDGET_EXHAUSTED";
  }
  await recordTraceEvent(input.db, {
    researchJobId: input.jobId,
    operationType: "FETCH_ATTEMPTED",
    providerKind: "FETCH",
    providerName,
    targetRef: url,
    status: "OK",
    budgetAxis: "sourceOpens",
    budgetAmount: 1,
  });
  out.strategyAttempts.push({ url, strategy: "ISOLATED_RENDER" });

  let rendered: FetchedDocument;
  try {
    rendered = await resolveRenderedDocsFetcher().render(url, {
      confirmedHost: eligibility.confirmedHost,
      matchedPathPrefix: eligibility.matchedPathPrefix,
    });
  } catch (e) {
    await recordRenderFailure(input, url, e);
    return "FAILED";
  }

  const route = await resolveSourceRoute(input.db, input.projectId, rendered.finalUrl);
  const stored = await persistAcquiredDocument(input.db, {
    projectId: input.projectId,
    acquiringJobId: input.jobId,
    doc: rendered,
    route,
    renderMode: "RENDERED",
    acquisitionStrategy: "ISOLATED_RENDER",
    admission: "PRODUCT_ACQUISITION",
  });
  if (!stored.ok) {
    out.failedUrls.push(url);
    return "FAILED";
  }
  out.sealedDocumentIds.push(stored.id);
  await recordTraceEvent(input.db, {
    researchJobId: input.jobId,
    operationType: "FETCH_OK",
    providerKind: "FETCH",
    providerName,
    targetRef: url,
    status: "OK",
  });
  return "SEALED";
}

// A render failure records the RENDERER's own closed category — never a
// fetch reason that would be false, and never a message.
async function recordRenderFailure(
  input: { db: Database; jobId: string },
  url: string,
  e: unknown,
): Promise<void> {
  const diagnosticCode =
    e instanceof RenderedDocsError && isRenderedDocsFailureReason(e.reason) ? e.reason : null;
  await recordTraceEvent(input.db, {
    researchJobId: input.jobId,
    operationType: "FETCH_FAILED",
    providerKind: "FETCH",
    providerName: STRATEGY_PROVIDER.ISOLATED_RENDER,
    targetRef: url,
    status: "FAILED",
    reasonCode: "PROVIDER_ERROR",
    diagnosticCode,
  });
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
  let admitted = 0;
  for (const row of rows) {
    // D-146 — the SAME tamper seal the strict resume path verifies. The
    // phased replay previously served persisted text without recomputing
    // it, so the two Stage-B entry points disagreed about whether a
    // sealed document had to still hash to what was sealed. A mismatch
    // fails closed by omission: the document is simply not in the replay
    // set, and the fetcher's existing refusal covers any request for it.
    // Altered content is never repaired and never re-sealed.
    if (textSha256(row.normalizedText) !== row.textSha256) continue;
    admitted += 1;
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
    // Admitted documents only: a row refused by the tamper seal is not
    // part of the replay set and must not be counted as one.
    documentCount: admitted,
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
