STATUS: LOCKED FOR PRE-BETA
TARGET: BETA READY

IMPORTANT:
This document defines the mandatory ATLAS PROOF intelligence behavior
that must exist BEFORE BETA testing starts.

Do not redesign this architecture.
Do not expand intelligence beyond the boundaries defined here.
Do not implement future PLUS / PRO intelligence prematurely.

The goal before BETA is NOT to create a perfect autonomous intelligence.

The goal is to create a correct, observable, controlled research core
that can be tested on real Proofs during BETA.

Real BETA behavior will determine future corrections.

NOTE (added by product team, 2026-08-16):
Section 32 below mentions TON Connect + GRAM as part of pre-BETA payment
scope. This is SUPERSEDED. Confirmed decision: Telegram Stars is the
only payment method in BETA/START. TON/GRAM is deferred to a future
Plus tier and is OUT of BETA scope. Treat this as resolved, not an
open question.

============================================================
0. CENTRAL PRE-BETA PRINCIPLE
============================================================

ATLAS must remain narrow before BETA.

ACTIVE TOPIC:
Token Value Capture

ACTIVE LEARNING BOUNDARY:
PROJECT

ATLAS is currently allowed to learn how to research Projects
inside the active Topic.

ATLAS is NOT currently allowed to autonomously:
- discover and activate new Topics;
- create new Topic Research Patterns;
- develop Connections;
- modify its own core research rules;
- change verdict logic;
- rewrite its own learning policy;
- expand its own capability boundary.

Future concepts may exist in data structures as inactive enums/states,
but must not become active functionality before BETA.

Core philosophy:

NARROW FIRST.
RELIABLE FIRST.
EXPAND ONLY AFTER STABILITY.

============================================================
1. THE PRE-BETA CORE
============================================================

Every user request must pass through four invisible filters:

1. REQUEST FILTER
2. RESEARCH FILTER
3. PROOF FILTER
4. LEARNING FILTER

User must NOT see these internal filters.

User experience remains simple:

Paste a claim
→ ATLAS researches
→ Proof
→ optional clarification

Internally:

USER INPUT
→ REQUEST FILTER
→ RESEARCH FILTER
→ RESEARCH / MEMORY
→ PROOF FILTER
→ USER RESULT
→ LEARNING FILTER
→ MEMORY / ISSUE / TELEMETRY

This four-filter architecture is mandatory before BETA.

============================================================
2. FILTER 1 — REQUEST FILTER
============================================================

Purpose:

Understand what the user actually wants BEFORE any expensive research.

No understood intent = no research.

Request Filter must handle:

- normal claim;
- typo;
- wrong keyboard layout;
- incomplete sentence;
- short follow-up;
- meaningless text;
- ambiguous text;
- multiple claims;
- unsupported request;
- prompt injection / adversarial instructions;
- request unrelated to current ATLAS capability.

Recommended internal pipeline:

RAW_INPUT
→ NORMALIZE
→ INPUT_SANITY_CHECK
→ LANGUAGE_DETECTION
→ KEYBOARD_LAYOUT_RECOVERY
→ TYPO_NORMALIZATION
→ INTENT_RESOLUTION
→ CLAIM_EXTRACTION
→ PROJECT_RESOLUTION
→ SCOPE_CHECK

The system should use a cheap model / cheap deterministic processing
where possible.

Do NOT launch the expensive Research Engine simply to understand a typo.

------------------------------------------------------------
2.1 INTENT CONFIDENCE
------------------------------------------------------------

Internal:

HIGH
MEDIUM
LOW

HIGH:
ATLAS understands the request and can proceed.

MEDIUM:
ATLAS may ask a minimal clarification when the ambiguity could materially
change the research or cause paid research.

LOW:
No research.

User never sees HIGH / MEDIUM / LOW.

------------------------------------------------------------
2.2 OUT-OF-SCOPE REQUESTS
------------------------------------------------------------

START must not attempt to answer everything in crypto.

If a request is understandable but outside the active capability,
do not run unrestricted research.

Example:

User:
"Who are the founders of Project X?"

If this does not materially relate to Token Value Capture:

Internal:
OUT_OF_SCOPE

User-facing response should be soft and simple.

Do NOT show:
UNSUPPORTED_TOPIC
OUTSIDE_CAPABILITY
ERROR

Instead explain that ATLAS currently specializes in a specific class
of verifiable crypto research and help the user formulate an appropriate claim.

------------------------------------------------------------
2.3 FUTURE SIGNAL
------------------------------------------------------------

An out-of-scope request MAY create a lightweight future signal.

Example:

FUTURE_TOPIC_SIGNAL

But START must NOT:
- investigate the possible new Topic;
- spend research budget exploring it;
- create a Topic Pattern;
- activate a new capability.

Signal only.

============================================================
3. FILTER 2 — RESEARCH FILTER
============================================================

After ATLAS understands the request,
it must NOT immediately start web research.

First question:

WHAT DO WE ALREADY KNOW?

Research Filter has only three primary modes:

A. MEMORY
B. TARGETED_REFRESH
C. FRESH_RESEARCH

------------------------------------------------------------
3.1 MEMORY MODE
------------------------------------------------------------

Use when ATLAS already has enough relevant,
sufficiently fresh verified research.

Example:

Same or semantically equivalent claim was already researched.

Do not repeat the full research.

Retrieve:

- relevant Proof;
- relevant Proof Version;
- Evidence;
- Project;
- Topic;
- data_as_of;
- freshness information.

Then generate the user-facing result.

Important:

Semantic matching must not rely on exact text.

Match should consider:

PROJECT
+
TOPIC
+
CLAIM / SUBCLAIM MEANING
+
TIMEFRAME
+
CURRENT/HISTORICAL NATURE

Example:

"Pump burns half its revenue"

and

"Does Pump.fun direct 50% of revenue to PUMP buybacks and burns?"

may represent the same underlying researched claim.

------------------------------------------------------------
3.2 TARGETED REFRESH MODE
------------------------------------------------------------

Use when most research remains valid,
but a material dynamic fact may have changed.

Example:

Historical mechanism is known,
but current ACTIVE / PAUSED status may be stale.

Do NOT rerun the entire Proof.

Reuse existing verified Evidence.

Refresh only the stale or missing research step.

Core rule:

REUSE DOES NOT OVERRIDE FRESHNESS.

------------------------------------------------------------
3.3 FRESH RESEARCH MODE
------------------------------------------------------------

Use when:

- no adequate Proof exists;
- Evidence is insufficient;
- project is new;
- material claim is new;
- existing research cannot answer the request.

Then build an Adaptive Research Plan.

============================================================
4. ACTIVE RESEARCH BOUNDARY
============================================================

Before FRESH_RESEARCH or TARGETED_REFRESH begins,
ATLAS must establish a Research Boundary.

Research must not begin as:

"What interesting information can I find?"

It must begin as:

"What exactly must be proven or disproven?"

Internal Research Contract should contain:

project_id
topic_id
claim_id
subclaims
known_information
reusable_evidence
required_fresh_evidence
required_pattern_steps
already_satisfied_steps
missing_steps
excluded_scope
stop_conditions
research_budget

ATLAS must explicitly know:

WHAT TO RESEARCH
WHAT IS ALREADY KNOWN
WHAT MUST BE FRESH
WHAT NOT TO RESEARCH
WHEN TO STOP

============================================================
5. ACTIVE TOPIC — TOKEN VALUE CAPTURE
============================================================

Before BETA only Token Value Capture is active.

Current Research Pattern v1 guides the research.

The Pattern determines questions.

Evidence determines the answer.

Never force a new project to resemble an existing project.

Pattern must support different outcomes such as:

- burn;
- inaccessible destination;
- treasury;
- redistribution;
- staking;
- no token value capture;
- governance-controlled allocation;
- proposed but not executed;
- paused mechanism;
- unclear mechanism.

Pattern must NOT predetermine verdict.

Core rule:

RESEARCH MEMORY GUIDES.
FRESH EVIDENCE VERIFIES.

============================================================
6. NEW PROJECT BEHAVIOR
============================================================

The primary intelligence objective before and during BETA is:

Can ATLAS correctly research a crypto project it has never seen before?

For an unknown Project:

CLAIM
→ PROJECT RESOLUTION
→ ACTIVE TOPIC
→ TOPIC PATTERN
→ DISCOVER PROJECT RESEARCH SURFACE
→ BUILD PLAN
→ RESEARCH
→ EVIDENCE
→ PROOF
→ PROJECT MEMORY

ATLAS should learn how to research the Project,
not create an encyclopedia about it.

Allowed Project Memory includes:

- official docs;
- official governance;
- official dashboards;
- protocol-native sources;
- useful addresses/contracts where relevant;
- terminology;
- metric semantics;
- useful research queries;
- bad queries;
- dead ends;
- source purpose;
- freshness behavior;
- known research caveats;
- execution verification routes.

Do not save unrelated information simply because it was discovered.

============================================================
7. PROJECT MEMORY
============================================================

Project Memory exists to answer:

"How should ATLAS research this Project better next time?"

Not:

"What information have we ever seen about this Project?"

Recommended lifecycle:

OBSERVED
→ CANDIDATE
→ ACTIVE

Possible health states:

QUESTIONABLE
REVERIFY
STALE
DEPRECATED

Material knowledge must not automatically become trusted ACTIVE memory
solely because an LLM generated it.

Important distinction:

FACT MEMORY:
what was true at a particular time.

RESEARCH MEMORY:
how ATLAS should efficiently verify that type of fact again.

Research Memory is strategically more durable.

============================================================
8. KNOWLEDGE BASE QUALITY
============================================================

The ATLAS Knowledge Base must NOT become a generic scraped internet RAG.

Internet = raw research material.

ATLAS Knowledge Base = research-processed knowledge.

Recommended conceptual states:

RAW
→ EVIDENCE
→ VERIFIED / ACTIVE KNOWLEDGE

Historical state management:

STALE
SUPERSEDED
DEPRECATED

Every important Evidence item should retain:

source
URL
publisher/source type
fetched_at
observed_at
data_as_of
relevant fragment
project
topic
claim/subclaim
research step
support/contradict/context relationship
freshness information
limitations

============================================================
9. CLARIFICATION / FOLLOW-UP
============================================================

If an existing Proof answers the original claim,
user may request clarification.

Clarification must remain connected to the Parent Proof.

Do not treat every clarification as an independent research request.

Required relationship:

PARENT PROOF
+
USER CLARIFICATION
→ INTENT RESOLUTION
→ EXISTING KNOWLEDGE
→ MISSING INFORMATION
→ DELTA

Every new follow-up research must have a defined Delta.

If Delta = 0:
No new research.

If Delta is small:
Targeted Refresh / Delta Research.

If Delta requires genuinely new research:
create a child Research Job.

If request leaves the current capability:
do not launch unrestricted research.

------------------------------------------------------------
9.1 FOLLOW-UP RESEARCH CONTRACT
------------------------------------------------------------

Store:

parent_proof_id
parent_proof_version_id
clarification_id
clarification_text
resolved_intent
project_id
topic_id
pattern_id
reused_evidence_ids
reused_pattern_steps
missing_steps
excluded_scope
child_research_job_id

============================================================
10. DELTA RESEARCH
============================================================

Delta Research means:

Research only what the user is asking beyond what ATLAS already knows.

Example:

Existing Proof already confirms:

Revenue
Allocation
Buyback
Burn

User asks:

"Does this actually make the token deflationary?"

ATLAS should NOT redo Revenue → Burn.

Research target becomes:

Net Token Effect

Potential dependencies:

burn amount
unlocks
vesting
claims
emissions
circulating supply change

This is mandatory research discipline.

============================================================
11. NOVELTY
============================================================

Before BETA support simple internal novelty classification:

KNOWN
PARTIALLY_KNOWN
NOVEL

Purpose:

Prevent ATLAS from forcing an unknown mechanism into an existing Pattern.

Example:

New Project + familiar mechanism:
Project = NEW
Mechanism = KNOWN

Normal.

New Project + mechanism not adequately explained by Pattern:
Mechanism = NOVEL

Then:

- perform enough research to answer the current Proof;
- increase caution;
- preserve uncertainty;
- create NOVELTY_SIGNAL if useful;
- do NOT autonomously create a new Topic or Pattern.

============================================================
12. SEARCH / SOURCE DISCIPLINE
============================================================

Source priority:

1. protocol-native / on-chain where directly relevant
2. official documentation
3. official governance
4. official reports / dashboards
5. strong primary data providers
6. high-quality independent analytics
7. media
8. social / forums / blogs for discovery only

Lower-quality sources may guide discovery,
but should not independently support strong conclusions.

Store Research Attempts:

USEFUL
PARTIAL
DUPLICATE
DEAD_END
LOW_QUALITY
BLOCKED
STALE
IRRELEVANT
ERROR

============================================================
13. STOP CONDITIONS
============================================================

ATLAS must not research indefinitely.

A branch can stop when:

- authoritative Evidence is sufficient;
- material claim is covered;
- required freshness is satisfied;
- material contradictions are reconciled;
- remaining gaps cannot materially change the verdict.

Do NOT continue collecting repetitive articles after Evidence is sufficient.

============================================================
14. QUALITY-FIRST RECOVERY
============================================================

If the optimal internal research route fails,
ATLAS may perform additional targeted research.

Example:

Expected Project Memory was not retrieved.

Do not immediately give the user a worse Proof.

If reasonable additional research can recover quality:

perform Recovery Research.

User does NOT see internal diagnostic details.

User sees normal research progress.

Internal:

QUALITY may PASS
while
EFFICIENCY may FAIL.

Quality has priority over efficiency.

However:

Recovery must respect a HARD SAFETY BUDGET.

No infinite loops.

============================================================
15. PROOF FILTER
============================================================

Research completion does NOT automatically mean
the result can be shown to the user.

Proof Filter checks:

- sufficient Evidence;
- acceptable source quality;
- appropriate freshness;
- material contradictions handled;
- verdict supported;
- confidence calibrated;
- gaps disclosed;
- traceability preserved.

Current verdict set:

SUPPORTED
PARTIALLY_SUPPORTED
NOT_ENOUGH_EVIDENCE
MISSING_CONTEXT
CONFLICTING_EVIDENCE

If Evidence is insufficient:

DO NOT guess.

Return an honest limited verdict.

============================================================
16. USER RESULT
============================================================

User should see a simple result.

Suggested structure:

Verdict
Confidence
Simple explanation
Why it matters
Main nuance / risk
Evidence
Sources
Freshness / data_as_of
Optional Clarify action

Do NOT show:

- Memory Retrieval Failure;
- Planning Failure;
- Search Failure;
- internal recovery;
- model routing;
- expected cost;
- actual cost;
- learning candidates;
- internal Issue classification.

Internal complexity must remain internal.

============================================================
17. LEARNING FILTER
============================================================

After every Proof ATLAS asks:

"Is there useful research experience that I am currently allowed to learn?"

Before BETA:

ACTIVE LEARNING OBJECT = PROJECT

Allowed learning:

- Project sources;
- source purpose;
- project terminology;
- research queries;
- query lessons;
- dead ends;
- metric semantics;
- freshness behavior;
- project-specific research routes.

Not allowed:

- autonomous Topic creation;
- autonomous Topic Pattern creation;
- Connection learning;
- self-modification of core planner;
- self-modification of verdict policy.

Possible future information may become SIGNAL only.

============================================================
18. SELF REVIEW — KEEP IT SIMPLE
============================================================

Before BETA Self Review must be structured,
not an unrestricted AI essay.

Two top-level outputs:

QUALITY
EFFICIENCY

QUALITY:

evidence_sufficient
freshness_sufficient
primary_evidence_available
material_conflicts_resolved
verdict_supported
confidence_appropriate

EFFICIENCY:

memory_available
memory_retrieved
memory_used
search_count
useful_search_count
duplicate_search_count
source_open_count
duplicate_source_count
dead_end_count
recovery_used
recovery_search_count
time_to_first_strong_evidence
total_research_time
estimated_cost
actual_cost

LEARNING:

new_project_memory_candidate
memory_questionable
memory_reverify_required
novelty_signal
internal_issue_candidate

============================================================
19. INTERNAL ERROR DIAGNOSIS
============================================================

Do not try to predict and solve every possible error before BETA.

But make the pipeline observable enough to locate failure.

Diagnostic chain:

Did relevant memory exist?
→ Was it retrieved?
→ Was it used in the Plan?
→ Was the Plan followed?
→ Was Evidence found?
→ Was freshness handled?
→ Was Evidence interpreted correctly?
→ Was the verdict derived correctly?

Possible root causes may include:

Knowledge Gap
Memory Retrieval Failure
Planning Failure
Search Failure
Source Failure
Freshness Error
Interpretation Error
Reasoning Error
Technical Error

Important:

If correct knowledge already exists,
do NOT solve the problem by adding a duplicate memory rule.

Fix the layer that failed.

============================================================
20. ADMIN BEFORE BETA
============================================================

Keep Admin simple.

Only three main views:

ISSUES
LIVE CHANGES
NEXT RELEASE

Before BETA its purpose is:

- see internal problems;
- inspect affected Proof;
- inspect relevant telemetry;
- classify root cause;
- record manual external AI review if used;
- apply safe memory-level correction;
- queue system/code problems for Claude Code.

Do NOT build advanced intelligence dashboards now.

============================================================
21. LIVE VS CODE CHANGE
============================================================

Simple rule:

Knowledge/state correction
→ LIVE CHANGE

Mechanism/code correction
→ NEXT RELEASE / CLAUDE CODE

Pattern v1 is protected before BETA.

Do not freely edit the active Pattern live.

Material Pattern changes require controlled release + regression.

============================================================
22. BETA LEARNING LOOP
============================================================

This is the main development cycle after the PRE-BETA foundation works.

REAL CLAIM
→ PROOF
→ SELF REVIEW
→ ISSUE / LEARNING
→ FIX
→ NEXT REAL PROOF
→ OBSERVE
→ VALIDATE

We do NOT need to guess all future errors today.

BETA will reveal real problems.

The architecture only needs to make those problems:

VISIBLE
DIAGNOSABLE
FIXABLE
MEASURABLE

============================================================
23. BETA TEST STRATEGY
============================================================

Initial base:

5 existing VERIFIED projects
+
Token Value Capture Research Pattern v1

Continue:

Proof #006
Proof #007
Proof #008
Proof #009
...

Use real projects and real claims.

Primary test:

Can ATLAS correctly research a Project it has never seen before?

Secondary test:

After researching that Project once,
does a second Proof about it use Project Memory
and avoid rediscovering the same research environment from zero?

Also retain the original five projects as Regression Benchmark.

============================================================
24. REGRESSION
============================================================

The original five projects remain permanent initial regression cases.

After material Research Intelligence changes:

Run 5/5.

But do NOT optimize only for those five.

BETA must include unseen projects.

Important test:

UNKNOWN PROJECT
→ FIRST PROOF
→ PROJECT MEMORY CREATED

then:

SAME PROJECT
→ DIFFERENT CLAIM
→ PROJECT MEMORY REUSED

Expected trend over time:

dead ends ↓
duplicate search ↓
time ↓
cost ↓

while:

Evidence Quality same or ↑
Verdict Quality same or ↑
Freshness same or ↑

============================================================
25. CORE RESEARCH JOB STATE MACHINE
============================================================

Keep the worker state machine understandable.

Recommended:

QUEUED
→ UNDERSTANDING_REQUEST
→ RESOLVING_PROJECT
→ CHECKING_SCOPE
→ CHECKING_MEMORY
→ BUILDING_RESEARCH_BOUNDARY
→ BUILDING_PLAN
→ RESEARCHING
→ RECOVERY_RESEARCH (optional)
→ EXTRACTING_EVIDENCE
→ RECONCILING
→ BUILDING_PROOF
→ PROOF_QUALITY_CHECK
→ PRESENTING_RESULT
→ SELF_REVIEW
→ LEARNING_REVIEW
→ COMPLETED

Optional:

AWAITING_USER_CLARIFICATION

Terminal:

FAILED
CANCELLED
BUDGET_LIMIT_REACHED

Persist state transitions.

Retries must be idempotent.

============================================================
26. MINIMUM DATA MODEL
============================================================

Do not prematurely build a huge intelligence graph.

PostgreSQL is sufficient.

Required core domain entities:

User
UserIdentity
Topic
Project
ProjectAlias
Claim
ClaimSubclaim

ResearchPattern
ResearchPatternStep

ResearchMemory
ProjectMemoryItem

Source
SourceFetch
ResearchAttempt
Evidence

ResearchJob
ResearchJobTransition
ResearchPlan
ResearchPlanStep

Proof
ProofVersion
ProofEvidence
ProofGap
ProofConflict

Clarification
ResearchReview
LearningCandidate

Issue
LiveChange

RegressionCase
RegressionRun

LinksAccount
LinksLedger
LinksHold

Payment / Subscription entities as defined in the current payment layer.

Use relational columns for:
identity
status
relationships
timestamps
verdict
confidence
money

Use JSONB only for flexible structured metadata.

Do not create one giant opaque JSON database.

============================================================
27. PROVIDER ABSTRACTIONS
============================================================

Keep providers replaceable.

ModelGateway
SearchGateway
ContentFetcher
ChainDataGateway
PaymentProvider

Foundation model choice must not be hardwired into product logic.

Use task-based model routing.

Cheap/simple model:
- input understanding;
- classification;
- extraction;
- deduplication;
- source triage.

Stronger reasoning model:
- reconciliation;
- conflicts;
- verdict;
- Proof quality review.

Expensive escalation:
only when materially required.

============================================================
28. STRUCTURED OUTPUTS
============================================================

Critical AI steps must use structured schemas.

Do not rely on parsing unrestricted model prose for:

- project resolution;
- intent;
- scope;
- research plan;
- Evidence extraction;
- verdict;
- confidence;
- Self Review;
- Learning Candidate;
- Issue routing.

Validate model output at runtime.

Retry schema failures safely.

============================================================
29. RESEARCH BUDGET
============================================================

Every Research Job must have hard limits.

Track at minimum:

max_search_queries
max_source_opens
max_model_cost
max_total_variable_cost
max_retries
max_wall_clock_time

Recovery may temporarily use reserved recovery budget.

Budget exhaustion must NOT generate fabricated certainty.

Preserve collected Evidence and return an honest gap/verdict.

============================================================
30. TELEMETRY
============================================================

Persist enough data to analyze BETA later.

Per Proof:

project
topic
memory_available
memory_retrieved
memory_used
searches_attempted
searches_useful
duplicate_searches
sources_opened
duplicate_sources
dead_ends
recovery_used
recovery_searches
time_to_first_strong_evidence
total_time
model_calls
model_tokens
model_cost
search_cost
external_data_cost
total_variable_cost
quality_result
efficiency_result
human_correction_required
issue_count

Do not overbuild analytics UI.

Persist the data first.

============================================================
31. SECURITY / SAFETY
============================================================

Mandatory before BETA:

- server-side Telegram initData validation;
- authorization;
- admin role separation;
- API rate limiting;
- safe URL fetching;
- SSRF protection;
- content size limits;
- fetch timeouts;
- redirect validation;
- XSS-safe source rendering;
- no arbitrary remote JS execution;
- secrets outside code;
- database backups;
- idempotency for jobs/payments/Links;
- global emergency pause flags.

User content is untrusted data.

A user cannot change:

- system instructions;
- Capability Contract;
- Research Pattern;
- Learning Boundary;
- budget limits;
- verdict policy.

============================================================
32. PAYMENT SCOPE
============================================================

Keep payment implementation separate from Research Intelligence.

Current approved direction must be respected:

Telegram environment:
Telegram Stars (XTR)

Additional subscription payment (DEFERRED — see note at top of document):
TON Connect + GRAM — NOT part of BETA/START scope. Planned for future Plus tier.

Links:
internal research units.

Payment status must never directly change research truth or confidence.

Payment buys access / capacity / additional research,
not a "better truth."

============================================================
33. UI SCOPE BEFORE BETA
============================================================

Keep the approved START visual direction.

User does not need to see internal architecture.

Core screens:

HOME
RESEARCH PROGRESS
PROOF RESULT
PROOF MAP / EVIDENCE
LINKS / ACCESS

User-facing research progress remains simple:

Understanding claim
Using Research Memory
Searching fresh evidence
Building Proof

Do not expose internal:
Scope Gate
Delta
Pattern steps
Recovery
Self Review
Issues
Learning Candidate

============================================================
34. WHAT MUST NOT BE BUILT BEFORE BETA
============================================================

DO NOT IMPLEMENT YET:

autonomous Topic Discovery
automatic Topic activation
automatic Topic Pattern generation
Connection Intelligence
graph database
self-fine-tuning
online gradient updates
autonomous prompt rewriting
self-modifying code
autonomous global learning policy
fully autonomous Admin correction
complex multi-agent orchestration
large intelligence dashboards
unrestricted internet exploration
automatic expansion beyond Token Value Capture

Leave extension points where useful.

Do not activate them.

============================================================
35. PRE-BETA ACCEPTANCE TEST
============================================================

PRE-BETA is ready only when the following end-to-end path works:

User enters a valid claim.

ATLAS:
1. understands the input;
2. resolves the Project;
3. confirms Token Value Capture scope;
4. checks existing Knowledge Base;
5. chooses MEMORY / REFRESH / RESEARCH;
6. establishes Research Boundary;
7. retrieves relevant Pattern and Memory;
8. builds Research Plan;
9. performs fresh research only where needed;
10. collects traceable Evidence;
11. handles material conflicts;
12. runs Recovery when reasonably necessary;
13. stops at sufficient Evidence;
14. builds Proof;
15. passes Proof Quality Filter;
16. presents a simple result;
17. performs structured Self Review;
18. extracts Project Learning Candidate if useful;
19. logs internal problems without exposing them to the user;
20. persists telemetry.

Then a second claim for the same Project must prove that
Project Memory can influence the next Research Plan.

============================================================
36. PRE-BETA SUCCESS DEFINITION
============================================================

Do NOT require ATLAS to be perfect before BETA.

BETA exists to find real errors.

Before BETA we require:

CORRECT ARCHITECTURE
+
CONTROLLED BOUNDARIES
+
OBSERVABILITY
+
RECOVERY
+
QUALITY GATE
+
LEARNING LOOP
+
PERSISTENT MEMORY
+
REAL END-TO-END RESEARCH

We do not require:

perfect retrieval
perfect planning
perfect search efficiency
perfect cost
perfect Project discovery
zero reasoning errors

Those will be improved from real BETA Proofs.

============================================================
37. CURRENT LEARNING CONSTITUTION
============================================================

For the current version:

ACTIVE TOPIC:
TOKEN VALUE CAPTURE

ACTIVE LEARNING OBJECT:
PROJECT

ACTIVE USER RESEARCH:
TOKEN VALUE CAPTURE CLAIMS

MEMORY:
REUSE FIRST

FRESHNESS:
FRESH EVIDENCE OVERRIDES OLD ASSUMPTIONS

NEW PROJECT:
RESEARCH + LEARN PROJECT

KNOWN PROJECT:
REUSE PROJECT MEMORY

FOLLOW-UP:
DEFINE DELTA BEFORE RESEARCH

OUT-OF-SCOPE:
SOFT USER REDIRECTION + OPTIONAL SIGNAL

UNKNOWN MECHANISM:
NOVELTY SIGNAL, NOT AUTONOMOUS EXPANSION

INTERNAL FAILURE:
RECOVER QUALITY WHEN REASONABLE

USER:
DO NOT EXPOSE INTERNAL FAILURES

LEARNING:
CONTROLLED

TOPIC DISCOVERY:
OFF

CONNECTION DISCOVERY:
OFF

SELF-MODIFICATION:
OFF

============================================================
38. FINAL RULE FOR CLAUDE CODE
============================================================

DO NOT make ATLAS broader before BETA.

Make the narrow core observable, reliable and testable.

Do not solve hypothetical future intelligence problems.

Build the architecture so real BETA Proofs can tell us:

what failed,
where it failed,
whether the user was affected,
how much recovery was required,
what should be corrected,
and whether the correction improves later Proofs.

The next intelligence architecture decisions will be based on
real BETA evidence.

Until then:

BUILD THE CORE.
PRESERVE THE BOUNDARIES.
DO NOT EXPAND THE CONCEPT.
