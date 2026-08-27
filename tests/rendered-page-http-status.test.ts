import { describe, expect, it } from "vitest";

import { isHttpStatusCode, isHttpSuccessStatus } from "../src/server/engine/providers/content-fetcher";
import {
  BROWSER_LAUNCH_DIAGNOSTICS,
  CHILD_REPORTABLE_RENDER_REASONS,
  RENDERED_DOCS_FAILURE_REASONS,
  RenderedDocsError,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { createPlaywrightRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-playwright";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";

// A BROWSER DOES NOT THROW ON 403.
//
// `page.goto()` resolves for any status a server actually answers with.
// The refusal page is fetched, rendered, and handed back like any other
// document — so the renderer would present a server's "access denied"
// HTML to extraction as though it were the page we asked for. The status
// that would have said otherwise was returned by `goto` and discarded on
// the spot; the adapter's own type even declared it.
//
// The fix reads it from the ONE trusted place, `Response.status()`, and
// fails closed on anything outside the success class. Nothing is inferred
// from markup, a title, a body, a header or an error string — a page is
// free to claim any status it likes in its own text, and none of that is
// read.
//
// The success rule itself is now shared with the static fetcher, because
// "which statuses yield a document" is a property of HTTP rather than of
// the transport, and two copies would eventually disagree.

const HOST = "docs.status-fixture.test";
const PREFIX = "/token";
const URL_IN = `https://${HOST}/token/economics`;
const ROUTE = { confirmedHost: HOST, matchedPathPrefix: PREFIX };

// Planted in every provider-controlled channel the renderer touches, so a
// leak has something unambiguous to be caught by.
const SECRET = "Bearer sk-live-9ZqW3RtYuVbNmKpL";
const SECRET_URL = `https://${HOST}/token?api_key=${SECRET}`;

interface FakeOpts {
  status?: number | null;
  nullResponse?: boolean;
  finalUrl?: string;
  html?: string;
  bodyText?: string;
  gotoError?: Error;
}

function fakeBrowser(opts: FakeOpts = {}) {
  const state = { navigations: 0, launches: 0 };
  const browser = {
    version: () => "fake/1.2.3",
    async newContext() {
      return {
        async newPage() {
          return {
            async goto() {
              state.navigations += 1;
              if (opts.gotoError) throw opts.gotoError;
              if (opts.nullResponse) return null;
              return { status: () => opts.status ?? 200 };
            },
            url: () => opts.finalUrl ?? URL_IN,
            content: async () =>
              opts.html ?? "<html><body>Fees are routed to the protocol vault.</body></html>",
            innerText: async () => opts.bodyText ?? "Fees are routed to the protocol vault.",
            on: () => {},
            close: async () => {},
          };
        },
        async close() {},
        async route() {},
      };
    },
    async close() {},
  };
  return { browser, state };
}

function fetcherWith(opts: FakeOpts = {}) {
  const { browser, state } = fakeBrowser(opts);
  const fetcher = createPlaywrightRenderedDocsFetcher({
    launchBrowser: async () => {
      state.launches += 1;
      return browser as never;
    },
    // Stubbed: an offline suite performs no DNS query.
    hostAllowed: async () => true,
  });
  return { fetcher, state };
}

async function renderError(opts: FakeOpts): Promise<RenderedDocsError> {
  const { fetcher } = fetcherWith(opts);
  const e = await fetcher.render(URL_IN, ROUTE).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(RenderedDocsError);
  return e as RenderedDocsError;
}

describe("1. the success rule is shared with the static fetcher", () => {
  it("accepts exactly 200..299 and nothing else", () => {
    for (const ok of [200, 201, 202, 204, 206, 226, 299]) {
      expect(isHttpSuccessStatus(ok)).toBe(true);
    }
    for (const bad of [100, 199, 300, 301, 302, 304, 400, 401, 403, 404, 429, 500, 503, 599]) {
      expect(isHttpSuccessStatus(bad)).toBe(false);
    }
  });

  it("refuses anything that is not an integer status", () => {
    for (const bad of [200.5, NaN, Infinity, -200]) expect(isHttpSuccessStatus(bad)).toBe(false);
    for (const bad of ["200", null, undefined, {}, [200], 99, 600, 200.5, NaN]) {
      expect(isHttpStatusCode(bad)).toBe(false);
    }
    for (const good of [100, 200, 403, 599]) expect(isHttpStatusCode(good)).toBe(true);
  });
});

describe("2. a successful render is still a document", () => {
  it("200 is accepted", async () => {
    const { fetcher } = fetcherWith({ status: 200 });
    const doc = await fetcher.render(URL_IN, ROUTE);
    expect(doc.renderMode).toBe("RENDERED");
    expect(doc.normalizedText).toContain("protocol vault");
  });

  it("other 2xx statuses are accepted", async () => {
    for (const status of [201, 202, 206]) {
      const { fetcher } = fetcherWith({ status });
      await expect(fetcher.render(URL_IN, ROUTE), String(status)).resolves.toMatchObject({
        renderMode: "RENDERED",
      });
    }
  });

  it("204 is accepted at the status gate, DELIBERATELY, and yields whatever rendered", async () => {
    // EXPLICIT DECISION, pinned rather than left to chance. 204 is inside
    // the success class, and the success class is the static fetcher's —
    // one rule, two transports, no possibility of a status a browser
    // accepts but a plain client refuses. A 204 carries no content, so
    // what comes back is an empty document, and an empty document cannot
    // become evidence: extraction has nothing to quote, so the component
    // ends INSUFFICIENT_EVIDENCE. That is a correct fail-closed outcome
    // reached by the existing path, not a special case bolted on here.
    const { fetcher } = fetcherWith({ status: 204, bodyText: "", html: "<html><body></body></html>" });
    const doc = await fetcher.render(URL_IN, ROUTE);
    expect(doc.renderMode).toBe("RENDERED");
    expect(doc.renderedTextLength).toBe(0);
  });
});

describe("3. a refusal is not a document", () => {
  it("401 is rejected, carrying the trusted status", async () => {
    const e = await renderError({ status: 401 });
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(401);
  });

  it("403 is rejected — the case that made this necessary", async () => {
    const e = await renderError({ status: 403 });
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(403);
  });

  it("429 is rejected", async () => {
    const e = await renderError({ status: 429 });
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(429);
  });

  it("404 is rejected — an absent page is not an empty one", async () => {
    const e = await renderError({ status: 404 });
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(404);
  });

  it("500 and other server errors are rejected", async () => {
    for (const status of [500, 502, 503]) {
      const e = await renderError({ status });
      expect(e.reason, String(status)).toBe("HTTP_ERROR");
      expect(e.httpStatus).toBe(status);
    }
  });

  it("a 1xx or a bare 3xx surfacing as the final status is rejected too", async () => {
    // Playwright follows redirects and returns the last response, so a
    // 3xx arriving here means the chain did not resolve to a document.
    for (const status of [100, 301, 302, 304]) {
      const e = await renderError({ status });
      expect(e.reason, String(status)).toBe("HTTP_ERROR");
      expect(e.httpStatus).toBe(status);
    }
  });

  it("ONE navigation and ONE launch, with no retry after a refusal", async () => {
    const { fetcher, state } = fetcherWith({ status: 403 });
    await fetcher.render(URL_IN, ROUTE).catch(() => {});
    expect(state.navigations).toBe(1);
    expect(state.launches).toBe(1);
  });
});

describe("4. redirects still obey the route policy first", () => {
  it("a redirect landing inside the confirmed route with a 200 is accepted", async () => {
    const { fetcher } = fetcherWith({
      status: 200,
      finalUrl: `https://${HOST}/token/economics/v2`,
    });
    await expect(fetcher.render(URL_IN, ROUTE)).resolves.toMatchObject({ renderMode: "RENDERED" });
  });

  it("a redirect OFF the route is a containment failure, even with a 200", async () => {
    const e = await renderError({ status: 200, finalUrl: "https://elsewhere.test/token/x" });
    expect(e.reason).toBe("FINAL_URL_OUTSIDE_ROUTE");
  });

  it("a redirect off the route AND a refusal reports the containment failure", async () => {
    // The route check runs first on purpose: landing somewhere we never
    // confirmed is the more serious statement to make about a render that
    // did both.
    const e = await renderError({ status: 403, finalUrl: "https://elsewhere.test/token/x" });
    expect(e.reason).toBe("FINAL_URL_OUTSIDE_ROUTE");
    expect(e.httpStatus).toBeNull();
  });

  it("a redirect to a different path on the SAME host, outside the prefix, is refused", async () => {
    const e = await renderError({ status: 200, finalUrl: `https://${HOST}/marketing/promo` });
    expect(e.reason).toBe("FINAL_URL_OUTSIDE_ROUTE");
  });
});

describe("5. the status comes from the Response and from nowhere else", () => {
  it("a page CLAIMING success in its own markup cannot rescue a 403", async () => {
    const e = await renderError({
      status: 403,
      html: "<html><head><title>200 OK</title></head><body>HTTP/1.1 200 OK — status: 200 — everything is fine</body></html>",
      bodyText: "HTTP/1.1 200 OK status:200 success",
    });
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(403);
  });

  it("a page CLAIMING a refusal in its own markup cannot spoil a 200", async () => {
    // The converse matters just as much: a document that merely discusses
    // 403 responses is still a document.
    const { fetcher } = fetcherWith({
      status: 200,
      html: "<html><body>Our API returns 403 Forbidden when the key is missing.</body></html>",
      bodyText: "Our API returns 403 Forbidden when the key is missing.",
    });
    const doc = await fetcher.render(URL_IN, ROUTE);
    expect(doc.renderMode).toBe("RENDERED");
    expect(doc.normalizedText).toContain("403 Forbidden");
  });

  it("a status in an ERROR STRING is never read as a status", async () => {
    const e = await renderError({
      gotoError: new Error(`net::ERR_FAILED 403 Forbidden at ${SECRET_URL} authorization: ${SECRET}`),
    });
    // A thrown navigation is not a refusal: no Response existed, so no
    // status is claimed. Nothing is scraped out of the message — the "403"
    // sitting in that error text reaches nothing.
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.httpStatus).toBeNull();
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
  });

  it("a missing Response fails closed rather than passing unverified", async () => {
    const e = await renderError({ nullResponse: true });
    expect(e.reason).toBe("NO_NAVIGATION_RESPONSE");
    expect(e.httpStatus).toBeNull();
  });

  it("a Response whose status is not a valid code fails closed", async () => {
    for (const status of [0, -1, 99, 600, 1000]) {
      const e = await renderError({ status });
      expect(e.reason, String(status)).toBe("NO_NAVIGATION_RESPONSE");
      expect(e.httpStatus).toBeNull();
    }
  });
});

describe("6. nothing provider-controlled leaves the renderer", () => {
  it("no body, header, url or message reaches the error", async () => {
    const e = await renderError({
      status: 403,
      html: `<html><body>${SECRET}<a href="${SECRET_URL}">x</a></body></html>`,
      bodyText: `${SECRET} ${SECRET_URL}`,
    });
    const surfaced = JSON.stringify({
      r: e.reason,
      s: e.httpStatus,
      m: e.message,
      n: e.name,
      d: e.diagnostic,
    });
    expect(surfaced).not.toContain(SECRET);
    expect(surfaced).not.toContain("api_key");
    expect(surfaced).not.toContain(HOST);
    // What DOES survive is a number and a code-owned word.
    expect(e.httpStatus).toBe(403);
    expect(typeof e.httpStatus).toBe("number");
  });

  it("the error validates the status at its own edge", () => {
    expect(new RenderedDocsError("HTTP_ERROR", "x", null, 403).httpStatus).toBe(403);
    for (const bad of [0, 99, 600, 403.5, NaN, "403" as unknown as number, null]) {
      expect(new RenderedDocsError("HTTP_ERROR", "x", null, bad as number).httpStatus).toBeNull();
    }
  });
});

describe("7. the status survives the process boundary, re-checked", () => {
  const PARENT_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };
  function isolatedWith(stdout: string) {
    return createIsolatedRenderedDocsFetcher({
      spawnChild: (async () => ({ stdout, code: 0 })) as never,
      startProxy: (async () => ({ port: 44991, decisions: [], close: async () => {} })) as never,
      parentEnv: PARENT_ENV,
    });
  }

  it("a valid status arrives intact", async () => {
    const f = isolatedWith(JSON.stringify({ ok: false, reason: "HTTP_ERROR", httpStatus: 403 }));
    const e = (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(403);
  });

  it("an invalid status on the wire is dropped while the reason stands", async () => {
    for (const httpStatus of ["403", 0, 600, 403.5, null, { s: 403 }, `403 ${SECRET}`]) {
      const f = isolatedWith(JSON.stringify({ ok: false, reason: "HTTP_ERROR", httpStatus }));
      const e = (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
      expect(e.reason).toBe("HTTP_ERROR");
      expect(e.httpStatus).toBeNull();
      expect(JSON.stringify({ m: e.message })).not.toContain(SECRET);
    }
  });

  it("both new reasons are reportable by the child", () => {
    expect(CHILD_REPORTABLE_RENDER_REASONS.has("HTTP_ERROR")).toBe(true);
    expect(CHILD_REPORTABLE_RENDER_REASONS.has("NO_NAVIGATION_RESPONSE")).toBe(true);
  });
});

describe("8. the launch diagnostics are untouched", () => {
  it("the launch diagnostic set is unchanged and still separate from the reason set", () => {
    expect(BROWSER_LAUNCH_DIAGNOSTICS.length).toBe(4);
    expect(BROWSER_LAUNCH_DIAGNOSTICS).toContain("EXECUTABLE_NOT_FOUND");
    // The two vocabularies do not overlap: a launch diagnostic is never a
    // failure reason and vice versa.
    for (const d of BROWSER_LAUNCH_DIAGNOSTICS) {
      expect(RENDERED_DOCS_FAILURE_REASONS).not.toContain(d);
    }
  });

  it("a launch failure still carries its diagnostic and no status", () => {
    const e = new RenderedDocsError("BROWSER_LAUNCH_FAILED", "isolated", "EXECUTABLE_NOT_FOUND");
    expect(e.diagnostic).toBe("EXECUTABLE_NOT_FOUND");
    expect(e.httpStatus).toBeNull();
  });
});
