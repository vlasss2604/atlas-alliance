import { createHash } from "node:crypto";

import {
  navigationAllowed,
  resolvedHostAllowed,
  subresourceAllowed,
} from "../rendered-docs-policy";
import { normalizeHtmlToText } from "./content-fetcher";
import { proxyChromiumArgs } from "./renderer-env";
import {
  BROWSER_LOCKDOWN,
  DEFAULT_RENDER_LIMITS,
  RenderedDocsError,
  type ConfirmedDocsRoute,
  type RenderedDocsFetcher,
  type RenderedDocument,
  type RenderLimits,
} from "./rendered-docs-fetcher";

// Playwright adapter — deliberately the thinnest layer in Stage 1.
//
// It owns no judgement: every allow/deny question is delegated to
// rendered-docs-policy.ts, which is pure and unit-tested offline. What
// lives here is only the mechanics of launching a locked-down browser,
// pointing it at ONE url, and reading the settled DOM text back out.
//
// DEPENDENCY POSTURE: playwright is imported LAZILY, inside the factory.
// The module graph therefore does not require it at load time, nothing
// breaks in a deployment that never enables rendering, and the package
// stays out of the production dependency set until the owner decides to
// promote it. Same discipline as the dev-bypass import in the auth route.

// The minimal surface this adapter uses. Declared structurally so the file
// type-checks without playwright's types being present, and so a test can
// substitute a driver without a browser binary.
interface BrowserLike {
  version(): string;
  newContext(options: unknown): Promise<ContextLike>;
  close(): Promise<void>;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  route(pattern: string, handler: (route: RouteLike) => Promise<void> | void): Promise<void>;
}
interface RouteLike {
  request(): { url(): string; resourceType(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}
interface PageLike {
  goto(url: string, options: unknown): Promise<{ status(): number } | null>;
  url(): string;
  content(): Promise<string>;
  innerText(selector: string): Promise<string>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): Promise<void>;
}

export interface PlaywrightRenderDeps {
  // Injected for tests; production resolves playwright lazily.
  launchBrowser?: () => Promise<BrowserLike>;
  limits?: RenderLimits;
  rendererVersion?: string;
  // Injected so the offline suite performs no DNS query. A DNS lookup is
  // still network activity, and these tests must make none.
  hostAllowed?: (host: string) => Promise<boolean>;
  // Loopback egress proxy every browser request must traverse. When set,
  // the browser is launched with no bypass route, so page.route() becomes
  // defence in depth rather than the security boundary.
  proxyPort?: number;
}

async function defaultLaunch(proxyPort?: number): Promise<BrowserLike> {
  // Lazy: only reached when rendering is actually enabled and invoked.
  const pw = (await import("playwright")) as unknown as {
    chromium: { launch(opts: unknown): Promise<BrowserLike> };
  };
  return pw.chromium.launch({
    headless: BROWSER_LOCKDOWN.headless,
    args: [
      ...BROWSER_LOCKDOWN.chromiumArgs,
      // Forces ALL traffic through the boundary, with no bypass — the
      // empty-loopback bypass list is the load-bearing part.
      ...(proxyPort ? proxyChromiumArgs(proxyPort) : []),
    ],
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function createPlaywrightRenderedDocsFetcher(
  deps: PlaywrightRenderDeps = {},
): RenderedDocsFetcher {
  const limits = deps.limits ?? DEFAULT_RENDER_LIMITS;
  const launch = deps.launchBrowser ?? (() => defaultLaunch(deps.proxyPort));
  const hostAllowed = deps.hostAllowed ?? resolvedHostAllowed;
  const name = "playwright-chromium";
  const version = deps.rendererVersion ?? "1";

  return {
    name,
    version,

    async render(url: string, route: ConfirmedDocsRoute): Promise<RenderedDocument> {
      // Pre-flight, before a browser exists: the url must satisfy the
      // confirmed host + prefix, and the host must not resolve into a
      // private/loopback/link-local range.
      if (!navigationAllowed(url, route.confirmedHost, route.matchedPathPrefix)) {
        throw new RenderedDocsError("NAVIGATION_BLOCKED", name);
      }
      if (!(await hostAllowed(route.confirmedHost))) {
        throw new RenderedDocsError("HOST_NOT_ALLOWED", name);
      }

      const startedAt = Date.now();
      let blockedRequestCount = 0;
      let totalBytes = 0;
      let navigations = 0;

      const browser = await launch();
      let context: ContextLike | null = null;
      try {
        context = await browser.newContext({
          javaScriptEnabled: BROWSER_LOCKDOWN.javaScriptEnabled,
          acceptDownloads: BROWSER_LOCKDOWN.acceptDownloads,
          ignoreHTTPSErrors: BROWSER_LOCKDOWN.ignoreHTTPSErrors,
          bypassCSP: BROWSER_LOCKDOWN.bypassCSP,
          serviceWorkers: BROWSER_LOCKDOWN.serviceWorkers,
          permissions: [...BROWSER_LOCKDOWN.permissions],
        });

        // EVERY request, top-level and subresource, is filtered. This is
        // the browser-side replacement for the static fetcher's
        // connection pinning: a browser resolves and connects on its own,
        // so containment has to happen here or not at all.
        await context.route("**/*", async (r) => {
          const requestUrl = r.request().url();
          if (subresourceAllowed(requestUrl, route.confirmedHost) === "BLOCK") {
            blockedRequestCount += 1;
            await r.abort("blockedbyclient");
            return;
          }
          await r.continue();
        });

        const page = await context.newPage();
        // A popup or new target is refused rather than followed.
        page.on("popup", (...args: unknown[]) => {
          blockedRequestCount += 1;
          const popup = args[0] as { close?: () => void } | undefined;
          popup?.close?.();
        });
        page.on("download", (...args: unknown[]) => {
          blockedRequestCount += 1;
          const dl = args[0] as { cancel?: () => void } | undefined;
          dl?.cancel?.();
        });
        page.on("response", (...args: unknown[]) => {
          const res = args[0] as { headers?: () => Record<string, string> } | undefined;
          const len = Number(res?.headers?.()["content-length"] ?? 0);
          if (Number.isFinite(len)) totalBytes += len;
        });

        navigations += 1;
        if (navigations > limits.maxNavigations) {
          throw new RenderedDocsError("NAVIGATION_BLOCKED", name);
        }

        // ONE navigation. No retry on failure — a failed render is a
        // failed render.
        await page.goto(url, {
          timeout: limits.navigationTimeoutMs,
          waitUntil: "networkidle",
        });

        if (Date.now() - startedAt > limits.totalWallClockMs) {
          throw new RenderedDocsError("TIMEOUT", name);
        }
        if (totalBytes > limits.maxTotalResponseBytes) {
          throw new RenderedDocsError("TOO_LARGE", name);
        }

        // Re-validate where we actually LANDED. A redirect chain must not
        // be able to carry the render outside the confirmed route.
        const finalUrl = page.url();
        if (!navigationAllowed(finalUrl, route.confirmedHost, route.matchedPathPrefix)) {
          throw new RenderedDocsError("FINAL_URL_OUTSIDE_ROUTE", name);
        }

        const html = await page.content();
        // Prefer the rendered body text; fall back to normalizing the
        // settled DOM's HTML if innerText is unavailable.
        let renderedText: string;
        try {
          renderedText = (await page.innerText("body")).trim();
        } catch {
          renderedText = normalizeHtmlToText(html);
        }
        if (renderedText.length > limits.maxRenderedTextLength) {
          renderedText = renderedText.slice(0, limits.maxRenderedTextLength);
        }

        return {
          // FetchedDocument-compatible half.
          finalUrl,
          requestedUrl: url,
          httpStatus: 200,
          contentType: "text/html",
          normalizedText: renderedText,
          contentHash: sha256(renderedText),
          fetchedAt: new Date(),
          byteLength: Buffer.byteLength(html),
          // Stage 1 audit half.
          renderMode: "RENDERED",
          rendererName: name,
          rendererVersion: version,
          browserVersion: browser.version(),
          confirmedRouteDomain: route.confirmedHost,
          matchedPathPrefix: route.matchedPathPrefix,
          staticTextLength: 0, // filled by the caller, which knows it
          renderedTextLength: renderedText.length,
          rawHtmlHash: sha256(html),
          blockedRequestCount,
          renderDurationMs: Date.now() - startedAt,
        };
      } catch (e) {
        if (e instanceof RenderedDocsError) throw e;
        // Never echo page content or a URL out of the renderer.
        throw new RenderedDocsError("RENDER_FAILED", name);
      } finally {
        // Torn down after EVERY render, success or failure.
        await context?.close().catch(() => {});
        await browser.close().catch(() => {});
      }
    },
  };
}
