# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Stage B ran with the real id. **D-128 worked end to end; the extraction failed
on the generation side** — a first. No Evidence exists; the chain gate stays
locked; the document is unconsumed and resumable. Analysis only this round.

### What the run proved (the architecture)

Cross-process resume · seal verified live · both-ends authority re-confirmed
(`CONFIRMED / OFFICIAL_DOCS`) · replay transport served the stored document
with **zero external Raydium fetch** (`acquired-document-replay` → `FETCH_OK`)
· documentary-only chain guarantee held (`ONCHAIN_DISABLED_DOCUMENTARY_ONLY`,
retriever 0, artifacts 11) · failure did **not** consume the document. The
fetch was neither lost nor repeated — exactly what the seam exists for.

### What failed, and how far the closed signals narrow it

The **real `anthropic` extractor** was invoked for the first time in any
Raydium job. `count_tokens` **passed** — a count failure is fatal-classified
and would have crashed the script; it did not — consistent with the
MantaRay-ON probe. Then: exactly **one** attempt, **no** transient-retry row,
`EXTRACT_FAILED / PROVIDER_ERROR`, outcome `EVIDENCE_EXTRACTOR_UNAVAILABLE`,
S5 = `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND` (kept separate from the three
historical jobs).

Usage columns are **null**, which narrows the cause to exactly two closed
candidates and excludes the rest:

1. `messages.create` threw a **non-transient 4xx** (400/401/403/404/422 —
   429/5xx/no-response would have retried and left a second row), **or**
2. the response truncated at **`stop_reason = "max_tokens"`** (thrown before
   usage capture; output ceiling is 1,536 tokens).

JSON-parse and schema failures are excluded — they record usage first. **Which
of the two occurred is not recoverable from anything persisted.** That is the
same observability shape fixed for count_tokens in e7c422c, missing on the
generation path. No cause beyond the two candidates is inferred.

### Next — the owner's choice

1. **Close the generation-side diagnostic gap first** (BACKLOG item, exact
   shape written there: reuse the existing classifier for API errors; add
   closed `MAX_TOKENS_TRUNCATED` / `OUTPUT_NOT_JSON` / `OUTPUT_SCHEMA_INVALID`;
   surface via `safeFailureDetail`). Offline, tested, small. Then one Stage B
   window — the document is still sealed and waiting — and the terminal line
   will name the cause.
2. **Run Stage B again as-is** to test reproducibility. Blind on cause if it
   fails the same way.
3. **Stop.**

Option 1 mirrors exactly what unblocked the count_tokens diagnosis. If the
answer turns out to be `MAX_TOKENS_TRUNCATED`, the follow-up is an owner
decision about the extractor output ceiling (D-122 territory); if a 4xx, it is
credential/permission territory. Either way the next window stops being blind.

### The standing Stage B command (document still resumable)

```
npx tsx scripts/extract-from-document.ts --document-id=711e6745-abc1-44c0-b4a0-4d3eb449b7df --component=DESTINATION --step=6 --actor=owner --project=raydium --mode=documentary-only
```

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
