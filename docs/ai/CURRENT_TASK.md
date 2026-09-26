# Current task

> Overwrite this file each round. Never append.

## EVM V1 — ZERO_ADDRESS_TRANSFER, IMPLEMENTED OFFLINE (awaiting Founder review)

Founder-approved 2026-09-24 (the V1 design and the fact kind) and 2026-09-27
(Extension 1: one explicit-block t0 read; Extension 2: an optional block
selector in the canonical target). LIVE CALLS MADE: 0. Not pushed.

### What it answers

"Were tokens actually burned, and did total supply decrease?" for an
Ethereum-mainnet project, from a transaction hash an admitted official
source names. The strongest answer it can give:

> A transfer of the project token to the zero address was observed, and the
> total supply was lower at the end of the measured period than at the
> start — but the evidence does not establish that this transfer brought it
> down or that the claimed mechanism executed.

It never says the tokens were burned and never says the mechanism executed.

### The semantic model

- **ZERO_ADDRESS_TRANSFER** (new `onchain_fact_kind`, migration 0057): a
  successful receipt, an ERC-20 Transfer log emitted by the confirmed token
  contract (3 topics, 32-byte data), `to` exactly 0x000…000. Establishes no
  component (not EXECUTION_EVIDENCE); readable by NET_EFFECT as an interval
  anchor only. `0x…dEaD` and every other destination → TOKEN_TRANSFER
  (CONTEXT). A reverted transaction or a foreign contract's log → nothing.
- **Interval**: anchored on the zero-address transfer exactly as on a burn
  (`t0 < event < t1`, strict). This Research's own reading may be t0 only
  when taken at an explicit historical block before the event.
- **Reads**: at most one t0 (block = earliest event − 1, EVM mainnet only,
  only when every usable event is a zero-address transfer, only when the
  budget can also pay for the t1 the interval still needs) and at most one
  t1, both one-shot, from the unchanged unprotected budget, no retry. No
  archive state → `RETRIEVAL_FAILED`, a technical stop.
- **NET_EFFECT**: decrease → PARTIALLY_SUPPORTED,
  `ZERO_ADDRESS_TRANSFER_SUPPLY_DECREASE_NOT_ATTRIBUTED`; not lower →
  CONTRADICTED, `ZERO_ADDRESS_TRANSFER_SUPPLY_NOT_REDUCED`; no interval → as
  before. BURN outcomes, Solana and every head-read URI are unchanged.

### One deviation from the approved plan, stated

The plan said the non-decrease case would reuse
`NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL`. Its reader copy begins "Tokens were
destroyed…", which is false here, so the case has its own code with the same
semantics (CONTRADICTED) and copy that says only what was measured.

### Still waiting on the Founder (unchanged)

The Blind Live Acceptance Batch V1 inputs in `docs/ai/BLIND_BATCH_V1.md` §11
(token addresses, official-docs hosts, SKY vs MKR, governance routes, live
spend). Nothing here was validated live; see BACKLOG "EVM V1 … offline only".

STOP here until the Founder reviews. No push, no live call.
