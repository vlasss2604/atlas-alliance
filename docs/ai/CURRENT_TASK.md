# Current task

> Overwrite this file each round. Never append.

## VERIFICATION EXPERIENCE V1 — first real product pass (done this round)

Offline round. No live HTTP, no RPC, no model call, no Proof, no migration.
Presentation only; the selector, reducer, evidence semantics and verdicts
are unchanged.

### What landed

The user-facing modes are RESEARCH and VERIFICATION. The old "Audit"
composition became the Verification page: VERIFICATION RESULT with coverage
counts → WHAT STOOD UP beside MAIN GAPS → CONTRADICTION (own panel only when
real, with the measured figure the reconciler tied to it) → HOW THE CLAIM
HOLDS UP (the selector's flow) → relevant signals → WHERE VERIFICATION STOPS
→ KEY EVIDENCE (each card names its check) → collapsed FULL VERIFICATION.
NONE is a valid decision for every optional block; the real sparse job shows
no chain, no signals, no contradiction panel.

### Dev surfaces

- `/dev/verification-showcase` — the golden verification
- `/dev/output-plan?view=verification` — `&fixture=A..E` and `&job=<uuid>`
  (`view=audit` still accepted)

### Next candidates (not started; need Founder scope)

- Wire Verification into the product `/research/[id]` surface as a mode
  beside the result (today it exists on dev routes only).
- Give the FULL VERIFICATION trail a real link to `/research/[id]/audit`
  when a job id is in scope.
