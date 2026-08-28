# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The second Stage B window ran post-fix (job `eb00256a-…`, HEAD `95bd370`) and
**the terminal line named the cause**: `EXTRACT_FAILED:OUTPUT_SCHEMA_INVALID`.
The model returned complete, valid JSON that failed the extraction schema —
not a credential problem, not a rate limit, not a `max_tokens` truncation,
not unparseable output. One attempt, no retry, no Evidence, chain gate still
locked (`findAdmittedLocator` 0 / `resolveOnchainSubject` `NOT_FOUND` for all
four role-bound addresses, run against the real functions), D-127 held, and
the document is **still unconsumed and resumable**.

**A prior narrowing was refuted this round.** The first Stage B failure
(job `b3457f0b-…`) was narrowed to two candidates on the premise that
JSON/schema failures persist usage; in fact usage persists only on the
success-path trace row, so every failure class leaves null usage columns.
`b3457f0b`'s cause is one of the four non-transient classes and remains
unknown; `eb00256a` proves nothing about it retroactively — though failing
at the same stage, on the same document and model, makes the same class a
plausible (unproven) reading. Recorded in `CURRENT_STATE.md` and corrected
in `ARCHITECTURE.md`.

**What is deliberately not knowable today:** WHICH schema field failed. The
zod message is model-derived text and never crosses. The failing field paths
are code-owned, so a membership-gated `OUTPUT_SCHEMA_INVALID:<field>` would
be safe — the exact shape is written in `BACKLOG.md`.

### Next — the owner's choice

1. **Close the schema-field diagnostic gap first** (BACKLOG: closed
   field/issue-code detail on `OUTPUT_SCHEMA_INVALID`). Offline, small,
   generic, same two-gate discipline. Then one Stage B window names the
   exact mismatched field.
2. **Re-run Stage B as-is.** Model output varies between runs; it may pass.
   If it fails the same way, the line will say the class again but not the
   field.
3. **Stop.**

Real generation tokens were spent on `eb00256a` (generation completed; only
the 55,680 micro-USD reservation ceiling is on record — actual usage is not
persisted on failure paths, so no spend figure should be quoted).

### The standing Stage B command (document still resumable)

```
npx tsx scripts/extract-from-document.ts --document-id=711e6745-abc1-44c0-b4a0-4d3eb449b7df --component=DESTINATION --step=6 --actor=owner --project=raydium --mode=documentary-only
```

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
- Keep the pasted terminal output of job `eb00256a-…` — for an owner-tooling
  run it is the only record of the closed diagnostic (BACKLOG notes the
  persist-at-rest option).
