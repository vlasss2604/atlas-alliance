import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import { isHttpStatusCode } from "./content-fetcher";
import {
  startEgressProxy,
  summarizeEgressDenials,
  type EgressDenialSummary,
  type EgressProxyHandle,
} from "./render-egress-proxy";
import { buildRendererEnv } from "./renderer-env";
import {
  CHILD_REPORTABLE_RENDER_REASONS,
  DEFAULT_RENDER_LIMITS,
  isolatedChildDeadlineMs,
  isBrowserLaunchDiagnostic,
  isNavigationDiagnostic,
  isRenderedDocsFailureReason,
  RenderedDocsError,
  type BrowserLaunchDiagnostic,
  type ConfirmedDocsRoute,
  type RenderedDocsFailureReason,
  type RenderedDocsFetcher,
  type RenderedDocument,
  type RenderLimits,
} from "./rendered-docs-fetcher";
import type {
  ChildRenderRequest,
  ChildRenderResponse,
  ChildSelfTestRequest,
} from "./rendered-docs-child";

// Parent-side supervisor: the production RenderedDocsFetcher.
//
// It never renders anything itself. It stands up an egress boundary,
// spawns a scrubbed child, hands it the MINIMUM request, supervises it,
// and validates whatever comes back. Three separate boundaries have to be
// crossed before a page's output becomes a document:
//
//   process   — the browser runs somewhere ATLAS secrets are not
//   network   — all traffic goes through a deny-by-default proxy
//   data      — only a bounded, schema-checked result is accepted
//
// Every failure mode is fail-closed: crash, timeout, non-zero exit,
// unparseable output, or an output that does not match the expected shape
// all become a typed RenderedDocsError and never a document.

export interface IsolatedRendererDeps {
  limits?: RenderLimits;
  // Injected for tests so no process is spawned and no proxy is opened.
  spawnChild?: (args: {
    scriptPath: string;
    env: Record<string, string>;
    request: ChildRenderRequest;
  }) => Promise<{ stdout: string; code: number | null }>;
  startProxy?: typeof startEgressProxy;
  parentEnv?: NodeJS.ProcessEnv;
  // OPT-IN passive network observation, forwarded to the child.
  // Off unless a caller explicitly asks: an ordinary evidentiary
  // render must not begin recording what a page fetched merely
  // because the capability exists.
  observeNetwork?: boolean;
  // OPT-IN record-recovery needles, forwarded to the child. Empty or
  // absent means the recovery never runs.
  recoverNeedles?: readonly string[];
}

const CHILD_SCRIPT = path.join(__dirname, "rendered-docs-child.ts");

export interface ChildCommand {
  command: string;
  args: string[];
  useShell: false;
}

// Builds the exact process invocation, as data, so the shape is directly
// assertable by test.
//
// WHY THIS IS NOT `spawn("npx", ["tsx", path], { shell: true })`:
// on Windows that form emits DEP0190 because the arguments are
// CONCATENATED INTO A SHELL COMMAND STRING rather than passed as argv.
// Any shell metacharacter in a path — `&`, `|`, `&&`, quotes — would then
// be interpreted by cmd.exe instead of treated as part of a filename. The
// script path here is code-owned (path.join(__dirname, ...)), so it was
// not exploitable, but a shell-concatenating spawn sitting INSIDE the
// isolation boundary is precisely the wrong place to leave a latent
// injection primitive.
//
// Instead: spawn the running Node binary directly (process.execPath, an
// absolute path) with tsx's CLI resolved to an absolute path, and pass
// every argument as a separate argv element. No shell is involved on any
// platform, so there is no string for a metacharacter to escape into, and
// no PATH lookup for `npx` to be hijacked.
export function buildChildCommand(scriptPath: string): ChildCommand {
  // Resolved, never assumed from PATH.
  const tsxCli = require.resolve("tsx/cli");
  return {
    command: process.execPath,
    args: [tsxCli, scriptPath],
    useShell: false,
  };
}

// The one place a child process is created.
async function defaultSpawn(args: {
  scriptPath: string;
  env: Record<string, string>;
  request: ChildRenderRequest;
}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const cmd = buildChildCommand(args.scriptPath);
      child = spawn(cmd.command, cmd.args, {
        // THE isolation boundary: the child's environment is exactly what
        // buildRendererEnv produced. process.env is NOT inherited.
        // Cast only to satisfy Next.js's ProcessEnv augmentation, which
        // declares NODE_ENV required and readonly; buildRendererEnv does
        // set it, and a plain record is what spawn actually wants.
        env: args.env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"],
        // Explicit and permanent: argv is passed as argv.
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    child.stdout?.on("data", (c: Buffer) => {
      // Bounded: a runaway child cannot exhaust parent memory.
      if (stdout.length < 8_000_000) stdout += c.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin?.write(JSON.stringify(args.request));
    child.stdin?.end();
  });
}

// Validates the child's output before it is allowed to become a document.
// The child is a separate, browser-hosting process; its output is treated
// as untrusted input like any other.
function parseChildDocument(stdout: string): RenderedDocument {
  let parsed: ChildRenderResponse;
  try {
    parsed = JSON.parse(stdout) as ChildRenderResponse;
  } catch {
    throw new RenderedDocsError("CHILD_OUTPUT_MALFORMED", "isolated");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RenderedDocsError("CHILD_OUTPUT_MALFORMED", "isolated");
  }
  if (!parsed.ok) {
    // THE CHILD ALREADY KNEW. It classifies its own failure and puts a
    // reason on the wire; this line used to throw it away and report
    // RENDER_FAILED for every one of them, which is why a site that
    // defeated the browser read identically to a browser that never
    // started.
    //
    // The envelope is untrusted input like any other — it arrives as JSON
    // from a separate process — so the value is admitted only by
    // membership of the closed, code-owned list, and only of the subset
    // the child is in a position to have observed. It is never
    // interpreted, never normalised, and nothing else on the envelope is
    // read. A look-alike string is not a reason.
    const reported = (parsed as { reason?: unknown }).reason;
    if (isRenderedDocsFailureReason(reported) && CHILD_REPORTABLE_RENDER_REASONS.has(reported)) {
      // The launch sub-reason and the HTTP status travel the same way and
      // are re-checked the same way: a member of its own closed set, or an
      // integer in 100..599, or nothing. An unrecognised value is dropped,
      // never passed along.
      const detail = (parsed as { detail?: unknown }).detail;
      const status = (parsed as { httpStatus?: unknown }).httpStatus;
      const navDetail = (parsed as { navigationDetail?: unknown }).navigationDetail;
      throw new RenderedDocsError(
        reported,
        "isolated",
        isBrowserLaunchDiagnostic(detail) ? detail : null,
        isHttpStatusCode(status) ? status : null,
        isNavigationDiagnostic(navDetail) ? navDetail : null,
      );
    }
    throw new RenderedDocsError("CHILD_OUTPUT_MALFORMED", "isolated");
  }
  // A self-test envelope is a valid response, but it is not a document —
  // and the render path must never be satisfied by one.
  const doc = (parsed as { document?: unknown }).document as Partial<RenderedDocument> | undefined;
  // Shape check on every field the downstream path reads. A missing one
  // means the result is not a document, not that we should default it.
  if (
    !doc ||
    doc.renderMode !== "RENDERED" ||
    typeof doc.finalUrl !== "string" ||
    typeof doc.normalizedText !== "string" ||
    typeof doc.contentHash !== "string" ||
    typeof doc.byteLength !== "number"
  ) {
    // The child claimed success and handed back something that is not a
    // document. That is the data boundary refusing it, not a render that
    // failed — the distinction tells a contract mismatch apart from a
    // page that defeated the browser.
    throw new RenderedDocsError("CHILD_OUTPUT_MALFORMED", "isolated");
  }
  // fetchedAt crosses the process boundary as a JSON string.
  return { ...(doc as RenderedDocument), fetchedAt: new Date(doc.fetchedAt as unknown as string) };
}

export function createIsolatedRenderedDocsFetcher(
  deps: IsolatedRendererDeps = {},
): RenderedDocsFetcher {
  const limits = deps.limits ?? DEFAULT_RENDER_LIMITS;
  const spawnChild = deps.spawnChild ?? defaultSpawn;
  const startProxy = deps.startProxy ?? startEgressProxy;
  const parentEnv = deps.parentEnv ?? process.env;
  const observeNetwork = deps.observeNetwork === true;
  const recoverNeedles = [...(deps.recoverNeedles ?? [])];

  return {
    name: "isolated-playwright-chromium",
    version: "1",

    async render(url: string, route: ConfirmedDocsRoute): Promise<RenderedDocument> {
      let proxy: EgressProxyHandle | null = null;
      let timer: NodeJS.Timeout | null = null;
      try {
        // The egress boundary is pinned to THIS render's confirmed host.
        // It exists only for the lifetime of the render.
        //
        // Its own stage: if this fails no child is ever spawned and no
        // request ever leaves the machine, so the site is not implicated
        // in any way. Reporting that as RENDER_FAILED pointed the reader
        // at the page instead of at a local port.
        try {
          proxy = await startProxy({ confirmedHost: route.confirmedHost });
        } catch (e) {
          if (e instanceof RenderedDocsError) throw e;
          throw new RenderedDocsError("EGRESS_PROXY_UNAVAILABLE", "isolated");
        }

        const request: ChildRenderRequest = {
          url,
          confirmedHost: route.confirmedHost,
          matchedPathPrefix: route.matchedPathPrefix,
          limits,
          proxyPort: proxy.port,
          observeNetwork,
          recoverNeedles,
        };

        // EXACTLY ONE child render request. No loop, no retry — a failed
        // render is a failed render.
        //
        // A rejection here is the process never starting — an unresolvable
        // loader, a missing binary, an OS refusal. Still exactly one call:
        // the mapping below replaces the error, it does not re-invoke.
        const work = spawnChild({
          scriptPath: CHILD_SCRIPT,
          env: buildRendererEnv({ parentEnv, proxyPort: proxy.port }),
          request,
        }).catch((e: unknown) => {
          if (e instanceof RenderedDocsError) throw e;
          throw new RenderedDocsError("CHILD_SPAWN_FAILED", "isolated");
        });

        // The parent owns the hard deadline: a wedged child cannot hang
        // the job even if its own internal timeout fails.
        //
        // DERIVED, never chosen: the sum of every budget the child may
        // lawfully spend — startup AND document — plus the isolation
        // allowance. It previously counted the document budget alone, so
        // it was already shorter than a healthy child's worst case; once
        // startup became a separate budget, ignoring it would have let the
        // parent kill a child that had done nothing wrong.
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RenderedDocsError("TIMEOUT", "isolated")),
            isolatedChildDeadlineMs(limits),
          );
        });

        const { stdout, code } = await Promise.race([work, timeout]);
        // A crash or non-zero exit is a failure, never a partial result.
        // The child catches its own render failures and still exits 0 with
        // an envelope, so reaching here means it died BEFORE it could
        // classify anything — whatever stdout holds is not to be trusted
        // as a reason.
        if (code !== 0) throw new RenderedDocsError("CHILD_EXIT_NONZERO", "isolated");
        return parseChildDocument(stdout);
      } catch (e) {
        // THE PROXY'S OWN VERDICT, attached here because this is where its
        // log lives — the proxy is a parent-side boundary, so the browser's
        // report and our containment's decision are two different
        // witnesses caught in two different places. Neither replaces the
        // other; the classification above is untouched and only counts are
        // added.
        //
        // Summarized before anything leaves this scope: `decisions` holds a
        // raw `host:port` per entry, and that is precisely what this
        // boundary exists to keep out of a diagnostic.
        const denials = proxy === null ? null : summarizeEgressDenials(proxy.decisions);
        if (e instanceof RenderedDocsError) throw e.withProxyDenials(denials);
        throw new RenderedDocsError(
          "RENDER_FAILED",
          "isolated",
          null,
          null,
          null,
          denials,
        );
      } finally {
        if (timer) clearTimeout(timer);
        // The boundary is torn down after every render, so no proxy
        // outlives the one page it was opened for.
        await proxy?.close().catch(() => {});
      }
    },
  };
}

// ---- offline self-test ------------------------------------------------
//
// "CAN THIS MACHINE START THE LOCKED-DOWN BROWSER?" — answerable in a few
// seconds, offline, at any time.
//
// It was not answerable before, and the cost of that was an owner-
// authorized live window that reached the page, was refused with 403,
// correctly opened the render fallback, and then died at a browser that
// never started. The window bought one bit of information that this
// function now gives away for free.
//
// PRODUCTION-EQUIVALENT BY CONSTRUCTION, not by resemblance: the same
// egress proxy, the same scrubbed environment from buildRendererEnv, the
// same argv-only spawn from buildChildCommand, the same child script, and
// the same launch call with the same lockdown and proxy arguments.
//
// It navigates NOWHERE. The request carries no url, no confirmed host and
// no path prefix, so the child structurally cannot be pointed at anything;
// the only page opened is `about:blank`. Safe to run with no
// authorization, on any network, at any time.
export interface RendererSelfTestResult {
  ok: boolean;
  browserVersion: string | null;
  reason: RenderedDocsFailureReason | null;
  diagnostic: BrowserLaunchDiagnostic | null;
  // The same counts-only summary the render path reports. A self-test
  // navigates only to about:blank, so a denial here would say something
  // is wrong with the boundary itself rather than with any site.
  proxyDenials: EgressDenialSummary | null;
  durationMs: number;
}

export async function runIsolatedRendererSelfTest(
  deps: IsolatedRendererDeps = {},
): Promise<RendererSelfTestResult> {
  const limits = deps.limits ?? DEFAULT_RENDER_LIMITS;
  const spawnChild = deps.spawnChild ?? defaultSpawn;
  const startProxy = deps.startProxy ?? startEgressProxy;
  const parentEnv = deps.parentEnv ?? process.env;
  const startedAt = Date.now();
  let proxy: EgressProxyHandle | null = null;
  const done = (
    over: Partial<RendererSelfTestResult>,
  ): RendererSelfTestResult => ({
    ok: false,
    browserVersion: null,
    reason: null,
    diagnostic: null,
    // Read at report time so it covers whatever the proxy saw, and
    // summarized here so no raw decision escapes this function.
    proxyDenials: proxy === null ? null : summarizeEgressDenials(proxy.decisions),
    durationMs: Date.now() - startedAt,
    ...over,
  });
  try {
    // A host that exists only as a label here: the proxy is opened so the
    // launch arguments are identical to production's, and no request is
    // ever made through it.
    try {
      proxy = await startProxy({ confirmedHost: "self-test.invalid" });
    } catch {
      return done({ reason: "EGRESS_PROXY_UNAVAILABLE" });
    }

    const request: ChildSelfTestRequest = { selfTest: true, limits, proxyPort: proxy.port };
    let out: { stdout: string; code: number | null };
    try {
      out = await spawnChild({
        scriptPath: CHILD_SCRIPT,
        env: buildRendererEnv({ parentEnv, proxyPort: proxy.port }),
        // The child accepts either message on stdin; the spawn signature
        // is shared, so the cast is at the boundary rather than inside it.
        request: request as unknown as ChildRenderRequest,
      });
    } catch {
      return done({ reason: "CHILD_SPAWN_FAILED" });
    }
    if (out.code !== 0) return done({ reason: "CHILD_EXIT_NONZERO" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(out.stdout);
    } catch {
      return done({ reason: "CHILD_OUTPUT_MALFORMED" });
    }
    const env = parsed as { ok?: unknown; selfTest?: unknown; browserVersion?: unknown; reason?: unknown; detail?: unknown };
    if (env?.ok === true && env.selfTest === true) {
      return done({
        ok: true,
        browserVersion: typeof env.browserVersion === "string" ? env.browserVersion : null,
      });
    }
    // Same two gates as the render path: the closed reason list, and the
    // subset the child could have witnessed.
    if (
      isRenderedDocsFailureReason(env?.reason) &&
      CHILD_REPORTABLE_RENDER_REASONS.has(env.reason)
    ) {
      return done({
        reason: env.reason,
        diagnostic: isBrowserLaunchDiagnostic(env.detail) ? env.detail : null,
      });
    }
    return done({ reason: "CHILD_OUTPUT_MALFORMED" });
  } finally {
    await proxy?.close().catch(() => {});
  }
}
