import { describe, expect, it } from "vitest";

import {
  CONTENT_FETCH_FAILURE_REASONS,
  ContentFetchError,
} from "../src/server/engine/providers/content-fetcher";
import {
  RENDER_ON_REFUSAL_STATUSES,
  evaluateRefusalRenderEligibility,
  evaluateRenderEligibility,
} from "../src/server/engine/rendered-docs-policy";
import type { ResolvedSourceRoute } from "../src/server/engine/source-authority";

// A PAGE THAT REFUSES US IS NOT A PAGE WE CANNOT READ.
//
// Rendering used to be reachable only as an upgrade to a fetch that had
// already succeeded: the gate measured the byte and text length of a
// document it already had. A server that declines to serve an ordinary
// client therefore made its own docs permanently unreadable — the renderer
// exists for exactly that page and could never be asked.
//
// The second way in is the same renderer behind the same gates. Only two
// things differ: there is no document to measure, and in its place stands a
// narrow, code-owned set of statuses a browser plausibly satisfies.
//
// WHAT THIS IS NOT. Not a licence to render on any failure, not anti-bot
// evasion, and not a relaxation of anything. A refusal opens the door only
// for a route already confirmed as this project's own official docs, and
// every failure that never reached a server carries no status and cannot
// reach it at all.

const CONFIRMED: ResolvedSourceRoute = {
  officiality: "CONFIRMED",
  routeClass: "OFFICIAL_DOCS",
  matchedPathPrefix: "/docs",
  observation: null,
};
const URL_IN_SCOPE = "https://example.com/docs/token";

function refusal(httpStatus: number | null, over: Partial<Parameters<typeof evaluateRefusalRenderEligibility>[0]> = {}) {
  return evaluateRefusalRenderEligibility({
    url: URL_IN_SCOPE,
    route: CONFIRMED,
    rendererEnabled: true,
    httpStatus,
    ...over,
  });
}

describe("1. the trusted status survives, and only from the response", () => {
  it("403 is preserved as a number", () => {
    const e = new ContentFetchError("HTTP_ERROR", "HTTP 403 for https://example.com/docs", URL_IN_SCOPE, 403);
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(403);
  });

  it("429 is preserved as a number", () => {
    const e = new ContentFetchError("HTTP_ERROR", "HTTP 429", URL_IN_SCOPE, 429);
    expect(e.httpStatus).toBe(429);
  });

  it("a message containing a status cannot become one", () => {
    // The message is provider-influenced text and is never parsed. A
    // failure that carries no numeric status carries no status at all.
    const e = new ContentFetchError("HTTP_ERROR", "HTTP 403 Forbidden — status: 403", URL_IN_SCOPE);
    expect(e.message).toContain("403");
    expect(e.httpStatus).toBeNull();
    expect(refusal(e.httpStatus).eligible).toBe(false);
  });

  it("out-of-range and non-integer values are dropped, not kept", () => {
    for (const bogus of [0, 99, 600, 1000, -403, 403.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(new ContentFetchError("HTTP_ERROR", "x", URL_IN_SCOPE, bogus).httpStatus).toBeNull();
    }
    expect(new ContentFetchError("HTTP_ERROR", "x", URL_IN_SCOPE, 100).httpStatus).toBe(100);
    expect(new ContentFetchError("HTTP_ERROR", "x", URL_IN_SCOPE, 599).httpStatus).toBe(599);
  });

  it("a non-HTTP failure carries no status", () => {
    for (const reason of CONTENT_FETCH_FAILURE_REASONS) {
      if (reason === "HTTP_ERROR") continue;
      expect(new ContentFetchError(reason, "x", URL_IN_SCOPE).httpStatus).toBeNull();
    }
  });
});

describe("2. which refusals open the renderer", () => {
  it("the set is exactly 401, 403 and 429", () => {
    expect([...RENDER_ON_REFUSAL_STATUSES].sort((a, b) => a - b)).toEqual([401, 403, 429]);
  });

  it("403 on a confirmed official-docs route is eligible", () => {
    const r = refusal(403);
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.confirmedHost).toBe("example.com");
      expect(r.matchedPathPrefix).toBe("/docs");
    }
  });

  it("429 is eligible", () => {
    expect(refusal(429).eligible).toBe(true);
  });

  it("401 is eligible", () => {
    expect(refusal(401).eligible).toBe(true);
  });

  it("404 is NOT — rendering does not invent an absent page", () => {
    const r = refusal(404);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("NOT_A_RENDERABLE_REFUSAL");
  });

  it("ordinary 5xx is NOT, and 503 specifically is not either", () => {
    for (const status of [500, 502, 503, 504]) {
      const r = refusal(status);
      expect(r.eligible, String(status)).toBe(false);
      if (!r.eligible) expect(r.reason).toBe("NOT_A_RENDERABLE_REFUSAL");
    }
  });

  it("410, 400 and every other 4xx stay closed", () => {
    for (const status of [400, 402, 405, 408, 410, 418, 451]) {
      expect(refusal(status).eligible, String(status)).toBe(false);
    }
  });

  it("a failure that never reached a server can never open it", () => {
    // BLOCKED_ADDRESS, DNS_RESOLUTION_FAILED, TIMEOUT, INVALID_URL and the
    // rest all carry httpStatus null by construction, so the door is shut
    // before any route gate is even consulted.
    for (const reason of CONTENT_FETCH_FAILURE_REASONS) {
      if (reason === "HTTP_ERROR") continue;
      const e = new ContentFetchError(reason, "x", URL_IN_SCOPE);
      expect(refusal(e.httpStatus).eligible, reason).toBe(false);
    }
    expect(refusal(null).eligible).toBe(false);
  });
});

describe("3. the route gates are unchanged and still decide", () => {
  it("a renderer-ineligible route is refused even on 403", () => {
    const cases: [string, Partial<ResolvedSourceRoute>][] = [
      ["NOT_CONFIRMED", { officiality: "CLAIMED" }],
      ["NOT_OFFICIAL_DOCS", { routeClass: null }],
      ["NO_PATH_PREFIX", { matchedPathPrefix: null }],
    ];
    for (const [expected, over] of cases) {
      const r = refusal(403, { route: { ...CONFIRMED, ...over } as ResolvedSourceRoute });
      expect(r.eligible, expected).toBe(false);
      if (!r.eligible) expect(r.reason).toBe(expected);
    }
  });

  it("a url outside the confirmed prefix is refused even on 403", () => {
    const r = refusal(403, { url: "https://example.com/blog/post" });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("URL_OUTSIDE_PREFIX");
  });

  it("plain http is refused even on 403", () => {
    const r = refusal(403, { url: "http://example.com/docs/token" });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("NOT_HTTPS");
  });

  it("a disabled renderer is refused even on 403", () => {
    const r = refusal(403, { rendererEnabled: false });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("RENDERER_DISABLED");
  });

  it("the prefix match is still segment-bounded", () => {
    // "/docs" must not admit "/docsearch" — the same discipline the
    // upgrade path uses, because it is literally the same code.
    const r = refusal(403, { url: "https://example.com/docsearch/x" });
    expect(r.eligible).toBe(false);
  });
});

describe("4. the existing upgrade path is untouched", () => {
  const base = {
    url: URL_IN_SCOPE,
    route: CONFIRMED,
    rendererEnabled: true,
  };

  it("a thin static document still qualifies as a shortfall", () => {
    const r = evaluateRenderEligibility({ ...base, staticHtmlBytes: 150_000, staticTextLength: 134 });
    expect(r.eligible).toBe(true);
  });

  it("a substantial static document still does not", () => {
    const r = evaluateRenderEligibility({ ...base, staticHtmlBytes: 150_000, staticTextLength: 40_000 });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("NO_STATIC_SHORTFALL");
  });

  it("the route gates still apply to it identically", () => {
    const r = evaluateRenderEligibility({
      ...base,
      route: { ...CONFIRMED, officiality: "CLAIMED" },
      staticHtmlBytes: 60_000,
      staticTextLength: 134,
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("NOT_CONFIRMED");
  });

  it("the two paths agree on every route gate, differing only on the last one", () => {
    // Same route, same url, same renderer: whatever one refuses for a
    // ROUTE reason, so does the other.
    for (const over of [
      { officiality: "CLAIMED" as const },
      { routeClass: null },
      { matchedPathPrefix: null },
    ]) {
      const route = { ...CONFIRMED, ...over } as ResolvedSourceRoute;
      const upgrade = evaluateRenderEligibility({ ...base, route, staticHtmlBytes: 150_000, staticTextLength: 134 });
      const onRefusal = refusal(403, { route });
      expect(upgrade.eligible).toBe(false);
      expect(onRefusal.eligible).toBe(false);
      if (!upgrade.eligible && !onRefusal.eligible) expect(onRefusal.reason).toBe(upgrade.reason);
    }
  });
});

describe("5. nothing leaks through the new field", () => {
  it("a status is a number, so it cannot carry text at all", () => {
    const e = new ContentFetchError(
      "HTTP_ERROR",
      "GET https://api.example.com/v1?api_key=SECRET_TOKEN_DO_NOT_LEAK — Authorization: Bearer sk-live-abc",
      "https://api.example.com/v1?api_key=SECRET_TOKEN_DO_NOT_LEAK",
      403,
    );
    expect(typeof e.httpStatus).toBe("number");
    expect(String(e.httpStatus)).toBe("403");
    expect(String(e.httpStatus)).not.toContain("SECRET_TOKEN_DO_NOT_LEAK");
    expect(String(e.httpStatus)).not.toContain("Bearer");
    expect(String(e.httpStatus)).not.toContain("api.example.com");
  });

  it("the eligibility result carries only host and prefix, both from the url we asked for", () => {
    const r = refusal(403);
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(Object.keys(r).sort()).toEqual(["confirmedHost", "eligible", "matchedPathPrefix"]);
    }
  });
});
