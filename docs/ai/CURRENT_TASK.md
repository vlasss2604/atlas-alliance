# Current task

> Overwrite this file each round. Never append.

## POST-LIVE VERIFICATION PRESENTATION CLEANUP V1 (done this round)

Offline round. No live call, no model, no engine, reducer, selector,
verdict or schema change. Four presentation defects the first fresh
current-semantics Raydium run exposed, fixed on the Verification surface:

1. Research-only UI (audit entry, Research process) no longer renders in
   Verification — gated on `shown === "research"` like the briefing and
   ladder.
2. A check under WHAT STOOD UP is never also counted as open:
   `open = boundary − stood-up components`; main gaps, "N more" and
   "N further open" are arithmetic over `open`. On the fresh run
   "5 more / 8 further" became "3 more / 6 further".
3. Evidence kind preserves the persisted source class; an unknown class is
   "Unclassified", never "Documentary". SOCIAL renders as Social.
4. The historical-semantics note is opt-in; the product route never opts
   in. Dev routes keep their explicit banner.

### Fresh completed job

- `http://localhost:3000/research/bd7cf5ef-33fa-4768-872e-104171aaf1d9`
  (Research) — `?view=verification` for Verification.

### Known, not this round

- First load in a fresh browser session can race the auth bootstrap
  (pre-existing).
- Dev overlay reports a hydration attribute mismatch on the showcase
  routes; pre-existing on the baseline.
- At 390px the Research view reports a horizontal overflow from decorative
  SVG paths outside the panels (pre-existing; Verification has none).
