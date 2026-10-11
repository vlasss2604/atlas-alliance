# Current task

> Overwrite this file each round. Never append.

## ENGINE SPEED + BUDGET ACCOUNTING — OFFLINE-VERIFIED, AWAITING FOUNDER APPROVAL OF BENCHMARK #2

Branch `claude/phase-5-research-memory`, on top of `d0dafcc` (UI V7).
LIVE CALLS MADE BY THIS TASK: 0. No new Research, no push, no commit.
Read-only inspection of the dev DB (`atlas_dev`, job `b817eb99`) only.

Implemented on this tree (uncommitted):

- D-173 budget settlement: a completed model call's reservation is settled
  down to its actual cost; admission still reserves the profile maximum.
- `research_attempts.completed_at` = wall-clock completion.
- D-174 EvidenceExtractor output ceiling 4,096 (OPEN; allowed for
  Benchmark #2, not to be raised further).
- D-175 safe speed pass: exact-barrier component overlap (3), job-level
  extraction probe, job-wide extraction call gate (8), SEARCH-phase
  pipelining.

Verified offline: 32 suites / 568 tests, benchmark 161/161, tsc, lint
(0 errors), `git diff --check`.

NOT implemented (each needs its own Founder decision): relaxed component
concurrency, document-first prompt / context redesign, prompt caching.

Next step, needing Founder approval:
- Benchmark #2: one controlled live Research on the same Jito question
  ("Does Jito use protocol revenue to buy back or burn JTO, and is that
  mechanism executing now?"), bounded, zero retries, measured against the
  213.3 s baseline (job `b817eb99`);
- then review and commit (no push).

STOP here until the Founder approves the live benchmark.
