# Current task

> Overwrite this file each round. Never append.

## FOUNDER DECISION Q1, AND ROUND 11 (done this round)

Offline, $0 spend (no Anthropic, Brave, RPC or live Research; migrations
0052–0054 still pending and NOT applied; Lido Memory untouched).

### Q1 — what spends a DEMO lifetime slot

  PROJECT REALITY / RESEARCH VERDICT consumes quota.
  TECHNICAL FAILURE does not.

`demoTerminalOutcome` returns CONSUMED when the terminal state carries a
result (SUCCEEDED or BUDGET_LIMIT_REACHED) AND a durable Proof exists;
everything else releases. The verdict is not consulted —
INSUFFICIENT_EVIDENCE and NOT_SUPPORTED are legitimate outcomes and the
work was done. `resolveDemoReservation` now matches only a reservation
still in RESERVED, so the first terminal handling decides and every
replay, retry, duplicate event and concurrent completion is a no-op
instead of the DB trigger raising on CONSUMED -> RELEASED.

Boundary pinned: a DOCUMENT-LOCAL provider failure is not a technical
failure of the Research — the run still finalises with a bounded Proof, so
it DOES spend the slot.

### Round 11 — MEMORY UNDER CORRUPTED AND STALE PERSISTED STATE

Round 6 attacked the gate fields adoption re-checks; Round 8 proved a role
is not inheritable; Round 11 attacks the CONTENT of the stored row,
corrupted after verification and promotion, against two controls each
time (clean memory, and no memory).

**Result: NOT CLEAN. One CRITICAL, found and fixed.**

`memory-evidence-adoption.ts` took the adopted Evidence row's `summary`
and `mechanismState` from the mutable memory row. Both are engine inputs —
S6 classifies over `fragment + " " + summary`. One UPDATE of
`research_memory.statement`, with no new document and no acquisition,
turned a bounded PARTIALLY_SUPPORTED into SUPPORTED. Fixed by taking both
from the ORIGIN observation, as every other axis on that insert already
did. The regression fails without the fix.

Everything else held: mechanism-state injection, freshness laundering,
confidence inflation, provenance fragment rewritten, provenance url
repointed at an unrouted host, and a corrupted row in one project never
reaching another.

**Consecutive CLEAN count: 0.**

### Next

- **Round 12** — a new independent adversarial round. Two consecutive
  clean rounds are still required.
- Not yet: speed optimization, migrations 0052–0054, any live Research.
