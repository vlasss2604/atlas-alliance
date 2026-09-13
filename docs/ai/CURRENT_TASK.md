# Current task

> Overwrite this file each round. Never append.

## EVIDENCE ENVIRONMENT SEAM V1 (done this round)

Offline round. No live call, no RPC, no Research job, no DB change, no
migration, no EVM primitive, no new subsystem, no project-specific rule.

The Research Core (Question → Research → Evidence → reconciliation → Proof →
Verification → Memory) was already chain-agnostic; the deterministic on-chain
layer was conceptually reusable and literally Solana. This round makes the
existing seam explicit so Solana is implementation #1 and an EVM adapter can
later be implementation #2 without a second Research architecture.

- **Environment (`engine/onchain-environment.ts`, new).** One code-owned table
  of implemented `(chain, network)` pairs (`solana/mainnet` → env var
  `SOLANA_MAINNET_RPC_URL`). `onchainEnvironmentFor(identity.chain)` is the
  ONE way generic code turns a confirmed identity into an environment; null
  for every EVM chain today. No network guessing (one production network per
  chain, D-131). Provider-free, so the materialization stage can consult it.
- **Registry (`providers/onchain-retriever.ts`).** The single global slot is a
  map keyed by environment. `__setOnchainRetriever(r, env)` requires an
  explicit, implemented environment; `resolveOnchainRetriever(chain,
  network)` / `onchainRetrievalAvailable(chain, network)` answer for that key
  only. No fallback across network or chain; unconfigured fails closed.
  `onchain-transport.ts` maps environment → adapter factory (Solana only).
  `jobs/onchain-capability.ts` installs under its declared environment.
- **Gates and intents (`onchain-acquisition.ts`, `onchain-post-event-supply.ts`,
  `onchain-supply-delta-materialization.ts`).** `identity.chain !== "solana"`
  and `chain: "solana", network: "mainnet"` are gone from generic code; the
  environment comes from the identity. Acquisition resolves the retriever for
  the intents' own environment and records `ONCHAIN_RETRIEVER_NOT_CONFIGURED`
  exactly as before when that environment has none.
- **Identifier shape (`domain/identifier-shape.ts`, new).** Base58 (Solana,
  ranges unchanged) and EVM hex (`0x`+40 address, `0x`+64 tx hash) stated
  once. `identifierShapeForChain` is the chain-aware check; the documentary
  locator validator takes the confirmed chain (the executor passes it) and
  refuses an EVM shape under a Solana identity and vice versa; discovery
  (`document-links`, `embedded-records`) recognises either family without
  attributing a chain. `addressShapeMatchesChain` and binding's address
  equality now read the same module.
- **Chain position (`providers/onchain-types.ts`).** `ChainPosition`
  (ordinal, blockTime, blockHash, finality), `chainPositionOf`,
  `compareChainPositions` — ordered only inside one `(chain, network)`,
  cross-environment fails closed. The `slot` field and column keep their
  name and values. `deriveTotalSupplyDelta` orders through it.
- **Obligation (`structural-obligation.ts`).** The approval registry is asked
  for the identity's own chain via `isInstructionRegistryChain`; a chain the
  registry does not decode is unmet, never looked up as Solana.
- **`OnchainChain` = `SupportedChain`.** The intent vocabulary is the identity
  vocabulary; capability is the registry's separate question.

Unchanged: Solana adapter (RPC methods, validation, decoding, finality),
canonical URI shape, artifact envelope, entity binding rules, Evidence rows,
supply observations, burn semantics, NET_EFFECT, Research Memory reuse,
reconciliation and Proof.

Tests: `tests/evidence-environment-seam-v1.test.ts` (new, offline, 26 cases:
A–I, L, binding); existing on-chain, locator, supply-delta, NET_EFFECT and
capability suites; seven test files now install fixtures with an explicit
environment.

### Reported, not done

- No EVM retrieval, no `eth_call`, no ERC-20, no ABI, no receipts, no EVM
  burn rules, no proxy handling, no L2s. An Ethereum identity still produces
  no intent and reserves no chain budget; it now does so because the
  environment table has no entry, not because a literal said "solana".
- `jobs/onchain-capability.ts` still declares one environment
  (`ONCHAIN_CHAIN`/`ONCHAIN_NETWORK` = solana/mainnet) — a deployment
  declaration, not an engine assumption. A second environment is a second
  declaration.
- `TransactionDetailResult`, the instruction registry, invocation provenance,
  owner flow and account lifecycle remain Solana-shaped by design.

### Next

- ChatGPT review of the seam. Do NOT proceed to EVM TOKEN_SUPPLY without it.
