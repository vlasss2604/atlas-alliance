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
  // member of the closed BROWSER_LAUNCH_DIAGNOSTICS set. Typed as string
  // because this is the wire: the parent re-checks it against the set
  // rather than believing the type.
  | { ok: false; reason: string; detail?: string };

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
    browser = await launchLockedDownBrowser(request.proxyPort);
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
      process.stdout.write(JSON.stringify(response));
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
    response =
      e instanceof RenderedDocsError
        ? e.diagnostic === null
          ? { ok: false, reason: e.reason }
          : { ok: false, reason: e.reason, detail: e.diagnostic }
        : { ok: false, reason: "RENDER_FAILED" };
  }
  process.stdout.write(JSON.stringify(response));
}

// Only runs when executed as a process, never on import.
if (process.argv[1] && process.argv[1].endsWith("rendered-docs-child.ts")) {
  void runChild().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
