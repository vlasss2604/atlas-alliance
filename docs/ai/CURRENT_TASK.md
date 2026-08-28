# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Raydium now has **three** ACTIVE routes, all unclassified. Nothing has been read;
five live windows have produced no first-party text. No source, Evidence, job or
artifact.

### What was done

One owner-authorized route act:

```
MSYS_NO_PATHCONV=1 npx tsx scripts/confirm-source-route.ts --project=raydium \
  --domain=docs.raydium.io --prefix=/ray/ray-buybacks.md --actor=owner
```

Row `52084c53-6e55-40fa-a7d4-66550b0e2771`, ACTIVE via `OBSERVED -> CANDIDATE ->
ACTIVE`, content exactly `{ domain, pathPrefix }`, `routeClass` absent. No SQL,
no classification.

`https://docs.raydium.io/ray/ray-buybacks.md` → `CONFIRMED` / `routeClass null` /
`matchedPathPrefix "/ray/ray-buybacks.md"`. Inspection **allowed**;
docs-inspection, render-as-Evidence and payload recovery all refuse
`NOT_OFFICIAL_DOCS`; `resolveSourceClass` still `SOCIAL`.

### Where the lead came from, and what it is worth

The owner independently read `https://docs.raydium.io/llms.txt`, the site's
current first-party documentation index, and reports that it advertises canonical
Markdown urls including `/ray/ray-buybacks.md`, `/ray/protocol-fees.md` and
`/ray/treasury.md`.

**That index is an owner-supplied lead and nothing more.** Its content is not
Evidence, was not acquired through the pipeline, and no mechanism claim follows
from it. It offers a plausible account of the earlier `404` — the browser-facing
paths this project confirmed are apparently not the paths the site now advertises
— but that account is not established either.

**Whether a Markdown surface reads where the SPA did not is unknown.** It has not
been inspected, and nothing should be assumed. The renderer still runs a browser
against it, and a `.md` url may be served as a download, as `text/plain`, or as
another SPA route; each behaves differently and none has been observed.

### Disjointness, proved rather than eyeballed

`.md` does not begin a new path segment, so `/ray/ray-buybacks.md` is **not**
under `/ray/ray-buybacks`. Verified with the real `matchesPathPrefix` in both
directions against every ACTIVE row — the same segment-bounded rule that kept
`/raydium/...` and `/ray/...` apart. Confirming it changed exactly two urls: the
route itself and `/ray/ray-buybacks.md/extra` beneath it.
`/ray/ray-buybacks.markdown` correctly stayed outside.

Both existing routes resolve **byte-identically** before and after.
`/ray/protocol-fees.md` and `/ray/treasury.md` remain unconfirmed: one route per
owner act.

### Still true

Nothing about any Raydium page's content is known — unknown, not absent. None of
the three routes may be classified. **The chain provenance gate remains locked**:
no documentary locator exists, and `resolveOnchainSubject` on the confirmed RAY
mint returns `NOT_FOUND`, because an identity does not admit itself.

### Next — the owner's choice

1. **Inspect `https://docs.raydium.io/ray/ray-buybacks.md`.** Now eligible, never
   attempted. It tests a genuinely different surface, not a retry.
2. **Stop.** Closing with the bridge named remains legitimate.

A live window is a separate authorization, one navigation, zero retry.

**The standard when a page is finally read has not moved:** classification needs
first-party documentation of the mechanism, and a usable locator needs an
identifier **plus** an explicit role assignment. An address occurrence, a
heading, a bare table row, or matching cardinality do not count. Buyback is not
burn.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
