# Current task

> Overwrite this file each round. Never append.

## NONE — Brave probe prepared; no existing entrypoint, so a choice is needed

Offline preparation. Nothing executed, no DB mutation, no code changed.

## 1. The Brave provider contract, read from code

`search-gateway-brave.ts` — a plain authenticated HTTPS **GET**, no SDK:

| axis | value |
|---|---|
| endpoint | `https://api.search.brave.com/res/v1/web/search` |
| credential | `BRAVE_SEARCH_API_KEY` → header `X-Subscription-Token` (configured, verified present) |
| params | `q=<query>`, `count=` clamped to 1..20 |
| timeout | **10 s**, `AbortController` |
| retries | **0 in the provider** — "exactly ONE external attempt per call"; retry is owned by `s4-executor`'s `reserveAndCallWithRetry`, which a probe would not use |
| result-page opens | **none** — returns candidate urls only; a snippet is never Evidence (D-076) |
| DB writes | **none** |
| model calls | **none** |

Failure classes are already distinguishable: transport error → transient
`SearchProviderUnavailableError`; `HTTP <status>` (429/5xx transient, others
not); non-JSON 200 → non-transient. That vocabulary is exactly what a
reachability probe needs.

## 2. No existing safe probe — verified, not assumed

`resolveSearchGateway` / `createBraveSearchGateway` are referenced **only**
inside engine modules (`live-executor`, `non-live-executor`, `query-proposer`,
`s4-executor`, and the gateway files). **No script calls either.** The only
entrypoints that would reach Brave are `alpha-run --mode=live` and the product
job path — both of which run a whole research job (search **+** fetch **+**
model), which is far more than a reachability question and would hit the very
network conflict we are trying to characterise.

So there is no bounded existing tool, and the task's fallback applies: report
the smallest probe, do not implement it.

## 3. Two options — the choice is yours, and I recommend the first

### Option 1 — zero new code (recommended for a one-off)

The provider is a single GET with one header, so the environment can be tested
without adding anything to the repository. Read the key from `.env.local`
rather than typing it, so it never enters shell history:

**MantaRay ON, exactly once:**

```bash
$k=(Select-String -Path .env.local -Pattern '^BRAVE_SEARCH_API_KEY=(.*)$').Matches[0].Groups[1].Value; try { $r = Invoke-WebRequest -Uri 'https://api.search.brave.com/res/v1/web/search?q=solana%20documentation&count=1' -Headers @{ 'X-Subscription-Token' = $k; 'Accept' = 'application/json' } -TimeoutSec 10; "HTTP $($r.StatusCode)  results=$((($r.Content | ConvertFrom-Json).web.results).Count)" } catch { "FAILED: $($_.Exception.Message)" }
```

**MantaRay OFF, exactly once:** the identical command, after switching the VPN
off. Nothing in it differs.

It reproduces the production request faithfully in the ways that matter for
reachability — same host, same path, same header, same timeout, `count=1`
inside the provider's own clamp — while adding no code. It does **not** go
through `resolveSearchGateway`, so it proves the network and the credential,
not the repository wiring. For "can this host be reached", that is the whole
question.

### Option 2 — a repo-consistent probe (only if you want it permanent)

`scripts/brave-search-probe.ts`, mirroring `anthropic-count-tokens-probe.ts`:
one `resolveSearchGateway().search(...)` call, key from env and never printed,
**no DB handle at all**, no fetcher/renderer/model/RPC in its import graph,
pinned by a boundary test like the Anthropic probe's. Worth building **only**
if search reachability becomes something you check repeatedly — for a single
question it is more surface than the question deserves.

**I have not implemented either.**

## 4. Exact live footprint (both options)

**1** HTTPS GET to `api.search.brave.com` · **0** retries · **0** result-page
opens · **0** source fetches · **0** renderer · **0** Anthropic · **0** RPC ·
**0** DB writes · 10 s timeout · `count=1`.

No Raydium host and no project is involved — the query is deliberately generic.

## 5. Signals to capture

- **`HTTP 200` + a result count** → Brave is reachable and the credential
  works in that state.
- **`HTTP 401/403`** → reached, credential/permission refused (the Anthropic
  `OFF` shape).
- **`HTTP 429`** → reached, rate-limited — reachability is still proven.
- **A transport failure** (timeout / DNS / connection) → **not reached** in
  that state. Note the message text; a DNS or blocked-address style failure is
  the `docs.raydium.io` shape.

Record the state (ON/OFF), the status or error, and the result count. Nothing
else is needed.

## 6. What this decides

```
                 ON        OFF
Anthropic        success   403
Raydium docs     blocked   success
Brave            ?         ?
```

- **Brave works ON** → it groups with the model, and the designed phase split
  (source acquisition vs model extraction) is **wrong**: search would belong
  with extraction, and Phase A would need urls from confirmed routes alone,
  with no search at all.
- **Brave works OFF** → it groups with source fetch, and the design as written
  holds.
- **Brave works in both** → the split is free to sit where the design puts it.
- **Brave works in neither** → the product path cannot run at all in this
  environment, and that is a much larger finding than the phase boundary.

Do not infer any of these from Anthropic's or Raydium's behaviour — that
inference is exactly what the `BLOCKED_ADDRESS` result already disproved once.

## 7. DB mutation: **NO** · 8. **READY**

No blocker. Nothing in the repository needs to change for Option 1.

### Standing boundaries

- Two windows, one request each, no retries.
- Never print or type the API key; read it from `.env.local`.
- No VPN toggling inside a running process.
- Do not infer one provider's network behaviour from another's.
