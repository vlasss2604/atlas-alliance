# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Document acquisition and model extraction are now **separable owner stages**
(D-128). No live call was made this round; Raydium untouched — still 0
Evidence, chain gate locked.

### Why (owner live facts, recorded)

The count_tokens probe: MantaRay **ON → SUCCESS** (input_tokens 14, 1 attempt);
MantaRay **OFF → `PERMISSION_DENIED:403`** (1 attempt). The 403's cause is
deliberately not inferred. Meanwhile the document host fetch succeeds **OFF**.
The one-process acquisition therefore coupled two capabilities whose working
network conditions are not currently identical — and a fetched document died
with the failed extraction.

### The seam

- **`acquired_documents`** (migration `0034_acquired_documents`, hand-authored
  per the 0028+ convention — note: `drizzle-kit generate` is unusable here, its
  snapshots are stale since 0018 and it regenerates existing objects; the bad
  generated file was discarded before anything applied).
- **Stage A** `scripts/acquire-document.ts` — the real S4 executor with a
  capture stub at the extractor seam: full production fetch/render/containment
  fidelity, zero duplication. Structurally zero model calls (no
  `ANTHROPIC_API_KEY` read), zero Evidence, zero locators, zero RPC
  (`DOCUMENTARY_ONLY` by definition).
- **Stage B** `scripts/extract-from-document.ts` — replays ONE stored document
  through the same executor via a replay fetcher that errors on any other url;
  renderer force-disabled; real extractor → Evidence → locators → S5, the
  ordinary path only.

**PERSISTED DOCUMENT ≠ EVIDENCE**; sealed (`text_sha256`), project-scoped,
consumed at most once, both-ends authority rule, explicit staleness (never
re-fetch on resume). All in `ARCHITECTURE.md` + D-128; 13 tests including the
no-network-on-resume mutation boundary.

### The Raydium two-window future flow (NOT run)

**Window 1 — MantaRay OFF:**

```
npx tsx scripts/acquire-document.ts --url=https://docs.raydium.io/ray/ray-buybacks.md --component=DESTINATION --step=6 --actor=owner --project=raydium
```

→ prints `documentId` + hashes; persists the document; nothing else.

**Window 2 — MantaRay ON:**

```
npx tsx scripts/extract-from-document.ts --document-id=<uuid from window 1> --component=DESTINATION --step=6 --actor=owner --project=raydium --mode=documentary-only
```

→ no second Raydium fetch (structurally impossible); real extraction; Evidence
+ locators through the production path; document marked consumed on success.

Only after Stage B success: evaluate `findAdmittedLocator(DdHDoz…VEZaz)` and
`resolveOnchainSubject` — offline. No RPC in either stage.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
