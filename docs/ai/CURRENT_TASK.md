# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The preserved blobs are decoded. **An asset exchange is now established** for the
transaction at slot `441840975`. Details in `PUMP_CASE.md`, "The exchange,
decoded".

### What is established

> The transaction deterministically executes an asset exchange in which the
> documented address's SOL/wSOL side is used and confirmed PUMP is received.

Within outer instruction 5: `382202589` raw wSOL paid, `7723746661` raw units of
the confirmed mint received, same counterparty on both sides. The venue method
reproduces `sha256("global:swap_v2")[0..8]` exactly; an event in the same
invocation states both mints and both amounts, each corroborated against a
transfer the transaction independently records.

The fact is **CONTEXT** and establishes no component.

### What is deliberately still open

Buyback, revenue funding, published-mechanism execution, market-wide purchase and
policy are all separate bridges, none crossed. One exchange is not a pattern. The
acquisition → burn link remains account-level quantity continuity only, under the
observed-index ceiling.

The aggregator's outer instruction variant is UNSUPPORTED — it matched none of
nineteen tested method names, and nothing depends on it.

### Standing boundaries

- No live calls without separate authorization.
- Do not call the exchange a buyback, a purchase, or a mechanism execution.
- Do not connect this cycle to the later acquisition at slot `441977087`.
- Do not broaden the decoder to general Jupiter or Raydium support.
