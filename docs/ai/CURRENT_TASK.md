# Current task

> Overwrite this file each round. Never append.

## SPEED + COST OPTIMIZATION — pass 1 (done this round)

Offline, $0 spend (no Anthropic, Brave, RPC or live Research; migrations
0052–0054 still pending and NOT applied; Lido Memory untouched). Semantic
core hardening is complete (Round 12 = CLEAN #1, Round 13 = CLEAN #2) and
no verdict, admissibility, lifecycle, Memory, confidence or Proof rule was
changed here.

### The timing model

`tests/perf-pipeline-timing-v1.test.ts` drives one normal Research (a
10-component queue) through the REAL phased pipeline — the real search
phase, fetch phase, replay providers, controller and S5–S8 — over fixture
providers that count every call and sleep a MODELLED latency per call
(proposer 1.5 s, search 0.4 s, fetch 0.8 s, extract 2.5 s; conservative
typical values, not live measurements). What it measures faithfully is
the STRUCTURE: how many calls, and how many are on the serial path.

| stage | before | shipped default | opt-in extraction overlap | calls (unchanged) |
|---|---|---|---|---|
| SEARCH phase | 14.6 s | 12.1 s | 12.1 s | 6 proposer, 12 search |
| FETCH phase | 6.0 s | 1.8 s | 1.8 s | 7 fetches, 7 unique urls |
| EXTRACT + S5–S8 | 55.2 s | 55.2 s | 32.3 s | 21 extractions |
| **total** | **75.9 s** | **69.1 s** | **46.2 s** | |

Best of two runs each; the search phase varied by up to 2.8 s between
identical runs (its ~30 DB round trips on a WSL/Docker Postgres), so
treat ±3 s as noise. Extraction is per-component serial by design: the
opt-in column overlaps only the documents AFTER a round's first success,
which is why it is 32 s and not the 17 s a fully overlapped round would
give.

Run it with `PERF_SCALE=1` for the numbers; the suite runs it at ~0 for the
structural pins. `ATLAS_ACQUISITION_CONCURRENCY=1` reproduces "before";
`ATLAS_EXTRACTION_CONCURRENCY=4` is the opt-in column.

### What changed

Three loops that waited on the network one item at a time now overlap the
waiting and nothing else (`engine/concurrency.ts`, bounded at 4 by default):

- **FETCH phase** — urls fetched with bounded concurrency; the per-job
  render cap (a read-then-act ledger check) is serialised per job so a
  parallel fetch cannot race it; nothing new starts after a
  BUDGET_EXHAUSTED.
- **SEARCH phase** — one component's queries: reserved in plan order,
  searched concurrently, merged in plan order, so `candidateUrls` (the
  fetch order) is byte-identical.
- **EXTRACTION — built, pinned equivalent, and OFF by default.** One
  round's documents are called one at a time until the round's first
  success, then the rest are reserved in document order and overlapped
  with per-call usage capture (the adapter-level usage sink was one shared
  object per component), their results consumed in document order by the
  unchanged tail. It ships at concurrency 1 because Founder decision 5.5B
  pins "the next document is never touched" after a fatal outcome, and
  fatality is only known when a call returns — so a later document's call
  cannot start before the previous outcome is known without violating
  the pin (`transient-extractor-resilience-v1` G2 caught exactly this).
  That is a decision, not a bug: see below.

`SEQUENTIAL == CONCURRENT` is pinned: two fresh projects, one at
concurrency 1 and one at 4, persist the identical S5 statuses and reason
codes, S6 flow shapes, S7 requirements, verdict, band, evidence count and
trace counts.

One documented equivalence boundary: a transient retry (attempt 2)
reserves when it happens, which can now be after a later document's
attempt 1. Under a model budget exhausted mid-round AND a transient
provider failure in the same round, the SET of documents that got a call
can differ from the sequential loop's; total spend cannot.

### Founder decision required: extraction overlap

Extraction is 73% of the modelled wall-clock and the only stage still
serial. Overlapping it needs 5.5B's "the next document is never touched"
relaxed to "no NEW extraction call starts after a fatal outcome; calls
already in flight complete". Cost of the relaxation: on a permanent
provider rejection or a second consecutive transient exhaustion that
follows an earlier success in the same round, up to (concurrency − 1)
later documents are already in flight — those calls are made and paid.
Under a genuinely broken capability (401/403) they fail immediately.
Benefit: 55 s → 32 s modelled on the normal Research (69 s → 46 s
total); the ≤ 60 s target is not reachable without it, and reaching it
with margin also needs cross-component overlap (below). `ATLAS_EXTRACTION_CONCURRENCY=4` turns it on.

### Cost levers found, not taken (Founder decisions)

- **Prompt caching** would cut the largest cost — the same document is
  extracted once per component that opened it — but the extractor prompt
  puts the varying component text BEFORE the document (an injection-safety
  ordering) so a prefix cache can never hit, and the billing accounting
  flags cache tokens as `unsupportedBillingUsage`. Both are deliberate;
  changing them is a prompt-behaviour and billing-model decision.
- **Cross-component parallelism** (proposer across components, extraction
  across components) is the remaining wall-clock: it interacts with D-140
  fair share and attempt claiming, so it needs a design review.

### Next

- Founder review of this report.
- Then: migrations 0052–0054, live Solana Research, live EVM Research.
  No live spend before approval.
