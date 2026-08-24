import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_SHORTFALL_THRESHOLDS,
  evaluateRenderEligibility,
  navigationAllowed,
  pathWithinPrefix,
  resolvedHostAllowed,
  staticShortfallDetected,
  subresourceAllowed,
} from "../src/server/engine/rendered-docs-policy";
import {
  BROWSER_LOCKDOWN,
  DEFAULT_RENDER_LIMITS,
  RenderedDocsError,
  renderedDocsAvailable,
  resolveRenderedDocsFetcher,
  __setRenderedDocsFetcher,
  type RenderedDocsFetcher,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { createPlaywrightRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-playwright";
import type { ResolvedSourceRoute } from "../src/server/engine/source-authority";

// STAGE 1 — rendered OFFICIAL_DOCS retrieval. Entirely offline.
//
// No browser is launched anywhere in this file: the adapter is driven by
// an injected fake driver, and every allow/deny rule lives in the pure
// policy module so it can be tested directly rather than inferred from
// browser behaviour. What is functionally tested vs config-asserted is
// called out per test.
//
// Nothing is project-specific: all hosts below are invented.

const HOST = "docs.example-project.test";
const PREFIX = "/docs";
const URL_IN = `https://${HOST}/docs/fees`;

function route(over: Partial<ResolvedSourceRoute> = {}): ResolvedSourceRoute {
  return {
    officiality: "CONFIRMED",
    routeClass: "OFFICIAL_DOCS",
    observation: null,
    matchedPathPrefix: PREFIX,
    ...over,
  };
}

// The exact live measurement that justified Stage 1.
const SPA_SHELL = { staticHtmlBytes: 1_477_635, staticTextLength: 134 };
const READABLE_DOCS = { staticHtmlBytes: 180_000, staticTextLength: 9_400 };

function eligibility(over: Partial<Parameters<typeof evaluateRenderEligibility>[0]> = {}) {
  return evaluateRenderEligibility({
    url: URL_IN,
    route: route(),
    ...SPA_SHELL,
    rendererEnabled: true,
    ...over,
  });
}

describe("static shortfall trigger", () => {
  it("fires on the measured SPA shell", () => {
    expect(staticShortfallDetected(SPA_SHELL)).toBe(true);
  });

  it("does NOT fire on a normal readable docs page", () => {
    expect(staticShortfallDetected(READABLE_DOCS)).toBe(false);
  });

  it("does NOT fire on a genuinely small page with little text", () => {
    // Small HTML + short text is just a short page, not a shell.
    expect(staticShortfallDetected({ staticHtmlBytes: 3_000, staticTextLength: 120 })).toBe(false);
  });

  it("thresholds are code-owned and configurable", () => {
    expect(DEFAULT_SHORTFALL_THRESHOLDS).toEqual({ minHtmlBytes: 100_000, maxStaticTextLength: 500 });
    expect(
      staticShortfallDetected(READABLE_DOCS, { minHtmlBytes: 1_000, maxStaticTextLength: 100_000 }),
    ).toBe(true);
  });

  // THE test this whole stage turns on.
  it("uses PRE-recovery static text: Stage 0 output must not suppress rendering", () => {
    // Reproduces the authorized measurement exactly: static extraction was
    // 134 chars; Stage 0 then recovered 57,640 chars of CSS tokens, React
    // internals and schema.org boilerplate — no documentation.
    const staticTextLength = 134;
    const stage0RecoveredLength = 57_640;
    const mergedTextLength = 57_770;

    // Correct: judged on static text -> renderer eligible.
    expect(eligibility({ staticTextLength }).eligible).toBe(true);

    // The bug this guards: judging on merged text would read 57,770,
    // conclude the page is fine, and skip rendering the one page that
    // needs it.
    expect(
      staticShortfallDetected({
        staticHtmlBytes: SPA_SHELL.staticHtmlBytes,
        staticTextLength: mergedTextLength,
      }),
    ).toBe(false);
    expect(stage0RecoveredLength).toBeGreaterThan(staticTextLength); // fixture is faithful
  });
});

describe("trigger WIRING — the call site must pass static, not merged, text", () => {
  // The policy tests above prove the function honours what it is GIVEN.
  // They cannot prove the caller gives it the right value — and that is
  // precisely where this bug would live: s4-executor holds both
  // `staticTextLength` (pre-Stage-0) and `normalizedText` (post-Stage-0
  // merged), and passing the wrong one silently disables rendering on
  // every SPA shell while every other test stays green.
  it("s4-executor passes staticTextLength into evaluateRenderEligibility", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/s4-executor.ts", import.meta.url),
      "utf-8",
    );
    const call = /evaluateRenderEligibility\(\{[\s\S]*?\}\)/.exec(raw);
    expect(call, "evaluateRenderEligibility call site not found").toBeTruthy();
    const site = call![0];
    // Must read the pre-recovery measurement...
    expect(site).toContain("staticTextLength");
    // ...and must NOT pass merged text as the shortfall input. The only
    // permitted use of normalizedText.length here is the fallback for a
    // document that never ran Stage 0 (where merged === static).
    const shortfallLine = /staticTextLength:\s*([^,]+),/.exec(site);
    expect(shortfallLine, "staticTextLength argument not found").toBeTruthy();
    expect(shortfallLine![1]).toContain("staticTextLength");
  });
});

describe("render eligibility", () => {
  it("a confirmed path-scoped OFFICIAL_DOCS page with a shortfall is eligible", () => {
    const e = eligibility();
    expect(e.eligible).toBe(true);
    if (e.eligible) {
      expect(e.confirmedHost).toBe(HOST);
      expect(e.matchedPathPrefix).toBe(PREFIX);
    }
  });

  it("a confirmed domain WITHOUT a pathPrefix is denied", () => {
    expect(eligibility({ route: route({ matchedPathPrefix: null }) })).toMatchObject({
      eligible: false,
      reason: "NO_PATH_PREFIX",
    });
  });

  it("a same-domain page OUTSIDE the prefix is denied", () => {
    expect(eligibility({ url: `https://${HOST}/coin/abc` })).toMatchObject({
      eligible: false,
      reason: "URL_OUTSIDE_PREFIX",
    });
  });

  it("an unconfirmed route is denied", () => {
    expect(
      eligibility({ route: route({ officiality: "CLAIMED", routeClass: null, matchedPathPrefix: null }) }),
    ).toMatchObject({ eligible: false, reason: "NOT_CONFIRMED" });
  });

  it("an ordinary search candidate cannot invoke the renderer", () => {
    // What a search result actually looks like: CLAIMED, no class.
    expect(
      eligibility({
        url: "https://random-blog.test/docs/fees",
        route: { officiality: "CLAIMED", routeClass: null, observation: null, matchedPathPrefix: null },
      }),
    ).toMatchObject({ eligible: false });
  });

  it("a confirmed GOVERNANCE route is denied in v1", () => {
    expect(eligibility({ route: route({ routeClass: "GOVERNANCE" }) })).toMatchObject({
      eligible: false,
      reason: "NOT_OFFICIAL_DOCS",
    });
  });

  it("http is denied", () => {
    expect(eligibility({ url: `http://${HOST}/docs/fees` })).toMatchObject({
      eligible: false,
      reason: "NOT_HTTPS",
    });
  });

  it("a readable page is denied — static-first is enforced", () => {
    expect(eligibility({ ...READABLE_DOCS })).toMatchObject({
      eligible: false,
      reason: "NO_STATIC_SHORTFALL",
    });
  });

  it("a disabled renderer denies everything", () => {
    expect(eligibility({ rendererEnabled: false })).toMatchObject({
      eligible: false,
      reason: "RENDERER_DISABLED",
    });
  });

  it("prefix matching respects a segment boundary", () => {
    expect(pathWithinPrefix("/docs/fees", "/docs")).toBe(true);
    expect(pathWithinPrefix("/docs", "/docs")).toBe(true);
    expect(pathWithinPrefix("/docsomething", "/docs")).toBe(false);
  });
});

describe("network policy", () => {
  it("navigation is confined to the confirmed host and prefix over https", () => {
    expect(navigationAllowed(URL_IN, HOST, PREFIX)).toBe(true);
    expect(navigationAllowed(`https://${HOST}/coin/x`, HOST, PREFIX)).toBe(false);
    expect(navigationAllowed(`https://evil.test/docs/fees`, HOST, PREFIX)).toBe(false);
    expect(navigationAllowed(`http://${HOST}/docs/fees`, HOST, PREFIX)).toBe(false);
  });

  it("cross-origin subresources are blocked, including CDNs", () => {
    expect(subresourceAllowed(`https://${HOST}/_next/static/main.js`, HOST)).toBe("ALLOW");
    expect(subresourceAllowed("https://cdn.jsdelivr.test/lib.js", HOST)).toBe("BLOCK");
    expect(subresourceAllowed("https://fonts.googleapis.test/x.css", HOST)).toBe("BLOCK");
    expect(subresourceAllowed(`http://${HOST}/x.js`, HOST)).toBe("BLOCK");
  });

  it("subresources are host-scoped, not prefix-scoped, so framework bundles load", () => {
    // A /docs page legitimately fetches /_next/... from its own origin.
    expect(subresourceAllowed(`https://${HOST}/_next/static/chunk.js`, HOST)).toBe("ALLOW");
  });

  it("private, loopback, link-local and reserved destinations are refused", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "169.254.169.254", "172.16.0.1"]) {
      expect(await resolvedHostAllowed(host), host).toBe(false);
    }
  });

  it("an unresolvable host is refused rather than allowed (injected lookup, no DNS)", async () => {
    const failing = async () => { throw new Error("ENOTFOUND"); };
    expect(await resolvedHostAllowed("docs.example.test", failing)).toBe(false);
  });

  it("a public host resolving to a PRIVATE address is refused (DNS-rebinding shape)", async () => {
    const rebinds = async () => ({ address: "127.0.0.1" });
    expect(await resolvedHostAllowed("docs.example.test", rebinds)).toBe(false);
    const publicIp = async () => ({ address: "93.184.216.34" });
    expect(await resolvedHostAllowed("docs.example.test", publicIp)).toBe(true);
  });
});

describe("browser lockdown posture (config assertions)", () => {
  it("no user state, no downloads, no service workers, no permissions", () => {
    expect(BROWSER_LOCKDOWN.acceptDownloads).toBe(false);
    expect(BROWSER_LOCKDOWN.serviceWorkers).toBe("block");
    expect(BROWSER_LOCKDOWN.permissions).toEqual([]);
    expect(BROWSER_LOCKDOWN.storageState).toBeUndefined();
    expect(BROWSER_LOCKDOWN.geolocation).toBeUndefined();
    expect(BROWSER_LOCKDOWN.bypassCSP).toBe(false);
    expect(BROWSER_LOCKDOWN.ignoreHTTPSErrors).toBe(false);
    expect(BROWSER_LOCKDOWN.headless).toBe(true);
  });

  it("extensions and WebRTC are disabled at launch", () => {
    const args = BROWSER_LOCKDOWN.chromiumArgs.join(" ");
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("WebRTC");
  });

  it("the interface exposes no automation capability at all", () => {
    // Stronger than a policy promise: there is no method to call.
    const fetcher = createPlaywrightRenderedDocsFetcher({
      launchBrowser: async () => { throw new Error("not launched"); },
      hostAllowed: async () => true,
    });
    expect(Object.keys(fetcher).sort()).toEqual(["name", "render", "version"]);
    for (const forbidden of ["click", "fill", "type", "goto", "evaluate", "addScriptTag"]) {
      expect(fetcher).not.toHaveProperty(forbidden);
    }
    expect(BROWSER_LOCKDOWN.forbiddenCapabilities).toContain("click");
    expect(BROWSER_LOCKDOWN.forbiddenCapabilities).toContain("retry");
  });

  it("resource limits are bounded and allow exactly one navigation", () => {
    expect(DEFAULT_RENDER_LIMITS.maxNavigations).toBe(1);
    expect(DEFAULT_RENDER_LIMITS.navigationTimeoutMs).toBeLessThanOrEqual(15_000);
    expect(DEFAULT_RENDER_LIMITS.totalWallClockMs).toBeLessThanOrEqual(15_000);
    expect(DEFAULT_RENDER_LIMITS.maxRenderedTextLength).toBeGreaterThan(0);
    expect(DEFAULT_RENDER_LIMITS.maxTotalResponseBytes).toBeGreaterThan(0);
  });
});

// ---- adapter behaviour, driven by a fake browser (no binary) ----------

interface FakeOpts {
  finalUrl?: string;
  bodyText?: string;
  html?: string;
  gotoError?: Error;
}

function fakeBrowser(opts: FakeOpts = {}) {
  const state = {
    navigations: 0,
    routed: [] as string[],
    contextsClosed: 0,
    browsersClosed: 0,
    routeHandler: null as null | ((r: unknown) => Promise<void> | void),
  };
  const browser = {
    version: () => "fake/1.2.3",
    async newContext() {
      return {
        async newPage() {
          return {
            async goto(url: string) {
              state.navigations += 1;
              if (opts.gotoError) throw opts.gotoError;
              state.routed.push(url);
              return { status: () => 200 };
            },
            url: () => opts.finalUrl ?? URL_IN,
            content: async () => opts.html ?? "<html><body>rendered</body></html>",
            innerText: async () => opts.bodyText ?? "Fees are routed to the protocol vault.",
            on: () => {},
            close: async () => {},
          };
        },
        async close() { state.contextsClosed += 1; },
        async route(_p: string, handler: (r: unknown) => Promise<void> | void) {
          state.routeHandler = handler;
        },
      };
    },
    async close() { state.browsersClosed += 1; },
  };
  return { browser, state };
}

function fetcherWith(opts: FakeOpts = {}) {
  const { browser, state } = fakeBrowser(opts);
  const fetcher = createPlaywrightRenderedDocsFetcher({
    launchBrowser: async () => browser as never,
    // Stubbed: an offline suite must perform no DNS query.
    hostAllowed: async () => true,
  });
  return { fetcher, state };
}

const ROUTE = { confirmedHost: HOST, matchedPathPrefix: PREFIX };

describe("adapter behaviour (fake driver, no browser launched)", () => {
  it("renders one page and returns complete provenance", async () => {
    const { fetcher, state } = fetcherWith();
    const doc = await fetcher.render(URL_IN, ROUTE);

    expect(state.navigations).toBe(1); // exactly one navigation
    expect(doc.renderMode).toBe("RENDERED");
    expect(doc.rendererName).toBe("playwright-chromium");
    expect(doc.rendererVersion).toBeTruthy();
    expect(doc.browserVersion).toBe("fake/1.2.3");
    expect(doc.requestedUrl).toBe(URL_IN);
    expect(doc.finalUrl).toBe(URL_IN);
    expect(doc.confirmedRouteDomain).toBe(HOST);
    expect(doc.matchedPathPrefix).toBe(PREFIX);
    expect(doc.contentHash).toMatch(/^sha256:/);
    expect(doc.rawHtmlHash).toMatch(/^sha256:/);
    expect(doc.renderedTextLength).toBeGreaterThan(0);
    expect(doc.renderDurationMs).toBeGreaterThanOrEqual(0);
    expect(doc.fetchedAt).toBeInstanceOf(Date);
    expect(doc.normalizedText).toContain("Fees are routed to the protocol vault.");
  });

  it("a redirect OUTSIDE the prefix aborts and discards output", async () => {
    const { fetcher } = fetcherWith({ finalUrl: `https://${HOST}/coin/abc` });
    await expect(fetcher.render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "FINAL_URL_OUTSIDE_ROUTE",
    });
  });

  it("a redirect OUTSIDE the domain aborts and discards output", async () => {
    const { fetcher } = fetcherWith({ finalUrl: "https://evil.test/docs/fees" });
    await expect(fetcher.render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "FINAL_URL_OUTSIDE_ROUTE",
    });
  });

  it("an off-route request is refused before any browser is launched", async () => {
    let launched = false;
    const fetcher = createPlaywrightRenderedDocsFetcher({
      launchBrowser: async () => { launched = true; throw new Error("should not launch"); },
      hostAllowed: async () => true,
    });
    await expect(fetcher.render(`https://${HOST}/coin/x`, ROUTE)).rejects.toMatchObject({
      reason: "NAVIGATION_BLOCKED",
    });
    expect(launched).toBe(false);
  });

  it("the request filter blocks cross-origin and allows same-host", async () => {
    const { fetcher, state } = fetcherWith();
    await fetcher.render(URL_IN, ROUTE);
    expect(state.routeHandler).not.toBeNull();

    const decisions: string[] = [];
    const mkRoute = (url: string) => ({
      request: () => ({ url: () => url, resourceType: () => "script" }),
      abort: async () => { decisions.push(`BLOCK ${url}`); },
      continue: async () => { decisions.push(`ALLOW ${url}`); },
    });
    await state.routeHandler!(mkRoute(`https://${HOST}/_next/app.js`));
    await state.routeHandler!(mkRoute("https://cdn.evil.test/x.js"));
    expect(decisions[0]).toContain("ALLOW");
    expect(decisions[1]).toContain("BLOCK");
  });

  it("a render failure is fail-closed and leaks no page content or URL", async () => {
    const { fetcher } = fetcherWith({
      gotoError: new Error(`boom at ${URL_IN} secret-token-XYZ`),
    });
    const err = (await fetcher.render(URL_IN, ROUTE).catch((e) => e)) as RenderedDocsError;
    expect(err).toBeInstanceOf(RenderedDocsError);
    expect(err.reason).toBe("RENDER_FAILED");
    expect(err.message).not.toContain("secret-token-XYZ");
    expect(err.message).not.toContain(HOST);
  });

  it("context and browser are torn down after every render, success or failure", async () => {
    const ok = fetcherWith();
    await ok.fetcher.render(URL_IN, ROUTE);
    expect(ok.state.contextsClosed).toBe(1);
    expect(ok.state.browsersClosed).toBe(1);

    const bad = fetcherWith({ gotoError: new Error("x") });
    await bad.fetcher.render(URL_IN, ROUTE).catch(() => {});
    expect(bad.state.contextsClosed).toBe(1);
    expect(bad.state.browsersClosed).toBe(1);
  });

  it("there is no retry — one failed navigation is one attempt", async () => {
    const { fetcher, state } = fetcherWith({ gotoError: new Error("x") });
    await fetcher.render(URL_IN, ROUTE).catch(() => {});
    expect(state.navigations).toBe(1);
  });

  it("rendered text is capped", async () => {
    const { fetcher } = fetcherWith({ bodyText: "x".repeat(1_000_000) });
    const doc = await fetcher.render(URL_IN, ROUTE);
    expect(doc.normalizedText.length).toBe(DEFAULT_RENDER_LIMITS.maxRenderedTextLength);
  });
});

describe("resolver and admissibility", () => {
  const original = process.env.RENDERED_DOCS_ENABLED;
  beforeAll(() => { __setRenderedDocsFetcher(null); });
  afterAll(() => {
    __setRenderedDocsFetcher(null);
    if (original === undefined) delete process.env.RENDERED_DOCS_ENABLED;
    else process.env.RENDERED_DOCS_ENABLED = original;
  });

  it("an unconfigured environment throws rather than faking", () => {
    expect(renderedDocsAvailable()).toBe(false);
    expect(() => resolveRenderedDocsFetcher()).toThrow(RenderedDocsError);
  });

  it("a rendered document is FetchedDocument-compatible, so nothing downstream changes", async () => {
    const { fetcher } = fetcherWith();
    const doc = await fetcher.render(URL_IN, ROUTE);
    // The exact fields the existing extract/persist path reads.
    for (const field of [
      "finalUrl", "requestedUrl", "httpStatus", "contentType",
      "normalizedText", "contentHash", "fetchedAt", "byteLength",
    ]) {
      expect(doc, field).toHaveProperty(field);
    }
    expect(doc.contentType).toBe("text/html");
  });

  it("rendering carries no source class or officiality — admissibility is untouched", async () => {
    const { fetcher } = fetcherWith();
    const doc = await fetcher.render(URL_IN, ROUTE) as unknown as Record<string, unknown>;
    // Authority stays a code decision made later from the route, exactly
    // as for a static document. The renderer has no field to raise it.
    expect(doc.sourceClass).toBeUndefined();
    expect(doc.officiality).toBeUndefined();
    expect(doc.entityBinding).toBeUndefined();
  });

  it("a test override is the only way to obtain a fetcher", () => {
    const stub: RenderedDocsFetcher = {
      name: "stub", version: "0",
      render: async () => { throw new RenderedDocsError("RENDER_FAILED"); },
    };
    __setRenderedDocsFetcher(stub);
    expect(renderedDocsAvailable()).toBe(true);
    expect(resolveRenderedDocsFetcher()).toBe(stub);
    __setRenderedDocsFetcher(null);
  });
});

describe("generalization", () => {
  it("no project-specific literal appears in the Stage 1 modules", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/engine/rendered-docs-policy.ts",
      "../src/server/engine/providers/rendered-docs-fetcher.ts",
      "../src/server/engine/providers/rendered-docs-playwright.ts",
    ]) {
      const raw = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      const lower = raw.toLowerCase();
      for (const banned of ["pump", "solana", "buyback", "solscan", "etherscan"]) {
        expect(lower, `${path} contains "${banned}"`).not.toContain(banned);
      }
    }
  });
});
