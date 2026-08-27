# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The owner approved confirming `fees.pump.fun` for non-evidentiary inspection.
**The route was NOT created: no supported owner route-management path exists**,
and the instruction in that case was to stop and report rather than improvise a
database write. Nothing was written, fetched or changed except this document set.

### Why there is no supported path — verified, not assumed

- **Nothing in `src/` or `scripts/` ever inserts a `project_memory_items` row.**
  Zero occurrences of `insert(projectMemoryItems)` outside tests.
- `promoteProjectMemoryItem` **exists** in `src/server/memory/lifecycle.ts` and
  correctly walks OBSERVED → CANDIDATE → ACTIVE inside a transaction, honouring
  the `0007_memory_lifecycle_guard` constraint — but it has **no caller
  anywhere**. No script wires it.
- `scripts/promote-memory.ts` is not it: it calls `promoteToActive`, which
  operates on `research_memory`, a different table. It can neither create nor
  promote a SOURCE_ROUTE.
- **Four separate tests actively ban route management from every existing owner
  entrypoint** — `owner-acquisition-boundary`, `owner-docs-inspection-mode`,
  `owner-inspection-mode` and `onchain-derive-entrypoint-boundary` each assert
  the entrypoint source contains none of `promoteProjectMemoryItem`,
  `projectMemoryItems`, `memory/lifecycle`, or `routeClass: "`.
- `docs/PROJECT_IDENTITY_CONFIRMATION.md` documents the record shape and that
  confirmation means `lifecycle_state = 'ACTIVE'` — and names no tool.

So the capability is deliberately absent from every acquisition entrypoint, and
was never given a home of its own. This is a real gap, not an oversight to route
around.

### Everything else the owner asked to verify — all confirmed

Current state: **0** SOURCE_ROUTE rows name `fees.pump.fun`, so **no conflicting
ACTIVE route** exists. Both candidate URLs resolve `CLAIMED / null / null`.

The intended end state was evaluated against the **real gate functions**, using
the route object that `{domain: "fees.pump.fun", pathPrefix: "/"}`, ACTIVE and
unclassified, would produce:

| gate | result |
|---|---|
| inspection eligibility (root url) | **eligible**, host `fees.pump.fun`, prefix `/` |
| render-as-Evidence (upgrade path) | refused — `NOT_OFFICIAL_DOCS` |
| render-on-refusal | refused — `NOT_OFFICIAL_DOCS` |
| `alpha-acquire-url` scope gate | **refuses** — routeClass is null |
| inspection of any sub-path | refused — `NO_PATH_PREFIX` |

Exactly the bounded grant intended: the root page becomes readable
non-evidentiarily, nothing becomes Evidence, and the confirmation reaches no
sub-path. `matchesPathPrefix` treats `/` as the root and nothing beneath it, in
both the authority and renderer implementations.

### The smallest safe way to create it

A new owner script, `scripts/confirm-source-route.ts` — the missing sibling of
`promote-memory.ts`, following the principle that file already states (D-021 /
D-055): a transition to ACTIVE happens **only by a human, through a controlled,
auditable script** — not an admin UI, not a model, not hand-written SQL.

It should:

- take `--project`, `--domain`, `--path-prefix`, `--actor`, and an **explicit**
  `--route-class` that **defaults to null**, so classification can never be a
  side effect of confirming a domain;
- refuse when an ACTIVE row already exists for the same project + domain, rather
  than creating a silent duplicate;
- insert as `OBSERVED` and then call the existing `promoteProjectMemoryItem`,
  reusing the supported lifecycle instead of copying it, so the database guard
  stays the authority;
- print `resolveSourceRoute` for the target url afterwards, so the outcome is
  verified rather than assumed;
- write nothing else — no Evidence, no fetch, no model, no S5–S7 — with its own
  boundary test mirroring the four that already exist.

**One design question for the owner**, because it is a judgement rather than a
detail: whether this script may set `routeClass` at all. The existing tests show
a clear stance that *acquisition* entrypoints must never assign one. A dedicated
confirmation script is the natural home for it, but keeping classification a
separate second act is also defensible — and is what actually happened with
`/pump-token`, which was inspected first and classified afterwards.

Say which, and whether to build it, and it is a small self-contained task.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
