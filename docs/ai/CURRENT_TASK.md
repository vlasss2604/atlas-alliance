# Current task

> Overwrite this file each round. Never append.

## EVM TOKEN_SUPPLY V1 (done this round)

Offline round. No live RPC, no Research job, no Lido run, no DB change, no
migration, no new Evidence concept, no project-specific rule.

The first deterministic EVM primitive, and the first proof that the
evidence-environment seam (9e01fe1) carries a second implementation without
touching the Research Core: **TOKEN_SUPPLY on Ethereum mainnet**, producing
the SAME semantic observation Solana produces (token + total supply +
decimals + canonical chain position + finality/provenance).

- **Adapter (`providers/onchain-evm.ts`, new).** Serves exactly one intent
  kind, `TOKEN_SUPPLY`, for exactly one environment, `ethereum/mainnet`.
  Four bounded calls per observation, fixed order, closed parameters:
  `eth_chainId` (must be 1 — a wrong chain id fails closed before any read),
  `eth_getBlockByNumber ["finalized", false]` (null or error fails closed —
  never `latest`), `eth_call totalSupply()` (`0x18160ddd`) and `eth_call
  decimals()` (`0x313ce567`), both pinned to the SAME finalized block by
  explicit number. Decimals are read, never assumed 18. BigInt decoding of
  exactly-32-byte return words; an empty return (no code) fails closed.
  Hex validation of anchor and subject happens before any request.
- **Chain position.** Finalized block number is the environment's ordinal
  (persisted `slot`, column name unchanged); block hash, block timestamp
  and `finality: "finalized"` travel in provenance. `rawResponseHash`
  covers all four raw responses; `artifactHash` is the canonical result.
- **Shared JSON-RPC rule (`providers/onchain-jsonrpc.ts`, new).** Envelope
  parsing, `OnchainRpcError`, `sha256` and `canonicalJson` moved out of the
  Solana adapter so both implementations agree on what a node error is and
  what the artifact hash is a hash of. The Solana adapter re-exports
  `OnchainRpcError`; its artifacts are byte-identical.
- **Environment table.** `ethereum/mainnet` → `ETHEREUM_MAINNET_RPC_URL`
  added to `engine/onchain-environment.ts`; the transport's implementation
  map gains the EVM factory. An Ethereum identity now admits acquisition,
  produces `TOKEN_SUPPLY` intents addressed to `ethereum/mainnet`, and — in a
  process holding only a Solana retriever — takes the existing bounded
  `ONCHAIN_RETRIEVER_NOT_CONFIGURED` path. Other EVM chains remain
  unimplemented (null environment).
- **Research Core unchanged.** Binding, containment, persistence, facts,
  supply-delta, NET_EFFECT, reconciliation and Proof have no EVM branch;
  the persistence test proves an Ethereum artifact lands in the same rows
  with `entityBinding CONFIRMED` through the same path.

Not implemented, by design: balanceOf, logs, receipts, transfers, event
decoding, proxy resolution, EVM burn, governance execution, archive reads,
any generic contract call, any other EVM chain. `jobs/onchain-capability.ts`
still declares only `solana/mainnet` — a live Ethereum run needs a
deployment declaration for the second environment (next step, after review).

Tests: `tests/evm-token-supply-v1.test.ts` (new, offline, 22 cases, A–L,
N–Q) and `tests/evm-token-supply-persistence-v1.test.ts` (new, DB-backed,
M); three existing test blocks that encoded "Ethereum is unimplemented" now
use `bsc` for that role.

### Reported, not done

- No live Ethereum validation. `ETHEREUM_MAINNET_RPC_URL` is not configured
  anywhere; live validation is a separate Founder-approved step.
- Four RPC requests per TOKEN_SUPPLY observation against one sourceOpen
  (Solana needs one). Bounded and closed; a per-process chain-id cache
  could remove one, deliberately not done this round.

### Next

- ChatGPT review. Then a deployment declaration for `ethereum/mainnet` in
  the capability installer, then Founder-approved live validation.
