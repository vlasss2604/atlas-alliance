# Current task

> Overwrite this file each round. Never append.

## ACQUISITION CANDIDATE REACHABILITY ALIGNMENT V1 (done this round)

Offline round. No live call, no provider/model call, no new Research job, no
budget change, no schema, no new subsystem. Two generic candidate-routing
defects the clean Raydium validation run `5cc4a75a-e6e3-46cc-9670-c8ba462f185f`
left standing after proving research semantics and showing the source-open
budget was not the bottleneck.

- **A — D-148 seed injection is path-independent.** The selection policy
  (D-148 eligibility, D-156 routing, D-150 provenance) is extracted
  unchanged into `src/server/engine/source-resource-seeds.ts`
  (`selectApprovedSeedTargets`) and consumed by both `loadFetchTargets`
  (phased FETCH) and the single-process executor, which now admits every
  seed routed to the component it is executing into its ordinary candidate
  set — same reservation, same ceiling, same allowance, same transport,
  same ranking, same dedupe, same authority resolution. Structurally
  replayed read-only against the persisted rows: both approved Raydium
  resources are eligible and rank first for the single-process path.
  Whether they produce Evidence is NOT verified — no live fetch.
- **B — D-133 explorer targeting follows on-chain reachability.**
  `loadAcquisitionPlan.onchainLocators` is now gated by
  `componentAdmitsOnchainAcquisition`, the gate the reserve, the intent
  selector and the executor's explorer-open rule already share. A component
  the adapter has no intent for (today: SOURCE_OF_VALUE) gets no
  `site:<explorer> <address>` rewrite; general search, organic explorer
  candidates, human-approved explorer resources and admitted locators are
  untouched. On the run, all six SOURCE_OF_VALUE explorer opens came from
  the two rewrites this removes.

Job `5cc4a75a-…` was NOT mutated. `maxSourceOpens`, refunds, cross-job
dead-url memory, OFFICIAL_DOCS pathPrefix rules, evidence authority,
reducers/verdicts, Pattern semantics, the deterministic adapter, D-149,
SSRF/IP pinning and the UI are all untouched.

### Reported, not done

- Explorer targeting is still issued for a component the adapter owns even
  in a process where the adapter is available and the executor will then
  skip the explorer HTTP opens it returns; those search units are the
  remaining explorer-related spend and were deliberately not touched.
- The `CLASS_REQUIRES_CONFIRMED_ROUTE:ONCHAIN_VERIFIABLE` observation now
  also appears for a component with no adapter intent; it is observability
  wording only.
- Still open and deliberately out of scope: cross-job dead-url memory, a
  second budget counter, refunds, repeated `WRONG_PROJECT` extraction,
  `/ray/protocol-fees` vs `/ray/protocol-fees.md` pathPrefix disjointness.

### Next

- Founder decides whether to spend one bounded validation run.
