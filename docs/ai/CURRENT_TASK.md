# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

**The PUMP case is closed: `CLOSED_WITH_UNRESOLVED_BRIDGES`.** Documentation
only; no production code touched, no research attempted, no network call.

Everything the proof plan justified was learned. The two bridges remain
unresolved, and **no negative conclusion is implied** — nothing says the
mechanism does not exist, only that ATLAS cannot establish it from what it holds.

### Where the closure lives

- `PUMP_CASE.md`, **"CASE CLOSURE"** at the top — the fact inventory separated
  into documentary / deterministic on-chain / composed / unresolved, the exact
  canonical statement ATLAS may make, the list it must not, the component state,
  and the criteria for the next case.
- `CURRENT_STATE.md` — a bounded summary in place of the round-by-round
  narrative, which had grown to 360 lines. The document is 188 lines again.
- `CORE_RULES.md` — the generic lessons, five added to *Authority and identity*
  and two to *Research brakes*. Candidates already durable were not duplicated.
- `BACKLOG.md` — six closure items, each classified, none BLOCKING.

### Verified at closure, from persisted state

- `onchain_artifact_id` is **null on all 401 Evidence rows**; no `snapshot_ref`
  anywhere. The Solana work has never entered Evidence.
- The most recent result for **all ten components** is
  `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. The three `PARTIALLY_SUPPORTED`
  `DESTINATION` results are from 2026-08-24 and were not reproduced later — a
  correction to how the case narrative read.
- The 53 `ONCHAIN_VERIFIABLE` rows are model-extracted explorer text with
  `entity_binding = UNVERIFIED`, including EVM Solidity for a Solana project.
  They establish nothing, correctly.

### What PUMP left untested, and it is the important part

**Whether any project can carry an on-chain fact all the way into Evidence and
out through a component.** Every deterministic chain fact here lives in a
standalone artifact. Until a case does that end to end, the on-chain half of the
pipeline is unproven in production — and PUMP could not do it, because getting
there requires a live retrieval inside a research job and there is deliberately
no offline adoption path.

That is the sharpest selection criterion for project #2, alongside: a different
mechanism shape (not buy-and-burn), **address-level role assignment published by
the project itself** so the actor → acquisition bridge can be tested rather than
merely missed again, and documentation reachable by the static fetcher.

Not selected here, and not browsed for.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
