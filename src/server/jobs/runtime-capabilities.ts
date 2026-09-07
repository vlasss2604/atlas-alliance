import {
  installFetchRendererCapability,
  type RendererInstallDeps,
  type RendererInstallResult,
} from "./renderer-capability";
import {
  installOnchainResearchCapability,
  type OnchainInstallDeps,
  type OnchainInstallResult,
} from "./onchain-capability";
import type { PhaseCapability } from "./worker-capabilities";

// EVERY RUNTIME CAPABILITY THIS PROCESS MAY NEED, INSTALLED IN ONE PLACE.
//
// WHY THIS EXISTS. A capability is installed into module state at process
// startup and read much later, deep inside acquisition, through an
// `available()` predicate that answers false when nothing installed it.
// The worker installs them during startup; `alpha-run` drives the same
// task handler WITHOUT that startup, so every capability the worker
// installs had to be remembered and repeated there by hand.
//
// It was not. The on-chain retriever was missing first: a live run reached
// the chain-reading branch, found no retriever, recorded
// ONCHAIN_RETRIEVER_NOT_CONFIGURED on every component that planned a read,
// and answered from documents — after spending real search and model
// budget. That was fixed by repeating the one call. The renderer was still
// missing, and would have failed the same way and just as quietly: enabled,
// with a browser that starts, and `renderedDocsAvailable()` false, so the
// oversized-document chain could reach negotiation and never the render.
//
// TWICE IS A PATTERN, NOT AN OVERSIGHT. The defect is not a forgotten line;
// it is that "which capabilities does a process need" had no single answer,
// so each caller kept its own list and a list can be short. This module IS
// that answer. Adding a capability here reaches every caller at once, and
// the parity guard in the tests fails if a new `install*Capability` module
// appears and this bootstrap does not know about it.
//
// NO POLICY LIVES HERE. Each installer keeps its own gates unchanged — the
// role test, the declared flag, the endpoint allowlist, the self-test that
// must pass before a renderer is exposed. This function decides nothing
// except that both are asked, in the order the worker already asked them.

export interface RuntimeCapabilityDeps {
  capabilities: ReadonlySet<PhaseCapability>;
  env?: NodeJS.ProcessEnv;
  // Seams, passed straight through to the installer that owns each
  // decision, exactly as those modules already accept them. Production
  // passes none of them; a test can prove the WIRING without launching a
  // browser or constructing a transport, which is the only way this
  // module can be covered honestly.
  renderer?: Omit<RendererInstallDeps, "capabilities" | "env">;
  onchain?: Omit<OnchainInstallDeps, "capabilities" | "env">;
}

export interface RuntimeCapabilityResult {
  renderer: RendererInstallResult;
  onchain: OnchainInstallResult;
}

// ORDER IS THE WORKER'S, PRESERVED. The renderer's self-test launches a
// browser and is the slower, more failure-prone of the two, so it runs
// first and a declared-but-broken renderer stops the caller before the
// cheaper installation has changed anything.
//
// DECLARED-BUT-UNCONSTRUCTIBLE STILL THROWS, from whichever installer
// raised it. Callers decide what that means: the worker fails startup, and
// a script refuses before it spends. Neither outcome is decided here.
export async function installRuntimeCapabilities(
  deps: RuntimeCapabilityDeps,
): Promise<RuntimeCapabilityResult> {
  const renderer = await installFetchRendererCapability({
    capabilities: deps.capabilities,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.renderer ?? {}),
  });
  const onchain = installOnchainResearchCapability({
    capabilities: deps.capabilities,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.onchain ?? {}),
  });
  return { renderer, onchain };
}
