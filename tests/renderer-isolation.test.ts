import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  decideEgress,
  parseConnectTarget,
  startEgressProxy,
} from "../src/server/engine/providers/render-egress-proxy";
import {
  buildRendererEnv,
  FORBIDDEN_ENV_KEYS,
  proxyChromiumArgs,
} from "../src/server/engine/providers/renderer-env";
import {
  buildChildCommand,
  createIsolatedRenderedDocsFetcher,
} from "../src/server/engine/providers/rendered-docs-isolated";
import {
  DEFAULT_RENDER_LIMITS,
  RenderedDocsError,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import type { ChildRenderRequest } from "../src/server/engine/providers/rendered-docs-child";

// RENDERER RUNTIME ISOLATION — entirely offline.
//
// No browser is launched, no child process is spawned, and no DNS query is
// made: the spawn seam and the resolver are both injected. What is proven
// here is the BOUNDARY, not the browser: which secrets cross it, which
// destinations are reachable, and what happens when the far side
// misbehaves.

const HOST = "docs.example-project.test";
const PREFIX = "/docs";
const URL_IN = `https://${HOST}/docs/fees`;
const ROUTE = { confirmedHost: HOST, matchedPathPrefix: PREFIX };

// A parent environment carrying every secret ATLAS actually holds.
const PARENT_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PATH: "/usr/bin",
  SystemRoot: "C:\\Windows",
  ANTHROPIC_API_KEY: "sk-ant-SECRET",
  BRAVE_SEARCH_API_KEY: "BSA-SECRET",
  DATABASE_URL: "postgres://user:pw@localhost:5432/atlas_dev",
  TEST_DATABASE_URL: "postgres://user:pw@localhost:5432/atlas_test",
  CSRF_SECRET: "csrf-SECRET",
  BOT_TOKEN: "telegram-SECRET",
  SOLANA_MAINNET_RPC_URL: "https://rpc.example/APIKEY",
  ALLOWED_ORIGINS: "https://app.atlas.test",
  AUTH_DEV_BYPASS: "1",
  MODEL_GATEWAY: "anthropic",
};

describe("secret boundary — the renderer child's environment", () => {
  const env = buildRendererEnv({ parentEnv: PARENT_ENV, proxyPort: 45123 });

  it("carries NO ATLAS secret of any kind", () => {
    for (const key of FORBIDDEN_ENV_KEYS) {
      expect(env[key], `${key} leaked into the renderer`).toBeUndefined();
    }
  });

  it("no secret VALUE appears anywhere in the child environment", () => {
    // Stronger than key-absence: proves nothing was smuggled under a
    // different name.
    const serialized = JSON.stringify(env);
    for (const secret of [
      "sk-ant-SECRET", "BSA-SECRET", "csrf-SECRET", "telegram-SECRET",
      "APIKEY", "postgres://",
    ]) {
      expect(serialized, `value "${secret}" leaked`).not.toContain(secret);
    }
  });

  it("has no database configuration at all", () => {
    for (const key of Object.keys(env)) {
      expect(key.toUpperCase()).not.toContain("DATABASE");
      expect(key.toUpperCase()).not.toContain("POSTGRES");
    }
  });

  it("is an ALLOWLIST: a newly added secret is excluded by default", () => {
    // The property that matters long-term — a denylist would leak this.
    const withNewSecret = buildRendererEnv({
      parentEnv: { ...PARENT_ENV, SOME_FUTURE_API_KEY: "future-SECRET" },
      proxyPort: 1,
    });
    expect(withNewSecret.SOME_FUTURE_API_KEY).toBeUndefined();
    expect(JSON.stringify(withNewSecret)).not.toContain("future-SECRET");
  });

  it("keeps only the OS/runtime plumbing a browser needs", () => {
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.ATLAS_RENDER_PROXY_PORT).toBe("45123");
  });

  it("forces every browser request through the proxy with no bypass", () => {
    const args = proxyChromiumArgs(45123).join(" ");
    expect(args).toContain("--proxy-server=http://127.0.0.1:45123");
    // The load-bearing half: without this, Chromium bypasses the proxy for
    // loopback by default, leaving exactly the hole the boundary closes.
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
  });
});

describe("egress boundary — deny by default", () => {
  const lookupPublic = async () => ({ address: "93.184.216.34" });

  it("allows the confirmed host over https", async () => {
    expect(
      await decideEgress(`${HOST}:443`, { confirmedHost: HOST, lookup: lookupPublic }),
    ).toMatchObject({ allow: true });
  });

  it("denies cross-origin, including CDNs", async () => {
    for (const target of ["cdn.jsdelivr.test:443", "fonts.googleapis.test:443", "evil.test:443"]) {
      expect(
        await decideEgress(target, { confirmedHost: HOST, lookup: lookupPublic }),
      ).toMatchObject({ allow: false, reason: "HOST_NOT_CONFIRMED" });
    }
  });

  it("denies non-443 ports — https only", async () => {
    expect(
      await decideEgress(`${HOST}:80`, { confirmedHost: HOST, lookup: lookupPublic }),
    ).toMatchObject({ allow: false, reason: "NOT_HTTPS" });
    expect(
      await decideEgress(`${HOST}:8080`, { confirmedHost: HOST, lookup: lookupPublic }),
    ).toMatchObject({ allow: false, reason: "NOT_HTTPS" });
  });

  it("denies a confirmed host that resolves to a private address", async () => {
    // The DNS-rebinding shape: right name, wrong destination. Validated at
    // the boundary, so the browser cannot reach it by resolving itself.
    for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "169.254.169.254"]) {
      expect(
        await decideEgress(`${HOST}:443`, {
          confirmedHost: HOST,
          lookup: async () => ({ address }),
        }),
        address,
      ).toMatchObject({ allow: false, reason: "BLOCKED_ADDRESS" });
    }
  });

  it("denies a literal private IP target directly", async () => {
    expect(
      await decideEgress("127.0.0.1:443", { confirmedHost: "127.0.0.1", lookup: lookupPublic }),
    ).toMatchObject({ allow: false, reason: "BLOCKED_ADDRESS" });
  });

  it("denies when DNS fails rather than falling through", async () => {
    expect(
      await decideEgress(`${HOST}:443`, {
        confirmedHost: HOST,
        lookup: async () => { throw new Error("ENOTFOUND"); },
      }),
    ).toMatchObject({ allow: false, reason: "DNS_FAILED" });
  });

  it("denies malformed targets", async () => {
    for (const target of ["", "no-port", "host:notaport", "host:99999", "a".repeat(400)]) {
      expect(
        await decideEgress(target, { confirmedHost: HOST, lookup: lookupPublic }),
      ).toMatchObject({ allow: false });
    }
    expect(parseConnectTarget("host:443")).toEqual({ host: "host", port: 443 });
    expect(parseConnectTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
  });

  it("a plain http request through the proxy is refused (no bypass route)", async () => {
    const proxy = await startEgressProxy({ confirmedHost: HOST, lookup: lookupPublic });
    try {
      // Loopback only — a request to the proxy itself, which is the one
      // socket a browser could reach without leaving the machine.
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`).catch(() => null);
      expect(res?.status).toBe(403);
      expect(proxy.decisions.some((d) => !d.allowed && d.reason === "NOT_HTTPS")).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("the proxy binds to loopback only, never acting as an open relay", async () => {
    const proxy = await startEgressProxy({ confirmedHost: HOST, lookup: lookupPublic });
    try {
      expect(proxy.port).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });
});

describe("process supervision — fail closed", () => {
  function fakeProxy() {
    return async () => ({
      port: 45123,
      decisions: [] as { target: string; allowed: boolean }[],
      close: async () => {},
    });
  }

  function isolated(spawnImpl: (a: {
    scriptPath: string;
    env: Record<string, string>;
    request: ChildRenderRequest;
  }) => Promise<{ stdout: string; code: number | null }>) {
    return createIsolatedRenderedDocsFetcher({
      spawnChild: spawnImpl,
      startProxy: fakeProxy() as never,
      parentEnv: PARENT_ENV,
      limits: { ...DEFAULT_RENDER_LIMITS, browserLaunchTimeoutMs: 200, totalWallClockMs: 200 },
    });
  }

  const goodDocument = {
    renderMode: "RENDERED",
    finalUrl: URL_IN,
    requestedUrl: URL_IN,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "Fees are routed to the protocol vault.",
    contentHash: "sha256:abc",
    fetchedAt: new Date().toISOString(),
    byteLength: 1000,
  };

  it("a well-formed child result becomes a document", async () => {
    const f = isolated(async () => ({
      stdout: JSON.stringify({ ok: true, document: goodDocument }),
      code: 0,
    }));
    const doc = await f.render(URL_IN, ROUTE);
    expect(doc.normalizedText).toContain("protocol vault");
    expect(doc.fetchedAt).toBeInstanceOf(Date);
  });

  it("EXACTLY ONE child render request, and zero retries on failure", async () => {
    let calls = 0;
    const f = isolated(async () => {
      calls += 1;
      return { stdout: JSON.stringify({ ok: false, reason: "RENDER_FAILED" }), code: 0 };
    });
    await f.render(URL_IN, ROUTE).catch(() => {});
    expect(calls).toBe(1);
  });

  it("the child receives ONLY the minimal render request", async () => {
    let seen: ChildRenderRequest | null = null;
    const f = isolated(async (a) => {
      seen = a.request;
      return { stdout: JSON.stringify({ ok: true, document: goodDocument }), code: 0 };
    });
    await f.render(URL_IN, ROUTE);
    // A CLOSED field list. The child's request payload is a security
    // surface: everything the isolated process learns about the parent
    // arrives through it, so adding a field must be a deliberate, reviewed
    // act rather than a side effect. observeNetwork was added under owner
    // authorization for passive observation and is a plain boolean.
    // inspectionDiagnostics was added for the owner inspection entrypoint
    // and is likewise a plain boolean: it tells the child whether to
    // DESCRIBE a failure, and nothing about it changes what the child
    // renders, allows, blocks or returns. It carries no value the child
    // did not already have.
    expect(Object.keys(seen!).sort()).toEqual(
      [
        "confirmedHost",
        "inspectionDiagnostics",
        "limits",
        "matchedPathPrefix",
        "observeNetwork",
        "proxyPort",
        "recoverNeedles",
        "url",
      ].sort(),
    );
    expect(JSON.stringify(seen)).not.toContain("SECRET");
    // All three opt-ins default OFF: an ordinary render tells the child to
    // observe nothing, recover nothing and describe nothing.
    const request = seen as unknown as {
      observeNetwork: boolean;
      recoverNeedles: string[];
      inspectionDiagnostics: boolean;
    };
    expect(request.observeNetwork).toBe(false);
    expect(request.recoverNeedles).toEqual([]);
    expect(request.inspectionDiagnostics).toBe(false);
  });

  it("the child is spawned with the scrubbed environment", async () => {
    let seenEnv: Record<string, string> | null = null;
    const f = isolated(async (a) => {
      seenEnv = a.env;
      return { stdout: JSON.stringify({ ok: true, document: goodDocument }), code: 0 };
    });
    await f.render(URL_IN, ROUTE);
    expect(JSON.stringify(seenEnv)).not.toContain("SECRET");
    expect(seenEnv!.DATABASE_URL).toBeUndefined();
  });

  it("a child crash (non-zero exit) fails closed", async () => {
    const f = isolated(async () => ({ stdout: "", code: 1 }));
    await expect(f.render(URL_IN, ROUTE)).rejects.toBeInstanceOf(RenderedDocsError);
  });

  it("a child killed by signal fails closed", async () => {
    const f = isolated(async () => ({ stdout: "partial", code: null }));
    await expect(f.render(URL_IN, ROUTE)).rejects.toBeInstanceOf(RenderedDocsError);
  });

  it("malformed child output is rejected, never coerced", async () => {
    for (const stdout of [
      "not json",
      "",
      JSON.stringify({ ok: true }),                                  // no document
      JSON.stringify({ ok: true, document: { renderMode: "STATIC" } }), // wrong mode
      JSON.stringify({ ok: true, document: { renderMode: "RENDERED" } }), // missing fields
      JSON.stringify({ ok: false, reason: "RENDER_FAILED" }),
    ]) {
      const f = isolated(async () => ({ stdout, code: 0 }));
      await expect(f.render(URL_IN, ROUTE), stdout.slice(0, 30)).rejects.toBeInstanceOf(
        RenderedDocsError,
      );
    }
  });

  it("a wedged child is killed by the parent deadline", async () => {
    const f = isolated(
      () => new Promise(() => {}), // never resolves
    );
    const started = Date.now();
    await expect(f.render(URL_IN, ROUTE)).rejects.toMatchObject({ reason: "TIMEOUT" });
    // Parent deadline is BOTH child phase budgets — startup and document —
    // plus the isolation allowance. Shrinking only one no longer shortens it.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("the egress boundary is torn down after every render, success or failure", async () => {
    let closed = 0;
    const proxy = async () => ({
      port: 45123,
      decisions: [],
      close: async () => { closed += 1; },
    });
    const mk = (stdout: string, code: number) =>
      createIsolatedRenderedDocsFetcher({
        spawnChild: async () => ({ stdout, code }),
        startProxy: proxy as never,
        parentEnv: PARENT_ENV,
      });
    await mk(JSON.stringify({ ok: true, document: goodDocument }), 0).render(URL_IN, ROUTE);
    await mk("", 1).render(URL_IN, ROUTE).catch(() => {});
    expect(closed).toBe(2);
  });
});

describe("child process invocation — no shell, no injection surface", () => {
  // Regression for DEP0190, observed on the first live render:
  // spawn("npx", ["tsx", path], { shell: true }) concatenates arguments
  // into a cmd.exe command STRING on Windows, so any shell metacharacter
  // in a path is interpreted rather than treated as a filename. The path
  // was code-owned and therefore not exploitable, but a shell-
  // concatenating spawn inside the isolation boundary is the wrong place
  // to leave a latent injection primitive.
  it("spawns an absolute executable with argv, never a shell", () => {
    const cmd = buildChildCommand("/tmp/child.ts");
    expect(cmd.useShell).toBe(false);
    // The running Node binary, resolved absolutely — no PATH lookup for
    // "npx" that could be hijacked.
    expect(cmd.command).toBe(process.execPath);
    expect(path.isAbsolute(cmd.command)).toBe(true);
    // tsx resolved to a real absolute file, not a bare package name.
    expect(path.isAbsolute(cmd.args[0])).toBe(true);
    expect(cmd.args[0]).toMatch(/tsx/);
    expect(cmd.args[1]).toBe("/tmp/child.ts");
  });

  it("shell metacharacters in a path stay ONE argv element", () => {
    // If this were ever shell-concatenated, cmd.exe would split on && and
    // run a second command. As argv, it is just an (absurd) filename.
    const hostile = 'C:\\tmp\\child.ts" && calc.exe && "';
    const cmd = buildChildCommand(hostile);
    // The property that matters is CONTAINMENT, not that the text
    // disappears: the whole hostile string is exactly ONE argv element, so
    // there is no command line for cmd.exe to re-split on `&&`. It reaches
    // the OS as an (absurd) filename, which simply fails to open.
    expect(cmd.args).toHaveLength(2);
    expect(cmd.args[1]).toBe(hostile); // verbatim, unsplit, unquoted
    expect(cmd.useShell).toBe(false);
    // And nothing was appended into the executable or the loader slot.
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args[0]).not.toContain("calc.exe");
  });

  it("a path with spaces needs no quoting because there is no shell", () => {
    const spaced = "C:\\Program Files\\atlas\\child.ts";
    const cmd = buildChildCommand(spaced);
    expect(cmd.args[1]).toBe(spaced);
    expect(cmd.args[1]).not.toContain('"'); // no manual quoting anywhere
  });

  it("the source contains no shell:true and no npx invocation", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/rendered-docs-isolated.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toMatch(/shell:\s*true/);
    expect(code).not.toMatch(/shell:\s*process\.platform/);
    expect(code).not.toContain('spawn("npx"');
    expect(code).toMatch(/shell:\s*false/);
  });

  it("isolation guarantees survive the spawn change", async () => {
    // The fix must not have quietly dropped anything the boundary relies
    // on: scrubbed env, one request, no retry, timeout, output validation.
    let calls = 0;
    let seenEnv: Record<string, string> | null = null;
    const f = createIsolatedRenderedDocsFetcher({
      spawnChild: async (a) => {
        calls += 1;
        seenEnv = a.env;
        return { stdout: "not json", code: 0 };
      },
      startProxy: (async () => ({ port: 1, decisions: [], close: async () => {} })) as never,
      parentEnv: PARENT_ENV,
    });
    await expect(f.render(URL_IN, ROUTE)).rejects.toBeInstanceOf(RenderedDocsError);
    expect(calls).toBe(1); // one request, zero retry
    expect(JSON.stringify(seenEnv)).not.toContain("SECRET"); // still scrubbed
  });
});

describe("child module hygiene", () => {
  it("the renderer child imports no ATLAS data layer", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/engine/providers/rendered-docs-child.ts",
      "../src/server/engine/providers/rendered-docs-playwright.ts",
    ]) {
      const raw = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      const imports = raw.split("\n").filter((l) => l.trim().startsWith("import"));
      const joined = imports.join("\n");
      for (const banned of ["db/client", "db/schema", "drizzle", "pg", "runtime"]) {
        expect(joined, `child imports "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("playwright is a production dependency, pinned by the lockfile", async () => {
    const fs = await import("node:fs/promises");
    const pkg = JSON.parse(
      await fs.readFile(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.playwright).toBeTruthy();
    const lock = JSON.parse(
      await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf-8"),
    ) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/playwright"]?.version).toBeTruthy();
  });

  it("production code does not depend on @playwright/test", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/engine/providers/rendered-docs-playwright.ts",
      "../src/server/engine/providers/rendered-docs-child.ts",
      "../src/server/engine/providers/rendered-docs-isolated.ts",
    ]) {
      const raw = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      expect(raw).not.toContain("@playwright/test");
    }
  });

  it("no project-specific literal appears in the isolation modules", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/engine/providers/render-egress-proxy.ts",
      "../src/server/engine/providers/renderer-env.ts",
      "../src/server/engine/providers/rendered-docs-isolated.ts",
      "../src/server/engine/providers/rendered-docs-child.ts",
    ]) {
      const raw = (await fs.readFile(new URL(path, import.meta.url), "utf-8")).toLowerCase();
      // "solana" is deliberately NOT banned here: renderer-env.ts names
      // SOLANA_MAINNET_RPC_URL in its forbidden-secrets tripwire, which is
      // an infrastructure config KEY that must be excluded from the child,
      // not research logic. Banning it would force us to stop naming a
      // secret we specifically need to keep out.
      for (const banned of ["pump", "buyback"]) {
        expect(raw, `${path} contains "${banned}"`).not.toContain(banned);
      }
    }
  });
});
