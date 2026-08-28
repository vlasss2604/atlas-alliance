# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Four inspection windows spent. **No Raydium page has been read.** Both routes
remain ACTIVE and unclassified. No source, Evidence, job or artifact.

### The four windows

| url | reason | status |
|---|---|---|
| `/ray/ray-buybacks` | `NAVIGATION_FAILED:NAVIGATION_TIMEOUT` | none |
| `/raydium/protocol/protocol-fees` (pre-budget-fix) | `TIMEOUT` | none |
| `/raydium/protocol/protocol-fees` (post-budget-fix) | `NAVIGATION_FAILED:NAVIGATION_TIMEOUT` | none |
| `/raydium/protocol/protocol-fees` (post-readiness-fix) | **`HTTP_ERROR:404`** | **404** |

Every window: `0 denied, 1 allowed`, no containment refusal.

### The renderer worked. The resource does not exist.

**For the first time in four windows a status was obtained.** `HTTP_ERROR` is
raised only after a real Response carrying a trusted numeric status, and it is
raised **before** the readiness wait — so readiness was never evaluated and is
not implicated in this failure.

Under the old contract this page **could not** report a status, because
`networkidle` never arrived. The 404 was there all along and was invisible. That
is the readiness change doing exactly its job: it moved the failure from our
renderer to the page.

**404 is an absent page, not a refusal.** The code-owned refusal set is
`401/403/429`; `404` is deliberately outside it — "the page is absent, and
rendering does not invent one". No anti-bot behaviour is indicated, and none
should be inferred.

### What is and is not established

**Established.** At that moment,
`https://docs.raydium.io/raydium/protocol/protocol-fees` returned **404**.

**Not established.** That the page never existed; that Raydium publishes no
protocol-fee documentation; that some other path would also 404; anything
whatsoever about `/ray/ray-buybacks`, which has never returned a status and
whose `NAVIGATION_TIMEOUT` remains unexplained. A 404 on one url is not a
finding about a project.

### Consequence for the route

`d09657e6-96b6-423e-9973-a2578cb71069` is an ACTIVE route whose own url is
absent. The **domain** confirmation is untouched — officiality is a statement
about the host — but the prefix points at nothing.

Superseding or replacing it is an **owner act**. Finding a correct path is
**discovery**, which no owner tool performs and which nothing here may guess.

### Nothing about the content is known

Fee source, allocation share, executing address, destination, supply effect: all
**unknown, not absent**. Neither route may be classified.

**The chain provenance gate remains locked.** No documentary locator exists;
`resolveOnchainSubject` on the confirmed RAY mint returns `NOT_FOUND`, because an
identity does not admit itself.

### Next — the owner's choice

1. **Re-inspect `/ray/ray-buybacks`.** Cheapest and most informative: it is the
   one url never to have returned a status, and the readiness fix has not been
   tried on it. It either reads, 404s, or times out — and all three are useful.
2. **Supply a corrected protocol-fees path**, then confirm and inspect it. The
   path must come from the owner; ATLAS may not discover it.
3. **Stop.** Closing with the bridge named remains legitimate and implies
   nothing about the mechanism.

A live window is a separate authorization, one navigation, zero retry.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
