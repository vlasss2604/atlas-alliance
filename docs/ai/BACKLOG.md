# Backlog

## DO NOT WORK ON THESE UNLESS `CURRENT_TASK.md` REQUIRES IT.

Known, non-blocking, deliberately deferred. Opportunistically fixing one of these
inside another task is scope creep and makes the change harder to review. If one
genuinely blocks the current task, say so and get it scoped explicitly.

### Engine / research

- **Reserved vs spent source-open accounting** — a discrepancy between what the
  budget reserves and what it records as spent.
- **Cross-component duplicate chain facts** — the same chain observation can be
  synthesized independently for several components.
- **Fee-payer / signer projection** — transaction fee payer and signers are not
  projected into the typed result.
- **`TOKEN_ACCOUNT_BALANCE` has no current caller** — the intent exists and is
  reachable by nothing since account maps moved to `ACCOUNT_INFO`. Decide whether
  it earns its place or goes.
- **`MAX_LOCATORS_PER_FACT = 10`** — overflow and coverage semantics are
  undefined. What does it mean when a fact has more locators than the cap?
- **`onchain_artifacts.normalized_result` is unversioned.** The stored payload is
  whatever the adapter produced on the day, and the row carries no contract
  version. Verified: three of five persisted `TRANSACTION_DETAIL` rows predate
  `lifecycleInstructions`, and replaying one through today's synthesizer throws.
  Harmless today — nothing replays a stored artifact — and a hard precondition
  for any future artifact-reuse path. Pinned by
  `tests/onchain-persisted-burn-evidence.test.ts`.

### Owner tooling gaps — BLOCKING for the next case

Both are the same shape as the `SOURCE_ROUTE` gap already closed: a decision the
architecture requires a human to make, with no controlled auditable tool to make
it. Neither is a defect in research behaviour; both stop project #2 before it
starts.

- **`PROJECT_IDENTITY` confirmation has no supported path** — *BLOCKING.*
  Nothing in `src/` or `scripts/` inserts one. `onchain-account-check.ts` and
  `onchain-derive-token-accounts.ts` read it and refuse without it, and S4 skips
  structured on-chain acquisition unless the project has a confirmed identity.
  Smallest fix: one owner script mirroring `confirm-source-route.ts` — insert as
  OBSERVED, reuse `promoteProjectMemoryItem`, validate chain and address shape at
  the edge, refuse a duplicate ACTIVE identity, print what `resolveProjectIdentity`
  then returns.
- **Route classification has no supported path** — *BLOCKING.*
  `confirm-source-route.ts` deliberately assigns no `routeClass`; the separate
  later act that assigns `OFFICIAL_DOCS` was never built. Without it the
  acquisition scope gate refuses and no documentary Evidence is admissible.
  Smallest fix: a second owner script that classifies an **already ACTIVE,
  unclassified** route, refusing to invent one — and it must respect the
  overlap and inheritance hazards already documented, since adding a classified
  row is exactly what can null a neighbouring route's matched prefix.

### Chain coverage

- **`SUPPORTED_CHAINS` promises more than the transport delivers** —
  *NON_BLOCKING, and a real capability boundary.* Identity may be confirmed on
  ethereum, bsc, polygon, arbitrum, base, optimism and avalanche, but
  `onchain-transport.ts` returns `null` (`v1: Solana only`) and every intent is
  gated on `chain === "solana" && network === "mainnet"`. A project confirmed on
  an EVM chain therefore degrades silently to documentary-only — S4 treats a
  missing retriever as a configuration boundary and falls through, which is
  correct behaviour, not a bug. Recorded because it decides which projects can
  ever exercise the on-chain half of the pipeline, and because the two
  non-PUMP projects already seeded (`uniswap`, `hyperliquid`) are both affected.
  **Whether to add an EVM read transport is an owner decision, not a backlog
  item to pick up.**

### Data / migrations

- **Stale Drizzle snapshot metadata for hand-authored migrations** — the snapshot
  does not reflect migrations written by hand.

### Product surface

- **Foreign-mint CONTEXT rendering** — Proof/UI must present a foreign-mint
  observation as visually neutral. It is neutral in reconciliation; nothing yet
  guarantees it reads that way to a user.

### From the PUMP case closure (2026-08-28)

Every item here is **NON_BLOCKING or DEFERRED**. None of them may silently
restart the PUMP investigation, and none is a correctness defect.

- **Proxy tunnel-outcome observability** — *DEFERRED.* After the egress proxy
  allows a CONNECT, the tunnel's outcome is never recorded: connected, errored
  and zero-bytes-transferred are indistinguishable, because the error path
  destroys both sockets silently. The allow itself is pushed at policy-decision
  time, *before* `netConnect`, so it proves policy said yes and nothing more.
  A counts-only, host-free diagnostic would close the last unlit segment of the
  render path. Deferred deliberately: it diagnoses our own network stack, and
  the branch that wanted it is closed.
- **`fees.pump.fun` API lead** — *DEFERRED.* `fees.pump.fun/api/buybacks` is
  known only from a third-party adapter. Reaching it needs **its own** confirmed
  route at prefix `/api`; the existing `/` grant does not cover it. Expectation
  set honestly in advance: an endpoint *named* `buybacks` is not a statement, and
  records merely containing an address are locator co-occurrence. Only a payload
  that **assigns the role** would move anything.
- **`fees.pump.fun` root is unread** — *DEFERRED, not failed.* Four windows ended
  in transport failures, never in a page. Its content is unknown, so the
  address's absence from it is **not** established.
- **Artifact → Evidence adoption path** — *DEFERRED, and architectural.* Every
  deterministic chain fact in this repository lives in a standalone artifact;
  `onchain_artifact_id` is null on all 401 Evidence rows. Getting one into
  Evidence requires a live retrieval inside a research job, by design — there is
  no offline adoption path and there should not be a back door. Worth designing
  deliberately when a case needs it, not improvised.
- **Explorer text classified `ONCHAIN_VERIFIABLE`** — *NON_BLOCKING, observed.*
  53 Evidence rows carry that class while being model-extracted explorer prose
  with `entity_binding = UNVERIFIED` — some of it EVM Solidity for a Solana
  project. They establish nothing and the architecture refuses them correctly, so
  this is not a defect. Recorded because the naming invites a reader to mistake
  the class for a chain read; the rule is now in `CORE_RULES.md`.
- **Documentary re-extraction cleanup** — *REJECTED as a task.* The three
  `PARTIALLY_SUPPORTED` `DESTINATION` results rest on sets where only one row is
  really destination evidence, but they are historical: the later full-pattern
  runs did not reproduce them, and every component's current result is
  `INSUFFICIENT_EVIDENCE`. Rows are never edited by hand, and re-extraction
  through the pipeline needs the page, which is unreachable. Nothing to do.

### Case-specific, deferred

- ~~**Second PUMP burn address** needs documentary provenance.~~ **Resolved.**
  `9jHrTCwp…` is a CONFIRMED documentary locator at ordinal 1, and one hop has
  been taken from it. See `PUMP_CASE.md`. Its signature history remains
  unobserved — that is research scope, not backlog.

### Tooling / environment

- **Console encoding** — an em dash renders as `тАФ` in some owner-script output on
  this Windows console.
- **Two pre-existing test failures** — a stale source-regex assertion in
  `first-real-run-stage2.test.ts`, and a Windows path bug (`C:\C:\...`) in
  `s10-live-provider-enablement.test.ts`. Both fail at `d04dff9` and are unrelated
  to research behaviour. See `CURRENT_STATE.md`.
