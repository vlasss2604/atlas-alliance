# Current task

> Overwrite this file each round. Never append.

## WAVE 1 DEPLOYMENT PACKAGE — PREPARED OFFLINE, NOTHING PROVISIONED

Founder-approved 2026-10-03. LIVE CALLS MADE BY THIS TASK: 0. Not pushed.
No product code, Research semantics, auth semantics or Pattern changed.

`deploy/wave1/` holds the smallest production-faithful environment: one
Ubuntu 24.04 server, Caddy (TLS), `next start` on loopback, ONE worker with
`ATLAS_WORKER_CAPABILITIES=SEARCH_EXTRACT,FETCH`, PostgreSQL 16 on loopback.
`RUNBOOK.md` is the procedure; `preflight-env.sh` (ExecStartPre) refuses a
process whose environment has a dev switch or proxy variable, a non-production
NODE_ENV, a missing required variable, an http origin, or a split worker
declaration. Pinned by `tests/deploy-wave1-preflight.test.ts`.

Established offline:
- `next build` compiles and type-checks offline; the ONLY network need is
  Google Fonts (`next/font/google`) at build time.
- Install must be `npm ci --include=dev`: worker, migrator and owner CLIs run
  through `tsx` (a devDependency).
- Hosted DB = a pg_dump copy of atlas_dev (owner-confirmed identities, routes,
  Pattern v5 and beta config are not reproducible from migrations + seed).

Each next step needs Founder approval: code transport to the server (push +
deploy key, or a git bundle — local HEAD is ahead of origin); provisioning;
the database copy; BotFather bot; the user-visible `rc1_*` smoke projects
(REQUIRED before inviting users, already on the BEFORE-BETA list); provider
connectivity checks; the beta grant; the first live beta Research.

STOP here until the Founder reviews.
