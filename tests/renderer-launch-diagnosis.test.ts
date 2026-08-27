import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_LAUNCH_DIAGNOSTICS,
  CHILD_REPORTABLE_RENDER_REASONS,
  RenderedDocsError,
  classifyBrowserLaunchFailure,
  isBrowserLaunchDiagnostic,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import {
  createIsolatedRenderedDocsFetcher,
  runIsolatedRendererSelfTest,
} from "../src/server/engine/providers/rendered-docs-isolated";
import { FORBIDDEN_ENV_KEYS, buildRendererEnv } from "../src/server/engine/providers/renderer-env";

// WHY A BROWSER DID NOT START.
//
// BROWSER_LAUNCH_FAILED already separated a local fault from a site that
// defeated us. It did not say WHICH local fault, and the error that would
// say so cannot be shown: every real launch failure observed while
// building this carried an absolute filesystem path, and two of the three
// carried Chromium's ENTIRE command line — around two kilobytes of local
// configuration — inside the message.
//
// So the message is read once, matched against fixed code-authored
// substrings, reduced to one enum value, and dropped.
//
// THE FIXTURES BELOW ARE REAL. Each was produced offline by inducing the
// failure against the actual installed Playwright and capturing verbatim
// what it emitted. Nothing here was written from documentation, and the
// classifications this repository does NOT make are just as deliberate:
// a permission-denied spawn, a profile/temp-directory failure and Linux's
// missing-shared-library case could not be induced on this platform, so
// they are absent rather than guessed at.

// Induced by pointing PLAYWRIGHT_BROWSERS_PATH at an empty directory.
const REAL_EXECUTABLE_MISSING =
  "browserType.launch: Executable doesn't exist at C:\\Users\\user\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe\n" +
  "╔════════════════════════════════════════════════════════════╗\n" +
  "║ Looks like Playwright was just installed or updated.       ║\n" +
  "║ Please run the following command to download new browsers: ║\n" +
  "║     npx playwright install                                 ║\n" +
  "╚════════════════════════════════════════════════════════════╝";

// Induced by putting a file that is not an executable where the browser
// belongs. Truncated here; the real one continued for ~2KB of arguments.
const REAL_SPAWN_REFUSED =
  "browserType.launch: spawn UNKNOWN\n" +
  "Call log:\n" +
  "  - <launching> C:\\Users\\user\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe " +
  "--disable-field-trial-config --disable-background-networking --user-data-dir=C:\\Users\\user\\AppData\\Local\\Temp\\pw-profile";

// Induced by substituting a real executable that exits immediately.
const REAL_EXITED_DURING_LAUNCH =
  "browserType.launch: Target page, context or browser has been closed\n" +
  "Browser logs:\n" +
  "\n" +
  "<launching> C:\\Users\\user\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe --headless --mute-audio";

// Everything the classifier must never let through.
const LOCAL_SECRETS = [
  "C:\\Users\\user",
  "AppData",
  "ms-playwright",
  "--user-data-dir",
  "--disable-field-trial-config",
  "npx playwright install",
];

describe("1. the diagnostic set is closed, code-owned and evidence-based", () => {
  it("exists at runtime, with the type derived from it", () => {
    expect(Array.isArray(BROWSER_LAUNCH_DIAGNOSTICS)).toBe(true);
    expect(new Set(BROWSER_LAUNCH_DIAGNOSTICS).size).toBe(BROWSER_LAUNCH_DIAGNOSTICS.length);
    for (const d of BROWSER_LAUNCH_DIAGNOSTICS) expect(d).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("stays small — one value per failure actually observed, plus UNKNOWN", () => {
    // A tripwire against taxonomy drift. Growing this list should require
    // inducing a new failure and reading what Playwright really said.
    expect(BROWSER_LAUNCH_DIAGNOSTICS.length).toBe(4);
    expect(BROWSER_LAUNCH_DIAGNOSTICS).toContain("UNKNOWN_BROWSER_LAUNCH_FAILURE");
  });

  it("the guard admits members and refuses everything else", () => {
    for (const d of BROWSER_LAUNCH_DIAGNOSTICS) expect(isBrowserLaunchDiagnostic(d)).toBe(true);
    for (const bad of [
      "executable_not_found",
      "EXECUTABLE_NOT_FOUND ",
      "EXECUTABLE_NOT_FOUND:extra",
      "RENDER_FAILED",
      REAL_EXECUTABLE_MISSING,
      "",
      null,
      undefined,
      7,
      { d: "EXECUTABLE_NOT_FOUND" },
    ]) {
      expect(isBrowserLaunchDiagnostic(bad)).toBe(false);
    }
  });
});

describe("2. real launch failures classify, and nothing local escapes", () => {
  it("a missing executable is EXECUTABLE_NOT_FOUND", () => {
    expect(classifyBrowserLaunchFailure(new Error(REAL_EXECUTABLE_MISSING))).toBe(
      "EXECUTABLE_NOT_FOUND",
    );
  });

  it("an OS refusal to start the process is PROCESS_START_FAILED", () => {
    expect(classifyBrowserLaunchFailure(new Error(REAL_SPAWN_REFUSED))).toBe(
      "PROCESS_START_FAILED",
    );
    // Every "spawn <ERRNO>" is the same stage, whichever errno it is.
    for (const errno of ["ENOENT", "EACCES", "EPERM", "UNKNOWN", "E2BIG"]) {
      expect(classifyBrowserLaunchFailure(new Error(`browserType.launch: spawn ${errno}`))).toBe(
        "PROCESS_START_FAILED",
      );
    }
  });

  it("a browser that started and died is PROCESS_EXITED_DURING_LAUNCH", () => {
    expect(classifyBrowserLaunchFailure(new Error(REAL_EXITED_DURING_LAUNCH))).toBe(
      "PROCESS_EXITED_DURING_LAUNCH",
    );
  });

  it("THE OUTPUT IS AN ENUM VALUE, so no path or command line can ride along", () => {
    // The strongest statement available: the return value is a member of
    // the closed set, and the set contains no text. Asserted against the
    // real messages, which are dense with local configuration.
    for (const message of [REAL_EXECUTABLE_MISSING, REAL_SPAWN_REFUSED, REAL_EXITED_DURING_LAUNCH]) {
      const out = classifyBrowserLaunchFailure(new Error(message));
      expect(BROWSER_LAUNCH_DIAGNOSTICS).toContain(out);
      for (const secret of LOCAL_SECRETS) expect(out).not.toContain(secret);
    }
  });

  it("unrecognised text maps to UNKNOWN rather than being echoed", () => {
    for (const message of [
      "something nobody has seen before",
      "Bearer sk-live-AAAA at https://host/x?api_key=SECRET",
      "",
      "\u0000\u0001 binary junk \uFFFD",
      "a".repeat(50_000),
    ]) {
      const out = classifyBrowserLaunchFailure(new Error(message));
      expect(out).toBe("UNKNOWN_BROWSER_LAUNCH_FAILURE");
    }
  });

  it("a non-Error value cannot crash or leak the classifier", () => {
    for (const thrown of [null, undefined, 42, { message: REAL_EXECUTABLE_MISSING }, ["x"]]) {
      expect(BROWSER_LAUNCH_DIAGNOSTICS).toContain(classifyBrowserLaunchFailure(thrown));
    }
    // A plain object is NOT an Error, so its `message` is not read at all.
    expect(classifyBrowserLaunchFailure({ message: REAL_EXECUTABLE_MISSING })).toBe(
      "UNKNOWN_BROWSER_LAUNCH_FAILURE",
    );
  });
});

describe("3. the error validates the diagnostic at its own edge", () => {
  it("keeps a member and drops anything else", () => {
    expect(new RenderedDocsError("BROWSER_LAUNCH_FAILED", "x", "EXECUTABLE_NOT_FOUND").diagnostic).toBe(
      "EXECUTABLE_NOT_FOUND",
    );
    for (const bad of ["nope", "RENDER_FAILED", "" as unknown]) {
      const e = new RenderedDocsError(
        "BROWSER_LAUNCH_FAILED",
        "x",
        bad as "EXECUTABLE_NOT_FOUND",
      );
      expect(e.diagnostic).toBeNull();
    }
  });

  it("defaults to null, and the message still carries nothing provider-controlled", () => {
    const e = new RenderedDocsError("BROWSER_LAUNCH_FAILED", "isolated");
    expect(e.diagnostic).toBeNull();
    for (const secret of LOCAL_SECRETS) expect(e.message).not.toContain(secret);
  });
});

describe("4. the wire is re-checked, never believed", () => {
  const HOST = "docs.launch-diagnosis.test";
  const URL_IN = `https://${HOST}/token/economics`;
  const ROUTE = { confirmedHost: HOST, matchedPathPrefix: "/token" };
  const PARENT_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };

  function isolatedWith(stdout: string) {
    return createIsolatedRenderedDocsFetcher({
      spawnChild: (async () => ({ stdout, code: 0 })) as never,
      startProxy: (async () => ({ port: 44777, decisions: [], close: async () => {} })) as never,
      parentEnv: PARENT_ENV,
    });
  }

  it("a valid detail survives the process boundary", async () => {
    const f = isolatedWith(
      JSON.stringify({ ok: false, reason: "BROWSER_LAUNCH_FAILED", detail: "EXECUTABLE_NOT_FOUND" }),
    );
    const e = (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
    expect(e.reason).toBe("BROWSER_LAUNCH_FAILED");
    expect(e.diagnostic).toBe("EXECUTABLE_NOT_FOUND");
  });

  it("an invalid detail is dropped while the reason still stands", async () => {
    for (const detail of [
      REAL_EXECUTABLE_MISSING, // the raw message, smuggled into the field
      "MADE_UP_DIAGNOSTIC",
      "executable_not_found",
      42,
      { d: "EXECUTABLE_NOT_FOUND" },
      null,
    ]) {
      const f = isolatedWith(
        JSON.stringify({ ok: false, reason: "BROWSER_LAUNCH_FAILED", detail }),
      );
      const e = (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
      expect(e.reason).toBe("BROWSER_LAUNCH_FAILED");
      expect(e.diagnostic).toBeNull();
      for (const secret of LOCAL_SECRETS) expect(e.message).not.toContain(secret);
    }
  });

  it("BROWSER_LAUNCH_FAILED is still a reason the child may report", () => {
    expect(CHILD_REPORTABLE_RENDER_REASONS.has("BROWSER_LAUNCH_FAILED")).toBe(true);
  });
});

describe("5. the scrubbed environment is unchanged by any of this", () => {
  it("stays an allowlist, and no secret is on it", () => {
    const parentEnv = {
      PATH: "p",
      LOCALAPPDATA: "l",
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "sk-SECRET",
      DATABASE_URL: "postgres://u:SECRET@h/db",
      BRAVE_SEARCH_API_KEY: "SECRET",
      SOLANA_MAINNET_RPC_URL: "https://rpc?api-key=SECRET",
      ProgramFiles: "C:\\Program Files",
      USERNAME: "user",
    } as NodeJS.ProcessEnv;
    const env = buildRendererEnv({ parentEnv, proxyPort: 1234 });
    expect(JSON.stringify(env)).not.toContain("SECRET");
    for (const k of FORBIDDEN_ENV_KEYS) expect(env[k]).toBeUndefined();
    // Arbitrary parent variables are NOT inherited. These were examined
    // as a possible cause of the launch failure and are still excluded,
    // because the launch was proven to work without them.
    expect(env.ProgramFiles).toBeUndefined();
    expect(env.USERNAME).toBeUndefined();
    expect(env.PATH).toBe("p");
    expect(env.LOCALAPPDATA).toBe("l");
  });
});

// ---------------------------------------------------------------------
// 6. The real thing: a production-equivalent launch, offline
// ---------------------------------------------------------------------
//
// These start an actual Chromium. They navigate nowhere — the child gets
// no url, no confirmed host and no path prefix, and the only page opened
// is about:blank — so they make no network request of any kind.

describe("6. the isolated renderer starts a browser offline", () => {
  it("a production-equivalent launch succeeds, opens about:blank and closes", async () => {
    const result = await runIsolatedRendererSelfTest();
    expect(result.reason).toBeNull();
    expect(result.diagnostic).toBeNull();
    expect(result.ok).toBe(true);
    // Proof it was a real browser and that the page round-trip completed:
    // the version is read from the launched browser, after about:blank was
    // opened and closed.
    expect(result.browserVersion).toMatch(/^\d+\.\d+/);
  }, 60_000);

  it("spawns EXACTLY ONE child, with no retry", async () => {
    let spawns = 0;
    const result = await runIsolatedRendererSelfTest({
      spawnChild: (async () => {
        spawns += 1;
        return { stdout: JSON.stringify({ ok: false, reason: "RENDER_FAILED" }), code: 0 };
      }) as never,
      startProxy: (async () => ({ port: 44778, decisions: [], close: async () => {} })) as never,
    });
    expect(spawns).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("an absent browser install is diagnosed as EXECUTABLE_NOT_FOUND, end to end", async () => {
    // The whole chain under one assertion: a real child, a real launch
    // attempt against a directory with no browser in it, Playwright's real
    // error, classification inside the child, the closed-set gate on the
    // wire, and a typed result — with the filesystem path it complained
    // about nowhere in sight.
    const emptyBrowsers = mkdtempSync(path.join(tmpdir(), "atlas-no-browsers-"));
    mkdirSync(path.join(emptyBrowsers, "placeholder"), { recursive: true });
    const result = await runIsolatedRendererSelfTest({
      parentEnv: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("BROWSER_LAUNCH_FAILED");
    expect(result.diagnostic).toBe("EXECUTABLE_NOT_FOUND");
    expect(JSON.stringify(result)).not.toContain(emptyBrowsers);
    expect(JSON.stringify(result)).not.toContain("Executable doesn't exist");
  }, 60_000);

  it("a corrupt browser binary is diagnosed as a start failure, end to end", async () => {
    const fake = mkdtempSync(path.join(tmpdir(), "atlas-bad-browser-"));
    // Playwright resolves headless launches to the headless shell.
    const dir = path.join(fake, "chromium_headless_shell-1234", "chrome-headless-shell-win64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "chrome-headless-shell.exe"), "not an executable");
    const result = await runIsolatedRendererSelfTest({
      parentEnv: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: fake },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("BROWSER_LAUNCH_FAILED");
    // Either the OS refuses the image outright or it starts and dies; both
    // are real, both are local, and both are named rather than collapsed.
    expect(["PROCESS_START_FAILED", "PROCESS_EXITED_DURING_LAUNCH"]).toContain(result.diagnostic);
    expect(JSON.stringify(result)).not.toContain(fake);
  }, 60_000);
});
