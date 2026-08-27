# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The pre-burn window inventory is done, offline, read-only. No RPC call was made,
no code changed, no test added.

### What it found

The window immediately preceding the burn did not need completing. Two of its ten
signatures already had transaction detail, they are the two newest, and they are
adjacent: an inflow of `7723746661` raw units into `9Wtcf…` from a zero balance at
slot `441840975`, then a `BurnChecked` of `7723746661` taking it back to zero at
`441840980`, with no signature listed between them.

That is a complete interval, so an **account-level inflow → burn continuity
statement already holds** at zero further cost. Details and its limits are in
`PUMP_CASE.md`, "The burn's own interval is already complete".

### The open decision, for the owner

**Eight** signatures in that window still have no transaction detail — the exact
maximum for a future authorized run. It is **not recommended**: the balance at
slot `441840975` was already zero, so those eight transactions cannot bear on this
burn's accounting. They would answer whether the cycle recurs, and ten signatures
cannot answer that.

Also unauthorized and unstarted: pinning the continuity finding as an offline
regression test, which would be small and is not yet done.

### Standing boundaries

- No live calls without separate authorization.
- No paging, no signatures outside a persisted window, no counterparty-chasing —
  `48xDcrnn…` and `45ssPkUQ…` are out of scope.
- Do not call the inflow a buyback, purchase, swap or revenue-funded acquisition.
- Do not connect this cycle to the later acquisition at slot `441977087`.
