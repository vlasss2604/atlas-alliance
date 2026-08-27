# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The `PROJECT_IDENTITY` confirmation tool exists and is tested. **No Raydium
project, identity or route was created** — capability only, as instructed.

### What exists now

`scripts/confirm-project-identity.ts`, a thin entrypoint, with the operation in
`src/server/memory/project-identity-confirmation.ts`.

```
npx tsx scripts/confirm-project-identity.ts \
  --project=<slug> --chain=<chain> [--token=<address>] [--ticker=<TICKER>] --actor=<name>
```

It inserts as OBSERVED — the only state the database guard permits — then walks
to ACTIVE through the existing `promoteProjectMemoryItem`, and finally prints
what the **production resolver** returns, failing loudly if an ACTIVE row somehow
resolves to nothing.

### Three things the contract dictated, against the brief

Discovered by reading the code rather than taking the prompt's shape:

1. **There is no `network` field.** The content schema is
   `{ chain, tokenAddress?, ticker? }` and it is `.strict()`. Mainnet is implied
   by construction — every explorer in the code-owned chain map is a mainnet
   host, and test networks are rejected again at classification time. The
   proposed `--network` option would have been inventing contract, so it does
   not exist and is refused loudly if passed.
2. **`tokenAddress` is optional**, deliberately: a project may be confirmed on a
   chain before its token is. Without one there is simply no explorer locator.
3. **A second ACTIVE identity must be refused outright, identical or not.**
   `resolveConfirmedIdentity` returns the *earliest* structurally-valid ACTIVE
   row, so a second would not replace anything and would not conflict loudly —
   it would be **silently ignored** while the older record kept deciding what
   the project is. An owner "confirming" a correction would get no error and no
   effect, which is worse than a refusal. Superseding stays a separate act.

### What it deliberately cannot do

Discover, infer, or query. No chain, no web, no document, no model is in its
import graph, and a test asserts it. Validation reuses the domain module's own
`SUPPORTED_CHAINS`, `addressShapeMatchesChain` and strict schema rather than
restating them — so an `0x…` address filed under `solana`, the cross-chain
contamination D-133 exists to prevent, is refused at entry.

### Auditability, stated honestly

`project_memory_items` has **no actor column** — deliberately, unlike
`research_memory` which carries `promoted_by`. `--actor` is therefore printed for
the operator's record and explicitly marked as not persisted, rather than
smuggled into the content JSON. Inventing a field to hold it would be inventing
provenance. The durable trail is the row's lifecycle state and `created_at`.

### Remaining blocker before Raydium can start

**Route classification still has no supported path.** `confirm-source-route.ts`
assigns no `routeClass` by design, and the separate later act that assigns
`OFFICIAL_DOCS` was never built — so no documentary Evidence can be admitted.

Smallest fix: a second script that classifies an **already ACTIVE, unclassified**
route, refusing to invent one, and respecting the overlap and inheritance hazards
already documented — adding a classified row is exactly what can null a
neighbouring route's matched prefix.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
