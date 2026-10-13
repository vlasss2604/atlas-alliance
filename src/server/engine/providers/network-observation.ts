// PASSIVE NETWORK OBSERVATION for the isolated renderer.
//
// A rendered page shows values it fetched from somewhere. When the settled
// DOM carries no machine-readable identifier — as pump.fun's burn table
// does not — the remaining question is what the page ITSELF asked for. That
// is answerable without asking for anything new: the browser already made
// those requests to render the page we are already allowed to render.
//
// OBSERVATIONAL ONLY, and that is a structural claim rather than a promise.
// This module is PURE POLICY plus a bounded collector. It has no fetch, no
// page handle, no request object and no way to issue, replay, modify or
// continue a request. It is handed metadata about responses that already
// arrived and decides what may be written down.
//
// SAME-ORIGIN ONLY for bodies. The egress proxy already blocks cross-origin
// requests outright, so a cross-origin body should never reach this code;
// checking it here anyway is defence in depth, and it means the rule is
// testable without a browser. A cross-origin response is recorded as
// metadata and its body is never adopted.
//
// NOTHING SECRET IS CAPTURED. There is no parameter for request headers,
// cookies, authorization, or browser storage — not filtered, absent. The
// only header-derived value is the response's own content-type, which
// selects whether a body may be read at all.
//
// AUTHORITY: none. An observed URL is a URL the page asked for. It is not
// OFFICIAL_DOCS, not evidence, not project identity, and not a mechanism.
// Nothing here can express approval, and a discovered endpoint stays an
// observational candidate until a human decides otherwise.

export interface NetworkObservation {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  contentType: string | null;
  // Bytes reported by the response, when it reported any.
  contentLength: number | null;
  // Same host as the confirmed route (after www-stripping)?
  sameOrigin: boolean;
  // Bounded body, captured only for a same-origin textual response. Null
  // whenever the policy declined — which is not a failure and not an
  // assertion that the response was empty.
  body: string | null;
  bodyTruncated: boolean;
}

// Caps. A page is externally authored: without ceilings one response could
// inflate an artifact without limit, and a chatty page could produce an
// unbounded list of observations.
export const MAX_OBSERVATIONS = 300;
export const MAX_BODY_BYTES = 262_144; // 256 KiB per response
export const MAX_TOTAL_BODY_BYTES = 2_097_152; // 2 MiB across the render

// Textual content types whose bodies may be read. An allowlist, because the
// set of binary types is open-ended and a denylist of them is one format
// away from being wrong. text/html is deliberately EXCLUDED: the document
// itself is already captured, and re-capturing it would duplicate megabytes
// to no purpose.
const CAPTURABLE_CONTENT_TYPES = [
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "text/json",
  "text/plain",
  "text/x-component",
];

export function isCapturableContentType(contentType: string | null): boolean {
  if (typeof contentType !== "string" || contentType.length === 0) return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return CAPTURABLE_CONTENT_TYPES.includes(base);
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isSameOrigin(url: string, confirmedHost: string): boolean {
  const host = hostOf(url);
  return host !== null && host === confirmedHost.toLowerCase().replace(/^www\./, "");
}

export interface BodyPolicyInput {
  url: string;
  confirmedHost: string;
  contentType: string | null;
}

// May this response's body be read at all? Same-origin AND textual. A
// cross-origin JSON endpoint the page happened to reach is recorded as
// metadata and nothing more — following it would be trusting a host nobody
// confirmed.
export function mayCaptureBody(input: BodyPolicyInput): boolean {
  if (!isSameOrigin(input.url, input.confirmedHost)) return false;
  return isCapturableContentType(input.contentType);
}

// Collects observations under hard caps. Holds no page or request handle —
// the caller feeds it what already arrived.
export class NetworkObservationCollector {
  private readonly observations: NetworkObservation[] = [];
  private totalBodyBytes = 0;
  private droppedCount = 0;

  constructor(private readonly confirmedHost: string) {}

  // `readBody` is invoked ONLY when policy allows, and only to read a body
  // the browser already received. It is a reader, never a fetcher: a
  // caller that passes something which issues a request would be defeating
  // the guarantee this class exists to hold, which is why the renderer's
  // call site is asserted by test.
  record(input: {
    url: string;
    method: string;
    resourceType: string;
    status: number;
    contentType: string | null;
    contentLength: number | null;
    body: string | null;
  }): void {
    if (this.observations.length >= MAX_OBSERVATIONS) {
      this.droppedCount += 1;
      return;
    }
    const sameOrigin = isSameOrigin(input.url, this.confirmedHost);
    const allowed = mayCaptureBody({
      url: input.url,
      confirmedHost: this.confirmedHost,
      contentType: input.contentType,
    });

    let body: string | null = null;
    let bodyTruncated = false;
    if (allowed && typeof input.body === "string") {
      const remaining = MAX_TOTAL_BODY_BYTES - this.totalBodyBytes;
      if (remaining > 0) {
        const perResponse = Math.min(MAX_BODY_BYTES, remaining);
        if (input.body.length > perResponse) {
          body = input.body.slice(0, perResponse);
          bodyTruncated = true;
        } else {
          body = input.body;
        }
        this.totalBodyBytes += body.length;
      } else {
        bodyTruncated = true;
      }
    }

    this.observations.push({
      url: input.url,
      method: input.method,
      resourceType: input.resourceType,
      status: input.status,
      contentType: input.contentType,
      contentLength: input.contentLength,
      sameOrigin,
      body,
      bodyTruncated,
    });
  }

  result(): { observations: NetworkObservation[]; droppedCount: number; totalBodyBytes: number } {
    return {
      observations: this.observations,
      droppedCount: this.droppedCount,
      totalBodyBytes: this.totalBodyBytes,
    };
  }
}
