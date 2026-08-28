# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Raydium has a catalog row, a confirmed identity and one **unclassified** route.
**Nothing has been read.** No source, no Evidence, no job, no artifact.

### What was done

One owner-authorized route act, through the only supported path:

```
npx tsx scripts/confirm-source-route.ts --project=raydium \
  --domain=docs.raydium.io --prefix=/ray/ray-buybacks --actor=owner
```

Row `84774bb9-b10a-4519-8a69-7f1c3a6c0b93`, kind `SOURCE_ROUTE`, ACTIVE via
`OBSERVED -> CANDIDATE -> ACTIVE` on the existing `promoteProjectMemoryItem`.
No SQL, no direct ACTIVE write, no classification.

Content is exactly `{ domain, pathPrefix }`. `routeClass` is **absent rather than
null** — the tool has no parameter for it, refuses `--class` and its variants
loudly, and the documented shape treats absent and null identically.

On Windows, note: Git Bash's MSYS path conversion rewrites a `/...` argument into
a Windows path. The first invocation therefore arrived as
`C:/Program Files/Git/ray/ray-buybacks` and was **refused** with
`PREFIX_HAS_WHITESPACE` before any write — the validator ran first, so nothing
was inserted. Prefix such a command with `MSYS_NO_PATHCONV=1`, or run it from
PowerShell.

### Verified offline, through the real resolver and the real gates

`resolveSourceRoute("https://docs.raydium.io/ray/ray-buybacks")` →
`officiality CONFIRMED`, `routeClass null`, `matchedPathPrefix
"/ray/ray-buybacks"`.

- inspection (`evaluateInspectionEligibility`) → **allowed**
- `evaluateDocsInspectionEligibility` → refused, `NOT_OFFICIAL_DOCS`
- `evaluateRenderEligibility` → refused, `NOT_OFFICIAL_DOCS`
- `docsPayloadRecoveryEligible` → false
- `resolveSourceClass(url, OTHER, null)` → `SOCIAL`, which is in no component's
  `establishingClasses`. With a class it would be `OFFICIAL_DOCS` — that is the
  whole difference classification makes, and it has not been made.

Segment-bounded matching holds: `/ray/ray-buybacks/history` is inside the prefix,
`/ray/ray-buybacks-extra` is not. `raydium.io` is a different host and stays
`CLAIMED`. `pump_fun`'s six route rows are untouched.

**One consequence to carry forward.** Officiality is decided by **domain match
alone**, so `/ray/treasury`, `/raydium/protocol/protocol-fees` and `/` on
`docs.raydium.io` moved `CLAIMED -> CONFIRMED` as a side effect of this single
confirmation. They gained no capability — `matchedPathPrefix` is null for them,
inspection denies `NO_PATH_PREFIX`, sourceClass stays `SOCIAL` — but "neighbouring
routes are untouched" is true of capability, not of officiality. Confirming a
second prefix on this host is also constrained: an overlapping ACTIVE prefix is
refused outright, because two co-matching rows null `matchedPathPrefix` and would
silently disable inspection for urls both cover.

### Next

1. **Inspect** `https://docs.raydium.io/ray/ray-buybacks` — non-evidentiary,
   needs an authorized live window. `scripts/inspect-official-page.ts`.
2. `classify-source-route.ts` — **only if what the page says earns it**, and only
   for the class the page actually supports.

Step 1 before step 2 is the point: classification follows reading.

The pre-registered success criteria for the case — what will and will not count
as an address-level role assignment — remain as written when Raydium was
selected, and were deliberately settled before anything was read.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
