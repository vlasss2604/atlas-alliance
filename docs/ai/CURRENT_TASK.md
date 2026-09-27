# Current task

> Overwrite this file each round. Never append.

## EVM TRANSACTION-HASH ADMISSION RELIABILITY — IMPLEMENTED OFFLINE (awaiting Founder review)

Founder-approved 2026-09-27. LIVE CALLS MADE: 0. Not pushed.

- **Exclusion-only filter** (`documentary-locator.ts`,
  `classifyEvmTransactionReference`): an EVM 0x+64-hex locator is refused as
  `NOT_A_TRANSACTION_REFERENCE` only when every known occurrence — in the
  document text, in the rendered link appendix, and in the fetch's structured
  `documentLinks` — is a `/proposal/` path value, a Safe
  `id=multisig_<safe>_<hash>` or `/multisig-transactions/<hash>` value, or an
  exact code-owned constant (all-zero, five event signatures, three EIP-1967
  slots; each re-derived from its preimage in the tests). Bare prose, other
  URLs and `/tx/` / `/transaction/` paths keep it admissible. Solana values
  and addresses are untouched.
- **Ordering**: a value presented in a `/tx/` or `/transaction/` path is
  stored `transaction_structured = true` and admitted first; everything else
  keeps the old order. Cap (8) and on-chain request budget unchanged.
- **Migration 0058**: trace reason `LOCATOR_NOT_TRANSACTION_REFERENCE`, and
  the ordering column `evidence_documentary_locators.transaction_structured`
  (boolean, default false; existing rows read false, none rewritten).

Still waiting on the Founder: EVM V1 live validation has no admissible
positive candidate (see the discovery report); the Blind Batch V1 inputs in
`docs/ai/BLIND_BATCH_V1.md` §11.

STOP here until the Founder reviews. No push, no live call.
