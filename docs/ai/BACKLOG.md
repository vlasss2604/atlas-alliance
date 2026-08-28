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

### Owner tooling gaps — ALL CLOSED

Each was a decision the architecture requires a human to make, with no
controlled auditable tool to make it. None was a defect in research behaviour;
together they stopped project #2 before it could start. Kept for context.

- ~~**`PROJECT_IDENTITY` confirmation has no supported path.**~~ **CLOSED
  2026-08-28** by `scripts/confirm-project-identity.ts`, with the operation in
  `memory/project-identity-confirmation.ts`. Generic, discovers nothing, reuses
  the domain module's own validation, and refuses a second ACTIVE identity
  outright because the resolver would silently ignore it.
- ~~**Route classification has no supported path.**~~ **CLOSED 2026-08-28** by
  `scripts/classify-source-route.ts`, with the operation in
  `memory/source-route-classification.ts`. Acts on an exact ACTIVE unclassified
  route by id; replaces rather than edits; supersedes the original in the SAME
  transaction, because two co-matching ACTIVE rows make the matched prefix
  vanish; and verifies the swap against the real resolver, rolling back if any
  other route would move. `supersedeProjectMemoryItem` is the primitive it
  needed — nothing had ever written `supersededBy`.

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

- **BLOCKING (S8): the confidence contract is undecided.** `proofs.confidence`
  is `smallint NOT NULL CHECK BETWEEN 0 AND 100`, and D-081 / D-110 /
  `phase-6-plan.md` §11.4 lock only that the number is deterministic,
  code-owned, computed in Proof Core from named inputs (component states,
  source classes, freshness, constraints) and never model-authored — the
  mapping to 0..100 is explicitly left to code and has never been fixed. Until
  it is, **no Proof can be persisted** and S8 stops at the pure builder. The
  four questions a decision must settle (ordinal vs cardinal; which inputs and
  in what precedence; whether the D-074 authority ceiling caps the number; what
  `INSUFFICIENT_EVIDENCE` scores) are written out in `CURRENT_TASK.md`. Needs a
  new `D-###`, not an implementation guess.

- **Foreign-mint CONTEXT rendering** — Proof/UI must present a foreign-mint
  observation as visually neutral. It is neutral in reconciliation; nothing yet
  guarantees it reads that way to a user.

### Future clients and adapters (constraint ACTIVE, implementations NOT scheduled)

The platform-independence constraint (D-125,
`docs/PLATFORM_INDEPENDENT_ARCHITECTURE.md`) is active now; these
implementations are not authorized and each needs its own owner decision:

- Web / iOS / Android clients against the same application boundary
- Payment adapters beyond Telegram Stars (entitlement stays provider-blind);
  includes de-denominating `price_stars_at_purchase` when a second adapter
  is actually built
- Notification delivery adapters (domain event ≠ Telegram message)

### Future extension — Project Assessment (recorded, NOT scheduled)

The canonical spec is `docs/PROJECT_ASSESSMENT_PRODUCT_SPEC.md` (D-124). Only
the phase names are referenced here; none is authorized work, and none may start
without its own scoped owner task:

- **PHASE B — Research Trace** (first mandatory post-core layer; exposure of the
  already-persisted component → evidence chain)
- **PHASE C — Project Memory / Proof association** (no second Project entity)
- **PHASE D — Promise v0**
- **PHASE E — Project Assessment v0** (Evidence Summary / Gaps, Promise Summary,
  Risk Signals, Watch Items)
- **PHASE F — Risk v0** (deterministic rule set; no autonomous risk engine)
- **PHASE G — External source adapters** (candidates only, never truth)

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

- **Every owner-tooling run creates a NEW `users` row.** Confirmed read-only
  2026-08-29: 15 users exist, one carries 19 jobs (seeded/alpha) and the
  recent owner-tool jobs each have their own. `extract-from-document.ts`,
  `onchain-observe-account.ts` and now `onchain-observe-token-accounts.ts` all
  do `db.insert(users).values({})` per run. Nothing is broken — the job is
  correctly attributed and quota logic is DEMO-only — but "the owner" is not
  one stable identity, so per-user history and any future owner-side quota or
  audit view would be fragmented. Deliberately **not** changed while
  implementing the token-accounts tool: a stable owner identity is an identity
  decision (one seeded owner user? a reserved uuid? a marker column?), not a
  side effect of an on-chain task.

- ~~**`ACCOUNT_INFO` has no persisting sibling, so a characterization read
  cannot become Evidence.**~~ **Resolved 2026-08-28** —
  `scripts/onchain-observe-account.ts`: one admitted subject, one intent, one
  RPC, no retry, reusing the production artifact → facts → Evidence →
  reconciliation path and authoring nothing. The open design question is
  resolved the honest way: the tool creates one owner-attributed job whose
  description is exactly this observation (no document, search or model is
  claimed, and those budget axes are zero), which is why creating a job here
  is truthful while `onchain-derive-token-accounts.ts` still correctly refuses
  to. Contract in `ARCHITECTURE.md`; pinned by
  `tests/onchain-observe-account-boundary.test.ts`. **Proven live 2026-08-29**
  (job `9d488cc6-…`): one RPC, one artifact, one Evidence row, and the D-074
  ceiling observed rather than asserted — `PARTIALLY_SUPPORTED` /
  `INSUFFICIENT_AUTHORITY`.

- ~~**Generation-side extractor failures lose their class.**~~ **Resolved
  2026-08-28**, exactly in the shape written here: the raw API error is
  classified by the existing shared classifier, the three closed output values
  exist (`EXTRACTOR_OUTPUT_DIAGNOSTICS`, each emitted only from its own
  branch), and the diagnostic crosses via `safeFailureDetail` — into the
  `CapabilityFatalError` message on the fatal path and into the terminal
  FAILED reason (`EXTRACT_FAILED:<diagnostic>`) on the local path. Pinned by
  `tests/generation-diagnostic.test.ts`; contract in `ARCHITECTURE.md` ("A
  generation failure names its cause").

- ~~**`OUTPUT_SCHEMA_INVALID` should name the failing schema field.**~~
  **Resolved 2026-08-28**: `EXTRACTOR_SCHEMA_FIELDS` +
  `classifyExtractionSchemaFailure` (evidence-extractor.ts) — first issue in
  stable schema order, array indices dropped, closed-`Map` lookup so no path
  segment can pass through, admitted by a third gate requiring the diagnostic
  to be the schema one. Contract in `ARCHITECTURE.md`; pinned by
  `tests/generation-diagnostic.test.ts`.

- **Provider-side structured output and the local zod check did not coincide
  on this schema.** The request carries `output_config` built from the same
  `extractionResultSchema`, yet job `eb00256a-…` returned JSON that failed
  the local `safeParse` (while `baf42b79-…`, same document and model minutes
  later, passed). Worth understanding — it may be a schema construct the
  provider's structured-output layer does not enforce identically, or plain
  output variance. The field-level diagnostic above will name the field on
  the next occurrence. Do **not** "fix" it by loosening validation.

- **The closed generation diagnostic is not persisted at rest for
  owner-tooling runs.** For job `eb00256a-…` the class survives only in the
  pasted terminal line: the `EXTRACT_FAILED` trace row stays
  `PROVIDER_ERROR` (trace enum deliberately unwidened, twice), owner tooling
  writes no `research_attempts` row, and the job row records no termination.
  Fine when the operator keeps the output; nothing at rest can answer "what
  class failed?" later. Options if wanted: widen the trace reason-code enum
  by migration, or add a membership-gated safe-detail column to trace
  events. Related fact, confirmed 2026-08-28: persisted usage columns are
  written ONLY on the success-path `MODEL_CALL_ATTEMPTED` row, so null
  usage columns distinguish nothing between failure classes.

- **QueryProposer generation failures still lose their class.** The proposer's
  `messages.create` catch (query-proposer-anthropic.ts) has the exact shape
  the extractor path had before the fix above — raw message wrapped, no closed
  diagnostic, `max_tokens`/JSON/schema collapse to the bare class name. The
  same mechanism now exists and would transplant directly (shared classifier +
  own output list + `safeFailureDetail` branch). Not urgent: no proposer
  failure has ever been observed live, and the current entrypoints inject a
  fixture proposer.

- **`loadAcquiredDocumentForResume` should refuse a malformed document id with
  the closed `NOT_FOUND`, not a raw driver error.** Observed live: Stage B was
  invoked with the literal placeholder `<DOCUMENT_ID>`; Postgres rejected the
  uuid and the script printed the failed SQL plus the operator's own input via
  the generic catch. No harm done (local SQL, operator's own string, nothing
  external), but it violates the closed-refusal discipline every other axis of
  that loader follows. One shape-check before the query, plus a test.

- **`alpha-acquire-url.ts` teardown is not crash-clean on Windows.** When
  `executor.execute()` throws, the process prints the error and then aborts in
  libuv during exit (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`)
  — likely an open handle (pg-boss/pool) torn down while closing. Verified
  harmless to data on both observed occurrences: every trace write had already
  committed, and the terminal error message prints before the abort. Annoying,
  not corrupting.

- **Console encoding** — an em dash renders as `тАФ` in some owner-script output on
  this Windows console.
- **Two pre-existing test failures** — a stale source-regex assertion in
  `first-real-run-stage2.test.ts`, and a Windows path bug (`C:\C:\...`) in
  `s10-live-provider-enablement.test.ts`. Both fail at `d04dff9` and are unrelated
  to research behaviour. See `CURRENT_STATE.md`.
