# Current task

> Overwrite this file each round. Never append.

## TELEGRAM FORWARD → RESEARCH INTAKE V1 — IMPLEMENTED OFFLINE, NOT COMMITTED

Founder-approved 2026-10-04 (D-168). LIVE CALLS MADE BY THIS TASK: 0.
Migration 0064 applied ONLY to the isolated test database by the suite.
Webhook not registered. Nothing pushed.

Done on this tree: webhook route + Telegram adapter, intake service, catalog
project detection, `research_intakes` schema/migration, owner read route,
launch handoff (button URL and signed `start_param`), Ask prefill, consume
after job creation (owner + OPEN + unexpired), env example and runbook §8/4a,
`tests/telegram-forward-intake-v1.test.ts`.

Next steps, each needing Founder approval:
- commit on `claude/phase-5-research-memory`;
- before `setWebhook`: verify against the current Bot API the shapes the
  tests pin (`forward_origin` types, `secret_token` header, `web_app`
  inline button with a query string, `start_param` inside signed initData);
- apply 0064 to atlas_dev / the hosted DB (D-167 items still pending too);
- set `TELEGRAM_WEBHOOK_SECRET`, restart web, register the webhook once
  from the Founder's machine (runbook §8 4a), then one forward from the
  second account as the first live check.

STOP here until the Founder reviews.
