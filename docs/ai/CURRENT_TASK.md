# Current task

> Overwrite this file each round. Never append.

## NONE — D-139: the legacy stale sweep no longer kills phased jobs

Offline round. No live HTTP, no RPC, no model call, no worker started, no
retry, no dev state mutated.

### The incident, proven from the persisted record

Job `01589b84-c85d-416d-8845-0fc7435eb43f`:

```
21:15:00.461  QUEUED -> RUNNING            "worker picked up"
21:15:38.293  phase advanced to FETCHING, research-fetch message enqueued
              [operator switches the machine's network — ~28.5 minutes]
21:44:05.596  RUNNING -> FAILED            "stale RUNNING sweep"
21:44:05.703  research-fetch dequeued -> JOB_NOT_RUNNABLE -> completed
```

`sweepStaleRunningJobs` runs at `startWorker` before any queue
subscription. It saw `now() - started_at = 1745s > maxWallClockSec(900) ×
1.5 = 1350s` and failed the job 107 ms before its own fetch message was
picked up. `error_code` and `termination_reason` were null because the
sweep is the only terminal path that writes neither.

The handoff was perfect: `loadFetchTargets` replayed read-only returns **48
valid https targets**, zero lossy, zero unparseable, zero dead. Network: not
involved. Budget: not involved (`sourceOpens` 0/24 untouched).

### The fix

One predicate in `sweepStaleRunningJobs`:

```sql
AND acquisition_phase IS NULL
```

A phased job is RUNNING for its whole journey but PARKED between capability
phases, and parked time is not execution time. The formula was never wrong
for what it was written for; it was asked a question it cannot answer. The
exclusion reads the persisted phase column and nothing else — no worker role,
no capability, nothing about the network. The legacy timeout formula is
unchanged (1.4× survives, 1.6× does not).

### Observability

No canonical `termination_reason` exists for "swept", and none was invented.
`BUDGET_EXHAUSTED` implies the `BUDGET_LIMIT_REACHED` state and one of the
three reserved axes; `SYSTEM_OR_PROVIDER_FAILURE` asserts a technical failure
that did not happen. **Owner decision needed** if a swept job should carry a
machine-readable reason.

Instead, `alpha-inspect` now prints the state-transition journal in its
TERMINATION section, where the explanation was already persisted as the note
"stale RUNNING sweep". No schema, no enum, no write. The same change also
covers the `JOB_NOT_RUNNABLE` visibility gap: the trace vocabulary is
operation-level only (query/search/fetch/extract), so no event there could
honestly describe "the job was not runnable" — the journal does.

### Deliberately not fixed here, recorded for their own rounds

- `runSearchPhase` ignores D-130 fair-share: 6 of 10 components consumed all
  12 search units; DESTINATION, RECIPIENT and NET_EFFECT — what this question
  is about — got zero candidates.
- Phase-1 proposer model spend is unmetered: 20 real Anthropic calls,
  `model_cost_micro_reserved = 0`. The mirror image of D-137.
- A phased-job liveness policy, if one is wanted.

### Standing boundaries

- The legacy sweep judges single-process jobs only; phased liveness is a
  separate, undecided contract.
- Phased research is opt-in and owner-only.
- Every live phase asks the same gate, before constructing any provider.
- The budget default is expensive; a provider that says nothing pays.
- Capability is declared, never discovered.
- Phases are never component attempts; the controller runs once.
- A lossy trace ref is never fetched.
