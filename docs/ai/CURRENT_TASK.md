# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Three inspection windows spent, **no Raydium page has ever been read**. Both
routes remain ACTIVE and unclassified. No source, Evidence, job or artifact.

### The three windows

| url | reason | proxy |
|---|---|---|
| `/ray/ray-buybacks` | `NAVIGATION_FAILED:NAVIGATION_TIMEOUT` | 0 denied, 1 allowed |
| `/raydium/protocol/protocol-fees` (pre-fix) | `TIMEOUT` | 0 denied, 1 allowed |
| `/raydium/protocol/protocol-fees` (post-fix) | `NAVIGATION_FAILED:NAVIGATION_TIMEOUT` | 0 denied, 1 allowed |

### What the fix did, and did not, do

**It did not make the page readable.** It changed the *diagnosis*.

**It explained the earlier `TIMEOUT` and refuted my own leading reading.** The
child's post-navigation wall-clock check sits after the `goto` try/catch, so it
is **structurally unreachable when `goto` throws**. This window shows `goto`
throwing on this page — therefore the pre-fix `TIMEOUT` cannot have been the
child's check, and was the **parent's** deadline. The arithmetic agrees: to
report `NAVIGATION_TIMEOUT` the child must outlive spawn + launch + `goto`'s own
15s, while the old parent deadline was a flat 20s, leaving under 5s for spawn and
launch — against a self-test that alone measured 7,095 ms cold. The parent was
killing the child mid-navigation and reporting its own impatience as the render's
outcome.

So the **parent-deadline half** of the fix is what changed this observation. The
**phase-boundary half was not implicated here**, because `goto` never returns on
this page. Both remain correct — the phase defect was reproduced deterministically
offline and is independently proven — but only one of them was operating here.

### The real finding

**Host-wide, and now supported rather than guessed.** Both Raydium pages, at two
unrelated prefixes, fail with the same closed reason: `waitUntil: "networkidle"`
does not settle within 15s. No containment refusal, no proxy denial of any class,
no `HTTP_ERROR` in any window. **Nothing observed says the site refused ATLAS.**
The wait condition is simply never reached on this host — ordinary for a
documentation SPA that holds persistent connections.

### The next generic question, and why it is not a one-liner

`waitUntil: "networkidle"` is the candidate. It must not be swapped casually:
`load` or `domcontentloaded` return sooner but risk capturing an **unsettled SPA
shell**, which is precisely the failure Stage 1 exists to detect and prevent —
the measured shell in the test suite is 1,477,635 bytes of HTML carrying 134
characters of text. Any change has to preserve that guarantee, so the shape is
likely "settle-or-fall-back with a shell check", not a different constant.

That is a scoped code task with offline regression tests, not a live window.

### Nothing about either page is known

Fee source, allocation share, executing address, destination, supply effect: all
**unknown, not absent**. Neither `84774bb9-b10a-4519-8a69-7f1c3a6c0b93` nor
`d09657e6-96b6-423e-9973-a2578cb71069` may be classified.

**The chain gate remains locked.** No documentary locator exists, so no on-chain
subject can be named. `resolveOnchainSubject` on the confirmed RAY mint returns
`NOT_FOUND`: an identity does not admit itself.

### Next — the owner's choice

1. **Address `networkidle` generically**, then re-inspect. The only option that
   attacks the reason actually observed three times.
2. **Stop.** Three windows, no content. Closing with the bridge named —
   "Raydium's own documentation could not be read by this renderer" — remains
   legitimate and implies nothing about the mechanism.

A live window is a separate authorization, one navigation, zero retry.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
