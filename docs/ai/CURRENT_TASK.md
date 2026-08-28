# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The future **Project Assessment** extension (EVIDENCE → PROMISES → RISKS) is
recorded — documentation only. **Nothing was implemented**: no tables, engines,
adapters, UI, migrations or API routes, and no change to Raydium / Proof
research behaviour. No production code was touched.

### What was recorded, and where

- **Canonical spec:** `docs/PROJECT_ASSESSMENT_PRODUCT_SPEC.md` — the complete
  future vision: NO CONCLUSION WITHOUT A TRACE; the dependency law (Assessment
  consumes Proof, never manages it); the verified mapping onto existing
  canonical entities; phases A–G; Promise/Risk/Watch boundaries; no investment
  advice; evidence coverage ≠ project quality; the ≥10-project testing vision.
- **Decision register:** `docs/DECISIONS.md` **D-124** (LOCKED), same commit —
  per the register's own rule that an owner decision living only in chat gets
  re-asked.
- **ARCHITECTURE.md:** only the dependency invariant / integration boundary.
- **BACKLOG.md:** only the future phase references, explicitly not scheduled.
- **CURRENT_STATE.md:** one note — recorded, NOT active.
- **INDEX.md:** one navigation line, read-only-when-relevant.

No text is duplicated across those files; each holds only its own slice.

### Mapping facts verified before writing (not assumed)

- `component_reconciliation_status` is exactly `SUPPORTED /
  PARTIALLY_SUPPORTED / CONTRADICTED / INSUFFICIENT_EVIDENCE`; `NOT_APPLICABLE`
  deliberately absent (D-092). The spec forbids introducing it into component
  semantics — and notes honestly that the *Proof-level* Phase-1 `verdict` enum
  does contain it, untouched.
- The Phase-B "Research Trace" chain already exists at rest:
  `research_component_results` carries supporting/contradicting/excluded
  evidence ids with closed reason codes; S6/S7 are replay-idempotent derived
  projections; `proof_gaps` exists; `proofs.layers` already mandates a "what
  could change the conclusion" block.
- Numeric research budgets are already owned by `product.ts`
  (`budget_demo` / `budget_core` / `INTERNAL_ALPHA_V1`); the spec added **no
  new constants**.

### Where the active work still stands (unchanged by this task)

Raydium: identity ACTIVE, buyback `.md` route classified `OFFICIAL_DOCS`,
`raydium` in the alpha allowlist, documentary-only mode available, **0 Evidence,
0 jobs**, chain gate locked. The prepared first acquisition command is in the
previous round's record (`git log`) and in CURRENT_STATE.

### One register gap flagged for the owner (not fixed here — scope)

The two owner decisions enacted in commit `b5a95aa` — adding `raydium` to
`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS` and the documentary-only mode — are not yet
rows in `docs/DECISIONS.md`. D-122's freeze text still names the allowlist as
`{pump_fun}`. Per the register's discipline a catch-up registration should be
its own small owner-authorized act.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
