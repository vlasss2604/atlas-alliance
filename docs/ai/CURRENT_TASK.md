# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Two things happened this round, one of them much larger than the task.

### 1. The task: `OUTPUT_SCHEMA_INVALID` now names the field (done, offline)

`EXTRACTOR_SCHEMA_FIELDS` + `classifyExtractionSchemaFailure`
(evidence-extractor.ts): `ROOT`, `FACTS`, one code per fact field
(`FACTS_STEP`, `FACTS_DIRECTNESS`, `FACTS_ONCHAIN_LOCATORS`, …),
`UNKNOWN_SCHEMA_FIELD` for anything unrecognised. First issue in stable
schema order; array indices dropped; every mapping a closed-`Map` lookup, so
no path segment can pass through; admitted by a third gate requiring the
diagnostic to be `OUTPUT_SCHEMA_INVALID`. Operator line reads
`EXTRACT_FAILED:OUTPUT_SCHEMA_INVALID:FACTS_STEP`.

**Validation itself is untouched** — the schema, prompt, model, ceilings and
retries are all unchanged and asserted unchanged. Observability only.

### 2. Discovered while verifying: STAGE B SUCCEEDED — the chain gate is OPEN

**An owner run outside these rounds (job `baf42b79-…`, 2026-08-28T16:04Z,
nine minutes after the failing `eb00256a-…`) extracted successfully.** Read
from persisted state, not run here. The premise "document unconsumed and
resumable" in this round's brief is **no longer true**.

- **4 Evidence rows**, step 6 `DESTINATION`, all `OFFICIAL_DOCS` /
  `CONFIRMED`, `onchain_artifact_id` null: one **SUPPORTS** (bought-back RAY
  **held at** `DdHDoz94o2WJ…`) and three `CONTEXT` fee-collection addresses.
- **S5 = `SUPPORTED`**, empty reason codes — the first component ever to
  reach `SUPPORTED` for `raydium`.
- **Chain gate OPEN**: `findAdmittedLocator` = 1 (`OFFICIAL_DOCS` /
  `CONFIRMED`) and `resolveOnchainSubject` = `ELIGIBLE / DOCUMENTARY_LOCATOR`
  for all four addresses — verified offline against the real functions, no
  RPC.
- **Document CONSUMED** at 16:04:08Z by that job. Seal still verifies.
  Further resumes are refused, by design (D-128).
- D-127 held: **0 on-chain artifacts**. Real usage persisted for the first
  time: input 2,627, output 1,078, **8,017 micro-USD**.

**What is NOT established:** `entity_binding` is null on all four rows;
everything is model-extracted from one first-party document — claims about
what Raydium publishes, not observations of on-chain behaviour. No buyback,
fee flow or holding has been verified on-chain. **Supply effect is HELD,
never burned.** Full account in `CURRENT_STATE.md`, "THIRD Stage B window".

### Next — the owner's choice

1. **Read one admitted locator on-chain.** This is the thing PUMP never
   reached: a documentary locator that is admissible, in a project whose
   chain is supported. `DdHDoz94o2WJ…` (the holding address) is the
   highest-value first read. Requires an authorized live RPC window and a
   mode that is not `documentary-only`; scope it to one bounded typed intent.
2. **Extend documentary coverage first** — other Pattern steps against the
   same corpus, or `/ray/protocol-fees.md` / `/ray/treasury.md` (each needs
   its own owner route confirmation; one route per owner act).
3. **Stop and consolidate.**

Note before any re-run of Stage B: the document is consumed, so
`extract-from-document.ts` will now refuse it. A fresh acquisition would be a
new Stage A.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
- Never loosen `extractionResultSchema` to make model output easier to
  accept — a schema failure is a finding, not an obstacle.
