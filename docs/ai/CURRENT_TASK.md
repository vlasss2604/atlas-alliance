# Current task

> Overwrite this file each round. Never append.

## BLOCKED — S8 needs one owner decision: the confidence contract

Offline implementation. No live call, no model call, no DB mutation, and no
existing verdict or row altered. **S8 is deliberately incomplete**, on your
instruction to stop at the confidence gap rather than invent a formula.

### What is done

`src/server/engine/proof-builder.ts` — the pure S8 builder. No IO, no model,
no clock, no randomness: same input, same draft. It produces the verdict, the
seven locked layers, resolved citations and the recorded gaps, and refuses
outright when S7 is absent.

Pinned by `tests/proof-builder.test.ts` (21 tests, offline).

### What is BLOCKED, and exactly why

`proofs.confidence` is `smallint NOT NULL` with `CHECK BETWEEN 0 AND 100`.
**No Proof can be persisted without a number**, so the store and the
`run-job.ts` wiring are not written. This is the whole of the blockage.

The register locks the *principle* but not the *value*:

- **D-081** — confidence is deterministic, a code function of component
  states, source classes and constraints; the model never names it. LOCKED.
- **D-110** — no numeric confidence in S7; the number the Proof schema
  requires is computed later in Proof Core as a deterministic pure function
  of `ClaimSupportResult` and the structured state above it. LOCKED.
- **phase-6-plan.md §11.4** — names the input families (component states,
  source classes, freshness, presence of constraints) and says only
  "формула фиксируется в коде".

So the inputs are named and the discipline is fixed; the mapping to 0..100 is
not. Choosing it is a product judgement about what a number shown to a user
means, not an implementation detail — which is why it stopped here.

**What a decision needs to answer** (each is a real fork, not a detail):

1. **Is it ordinal or cardinal?** A coarse band (e.g. a handful of discrete
   values) says "structurally stronger/weaker". A fine score reads as a
   probability, which ATLAS cannot compute and must not imply.
2. **Which recorded inputs, and in what precedence?** Available today:
   S7 claim status; requirement satisfaction counts; the authority ceiling
   actually hit (`INSUFFICIENT_AUTHORITY`, i.e. D-074's `CLAIMED` cap);
   component statuses; recorded gap count; excluded-evidence count;
   freshness (`requiresFreshEvidence` / temporal basis).
3. **Does an authority ceiling cap confidence?** A `CLAIMED`-only chain
   result cannot exceed `PARTIALLY_SUPPORTED` — should the number carry the
   same ceiling, or is it independent of verdict?
4. **What does `INSUFFICIENT_EVIDENCE` score?** Zero, or the confidence that
   the *insufficiency itself* is correctly established? These are opposite
   readings and the layers render differently.

I recommend **ordinal bands** with an authority ceiling, registered as a new
`D-###`. But it is your call, and the code will implement whatever you fix
exactly, with a test per band.

Meanwhile the draft is honest about the hole rather than hiding it: layer 1
reads `Confidence: not yet contracted (see D-081 / D-110); this draft carries
no number.`, and a test asserts no numeric confidence appears anywhere in the
draft.

### What the builder does, and what it refuses to do

**Verdict is copied from S7, never recomputed.** All four
`ClaimSupportStatus` values map to their namesakes. Pinned: ten satisfied
citations under an `INSUFFICIENT_EVIDENCE` claim still yield
`INSUFFICIENT_EVIDENCE` — there is no majority vote and no upgrade path.
**`NOT_APPLICABLE` is never emitted**: the schema enum has it, S7 cannot
produce it, so S8 inventing it would be a judgement no stage made.

**Citations resolve or vanish.** An id survives only if the requirement cites
it, the component treated it as *supporting*, and it exists as an Evidence row
for the job. So an excluded row can never be cited as support, evidence from a
component the claim never referenced never appears, and a dangling id is
structurally impossible. SOURCE ≠ EVIDENCE ≠ FACT ≠ PROOF CLAIM holds: no
source row and no on-chain artifact can become a citation.

**Layer 5 is empty (D-083)** and never padded. **Layer 6 — "what could change
this conclusion" — is assembled only from recorded state**: requirement
blocking gaps, claim context gaps, non-SUPPORTED component reason codes, and
excluded-evidence reasons. It is empty only when genuinely nothing is
unresolved; there is no filler path.

**No S7 ⇒ no Proof**, returning the closed refusal `NO_CLAIM_SUPPORT` — never
an empty or `UNKNOWN` placeholder.

**Insufficient evidence is a valid Proof.** The all-excluded case yields
`INSUFFICIENT_EVIDENCE`, cites **nothing**, and names both
`ALL_EVIDENCE_EXCLUDED` and `RELATIONSHIP_NOT_SUPPORTING` in layer 6. Absence
never becomes support.

### Still to build once confidence is fixed

1. `proof-store.ts` — persist exactly one Proof per job (the DB already
   enforces this with `uq_proofs_research_job`), `visibility PRIVATE`,
   `verificationStatus DRAFT`, and bind `evidence.proof_id` on cited rows in
   **one transaction** so a half-bound Proof cannot exist. Composite FK
   `evidence_proof_same_job_fk` already prevents binding across jobs.
2. Idempotency on re-run: the unique index makes a second insert fail rather
   than fork. Open sub-question for the same decision: may S8 *update* an
   existing Proof when S5/S6/S7 changed, and must it refuse to touch one
   whose `verificationStatus` is `REVIEWED`/`VERIFIED` (which memory
   promotion depends on, D-041/D-055)? My recommendation: never rewrite a
   non-DRAFT Proof.
3. Wire after S7 in `run-job.ts`, as the same kind of re-runnable derived
   projection S6 and S7 already are.

### Note on this round's prompt

Your instructions ended mid-STEP 11 (`S7 completed → build Proof →`). I
proceeded from the milestone plan in the previous round plus steps 1–10. If
the truncated text specified anything about the store, wiring or acceptance
that differs from the above, say so and I will follow it instead.

### Standing boundaries

- S8 never re-judges S5/S6/S7, never calls a model, never touches the network.
- Fail closed: no S7 ⇒ no Proof. `INSUFFICIENT_EVIDENCE` with named gaps is a
  valid, successful outcome.
- Private by default; no public Proof URLs in v1.
- Never invent a confidence formula the register says must be fixed
  deliberately.
