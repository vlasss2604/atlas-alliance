# Current task

> Overwrite this file each round. Never append.

## POST-RAYDIUM ACQUISITION CLEANUP V1 (done this round)

Offline round. No live call, no provider/model call, no new Research job, no
budget increase, no schema, no new subsystem. Three areas only, from the
fresh post-fix Raydium run `8eb1e920-f216-417c-a04c-f2027bc4ef3e` (which
proved D1/D2/D3 work live).

- **A — explorer HTTP documentary opens.** A url the code-owned classifier
  recognizes as an on-chain explorer is not bought as an ordinary
  documentary HTTP source when the dedicated deterministic adapter owns
  that component's chain facts (`componentAdmitsOnchainAcquisition`, the
  reserve's own gate) AND could act in this process. Not a blacklist:
  provenance, targeting, locators, the deterministic path and every
  non-documentary role are untouched, and a human-approved
  `SOURCE_RESOURCE` for the component is always opened. The live run's
  5 explorer-shell opens are the reported class this removes; that
  reduction is NOT verified here — no live trace was replayed this round.
  What is proved offline is the routing: the explorer candidate is skipped
  in the intended situation and opened in every other one.
- **B — D3 observability.** `EXTRACT_FAILED` now persists the extractor's
  own classified failure in the existing `diagnostic_code` column, so it
  survives the budget-exhausted flow that discards the attempt's
  observation string. No retry, no extra model call, no outcome change.
- **C — `--owner`.** `scripts/alpha-run.ts` accepts an optional
  `--owner=<existing-user-id>`, validated (shape, then existence) before
  anything can be spent. Omitted, behaviour is unchanged.

Job `8eb1e920-…` was NOT mutated. `maxSourceOpens`, search budgets,
evidence/admission/verdict semantics, Research | Verification composition,
D-149, SSRF and IP pinning are all untouched.

### Reported, not done

- `MODEL_CALL_ATTEMPTED` accounting on the failing-extraction path is a
  separate defect; cost accounting was deliberately not redesigned here.
- The phased FETCH phase still opens explorer candidates: it is
  component-agnostic and may run in a process without the retriever, so
  the distinction cannot be made there safely. The live run used the
  single-process executor.
- Still open and deliberately out of scope: cross-job dead-url memory, a
  second budget counter, refunds, repeated `WRONG_PROJECT` extraction.

### Next

- Founder decides whether to spend one bounded validation run.
