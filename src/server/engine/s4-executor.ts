import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { loadProductConfig } from "../config/product";
import type { Database, Transaction } from "../db/client";
import { evidence, researchJobs, sources } from "../db/schema";
import { reserveJobBudget } from "./budget-reservation";
import { isReplayProvider } from "./providers/types";
import type { ComponentWorkItem } from "./contract-view";
import type { WorkExecutionResult, WorkExecutor } from "./controller";
import {
  ModelCostProfileMissingError,
  calculateActualCostMicro,
  calculateMaxAuthorizedCostMicro,
  loadModelCostProfile,
} from "./model-cost-profile";
import type { ModelCostProfile, ModelRole } from "./model-cost-profile";
import {
  CONTENT_FETCH_FAILURE_REASONS,
  ContentFetchError,
  isHttpStatusCode,
  resolveContentFetcher,
} from "./providers/content-fetcher";
import type { ContentFetcher } from "./providers/content-fetcher";
import {
  EvidenceExtractorUnavailableError,
  isExtractorOutputDiagnostic,
  isExtractorSchemaField,
  resolveEvidenceExtractor,
} from "./providers/evidence-extractor";
import type { EvidenceExtractor, RejectedFactReport } from "./providers/evidence-extractor";
import { resolveQueryProposer } from "./providers/query-proposer";
import type { QueryProposer } from "./providers/query-proposer";
import { resolveSearchGateway } from "./providers/search-gateway";
import type { SearchGateway } from "./providers/search-gateway";
import { isTransientError } from "./providers/retry";
import { isTokenCountDiagnostic, ModelInputOversizedError, TokenCountUnavailableError } from "./providers/token-gate";
import {
  isExtractorFailureDiagnosticCode,
  type ExtractorFailureDiagnosticCode,
} from "./providers/extractor-failure-diagnostics";
import type { ComponentTarget, ExtractedFact, FetchedDocument, ModelUsage } from "./providers/types";
import { isOnchainExplorerUrl, resolveSourceClass, resolveSourceRoute, deriveSourceType } from "./source-authority";
import { observeSourceRouteCandidate } from "./source-route-candidates";
import {
  blendQueries,
  buildTargetedQueries,
  genericSearchMayEstablish,
  modelQueriesCanBeUsed,
  orderCandidatesForComponent,
} from "./acquisition-targeting";
import {
  approvedResourcesForComponent,
  isAlreadyFetchedUrl,
  isKnownDeadUrl,
  loadAcquisitionLedger,
  planQueries,
} from "./acquisition-ledger";
import { componentAdmitsOnchainAcquisition, runStructuredOnchainAcquisition } from "./onchain-acquisition";
import {
  deterministicCeilingForComponent,
  resolveOnchainSourceOpenReserve,
} from "./onchain-source-open-reserve";
import { docsPayloadRecoveryEligible } from "./docs-payload-eligibility";
import type { LocatorRejection } from "./documentary-locator";
import {
  admittedLocatorsForJob,
  persistFactLocators,
  validateFactLocators,
} from "./documentary-locator-store";
import {
  evaluateRefusalRenderEligibility,
  evaluateRenderEligibility,
  routeEligibility,
} from "./rendered-docs-policy";
import {
  MAX_FALLBACK_ATTEMPTS_PER_URL,
  plannedFallbacks,
} from "./acquisition-fallback-policy";
import {
  ACQUIRED_DOCUMENT_REPLAY_PROVIDER,
  persistAcquiredDocument,
  sealedDocumentsForJob,
  type AcquisitionStrategy,
} from "./acquired-documents";
import {
  isBrowserLaunchDiagnostic,
  isNavigationDiagnostic,
  isRenderedDocsFailureReason,
  RenderedDocsError,
  renderedDocsAvailable,
  renderedDocsEnabled,
  resolveRenderedDocsFetcher,
} from "./providers/rendered-docs-fetcher";
import { componentSearchAllowance } from "./budget-fairness";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { seedRoutedForComponent, selectApprovedSeedTargets } from "./source-resource-seeds";
import { computeEntityBinding } from "../domain/project-identity";
import { canonicalTargetRef, findAttemptId, recordTraceEvent } from "./trace-store";
import { CapabilityFatalError } from "./capability-fatal-error";
import { BudgetExhaustedError } from "./budget-exhausted-error";

// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) — this
// file's OWN instrumentation is additive-only: every recordTraceEvent
// call below sits around an existing decision (a branch/condition that
// was already here) and never changes what that decision returns, in
// what order, or which attempt/candidate it applies to. No condition,
// branch ordering, candidate ordering, containment rule, traceability
// rule, Evidence-admission rule, source classification, budget rule, or
// provider-selection rule in this file was touched to add tracing.
//
// recordTraceEvent (trace-store.ts) THROWS on persistence failure by
// design (§5 of the stage spec) — deliberately NOT caught anywhere in
// this file. An uncaught exception here propagates through
// controller.ts's executor.execute() call (which has no try/catch around
// it) and run-job.ts, and is caught only at the worker boundary
// (worker.ts's handleResearchJobTask), which maps it to
// state=FAILED/terminationReason=SYSTEM_OR_PROVIDER_FAILURE — never a
// fabricated S7 evidentiary conclusion. This file adds no new
// try/catch/exception-handling of its own to achieve that; it is a
// structural consequence of trace persistence being mandatory and
// unguarded here.

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
  // DOCUMENTARY-ONLY MODE. Absent or "ENABLED" is the ordinary behaviour
  // and the default, so nothing that does not set it changes.
  //
  // "DOCUMENTARY_ONLY" is an OWNER INSTRUCTION, not a capability probe: the
  // structured on-chain branch is not entered at all, so no retriever is
  // resolved and no RPC can be issued regardless of what the database
  // holds. It is deliberately NOT satisfied by injecting a no-op retriever
  // — that would skip the calls while still entering the branch, which is
  // a state-dependent guarantee rather than a structural one.
  chainAcquisition?: "ENABLED" | "DOCUMENTARY_ONLY";
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
// Validator reason -> the closed trace vocabulary. Exhaustive by type:
// a new rejection reason will not compile until it is given a code here,
// so a refusal can never silently become untraceable.
const LOCATOR_TRACE_REASON: Record<
  Exclude<LocatorRejection, "NOT_CLAIMED">,
  "LOCATOR_TRUNCATED" | "LOCATOR_INCOMPLETE" | "LOCATOR_NOT_IN_DOCUMENT"
> = {
  TRUNCATED_DISPLAY_FORM: "LOCATOR_TRUNCATED",
  NOT_A_COMPLETE_IDENTIFIER: "LOCATOR_INCOMPLETE",
  NOT_LITERAL_IN_DOCUMENT: "LOCATOR_NOT_IN_DOCUMENT",
};

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

// MEDIUM-2 (Stage 2 acceptance closure, D-116): converts anything an
// external provider call throws (its own typed error class OR an
// ordinary/unexpected Error) into a uniform typed outcome, so no
// exception ever escapes an execute() call from one of these four
// provider boundaries. `label` identifies which boundary threw, for an
// honest, specific reason string.
//
// Owner-approved security correction, not a research-semantic change:
// this used to interpolate the caught exception's own `.message` into
// the returned reason — and that reason ends up, unsanitized, in
// research_attempts.reason via controller.ts's generic persistence of
// WorkExecutionResult.reason (an owner-visible audit field). A provider/
// transport exception's message is free text the underlying HTTP client
// or SDK controls; it can embed a credential-bearing request URL or an
// Authorization header verbatim (confirmed reproducible: a real
// ContentFetchError thrown with such text in its message). `label` (a
// closed, code-authored constant naming which of the four provider
// boundaries failed, D-070) plus the exception's own class NAME — never
// its message — is sufficient to know provider role + operation failed +
// a safe failure category, with nothing to leak.
// S10 (LOW-3 hardening, live-provider-enablement.md §14, D-118): a small,
// deterministic maximum on the error-class category — provider data
// cannot normally control `e.constructor.name`, but bounding it anyway
// closes the theoretical case of a pathological/malicious error class
// name being interpolated here.
const MAX_FAILURE_CATEGORY_LENGTH = 64;

// THE TYPED DETAIL A FAILURE MAY SAFELY CONTRIBUTE, and nothing else.
//
// The class name alone proved too coarse to act on: a real bounded fetch
// failed and nothing recorded could say whether the site had refused us,
// the request had been SSRF-blocked, or it had simply timed out. Those
// call for opposite next moves, and one of them means a live window never
// actually opened.
//
// TWO INDEPENDENT GATES, both required. The error must be an actual
// ContentFetchError — an instanceof check against a class this repository
// owns, never a duck-typed `reason` property, because anything can carry
// a field by that name and a provider-shaped object must not be able to
// talk its way into diagnostics. And the value must be a member of the
// closed, code-authored list beside the type itself, because a runtime
// value can violate a compile-time union and a class alone therefore
// vouches for nothing.
//
// WHAT IS STILL NEVER SURFACED: message, stack, url, headers, response
// body. A fetch error's message can embed a credential-bearing URL or an
// Authorization header verbatim — confirmed reproducible — which is why
// only enumerated values pass, and why the gates are membership tests
// rather than sanitisation of free text. There is no escaping or
// redaction here to get subtly wrong.
const SAFE_FAILURE_DETAILS: ReadonlySet<string> = new Set<string>(CONTENT_FETCH_FAILURE_REASONS);

function safeFailureDetail(e: unknown): string | null {
  // count_tokens failures carry a CLOSED diagnostic classified at the
  // throw site. Same two-gate discipline as the fetch branch below: the
  // class vouches for the field existing, membership vouches for the
  // value — a forged look-alike carrying arbitrary text returns null
  // rather than crossing the boundary.
  if (e instanceof TokenCountUnavailableError) {
    if (!isTokenCountDiagnostic(e.diagnostic)) return null;
    const status = typeof e.httpStatus === "number" && Number.isInteger(e.httpStatus) ? e.httpStatus : null;
    return status === null ? e.diagnostic : `${e.diagnostic}:${status}`;
  }
  // Generation-side failures carry the SAME closed discipline (BACKLOG:
  // "Generation-side extractor failures lose their class"): the class
  // vouches for the field existing, membership vouches for the value.
  // The admissible vocabulary is the union of the two closed lists — the
  // shared provider-failure classes (classified once, at the throw site,
  // by token-gate.ts's classifier) and the extractor's own output classes
  // (MAX_TOKENS_TRUNCATED / OUTPUT_NOT_JSON / OUTPUT_SCHEMA_INVALID).
  // A null diagnostic (resolve-time configuration failures) and a forged
  // out-of-vocabulary value both return null rather than crossing.
  if (e instanceof EvidenceExtractorUnavailableError) {
    const d = e.diagnostic;
    if (d === null) return null;
    if (!isTokenCountDiagnostic(d) && !isExtractorOutputDiagnostic(d)) return null;
    // WHICH code-owned schema field failed — admitted only for the one
    // diagnostic it can describe, and only from the closed field list.
    // A field asserted alongside any other class is a contradiction, so
    // it is dropped rather than reconciled; a forged or renamed value
    // fails the membership gate and the class still crosses alone.
    if (d === "OUTPUT_SCHEMA_INVALID") {
      return isExtractorSchemaField(e.schemaField) ? `${d}:${e.schemaField}` : d;
    }
    const status = typeof e.httpStatus === "number" && Number.isInteger(e.httpStatus) ? e.httpStatus : null;
    return status === null ? d : `${d}:${status}`;
  }
  if (!(e instanceof ContentFetchError)) return null;
  if (!SAFE_FAILURE_DETAILS.has(e.reason)) return null;
  // The status is already a trusted integer — the class coerced it out of
  // the Response and refuses anything else — so appending it adds
  // actionable detail without widening what may be said.
  return e.httpStatus === null ? e.reason : `${e.reason}:${e.httpStatus}`;
}

// The same two gates, returning the typed facts a caller may branch on
// rather than a string it would have to parse. Nothing here is derived
// from a message.
function safeFetchFailure(e: unknown): { reason: string; httpStatus: number | null } | null {
  if (!(e instanceof ContentFetchError)) return null;
  if (!SAFE_FAILURE_DETAILS.has(e.reason)) return null;
  return { reason: e.reason, httpStatus: e.httpStatus };
}

// A RENDER FAILURE, sanitized by the same two independent gates the fetch
// path uses, for the same reason: the class alone vouches for nothing
// because a runtime value can violate a compile-time union, and a closed
// list alone vouches for nothing because a look-alike object can carry a
// matching `reason` field.
//
// Every renderer failure used to arrive here as one indistinguishable
// observation, which could not tell a site that defeated the browser from
// a browser that never started — opposite diagnoses with opposite next
// moves. The reason is the ONLY thing taken from the error: no message,
// no stack, no url, no rendererName, no cause.
function renderFailureObservation(label: string, e: unknown): string {
  if (!(e instanceof RenderedDocsError)) return label;
  if (!isRenderedDocsFailureReason(e.reason)) return label;
  const staged = `${label}:${e.reason}`;
  // And, when the browser is what failed, WHICH local fault it was —
  // gated the same way, from its own closed set. A launch error's own
  // text can carry an absolute path and Chromium's whole command line;
  // none of it is here, only the classification.
  if (isBrowserLaunchDiagnostic(e.diagnostic)) return `${staged}:${e.diagnostic}`;
  // Or, when the server answered and refused, WHICH status it answered
  // with. Same shape the static path already uses, and the same trusted
  // source: a Response's own status, never anything parsed out of a page.
  if (isHttpStatusCode(e.httpStatus)) return `${staged}:${e.httpStatus}`;
  // Or, when the navigation itself never completed, WHICH kind of
  // pre-response failure it was. Same closed-set gate as the others.
  if (isNavigationDiagnostic(e.navigationDiagnostic)) return `${staged}:${e.navigationDiagnostic}`;
  return staged;
}

// EXPORTED so the boundary tests ask THIS rule rather than a copy — the
// same reason validateDomain and matchesPathPrefix are exported.
export function safeFailureReason(label: string, e: unknown): string {
  const category = e instanceof Error ? e.constructor.name : "UnknownError";
  const detail = safeFailureDetail(e);
  const base = `${label}_FAILED:${category.slice(0, MAX_FAILURE_CATEGORY_LENGTH)}`;
  return detail === null ? base : `${base}:${detail}`;
}

// S10 (D-090 count-then-gate, live-provider-enablement.md §5/§17):
// classifies a caught provider exception into a closed trace reason code
// — MODEL_INPUT_OVERSIZED and TOKEN_COUNT_UNAVAILABLE are distinguished
// from the generic PROVIDER_ERROR catch-all so it is inspectable
// (alpha-inspect/trace) whether a model call was skipped because the
// exact input exceeded the approved ceiling, or because token counting
// itself failed — never the same undifferentiated bucket.
function classifyTraceReasonCode(e: unknown): "MODEL_INPUT_OVERSIZED" | "TOKEN_COUNT_UNAVAILABLE" | "PROVIDER_ERROR" {
  if (e instanceof ModelInputOversizedError) return "MODEL_INPUT_OVERSIZED";
  if (e instanceof TokenCountUnavailableError) return "TOKEN_COUNT_UNAVAILABLE";
  return "PROVIDER_ERROR";
}

// The extractor-side diagnostic_code for a trace row, from an already
// classified detail (a safeFailureDetail product — either read straight
// off a RetryOutcome, or computed here from the raw exception the retry
// loop hands its onTransientRetry callback). Narrows to the persistable
// vocabulary exactly as the EXTRACT_FAILED row always has; recordTraceEvent
// re-checks membership independently. No closed detail -> null, never a
// guess. One rule for every extractor MODEL_CALL_ATTEMPTED / EXTRACT_FAILED
// row, so the two attempt rows and the document's terminal row can never
// disagree about WHY.
function extractorDiagnosticCode(detail: string | null | undefined): ExtractorFailureDiagnosticCode | null {
  return isExtractorFailureDiagnosticCode(detail) ? detail : null;
}

async function callProvider<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<
  | { ok: true; value: T }
  | {
      ok: false;
      reason: string;
      reasonCode: ReturnType<typeof classifyTraceReasonCode>;
      fetchFailure: { reason: string; httpStatus: number | null } | null;
    }
> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return {
      ok: false,
      reason: safeFailureReason(label, e),
      reasonCode: classifyTraceReasonCode(e),
      fetchFailure: safeFetchFailure(e),
    };
  }
}

// D-090: resolves the cost profile for (role, modelId) — test-injected
// fixture profile first (structurally separate from production, items
// 3/4), else the production catalogue. S10 (D-118): role-qualified —
// QUERY_PROPOSER and EVIDENCE_EXTRACTOR may use the same modelId but
// resolve to two DIFFERENT approved profiles; a missing exact role+model
// combination fails closed exactly like before. Returns a typed failure
// reason instead of throwing past this boundary.
function resolveCostProfile(
  role: ModelRole,
  modelId: string,
  fixture: ModelCostProfile | undefined,
): { ok: true; profile: ModelCostProfile } | { ok: false; reason: string } {
  if (fixture) return { ok: true, profile: fixture };
  try {
    return { ok: true, profile: loadModelCostProfile(role, modelId) };
  } catch (e) {
    if (e instanceof ModelCostProfileMissingError) return { ok: false, reason: e.message };
    throw e;
  }
}

// S10 acceptance closure (BLOCKER-1/BLOCKER-2, D-119) — the ONE place
// that owns "reserve BEFORE every external attempt, including a retry"
// for a billable/budgeted external call (SearchGateway per-query,
// QueryProposer, EvidenceExtractor). Provider primitives themselves now
// perform exactly ONE external attempt each (retry.ts/the three
// providers/*-anthropic.ts files no longer self-retry) — this function
// is what actually issues a second reservation and a second call when a
// retry is warranted, so `research_jobs.*Reserved` always equals the
// real number of external attempts made (never one reservation
// authorizing two calls).
//
// Classification (never conflated — see live-provider-enablement.md
// closure §1/§2/§8, and the S10 final pre-smoke closure §3/§5, D-120):
//   "ok"              — the call succeeded (on attempt 1 or the retry).
//   "budget_exhausted"— a required reservation could not be authorized:
//                       either the FIRST reservation was refused (zero
//                       real attempts made), or a transient first
//                       failure warranted a retry but the retry's OWN
//                       reservation was refused (exactly one real
//                       attempt made). Neither is proven capability
//                       unavailability — the provider was never given
//                       (or never given a second) authorized attempt.
//                       HIGH-1 (D-120): the CALLER decides whether this
//                       terminates the whole job (throw
//                       BudgetExhaustedError) or is a local/continuable
//                       event for this one call within a multi-call loop
//                       (SearchGateway per-query, EvidenceExtractor
//                       per-document) — reserveAndCallWithRetry itself
//                       never throws.
//   "local"           — a non-transient failure (schema-invalid or
//                       oversized input). Local/continuable — the caller
//                       returns a normal FAILED/SKIPPED result, never
//                       throws.
//   "fatal"           — the capability itself is unavailable: a
//                       transient failure survived through the allowed
//                       retry, or count_tokens (which owns its own
//                       internal retry, see token-gate.ts) could not be
//                       obtained at all. `fatalCause` says which. The
//                       caller MUST throw CapabilityFatalError for this
//                       case — never return an ordinary
//                       WorkExecutionResult — with ONE caller-decided
//                       exception (the same seam HIGH-1/D-120 already
//                       gives "budget_exhausted"): the EvidenceExtractor
//                       per-document loop treats ONE document whose
//                       generation call exhausted the transient retry as
//                       a local, continuable EXTRACT_FAILED and throws
//                       only when TWO consecutive documents do so with
//                       no successful extraction between them. See the
//                       extractor section of createS4WorkExecutor for
//                       the exact N=2 rule. NETWORK TRANSIENT RESILIENCE
//                       V1 extends that same seam, same counter, same
//                       N=2, to a document whose count_tokens exhausted
//                       ITS transient retry (TOKEN_COUNT_TRANSIENT_
//                       RETRY_EXHAUSTED); a permanent count_tokens
//                       failure (TOKEN_COUNT_UNAVAILABLE) is never
//                       softened anywhere.
interface RetryOutcome<T> {
  kind: "ok" | "budget_exhausted" | "local" | "fatal";
  value?: T;
  reason?: string;
  reasonCode?: "PROVIDER_ERROR" | "MODEL_INPUT_OVERSIZED" | "TOKEN_COUNT_UNAVAILABLE" | "SEARCH_QUERY_BUDGET_EXHAUSTED" | "MODEL_COST_BUDGET_EXHAUSTED";
  capability?: string;
  // Present on every "fatal" outcome — the typed WHY, so a caller that is
  // allowed to soften the transient fatal causes decides on a closed
  // discriminator, never by parsing `reason` or `capability` text.
  //   TRANSIENT_RETRY_EXHAUSTED             — the generation call failed
  //                                           transiently on both attempts.
  //   TOKEN_COUNT_TRANSIENT_RETRY_EXHAUSTED — count_tokens failed transiently
  //                                           on both of ITS attempts
  //                                           (token-gate.ts's own retry).
  //   TOKEN_COUNT_UNAVAILABLE               — count_tokens failed permanently
  //                                           (auth/config/request/unknown):
  //                                           one attempt, never softened.
  fatalCause?: "TRANSIENT_RETRY_EXHAUSTED" | "TOKEN_COUNT_TRANSIENT_RETRY_EXHAUSTED" | "TOKEN_COUNT_UNAVAILABLE";
  // The closed, membership-gated detail (safeFailureDetail product) of a
  // "local" or "fatal" failure, when one exists — null/absent otherwise.
  // Lets the caller SAY the classified WHY (in the observation channel
  // and on the trace row's diagnostic_code) without ever holding the raw
  // exception. For "fatal" it is the same detail `reason` already embeds
  // into the CapabilityFatalError message, carried separately so the
  // trace rows written before/instead of a throw persist the typed code
  // rather than the bare PROVIDER_ERROR the live run was left with.
  detail?: string | null;
  attempts: number;
}

// D-130 — live read of how much of the searchQueries axis this job has
// already reserved. Read fresh immediately before computing an
// allowance, never cached: any concurrent attempt may have reserved in
// between, and a stale figure would hand out budget twice.
async function currentSearchQueriesReserved(
  db: Database | Transaction,
  jobId: string,
): Promise<number> {
  try {
    const [row] = await db
      .select({ reserved: researchJobs.searchQueriesReserved })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    return row?.reserved ?? 0;
  } catch {
    // Never let an observability read fail an attempt — a conservative 0
    // simply means "assume nothing reserved", and the real ceiling is
    // still enforced atomically by reserveJobBudget on every call.
    return 0;
  }
}

// D-130 — same live-read discipline as currentSearchQueriesReserved, for
// the sourceOpens axis.
async function currentSourceOpensReserved(
  db: Database | Transaction,
  jobId: string,
): Promise<number> {
  try {
    const [row] = await db
      .select({ reserved: researchJobs.sourceOpensReserved })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    return row?.reserved ?? 0;
  } catch {
    return 0;
  }
}

async function reserveAndCallWithRetry<T>(params: {
  db: Database | Transaction;
  jobId: string;
  budgetAxis: "searchQueries" | "modelCostMicro";
  reserveAmount: number;
  maxBudget: number;
  label: string;
  capability: string;
  fn: () => Promise<T>;
  // D-137 — whether this invocation consumes the axis at all. Omitted or
  // true means it does, so every existing call site is unchanged and a
  // new one has to opt OUT deliberately. When false the provider serves
  // already-accounted persisted results: no reservation is taken, and
  // therefore no reservation can be refused. Everything else about this
  // function — the retry policy, the transient/fatal classification, the
  // trace callbacks, the returned shape — is identical either way, so a
  // replay follows exactly the same control flow as a live call.
  meter?: boolean;
  // Invoked once per real external attempt, immediately after its
  // reservation succeeds and BEFORE fn() is called — lets a caller trace
  // "attempted" per real attempt (including a retry), not just the final
  // resolved outcome.
  onAttempt?: (attemptNumber: number) => Promise<void>;
  // S10 final pre-smoke closure (§8, D-120) — MODEL_CALL attempt
  // cardinality: invoked ONLY when attempt 1 fails transiently and the
  // loop is about to make a second, real, freshly-reserved attempt —
  // never for a non-transient/oversized/budget-denied outcome (those
  // already resolve to exactly one real attempt, already correctly
  // represented by the single post-hoc trace row the caller writes).
  // Lets a caller emit ONE audit row for the FAILED first attempt,
  // distinct from the row the caller writes for the (successful or
  // still-failing) second attempt — so trace cardinality equals real
  // external-call cardinality instead of collapsing two real attempts
  // into one row.
  onTransientRetry?: (firstAttemptError: unknown) => Promise<void>;
}): Promise<RetryOutcome<T>> {
  const budgetReasonCode: "SEARCH_QUERY_BUDGET_EXHAUSTED" | "MODEL_COST_BUDGET_EXHAUSTED" =
    params.budgetAxis === "searchQueries" ? "SEARCH_QUERY_BUDGET_EXHAUSTED" : "MODEL_COST_BUDGET_EXHAUSTED";
  let attempts = 0;
  let lastError: unknown = null;
  const meter = params.meter !== false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reserved = meter
      ? await reserveJobBudget(params.db, params.jobId, params.budgetAxis, params.reserveAmount, params.maxBudget)
      : true;
    if (!reserved) {
      // attempt===1: zero real attempts ever made. attempt===2: exactly
      // one real attempt was made (it failed transiently), then the
      // retry's own reservation was refused — never proven capability
      // unavailability either way, always budget_exhausted.
      return {
        kind: "budget_exhausted",
        reason: attempts > 0 ? safeFailureReason(params.label, lastError) : undefined,
        reasonCode: budgetReasonCode,
        attempts,
      };
    }
    attempts++;
    if (params.onAttempt) await params.onAttempt(attempt);
    try {
      const value = await params.fn();
      return { kind: "ok", value, attempts };
    } catch (e) {
      lastError = e;
      if (e instanceof ModelInputOversizedError) {
        // Never fatal (owner decision, explicit): an oversized single
        // source/input is a local operational skip, not a capability
        // failure — retrying would not change the input size.
        return { kind: "local", reason: safeFailureReason(params.label, e), reasonCode: "MODEL_INPUT_OVERSIZED", attempts };
      }
      if (e instanceof TokenCountUnavailableError) {
        // count_tokens already retried internally (token-gate.ts) before
        // this exception was thrown — an unresolved failure here means
        // the counting capability itself is unavailable, immediately.
        // The typed cause says whether that retry was even attempted:
        // `transient` is the flag token-gate.ts set from the SAME
        // classifier that decided to retry (isTransientAnthropicApiError),
        // so a permanent failure (one attempt, no retry) and an exhausted
        // transient one (two attempts) are told apart on a closed field —
        // the per-document caller may soften only the latter.
        return {
          kind: "fatal",
          fatalCause: e.transient ? "TOKEN_COUNT_TRANSIENT_RETRY_EXHAUSTED" : "TOKEN_COUNT_UNAVAILABLE",
          reason: safeFailureReason(params.label, e),
          capability: `${params.capability}_COUNT_TOKENS`,
          detail: safeFailureDetail(e),
          attempts,
        };
      }
      if (!isTransientError(e)) {
        return { kind: "local", reason: safeFailureReason(params.label, e), reasonCode: "PROVIDER_ERROR", detail: safeFailureDetail(e), attempts };
      }
      if (attempt === 2) {
        // Transient on the retry too — the capability itself is down.
        return {
          kind: "fatal",
          fatalCause: "TRANSIENT_RETRY_EXHAUSTED",
          reason: safeFailureReason(params.label, e),
          capability: params.capability,
          detail: safeFailureDetail(e),
          attempts,
        };
      }
      // Transient on attempt 1 — loop continues, reserves again, retries.
      if (params.onTransientRetry) await params.onTransientRetry(e);
    }
  }
  // Unreachable (the loop always returns), but keeps the function total.
  return { kind: "local", reason: safeFailureReason(params.label, lastError), reasonCode: "PROVIDER_ERROR", attempts };
}

interface Preflight {
  queryProposerProfile: ModelCostProfile;
  evidenceExtractorProfile: ModelCostProfile;
  searchGateway: SearchGateway;
  contentFetcher: ContentFetcher;
  queryProposer: QueryProposer;
  evidenceExtractor: EvidenceExtractor;
}

// S10 (live-provider-enablement.md §7, D-118) — mutable capture boxes for
// real provider usage, populated (at most once each) by the onUsage
// callbacks threaded through resolveQueryProposer/resolveEvidenceExtractor
// below. Never read before the corresponding provider call has actually
// returned; audit-only (see model-cost-profile.ts's calculateActualCostMicro
// and the trace-event calls that persist these).
interface UsageCapture {
  queryProposer: ModelUsage | null;
  evidenceExtractor: ModelUsage | null;
  // D-153 — the same capture-box discipline, for the facts a response
  // carried that could not be read. Overwritten per extraction call and
  // read immediately after it, exactly like evidenceExtractor above.
  rejectedFacts: readonly RejectedFactReport[] | null;
}

// S10 LAST HIGH CLOSURE (HIGH-2, D-121) — structured preflight failure:
// `kind` is the execution classification (never inferred by parsing
// `reason`'s human-readable text), `code` a closed, safe diagnostic
// identifier, `reason` the existing safe human-readable string kept for
// research_attempts.reason. Every CURRENT preflight resolver failure
// (missing credential, missing exact role-qualified cost profile,
// unresolvable required SearchGateway/ContentFetcher/model-provider
// configuration) means the underlying capability cannot function AT ALL
// this attempt — none of today's preflight failure sites represent a
// local/continuable condition, so all five below classify
// CAPABILITY_FATAL. The `kind` field exists so a FUTURE preflight check
// that genuinely is local/continuable does not have to be force-fit into
// this bucket — see the implementation report's classification table for
// why each of the five is fatal, not local.
type PreflightFailureKind = "CAPABILITY_FATAL" | "LOCAL";
interface PreflightFailure {
  ok: false;
  kind: PreflightFailureKind;
  code: string;
  reason: string;
}

function clearRejectedFacts(u: UsageCapture): void {
  u.rejectedFacts = null;
}

function capabilityFatalPreflight(code: string, reason: string): PreflightFailure {
  return { ok: false, kind: "CAPABILITY_FATAL", code, reason };
}

// MEDIUM-4/LOW-1 (S4 final acceptance fix): every resolver this attempt
// will need — cost profiles AND providers, for every stage — is resolved
// and verified HERE, before a single reservation is made. A resolver that
// throws (missing BRAVE_SEARCH_API_KEY, MODEL_GATEWAY=fake with no
// fixture, a missing cost profile) becomes a deterministic, zero-cost
// preflight failure instead of an uncaught exception escaping after
// already-reserved/spent budget (the exact "QueryProposer reserved, then
// SearchGateway resolution throws uncaught" scenario the review names).
async function preflight(
  deps: S4ExecutorDeps,
  config: { query_proposer_model: string; evidence_extractor_model: string },
  usage: UsageCapture,
): Promise<{ ok: true; value: Preflight } | PreflightFailure> {
  const qp = resolveCostProfile("QUERY_PROPOSER", config.query_proposer_model, deps.queryProposerCostProfile);
  if (!qp.ok) return capabilityFatalPreflight("MODEL_COST_PROFILE_MISSING", qp.reason);

  const ep = resolveCostProfile("EVIDENCE_EXTRACTOR", config.evidence_extractor_model, deps.evidenceExtractorCostProfile);
  if (!ep.ok) return capabilityFatalPreflight("MODEL_COST_PROFILE_MISSING", ep.reason);

  let searchGateway: SearchGateway;
  try {
    searchGateway = deps.searchGateway ?? resolveSearchGateway();
  } catch (e) {
    return capabilityFatalPreflight("SEARCH_GATEWAY_UNAVAILABLE", `SEARCH_GATEWAY: ${e instanceof Error ? e.message : String(e)}`);
  }

  let contentFetcher: ContentFetcher;
  try {
    contentFetcher = deps.contentFetcher ?? resolveContentFetcher();
  } catch (e) {
    return capabilityFatalPreflight("CONTENT_FETCHER_UNAVAILABLE", `CONTENT_FETCHER: ${e instanceof Error ? e.message : String(e)}`);
  }

  let queryProposer: QueryProposer;
  try {
    queryProposer =
      deps.queryProposer ??
      (await resolveQueryProposer(config.query_proposer_model, qp.profile.maxOutputTokens, qp.profile.maxInputTokens, (u) => {
        usage.queryProposer = u;
      }));
  } catch (e) {
    return capabilityFatalPreflight("QUERY_PROPOSER_UNAVAILABLE", `QUERY_PROPOSER: ${e instanceof Error ? e.message : String(e)}`);
  }

  let evidenceExtractor: EvidenceExtractor;
  try {
    evidenceExtractor =
      deps.evidenceExtractor ??
      (await resolveEvidenceExtractor(
        config.evidence_extractor_model,
        ep.profile.maxOutputTokens,
        ep.profile.maxInputTokens,
        (u) => {
          usage.evidenceExtractor = u;
        },
        (r) => {
          usage.rejectedFacts = r;
        },
      ));
  } catch (e) {
    return capabilityFatalPreflight("EVIDENCE_EXTRACTOR_UNAVAILABLE", `EVIDENCE_EXTRACTOR: ${e instanceof Error ? e.message : String(e)}`);
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

// TRANSIENT EXTRACTOR RESILIENCE (founder decision, option C via the
// caller-decides seam): how many extractor generation calls are made per
// document is unchanged (at most 2 — one transient retry). What changes is
// what ONE document exhausting that retry means. Before: proof that the
// capability is down, thrown as CapabilityFatalError at once, ending the
// job as SYSTEM_OR_PROVIDER_FAILURE — the live run 06ade56b died this way
// on a single NETWORK_NO_RESPONSE at its first component's SECOND document,
// right after the first had extracted successfully (two EXTRACT_OK rows).
// Now: a local EXTRACT_FAILED for that document, and the job is fatal only
// when this many CONSECUTIVE documents each exhaust their retry with no
// successful extraction in between. One document can be unlucky; two in a
// row with nothing succeeding between them is the capability-wide signal
// the fatal channel is reserved for.
//
// NETWORK TRANSIENT RESILIENCE V1 (founder-approved, application-level
// only): the SAME rule, counter and threshold now also cover a document
// whose count_tokens call exhausted its own transient retry (the live run
// 1f8e1a63 died as SYSTEM_OR_PROVIDER_FAILURE on ONE such document, during
// a short tunnel outage, after substantial paid work had completed). The
// two transient causes share one counter because they are one signal —
// "the provider could not be reached for this document, twice" — against
// one provider; which of the two calls did not get through says nothing
// more about whether the NEXT document will. Permanent count_tokens
// failures (auth/config/request) are not transient and stay immediately
// fatal, exactly as before.
const CONSECUTIVE_TRANSIENT_DOCUMENTS_FATAL_THRESHOLD = 2;

export function createS4WorkExecutor(deps: S4ExecutorDeps): WorkExecutor {
  // The consecutive-document counter. Held on the executor instance — one
  // per job run in every production path (worker.ts / live-executor.ts /
  // owner-alpha-routing.ts each build one per job) and never shared across
  // jobs — so "consecutive" spans the documents of one attempt AND the
  // documents of the attempts that follow it: an attempt whose only
  // document failed transiently, followed by the next attempt's first
  // document failing the same way, is two consecutive documents. The
  // controller runs attempts strictly one after another, so no two
  // documents are ever in flight against this counter at once. It is
  // incremented only by a document whose generation call — or, since
  // NETWORK TRANSIENT RESILIENCE V1, whose count_tokens call — exhausted
  // the transient retry (once per DOCUMENT: the retries happen inside
  // that one call, below this counter, so a document can never count
  // twice), reset only by a successful extraction (admitted or not — the
  // extractor answered, which means count_tokens AND generation both got
  // through), and left untouched by every other outcome (oversized,
  // non-transient, budget-denied), none of which says anything about
  // whether the capability is reachable.
  let consecutiveTransientlyFailedDocuments = 0;
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
      const usage: UsageCapture = { queryProposer: null, evidenceExtractor: null, rejectedFacts: null };
      const pre = await preflight(deps, config, usage);
      if (!pre.ok) {
        // HIGH-2 (S10 LAST HIGH CLOSURE, D-121): a capability-fatal
        // preflight failure (missing credential, missing exact
        // role-qualified cost profile, unresolvable required provider
        // configuration) must never become an ordinary FAILED result the
        // controller could fold into WORK_QUEUE_EXHAUSTED -> SUCCEEDED —
        // throw, exactly like a real-call CapabilityFatalError, before a
        // single reservation is made (zero cost, zero provider calls).
        if (pre.kind === "CAPABILITY_FATAL") {
          throw new CapabilityFatalError(pre.code, pre.reason);
        }
        return { status: "FAILED", reason: pre.reason, spent };
      }
      const { queryProposerProfile, evidenceExtractorProfile, searchGateway, contentFetcher, queryProposer, evidenceExtractor } =
        pre.value;

      // Stage 2: resolves the STARTED research_attempts row's own id
      // (controller.ts's claimAttempt already created it before calling
      // this executor; its id was just never threaded into ctx) so trace
      // events below can link to research_attempt_id without any change
      // to controller.ts. Best-effort null if not found — never blocks
      // or alters the attempt itself; only trace linkage degrades.
      const attemptId = await findAttemptId(deps.db, ctx.jobId, item.step, item.component, ctx.attemptNumber);

      // --- 0. Acquisition plan + allowance ---------------------------------
      // Loaded BEFORE the QueryProposer call (it used to run after). Three
      // things now depend on it existing first: the evidence-goal/task
      // context threaded into the proposer prompt (A), the decision to skip
      // a provably-useless proposer call (D), and the allowance that
      // decision reads. It is pure DB reads over authoritative records —
      // no provider, no budget, no reservation — so moving it earlier
      // cannot change cost or ordering of any external action.
      const plan = await loadAcquisitionPlan(deps.db, ctx.jobId, item.component, deps.project.id);

      // A: what this component must actually resolve, and for which task.
      // Context for query/fact generation only — never an admissibility input.
      target.researchTask = plan.researchTask;
      target.intent = plan.intent;
      target.evidenceGoal = plan.evidenceGoal;

      // --- 0b. Structured on-chain acquisition -----------------------------
      // Tried BEFORE search, because a canonical chain read is the
      // strongest source a component admitting ONCHAIN_VERIFIABLE can get,
      // and it costs one bounded reservation instead of a search + fetch +
      // model extraction chain.
      //
      // Entirely skipped unless the Pattern says this component admits
      // ONCHAIN_VERIFIABLE, the project has a confirmed identity, and a
      // retriever is actually configured. An unconfigured environment is a
      // configuration boundary, never a research failure — the attempt
      // simply falls through to the normal path.
      // ADMITTED LOCATORS ARE THE SUBJECTS. Without this the only address
      // normal research could ever address was the project's own mint, and
      // every account-kind structured intent was unreachable in production
      // — declared in the component map and never once issued. Only
      // persisted, deterministically validated locators admitted BY THIS
      // JOB are loaded: never extractor output the validator refused,
      // never a string a model proposed, never an address from anywhere
      // else. The document's authority stays on the document; a locator
      // only says where to look.
      // THE DOCUMENTARY-ONLY GUARD. Placed around the WHOLE branch rather
      // than inside it: the locator read, the intent selection, the
      // retriever resolution and every call are skipped together, so "no
      // RPC" holds because the code cannot reach one — not because the
      // database happens to hold no admitted locators today.
      //
      // Whether the deterministic on-chain path can act AT ALL in this
      // process. Set only from what this attempt actually observed — an
      // owner documentary-only instruction, or no retriever installed
      // here. It is the release condition for the source-open floor
      // below: protecting capacity for a path that cannot run would waste
      // it, and wasting it is the same starvation seen from the other
      // side. Never inferred from a project, a chain or an address.
      let onchainAcquisitionUnavailable = false;
      if (deps.chainAcquisition === "DOCUMENTARY_ONLY") {
        observations.add("ONCHAIN_DISABLED_DOCUMENTARY_ONLY");
        onchainAcquisitionUnavailable = true;
      } else {
        const admittedLocators = await admittedLocatorsForJob(deps.db, ctx.jobId);
        // THE CEILING A DETERMINISTIC READ PASSES IS NOT THE JOB CEILING.
        //
        // It used to be, and that is precisely how the promotion chain was
        // starved: anchor-level TOKEN_SUPPLY reads, each allowed the full
        // ceiling, consumed capacity a reachable promotion chain had been
        // promised. This component may now spend its OWN protected
        // allocation plus whatever is genuinely spare, and not one unit of
        // another component's protection. The job's maxSourceOpens is
        // untouched and every reservation is still bounded by it.
        const deterministicReserve = await resolveOnchainSourceOpenReserve(deps.db, {
          jobId: ctx.jobId,
          projectId: deps.project.id,
          maxSourceOpens: ctx.budget.maxSourceOpens,
        });
        const onchainOutcome = await runStructuredOnchainAcquisition({
          db: deps.db,
          jobId: ctx.jobId,
          attemptId,
          item,
          plan,
          // The validator's shape travels with the value. Dropping it here
          // is what made a documented transaction signature an ACCOUNT_INFO
          // subject that spent a protected source open and failed.
          locators: admittedLocators.map((l) => ({
            value: l.value,
            shape: l.shape,
            origin: "ADMITTED_EVIDENCE_SOURCE" as const,
          })),
          maxSourceOpens: deterministicCeilingForComponent(deterministicReserve, item.component),
          recordTrace: async (event) =>
            recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: event.operationType,
              providerKind: "FETCH",
              patternStep: item.step,
              component: item.component,
              targetRef: event.targetRef,
              status: event.status,
              reasonCode: event.reasonCode ?? "NONE",
              budgetAxis: "sourceOpens",
              budgetAmount: 1,
            }),
        });
        spent.sourceOpens += onchainOutcome.sourceOpensSpent;
        for (const code of onchainOutcome.observations) observations.add(code);
        if (onchainOutcome.observations.includes("ONCHAIN_RETRIEVER_NOT_CONFIGURED")) {
          onchainAcquisitionUnavailable = true;
        }
        if (onchainOutcome.evidenceIds.length > 0) {
          // Establishing on-chain evidence was obtained deterministically.
          // Returning here conserves the search/model budget for components
          // that got nothing — which is exactly the starvation the audit
          // found. Meaning-of-the-mechanism questions belong to OTHER
          // components (MECHANISM_SPEC / GOVERNANCE_BASIS), each with its
          // own attempt and its own doc-oriented targeting.
          return {
            status: "SUCCEEDED",
            reason: withObservations("ONCHAIN_EVIDENCE_ESTABLISHED"),
            spent,
          };
        }
      }

      // D-130: how many search units this component may spend, so that a
      // later component the job's INTENT actually requires cannot be
      // starved by earlier Pattern steps walking the queue first. Reads
      // the live reserved counter, never a stale snapshot.
      const reservedNow = await currentSearchQueriesReserved(deps.db, ctx.jobId);
      const searchAllowance = componentSearchAllowance({
        maxSearchQueries: ctx.budget.maxSearchQueries,
        alreadyReserved: reservedNow,
        workQueueSize: ctx.workQueueSize ?? 1,
        remainingComponents: ctx.remainingComponents ?? 1,
        isIntentRequired: plan.intentRequired.has(item.component),
        hardCapPerAttempt: MAX_QUERIES_PER_ATTEMPT,
        // E: an intent-required component still pending must keep a usable
        // search opportunity — a non-required component may not take the
        // last one out from under it. Counted here (not in the
        // controller) because which components an intent requires is
        // Pattern data, resolved by loadAcquisitionPlan above.
        intentRequiredPending: (ctx.pendingComponents ?? []).filter((c) =>
          plan.intentRequired.has(c),
        ).length,
      });
      // An allowance of 0 means the JOB's searchQueries axis is already
      // exhausted, not that this component is being throttled. That case
      // must keep its existing, accepted behaviour exactly: fall through
      // with one query so reserveJobBudget refuses it and
      // BudgetExhaustedError is thrown (D-120's terminal contract), never
      // silently degraded into a SKIPPED result the controller could fold
      // into WORK_QUEUE_EXHAUSTED -> SUCCEEDED. This module never decides
      // budget exhaustion itself; the atomic reservation does.
      const effectiveAllowance = Math.max(1, searchAllowance);

      // --- 1. QueryProposer -----------------------------------------------
      // BLOCKER-2 (S10 closure, D-119): reserveAndCallWithRetry reserves
      // BEFORE every external attempt, including a retry — one
      // reservation can never authorize two real calls.
      const queryProposerCostMicro = calculateMaxAuthorizedCostMicro(queryProposerProfile);

      // D: skip the call entirely when the blend below provably cannot use
      // a single model query. Deterministic (blendQueries is), conservative
      // (counts only self-contained on-chain locators), and zero-risk: when
      // it skips, deterministic targeting alone already fills every slot,
      // so the attempt searches exactly what it would have searched anyway
      // — minus one paid model call that produced discarded output.
      const canUseModelQueries = modelQueriesCanBeUsed({
        establishingClasses: plan.establishingClasses,
        onchainLocators: plan.onchainLocators,
        maxTotal: effectiveAllowance,
      });
      if (!canUseModelQueries) {
        // The trace vocabulary is closed and deliberately not extended
        // here. Among MODEL_CALL_SKIPPED rows the reason code is already
        // discriminating: MODEL_INPUT_OVERSIZED / TOKEN_COUNT_UNAVAILABLE
        // / MODEL_COST_BUDGET_EXHAUSTED each mark a real failure, so NONE
        // uniquely marks this case — nothing failed, the call was simply
        // not worth making. budgetAmount 0 records that nothing was
        // reserved. The human-readable detail rides the existing
        // observations channel below.
        observations.add("MODEL_QUERIES_UNUSABLE_SKIPPED_PROPOSER");
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: "MODEL_CALL_SKIPPED",
          providerKind: "QUERY_PROPOSE",
          patternStep: item.step,
          component: item.component,
          status: "SKIPPED",
          reasonCode: "NONE",
          budgetAxis: "modelCostMicro",
          budgetAmount: 0,
        });
      }
      // D-137: a replay proposer returns queries this job already proposed
      // and paid a model call for. Re-charging modelCostMicro here would
      // bill a second generation that never happens.
      const queryProposerMetered = !isReplayProvider(queryProposer);
      const queryProposerOutcome = canUseModelQueries
        ? await reserveAndCallWithRetry({
        db: deps.db,
        jobId: ctx.jobId,
        budgetAxis: "modelCostMicro",
        reserveAmount: queryProposerCostMicro,
        maxBudget: ctx.budget.maxModelCostMicro,
        label: "QUERY_PROPOSER",
        capability: "QUERY_PROPOSER",
        meter: queryProposerMetered,
        fn: () => queryProposer.proposeQueries({ target, hint, maxQueries: MAX_QUERIES_PER_ATTEMPT }),
        // S10 final pre-smoke closure (§8, D-120): a FAILED attempt-1
        // trace row for a transient failure that is about to be retried —
        // distinct from the row written below for the resolved (ok/
        // fatal) attempt-2 outcome, so a real 2-attempt sequence produces
        // 2 MODEL_CALL_ATTEMPTED rows, not 1.
        onTransientRetry: async (firstAttemptError) => {
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "MODEL_CALL_ATTEMPTED",
            providerKind: "QUERY_PROPOSE",
            providerName: queryProposer.name,
            patternStep: item.step,
            component: item.component,
            status: "FAILED",
            reasonCode: classifyTraceReasonCode(firstAttemptError),
            budgetAxis: "modelCostMicro",
            budgetAmount: queryProposerMetered ? queryProposerCostMicro : 0,
          });
        },
      })
        : // Skipped: no reservation was made and no call happened, so this
          // stands in as a zero-attempt, zero-cost "ok" with no queries.
          ({ kind: "ok" as const, attempts: 0, value: [] as string[] });
      spent.authorizedModelCostMicro += queryProposerMetered
        ? queryProposerOutcome.attempts * queryProposerCostMicro
        : 0;

      if (queryProposerOutcome.kind === "budget_exhausted") {
        // HIGH-1 (S10 final pre-smoke closure, D-120): QueryProposer is
        // step 1 of this component's attempt — a required reservation
        // failing here always means ZERO usable result is possible this
        // attempt (there is no "partial success" concept before any
        // query has even been proposed). Never degrade into an ordinary
        // FAILED/SKIPPED result that the controller could fold into
        // WORK_QUEUE_EXHAUSTED -> SUCCEEDED: throw, so the job's terminal
        // state honestly reflects budget exhaustion, never fabricated
        // evidentiary completion.
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: "MODEL_CALL_SKIPPED",
          providerKind: "QUERY_PROPOSE",
          patternStep: item.step,
          component: item.component,
          status: "SKIPPED",
          reasonCode: "MODEL_COST_BUDGET_EXHAUSTED",
          budgetAxis: "modelCostMicro",
          budgetAmount: queryProposerOutcome.attempts * queryProposerCostMicro,
        });
        throw new BudgetExhaustedError("modelCostMicro", queryProposerOutcome.reason);
      }
      if (queryProposerOutcome.kind === "fatal") {
        // BLOCKER-1: the capability itself is unavailable — throw, never
        // return an ordinary FAILED result. Propagates uncaught through
        // controller.ts/run-job.ts to worker.ts's existing catch
        // boundary: state=FAILED/terminationReason=SYSTEM_OR_PROVIDER_FAILURE,
        // no research_claim_support row (S7 never runs for this job).
        // §8/D-120: budgetAmount covers only THIS (final, still-failing)
        // attempt — a prior transient attempt-1 failure already has its
        // own row from onTransientRetry above.
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: "MODEL_CALL_ATTEMPTED",
          providerKind: "QUERY_PROPOSE",
          providerName: queryProposer.name,
          patternStep: item.step,
          component: item.component,
          status: "FAILED",
          reasonCode: "PROVIDER_ERROR",
          budgetAxis: "modelCostMicro",
          budgetAmount: queryProposerMetered ? queryProposerCostMicro : 0,
        });
        throw new CapabilityFatalError(queryProposerOutcome.capability!, queryProposerOutcome.reason);
      }
      if (queryProposerOutcome.kind === "local") {
        // S10 (D-090 count-then-gate, §5/§17): a dedicated skip trace for
        // the count-then-gate decision itself (no generation call was
        // ever made) vs a real attempted-and-failed call — otherwise this
        // role has no pre-call ATTEMPTED/OK/FAILED triplet the way
        // EXTRACT_* does.
        const isCountGateSkip = queryProposerOutcome.reasonCode === "MODEL_INPUT_OVERSIZED" || queryProposerOutcome.reasonCode === "TOKEN_COUNT_UNAVAILABLE";
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: isCountGateSkip ? "MODEL_CALL_SKIPPED" : "MODEL_CALL_ATTEMPTED",
          providerKind: "QUERY_PROPOSE",
          providerName: isCountGateSkip ? undefined : queryProposer.name,
          patternStep: item.step,
          component: item.component,
          status: isCountGateSkip ? "SKIPPED" : "FAILED",
          reasonCode: queryProposerOutcome.reasonCode,
          budgetAxis: "modelCostMicro",
          budgetAmount: queryProposerOutcome.attempts * queryProposerCostMicro,
        });
        return { status: "FAILED", reason: queryProposerOutcome.reason!, spent };
      }
      // "ok" — S10 (§7) — audit-only actual usage/cost for this ONE
      // successful QueryProposer attempt, priced with the SAME approved
      // profile that sized the reservation above. Exactly ONE
      // MODEL_CALL_ATTEMPTED row per call site (MEDIUM-1) — QUERY_PROPOSED
      // (below, per accepted query) never carries usage, avoiding the
      // N-rows-overstate-cost defect.
      const queryProposerUsage = usage.queryProposer;
      const queryProposerActualCostMicro =
        queryProposerUsage && !queryProposerUsage.unsupportedBillingUsage
          ? calculateActualCostMicro(queryProposerProfile, queryProposerUsage)
          : null;
      // D: no call was made, so there is no attempt to record here — the
      // MODEL_CALL_SKIPPED row above is this decision's only trace.
      if (canUseModelQueries) await recordTraceEvent(deps.db, {
        researchJobId: ctx.jobId,
        researchAttemptId: attemptId,
        operationType: "MODEL_CALL_ATTEMPTED",
        providerKind: "QUERY_PROPOSE",
        providerName: queryProposer.name,
        patternStep: item.step,
        component: item.component,
        status: "OK",
        // MEDIUM-2: never invent a price for a billable usage category
        // the approved profile can't safely price (prompt caching is not
        // used in S10) — surface it explicitly instead of an understated cost.
        reasonCode: queryProposerUsage?.unsupportedBillingUsage ? "UNSUPPORTED_BILLING_USAGE" : "NONE",
        budgetAxis: "modelCostMicro",
        // §8/D-120: this row covers only THIS (successful) attempt's
        // cost — a prior transient attempt-1 failure, if any, already
        // has its own row from onTransientRetry above.
        budgetAmount: queryProposerMetered ? queryProposerCostMicro : 0,
        actualInputTokens: queryProposerUsage?.inputTokens ?? null,
        actualOutputTokens: queryProposerUsage?.outputTokens ?? null,
        actualCostMicro: queryProposerActualCostMicro,
      });
      // Bounded again here regardless of what the proposer promised —
      // "Query count must be bounded before execution by controller
      // budget" (§2). Also drop empty/whitespace-only strings — never
      // trust shape beyond the type.
      const modelQueries = queryProposerOutcome
        .value!.filter((q) => typeof q === "string" && q.trim().length > 0)
        .slice(0, MAX_QUERIES_PER_ATTEMPT);
      // A proposer that RAN and returned nothing is still an unusable
      // attempt. A proposer that was deliberately skipped is not — the
      // deterministic locators below are this attempt's queries.
      if (modelQueries.length === 0 && canUseModelQueries) {
        return { status: "SKIPPED", reason: "NO_QUERIES_PROPOSED", spent };
      }

      // D-129: steer part of this attempt's allowance at hosts whose
      // class source-authority.ts ALREADY recognizes as one this
      // component admits. Admissibility itself is untouched — this only
      // gives admissible evidence a chance to exist.
      const { targetedQueries, unreachableClasses } = buildTargetedQueries({
        establishingClasses: plan.establishingClasses,
        confirmedRouteDomainsByClass: plan.confirmedRouteDomainsByClass,
        onchainLocators: plan.onchainLocators,
        baseQueries: modelQueries,
      });
      for (const cls of unreachableClasses) {
        // Honest, bounded observability: a required class that can only
        // come from a human-confirmed SOURCE_ROUTE this project does not
        // have. Never silently ignored — it is the real reason such a
        // component can stay INSUFFICIENT_EVIDENCE at any budget.
        observations.add(`CLASS_REQUIRES_CONFIRMED_ROUTE:${cls}`);
      }
      // Targeting REPLACES, never ADDS: the total query count for this
      // attempt can never exceed what the proposer itself returned (still
      // bounded by the fair-share allowance). Steering changes WHERE the
      // searches point, never how many search units a component spends —
      // so per-component budget accounting is identical to before D-129.
      // When the proposer ran, its own output still bounds the attempt's
      // query count (targeting REPLACES, never ADDS). When it was skipped,
      // there is no model output to bound by, so the deterministic
      // targeted queries bound it instead — still inside the same
      // fair-share allowance, so no component can spend more than before.
      const queryCountBound = canUseModelQueries
        ? Math.min(effectiveAllowance, modelQueries.length)
        : Math.min(effectiveAllowance, targetedQueries.length);
      const queries = blendQueries(
        targetedQueries,
        modelQueries,
        queryCountBound,
        genericSearchMayEstablish(plan.establishingClasses),
      );
      for (const q of queries) {
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: "QUERY_PROPOSED",
          providerKind: "QUERY_PROPOSE",
          providerName: queryProposer.name,
          patternStep: item.step,
          component: item.component,
          targetRef: q,
          status: "OK",
        });
      }

      // --- 2. SearchGateway -------------------------------------------------
      // BLOCKER-2 (S10 closure, D-119): each REAL Brave HTTP attempt —
      // including a retry — reserves its own unit of the job's real,
      // job-lifetime maxSearchQueries ceiling BEFORE it is made, via
      // reserveAndCallWithRetry. searchQueriesReserved therefore always
      // equals the real number of Brave HTTP attempts, never one
      // reservation authorizing two calls.
      const candidateUrls = new Map<string, { url: string }>();
      // LOW-A: keep the most recent typed provider failure reason around
      // so a terminal SKIPPED/FAILED result can surface it for
      // observability, instead of only a generic NO_SEARCH_CANDIDATES/
      // NO_SOURCE_COULD_BE_FETCHED reason that hides WHY every candidate/
      // query failed.
      let lastSearchFailureReason: string | null = null;
      // D-148 — THE SAME SEED POLICY THE PHASED FETCH PATH APPLIES, ASKED
      // HERE TOO.
      //
      // THE DEFECT THIS CLOSES, measured on the clean Raydium validation
      // run (job 5cc4a75a-…): the project held two ACTIVE human-approved
      // SOURCE_RESOURCE rows under ACTIVE classified routes, approved for
      // precisely the components the run failed on, and this executor
      // selected neither — SOURCE_RESOURCE_SELECTED: 0. Seeds were injected
      // only by the phased FETCH path's loadFetchTargets; here they were
      // consulted only as a tie-break among urls search had already
      // returned (D-154), so an approved document search did not
      // rediscover was unreachable at any budget.
      //
      // Selection, D-156 routing and D-150 provenance are the ONE shared
      // function, so the two paths cannot disagree about what is seedable.
      // Asked BEFORE the ledger is read, so the ledger's own
      // sourceResourcesByComponent — the D-154 tie-break and the explorer
      // rule's human-approval exemption below — sees this run's provenance
      // the same way a phased run's extraction does. What is admitted, and
      // where, is decided further down, once search has had its say.
      //
      // Idempotent on redelivery and on the phased EXTRACTING replay, where
      // the FETCH phase already recorded the same rows: nothing is written
      // twice and nothing is opened here.
      const approvedSeeds = await selectApprovedSeedTargets(deps.db, ctx.jobId, deps.project.id);
      // B: what this JOB has already searched and already proven dead.
      // Derived from persisted trace, so it spans components, attempts and
      // recovery without any new state.
      const ledger = await loadAcquisitionLedger(deps.db, ctx.jobId);
      const searchMetered = !isReplayProvider(searchGateway);
      // D-152 — REUSE IS SCOPED TO THE COMPONENT THAT DID THE WORK.
      //
      // The same canonical query is legitimately proposed by several
      // components. Keyed on the string alone, the first component to run it
      // handed its candidate list to every later one — and, worse, those
      // later components then skipped the gateway entirely, so the seed-first
      // ordering that puts an approved SOURCE_RESOURCE ahead of search
      // results never ran for them. That is how an approved document could be
      // selected, fetched and sealed and still reach no component.
      for (const entry of planQueries(queries, ledger, {
        step: item.step,
        component: item.component,
      })) {
        const query = entry.query;
        if (!entry.needsSearch) {
          // THIS component already ran this query in this job: reusing its
          // own result set spends nothing and invents nothing.
          observations.add("QUERY_ALREADY_SEARCHED_IN_JOB");
          for (const url of entry.knownCandidates) {
            if (!candidateUrls.has(url)) candidateUrls.set(url, { url });
          }
          continue;
        }
        if (entry.alreadyPaid && searchMetered) {
          // Another component already paid a unit of the scarce axis for this
          // exact query. Asking again would buy the identical result set
          // twice, so the job-wide candidates stand in — the pre-D-152
          // behaviour, kept EXACTLY for the metered path so no budget moves.
          //
          // A replay gateway is never metered (D-137: it is
          // network-impossible and already paid for), so this branch cannot
          // fire during extraction: there, every component asks the gateway
          // and every component therefore gets the seed-first corpus.
          observations.add("QUERY_ALREADY_SEARCHED_IN_JOB");
          for (const url of entry.jobWideCandidates) {
            if (!candidateUrls.has(url)) candidateUrls.set(url, { url });
          }
          continue;
        }
        // D-137: a replay gateway serves candidates this job already
        // discovered and already paid a search call for. The ledger reuse
        // above covers the identical query string; this covers the same
        // work reached under a different (targeted) phrasing, where no
        // external call happens either.
        const searchOutcome = await reserveAndCallWithRetry({
          db: deps.db,
          jobId: ctx.jobId,
          budgetAxis: "searchQueries",
          reserveAmount: 1,
          maxBudget: ctx.budget.maxSearchQueries,
          label: "SEARCH_GATEWAY",
          capability: "SEARCH_GATEWAY",
          meter: searchMetered,
          fn: () => searchGateway.search(query, target, { maxResults: MAX_SEARCH_RESULTS_PER_QUERY }),
        });
        spent.searchQueries += searchMetered ? searchOutcome.attempts : 0;

        if (searchOutcome.kind === "budget_exhausted") {
          // HIGH-1 (S10 LAST HIGH CLOSURE, D-121): a required reservation
          // could not be authorized — never proven capability
          // unavailability, but budget denial is itself the terminal
          // execution fact. Throw AT the denial boundary, regardless of
          // whether earlier queries in this same loop already produced
          // candidate URLs — a non-empty partial result is not research
          // completion, and S4 is not the sufficiency adjudicator (owner
          // instruction, explicit). Anything already recorded/persisted
          // before this point (candidate/trace rows) is left in place.
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "SEARCH_EXECUTED",
            providerKind: "SEARCH",
            patternStep: item.step,
            component: item.component,
            targetRef: query,
            status: "SKIPPED",
            reasonCode: searchOutcome.reasonCode ?? "SEARCH_QUERY_BUDGET_EXHAUSTED",
            budgetAxis: "searchQueries",
            budgetAmount: searchMetered ? searchOutcome.attempts : 0,
          });
          throw new BudgetExhaustedError("searchQueries", searchOutcome.reason ?? "SEARCH_QUERY_BUDGET_EXHAUSTED");
        }
        if (searchOutcome.kind === "fatal") {
          // BLOCKER-1: SearchGateway unavailable after the approved
          // retry — throw, never return an ordinary FAILED result (see
          // the QueryProposer section above for the full propagation
          // note).
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "SEARCH_EXECUTED",
            providerKind: "SEARCH",
            providerName: searchGateway.name,
            patternStep: item.step,
            component: item.component,
            targetRef: query,
            status: "FAILED",
            reasonCode: "PROVIDER_ERROR",
            budgetAxis: "searchQueries",
            budgetAmount: searchMetered ? searchOutcome.attempts : 0,
          });
          throw new CapabilityFatalError(searchOutcome.capability!, searchOutcome.reason);
        }
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: "SEARCH_EXECUTED",
          providerKind: "SEARCH",
          providerName: searchGateway.name,
          patternStep: item.step,
          component: item.component,
          targetRef: query,
          status: searchOutcome.kind === "ok" ? "OK" : "FAILED",
          reasonCode: searchOutcome.kind === "ok" ? "NONE" : (searchOutcome.reasonCode ?? "PROVIDER_ERROR"),
          budgetAxis: "searchQueries",
          // D-137: a replayed search reserved nothing; the row says so.
          budgetAmount: searchMetered ? searchOutcome.attempts : 0,
        });
        if (searchOutcome.kind !== "ok") {
          lastSearchFailureReason = searchOutcome.reason ?? null;
          continue; // one query's local failure doesn't fail the whole attempt
        }
        for (const r of searchOutcome.value!) {
          // A search result is a candidate URL ONLY — never Evidence
          // (§3, D-076). title/snippet are discarded here entirely; they
          // never reach evidence-extractor or persistence.
          if (typeof r.url === "string" && r.url.length > 0) {
            const wasDuplicate = candidateUrls.has(r.url);
            // D-152 — A REPLAY DISCOVERS NOTHING, SO IT RECORDS NO DISCOVERY.
            //
            // CANDIDATE_RETURNED means "a search returned this". Every url a
            // replay gateway serves is already in this job's trace — as a
            // CANDIDATE_RETURNED row from the real search, or as a
            // SOURCE_RESOURCE_SELECTED row for a curated resource. Writing
            // the row again adds no information and, for a curated url,
            // actively corrupts search provenance: it would forge exactly
            // the event D-150 refused to forge, and the trace would stop
            // being able to tell a discovered candidate from an approved one.
            //
            // Reachable only since components stopped bypassing the gateway,
            // which is what the rest of D-152 fixes. The candidate itself is
            // still admitted below; only the duplicate claim is dropped.
            if (searchMetered) {
              await recordTraceEvent(deps.db, {
                researchJobId: ctx.jobId,
                researchAttemptId: attemptId,
                operationType: "CANDIDATE_RETURNED",
                providerKind: "SEARCH",
                patternStep: item.step,
                component: item.component,
                targetRef: r.url,
                status: "OK",
              });
            }
            if (wasDuplicate && searchMetered) {
              await recordTraceEvent(deps.db, {
                researchJobId: ctx.jobId,
                researchAttemptId: attemptId,
                operationType: "CANDIDATE_DEDUPED",
                patternStep: item.step,
                component: item.component,
                targetRef: r.url,
                status: "SKIPPED",
                reasonCode: "DUPLICATE_URL",
              });
            }
            candidateUrls.set(r.url, { url: r.url });
          }
        }
      }
      // D-148 — AN APPROVED SEED IS A CANDIDATE WHETHER OR NOT SEARCH
      // RETURNED IT.
      //
      // Only seeds the shared policy routed to THIS (step, component) — the
      // human's componentKeys plus the components whose Pattern admits the
      // resource's resolved class, intersected with what the job still
      // needs — and never one already in the set: dedupe is by the same
      // canonicalTargetRef the ledger and the phased list use, so a url
      // known both ways is one candidate and one budget spend. Trailing
      // slash or host case from search cannot make it two.
      //
      // WHAT THIS IS NOT. Not a CANDIDATE_RETURNED row — no search returned
      // it, and D-150/D-152 keep that provenance honest. Not priority: the
      // seed joins the ordinary set and is then ranked by
      // orderCandidatesForComponent from its predicted class and the
      // project's own resolved route (D-155), with approval breaking only
      // an equal-rank tie (D-154). Not authority: what the document is
      // worth is resolveSourceRoute's answer at open and at persist time,
      // as for any other url. Not free: it takes the same reservation
      // against the same documentary ceiling, inside the same per-attempt
      // allowance, through the same SSRF-safe transport, and a seed this
      // job already proved dead or already sealed is treated exactly as a
      // search candidate in that state is.
      const knownCandidates = new Set<string>();
      for (const url of candidateUrls.keys()) knownCandidates.add(canonicalTargetRef(url));
      for (const seed of approvedSeeds) {
        if (!seedRoutedForComponent(seed, item.step, item.component)) continue;
        const canonical = canonicalTargetRef(seed.canonicalUrl);
        if (knownCandidates.has(canonical)) continue;
        knownCandidates.add(canonical);
        candidateUrls.set(seed.canonicalUrl, { url: seed.canonicalUrl });
        observations.add("SOURCE_RESOURCE_SEED_ADMITTED");
      }
      if (candidateUrls.size === 0) {
        // A budget denial for this axis already threw above, at the
        // point of denial — reaching here with zero candidates means
        // every query failed for a non-budget (local/capability-already-
        // handled) reason. LOW-A: prefer the actual typed provider
        // failure reason over the generic label when one exists.
        const reason = lastSearchFailureReason ?? "NO_SEARCH_CANDIDATES";
        return { status: "FAILED", reason, spent };
      }

      // --- 3. ContentFetcher (already the accepted S1 SSRF-safe impl) ------
      // D-130: sourceOpens gets the SAME fair-share division as
      // searchQueries. With the flat per-attempt cap of 6 and a ceiling of
      // 24, five components exhausted the axis and every later component —
      // including an intent-required one — was starved. Same contract as
      // above: a proposal cap only, floored at 1, full cap for the last
      // pending component so reserveJobBudget can still refuse and throw.
      //
      // ON-CHAIN FLOOR. The same axis pays for documentary opens and for
      // bounded deterministic chain reads, so a documentary spend here can
      // starve a chain read this job has not made yet. The floor is sized
      // job-wide — every work-queue component that admits deterministic
      // on-chain acquisition and has not yet had its one bounded
      // opportunity — NOT from `ctx.pendingComponents`. Pending-emptiness
      // is not a release condition: a component whose subject arrives late
      // is revisited once after the controller, so the last component in
      // the queue must not be able to spend the capacity that revisit
      // needs. It lowers the CEILING documentary reservations use;
      // `maxSourceOpens` itself, the ledger, and the on-chain path's own
      // full-ceiling reservations are all unchanged.
      const onchainReserve = await resolveOnchainSourceOpenReserve(deps.db, {
        jobId: ctx.jobId,
        projectId: deps.project.id,
        maxSourceOpens: ctx.budget.maxSourceOpens,
        onchainAcquisitionUnavailable,
      });
      const documentaryMaxSourceOpens = onchainReserve.documentaryCeiling;
      if (onchainReserve.reserved > 0) {
        observations.add("SOURCE_OPENS_RESERVED_FOR_ONCHAIN");
      }
      // D-137: a replay fetcher serves documents this job (or the owner
      // path that sealed them) already opened and already paid for. It is
      // network-impossible by construction, so charging a source open for
      // it would meter an external action that cannot occur.
      const fetchMetered = !isReplayProvider(contentFetcher);
      // RC-8 — AN UNMETERED PHASE MUST NOT BE RATIONED BY THE METERED AXIS.
      //
      // THE DEFECT THIS CLOSES, measured on the frozen panel: in 4 of 4
      // Raydium jobs an official page was selected for seven components,
      // fetched OK, sealed with full authority — and then never extracted,
      // with no error anywhere, because nothing failed. It was simply never
      // opened.
      //
      // The allowance below divides what is LEFT of the source-open ledger.
      // By the time the EXTRACTING phase replays documents, the FETCHING
      // phase has already spent nearly all of it (20 of 24 in the observed
      // run), so remainingBudget collapses, the per-component fair share
      // floors at 1, and extraction opens exactly ONE candidate per
      // component and breaks. Every other document this job already
      // fetched and paid for stays unread — the more authoritative sources
      // acquisition found, the more it threw away.
      //
      // `fetchMetered` is already false here, because charging a source
      // open for a network-impossible read would meter an external action
      // that cannot occur (D-137). The identical reasoning governs
      // RATIONING: an axis that bounds external opens has nothing to say
      // about a read that performs none. The per-attempt hard cap still
      // applies, and extraction is still bounded by the axis that actually
      // pays for it — modelCostMicro — which reserves per extraction call
      // and is untouched here.
      const openAllowance = fetchMetered
        ? Math.max(
            1,
            componentSearchAllowance({
              maxSearchQueries: documentaryMaxSourceOpens,
              alreadyReserved: await currentSourceOpensReserved(deps.db, ctx.jobId),
              workQueueSize: ctx.workQueueSize ?? 1,
              remainingComponents: ctx.remainingComponents ?? 1,
              isIntentRequired: plan.intentRequired.has(item.component),
              hardCapPerAttempt: MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT,
            }),
          )
        : MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT;
      const fetchedDocs: Awaited<ReturnType<ContentFetcher["fetch"]>>[] = [];
      let opensAttempted = 0;
      let lastFetchFailureReason: string | null = null;
      // AN EXPLORER PAGE IS NOT THE MECHANISM THAT ESTABLISHES A CHAIN FACT.
      //
      // THE DEFECT THIS CLOSES, measured on the fresh post-fix Raydium run
      // (job 8eb1e920-…): of 17 paid documentary opens, five bought an
      // explorer SPA shell that was then correctly rejected as another
      // project's, and several more failed in transport. Every one of them
      // was a url from the code-owned ONCHAIN_EXPLORER_DOMAINS list, ranked
      // FIRST precisely because its predicted class (ONCHAIN_VERIFIABLE) is
      // one the component admits — the strongest rank there is — and then
      // opened through the ordinary documentary HTTP path, which is not the
      // mechanism this repository uses to read a chain.
      //
      // THE RULE IS GENERIC, and states one thing only: when a component's
      // on-chain facts are the DEDICATED deterministic adapter's
      // responsibility and that adapter could actually act in this process,
      // an HTTP documentary open of an explorer host cannot establish what
      // the adapter is responsible for — so it is not bought.
      //
      // Both halves are required, and neither is restated here:
      //   * `componentAdmitsOnchainAcquisition` is the SAME shared gate the
      //     on-chain source-open reserve already uses to decide what to
      //     protect capacity for — the Pattern's establishingClasses, the
      //     project's human-confirmed identity, the supported chain, and the
      //     component -> intent map, in one place so the two answers cannot
      //     drift. It says exactly what is needed here: the deterministic
      //     adapter has real, addressable work for THIS component. A
      //     component it has no intent for is untouched, and so is a project
      //     with no confirmed identity;
      //   * `onchainAcquisitionUnavailable` is false — the deterministic
      //     path is installed and permitted here, so it is a real
      //     alternative and not a promise nothing can keep. A
      //     DOCUMENTARY_ONLY job, or a process with no retriever, changes
      //     nothing: every explorer candidate stays openable exactly as
      //     before.
      //
      // By the time this line is reached, the deterministic path has ALREADY
      // run for this component and produced no evidence (a success returns
      // at step 0b) — so this is never "instead of trying"; it is "the one
      // mechanism that can answer this has been tried, and buying the SPA
      // shell of the same explorer is not a second attempt at it".
      //
      // WHAT THIS IS NOT. Not a blacklist: nothing is removed from any
      // domain list, no class is lowered, and the explorer is skipped ONLY
      // as a documentary HTTP purchase. Its CANDIDATE_RETURNED provenance
      // stays in the trace, D-133 targeting still aims search at explorers
      // by confirmed address, admitted locators still address them, the
      // deterministic adapter still reaches them, and every non-documentary
      // role an explorer url plays (provenance, transaction locator,
      // user-visible link) is untouched. No project, chain or token appears
      // in the condition.
      const explorerHttpOpenIsNotTheMechanism =
        !onchainAcquisitionUnavailable &&
        componentAdmitsOnchainAcquisition({
          component: item.component,
          establishingClasses: plan.establishingClasses,
          identity: plan.confirmedIdentity,
        });

      // D-154's approved-resource tie-break input, read once. Resolved HERE
      // rather than at the call below because the explorer rule above also
      // consults it, and asking the ledger the same question twice for one
      // attempt would be two answers waiting to disagree.
      const approvedForComponent = approvedResourcesForComponent(ledger, item.step, item.component);

      // C: open candidates whose predicted class could ESTABLISH this
      // component first, ranked across ALL of this attempt's queries — not
      // in discovery order, which drained query #1's list and never
      // reached a later query's admissible candidate.
      // B: and never re-open a URL this job has already proven dead.
      // D-155 — the class the project's OWN already-ACTIVE source routes give
      // each candidate, resolved through the ONE canonical resolver
      // (resolveSourceRoute) that every other consumer uses. Nothing is
      // manufactured here: a class appears only where a human already
      // confirmed a route for THIS project that matches THIS url, and the
      // resolver's own rules (ACTIVE only, project-scoped, domain + optional
      // path prefix, conflicting or invalid classes collapsing to null)
      // decide entirely.
      //
      // Resolved for every candidate BEFORE ordering, because ordering is
      // what was throwing the information away; the open loop below then
      // reuses these instead of resolving the same url a second time.
      const routeByCandidate = new Map<string, Awaited<ReturnType<typeof resolveSourceRoute>>>();
      await Promise.all(
        [...candidateUrls.keys()].map(async (url) => {
          routeByCandidate.set(canonicalTargetRef(url), await resolveSourceRoute(deps.db, deps.project.id, url));
        }),
      );
      // Only a CONFIRMED route may contribute a class. routeClass is already
      // null unless a matching ACTIVE row supplied exactly one valid class,
      // so this is belt-and-braces rather than a second rule — stated so the
      // narrowest valid state is visible at the point of use.
      const routeClassByCandidate = new Map(
        [...routeByCandidate].map(([key, route]) => [
          key,
          route.officiality === "CONFIRMED" ? route.routeClass : null,
        ]),
      );

      // D-154 — an approved SOURCE_RESOURCE for THIS component wins a tie
      // among equally-ranked candidates, and only a tie. Read from this
      // job's own persisted SOURCE_RESOURCE_SELECTED provenance, so the
      // priority that D-151 established in the corpus and D-152 delivered to
      // every component survives the final source-open boundary too.
      const orderedCandidates = orderCandidatesForComponent(
        [...candidateUrls.keys()],
        plan.establishingClasses,
        routeClassByCandidate,
        approvedForComponent,
      ).filter((url) => {
        if (isKnownDeadUrl(url, ledger)) {
          observations.add("SKIPPED_KNOWN_DEAD_URL");
          return false;
        }
        if (
          explorerHttpOpenIsNotTheMechanism &&
          isOnchainExplorerUrl(url) &&
          // A HUMAN DECISION IS NEVER OVERRULED BY AN ACQUISITION RULE.
          // Where this job's own provenance says someone approved this
          // exact url as a SOURCE_RESOURCE for this component (D-151/
          // D-154), it is opened. The rule above removes waste nobody
          // chose; it must not silently discard a document somebody did.
          !approvedForComponent.has(canonicalTargetRef(url))
        ) {
          observations.add("SKIPPED_EXPLORER_HTTP_ONCHAIN_PATH_OWNS_FACT");
          return false;
        }
        return true;
      });
      // A URL IS OPENED ONCE PER JOB. The phased path already lives by that
      // rule (FETCH seals, EXTRACTING replays the sealed set); this
      // executor remembered only the urls it had proven DEAD, so a page
      // that fetched fine — and was then rejected as another project's, or
      // simply held nothing for that component — was bought again by every
      // later component whose search returned it. On the first fresh
      // Raydium run one explorer page was opened three times and one
      // aggregator page twice: five source-open units and five extraction
      // calls for two documents the job already held.
      //
      // The sealed set is loaded lazily, once per attempt, and only when a
      // candidate is actually already in this job's fetched ledger. A url
      // served from it takes NO reservation (D-137: no external open
      // occurs) and is traced under the replay provider name so the trace
      // distinguishes a replay from a transport. It DOES count toward the
      // per-attempt candidate cap: this attempt inspects the same number
      // of documents it would have, and only the external opens are gone.
      // Not a skip: the document is inspected for THIS component exactly as
      // a fresh fetch would be — reuse never means "ignore the source".
      //
      // A url in the ledger with no sealed copy (sealed before this rule
      // existed, or refused by the size bound) falls through to the
      // ordinary paid fetch, exactly as before.
      let sealedByUrl: Map<string, FetchedDocument> | null = null;
      // D3 — SOURCE-OPEN EXHAUSTION IS HONOURED AFTER THE PAID WORK IS
      // READ. A refused reservation used to throw at the denial boundary,
      // aborting the attempt with documents already fetched — and already
      // paid for — sitting unextracted in `fetchedDocs`. On the first
      // fresh Raydium run an official documentation page was opened as the
      // 19th unit, the 20th reservation was refused, and the page was
      // never read. The refusal now ends the OPEN loop and is remembered
      // here; nothing below this loop opens anything, extraction runs over
      // what was fetched, and the SAME error is thrown afterwards. The
      // terminal outcome is unchanged (D-121): the job still ends
      // BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED, no ceiling moves, no unit is
      // refunded, and no further source open is made.
      let sourceOpenExhaustion: BudgetExhaustedError | null = null;
      for (const url of orderedCandidates) {
        if (opensAttempted >= openAllowance) break;
        if (fetchMetered && isAlreadyFetchedUrl(url, ledger)) {
          sealedByUrl ??= (await sealedDocumentsForJob(deps.db, ctx.jobId)).byUrl;
          const sealed = sealedByUrl.get(canonicalTargetRef(url));
          if (sealed) {
            opensAttempted += 1;
            observations.add("REUSED_ACQUIRED_DOCUMENT");
            for (const operationType of ["FETCH_ATTEMPTED", "FETCH_OK"] as const) {
              await recordTraceEvent(deps.db, {
                researchJobId: ctx.jobId,
                researchAttemptId: attemptId,
                operationType,
                providerKind: "FETCH",
                providerName: ACQUIRED_DOCUMENT_REPLAY_PROVIDER,
                patternStep: item.step,
                component: item.component,
                targetRef: url,
                status: "OK",
              });
            }
            fetchedDocs.push(sealed);
            continue;
          }
          observations.add("ACQUIRED_DOCUMENT_UNAVAILABLE");
        }
        const reserved = fetchMetered
          ? await reserveJobBudget(deps.db, ctx.jobId, "sourceOpens", 1, documentaryMaxSourceOpens)
          : true;
        if (!reserved) {
          // HIGH-1 (S10 LAST HIGH CLOSURE, D-121): the third authoritative
          // dimensional budget axis — the denial is terminal regardless of
          // whether an earlier candidate in this same loop was already
          // fetched. A non-empty partial result (one document already
          // fetched) is not proof that the planned source-open work was
          // complete — S4 is not the sufficiency adjudicator. What changes
          // (D3, above) is only WHEN the error leaves this function: after
          // the documents already opened have been extracted, never before.
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "CANDIDATE_SKIPPED_BUDGET",
            patternStep: item.step,
            component: item.component,
            targetRef: url,
            status: "SKIPPED",
            reasonCode: "SOURCE_OPEN_BUDGET_EXHAUSTED",
            budgetAxis: "sourceOpens",
            budgetAmount: 1,
          });
          sourceOpenExhaustion = new BudgetExhaustedError(
            "sourceOpens",
            lastFetchFailureReason ?? "SOURCE_OPEN_BUDGET_EXHAUSTED",
          );
          observations.add("SOURCE_OPENS_EXHAUSTED_MID_ATTEMPT");
          break;
        }
        opensAttempted += 1;
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: "FETCH_ATTEMPTED",
          providerKind: "FETCH",
          providerName: contentFetcher.name,
          patternStep: item.step,
          component: item.component,
          targetRef: url,
          status: "OK",
        });
        // Stage 0 gate. Resolved BEFORE the fetch because the recovery
        // flag has to be decided up front, and deliberately re-resolved
        // on doc.finalUrl at persist time below — a redirect must not let
        // a pre-fetch decision speak for where we actually landed. This
        // read is a cheap local query over the project's own confirmed
        // routes; it consults no provider.
        // D-155 — already resolved above, for ordering, by the same canonical
        // resolver on the same url. Reused rather than re-queried, so the
        // gate below and the ordering above can never disagree about what
        // this project's routes say. Still deliberately re-resolved on
        // doc.finalUrl at persist time: a redirect must not let a pre-fetch
        // decision speak for where we actually landed.
        const preFetchRoute =
          routeByCandidate.get(canonicalTargetRef(url)) ??
          (await resolveSourceRoute(deps.db, deps.project.id, url));
        const recoverEmbeddedPayloads = docsPayloadRecoveryEligible(preFetchRoute);
        let fetchResult = await callProvider("CONTENT_FETCHER", () =>
          contentFetcher.fetch(url, recoverEmbeddedPayloads ? { recoverEmbeddedPayloads: true } : undefined),
        );
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: fetchResult.ok ? "FETCH_OK" : "FETCH_FAILED",
          providerKind: "FETCH",
          providerName: contentFetcher.name,
          patternStep: item.step,
          component: item.component,
          targetRef: url,
          status: fetchResult.ok ? "OK" : "FAILED",
          reasonCode: fetchResult.ok ? "NONE" : "PROVIDER_ERROR",
        });
        // Which bounded strategy finally produced the document, recorded as
        // provenance on the sealed copy (D-146: a strategy alters nothing
        // about authority or admissibility).
        let acquiredVia: AcquisitionStrategy = "DIRECT_HTTP";
        if (!fetchResult.ok) {
          lastFetchFailureReason = fetchResult.reason;

          // THE SHARED FALLBACK CHAIN, ASKED HERE FOR THE FIRST TIME.
          //
          // This path had no fallback of any kind, so a confirmed
          // OFFICIAL_DOCS page whose html exceeds the transport cap ended
          // the attempt permanently — while the phased path would have
          // negotiated a smaller representation and, failing that,
          // rendered one. Same document, same policy, opposite outcome,
          // decided only by which executor happened to run.
          //
          // NO POLICY IS RESTATED HERE. `plannedFallbacks` is the one
          // decision module, now imported by both paths; this loop only
          // executes what it returns. The render gates are the same two
          // the phased path asks, chosen the same way: the refusal policy
          // when a status exists, the shared route gate when the message
          // never completed and there is none. No third notion of
          // renderability is introduced and no bar is lowered.
          //
          // Bounded exactly as the phased chain is: each strategy at most
          // once, at most MAX_FALLBACK_ATTEMPTS_PER_URL of them, every
          // attempt taking its own reservation against the SAME
          // documentary ceiling, and no cap raised anywhere.
          let fbDiagnostic = fetchResult.fetchFailure?.reason ?? null;
          let fbHttpStatus = fetchResult.fetchFailure?.httpStatus ?? null;
          let fbFailedStrategy: AcquisitionStrategy = "DIRECT_HTTP";
          const fbTried = new Set<AcquisitionStrategy>(["DIRECT_HTTP"]);
          let fbUsed = 0;
          // AN HTTP REFUSAL IS ALREADY OWNED, and must stay owned.
          //
          // For HTTP_ERROR the planner's only answer is ISOLATED_RENDER,
          // and the render-on-refusal block below is this executor's
          // long-standing implementation of exactly that branch — same
          // renderer, same gate, its own owner-visible reasons
          // (DOCS_RENDER_AFTER_REFUSAL_*). Running the chain there would
          // not add a fallback, it would rename one, and the terminal line
          // an owner reads would change for a case whose behaviour is not
          // in question. The chain therefore covers only the diagnostics
          // that previously had NO fallback at all — the transport and
          // representation failures — and a status-bearing refusal falls
          // through untouched.
          const fbChainApplies = fbHttpStatus === null;
          while (fbChainApplies && fbUsed < MAX_FALLBACK_ATTEMPTS_PER_URL) {
            const nextStrategy: AcquisitionStrategy | undefined = plannedFallbacks(
              fbDiagnostic,
              fbHttpStatus,
              fbFailedStrategy,
            ).find(
              (strategy) => !fbTried.has(strategy),
            );
            if (nextStrategy === undefined) break;
            fbTried.add(nextStrategy);
            fbUsed += 1;

            if (nextStrategy === "CONTENT_NEGOTIATION") {
              const negotiationReserved = await reserveJobBudget(
                deps.db,
                ctx.jobId,
                "sourceOpens",
                1,
                documentaryMaxSourceOpens,
              );
              if (!negotiationReserved) {
                observations.add("DOCS_FALLBACK_SKIPPED_BUDGET");
                break;
              }
              spent.sourceOpens += 1;
              // ONE RESERVATION, ONE ATTEMPT ROW. This is a real request to
              // the origin with a different Accept, and it spends a source
              // open — so it is an ATTEMPT, and the trace has to say so
              // before the call rather than only reporting how it ended.
              // Without this row the reservation is invisible and documentary
              // spend cannot be reconstructed from the attempt stream. The
              // strategy is carried in providerName, the same identity the
              // outcome row below already uses.
              await recordTraceEvent(deps.db, {
                researchJobId: ctx.jobId,
                researchAttemptId: attemptId,
                operationType: "FETCH_ATTEMPTED",
                providerKind: "FETCH",
                providerName: "content-negotiation",
                patternStep: item.step,
                component: item.component,
                targetRef: url,
                status: "OK",
              });
              const negotiated = await callProvider("CONTENT_FETCHER", () =>
                contentFetcher.fetch(url, {
                  ...(recoverEmbeddedPayloads ? { recoverEmbeddedPayloads: true } : {}),
                  acceptPreference: "TEXT_REPRESENTATION" as const,
                }),
              );
              await recordTraceEvent(deps.db, {
                researchJobId: ctx.jobId,
                researchAttemptId: attemptId,
                operationType: negotiated.ok ? "FETCH_OK" : "FETCH_FAILED",
                providerKind: "FETCH",
                providerName: "content-negotiation",
                patternStep: item.step,
                component: item.component,
                targetRef: url,
                status: negotiated.ok ? "OK" : "FAILED",
                reasonCode: negotiated.ok ? "NONE" : "PROVIDER_ERROR",
              });
              if (negotiated.ok) {
                observations.add("DOCS_NEGOTIATED_AFTER_FETCH_FAILURE");
                fetchResult = negotiated;
                acquiredVia = "CONTENT_NEGOTIATION";
                break;
              }
              lastFetchFailureReason = negotiated.reason;
              fbDiagnostic = negotiated.fetchFailure?.reason ?? null;
              fbHttpStatus = negotiated.fetchFailure?.httpStatus ?? null;
              fbFailedStrategy = nextStrategy;
              continue;
            }

            // ISOLATED_RENDER — the same renderer, the same one-navigation
            // isolated child, and the same gates the phased path asks.
            const renderGate =
              fbHttpStatus !== null
                ? evaluateRefusalRenderEligibility({
                    url,
                    route: preFetchRoute,
                    rendererEnabled: renderedDocsEnabled() && renderedDocsAvailable(),
                    httpStatus: fbHttpStatus,
                  })
                : routeEligibility(
                    url,
                    preFetchRoute,
                    renderedDocsEnabled() && renderedDocsAvailable(),
                  );
            if (!renderGate.eligible) break;
            const fallbackRenderReserved = await reserveJobBudget(
              deps.db,
              ctx.jobId,
              "sourceOpens",
              1,
              documentaryMaxSourceOpens,
            );
            if (!fallbackRenderReserved) {
              observations.add("DOCS_RENDER_SKIPPED_BUDGET");
              break;
            }
            spent.sourceOpens += 1;
            // A render is a browser navigation to the origin. It reserved,
            // so it attempts — and it used to emit no trace row at all, which
            // is how the one open that produced the only usable document in a
            // live run became invisible.
            await recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: "FETCH_ATTEMPTED",
              providerKind: "FETCH",
              providerName: "isolated-render",
              patternStep: item.step,
              component: item.component,
              targetRef: url,
              status: "OK",
            });
            try {
              const rendered = await resolveRenderedDocsFetcher().render(url, {
                confirmedHost: renderGate.confirmedHost,
                matchedPathPrefix: renderGate.matchedPathPrefix,
              });
              // No static text existed to fall short of — the transport
              // never delivered one. An absence, not a shortfall.
              rendered.staticTextLength = 0;
              fetchedDocs.push(rendered);
              observations.add("DOCS_RENDERED_AFTER_FETCH_FAILURE");
            } catch (e) {
              // Fail closed and stop. A failed render is never evidence
              // and never fails the attempt; it only says which stage
              // failed.
              observations.add(
                renderFailureObservation("DOCS_RENDER_AFTER_FETCH_FAILURE_FAILED", e),
              );
            }
            break;
          }
          if (!fetchResult.ok && fbTried.size > 1) {
            continue; // the shared chain ran and ended — next candidate
          }
        }
        if (!fetchResult.ok) {
          // RENDER ON REFUSAL.
          //
          // Rendering used to be reachable only as an upgrade to a fetch
          // that had already succeeded, which left a page that refuses
          // ordinary clients permanently unreadable — the renderer exists
          // for exactly that page and could never be asked.
          //
          // This is the same renderer, the same route gates, the same
          // host and prefix, and the same one-navigation isolated child
          // process. What differs is only that no document exists to
          // measure, so the static-shortfall test is replaced by a
          // narrow, code-owned set of refusal statuses. A blocked
          // address, a DNS failure, a timeout or a malformed URL carries
          // no status at all and cannot reach here.
          const refusal = evaluateRefusalRenderEligibility({
            url,
            route: preFetchRoute,
            rendererEnabled: renderedDocsEnabled() && renderedDocsAvailable(),
            httpStatus: fetchResult.fetchFailure?.httpStatus ?? null,
          });
          if (refusal.eligible) {
            // Its own reservation, exactly like the upgrade path. The
            // refused static request spent nothing, and no ceiling moves.
            const refusalReserved = await reserveJobBudget(
              deps.db,
              ctx.jobId,
              "sourceOpens",
              1,
              documentaryMaxSourceOpens,
            );
            if (refusalReserved) {
              spent.sourceOpens += 1;
              // Same rule as the two above: reserved, so it attempts, so the
              // trace says so before the navigation.
              await recordTraceEvent(deps.db, {
                researchJobId: ctx.jobId,
                researchAttemptId: attemptId,
                operationType: "FETCH_ATTEMPTED",
                providerKind: "FETCH",
                providerName: "isolated-render",
                patternStep: item.step,
                component: item.component,
                targetRef: url,
                status: "OK",
              });
              try {
                const rendered = await resolveRenderedDocsFetcher().render(url, {
                  confirmedHost: refusal.confirmedHost,
                  matchedPathPrefix: refusal.matchedPathPrefix,
                });
                // Honest provenance: the static request was refused, so
                // there was no static text — not a shortfall, an absence.
                rendered.staticTextLength = 0;
                fetchedDocs.push(rendered);
                observations.add("DOCS_RENDERED_AFTER_REFUSAL");
                continue;
              } catch (e) {
                // Fail closed and stop. One attempt, no retry — a failed
                // render is never evidence and never fails the attempt.
                // It does, however, say which stage failed.
                observations.add(
                  renderFailureObservation("DOCS_RENDER_AFTER_REFUSAL_FAILED", e),
                );
              }
            } else {
              observations.add("DOCS_RENDER_SKIPPED_BUDGET");
            }
          }
          continue; // typed/unexpected fetch failure — try the next candidate
        }
        // Bounded, safe-to-persist observability: WHICH payload kinds were
        // recovered and that recovery happened at all — never the text.
        // Without this, a document's text could silently have two very
        // different provenances with no way to tell them apart later.
        const recovered = fetchResult.value.embeddedPayload;
        if (recovered) {
          observations.add(`DOCS_PAYLOAD_RECOVERED:${recovered.kinds.join("+")}`);
        }
        let acquiredDoc = fetchResult.value;
        if (fetchMetered) spent.sourceOpens += 1;

        // --- Stage 1: rendered docs -------------------------------------
        // Static-first, always. Rendering runs only when the STATIC
        // extraction (before Stage 0 recovery) shows an SPA shell on a
        // confirmed, path-scoped OFFICIAL_DOCS page. Judging this on the
        // Stage 0 merged text would suppress rendering on exactly the
        // pages that need it — a measured page produced 134 static chars
        // and 57,640 recovered chars of CSS tokens and React internals.
        const eligibility = evaluateRenderEligibility({
          url: acquiredDoc.finalUrl,
          route: preFetchRoute,
          staticHtmlBytes: acquiredDoc.byteLength,
          staticTextLength: acquiredDoc.staticTextLength ?? acquiredDoc.normalizedText.length,
          rendererEnabled: renderedDocsEnabled() && renderedDocsAvailable(),
        });
        if (eligibility.eligible) {
          // A render is its own bounded external action, so it takes its
          // own reservation. The static fetch above keeps the one it
          // already spent; no ceiling is raised.
          const renderReserved = await reserveJobBudget(
            deps.db,
            ctx.jobId,
            "sourceOpens",
            1,
            documentaryMaxSourceOpens,
          );
          if (renderReserved) {
            spent.sourceOpens += 1;
            // The static fetch already has its own attempt row and keeps the
            // open it spent; this is a SECOND external action with a second
            // reservation, so it gets its own row rather than being folded
            // into the fetch that justified it.
            await recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: "FETCH_ATTEMPTED",
              providerKind: "FETCH",
              providerName: "isolated-render",
              patternStep: item.step,
              component: item.component,
              targetRef: acquiredDoc.finalUrl,
              status: "OK",
            });
            try {
              const rendered = await resolveRenderedDocsFetcher().render(acquiredDoc.finalUrl, {
                confirmedHost: eligibility.confirmedHost,
                matchedPathPrefix: eligibility.matchedPathPrefix,
              });
              // The renderer does not know the static measurement that
              // justified it; the caller does, so it is stamped here.
              rendered.staticTextLength =
                acquiredDoc.staticTextLength ?? acquiredDoc.normalizedText.length;
              acquiredDoc = rendered;
              acquiredVia = "ISOLATED_RENDER";
              observations.add("DOCS_RENDERED");
            } catch (e) {
              // Fail closed: a failed render is never evidence, and never
              // fails the attempt — the static document stands as-is.
              // Same sanitizer as the refusal path: two ways in, one set
              // of gates, and now one way of saying what went wrong.
              observations.add(renderFailureObservation("DOCS_RENDER_FAILED", e));
            }
          } else {
            observations.add("DOCS_RENDER_SKIPPED_BUDGET");
          }
        }
        // SEAL WHAT WAS PAID FOR, so a later component meets it in storage
        // rather than at the origin. Same door the phased FETCH phase uses
        // (`persistAcquiredDocument`, PRODUCT_ACQUISITION): the seal is a
        // statement about the transport only — authority is recorded as
        // resolved on the final url, never granted, and extraction below
        // and in every later attempt re-resolves it live. A refused seal
        // (the size bound) or a storage error changes nothing about this
        // attempt: the document is extracted from memory as before, and the
        // next encounter simply pays for its own fetch.
        if (fetchMetered) {
          try {
            const sealRoute = await resolveSourceRoute(deps.db, deps.project.id, acquiredDoc.finalUrl);
            const sealed = await persistAcquiredDocument(deps.db, {
              projectId: deps.project.id,
              acquiringJobId: ctx.jobId,
              doc: acquiredDoc,
              route: sealRoute,
              renderMode: acquiredVia === "ISOLATED_RENDER" ? "RENDERED" : "STATIC",
              acquisitionStrategy: acquiredVia,
              admission: "PRODUCT_ACQUISITION",
            });
            if (!sealed.ok) observations.add(`ACQUIRED_DOCUMENT_NOT_SEALED:${sealed.refusal}`);
          } catch {
            observations.add("ACQUIRED_DOCUMENT_NOT_SEALED:STORE_ERROR");
          }
        }
        fetchedDocs.push(acquiredDoc);
      }
      if (fetchedDocs.length === 0 && sourceOpenExhaustion !== null) {
        // Nothing was opened before the axis was refused, so there is
        // nothing to read first: the denial is terminal exactly as it was
        // at the boundary.
        throw sourceOpenExhaustion;
      }
      if (fetchedDocs.length === 0) {
        // No source-open budget denial occurred (one would have thrown just
        // above) — reaching here with zero documents means every candidate
        // failed for a non-budget reason.
        // Folded into the SAME observation channel every other terminal
        // return here already uses. This path was the one exception, and
        // it is precisely the path a render-after-refusal ends on — so a
        // renderer failure was classified correctly and then had nowhere
        // to be said. For a run executed directly (owner tooling writes no
        // research_attempts row) this string is the only place it appears
        // at all. Everything appended is code-owned: the sanitized fetch
        // reason, plus observation codes this function itself authored.
        return {
          status: "FAILED",
          reason: withObservations(lastFetchFailureReason ?? "NO_SOURCE_COULD_BE_FETCHED"),
          spent,
        };
      }

      // --- 4. EvidenceExtractor ----------------------------------------------
      const evidenceExtractorCostMicro = calculateMaxAuthorizedCostMicro(evidenceExtractorProfile);
      const insertedEvidenceIds: string[] = [];
      let extractionFailures = 0;
      let nonOversizedExtractionFailures = 0;
      for (const doc of fetchedDocs) {
        // BLOCKER-2 (S10 closure, D-119): reserveAndCallWithRetry reserves
        // BEFORE every real extraction attempt, including a retry —
        // EXTRACT_ATTEMPTED fires once per real attempt via onAttempt.
        // D-153 — cleared before every call, so a rejection reported for an
        // earlier document can never be attributed to this one. Cleared
        // through a helper rather than inline, so the read below stays typed
        // as the report array instead of being narrowed to the null this
        // statement just wrote.
        clearRejectedFacts(usage);
        const extractOutcome = await reserveAndCallWithRetry({
          db: deps.db,
          jobId: ctx.jobId,
          budgetAxis: "modelCostMicro",
          reserveAmount: evidenceExtractorCostMicro,
          maxBudget: ctx.budget.maxModelCostMicro,
          label: "EVIDENCE_EXTRACTOR",
          capability: "EVIDENCE_EXTRACTOR",
          // Item 6 (S4 final acceptance fix): no input bounding — the
          // extractor is given the document text exactly as fetched. See
          // model-cost-profile.ts's module comment for why a chars/token
          // heuristic was removed rather than kept as a claimed guarantee.
          fn: () => evidenceExtractor.extract({ target, document: doc }),
          onAttempt: async () => {
            await recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: "EXTRACT_ATTEMPTED",
              providerKind: "EXTRACT",
              providerName: evidenceExtractor.name,
              patternStep: item.step,
              component: item.component,
              targetRef: doc.finalUrl,
              status: "OK",
              budgetAxis: "modelCostMicro",
              budgetAmount: evidenceExtractorCostMicro,
            });
          },
          // §8/D-120: same MODEL_CALL attempt-cardinality tightening as
          // QueryProposer above — one FAILED row for the transient
          // attempt-1 failure, distinct from the row written below for
          // the resolved (ok/fatal) attempt-2 outcome.
          onTransientRetry: async (firstAttemptError) => {
            await recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: "MODEL_CALL_ATTEMPTED",
              providerKind: "EXTRACT",
              providerName: evidenceExtractor.name,
              patternStep: item.step,
              component: item.component,
              targetRef: doc.finalUrl,
              status: "FAILED",
              reasonCode: classifyTraceReasonCode(firstAttemptError),
              budgetAxis: "modelCostMicro",
              budgetAmount: evidenceExtractorCostMicro,
              // The typed WHY of the failed first attempt (e.g.
              // NETWORK_NO_RESPONSE, RATE_LIMITED:429), on the row itself.
              // The live run 06ade56b persisted two FAILED attempt rows
              // that said only PROVIDER_ERROR while the class sat in the
              // thrown message — this is the proven gap.
              diagnosticCode: extractorDiagnosticCode(safeFailureDetail(firstAttemptError)),
            });
          },
        });
        spent.authorizedModelCostMicro += extractOutcome.attempts * evidenceExtractorCostMicro;

        if (extractOutcome.kind === "budget_exhausted") {
          // HIGH-1 (S10 LAST HIGH CLOSURE, D-121): throw AT the denial
          // boundary, regardless of whether an earlier document in this
          // same loop already produced admitted Evidence — a non-empty
          // partial result is not proof the planned extraction work was
          // complete. Evidence already inserted for prior documents
          // stays persisted (never deleted); only the terminal execution
          // outcome for THIS attempt changes from "succeeded" to
          // "budget-constrained", honestly.
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "CANDIDATE_SKIPPED_BUDGET",
            patternStep: item.step,
            component: item.component,
            targetRef: doc.finalUrl,
            status: "SKIPPED",
            reasonCode: extractOutcome.reasonCode ?? "MODEL_COST_BUDGET_EXHAUSTED",
            budgetAxis: "modelCostMicro",
            budgetAmount: extractOutcome.attempts * evidenceExtractorCostMicro,
          });
          throw new BudgetExhaustedError("modelCostMicro", extractOutcome.reason ?? "MODEL_COST_BUDGET_EXHAUSTED");
        }
        // The document-local failure record, shared by a non-transient
        // ("local") outcome and — new — by a document whose generation
        // call exhausted the transient retry. One writer, so both paths
        // persist the same row shape and the same typed diagnostic_code,
        // and both count toward the attempt's own FAILED /
        // EVIDENCE_EXTRACTOR_UNAVAILABLE resolution below.
        const recordDocumentExtractionFailure = async (outcome: {
          reasonCode?: RetryOutcome<unknown>["reasonCode"];
          detail?: string | null;
        }): Promise<void> => {
          extractionFailures += 1;
          // S10 acceptance closure (BLOCKER-1, D-119, "IMPORTANT OVERSIZED
          // INPUT RULE"): an oversized source is a local operational skip,
          // never evidence of the extractor being unavailable — a batch
          // where every failure is MODEL_INPUT_OVERSIZED must resolve to
          // SKIPPED below, not FAILED/EVIDENCE_EXTRACTOR_UNAVAILABLE.
          if (outcome.reasonCode !== "MODEL_INPUT_OVERSIZED") nonOversizedExtractionFailures += 1;
          // Generation-side closed diagnostic (BACKLOG: "Generation-side
          // extractor failures lose their class"): when the failure
          // carries a closed, membership-gated detail, say it in the
          // observation channel — the same channel DOCS_RENDER_FAILED
          // already uses. Without this, every non-transient generation
          // failure collapses to the bare EVIDENCE_EXTRACTOR_UNAVAILABLE
          // terminal line while the classified WHY is dropped. A failure
          // with no closed detail adds nothing — never a guessed class.
          if (outcome.detail) observations.add(`EXTRACT_FAILED:${outcome.detail}`);
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            // S10 (D-090 count-then-gate, §5/§17): reasonCode now
            // distinguishes MODEL_INPUT_OVERSIZED/TOKEN_COUNT_UNAVAILABLE
            // from the generic PROVIDER_ERROR catch-all — previously
            // hardcoded to PROVIDER_ERROR for every EXTRACT_FAILED.
            operationType: "EXTRACT_FAILED",
            providerKind: "EXTRACT",
            providerName: evidenceExtractor.name,
            patternStep: item.step,
            component: item.component,
            targetRef: doc.finalUrl,
            status: "FAILED",
            reasonCode: outcome.reasonCode ?? "PROVIDER_ERROR",
            // THE CLASSIFIED WHY, ON THE ROW ITSELF.
            //
            // The observation added just above says the same thing, and on
            // the D3 flow it is lost: source opens are exhausted, the
            // documents already paid for are extracted here, and the SAME
            // budget error is then thrown — so this attempt returns no
            // result and its observation string is never persisted
            // anywhere. The live run that proved D3 works ended with
            // exactly that shape and recorded only PROVIDER_ERROR.
            //
            // The trace row is written before any of that, in its own
            // committed transaction, so the diagnostic survives the throw.
            // `detail` is already the product of safeFailureDetail's two
            // gates; this narrows it to the persistable vocabulary, and
            // recordTraceEvent re-checks membership independently. A
            // failure with no closed detail persists null — never a guess.
            diagnosticCode: extractorDiagnosticCode(outcome.detail),
          });
        };

        if (extractOutcome.kind === "fatal") {
          // §8/D-120: budgetAmount covers only THIS (final, still-failing)
          // attempt — a prior transient attempt-1 failure already has its
          // own row from onTransientRetry above. The typed WHY is on this
          // row too, for the same reason it is on that one.
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "MODEL_CALL_ATTEMPTED",
            providerKind: "EXTRACT",
            providerName: evidenceExtractor.name,
            patternStep: item.step,
            component: item.component,
            targetRef: doc.finalUrl,
            status: "FAILED",
            reasonCode: "PROVIDER_ERROR",
            budgetAxis: "modelCostMicro",
            budgetAmount: evidenceExtractorCostMicro,
            diagnosticCode: extractorDiagnosticCode(extractOutcome.detail),
          });
          const transientCause =
            extractOutcome.fatalCause === "TRANSIENT_RETRY_EXHAUSTED" ||
            extractOutcome.fatalCause === "TOKEN_COUNT_TRANSIENT_RETRY_EXHAUSTED";
          if (!transientCause) {
            // BLOCKER-1, unchanged: a PERMANENT count_tokens failure
            // (auth/config/request/unknown — not retried, not transient)
            // is proven capability unavailability — throw, never return an
            // ordinary FAILED/SKIPPED result (see the QueryProposer section
            // above for the full propagation note).
            throw new CapabilityFatalError(extractOutcome.capability!, extractOutcome.reason);
          }
          // TRANSIENT_RETRY_EXHAUSTED / TOKEN_COUNT_TRANSIENT_RETRY_EXHAUSTED
          // — the caller-decided case. This document's generation call, or
          // its count_tokens call, failed transiently twice (its allowance;
          // no third call is ever made). It is recorded as the same
          // document-local EXTRACT_FAILED a non-transient failure gets,
          // with the same typed diagnostic_code (and, for count_tokens, the
          // TOKEN_COUNT_UNAVAILABLE reason code the row already
          // distinguishes), it produces no Evidence and no contradiction,
          // and the attempt moves to the next document. Should nothing
          // else in the attempt survive, the existing resolution below
          // yields FAILED / EVIDENCE_EXTRACTOR_UNAVAILABLE — a fact about
          // the run, never about the project. Only when this is the SECOND
          // consecutive such document (no successful extraction since the
          // first) is it the capability-wide signal, thrown exactly as
          // before.
          await recordDocumentExtractionFailure({
            reasonCode: extractOutcome.fatalCause === "TOKEN_COUNT_TRANSIENT_RETRY_EXHAUSTED" ? "TOKEN_COUNT_UNAVAILABLE" : "PROVIDER_ERROR",
            detail: extractOutcome.detail,
          });
          consecutiveTransientlyFailedDocuments += 1;
          if (consecutiveTransientlyFailedDocuments >= CONSECUTIVE_TRANSIENT_DOCUMENTS_FATAL_THRESHOLD) {
            throw new CapabilityFatalError(extractOutcome.capability!, extractOutcome.reason);
          }
          continue;
        }
        if (extractOutcome.kind === "local") {
          await recordDocumentExtractionFailure(extractOutcome);
          continue;
        }
        // "ok" — the extractor answered: whatever happened to earlier
        // documents, the capability is reachable now.
        consecutiveTransientlyFailedDocuments = 0;
        const facts: ExtractedFact[] = extractOutcome.value!;
        // D-153 — a fact the canonical schema could not read is dropped
        // alone; its valid siblings in the same response survive. What is
        // recorded is the closed, code-owned schema field that rejected it
        // and this code's own position counter — never the model's text and
        // never the rejected value. The observation lands on the attempt,
        // which already carries the step and component this happened under.
        for (const r of usage.rejectedFacts ?? []) {
          observations.add(`FACT_SCHEMA_REJECTED:${r.field}:${r.index}`);
        }
        // S10 (§7) — audit-only actual usage/cost for THIS document's
        // extraction call, priced with the SAME approved profile that
        // sized the reservation above. Captured immediately after this
        // call (not before the per-document loop) since evidenceExtractor
        // is resolved once per attempt but called once per document —
        // the onUsage callback overwrites usage.evidenceExtractor on
        // every call, so it must be read fresh for each document. MEDIUM-1
        // (D-119): exactly ONE MODEL_CALL_ATTEMPTED row per document's
        // successful call — EXTRACT_OK (below, per admitted fact) never
        // carries usage, avoiding the N-rows-overstate-cost defect.
        const evidenceExtractorUsage = usage.evidenceExtractor;
        const evidenceExtractorActualCostMicro =
          evidenceExtractorUsage && !evidenceExtractorUsage.unsupportedBillingUsage
            ? calculateActualCostMicro(evidenceExtractorProfile, evidenceExtractorUsage)
            : null;
        await recordTraceEvent(deps.db, {
          researchJobId: ctx.jobId,
          researchAttemptId: attemptId,
          operationType: "MODEL_CALL_ATTEMPTED",
          providerKind: "EXTRACT",
          providerName: evidenceExtractor.name,
          patternStep: item.step,
          component: item.component,
          targetRef: doc.finalUrl,
          status: "OK",
          // MEDIUM-2: never invent a price for a billable usage category
          // the approved profile can't safely price.
          reasonCode: evidenceExtractorUsage?.unsupportedBillingUsage ? "UNSUPPORTED_BILLING_USAGE" : "NONE",
          budgetAxis: "modelCostMicro",
          // §8/D-120: this row covers only THIS (successful) attempt's
          // cost — a prior transient attempt-1 failure, if any, already
          // has its own row from onTransientRetry above.
          budgetAmount: evidenceExtractorCostMicro,
          actualInputTokens: evidenceExtractorUsage?.inputTokens ?? null,
          actualOutputTokens: evidenceExtractorUsage?.outputTokens ?? null,
          actualCostMicro: evidenceExtractorActualCostMicro,
        });

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
        if (!projectContained) {
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "REJECTED_WRONG_PROJECT",
            patternStep: item.step,
            component: item.component,
            targetRef: doc.finalUrl,
            status: "SKIPPED",
            reasonCode: "WRONG_PROJECT",
            sourceId: sourceInfo.id,
          });
          continue; // wrong-project document — never persisted, regardless of what the extractor claims
        }

        // D-089/§7.2a: exact locked precedence — routeClass only supplies
        // the class at step 6, after every public/project-independent
        // class (and every shared multi-tenant platform base domain) has
        // had a chance to positively recognize/exclude the domain.
        const sourceClass = resolveSourceClass(doc.finalUrl, sourceInfo.sourceType, route.routeClass);
        // D-134 (RISK 2) — computed once per document, exactly like
        // sourceClass/officiality above: whether this ONCHAIN_VERIFIABLE
        // URL is deterministically attributable to the project's
        // confirmed (chain, tokenAddress). null for every other class —
        // the axis simply does not apply. Never re-derived by S5; S5 only
        // ever reads this precomputed column, same discipline as
        // sourceClass/officiality.
        const entityBinding = computeEntityBinding(doc.finalUrl, sourceClass, plan.confirmedIdentity);

        // Evidence rows genuinely NEW from THIS document — the strict
        // eligibility input for the route-candidate observation below.
        let insertedForDocument = 0;
        for (const fact of facts) {
          // D-070/D-072 structural containment: a fact for any OTHER
          // step/component is not "extra scope generously offered" — it
          // is discarded outright. The model has no path from here to
          // the controller, the work queue, or any other component.
          if (fact.step !== target.step || fact.component !== target.component) {
            await recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: "REJECTED_WRONG_COMPONENT",
              patternStep: fact.step,
              component: fact.component,
              targetRef: doc.finalUrl,
              status: "SKIPPED",
              reasonCode: "WRONG_COMPONENT",
              sourceId: sourceInfo.id,
            });
            continue;
          }
          // §7/D-076/item 12.D: no traceable excerpt in the EXACT document
          // text the extractor was given -> not Evidence, regardless of
          // how confident the model sounds. A project name or a support
          // fragment that exists only OUTSIDE what the model actually saw
          // must never silently validate model Evidence.
          if (!isTraceable(doc.normalizedText, fact.supportFragment)) {
            await recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: "REJECTED_NOT_TRACEABLE",
              patternStep: fact.step,
              component: fact.component,
              targetRef: doc.finalUrl,
              status: "SKIPPED",
              reasonCode: "NOT_TRACEABLE",
              sourceId: sourceInfo.id,
            });
            continue;
          }

          // EXACT DOCUMENTARY LOCATOR. The model may PROPOSE a concrete
          // on-chain identifier; this is where the proposal is checked,
          // and the check — not the prompt — is what decides. A truncated
          // display form ("99mRw3…pm4F3c") is refused outright, because
          // the elided characters are not recoverable from it by any
          // means we would be willing to use. So is an incomplete shape,
          // and so is a value that does not appear literally in the exact
          // document text the extractor was given, which is what makes a
          // reconstructed identifier structurally impossible to admit.
          //
          // A refused locator NEVER costs the fact. The fact is still
          // ordinary documentary evidence and is admitted on its own
          // merits with the column left NULL: "the page says tokens go to
          // an address it displays as 99mRw3…pm4F3c" is true, useful, and
          // simply not a locator.
          //
          // ONE FACT MAY IDENTIFY SEVERAL ACCOUNTS, and every one of them
          // is validated INDEPENDENTLY: a bad entry never contaminates a
          // good one, and a good entry never launders a bad one. The
          // scalar proposal and the array are merged here so a model using
          // either shape reaches the same check.
          const locatorOutcome = validateFactLocators({
            claimed: [fact.onchainLocator, ...(fact.onchainLocators ?? [])],
            documentText: doc.normalizedText,
          });
          for (const refused of locatorOutcome.rejected) {
            await recordTraceEvent(deps.db, {
              researchJobId: ctx.jobId,
              researchAttemptId: attemptId,
              operationType: "LOCATOR_REJECTED",
              patternStep: fact.step,
              component: fact.component,
              targetRef: doc.finalUrl,
              status: "SKIPPED",
              reasonCode: LOCATOR_TRACE_REASON[refused.reason],
              sourceId: sourceInfo.id,
            });
          }

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
              entityBinding,
              // Never fact.onchainLocator — only the validator's own
              // output can reach this column. Now a COMPATIBILITY
              // PROJECTION of ordinal 0: every locator lives in
              // evidence_documentary_locators, and this column keeps
              // showing the first one so existing readers and historical
              // rows behave identically.
              documentaryLocator: locatorOutcome.confirmed[0]?.value ?? null,
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
          if (row) {
            insertedEvidenceIds.push(row.id);
            insertedForDocument += 1;
            // Written only when the Evidence row is genuinely NEW — a
            // replayed extraction unit returns no row, and re-inserting
            // its locators would be writing children for a fact this
            // attempt did not create.
            await persistFactLocators(deps.db, row.id, locatorOutcome.confirmed);
          }
          // §J item 18 — links trace to the resulting source/evidence ids
          // without making the trace table itself readable as Evidence
          // (no fragment/statement/provenance is copied here, only ids).
          await recordTraceEvent(deps.db, {
            researchJobId: ctx.jobId,
            researchAttemptId: attemptId,
            operationType: "EXTRACT_OK",
            providerKind: "EXTRACT",
            providerName: evidenceExtractor.name,
            patternStep: fact.step,
            component: fact.component,
            targetRef: doc.finalUrl,
            status: "OK",
            sourceId: sourceInfo.id,
            evidenceId: row?.id ?? null,
            // MEDIUM-1 (D-119): usage/cost lives on the ONE MODEL_CALL_ATTEMPTED
            // row for this document's call (above), never duplicated
            // across every admitted fact — summing actual_cost_micro
            // over MODEL_CALL_ATTEMPTED alone gives the true cost.
          });
        }

        // UNSEEN PROJECT AUTHORITY BOOTSTRAP V1 — observe, never trust.
        // This document passed containment and yielded Evidence this
        // project can see; if its host is one no code-owned list knows and
        // no human has confirmed (route resolved CLAIMED on finalUrl, the
        // same resolution the Evidence rows above were sealed with), record
        // the host as an OBSERVED route candidate for the owner to read.
        // The candidate confers nothing — sourceClass/officiality above are
        // already computed and persisted, and no authority consumer reads
        // OBSERVED — and it never costs the attempt: a bookkeeping failure
        // is an observation, not a research outcome.
        if (insertedForDocument > 0) {
          try {
            const candidate = await observeSourceRouteCandidate(deps.db, {
              projectId: deps.project.id,
              jobId: ctx.jobId,
              sourceId: sourceInfo.id,
              finalUrl: doc.finalUrl,
              component: item.component,
              evidenceCount: insertedForDocument,
              route,
            });
            if (candidate.outcome === "OBSERVED" || candidate.outcome === "UPDATED") {
              observations.add(`SOURCE_ROUTE_CANDIDATE_OBSERVED:${candidate.domain}`);
            } else if (candidate.reason === "CAP_REACHED") {
              observations.add("SOURCE_ROUTE_CANDIDATE_CAP_REACHED");
            }
          } catch (e) {
            console.error("[s4-executor] source route candidate observation failed", e);
            observations.add("SOURCE_ROUTE_CANDIDATE_WRITE_FAILED");
          }
        }
      }

      // D3 — THE PAID-FOR DOCUMENTS HAVE NOW BEEN READ. Every Evidence row
      // and every admitted locator they yielded is persisted above; the
      // attempt's terminal outcome is still the budget denial, exactly as
      // D-121 requires, so nothing after this point can mistake a
      // budget-constrained attempt for a completed one. The reconciliation
      // that runs after a job stops on budget already reads persisted
      // Evidence for a component whose attempt never reached a terminal
      // row (acquisitionStopped), so what was extracted here is counted.
      if (sourceOpenExhaustion !== null) throw sourceOpenExhaustion;

      if (insertedEvidenceIds.length > 0) {
        return {
          status: "SUCCEEDED",
          reason: withObservations(
            `extracted ${insertedEvidenceIds.length} evidence candidate(s) from ${fetchedDocs.length} document(s)`,
          ),
          spent,
        };
      }
      // A model-cost budget denial during extraction already threw above,
      // at the point of denial — reaching here means every document
      // either had zero admitted facts or failed for a non-budget reason.
      if (extractionFailures > 0 && extractionFailures === fetchedDocs.length && nonOversizedExtractionFailures > 0) {
        return { status: "FAILED", reason: withObservations("EVIDENCE_EXTRACTOR_UNAVAILABLE"), spent };
      }
      return { status: "SKIPPED", reason: withObservations("NO_TRACEABLE_FACTS_FOR_COMPONENT"), spent };
    },
  };
}
