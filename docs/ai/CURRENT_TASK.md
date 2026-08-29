# Current task

> Overwrite this file each round. Never append.

## NONE — D-138 phased product admission and one uniform live gate: implemented and proven offline

Offline round. No live HTTP, no RPC, no browser, no model call, no worker
started, no dev config changed.

### What was built

**`phased_research_enabled`** — a backend-only product flag, default false,
affecting ONLY the owner/internal-alpha admission path. `research_enabled`
and `internal_alpha_enabled` keep their own meanings; entitlement is
untouched; the public path is not widened. No client field, no API surface.

**Atomic phased admission.** `initializeAcquisitionPhaseInTx` (queue.ts)
writes the phase and its SEARCHING message together, in the caller's
transaction, and `createResearchJob(..., { phased: true })` runs it inside
the same transaction that inserts the job. `beginAcquisitionPhases` now just
opens a transaction around the same primitive — one implementation, two entry
points. `phased` + `skipEnqueue` together is refused as a programming error.

**One live gate.** `evaluateOwnerAlphaLive` (non-throwing) and
`assertOwnerAlphaLive` (throwing) in `owner-alpha-routing.ts`, with the closed
refusal set `NOT_OWNER_MANUAL_ALPHA | ACTOR_NOT_ADMIN | PROJECT_NOT_ALLOWLISTED
| INTERNAL_ALPHA_DISABLED` and the same two error classes as before. Asked by
the single-process executor, SEARCHING, FETCHING and EXTRACTING — and by the
admission path before it creates any phased work.

**Gate timing.** At admission AND again at each phase, because configuration
and roles change after enqueue. SEARCHING and FETCHING ask before a provider
is constructed, so a refusal costs zero model calls, zero searches, zero
source opens, zero attempts and zero budget. FETCHING never infers
eligibility from SEARCHING having succeeded.

### What was proven

`tests/d138-phased-admission.test.ts` — 18 tests. Legacy admission is
unchanged (phase NULL, one legacy message, gate not consulted); phased
admission creates one job, phase SEARCHING, one SEARCHING message, zero legacy
messages, linked interpretation, zero attempts; a failed enqueue rolls the job
back rather than stranding it; the one-active-job invariant and idempotency
still hold; every refusal reason is produced by the one shared helper; a gate
that closes after enqueue refuses at SEARCHING and at FETCHING with zero
provider calls; EXTRACTING refuses through the same helper; and the client
contract carries no phase vocabulary.

### Learned from a failing test, not from reasoning

The state machine has no `QUEUED → FAILED` edge. A phase that refuses before
claiming must claim first, exactly as the single-process path does — otherwise
the terminal write is rejected by the trigger and the message is retried
forever.

### Ready for the first real Mini App phased run

Yes, on the code side. Remaining operator steps, unchanged from the runbook
and deliberately NOT done here: set `phased_research_enabled = true` in dev
`product_config`, cancel the stale QUEUED owner job that holds the
one-active-job slot, then run the sequential worker runbook. `research_enabled`
stays false; `internal_alpha_enabled` is already true in dev.

### Standing boundaries

- Phased research is opt-in and owner-only; the flag never widens the public path.
- A phased job never carries a legacy entry message.
- Every live phase asks the same gate, before constructing any provider.
- The budget default is expensive; a provider that says nothing pays.
- No network product in domain logic; capability is declared, never discovered.
- Phases are never component attempts; the controller runs once.
- `OWNER_STRICT` sealing keeps its both-ends gate, pinned by test.
- A lossy trace ref is never fetched.
