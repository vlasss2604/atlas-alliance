# Current task

> Overwrite this file each round. Never append.

## NONE — first real end-to-end Proof is PREPARED but BLOCKED on one unverified network fact

Offline preparation. Nothing executed, nothing enabled, no DB mutation, no
code changed.

## The path is fully wired — and needs NO global enable

`research_enabled` stays **false**. The narrow authorization already exists
(D-123, Owner Manual Alpha App Test):

```
POST /api/interpretations            (ADMIN session)
POST /api/research-jobs              interpretationId + idempotencyKey
  → research_enabled === false AND session.role === "ADMIN"
  → startOwnerManualAlphaResearch      job.origin = OWNER_MANUAL_ALPHA
  → worker picks it up
  → resolveOwnerAlphaWorkExecutor      ADMIN + slug in allowlist
  → createLiveS4WorkExecutor           real Brave / fetch / Anthropic
  → runS4ResearchJob                   S4 → S5 → S6 → S7 → S8
GET /api/research-jobs/[id]            → `proof` (S9)
```

**Flipping `research_enabled` would be strictly worse**, not just broader: the
owner branch is reachable *only while it is false*, so enabling it would close
this path AND open public research to every user. The correct authorization is
narrower — `internal_alpha_enabled = true` plus an ADMIN role — and it is
re-checked independently at worker pickup, not just at admission.

No CLI is needed. The product API is canonical, and using it is the point:
this run must exercise the path a real user takes.

## First case: `raydium` — with one caveat that did not exist before

In the allowlist, ACTIVE identity confirmed, a classified `OFFICIAL_DOCS`
route at `/ray/ray-buybacks.md` whose acquisition behaviour is known
(HTTP 200, `text/markdown`, 2,939 chars), no history paging, PUMP untouched.

**Caveat:** raydium now holds 4 admitted documentary locators and 6 derived
token-account subjects. A normal (non-`documentary-only`) job **will enter the
on-chain branch** and issue real RPC — this is no longer the clean
documentary-only shape the earlier Stage A/B runs had.

## Actual code-enforced maximum footprint for one job

| Axis | Ceiling | Where |
|---|---|---|
| Search queries | **12** | `INTERNAL_ALPHA_V1` |
| Source opens | **24**, shared by document fetches **and** on-chain reads | `INTERNAL_ALPHA_V1`; on-chain reserves the same `sourceOpens` axis |
| Model spend | **2,000,000 µUSD ($2.00)** — the binding constraint on model calls | `INTERNAL_ALPHA_V1` |
| Wall clock | **900 s** | `INTERNAL_ALPHA_V1` |
| Model generation attempts | ≤ 2 per call site, each with a fresh reservation | `reserveAndCallWithRetry` |
| `count_tokens` | ≤ 2 per generation attempt (own internal retry) | `token-gate.ts` |
| Content fetch retries | **0** — move to the next candidate | fetcher policy |
| Renderer | 1 navigation, 0 retry, official-docs refusals only | `rendered-docs-*` |
| On-chain per component | ≤ 2 base + ≤ 3 promoted = **≤ 5 reads**, 1 RPC each, **0 retries** | `MAX_ONCHAIN_INTENTS_PER_ATTEMPT`, `MAX_PROMOTED_INTENTS_PER_ATTEMPT`, transport has no retry |

Every external read is bounded by the 24-open axis, so the job cannot spend
more than that in total regardless of component count.

## THE BLOCKER — incompatible network conditions in one process

A production job does **Brave search → document fetch → Anthropic** in a
single process. The established facts:

- **Anthropic requires MantaRay ON.** Probed both ways: ON = SUCCESS, OFF =
  `PERMISSION_DENIED:403`.
- **Every successful `docs.raydium.io` fetch has been with MantaRay OFF.**
- **Brave has never been exercised live at all** — every run so far injected a
  single-URL search gateway ("no Brave call"). Its behaviour under either
  state is unknown, and it is the *first* external call the pipeline makes.

D-128 exists precisely because acquisition and extraction needed opposite
states. There is no per-stage network control inside one job, and toggling a
VPN mid-process is not a procedure I will recommend.

**With MantaRay OFF the run cannot succeed**: `count_tokens` 403s →
`CapabilityFatalError` → job FAILED, no Proof. Deterministic.

**The precise nuance, and why this is one probe from dissolving:** "the
document host needs OFF" is an inference from one-sided evidence — every
document read simply *was* OFF. **A fetch of `docs.raydium.io` with MantaRay ON
has never been attempted.** If it works, the whole blocker disappears.

## Smallest unblocking step — an owner probe with EXISTING tools, no new code

Not a coding task. One bounded live window, MantaRay **ON**, re-running the
existing Stage A tool against the already-classified route:

```
npx tsx scripts/acquire-document.ts --url=https://docs.raydium.io/ray/ray-buybacks.md --component=DESTINATION --step=6 --actor=owner --project=raydium
```

*(Flags taken from the script's own usage line, not guessed. Not executed.)*

It persists a document and makes **zero** model calls, so it answers exactly
one question — *is the document host reachable with MantaRay ON?* — at the
cost of one fetch. It creates a new `acquired_documents` row (the previous one
is consumed); it changes no verdict and no Evidence.

- **Fetch succeeds →** the single-process run is viable. Proceed to the full
  job below with MantaRay ON. Brave stays the one unknown, and it fails safe.
- **Fetch fails →** the blocker is real and structural, and the next decision
  is an architectural one (per-stage network policy, or a documented
  two-window production path), not a run.

## The full procedure, once that probe passes

**Preconditions:** `internal_alpha_enabled = true`; the owner's `users.role =
ADMIN`; `research_enabled` **stays false**; all four credentials present
(verified configured: `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY`,
`SOLANA_MAINNET_RPC_URL`, `DATABASE_URL`); worker running. **MantaRay ON.**

**Action:** create an interpretation for a Raydium value-capture question via
`POST /api/interpretations`, then `POST /api/research-jobs` with its id and a
fresh idempotency key — through the app, as ADMIN.

**Capture:** job id · terminal `state` / `terminationReason` / `errorCode` ·
the `proof` object from `GET /api/research-jobs/[id]` (verdict, confidence
band + score, layers, citations) · counts of Evidence / component results /
on-chain artifacts · and the trace's model-call and budget rows.

## Success state

One real job; Source/Evidence as the pipeline admits them; S5 results; S6
assembly; S7 claim support; **exactly one S8 Proof**; cited Evidence bound via
`proof_id`; a D-135 band; `PRIVATE`/`DRAFT`; and the S9 DTO retrievable
through the normal product read. No manual DB insertion anywhere.

## Failure semantics — verified, no fabricated Proof is possible

- **Search/acquisition fails** → `NO_SOURCE_COULD_BE_FETCHED`; S5 reconciles
  to `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`; S6/S7 still project; S8
  writes an honest `INSUFFICIENT_EVIDENCE` Proof at confidence **LOW (20)**.
  A real Proof, and a valid outcome.
- **Model extraction fails** → `CapabilityFatalError` propagates to the worker
  before S5/S6/S7 run for that attempt; the job terminates
  `SYSTEM_OR_PROVIDER_FAILURE`. **No S7 → no Proof.**
- **Chain acquisition fails** → local/continuable; documentary evidence and
  the Proof are unaffected.
- **Budget exhausted** → `BUDGET_LIMIT_REACHED`; S5/S6/S7/S8 still project, so
  paid-for research still yields its honest Proof.
- **S8 refuses** (`NO_CLAIM_SUPPORT` / `NO_PROJECT` / `PROOF_NOT_DRAFT`) →
  no Proof row, no partial write; the transaction is all-or-nothing.

At no point can a Proof appear without a persisted S7 result.

## Verdict: **BLOCKED** — on an unverified environment fact, not on code

Nothing in the repository needs to change. One bounded probe decides it.

### Standing boundaries

- No live call without a separate authorized window; no retries.
- Never enable `research_enabled` to reach this path — it would close it.
- Never toggle the VPN inside a running process.
- Never weaken SSRF, safe-http or any network gate to make a fetch work.
