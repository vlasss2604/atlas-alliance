import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import { startEgressProxy, type EgressProxyHandle } from "./render-egress-proxy";
import { buildRendererEnv } from "./renderer-env";
import {
  DEFAULT_RENDER_LIMITS,
  RenderedDocsError,
  type ConfirmedDocsRoute,
  type RenderedDocsFetcher,
  type RenderedDocument,
  type RenderLimits,
} from "./rendered-docs-fetcher";
import type { ChildRenderRequest, ChildRenderResponse } from "./rendered-docs-child";

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
    throw new RenderedDocsError("RENDER_FAILED", "isolated");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RenderedDocsError("RENDER_FAILED", "isolated");
  }
  if (!parsed.ok) throw new RenderedDocsError("RENDER_FAILED", "isolated");
  const doc = parsed.document as Partial<RenderedDocument> | undefined;
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
    throw new RenderedDocsError("RENDER_FAILED", "isolated");
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

  return {
    name: "isolated-playwright-chromium",
    version: "1",

    async render(url: string, route: ConfirmedDocsRoute): Promise<RenderedDocument> {
      let proxy: EgressProxyHandle | null = null;
      let timer: NodeJS.Timeout | null = null;
      try {
        // The egress boundary is pinned to THIS render's confirmed host.
        // It exists only for the lifetime of the render.
        proxy = await startProxy({ confirmedHost: route.confirmedHost });

        const request: ChildRenderRequest = {
          url,
          confirmedHost: route.confirmedHost,
          matchedPathPrefix: route.matchedPathPrefix,
          limits,
          proxyPort: proxy.port,
        };

        // EXACTLY ONE child render request. No loop, no retry — a failed
        // render is a failed render.
        const work = spawnChild({
          scriptPath: CHILD_SCRIPT,
          env: buildRendererEnv({ parentEnv, proxyPort: proxy.port }),
          request,
        });

        // The parent owns the hard deadline: a wedged child cannot hang
        // the job even if its own internal timeout fails.
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RenderedDocsError("TIMEOUT", "isolated")),
            limits.totalWallClockMs + 5_000,
          );
        });

        const { stdout, code } = await Promise.race([work, timeout]);
        // A crash or non-zero exit is a failure, never a partial result.
        if (code !== 0) throw new RenderedDocsError("RENDER_FAILED", "isolated");
        return parseChildDocument(stdout);
      } catch (e) {
        if (e instanceof RenderedDocsError) throw e;
        throw new RenderedDocsError("RENDER_FAILED", "isolated");
      } finally {
        if (timer) clearTimeout(timer);
        // The boundary is torn down after every render, so no proxy
        // outlives the one page it was opened for.
        await proxy?.close().catch(() => {});
      }
    },
  };
}
