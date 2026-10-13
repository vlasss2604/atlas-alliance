// The renderer CHILD entrypoint. Runs in its own process, with a scrubbed
// environment and no database configuration.
//
// Contract, deliberately tiny:
//   stdin  <- one JSON render request
//   stdout -> one JSON envelope: { ok: true, document } | { ok: false, reason }
//
// It imports nothing from the ATLAS data layer — no db client, no schema,
// no config. Its entire capability is "render one confirmed URL and
// describe the result". A crash, a timeout, or malformed output is handled
// by the parent as a typed failure; this process never decides anything
// about evidence.
import {
  createPlaywrightRenderedDocsFetcher,
  launchLockedDownBrowser,
} from "./rendered-docs-playwright";
import {
  BROWSER_LOCKDOWN,
  RenderedDocsError,
  classifyBrowserLaunchFailure,
  type RenderLimits,
} from "./rendered-docs-fetcher";

export interface ChildRenderRequest {
  url: string;
  confirmedHost: string;
  matchedPathPrefix: string;
  limits: RenderLimits;
  proxyPort: number;
  // OPT-IN passive network observation. Absent means off, so a
  // request that predates this field renders exactly as before.
  observeNetwork?: boolean;
  // OPT-IN record recovery needles. Absent means the recovery never
  // runs. Bounded by the recovery itself, not by the caller.
  recoverNeedles?: string[];
  // OPT-IN OWNER INSPECTION DIAGNOSTICS. Absent means off, so a request
  // that predates this field renders and fails exactly as before.
  inspectionDiagnostics?: boolean;
}

// THE SELF-TEST REQUEST. A different message, not a render with a flag:
// it carries no url, no confirmed host and no path prefix, so this process
// structurally cannot be asked to visit anything by sending one.
//
// It exists because "can this machine start the locked-down browser?" was
// only answerable by spending an authorized live window and watching it
// fail. It launches through the SAME shared call with the same lockdown
// and the same proxy arguments, opens `about:blank`, and closes.
export interface ChildSelfTestRequest {
  selfTest: true;
  limits: RenderLimits;
  proxyPort: number;
}

export type ChildRenderResponse =
  | { ok: true; document: unknown }
  | { ok: true; selfTest: true; browserVersion: string }
  // `detail` is present only for BROWSER_LAUNCH_FAILED and is always a
  // member of the closed BROWSER_LAUNCH_DIAGNOSTICS set. `httpStatus` is
  // present only for HTTP_ERROR and comes from Playwright's navigation
  // Response. Both are typed loosely because this is the wire: the parent
  // re-checks them rather than believing the type.
  // `inspection` is present only when the PARENT asked for owner
  // inspection diagnostics, and the parent re-sanitizes it field by field
  // on arrival — and drops it outright if it did not ask. Typed as
  // `unknown` because this is the wire.
  | {
      ok: false;
      reason: string;
      detail?: string;
      httpStatus?: number;
      navigationDetail?: string;
      inspection?: unknown;
    };

// THE ONLY WAY AN ENVELOPE LEAVES THIS PROCESS — and the only way it
// exits after one.
//
// `process.stdout.write(payload); process.exit(code)` is NOT flush-safe
// when stdout is a pipe: on the current Node runtime anything past the
// first ~64 KB is cut off at exit, measured directly — a 200 KB envelope
// arrived as 182,720 bytes, a 1 MB one as 146,176. A small failure
// envelope always fit, so a page that DEFEATED the browser was reported
// faithfully while a large page the browser rendered PERFECTLY came back
// to the parent as CHILD_OUTPUT_MALFORMED. The parent's own 8 MB stdout
// bound is far above where this bit.
//
// So the exit is scheduled from the write's completion callback: it runs
// once the whole payload has been handed to the OS, and it runs on a
// write error too (the callback receives the error; exiting is still the
// right response, since there is no one left to tell). No timer, no
// sleep, no second write — the envelope is still exactly one.
export function emitEnvelopeAndExit(response: ChildRenderResponse, exitCode: 0 | 1): void {
  process.stdout.write(JSON.stringify(response), () => process.exit(exitCode));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

// The self-test path. Launches the locked-down browser through the shared
// call, opens the blank page every browser already has, and closes. No
// navigation, no url, nothing to fetch — so it is safe to run at any time,
// on any network, with no authorization.
async function runSelfTest(request: ChildSelfTestRequest): Promise<ChildRenderResponse> {
  // Classified at the same seam production uses, so a self-test failure
  // and a render failure name the identical cause.
  let browser: Awaited<ReturnType<typeof launchLockedDownBrowser>>;
  try {
    browser = await launchLockedDownBrowser(request.proxyPort, request.limits);
  } catch (e) {
    throw new RenderedDocsError("BROWSER_LAUNCH_FAILED", "selftest", classifyBrowserLaunchFailure(e));
  }
  try {
    const context = await browser.newContext({
      javaScriptEnabled: BROWSER_LOCKDOWN.javaScriptEnabled,
      acceptDownloads: BROWSER_LOCKDOWN.acceptDownloads,
      ignoreHTTPSErrors: BROWSER_LOCKDOWN.ignoreHTTPSErrors,
      bypassCSP: BROWSER_LOCKDOWN.bypassCSP,
      serviceWorkers: BROWSER_LOCKDOWN.serviceWorkers,
      permissions: [...BROWSER_LOCKDOWN.permissions],
    });
    try {
      const page = await context.newPage();
      await page.goto("about:blank", { timeout: request.limits.navigationTimeoutMs });
      await page.close();
      return { ok: true, selfTest: true, browserVersion: browser.version() };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function runChild(): Promise<void> {
  let response: ChildRenderResponse;
  try {
    const parsed = JSON.parse(await readStdin()) as ChildRenderRequest | ChildSelfTestRequest;
    if ((parsed as { selfTest?: unknown }).selfTest === true) {
      response = await runSelfTest(parsed as ChildSelfTestRequest);
      emitEnvelopeAndExit(response, 0);
      return;
    }
    const request = parsed as ChildRenderRequest;
    const fetcher = createPlaywrightRenderedDocsFetcher({
      limits: request.limits,
      proxyPort: request.proxyPort,
      observeNetwork: request.observeNetwork === true,
      recoverRecords:
        Array.isArray(request.recoverNeedles) && request.recoverNeedles.length > 0
          ? { needles: request.recoverNeedles }
          : undefined,
      inspectionDiagnostics: request.inspectionDiagnostics === true,
    });
    const document = await fetcher.render(request.url, {
      confirmedHost: request.confirmedHost,
      matchedPathPrefix: request.matchedPathPrefix,
    });
    response = { ok: true, document };
  } catch (e) {
    // Only reason codes ever cross the boundary — never page content,
    // never a URL, never a stack. `detail` is a member of a closed
    // code-owned set or it is omitted; the class validated it on the way
    // in and the parent validates it again on the way out.
    if (e instanceof RenderedDocsError) {
      response = { ok: false, reason: e.reason };
      if (e.diagnostic !== null) response.detail = e.diagnostic;
      if (e.httpStatus !== null) response.httpStatus = e.httpStatus;
      if (e.navigationDiagnostic !== null) response.navigationDetail = e.navigationDiagnostic;
      // Only ever populated when the parent asked: the adapter builds it
      // solely under its own opt-in flag, which the parent set. The parent
      // still re-checks its own flag before reading this key.
      if (e.inspection !== null) response.inspection = e.inspection;
    } else {
      response = { ok: false, reason: "RENDER_FAILED" };
    }
  }
  emitEnvelopeAndExit(response, 0);
}

// Only runs when executed as a process, never on import.
//
// Exit 0 is scheduled by the envelope write itself (see
// emitEnvelopeAndExit), so the success side has nothing left to do here.
// A rejection means no envelope was ever written — malformed stdin, or
// the request failed before the try above — and exits 1 exactly as
// before, which the parent reports as CHILD_EXIT_NONZERO.
if (process.argv[1] && process.argv[1].endsWith("rendered-docs-child.ts")) {
  void runChild().catch(() => process.exit(1));
}
