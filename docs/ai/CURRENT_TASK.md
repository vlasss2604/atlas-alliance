# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The buyback Markdown route is classified `OFFICIAL_DOCS`. **Nothing was
acquired.** Raydium still has 0 Evidence, 0 jobs, 0 sources, 0 artifacts, and the
chain gate is still locked.

### What was done

```
npx tsx scripts/classify-source-route.ts \
  --route-id=52084c53-6e55-40fa-a7d4-66550b0e2771 --class=OFFICIAL_DOCS --actor=owner
```

**Replacement plus supersession, in one transaction** — not an in-place edit:

| row | state | content |
|---|---|---|
| `52084c53-6e55-40fa-a7d4-66550b0e2771` | **SUPERSEDED**, `supersededBy` → `dbe81df6-…` | `{ domain, pathPrefix }` — **still unclassified, never edited** |
| `dbe81df6-b197-48c4-938f-b03ea8d37e50` | **ACTIVE** | `{ domain, pathPrefix, routeClass: "OFFICIAL_DOCS" }` |

Domain and prefix carried over verbatim. Three ACTIVE routes throughout, never
four — the transaction exists precisely because two co-matching ACTIVE rows would
null `matchedPathPrefix` for the urls they both cover.

### Verified through the real resolver

`https://docs.raydium.io/ray/ray-buybacks.md` → `CONFIRMED` / **`OFFICIAL_DOCS`**
/ `/ray/ray-buybacks.md`, `observation: null`.

**No scope widened.** Across seven urls exactly two changed: the route and one
path beneath it. `/ray/ray-buybacks` and `/raydium/protocol/protocol-fees`
resolve **byte-identically** and remain unclassified. `/ray/protocol-fees.md`,
`/ray/treasury.md` and `/` are untouched.

### What classification actually opened

| gate | before | now |
|---|---|---|
| `resolveSourceClass` | `SOCIAL` | **`OFFICIAL_DOCS`** |
| `evaluateDocsInspectionEligibility` | refused | **eligible** |
| `docsPayloadRecoveryEligible` | false | **true** |
| `evaluateRenderEligibility` | refused | **eligible** |
| owner inspection | allowed | **refused — `ALREADY_CLASSIFIED`** |

That last row is correct, not a regression: the two gates are mutually exclusive
by construction. Inspection exists only for the undecided case, so a classified
page goes through the ordinary evidentiary path instead.

### CLASSIFIED ROUTE != EVIDENCE

Verified **after** classification, not assumed: `findAdmittedLocator` returns
**0** rows for all four addresses, and `resolveOnchainSubject` on
`DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz` still returns **`NOT_FOUND`**.

Classification makes acquisition *possible*. The locators become admissible only
when the page is acquired through the normal pipeline and Evidence exists with
`sourceClass OFFICIAL_DOCS`. Nothing about the chain was unlocked by hand, and
nothing should be.

### Next — the owner's choice

1. **Acquire the page through the pipeline.** The one step that turns a
   classified route into Evidence and makes the four addresses admissible
   locators. Requires a live window.
2. **Confirm and inspect `/ray/treasury.md`** — the document points at it for
   "the complete address map", and it is where a buyback *executor* might be
   role-bound. Its own route act and its own window.
3. **Stop.**

**Two risks already named, unchanged.** `DESTINATION` is
`tokenStateSensitive: true` — the gate that excluded PUMP's DESTINATION results
as `TOKEN_STATE_UNQUALIFIED`. And **no Evidence row in this repository has ever
carried an `onchainArtifactId`**: that path is read and believed correct but has
never succeeded end to end. This case would be its first real test.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
