# Backlog

## DO NOT WORK ON THESE UNLESS `CURRENT_TASK.md` REQUIRES IT.

Known, non-blocking, deliberately deferred. Opportunistically fixing one of these
inside another task is scope creep and makes the change harder to review. If one
genuinely blocks the current task, say so and get it scoped explicitly.

### Engine / research

- **`ContentFetchError.reason` observability** — the reason a fetch failed is not
  surfaced usefully. Matters because a failed read must never be readable as
  absence, and today the distinction is hard to see from outside.
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

### Data / migrations

- **Stale Drizzle snapshot metadata for hand-authored migrations** — the snapshot
  does not reflect migrations written by hand.

### Product surface

- **Foreign-mint CONTEXT rendering** — Proof/UI must present a foreign-mint
  observation as visually neutral. It is neutral in reconciliation; nothing yet
  guarantees it reads that way to a user.

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
