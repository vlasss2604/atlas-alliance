# Current task

> Overwrite this file each round. Never append.

## GENERIC PERSISTING TOKEN_SUPPLY PROBE V1 (done this round)

Offline round. No live RPC, no Research job, no model/search call, no DB
schema change, no new primitive, no Research Core change, no Memory
eligibility change, no project- or chain-specific rule.

The stopped live validation exposed a generic operational gap: the
deterministic TOKEN_SUPPLY path (identity → exact-environment retriever →
canonical artifact → binding → Evidence) lived only inside the Research
executor. The standalone owner scripts were Solana-literal (observe-account,
observe-token-accounts, observe-signatures) or non-persisting (onchain-smoke).

- **Entry point (`scripts/onchain-observe-token-supply.ts`, new).**
  `npx tsx scripts/onchain-observe-token-supply.ts --project=<slug>
  [--component=<C>]`. No chain, network or address flag exists. The logic is
  the exported `observeTokenSupply(deps)`; `main` only parses flags.
- **Identity.** `resolveConfirmedIdentity` (the executor's resolver) plus an
  operator-strict ambiguity gate: more than one ACTIVE PROJECT_IDENTITY row
  is refused. Missing, non-ACTIVE, or token-less identities refuse before
  anything is constructed. No SOURCE_ROUTE, document or ticker is read.
- **Environment / retriever.** `onchainEnvironmentFor(identity.chain)` →
  `createProductionOnchainRetriever(env.chain, env.network)`, exact key,
  then `supports(chain, network, TOKEN_SUPPLY)`. Neither chain is named in
  the script's code (asserted by test). An Ethereum identity in a
  Solana-only process is `RETRIEVER_NOT_CONFIGURED`; nothing is called.
- **Observation.** One intent, `TOKEN_SUPPLY`, a module constant; one
  `retriever.retrieve`; no retry. Owner gates kept: live allowlist
  (`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`), `internal_alpha_enabled`, and the
  component must be ONCHAIN_VERIFIABLE-establishable per the Pattern; its
  step comes from the Pattern (default CURRENT_STATE, step 5).
- **Persistence.** The production `persistOnchainArtifactAndFacts` in an
  owner-attributed, never-enqueued job (skipEnqueue, budget 1 sourceOpen /
  0 searches / 0 model) — the same job discipline as observe-account. Then
  `reconcileAndPersistComponent` for the one component, job-scoped. Binding
  is `validateOnchainBinding(artifact, identity)` and containment refusal
  writes nothing (`NOT_PERSISTED`, detail carries the reason).
- **Memory.** Writes no `project_memory_items`. The artifact is
  RESEARCH_JOB-origin under the owner job — exactly what observe-account
  produces — so existing job-scoped eligibility rules apply unchanged;
  promotion to Research Memory stays the separate VERIFIED-only owner path.

Tests: `tests/onchain-observe-token-supply.test.ts` (new, DB-backed, 20
cases, A–M): both chains end to end with fixture transports; the Ethereum
rows equal what Research writes for the same artifact (all columns except
ids, job, timestamps and the job-scoped extractionUnitKey); wrong-chain
artifact refused at the production gate with nothing written; source scan
pins one intent, no chain literal, no second writer.

### Reported, not done

- Not run live. `ETHEREUM_MAINNET_RPC_URL` is configured nowhere. Lido has
  no PROJECT_IDENTITY in `atlas_dev`.
- The three older persisting owner scripts remain Solana-literal; bringing
  them through the seam is a separate housekeeping round.

### Next

- Founder: confirm the Lido identity through
  `scripts/confirm-project-identity.ts`, set `ETHEREUM_MAINNET_RPC_URL`,
  then authorize one run of the probe.
