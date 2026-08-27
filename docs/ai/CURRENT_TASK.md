# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Step 0 is complete. It was run offline against the local database, read-only, with
no network, RPC or live call, and no script was added to the repository.

It refuted its own premise and turned up something nobody had looked for. Both
results are recorded in `PUMP_CASE.md` — read the verified inventory, "The
established burn", and "The temporal picture, and the hole in it".

### What Step 0 settled

- The zero-balance observation is at slot `441498936`, **before** the acquisition
  at `441977087`. No decrease in a known interval is established by that pairing.
- **A genuine `BurnChecked` of the confirmed mint was already persisted** —
  7723.746661 PUMP destroyed from the locator's own token account, under the
  locator's own authority, balance to zero, slot `441840980`.
- **Nothing is observed after slot `441977087`.** No persisted signature anywhere
  has a higher slot.
- Step 1 is therefore **rejected** for the burn-after-acquisition question, and
  was not executed. The window ends at the acquisition; its other 24 signatures
  all precede it.

### What is deliberately not decided here

No new research strategy. No second-burn-address work. No forward-coverage plan.
The next scoped task is the owner's call once the Step 0 result has been reviewed.

Two candidates exist and neither is authorized: reconciling the already-persisted
burn into Evidence, and closing the forward-coverage gap after slot `441977087`.
Do not start either on your own initiative.

### Standing boundaries

- No live calls without separate authorization.
- No paging, no arbitrary transactions, no counterparty-chasing.
- Do not hardcode any address; both burn addresses are already CONFIRMED
  documentary locators and must keep arriving that way.
