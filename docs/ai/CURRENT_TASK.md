# Current task

> Overwrite this file each round. Never append.

## GOVERNANCE STATE EXTRACTION GUIDANCE V1 (done this round)

Offline round. No live call, no Research job, no DB change, no reducer
change, no schema redesign, no new subsystem, no project-specific rule.

GOVERNANCE LIFECYCLE SAFETY V1 (`a7ec578`) made S5 read `mechanism_state`
honestly, but the extractor was never told the dictionary: the wire field
was bare text and the prompt said nothing about lifecycle, so explicit
approvals normalised to UNKNOWN and GOVERNANCE_BASIS read
APPROVAL_NOT_ESTABLISHED even when the source said the vote passed.

- **Change (evidence-extractor-anthropic.ts).** `mechanismState` keeps
  `z.string().nullable()` but now carries `MECHANISM_STATES` (imported from
  domain/mechanism-state.ts) as its schema description; the system prompt
  gains a MECHANISM STATE section: the eight canonical states, the mapping
  per rung, the ladder rule (proposal ≠ approval ≠ implementation ≠ live),
  the non-inference rules (not from source kind, site, project, component,
  task, world knowledge; forum ≠ decision; docs ≠ operating; official ≠
  live), UNKNOWN when unsettled. `evidenceExtractorOutputFormat()` and
  `EVIDENCE_EXTRACTOR_SYSTEM_PROMPT` are exported for contract tests.
- **Why not `z.enum`.** This SDK build serialises zod enums as description
  hints, not grammar keywords (`directness` shows the same), so an enum would
  not constrain generation and would only reject a whole fact on parse. The
  tolerant wire + the existing exact-match normalizer preserves the fact and
  fails the state closed to UNKNOWN.
- **Unchanged.** component-reconciler semantics from a7ec578, approval
  thresholds, Proof/verdict, authority rules, Lido DB state (research.lido.fi
  OBSERVED, blog.lido.fi unclassified), providers' network behaviour.

Files: `src/server/engine/providers/evidence-extractor-anthropic.ts`,
`src/server/engine/providers/types.ts` (doc comment),
`tests/governance-state-extraction-guidance-v1.test.ts` (new),
`docs/ai/CURRENT_STATE.md`, `docs/ai/ARCHITECTURE.md`, this file.

### Reported, not done

- Whether the model follows the guidance is a live property; the offline
  tests pin the contract (what it is told, what the wire accepts, how the
  normalizer reads it), not model behaviour. The next authorised live run
  is the first observation.
- Fixture executors and other producers still write null / prose; the
  normalizer reads those as UNKNOWN, as before.

### Next

- Founder decides on a bounded Lido retest and on research.lido.fi /
  blog.lido.fi classification.
