# Current task

> Overwrite this file each round. Never append.

## D-170 CREATOR BETA LAUNCH GUARDRAILS — IMPLEMENTED OFFLINE, NOT COMMITTED

Founder-approved 2026-10-05. LIVE CALLS MADE BY THIS TASK: 0.
Migration 0065 applied ONLY to the isolated test database by the suite.
atlas_dev config untouched (still limit 5, no global row → reads 0, closed).

Done on this tree: global capacity (every admitted PRIVATE_BETA job, under
an advisory lock in the job transaction), Interpreter refusal before the
model when no Research can follow (incl. personal allowance used up),
creator invite → ordinary beta grant, bounded to 20 creator users in total
across all tokens (plus a per-invite bound),
`/api/me.privateBeta` + Home/Profile "Private Beta · N Research remaining",
one-time feedback after the second Proof, owner tool `invite` / `stop` /
`--global-limit`, runbook §13, D-170 recorded,
`tests/creator-beta-guardrails-v1.test.ts`.

Next steps, each needing Founder approval:
- review and commit on `claude/phase-5-research-memory`; push;
- on the hosted database: `config --limit=3 --global-limit=60 --creator-user-limit=20 --apply`,
  then `invite --until=YYYY-MM-DD --max-redemptions=20 --apply` (runbook §13);
- HTTPS smoke test: creator link → sign-in → grant; D-168 forward;
- deployment topology decision.

STOP here until the Founder reviews.
