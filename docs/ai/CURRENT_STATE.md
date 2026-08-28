# Current state

Where the system actually is. Not a history — for that, `git log --oneline`.

## Repository

- Branch: `claude/phase-5-research-memory`. Working tree should be clean.
- `npm run typecheck` and `npm run lint` are clean.
- Full suite, last verified 2026-08-28: **2229 passing, 4 skipped, 1 failing**
  (2234 total). Only the second item below failed on that run; the first passed
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

## Open

- **Both PUMP bridges stay unresolved** — see the closure summary above. That is
  a legitimate research outcome, not a defect, and nothing should reopen the case
  without new authoritative material.
- The second burn address has one derived token account observed at zero; its
  history has never been read.
- Cumulative official burn totals are unverified.
- Nothing at all is observed after slot `441977087`; no persisted signature
  anywhere has a higher slot.
- Non-blocking engineering items are in `BACKLOG.md`. Do not work on them unless
  `CURRENT_TASK.md` says so.

## Next research direction

**PUMP is closed. Project #2 is blocked on one architectural fork**, not on
finding a project. Selection ran 2026-08-28; the reasoning is in
`CURRENT_TASK.md`.

The single most valuable thing PUMP left untested: **whether any project can
carry an on-chain fact all the way into Evidence and out through a component.**
Every deterministic chain fact in this repository still lives in a standalone
artifact, and no Evidence row references one.

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

**The chain gate is still locked, and the reason is precise.** Verified:
`findAdmittedLocator` returns **0** rows for the holding address and
`resolveOnchainSubject` still returns `NOT_FOUND`. A locator becomes admissible
only from an Evidence row whose `sourceClass` is in
`ADMISSIBLE_LOCATOR_SOURCE_CLASSES` (`OFFICIAL_DOCS`, `GOVERNANCE`,
`OFFICIAL_REPORT`).

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

**The chain gate is still locked, and that is the point.** Verified after
classification: `findAdmittedLocator` returns **0** rows for all four addresses
and `resolveOnchainSubject` still returns `NOT_FOUND`. Raydium still has **0
Evidence and 0 jobs**. **A classified route is not Evidence** — it only makes
acquisition possible. The locators become admissible when the page is acquired
through the normal pipeline, and not before.

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
remains locked**, and nothing about the buyback mechanism is established. The
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
