# Current task

> Overwrite this file each round. Never append.

## NONE — D-137 replay-aware budget metering: implemented and proven offline

Offline round. No live HTTP, no RPC, no browser, no model call. Accounting
only: no engine semantics changed.

### The problem, precisely

The job budget is supposed to measure REAL external capability
consumption. `s4-executor` reserves before every provider call and could
not tell a replay from a live call, so the D-136 EXTRACTING phase charged
`searchQueries`, `sourceOpens` and `modelCostMicro` for providers that make
no external call at all. A phased job could falsely exhaust its budget.

Note the mechanism, since it is not obvious: the ledger already refuses to
re-search an identical query string, so the leak was not the same query
twice. It was D-129 targeting — the executor rewrites proposed queries into
targeted forms, which the ledger has never seen, so a replay gateway was
asked for them and charged for answering from persisted rows.

### The contract

`PROVIDER_METERING = LIVE | REPLAY`, an optional `metering` field on
`SearchGateway`, `ContentFetcher` and `QueryProposer` (via `MeteredProvider`),
and one decision function:

```
isReplayProvider(p)  ===  p?.metering === "REPLAY"
```

Default is chargeable. Absence, `undefined`, `"replay"`, `true`, `1` and a
wrapper that dropped the field all pay. Replay is never inferred from
`instanceof`, a class or file name, the acquisition phase, the worker role
or the network — a provider declares what it does.

Declared REPLAY: the three D-136 extraction providers and D-128's
`replayContentFetcher`. Never declared: the evidence extractor. EXTRACTING
is real model work and is still charged for it.

### What was proven

`tests/d137-replay-metering.test.ts` — 14 tests. Live phases reserve exactly
one unit per real call; extraction over replays adds **zero** to both
acquisition axes; a second replay adds zero again; per-attempt
`searchQueriesSpent`/`sourceOpensSpent` are 0 while `modelCostMicroSpent` is
not; the phased path never costs more than single-process for the same
work; attempt numbering and the recovery pool are untouched.

The D-136 Slice 2 test that pinned the old behaviour was rewritten to state
the corrected one — it is the same measurement with the opposite result.

### Ready for the first real D-136 run

Yes, on the accounting side. What remains is deployment: two worker
processes, one with `ATLAS_WORKER_CAPABILITIES=SEARCH_EXTRACT` in the
model-side network, one with `=FETCH` in the source-side network, and the
owner's decision to admit a phased job. `research_enabled` and
`internal_alpha_enabled` remain false.

### Standing boundaries

- The budget default is expensive. A new provider that says nothing pays.
- A wrapper must carry `metering` across deliberately.
- Never weaken SSRF, whitelist a reserved range, or special-case a domain.
- No network product in domain logic; capability is declared, never
  discovered.
- Phases are never component attempts; the controller runs once.
- `OWNER_STRICT` sealing keeps its both-ends gate, pinned by test.
- A lossy trace ref is never fetched.
- A phased job must never also carry a single-process entry message.
