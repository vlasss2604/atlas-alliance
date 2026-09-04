// Provider-credential isolation for the whole test run.
//
// Why this exists: resolveSearchGateway() / resolveQueryProposer() /
// resolveEvidenceExtractor() read their credentials from process.env at
// CALL time. A vitest worker inherits the developer's ambient environment,
// so on a desktop machine with real provider credentials exported, every
// "no provider configured -> must throw" assertion silently inverted: the
// resolver found a real key and returned a REAL provider instead of
// throwing. The suite then passed or failed depending on whose machine it
// ran on, and a test one line away from calling .search() would have been
// talking to the live Brave API.
//
// (Note it is the ambient OS environment that leaks in, not .env.local —
// vitest does not load .env.local in test mode. Scrubbing here covers
// both, since both end up in process.env.)
//
// The rule is therefore default-deny: no test can reach a live provider by
// accident, regardless of how the developer's shell is configured. This
// is test-environment isolation only — no production resolver logic is
// changed, and the resolvers' real behaviour (throw when unconfigured,
// construct a provider when configured) is exercised exactly as before,
// against values the tests set themselves.
//
// Deliberate escape hatch: the opt-in live smoke tests
// (tests/interpreter-live.test.ts) still need real credentials. They now
// require a SECOND explicit signal, so live access in tests is always a
// conscious act and never an inherited accident:
//
//   ATLAS_ALLOW_LIVE_PROVIDER_ENV=1 ANTHROPIC_API_KEY=... npx vitest run ...
//
// Values are never read or printed here — only deleted.

// Every variable that can make a resolver reach a live provider, or change
// which provider branch is selected. Scrubbing the selector vars too keeps
// the default branch deterministic instead of ambient-dependent.
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "MODEL_GATEWAY",
  "SEARCH_GATEWAY_PROVIDER",
] as const;

export const ISOLATED_PROVIDER_ENV_KEYS: readonly string[] = PROVIDER_ENV_KEYS;

if (process.env.ATLAS_ALLOW_LIVE_PROVIDER_ENV !== "1") {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key];
  }
}
