# Current task

> Overwrite this file each round. Never append.

## NONE — locator provenance boundary V1

Offline round. No live HTTP, no RPC, no model call, no Proof, no schema
change. Cloud-safe focused tests only.

### What changed

`admittedLocatorsForJob` resolved the project FROM the job and then returned
CONFIRMED documentary locators from **any** job of that project, with no
freshness bound, no revalidation, no revocation act, and `{value, shape}`
only — so a fresh Proof could plan account-level reads against a historical
address and could not say it had done so.

One predicate changed. The boundary is now the job:

```
eq(researchJobs.id, jobId)          // was: eq(researchJobs.projectId, …)
```

- **Nothing else was relaxed**: `literallyPresent`, `validationResult =
  CONFIRMED`, `officiality = CONFIRMED`, the documentary source classes,
  `sources.health != 'BROKEN'`, the shape validator, the cap of 8.
- **Cross-project is now impossible by construction** — a job has one
  project — rather than by a predicate that would imply the project still
  means something here.
- **Provenance**: the return type is a new `AdmittedLocator` carrying
  `evidenceId`, `sourceId`, `researchJobId`. `ConfirmedLocator` is unchanged,
  so no existing producer or consumer moved. Dedup ties break on the
  evidence id, so the surviving attribution is deterministic.

### Identity is NOT a documentary locator

Confirmed project identity keeps its existing semantics: `eligibleSubjects`
still returns the anchor from identity alone, so `TOKEN_SUPPLY` on
NET_EFFECT / CURRENT_STATE / SOURCE_OF_VALUE is planned with no locator
anywhere. Only account-kind intents wait for a locator admitted in this job.

### The accepted cost

EXECUTION_EVIDENCE is step 4, DESTINATION is step 6. A fresh job reaches the
account-kind components before the one that documents an account, so on a
first run those components legitimately have no subject. That is a visible
acquisition boundary and an honest INSUFFICIENT_EVIDENCE — never a fallback
to a previous job, a standalone observation, a project heuristic, an address
parsed from text, or a model guess.

### Interaction with the source-open floor (232b9ac)

Unchanged and re-verified. The floor still activates for a fresh job with a
confirmed identity, because anchor-addressable components still yield
intents. An account-kind component earns the floor only once this job has
admitted a locator — the floor inherits the locator gate rather than
restating it.

### Deferred, explicitly

Historical locator reuse may return only through an explicit Research Memory
design carrying provenance, freshness, revalidation, revocation and
transparent historical reuse. Not built, not stubbed, not scheduled here.
