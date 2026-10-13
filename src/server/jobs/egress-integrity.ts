import { workerServesPhase, type PhaseCapability } from "./worker-capabilities";

// D-149 — EGRESS INTEGRITY: THE ENVIRONMENT MUST AGREE WITH THE DECLARED
// CAPABILITY.
//
// This is deployment-layer validation, not domain logic, and the direction
// matters: it never infers a capability from the environment (D-136 forbids
// exactly that). Capability is still declared, and only declared. What this
// asserts is the converse — that the process environment is CONSISTENT with
// what was declared, and refuses to start when it is not.
//
// WHY THE SOURCE-ACQUISITION ROLE IS SPECIAL. Its whole contract is direct,
// DNS-validated, IP-pinned egress: resolve the host, refuse blocked and
// reserved addresses, then dial THAT VALIDATED ADDRESS. A forwarding proxy
// breaks the second half. Node's env-proxy support routes `node:http`/
// `node:https` as well as fetch, and — measured on this runtime, not
// assumed — it bypasses a custom `lookup`, so the pinned-address connection
// silently stops happening while the pre-connect validation still passes.
// The request then leaves through somewhere else entirely, and NOTHING
// reports an error. That is the one failure mode here that is both
// security-relevant and completely silent, which is why it is refused at
// startup rather than merely documented.
//
// The role that talks to model and search providers is unaffected: it holds
// no pinned-address contract, and configuring its egress explicitly is the
// supported way to give a process provider reach.
//
// FAIL CLOSED, AND REPAIR NOTHING. An unsafe environment is an operator
// decision this process must not silently overwrite: deleting the variables
// and continuing would hide a launch mistake whose whole danger is that it
// is invisible. It stops, names the offending VARIABLES, and exits.

// Both cases are honoured because the runtime's env-proxy support reads
// both, so checking only the upper-case spelling would leave a real hole.
export const PROVIDER_PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

export class DirectEgressViolationError extends Error {
  constructor(readonly offendingVariables: readonly string[]) {
    // NAMES ONLY, NEVER VALUES. A proxy variable's value is an endpoint and
    // may carry credentials; the operator needs to know WHICH variable to
    // remove, and nothing else.
    super("FETCH_EGRESS_PROXY_FORBIDDEN: " + offendingVariables.join(", "));
    this.name = "DirectEgressViolationError";
  }
}

// A variable counts as present only when it holds a non-empty value: an
// empty string is how a shell spells "unset" for these, and treating it as
// set would refuse a clean environment.
// Accepts any string map so callers (and tests) need no cast; process.env
// satisfies it.
export function findProviderProxyEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return PROVIDER_PROXY_ENV_VARS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

// Called at worker bootstrap, before any queue is subscribed, so a
// misconfigured process never accepts a single message.
export function assertDirectAcquisitionEgress(
  capabilities: ReadonlySet<PhaseCapability>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!workerServesPhase(capabilities, "FETCHING")) return;
  const offending = findProviderProxyEnv(env);
  if (offending.length > 0) throw new DirectEgressViolationError(offending);
}
