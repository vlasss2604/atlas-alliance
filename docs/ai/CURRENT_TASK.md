# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The artifact → Evidence question is answered. Nothing is pending, and no code was
changed.

### What was settled

- The persisted burn artifact was verified against the local database and its
  exact payload is now a fixture in
  `tests/onchain-persisted-burn-evidence.test.ts`.
- Run through the real synthesizer and the real reconciler offline, it establishes
  `EXECUTION_EVIDENCE` at **`PARTIALLY_SUPPORTED` / `INSUFFICIENT_AUTHORITY`** —
  the ceiling for all on-chain evidence under D-074, not a defect.
- There is **no route** from a standalone artifact to Evidence. It is deliberate
  and regression-tested; the supported route is a live retrieval inside a research
  job.

Details in `PUMP_CASE.md` ("What the burn would establish if it reached Evidence",
"Why it is not Evidence today") and `ARCHITECTURE.md`.

### The open decision, for the owner

Reusing a persisted artifact rather than re-fetching it is a real design question
and was **not** implemented. The report accompanying this round sets out the
smallest generic design, the files it would touch and its provenance cost. It
needs an owner decision before any code is written.

### Standing boundaries

- No live calls without separate authorization.
- No paging, no arbitrary transactions, no counterparty-chasing.
- Do not connect the burn to the later acquisition; they are different cycles.
- Do not hardcode any address.
