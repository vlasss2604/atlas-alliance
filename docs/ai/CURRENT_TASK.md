# Current task

> Overwrite this file each round. Never append.

## OWNER OBSERVATION ORIGIN V1 (done this round)

Offline round. One additive migration, no live RPC, no Research, no Lido
mutation, no Memory redesign, no comparability change.

**The proven bug.** The persisting owner scripts create a research_jobs row
because Evidence requires one, with the default origin PRODUCT — the same
origin a real Research carries. The historical total-supply loader admitted
any prior RESEARCH_JOB-origin artifact from a different job, so an operator's
TOKEN_SUPPLY probe was eligible as a later Research's t0. Proven against the
test database before this round.

- **Schema.** `research_job_origin` gains `OWNER_OBSERVATION` (migration
  `0048`, `ADD VALUE IF NOT EXISTS`, default stays PRODUCT, no row rewritten).
  Meaning: an operator-run bounded acquisition or observation job — persisted
  and inspectable, NOT a Research acquisition.
- **The rule (`engine/research-acquisition-origin.ts`, new).**
  `REAL_RESEARCH_ACQUISITION_ORIGINS = {PRODUCT, OWNER_MANUAL_ALPHA}`, a
  positive allowlist. OWNER_MANUAL_ALPHA is kept because it is the admin
  manual-admission path for FULL Research (the dev DB holds 9 TOKEN_SUPPLY
  artifacts from such jobs). Any origin not listed fails closed.
- **The boundary.** `loadHistoricalSupplyCandidates` inner-joins the
  producing `research_jobs` row and requires `origin IN` the allowlist, in
  the query. It is the ONE place cross-job candidate eligibility is decided;
  the pure selectors, post-event completion and materialization consume its
  output unchanged and gain no second origin check. No artifact-level flag.
- **Owner scripts.** `onchain-observe-token-supply`, `onchain-observe-account`,
  `onchain-observe-token-accounts`, `acquire-document`, `alpha-acquire-url`,
  `extract-from-document` pass `origin: "OWNER_OBSERVATION"` — one line
  each, no other behaviour change. `alpha-run` (drives the full Research
  handler) and the two product paths are untouched and stay reusable.
- **Unchanged.** Same-job reuse (job-scoped, origin-blind), current-job
  loading (an owner job still sees its own reading), STANDALONE exclusion,
  VERIFIED Research Memory promotion (reads no job origin), worker routing
  (an OWNER_OBSERVATION job is never enqueued; owner-alpha routing already
  answers NOT_OWNER_MANUAL_ALPHA for it).
- **No backfill.** No owner-produced TOKEN_SUPPLY artifact exists; the two
  older owner on-chain jobs in `atlas_dev` hold account-level artifacts that
  can never enter the supply loader.

Tests: `tests/owner-observation-origin-v1.test.ts` (new, DB-backed, 13
cases): the proven bug now yields zero candidates; PRODUCT and
OWNER_MANUAL_ALPHA priors remain eligible; mixed history returns only the
Research readings; the selector, post-event completion and materialization
each refuse the owner probe and accept a PRODUCT prior in the same test;
same-job reuse and Memory untouched; all six owner scripts pinned; no
chain/project literal in the rule.

### Next

- Founder-approved live Ethereum validation, after ChatGPT review.
