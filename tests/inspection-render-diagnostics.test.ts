import { describe, expect, it } from "vitest";

import {
  MAX_DESCRIBED_EGRESS_DECISIONS,
  describeEgressDecisions,
  summarizeEgressDenials,
  type EgressProxyHandle,
} from "../src/server/engine/providers/render-egress-proxy";
import {
  MAX_INSPECTION_BLOCKED_REQUESTS,
  RenderedDocsError,
  extractNetError,
  normalizeErrorName,
  sanitizeInspectionDiagnostics,
  sanitizeInspectionUrl,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { createPlaywrightRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-playwright";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";
import { evaluateInspectionEligibility } from "../src/server/engine/inspection-eligibility";
import { evaluateRenderEligibility } from "../src/server/engine/rendered-docs-policy";
import type { ResolvedSourceRoute } from "../src/server/engine/source-authority";

// A PROVEN OBSERVABILITY GAP, not a suspected one.
//
// An owner inspection of a CONFIRMED, unclassified route reached isolated
// rendering and came back with exactly three things:
//
//   NAVIGATION_FAILED:UNCLASSIFIED_NAVIGATION_ERROR
//   proxyDenials: 1 denied, 1 allowed
//   HOST_NOT_CONFIRMED = 1
//
// Every one of those is a closed code-owned code, and for an EVIDENTIARY
// render that is the correct posture: a renderer error must never echo a
// URL, a host or a provider message into logs or trace. Applied to owner
// inspection it left three hypotheses alive that one observation should
// have separated — was the confirmed host itself refused, or a third-party
// asset the page pulled? was the refused request the page's own navigation
// or a subresource? where did the navigation actually end up, and what did
// the browser actually report?
//
// The second probe could not close the gap either: the production renderer
// correctly refuses an unclassified route with NOT_ELIGIBLE_FOR_RENDER,
// which is authority working as designed and must not change.
//
// So the fix is DIAGNOSTIC ONLY, and opt-in at every layer. Inspection is
// a local, manual, non-evidentiary act performed by the owner on a URL
// they typed, against a host a human already confirmed and which the
// entrypoint already prints back to that same terminal. Nothing about what
// is rendered, allowed, blocked, retried or returned changes — and an
// evidentiary render keeps failing with a reason code and counts.

const HOST = "docs.inspection-diagnostics.test";
const PREFIX = "/token";
const URL_IN = `https://${HOST}/token/economics`;
const ROUTE = { confirmedHost: HOST, matchedPathPrefix: PREFIX };

// Planted wherever a value could leak, so a passing assertion is evidence
// rather than an appeal to the code reading correctly.
const SECRET = "sk-live-77XyZqPlMnBvCx";
const SECRET_QUERY = `?api_key=${SECRET}`;
const SECRET_ADDR = "10.11.12.13";
const CDN = "cdn.third-party.test";

interface FakeOpts {
  gotoError?: Error;
  // Requests the fake route handler is asked about while navigating.
  blocked?: { url: string; isNav: boolean; mainFrame: boolean }[];
  exposesFrameApi?: boolean;
  finalUrl?: string;
  inspectionDiagnostics?: boolean;
}

function fetcherWith(opts: FakeOpts = {}) {
  const state = { navigations: 0, aborted: 0, continued: 0 };
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
        state.aborted += 1;
      },
      continue: async () => {
        state.continued += 1;
      },
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
              for (const b of opts.blocked ?? []) {
                if (routeHandler) {
                  await routeHandler(makeRoute(b.url, b.mainFrame ? mainFrame : otherFrame, b.isNav));
                }
              }
              state.navigations += 1;
              if (opts.gotoError) throw opts.gotoError;
              return { status: () => 200 };
            },
            url: () => opts.finalUrl ?? URL_IN,
            content: async () => "<html><body>rendered document body</body></html>",
            innerText: async () => "Fees are routed to the protocol vault, and the vault buys back.",
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

  return {
    fetcher: createPlaywrightRenderedDocsFetcher({
      launchBrowser: async () => browser as never,
      hostAllowed: async () => true,
      ...(opts.inspectionDiagnostics === undefined
        ? {}
        : { inspectionDiagnostics: opts.inspectionDiagnostics }),
    }),
    state,
  };
}

// The message shape Chromium actually produces: the net:: code, the
// requested url, and a call log. Only the first may travel.
function chromiumNavError(code: string): Error {
  return new Error(
    `page.goto: ${code} at ${URL_IN}${SECRET_QUERY}\n` +
      `Call log:\n  - navigating to "${URL_IN}${SECRET_QUERY}", waiting until "domcontentloaded"\n`,
  );
}

async function failWith(opts: FakeOpts): Promise<RenderedDocsError> {
  const { fetcher } = fetcherWith(opts);
  return (await fetcher.render(URL_IN, ROUTE).catch((e: unknown) => e)) as RenderedDocsError;
}

// -----------------------------------------------------------------------
describe("1. the normalizers keep the diagnostic bounded at its source", () => {
  it("a browser message yields Chromium's own code and nothing around it", () => {
    const e = chromiumNavError("net::ERR_TUNNEL_CONNECTION_FAILED");
    expect(extractNetError(e)).toBe("net::ERR_TUNNEL_CONNECTION_FAILED");
    // The url, the query and the call log stay behind.
    expect(extractNetError(e)).not.toContain(SECRET);
    expect(extractNetError(e)).not.toContain(HOST);
    expect(extractNetError(e)).not.toContain("Call log");
  });

  it("the transport classes an operator must be able to tell apart all survive", () => {
    for (const code of [
      "net::ERR_TUNNEL_CONNECTION_FAILED",
      "net::ERR_CONNECTION_RESET",
      "net::ERR_CONNECTION_CLOSED",
      "net::ERR_SSL_PROTOCOL_ERROR",
      "net::ERR_EMPTY_RESPONSE",
      "net::ERR_ABORTED",
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_PROXY_CONNECTION_FAILED",
    ]) {
      expect(extractNetError(chromiumNavError(code))).toBe(code);
    }
  });

  it("a message with no net:: code yields nothing rather than a fragment of itself", () => {
    expect(extractNetError(new Error(`something went wrong at ${URL_IN}${SECRET_QUERY}`))).toBeNull();
    expect(extractNetError(null)).toBeNull();
    expect(extractNetError({ message: "net::ERR_FAKE" })).toBeNull();
  });

  it("only an identifier-shaped error CLASS travels, never a message wearing the name field", () => {
    const named = new Error("x");
    named.name = "TimeoutError";
    expect(normalizeErrorName(named)).toBe("TimeoutError");
    const hostile = new Error("x");
    hostile.name = `leak ${SECRET} http://${HOST}/p`;
    expect(normalizeErrorName(hostile)).toBeNull();
  });

  it("a url is reduced to origin and path — query and fragment are dropped by construction", () => {
    expect(sanitizeInspectionUrl(`https://${HOST}/token/economics${SECRET_QUERY}#frag`)).toBe(
      `https://${HOST}/token/economics`,
    );
    // The one value that says the navigation never committed.
    expect(sanitizeInspectionUrl("about:blank")).toBe("about:blank");
    // Credentials in the authority are dropped with the rest.
    expect(sanitizeInspectionUrl(`https://user:${SECRET}@${HOST}/a`)).toBe(`https://${HOST}/a`);
    for (const bad of ["file:///etc/passwd", "data:text/html,x", "", null, 42, "not a url"]) {
      expect(sanitizeInspectionUrl(bad)).toBeNull();
    }
  });

  it("the proxy description carries host and port, and never the raw target or address", () => {
    const decisions = [
      { target: `${CDN}:443`, allowed: false, reason: "HOST_NOT_CONFIRMED" },
      { target: `${HOST}:443`, allowed: true, address: SECRET_ADDR },
      { target: "http-request", allowed: false, reason: "NOT_HTTPS" },
    ] as never as EgressProxyHandle["decisions"];
    const d = describeEgressDecisions(decisions);
    expect(d.truncated).toBe(false);
    expect(d.decisions[0]).toEqual({
      host: CDN,
      port: 443,
      allowed: false,
      reason: "HOST_NOT_CONFIRMED",
    });
    expect(d.decisions[1]).toEqual({ host: HOST, port: 443, allowed: true, reason: null });
    // A non-CONNECT record has no host to report, and does not invent one.
    expect(d.decisions[2]).toEqual({ host: null, port: null, allowed: false, reason: "NOT_HTTPS" });
    // The resolved address is the field that could name a private
    // destination. It has nowhere to go.
    expect(JSON.stringify(d)).not.toContain(SECRET_ADDR);
  });

  it("an unrecognised denial reason and a junk host are dropped, never printed", () => {
    const d = describeEgressDecisions([
      { target: `${SECRET}:443`, allowed: false, reason: SECRET },
    ] as never);
    expect(d.decisions[0].reason).toBeNull();
    // "sk-live-..." is host-shaped, so it survives the charset test; what
    // matters is that a REASON never becomes free text.
    expect(d.decisions[0].allowed).toBe(false);
    // A value that is not host-shaped is dropped to null rather than
    // printed: it is not a host, and echoing it would be echoing whatever
    // the browser sent.
    const junk = describeEgressDecisions([
      { target: "HOST WITH SPACES:443", allowed: false, reason: "DNS_FAILED" },
    ] as never);
    expect(junk.decisions[0].host).toBeNull();
    expect(junk.decisions[0].port).toBe(443);
    expect(junk.decisions[0].reason).toBe("DNS_FAILED");
  });

  it("both lists are hard-capped, and truncation is stated rather than silent", () => {
    const many = Array.from({ length: MAX_DESCRIBED_EGRESS_DECISIONS + 5 }, () => ({
      target: `${CDN}:443`,
      allowed: false,
      reason: "HOST_NOT_CONFIRMED" as const,
    }));
    const d = describeEgressDecisions(many as never);
    expect(d.decisions.length).toBe(MAX_DESCRIBED_EGRESS_DECISIONS);
    expect(d.truncated).toBe(true);

    const s = sanitizeInspectionDiagnostics({
      blockedRequests: Array.from({ length: MAX_INSPECTION_BLOCKED_REQUESTS + 3 }, () => ({
        origin: `https://${CDN}`,
      })),
    });
    expect(s?.blockedRequests.length).toBe(MAX_INSPECTION_BLOCKED_REQUESTS);
    expect(s?.blockedRequestsTruncated).toBe(true);
  });

  it("the error REBUILDS the block rather than adopting it", () => {
    const hostile = {
      requestedUrl: `https://${HOST}/a${SECRET_QUERY}`,
      finalUrl: `https://${HOST}/b#${SECRET}`,
      navigationErrorName: `Error ${SECRET}`,
      navigationNetError: `net::ERR_X ${SECRET}`,
      blockedRequests: [
        { origin: `https://${CDN}/path${SECRET_QUERY}`, resourceType: SECRET, navigationRequest: "yes" },
      ],
      egressDecisions: [{ host: HOST, port: 443, allowed: true, reason: SECRET, address: SECRET_ADDR }],
      pageHtml: "<html>secret body</html>",
      cookies: SECRET,
      headers: { authorization: `Bearer ${SECRET}` },
    } as never;
    const e = new RenderedDocsError("NAVIGATION_FAILED", "iso", null, null, null, null, hostile);
    const json = JSON.stringify(e.inspection);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(SECRET_ADDR);
    expect(json).not.toContain("secret body");
    // Extra keys have nowhere to land.
    expect(Object.keys(e.inspection!).sort()).toEqual([
      "blockedRequests",
      "blockedRequestsTruncated",
      "egressDecisions",
      "egressDecisionsTruncated",
      "finalUrl",
      "navigationErrorName",
      "navigationNetError",
      "requestedUrl",
    ]);
    // The legitimate parts survive, reduced.
    expect(e.inspection!.requestedUrl).toBe(`https://${HOST}/a`);
    expect(e.inspection!.finalUrl).toBe(`https://${HOST}/b`);
    expect(e.inspection!.navigationErrorName).toBeNull();
    expect(e.inspection!.navigationNetError).toBeNull();
    expect(e.inspection!.blockedRequests[0].origin).toBe(`https://${CDN}`);
    expect(e.inspection!.blockedRequests[0].resourceType).toBeNull();
    expect(e.inspection!.blockedRequests[0].navigationRequest).toBe(false);
    expect(Object.keys(e.inspection!.egressDecisions[0]).sort()).toEqual([
      "allowed",
      "host",
      "port",
      "reason",
    ]);
  });
});

// -----------------------------------------------------------------------
describe("2. the failure the gap was about is now explained", () => {
  it("UNCLASSIFIED_NAVIGATION_ERROR now says WHICH transport failure it was", async () => {
    const e = await failWith({
      inspectionDiagnostics: true,
      gotoError: chromiumNavError("net::ERR_TUNNEL_CONNECTION_FAILED"),
      finalUrl: "about:blank",
    });
    // The existing classification is untouched — this adds, never replaces.
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
    // 1. the browser's own error class and normalized code
    expect(e.inspection?.navigationErrorName).toBe("Error");
    expect(e.inspection?.navigationNetError).toBe("net::ERR_TUNNEL_CONNECTION_FAILED");
    // 2. what we asked to open, and 3. where it actually ended up
    expect(e.inspection?.requestedUrl).toBe(URL_IN);
    expect(e.inspection?.finalUrl).toBe("about:blank");
    // The message that carried all of it never travels.
    expect(JSON.stringify(e.inspection)).not.toContain(SECRET);
    expect(JSON.stringify(e.inspection)).not.toContain("Call log");
  });

  it("a refused request is attributed to the main frame or to a subresource", async () => {
    const e = await failWith({
      inspectionDiagnostics: true,
      gotoError: chromiumNavError("net::ERR_ABORTED"),
      blocked: [
        // The page's OWN navigation, redirected off the confirmed host.
        { url: `https://${CDN}/redirected${SECRET_QUERY}`, isNav: true, mainFrame: true },
        // A third-party asset — a completely different diagnosis.
        { url: `https://${CDN}/analytics.js${SECRET_QUERY}`, isNav: false, mainFrame: false },
      ],
    });
    // Our own containment outranks the browser's report of it, unchanged.
    expect(e.navigationDiagnostic).toBe("BLOCKED_BY_ROUTE_POLICY");
    const blocked = e.inspection!.blockedRequests;
    expect(blocked.length).toBe(2);
    // 4. which host was refused — origin only, never the path or query.
    expect(blocked[0].origin).toBe(`https://${CDN}`);
    // 5. main-frame document navigation versus subresource.
    expect(blocked[0].navigationRequest).toBe(true);
    expect(blocked[0].mainFrame).toBe(true);
    expect(blocked[0].resourceType).toBe("document");
    expect(blocked[1].navigationRequest).toBe(false);
    expect(blocked[1].mainFrame).toBe(false);
    expect(blocked[1].resourceType).toBe("script");
    expect(JSON.stringify(e.inspection)).not.toContain(SECRET);
  });

  it("a driver that cannot PROVE frame attribution reports false, not a guess", async () => {
    const e = await failWith({
      inspectionDiagnostics: true,
      exposesFrameApi: false,
      gotoError: chromiumNavError("net::ERR_ABORTED"),
      blocked: [{ url: `https://${CDN}/x`, isNav: true, mainFrame: true }],
    });
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
    expect(e.inspection?.blockedRequests[0].navigationRequest).toBe(false);
    expect(e.inspection?.blockedRequests[0].mainFrame).toBe(false);
  });

  it("every render-stage failure after launch carries it, not only navigation", async () => {
    // A landing outside the confirmed route: a different stage entirely,
    // and the operator needs the final url most of all here.
    const e = await failWith({
      inspectionDiagnostics: true,
      finalUrl: `https://${CDN}/elsewhere${SECRET_QUERY}`,
    });
    expect(e.reason).toBe("FINAL_URL_OUTSIDE_ROUTE");
    expect(e.inspection?.finalUrl).toBe(`https://${CDN}/elsewhere`);
    // Not a navigation throw, so there is no browser error to report.
    expect(e.inspection?.navigationNetError).toBeNull();
    expect(JSON.stringify(e.inspection)).not.toContain(SECRET);
  });

  it("the supervisor joins the two witnesses: the browser's, and the proxy's own log", async () => {
    const decisions = [
      { target: `${CDN}:443`, allowed: false, reason: "HOST_NOT_CONFIRMED" as const },
      { target: `${HOST}:443`, allowed: true },
    ];
    const fetcher = createIsolatedRenderedDocsFetcher({
      inspectionDiagnostics: true,
      parentEnv: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      startProxy: (async () => ({ port: 44998, decisions, close: async () => {} })) as never,
      spawnChild: (async () => ({
        code: 0,
        stdout: JSON.stringify({
          ok: false,
          reason: "NAVIGATION_FAILED",
          navigationDetail: "UNCLASSIFIED_NAVIGATION_ERROR",
          inspection: {
            // The child echoes its own url; the parent overwrites it with
            // the value THIS process owns.
            requestedUrl: `https://${CDN}/child-said-this`,
            finalUrl: "about:blank",
            navigationErrorName: "Error",
            navigationNetError: "net::ERR_TUNNEL_CONNECTION_FAILED",
            blockedRequests: [],
            blockedRequestsTruncated: false,
            egressDecisions: [],
            egressDecisionsTruncated: false,
          },
        }),
      })) as never,
    });
    const e = (await fetcher.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
    expect(e.reason).toBe("NAVIGATION_FAILED");
    // The counts are still there, unchanged, beside the description.
    expect(e.proxyDenials?.denials.HOST_NOT_CONFIRMED).toBe(1);
    expect(e.proxyDenials?.allowedCount).toBe(1);
    // 6. the closed denial reason, now WITH the host it applied to — the
    // single fact "1 denied, 1 allowed" could not express.
    expect(e.inspection?.egressDecisions).toEqual([
      { host: CDN, port: 443, allowed: false, reason: "HOST_NOT_CONFIRMED" },
      { host: HOST, port: 443, allowed: true, reason: null },
    ]);
    // The browser's half survived the process boundary.
    expect(e.inspection?.navigationNetError).toBe("net::ERR_TUNNEL_CONNECTION_FAILED");
    expect(e.inspection?.finalUrl).toBe("about:blank");
    // The parent owns the requested url; the child's echo is discarded.
    expect(e.inspection?.requestedUrl).toBe(URL_IN);
  });
});

// -----------------------------------------------------------------------
describe("3. ordinary production renderer behaviour is unchanged", () => {
  it("a successful render is byte-identical whether or not diagnostics were asked for", async () => {
    const off = await fetcherWith({}).fetcher.render(URL_IN, ROUTE);
    const on = await fetcherWith({ inspectionDiagnostics: true }).fetcher.render(URL_IN, ROUTE);
    // Only the two wall-clock measurements are expected to differ.
    const strip = (d: Record<string, unknown>) => {
      const rest = { ...d };
      delete rest.fetchedAt;
      delete rest.renderDurationMs;
      return rest;
    };
    expect(strip(on as never)).toEqual(strip(off as never));
    // And no diagnostic field was smuggled onto the document.
    expect(Object.keys(on)).not.toContain("inspection");
  });

  it("the same requests are blocked and allowed either way", async () => {
    const blocked = [
      { url: `https://${CDN}/a.js`, isNav: false, mainFrame: false },
      { url: `https://${HOST}/token/ok.js`, isNav: false, mainFrame: false },
    ];
    const off = fetcherWith({ blocked });
    await off.fetcher.render(URL_IN, ROUTE);
    const on = fetcherWith({ blocked, inspectionDiagnostics: true });
    await on.fetcher.render(URL_IN, ROUTE);
    expect(on.state).toEqual(off.state);
    expect(off.state.aborted).toBe(1);
    expect(off.state.continued).toBe(1);
    expect(off.state.navigations).toBe(1);
  });

  it("with diagnostics OFF, a failure carries exactly what it carried before: null", async () => {
    for (const opts of [
      { gotoError: chromiumNavError("net::ERR_TUNNEL_CONNECTION_FAILED") },
      { finalUrl: `https://${CDN}/elsewhere` },
      {
        gotoError: chromiumNavError("net::ERR_ABORTED"),
        blocked: [{ url: `https://${CDN}/x`, isNav: true, mainFrame: true }],
      },
    ]) {
      const e = await failWith(opts);
      expect(e).toBeInstanceOf(RenderedDocsError);
      expect(e.inspection).toBeNull();
      // The classification is what it always was.
      expect(typeof e.reason).toBe("string");
    }
  });

  it("classification is identical with the flag on and off", async () => {
    const cases: FakeOpts[] = [
      { gotoError: chromiumNavError("net::ERR_CONNECTION_RESET") },
      { finalUrl: `https://${CDN}/elsewhere` },
      {
        gotoError: chromiumNavError("net::ERR_ABORTED"),
        blocked: [{ url: `https://${CDN}/x`, isNav: true, mainFrame: true }],
      },
    ];
    for (const c of cases) {
      const off = await failWith(c);
      const on = await failWith({ ...c, inspectionDiagnostics: true });
      expect(on.reason).toBe(off.reason);
      expect(on.navigationDiagnostic).toBe(off.navigationDiagnostic);
      expect(on.diagnostic).toBe(off.diagnostic);
      expect(on.httpStatus).toBe(off.httpStatus);
    }
  });

  it("a child cannot attach a description to a supervisor that did not ask", async () => {
    // THE LOAD-BEARING GATE. A compromised or simply newer child putting
    // the key on the wire must not give an evidentiary render a URL-
    // carrying diagnostic.
    const fetcher = createIsolatedRenderedDocsFetcher({
      parentEnv: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      startProxy: (async () => ({
        port: 44999,
        decisions: [{ target: `${CDN}:443`, allowed: false, reason: "HOST_NOT_CONFIRMED" }],
        close: async () => {},
      })) as never,
      spawnChild: (async () => ({
        code: 0,
        stdout: JSON.stringify({
          ok: false,
          reason: "NAVIGATION_FAILED",
          navigationDetail: "UNCLASSIFIED_NAVIGATION_ERROR",
          inspection: {
            requestedUrl: `https://${HOST}/x${SECRET_QUERY}`,
            finalUrl: `https://${CDN}/y`,
            navigationNetError: "net::ERR_TUNNEL_CONNECTION_FAILED",
          },
        }),
      })) as never,
    });
    const e = (await fetcher.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
    // The counts still arrive — that behaviour is untouched.
    expect(e.proxyDenials?.denials.HOST_NOT_CONFIRMED).toBe(1);
    // And nothing wider does.
    expect(e.inspection).toBeNull();
    expect(JSON.stringify({ r: e.reason, p: e.proxyDenials, i: e.inspection })).not.toContain(CDN);
  });

  it("withProxyDenials still preserves every other classification, description included", () => {
    const before = new RenderedDocsError("NAVIGATION_FAILED", "iso", null, null, "NAVIGATION_TIMEOUT");
    const after = before.withProxyDenials(summarizeEgressDenials([]));
    expect(after.reason).toBe("NAVIGATION_FAILED");
    expect(after.navigationDiagnostic).toBe("NAVIGATION_TIMEOUT");
    expect(after.inspection).toBeNull();
    const described = after.withInspectionDiagnostics({
      requestedUrl: URL_IN,
      finalUrl: "about:blank",
      navigationErrorName: "TimeoutError",
      navigationNetError: null,
      blockedRequests: [],
      blockedRequestsTruncated: false,
      egressDecisions: [],
      egressDecisionsTruncated: false,
    });
    expect(described.reason).toBe("NAVIGATION_FAILED");
    expect(described.navigationDiagnostic).toBe("NAVIGATION_TIMEOUT");
    expect(described.proxyDenials?.deniedCount).toBe(0);
    expect(described.inspection?.finalUrl).toBe("about:blank");
    // Round-tripping through denials again does not lose it.
    expect(described.withProxyDenials(null).inspection?.finalUrl).toBe("about:blank");
  });

  it("no production acquisition path asks for inspection diagnostics", async () => {
    const fs = await import("node:fs/promises");
    async function walk(dir: URL): Promise<{ name: string; text: string }[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: { name: string; text: string }[] = [];
      for (const e of entries) {
        const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
        if (e.isDirectory()) out.push(...(await walk(child)));
        else if (e.name.endsWith(".ts")) {
          out.push({ name: child.pathname, text: await fs.readFile(child, "utf-8") });
        }
      }
      return out;
    }
    // The flag may be DEFINED inside the renderer provider modules; it may
    // not be SET anywhere under src/.
    for (const f of await walk(new URL("../src/", import.meta.url))) {
      expect(f.text, `${f.name} enables inspection diagnostics`).not.toContain(
        "inspectionDiagnostics: true",
      );
    }
    // And exactly one entrypoint sets it.
    const scripts = await walk(new URL("../scripts/", import.meta.url));
    const setters = scripts.filter((f) => f.text.includes("inspectionDiagnostics: true"));
    expect(setters.map((f) => f.name.split("/").pop())).toEqual(["inspect-official-page.ts"]);
  });
});

// -----------------------------------------------------------------------
describe("4. authority rules are unchanged", () => {
  const route = (over: Partial<ResolvedSourceRoute> = {}): ResolvedSourceRoute =>
    ({
      officiality: "CONFIRMED",
      routeClass: null,
      matchedPathPrefix: PREFIX,
      ...over,
    }) as ResolvedSourceRoute;

  it("inspection still requires CONFIRMED, a path prefix, https and NO class", () => {
    expect(evaluateInspectionEligibility(URL_IN, route()).eligible).toBe(true);
    expect(evaluateInspectionEligibility(URL_IN, route({ officiality: "UNKNOWN" as never }))).toEqual({
      eligible: false,
      reason: "NOT_CONFIRMED",
    });
    expect(evaluateInspectionEligibility(URL_IN, route({ matchedPathPrefix: null }))).toEqual({
      eligible: false,
      reason: "NO_PATH_PREFIX",
    });
    expect(
      evaluateInspectionEligibility(URL_IN, route({ routeClass: "OFFICIAL_DOCS" as never })),
    ).toEqual({ eligible: false, reason: "ALREADY_CLASSIFIED" });
    expect(evaluateInspectionEligibility(`http://${HOST}/token`, route())).toEqual({
      eligible: false,
      reason: "NOT_CONFIRMED",
    });
  });

  it("the production render gate still refuses an unclassified route", () => {
    // This is the refusal the second probe hit, and it is CORRECT. The
    // diagnostic change must not have turned inspection into a second,
    // looser route into the evidentiary renderer.
    const d = evaluateRenderEligibility({
      url: URL_IN,
      route: route(),
      staticTextLength: 0,
      staticHtmlBytes: 100,
    } as never);
    expect(d.eligible).toBe(false);
  });

  it("inspection and documentation remain MUTUALLY EXCLUSIVE", () => {
    for (const routeClass of [null, "OFFICIAL_DOCS", "GOVERNANCE"]) {
      const r = route({ routeClass: routeClass as never });
      const insp = evaluateInspectionEligibility(URL_IN, r).eligible;
      const rend = evaluateRenderEligibility({
        url: URL_IN,
        route: r,
        staticTextLength: 0,
        staticHtmlBytes: 100,
      } as never).eligible;
      expect(insp && rend).toBe(false);
    }
  });

  it("no authority module knows the diagnostic flag exists", async () => {
    const fs = await import("node:fs/promises");
    for (const m of [
      "../src/server/engine/inspection-eligibility.ts",
      "../src/server/engine/source-authority.ts",
      "../src/server/engine/rendered-docs-policy.ts",
    ]) {
      const text = await fs.readFile(new URL(m, import.meta.url), "utf-8");
      expect(text, `${m} mentions the diagnostic flag`).not.toContain("inspectionDiagnostics");
      expect(text).not.toContain("navigationNetError");
    }
  });
});
