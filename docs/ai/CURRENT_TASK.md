# Current task

> Overwrite this file each round. Never append.

## GOVERNANCE LIFECYCLE SAFETY V1 (done this round)

Offline round. No live call, no Research job, no DB authority change, no
schema, no new subsystem, no new source class. Founder decision: generic fix
for PROPOSED != APPROVED; do not special-case any project or host.

The Lido authority review showed that a GOVERNANCE row of any
`mechanism_state` fully established GOVERNANCE_BASIS, MECHANISM_SPEC,
RECIPIENT and DURABILITY_BASIS — an official forum RFC would have read as an
approved governance basis.

- **Rule (component-reconciler.ts, subtractive).** `PROPOSED_STATE_ONLY`
  caps every component that does not itself evaluate state when an
  establishing row positively declares PROPOSED and nothing establishing is
  past it; `APPROVAL_NOT_ESTABLISHED` caps GOVERNANCE_BASIS unless an
  establishing row carries APPROVED / IMPLEMENTING / LIVE (UNKNOWN and
  terminal states fail closed). Rows stay in `supportingEvidenceIds`.
- **Not changed.** EXECUTION_EVIDENCE / CURRENT_STATE / NET_EFFECT gates;
  lifecycle computation; authority axis; SOURCE_ROUTE bootstrap and owner
  workflow; Lido DB state (`research.lido.fi` still OBSERVED); providers.
- **Consumers wired.** mechanism-assembler (node qualifications),
  proof-confidence (LIMITED caps), research-model / audit-composition
  (reader copy), ui-v2 vocabulary test.

Files: `src/server/engine/component-reconciler.ts`,
`src/server/engine/mechanism-assembler.ts`,
`src/server/engine/proof-confidence.ts`, `src/client/research-model.ts`,
`src/client/components/result-blocks/audit-composition.tsx`,
`tests/governance-lifecycle-safety-v1.test.ts` (new),
`tests/ui-v2-answer-first.test.ts`, `docs/ai/CORE_RULES.md`,
`docs/ai/ARCHITECTURE.md`, `docs/ai/CURRENT_STATE.md`, this file.

### Reported, not done

- The extractor is given no `mechanism_state` vocabulary, so live rows
  normalise to UNKNOWN; GOVERNANCE_BASIS will read APPROVAL_NOT_ESTABLISHED
  until the state channel is guided (prompt change — separate decision).
- PAUSED / DEPRECATED / REMOVED do not count as approval-bearing for
  GOVERNANCE_BASIS (conservative false negative for historical mechanisms).
- MECHANISM_SPEC with a PROPOSED row is PARTIALLY_SUPPORTED with the
  qualification rather than SUPPORTED — the design is preserved and cited,
  the node carries "proposed · not adopted".

### Next

- Founder decides on `research.lido.fi` GOVERNANCE classification now that
  a forum RFC cannot establish authorisation, and on `blog.lido.fi`.
