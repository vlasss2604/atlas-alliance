# Current task

> Overwrite this file each round. Never append.

## NONE — S8 is complete

Offline implementation. No live call, no model call, and no existing verdict,
Evidence row, component result or claim-support row altered.

**The pipeline now ends in a Proof.** `run-job.ts` runs S4 → S5 → S6 → S7 →
**S8**, and a finished job persists one Proof with `evidence.proof_id` bound on
the rows it cites — which makes D-088's `PROOF_BOUND` ownership branch
reachable for the first time in the project's history.

### D-135 ratified and implemented

Recorded in `docs/DECISIONS.md` as LOCKED. Confidence is a **closed ordinal
band** — `LOW 20 / LIMITED 40 / STRONG 60 / VERY_STRONG 80` — expressing
structural confidence in the verdict, never a probability, never a percentage.
`proof-confidence.ts` computes it: the verdict sets a ceiling, each recorded
signal imposes a cap, and the result is the **minimum**. No arithmetic, no
weighting, no citation counting, no source popularity, no model judgement.

`0` and `100` are unreachable by construction and asserted so across every
input combination. The cap table is `Record<ResultReasonCode, …>`, so adding a
reason code without deciding its cap is a **compile error**, and an
unrecognised code reaching runtime **fails closed to LOW** rather than
inflating. Deliberately non-monotonic in verdict positivity — a reasoned
`INSUFFICIENT_EVIDENCE` (60) outranks a blocked `PARTIALLY_SUPPORTED` (40) —
because otherwise the field would merely re-encode the verdict.

All five ratified acceptance cases pass: clean documentary **80**,
authority-limited chain **60**, all-excluded-with-blocking-gap **40**,
bare-absence **20**, strong contradiction **80**.

### What S8 refuses to do

Verdict is **copied** from S7 and never recomputed — ten satisfied citations
under an `INSUFFICIENT_EVIDENCE` claim still yield `INSUFFICIENT_EVIDENCE`.
`NOT_APPLICABLE` is excluded at the *type* level, so the compiler guarantees
S8 cannot invent a verdict S7 never made. Confidence never overrides S7:
the weakest confidence leaves a `SUPPORTED` verdict `SUPPORTED`.

Citations resolve or vanish — an id is bound only if the requirement names it,
the component treated it as *supporting*, and it exists as an Evidence row for
the job. Excluded rows are never bound merely for belonging to the job.

Fail closed three ways: **no S7 → `NO_CLAIM_SUPPORT`, no Proof** (never an
empty or `UNKNOWN` placeholder); no project → `NO_PROJECT` (`proofs.project_id`
is NOT NULL while the job's is nullable); already `REVIEWED`/`VERIFIED` →
`PROOF_NOT_DRAFT`, never silently rewritten, because that status gates memory
promotion (D-041/D-055). Only a `DRAFT` is replaced, which makes a re-run
stable rather than duplicating.

D-083 is untouched: seven layers, **layer 5 empty**, layer 6 assembled only
from recorded gaps and exclusion reasons. `research_cutoff` stays NULL —
its semantics are not locked, and I did not invent a second one.

### What this unblocks

Research Memory promotion is gated on a **VERIFIED Proof**. Until now nothing
produced a Proof to verify, so the learning loop was structurally blocked
rather than merely unbuilt. There is now an object for a human to review.

### Honest limits — what is NOT done

1. **No production job has run S8 end to end.** The pipeline stays behind
   `research_enabled=false`; every test drives the store directly or through
   fixtures. The first real Proof does not exist yet.
2. **The job-detail API still returns engine projections, not the Proof.**
   `GET /api/research-jobs/[id]` predates S8. Now that a Proof exists, that
   surface should return it — recorded in `BACKLOG.md`, deliberately out of
   scope for an engine-side milestone.
3. **Layer prose is templated, not editorial.** D-083 defers the copy system;
   the lines are mechanical by design and trace to persisted fields.

### Next — the owner's choice

1. **Surface the Proof through the API** — the smallest step that makes S8
   visible to a user, and the last thing between the engine and the product
   experience.
2. **Run one job end to end** behind the alpha gate to produce the first real
   Proof, then review and VERIFY it — which would exercise the memory
   promotion path for the first time.
3. **Stop and consolidate.**

### Standing boundaries

- S8 never re-judges S5/S6/S7, never calls a model, never touches the network.
- Confidence is never a probability and its score is never rendered as a
  percentage; the band is the semantic value.
- Never rewrite a non-DRAFT Proof.
- Fail closed: no S7 ⇒ no Proof. `INSUFFICIENT_EVIDENCE` with named gaps is a
  valid, successful outcome.
- Private by default; no public Proof URLs in v1.
