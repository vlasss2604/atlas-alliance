# Current task

> Overwrite this file each round. Never append.

## NONE — S9 is complete

Offline implementation. No live call, no model call, no RPC, and no S8 change,
no decision change, no UI change. Existing Proof rows untouched.

**The Proof is now the product boundary.** `GET /api/research-jobs/[id]`
returns a canonical `proof` field — verdict, confidence band + encoding, the
locked layers, and the citations S8 actually bound — so a client never has to
read S5 component rows, S6 assembly, S7 claim support or exclusion plumbing to
know what ATLAS concluded.

### One serializer, not two

`src/server/services/proof-view.ts` is the single canonical projection. The
route calls `loadProofForJob` and never queries the `proofs` table itself —
pinned by a test — so a future route (a dedicated Proof resource, an external
API) reuses the same function instead of growing a second representation.

Chosen over a new `/api/proofs/[id]` route deliberately: retrieving the Proof
*for a job* is the stated need, the job endpoint is what the client already
calls, and a second route would add another ownership surface for no product
gain. The serializer is route-agnostic, so adding that route later is trivial.

### What it refuses to do

**S9 reads S8 and recomputes nothing.** Pinned by writing a verdict/confidence
pair the engine would never produce for that state and showing the DTO reports
it unchanged rather than "correcting" it — while the S7 row still says
something else, proving no reconciliation ran.

**Citations come from the binding** (`evidence.proof_id`), never from job
membership. Excluded and context rows are absent because they were never
bound, not because a filter hid them.

**Ownership is a query predicate**, not a post-hoc check: `WHERE
researchJobId = … AND ownerUserId = …`. A stranger guessing an id gets the
same `null` as "no Proof yet" and can distinguish neither. **A GET never
writes**, and a missing Proof is never fabricated.

**Verification is copied, never inferred** from confidence, verdict or
citation count — verification is a human act (D-041/D-055) and confidence is a
structural indicator; conflating them would let a machine mark its own work
verified.

**Platform-independent (D-125):** no Telegram field, no markdown, no
formatting. Layers travel exactly as S8 wrote them.

### One honest edge case

`proofs.confidence` has `CHECK 0..100`, so a row predating D-135 (or written
by hand in a fixture) can hold a value outside the four band encodings. That
reports `band: null` with the raw score rather than a guessed or rounded band
— decoding is not computing, and inventing a band would be inventing
confidence. Test-pinned.

### Acceptance — all five verdict/band pairs project correctly

`SUPPORTED`/VERY_STRONG 80 · `PARTIALLY_SUPPORTED`/STRONG 60 (D-074 ceiling) ·
`INSUFFICIENT_EVIDENCE`/LIMITED 40 · `INSUFFICIENT_EVIDENCE`/LOW 20 ·
`NOT_SUPPORTED`/VERY_STRONG 80. Citations resolve in each.

### Honest limits — what is NOT done

1. **No production job has run the pipeline end to end.** It stays behind
   `research_enabled=false`, so **no real Proof exists yet** — every test
   builds its own fixture. S9 is proven against persisted state, not against a
   live run.
2. **The engine projections are still in the same response.** `claimSupport` /
   `mechanism` / `components` / flat `evidence` remain for the owner
   manual-alpha view (D-123). A client no longer *needs* them, but they are
   not gone — removing them is a UI change, explicitly out of scope here.
   Recorded in `BACKLOG.md`.
3. **No client renders `proof` yet.** The field exists; the UI still reads the
   old shape.

### Next — the owner's choice

1. **Move the result view onto `proof`**, then drop the engine projections
   from the response — the step that actually makes the boundary real for a
   user, and closes the remaining BACKLOG half.
2. **Run one job end to end** behind the alpha gate to produce the first real
   Proof, then review and VERIFY it — exercising the memory-promotion path for
   the first time.
3. **Stop and consolidate.**

### Standing boundaries

- S9 reads S8; it never recomputes a verdict, confidence, layers or citations.
- Confidence is never a probability and its score is never rendered as a
  percentage; the band is the semantic value.
- A GET never creates or mutates a Proof.
- Proof is PRIVATE by default; no public Proof URLs in v1.
- No Telegram-specific field in Core (D-125).
