# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The owner route-confirmation tool is built and tested. **No route was created for
`fees.pump.fun`** — the capability only, as instructed.

### What exists now

`scripts/confirm-source-route.ts`, a thin controlled entrypoint, with the
operation in `src/server/memory/source-route-confirmation.ts`.

```
npx tsx scripts/confirm-source-route.ts \
  --project=<slug> --domain=<host> --prefix=</path> --actor=<name>
```

It reuses `promoteProjectMemoryItem` for OBSERVED → CANDIDATE → ACTIVE and
inserts only the OBSERVED state the database guard permits — no transition is
re-implemented. Then it prints the route as resolved by the **real**
source-authority resolver, and fails loudly if `routeClass` came back non-null.

**It assigns no route class and has no parameter that could.** A `--route-class`
flag (or any spelling of it) is refused loudly rather than ignored, because
silently dropping it would let an operator believe they had classified
something. Confirming a host and classifying a page are different judgements,
and the second should follow reading the page.

### Two hazards found while building it, both now refused

Neither was in the brief; both fall out of how `resolveSourceRoute` **combines**
ACTIVE rows, and both would have silently damaged working routes.

- **`OVERLAPPING_ACTIVE_PREFIX`** — `matchedPathPrefix` is reported only when
  *exactly one* path-scoped row matched a url. Confirming a prefix that
  co-matches an existing ACTIVE one turns that field null for the overlapping
  urls, disabling rendering and inspection for a route that worked yesterday.
- **`WOULD_INHERIT_ROUTE_CLASS`** — `routeClass` resolves from *every* matching
  ACTIVE row, so an ACTIVE domain-wide row carrying a class hands it to the new
  url too. A confirmation promising "unclassified" would quietly grant
  documentation authority.

Both are mutation-checked: removing either guard fails tests.

The refusals are not so broad as to block legitimate use — two non-overlapping
prefixes on one domain still coexist, which is what `pump.fun` has in production
today.

### Next step, awaiting approval

Creating the real route:

```
npx tsx scripts/confirm-source-route.ts \
  --project=pump_fun --domain=fees.pump.fun --prefix=/ --actor=owner
```

Verified offline in advance: no SOURCE_ROUTE row names `fees.pump.fun`, so no
duplicate, no overlap and no class to inherit — the command should succeed and
yield CONFIRMED / null / `/`.

**One thing to weigh before running it.** A `/` prefix confirms the root path
and nothing beneath it, so if `fees.pump.fun/` redirects or client-side-routes
to a sub-path, the later inspection render ends `FINAL_URL_OUTSIDE_ROUTE` —
exactly as `pump.fun/pump-token` did. The honest response then is to confirm a
route at that specific sub-path, not to widen the prefix.

Say the word and it runs; it is a single local database write, no network.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
