# Current task

> Overwrite this file each round. Never append.

## NONE — the D-128 resumed path now ends in a Proof

Offline implementation. No live call, no model call, no RPC, no network. No
change to S8, S9, D-127, D-128 or D-135. No Raydium networking retried.

## What changed

`extract-from-document.ts` stopped at S5. It now continues through the **same
production functions `run-job.ts` calls**, in the same order:

```
stored sealed document → replay → extraction → Evidence → S5
  → assembleAndPersistMechanism   (S6)
  → evaluateAndPersistClaimSupport (S7)
  → buildAndPersistProof           (S8)
```

No second Proof implementation exists; the script hand-rolls nothing and has
no `.insert(proofs)` anywhere. All three are pure projections over rows that
are already persisted, so the stage's network footprint is **unchanged from
when it stopped at S5**: zero fetch, zero render, zero search, zero RPC, and
zero model generation or `count_tokens` after extraction.

## One defect the tests caught, and the honest fix

S6 refuses to assemble without the job's frozen Boundary Contract
(`research_plans`) to cross-check the pattern version — and **Stage B never
created one**, because planning belongs to the worker. Wired naively, my first
version would have thrown `MissingActivePatternError` at S6 in a real run.

Fixed by calling the **real** `runMemoryPlanningStage` — the same function
`worker.ts` calls, in the same position (right after job creation). It is
DB-only (memory retrieval, active Pattern, deterministic planner), so it adds
no external call of any kind. Hand-writing a `research_plans` row instead
would have asserted a planning stage that never happened — exactly the lie
D-128 refuses elsewhere when it declines to invent jobs and sources.

## Where the resumed path deliberately DIVERGES from `run-job.ts`

`run-job.ts` runs S6/S7/S8 unconditionally. The resumed path runs them **only
when Evidence was actually persisted**.

The reason is the input, not caution: `run-job.ts` projects a whole work
queue, so an empty result there is still a statement about the research that
was attempted. Here the input is **one document for one component** — a Proof
built from a failed replay would be a conclusion about that failure, not about
the project. So extraction failure stops before S6 and writes no Proof at all.

## Consumption semantics — the boundary did NOT move

D-128 marks `consumed_at` / `consumed_by_job_id` on **successful Evidence
persistence**, and it still does: the mark sits exactly where it did, gated on
`rows.length > 0`, and the projections run **after** it.

Stated plainly, because it is now literally observable:

> **DOCUMENT CONSUMED ≠ PROOF NECESSARILY PERSISTED.**

A failure inside S6/S7/S8 leaves the Evidence and the consumption exactly as
D-128 specifies, and the projections can be re-run — they are idempotent.
A source-scan test pins the ordering so a later edit cannot quietly move it.

## Fail-closed, unchanged

- Extraction failure → no Evidence → **no S6, no S7, no S8, no Proof**.
- No S7 → S8 refuses `NO_CLAIM_SUPPORT`; no row, no partial write.
- S8 persistence is one transaction — no half-bound Proof.
- Re-running creates no duplicate (one Proof per job, DB-enforced).
- A `REVIEWED`/`VERIFIED` Proof is never overwritten (`PROOF_NOT_DRAFT`).
- Retry semantics, seal verification, both-ends authority revalidation and the
  documentary-only chain guarantee are all untouched.

## S9 compatibility

The resulting Proof is the ordinary canonical one — `PRIVATE`, `DRAFT`, D-135
band, the seven layers with layer 5 empty, citations bound via
`evidence.proof_id`. `services/proof-view.ts` projects it unchanged: **S9
cannot tell a resumed job from a normal one**, and no resumed-path DTO exists.

## What this unblocks — and what it does not

With MantaRay OFF for Stage A and ON for Stage B, the two-window path can now
produce a **real Proof from real Raydium evidence**, without touching the
blocked-address problem and without weakening any gate.

**It does not prove the product API path.** The entrypoint is owner tooling,
not `POST /api/research-jobs`. Those are different claims, and the record must
keep saying which one was made. The single-process product run remains blocked
by the network matrix (Anthropic needs ON, `docs.raydium.io` resolves into a
blocked range under ON — reproduced twice).

## Next — the owner's choice

1. **Run the two-window sequence** for the first real Proof: Stage A with
   MantaRay OFF (re-acquire the document — the previous one is consumed), then
   Stage B with MantaRay ON. Two authorized live windows, standing commands in
   the scripts' own usage lines.
2. **Fix the environment** so one state satisfies both, and get the first Proof
   through the real product API instead.
3. **Stop and consolidate.**

### Standing boundaries

- No live call without a separate authorized window; no retries.
- Never weaken SSRF, whitelist a reserved range, or special-case a domain.
- Never move the D-128 consumption boundary because a later stage was added.
- The resumed path may never invent planning, Evidence or a Proof it did not
  earn from persisted state.
