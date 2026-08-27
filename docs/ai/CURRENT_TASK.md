# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Opaque-instruction preservation and inner-instruction parent linkage are
implemented and accepted. See `ARCHITECTURE.md` for the shape and `PUMP_CASE.md`
for what it does and does not change about the inflow transaction.

### What changed

An instruction the node does not parse is now preserved rather than dropped:
program id, ordered account list and opaque data blob, in `rawInstructions`.
Every instruction — parsed or not — records its own position and the ordinal of
the outer instruction it was invoked from, so "inside one invocation" is
distinguishable from "in one transaction".

Nothing reads this material. No program is identified anywhere, and no swap,
purchase or exchange semantics exist in the model. Malformed material is dropped
whole, never stored in part; an over-long blob is dropped rather than truncated.

`rawInstructions` is optional, so artifacts stored before this remain valid.
Absent means "unknown"; `[]` means "read with this capability, none present" —
the two are deliberately not the same.

### Known limit

Preservation is not retrospective. The raw response is still kept only as a hash,
so an existing artifact cannot be enriched; only a fresh read carries the new
material. The inflow transaction at slot `441840975` is therefore unchanged, and
no re-read is authorized.

### Standing boundaries

- No live calls without separate authorization.
- Do not identify any program or decode an opaque instruction; that is a separate
  decision, and it is the one that would license "swap" or "market purchase".
- Do not call the inflow a buyback, purchase or revenue-funded acquisition.
- Do not connect this cycle to the later acquisition at slot `441977087`.
