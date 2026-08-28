# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The Decision Register is caught up to `b5a95aa`. **D-126** (live allowlist
extended to `{pump_fun, raydium}`) and **D-127** (documentary-only acquisition
mode) are registered LOCKED. Register-and-docs only: **no production code
changed**, no live calls, no Raydium research.

### What was done

- **Verified against current code first, not assumed** — all eight facts hold:
  `b5a95aa` is an ancestor of HEAD; the allowlist is exactly
  `{pump_fun, raydium}` (`live-executor.ts:56`); `documentary-only` maps to
  `DOCUMENTARY_ONLY` and the omitted flag to `ENABLED`
  (`alpha-acquire-url.ts:294`); the guard wraps the complete on-chain branch
  (`s4-executor.ts:869` — locator read is inside the `else`); the retriever is
  unreachable in the mode (boundary test asserts exactly 0 spy calls); unknown
  arguments and invalid mode values fail closed.
- **D-126** uses the register's native amendment convention: a new later row
  that names D-122, does not reopen it, and satisfies D-122's own requirement
  that any change to its data boundary be a new explicit owner decision. D-122's
  historical text is untouched.
- **D-127** records the structural no-RPC contract, the corrected operator
  wording (chain work is CONDITIONAL without the flag — never "NO CHAIN CALL"
  generally), and the fail-closed CLI behaviour.

### Current-state doc corrections (historical records preserved)

Two stale present-tense sentences in `CURRENT_STATE.md`'s RPC-caveat paragraph
were corrected: a later *default-mode* run would enter the chain branch, and the
script's old "no chain call" claim was removed in `b5a95aa`. The explicitly
marked "Previously" paragraph (allowlist `{pump_fun}`) stays as a historical
record; `docs/implementation/` freeze documents stay untouched as historical.
D-124, D-125, both canonical spec documents, and Raydium research conclusions
are untouched.

### Where the active research work stands (unchanged)

Raydium: identity ACTIVE, buyback `.md` route classified `OFFICIAL_DOCS`, alpha
allowlist includes `raydium`, documentary-only mode available, **0 Evidence,
0 jobs**, chain gate locked. The prepared first acquisition command is recorded
in CURRENT_STATE and `git log`; running it needs an owner-authorized live
window.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
