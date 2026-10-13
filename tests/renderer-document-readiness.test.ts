import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RENDER_LIMITS,
  type RenderLimits,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import { createPlaywrightRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-playwright";
import {
  DEFAULT_SHORTFALL_THRESHOLDS,
  navigationAllowed,
  renderedDocumentUsable,
  resolvedHostAllowed,
  staticShortfallDetected,
  subresourceAllowed,
} from "../src/server/engine/rendered-docs-policy";

// DOCUMENT READINESS — entirely offline. No browser, no DNS, no network.
//
// `networkidle` used to be the navigation's success condition, which made
// an absence of traffic the sole proxy for "the document is ready". A
// documentation SPA holding a poll, socket or beacon open never reaches it,
// so a page whose document was perfectly usable failed as
// NAVIGATION_TIMEOUT. Readiness is now decided from the document itself.
//
// Nothing here is project-specific: every host is invented.

const HOST = "docs.example-project.test";
const PREFIX = "/docs";
const URL_IN = `https://${HOST}/docs/fees`;
const ROUTE = { confirmedHost: HOST, matchedPathPrefix: PREFIX };

// Substantial as a document, empty as text — the shape the shell rule
// exists to recognise.
const SHELL_HTML =
  "<html><body><div id=app></div>" + "<script>/*bundle*/</script>".repeat(4000) + "</body></html>";
const SMALL_HTML = "<html><body><p>Protocol fees are routed to the vault.</p></body></html>";
const REAL_TEXT = "Protocol fees are routed to the vault. ".repeat(30);

interface PageOpts {
  // Text returned by successive samples. The last entry repeats forever,
  // which is what makes a never-filling shell deterministic.
  textSamples: string[];
  html?: string;
  gotoThrows?: Error;
  finalUrls?: string[];
  status?: number;
  contentLength?: number;
}

function fakePage(opts: PageOpts) {
  let textCall = 0;
  let urlCall = 0;
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const page = {
    navigations: 0,
    async goto(_u: string, o: { waitUntil?: string; timeout?: number }) {
      page.navigations += 1;
      // A page holding a connection open NEVER reaches networkidle. Asking
      // for it is what used to fail; asking for domcontentloaded does not.
      if (o.waitUntil === "networkidle") {
        throw Object.assign(new Error("Timeout"), { name: "TimeoutError" });
      }
      if (opts.gotoThrows) throw opts.gotoThrows;
      if (opts.contentLength !== undefined && handlers.response) {
        handlers.response({
          headers: () => ({ "content-length": String(opts.contentLength) }),
        });
      }
      return { status: () => opts.status ?? 200 };
    },
    url: () => {
      const urls = opts.finalUrls ?? [URL_IN];
      return urls[Math.min(urlCall++, urls.length - 1)];
    },
    content: async () => opts.html ?? SHELL_HTML,
    innerText: async () => {
      const i = Math.min(textCall++, opts.textSamples.length - 1);
      return opts.textSamples[i];
    },
    on: (event: string, handler: (...a: unknown[]) => void) => {
      handlers[event] = handler;
    },
    close: async () => {},
  };
  return page;
}

function fetcherFor(page: ReturnType<typeof fakePage>, over: Partial<RenderLimits> = {}) {
  return createPlaywrightRenderedDocsFetcher({
    limits: {
      ...DEFAULT_RENDER_LIMITS,
      navigationTimeoutMs: 300,
      totalWallClockMs: 2_000,
      documentReadinessPollMs: 10,
      ...over,
    },
    launchBrowser: async () =>
      ({
        version: () => "fake/1",
        async newContext() {
          return { async newPage() { return page; }, async close() {}, async route() {} };
        },
        async close() {},
      }) as never,
    // Stubbed: this suite performs no DNS query.
    hostAllowed: async () => true,
  });
}

describe("the readiness predicate is the shell rule, not a second opinion", () => {
  it("4. huge HTML with tiny text is not usable", () => {
    expect(renderedDocumentUsable({ htmlBytes: 1_477_635, textLength: 134 })).toBe(false);
    // Same numbers, same verdict, through the rule it is built on.
    expect(
      staticShortfallDetected({ staticHtmlBytes: 1_477_635, staticTextLength: 134 }),
    ).toBe(true);
  });

  it("the same shell becomes usable once it holds real text", () => {
    expect(renderedDocumentUsable({ htmlBytes: 1_477_635, textLength: 9_400 })).toBe(true);
  });

  it("a genuinely short page is usable — shortness is not emptiness", () => {
    expect(renderedDocumentUsable({ htmlBytes: 3_000, textLength: 120 })).toBe(true);
  });

  it("a SHELL with no text is not usable; a genuinely empty small page still is", () => {
    expect(renderedDocumentUsable({ htmlBytes: 1_477_635, textLength: 0 })).toBe(false);
    // Deliberately NOT refused here. A 204 is inside the success class and
    // yields an empty document, which fails closed downstream because
    // extraction has nothing to quote. Readiness adds no second opinion on
    // a decision the system already makes — see rendered-page-http-status.
    expect(renderedDocumentUsable({ htmlBytes: 3_000, textLength: 0 })).toBe(true);
  });

  it("mutation check: the boundary is the code-owned threshold, not a hard-coded number", () => {
    const { maxStaticTextLength, minHtmlBytes } = DEFAULT_SHORTFALL_THRESHOLDS;
    expect(renderedDocumentUsable({ htmlBytes: minHtmlBytes, textLength: maxStaticTextLength - 1 })).toBe(false);
    expect(renderedDocumentUsable({ htmlBytes: minHtmlBytes, textLength: maxStaticTextLength })).toBe(true);
    // Below the html floor it is a short page, not a shell.
    expect(renderedDocumentUsable({ htmlBytes: minHtmlBytes - 1, textLength: 1 })).toBe(true);
  });
});

describe("CASE A — a valid SPA that never reaches networkidle", () => {
  it("1/2. succeeds without networkidle, and returns the meaningful content", async () => {
    const page = fakePage({ textSamples: ["", "", REAL_TEXT], html: SHELL_HTML });
    const doc = await fetcherFor(page).render(URL_IN, ROUTE);
    expect(doc.renderMode).toBe("RENDERED");
    expect(doc.normalizedText).toContain("Protocol fees are routed to the vault.");
    expect(doc.renderedTextLength).toBeGreaterThan(DEFAULT_SHORTFALL_THRESHOLDS.maxStaticTextLength);
    expect(page.navigations).toBe(1);
  });

  it("5. a conventional page that is ready immediately still succeeds, on the first sample", async () => {
    const page = fakePage({ textSamples: [REAL_TEXT], html: SMALL_HTML });
    const doc = await fetcherFor(page).render(URL_IN, ROUTE);
    expect(doc.normalizedText).toContain("Protocol fees are routed to the vault.");
    expect(page.navigations).toBe(1);
  });
});

describe("CASE B — a shell that never fills", () => {
  it("3/7. fails closed as DOCUMENT_NOT_READY, and never as NAVIGATION_TIMEOUT", async () => {
    const page = fakePage({ textSamples: [""], html: SHELL_HTML });
    await expect(fetcherFor(page, { totalWallClockMs: 300 }).render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "DOCUMENT_NOT_READY",
      navigationDiagnostic: null,
    });
  });

  it("mutation check: a shell that fills only AFTER the budget is still refused", async () => {
    // 40 empty samples at a 10ms interval outlast a 200ms document budget.
    const page = fakePage({ textSamples: [...Array(40).fill(""), REAL_TEXT], html: SHELL_HTML });
    await expect(
      fetcherFor(page, { totalWallClockMs: 200, documentReadinessPollMs: 10 }).render(URL_IN, ROUTE),
    ).rejects.toMatchObject({ reason: "DOCUMENT_NOT_READY" });
  });

  it("15. the wait is bounded by the DOCUMENT budget, not by a new one", async () => {
    const page = fakePage({ textSamples: [""], html: SHELL_HTML });
    const started = Date.now();
    await expect(
      fetcherFor(page, { totalWallClockMs: 300, documentReadinessPollMs: 10 }).render(URL_IN, ROUTE),
    ).rejects.toMatchObject({ reason: "DOCUMENT_NOT_READY" });
    // Comfortably inside the document budget plus scheduling slack, and
    // nowhere near an unbounded loop.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("the gates that must not weaken", () => {
  it("6. a stalled initial navigation is still NAVIGATION_TIMEOUT", async () => {
    const page = fakePage({
      textSamples: [REAL_TEXT],
      gotoThrows: Object.assign(new Error("Timeout"), { name: "TimeoutError" }),
    });
    await expect(fetcherFor(page).render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "NAVIGATION_FAILED",
      navigationDiagnostic: "NAVIGATION_TIMEOUT",
    });
  });

  it("8. HTTP 4xx/5xx still refuse BEFORE any content is read", async () => {
    for (const status of [403, 404, 500]) {
      const page = fakePage({ textSamples: [REAL_TEXT], html: SMALL_HTML, status });
      await expect(fetcherFor(page).render(URL_IN, ROUTE)).rejects.toMatchObject({
        reason: "HTTP_ERROR",
        httpStatus: status,
      });
    }
  });

  it("9. a final url outside the route is refused even with a perfect document", async () => {
    const page = fakePage({
      textSamples: [REAL_TEXT],
      html: SMALL_HTML,
      finalUrls: [`https://${HOST}/somewhere-else`],
    });
    await expect(fetcherFor(page).render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "FINAL_URL_OUTSIDE_ROUTE",
    });
  });

  it("9b. a url that leaves the route DURING the settle window is refused", async () => {
    // In-route while hydrating, out of route by the time it is readable.
    // The pre-settle check alone would have accepted this.
    const page = fakePage({
      textSamples: ["", REAL_TEXT],
      html: SHELL_HTML,
      finalUrls: [URL_IN, `https://${HOST}/somewhere-else`],
    });
    await expect(fetcherFor(page).render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "FINAL_URL_OUTSIDE_ROUTE",
    });
  });

  it("12. the byte cap still refuses before readiness is even considered", async () => {
    const page = fakePage({
      textSamples: [REAL_TEXT],
      html: SMALL_HTML,
      contentLength: DEFAULT_RENDER_LIMITS.maxTotalResponseBytes + 1,
    });
    await expect(fetcherFor(page).render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "TOO_LARGE",
    });
  });

  it("13/14. exactly one navigation, on success and on failure alike", async () => {
    const ok = fakePage({ textSamples: [REAL_TEXT], html: SMALL_HTML });
    await fetcherFor(ok).render(URL_IN, ROUTE);
    expect(ok.navigations).toBe(1);

    const bad = fakePage({ textSamples: [""], html: SHELL_HTML });
    await expect(fetcherFor(bad, { totalWallClockMs: 200 }).render(URL_IN, ROUTE)).rejects.toBeTruthy();
    expect(bad.navigations).toBe(1);
  });

  it("10/11. route containment and SSRF predicates are untouched", async () => {
    // Same predicates the render path and the route handler both use.
    expect(navigationAllowed(URL_IN, HOST, PREFIX)).toBe(true);
    expect(navigationAllowed(`https://${HOST}/other`, HOST, PREFIX)).toBe(false);
    expect(navigationAllowed(`https://evil.test/docs/fees`, HOST, PREFIX)).toBe(false);
    expect(navigationAllowed(`http://${HOST}/docs/fees`, HOST, PREFIX)).toBe(false);
    expect(subresourceAllowed(`https://cdn.other.test/x.js`, HOST)).toBe("BLOCK");
    expect(subresourceAllowed(`https://${HOST}/x.js`, HOST)).toBe("ALLOW");
    // Reserved ranges stay refused — resolution is stubbed nowhere here.
    await expect(resolvedHostAllowed("localhost")).resolves.toBe(false);
  });
});

describe("17. no site-specific knowledge entered the renderer", () => {
  it("the production render path names no project, host or selector", () => {
    for (const file of [
      "../src/server/engine/providers/rendered-docs-playwright.ts",
      "../src/server/engine/rendered-docs-policy.ts",
      "../src/server/engine/providers/rendered-docs-fetcher.ts",
    ]) {
      const code = readFileSync(new URL(file, import.meta.url), "utf-8")
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["raydium", "pump", "gitbook", "docusaurus", "__next", "#app", "solscan"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
    }
  });
});
