# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

`networkidle` is no longer required as proof of readiness. Nothing Raydium was
run, nothing was classified, no Evidence exists.

### What was wrong

`waitUntil: "networkidle"` was the navigation's success condition, which made an
**absence of network traffic** the sole proxy for "this document is ready". And
there was **no post-render quality check anywhere** — `staticShortfallDetected()`
existed only as the *eligibility trigger* on the static fetch, deciding whether
to render at all. So the renderer had exactly one readiness signal, and it was
the wrong one: a docs SPA holding a poll, socket or beacon open never reaches it,
and a page whose document was perfectly usable failed as `NAVIGATION_TIMEOUT`.

### What changed

- The navigation waits for **`domcontentloaded`** — still a real milestone, so a
  response exists and the status and final-url checks are unchanged.
- Readiness is then decided by **re-sampling the rendered document** until it
  stops looking like an unfilled shell, bounded by the **existing** document
  budget. `documentReadinessPollMs` (250) only sets how often the question is
  asked; the wait ends the instant the predicate passes.
- `renderedDocumentUsable()` is `staticShortfallDetected()` **inverted and
  nothing more** — one code-owned notion of "usable document" instead of two.
- **`DOCUMENT_NOT_READY`**, a new closed reason: the navigation succeeded and the
  page never stopped looking like a shell. The opposite statement to
  `NAVIGATION_TIMEOUT`, which now means the page never reached the milestone.
- Containment is checked **twice** — before and after the settle window. An SPA
  can change its own url client-side while hydrating.

One navigation, no retry, no fixed sleep standing in for readiness, no selector,
hostname or keyword. A source scan asserts the render path names no project,
host or framework.

### A correction worth keeping

I first added "zero rendered text is never usable" on top of the shell rule. A
pinned existing test caught it: a `204` is deliberately inside the success class,
yields an empty document, and fails closed downstream where extraction has
nothing to quote. Re-deciding that in the renderer would have been a second
opinion overriding a decision the system already makes on purpose. The predicate
is now pure reuse, and the tests record why.

### What did NOT change

DNS/SSRF, confirmed host, path containment, HTTP status handling (including the
204 decision), final-url containment, byte caps, proxy policy, retry count, the
phase budgets from `fbcceeb`, the parent supervisor's derived deadline, source
authority, evidence semantics.

### About Raydium

**Unknown whether this makes either page readable.** Neither has been
re-inspected; the change is verified only against offline fixtures. It removes
the reason those three windows actually reported. It predicts nothing about what
the host will do next.

Both routes remain ACTIVE and unclassified. The chain gate remains locked: no
documentary locator exists, and `resolveOnchainSubject` on the confirmed RAY mint
returns `NOT_FOUND` — an identity does not admit itself.

### Next — the owner's choice

1. **A new live window** on either Raydium url. The only way to learn whether the
   host is now readable.
2. **Stop.** Closing with the bridge named remains legitimate.

A live window is a separate authorization, one navigation, zero retry.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
