# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The route classification tool exists and is tested. **No real route was
classified** — capability only. `fees.pump.fun` is still unclassified, the two
`pump.fun` routes are untouched, and there is still no Raydium anything.

**Both blockers for project #2 are now closed.**

### What exists now

`scripts/classify-source-route.ts`, with the operation in
`src/server/memory/source-route-classification.ts`.

```
npx tsx scripts/classify-source-route.ts --route-id=<uuid> --class=<CLASS> --actor=<name>
```

It acts only on an exact, already-ACTIVE, currently-unclassified route named by
**id**. It cannot create a host, confirm an unconfirmed one, widen a prefix, or
read anything — `--domain`, `--prefix` and `--project` are refused outright,
because naming a host here would be performing the *first* owner act inside the
second.

### The transition, and why it is that one

Established from the repository rather than chosen: **replacement plus
supersession**, which is the lifecycle graph's own model and the precedent
already sitting in the database from when `/pump-token` was classified. A new
ACTIVE record carries the same domain and the same prefix **verbatim** plus the
class; the original moves to `SUPERSEDED` with `supersededBy` linking to it.

Editing content in place was rejected for a concrete reason: the lifecycle
trigger fires on `lifecycle_state` **only**, so mutating an ACTIVE row's content
is an unguarded change to an authoritative human statement, and it destroys the
history the graph exists to keep.

**One transaction, because the middle is dangerous.** Between inserting the
replacement and superseding the original there are two co-matching ACTIVE rows,
and `resolveSourceRoute` reports `matchedPathPrefix` only when exactly one
path-scoped row matched — so a reader in that window sees the prefix vanish, and
a crash there would leave it vanished for good.

**Verified, not argued.** After the swap the transaction re-resolves every
affected url through the real resolver: the target must differ in exactly one
field, and every other route's url must be byte-identical, or the whole thing
rolls back. That check caught the deliberate mutation that skips supersession.

`supersedeProjectMemoryItem` is the primitive this needed — the schema had a
`supersededBy` column and the graph permitted `ACTIVE → SUPERSEDED`, but no code
had ever performed it.

### Classes

The resolver's own closed enum — `OFFICIAL_DOCS`, `GOVERNANCE`,
`OFFICIAL_REPORT` — validated by the resolver's own predicate, both now exported
rather than copied. All three are supported: they are equally real source
classes with the same semantics, and restricting to one would only guarantee a
second task later. Anything else is refused with no fallback.

### Ready for Raydium

Nothing architectural blocks the case now. The remaining prerequisites are
ordinary owner acts, in order:

1. add `raydium` to the seed catalog (one line + `npx tsx scripts/seed.ts`);
2. `confirm-project-identity.ts` — Solana, RAY mint;
3. `confirm-source-route.ts` — `docs.raydium.io` at a bounded prefix;
4. **inspect** the page (non-evidentiary), then
5. `classify-source-route.ts` — only if what the page says earns it.

Step 4 before step 5 is the whole point: classification should follow reading.

The pre-registered success criteria for the case — what will and will not count
as an address-level role assignment — remain as written when Raydium was
selected, and were deliberately settled before anything was read.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
