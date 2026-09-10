# Current task

> Overwrite this file each round. Never append.

## AUDIT OUTPUT V2 — one instrument, not many boxes

Offline round. No live HTTP, no RPC, no model call, no Proof, no migration.
Presentation only; the selector and every derivation it reads are unchanged.

### Order

1. AUDIT VERDICT — the Proof's verdict, its band
2. SHORT SUMMARY — `resultBriefing().shortAnswer[0]`, the research screen's
   own lead sentence; nothing is composed
3. COVERAGE COUNTS — "Established: 2 · Partial: 2 · Not established: 6" as a
   list, never "N / M" (a fraction reads as a grade; a check the sources did
   not establish is not a point lost)
4. MAIN AUDIT TABLE — CHECK · WHAT ATLAS FOUND · STATE, one row per assessed
   check in ladder order; found = the check's phrase where it stood, the
   `SHORT_REASON[code]` where it did not, "Sources could not be opened" where
   blocked; a BLOCKED row is chipped **Not checked**; full sentences in one
   fold beneath
5. WHERE THE AUDIT STOPS — ONE check, chosen by the short answer's own
   "main limitation" priority (blocked → first unresolved → first partial
   with a reason, ladder order within), with its full sentence and a count
   of other open checks; no list
6. analytical blocks, exactly as the selector chose
7. PROOF MAP — supporting depth, no longer beside the verdict
8. KEY EVIDENCE  9. DEEP AUDIT

Removed as separate sections: MAIN FINDINGS (tiles), CLAIM VS REALITY
(now the main table), WHAT COULD NOT BE VERIFIED (chips), the coverage grid
and the hero fraction. `auditFindings` is gone from the derivation.

Desktop: verdict column (21rem) with the gap beneath it, the table as the
main area, in one panel. Mobile: the same in DOM order, stacked rows. No
horizontal overflow at 430 or 1440.

### Dev surface

`/dev/output-plan?view=audit` — `&fixture=A..E` and `&job=<uuid>`.
