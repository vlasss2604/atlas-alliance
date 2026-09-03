# Current task

> Overwrite this file each round. Never append.

## NONE — on-chain source-open reservation V1

Offline round. No live HTTP, no RPC, no model call, no Proof. Cloud-safe
focused tests only.

### What changed

`sourceOpens` is one axis shared by documentary opens, renders and bounded
RPC reads, and nothing decided the ORDER in which it could be claimed. The
phased architecture fixes that order structurally — FETCHING runs to
completion before EXTRACTING, and only EXTRACTING can reach a chain — so
documentary acquisition spent the whole axis and every planned on-chain
intent was refused `SOURCE_OPEN_BUDGET_EXHAUSTED`.

One new module, `src/server/engine/onchain-source-open-reserve.ts`, holds a
small bounded FLOOR inside the EXISTING ceiling. It is not a second ledger:
it computes a LOWER CEILING that documentary reservations pass to the same
`reserveJobBudget`, while on-chain reservations keep passing the full one.

- **Floor** = `MAX_ONCHAIN_INTENTS_PER_ATTEMPT` (2), capped at half the
  job's ceiling. `reserved + documentaryCeiling === maxSourceOpens`, always.
- **Activates** only where outstanding plan work yields an on-chain intent,
  decided by `selectOnchainIntents` itself — Pattern establishing classes,
  confirmed identity, supported chain, component→intent map. No project.
- **Releases** when nothing outstanding admits it, when the context is known
  not to reach a chain (`DOCUMENTARY_ONLY`, `ONCHAIN_RETRIEVER_NOT_CONFIGURED`),
  and — in the executor — when no component is left pending. An UNKNOWN
  capability never releases it.
- **No locator still means no floor** for account-kind components: the
  predicate inherits that gate rather than restating it.

Applied at both documentary spend sites: `runFetchPhase` (once per pass,
threaded to every strategy) and `s4-executor`'s fetch loop, both renders and
its `openAllowance`.

### Unchanged

Total ceilings, `reserveJobBudget`, the DB schema, the trace vocabulary, the
Pattern, NET_EFFECT semantics, evidence admission, source authority, model
prompts and provider configuration. The four boundaries stay four things:
no subject / capability disabled / RPC failure / bounded budget limitation —
and none is evidence that a mechanism is absent.

### OPEN OWNER DECISION — `admittedLocatorsForJob` is project-scoped

Deliberately NOT changed this round, and not renamed.

`admittedLocatorsForJob(db, jobId)` resolves the project FROM the job, then
selects every CONFIRMED, literally-present locator on CONFIRMED evidence of
**any job of that project** (`documentary-locator-store.ts:271`). The name
says job; the contract is project.

- **Freshness**: none. No age bound, no re-verification. The only liveness
  signal is `sources.health != 'BROKEN'`; a locator whose document changed
  or was retracted stays admissible while its source row looks healthy.
- **Revocation**: only by lowering `evidence.officiality`, the locator's
  `validationResult`, or marking the source BROKEN. There is no locator-level
  revocation act.
- **Selection**: sorted by address, capped at 8. A locator from an old job
  can crowd out one established in this run purely alphabetically.
- **Provenance**: the returned shape is `{value, shape}` — the justifying
  evidence id and its job are dropped, and `onchain_artifacts` records only
  the acquiring job. **A Proof therefore cannot today distinguish a locator
  reused from earlier project research from one established in this run.**

Owner decision needed: keep project-scoped reuse (and add provenance +
freshness), or narrow the contract to the job. Analysis only this round.
