# Current task

> Overwrite this file each round. Never append.

## RESEARCH QUALITY V1 — GLOBAL P0/P1 PASS, OFFLINE-VERIFIED, AWAITING FOUNDER REVIEW

Branch `claude/phase-5-research-memory`, on top of `77368b8` (speed/budget
pass, Benchmark #2). LIVE CALLS MADE BY THIS TASK: 0. No new Research, no
push, no commit. Read-only replays of the two Jito jobs against `atlas_dev`.

Implemented on this tree (uncommitted), see D-176 and CURRENT_STATE:

- P0 verdict anchor: a claim is SUPPORTED / PARTIALLY_SUPPORTED only with
  the asserted mechanism established (documented, approved or executed) on
  the matched flow; else INSUFFICIENT_EVIDENCE +
  `ASSERTED_MECHANISM_NOT_ESTABLISHED`.
- P0 research coverage model and quality gate (`research-coverage.ts`),
  derived, not persisted; alpha-inspect section.
- P1 authority candidates for the owner (confirmed-domain path outside the
  classified prefix; project-owned subdomain provenance).
- P1 critical-source fairness and a stable, authority-aware fetch tail.

Root cause of the Jito verdict flip, measured: the interpreter classified
the same question as MECHANISM_CURRENT_STATE (B1) and
PROTOCOL_REVENUE_TO_TOKEN (B2); under PRT the fee-routing facts satisfied
PRT-1/PRT-2 partially with no mechanism. Both runs now re-evaluate to
INSUFFICIENT_EVIDENCE; the intent instability itself is model-side and
untouched (no prompt change in this pass).

Needs a Founder decision (not implemented): automatic authority for a
confirmed domain's unclassified pages or for project-owned subdomains
(e.g. forum.<domain> as GOVERNANCE) — STRATEGY REVIEW REQUIRED against
D-074 / D-089 / CORE_RULES. The immediate data action for Jito is the
owner confirming `forum.jito.network` as GOVERNANCE and `jito.network`
`/jto` as a classified route through the existing tools.

Next steps, each needing Founder approval:
- review and commit this pass (no push);
- decide the authority question above;
- then one controlled live Quality Benchmark on the Jito question.

STOP here until the Founder reviews.
