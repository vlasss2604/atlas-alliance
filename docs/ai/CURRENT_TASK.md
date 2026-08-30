# Current task

> Overwrite this file each round. Never append.

## NONE — D-145 closeout: Raydium live acquisition is ENVIRONMENTALLY_BLOCKED / INCOMPLETE_TRANSPORT

Documentation-only round. **No runtime code changed, no runtime state added,
no Proof run.** The status above is a research-operations conclusion recorded
in prose — not an enum, not a column, not a job state.

### The controlled fact

MantaRay OFF, exact url `https://docs.raydium.io/ray/protocol-fees`, three
independent clients, one answer:

| client | result |
|---|---|
| curl | HTTP 200, 23 164 bytes, exit 56, `Recv failure: Connection was reset` |
| plain Node https | 200, `transfer-encoding: chunked`, 22 119 / 26 219 bytes, then `req:error:ECONNRESET` |
| canonical safe-http | `NETWORK_ERROR` |

DNS resolves to public addresses; SSRF classification is correct; TLS and
headers succeed; the **body is truncated** — the terminal chunk never arrives
and the cut-off moves between runs, so it is not a stable-boundary truncation.
The response is incomplete by HTTP framing.

### What is settled

1. No safe-http defect — **refuted**, not merely unproven. A complete
   `Content-Length` body followed by a hard RST already returns OK 200; short,
   chunk-truncated and reset-before-close bodies all fail closed. The
   "tolerate a late reset" idea is already the behaviour where HTTP proves
   completeness, and refusing elsewhere is required by RFC 9112 §6.3.
2. ATLAS must not accept this document.
3. Nothing added: no whitelist, no partial-body tolerance, no VPN awareness,
   no Mintlify/Cloudflare case, no SSRF/pinning/redirect change.
4. The 24 × `BLOCKED_ADDRESS` run was a separate transient DNS/environment
   state and does not reproduce; the classifier is exact on every literal and
   every CIDR boundary.
5. **Raydium is no longer a useful live acceptance target in this
   environment.**

### The representation observation worth carrying forward

The same host, the same day, served `docs.raydium.io/ray/ray-buybacks.md`
**four times** — sealed, STATIC, 200, 2 939 chars — hours before the FETCHING
phase failed every docs url. Markdown completes; the HTML documentation page
does not. Search never returned the `.md` url, so the loss was in
**discovery**, not transport. Inventing `.md` targets is barred: it would
fabricate acquisition targets search never found.

### Recommended next milestone

**A second real project acceptance case**, chosen for acquirability rather
than familiarity. The engine is proven end to end (D-136 → D-141); what has
never been demonstrated is a project whose authoritative documents this
environment can actually fetch to completion. Selection criteria are in the
report accompanying this round.

### Standing boundaries

- A truncated document is never Evidence, at any layer.
- Discovery gaps are fixed by discovery, never by inventing URLs.
- The budget default is expensive; replay stays free under D-137.
- Capability is declared, never discovered.
