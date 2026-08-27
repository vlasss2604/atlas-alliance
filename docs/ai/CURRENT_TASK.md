# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The `fees.pump.fun` route was created, owner-authorized, through the supported
script. No network call was made and the page has not been read.

### What was created

Memory item `0aec2717-7c3e-4332-82d0-d0cee2f422c0`, `SOURCE_ROUTE`, **ACTIVE**,
content exactly:

```json
{"domain": "fees.pump.fun", "pathPrefix": "/"}
```

No `routeClass` key — absent, not null-valued. Created via
`OBSERVED → CANDIDATE → ACTIVE` through the existing lifecycle function; no SQL
was written by hand and nothing was superseded.

Pre-check before execution found zero existing routes for the host, no
duplicate, no overlapping prefix and no class to inherit. The resolver reported
`CLAIMED / null / null` before, and `CONFIRMED / null / "/"` after.

### Verified after, independently of what the script printed

| check | result |
|---|---|
| `resolveSourceRoute("https://fees.pump.fun/")` | `CONFIRMED / null / "/"`, observation null |
| inspection eligibility | **eligible** — host `fees.pump.fun`, prefix `/` |
| evidentiary acquisition scope gate | **refuses** — routeClass is null |
| render-as-Evidence (upgrade) | refused — `NOT_OFFICIAL_DOCS` |
| render-on-refusal | refused — `NOT_OFFICIAL_DOCS` |
| `/api/buybacks`, `/dashboard` | `CONFIRMED` host-wide, prefix **null** → `NO_PATH_PREFIX` |
| existing `pump.fun` routes | unchanged: `OFFICIAL_DOCS` at `/docs` and `/pump-token` |

Exactly the bounded grant intended: the root page became readable
non-evidentiarily, nothing became able to produce Evidence, and the confirmation
reached no sub-path.

### Operational note worth keeping

**Run that script from PowerShell, not Git Bash.** MSYS path conversion rewrites
a bare `--prefix=/` into `C:/Program Files/Git/`. The first attempt hit exactly
that: the tool refused it as `PREFIX_HAS_WHITESPACE` and wrote nothing, which is
the validation doing its job — but in that shell the command silently means
something other than what it says. The real run was made from PowerShell.

### The next step, not taken

Inspection has **not** been run, as instructed:

```
npx tsx scripts/inspect-official-page.ts https://fees.pump.fun/ pump_fun
```

That is one live isolated render, navigating nowhere but the confirmed root —
no model, no Evidence, no budget, no database write. It needs an authorized
window with MantaRay off, and `renderer-selftest.ts` should be run first in the
same session.

Two things to expect. If the host redirects or client-side-routes away from the
root, the render ends `FINAL_URL_OUTSIDE_ROUTE`, and the honest response is to
confirm that specific sub-path rather than widen the prefix. And whatever the
page says, the standard is unchanged: an explicit first-party assignment of the
acquisition role to `99mRw3…`. The address appearing in data is not that.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
