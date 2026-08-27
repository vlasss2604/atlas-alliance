import { createHash } from "node:crypto";

import {
  navigationAllowed,
  resolvedHostAllowed,
  subresourceAllowed,
} from "../rendered-docs-policy";
import {
  isHttpStatusCode,
  isHttpSuccessStatus,
  normalizeHtmlToText,
} from "./content-fetcher";
import { proxyChromiumArgs } from "./renderer-env";
import { extractDocumentLinks, renderLinkAppendix } from "./document-links";
import {
  mayCaptureBody,
  NetworkObservationCollector,
} from "./network-observation";
import { recoverEmbeddedRecords } from "./embedded-records";
import {
  BROWSER_LOCKDOWN,
  DEFAULT_RENDER_LIMITS,
  RenderedDocsError,
  classifyBrowserLaunchFailure,
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
  // OPT-IN passive network observation. Off by default: an ordinary
  // evidentiary render must not start recording what a page fetched
  // just because the capability exists.
  observeNetwork?: boolean;
  // OPT-IN record-preserving recovery from the SETTLED html this render
  // already captured. Parse only — no second navigation, no execution,
  // no request. Absent means the recovery never runs.
  recoverRecords?: { needles: readonly string[] };
}

// EXPORTED so the offline self-test launches through the SAME call, with
// the same lockdown and the same proxy arguments. A probe that built its
// own launch would drift from this one and stop proving anything about
// production.
export async function launchLockedDownBrowser(proxyPort?: number): Promise<BrowserLike> {
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
  const launch = deps.launchBrowser ?? (() => launchLockedDownBrowser(deps.proxyPort));
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
      // Present only when the caller asked to observe. Absent by
      // default, so an ordinary evidentiary render records nothing.
      const observer = deps.observeNetwork
        ? new NetworkObservationCollector(route.confirmedHost)
        : null;
      const bodyReads: Promise<void>[] = [];
      let totalBytes = 0;
      let navigations = 0;

      // Starting the browser is its own stage. A missing playwright
      // module, an absent Chromium binary or a refused launch says
      // nothing whatever about the page — collapsing it into
      // RENDER_FAILED made a broken local install indistinguishable from
      // a site that defeated the renderer, which are opposite diagnoses.
      let browser: BrowserLike;
      try {
        browser = await launch();
      } catch (e) {
        if (e instanceof RenderedDocsError) throw e;
        // The message is read exactly once, here, and reduced to a member
        // of a closed code-owned set. It is never stored, forwarded or
        // re-thrown: a real launch error carries an absolute filesystem
        // path, and often Chromium's entire command line.
        throw new RenderedDocsError(
          "BROWSER_LAUNCH_FAILED",
          name,
          classifyBrowserLaunchFailure(e),
        );
      }
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
        // PASSIVE. This handler is called for responses the browser has
        // ALREADY received while rendering the one page we navigated to.
        // It issues nothing: response.text() reads a body the browser is
        // already holding, and there is no request object, no continue(),
        // no fetch and no evaluate anywhere in it. A body is read only
        // when the policy allows — same-origin and textual — and the
        // policy lives in a pure module so it is testable without a
        // browser.
        page.on("response", (...args: unknown[]) => {
          const res = args[0] as
            | {
                headers?: () => Record<string, string>;
                url?: () => string;
                status?: () => number;
                request?: () => { method?: () => string; resourceType?: () => string };
                text?: () => Promise<string>;
              }
            | undefined;
          const headers = res?.headers?.() ?? {};
          const len = Number(headers["content-length"] ?? 0);
          if (Number.isFinite(len)) totalBytes += len;
          if (!observer) return;
          const url = res?.url?.() ?? "";
          const contentType = headers["content-type"] ?? null;
          const meta = {
            url,
            method: res?.request?.()?.method?.() ?? "",
            resourceType: res?.request?.()?.resourceType?.() ?? "",
            status: res?.status?.() ?? 0,
            contentType,
            contentLength: Number.isFinite(len) && len > 0 ? len : null,
          };
          if (!mayCaptureBody({ url, confirmedHost: route.confirmedHost, contentType })) {
            observer.record({ ...meta, body: null });
            return;
          }
          // Reading the buffered body is asynchronous; the promise is
          // tracked so the render does not finish mid-read. A failure to
          // read is recorded as no body, never retried.
          const pending = (async () => {
            let body: string | null = null;
            try {
              body = (await res?.text?.()) ?? null;
            } catch {
              body = null;
            }
            observer.record({ ...meta, body });
          })();
          bodyReads.push(pending);
        });

        navigations += 1;
        if (navigations > limits.maxNavigations) {
          throw new RenderedDocsError("NAVIGATION_BLOCKED", name);
        }

        // ONE navigation. No retry on failure — a failed render is a
        // failed render.
        //
        // The Response is KEPT. A browser does not throw on 403: it
        // receives the refusal page, renders it, and reports success.
        // Discarding this was how a server's "access denied" HTML could
        // reach extraction dressed as the document we asked for.
        const response = await page.goto(url, {
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
        //
        // DELIBERATELY BEFORE the status check: landing outside the
        // confirmed route is a containment failure, and it is the more
        // serious statement to make about a render that did both.
        const finalUrl = page.url();
        if (!navigationAllowed(finalUrl, route.confirmedHost, route.matchedPathPrefix)) {
          throw new RenderedDocsError("FINAL_URL_OUTSIDE_ROUTE", name);
        }

        // THE STATUS OF THE FINAL MAIN-DOCUMENT NAVIGATION.
        //
        // Playwright follows redirects itself and returns the LAST
        // response, so this is the status of the page actually in the
        // browser — the same thing `page.url()` above was checked against.
        //
        // Trusted numerically and nowhere else: `Response.status()` and
        // not the html, the title, the body, a header or an error string.
        // A page is free to claim any status it likes in its own markup
        // and none of that is read here.
        if (response === null || response === undefined) {
          // No response means no status to check, and unverifiable is not
          // the same as fine.
          throw new RenderedDocsError("NO_NAVIGATION_RESPONSE", name);
        }
        const status: unknown = response.status();
        if (!isHttpStatusCode(status)) {
          throw new RenderedDocsError("NO_NAVIGATION_RESPONSE", name);
        }
        // The SAME success rule the static fetcher applies, from one
        // shared predicate, so the two transports cannot drift into
        // disagreeing about which statuses yield a document.
        if (!isHttpSuccessStatus(status)) {
          throw new RenderedDocsError("HTTP_ERROR", name, null, status);
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

        // Links recovered from the settled DOM string already in hand. No
        // click, no evaluate, no second navigation — the browser's work is
        // done before this runs.
        const documentLinks = extractDocumentLinks(html);
        // The appendix is BOUNDED SEPARATELY and appended AFTER the body
        // text is truncated, so a long page can never squeeze the
        // recovered hrefs out of the document — the two limits are
        // independent by construction.
        //
        // It is part of normalizedText, not a sibling field, and that is
        // deliberate: D-076 admits a fact only when its support fragment
        // appears literally in the text the extractor was given. Carrying
        // the hrefs beside the text instead would make every fact quoting
        // an exact address untraceable and correctly rejected. Being
        // inside normalizedText also means contentHash covers it, so what
        // was hashed and what the model read remain the same value.
        // Settle any body reads started while rendering. These are reads
        // of buffered responses, not new requests.
        await Promise.allSettled(bodyReads);
        const networkObservations = observer ? observer.result() : null;

        // Record-preserving recovery from the SAME settled html string
        // already in hand. The browser's work is finished; this is
        // string parsing, and it is bounded inside this process so a
        // multi-megabyte document never crosses the boundary.
        const embeddedRecords = deps.recoverRecords
          ? recoverEmbeddedRecords(html, { needles: deps.recoverRecords.needles })
          : null;

        const linkAppendix = renderLinkAppendix(documentLinks);
        const normalizedText = linkAppendix
          ? `${renderedText}\n\n${linkAppendix}`
          : renderedText;

        return {
          // FetchedDocument-compatible half.
          finalUrl,
          requestedUrl: url,
          httpStatus: 200,
          contentType: "text/html",
          normalizedText,
          contentHash: sha256(normalizedText),
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
          // The PAGE's own text only — deliberately NOT normalizedText's
          // length. This is the figure that answers "did rendering
          // actually recover prose", and folding the appendix into it
          // would let a link-heavy SPA shell look like a rendered
          // document.
          renderedTextLength: renderedText.length,
          linkAppendixLength: linkAppendix.length,
          rawHtmlHash: sha256(html),
          blockedRequestCount,
          renderDurationMs: Date.now() - startedAt,
          documentLinks,
          networkObservations,
          embeddedRecords,
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
