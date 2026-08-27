# Core research invariants

Durable and **generic**. Nothing here is about a specific project. Read before
touching research logic, evidence semantics, fact synthesis or reconciliation.

## The chain of distinct things

**SOURCE ≠ EVIDENCE ≠ FACT ≠ RESEARCH MEMORY ≠ PROOF CLAIM.**

A source is something you can fetch. Evidence is an admitted excerpt of it with
provenance. A fact is what the evidence deterministically states. Research Memory
is a verified prior outcome that guides planning. A proof claim is what ATLAS is
willing to assert. Collapsing any two of these is the most common failure.

## Absence

- **Absence of evidence ≠ evidence of absence.**
- **Failure to read a source ≠ evidence that the information is absent.** A fetch
  error, a render failure, an unsearched payload — none of them is a finding.
- Absence of a mechanism *is* a valid finding, when you actually looked.
- **Zero balance ≠ burn.** Zero balance ≠ proof that tokens never existed.

## Authority and identity

- **Official domain ≠ OFFICIAL_DOCS authority automatically.**
- **Source authority ≠ project identity.** That a document is authoritative says
  nothing about which asset it is about.
- **Token mint ≠ mechanism locator.** The project's mint identifies the asset,
  not the account where a mechanism operates.
- Social sources cannot independently establish a conclusion, however many of
  them agree.
- Model output is not authoritative for a deterministic fact. Chain data is read
  by code, never restated by a model.

## Economic reading of technical facts

- **Transfer ≠ buyback.** Transfer ≠ burn.
- **Buyback ≠ burn.**
- **Burn claim ≠ actual on-chain Burn/BurnChecked.**
- **Proposal passed ≠ proposal executed.**
- **Same transaction ≠ causality.** Co-occurrence is structure, never exchange.
  Two unrelated transfers batched together produce an identical picture.
- **Token-account owner ≠ wallet**, and ≠ economic recipient. "Owner" is the
  RPC's field name and the limit of what it says.
- **Successful idempotent instruction ≠ state change.** A `createIdempotent` that
  succeeded may have created nothing.
- **System utility ≠ economic value capture.**
- A documentary role label ("burn address", "treasury") is a claim about the
  account, never a chain fact about it.
- **Fungible units have no individual identity.** No chain record links a
  specific acquired unit to a specific destroyed one, and none can — so
  "*these* tokens were burned" is never directly provable.
  **This does not make an acquisition → disposition bridge impossible.** Bounded
  account-level QUANTITY continuity can establish one: if a balance is known at
  two points and EVERY state-changing transaction in between is deterministically
  accounted for, then what entered and what left are reconciled as quantities,
  and the bridge holds without ever needing unit identity. The condition is
  completeness of the interval, not identity of the units.
  What fails is the shortcut: two endpoints with an unobserved gap between them
  establish nothing about what happened in the gap, however suggestive the
  endpoints look. Say which one you have — a reconciled interval, or two
  observations with a hole between them.

## Establishment

- **Fact truth ≠ component-establishment eligibility.** A fact can be exactly
  true, DIRECT and bound to the right project, and still be unable to establish a
  component — because the component asks a different question. Check the
  component's own contract, never the enum names.
- **Transaction-level destination ≠ mechanism-level destination.**
- **Asset movement ≠ proof that the movement belongs to the claimed mechanism.**
- A component that asks a mechanism-level or economic question is not answered by
  a bare technical observation. Offer it as context and let the binding arrive as
  separate admitted evidence.

## Fail closed

When entity binding, source authority, identity or evidence is insufficient:
**stop and name the missing bridge.** Do not widen scope to find something else
to say. `INSUFFICIENT_EVIDENCE` is a successful outcome when the gap is stated
correctly.

## Research brakes

Brakes are as much a capability as skills. Do not:

- page dense history indefinitely, or add pagination casually to reach a date;
- chase arbitrary counterparties;
- inspect another transaction merely because the first one did not show the
  desired result;
- infer a burn from a transfer or a balance;
- turn a documentary label into a chain fact;
- turn a technical fact into an economic interpretation without an evidence bridge;
- keep digging a payload that has already been shown to carry no identifier.

**Stop when the proof plan no longer justifies another branch.** Over-research is
a defect, not diligence.

## Sampling honestly

Enumerating a **pre-declared, already-justified, bounded set completely** is not a
search: the outcome does not depend on which member you happened to look at, and
the negative result is a finding. Reading one more because the last one
disappointed is a search for a desired answer, however deterministic the rule
selecting it looks. Declare the whole set first and read all of it, or read none
of it — and do not stop early just because the hoped-for thing turned up.

Then report the sample as a sample. A bounded window is not the population, and
**absence in a bounded sample is not evidence of absence.** The finding is "not
found in the observed window", never "does not occur".

## Generic over specific

A new failure mode becomes: generic rule → regression test → every future project
inherits the improvement. Never `if (project === X)`. The maturity signal is that
each new project needs fewer interventions than the last.
