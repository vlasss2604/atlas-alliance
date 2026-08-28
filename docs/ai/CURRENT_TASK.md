# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner approval of the next major milestone

Planning round. Offline, no code changed, no live call. The Raydium case
stays at its resting point and is used below only as a persisted fixture.

## The bottleneck: the pipeline ends one stage before the product

Verified against current code, not notes: the engine runs
**S4 → S5 → S6 → S7** and stops. `run-job.ts` ends with
`assembleAndPersistMechanism` then `evaluateAndPersistClaimSupport`, and
returns.

**Nothing in production ever writes a Proof.** The `proofs` table exists with
its locked shape (`verdict`, `confidence`, 7-layer `layers` jsonb,
`researchCutoff`, `visibility PRIVATE`, `verificationStatus`), and
`memory/verification.ts` reads it — but the only `insert(proofs)` calls in the
repository are in tests. `evidence.proof_id` is null on every row ever
written; the `PROOF_BOUND` half of the ownership model has never occurred.

Three consequences, all product-blocking:

1. **There is no Proof.** `GET /api/research-jobs/[id]` returns raw engine
   projections — claim-support rows, component results, evidence arrays.
   Internal research complexity leaks straight to the surface, which the
   product rules forbid ("user-facing answers start simple").
2. **The learning loop cannot close.** Memory promotion is gated on a
   **VERIFIED Proof** (D-041/D-055). With no Proof writer there is nothing to
   verify, so no research outcome can ever become durable memory —
   `ARI_LEARNING_LOOP` is structurally blocked, not merely unimplemented.
3. **Nothing is citable.** A Proof is the only object that binds a verdict to
   the evidence and gaps behind it. Without it, every downstream feature
   (Proof Map, sharing, history) has no object to render.

## Selected milestone: **S8 — the Proof Writer**

One job's reconciled state becomes **one persisted, structured Proof**.

Deliberately chosen over the alternatives: it *completes* an existing pipeline
rather than adding another adapter, it unblocks the learning loop, and it is
the last stage between validated subsystems and a coherent Proof Engine.

### Product outcome

A finished research job produces a Proof row carrying a verdict, a confidence,
the seven locked layers, and traceable references to the Evidence, component
results and gaps it rests on — private by default, with `evidence.proof_id`
bound for the rows it cites.

### Domain contract

- **Input:** `researchJobId`. Everything else is read from persisted state —
  S7 claim support (status, reasonCodes, requirementResults with their
  evidenceIds/componentResultKeys/blockingGaps), S6 assembly, S5 component
  results, and the Evidence they cite.
- **Output:** one `proofs` row + `evidence.proof_id` bound on cited rows.
- **Verdict:** derived deterministically from S7's `ClaimSupportStatus`, which
  already shares the vocabulary (`SUPPORTED` / `PARTIALLY_SUPPORTED` /
  `NOT_SUPPORTED` / `INSUFFICIENT_EVIDENCE`), plus `NOT_APPLICABLE` for a job
  with no applicable claim. **The verdict is never re-judged and never
  model-authored** — S7 already decided it.
- **Confidence:** a documented deterministic function of what S7 and S5
  recorded (requirement satisfaction, authority ceiling, gaps). Not a model
  score, not a vibe.
- **Layers:** the seven locked layers, with **"Что может изменить вывод"
  mandatory** — populated from real `blockingGaps` / `contextGaps` /
  exclusion reasons, never invented, and never padded to fill a block.

### Invariants to preserve

- **Fail closed:** a job with no S7 projection produces **no Proof**, not an
  empty one. `INSUFFICIENT_EVIDENCE` with named gaps is a valid, successful
  Proof.
- **D-074 and every reconciliation verdict stand.** S8 projects; it never
  re-decides, upgrades or downgrades what S5/S6/S7 concluded.
- **No new research, no model call, no network.** S8 is a pure projection
  over persisted state, exactly like S6 and S7 — re-runnable, deterministic,
  spending nothing.
- **Private by default** (`visibility PRIVATE`, no public URLs in v1);
  entitlement is enforced server-side and an entitlement change must never
  destroy an existing Proof.
- **Idempotent per job**, and re-running must not fork a second conflicting
  Proof for the same job.
- Every citation must resolve to a row that actually exists; a claim with no
  evidence renders empty rather than borrowing another component's rows.

### Reused vs new

**Reused unchanged:** `claim-support-store`, `mechanism-assembly-store`,
`component-reconciliation-store`, the `proofs`/`evidence` schema, `run-job.ts`
as the call site (one more projection step after S7), `memory/verification.ts`
downstream.
**New:** a proof builder (pure, deterministic, testable without a DB) and a
proof store (persist + bind `evidence.proof_id`), mirroring the
`*-store.ts` / pure-module split S5/S6/S7 already use.

### Test plan (offline, existing fixtures)

Unit: verdict mapping for every S7 status; confidence determinism; the
mandatory-gap layer populated only from real gaps; no-S7 → no Proof.
Integration: the **existing Raydium jobs** as fixtures — the documentary
`SUPPORTED` job, the `PARTIALLY_SUPPORTED` chain job, and the
`ALL_EVIDENCE_EXCLUDED` job — each producing the honest Proof its state
implies, **without re-running research or altering a single existing row**.
Boundary: no model, no network, no re-judging, idempotency, private-by-default.

### Acceptance criteria

A completed job yields exactly one Proof whose verdict equals S7's status,
whose layers are all present with the change-conditions block non-empty
whenever gaps exist, whose citations resolve, whose cited Evidence rows carry
`proof_id`, and which re-runs identically. Every pre-existing verdict, S5
result and Evidence row is unchanged. Full suite green.

### What a user can do afterward that they cannot today

Ask a question, and when the job finishes receive **one persisted structured
Proof** — verdict, confidence, plain-language explanation, what would change
the conclusion, and the evidence and gaps behind it — instead of raw engine
projections. And for the first time a research outcome becomes **verifiable**,
which is the gate durable Research Memory has always been waiting on.

### Deliberately deferred (backlog, not blockers)

Raydium transaction history · stable owner-user identity · the Windows
`C:\C:\` test bug · diagnostics · more owner CLIs · another project case ·
Telegram/UI polish · Proof Map rendering · sharing · Promises/Risks (D-124) ·
EVM support.

### Recommended next coding task

Implement S8 in one slice: the pure proof builder + its store + wiring after
S7 in `run-job.ts`, validated against the existing Raydium and PUMP fixtures
offline. **Not started — awaiting your approval**, since this is the largest
single block since the acquisition path.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- S8 must never re-judge S5/S6/S7, never call a model, never touch the network.
- documentary role ≠ chain behaviour · holding ≠ mechanism · balance ≠
  history · buyback ≠ burn · same transaction ≠ causality.
- Never relax safe-http or SSRF; never loosen `extractionResultSchema`.
