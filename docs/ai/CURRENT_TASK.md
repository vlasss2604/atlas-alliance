# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The platform-independence constraint — **ATLAS is the product; Telegram is only
the first interface** — is recorded as an **ACTIVE** architectural invariant
(D-125). Documentation and audit only: **no production code changed**, no
client built, no Raydium/Proof behaviour touched.

### What was recorded, and where

- **Canonical doc:** `docs/PLATFORM_INDEPENDENT_ARCHITECTURE.md` — the
  dependency law (CLIENT → APPLICATION → CORE; reverse edge forbidden), the
  verified repository mapping, the Telegram coupling audit, forbidden
  couplings, the removal test, and the honest 14-point acceptance matrix.
- **Register:** `docs/DECISIONS.md` **D-125** (LOCKED), same commit.
- **ARCHITECTURE.md** — the law only. **CURRENT_STATE.md** — one ACTIVE note
  (explicitly distinguished from the *future* D-124 spec). **BACKLOG.md** —
  future clients/adapters as unscheduled references. **INDEX.md** — one nav
  line.

### The audit result (report only, per instruction)

**Zero Core violations.** Telegram exists only at the edge: the auth chain
(`app/api/auth/telegram/` → `src/server/auth/`), the client
`PlatformAdapter` (`src/client/platform.ts`, with a `web` fallback already in
place), and the SDK script tag. `package.json` carries no Telegram SDK. The
single engine string match is `t.me`/`telegram.me` inside `SOCIAL_DOMAINS` —
source-classification data about the external web, not coupling.

Key mapping facts, verified not assumed: canonical identity is `users.id` with
`user_identities` as generic provider attachment; every domain FK references
the internal uuid; entitlement is computed from subscription state and
**nothing reads `billingProvider`**; `evaluateGates` is one function for
preview and enforcement; no client/app file imports `src/server/engine`; no
payment-processing code exists at all; only tests write `proofs` (S8/S9 not
started — a roadmap fact, not a platform gap).

One denomination residue recorded for later, not fixed: `price_stars_at_purchase`
/ `ari_core_price_stars` bake Stars into the billing record. De-denominate when
a second billing adapter is actually built.

### Still flagged from earlier (unchanged)

The raydium-allowlist and documentary-only-mode owner decisions from `b5a95aa`
are still not register rows; D-122's text still names the allowlist as
`{pump_fun}`. Catch-up registration remains its own owner act.

### Where the active research work stands (unchanged by this task)

Raydium: identity ACTIVE, buyback `.md` route classified `OFFICIAL_DOCS`,
alpha allowlist includes `raydium`, documentary-only mode available, **0
Evidence, 0 jobs**, chain gate locked. The prepared first acquisition command
is recorded in CURRENT_STATE and `git log`.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
