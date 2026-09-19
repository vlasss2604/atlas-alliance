# Current task

> Overwrite this file each round. Never append.

## ROUND 13 — IDENTITY, PROVENANCE AND ISOLATION UNDER COMPOSITION (done this round)

Offline, $0 spend (no Anthropic, Brave, RPC or live Research; migrations
0052–0054 still pending and NOT applied; Lido Memory untouched).

Question: **can ATLAS assemble a stronger Proof by combining evidence
that is individually valid but belongs to the wrong identity?**

### What was new

Rounds 4 and 5.5 asked whether ONE foreign row binds — same ticker, same
contract, same host, same hex address on another chain. Each is refused.
That leaves composition untested, and composition is where an isolation
rule usually breaks: no single foreign row is enough to matter, so nothing
trips a per-row check, while together they supply exactly the components
the local world is missing.

So Round 13 is a **jigsaw attack**. The local world is deliberately
incomplete and every hole is offered a piece that is perfectly good
evidence — for somebody else:

- revenue here + another project's mechanism + a third's execution
  must not become a value-capture path;
- an unbound burn + an unbound supply delta must not become NET_EFFECT;
- holders here + the entitlement bridge there must not become
  PASSIVE_HOLDER_OUTCOME.

The law asserted is the strongest available: the mixed world is **byte
identical** to the isolated control, not merely "no stronger".

The persisted half runs it where binding is actually computed — two
onboarded projects with their own confirmed identities and routes, and a
provider that serves BOTH projects' pages, offering the foreign one first
at every step.

### Result

**CLEAN.** Zero CRITICAL, zero MAJOR, zero MINOR. No fix required.

Two things worth recording rather than hiding:

- A foreign row is not silently dropped — it is **recorded as refused**
  with reason `WRONG_PROJECT`, which changes the diagnostics and nothing
  else. It never becomes a blocking gap, and verdict, band, requirements
  and citations are the isolated world's exactly.
- Both DB cases assert their own non-vacuity: the attack surface is
  proven reached (the foreign page is offered and fetched) and the
  isolated control is proven to establish something.

**SEMANTIC CORE HARDENING COMPLETE** — Round 12 = CLEAN #1,
Round 13 = CLEAN #2.

### Next

**SPEED + COST OPTIMIZATION**, after Founder review. Not started.

Still pending and untouched: migrations 0052–0054, live Solana Research,
live Ethereum/EVM Research. No live spend before Founder approval.
