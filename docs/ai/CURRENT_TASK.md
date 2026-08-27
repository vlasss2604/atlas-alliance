# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The transient-wrapper blind spot is closed. Details in `PUMP_CASE.md` ("The
reciprocal shape, and how ATLAS came to see it") and `ARCHITECTURE.md`.

### What changed

`deriveReciprocalAssetFlows` recognises a second shape: the payer funding an
account it owns, which then pays the counterparty. Ownership for an account with
no balance metadata comes from same-transaction instructions that establish it by
protocol definition — read, never inferred — and every agreeing instruction is
named. Balance metadata still comes first; disagreement between the two sources
resolves the account to nothing.

Routing stays visible: the native leg records what went into the wrapper, the
onward hop records what reached the counterparty, and no amount crosses between
them. Legs and pairing remain DIRECT + CONTEXT.

### Standing boundaries

- No live calls without separate authorization.
- No paging, no signatures outside a persisted window, no counterparty-chasing.
- Do not decode program ids; that is a separate authorized step and it is the one
  that would license "swap" or "market purchase".
- Do not call the inflow a buyback, purchase or revenue-funded acquisition.
- Do not connect this cycle to the later acquisition at slot `441977087`.
