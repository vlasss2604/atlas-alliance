# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Five inspection windows spent. **No Raydium page has been read.** Both routes
remain ACTIVE and unclassified. No source, Evidence, job or artifact.

### The five windows

| url | contract | reason | status |
|---|---|---|---|
| `/ray/ray-buybacks` | networkidle | `NAVIGATION_TIMEOUT` | none |
| `/raydium/protocol/protocol-fees` | networkidle, pre-budget-fix | `TIMEOUT` | none |
| `/raydium/protocol/protocol-fees` | networkidle, post-budget-fix | `NAVIGATION_TIMEOUT` | none |
| `/raydium/protocol/protocol-fees` | **domcontentloaded** | `HTTP_ERROR` | **404** |
| `/ray/ray-buybacks` | **domcontentloaded** | `NAVIGATION_TIMEOUT` | none |

Every window: `0 denied, 1 allowed`, no containment refusal, no denial of any
class.

### What the fifth window means

The reason is unchanged from that url's first window, but the **milestone
changed**, so the statement is much stronger. The old contract waited for
`networkidle`; this one waits only for **`domcontentloaded`**, which fires when
the initial HTML is parsed. **This url does not deliver a parseable document at
all within 15s.**

### It refutes a conclusion recorded two rounds ago

"Host-wide, not page-specific" is **wrong**, and it was mine. In the same period,
on the same host, with the same proxy and budgets, `/raydium/protocol/protocol-fees`
returned a 404 **promptly**. `docs.raydium.io` is reachable and responsive. The
stall belongs to one url, not to the host. The earlier reading was an artefact of
judging both pages by `networkidle`, which hid that they behave differently.

### What is established, and what is not

**Established.** This url did not reach `domcontentloaded` within 15s. No status
was obtained. No containment refusal and no proxy denial of any class occurred.
No other host was involved — a cross-host redirect would have surfaced as
`BLOCKED_BY_ROUTE_POLICY` or `HOST_NOT_CONFIRMED`.

**Not established.** Which of three readings holds: the server never answered for
this path; a **same-host** redirect chain never settled into a parsed document
(the route handler filters by host, not path, so such a chain passes containment
silently and would look exactly like this); or the connection stalled after
CONNECT. `1 allowed` is recorded at policy-decision time, before `netConnect`, so
it excludes none of them — the tunnel-outcome blind spot in `BACKLOG.md`.

**Nothing about the page's content is known** — unknown, not absent. Nothing here
says Raydium lacks buyback documentation, or that this page never existed.

### Where the case actually stands

**Both confirmed urls are unreadable, for two distinct reasons**: one absent
(404), one unresponsive. Five live windows have produced no first-party text, no
Evidence, and no documentary locator.

**The chain provenance gate remains locked.** `resolveOnchainSubject` on the
confirmed RAY mint returns `NOT_FOUND`: an identity does not admit itself.

Neither `84774bb9-b10a-4519-8a69-7f1c3a6c0b93` nor
`d09657e6-96b6-423e-9973-a2578cb71069` may be classified.

### Recommendation

**Close the case with the bridge named.** CORE_RULES' brake applies: the proof
plan no longer justifies another branch, and further windows would be diagnosing
our own transport rather than researching a mechanism — the same trap that
consumed four PUMP windows. The honest closure is *"ATLAS could not read
Raydium's first-party documentation at the two confirmed urls: one returned 404,
the other never delivered a document."* That is a valid `INSUFFICIENT_EVIDENCE`
outcome with the missing bridge named correctly, and it implies **nothing** about
whether the buyback mechanism exists.

If the owner prefers to continue, the only options that attack something real
are owner acts, not retries:

1. **Supply corrected first-party urls** for both pages, then confirm and inspect.
   The paths must come from the owner; ATLAS may not discover them.
2. **Accept the transport blind spot as a work item** — recording the tunnel
   outcome would separate the three readings. That is engineering, not research,
   and it belongs in `BACKLOG.md` rather than in a live window.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
