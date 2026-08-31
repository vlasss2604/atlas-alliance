// D-149 — ROLE-SPECIFIC LOCAL DEVELOPMENT LAUNCHER.
//
// LOCAL DEVELOPMENT INFRASTRUCTURE ONLY. Nothing here is production
// configuration, and nothing here is imported by the engine: it exists so a
// human never has to assemble a process environment by hand, because the
// dangerous mistake in this setup is silent. Giving the source-acquisition
// worker a forwarding proxy would reroute validated, IP-pinned requests
// without any error appearing — so the safe environments are written down
// once, here, and the worker refuses to start if they are ever wrong
// anyway (egress-integrity.ts).
//
// WHY A SCRIPT RATHER THAN INLINE npm ENV. `VAR=value command` is POSIX
// shell syntax and does not work in cmd.exe or PowerShell, which is the
// current development environment; the alternative is a dependency whose
// only job is assigning variables. A dozen lines of Node is smaller than a
// dependency and works identically everywhere.
//
// WHY IT SPAWNS. The runtime reads its env-proxy switch once, at process
// bootstrap. Setting it in this process and importing the worker would be
// too late — the child must be born with the right environment.
//
// The proxy endpoint is a LOCAL, per-developer detail and is deliberately
// not a constant of the product: override it with ATLAS_DEV_PROVIDER_PROXY.
import { spawn } from "node:child_process";

import { PROVIDER_PROXY_ENV_VARS } from "../src/server/jobs/egress-integrity";

export const DEV_ROLES = ["search-extract", "fetch", "dev"] as const;
export type DevRole = (typeof DEV_ROLES)[number];

export const DEFAULT_PROVIDER_PROXY = "http://127.0.0.1:10809";

// Loopback and intra-host traffic must never be forwarded: the database,
// pg-boss and the dev server's own calls are direct by definition.
export const PROVIDER_NO_PROXY = "localhost,127.0.0.1,::1";

export interface LaunchPlan {
  command: string;
  args: string[];
  // A plain string map rather than NodeJS.ProcessEnv: this is a plan built
  // from an arbitrary base, not the ambient environment of this process.
  env: Record<string, string | undefined>;
}

// Pure, so the environment contract is testable without starting anything.
export function buildLaunchPlan(
  role: DevRole,
  base: Readonly<Record<string, string | undefined>> = process.env,
): LaunchPlan {
  const env: Record<string, string | undefined> = { ...base };

  // Start from a clean slate in EVERY role: a proxy variable inherited from
  // the terminal is exactly how the source-acquisition worker would be
  // misconfigured, and roles that DO want one set it explicitly below.
  for (const name of PROVIDER_PROXY_ENV_VARS) delete env[name];

  const proxy = base.ATLAS_DEV_PROVIDER_PROXY ?? DEFAULT_PROVIDER_PROXY;
  const withProviderProxy = () => {
    env.NODE_USE_ENV_PROXY = "1";
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.NO_PROXY = PROVIDER_NO_PROXY;
  };

  switch (role) {
    case "search-extract":
      // Model and search reach through the provider proxy; the database and
      // pg-boss stay direct via NO_PROXY. This role performs no live
      // document acquisition at all — extraction replays what was already
      // acquired — so nothing here carries a pinned-address contract.
      env.ATLAS_WORKER_CAPABILITIES = "SEARCH_EXTRACT";
      withProviderProxy();
      return { command: "npx", args: ["tsx", "src/server/jobs/worker.ts"], env };

    case "fetch":
      // Direct egress, system DNS, pinned-IP dialling, renderer enabled.
      // No provider proxy is set — and any inherited one was deleted above.
      env.ATLAS_WORKER_CAPABILITIES = "FETCH";
      env.RENDERED_DOCS_ENABLED = "1";
      return { command: "npx", args: ["tsx", "src/server/jobs/worker.ts"], env };

    case "dev":
      // The dev server interprets questions in-process through a model
      // provider, so it needs the same reach as the model-side worker.
      // `npm run dev` stays direct and unchanged.
      withProviderProxy();
      return { command: "npx", args: ["next", "dev"], env };
  }
}

function usage(): never {
  console.error("usage: npx tsx scripts/dev-launch.ts <" + DEV_ROLES.join("|") + ">");
  process.exit(1);
}

function main(): void {
  const role = process.argv[2] as DevRole | undefined;
  if (!role || !(DEV_ROLES as readonly string[]).includes(role)) usage();

  const plan = buildLaunchPlan(role);
  const proxied = plan.env.NODE_USE_ENV_PROXY === "1";
  console.log(
    `[dev-launch] role=${role} capabilities=${plan.env.ATLAS_WORKER_CAPABILITIES ?? "(none)"} ` +
      `provider-egress=${proxied ? "proxied" : "direct"}`,
  );

  const child = spawn(plan.command, plan.args, {
    // The plan is a plain map; the spawn API wants the ambient env type.
    env: plan.env as NodeJS.ProcessEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
}

// Only when executed directly — importing this for its contract must not
// start a process.
if (process.argv[1] && process.argv[1].endsWith("dev-launch.ts")) {
  main();
}
