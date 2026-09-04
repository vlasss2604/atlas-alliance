import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_PROXY,
  PROVIDER_NO_PROXY,
  buildLaunchPlan,
} from "../scripts/dev-launch";
import {
  DirectEgressViolationError,
  PROVIDER_PROXY_ENV_VARS,
  assertDirectAcquisitionEgress,
  findProviderProxyEnv,
} from "../src/server/jobs/egress-integrity";
import { PHASE_QUEUE, RESEARCH_QUEUE } from "../src/server/jobs/queue";
import {
  parseWorkerCapabilities,
  workerServesPhase,
  type PhaseCapability,
} from "../src/server/jobs/worker-capabilities";

// D-149 — TWO WORKERS, ALWAYS ON, ONE NETWORK STATE.
//
// Two independent hazards are pinned here, and both are silent in the
// direction that matters.
//
// The first is security-shaped: the source-acquisition role's contract is
// direct, DNS-validated, IP-pinned egress. A forwarding proxy in its
// environment routes the request somewhere else while the pre-connect
// validation still passes, so nothing errors and the acquisition simply
// happens from a different network identity. That environment must refuse
// to start, and the refusal must name variables without ever printing a
// value.
//
// The second is queue-shaped: the entry queue also carries the SEARCHING
// phase, so a source-only worker used to take messages it could never
// execute and hand them back — spending a bounded delivery each time, until
// a perfectly good Research was terminated for no reason but polling luck.
// A worker does not subscribe to work it cannot do.

const FETCH_ONLY: ReadonlySet<PhaseCapability> = new Set(["FETCH"]);
const SEARCH_ONLY: ReadonlySet<PhaseCapability> = new Set(["SEARCH_EXTRACT"]);
const BOTH: ReadonlySet<PhaseCapability> = new Set(["SEARCH_EXTRACT", "FETCH"]);
const NONE: ReadonlySet<PhaseCapability> = new Set();

const SECRET = "http://user:hunter2@127.0.0.1:10809";

describe("D-149 §A — the acquisition role refuses a redirected environment", () => {
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] as const) {
    it(`${name} present -> startup refusal`, () => {
      expect(() => assertDirectAcquisitionEgress(FETCH_ONLY, { [name]: SECRET })).toThrow(
        DirectEgressViolationError,
      );
    });
  }

  it("NODE_USE_ENV_PROXY=1 -> startup refusal", () => {
    expect(() =>
      assertDirectAcquisitionEgress(FETCH_ONLY, { NODE_USE_ENV_PROXY: "1" }),
    ).toThrow(DirectEgressViolationError);
  });

  it("lower-case spellings are refused too", () => {
    // The runtime reads both cases; checking only one would leave a hole.
    expect(() => assertDirectAcquisitionEgress(FETCH_ONLY, { https_proxy: SECRET })).toThrow(
      DirectEgressViolationError,
    );
  });

  it("names the offending variables and NEVER their values", () => {
    let err: DirectEgressViolationError | null = null;
    try {
      assertDirectAcquisitionEgress(FETCH_ONLY, {
        HTTPS_PROXY: SECRET,
        NODE_USE_ENV_PROXY: "1",
      });
    } catch (e) {
      err = e as DirectEgressViolationError;
    }
    expect(err).toBeInstanceOf(DirectEgressViolationError);
    if (!err) throw new Error("unreachable");

    expect(err.message).toContain("FETCH_EGRESS_PROXY_FORBIDDEN");
    expect(err.message).toContain("HTTPS_PROXY");
    expect(err.message).toContain("NODE_USE_ENV_PROXY");
    // A proxy value is an endpoint and may carry credentials.
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("127.0.0.1");
    expect(err.message).not.toContain("10809");
    expect(err.message).not.toMatch(/http:\/\//);
    expect(JSON.stringify(err.offendingVariables)).not.toContain("hunter2");
  });

  it("the model/search role may use a provider proxy", () => {
    expect(() =>
      assertDirectAcquisitionEgress(SEARCH_ONLY, {
        HTTPS_PROXY: SECRET,
        NODE_USE_ENV_PROXY: "1",
      }),
    ).not.toThrow();
  });

  it("a clean acquisition environment starts normally", () => {
    expect(() =>
      assertDirectAcquisitionEgress(FETCH_ONLY, { PATH: "/usr/bin", NO_PROXY: "localhost" }),
    ).not.toThrow();
    // An empty value is how a shell spells "unset"; it must not refuse.
    expect(() => assertDirectAcquisitionEgress(FETCH_ONLY, { HTTPS_PROXY: "  " })).not.toThrow();
    expect(findProviderProxyEnv({ HTTPS_PROXY: "" })).toEqual([]);
  });

  it("a single process holding BOTH roles is refused a provider proxy", () => {
    // One process cannot be simultaneously proxied and direct, so the
    // convenient single-box mode is incompatible with provider egress —
    // and says so at startup instead of acquiring through the proxy.
    expect(() => assertDirectAcquisitionEgress(BOTH, { NODE_USE_ENV_PROXY: "1" })).toThrow(
      DirectEgressViolationError,
    );
  });
});

describe("D-149 §B — the launcher writes the environment contract", () => {
  it("search-extract: model/search role, provider proxy, direct control plane", () => {
    const plan = buildLaunchPlan("search-extract", { PATH: "x" });
    expect(plan.env.ATLAS_WORKER_CAPABILITIES).toBe("SEARCH_EXTRACT");
    expect(parseWorkerCapabilities(plan.env.ATLAS_WORKER_CAPABILITIES)).toEqual(
      new Set(["SEARCH_EXTRACT"]),
    );
    expect(plan.env.NODE_USE_ENV_PROXY).toBe("1");
    expect(plan.env.HTTPS_PROXY).toBe(DEFAULT_PROVIDER_PROXY);
    expect(plan.env.HTTP_PROXY).toBe(DEFAULT_PROVIDER_PROXY);
    // The database and pg-boss are never forwarded.
    expect(plan.env.NO_PROXY).toBe(PROVIDER_NO_PROXY);
    expect(plan.env.NO_PROXY).toContain("127.0.0.1");
  });

  it("search-extract never enables the acquisition role", () => {
    const plan = buildLaunchPlan("search-extract", {});
    const caps = parseWorkerCapabilities(plan.env.ATLAS_WORKER_CAPABILITIES);
    expect(workerServesPhase(caps, "FETCHING")).toBe(false);
    expect(plan.env.RENDERED_DOCS_ENABLED).toBeUndefined();
  });

  it("fetch: acquisition role, renderer on, and NO provider proxy", () => {
    const plan = buildLaunchPlan("fetch", { PATH: "x" });
    expect(plan.env.ATLAS_WORKER_CAPABILITIES).toBe("FETCH");
    expect(plan.env.RENDERED_DOCS_ENABLED).toBe("1");
    for (const name of PROVIDER_PROXY_ENV_VARS) {
      expect(plan.env[name]).toBeUndefined();
    }
    // The contract it produces satisfies the guardrail by construction.
    expect(() =>
      assertDirectAcquisitionEgress(parseWorkerCapabilities("FETCH"), plan.env),
    ).not.toThrow();
  });

  it("fetch STRIPS a proxy inherited from the terminal", () => {
    // The realistic mistake: reusing the shell that launched the model-side
    // worker. The launcher must not carry that environment forward.
    const dirty = { HTTPS_PROXY: SECRET, NODE_USE_ENV_PROXY: "1", http_proxy: SECRET };
    const plan = buildLaunchPlan("fetch", dirty);
    expect(findProviderProxyEnv(plan.env)).toEqual([]);
    expect(() =>
      assertDirectAcquisitionEgress(parseWorkerCapabilities("FETCH"), plan.env),
    ).not.toThrow();
  });

  it("the dev server role is proxied but declares no worker capability", () => {
    const plan = buildLaunchPlan("dev", {});
    expect(plan.env.NODE_USE_ENV_PROXY).toBe("1");
    expect(plan.env.ATLAS_WORKER_CAPABILITIES).toBeUndefined();
    expect(plan.args.join(" ")).toContain("next");
  });

  it("the proxy endpoint is per-developer, never a product constant", () => {
    const plan = buildLaunchPlan("search-extract", {
      ATLAS_DEV_PROVIDER_PROXY: "http://127.0.0.1:7890",
    });
    expect(plan.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    // And it lives only in dev tooling — not in product configuration.
    const productConfig = readFileSync("src/server/config/product.ts", "utf-8");
    expect(productConfig).not.toContain("10809");
    expect(productConfig.toLowerCase()).not.toContain("proxy");
  });
});

describe("D-149 §C — dual workers cannot burn a job's deliveries", () => {
  // The rule startWorker applies, restated here so a change to it fails.
  const servesEntryQueue = (caps: ReadonlySet<PhaseCapability>) =>
    caps.size === 0 || workerServesPhase(caps, "SEARCHING");

  it("the entry queue IS the SEARCHING queue", () => {
    // Which is why an acquisition-only worker must not subscribe to it.
    expect(PHASE_QUEUE.SEARCHING).toBe(RESEARCH_QUEUE);
  });

  it("an acquisition-only worker does not subscribe to the entry queue", () => {
    expect(servesEntryQueue(FETCH_ONLY)).toBe(false);
    const src = readFileSync("src/server/jobs/worker.ts", "utf-8");
    expect(src).toContain("const servesEntryQueue =");
    expect(src).toContain('workerServesPhase(capabilities, "SEARCHING")');
    // ...and the subscription is actually guarded by it.
    expect(src).toMatch(/if \(servesEntryQueue\) \{[\s\S]*RESEARCH_QUEUE/);
  });

  it("every other role keeps serving the entry queue exactly as before", () => {
    expect(servesEntryQueue(SEARCH_ONLY)).toBe(true);
    expect(servesEntryQueue(BOTH)).toBe(true);
    // The undeclared single-process box is untouched: legacy jobs need no
    // phase capability, and this mode predates the phase roles entirely.
    expect(servesEntryQueue(NONE)).toBe(true);
  });

  it("capability is decided before any side effect on the job", () => {
    // It used to be asked last — after config load, after the live gate
    // (which can terminate a job) and after a provider was constructed.
    const src = readFileSync("src/server/jobs/worker.ts", "utf-8");
    const dispatch = src.slice(src.indexOf("export async function dispatchResearchQueueMessage"));
    const capabilityCheck = dispatch.indexOf('workerServesPhase(ctx.capabilities, "SEARCHING")');
    const configLoad = dispatch.indexOf("loadProductConfig");
    const liveGate = dispatch.indexOf("assertPhaseLiveAdmitted");
    const providerBuild = dispatch.indexOf("resolveQueryProposer");
    expect(capabilityCheck).toBeGreaterThan(-1);
    expect(capabilityCheck).toBeLessThan(configLoad);
    expect(capabilityCheck).toBeLessThan(liveGate);
    expect(capabilityCheck).toBeLessThan(providerBuild);
  });

  it("retry policy is UNCHANGED — the wrong-capability pickup was removed, not padded", () => {
    // Raising the delivery budget would have made the bad outcome rarer
    // while keeping it possible, and would have blunted D-147's terminal
    // reconciliation. Nothing in the repo sets a retry limit.
    const queue = readFileSync("src/server/jobs/queue.ts", "utf-8");
    expect(queue).not.toMatch(/retryLimit|retry_limit|retryDelay|retryBackoff/);
    // worker.ts explains pg-boss own rule in a D-147 comment, so the
    // assertion is about CODE: nothing configures a retry budget.
    const workerCode = readFileSync("src/server/jobs/worker.ts", "utf-8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(workerCode).not.toMatch(/retryLimit|retry_limit/);
  });

  it("a genuine execution failure still fails normally, and D-147 still terminates", () => {
    // The hand-back path survives for real inconsistencies: a refusal that
    // reaches the handler is still thrown, so the message is not silently
    // completed and lost.
    const src = readFileSync("src/server/jobs/worker.ts", "utf-8");
    expect(src).toContain("throwIfCapabilityRefusal(out.result");
    expect(src).toContain("class PhaseCapabilityMissingError");
    // And terminal exhaustion reconciliation is untouched.
    expect(src).toContain("reconcileExhaustedPhaseDeliveries");
    expect(src).toContain("PHASE_DELIVERY_EXHAUSTED");
  });
});

describe("D-149 §D — nothing about the network reached the domain", () => {
  it("the renderer environment allowlist is unchanged and still excludes proxy vars", () => {
    // The allowlist is module-private by design, so it is read as source
    // rather than exported for a test — the boundary stays closed.
    const env = readFileSync("src/server/engine/providers/renderer-env.ts", "utf-8");
    const list = env.slice(env.indexOf("ALLOWED_ENV_KEYS"), env.indexOf("];", env.indexOf("ALLOWED_ENV_KEYS")));
    for (const name of PROVIDER_PROXY_ENV_VARS) {
      expect(list, `renderer env must not admit ${name}`).not.toContain(`"${name}"`);
    }
    expect(list).not.toContain('"NODE_OPTIONS"');
    // And the child is still told explicitly to bypass nothing.
    expect(env).toContain('NO_PROXY');
  });

  it("the acquisition transport is untouched by this round", () => {
    // The pinned-address dial is the thing the guardrail exists to protect;
    // it must still be there, unchanged.
    const fetcher = readFileSync("src/server/engine/providers/content-fetcher.ts", "utf-8");
    expect(fetcher).toContain("createPinnedLookup");
    expect(fetcher).toContain("isBlockedIp");
    expect(fetcher).toContain('["198.18.0.0", 15]');
    // And it names no proxy concept at all.
    expect(fetcher.toLowerCase()).not.toContain("http_proxy");
  });

  it("no vendor, product or location name entered the new modules", () => {
    const banned = [/mantaray/i, /\bhapp\b/i, /\bvpn\b/i, /wireguard/i, /openvpn/i, /russia/i, /raydium/i, /\bgeo\b/i, /country/i];
    for (const file of ["src/server/jobs/egress-integrity.ts", "scripts/dev-launch.ts"]) {
      const src = readFileSync(file, "utf-8");
      for (const pattern of banned) {
        expect(src, `${file} must not mention ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("capability is still declared, never inferred from the environment", () => {
    // The guardrail validates that the environment AGREES with the declared
    // capability. It must never read the environment to decide what the
    // process may do — that inversion is what D-136 forbids.
    const src = readFileSync("src/server/jobs/egress-integrity.ts", "utf-8");
    expect(src).not.toMatch(/ATLAS_WORKER_CAPABILITIES/);
    expect(src).not.toMatch(/loadWorkerCapabilities/);
    // And the capability module itself learned nothing about networks.
    const caps = readFileSync("src/server/jobs/worker-capabilities.ts", "utf-8");
    expect(caps.toLowerCase()).not.toContain("proxy");
  });
});
