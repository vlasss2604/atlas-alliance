# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

**A Raydium page was read for the first time**, on the sixth window. Nothing was
classified, nothing persisted: Raydium still has 0 Evidence, 0 jobs, 0 sources,
0 artifacts, and all three routes remain ACTIVE and unclassified.

### The read

`https://docs.raydium.io/ray/ray-buybacks.md` — `finalUrl` identical and in
route, `htmlBytes 3124`, `renderedLength 2939`, `blockedRequests 0`,
`durationMs 3158`, `contentHash sha256:f71a3dd3…`.

**Served as plain text, not HTML.** `anchors: 0, identifiers: 0, hosts: (none)`
while the text contains a Markdown link — the browser wrapped a raw document
instead of parsing a DOM. That is why this surface worked where the SPA
representation never delivered one, and it means **no hrefs exist**: every
identifier is fully literal or unavailable.

### INSPECTION ONLY — none of this is Evidence

The document has not been acquired through the pipeline and the route is
unclassified. Everything below is *what one first-party document was observed to
say*, not a verified finding about Raydium.

### What it says

- **Source of value:** `12%` of Raydium trading fees are used to buy back RAY.
- **Mechanism spec:** the share applies to the **trading fee**, not the trade
  amount. CLMM and CPMM split `84/12/4` LPs/buybacks/treasury; Standard AMM v4
  splits `88/12` LPs/buybacks. Both sum to 100.
- **Supply effect: HELD, not burned.** "Bought-back RAY is held by the protocol
  at a public on-chain address"; the page speaks of "RAY accumulation". `burn` is
  **absent**, per the term scan. `buyback != supply reduction` — the invariant
  this case was chosen to exercise.

### Four role-bound addresses, all Solana-shape valid

| address | stated role | binding |
|---|---|---|
| `projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416` | CLMM protocol fee collection | table column "Collection address" |
| `ProCXqRcXJjoUd1RNoo28bSizAA6EEqt9wURZYPDc5u` | CPMM protocol fee collection | same table |
| `PNLCQcVCD26aC7ZWgRyr5ptfaR7bBrWdTFgRWwu2tvF` | Standard AMM v4 protocol fee collection | same table |
| `DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz` | **where bought-back RAY is held** | "Bought-back RAY is held at:" then the address |

**This is the address-level role assignment PUMP never had.** PUMP's bridge
failed because no single text contained both an address and an acquisition verb.
Here identifier and role sit in the same statement.

### The chain gate is still locked, and the reason is exact

Verified, not assumed: `findAdmittedLocator` returns **0** rows for the holding
address, and `resolveOnchainSubject` returns `NOT_FOUND`.

A locator is admissible only from an Evidence row whose `sourceClass` is in
`ADMISSIBLE_LOCATOR_SOURCE_CLASSES` — `OFFICIAL_DOCS`, `GOVERNANCE`,
`OFFICIAL_REPORT`. The route is unclassified, so this page would still acquire as
`SOCIAL`, which appears in no component's `establishingClasses`.

**Classification is the gate.** It is an owner act, and it is now the one step
that unlocks everything downstream.

### The path this opens, if classified

1. `classify-source-route.ts` on `52084c53-6e55-40fa-a7d4-66550b0e2771` →
   `OFFICIAL_DOCS`.
2. Acquire the page through the pipeline → Evidence, `sourceClass OFFICIAL_DOCS`,
   `officiality CONFIRMED`, with the four addresses as documentary locators.
3. `resolveOnchainSubject` then admits `DdHDoz…VEZaz` as a `DOCUMENTARY_LOCATOR`.
4. Deterministic Solana read: `ACCOUNT_INFO` first — it is the sole base intent
   and classifies the subject before anything is asked of it — then
   `TOKEN_ACCOUNTS_BY_OWNER`, which is exactly what the document's own
   `spl-token accounts --owner` instruction describes.
5. Artifact → Evidence with `onchainArtifactId` → **DESTINATION**, whose
   `establishingClasses` are `["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"]` and whose
   goal is literally "whether that destination retains, redistributes or retires
   them".

**Expected ceiling: `PARTIALLY_SUPPORTED` for the chain leg.** Every on-chain
fact is `officiality CLAIMED`, and D-074 caps `CLAIMED` there. The documentary
leg (`OFFICIAL_DOCS` / `CONFIRMED`) is what can reach `SUPPORTED`.

**Two risks worth naming before spending anything.** `DESTINATION` is
`tokenStateSensitive: true`, which is the gate that excluded PUMP's DESTINATION
results as `TOKEN_STATE_UNQUALIFIED`. And no Evidence row in this repository has
ever carried an `onchainArtifactId` — that path is read and believed correct but
has never succeeded end to end.

### Next — the owner's choice

1. **Classify `52084c53-…` as `OFFICIAL_DOCS`**, after deciding the document
   earns it. Offline, and it is the single unlocking step.
2. **Inspect `/ray/treasury.md` or `/ray/protocol-fees.md` first** — each needs
   its own route confirmation and its own live window.
3. **Stop.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
