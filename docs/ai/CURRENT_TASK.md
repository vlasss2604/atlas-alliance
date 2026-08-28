# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

`raydium` is alpha-live-enabled and a documentary-only mode exists. **No live
acquisition was run.** Raydium still has 0 Evidence, 0 jobs, 0 sources, 0
artifacts; the chain gate is still locked.

### The defect this closed

`alpha-acquire-url.ts` claimed "NO CHAIN CALL", reasoning from its own import
graph. That was wrong about what matters: the S4 executor it **builds** contains
a structured on-chain branch driven by locators admitted **for the project**, not
merely for the job. Raydium's first run would have performed no RPC — but only
because the database held no admitted locators. **A state-dependent safety
property, presented as a structural one.**

### What changed

- **`--mode=documentary-only`** on the exact-URL entrypoint. The guard wraps the
  **whole** branch in `s4-executor.ts` — locator read, intent selection,
  retriever resolution and every call skipped together — so no RPC can be issued
  whatever the database holds. Deliberately **not** a no-op retriever: that skips
  the calls while still entering the branch.
- **Unknown arguments are refused, not ignored**, and the parser now accepts
  hyphens like every other owner script. A misspelt safety flag dropped in
  silence would run with chain work enabled while the operator believed it off.
- **`raydium` added to `INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`**, now exactly
  `{ pump_fun, raydium }` — closed and enumerated, pinned by test.
- The operator contract is corrected to state chain work as **conditional**, with
  both branches spelled out.

The default is unchanged: anything that does not ask for the mode behaves as
before.

### One thing I tried and reverted

I first made the `NO_SEARCH_CANDIDATES` return carry `withObservations`, so the
new observation code would be visible there as it is on sibling returns. Two
existing tests assert that reason string exactly, and it appended source-route
observations to `SEARCH_GATEWAY_FAILED:…`. That was scope creep for my own test's
convenience, so I reverted it — **no reason string changed**. The structural
proof does not need it: the retriever spy counts are the evidence.

### Raydium preflight — all four prerequisites now pass

| check | result |
|---|---|
| `internal_alpha_enabled` | true |
| `ANTHROPIC_API_KEY` | set |
| `raydium` in the allowlist | **true** — `["pump_fun","raydium"]` |
| model cost profile | OK — `claude-haiku-4-5` |
| route | `CONFIRMED` / `OFFICIAL_DOCS` / `/ray/ray-buybacks.md` |
| `sourceClass` | `OFFICIAL_DOCS` |
| Raydium Evidence / jobs | **0 / 0** |
| `findAdmittedLocator` / `resolveOnchainSubject` | 0 rows / `NOT_FOUND` |

### The command, when the owner authorizes a live window

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://docs.raydium.io/ray/ray-buybacks.md \
  --component=DESTINATION --step=6 --actor=owner --project=raydium \
  --mode=documentary-only
```

Expected footprint: **max 2 source opens** (static, then at most one render),
static first, **search provider absent** (a fixture returns the single url; Brave
is never constructed), the **real** EvidenceExtractor may run, **zero retries**,
and **RPC structurally impossible**.

### Next — the owner's choice

1. **Run the acquisition** in an authorized live window.
2. **Stop.**

Two risks already named, unchanged: `DESTINATION` is `tokenStateSensitive: true`
— the gate that excluded PUMP's results as `TOKEN_STATE_UNQUALIFIED`; and no
Evidence row in this repository has ever carried an `onchainArtifactId`.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
