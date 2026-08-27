# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The program-semantics question for the inflow transaction is answered: **no swap
or acquisition fact can be established from what is stored.** Details in
`PUMP_CASE.md`, "Why it cannot be called a swap, from what is stored". No code
changed.

### What it found

The two non-infrastructure programs are **UNKNOWN** from local evidence — no
dependency, no IDL, no registry, and their ids appear nowhere in the repository
except a test that records them as opaque. They contributed **zero** decoded
instructions.

Nothing stored could be decoded later either: instruction `data` and `accounts`
are dropped at the schema level, only the raw response's hash is kept, and inner
instructions are flattened so parent linkage is gone. So ATLAS cannot even reach
the weaker claim that both legs happened inside one invocation of one program.

### Open, for the owner

Two separable items, neither started:

- **Inner-instruction parent linkage** — small, program-agnostic, filed in
  `BACKLOG.md`. Would establish "one invocation", not "a swap".
- **Program semantics** — would need re-retrieval plus a human-authored program
  registry whose own provenance then needs answering. Even complete, it would
  establish acquisition, never buyback.

### Standing boundaries

- No live calls without separate authorization.
- No paging, no signatures outside a persisted window, no counterparty-chasing.
- Do not call the inflow a buyback, purchase, swap or revenue-funded acquisition.
- Do not connect this cycle to the later acquisition at slot `441977087`.
