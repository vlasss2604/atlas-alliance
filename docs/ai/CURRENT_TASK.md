# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The signature-coverage contract check is done, offline. No production code
changed; the correction was to wording that had outrun its evidence.

### What it found

ATLAS has **no contract** for what the RPC address-signature index covers. There
is no Solana SDK in the tree, address lookup tables are modelled nowhere
(`meta.loadedAddresses` and `message.addressTableLookups` are unread), and the
account-key schema keeps only `pubkey`, discarding the `source` field that would
say whether an address arrived via a lookup table.

So "no other transaction touched the account" was a census claim resting on an
unverified premise. The correct, weaker statement — *nothing further was listed
for that range by the observed window* — is what the data supports, and it still
carries the burn cycle's quantity reconciliation.

No production path relied on the stronger reading: windows are treated as
deterministic sampling, and the signature fact is CONTEXT-only. Details in
`PUMP_CASE.md`, "Why 'complete' is the wrong word here"; the generic rule is in
`CORE_RULES.md`, "An index is not a census".

### Flagged, not fixed

The `SIGNATURES_FOR_ADDRESS` fact statement reads "Address X has N on-chain
transaction(s) in the observed window", which phrases an index reading as a
count. It establishes nothing (CONTEXT, with its own limits attached), so it was
left alone under this round's no-production-change rule. Worth a decision.

### Standing boundaries

- No live calls without separate authorization.
- No paging, no signatures outside a persisted window, no counterparty-chasing.
- Do not call the inflow a buyback, purchase, swap or revenue-funded acquisition.
- Do not connect this cycle to the later acquisition at slot `441977087`.
