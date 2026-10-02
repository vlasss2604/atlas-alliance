# Current task

> Overwrite this file each round. Never append.

## PRIVATE-BETA ADMISSION (D-167) — IMPLEMENTED OFFLINE

Founder-approved 2026-10-02. LIVE CALLS MADE BY THIS TASK: 0. Not pushed.

An approved beta USER runs the same real, budget-bounded Research as owner
alpha, without ADMIN; the public PRODUCT path stays closed.

- **Grant**: a `subscriptions` row (ARI_CORE, explicit expiry, no
  auto-renew, `PRIVATE_BETA_GRANT`). No new role, table or auth system.
- **Admission**: `services/start-private-beta-research.ts`; refusals
  BETA_ACCESS_REQUIRED / BETA_PROJECT_NOT_AVAILABLE /
  BETA_RESEARCH_LIMIT_REACHED create no job. Origin `PRIVATE_BETA`
  (migration 0063), budget `INTERNAL_ALPHA_V1`.
- **Execution**: `jobs/private-beta-routing.ts`, the real executor at every
  phase; the grant is checked at admission only; `private_beta_enabled` is
  the emergency switch.
- **Preview / Interpreter / roster** use the same admission function.

NOT done, each needs Founder approval (writes to atlas_dev):
1. `npm run db:migrate` (0063 only; export DATABASE_URL from .env.local).
2. `npm run admin:private-beta -- config --enabled=true
   --projects=raydium,pump_fun,lido --limit=5 --apply`.
3. The user signs in once; then `npm run admin:private-beta -- grant
   --telegram-id=<id> --until=YYYY-MM-DD --apply`.
4. A hosted environment (app + two workers + provider reach) — not designed.

Known and left as is: with the beta switch OFF the Interpreter is open to
any signed-in user as before (stop it with `interpreter_enabled`); a failed
or cancelled beta Research still counts toward the cap of 5.

Still waiting on the Founder: hosted-environment task; BEFORE-BETA items
from the readiness audit (Solana DESTINATION dead end, first-answer wording,
smoke-test projects in the catalog); D-165 positive live validation.

STOP here until the Founder reviews. No push, no live call.
