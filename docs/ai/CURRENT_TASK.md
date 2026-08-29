# Current task

> Overwrite this file each round. Never append.

## NONE — the probe answered: the two network states are mutually exclusive

Analysis only. No live call this round; the local Postgres was read, never
mutated.

## The probe result, and why it is decisive

One owner window, MantaRay **ON**, Stage A against the classified route:

```
status: FAILED
reason: CONTENT_FETCHER_FAILED:ContentFetchError:BLOCKED_ADDRESS
```

**`BLOCKED_ADDRESS` is OUR OWN SSRF GUARD, not a refusal by Raydium.** It is
raised in `content-fetcher.ts` at `resolveAndValidate`: DNS for
`docs.raydium.io` resolved to an address inside a blocked (private / reserved /
loopback) range, and the fetcher refused **before opening any connection**. No
packet reached the host; the site never saw the request. This is the guard
working exactly as designed.

**So MantaRay ON is proven INCOMPATIBLE with `docs.raydium.io`** — under ON,
that hostname resolves into a blocked range, which is the split-DNS / filtered
resolution shape a VPN produces when it intercepts or blackholes a name.

Combined with the already-proven other direction, both are now established
rather than inferred:

| MantaRay | Anthropic | `docs.raydium.io` |
|---|---|---|
| **ON** | SUCCESS | **`BLOCKED_ADDRESS`** (DNS → blocked range) |
| **OFF** | `PERMISSION_DENIED:403` | HTTP 200, `text/markdown` |

A single-process production job needs both in one process. **No network state
satisfies both.** The blocker did not dissolve — it hardened into a fact.

**The fix is not in this repository.** Whitelisting a reserved range,
special-casing the domain, or relaxing the SSRF check would each make the
fetch "work" by removing the protection that correctly stopped it. None is
acceptable, and none is on the table.

## A second, independent gap found while checking the alternative

The D-128 two-stage path *is* network-compatible (Stage A with OFF, Stage B
with ON, replay transport, zero refetch). But it **cannot produce a Proof
today**: `extract-from-document.ts` calls `executor.execute` and then
`reconcileAndPersistComponent` — **S5 and stop**. It never calls
`assembleAndPersistMechanism` (S6), `evaluateAndPersistClaimSupport` (S7) or
`buildAndPersistProof` (S8). Only `run-job.ts` runs that chain, and the
two-stage scripts do not go through it.

So the two-stage route reaches S5 and halts one stage short of the three that
now exist.

## The two honest options

**A — fix the environment (preserves the true product path).** If a network
state can be found where `docs.raydium.io` resolves to a public address *and*
Anthropic is reachable, the single-process run works with no code change and
the first Proof comes from the real product API, exactly as a user would get
it. This is a MantaRay/DNS configuration question — split tunnelling, a
different exit, or an exclusion for that host — and it is outside this
repository. **Free to try, and strictly better if it works.**

**B — extend the two-stage path to S6→S7→S8 (offline coding task).** Small and
testable: after `reconcileAndPersistComponent`, call the same three production
functions `run-job.ts` already calls, in the same order. Reuses existing code,
adds no new engine logic, needs no live call to build or test.

**Caveat that must not be glossed:** the resulting Proof would be genuine
research through the genuine executor, but the *entrypoint* would be owner
tooling rather than `POST /api/research-jobs`. It proves S5→S6→S7→S8 end to
end on real acquired evidence; it does **not** prove the product API path.
Those are different claims and the record must say which one was made.

## Recommendation

**Try A first** — it costs nothing, and it is the only route that yields a
first Proof through the path a real user takes. If the DNS behaviour cannot be
changed, **B** is the smallest honest way to get a real Proof from real
Raydium evidence, with its entrypoint caveat recorded plainly.

I did not start either.

## What the probe left behind

Job `19e86520-…` (origin `PRODUCT`), 6 trace rows ending
`FETCH_FAILED / PROVIDER_ERROR`. **Nothing else**: 0 evidence, 0 sources,
0 on-chain artifacts, 0 component results, 0 proofs, and **no new
`acquired_documents` row** — the table still holds exactly the one consumed
document from 2026-08-28. Model usage columns are null: the reserved
`6560 µUSD` is the authorization ceiling around the injected fixture proposer,
which calls no model. **0 model calls, 0 RPC.**

## Standing boundaries

- No live call without a separate authorized window; no retries.
- **Never whitelist a reserved range, special-case a domain, or weaken SSRF**
  to make a blocked address fetchable. `BLOCKED_ADDRESS` here is the guard
  succeeding, not failing.
- Never enable `research_enabled` to reach the owner path — it would close it.
- Never toggle the VPN inside a running process.
