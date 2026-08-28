import { isHttpStatusCode } from "./content-fetcher";
import {
  EGRESS_DENIAL_REASONS,
  type EgressDenialReason,
  type EgressDenialSummary,
} from "./render-egress-proxy";
import type { FetchedDocument } from "./types";

// Stage 1 — RenderedDocsFetcher.
//
// A SEPARATE provider role, deliberately not an extension of
// ContentFetcher. Every existing caller already holds a ContentFetcher
// reference — arbitrary search candidates, explorer URLs, anything the
// engine decides to open — so adding browser execution behind that
// interface would silently make JS rendering reachable from paths that
// must never have it. With a distinct role, "can this caller render?" is
// answerable by reading imports, and the answer is: only the one call site
// that first proved eligibility.
//
// This is DOCUMENT RENDERING, not browser automation. There is no click,
// no form fill, no login, no navigation beyond a single page load. The
// interface has no method that could express those, which is a stronger
// guarantee than a policy saying we won't.

export interface ConfirmedDocsRoute {
  // The human-confirmed domain this render is pinned to.
  confirmedHost: string;
  // The confirmed pathPrefix the requested url matched.
  matchedPathPrefix: string;
}

// Extends FetchedDocument so the rendered result flows through the
// existing extract -> persist -> S5 path with no downstream change.
// Rendering alters acquisition TRANSPORT only; admissibility is untouched.
export interface RenderedDocument extends FetchedDocument {
  renderMode: "RENDERED";
  rendererName: string;
  rendererVersion: string;
  browserVersion: string;
  confirmedRouteDomain: string;
  matchedPathPrefix: string;
  // The static extraction that justified rendering — kept so the
  // before/after pair is auditable rather than asserted.
  staticTextLength: number;
  // Length of the PAGE's own rendered text, excluding the recovered-link
  // appendix that normalizedText may carry. Kept separate so a link-heavy
  // shell cannot read as a page that rendered real prose.
  renderedTextLength: number;
  // Length of that appendix, 0 when the page had no recoverable link.
  // normalizedText.length is renderedTextLength + linkAppendixLength (+2
  // for the blank line) — stated as two figures rather than one so the
  // provenance of the text stays legible after the fact.
  linkAppendixLength?: number;
  rawHtmlHash: string | null;
  blockedRequestCount: number;
  renderDurationMs: number;
  // OBSERVATIONS ONLY, recovered from the settled DOM that plain-text
  // conversion discards. Carries no class, no officiality and no entity
  // binding: a link found on a confirmed page is still just a link until
  // the existing identity/provenance checks pass on their own terms.
  //
  // `heading`/`context` are the page's OWN words near the link — what the
  // page calls the thing it is pointing at. Page text is a claim, never a
  // verified fact, and reading it here changes nothing about that.
  documentLinks?: {
    links: {
      href: string;
      text: string;
      host: string | null;
      heading?: string | null;
      context?: string | null;
      // The exact identifier this anchor's truncated visible text
      // abbreviates, when exactly one candidate in the SAME element
      // agrees. Null on ambiguity — never a guess.
      resolvedIdentifier?: string | null;
    }[];
    identifiers: { attribute: string; value: string; shape: string }[];
    hosts: string[];
    truncated: boolean;
  } | null;
  // PASSIVE OBSERVATIONS of requests the browser already made while
  // rendering this one page. Null unless the caller explicitly opted in —
  // an ordinary evidentiary render records nothing.
  //
  // AUTHORITY: none. An observed URL is a URL the page asked for. It is not
  // OFFICIAL_DOCS, not evidence, not project identity, and not a mechanism;
  // nothing in this shape can express approval. Bodies are present only for
  // same-origin textual responses, bounded, and never adopted from a
  // cross-origin host.
  networkObservations?: {
    observations: {
      url: string;
      method: string;
      resourceType: string;
      status: number;
      contentType: string | null;
      contentLength: number | null;
      sameOrigin: boolean;
      body: string | null;
      bodyTruncated: boolean;
    }[];
    droppedCount: number;
    totalBodyBytes: number;
  } | null;
  // RECORDS recovered from the settled html's embedded payloads, for
  // needles the caller supplied. Null unless the caller opted in.
  //
  // AUTHORITY: none. Recovering a value from a page's embedded payload
  // says the page shipped that value — not that it is true, not that it
  // is documentation, and not that any identifier inside it is bound to
  // anything. Identifiers are reported per RECORD, so a value from an
  // unrelated record is never attached to this one.
  embeddedRecords?: {
    kinds: string[];
    recordsScanned: number;
    matches: {
      kind: string;
      scriptIndex: number;
      path: string;
      json: string;
      jsonTruncated: boolean;
      fields: string[];
      matchedNeedles: string[];
      identifiers: { field: string; value: string; shape: string }[];
    }[];
    truncated: boolean;
    // COVERAGE. Finding a payload source is not searching it — a zero-
    // match result is only a real negative when this says COMPLETE.
    coverage: {
      sourcesFound: number;
      sourcesTraversed: number;
      framesSeen: number;
      framesParsed: number;
      framesUnsupported: number;
      parseErrors: number;
      recordsScanned: number;
      coverage: "COMPLETE" | "PARTIAL" | "NONE";
    };
  } | null;
}

// THE CLOSED, CODE-AUTHORED REASON LIST.
//
// Declared as a runtime array and the type DERIVED from it, exactly as
// CONTENT_FETCH_FAILURE_REASONS is. A bare type union vanishes at compile
// time, and a sanitizer that must decide whether a runtime value is a
// member of a closed set needs the set to actually exist at runtime — a
// value crossing a process boundary can violate a compile-time union.
//
// ONE REASON PER STAGE THAT CAN INDEPENDENTLY FAIL, and no more. A render
// crosses four boundaries before a page becomes a document — network
// (the egress proxy), process (spawn, then exit), data (the output
// contract), and the render itself — and each one failing points at a
// different next action. Anything finer than that is taxonomy for its own
// sake; anything coarser is the defect this list exists to remove.
export const RENDERED_DOCS_FAILURE_REASONS = [
  // --- render stage: the page, the route, the limits -------------------
  "NAVIGATION_BLOCKED",
  "FINAL_URL_OUTSIDE_ROUTE",
  "HOST_NOT_ALLOWED",
  "TIMEOUT",
  "TOO_LARGE",
  // The navigation completed and the server answered with a non-success
  // status. A BROWSER DOES NOT THROW ON 403: it receives the refusal page
  // and renders it, so without this the renderer would hand a server's
  // "access denied" HTML to extraction as though it were the document.
  // Carries the trusted numeric status.
  "HTTP_ERROR",
  // The navigation produced no Response at all, so no status could be
  // checked. Fail closed: unverifiable is not the same as fine, and it is
  // a different statement from the server having refused us.
  "NO_NAVIGATION_RESPONSE",
  // The navigation THREW — it never completed, so there was never a
  // response to have a status. Its own stage, because everything before it
  // (the browser started, the route passed pre-flight) worked and
  // everything after it (status, final url, text) never happened.
  // Carries a NavigationDiagnostic saying which kind.
  "NAVIGATION_FAILED",
  // The navigation SUCCEEDED — a real response, a permitted status, a url
  // still inside the route — and the document never became readable
  // before the document budget ran out. Its own stage because it makes the
  // opposite statement to NAVIGATION_FAILED: the page answered, and what
  // it served never stopped looking like an unfilled shell. Conflating the
  // two would tell an operator to investigate the network when the honest
  // finding is about the document.
  "DOCUMENT_NOT_READY",
  // The browser itself could not be started: the module is absent, the
  // binary is missing, or the launch was refused. Distinct from every
  // page-level failure because the site is not implicated at all.
  "BROWSER_LAUNCH_FAILED",
  // The render stage failed for a reason the renderer does not classify.
  // Genuinely unknown — never a stand-in for one of the above.
  "RENDER_FAILED",
  // --- supervisor stages: reachable only in the parent -----------------
  // The deny-by-default egress boundary could not be established, so no
  // child was ever spawned. Local, and the site is not implicated.
  "EGRESS_PROXY_UNAVAILABLE",
  // The child process could not be started at all.
  "CHILD_SPAWN_FAILED",
  // The child started and died without emitting a usable envelope.
  "CHILD_EXIT_NONZERO",
  // The child answered, and the answer did not satisfy the data contract.
  "CHILD_OUTPUT_MALFORMED",
  // No renderer is installed in this deployment.
  "RENDERER_UNAVAILABLE",
] as const;

export type RenderedDocsFailureReason = (typeof RENDERED_DOCS_FAILURE_REASONS)[number];

const RENDERED_DOCS_FAILURE_REASON_SET: ReadonlySet<string> = new Set<string>(
  RENDERED_DOCS_FAILURE_REASONS,
);

// The runtime gate. `unknown` in, and membership of the closed list is the
// only way out — no duck typing, no prefix match, no normalisation.
export function isRenderedDocsFailureReason(v: unknown): v is RenderedDocsFailureReason {
  return typeof v === "string" && RENDERED_DOCS_FAILURE_REASON_SET.has(v);
}

// WHAT THE CHILD IS ALLOWED TO SAY ABOUT ITSELF.
//
// The child renders; it does not supervise. It cannot have observed a
// proxy that failed before it existed, a spawn that failed to produce it,
// its own non-zero exit, or its own malformed output — so a child claiming
// any of those is not reporting, it is contradicting the parent's own
// observation. Such an envelope is malformed output, not a reason.
//
// This is a fidelity gate, not a security one: every value here is
// code-owned either way. It keeps the stage a reason names honest.
export const CHILD_REPORTABLE_RENDER_REASONS: ReadonlySet<string> = new Set<string>([
  "NAVIGATION_BLOCKED",
  "FINAL_URL_OUTSIDE_ROUTE",
  "HOST_NOT_ALLOWED",
  "TIMEOUT",
  "TOO_LARGE",
  "HTTP_ERROR",
  "NO_NAVIGATION_RESPONSE",
  "NAVIGATION_FAILED",
  "DOCUMENT_NOT_READY",
  "BROWSER_LAUNCH_FAILED",
  "RENDER_FAILED",
] satisfies RenderedDocsFailureReason[]);

// WHY A NAVIGATION NEVER COMPLETED, as a closed code-owned set.
//
// `page.goto` throwing collapsed three materially different situations
// into one word, and they call for opposite next actions: wait longer,
// confirm a different host, or do nothing at all. A live window that comes
// back unable to say which buys one bit of information at full price.
//
// EVERY VALUE HERE RESTS ON A LOCAL SIGNAL WE ACTUALLY HOLD. Nothing is
// inferred from the shape of a generic failure, and nothing is parsed out
// of an exception message.
export const NAVIGATION_DIAGNOSTICS = [
  // Playwright's own typed timeout. `errors.TimeoutError` sets
  // `name === "TimeoutError"`, verified against the installed package —
  // an exact comparison against a code-owned constant, not a message
  // search.
  "NAVIGATION_TIMEOUT",
  // OUR OWN containment aborted the main-frame navigation. Recorded by the
  // route handler at the moment it calls abort(), never inferred: the
  // request must have been a navigation request belonging to the page's
  // main frame. A cross-host redirect is the case this exists for, and it
  // is a statement about what THIS code did, not a guess about the site.
  "BLOCKED_BY_ROUTE_POLICY",
  // The navigation failed some other way — a reset, a TLS failure, an
  // empty response. Chromium's `net::ERR_*` code lives only inside the
  // exception message, and messages are provider-influenced text, so it is
  // deliberately NOT parsed. By elimination this value still separates the
  // transport case from the two above.
  "UNCLASSIFIED_NAVIGATION_ERROR",
] as const;

export type NavigationDiagnostic = (typeof NAVIGATION_DIAGNOSTICS)[number];

const NAVIGATION_DIAGNOSTIC_SET: ReadonlySet<string> = new Set<string>(NAVIGATION_DIAGNOSTICS);

export function isNavigationDiagnostic(v: unknown): v is NavigationDiagnostic {
  return typeof v === "string" && NAVIGATION_DIAGNOSTIC_SET.has(v);
}

// The name Playwright gives its typed timeout. Kept as a named constant so
// the comparison is against something this repository owns and a test can
// assert it still matches the installed package.
export const PLAYWRIGHT_TIMEOUT_ERROR_NAME = "TimeoutError";

// The one place a navigation failure is classified. `blockedMainFrameNav`
// is OUR OWN observation, passed in by the caller that made it — the
// classifier never guesses at containment from the exception.
export function classifyNavigationFailure(
  e: unknown,
  blockedMainFrameNav: boolean,
): NavigationDiagnostic {
  // Our own action outranks the browser's report of it: when containment
  // aborted the navigation, the exception is merely the consequence.
  if (blockedMainFrameNav) return "BLOCKED_BY_ROUTE_POLICY";
  if (e instanceof Error && e.name === PLAYWRIGHT_TIMEOUT_ERROR_NAME) return "NAVIGATION_TIMEOUT";
  return "UNCLASSIFIED_NAVIGATION_ERROR";
}

// WHY A BROWSER DID NOT START, as a closed code-owned set.
//
// BROWSER_LAUNCH_FAILED says the browser never started, which is already
// the difference between a local fault and a site that defeated us. It
// does not say WHICH local fault, and the launch error that would say so
// cannot be shown: every real one observed while building this carried
// either an absolute filesystem path or Chromium's ENTIRE command line —
// roughly two kilobytes of local configuration — inside its message.
//
// So the message is read once, matched against fixed code-authored
// substrings, reduced to one of these, and dropped.
//
// EVERY ENTRY BELOW WAS OBSERVED, offline, by inducing the failure and
// reading what Playwright actually produced. Nothing here is guessed from
// documentation, and candidates that could not be induced on this platform
// were deliberately left out rather than added speculatively:
// a permission-denied spawn, a profile/temp-directory failure (Chromium
// launches fine with TEMP pointed at a non-existent path), and Linux's
// missing-shared-library case.
export const BROWSER_LAUNCH_DIAGNOSTICS = [
  // Observed: "browserType.launch: Executable doesn't exist at <path>",
  // by pointing PLAYWRIGHT_BROWSERS_PATH at an empty directory. The
  // install is absent or is a revision this Playwright does not expect.
  "EXECUTABLE_NOT_FOUND",
  // Observed: "browserType.launch: spawn UNKNOWN", by putting a file that
  // is not an executable where the browser belongs. The OS refused to
  // start the process at all — also the shape a security product blocking
  // the binary would take.
  "PROCESS_START_FAILED",
  // Observed: "browserType.launch: Target page, context or browser has
  // been closed" with a "Browser logs:" section, by substituting a real
  // executable that exits immediately. The process started and died
  // before it could speak the debugging protocol.
  "PROCESS_EXITED_DURING_LAUNCH",
  // Anything else. Never a guess dressed up as a finding.
  "UNKNOWN_BROWSER_LAUNCH_FAILURE",
] as const;

export type BrowserLaunchDiagnostic = (typeof BROWSER_LAUNCH_DIAGNOSTICS)[number];

const BROWSER_LAUNCH_DIAGNOSTIC_SET: ReadonlySet<string> = new Set<string>(
  BROWSER_LAUNCH_DIAGNOSTICS,
);

export function isBrowserLaunchDiagnostic(v: unknown): v is BrowserLaunchDiagnostic {
  return typeof v === "string" && BROWSER_LAUNCH_DIAGNOSTIC_SET.has(v);
}

// The one place a provider-controlled string is read, and nothing but a
// member of the set above ever comes back out. The input is never stored,
// never returned, never logged and never re-thrown.
export function classifyBrowserLaunchFailure(e: unknown): BrowserLaunchDiagnostic {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (text.includes("Executable doesn't exist")) return "EXECUTABLE_NOT_FOUND";
  // Node surfaces every OS-level start refusal as "spawn <ERRNO>", and the
  // errno set includes digits (E2BIG). Only "spawn UNKNOWN" was observed
  // here; the family is generalised because the SHAPE is Node's, not
  // because other errnos were guessed at — every one of them means the
  // same thing, that the process was never started.
  if (/\bspawn [A-Z][A-Z0-9]*\b/.test(text)) return "PROCESS_START_FAILED";
  if (
    text.includes("Target page, context or browser has been closed") ||
    text.includes("browser has disconnected")
  ) {
    return "PROCESS_EXITED_DURING_LAUNCH";
  }
  return "UNKNOWN_BROWSER_LAUNCH_FAILURE";
}

// REBUILT, never adopted. The summary is re-derived key by key from the
// closed reason list and coerced to non-negative integers, so an object
// arriving with a `target`, a hostname or any other extra field yields a
// summary that structurally cannot contain it.
function sanitizeProxyDenials(v: EgressDenialSummary | null): EgressDenialSummary | null {
  if (v === null || typeof v !== "object") return null;
  const src = (v as { denials?: unknown }).denials;
  const counts = (src ?? {}) as Record<string, unknown>;
  const int = (n: unknown): number =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  const denials = Object.fromEntries(
    EGRESS_DENIAL_REASONS.map((r) => [r, int(counts[r])]),
  ) as Record<EgressDenialReason, number>;
  return {
    denials,
    deniedCount: int((v as { deniedCount?: unknown }).deniedCount),
    allowedCount: int((v as { allowedCount?: unknown }).allowedCount),
    distinctDenialClasses: EGRESS_DENIAL_REASONS.filter((r) => denials[r] > 0).length,
  };
}

// Carries a reason code only. A renderer error must never echo page
// content or a URL back into logs/trace.
export class RenderedDocsError extends Error {
  // Present only for BROWSER_LAUNCH_FAILED, and only ever a member of the
  // closed set above.
  readonly diagnostic: BrowserLaunchDiagnostic | null;

  // Present only for HTTP_ERROR. TRUSTED NUMERIC ONLY: it comes from
  // Playwright's navigation `Response.status()`, exactly as the static
  // path takes its own from the fetch Response — never parsed out of a
  // message, a title, a body or any markup. A number cannot carry a URL,
  // a header or a page, whatever the server sent.
  readonly httpStatus: number | null;

  // Present only for NAVIGATION_FAILED, and only ever a member of the
  // closed set above. Kept as its OWN field rather than widening
  // `diagnostic`: launch causes and navigation causes are separate
  // vocabularies, and merging them would let a value from one be reported
  // for a stage in the other.
  readonly navigationDiagnostic: NavigationDiagnostic | null;

  // COUNTS FROM THE EGRESS PROXY'S OWN LOG, and only counts. An
  // INDEPENDENT observation from the ones above, never a replacement:
  // what the browser reported and what our proxy decided are two
  // different witnesses, and the whole point is being able to read both.
  //
  // Rebuilt through the summarizer rather than trusted, so a caller
  // cannot attach an object with extra fields.
  readonly proxyDenials: EgressDenialSummary | null;

  constructor(
    public readonly reason: RenderedDocsFailureReason,
    public readonly rendererName = "unknown",
    diagnostic: BrowserLaunchDiagnostic | null = null,
    httpStatus: number | null = null,
    navigationDiagnostic: NavigationDiagnostic | null = null,
    proxyDenials: EgressDenialSummary | null = null,
  ) {
    super(`rendered docs retrieval failed (${reason}) via ${rendererName}`);
    this.name = "RenderedDocsError";
    // Re-checked here rather than trusted from the caller: this class is
    // the boundary, so it validates at its own edge.
    this.diagnostic = isBrowserLaunchDiagnostic(diagnostic) ? diagnostic : null;
    this.httpStatus = isHttpStatusCode(httpStatus) ? httpStatus : null;
    this.navigationDiagnostic = isNavigationDiagnostic(navigationDiagnostic)
      ? navigationDiagnostic
      : null;
    this.proxyDenials = sanitizeProxyDenials(proxyDenials);
  }

  // Attaches the proxy's counts to an already-classified failure. The
  // proxy is a PARENT-side boundary, so its log exists where the error is
  // caught rather than where it was raised — and the classification must
  // not change on the way through. Everything else is copied verbatim.
  withProxyDenials(summary: EgressDenialSummary | null): RenderedDocsError {
    return new RenderedDocsError(
      this.reason,
      this.rendererName,
      this.diagnostic,
      this.httpStatus,
      this.navigationDiagnostic,
      summary,
    );
  }
}

export interface RenderedDocsFetcher {
  readonly name: string;
  readonly version: string;
  // `route` is REQUIRED and typed: there is no signature accepting a bare
  // URL, so a caller structurally cannot ask this to render something
  // unconfirmed.
  render(url: string, route: ConfirmedDocsRoute): Promise<RenderedDocument>;
}

// ---- hard resource limits (code-owned) --------------------------------
export interface RenderLimits {
  // BROWSER STARTUP is its own phase with its own budget, separate from
  // the document work that follows it. Before this existed, launch was
  // measured against totalWallClockMs, so starting the browser spent the
  // navigation's allowance and a COMPLETED navigation could be discarded
  // as TIMEOUT. The two phases now have two budgets.
  browserLaunchTimeoutMs: number;
  navigationTimeoutMs: number;
  // The DOCUMENT phase: measured from the moment the browser is up, never
  // from before it. Bounds context creation, the navigation, AND the
  // bounded wait for the document to become readable.
  totalWallClockMs: number;
  // How often the rendered document is re-sampled while waiting for it to
  // become usable. A sampling interval, never a sleep that stands in for
  // readiness: the wait ends the moment the document passes the predicate,
  // and the document budget above is what ends it if it never does.
  documentReadinessPollMs: number;
  maxRenderedTextLength: number;
  maxTotalResponseBytes: number;
  maxNavigations: number;
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  // A bound where the code previously had none of its own: launch was
  // called with no timeout at all, deferring to Playwright's undeclared
  // 30s default. This is TIGHTER than that default, so it constrains
  // rather than relaxes — it is not a grace period.
  //
  // Sized from a measurement, not a guess: `scripts/renderer-selftest.ts`
  // — launch, context, about:blank, close — took 7,095 ms on the
  // development machine. A startup bound near that would fail healthy
  // cold starts on a loaded host, so this is roughly 2.8x the observed
  // probe and still well under the driver's own default.
  browserLaunchTimeoutMs: 20_000,
  navigationTimeoutMs: 15_000,
  totalWallClockMs: 15_000,
  documentReadinessPollMs: 250,
  maxRenderedTextLength: 400_000,
  maxTotalResponseBytes: 8_000_000,
  // Exactly one. Not a budget to spend — a structural bound.
  maxNavigations: 1,
};

// What the PARENT allows on top of the child's own two phase budgets:
// process spawn, module load, and the JSON envelope's round trip. It
// covers supervision overhead only — never a phase of the render, and
// never a margin for a phase that overran its own budget.
export const ISOLATION_ENVELOPE_ALLOWANCE_MS = 5_000;

// THE PARENT'S DEADLINE, derived rather than chosen.
//
// The supervisor must not kill a child that is still legitimately inside
// its permitted phases, so its deadline is the sum of every budget the
// child may lawfully spend plus the isolation allowance above. Expressed
// as a function so the relationship is asserted by a test instead of
// living as an arithmetic literal that drifts when a phase budget changes.
export function isolatedChildDeadlineMs(limits: RenderLimits): number {
  return limits.browserLaunchTimeoutMs + limits.totalWallClockMs + ISOLATION_ENVELOPE_ALLOWANCE_MS;
}

// ---- browser lockdown, expressed as inspectable DATA ------------------
//
// Kept as a plain object rather than scattered through adapter code so a
// test can assert the posture directly, and so a future reviewer can read
// the entire security stance in one place instead of auditing call sites.
export const BROWSER_LOCKDOWN = {
  headless: true,
  javaScriptEnabled: true, // the whole point; everything else is off
  // No user state, ever.
  acceptDownloads: false,
  storageState: undefined,
  ignoreHTTPSErrors: false,
  bypassCSP: false,
  // No device capabilities.
  permissions: [] as string[],
  geolocation: undefined,
  serviceWorkers: "block" as const,
  offline: false,
  // No extensions, no automation surface beyond a single goto.
  chromiumArgs: [
    "--disable-extensions",
    "--disable-plugins",
    "--disable-background-networking",
    "--disable-sync",
    "--no-first-run",
    "--disable-default-apps",
    "--disable-features=WebRTC,WebRtcHideLocalIpsWithMdns",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
  ],
  // Capabilities this role must never have. Asserted by test; the
  // interface above provides no method to invoke any of them.
  forbiddenCapabilities: [
    "click",
    "fill",
    "type",
    "login",
    "cookies",
    "download",
    "popup",
    "newTab",
    "fileAccess",
    "scriptInjection",
    "extensions",
    "webrtc",
    "serviceWorker",
    "geolocation",
    "camera",
    "microphone",
    "clipboard",
    "retry",
  ],
} as const;

// ---- resolver ---------------------------------------------------------

let _override: RenderedDocsFetcher | null = null;

// Test-only. There is no production fake branch.
export function __setRenderedDocsFetcher(f: RenderedDocsFetcher | null): void {
  _override = f;
}

// Server-side switch. Absent => the capability does not exist in this
// deployment, and the engine simply keeps whatever the static path found.
export function renderedDocsEnabled(): boolean {
  return _override !== null || process.env.RENDERED_DOCS_ENABLED === "1";
}

export function resolveRenderedDocsFetcher(): RenderedDocsFetcher {
  if (_override) return _override;
  throw new RenderedDocsError("RENDERER_UNAVAILABLE");
}

export function renderedDocsAvailable(): boolean {
  return _override !== null;
}
