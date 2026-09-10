# Current task

> Overwrite this file each round. Never append.

## PRODUCT VERIFICATION TAB V1 (done this round)

Offline round. No live HTTP, no RPC, no model call, no Proof, no migration.
Product wiring only; Research truth, the selector and the Verification
composition are unchanged.

### What landed

`/research/[id]` — a finished result has RESEARCH | VERIFICATION in the
result header. Research is the default and untouched. Verification renders
the approved composition for the same loaded payload through
`JobVerification` (pure; no fetch, no recomputation). `?view=verification`
opens it; the switch mirrors state with the History API and never
navigates. FAILED / CANCELLED runs offer no switch. The historical-semantics
note is shown on every product Verification.

### Real completed job

- `http://localhost:3000/research/1302b67e-273d-4a38-b02c-78c9d8155a77`
  (Research) — switch in the header, or append `?view=verification`.

### Known, not this round

- First load in a fresh browser session can race the auth bootstrap (the
  page's first job read returns 401, then succeeds); pre-existing, seen
  while capturing screenshots.
- Dev overlay reports a hydration attribute mismatch on the dev showcase
  routes; pre-existing on the baseline.
