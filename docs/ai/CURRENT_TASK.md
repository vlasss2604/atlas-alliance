# Current task

> Overwrite this file each round. Never append.

## AUDIT OUTPUT V1 — a composition mode over the existing result

Offline round. No live HTTP, no RPC, no model call, no Proof, no migration.

### What it is

An audit answers "what exactly was checked, where did it not line up, and
what could not be verified?" from the SAME record, the SAME selector
(`chooseAnalyticalBlocks`) and the SAME blocks as a research result. It is
`composeAudit` in `src/client/audit-composition.ts` plus one composition
component, `AuditCompositionView`. No engine, no verdict, no score.

### Structure

1. AUDIT VERDICT + COVERAGE — the Proof's verdict relabelled, its band, the
   proof map, coverage restated in words ("2 partly established · 8 not
   established"). Coverage counts checks, not quality.
2. MAIN FINDINGS — at most 5: CONTRADICTED, then PARTIALLY_SUPPORTED with a
   persisted reason, then INSUFFICIENT_EVIDENCE with a persisted reason, in
   ladder order. A BLOCKED check is never a finding; an established check
   is never a finding; a gap with no reason code contributes nothing.
3. CLAIM VS REALITY — one table row per assessed check: the ladder's own
   claim sentence, the row's `shows` / `reason` / `limitation`, its state,
   its source count. No prose is parsed and no project claim is invented.
4. ANALYTICAL BLOCKS — METRIC / FLOW / TABLE / CHART / TIMELINE exactly as
   the selector chose them, rendered through `SelectedBlocks` with a filter.
   No audit variants.
5. WHAT COULD NOT BE VERIFIED — three kinds, never mixed: partly
   established (reason names the missing part), not established
   (`unresolvedFrom`, the research screen's own derivation), could not be
   checked (BLOCKED — a limit of the run, not a finding about the project).
6. KEY EVIDENCE — the same snapshot selection, retitled.
7. DEEP AUDIT — the same verification layer, retitled.

### Every state is upstream

Every state shown is `proofStateOf(component.status)` through
`deriveResultLadder`; every sentence is a row's own `shows`, `reason` or
`limitation`. Tests sweep all fixtures asserting exactly that, and pin the
seven audit invariants (not established ≠ false; absence ≠ absence;
documented ≠ approved ≠ activated ≠ executing; transaction ≠ mechanism
executed; address ≠ role; burn ≠ net deflation; measurement ≠ attribution).

### Dev surface

`/dev/output-plan?view=audit` on both modes — `&fixture=A..E` and
`&job=<uuid>` — with a result/audit toggle. The real-job mode keeps its
historical-semantics banner. ENTITY is never rendered in the audit.

### One line of copy added

`MECHANICAL_PROVENANCE_NOT_ESTABLISHED` (D-158) had no entry in
`REASON_CODE_EXPLANATIONS`, which that map's own comment calls "a silent
gap on the Result and the audit". One sentence was added, worded from
D-158's definition, describing the record and not the project.
