# Current task

> Overwrite this file each round. Never append.

## FOUNDER REVIEW OF ROUND 8, THE I3 FIX, AND ROUND 9 (done this round)

Offline, $0 spend (no Anthropic, Brave, RPC or live Research; migrations
0052–0054 still pending and NOT applied; Lido Memory untouched).

### Founder review of Round 8

**Round 8 is NOT CLEAN.** It discovered a semantic defect in its own
baseline — holder entitlement could be manufactured by pooling text from
separate rows, one naming holders and another carrying unrelated
entitlement language. A serious semantic defect found during an
adversarial round means that round cannot count as clean, even when the
defect was introduced earlier in the same turn and fixed before the
report. **Consecutive CLEAN count: 0.**

### The I3 fix — explicit negation is not the positive bridge

I3 was ruled a defect, not a boundary: the approved M3 rule is that
POSITIVE entitlement or receipt must be established, so a sentence denying
it must not satisfy the bridge. Implied by the approved rule; no new
Founder decision. Implemented row-locally, keeping the closed positive
dictionary, with two bounds:

- **CLAUSE** — the text is cut at sentence/clause terminators (not
  commas), and one clause must carry the WHOLE bridge: name holders itself
  AND state the entitlement. This also closes, inside one row, the same
  laundering case 7 closed across two rows.
- **WINDOW** — within that clause only the 6 tokens before the matched
  phrase are read for a negator, from a closed 11-word list. So a denial
  about something else, or in another sentence, never suppresses a real
  statement.

A denial is ABSENCE of the bridge, never a refutation of the recipient —
NOT_SUPPORTED stays unreachable this way, and H3 (the destination
dictionary's own negation limit) is untouched.

### Round 9 — THE OUTPUT BOUNDARY

A new angle: every previous round stopped at the Proof. Round 9 attacks
the last hop — from the persisted record to the sentence a reader actually
reads. Can a reader be shown more than the record proves?

**Result: NOT CLEAN. One CRITICAL-class defect, found and fixed.**

`relationship` is what the EXTRACTOR said a row was for; S5 decides
admissibility and records refusals in `excludedEvidence`, which never
rewrites the row. `output-plan.ts` admitted on the label alone, so an
S5-EXCLUDED on-chain TOKEN_SUPPLY reading rendered as a METRIC tile marked
`state: "ESTABLISHED"` — byte-identical to the admitted twin — and
excluded rows could appear in the evidence snapshot. Fixed by positive,
component-scoped admission (`admittedFor`), using sets already in the
payload: no new field, no API change. Four of the five F regression cases
fail without the fix.

**MINOR, open:** I4 (no tense grammar in the entitlement dictionary — ATLAS
bounds tense through `mechanism_state` instead), A2 (the projection label
guard is a closed status-word list, so a label may still assert magnitude
or certainty; deliberate by design, now measured), A3 (the label rule is
enforced on write, not on read).

**Tests.** `tests/adversarial-core-round9-output-boundary-v1.test.ts` (25).

### Next

- **Round 10** — a new independent adversarial round. Round 9 was NOT
  CLEAN, so the counter is still 0 and TWO consecutive clean rounds remain
  required.
- Founder decisions open: I4, A2, A3.
- Not yet: speed optimization, migrations 0052–0054, any live Research.
