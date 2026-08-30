import {
  __setRenderedDocsFetcher,
  type RenderedDocsFetcher,
} from "../engine/providers/rendered-docs-fetcher";
import {
  createIsolatedRenderedDocsFetcher,
  runIsolatedRendererSelfTest,
  type RendererSelfTestResult,
} from "../engine/providers/rendered-docs-isolated";
import {
  workerServesPhase,
  type PhaseCapability,
} from "./worker-capabilities";

// D-146 SLICE 2 — ISOLATED_RENDER BECOMES A REAL CAPABILITY OF THE FETCH
// WORKER, AND ONLY OF THE FETCH WORKER.
//
// Slice 1 built the chain DIRECT_HTTP -> CONTENT_NEGOTIATION ->
// ISOLATED_RENDER and left the third strategy inert, because no
// production process ever installed a renderer: `renderedDocsAvailable()`
// was false everywhere outside owner scripts and tests. This module is
// the whole of the production installation, and it is deliberately small
// enough to read in one sitting.
//
// DECLARED, NEVER DISCOVERED — the same rule D-136 established for phase
// capability. Whether this process may render is answered by exactly two
// declarations:
//
//   1. the worker ROLE (ATLAS_WORKER_CAPABILITIES contains FETCH), and
//   2. the explicit renderer flag (RENDERED_DOCS_ENABLED=1).
//
// Nothing else is consulted. Not VPN state, not DNS, not a reachability
// probe, not a hostname, not a project, not whether a browser happens to
// be on the box. A process that has not been told to render does not
// render, and a process that HAS been told either renders or fails to
// start — there is no third, quieter outcome.
//
// ROLE ISOLATION. Chromium is started only by the role that acquires
// documents. A SEARCH_EXTRACT worker running on a box where the flag
// happens to be set installs nothing and launches nothing: the flag alone
// is not a licence, the role is. This keeps D-136's separation honest —
// the two roles exist because they have different external reach, and
// giving the model/search role a browser would quietly erase that.
//
// FAIL CLOSED, LOUDLY. If the owner declares renderer capability and the
// browser cannot start, the worker does NOT come up in a degraded
// direct-only mode. A worker that silently drops a declared capability
// looks healthy while every render-eligible document quietly fails, and
// the FETCHING phase would go on reporting ordinary acquisition failures
// for a cause that has nothing to do with any source. Startup fails
// instead, with the self-test's own closed reason.
//
// NOT RESEARCH. The self-test navigates nowhere but about:blank. It opens
// no source, writes no trace row and reserves NO sourceOpen: it is
// capability health verification, not acquisition. Its failure is an
// operational fact for the operator's console, never a research fact —
// no research attempt occurred, so nothing about it may enter a job's
// trace.

export const RENDERED_DOCS_ENV = "RENDERED_DOCS_ENABLED";

// Why this process did or did not end up with a renderer. Closed, and
// reported to the operator verbatim so an unexpected "not enabled" is
// visible at startup rather than inferred from a later failure.
export type RendererInstallOutcome =
  // Declared FETCH + declared flag + self-test passed.
  | "INSTALLED"
  // This process does not serve FETCHING. Chromium is never started here,
  // whatever the flag says.
  | "NOT_FETCH_ROLE"
  // The FETCH role, but renderer capability was not declared. The worker
  // keeps DIRECT_HTTP and CONTENT_NEGOTIATION and simply has no third
  // strategy; the chain's own gate (renderedDocsAvailable()) sees that.
  | "NOT_ENABLED";

export interface RendererInstallResult {
  outcome: RendererInstallOutcome;
  // Present only when a self-test actually ran.
  selfTest: RendererSelfTestResult | null;
}

// Thrown to stop worker startup. Carries the self-test's own CLOSED
// reason and browser-launch diagnostic — never a raw browser error, never
// a stack from the child, never anything about the network.
export class RendererCapabilityUnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly diagnostic: string | null,
    readonly durationMs: number,
  ) {
    super(
      "renderer capability was declared (" +
        RENDERED_DOCS_ENV +
        "=1) but the isolated renderer self-test failed: " +
        reason +
        (diagnostic ? " / " + diagnostic : ""),
    );
    this.name = "RendererCapabilityUnavailableError";
  }
}

export interface RendererInstallDeps {
  capabilities: ReadonlySet<PhaseCapability>;
  env?: NodeJS.ProcessEnv;
  // Seams, so the whole decision above is testable without launching a
  // browser. Production passes none of them.
  selfTest?: () => Promise<RendererSelfTestResult>;
  create?: () => RenderedDocsFetcher;
  install?: (f: RenderedDocsFetcher | null) => void;
}

// Ordering is the point: SELF-TEST FIRST, install second. The capability
// is exposed to the FETCHING phase only after the browser has been proven
// to start on this machine, so the chain can never reach a renderer that
// was going to fail at launch.
export async function installFetchRendererCapability(
  deps: RendererInstallDeps,
): Promise<RendererInstallResult> {
  const env = deps.env ?? process.env;
  const install = deps.install ?? __setRenderedDocsFetcher;

  if (!workerServesPhase(deps.capabilities, "FETCHING")) {
    return { outcome: "NOT_FETCH_ROLE", selfTest: null };
  }
  if (env[RENDERED_DOCS_ENV] !== "1") {
    return { outcome: "NOT_ENABLED", selfTest: null };
  }

  const selfTest = await (deps.selfTest ?? runIsolatedRendererSelfTest)();
  if (!selfTest.ok) {
    // Nothing was installed, but the uninstall is unconditional anyway:
    // startup must never leave a half-installed capability behind for a
    // supervisor's restart to inherit.
    install(null);
    throw new RendererCapabilityUnavailableError(
      selfTest.reason ?? "RENDERER_UNAVAILABLE",
      selfTest.diagnostic,
      selfTest.durationMs,
    );
  }

  install((deps.create ?? createIsolatedRenderedDocsFetcher)());
  return { outcome: "INSTALLED", selfTest };
}

// Shutdown. The isolated renderer holds NO long-lived process of its own:
// by design each render spawns its own child and its own egress proxy and
// tears both down in a finally, so no browser outlives the one page it
// was opened for. That per-render isolation IS the security model and is
// not traded for reuse here. What the worker installs is the capability
// object; what shutdown removes is that same object, exactly once, so a
// stopped worker cannot still answer renderedDocsAvailable() with true.
export function uninstallRendererCapability(
  install: (f: RenderedDocsFetcher | null) => void = __setRenderedDocsFetcher,
): void {
  install(null);
}
