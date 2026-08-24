// The renderer child's ENVIRONMENT — an allowlist, never a denylist.
//
// The child launches a browser that loads untrusted third-party code. It
// must therefore be unable to read anything ATLAS knows: no model keys, no
// search keys, no database URL, no CSRF secret, no bot token, no RPC
// endpoint (which is itself credential-bearing).
//
// This is built as a POSITIVE allowlist for one reason: a denylist is
// wrong the moment someone adds a new secret and forgets to list it. With
// an allowlist, a new secret is excluded by default and the failure mode
// of forgetting is "the renderer doesn't get something harmless", not "the
// renderer silently gains a credential".
//
// The child also receives no database configuration at all, so there is
// nothing for it to connect to even if it tried.

// Variables the child genuinely needs to run a browser. Nothing here is
// ATLAS state; every entry is OS/runtime plumbing.
const ALLOWED_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  // Windows process/browser prerequisites.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  // Where Playwright's browser binaries live, when relocated.
  "PLAYWRIGHT_BROWSERS_PATH",
  // Linux display plumbing for headless shells.
  "XDG_RUNTIME_DIR",
  "DISPLAY",
];

// Named explicitly so a test can assert each one is absent. This list is
// documentation and a tripwire — the allowlist above is what actually
// enforces exclusion.
export const FORBIDDEN_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "EVAL_DATABASE_URL",
  "CSRF_SECRET",
  "BOT_TOKEN",
  "SOLANA_MAINNET_RPC_URL",
  "ALLOWED_ORIGINS",
  "AUTH_DEV_BYPASS",
  "MODEL_GATEWAY",
  "INTERPRETER_MODEL",
  "QUERY_PROPOSER_MODEL",
  "EVIDENCE_EXTRACTOR_MODEL",
];

export interface RendererEnvInput {
  // The parent's environment. Passed in rather than read from
  // process.env so this is a pure function and directly testable.
  parentEnv: NodeJS.ProcessEnv;
  // Loopback proxy the browser must route ALL traffic through.
  proxyPort: number;
}

// Builds the child's complete environment. Everything not on the allowlist
// is dropped, including anything added to ATLAS in the future.
export function buildRendererEnv(input: RendererEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = input.parentEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  // Told to the child explicitly; not inherited.
  env.ATLAS_RENDER_PROXY_PORT = String(input.proxyPort);
  // Belt-and-braces against a library reading these directly.
  env.NODE_ENV = "production";
  env.NO_PROXY = "";
  return env;
}

// Chromium flags that force every request through the proxy with no
// bypass route. An empty bypass list is the important half: without it,
// Chromium bypasses the proxy for localhost by default, which would leave
// exactly the loopback hole this boundary exists to close.
export function proxyChromiumArgs(proxyPort: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-features=NetworkService,NetworkServiceInProcess",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
  ];
}
