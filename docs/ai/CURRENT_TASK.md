# Current task

> Overwrite this file each round. Never append.

## AUDIT OUTPUT V3 — exceptions first

Offline round. No live HTTP, no RPC, no model call, no Proof, no migration.
Presentation only; the selector is unchanged.

### Principle

An audit is what deserves attention after the verification. The main page
lists most checks not at all:

1. AUDIT VERDICT — verdict, band, the research screen's own lead sentence
2. WHAT STOOD UP — established checks, ladder order, at most 3; if none,
   the partly-established ones stand in (and are then not also gaps)
3. MAIN GAPS — 2–4: one of each open kind in the existing priority
   (could not check → not established → partly established with a
   reason), then round again; ladder order within; never scored
4. CONTRADICTIONS — only checks whose persisted state is CONTRADICTED;
   otherwise "No contradiction established." — never a gap dressed up
5. analytical blocks ONLY when their `refs.components` touch a gap or a
   contradiction (a standalone measure that explains no exception is set
   aside — composition, not truth; the research view still shows it)
6. KEY EVIDENCE — the selector's choice filtered to the selected findings'
   components, falling back to the selector's choice untouched
7. FULL AUDIT TRAIL — one collapsed `<details>`: compact proof map, every
   check with what ATLAS found / state / sources, full sentences, handover

Removed from the main page: the key-checks table, the counts dashboard,
the proof map beside the verdict, the deep-audit block. Every check is
still in the trail, once.

### Dev surfaces

- `/dev/audit-showcase` — the golden audit
- `/dev/output-plan?view=audit` — `&fixture=A..E` and `&job=<uuid>`
