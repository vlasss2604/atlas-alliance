import { describe, expect, it } from "vitest";

import {
  DEFAULT_RENDER_LIMITS,
  ISOLATION_ENVELOPE_ALLOWANCE_MS,
  isolatedChildDeadlineMs,
  type RenderLimits,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import {
  chromiumLaunchOptions,
  createPlaywrightRenderedDocsFetcher,
} from "../src/server/engine/providers/rendered-docs-playwright";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";

// RENDERER PHASE BUDGETS — entirely offline. No browser, no DNS, no network.
//
// Browser STARTUP and DOCUMENT work are two phases with two budgets. This
// file pins the boundary between them, because it was previously absent:
// the document budget was measured from before launch, so startup spent
// the navigation's allowance and a COMPLETED navigation could be discarded
// as TIMEOUT.
//
// Nothing here is project-specific: every host is invented.

const HOST = "docs.example-project.test";
const PREFIX = "/docs";
const URL_IN = `https://${HOST}/docs/fees`;
const ROUTE = { confirmedHost: HOST, matchedPathPrefix: PREFIX };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Deterministic in the direction that matters: setTimeout guarantees AT
// LEAST the delay, so "launch outlasts the document budget" cannot flake
// into being false.
const SLOW_LAUNCH_MS = 150;
const DOC_BUDGET_MS = 100;

interface FakeOpts {
  gotoError?: Error;
  gotoDelayMs?: number;
  finalUrl?: string;
  status?: number;
  launchDelayMs?: number;
  limits?: RenderLimits;
}

function fakeBrowser(opts: FakeOpts = {}) {
  return {
    version: () => "fake/1.2.3",
    async newContext() {
      return {
        async newPage() {
          return {
            async goto() {
              if (opts.gotoDelayMs) await delay(opts.gotoDelayMs);
              if (opts.gotoError) throw opts.gotoError;
              return { status: () => opts.status ?? 200 };
            },
            url: () => opts.finalUrl ?? URL_IN,
            content: async () => "<html><body>rendered</body></html>",
            innerText: async () => "Protocol fees are routed to the vault.",
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
}

function fetcherWith(opts: FakeOpts = {}) {
  const browser = fakeBrowser(opts);
  return createPlaywrightRenderedDocsFetcher({
    limits: opts.limits ?? {
      ...DEFAULT_RENDER_LIMITS,
      navigationTimeoutMs: DOC_BUDGET_MS,
      totalWallClockMs: DOC_BUDGET_MS,
    },
    launchBrowser: async () => {
      if (opts.launchDelayMs) await delay(opts.launchDelayMs);
      return browser as never;
    },
    // Stubbed: this suite must perform no DNS query.
    hostAllowed: async () => true,
  });
}

describe("phase boundary: startup does not spend the document budget", () => {
  // THE REGRESSION. Launch alone outlasts the entire document budget, and
  // the navigation then completes comfortably inside its own timeout.
  // Before the fix this returned TIMEOUT and the document was discarded.
  it("1/2. a successful navigation survives startup overhead longer than the document budget", async () => {
    const doc = await fetcherWith({ launchDelayMs: SLOW_LAUNCH_MS }).render(URL_IN, ROUTE);
    expect(doc.renderMode).toBe("RENDERED");
    expect(doc.normalizedText).toContain("Protocol fees are routed to the vault.");
  });

  it("the reported render duration still covers the WHOLE render, launch included", async () => {
    const doc = await fetcherWith({ launchDelayMs: SLOW_LAUNCH_MS }).render(URL_IN, ROUTE);
    // Unchanged meaning: an operator reading this wants wall time spent,
    // not the post-launch remainder.
    expect(doc.renderDurationMs).toBeGreaterThanOrEqual(SLOW_LAUNCH_MS);
  });

  it("4. document work that genuinely outruns its own budget is still TIMEOUT", async () => {
    // Navigation takes longer than the document budget but less than its
    // own timeout, so goto SUCCEEDS and the post-navigation wall-clock
    // check is what rejects it.
    await expect(
      fetcherWith({
        launchDelayMs: 0,
        gotoDelayMs: 150,
        limits: {
          ...DEFAULT_RENDER_LIMITS,
          navigationTimeoutMs: 5_000,
          totalWallClockMs: DOC_BUDGET_MS,
        },
      }).render(URL_IN, ROUTE),
    ).rejects.toMatchObject({ reason: "TIMEOUT" });
  });

  it("mutation check: the guard measures the document phase, not the whole render", async () => {
    // Comparable elapsed time in both runs; only WHERE it is spent differs.
    // A guard still measuring from before launch would fail the first.
    await expect(
      fetcherWith({ launchDelayMs: SLOW_LAUNCH_MS, gotoDelayMs: 0 }).render(URL_IN, ROUTE),
    ).resolves.toBeTruthy();

    await expect(
      fetcherWith({
        launchDelayMs: 0,
        gotoDelayMs: SLOW_LAUNCH_MS,
        limits: {
          ...DEFAULT_RENDER_LIMITS,
          navigationTimeoutMs: 5_000,
          totalWallClockMs: DOC_BUDGET_MS,
        },
      }).render(URL_IN, ROUTE),
    ).rejects.toMatchObject({ reason: "TIMEOUT" });
  });
});

describe("failure stages stay distinguishable", () => {
  it("3. a genuine goto timeout is still NAVIGATION_FAILED:NAVIGATION_TIMEOUT", async () => {
    const timeoutError = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    await expect(
      fetcherWith({ launchDelayMs: SLOW_LAUNCH_MS, gotoError: timeoutError }).render(URL_IN, ROUTE),
    ).rejects.toMatchObject({
      reason: "NAVIGATION_FAILED",
      navigationDiagnostic: "NAVIGATION_TIMEOUT",
    });
  });

  it("8. BROWSER_LAUNCH_FAILED semantics unchanged", async () => {
    const fetcher = createPlaywrightRenderedDocsFetcher({
      launchBrowser: async () => {
        throw new Error("Executable doesn't exist at /nowhere/chrome");
      },
      hostAllowed: async () => true,
    });
    await expect(fetcher.render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "BROWSER_LAUNCH_FAILED",
    });
  });

  it("9. HTTP_ERROR semantics unchanged", async () => {
    await expect(
      fetcherWith({ launchDelayMs: SLOW_LAUNCH_MS, status: 403 }).render(URL_IN, ROUTE),
    ).rejects.toMatchObject({ reason: "HTTP_ERROR", httpStatus: 403 });
  });

  it("10. FINAL_URL_OUTSIDE_ROUTE unchanged", async () => {
    await expect(
      fetcherWith({
        launchDelayMs: SLOW_LAUNCH_MS,
        finalUrl: `https://${HOST}/somewhere-else`,
      }).render(URL_IN, ROUTE),
    ).rejects.toMatchObject({ reason: "FINAL_URL_OUTSIDE_ROUTE" });
  });

  it("12. exactly one navigation happens — no retry was introduced", async () => {
    let navigations = 0;
    const fetcher = createPlaywrightRenderedDocsFetcher({
      limits: { ...DEFAULT_RENDER_LIMITS, navigationTimeoutMs: 50, totalWallClockMs: 50 },
      launchBrowser: async () =>
        ({
          version: () => "fake/1",
          async newContext() {
            return {
              async newPage() {
                return {
                  async goto() {
                    navigations += 1;
                    throw Object.assign(new Error("t"), { name: "TimeoutError" });
                  },
                  url: () => URL_IN,
                  content: async () => "",
                  innerText: async () => "",
                  on: () => {},
                  close: async () => {},
                };
              },
              async close() {},
              async route() {},
            };
          },
          async close() {},
        }) as never,
      hostAllowed: async () => true,
    });
    await expect(fetcher.render(URL_IN, ROUTE)).rejects.toMatchObject({
      reason: "NAVIGATION_FAILED",
    });
    expect(navigations).toBe(1);
  });
});

describe("5. browser startup is bounded, by a code-owned value", () => {
  it("the launch budget exists, is positive, and is not a grace period", () => {
    expect(DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs).toBeGreaterThan(0);
    // Tighter than Playwright's own 30s default: this ADDS a bound where
    // the code previously delegated to an undeclared one.
    expect(DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs).toBeLessThan(30_000);
  });

  it("the launch options actually carry the budget to the driver", () => {
    const opts = chromiumLaunchOptions(undefined, DEFAULT_RENDER_LIMITS);
    expect(opts.timeout).toBe(DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs);
    expect(opts.headless).toBe(true);
  });

  it("the proxy arguments are still applied alongside it", () => {
    const opts = chromiumLaunchOptions(45123, DEFAULT_RENDER_LIMITS);
    expect(opts.args.join(" ")).toContain("45123");
    expect(opts.timeout).toBe(DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs);
  });
});

describe("6/7. the parent supervisor stays bounded AND coherent", () => {
  it("the deadline is the sum of both child phases plus the isolation allowance", () => {
    expect(isolatedChildDeadlineMs(DEFAULT_RENDER_LIMITS)).toBe(
      DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs +
        DEFAULT_RENDER_LIMITS.totalWallClockMs +
        ISOLATION_ENVELOPE_ALLOWANCE_MS,
    );
  });

  it("7. it cannot kill a child still inside its permitted phases", () => {
    const worstCaseHealthyChild =
      DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs + DEFAULT_RENDER_LIMITS.totalWallClockMs;
    expect(isolatedChildDeadlineMs(DEFAULT_RENDER_LIMITS)).toBeGreaterThan(worstCaseHealthyChild);
  });

  it("mutation check: dropping either phase from the sum would cut a healthy child short", () => {
    const worstCaseHealthyChild =
      DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs + DEFAULT_RENDER_LIMITS.totalWallClockMs;
    // The OLD formula — document phase + allowance, launch ignored.
    const withoutLaunch = DEFAULT_RENDER_LIMITS.totalWallClockMs + ISOLATION_ENVELOPE_ALLOWANCE_MS;
    expect(withoutLaunch).toBeLessThan(worstCaseHealthyChild);
    // And the allowance alone must not be what rescues it.
    const withoutDocument =
      DEFAULT_RENDER_LIMITS.browserLaunchTimeoutMs + ISOLATION_ENVELOPE_ALLOWANCE_MS;
    expect(withoutDocument).toBeLessThan(worstCaseHealthyChild);
    expect(isolatedChildDeadlineMs(DEFAULT_RENDER_LIMITS)).toBeGreaterThan(worstCaseHealthyChild);
  });

  it("6. remains bounded — a wedged child is still killed at the parent's deadline", async () => {
    const f = createIsolatedRenderedDocsFetcher({
      spawnChild: (() => new Promise(() => {})) as never,
      startProxy: (async () => ({ port: 1, close: async () => {}, decisions: [] })) as never,
      parentEnv: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      limits: {
        ...DEFAULT_RENDER_LIMITS,
        browserLaunchTimeoutMs: 20,
        navigationTimeoutMs: 20,
        totalWallClockMs: 20,
      },
    });
    await expect(f.render(URL_IN, ROUTE)).rejects.toMatchObject({ reason: "TIMEOUT" });
  }, 20_000);
});
