# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The component-assignment investigation is done. **No generic routing defect
exists, and no code was changed.** Details in `PUMP_CASE.md`, "Why the official
rows all landed on DESTINATION".

### What the trace showed

One document reaching several components is supported and happened —
`pump.fun/pump-token` was opened under six of them, and eight sources across the
corpus produced Evidence under two to four components each. The premise that
routing is too coarse is disproven.

What actually happened: MECHANISM_SPEC never got a successful extraction of that
page with current guidance (its one success predates `evidenceGoal`; two later
attempts died at `FETCH_FAILED / PROVIDER_ERROR`), while DESTINATION over-reported
inside its own lane, returning four semantically distinct sentences under one
label.

S4's wrong-component guard cannot catch that: the extractor is told the component
and echoes it, so a wrong fact with the right label always passes. That guard has
never fired in this database.

### Open decisions, for the owner

- **Re-extraction.** The supported remedy is a fresh job whose MECHANISM_SPEC work
  item successfully fetches the page. No rows should be edited by hand.
- **Prompt exclusions.** Passing sibling components' evidence goals to the
  extractor as exclusions is generic and Pattern-driven, but its effect cannot be
  proven offline. Not implemented.

### Standing boundaries

- No live calls without separate authorization.
- Do not hand-edit Evidence rows to correct a component.
- Do not call the observed sequence a buyback or revenue-funded.
