import { describe, expect, it } from "vitest";

import {
  BROWSER_LAUNCH_DIAGNOSTICS,
  CHILD_REPORTABLE_RENDER_REASONS,
  NAVIGATION_DIAGNOSTICS,
  PLAYWRIGHT_TIMEOUT_ERROR_NAME,
  RENDERED_DOCS_FAILURE_REASONS,
  RenderedDocsError,
  classifyNavigationFailure,
  isNavigationDiagnostic,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { createPlaywrightRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-playwright";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";

// A NAVIGATION THAT NEVER COMPLETED IS NOT ONE THING.
//
// `page.goto` throwing collapsed into the generic RENDER_FAILED beside
// failures that happen nowhere near the network. Three situations lived
// inside that one word and they call for opposite next actions: wait
// longer, confirm a different host, or do nothing at all. A live window
// that comes back unable to say which buys one bit of information at full
// price — the third time that has happened in this project.
//
// The classification rests only on signals held LOCALLY. The timeout is
// Playwright's own typed error, matched on a name this repository pins as
// a constant. The containment case is recorded by our own route handler at
// the moment it aborts, never inferred afterwards from the shape of a
// generic failure — and when the driver cannot prove it, nothing is
// claimed. Everything else stays honestly unclassified.

const HOST = "docs.nav-diagnosis.test";
const PREFIX = "/token";
const URL_IN = `https://${HOST}/token/economics`;
const ROUTE = { confirmedHost: HOST, matchedPathPrefix: PREFIX };

const SECRET = "Bearer sk-live-77XyZqPlMnBvCx";
const SECRET_URL = `https://${HOST}/token?api_key=${SECRET}`;

// The shape Playwright's typed timeout actually has, pinned by the
// contract test below against the installed package.
function timeoutError(message = "Timeout 15000ms exceeded."): Error {
  const e = new Error(message);
  e.name = PLAYWRIGHT_TIMEOUT_ERROR_NAME;
  return e;
}

interface FakeOpts {
  gotoError?: Error;
  // Requests the fake route handler will be asked about before navigating.
  blockedNavigationUrl?: string;
  // Whether the fake driver exposes the methods that PROVE a main-frame
  // navigation was aborted. Off means the proof is unavailable.
  exposesFrameApi?: boolean;
  status?: number;
  finalUrl?: string;
}

function fetcherWith(opts: FakeOpts = {}) {
  const state = { navigations: 0, blockedRequests: 0 };
  const mainFrame = { id: "main" };
  const otherFrame = { id: "iframe" };

  function makeRoute(url: string, frame: unknown, isNav: boolean) {
    return {
      request: () => ({
        url: () => url,
        resourceType: () => (isNav ? "document" : "script"),
        ...(opts.exposesFrameApi === false
          ? {}
          : { isNavigationRequest: () => isNav, frame: () => frame }),
      }),
      abort: async () => {
        state.blockedRequests += 1;
      },
      continue: async () => {},
    };
  }

  let routeHandler: ((r: unknown) => Promise<void> | void) | null = null;
  const browser = {
    version: () => "fake/1.2.3",
    async newContext() {
      return {
        async newPage() {
          return {
            async goto() {
              // The handler runs during navigation in the real driver, so
              // the fake calls it at the same point.
              if (opts.blockedNavigationUrl && routeHandler) {
                await routeHandler(makeRoute(opts.blockedNavigationUrl, mainFrame, true));
              }
              state.navigations += 1;
              if (opts.gotoError) throw opts.gotoError;
              return { status: () => opts.status ?? 200 };
            },
            url: () => opts.finalUrl ?? URL_IN,
            content: async () => "<html><body>rendered</body></html>",
            innerText: async () => "Fees are routed to the protocol vault.",
            on: () => {},
            close: async () => {},
            ...(opts.exposesFrameApi === false ? {} : { mainFrame: () => mainFrame }),
          };
        },
        async close() {},
        async route(_p: string, handler: (r: unknown) => Promise<void> | void) {
          routeHandler = handler;
        },
      };
    },
    async close() {},
  };

  const fetcher = createPlaywrightRenderedDocsFetcher({
    launchBrowser: async () => browser as never,
    hostAllowed: async () => true,
  });
  return { fetcher, state, mainFrame, otherFrame, makeRoute, getHandler: () => routeHandler };
}

async function renderError(opts: FakeOpts): Promise<RenderedDocsError> {
  const { fetcher } = fetcherWith(opts);
  const e = await fetcher.render(URL_IN, ROUTE).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(RenderedDocsError);
  return e as RenderedDocsError;
}

describe("1. the diagnostic set is closed, small and code-owned", () => {
  it("exists at runtime with the type derived from it", () => {
    expect(Array.isArray(NAVIGATION_DIAGNOSTICS)).toBe(true);
    expect(new Set(NAVIGATION_DIAGNOSTICS).size).toBe(NAVIGATION_DIAGNOSTICS.length);
    for (const d of NAVIGATION_DIAGNOSTICS) expect(d).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("has exactly the three cases a local signal can support", () => {
    expect(NAVIGATION_DIAGNOSTICS.length).toBe(3);
    expect(NAVIGATION_DIAGNOSTICS).toContain("NAVIGATION_TIMEOUT");
    expect(NAVIGATION_DIAGNOSTICS).toContain("BLOCKED_BY_ROUTE_POLICY");
    expect(NAVIGATION_DIAGNOSTICS).toContain("UNCLASSIFIED_NAVIGATION_ERROR");
  });

  it("does not overlap the launch vocabulary or the reason list", () => {
    for (const d of NAVIGATION_DIAGNOSTICS) {
      expect(BROWSER_LAUNCH_DIAGNOSTICS).not.toContain(d);
      expect(RENDERED_DOCS_FAILURE_REASONS).not.toContain(d);
    }
  });

  it("the guard admits members and refuses everything else", () => {
    for (const d of NAVIGATION_DIAGNOSTICS) expect(isNavigationDiagnostic(d)).toBe(true);
    for (const bad of [
      "navigation_timeout",
      "NAVIGATION_TIMEOUT ",
      "RENDER_FAILED",
      "EXECUTABLE_NOT_FOUND",
      SECRET,
      "",
      null,
      undefined,
      7,
      { d: "NAVIGATION_TIMEOUT" },
    ]) {
      expect(isNavigationDiagnostic(bad)).toBe(false);
    }
  });

  it("CONTRACT: the installed Playwright still names its timeout what we pin", async () => {
    // The timeout branch rests on this exact string. If a future
    // Playwright renames it, this fails here rather than silently
    // degrading every timeout to UNCLASSIFIED in a live window.
    const pw = (await import("playwright-core")) as unknown as {
      errors: { TimeoutError: new (m: string) => Error };
    };
    expect(new pw.errors.TimeoutError("x").name).toBe(PLAYWRIGHT_TIMEOUT_ERROR_NAME);
  });
});

describe("2. the classifier uses local signals only", () => {
  it("a typed timeout is NAVIGATION_TIMEOUT", () => {
    expect(classifyNavigationFailure(timeoutError(), false)).toBe("NAVIGATION_TIMEOUT");
  });

  it("our own recorded abort outranks whatever the browser reported", () => {
    // Containment is a fact about what THIS code did; the exception is
    // only its consequence, so it does not get a vote.
    expect(classifyNavigationFailure(new Error("net::ERR_BLOCKED_BY_CLIENT"), true)).toBe(
      "BLOCKED_BY_ROUTE_POLICY",
    );
    expect(classifyNavigationFailure(timeoutError(), true)).toBe("BLOCKED_BY_ROUTE_POLICY");
  });

  it("everything else stays honestly unclassified", () => {
    for (const e of [
      new Error("net::ERR_CONNECTION_RESET"),
      new Error("net::ERR_CERT_AUTHORITY_INVALID"),
      new Error("net::ERR_EMPTY_RESPONSE"),
      new Error(""),
      "a string",
      null,
      undefined,
      42,
    ]) {
      expect(classifyNavigationFailure(e, false)).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
    }
  });

  it("a message that merely SAYS timeout is not a timeout", () => {
    // The signal is the typed name, never the text. A page whose error
    // text contains the word cannot promote itself.
    const e = new Error("Timeout 15000ms exceeded. TimeoutError");
    expect(e.name).toBe("Error");
    expect(classifyNavigationFailure(e, false)).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
  });

  it("the output is a set member, so no message can ride along", () => {
    const out = classifyNavigationFailure(new Error(`${SECRET} at ${SECRET_URL}`), false);
    expect(NAVIGATION_DIAGNOSTICS).toContain(out);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(HOST);
  });
});

describe("3. the renderer reports the stage and the kind", () => {
  it("a goto timeout is distinguishable", async () => {
    const e = await renderError({ gotoError: timeoutError() });
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.navigationDiagnostic).toBe("NAVIGATION_TIMEOUT");
    expect(e.httpStatus).toBeNull();
    expect(e.diagnostic).toBeNull();
  });

  it("OUR OWN route-policy abort of the main-frame navigation is distinguishable", async () => {
    // The handler blocks a cross-host navigation, then goto throws as it
    // would in the real driver. The classification comes from the record
    // the handler made, not from the exception.
    const e = await renderError({
      blockedNavigationUrl: "https://elsewhere.test/landing",
      gotoError: new Error("net::ERR_BLOCKED_BY_CLIENT"),
    });
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.navigationDiagnostic).toBe("BLOCKED_BY_ROUTE_POLICY");
  });

  it("a generic transport failure stays UNCLASSIFIED", async () => {
    const e = await renderError({ gotoError: new Error("net::ERR_CONNECTION_RESET") });
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
  });

  it("a driver that CANNOT prove a main-frame abort does not claim one", async () => {
    // Absence of proof is not proof. Without isNavigationRequest/frame the
    // block still happens — containment is unaffected — but the
    // classification stays generic.
    const e = await renderError({
      exposesFrameApi: false,
      blockedNavigationUrl: "https://elsewhere.test/landing",
      gotoError: new Error("net::ERR_BLOCKED_BY_CLIENT"),
    });
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
  });

  it("blocking a SUBRESOURCE never makes the navigation look policy-blocked", async () => {
    const { fetcher, mainFrame, makeRoute, getHandler } = fetcherWith({
      gotoError: new Error("net::ERR_CONNECTION_RESET"),
    });
    const run = fetcher.render(URL_IN, ROUTE).catch((x: unknown) => x);
    // The handler is installed during render; drive a non-navigation
    // block through it before the failure surfaces.
    await Promise.resolve();
    const h = getHandler();
    if (h) await h(makeRoute("https://cdn.evil.test/x.js", mainFrame, false));
    const e = (await run) as RenderedDocsError;
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
  });

  it("no exception message, url or host reaches anything surfaced", async () => {
    const e = await renderError({ gotoError: new Error(`${SECRET} at ${SECRET_URL}`) });
    const surfaced = JSON.stringify({
      r: e.reason,
      n: e.navigationDiagnostic,
      d: e.diagnostic,
      s: e.httpStatus,
      m: e.message,
      name: e.name,
    });
    expect(surfaced).not.toContain(SECRET);
    expect(surfaced).not.toContain(HOST);
    expect(surfaced).not.toContain("api_key");
  });
});

describe("4. nothing else moved", () => {
  it("FINAL_URL_OUTSIDE_ROUTE still wins for a completed navigation off-route", async () => {
    const e = await renderError({ status: 200, finalUrl: "https://elsewhere.test/token/x" });
    expect(e.reason).toBe("FINAL_URL_OUTSIDE_ROUTE");
    expect(e.navigationDiagnostic).toBeNull();
  });

  it("HTTP status handling is untouched", async () => {
    const e = await renderError({ status: 403 });
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.httpStatus).toBe(403);
    expect(e.navigationDiagnostic).toBeNull();
  });

  it("a successful render is still a document", async () => {
    const { fetcher } = fetcherWith({ status: 200 });
    const doc = await fetcher.render(URL_IN, ROUTE);
    expect(doc.renderMode).toBe("RENDERED");
  });

  it("launch diagnostics are untouched and stay in their own field", () => {
    const e = new RenderedDocsError("BROWSER_LAUNCH_FAILED", "isolated", "EXECUTABLE_NOT_FOUND");
    expect(e.diagnostic).toBe("EXECUTABLE_NOT_FOUND");
    expect(e.navigationDiagnostic).toBeNull();
  });

  it("the error validates the navigation diagnostic at its own edge", () => {
    expect(
      new RenderedDocsError("NAVIGATION_FAILED", "x", null, null, "NAVIGATION_TIMEOUT")
        .navigationDiagnostic,
    ).toBe("NAVIGATION_TIMEOUT");
    for (const bad of ["nope", "EXECUTABLE_NOT_FOUND", "", 7]) {
      expect(
        new RenderedDocsError(
          "NAVIGATION_FAILED",
          "x",
          null,
          null,
          bad as "NAVIGATION_TIMEOUT",
        ).navigationDiagnostic,
      ).toBeNull();
    }
  });
});

describe("5. it survives the process boundary, re-checked", () => {
  const PARENT_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };
  function isolatedWith(stdout: string) {
    return createIsolatedRenderedDocsFetcher({
      spawnChild: (async () => ({ stdout, code: 0 })) as never,
      startProxy: (async () => ({ port: 44995, decisions: [], close: async () => {} })) as never,
      parentEnv: PARENT_ENV,
    });
  }

  it("NAVIGATION_FAILED is a reason the child may report", () => {
    expect(CHILD_REPORTABLE_RENDER_REASONS.has("NAVIGATION_FAILED")).toBe(true);
  });

  it("a valid navigation diagnostic arrives intact", async () => {
    for (const d of NAVIGATION_DIAGNOSTICS) {
      const f = isolatedWith(
        JSON.stringify({ ok: false, reason: "NAVIGATION_FAILED", navigationDetail: d }),
      );
      const e = (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
      expect(e.reason).toBe("NAVIGATION_FAILED");
      expect(e.navigationDiagnostic).toBe(d);
    }
  });

  it("an invalid one on the wire is dropped while the reason stands", async () => {
    for (const navigationDetail of [
      "MADE_UP",
      "navigation_timeout",
      `NAVIGATION_TIMEOUT ${SECRET}`,
      7,
      null,
      { d: "NAVIGATION_TIMEOUT" },
      "EXECUTABLE_NOT_FOUND",
    ]) {
      const f = isolatedWith(
        JSON.stringify({ ok: false, reason: "NAVIGATION_FAILED", navigationDetail }),
      );
      const e = (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
      expect(e.reason).toBe("NAVIGATION_FAILED");
      expect(e.navigationDiagnostic).toBeNull();
      expect(JSON.stringify({ m: e.message })).not.toContain(SECRET);
    }
  });
});
