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
  renderedTextLength: number;
  rawHtmlHash: string | null;
  blockedRequestCount: number;
  renderDurationMs: number;
}

export type RenderedDocsFailureReason =
  | "NAVIGATION_BLOCKED"
  | "FINAL_URL_OUTSIDE_ROUTE"
  | "HOST_NOT_ALLOWED"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "RENDER_FAILED"
  | "RENDERER_UNAVAILABLE";

// Carries a reason code only. A renderer error must never echo page
// content or a URL back into logs/trace.
export class RenderedDocsError extends Error {
  constructor(
    public readonly reason: RenderedDocsFailureReason,
    public readonly rendererName = "unknown",
  ) {
    super(`rendered docs retrieval failed (${reason}) via ${rendererName}`);
    this.name = "RenderedDocsError";
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
  navigationTimeoutMs: number;
  totalWallClockMs: number;
  maxRenderedTextLength: number;
  maxTotalResponseBytes: number;
  maxNavigations: number;
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  navigationTimeoutMs: 15_000,
  totalWallClockMs: 15_000,
  maxRenderedTextLength: 400_000,
  maxTotalResponseBytes: 8_000_000,
  // Exactly one. Not a budget to spend — a structural bound.
  maxNavigations: 1,
};

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
