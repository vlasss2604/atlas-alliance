# Current task

> Overwrite this file each round. Never append.

## ROUND 7.5 — FOUNDER SEMANTICS M3 + C4, AND ROUND 8 (done this round)

Offline, $0 spend (no Anthropic, Brave, RPC or live Research; migrations
0052–0054 still pending and NOT applied; Lido Memory untouched).

### Round 7.5 — the two approved decisions

One shape, two places: **a component can be ESTABLISHED while the economic
ROLE it must play is unknown**, and a requirement whose meaning depends on
that role may not be satisfied from the role-less fact.

**M3 — recipient identity is not entitlement.** "Holders receive something"
is not "passive holding entitles holders to receive it". S6 gains
`classifyHolderEntitlement`, a closed positive dictionary for the
holding → entitlement/receipt bridge, in the same D-100 discipline as every
other classifier. It is asked of each admitted RECIPIENT row SEPARATELY and
only of rows that name holders on their own, so two individually true
sentences about different actors cannot compose into an entitlement neither
states. `recipientKind = PASSIVE_HOLDER` with no match leaves a positioned
`RECIPIENT_UNRESOLVED` gap on the ESTABLISHED recipient.

**C4 — an address is not an economic role. WHERE ≠ WHO.** S6 already
recorded `DESTINATION_UNRESOLVED` on an established destination whose kind
the closed dictionary cannot classify; nothing read it.

S7 now reads both. A role-unresolved gap on a relationship endpoint caps
`FLOW_RELATIONSHIP` at PARTIAL (PRT-2 / RS-2 / UTL-2 / VC-2); on an
attribute's own role component it caps `FLOW_ATTRIBUTE` at PARTIAL (PHO-1,
TU-2). Both name `REQUIRED_RELATIONSHIP_UNRESOLVED` and carry the gap as a
blocking gap, so the limitation reaches the Proof and the band. SUPPORTED
becomes unreachable in both worlds; the component stays established and its
rows stay cited.

PARTIAL and **not** UNSATISFIED deliberately — see
`RESEARCH_CORE_HARDENING_V1.md` (C4 row) for why.

Deliberate consequence: any gap makes a flow `PARTIAL_PATH`, so a holder
flow with no stated entitlement now reads PARTIAL_PATH. Symmetric with the
pre-existing destination behaviour; pinned as S6 scenario A2. Half of MINOR
M2 is closed by C4.

**Tests.** `tests/founder-semantics-round7-5-v1.test.ts` (14).

### Round 8 — ROLE MANUFACTURE AND ATTRIBUTION LAUNDERING

A new angle, not a replay of Round 7. For each distinction ATLAS claims to
make, can the STRONGER side be MANUFACTURED out of parts that individually
do not carry it? position → role, receipt → entitlement, address →
destination role, documented → executing, approved → live, supply level →
attributed delta, two sentences → one relation, technical failure → project
reality, absence → denial.

**Result: CLEAN.** Zero CRITICAL, zero MAJOR. 486 combinatorial worlds × 8
intents plus the targeted families violate no law; a bound chain balance
never becomes a role, entitlement never crosses actors or components, a
proposal never becomes a live outcome, foreign and inadmissible rows reach
nothing, 24 permutations per world are byte-identical, mirrors multiply
structure and not truth, and the existential rule never lets a role-less
flow satisfy a role-dependent atom. The persisted half proves a role is not
inheritable through Research Memory: A bounded → VERIFIED → ACTIVE → B
adopts the same observations and is bounded for the same reason, with A's
deliberately corrupted verdict, confidence and S5 status nowhere in B.

**One MINOR (I3), inherited:** the entitlement dictionary has no negation or
tense grammar, exactly like every other closed S6 classifier — a sentence
that DENIES holder entitlement satisfies the bridge. Not a regression (each
of those worlds answered SUPPORTED before the gate existed), and the remedy
is the already-documented H3 decision.

**Tests.** `tests/adversarial-core-round8-role-attribution-v1.test.ts` (22)
and `tests/adversarial-core-round8-role-memory-db-v1.test.ts` (3).

**Consecutive CLEAN count: 2.** Round 7 = CLEAN #1, Round 8 = CLEAN #2.
**SEMANTIC CORE HARDENING COMPLETE.** Do not start Round 9.

### Next

- Founder review, then SPEED + COST OPTIMIZATION.
- Later: pending migrations 0052–0054, live Solana Research, live
  Ethereum/EVM Research. No live spend before Founder approval.
