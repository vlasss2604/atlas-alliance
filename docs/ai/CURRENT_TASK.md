# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The first Raydium documentary acquisition is **prepared but NOT READY**. Nothing
was acquired, no Evidence exists, no live call was made.

### Authority: everything on the ATLAS side is in place

- `raydium` exists; `PROJECT_IDENTITY` ACTIVE — solana /
  `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` / RAY
- `https://docs.raydium.io/ray/ray-buybacks.md` resolves **`CONFIRMED` /
  `OFFICIAL_DOCS` / `/ray/ray-buybacks.md`**, `observation: null`
- Replacement row `dbe81df6-…` ACTIVE; `52084c53-…` SUPERSEDED and linked
- Raydium Evidence **0**, jobs **0**
- `findAdmittedLocator(DdHDoz…VEZaz)` → **0**;
  `resolveOnchainSubject` → **`NOT_FOUND`**

### The blocker

`scripts/alpha-acquire-url.ts` refuses any project outside
`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`, a hard-coded code constant whose only member
is **`pump_fun`**.

Checked exactly as the script checks them:

| # | prerequisite | result |
|---|---|---|
| 1 | `internal_alpha_enabled` | **true** |
| 2 | `ANTHROPIC_API_KEY` set | **true** |
| 3 | `raydium` in the alpha live allowlist | **FALSE — the blocker** |
| 4 | model cost profile | **OK** — `claude-haiku-4-5` |

The route scope gate itself passes. Only the allowlist refuses, and it refuses
**before any DB write and before any network**.

Widening it is an owner decision about which projects may spend money and make
live calls — deliberate, and pinned by `gates-owner-alpha.test.ts`, which asserts
that an in-scope but non-allowlisted project is DISABLED. It should not be
changed inside a preparation task.

### The command, once the allowlist admits raydium

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://docs.raydium.io/ray/ray-buybacks.md \
  --component=DESTINATION --step=6 --actor=owner --project=raydium
```

`--step=6` is Pattern v1's "Token Destination + Recipient", whose components are
`DESTINATION` and `RECIPIENT`. It was read from `PATTERN_V1_CONTENT`, not chosen.
`--project` is required: it defaults to `pump_fun`.

### Expected live footprint

| axis | bound |
|---|---|
| search queries | 1 — a fixture returning the given url; **Brave is never constructed** |
| source opens | **2** — static fetch, plus at most one render |
| static first | yes — the render gate is static-first by construction |
| renderer fallback | possible but unlikely: the observed page was ~3.1 KB html / 2,939 chars text, nowhere near the shell trigger (≥100 KB html **and** <500 chars) |
| model calls | the **real** `EvidenceExtractor`; `QueryProposer` is stubbed and calls no model. Bounded by `maxModelCostMicro` 2,000,000 |
| search provider | **not involved** |
| RPC | **none on this run** — see the caveat below |
| retries | **zero** — one `execute()`, `attemptNumber 1`, `isRecoveryAttempt false`, renderer zero-retry |

### The RPC caveat — first run vs later runs

The S4 executor **does** have a structured on-chain branch, driven by
`admittedLocatorsForJob`. That function is scoped by **project**, not by job, and
admits a locator only when it is `literallyPresent`, `validationResult CONFIRMED`,
on Evidence with `officiality CONFIRMED` and a `sourceClass` in
`OFFICIAL_DOCS/GOVERNANCE/OFFICIAL_REPORT`, from a source that is not `BROKEN`,
capped at 8.

Raydium has **none** today, so a first run cannot reach RPC — **by state, not by
construction**. Once documentary Evidence carries those locators, a later run of
the same script **would** enter that branch and issue real RPC. The script's "no
chain call" note describes its own import graph, not the executor it builds.

### Success criteria for the run

An Evidence row with `sourceClass OFFICIAL_DOCS`, `officiality CONFIRMED`,
project `raydium`, component `DESTINATION`, whose fragment preserves
**bought-back RAY → held at → `DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz`**.
Relationship and directness are whatever the real extractor assigns; they are not
prescribed.

**A row that merely contains the address does not count.** The address must be
admitted as a role-bound documentary locator — `literallyPresent`,
`validationResult CONFIRMED` — which is exactly what the script prints under
"LOCATORS", "Locator rejections" and "Document provenance".

### After a successful run, verify offline

Evidence row exists; sourceClass/officiality/component as above; the exact
fragment; locator admission for the holding address; `findAdmittedLocator` now
returns it; `resolveOnchainSubject` progresses past `NOT_FOUND`; still no RPC
executed; and the S5 `DESTINATION` reconciliation result.

`DESTINATION` is `tokenStateSensitive: true` — the gate that excluded PUMP's
DESTINATION results as `TOKEN_STATE_UNQUALIFIED`. Expect that to be live here too.

### Next — the owner's choice

1. **Authorize adding `raydium` to `INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`** — a
   one-line code change plus its test, then the command above in a live window.
2. **Stop.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
