# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Raydium now has a catalog row and a confirmed identity. It still has **no route,
no source, no Evidence, no job and no artifact**, and nothing has been read.

### What was done

One owner-authorized identity act, through the only supported path:

```
npx tsx scripts/confirm-project-identity.ts --project=raydium --chain=solana \
  --token=4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R --ticker=RAY --actor=owner
```

Row `c90833b3-bd93-413b-b430-b9e5e8b3cb28`, kind `PROJECT_IDENTITY`, ACTIVE via
`OBSERVED -> CANDIDATE -> ACTIVE` on the existing `promoteProjectMemoryItem`. No
SQL, no direct ACTIVE write, no re-implemented transition.

Stored content has exactly three keys — `chain`, `tokenAddress`, `ticker`. There
is **no `network` field**; the schema is `.strict()` and the script refuses
`--network` loudly rather than dropping it. Mainnet is implied by construction.

The chain and mint were **owner-supplied**. Nothing discovered or verified them:
the shape validator only rejects an obviously cross-chain address, and a
well-formed address is not a confirmed one. Confirmation *is* the human ACTIVE
row, and that is all this recorded.

`projects.ticker` for `raydium` stays **null**, untouched. Catalog ticker and
canonical identity are separate concerns — the domain module treats identity
`ticker` as informational and never uses it for matching.

### Verified offline, through the real production resolver

`resolveConfirmedIdentity(raydium)` returns
`{ chain: "solana", tokenAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
ticker: "RAY" }` — exact match on all three. Exactly one ACTIVE
`PROJECT_IDENTITY` row exists; it is the project's only `project_memory_items`
row of any kind or state. `pump_fun`'s identity is untouched.

On-chain preflight, exercised against the real gate functions with **no retriever
constructed**, so transport was structurally unreachable: the identity gate
**passes**, the `chain === "solana"` gate **passes**, `projectAnchor` would be the
confirmed mint — and it stops at the subject-provenance gate with `NOT_FOUND`.
Correct: there is no admitted documentary locator and no derived subject, so
nothing is eligible to be read. Identity was the first gate, not the last.

### Next, and still ordinary owner acts

1. `confirm-source-route.ts` — `docs.raydium.io` at a bounded prefix.
2. **inspect** the page (non-evidentiary) — needs an authorized live window.
3. `classify-source-route.ts` — only if what the page says earns it.

Step 2 before step 3 remains the point: classification follows reading.

Note the ordering that the preflight just made concrete: on-chain reading cannot
start from the mint alone. A subject becomes eligible only through a documentary
locator or a previously derived subject, so the documentary path is not optional
groundwork — it is what unlocks the chain path.

The pre-registered success criteria for the case — what will and will not count
as an address-level role assignment — remain as written when Raydium was
selected, and were deliberately settled before anything was read.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
