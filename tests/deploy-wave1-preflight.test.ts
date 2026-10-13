import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PROVIDER_PROXY_ENV_VARS } from "../src/server/jobs/egress-integrity";
import { parseWorkerCapabilities } from "../src/server/jobs/worker-capabilities";

// WAVE 1 DEPLOYMENT PACKAGE — the preflight is the one place a hosted
// process can be stopped before it starts with the wrong environment, so it
// must fail CLOSED, and the templates must stay in step with it and with
// the code it guards.

const DIR = "deploy/wave1";
const PREFLIGHT = `${DIR}/preflight-env.sh`;

const WEB_OK: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/atlas_beta",
  ANTHROPIC_API_KEY: "x",
  BOT_TOKEN: "x",
  CSRF_SECRET: "x",
  ALLOWED_ORIGINS: "https://atlas.example.com",
};
const WORKER_OK: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/atlas_beta",
  ANTHROPIC_API_KEY: "x",
  BRAVE_SEARCH_API_KEY: "x",
  SOLANA_MAINNET_RPC_URL: "https://rpc.example/solana",
  ETHEREUM_MAINNET_RPC_URL: "https://rpc.example/eth",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/atlas/ms-playwright",
  ATLAS_WORKER_CAPABILITIES: "SEARCH_EXTRACT,FETCH",
  ONCHAIN_RESEARCH_ENABLED: "1",
  RENDERED_DOCS_ENABLED: "1",
};

// A clean environment: nothing inherited from the test runner can make a
// case pass or fail by accident. (The project's ProcessEnv type insists on
// NODE_ENV; a child environment deliberately may lack it.)
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra } as unknown as NodeJS.ProcessEnv;
}

function preflight(role: string, env: Record<string, string>) {
  const res = spawnSync("/bin/sh", [PREFLIGHT, role], { env: cleanEnv(env), encoding: "utf8" });
  return { status: res.status, stderr: res.stderr };
}

// KEY='value' assignments in a template, comments ignored.
function assignedKeys(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)='([^']*)'$/.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const FORBIDDEN = ["AUTH_DEV_BYPASS", "ATLAS_DEV_PROVIDER_PROXY", ...PROVIDER_PROXY_ENV_VARS];

describe("Wave 1 preflight-env.sh", () => {
  it("accepts a complete production web and worker environment", () => {
    expect(preflight("web", WEB_OK).status).toBe(0);
    expect(preflight("worker", WORKER_OK).status).toBe(0);
  });

  it("refuses an unknown role", () => {
    expect(preflight("fetch", WORKER_OK).status).not.toBe(0);
    expect(preflight("", WEB_OK).status).not.toBe(0);
  });

  it.each(FORBIDDEN)("refuses to start either role when %s is set, naming it", (name) => {
    for (const [role, env] of [["web", WEB_OK], ["worker", WORKER_OK]] as const) {
      const out = preflight(role, { ...env, [name]: "http://127.0.0.1:10809" });
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain(name);
      // Names only: a value never reaches the log.
      expect(out.stderr).not.toContain("10809");
    }
  });

  it("refuses a non-production NODE_ENV", () => {
    expect(preflight("web", { ...WEB_OK, NODE_ENV: "development" }).status).not.toBe(0);
    const { NODE_ENV: _drop, ...noNodeEnv } = WORKER_OK;
    void _drop;
    expect(preflight("worker", noNodeEnv).status).not.toBe(0);
  });

  it.each(Object.keys(WEB_OK).filter((k) => k !== "NODE_ENV"))("web refuses when %s is missing", (name) => {
    const env = { ...WEB_OK };
    delete env[name];
    const out = preflight("web", env);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(name);
  });

  it.each(Object.keys(WORKER_OK).filter((k) => k !== "NODE_ENV"))("worker refuses when %s is missing", (name) => {
    const env = { ...WORKER_OK };
    delete env[name];
    expect(preflight("worker", env).status).not.toBe(0);
  });

  it("web refuses an http origin, because the session cookie is Secure", () => {
    expect(preflight("web", { ...WEB_OK, ALLOWED_ORIGINS: "http://atlas.example.com" }).status).not.toBe(0);
    expect(preflight("web", { ...WEB_OK, ALLOWED_ORIGINS: "https://a.example.com,http://b.example.com" }).status).not.toBe(0);
  });

  it("worker refuses a split or truthy-looking capability declaration", () => {
    expect(preflight("worker", { ...WORKER_OK, ATLAS_WORKER_CAPABILITIES: "FETCH" }).status).not.toBe(0);
    expect(preflight("worker", { ...WORKER_OK, ONCHAIN_RESEARCH_ENABLED: "true" }).status).not.toBe(0);
    expect(preflight("worker", { ...WORKER_OK, RENDERED_DOCS_ENABLED: "yes" }).status).not.toBe(0);
  });
});

describe("Wave 1 templates", () => {
  const shared = assignedKeys(`${DIR}/atlas.env.example`);
  const worker = assignedKeys(`${DIR}/worker.env.example`);

  it("hold no secret value — every secret slot is empty", () => {
    for (const name of ["DATABASE_URL", "BOT_TOKEN", "CSRF_SECRET", "ALLOWED_ORIGINS", "ANTHROPIC_API_KEY", "BRAVE_SEARCH_API_KEY", "SOLANA_MAINNET_RPC_URL", "ETHEREUM_MAINNET_RPC_URL"]) {
      expect(shared.has(name), name).toBe(true);
      expect(shared.get(name), name).toBe("");
    }
  });

  it("assign no forbidden variable", () => {
    for (const name of FORBIDDEN) {
      expect(shared.has(name), name).toBe(false);
      expect(worker.has(name), name).toBe(false);
    }
  });

  it("declare exactly what the preflight requires of a combined worker", () => {
    const merged = { ...Object.fromEntries(shared), ...Object.fromEntries(worker) };
    for (const name of Object.keys(WORKER_OK)) expect(name in merged, name).toBe(true);
    expect(merged.NODE_ENV).toBe("production");
    expect(merged.ONCHAIN_RESEARCH_ENABLED).toBe("1");
    expect(merged.RENDERED_DOCS_ENABLED).toBe("1");
    expect([...parseWorkerCapabilities(merged.ATLAS_WORKER_CAPABILITIES)].sort()).toEqual(["FETCH", "SEARCH_EXTRACT"]);
  });

  it("units run the preflight before the process and reference files that exist", () => {
    const web = readFileSync(`${DIR}/atlas-web.service`, "utf8");
    const wrk = readFileSync(`${DIR}/atlas-worker.service`, "utf8");
    expect(web).toContain("preflight-env.sh web");
    expect(wrk).toContain("preflight-env.sh worker");
    expect(web).toMatch(/next start -H 127\.0\.0\.1/);
    expect(wrk).toContain("src/server/jobs/worker.ts");
    expect(wrk).toContain("EnvironmentFile=/etc/atlas/worker.env");
    expect(existsSync("src/server/jobs/worker.ts")).toBe(true);
    for (const f of ["preflight-env.sh", "with-env.sh", "atlas-backup.sh", "Caddyfile", "atlas-backup.timer", "RUNBOOK.md"]) {
      expect(existsSync(`${DIR}/${f}`), f).toBe(true);
    }
  });
});

describe("Wave 1 with-env.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-with-env-"));
  const shared = join(dir, "atlas.env");
  const worker = join(dir, "worker.env");
  // The template format: KEY='value'. A URL with & and $ must come through
  // byte for byte — unquoted shell sourcing would break on exactly this.
  writeFileSync(shared, "NODE_ENV='production'\nSOLANA_MAINNET_RPC_URL='https://rpc.example/?a=1&b=$NOT_EXPANDED'\n");
  writeFileSync(worker, "ATLAS_WORKER_CAPABILITIES='SEARCH_EXTRACT,FETCH'\n");
  const run = (args: string[]) =>
    spawnSync("/bin/sh", [`${DIR}/with-env.sh`, ...args], {
      env: cleanEnv({ ATLAS_ENV_FILE: shared, ATLAS_WORKER_ENV_FILE: worker, ATLAS_APP_DIR: process.cwd() }),
      encoding: "utf8",
    });

  it("loads single-quoted values exactly, without shell expansion", () => {
    const out = run(["printenv", "SOLANA_MAINNET_RPC_URL"]);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("https://rpc.example/?a=1&b=$NOT_EXPANDED");
  });

  it("loads the worker file only with --worker", () => {
    expect(run(["printenv", "ATLAS_WORKER_CAPABILITIES"]).status).not.toBe(0);
    const out = run(["--worker", "printenv", "ATLAS_WORKER_CAPABILITIES"]);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("SEARCH_EXTRACT,FETCH");
  });

  it("refuses to run without a command or with an unreadable env file", () => {
    expect(run([]).status).not.toBe(0);
    const missing = spawnSync("/bin/sh", [`${DIR}/with-env.sh`, "true"], {
      env: cleanEnv({ ATLAS_ENV_FILE: join(dir, "absent.env") }),
      encoding: "utf8",
    });
    expect(missing.status).not.toBe(0);
  });

  it("the shipped templates source cleanly in sh", () => {
    const out = spawnSync("/bin/sh", [`${DIR}/with-env.sh`, "--worker", "printenv", "ATLAS_WORKER_CAPABILITIES"], {
      env: cleanEnv({ ATLAS_ENV_FILE: `${DIR}/atlas.env.example`, ATLAS_WORKER_ENV_FILE: `${DIR}/worker.env.example`, ATLAS_APP_DIR: process.cwd() }),
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("SEARCH_EXTRACT,FETCH");
  });
});
