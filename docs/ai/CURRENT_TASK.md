# Current task

> Overwrite this file each round. Never append.

## D-176 ANCHOR SCOPE FIX (D-178) + SOURCE AUTHORITY P0 (D-177) — OFFLINE-VERIFIED, AWAITING FOUNDER REVIEW

Branch `claude/phase-5-research-memory`, on top of `d24786e` (D-176).
LIVE CALLS MADE BY THIS TASK: 0. No new Research, no push, no commit.

On this tree (uncommitted), see D-177 / D-178 and CURRENT_STATE:

- D-178: the D-176 mechanism anchor applies only to a claim whose REQUIRED
  atoms assert a mechanism (FLOW_RELATIONSHIP / NET_EFFECT_ESTABLISHED).
  Fixes the 8 regressions introduced by `d24786e`.
- `source-open-efficiency-d1-d3` D3: its stale "no decrement" assertion
  now pins the D-173 settlement as the one decrement (test only).
- D-177: owner route-candidate review, reject, combined confirm + classify
  (preview, explicit host / prefix / class, `--confirm=yes`), coverage
  reason `AUTHORITY_PENDING_OWNER_REVIEW`, and the hard refusal of
  GOVERNANCE / OFFICIAL_DOCS / OFFICIAL_REPORT on a community host's whole
  host or all-content roots (`/t`, `/c`, `/p`, `/u`, …).

Open P1 design problem (not solved, authority not weakened): Discourse
governance topics live under `/t/<slug>/<id>`, so a category prefix
(`/c/governance`) never matches topic pages; today the owner can only
classify one topic at a time.

Jito data action (owner, not done by this task): `review-route-candidates
--project=jito`, then `decide-source-route` for reviewed narrow prefixes.

Next steps, each needing Founder approval:
- commit structure for D-178 and D-177 (no push);
- P1: Discourse category scoping, link provenance, signal-aware fetch
  ordering, route freshness;
- then one controlled live Quality Benchmark on the Jito question.

STOP here until the Founder reviews.
