# ATLAS Scenario Matrix — V1

Planning document. No implementation is scheduled here; a row becoming PASS is
what schedules work, and the work itself is scoped in `CURRENT_TASK.md`.

## Why this file exists

ATLAS is not a catalogue of projects. It is a set of research questions it can
answer from evidence, and a project is only ever the carrier that lets one of
those questions be tested against reality.

**Scenario coverage, not project count, is the beta-readiness metric.** Ten
projects proving the same scenario is one scenario proved. One project proving
six scenarios is six.

## The working principle

```
Scenario → Live Proof → Gap → Fix → Re-test → PASS
```

Read strictly, in order:

- **Scenario** — a real question a user would ask, written in their words.
- **Live Proof** — a fresh production Research run against a real carrier.
  Not a fixture, not a unit test, not a manual script.
- **Gap** — whatever the run could not reach, named exactly. An honest evidence
  boundary is a legitimate outcome and closes a row as PASS; only an engine or
  coverage gap keeps it open.
- **Fix** — the smallest generic correction. Never a project-specific patch.
- **Re-test** — another fresh production run. A fix is not believed until a run
  shows it.
- **PASS** — the scenario is answerable end to end, or its boundary is named
  correctly and the answer says so.

A row is never advanced on reasoning alone. PARTIAL means a live run happened
and stopped somewhere identifiable; NOT_TESTED means no live run exists.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `NOT_TESTED` | No fresh production run has attempted this scenario. |
| `PARTIAL` | A live run reached a real, identified stopping point. |
| `PASS` | Answerable end to end, or the boundary is named honestly in the answer. |
| `BLOCKED` | A known gap prevents a meaningful attempt until it is closed. |

Candidate projects below are **carriers chosen for mechanism SHAPE**. Naming one
asserts nothing about it: the matrix records which question a run would put to a
project, never what the answer is. Only a live run decides that.

---

## The twelve canonical scenario families

### 1. Buyback → Destination

- **User question** — "They say they buy back the token. Where do the bought tokens actually go?"
- **ATLAS must prove** — that a purchase occurred, and where the purchased asset landed. A purchase is not a burn and holding is not removal; the destination is a separate finding from the execution.
- **Components** — `EXECUTION_EVIDENCE`, `DESTINATION`, `RECIPIENT`, `FLOW_PATH`
- **Candidate carriers** — pump.fun; any protocol with a documented buyback contract
- **Status** — `PARTIAL`
- **Known gap** — the transaction layer was never reached in the live PUMP run: no documentary address locator was admitted, so on-chain acquisition stopped at anchor-level reads. See the PUMP record below.

### 2. Burn → Net Supply Effect

- **User question** — "They burn tokens. Does the supply actually go down?"
- **ATLAS must prove** — that a gross destruction event occurred, AND what total supply did across an interval containing it. The two are different findings and neither implies the other.
- **Components** — `EXECUTION_EVIDENCE`, `NET_EFFECT`
- **Candidate carriers** — pump.fun; any token with an on-chain burn instruction
- **Status** — `PARTIAL`
- **Known gap** — no `BURN` fact was reached, so `NET_EFFECT` correctly reported `SUPPLY_REDUCTION_NOT_ESTABLISHED`. At `6747662` the reconciler can express a gross burn without a net change, but not a measured interval; the point-in-time `TOKEN_SUPPLY` observation is a level, never a change.

### 3. Revenue → Holder Capture

- **User question** — "The protocol earns real money. Does any of it reach me as a token holder?"
- **ATLAS must prove** — a path from an established revenue source to an established recipient class, with every link observed rather than assumed.
- **Components** — `SOURCE_OF_VALUE`, `FLOW_PATH`, `DESTINATION`, `RECIPIENT`
- **Candidate carriers** — fee-switch protocols; DEXes with documented revenue sharing
- **Status** — `NOT_TESTED`
- **Known gap** — none identified. This is the highest-value untested family and the most likely first target after PUMP.

### 4. Governance → Execution

- **User question** — "Governance approved this. Is it actually running?"
- **ATLAS must prove** — that a decision was formally taken, and separately that the decided thing executes. An approved proposal is not an executed one.
- **Components** — `GOVERNANCE_BASIS`, `CURRENT_STATE`, `EXECUTION_EVIDENCE`
- **Candidate carriers** — any DAO-governed protocol with an on-chain vote record
- **Status** — `NOT_TESTED`
- **Known gap** — none identified. Likely reachable with documentary evidence alone, which makes it a cheap early candidate.

### 5. Eligible Revenue Definition

- **User question** — "When they say 'revenue', what is actually counted?"
- **ATLAS must prove** — what the project's own definition includes and excludes, and whether the reported figure matches that definition. Gross is not net, and protocol revenue is not treasury revenue.
- **Components** — `SOURCE_OF_VALUE`, `MECHANISM_SPEC`
- **Candidate carriers** — any protocol publishing a revenue figure alongside a methodology
- **Status** — `NOT_TESTED`
- **Known gap** — none identified. Note this family is largely documentary; a chain read may not bear on it at all, and that is a legitimate shape.

### 6. Activity → Fees

- **User question** — "Usage is up. Does that actually turn into fees?"
- **ATLAS must prove** — that measured activity and measured fee accrual are the same quantity, or that they are not. Volume is not revenue.
- **Components** — `SOURCE_OF_VALUE`, `FLOW_PATH`
- **Candidate carriers** — high-throughput DEXes and perp venues
- **Status** — `NOT_TESTED`
- **Known gap** — none identified. Likely leans on `DATA_PROVIDER` evidence, whose methodology ATLAS does not itself verify — the answer must say so.

### 7. Activation Scope

- **User question** — "This mechanism is live — but for everything, or only part of it?"
- **ATLAS must prove** — the boundary of what is switched on: which pools, chains, markets or asset classes the live mechanism covers, and which it does not.
- **Components** — `CURRENT_STATE`, `MECHANISM_SPEC`, `FLOW_PATH`
- **Candidate carriers** — protocols with per-market or per-pool fee switches
- **Status** — `NOT_TESTED`
- **Known gap** — no component carries a scope qualifier today. A partial activation may currently read as a full one; this family is the one most likely to surface a genuine Pattern limitation rather than an engine defect.

### 8. Durability / Reversibility

- **User question** — "Can they just turn this off next week?"
- **ATLAS must prove** — what would have to happen for the arrangement to change: who holds the key, whether a vote is required, whether it is contract-enforced or policy.
- **Components** — `DURABILITY_BASIS`, `GOVERNANCE_BASIS`
- **Candidate carriers** — any protocol with an upgradeable or multisig-controlled mechanism
- **Status** — `NOT_TESTED`
- **Known gap** — none identified. Almost entirely documentary and governance evidence.

### 9. Unlock → Market Float

- **User question** — "There's a big unlock coming. What actually changes?"
- **ATLAS must prove** — that scheduled tokens exist, and separately what reaches circulation. A vesting schedule is a document; circulation is not a chain value.
- **Components** — `NET_EFFECT`, `SOURCE_OF_VALUE`, `DURABILITY_BASIS`
- **Candidate carriers** — recently launched tokens with published vesting schedules
- **Status** — `BLOCKED`
- **Known gap** — circulating supply is not observable on chain, and ATLAS states this explicitly (`ONCHAIN_DOES_NOT_PROVE`). Without a defensible float definition the honest answer is a boundary, so this family needs a research-semantics decision before a run is worth spending.

### 10. Treasury → Token Claim

- **User question** — "The treasury is huge. Does the token have any claim on it?"
- **ATLAS must prove** — whether holding the token confers an enforceable claim on treasury assets, or none. A balance is not a claim.
- **Components** — `DESTINATION`, `RECIPIENT`, `DURABILITY_BASIS`, `GOVERNANCE_BASIS`
- **Candidate carriers** — protocols with large disclosed treasuries
- **Status** — `NOT_TESTED`
- **Known gap** — none identified. The expected outcome is often a well-named absence, which is a valid PASS.

### 11. Incentives → Who Pays?

- **User question** — "This yield looks great. Who is funding it?"
- **ATLAS must prove** — whether the yield is funded by external revenue or by issuance. Emissions paid to holders are paid by holders.
- **Components** — `SOURCE_OF_VALUE`, `FLOW_PATH`, `NET_EFFECT`
- **Candidate carriers** — liquidity-mining and staking-reward programmes
- **Status** — `NOT_TESTED`
- **Known gap** — none identified. `PROTOCOL_ISSUANCE` vs `FEES` is already a typed distinction in S6 value-source classification, so the vocabulary exists.

### 12. Stated → Observed

- **User question** — "Does what they say match what actually happens?"
- **ATLAS must prove** — both halves independently: what is documented, and what is observed. This family is the cross-cutting one — every other scenario contains a version of it.
- **Components** — `MECHANISM_SPEC`, `CURRENT_STATE`, `EXECUTION_EVIDENCE`
- **Candidate carriers** — any project; strongest where documentation is specific
- **Status** — `PARTIAL`
- **Known gap** — the documentary half worked in the live PUMP run; the observed half stopped before the transaction layer.

---

## Current PUMP state

The only live production acceptance run to date.

| | |
| --- | --- |
| Job | `a9368862-8776-4afc-b9bd-c75c476ef6a9` |
| Commit tested | `6747662` |
| Outcome | **PUMP E2E = PARTIAL** |

**What worked.** The production path end to end: real UI job creation, the
SEARCH_EXTRACT worker with the on-chain capability installed, the FETCH worker
with the renderer installed, and a production Solana RPC read that produced a
real current-job `TOKEN_SUPPLY` observation. The engine reached the chain
through ordinary Research, not through a script.

**Where it stopped.** `TOKEN_SUPPLY` was the only intent that ran. No
`SIGNATURES_FOR_ADDRESS` read followed, so the transaction, burn and
destination layers were never reached. `TOKEN_SUPPLY` is the one base intent
addressed to the anchor rather than to a discovered locator — it needs nothing
to be found first, which is exactly why it was the only one that could happen.

**Why.** No fresh current-job documentary address locator was admitted.
`pump.fun/docs/fees` and `pump.fun/docs/bonding-curve` were fetched
successfully; `pump.fun/pump-token` was not fetched at all, and it is the page
that carries the addresses. Without a locator there is no account-level subject,
so no account-kind intent can be issued and dynamic reactivation has nothing to
act on.

**Fixed since.** A point-in-time `TOKEN_SUPPLY` was being planned directly for
`SOURCE_OF_VALUE` — a supply level cannot answer where value comes from.
Corrected in cloud commit `3a4076d`, which also returns one protected
source-open to the documentary budget. Not yet integrated on the laptop tree,
which remains pinned at `6747662`.

**Next laptop action.** A read-only check of `project_memory_items` for
`kind = SOURCE_RESOURCE` on `pump_fun`, in planner order, to distinguish three
causes of `/pump-token` never entering the fetch target list:

1. never registered as an ACTIVE `SOURCE_RESOURCE` — a classified route grants
   authority but never causes acquisition;
2. registered but ranked below the `MAX_SOURCE_RESOURCE_SEEDS = 3` cutoff,
   which orders oldest-first with no relevance term;
3. inside the cap, but its approved `componentKeys` did not intersect what this
   job needed.

Until that is known, no fix is scoped. One finding already stands regardless of
which cause it is: **a resource that is excluded at planning leaves no trace row
at all**, so the exclusion is invisible and indistinguishable from "no resource
existed".

⚠️ `PUMP_CASE.md` records that as of 2026-08-27 `/pump-token` redirects
off-route and fails the pinned-route egress gate. Seeding it may yield a
`FETCH_FAILED` rather than a locator — a different, and honest, stop.

---

## How to use this file

Pick the next scenario by value, not by convenience. Run it live against a real
carrier. Record where it stopped, in the row, in the vocabulary above. Scope the
smallest generic fix. Re-run.

Do not add scenario families to make the matrix look complete, and do not mark a
row PASS from a fixture. A row that has never had a live run says `NOT_TESTED`,
and that is the honest state of most of this table today.
