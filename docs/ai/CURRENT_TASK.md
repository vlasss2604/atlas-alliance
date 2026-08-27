# Current task

> Overwrite this file each round. Never append.

## PUMP BURN-SIDE — STEP 0 (offline)

**Mode:** Opus 5 · High · single-agent · **offline only**.

The burn-side strategy is designed and recorded in `PUMP_CASE.md` §"Burn-side
strategy". Read that section first. Steps 1 and 2 of it need separate owner
authorization and a live window; **Step 0 does not** — it reads only the local
database.

### Objective

Establish, from already-persisted rows and without a single network call:

1. the post-balance recorded for token account `9Wtcf…` in transaction artifact
   `df2ed321-…` (slot `441977087`);
2. the `slot` of the `TOKEN_ACCOUNTS_BY_OWNER` artifact and the balance it
   recorded for the same account;
3. the 25 rows of `onchain_observed_signatures` under artifact `2e332079-…` —
   `slot`, `block_time`, `err` for each.

The decisive question is the **ordering**. If the zero-balance observation is at a
strictly later slot than `441977087`, a decrease of a known size occurred within a
known slot interval. That is a real bounded fact and it is what justifies Step 1.
If it is earlier, Step 0 yields nothing — say so, do not stretch it.

Item 3 also fixes the exact size of Step 1. Do not assume 25; count the ones with
`err = false` that have not already been read.

### Boundaries

- No HTTP, no RPC, no browser. Local database reads only.
- Read-only. No INSERT/UPDATE/DELETE on any table.
- No existing script covers this (`alpha-inspect.ts` is research-job-scoped). If a
  small read-only inspection script is the cleanest way, propose it before writing
  it — it is new code, not a query.
- A decrease is a decrease. Never write it as a burn, a buyback or a supply change.

### Prohibited

- No live calls. Steps 1 and 2 are separately authorized.
- No paging, no arbitrary transactions, no counterparty-chasing.
- Do not hardcode the second documented burn address.
- Do not start a second task.

### Definition of done

The three readings above, stated exactly as observed with their slots, plus a
plain statement of what the ordering does and does not establish. If the database
is unavailable offline, say so and stop — that is a valid outcome, not a failure.
