# AI memory — navigation

This set exists so a new chat can load a few percent of context instead of a
pasted handoff. Each file has one job. **Open a file only when the current task
needs it.**

## Always

| File | Purpose |
|---|---|
| `../../CLAUDE.md` | Laws, working style, fail-closed philosophy. Auto-loaded. |
| `CURRENT_STATE.md` | Where the system is right now: HEAD, capabilities, what is done, what is open. |
| `CURRENT_TASK.md` | The one scoped task. Overwritten every round. |

Those three are the whole normal startup set.

## On demand

| File | Read it when | Do NOT read it when |
|---|---|---|
| `CORE_RULES.md` | You are touching research logic, evidence semantics, fact synthesis, reconciliation, or deciding whether a conclusion is licensed. | You are doing UI, infra, docs, or a mechanical refactor. |
| `ARCHITECTURE.md` | You need the shape of the research pipeline, or where a concept lives before you go looking in source. | You already know which file to open — go straight to the source. |
| `PUMP_CASE.md` | The task is PUMP research, or you need the live-validation (MantaRay) procedure. | The task is generic engineering. PUMP facts must never drive generic code. |
| `BACKLOG.md` | `CURRENT_TASK.md` explicitly points you at a backlog item. | Any other time. Backlog items are not free work. |

## Not part of this set

- `../DECISIONS.md` — the D-### register. Consult when a comment or plan cites a
  decision number you need to honour.
- `../PROJECT_ASSESSMENT_PRODUCT_SPEC.md` — the recorded FUTURE
  Evidence → Promises → Risks extension (D-124). Read only when a task
  explicitly concerns that extension; it authorizes no current work.
- `../implementation/` — phase plans, freezes, audits. Historical; read only when
  a task names one.
- `../handoff/` — the original bootstrap package that created this repository.
  Historical.

## History is git, not prose

No file here narrates development rounds. For how something got this way:

```bash
git log --oneline
```

then `git show <commit>`, `git blame <file>`, and the tests. Commit messages in
this repository explain reasoning, not just diffs — they are the development
diary, so nothing here needs to be.

## Maintenance rule

After a meaningful accepted round:

- update `CURRENT_STATE.md` **only if** current capability or state changed;
- **overwrite** `CURRENT_TASK.md` with the next scoped task;
- update a case document only if durable case knowledge changed;
- update `CORE_RULES.md` only for a genuinely durable, generic research principle;
- never append a dated diary entry to anything.

If a document starts growing chronologically, it is being used wrong.
