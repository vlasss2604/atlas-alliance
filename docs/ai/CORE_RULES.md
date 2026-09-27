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
- **Technical failure ≠ project reality.** A provider that rejects ATLAS's
  credential (401 / 403 / 404) has said nothing about the project: the
  Research fails as a capability failure and never becomes `NO_EVIDENCE_FOUND`.
- **No evidence ≠ not extracted.** A document that was opened but never
  inspected reads `EXTRACTION_NOT_COMPLETED`, not "nothing found". The
  distinction is diagnostic: same status, same confidence footing.
- **Technical failure ≠ stronger project reality.** Technical degradation
  (an RPC down, a provider unreachable) must never make the semantic Research
  result stronger than it is with everything working. A deterministic chain
  read closes a component's acquisition only when its rows can establish the
  component under the reducer's own rules and carry what it reports; a
  reading that cannot never suppresses the documentary pass that can.
- **Excluded evidence ≠ confidence.** Evidence that S5 excludes may stay
  visible in the audit record and never strengthens verdict, support,
  confidence or citations: a Proof over the control plus inadmissible-only
  additions is never stronger than the control. Exclusion-shaped absence
  (`ALL_EVIDENCE_EXCLUDED`, `MISSING_CURRENT_STATE`, `STALE_CURRENT_STATE`,
  `MISSING_EXECUTION_EVIDENCE`) caps exactly where bare absence caps.
- Absence of a mechanism *is* a valid finding, when you actually looked.
- **A known path left unused ≠ looked.** An unresolved critical component is
  not finalized while a known admissible path (sealed-unextracted, unopened
  candidate, unexplored confirmed route) remains and the hard envelope
  allows another attempt: recovery continues round by round while each
  round consumes at least one path. It stops when the paths are used up,
  when a round consumes nothing, or when the envelope is spent — the last
  recorded as RECOVERY_BOUND_REACHED, never as a finding.
- **Zero balance ≠ burn.** Zero balance ≠ proof that tokens never existed.

## Authority and identity

- **Official domain ≠ OFFICIAL_DOCS authority automatically.**
- **Source authority ≠ project identity.** That a document is authoritative says
  nothing about which asset it is about.
- **Same ticker ≠ same project.** An unrouted document binds to the project
  only on a strong anchor — the confirmed project name, the canonical slug, or
  the confirmed token contract / mint. A bare ticker match is not binding: two
  unrelated projects can share one. A confirmed route is its own anchor.
- **Token mint ≠ mechanism locator.** The project's mint identifies the asset,
  not the account where a mechanism operates.
- Social sources cannot independently establish a conclusion, however many of
  them agree.
- **The extractor and D-076 read the same human-readable text.** HTML
  character references are decoded when a document's text is built, so a
  literal excerpt is checked against what the page says ("users' stake"),
  never against its encoding ("users&#x27; stake"). Traceability itself stays
  strict literal containment, with exactly two equivalences inside the
  comparison, applied to both sides: typographic quotes are the same quote
  (’ ‘ ≡ ', “ ” ≡ "), and a space before , . ; : ! ? ) or after ( is not
  part of the excerpt (our HTML normalizer inserts it where a tag was:
  "rewards : Determined" ≡ "rewards: Determined"). No other character,
  spacing or markup is folded, and stored text, stored fragments and
  extraction-unit / observation keys keep the characters as written.
- **A 32-byte hex value is not a transaction by its shape.** An EVM 0x+64-hex
  locator is refused (`NOT_A_TRANSACTION_REFERENCE`) only when EVERY known
  occurrence is deterministic non-transaction structure — the value after a
  `/proposal/` URL segment, a Safe `id=multisig_<safe>_<hash>` identifier or
  `/multisig-transactions/<hash>` path, or an exact code-owned constant
  (all-zero, well-known event signatures, EIP-1967 slots). Any bare-prose,
  unrecognised or `/tx/` occurrence keeps it admissible; no nearby word is
  read and no RPC classifies it. A value the page also presents in a `/tx/`
  or `/transaction/` path is admitted first, so it cannot be crowded out of
  the unchanged cap. Link structure classifies the identifier, never the claim.
- Model output is not authoritative for a deterministic fact. Chain data is read
  by code, never restated by a model.
- **A subdomain is a different host.** Confirming a domain confirms that host and
  nothing beneath or beside it; authority does not flow from `example.com` to
  `fees.example.com`. Route matching is exact for the same reason.
- **Confirming a host and classifying a page are different decisions.** That a
  domain belongs to a project says nothing about whether a particular page is its
  documentation. Classification should follow reading the page, never precede it.
- **Source class `ONCHAIN_VERIFIABLE` is not a chain read.** An explorer page
  scraped by a model is a *document about* the chain — text, unbound, and as
  capable of being wrong or off-project as any other page. Only code-read,
  entity-bound chain data is a chain fact.
- **Cardinality equality is not identity.** Two documents each describing "two"
  of something does not make them the same two. |X| = 2 and |Y| = 2 entails
  nothing about X = Y, and shared mechanism context does not supply the missing
  premise — it is the setting in which the wrong join is least detectable.
- **Chain behaviour cannot assign an institutional role.** The forward rule above
  says a documentary role label is never a chain fact; the converse holds
  identically. Observing that an account does what a role would do is affirming
  the consequent — many actors produce the same trace. Roles are assigned by
  authoritative sources, never inferred from activity.

## Economic reading of technical facts

- **Transfer ≠ buyback.** Transfer ≠ burn.
- **Buyback ≠ burn.**
- **Burn claim ≠ actual on-chain Burn/BurnChecked.**
- **Burn event ≠ claimed mechanism execution.** A deterministic BURN shows
  that tokens of the mint were destroyed; it establishes no
  EXECUTION_EVIDENCE for the researched mechanism, because nothing ties the
  burned account or the transaction to the mechanism beyond sharing one. It
  still carries NET_EFFECT under B1/B2. A row whose kind cannot establish a
  component supersedes nothing there. Saved rows resting on burns only are
  shown as not established.
- **Point-in-time state ≠ mechanism execution.** One total-supply reading
  establishes neither CURRENT_STATE nor NET_EFFECT: it says nothing about
  whether a mechanism operates now and observes no change. A change reaches
  NET_EFFECT only as a measured interval; a saved Proof resting on a lone
  reading is shown as not established.
- **Point-in-time balance ≠ mechanism execution.** A balance or an owner's
  token accounts say where tokens sit (DESTINATION), never that a mechanism
  is operating now. No chain observation establishes CURRENT_STATE.
- **Zero-address transfer ≠ burn ≠ mechanism execution.** An ERC-20 Transfer
  of the confirmed token to exactly 0x000…000 (successful receipt, emitted
  by the confirmed contract) is ZERO_ADDRESS_TRANSFER: it establishes no
  component. At NET_EFFECT it can only anchor a measured interval; a
  decrease across it is PARTIALLY_SUPPORTED with its own code and is never
  attributed to the transfer. A transfer to 0x…dEaD is a TOKEN_TRANSFER.
- **Measured supply decrease around an event ≠ causal attribution.** Two
  readings bound the interval; the delta is the net of everything in it.
  A reading taken by this Research at an explicit historical block is
  history and may be t0; a head reading of this Research never is.
- **Fresh document ≠ current claim.** A component that asks what is true NOW
  (CURRENT_STATE) is answered only by a row that states a known state; a
  fresh publication date proves when a page was written, never that its
  excerpt speaks about the present ("cumulative total since launch" on a
  page dated yesterday is historical content). `published_at` is document
  metadata only — an explicit publication or last-updated date of the
  document itself, else null; never a fetch date, an "as of" data date, a
  governance or transaction date. Saved results resting only on stateless
  rows are shown as not established.
- **Untrusted documentary dates must not create current or lifecycle temporal
  truth.** `evidence.published_at_rule_version = 1` marks a date produced
  under the strict rule; NULL is legacy. Only a marked documentary date can
  make CURRENT_STATE current (freshness), order LIVE against a stop for the
  lifecycle, or raise TEMPORAL_STATE_MISMATCH; an unmarked date stays
  provenance. Memory reuse copies the marker exactly.
- **A newer date alone never erases an older fact (D-160).** Supersession
  (§8.1) removes an older row only for a change of stated state (PROPOSED →
  LIVE), never between rows stating the same state; only when both dates are
  trusted and the newer row is strictly newer; never over a row already
  excluded for another reason (it keeps that reason); never a CONFIRMED
  official row by a newer row that is not CONFIRMED; never a fresh row by a
  memory-adopted one; never an IMPLEMENTING or LIVE row by a newer PROPOSED
  or APPROVED one (D-161: a pending change is not current reality, whatever
  its date). Otherwise both rows stay and ordinary reconciliation decides
  coexistence or conflict. Same-state value or destination changes
  are not detected — see BACKLOG.
- **One passage, several kinds → unresolved (D-161).** A passage that
  matches more than one distinct destination or recipient kind in the closed
  dictionaries classifies UNKNOWN, never the first match; the passage stays
  as evidence and no single destination or recipient is invented.
- **Stopped later ≠ never executed.** DEPRECATED and REMOVED are durable
  lifecycle stops (they outlive the current-state freshness window until a
  newer trusted state says otherwise): trusted, newer than the latest LIVE,
  with execution observed → HISTORICAL. PAUSED is never durable and never
  makes a flow HISTORICAL; a newer trusted stop of any kind blocks CURRENT;
  same-date conflicting states settle nothing (NOT_ESTABLISHED). Execution
  evidence is never re-read by a later stop.
- **Historical execution ≠ executing now.** Execution evidence shows that
  execution happened by its date; the surface says so and never implies it
  continues. An approval later paused, deprecated or removed by a newer
  governance record is named (`APPROVAL_LATER_WITHDRAWN`), never "no
  approval seen".
- **Proposal made ≠ proposal passed.** An official governance venue is not a
  decision; a post on it establishes what was proposed, never that governance
  approved it. `PROPOSED` ≠ `APPROVED` ≠ `ACTIVATED` ≠ `EXECUTING`.
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

- **More agreeing admissible evidence ≠ weaker Proof.** A second admissible row
  that agrees with the first never weakens a claim merely because the
  assembled lineage forks. A weaker result needs a real semantic reason the
  existing rules already define — contradiction, temporal incompatibility,
  identity mismatch, scope mismatch, an authority or current-state conflict.
  Mere multiplicity or branching is not one. Structurally: a row whose source
  names no branch continues the trunk on every branch, as it would in an
  unforked lineage.
- **Same source ≠ extra independent confidence; same source ≠ automatic
  penalty.** Several agreeing passages of one page are never independent
  corroboration (S7 is existential, confidence never counts). A page that
  spans a fork with ONE element below it offers no pairing choice: that
  element continues on every branch the page spans, one shared provenance,
  the branches kept distinct. Two elements of the same page below the fork
  are a genuine pairing choice the page's own structure decides and the
  assembler does not guess (`BRANCH_ATTRIBUTION_UNRESOLVED`, audit HIGH-1).
- **Bounded enumeration ≠ weaker truth.** The flow-enumeration cap is a
  computational safety boundary, not project counterevidence. When it binds,
  the lineage continues with the structurally-first slot, the fact that not
  every permutation was listed stays visible (`FLOW_ENUMERATION_INCOMPLETE`
  on the flow, on the result and in the Proof), and it never binds the
  confidence band. A real contradiction on the retained path still weakens.

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

**Classify the failure before repeating the attempt.** A bounded live window
spent on a failure that cannot say which failure it was buys one bit of
information at full price — and the same window spent again buys the same bit.
When an attempt fails opaquely, the cheapest next move is almost always to make
the failure name itself, offline, before spending another. Every acquisition
stage that can fail independently deserves its own reason, and every reason its
own closed sub-vocabulary, so that "it did not work" is never the whole answer.

**Know when the diagnosis has stopped being research.** Fixing observability to
reach a source is justified while the source is plausibly load-bearing. Once the
thing being illuminated is your own network stack rather than the question, the
branch is over — however tractable the next fix looks.

## An index is not a census

A provider's index answers "what did you list for this key", never "what exists".
A coverage claim inherits the indexing guarantees of whatever answered — so
before writing that a set is COMPLETE, name the guarantee and check you actually
hold it. A vendored contract, a conformance test, a documented invariant: one of
those, or the claim is an assumption wearing a stronger word.

Absent the guarantee, scope the claim to the observation: *nothing further was
listed for that range* is honest and often enough. *Nothing else happened* is a
census, and needs the guarantee.

The gap matters most exactly where it is easiest to miss — when the listing looks
exhaustive because it is contiguous, saturated and internally consistent. None of
those properties is the guarantee.

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
