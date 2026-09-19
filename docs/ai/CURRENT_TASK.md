# Current task

> Overwrite this file each round. Never append.

## THE THREE APPROVED FIXES, AND ROUND 10 (done this round)

Offline, $0 spend (no Anthropic, Brave, RPC or live Research; migrations
0052–0054 still pending and NOT applied; Lido Memory untouched).

### I4 — uncertain, proposed or conditional is not positive

A closed list of possibility, conditionality and intention markers, read
inside the matched phrase's own clause within a bounded window, and judged
PER CLAUSE: a clause with any defeated occurrence establishes nothing
(several dictionary phrases can match one clause, and the marker that
defeats one sits outside another's window).

Not a tense parser. `will` and `can` are deliberately absent — a scheduled
mechanism's actuality is `mechanism_state`'s decision. Conservative where
it cannot tell: a clause carrying explicit proposal language is refused
even where a reader could see the proposal had passed, because governance
approval is represented structurally and nothing real rests on prose.

### A2 + A3 — one label guard, every path

`src/shared/projection-label-safety.ts` is the single rule, called on the
WRITE path (reject), the API READ path (neutralise) and the RENDERER
(neutralise). Storage is never trusted, so a legacy or corrupted row is
neutralised on the way out.

Five closed axes, each named after what it refuses: STATUS, CERTAINTY,
MAGNITUDE (any stated number; a digit inside a word such as `ERC-20` is a
name and passes), DIRECTION, and the per-component ECONOMIC ENVELOPE that
already existed. A refusal degrades to the component's canonical copy.
The lists are closed, as every ATLAS dictionary is, and that limit is
stated rather than hidden.

### Round 10 — AUTHORIZATION, TENANCY AND ENTITLEMENT UNDER COMPOSITION

A different boundary: whose record is it, and when was the right to it
decided? Tenancy at every loader, Proof-owner drift, the DEMO quota
ledger, idempotency as a per-account name, entitlement frozen at start,
and whole-table ownership invariants.

**Result: NOT CLEAN. One MAJOR-class finding, NOT fixed — it needs a
Founder decision.**

**Q1 — the DEMO lifetime proof quota never decrements.** Admission counts
`RESERVED + CONSUMED`, but no code path anywhere passes `CONSUMED`: all
seven `resolveDemoReservation` call sites pass `RELEASED`, including the
ordinary SUCCESS path. A DEMO account that runs a job to SUCCEEDED and
receives a Proof gets its slot back, so the lifetime limit bounds only
concurrency — which the one-active-job rule already bounds. Which terminal
outcomes should consume a lifetime proof is a product policy question
ATLAS's semantics do not settle, so no fix was chosen and the observed
behaviour is pinned.

Everything else in Round 10 held: no cross-account read at any door, no
cross-job evidence through a job you own, no Proof-owner drift anywhere in
the table, idempotency is per account, entitlement is frozen at start and
a downgrade never destroys a finished Proof.

**Consecutive CLEAN count: 0.**

### Next

- **Founder decision on Q1**, then a fix and a regression test.
- **Round 11** — a new independent adversarial round. Two consecutive
  clean rounds are still required.
- Not yet: speed optimization, migrations 0052–0054, any live Research.
