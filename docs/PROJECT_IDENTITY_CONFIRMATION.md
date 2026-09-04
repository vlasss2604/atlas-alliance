# Confirmed Project Identity & Source Locators (D-133)

Research infrastructure, not a product feature. ATLAS cannot safely acquire
authoritative evidence about a project until a human confirms **which entity
the project is** and **where its authoritative surfaces live**.

## Why this exists

A live owner-alpha run steered `site:etherscan.io pump.fun …`, found an
unrelated Ethereum ERC-20 that merely matched the name, and used it to
`PARTIALLY_SUPPORT` claims about a Solana asset. Wrong chain, wrong contract,
wrong asset, presented as on-chain proof.

Shared, multi-tenant platforms (block explorers, governance portals, GitHub,
Medium) host millions of unrelated entities. Searching one by **project name**
returns whatever matched the name. Addressing one by a **globally unique,
human-confirmed identifier** returns the project's own page.

> A locator proves WHERE to look. It never proves a research claim.
> **SOURCE ≠ EVIDENCE ≠ FACT.**

## Record types

Both are `project_memory_items` rows. **Confirmation means `lifecycle_state = 'ACTIVE'`
and nothing else** — `OBSERVED` / `CANDIDATE` / `DEPRECATED` / `SUPERSEDED` confer no
authority (D-074).

### `kind = 'PROJECT_IDENTITY'` — WHICH entity

```jsonc
{
  "chain": "solana",            // one of the supported mainnet chains
  "tokenAddress": "<mint>",     // optional; REQUIRED for any explorer locator
  "ticker": "<TICKER>"          // optional, informational only
}
```

Supported chains: `solana`, `ethereum`, `bsc`, `polygon`, `arbitrum`, `base`,
`optimism`, `avalanche`. Mainnet only — a testnet cannot satisfy production
identity, and the chain value bounds which explorers may ever be addressed, so a
Solana project can never be looked up on an Ethereum explorer.

Address shape is sanity-checked against the chain (base58 for Solana, `0x…40` hex
for EVM). A well-formed address is **not** a confirmed one; only the ACTIVE row
confirms it.

### `kind = 'SOURCE_ROUTE'` — WHERE to look

```jsonc
{
  "domain": "docs.example.org",
  "routeClass": "OFFICIAL_DOCS"   // OFFICIAL_DOCS | GOVERNANCE | OFFICIAL_REPORT
}
```

A bare base domain of a shared platform (`github.com`, `medium.com`) is
deliberately rejected as a project-specific class — it identifies the platform,
not the tenant.

## Values still needing human confirmation for `pump_fun`

**Nothing has been guessed or pre-filled.** The repo contains **zero** confirmed
identity or route records for any project. To activate acquisition for
`pump_fun`, a human must confirm:

| # | Value | Record | Enables |
|---|-------|--------|---------|
| 1 | Chain (expected `solana`) | `PROJECT_IDENTITY.chain` | Bounds which explorers may be used at all |
| 2 | Exact `$PUMP` token **mint address** | `PROJECT_IDENTITY.tokenAddress` | `ONCHAIN_VERIFIABLE` locators — the class NET_EFFECT / DESTINATION / EXECUTION_EVIDENCE depend on |
| 3 | Official website domain | `SOURCE_ROUTE` `{domain}` | `officiality = CONFIRMED` for that domain |
| 4 | Official documentation domain/route — **only if one genuinely exists** | `SOURCE_ROUTE` `{domain, routeClass: "OFFICIAL_DOCS"}` | `OFFICIAL_DOCS`, required by SOURCE_OF_VALUE / FLOW_PATH / MECHANISM_SPEC |
| 5 | Governance domain/route — **only if governance genuinely exists** | `SOURCE_ROUTE` `{domain, routeClass: "GOVERNANCE"}` | `GOVERNANCE`, required by GOVERNANCE_BASIS |

Item 5 must be omitted entirely if the project has no real governance surface.
An absent mechanism is a valid finding; inventing a locator for one would
manufacture a research surface that does not exist.

The explorer locator (#2's derived `site:<explorer> <mint>` query) is **computed
from** the confirmed mint. It is never entered by hand and never guessed.

## What stays true regardless

- Admissibility is untouched. Identity steers acquisition; it never reclassifies
  a source, never widens `establishingClasses`, and never changes S5/S7.
- A confirmed domain does **not** substitute for a confirmed address on a shared
  explorer, and vice versa.
- With no confirmed records, on-chain / official-docs / governance targeting stays
  dormant and the affected classes are reported as
  `CLASS_REQUIRES_CONFIRMED_ROUTE:<class>` rather than silently searched for.
