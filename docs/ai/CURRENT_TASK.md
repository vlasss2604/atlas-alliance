# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The fourth authorized `pump.fun` window was executed by the owner and analysed
offline. No further live call was made.

### What the window established

`pump.fun` refuses the static fetcher with **`403`** again, reproducing the third
attempt exactly. The scope gate passed and the refusal path opened correctly.

**The browser launched and navigated.** No `BROWSER_LAUNCH_FAILED` — which,
together with the offline self-test, retires the previous window's launch failure
as transient rather than a standing defect.

**And the render ended outside the confirmed route.** This is the first time
ATLAS has observed what `pump.fun` does with a browser: it does not leave it on
`/pump-token`. The final URL was on `pump.fun` but outside the prefix — derived
from the code, since a cross-host redirect would have been aborted as a thrown
navigation instead. Whether the move was an HTTP redirect or a client-side
navigation is not distinguishable from what was captured.

Nothing was written: zero Evidence, no `sources` row, `MECHANISM_SPEC` unchanged
at 112 SOCIAL/CLAIMED rows, S5 `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. The
extractor was never reached. Details in `PUMP_CASE.md`, "Fourth attempt".

### The sharp part

**The same URL under the same prefix rendered successfully on 2026-08-24.** The
inspection gate requires a non-empty prefix and refuses an already-classified
route, so that render used the `/pump-token` row and not a broader one. The
earlier success was not an artefact of scope.

**Why it now moves off-route is not established.** A site change,
headless-specific handling and intermittent behaviour all fit one observation
equally well, and one observation does not choose between them.

### Decisions the owner may want to make

Named, not taken. None of these were started.

1. **Another window changes nothing on its own.** The static path will be
   refused with `403` and the render will move off-route again — unless the
   behaviour is intermittent, which is exactly what is unknown. A second
   identical run is the cheapest way to test intermittency, and it is the
   owner's call whether that is worth a window.
2. **The page can no longer be inspected.** `evaluateInspectionEligibility`
   refuses an already-classified route, so the non-evidentiary tool that
   discovered this page is now closed for it. Whether that gate should admit a
   classified route for re-inspection is a real design question.
3. **The documentary line may simply be closed for this page.** The corpus
   already contains the claim sentence under `DESTINATION`, and the missing
   bridge — the actor bound to the ACQUISITION step — was established by
   exhaustion, not by a failure to fetch. Re-extraction was always about filing,
   never about discovering something new.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
