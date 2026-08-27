# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The inflow transaction at slot `441840975` has been inspected offline. No RPC, no
production change. Findings in `PUMP_CASE.md`, "The inflow transaction, and the
fact it does not produce", pinned by
`tests/onchain-persisted-inflow-shape.test.ts`.

### What it found

The transaction really does carry a reciprocal shape — the documented address
pays out `382585174` lamports, the counterparty `45ssPkUQ…` pays in `7723746661`
raw units of the confirmed mint, one successful transaction, both sides
reconciling exactly.

**ATLAS derives nothing from it.** The payment routes through a transient
wrapped-SOL account the payer creates, funds, spends and closes in the same
transaction; that account is in no balance metadata, so its owner is unresolvable
and the native leg is dropped before pairing. No burn plus no derivable flow means
no fact for any component. The case's most informative acquisition-side
transaction is invisible to the Evidence path.

### The open decision, for the owner

Closing that gap is generic work — wrap-then-pay is the ordinary way to spend SOL
down a token-program path, so this blind spot is not PUMP's. It would mean
resolving a transient account's owner from its own `initializeAccount3` /
`createIdempotent` instruction, and admitting a second pairing shape,
`A → A's own wrapper → C`.

That relaxes a deliberate rule — ownership comes from the RPC, never from
inference — so it is a decision, not a patch. **Not implemented.** Nothing should
be built here without approval.

### Standing boundaries

- No live calls without separate authorization.
- No paging, no signatures outside a persisted window, no counterparty-chasing.
- Do not decode program ids; that is a separate authorized step and it is the one
  that would license "swap" or "market purchase".
- Do not call the inflow a buyback, purchase or revenue-funded acquisition.
- Do not connect this cycle to the later acquisition at slot `441977087`.
