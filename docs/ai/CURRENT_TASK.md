# Current task

> Overwrite this file each round. Never append.

## EVM CAPABILITY INSTALL V1 (done this round)

Offline round. No live RPC, no Research job, no Lido run, no DB change, no
new Evidence primitive, no Research Core change, no TOKEN_SUPPLY change.

The last blocker before a live Ethereum observation: the runtime capability
installer declared and installed only `solana/mainnet`. Now the installer
covers every implemented environment this deployment configured.

- **Installer (`jobs/onchain-capability.ts`).** The role (SEARCH_EXTRACT)
  and the flag (`ONCHAIN_RESEARCH_ENABLED=1`) still decide WHETHER this
  process may reach a chain — unchanged. WHICH environments it installs is
  now `configuredOnchainEnvironments(env)`: every implemented
  `(chain, network)` whose allowlisted endpoint variable is set (presence
  only; the value is never read here). Each is constructed through the
  existing factory and installed under its own exact key. Any configured
  environment that cannot construct (absent, not https, credential in the
  URL) fails startup naming its env var, and nothing is left installed.
  Flag on with no endpoint configured at all attempts the default
  `solana/mainnet` and fails closed naming `SOLANA_MAINNET_RPC_URL`, exactly
  as before. `OnchainInstallResult.installed` lists every installed
  environment; `providerId` stays the first label.
- **Factory (`providers/onchain-transport.ts`).** `createProductionOnchainRetriever`
  takes an optional `env` (default `process.env`) so the installer reads
  presence and value from one place.
- **Environment table.** `implementedOnchainEnvironments()` enumerates the
  table (re-exported from `onchain-retriever.ts`).
- **Config hygiene.** `ETHEREUM_MAINNET_RPC_URL` added to the renderer's
  `FORBIDDEN_ENV_KEYS` tripwire and documented empty in `.env.local.example`.
  Worker startup logs the installed labels (never an endpoint).
- **alpha-run** is untouched: its live pre-flight still requires the Solana
  endpoint, because the alpha live target is a Solana project.

Behaviour: Solana-only config installs Solana as before; Ethereum-only
config installs `ethereum/mainnet` (TOKEN_SUPPLY only); both coexist and
resolve independently; no Ethereum URL leaves `ethereum/mainnet`
unavailable; an Ethereum identity in a Solana-only process (and the
reverse) records `ONCHAIN_RETRIEVER_NOT_CONFIGURED`; unsupported networks
stay unavailable; no environment stands in for another.

Tests: `tests/evm-capability-install-v1.test.ts` (new, offline, 12 cases,
A–H); existing capability, parity, seam, EVM adapter and Solana suites
green; one source-string pin in `onchain-research-capability.test.ts`
updated for the per-environment factory call.

### Reported, not done

- No live Ethereum observation. `ETHEREUM_MAINNET_RPC_URL` is configured
  nowhere in this repository.
- "Declared, never discovered" now reads: the flag declares the capability;
  the endpoint variables declare which environments — a deployment that
  sets `ETHEREUM_MAINNET_RPC_URL` has declared Ethereum. There is no
  separate per-chain enable flag; adding one is a Founder decision.

### Next

- Founder-approved live validation of one Ethereum `TOKEN_SUPPLY`
  observation, after ChatGPT review.
