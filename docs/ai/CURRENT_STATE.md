# Current state

Where the system actually is. Not a history — for that, `git log --oneline`.

## Repository

- Branch: `claude/phase-5-research-memory`. Working tree should be clean.
- Typecheck (`npx tsc --noEmit` — there is no `typecheck` npm script) and
  `npm run lint` are clean.
- Full suite, last verified 2026-08-29: **2368 passing, 4 skipped, 1 failing**
  (2373 total). Only the second item below failed on that run; the first passed
  because the working copy happened to hold LF. Both are pre-existing and
  unrelated to research behaviour:
  - `first-real-run-stage2.test.ts` — a source-regex assertion against
    `s4-executor.ts`. **Now understood: it is a line-ending artifact.** The
    assertion matches `\n}\n`, and `core.autocrlf=true` checks the file out with
    CRLF, so the regex finds nothing and the match is null. It passes whenever
    the working copy happens to hold LF — which an editor rewriting the file can
    cause — and fails again after any git round-trip restores CRLF. It says
    nothing about the code either way;
  - `s10-live-provider-enablement.test.ts` — a Windows path bug (`C:\C:\...`)
    while scanning `src/server/services/`.

  Do not "fix" these opportunistically. Verify by stashing before blaming any new
  change on them — and for the first one, check the file's line endings before
  believing either result.

## What works today

**Markdown is a readable document representation.** The static fetcher's closed
MIME allowlist now admits `text/markdown` alongside `text/html`,
`text/plain`, `application/json`, `application/xml`. Markdown takes the
`text/plain` path — trimmed text, never parsed, rendered or followed. The gate
sits last, after SSRF, the byte cap and the status check, so nothing else
loosened; a mutation test fails if the allowlist ever becomes a `text/*`
wildcard. MIME establishes representation only, never authority. Detail in
`ARCHITECTURE.md`.

**Document recovery.** Embedded structured payloads (`__NEXT_DATA__`, JSON-LD,
RSC flight frames, `application/json`), then isolated Playwright rendering for
official docs — scrubbed child process, deny-by-default egress proxy, one
navigation, zero retry, bounded time and body, no clicks/forms/logins/downloads.
An unread payload can never read as absence.

**Documentary locators.** One-to-many per fact, with provenance. The legacy
scalar field is a compatibility projection of ordinal 0.

**Typed on-chain retrieval.** Solana only. Typed intents, deterministic facts, no
arbitrary RPC, project anchor kept separate from the queried subject. Burn and
BurnChecked decoding, including Token-2022.

**Fail-closed account relationships.** `ACCOUNT_INFO` is the sole base intent for
account-kind components and classifies the subject before anything is asked of
it: not-token-program-owned, parsed token account, or token-program-owned but
unresolved (fails closed). Foreign-mint token accounts are CONTEXT — neutral,
never support. Encoded `getAccountInfo` data is a valid answer, not a validation
failure; no mint is inferred from binary.

**Bounded promotion.** Discovery-only components stop at the token accounts an
address owns. Only `EXECUTION_EVIDENCE` may currently walk a signature window
into a transaction. No unbounded paging exists, and none should be added casually.

**Document readiness.** `networkidle` is no longer the navigation's success
condition. The navigation waits for `domcontentloaded`, then the rendered
document is re-sampled — inside the existing document budget — until it stops
looking like an unfilled shell, using `staticShortfallDetected()` inverted so
there is one notion of "usable document" rather than two. A page that never
becomes readable fails as `DOCUMENT_NOT_READY`, a different statement from
`NAVIGATION_TIMEOUT`. Containment is re-checked after the settle window. Detail
in `ARCHITECTURE.md`.

**Renderer phase budgets.** Browser startup and document work are two phases with
two budgets: `browserLaunchTimeoutMs` enforced by the driver at `launch()`, and
`totalWallClockMs` measured from the moment the browser is up. Previously the
document budget ran from before launch, so startup spent the navigation's
allowance and a **completed** navigation could be discarded as `TIMEOUT`. The
parent supervisor's deadline is now derived from both phases plus a fixed
isolation allowance rather than from the document budget alone. Detail in
`ARCHITECTURE.md`.

**Deterministic fact synthesis.** Chain facts bypass the model completely:
code-templated statements, literal artifact fragments, hand-authored
`doesNotProve` limits.

**Component reconciliation (S5).** Pure and model-free. Applies each component's
own CORE contract. Closed exclusion-reason list. Downstream S6 assembly and S7
claim evaluation exist.

Two boundaries verified this round and now written down in `ARCHITECTURE.md`:
on-chain evidence **cannot reach `SUPPORTED`** — D-074 caps officiality
`CLAIMED` at `PARTIALLY_SUPPORTED`, and every on-chain fact is `CLAIMED` by
design; and a standalone artifact **cannot become Evidence** — structurally, not
by convention.

## Latest semantic result

Reciprocal same-transaction asset flow is derived deterministically and named
nothing. Its three facts — native leg, target-token leg, structural pairing — are
all **`DIRECT` + `CONTEXT`**, `mechanismState = null`.

Directness stays `DIRECT` because the reading really is a decoded instruction.
The relationship is `CONTEXT` because every Pattern v1 component such a fact can
be offered for asks a mechanism-level or economic question, and a movement
between two accounts answers none of them. Previously the two legs were
`SUPPORTS` and each established `FLOW_PATH`, `DESTINATION` and `RECIPIENT` on its
own — a semantic overclaim, live only in the sense that the promotion map
happened to route these facts to a component whose live-state gate already
excluded them.

A genuine `Burn`/`BurnChecked` fact is unchanged: **`SUPPORTS` + `mechanismState
= LIVE`**, and still establishes `EXECUTION_EVIDENCE`.

Consequence to keep in mind: S5 reconciles one component from one pool and never
waits for a binding to arrive from elsewhere, so a fact's relationship must be
correct where the fact is authored — not left to a downstream gate.

## Active architectural constraint: platform independence

**ATLAS is the product; Telegram is only the first interface** (D-125) — an
**ACTIVE** constraint on all current development, unlike the future extension
below. Core must never depend on Telegram; the boundary, mapping, audit and
acceptance matrix are in `docs/PLATFORM_INDEPENDENT_ARCHITECTURE.md`. Audit
2026-08-28: zero Core violations; Telegram exists only at the auth/client edge
and as identity-attachment data. No new client platform is authorized.

## Recorded future extension (not active)

A future product layer — **EVIDENCE → PROMISES → RISKS** (Project Assessment) —
is recorded in `docs/PROJECT_ASSESSMENT_PRODUCT_SPEC.md` and registered as
D-124. **Nothing of it is implemented, scheduled or active**; the dependency
boundary lives in `ARCHITECTURE.md`, the phase references in `BACKLOG.md`. The
Proof Core roadmap is unchanged.

## Token Value Capture — stage

TVC is the only supported domain and is not yet mature. Target: roughly 10 diverse
TVC projects, with about 8/10 unfamiliar claims reaching a valid result without
manual steering. `INSUFFICIENT_EVIDENCE` counts as valid when the missing bridge
is named correctly.

**PUMP is project #1** — the deep crash/training case. Details in `PUMP_CASE.md`;
read it only for a PUMP task.

### PUMP — CLOSED WITH UNRESOLVED BRIDGES (2026-08-28)

Everything the proof plan justified was learned. The unresolved bridges stay
unresolved, and **no negative conclusion is implied**: nothing here says the
mechanism does not exist, only that ATLAS cannot establish it from what it holds.
Full detail in `PUMP_CASE.md`, "CASE CLOSURE"; this is the bounded summary.

**Documentary, established.** Four distinct fragments, all from
`https://pump.fun/pump-token`, all `OFFICIAL_DOCS / CONFIRMED`, all filed at
step 6 / `DESTINATION` — the buy-and-burn claim, the "Burn addresses" heading
listing `99mRw3…` (truncated on the page; the full value came from the href) and
`9jHrTC…`, the 50%-locked-for-a-year statement, and a claim that a record of each
daily purchase and burn exists. That is the entire first-party corpus.

**On-chain, deterministic, in standalone artifacts.** A genuine `BurnChecked` of
the confirmed mint — 7723.746661 PUMP destroyed from the locator's own token
account, under its own authority, balance to zero, slot `441840980`. Five slots
earlier the same raw quantity entered that account from zero, and the quantities
reconcile: an account-level inflow → burn continuity statement holds across
`441840975`–`441840980`, **closed under the observed index**, which is weaker
than complete. Within one invocation of that inflow transaction, the documented
address paid `382202589` raw wSOL and received `7723746661` raw units of the
confirmed mint from one counterparty — a decoded exchange, offered as CONTEXT.

**Composed: nothing.** Verified at closure: `onchain_artifact_id` is **null on
all 401 Evidence rows** and no row carries a `snapshot_ref`. The Solana work has
never entered Evidence. The 53 rows classified `ONCHAIN_VERIFIABLE` are
model-extracted explorer text with `entity_binding = UNVERIFIED` — some of it
EVM Solidity for a Solana project — and establish nothing, correctly.

**Component state.** The most recent result for **every one of the ten
components is `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`.** Three
`PARTIALLY_SUPPORTED` DESTINATION results exist from 2026-08-24 jobs
(`TOKEN_STATE_UNQUALIFIED`) and were not reproduced by the later full-pattern
runs. `MECHANISM_SPEC` holds 112 rows, all `SOCIAL / CLAIMED`, which establish
nothing ever (D-074).

**Two unresolved bridges, kept separate.**

1. **Actor → acquisition.** No authoritative first-party statement assigns the
   acquisition role to `99mRw3…`. Established by exhaustion across all 115
   text-bearing columns: no single text contains both any form of the address and
   any of `buyback`, `purchase`, `acquir…`, `treasury`, `buying`, `executes`.
2. **Revenue → observed acquisition.** Nothing binds the revenue Pump.fun
   describes to the specific observed acquisition. No evidence at all.

**`fees.pump.fun`** is CONFIRMED and unclassified at prefix `/`, and unread —
four windows ended in transport failures, never in a page. Its content is
unknown, so the address's absence from it is **not** established.

## Done

- Acquisition-side deterministic evidence for PUMP, with correct limits.
- Multi-locator support, parsed token-account projection, fail-closed relation
  classification, relationship-gated promotion, encoded-account fallback,
  `createIdempotent` lifecycle correctness, reciprocal-flow derivation.
- The component-contract semantics of transfer facts, settled and regression-tested.
- **Acquisition observability, in four stages**: a fetch failure names its typed
  reason and HTTP status; a render names the stage that failed (launch,
  navigation, data boundary, process) and its sub-reason; the isolated renderer
  is testable offline without a live window; and the egress proxy's own decisions
  reach the operator as counts. Each was paid for by a live window that could not
  explain itself, and each retired at least one hypothesis on its next use.
- **Owner route confirmation** — `confirm-source-route.ts`, unclassified only,
  reusing the existing lifecycle. Confirming a host and classifying a page are
  separate decisions.

## The pipeline ends at S7 — no Proof is ever written

Verified against current code 2026-08-29: `run-job.ts` runs S4 → S5 → S6
(`assembleAndPersistMechanism`) → S7 (`evaluateAndPersistClaimSupport`) and
returns. **There is no S8.** The `proofs` table exists with its locked shape
(verdict, confidence, 7-layer `layers`, `researchCutoff`, `visibility
PRIVATE`, `verificationStatus`) and `memory/verification.ts` reads it, but the
only `insert(proofs)` calls in the repository are in tests. Consequently
`evidence.proof_id` is null on every row ever written and the `PROOF_BOUND`
half of the ownership model has never occurred.

Three product consequences: `GET /api/research-jobs/[id]` returns raw engine
projections rather than a Proof, so internal complexity leaks to the surface;
Research Memory promotion is gated on a **VERIFIED Proof** (D-041/D-055), so
with no Proof writer the learning loop is structurally blocked; and no object
exists for any downstream feature to render or cite.

This is the current single biggest product bottleneck.

**S8 is now half-built and deliberately stopped.** The pure builder exists —
`proof-builder.ts`, no IO, no model, deterministic — producing the verdict
(copied from S7, never recomputed), the seven locked layers (5 empty per
D-083, 6 assembled only from recorded gaps), resolved citations and a closed
refusal when S7 is absent. 21 offline tests pin it.

**It cannot be persisted, and that is a contract gap, not an oversight.**
`proofs.confidence` is `smallint NOT NULL CHECK BETWEEN 0 AND 100`, and while
D-081/D-110/§11.4 lock that the number is deterministic, code-owned and never
model-authored, **no decision fixes the mapping to 0..100**. Inventing one
would invent exactly what the register says must be fixed deliberately, so
the store and the `run-job.ts` wiring are not written. The four questions a
decision must answer are in `CURRENT_TASK.md`.

## Open

- **Both PUMP bridges stay unresolved** — see the closure summary above. That is
  a legitimate research outcome, not a defect, and nothing should reopen the case
  without new authoritative material.
- The second burn address has one derived token account observed at zero; its
  history has never been read.
- Cumulative official burn totals are unverified.
- Nothing at all is observed after slot `441977087`; no persisted signature
  anywhere has a higher slot.
- **Raydium's four documentary locators are admissible; one has now been read
  once.** `DdHDoz94o2WJ…` was characterized 2026-08-28 as a System-Program
  account (not a RAY token account) — see the first on-chain read below.
  Nothing has been read for the other three, no RAY balance has been observed
  anywhere for the other three. For `DdHDoz94o2WJ…` two chain observations are
  now Evidence (2026-08-29): it exists and is System-Program-owned, and it
  owns six RAY token accounts at slot `442456294`. **No flow, buyback or burn
  has been observed** — nothing says how any balance arrived, and the
  holding facts are `CONTEXT`, establishing no component on their own.
- Non-blocking engineering items are in `BACKLOG.md`. Do not work on them unless
  `CURRENT_TASK.md` says so.

## Next research direction

**PUMP is closed. Project #2 is blocked on one architectural fork**, not on
finding a project. Selection ran 2026-08-28; the reasoning is in
`CURRENT_TASK.md`.

The single most valuable thing PUMP left untested: **whether any project can
carry an on-chain fact all the way into Evidence and out through a component.**
**ANSWERED 2026-08-29 — yes.** Job `9d488cc6-…` carried a Raydium
`ACCOUNT_INFO` observation into Evidence with `onchainArtifactId` set and out
through `DESTINATION` reconciliation (`PARTIALLY_SUPPORTED` /
`INSUFFICIENT_AUTHORITY`, the D-074 ceiling). See "FIRST PERSISTED ON-CHAIN
EVIDENCE" below. The paragraph as written before that run:

**That path is not the blocker.** Verified by reading it: `onchain-acquisition.ts`
stores the artifact and inserts Evidence with `onchainArtifactId` set,
`sourceClass ONCHAIN_VERIFIABLE`, `officiality CLAIMED` and **`entityBinding
CONFIRMED`**. It works; it has simply never succeeded end to end. (Which also
proves the 53 existing `ONCHAIN_VERIFIABLE` rows, `entityBinding UNVERIFIED` with
null artifact id, did not come from it.)

**The blocker is chain coverage.** `onchain-transport.ts` returns `null` —
`v1: Solana only` — and every intent is gated on `chain === "solana" && network
=== "mainnet"`. `SUPPORTED_CHAINS` admits ethereum and six other EVM chains **for
identity only**, so a confirmed Ethereum project degrades silently to
documentary-only. Not a defect; a capability boundary.

Repository memory holds four projects: `pump_fun` (26 jobs, 401 evidence),
`hyperliquid`, `uniswap` and `raydium` — the latter three with **0 jobs,
0 evidence and no documentary knowledge of any kind**. `hyperliquid` and
`uniswap` additionally have **no confirmed identity and no route**, and both are
non-Solana, so neither can test the on-chain path. `raydium` now has an identity
and two unclassified routes — see below.

**The fork: add an EVM read transport, or choose Solana projects until Pattern v1
is mature.** No Solana TVC candidate exists in repository memory, so option two
needs the owner to name one.

**Resolved 2026-08-28: the owner named RAYDIUM / RAY buybacks**, which is on
Solana, so the transport wall does not apply. Recorded as the **selected next
case and an owner-supplied lead only** — nothing about its mechanism, fee split
or published addresses is a finding, and none of it becomes one until acquired
through the pipeline. Local state is a clean slate apart from the catalog row, the
confirmed identity and the two unclassified routes recorded below: no source, job,
Evidence or artifact, and **nothing has been read**; the only `raydium` mentions
anywhere are 11 SOCIAL Evidence rows belonging to `pump_fun` that name it as a
venue.

The shape is deliberately different from PUMP — fee → collection → conversion →
**accumulation at a protocol-controlled destination, with no burn** — so it
exercises **buyback ≠ supply reduction**, an invariant CORE_RULES states and
nothing has ever tested.

**Catalog entry created 2026-08-28** — `raydium` / "Raydium", `ACTIVE_CORE`,
`ticker = null`, project id `9cc80fd6-04ae-45e8-be6c-7ed8b9f663c7`, via the
existing idempotent seed path. That is a catalog row and nothing else: **zero**
`PROJECT_IDENTITY` rows, zero `SOURCE_ROUTE` rows, zero sources, zero Evidence,
zero jobs. No chain and no mint were inferred — the ticker was deliberately left
null so the catalog asserts no token identity, which is `PROJECT_IDENTITY`'s job.
`demo_project_slugs` was **not** touched, so `raydium` is in scope and not
available to DEMO (Scope != Entitlement), and the projects API now proves that
divergence rather than assuming catalog and DEMO config coincide.

**Identity confirmed 2026-08-28**, by owner decision through
`confirm-project-identity.ts` — the only supported path. One
`PROJECT_IDENTITY` row, `c90833b3-bd93-413b-b430-b9e5e8b3cb28`, ACTIVE via
`OBSERVED -> CANDIDATE -> ACTIVE` on the existing lifecycle function. Content is
exactly `{ chain: "solana", tokenAddress:
"4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", ticker: "RAY" }` — three keys,
no `network` field, because the schema is `.strict()` and has none. The chain
and the mint were **supplied by the owner**; nothing discovered or inferred them,
and a well-formed address is not a confirmed one — confirmation *is* the human
ACTIVE row.

The catalog's `projects.ticker` for `raydium` deliberately stays **null**.
Catalog ticker and canonical identity are separate concerns, and the domain
module says so itself: identity `ticker` is informational and never used for
matching, while the catalog column is the display authority.

Consequence, verified offline against the real gates without constructing a
retriever: the on-chain preflight now **passes** the identity gate and the
`chain === "solana"` gate, with `projectAnchor` =
`4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R`, and stops at the subject
provenance gate with `NOT_FOUND`. That is correct: `raydium` has no admitted
documentary locator and no derived subject, so nothing is eligible to be read
yet. Identity was never the last gate — it was the first.

**Two routes confirmed 2026-08-28, both unclassified** — `confirm-source-route.ts`,
each ACTIVE via `OBSERVED -> CANDIDATE -> ACTIVE`, each content exactly
`{ domain, pathPrefix }` with `routeClass` **absent rather than null**, because
the tool has no parameter for it and the documented shape treats absent and null
identically.

| row | prefix | resolves |
|---|---|---|
| `84774bb9-b10a-4519-8a69-7f1c3a6c0b93` | `/ray/ray-buybacks` | `CONFIRMED` / null / that prefix |
| `d09657e6-96b6-423e-9973-a2578cb71069` | `/raydium/protocol/protocol-fees` | `CONFIRMED` / null / that prefix |

The two are **disjoint**, which is the only reason the second could be added:
`OVERLAPPING_ACTIVE_PREFIX` refuses co-matching prefixes because two matching
path-scoped rows null `matchedPathPrefix` and would silently disable inspection
for urls both cover. Note the trap they avoid — `/raydium/…` is a string prefix
neighbour of `/ray/…` but not a **segment** prefix of it, and matching is
segment-bounded. Confirming the second changed the resolution of exactly two urls,
both inside the new prefix; `/ray/ray-buybacks` resolved byte-identically before
and after.

That opens **non-evidentiary inspection and nothing else**, verified against the
real gates: `evaluateInspectionEligibility` allows it, while
`evaluateDocsInspectionEligibility`, `evaluateRenderEligibility` and
`docsPayloadRecoveryEligible` all refuse with `NOT_OFFICIAL_DOCS`. Acquired as
Evidence today the page would classify `SOCIAL` — `resolveSourceClass` only
promotes an unrecognized host when a routeClass exists — and `SOCIAL` appears in
no component's `establishingClasses`, so it would establish nothing.

**Worth knowing before confirming a second route on that host: officiality is
domain-wide, matchedPathPrefix is not.** The resolver decides officiality by
domain match alone, so the whole of `docs.raydium.io` became `CONFIRMED` on the
first confirmation. Urls outside both prefixes — `/ray/treasury`,
`/raydium/protocol`, `/` — carry that officiality and **no capability**: their
`matchedPathPrefix` is null, so inspection denies them `NO_PATH_PREFIX`, and
their sourceClass stays `SOCIAL`. Prefix matching is segment-bounded, verified
both ways: `/ray/ray-buybacks/history` and `/raydium/protocol/protocol-fees/detail`
are inside their prefixes, while `/ray/ray-buybacks-extra` and
`/raydium/protocol/protocol-fees-extra` are not. A parent path is not covered by
its child's prefix either. `raydium.io` (a different host) stays `CLAIMED`.

**Inspected 2026-08-28 — the page was never read.** One owner window, MantaRay
off, zero retry:
`INSPECTION FAILED: NAVIGATION_FAILED:NAVIGATION_TIMEOUT`, with
`proxyDenials: 0 denied, 1 allowed` and every denial class at zero. No
`finalUrl`, no status, no bytes, no term scan, no links, no text — the script
prints those only after a successful render and printed none.

**Nothing about the page's content is known, and absence is not established.**
Whether Raydium documents a fee share, an executing address or a destination is
**unknown**, not absent. The route therefore stays ACTIVE and **unclassified**:
classification follows reading, and no reading occurred.

**What the closed signals do establish.** Not `BLOCKED_BY_ROUTE_POLICY`, so our
containment did not abort the main-frame navigation. Not
`UNCLASSIFIED_NAVIGATION_ERROR`, so this was Playwright's typed `TimeoutError`
rather than a reset or TLS failure — **the first time that diagnostic has fired
anywhere in this repository**; all four `fees.pump.fun` windows returned
`UNCLASSIFIED_NAVIGATION_ERROR`. And with `DNS_FAILED` and `BLOCKED_ADDRESS`
both zero, the stale-fake-IP hypothesis is refuted here too.

**What they do not establish, and why.** `1 allowed` is recorded at
policy-decision time, **before `netConnect` is attempted**; if the upstream
connect or TLS then fails, the error path destroys both sockets and records
nothing. So it proves DNS resolved and the address was public, and proves nothing
about the connection succeeding. Two readings survive and the local signals
cannot separate them: the server never answered, or the page answered and
`waitUntil: "networkidle"` never settled inside the 15s budget — ordinary for a
documentation SPA. That second reading was refuted for `pump.fun`, where the
timeout never fired; here the timeout is exactly what fired, so it is live again.
Separating them needs the tunnel-outcome diagnostic already named in
`BACKLOG.md` — and CORE_RULES' brake applies: that is engineering, not research.

**Second window, 2026-08-28: `/raydium/protocol/protocol-fees` — a different
failure at a different stage.** `INSPECTION FAILED: TIMEOUT`, again
`0 denied, 1 allowed`, no navigation diagnostic, no HTTP status, no finalUrl,
no content. **Two pages inspected, two windows spent, nothing read.**

**`TIMEOUT` is not `NAVIGATION_TIMEOUT`.** The buyback page threw inside
`page.goto`, so navigation never completed and no response ever existed.
`TIMEOUT` is raised by the renderer's own wall-clock check, and the two places
it can be raised are both **after** a navigation attempt:

1. child-side, `rendered-docs-playwright.ts` — the check sits *after* the
   `goto` try/catch, so reaching it means **`goto` returned without throwing**;
2. parent-side, `rendered-docs-isolated.ts` — the supervisor's hard deadline at
   `totalWallClockMs + 5_000` = 20s, for a child that never produced an envelope.

Both surface identically: reason `TIMEOUT`, provider `"isolated"` either way
(`TIMEOUT` is in `CHILD_REPORTABLE_RENDER_REASONS`, so the child's own is
re-thrown by the parent unchanged), no diagnostic, no status. **The printed output
cannot separate them** — the same shape of observability gap already closed three
times on this path.

**Reading 1 was later REFUTED for this page** by the post-fix window below, which
showed `goto` throwing on it. The pre-fix `TIMEOUT` was the parent-side one.

**A generic capability limit, found while reading the code and not specific to
Raydium.** `startedAt` is stamped at line 153, *before* `launch()` at line 178,
and `navigationTimeoutMs` and `totalWallClockMs` are **both 15_000**. So browser
launch is deducted from the same budget the navigation is measured against, and a
navigation that legitimately takes 14s and **succeeds** is discarded by the
post-check whenever launch cost more than a second. The renderer can therefore
throw away a completed navigation. Belongs in `BACKLOG.md`; not changed here.

**Third window, 2026-08-28, after the phase-budget fix: the same page returned
`NAVIGATION_FAILED:NAVIGATION_TIMEOUT`**, again `0 denied, 1 allowed`, again no
status, no `finalUrl`, no content. **The fix changed the diagnosis, not the
result.**

**It did explain the earlier `TIMEOUT`, and it retired a hypothesis of mine.**
The child's post-navigation wall-clock check sits *after* the `goto` try/catch,
so it is **structurally unreachable** when `goto` throws. This window shows
`goto` throwing on this page — so the pre-fix `TIMEOUT` cannot have come from
the child's check, and must have been the **parent's** deadline. The arithmetic
agrees: to report `NAVIGATION_TIMEOUT` the child must survive spawn + launch +
`goto`'s own 15s, while the old parent deadline was a flat 20s — leaving under
5s for spawn and launch, when the self-test alone measured 7,095 ms cold. The
parent was killing the child mid-navigation and reporting its own impatience as
the render's outcome. Deriving the deadline removed that race; the
phase-boundary half of the fix was **not** implicated here, because `goto` never
returns on this page.

**Host-wide, not page-specific — LATER REFUTED (see the fifth window below).**
This was concluded while both pages were being judged by `networkidle`, which
hid that they behave completely differently. Recorded as written, then
overturned. **Both** Raydium pages, at two unrelated prefixes, returned the same
closed reason: `waitUntil: "networkidle"` never settles within 15s. Neither is a containment refusal, neither carries a
proxy denial of any class, and neither produced an `HTTP_ERROR`. **Nothing
observed says the site refused ATLAS** — the wait condition is simply not
reached on this host, which is ordinary for a documentation SPA holding
persistent connections.

**That wait condition was removed generically 2026-08-28** — see "Document
readiness" above. It was not a one-line swap: returning at `domcontentloaded`
alone would have accepted the unsettled shell Stage 1 exists to reject, so the
shell rule became the acceptance test instead of a mere trigger.

**Fourth window, 2026-08-28, after the readiness fix: `HTTP_ERROR:404`.** Again
`0 denied, 1 allowed`. The page was still not read — but for the **first time in
four windows a status was obtained at all**, which is the thing every previous
window failed to reach.

**The renderer worked; the resource does not exist.** `HTTP_ERROR` is raised
only after a real Response with a trusted numeric status, and it is raised
*before* the readiness wait — so readiness was never evaluated and is not
implicated. Under the old contract this page could never report a status,
because `networkidle` never arrived; the 404 was there all along and was
invisible.

**404 is an absent page, not a refusal of ATLAS.** The code-owned refusal set is
`401/403/429`; `404` is deliberately outside it — "the page is absent, and
rendering does not invent one". So no anti-bot behaviour is indicated, and none
should be inferred.

**What this establishes, and what it does not.** Established: at that moment,
`https://docs.raydium.io/raydium/protocol/protocol-fees` returned **404**. Not
established: that the page never existed, that Raydium publishes no protocol-fee
documentation, that some other path would also 404, or anything at all about
`/ray/ray-buybacks` — which has never returned a status and whose three
`NAVIGATION_TIMEOUT`s remain unexplained.

**Consequence for the route.** `d09657e6-96b6-423e-9973-a2578cb71069` is an
ACTIVE route whose own url is absent. The domain confirmation is untouched —
officiality is a statement about the host — but the prefix points at nothing.
Superseding or replacing it is an **owner act**, and finding a correct path is
discovery, which no owner tool may perform.

### Fifth window, 2026-08-28: `/ray/ray-buybacks` under the new contract

`NAVIGATION_FAILED:NAVIGATION_TIMEOUT` again, `0 denied, 1 allowed`, no status.
The reason is unchanged from its first window — but it now means something much
stronger, because the milestone changed. The old contract waited for
`networkidle`; this one waits only for **`domcontentloaded`**, which fires when
the initial HTML is parsed. **This url does not deliver a parseable document at
all within 15s.**

**My "host-wide" conclusion is refuted.** In the same period, on the same host,
with the same proxy and the same budgets, `/raydium/protocol/protocol-fees`
returned a **404 status promptly**. `docs.raydium.io` is therefore reachable and
responsive; the stall belongs to this one url, not to the host. The earlier
reading was an artefact of judging both pages by `networkidle`, which hid that
they behave completely differently.

**No other host was involved.** The route handler filters by **host**, so a
cross-host redirect would have surfaced as `BLOCKED_BY_ROUTE_POLICY` or as a
`HOST_NOT_CONFIRMED` proxy denial. Neither appeared, and every denial class is
zero. Note the corollary: a **same-host** redirect is *not* filtered by path, so
a redirect chain within `docs.raydium.io` would pass containment silently and
would look exactly like this.

**Three readings survive, unseparated by any closed signal**: the server never
answered for this path; a same-host redirect chain never settled into a parsed
document; or the connection stalled after CONNECT. The tunnel-outcome blind spot
named in `BACKLOG.md` is why the last one cannot be excluded — `1 allowed` is
recorded at policy-decision time, before `netConnect`.

**Status of the Raydium documentary path: both browser-facing urls are
unreadable**, for two different and clearly distinct reasons — one absent, one
unresponsive. Five live windows produced no first-party text.

### A third route, from Raydium's own current index (2026-08-28)

The owner independently read `https://docs.raydium.io/llms.txt` — the site's
current first-party documentation index — and reports that it advertises
canonical **Markdown** urls, among them `/ray/ray-buybacks.md`,
`/ray/protocol-fees.md` and `/ray/treasury.md`.

**That index is an owner-supplied lead and nothing more.** Its content is not
Evidence, has not been acquired through the pipeline, and no mechanism claim
follows from it. It explains the earlier `404`, without proving anything: the
browser-facing paths this project confirmed are apparently not the paths the site
now advertises.

`/ray/ray-buybacks.md` is confirmed as a third ACTIVE route,
`52084c53-6e55-40fa-a7d4-66550b0e2771`, unclassified, disjoint from both
others — `.md` does not begin a new path segment, so it is **not** under
`/ray/ray-buybacks`, verified with the real predicate in both directions rather
than inferred from the strings. The other two Markdown urls are **not** confirmed:
one route per owner act.

**Sixth window, 2026-08-28: the Markdown surface READ.** First readable page in
six windows. `finalUrl` identical to the request and inside the route,
`htmlBytes 3124`, `renderedLength 2939`, `blockedRequests 0`, `durationMs 3158`,
`contentHash sha256:f71a3dd3…`. A success status by construction — `HTTP_ERROR`
fires on anything outside the success class.

**It was served as plain text, not HTML.** `anchors: 0, identifiers: 0, hosts:
(none)` while the text itself contains a Markdown link — so the browser wrapped a
raw document rather than parsing a DOM. That is why the `.md` surface worked
where the SPA representation never delivered one. Consequence for locators:
there are **no hrefs at all**, so every identifier is either fully literal in the
text or unavailable — no truncated-plus-href recovery exists on this surface, and
none is needed.

**INSPECTION ONLY — none of the following is Evidence.** The document has not
been acquired through the pipeline, the route is still unclassified, and nothing
below is a verified finding about Raydium. It is what one first-party document
was observed to say.

**What the document states.** `12%` of Raydium trading fees buy back RAY, applied
to the trading fee rather than the trade amount. Splits: CLMM and CPMM
`84/12/4` LPs/buybacks/treasury, Standard AMM v4 `88/12` LPs/buybacks. Four
addresses appear, each **structurally valid for Solana** and each carrying an
explicit role in the same statement or table that names it:

| address | stated role |
|---|---|
| `projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416` | CLMM protocol fee collection |
| `ProCXqRcXJjoUd1RNoo28bSizAA6EEqt9wURZYPDc5u` | CPMM protocol fee collection |
| `PNLCQcVCD26aC7ZWgRyr5ptfaR7bBrWdTFgRWwu2tvF` | Standard AMM v4 protocol fee collection |
| `DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz` | **where bought-back RAY is held** |

**This is the address-level role assignment PUMP never had.** The PUMP bridge
failed because no single text contained both an address and any acquisition verb.
Here "Bought-back RAY is held at:" is immediately followed by the address, and the
collection table's own column is "Collection address" under a sentence stating
that protocol-side fees are collected by those addresses.

**Supply effect: HELD, not burned.** The document says bought-back RAY "is held by
the protocol at a public on-chain address" and speaks of "RAY accumulation".
`burn` is **absent** from the page — confirmed by the term scan, not by reading
impression. This is exactly the `buyback != supply reduction` invariant Raydium
was selected to exercise, and nothing here may be read as a burn.

**The chain gate is still locked, and the reason is precise.** *(True at
inspection time; SUPERSEDED — see "THIRD Stage B window" above.)* Verified:
`findAdmittedLocator` returns **0** rows for the holding address and
`resolveOnchainSubject` still returns `NOT_FOUND`. A locator becomes admissible
only from an Evidence row whose `sourceClass` is in
`ADMISSIBLE_LOCATOR_SOURCE_CLASSES` (`OFFICIAL_DOCS`, `GOVERNANCE`,
`OFFICIAL_REPORT`) — the condition the third window finally satisfied.

**Classified 2026-08-28 — `OFFICIAL_DOCS`.** `classify-source-route.ts`, by
replacement and supersession in one transaction: the unclassified row
`52084c53-…` moved to `SUPERSEDED` with `supersededBy` pointing at the new
ACTIVE row `dbe81df6-b197-48c4-938f-b03ea8d37e50`, which carries the same domain
and the same prefix **verbatim** plus the class. The superseded row was never
edited — its content is still the unclassified original, which is the history the
lifecycle graph exists to keep.

`https://docs.raydium.io/ray/ray-buybacks.md` now resolves `CONFIRMED` /
`OFFICIAL_DOCS` / `/ray/ray-buybacks.md`, and `resolveSourceClass` returns
**`OFFICIAL_DOCS`** where it returned `SOCIAL` before. Documentary acquisition,
Stage-0 payload recovery and renderer-as-Evidence are all now eligible for this
exact prefix. Owner inspection is correspondingly **refused** with
`ALREADY_CLASSIFIED` — the two gates are mutually exclusive by construction, and
inspection exists only for the undecided case.

**No scope widened.** Across seven urls exactly two changed: the route itself and
one path beneath it. `/ray/ray-buybacks` and `/raydium/protocol/protocol-fees`
resolve **byte-identically** and remain unclassified; `/ray/protocol-fees.md`,
`/ray/treasury.md` and `/` are untouched. Three ACTIVE routes, never four.

**The chain gate is still locked, and that is the point.** *(True as
written; SUPERSEDED — the third Stage B window later acquired the page and
opened the gate. See "THIRD Stage B window" above.)* Verified after
classification: `findAdmittedLocator` returns **0** rows for all four addresses
and `resolveOnchainSubject` still returns `NOT_FOUND`. Raydium still has **0
Evidence and 0 jobs**. **A classified route is not Evidence** — it only makes
acquisition possible. The locators become admissible when the page is acquired
through the normal pipeline, and not before — which is exactly what
eventually happened.

**Acquisition is no longer blocked.** `raydium` was added to
`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS` 2026-08-28, which is now exactly
`{ pump_fun, raydium }` — a closed enumerated set, verified by test, registered
post-factum as **D-126** (allowlist) and **D-127** (documentary-only mode). All four
prerequisites pass. A new `--mode=documentary-only` makes chain work refused **by
instruction rather than by state**; see `ARCHITECTURE.md`. The paragraph below
records the position that held before that change.

**Previously — acquisition was blocked by a code-owned safety allowlist, not by authority.**
`alpha-acquire-url.ts` refuses any project outside
`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`, which is the hard-coded set `{ pump_fun }`.
Three of its four prerequisites already pass for `raydium` —
`internal_alpha_enabled` true, `ANTHROPIC_API_KEY` set, and a model cost profile
resolving for `claude-haiku-4-5` — and the route gate itself passes. **Only the
allowlist refuses.** Widening it is an owner decision about which projects may
spend money and make live calls; it is deliberate, and `gates-owner-alpha.test.ts`
pins it.

**A caveat that will matter on the SECOND acquisition, not the first.** The S4
executor has a structured on-chain branch driven by `admittedLocatorsForJob`,
which is scoped by **project** — not by job — and admits a locator only when it
is `literallyPresent`, `validationResult CONFIRMED`, on Evidence that is
`officiality CONFIRMED` with a `sourceClass` in the admissible set, from a source
that is not `BROKEN`, capped at 8. Raydium has none today, so a first run cannot
reach RPC **by state**. Once documentary Evidence carries those locators, a later
run of the same script in its **default mode** would enter that branch and
issue real RPC — which is exactly why `--mode=documentary-only` exists
(D-127): in that mode the branch is not entered at all, whatever the database
holds. The script's operator contract now states chain work as conditional;
its old "no chain call" claim was removed in `b5a95aa`.

**Nothing about either page's content is known.** Fee source, allocation share,
executing address, destination and supply effect are all **unknown, not absent**.
Both routes stay ACTIVE and **unclassified**.

### First production acquisition attempt (2026-08-28) — FAILED at the fetcher

Owner-run once, `--mode=documentary-only`, job
`451770c3-2e64-4e27-9d3e-cf8263b876d2`. Terminal outcome:
`CONTENT_FETCHER_FAILED:ContentFetchError:UNSUPPORTED_CONTENT_TYPE`.

**No Evidence was created** — 0 Evidence, 0 sources, 0 locators, 0 on-chain
artifacts. `findAdmittedLocator` is still **0** for all four addresses and
`resolveOnchainSubject` still returns `NOT_FOUND`. **The chain provenance gate
remains locked**, and nothing about the buyback mechanism is established.
*(State of this run only; SUPERSEDED by the third Stage B window above.)* The
only rows this run created are the job itself, six trace events, and one S5
component result: step 6 `DESTINATION` = `INSUFFICIENT_EVIDENCE` /
`NO_EVIDENCE_FOUND` — the correct fail-closed outcome.

**The cause is a transport-contract mismatch, not the page.** The static
`ContentFetcher` admits exactly `text/html`, `text/plain`,
`application/json`, `application/xml`. `text/plain` **is** on that list, so the
server answered with something outside it — most plausibly `text/markdown`,
though the exact header is **not recorded**: `safeFailureReason` deliberately
strips provider messages, so only the reason code survives. The same document
was read end-to-end in the browser inspection window, so the page is readable —
**ATLAS's static path simply cannot ingest this representation.**

**The render fallback correctly did not fire.** `evaluateRefusalRenderEligibility`
is scoped to the code-owned refusal statuses `{401, 403, 429}`; an
`UNSUPPORTED_CONTENT_TYPE` error carries **no** HTTP status (the constructor is
called without one), so the gate returns `NOT_A_RENDERABLE_REFUSAL`. The
renderer exists for pages that refuse ordinary clients, not for content-type
mismatches. Widening it would be the wrong fix.

**D-127 held.** `chain work: DISABLED by owner instruction — branch not
entered`, observation `ONCHAIN_DISABLED_DOCUMENTARY_ONLY`, zero on-chain
artifacts created. No RPC, and the mode — not the empty locator table — is what
guaranteed it.

### Second production attempt (2026-08-28) — the transport cleared, the extractor did not

Owner-run once, same command, job `4b437b14-1cf8-4637-8539-e0e1e4835e62`.
Terminal outcome: `CapabilityFatalError: capability unavailable:
EVIDENCE_EXTRACTOR_COUNT_TOKENS`.

**The Markdown fix worked — proved by a controlled before/after.** The same url
traced `FETCH_ATTEMPTED -> FETCH_FAILED` in run 1 and
`FETCH_ATTEMPTED -> **FETCH_OK**` in run 2, with the only intervening change
being the two lines admitting `text/markdown`. So the server's essence is
`text/markdown` on the strength of that controlled delta — **the header value
itself is still not persisted anywhere**, and `FETCH_OK` records no content
type, so this remains inference from the change, not a stored observation.

**The new blocker is the model provider, not the document.** The run reached
`EXTRACT_ATTEMPTED` (reservation 55,680 micro-USD) and then a single
`MODEL_CALL_ATTEMPTED / EXTRACT / FAILED / PROVIDER_ERROR`. A
`TokenCountUnavailableError` from `countThenGate` is classified **immediately
fatal** — count_tokens has already spent its own internal
`retryOnceIfTransient` inside `token-gate.ts` before throwing, so the executor
does not retry it. Exactly one extraction attempt was made.

**Why it failed was not recoverable from anything persisted — a gap CLOSED the
same day** (see "count_tokens failure names its cause" in `ARCHITECTURE.md`):
the next such failure will read
`capability unavailable: EVIDENCE_EXTRACTOR_COUNT_TOKENS — …:<CLASS>[:<status>]`
from a closed vocabulary. The run recorded below predates that fix, so its
cause remains genuinely unknown. As recorded at the time:

### Stage A succeeded (2026-08-28): the buyback document is persisted and sealed

First production run of the D-128 path, MantaRay OFF, job
`983d8ebb-71ab-41f7-b2e9-54a071722647`. `acquired_documents` row
`711e6745-abc1-44c0-b4a0-4d3eb449b7df`: project `raydium`,
url = finalUrl = `https://docs.raydium.io/ray/ray-buybacks.md`, HTTP 200,
**`content_type = text/markdown` — now PERSISTED, retroactively confirming
what was previously only inferred from the fetch-fix delta**, 2,940 bytes /
2,939 chars, `renderMode STATIC`, authority snapshot
`CONFIRMED / OFFICIAL_DOCS / /ray/ray-buybacks.md`, unconsumed. Seal verified
offline: recomputed sha256 of the stored text equals `text_sha256`.

**Cross-transport confirmation:** the stored `text_sha256`
(`sha256:f71a3dd3…`) is byte-identical to the content hash the browser
inspection window reported for its rendered text — two different transports,
one identical document, unchanged between windows. All four role-bound
addresses are literally present in the stored text (verified in the DB, not
from memory).

Stage A created exactly what D-128 promises **plus one row worth naming
honestly**: the executor's pre-existing bookkeeping creates a url-registry
`sources` row after any successful document handling — even with zero facts —
so `sources` gained one row (`sourceType OTHER`, `health UNKNOWN`, no
content, no authority). That is production behaviour older than D-128, and the
row is not Evidence and establishes nothing. Otherwise: 0 Evidence, 0
locators, 0 artifacts, 0 attempts, no component result, chain gate still
locked, trace shows the real `safe-http` fetch and the `document-capture`
stub.

**Stage B ran (2026-08-28, MantaRay ON, job `b3457f0b-…`) and D-128 did its
job end to end** — cross-process resume, live seal verification, authority
re-confirmed `CONFIRMED / OFFICIAL_DOCS` at both ends, the replay transport
(`acquired-document-replay`) served the stored document with **zero external
fetch**, the documentary-only chain guarantee held, and when extraction failed
the document was **not consumed and remains resumable** — the Raydium fetch was
neither lost nor repeated, which is precisely what the seam was built for.

**The extraction itself failed — for the first time on the GENERATION side.**
The real `anthropic` extractor was invoked for the first time in any Raydium
job; `count_tokens` passed (a count failure is fatal-classified and would have
crashed — it did not), consistent with the MantaRay-ON probe. One attempt, no
transient-retry row, `EXTRACT_FAILED / PROVIDER_ERROR`, outcome
`FAILED / EVIDENCE_EXTRACTOR_UNAVAILABLE`, S5 for this job
`INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. Usage columns are all **null**,
which was read at the time as narrowing the cause to exactly two closed
candidates — a non-transient 4xx or a `max_tokens` truncation — by excluding
JSON/schema failures, "which record usage first". **That narrowing was
REFUTED by the first post-fix window (below).** The capture-ordering premise
is real but in-memory only (`onUsage`); the persisted usage columns are
written solely on the success-path `MODEL_CALL_ATTEMPTED` row
(s4-executor.ts), so every failure class leaves them null, and the post-fix
window — a **known** `OUTPUT_SCHEMA_INVALID` failure — left a trace shape
byte-identical in structure to this job's. Corrected statement: this job's
cause is one of the four non-transient classes — non-transient 4xx,
`MAX_TOKENS_TRUNCATED`, `OUTPUT_NOT_JSON`, `OUTPUT_SCHEMA_INVALID` — and
which one is not recoverable from anything persisted. The observability gap
itself was **CLOSED the same day** (see "A generation failure names its
cause" in `ARCHITECTURE.md`); this run predates the fix and the new
vocabulary is never applied retroactively.

### THE DOCUMENTED ADDRESS DOES OWN RAY TOKEN ACCOUNTS (2026-08-29, job `ce359a54-…`)

One owner window ran `onchain-observe-token-accounts.ts` on
`DdHDoz94o2WJ…` (`raydium DESTINATION 6`). One RPC
(`getTokenAccountsByOwner`, `finalized`), zero retries, no pagination, no
follow-up read.

**Established at slot `442456294`:** the address owns **six** SPL token
accounts whose mint is the confirmed RAY mint. Each is an independent
position, and production authored **one fact per account** — never a total,
because the chain reported none:

| token account | raw amount (6 decimals) |
|---|---|
| `E5BMFn1mzTGuFWzNHZ7cybWfzetmqhFKS7SM91N5WePU` | 39064464475794 |
| `BEVT2yGq2rvvPCnMipktFWxJaouidExC7scW9GHhMuzi` | 23497797799450 |
| `FpDWkidnRD6pWzYZAnDWEU3kC1hXSmQSqhd9w4nMCn1` | 15363003294153 |
| `BnTSNB2VqsUGiauSfwfyQBdFwPYnteb1M69Y1VXziP5u` | 6708471002739 |
| `G7rxL8ySm5qPbtTus9FhAn2nEAZn8DDsUEeHGXgWTP1x` | 19940152952 |
| `GX4HMQz73cHETFMMW4SsCG5dYnWG8DYZYLhMMzV6ZfuC` | 0 |

**No aggregate is stated anywhere** — not in Evidence, not here. Summing six
independent positions would invent a figure the chain never reported, and the
one zero-balance account is a position like any other, not evidence that
anything left it.

**Persisted:** artifact `6b3dc314-…` (`TOKEN_ACCOUNTS_BY_OWNER`, slot
`442456294`, `finalized`, `rawHash sha256:b2ff4751…`, `artifactHash
sha256:636b7d2e…`, binding `CONFIRMED`), six Evidence rows — all step 6
`DESTINATION`, `ONCHAIN_VERIFIABLE` / `CLAIMED`, `entityBinding CONFIRMED`,
**`CONTEXT` / `DIRECT`**, `onchainArtifactId` set — and six derived subjects
(`TOKEN_ACCOUNT`, parent = the queried address). The derived subjects were
**recorded only**: nothing was read from them, no intent was promoted, and no
second RPC occurred.

**S5 for this job: `INSUFFICIENT_EVIDENCE` / `["ALL_EVIDENCE_EXCLUDED"]`**,
with all six excluded as `RELATIONSHIP_NOT_SUPPORTING`. That is correct and
worth stating as a rule: **a holding observation is authored `CONTEXT`, so it
can never establish `DESTINATION` on its own.** Where value *is* is not the
same statement as where value *ends up by mechanism*, and the reconciler
enforces the difference rather than trusting the reader.

**What this does and does not settle.** It settles that the documented address
holds RAY at that slot — the documentation's claim is now *consistent with*
chain state instead of unexamined. It settles nothing about **how** any
balance arrived: no buyback, no fee flow, no revenue, no burn, no permanence,
no accumulation over time, and no institutional control. The owner field is
RPC metadata and names no organisation. A balance is a position at a moment.

### FIRST PERSISTED ON-CHAIN EVIDENCE IN THE REPOSITORY (2026-08-29, job `9d488cc6-…`)

One owner window ran `onchain-observe-account.ts` on `DdHDoz94o2WJ…`
(`raydium DESTINATION 6`). **The chain-to-Evidence path closed end to end for
the first time**: one RPC → artifact → synthesized fact → Evidence carrying
`onchainArtifactId` → reconciliation. Before this, every deterministic chain
fact in this repository lived in a standalone artifact and no Evidence row
referenced one — the single most valuable thing PUMP left untested.

**The observation repeated the earlier characterization at a fresh slot**
(`442446081`, `finalized`): exists, `ownerProgram`
`11111111111111111111111111111111`, `executable false`, `lamports
7823801354`, `NOT_TOKEN_PROGRAM_OWNED`, `tokenAccount null`, binding
`CONFIRMED`. Nothing new about the account was learned; what is new is that it
is now durable Evidence rather than terminal output.

**Persisted:** artifact `84915cd0-…` (`RESEARCH_JOB` origin, source
`28cfd151-…` = the `atlas-onchain://…/info` URI, `sourceType ONCHAIN`,
`getAccountInfo`, `rawHash sha256:fb61e136…`, `artifactHash
sha256:ae1b7ae1…`); Evidence `7770000d-…` — step 6 `DESTINATION`,
**`ONCHAIN_VERIFIABLE` / `CLAIMED`**, `entityBinding CONFIRMED`, `SUPPORTS` /
`DIRECT`, `mechanismState null`, `publishedAt null`, `onchainArtifactId` set.
Exactly **one** artifact and **one** Evidence row; no duplicate artifact hash
exists anywhere in the table.

**The job is truthful and minimal:** `original_question` = "observe on-chain
account … for component DESTINATION", task = "perform one bounded
ACCOUNT_INFO read of one admitted on-chain subject", and all three reserved
budget axes are **0** — no search, no source open, no model spend was
authorized, and none happened. It writes **no trace rows** (0 for this job),
consistent with the rest of the owner tooling.

**D-074 held, visibly.** Reconciliation for this job alone returned
**`PARTIALLY_SUPPORTED` / `["INSUFFICIENT_AUTHORITY"]`** — the reason code
emitted precisely when the best establishing row's officiality is `CLAIMED`.
A canonical chain read cannot independently exceed the ceiling, and here that
is not a doc claim but an observed result.

**The documentary result was not touched.** Job `baf42b79-…` still carries
`SUPPORTED` / `[]` with its four `OFFICIAL_DOCS` / `CONFIRMED` rows;
reconciliation is job-scoped, so the five `DESTINATION` results now stand side
by side (three `INSUFFICIENT_EVIDENCE`, one `SUPPORTED`, one
`PARTIALLY_SUPPORTED`), each honest about the Evidence its own job held.

**The two statements remain separate, and this is the point of the case.**
The documentation *states* bought-back RAY is held at that address; the chain
says only that the address is a System-Program account. **Neither confirms the
other.** No buyback, no burn, no balance, no history and no institutional role
is established, and `NOT_TOKEN_PROGRAM_OWNED` still does not mean "owns no RAY
token account".

### FIRST RAYDIUM ON-CHAIN READ (2026-08-28, owner window): the holding address is a SYSTEM-PROGRAM account, not a RAY token account

One owner-authorized window, MantaRay OFF, `onchain-account-check.ts` on
`DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz` with project `raydium`. **One
RPC, zero retries, nothing persisted** — verified afterwards in the DB: 0
raydium on-chain artifacts, 0 artifacts created since the window, all four
Evidence rows still `onchain_artifact_id` null, `DESTINATION` S5 unchanged at
`SUPPORTED` / `[]`.

**Established, deterministically, at slot `442384428` (`finalized`):** the
account **exists**; `ownerProgram` = `11111111111111111111111111111111` (the
System Program); `executable: false`; `lamports: 7823801354`;
`tokenAccountRelation` = **`NOT_TOKEN_PROGRAM_OWNED`** — an established
negative, returned only when the owning program is not an SPL Token program,
never an unresolved one. `tokenAccount` is `null`, so **no mint, no
token-account owner, no token amount and no decimals were obtained**.
`binding: CONFIRMED`. `rawHash sha256:5e2086a6…`, `artifactHash
sha256:ae1b7ae1…`.

**The documented holding address is therefore NOT itself a RAY token
account.** A System-Program account cannot hold SPL tokens directly; SPL
balances live in separate token accounts such an address may own. That is a
technical prerequisite, and it is the whole of what this read settled.

**It establishes nothing economic.** Not that a buyback occurred, not that
RAY was burned or removed, not who controls the account, not that anything
was ever sent there. The 7.82 SOL of lamports is a native position at one
slot — not a RAY balance, not a history. The documentary claim that
bought-back RAY is held here **remains documentary**; this read neither
confirms nor contradicts it, and **documentary role has not become a chain
fact**.

**The justified next read is `TOKEN_ACCOUNTS_BY_OWNER`** for the confirmed RAY
mint on this same address — which is also what the production promotion rule
derives independently (`NOT_TOKEN_PROGRAM_OWNED` → `ACCOUNT_TO_TOKEN_ACCOUNTS`,
permitted for `DESTINATION`). An answer of "owns no RAY token account" would
be a genuine finding, not a failure.

**The persistence gap was confirmed at the time of this read:** `ACCOUNT_INFO`
had no persisting sibling, and `persistOnchainArtifactAndFacts` requires a
`jobId` because `evidence.research_job_id` is NOT NULL — so on-chain Evidence
exists only inside a research job. *(The gap was closed the same day —
`scripts/onchain-observe-account.ts`, offline, never yet run live; see
`ARCHITECTURE.md`. **This read's result was NOT imported into it** — the
later persisting run performed its own fresh read at slot `442446081`.)* **At
the time of this read, no Raydium on-chain fact had entered Evidence**; one
has since — see "FIRST PERSISTED ON-CHAIN EVIDENCE" above.

### THIRD Stage B window (2026-08-28, job `baf42b79-…`): EXTRACTION SUCCEEDED — Raydium has documentary Evidence, and the chain gate is OPEN

**This run was executed by the owner outside the analysis rounds below; the
account here is read from persisted state, not from having run it.** It
supersedes every "raydium has 0 Evidence / the chain gate is locked"
statement elsewhere in this file. Created 2026-08-28T16:04:01Z — nine
minutes after the failing `eb00256a-…` — with the same command and the same
sealed document. **Model output varies between runs; this one satisfied the
schema.**

**What was created (verified in the DB).** Twelve trace rows: one
`EXTRACT_ATTEMPTED`, one `MODEL_CALL_ATTEMPTED` carrying **real usage —
input 2,627, output 1,078, actual cost 8,017 micro-USD** (the first
persisted real extraction usage anywhere in this project), then four
`EXTRACT_OK`. **Four Evidence rows**, all step 6 / `DESTINATION`, all
`OFFICIAL_DOCS` / `CONFIRMED`, all `onchain_artifact_id` **null**, all
pointing at the single Stage A `sources` row (no new source was created),
`retrievedUrl` = `https://docs.raydium.io/ray/ray-buybacks.md`:

| relationship | locator | statement (model-extracted) |
|---|---|---|
| **SUPPORTS** / DIRECT | `DdHDoz94o2WJ…` | bought-back RAY **is held at** that address |
| CONTEXT / DIRECT | `projjosVCPQH…` | CLMM protocol-side fee collection |
| CONTEXT / DIRECT | `ProCXqRcXJjo…` | CPMM protocol-side fee collection |
| CONTEXT / DIRECT | `PNLCQcVCD26a…` | Standard AMM v4 protocol-side fee collection |

Four documentary locators were created, ordinal 0, shape `ADDRESS_LIKE`.
**S5 for this job is `SUPPORTED`** with an empty reason-code list — the first
component ever to reach `SUPPORTED` for `raydium`, and the first time the
address-level role assignment PUMP never had has carried through to a
component result.

**THE CHAIN GATE IS NOW OPEN — verified against the real functions, offline,
with no RPC.** For all four addresses `findAdmittedLocator` returns **1** row
(`OFFICIAL_DOCS` / `CONFIRMED`) and `resolveOnchainSubject` returns
**`ELIGIBLE` / `DOCUMENTARY_LOCATOR`**, where both returned 0 / `NOT_FOUND`
before. Nothing has been read on-chain: **0 on-chain artifacts** for this job
(D-127 held — documentary-only, branch not entered). What changed is
eligibility, not knowledge.

**The document was CONSUMED** at 2026-08-28T16:04:08Z by this job
(`consumed_by_job_id = baf42b79-…`), exactly as D-128 specifies once Evidence
is persisted — further resumes are refused. The seal still verifies. The
"unconsumed and resumable" statements in the two windows below were true when
written and are now superseded.

**What this does NOT establish.** `entity_binding` is **null** on all four
rows. The statements are model-extracted from one first-party document —
Evidence, not proof — and each is a claim about what Raydium publishes, not
an observation of on-chain behaviour: no buyback, no fee flow and no holding
has been verified on-chain, and none may be inferred. **Supply effect stays
HELD, never burned** — the invariant Raydium was selected to exercise. The
three collection addresses are `CONTEXT`, which establishes nothing on its
own.

### Second Stage B window (2026-08-28, post-fix, job `eb00256a-…`): the terminal line named the cause — `OUTPUT_SCHEMA_INVALID`

One owner-authorized run of the same command, MantaRay ON, on HEAD `95bd370`
(the diagnostic fix). Terminal outcome:
`FAILED / EVIDENCE_EXTRACTOR_UNAVAILABLE; source-route observations:
ONCHAIN_DISABLED_DOCUMENTARY_ONLY, EXTRACT_FAILED:OUTPUT_SCHEMA_INVALID`.

**What the closed diagnostic establishes, by construction of its branch:**
count_tokens passed; `messages.create` returned a response (no provider
class fired); `stop_reason` was not `max_tokens` (that branch precedes);
`JSON.parse` succeeded; the parsed JSON **failed the extraction schema**.
The model produced complete, syntactically valid JSON that does not match
`extractionResultSchema`. Exactly one attempt (non-transient, no retry row —
trace verified: one `EXTRACT_ATTEMPTED`, one `EXTRACT_FAILED /
PROVIDER_ERROR`, eight rows total, same shape as `b3457f0b-…`). **Which
schema field failed is deliberately not recoverable** — the zod message is
model-derived text and never crosses; the closed class is the entire safe
statement today.

**Noted, not inferred further:** the request carries provider-side
structured output (`output_config` built from the same zod schema), and the
output still failed the local `safeParse` — the two enforcement layers do
not coincide on this schema. Which constraint diverged is unknown.

**Everything else held, verified in the DB after the run:** 0 Evidence for
raydium (all five jobs), 0 documentary locators, 0 locator rejections, 0
on-chain artifacts for both Stage B jobs (D-127: `branch not entered`),
exactly one `sources` row for `docs.raydium.io` (Stage A's bookkeeping row —
neither Stage B run added one), S5 for this job persisted as its own
`INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND` row, and the acquired document
is **unconsumed and resumable** (`consumed_at` null; the
`DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz` role binding is literally
present in the stored text at char 1935). The chain gate is unchanged, run
against the real functions: `findAdmittedLocator` = 0 and
`resolveOnchainSubject` = `NOT_FOUND` for all four role-bound addresses.

**Two honest caveats.** Real generation tokens were spent on this run
(generation completed; usage was captured in-memory) but the actual figures
are persisted nowhere — only the 55,680 micro-USD reservation ceiling is on
record, and no spend number should be quoted. And the closed diagnostic
itself survives **only in the terminal line** for an owner-tooling run: the
trace row stays `PROVIDER_ERROR` (no enum migration, by design), no
`research_attempts` row exists, and the job row records no termination —
the pasted output is the record. Both are BACKLOG candidates, not defects.

**Previously — Stage B had not run in substance.** The owner's invocation passed the
literal placeholder `<DOCUMENT_ID>` instead of the real uuid; the script died
at the row lookup on Postgres uuid parsing — before any job, fetch, or model
call. The document remains unconsumed and resumable; the correct command is in
`CURRENT_TASK.md`. Hardening noted in BACKLOG: a malformed id currently
surfaces as a raw driver error instead of the closed `NOT_FOUND` refusal.

**Two owner probe runs (2026-08-28) split the failure cleanly.** With MantaRay
ON the count_tokens probe returned SUCCESS (input_tokens 14, 1 attempt); with
MantaRay OFF it returned `PERMISSION_DENIED:403` (1 attempt). Established:
Anthropic is reachable OFF and returned an explicit 403 there, while the same
credential/model succeeds ON. The CAUSE of the 403 is deliberately not
inferred. Since the document host needs OFF and the provider currently needs
ON, acquisition and extraction are now separable stages — see "Two-stage
acquisition" in `ARCHITECTURE.md` (D-128): `acquire-document.ts` persists the
validated document (no model, no Evidence, no RPC), `extract-from-document.ts`
resumes extraction from storage (no external fetch). PERSISTED DOCUMENT ≠
EVIDENCE.

**A provider-only probe now exists** — `scripts/anthropic-count-tokens-probe.ts`
(owner-run, MantaRay ON): one countTokens capability check using the production
client construction, config model id, retry composition and closed diagnostic;
at most 2 provider requests, zero generation, zero DB writes, no research
surface in its import graph (pinned by a boundary test). It separates
"the capability works at all" from "the acquisition process works". `safeFailureDetail` extracts a status only for `ContentFetchError`;
for this error class it returns null, so the reason is the bare
`EVIDENCE_EXTRACTOR_FAILED:TokenCountUnavailableError`. `CapabilityFatalError`'s
message carries only the capability name, the computed reason travels as an
unprinted `cause`, and the trace row's reason code is the generic
`PROVIDER_ERROR`. **Nothing distinguishes a bad credential (401), an
unrecognised model id (404), an exhausted rate limit (429) and a provider
outage (5xx)** — and those call for completely different next actions. The model
id sent is `claude-haiku-4-5` (config default; its cost profile resolves).

**Nothing was persisted beyond the job and eight trace rows.** No Source (source
creation happens at Evidence-persist time, which was never reached), no
Evidence, no locators, no artifacts, and **no component result** — the exception
propagated out of `executor.execute()` before the script's S5 call, so unlike
run 1 this job has no reconciliation row. The chain gate is unchanged:
`findAdmittedLocator` 0 for all four addresses, `resolveOnchainSubject`
`NOT_FOUND`.

**D-127 held again**: `chain work: DISABLED by owner instruction — branch not
entered`, zero on-chain artifacts, and no retriever resolved.

**One process-level observation, not a research finding.** After the fatal
error the process aborted during teardown with a libuv assertion
(`!(handle->flags & UV_HANDLE_CLOSING)`, `srcwinasync.c`). All trace writes
had already committed, so no data was lost, but the cleanup path is not
crash-clean on Windows when `execute()` throws.

**One reporting nuance worth keeping.** The trace carries one
`MODEL_CALL_ATTEMPTED` row (`QUERY_PROPOSE`, 6,560 micro-USD) and `spent`
reports `authorizedModelCostMicro: 6560`. That is the **reserved authorization
ceiling** around the proposer role, not spend: this entrypoint injects a fixture
proposer that calls no model. The searched query
(`site:solscan.io <RAY mint>`) came from deterministic explorer targeting, and
the injected single-URL search gateway returned only the owner-named url — no
Brave call, and no solscan candidate could enter. The extractor never ran.

**The budget defect named above was found and fixed 2026-08-28** — generically,
with an offline regression test that reproduces it deterministically. Whether it
**caused** this `TIMEOUT` is **not established**: it is a plausible explanation
and nothing more, because the page has not been re-inspected since. The two
readings named above — server never answered, or `networkidle` never settled —
both remain open, and the fix does not decide between them. Confirming it needs a
new owner-authorized live window.

**Both owner capabilities now exist.** Nothing blocks the case:

1. ~~`PROJECT_IDENTITY` has no supported creation path.~~ **Closed 2026-08-28** —
   `confirm-project-identity.ts`, generic, discovers nothing, refuses a second
   ACTIVE identity outright. See `ARCHITECTURE.md`.
2. ~~Route classification has no supported path.~~ **Closed 2026-08-28** —
   `classify-source-route.ts` acts on an exact ACTIVE unclassified route by id,
   replaces rather than edits, supersedes the original atomically, and verifies
   the swap against the real resolver. See `ARCHITECTURE.md`.

Plan and pre-registered success criteria are in `CURRENT_TASK.md`.
