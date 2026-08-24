import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isBlockedIp } from "./providers/content-fetcher";
import type { ResolvedSourceRoute } from "./source-authority";

// Stage 1 — the POLICY half of rendered docs retrieval.
//
// Everything here is pure (or DNS-only) and therefore fully testable
// offline. The Playwright adapter contains as little judgement as
// possible: it launches a locked-down browser and asks these functions
// what is allowed. Keeping the decisions here is what makes "would this
// URL be blocked?" answerable by a unit test rather than by running a
// browser.
//
// Every rule fails closed. A question this module cannot answer with
// certainty is answered "no".

// ---- static shortfall -------------------------------------------------
//
// The trigger, and the one subtlety that matters most.
//
// It reads the STATIC extraction only — the text produced from visible
// HTML BEFORE Stage 0 embedded-payload recovery. The authorized probe of a
// real SPA docs page measured: 1,477,635 HTML bytes, 134 characters of
// static text, and 57,640 characters recovered from RSC/JSON-LD payloads
// that turned out to be CSS tokens, React internals and schema.org
// boilerplate — no documentation at all.
//
// Judging the trigger on merged text would therefore have read 57,770
// characters, concluded "this page is fine", and suppressed rendering on
// precisely the page that needs it. Stage 0's recovery must never be able
// to mask an SPA shell.
export interface StaticShortfallInput {
  // Size of the served HTML document.
  staticHtmlBytes: number;
  // Text extracted from visible HTML ONLY. Never the Stage 0 merged text.
  staticTextLength: number;
}

export interface StaticShortfallThresholds {
  minHtmlBytes: number;
  maxStaticTextLength: number;
}

// Code-owned defaults. A page has to be BOTH substantial as a document and
// nearly empty as text — that combination is what an SPA shell looks like
// and what an ordinary short page does not.
export const DEFAULT_SHORTFALL_THRESHOLDS: StaticShortfallThresholds = {
  minHtmlBytes: 100_000,
  maxStaticTextLength: 500,
};

export function staticShortfallDetected(
  input: StaticShortfallInput,
  thresholds: StaticShortfallThresholds = DEFAULT_SHORTFALL_THRESHOLDS,
): boolean {
  return (
    input.staticHtmlBytes >= thresholds.minHtmlBytes &&
    input.staticTextLength < thresholds.maxStaticTextLength
  );
}

// ---- eligibility ------------------------------------------------------

export type RenderDenialReason =
  | "RENDERER_DISABLED"
  | "NOT_HTTPS"
  | "NOT_CONFIRMED"
  | "NOT_OFFICIAL_DOCS"
  | "NO_PATH_PREFIX"
  | "URL_OUTSIDE_PREFIX"
  | "NO_STATIC_SHORTFALL";

export type RenderEligibility =
  | { eligible: true; confirmedHost: string; matchedPathPrefix: string }
  | { eligible: false; reason: RenderDenialReason };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Segment-boundary prefix match, same discipline as D-135's own matcher:
// "/doc" must never match "/documentation".
export function pathWithinPrefix(pathname: string, prefix: string): boolean {
  const norm = (p: string) => {
    const withSlash = p.startsWith("/") ? p : `/${p}`;
    return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
  };
  const a = norm(pathname);
  const b = norm(prefix);
  return a === b || a.startsWith(`${b}/`);
}

export interface RenderEligibilityInput {
  url: string;
  route: ResolvedSourceRoute;
  staticHtmlBytes: number;
  staticTextLength: number;
  rendererEnabled: boolean;
  thresholds?: StaticShortfallThresholds;
}

// Every condition the owner required, evaluated in one place so no caller
// can satisfy a subset. Ordinary search candidates never reach this with a
// CONFIRMED/OFFICIAL_DOCS route, so they are denied by construction.
export function evaluateRenderEligibility(input: RenderEligibilityInput): RenderEligibility {
  if (!input.rendererEnabled) return { eligible: false, reason: "RENDERER_DISABLED" };
  if (!isHttps(input.url)) return { eligible: false, reason: "NOT_HTTPS" };
  if (input.route.officiality !== "CONFIRMED") return { eligible: false, reason: "NOT_CONFIRMED" };
  if (input.route.routeClass !== "OFFICIAL_DOCS") {
    return { eligible: false, reason: "NOT_OFFICIAL_DOCS" };
  }
  const prefix = input.route.matchedPathPrefix;
  if (typeof prefix !== "string" || prefix.length === 0) {
    return { eligible: false, reason: "NO_PATH_PREFIX" };
  }
  if (!pathWithinPrefix(pathOf(input.url), prefix)) {
    return { eligible: false, reason: "URL_OUTSIDE_PREFIX" };
  }
  const host = hostOf(input.url);
  if (!host) return { eligible: false, reason: "NOT_HTTPS" };
  // Static-first: rendering is the expensive, higher-risk path and only
  // runs when the cheap one demonstrably failed.
  if (
    !staticShortfallDetected(
      { staticHtmlBytes: input.staticHtmlBytes, staticTextLength: input.staticTextLength },
      input.thresholds,
    )
  ) {
    return { eligible: false, reason: "NO_STATIC_SHORTFALL" };
  }
  return { eligible: true, confirmedHost: host, matchedPathPrefix: prefix };
}

// ---- in-flight network policy ----------------------------------------

export type RequestDecision = "ALLOW" | "BLOCK";

// The top-level document. Re-checked after navigation against the FINAL
// url, so a redirect chain cannot land outside the confirmed route.
export function navigationAllowed(url: string, confirmedHost: string, prefix: string): boolean {
  if (!isHttps(url)) return false;
  const host = hostOf(url);
  if (host !== confirmedHost) return false;
  return pathWithinPrefix(pathOf(url), prefix);
}

// Subresources (scripts, styles, fonts, XHR the page issues). Minimum V1
// allows the confirmed host ONLY — every cross-origin request is blocked,
// including CDNs. A page that cannot render under that policy does not
// render; we do not widen the boundary to make any particular site work.
//
// Subresources are constrained by HOST, not by pathPrefix: a /docs page
// legitimately loads /_next/static/... from its own origin, and forcing
// the prefix here would break every framework bundle while adding no
// safety (the host is already the confirmed one).
export function subresourceAllowed(url: string, confirmedHost: string): RequestDecision {
  if (!isHttps(url)) return "BLOCK";
  const host = hostOf(url);
  if (!host) return "BLOCK";
  if (host !== confirmedHost) return "BLOCK";
  // A literal IP that resolves into a blocked range is refused even if it
  // somehow matched the confirmed host string.
  if (isIP(host) && isBlockedIp(host)) return "BLOCK";
  return "ALLOW";
}

// Pre-navigation DNS validation, mirroring the static fetcher's own
// discipline: resolve first, refuse private/loopback/link-local/reserved
// destinations before a browser is pointed at the host.
//
// Honest limitation, stated rather than implied: the browser performs its
// own resolution for the requests it makes, so this check plus
// host-equality is a strong constraint but not the same airtight guarantee
// as the static fetcher's connection pinning. Network-level egress
// restriction remains the complete answer and is a deployment
// prerequisite, not something this module can provide.
// `lookup` is injectable so this is testable with ZERO network activity —
// a DNS query is still a network operation, and an offline suite must not
// perform one. Production uses node's resolver.
export async function resolvedHostAllowed(
  host: string,
  lookup: (h: string) => Promise<{ address: string }> = dnsLookup,
): Promise<boolean> {
  try {
    // A literal IP short-circuits entirely: no resolution needed.
    if (isIP(host)) return !isBlockedIp(host);
    const { address } = await lookup(host);
    return !isBlockedIp(address);
  } catch {
    return false; // unresolvable => refuse
  }
}
