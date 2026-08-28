# Architecture — conceptual map

Shape only. This document tells you where a concept lives; the source and the
tests tell you how it works. Do not reproduce enums or schemas here.

## What a research run does

A user question becomes a bounded proof plan, not an open-ended crawl.

```
question → interpretation → Pattern boundary → per-component acquisition
        → sources → evidence → facts → component reconciliation
        → mechanism assembly → claim evaluation → Proof / Verdict
```

Each stage is allowed to say "not established". That is the design.

- Interpretation — `src/server/interpreter/`
- Orchestration — `src/server/engine/controller.ts`, `run-job.ts`, `s4-executor.ts`
- Providers (fetch, render, search, extract, chain) — `src/server/engine/providers/`

## Pattern and components

Research is structured by **Pattern v1 — Token Value Capture**, eight steps, in
`src/server/domain/pattern.ts`. Steps decompose into named components
(`SOURCE_OF_VALUE`, `FLOW_PATH`, `MECHANISM_SPEC`, `GOVERNANCE_BASIS`,
`EXECUTION_EVIDENCE`, `CURRENT_STATE`, `DESTINATION`, `RECIPIENT`, `NET_EFFECT`,
`DURABILITY_BASIS`).

Each component carries **human-authored CORE data**: which source classes may
establish it, whether it needs a current-state or live-mechanism-state basis, its
freshness class, and a one-sentence `evidenceGoal` stating the proposition it must
resolve. The Pattern is CORE — changed by a human, with regression, never by a run.

**Read the component's contract before deciding what may establish it.** The
component names are not self-explanatory and reasoning from them is exactly how
overclaims get in.

## Source → evidence → fact

- **Source class and officiality** are computed from provenance, never asserted:
  `src/server/engine/source-authority.ts`.
- **Entity binding** is a separate axis: chain data must be bound to *this*
  project's confirmed identity (`src/server/domain/project-identity.ts`) or it can
  establish nothing, without being reclassified.
- **Documentary locators** — addresses recovered from documents — are one-to-many
  per fact and carry their own provenance: `documentary-locator*.ts`.
- Document recovery is staged: embedded structured payloads first
  (`__NEXT_DATA__`, JSON-LD, RSC flight frames, `application/json`), then isolated
  rendering only for official docs. The renderer is a scrubbed child process
  behind a deny-by-default egress proxy: `rendered-docs-*.ts`,
  `render-egress-proxy.ts`, `renderer-env.ts`.

## Document representations the static fetcher accepts

A **closed allowlist of MIME essences**, never a family wildcard:
`text/html`, `text/markdown`, `text/plain`, `application/json`,
`application/xml`. `text/*` would admit every future subtype sight-unseen,
so each entry is a representation the fetcher knows it treats as inert
documentary text. A boundary test fails if the check ever becomes a prefix
match.

Only `text/html` is parsed — `normalizeHtmlToText`, plus the opt-in Stage 0
embedded-payload recovery. **Everything else, Markdown included, is trimmed
text and nothing more**: never rendered, never followed, no embedded HTML
executed, no link resolved, no directive honoured.

The gate sits **last**, after SSRF/DNS/redirect validation (which happens
before any network activity), after the streaming byte cap, and after the HTTP
status check — so admitting a MIME type cannot loosen any of them, and each is
pinned by test.

**MIME is representation, never authority.** A `text/markdown` response
establishes only what shape the bytes are in — not officiality, source class,
project identity, or truth. Content type is read from the response header and
**never inferred from a file extension**; authority stays route- and
source-based.

## Deterministic on-chain facts

Chain reads use **typed intents only** — no arbitrary RPC. Intents:
`TOKEN_SUPPLY`, `ACCOUNT_INFO`, `TOKEN_ACCOUNTS_BY_OWNER`,
`SIGNATURES_FOR_ADDRESS`, `TRANSACTION_DETAIL`, `TOKEN_ACCOUNT_BALANCE`.
See `providers/onchain-*.ts`.

The adapter decodes a CLOSED SET of programs — System, SPL Token, Token-2022,
Associated Token. An instruction from any other program is **preserved, not
decoded**: its program id, account list (in order) and opaque data blob are kept
verbatim in `rawInstructions`, and every instruction — parsed or not — records
its own position and the ordinal of the outer instruction it was invoked from.
That is what makes "inside one invocation" distinguishable from "in one
transaction".

Malformed material is dropped whole rather than stored in part, and an over-long
blob is dropped rather than truncated — something that looks decodable and is
not is worse than nothing.

One narrow decoder reads that material: `onchain-exchange-decoding.ts`. Its
constants are DERIVED at module load, never pasted — an Anchor method name is a
hypothesis checked against `sha256("global:<name>")[0..8]`, so it either
reproduces the observed bytes exactly or is wrong. Program-id match is exact,
payload length is exact, and every step fails closed with no fallback.

**It never reads an account role from array position.** A third-party ordering
contract is not available, and assuming one fails silently and wrongly. Roles
come from the mints and amounts the instruction and its event state, each
corroborated against a transfer the transaction independently records; direction
comes from those transfers. A decoded exchange is still offered as CONTEXT: it is
an economic fact about two parties, not evidence that any mechanism ran.

The raw response itself is still kept only as a hash, so an artifact stored
before this capability cannot be enriched retrospectively; only a fresh read can
carry the new material.

Chain facts **bypass the model entirely**. `src/server/engine/onchain-facts.ts`
synthesizes statements by code template over validated values, with a literal
fragment of the artifact's canonical JSON as support, and a hand-authored
`doesNotProve` sentence stating what the observation does not establish. There is
no seam for a model in that path.

Reciprocal same-transaction asset flow is derived purely in
`onchain-transaction-flow.ts` and deliberately named nothing: it is co-occurrence,
not exchange. Two shapes are recognised — the payer paying the counterparty
directly, and the payer funding an account it owns which then pays the
counterparty. Account ownership comes from RPC balance metadata first; an
account that has none — a wrapper created and closed inside the transaction —
may instead be resolved from a same-transaction instruction that establishes
ownership by protocol definition. The two sources must agree or the account
resolves to nothing, and no amount is ever carried across a routing hop.

## Bounded promotion

An intent chain is **evidence-dependent**, not planned up front. Every
account-kind chain starts at `ACCOUNT_INFO`, which establishes *what the subject
is*; only then does promotion decide the next meaningful question
(`onchain-subject-promotion.ts`).

Promotion is gated per component, on purpose. Discovery-only components stop at
the token accounts an address owns; only the component that asks whether a
mechanism *ran* may walk a signature into a transaction. An unresolvable
relationship fails closed rather than guessing.

The philosophy: a bounded window is for deterministic sampling, never for
searching for a dated event.

## Component reconciliation (S5)

`src/server/engine/component-reconciler.ts` turns one component's evidence into a
machine-readable outcome. Pure, deterministic, model-free, network-free.

It applies the component's own contract: admissible class, entity binding,
state/freshness gates, then relationship and directness, then deduplication,
supersession and contradiction. Every exclusion carries a closed-list reason.
Outcome is `SUPPORTED` / `PARTIALLY_SUPPORTED` / `CONTRADICTED` /
`INSUFFICIENT_EVIDENCE`.

It reconciles **one component from one pool**. It never waits for a binding to
arrive from another component — which is why a fact's relationship label must be
correct where the fact is authored.

Two consequences worth knowing before you reason about outcomes:

- **`SUPPORTED` is out of reach for on-chain evidence.** D-074 (LOCKED) caps any
  component whose best establishing element carries officiality `CLAIMED`, and
  every on-chain fact is written `CLAIMED` by design — a canonical chain read is
  not the project's own published claim. The ceiling is `PARTIALLY_SUPPORTED`
  with `INSUFFICIENT_AUTHORITY`. Officiality `CONFIRMED` comes only from a
  human-approved `SOURCE_ROUTE` matched by hostname, and an
  `atlas-onchain://` URI has no hostname. Established and `SUPPORTED` are not
  the same thing.
- **A standalone artifact cannot become Evidence.** `evidence.source_id` is NOT
  NULL and a standalone artifact has no source row, so it is unrepresentable
  rather than merely disallowed. Evidence is written only by
  `persistOnchainArtifactAndFacts`, which requires a job.

Downstream: `mechanism-assembler.ts` (S6) composes the chain,
`claim-evaluator.ts` (S7) evaluates claim requirements.

## What a failure may say about itself

A provider exception reaches owner-visible diagnostics through one sanitizer,
and it may contribute exactly two things: the code-owned label of which provider
boundary failed, and the exception's CLASS NAME. Never the message — a fetch
error's message can embed a credential-bearing URL or an Authorization header
verbatim, which is confirmed reproducible, so there is no redaction step to get
subtly wrong.

One typed detail is allowed past that line, and only through two independent
gates that must both hold: the error is an actual `ContentFetchError`
(`instanceof` against a class this repository owns, never a duck-typed
`reason` field a look-alike object could carry), **and** its reason is a member
of the closed, code-authored list that the reason type is itself derived from.
The second gate is not redundant: a runtime value can violate a compile-time
union, so the class alone vouches for nothing.

The result is `CONTENT_FETCHER_FAILED:ContentFetchError:BLOCKED_ADDRESS` — enough
to tell a refusal from a block from a timeout, which are three different next
moves. Anything that fails either gate falls back to the class-name-only form
unchanged.

An HTTP failure adds its status the same way: `…:HTTP_ERROR:403`. The number is
taken from the Response's own `status` and re-checked as an integer in 100..599
by the error's constructor — never parsed back out of a message, which is
provider-influenced text. A status is a number, so it cannot carry a URL, a
header or a body no matter what the server sent.

A **render** failure says which stage failed by the same construction:
`DOCS_RENDER_AFTER_REFUSAL_FAILED:BROWSER_LAUNCH_FAILED`. The reason list is
declared as a runtime array with the type derived from it, so membership is
checkable for a value that crossed a process boundary; the two gates are the
`RenderedDocsError` class and that list. Nothing else on the error is read — no
message, no stack, no url, no renderer name.

A render crosses four boundaries before a page becomes a document — network
(the egress proxy), process (spawn, then exit), data (the output contract) — and
then renders. **One reason per stage that can independently fail**, because each
points at a different next action: a browser that never started and a site that
defeated the browser are opposite diagnoses. The child already classified its own
failure and put a typed reason on the wire; the parent used to discard it and
report `RENDER_FAILED` for everything.

The child's envelope is untrusted input like any other, so its reason is admitted
only by membership of the closed list **and** of the subset the child could have
witnessed. A child claiming the proxy failed, or claiming its own non-zero exit,
is contradicting the parent's own observation — that is malformed output, not a
reason.

When the browser is what failed, one more level is available:
`…:BROWSER_LAUNCH_FAILED:EXECUTABLE_NOT_FOUND`. Its set is its own, closed and
runtime-checked like the others, and **every member was observed** by inducing
the failure offline and reading what Playwright actually emitted. That mattered:
each real launch error carried an absolute filesystem path, and two carried
Chromium's entire command line. The message is read once at the launch seam,
matched against fixed code-owned substrings, reduced to one value, and dropped —
it is never stored, forwarded or re-thrown. Candidates that could not be induced
on this platform were left out rather than guessed at, and unrecognised text maps
to `UNKNOWN_BROWSER_LAUNCH_FAILURE` rather than being echoed.

**A navigation that never completed is its own stage**, `NAVIGATION_FAILED`,
carrying its own closed diagnostic: `NAVIGATION_TIMEOUT`,
`BLOCKED_BY_ROUTE_POLICY`, or `UNCLASSIFIED_NAVIGATION_ERROR`. It used to fall
into the generic `RENDER_FAILED` beside failures happening nowhere near the
network, and the three causes inside it call for opposite next actions — wait
longer, confirm a different host, or nothing at all.

Each value rests on a signal held locally. The timeout is Playwright's own typed
error, matched against a name this repository pins as a constant and re-checks by
contract test against the installed package. **The containment case is recorded
by our own route handler at the moment it aborts** — the request must have been
a navigation belonging to the page's own main frame — and is never inferred
afterwards from the shape of a generic failure; a driver that cannot prove it
claims nothing. Chromium's `net::ERR_*` codes live only inside the exception
message, so they are deliberately not parsed and that case stays unclassified —
which still separates it from the other two by elimination.

`RENDER_FAILED` keeps its meaning: genuinely unclassified, and now genuinely
elsewhere — context creation, text extraction, anything outside the navigation.

**A render has two phases, and each has its own budget.** Browser STARTUP is
bounded by `browserLaunchTimeoutMs` and enforced by the driver at `launch()`, the
same arrangement `navigationTimeoutMs` already had at `page.goto`. DOCUMENT work
— context creation and the navigation — is bounded by `totalWallClockMs`,
measured from the moment the browser is up.

The boundary is the point. `totalWallClockMs` used to be measured from before
launch, so starting the browser spent the navigation's allowance: with both
budgets at 15s, a navigation that completed well inside its own timeout was
still discarded as `TIMEOUT` whenever startup had consumed the difference. That
is not a hypothetical — startup was measured at 7,095 ms cold and 2,831 ms warm
on one machine by `renderer-selftest.ts`, and it is exactly the variance a
shared budget converts into a false failure. `renderDurationMs` still reports
whole-render wall time, launch included: it is a measurement, not a budget.

**The parent's deadline is derived, not chosen** — `isolatedChildDeadlineMs()` is
the sum of both child phase budgets plus a fixed isolation allowance for spawn
and the envelope round trip. A supervisor whose deadline is shorter than what a
healthy child may lawfully spend is a race, and a large round number hides it
rather than fixing it; expressing it as a function lets a test assert the
relationship instead of an arithmetic literal that drifts when a phase changes.

One residual, stated rather than implied: the document budget is checked at a
single point, immediately after navigation. Text extraction that follows it is
bounded only by the parent's deadline, so a child wedged in extraction is caught
by the supervisor rather than by its own budget.

**`networkidle` is no longer proof of readiness; the document is.** It was the
navigation's `waitUntil`, which made an absence of network traffic the sole
proxy for "this page is ready to read" — and there was no post-render quality
check anywhere to catch what that let through or kept out. A documentation SPA
that holds a poll, a socket or an analytics beacon open never reaches it, so a
page whose document was perfectly usable failed as `NAVIGATION_TIMEOUT`.

The navigation now waits for `domcontentloaded` — a real milestone, so a
response exists and status and final-url checks are unchanged — and readiness is
then decided by **re-sampling the rendered document until it stops looking like
an unfilled shell**. The predicate is `renderedDocumentUsable()`, which is
`staticShortfallDetected()` inverted and nothing more: one code-owned notion of
"usable document" rather than two that can drift. It adds no opinion about empty
bodies, because that is already decided elsewhere and on purpose — a `204` is
inside the success class, yields an empty document, and fails closed downstream
where extraction has nothing to quote.

The wait is bounded by the **existing document budget**, not a new or longer one,
and the poll interval only decides how often the question is asked: the wait ends
the instant the predicate passes. One navigation, no retry, no fixed sleep
standing in for readiness.

**Two failures that used to be one.** `NAVIGATION_TIMEOUT` now means the page
never reached `domcontentloaded`. `DOCUMENT_NOT_READY` means the opposite
statement: the navigation succeeded — real response, permitted status, url still
inside the route — and what the page served never stopped looking like a shell.
Conflating them would send an operator to investigate the network when the honest
finding is about the document.

Containment is checked **twice**: before the settle window and again after it. An
SPA can change its own url client-side while it hydrates, and a document read at
the wrong url is invalid however good it looks.

**A model-provider count_tokens failure names its cause from a closed set.**
`TOKEN_COUNT_DIAGNOSTICS` (token-gate.ts): `AUTHENTICATION_FAILED` (401),
`PERMISSION_DENIED` (403), `NOT_FOUND` (404 — the endpoint is SDK-fixed, so in
practice the model id), `INVALID_REQUEST` (400/422), `RATE_LIMITED` (429),
`PROVIDER_SERVER_ERROR` (5xx), `NETWORK_NO_RESPONSE` (the SDK's own
no-response class, or an APIError with no status — deliberately claiming
nothing about DNS/VPN/routing), `UNCLASSIFIED_PROVIDER_ERROR`. Classified once,
at the throw site, from the SDK's class identity and trusted status integer —
never from a message. It crosses the boundary through the same two-gate
discipline as fetch details (class + membership check; a forged value returns
null), and a string cause now surfaces inside `CapabilityFatalError`'s
message, so a terminal owner run says
`capability unavailable: EVIDENCE_EXTRACTOR_COUNT_TOKENS — …:RATE_LIMITED:429`
instead of only naming the capability. Raw provider messages, keys, bodies and
stacks still never cross; the internal count_tokens retry (at most one, only
for 429/5xx/no-status) is unchanged.

**The egress proxy is a second, independent witness.** It records every decision
it makes with a closed denial vocabulary — `NOT_HTTPS`, `HOST_NOT_CONFIRMED`,
`BLOCKED_ADDRESS`, `DNS_FAILED`, `MALFORMED_TARGET` — and a failed render now
carries a **counts-only** summary of that log beside the browser's own verdict.
The two never replace each other: what Chromium reported and what our
containment decided are different observations, and reading both is the point.

Only counts cross. A decision record holds a raw `host:port`, and an allow
carries the resolved address, so the summary is built by counting and has no
field that could hold a string; it is re-derived key by key from the closed list
at the error's edge, so an object arriving with extra fields yields one that
structurally cannot contain them. Every reason key is always present, so "no
denial of this kind" and "no summary at all" stay different observations, and an
`allowedCount` separates a proxy that permitted traffic from one never consulted.

What it licenses is narrow: a denial count above zero says **we** refused at
least one request and names the class. All-zero says no containment refusal was
recorded — not which host, not which address, and never a redirect destination.

**The renderer can be tested without a live window.**
`runIsolatedRendererSelfTest()`, and `scripts/renderer-selftest.ts` for the
owner, answers "can this machine start the locked-down browser?" in a few
seconds, offline. It is production-equivalent by construction rather than by
resemblance — same egress proxy, same scrubbed environment, same argv-only
spawn, same child, same shared launch call with the same lockdown and proxy
arguments — and it navigates nowhere: the self-test message carries no url, no
confirmed host and no path prefix, so the child structurally cannot be pointed
at anything, and the only page opened is `about:blank`.

**A rendered page must have answered with a success status.** A browser does not
throw on `403` — it receives the refusal page and renders it — so `page.goto()`'s
Response is read rather than discarded, and a non-success status fails closed as
`HTTP_ERROR` carrying the trusted number. The status comes from
`Response.status()` and from nowhere else: never from markup, a title, a body, a
header or an error string, so a page claiming `200 OK` in its own text changes
nothing, and a page that merely discusses `403` is still a document.

The success rule itself — `200..299` — is **one shared predicate used by both
transports**. Which statuses yield a document is a property of HTTP, not of the
transport, and two copies would eventually disagree about a status one accepted
and the other refused. `204` is inside that class and therefore renders to an
empty document, which cannot become evidence because extraction has nothing to
quote.

Playwright follows redirects and returns the last response, so the status
belongs to the page actually in the browser — the same one `page.url()` is
checked against. The route check runs **first**: landing outside the confirmed
route is a containment failure and the more serious statement about a render
that did both. A navigation that produced no Response, or a status that is not a
valid code, is `NO_NAVIGATION_RESPONSE` — unverifiable is not the same as fine.

One limit remains: a failed render is still never evidence and never fails the
attempt, so the stage name is an observation rather than a verdict.

## Documentary-only mode: chain work refused by instruction, not by state

The exact-URL owner acquisition entrypoint builds the **real** S4 executor, and
that executor contains a structured on-chain branch driven by documentary
locators already admitted **for the project** — not merely for the job. So a run
on a project with no admitted locators performs no RPC, but that is a property of
the **database**, not of the code. The entrypoint's comment once claimed "NO
CHAIN CALL" by reading its own import graph; that claim was wrong about what
matters, and is corrected.

`--mode=documentary-only` makes the guarantee structural. The guard wraps the
**whole** branch — the locator read, the intent selection, the retriever
resolution and every call are skipped together — so no RPC can be issued whatever
the database holds. It is deliberately **not** implemented by injecting a no-op
retriever: that would skip the calls while still entering the branch, which is
the same state-dependent guarantee in a different costume.

The default is unchanged, so nothing that does not ask for the mode behaves
differently. Its boundary test proves both halves against one fixture — the
retriever **is** reached in the ordinary mode and is **not** reached in
documentary-only mode — because a zero on its own would not distinguish the guard
from an absent retriever.

Unknown arguments are **refused rather than ignored**, and the parser accepts
hyphens like every other owner script. A misspelt safety flag that a parser drops
in silence would run with chain work enabled while the operator believed it off.

**Which projects may execute live is a closed enumerated allowlist**,
`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`. Membership is the only place a project slug
appears in live-execution control: the engine branches on capability and
authority, never on identity.

## Rendering: two ways in, one set of gates

The isolated renderer is reachable two ways, and both pass through the same
route gates in one shared implementation — https, officiality CONFIRMED,
routeClass OFFICIAL_DOCS, a non-empty path prefix, and a segment-bounded match
of the url against it.

- **As an upgrade**, when a static fetch SUCCEEDED but returned an SPA shell:
  substantial HTML, almost no text.
- **On refusal**, when the static request was declined by `401`, `403` or
  `429` — refusals a real browser session frequently satisfies. Without this,
  a site that declines ordinary clients made its own official docs permanently
  unreadable, and the tool built for that page could never be asked.

The refusal set is deliberately narrow. `404` is an absent page and rendering
does not invent one; ordinary 5xx means the server is broken and a second,
costlier request is not a fix; `503` is excluded for that reason rather than
treated as a refusal. Everything that never reached a server — a blocked
address, a DNS failure, a timeout, a malformed URL — carries no status at all
and so cannot open this path even in principle.

Nothing else differs. Same isolated child process, scrubbed environment,
deny-by-default egress, cross-origin and reserved-IP blocking, one navigation,
no clicks or forms or logins or downloads, bounded time and body, zero retry.
The fallback takes its own source-open reservation exactly as the upgrade does,
so it is one visible attempt against the normal budget and never a hidden extra.
No user agent is spoofed and no anti-bot evasion is added; if a render fails,
the candidate is abandoned.

The trace's `reason_code` stays a closed Postgres enum and keeps recording
`PROVIDER_ERROR` for fetch failures. Widening it would need a migration for
detail that already reaches the owner through the terminal reason. Neither
render path records a trace event of its own; both report through the
per-attempt observation channel, which is folded into the terminal reason — the
zero-document failure path included, since that is the path a failed render
ends on and owner tooling that executes an item directly writes no attempt row.

## Confirming a project's identity

Which entity a project **is** — D-133 — is an ACTIVE `PROJECT_IDENTITY` row, and
that transition is a human act performed by a controlled script, never a model
and never hand-written SQL. `confirm-project-identity.ts` is that script, with
the operation in `memory/project-identity-confirmation.ts`.

It **discovers nothing**: no chain query, no web query, no document, no model is
in its import graph. A well-formed address is not a confirmed one — confirmation
*is* the human decision, and the tool only records that it was made. Validation
reuses the domain module's own `SUPPORTED_CHAINS`, `addressShapeMatchesChain` and
strict content schema rather than restating them, so an `0x…` address filed under
`solana` — the cross-chain contamination D-133 exists to prevent — is refused at
entry.

**The stored contract is `{ chain, tokenAddress?, ticker? }` and nothing else.**
There is no `network` field: mainnet is implied by construction, since every
explorer in the code-owned chain map is a mainnet host and test networks are
rejected again at classification time. A `--network` option is refused loudly
rather than dropped silently. `tokenAddress` is genuinely optional — a project
may be confirmed on a chain before its token is, and without an address there is
simply no explorer locator.

**A second ACTIVE identity is refused outright, identical or not.**
`resolveConfirmedIdentity` returns the *earliest* structurally-valid ACTIVE row,
so a second one would not replace anything and would not conflict loudly — it
would be silently ignored while the older record kept deciding what the project
is. An owner who "confirmed" a correction would get no error and no effect, which
is worse than a refusal. Superseding is a separate deliberate act with its own
consequences, and this tool does not perform it.

## Confirming a source route

A domain becomes CONFIRMED for a project only through an ACTIVE `SOURCE_ROUTE`
row, and that transition is a human act performed by a controlled script
(D-021/D-055) — never a model, never an admin UI, never hand-written SQL.
`promote-memory.ts` is that script for `research_memory`;
`confirm-source-route.ts` is it for `project_memory_items`, with the operation
itself in `memory/source-route-confirmation.ts`.

**It assigns no `routeClass`, and has no parameter that could.** Confirming that
a host belongs to a project and deciding that a page carries documentation
authority are different judgements, and the second should follow reading the
page. So the result is always officiality CONFIRMED with `routeClass` null,
which opens **non-evidentiary inspection and nothing else** — evidentiary
acquisition and both renderer-as-Evidence entry points require a non-null class
and keep refusing. Classification stays a separate later act, which is the order
`/pump-token` actually went through.

**Classifying a route is the owner's second act**, and `classify-source-route.ts`
is its tool. It acts only on an exact, already-ACTIVE, currently-unclassified
route named by id: it cannot create a host, confirm an unconfirmed one, widen a
prefix, or read anything — `--domain`, `--prefix` and `--project` are refused
outright, because naming a host here would be doing the first act inside the
second. The class comes from the resolver's own closed enum
(`OFFICIAL_DOCS`, `GOVERNANCE`, `OFFICIAL_REPORT`), validated by the resolver's
own predicate.

**The route is replaced, not edited.** A new ACTIVE record carries the same
domain and the same prefix verbatim plus the class, and the original moves to
`SUPERSEDED` with `supersededBy` linking to it — the lifecycle graph's own model,
and the precedent already in the database from `/pump-token`. Editing content in
place would be an unguarded mutation of an authoritative row: the lifecycle
trigger fires on `lifecycle_state` only.

**The whole swap is one transaction**, because the intermediate state is
dangerous — two co-matching ACTIVE rows make `matchedPathPrefix` vanish, and a
crash between the two writes would leave it vanished. Afterwards the transition
is **verified against the real resolver**: the target url must differ in exactly
one field and every other route's url must be byte-identical, or the transaction
rolls back. `supersedeProjectMemoryItem` is the primitive that performs the
`ACTIVE → SUPERSEDED` move; nothing had ever written `supersededBy` before.

Two refusals exist because of how the resolver *combines* rows, and both prevent
a confirmation from silently damaging what already works:

- `matchedPathPrefix` is reported only when **exactly one** path-scoped row
  matched a url, so a new prefix that co-matches an existing ACTIVE one turns
  that field null for the overlapping urls — disabling rendering and inspection
  for a route that worked yesterday. Overlapping prefixes are refused.
- `routeClass` resolves from **every** matching ACTIVE row, so an ACTIVE
  domain-wide row carrying a class would hand it to the new url too. A
  confirmation that would inherit a class is refused rather than quietly
  granting authority.

Nothing is ever auto-superseded: supersession is a separate owner action. The
prefix rule and the shared-platform list are the authority module's own,
exported rather than copied, so no second notion of authority exists.

## Research Memory

Direction, not a finished system: retrieval before fresh research, freshness
policy, and only VERIFIED outcomes becoming durable memory.
`src/server/memory/` — retrieval gateway, planner, lifecycle, verification, blind
evaluation, golden scenarios. See `docs/ARI_LEARNING_LOOP.md` for the intended
evolution. No LLM weights are ever trained.

## Platform boundary: Telegram is a client, not the platform (ACTIVE)

**ATLAS is the product; Telegram is only the first interface** — an ACTIVE
constraint on current development (D-125), not a future idea. The full boundary,
repository mapping, coupling audit and acceptance matrix live in
`docs/PLATFORM_INDEPENDENT_ARCHITECTURE.md`; only the law lives here:

```
CLIENT → APPLICATION/SERVICE LAYER → ATLAS DOMAIN/CORE
```

The reverse edge `ATLAS DOMAIN → TELEGRAM` is forbidden. The Core — engine,
domain, memory, persistence, entitlements, usage policy — must not need to know
Telegram exists. Telegram concerns (initData bootstrap, WebApp SDK, deep links,
payments, presentation) stay at the edge: `src/server/auth/`,
`app/api/auth/telegram/`, `src/client/platform.ts`. The canonical user is
`users.id`; a Telegram user id is an attached external identity in
`user_identities`, never a domain key. Entitlement is computed from
subscription state, never from a payment event. The design-review rule for
every feature: **if Telegram disappeared tomorrow, the feature must still
operate through another client against the same backend.** Audit 2026-08-28:
zero Core violations found.

## Future extension boundary: Project Assessment consumes Proof

A future product layer — **EVIDENCE → PROMISES → RISKS** — is recorded in
`docs/PROJECT_ASSESSMENT_PRODUCT_SPEC.md` (D-124). It is **not active** and
authorizes no implementation. The one structural law that binds any future work
on it belongs here:

**Assessment consumes Proof; Assessment never manages Proof.** The dependency
`Project Assessment → Proof Engine` is forbidden: no assessment code may
control, override, rewrite, re-run or replace Proof logic, and no assessment
concept may duplicate a canonical entity (`projects`, `sources`, `evidence`,
`proofs`) that already exists. An assessment that needs research requests an
ordinary Proof through the ordinary front door and consumes the persisted
results. Component reconciliation states stay exactly the four of D-092 —
`NOT_APPLICABLE` stays out. Everything else about the extension lives in the
spec, not here.

## Public v1 research areas

1. **Token Value Capture** — the only mature domain; current focus.
2. Governance → Execution
3. Supply / Emissions / Unlocks
4. Treasury / Rewards / Incentives

Areas 2–4 inherit the same discipline once TVC is mature. Do not expand scope
without approval.

## Going deeper

For implementation detail: read the source, read the tests beside it, and use
`git show` on the commit that introduced the behaviour. Commit messages here carry
the reasoning.
