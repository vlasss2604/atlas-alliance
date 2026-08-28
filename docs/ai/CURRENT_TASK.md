# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The `raydium` catalog entry exists. Nothing else about Raydium exists.

### What was done

One owner-authorized setup action: `raydium` / "Raydium" added to the project
catalog in `src/server/db/seed.ts` using the existing entry shape, applied with
the existing idempotent path (`npx tsx scripts/seed.ts`). No manual SQL.

Project id `9cc80fd6-04ae-45e8-be6c-7ed8b9f663c7`, `status = ACTIVE_CORE`,
`ticker = null`. Catalog count 3 -> 4; the other three rows are byte-identical.

`ticker` was left null on purpose. The catalog row is a name, not an identity
claim: which token this project *is* belongs to `PROJECT_IDENTITY` (chain +
mint), which does not exist for Raydium. Nothing was inferred — the owner
supplied a slug and a name, and only those were written.

`demo_project_slugs` was not touched, so Raydium is in **scope** and **not**
available to DEMO. That divergence is now asserted rather than assumed: the
projects API test previously passed only because the catalog and the DEMO config
happened to list the same three slugs.

### Verified offline after seeding

Exactly one `raydium` row; project count 4; the three prior projects unchanged;
`pump_fun` still 26 jobs / 401 Evidence / 7 memory items. For `raydium`: zero
`PROJECT_IDENTITY`, zero `SOURCE_ROUTE`, zero project-memory rows of any kind,
zero jobs, zero Evidence, zero reachable sources. The global `sources` table is
unchanged at 62 rows — `sources` has no project column, so "zero sources for
Raydium" means zero reachable through its (nonexistent) Evidence.

Idempotence was not re-proved by a second run: `tests/phase1.test.ts` case 1
already establishes it, and now pins the catalog at 4.

### Next, and still ordinary owner acts

1. `confirm-project-identity.ts` — Solana, RAY mint. **The mint address must come
   from the owner.** It is the entity binding; nothing may infer it.
2. `confirm-source-route.ts` — `docs.raydium.io` at a bounded prefix.
3. **inspect** the page (non-evidentiary) — needs an authorized live window.
4. `classify-source-route.ts` — only if what the page says earns it.

Step 3 before step 4 remains the point: classification follows reading.

The pre-registered success criteria for the case — what will and will not count
as an address-level role assignment — remain as written when Raydium was
selected, and were deliberately settled before anything was read.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
