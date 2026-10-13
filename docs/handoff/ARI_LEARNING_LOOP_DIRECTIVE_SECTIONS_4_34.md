# ATLAS PROOF — ARI LEARNING LOOP

**Continuation only — Sections 4–34 from the complete directive.**

Use this file only to complete the previously truncated review. Do not reinterpret Sections 0–3; append this continuation to the existing directive.

# 4. CORE VS RESEARCH MEMORY

This distinction must remain clear.

## CORE

CORE answers:

> **HOW should Atlas research?**

CORE contains durable research principles, reasoning rules, methodology, scope-control rules, and validated research patterns.

Examples:

```text
Proposal ≠ Live Mechanism
System Utility ≠ Economic Capture
Abstraction ≠ Removal
Same Asset ≠ Same Economic Flow
```

CORE should stay:
- small;
- high quality;
- slow-changing;
- highly validated;
- broadly reusable.

CORE must not become a dump of project facts.

## Research Memory

Research Memory answers:

> **WHAT has Atlas already seen, checked, and learned?**

It contains accumulated experience from prior research:
- project-specific mechanisms;
- previous Proofs;
- important evidence;
- research paths;
- lessons;
- candidate patterns;
- contradictions;
- unresolved gaps;
- timestamps;
- provenance.

Research Memory can be large.

It should be retrieved selectively, not loaded in full.

---

# 5. KNOWLEDGE LEVELS

## LEVEL 1 — PROOF MEMORY / EPISODIC EXPERIENCE

Concrete experience from one research case.

Example:

```text
In RENDER, customer/network usage causes RENDER burn,
while node rewards are paid through a separate emissions allocation.
```

This is:
- specific to a case;
- source-backed;
- timestamped;
- potentially stale later;
- useful as prior experience.

It should point back to the originating Proof and evidence.

## LEVEL 2 — LESSON / PATTERN MEMORY

A reusable research lesson extracted from one or more Proofs.

Example:

```text
Same Asset ≠ Same Economic Flow
```

Another example:

```text
Buyback existence does not prove that the buyback is funded by current protocol revenue.
```

This level contains:
- observations;
- candidate patterns;
- supported patterns;
- counterexamples;
- validation history.

These are not yet automatically permanent CORE rules.

## LEVEL 3 — CORE

A compact set of the strongest validated research principles.

CORE should only receive lessons that have passed sufficient validation and human approval.

---

# 6. A LARGE VERIFIED KNOWLEDGE BASE IS A SEPARATE ASSET

ATLAS should accumulate a large, verifiable research base over time.

This base is not identical to CORE.

It should contain:

```text
claim
→ source
→ evidence
→ mechanism
→ date verified
→ Proof
```

The long-term value is that another person should be able, where practical, to trace the reasoning back to evidence and verify why Atlas reached the result.

The database should become valuable because it is:
- built from real research;
- source-backed;
- dated;
- structured;
- reusable;
- increasingly rich in mechanisms and historical context.

The quality of this base matters more than raw volume.

Principle:

> **100 strong Proofs are more valuable than 10,000 low-quality answers.**

---

# 7. NEW QUESTION FLOW

A future research request should follow a controlled sequence.

```text
User Question
→ Intent / Research Type
→ Relevant Memory Retrieval
→ Research Plan
→ Research Execution
→ Evidence
→ Preliminary Conclusion
→ Review / Validation
→ Proof
→ Lesson Extraction
→ Memory Update
```

Example:

User asks:

```text
"The protocol earns revenue. Does the token actually capture any of it?"
```

ATLAS identifies:

```text
Intent: Token Value Capture
```

Then Research Memory may surface:

```text
System Utility ≠ Economic Capture
Mechanism State Gate
Token State Qualification
```

Those lessons should change the research plan.

Instead of researching blindly, Atlas immediately knows to inspect:
- whether revenue really exists;
- who pays it;
- who receives it;
- whether the mechanism is live;
- whether the token participates;
- which token state matters;
- whether holders have any economic entitlement;
- whether any transfer is being confused with capture.

Past experience must have a functional effect on the next investigation.

Otherwise, Research Memory is only an archive.

---

# 8. SEMANTIC RETRIEVAL

ATLAS must be able to retrieve prior experience by meaning, not only exact words.

Example:

New question:

```text
"The protocol makes fees. Does the token get anything?"
```

Past lesson:

```text
"Protocol revenue does not automatically create holder capture."
```

Different wording, same research problem.

V1 should consider hybrid retrieval using:
- embeddings / semantic similarity;
- intent;
- project;
- topic;
- mechanism type;
- validation state;
- timestamp / freshness;
- metadata;
- possibly source type.

The system should normally retrieve only a small number of highly relevant memories.

Suggested starting point:

```text
Top-K: 3–5 memories / patterns
```

This is a design starting point, not a hard permanent rule.

Do not inject the entire Research Memory into every model call.

---

# 9. WHAT SHOULD BE EMBEDDED

Claude Code should review the exact design, but likely candidates include:
- normalized research question;
- concise Proof summary;
- lesson text;
- mechanism summary;
- pattern description;
- unresolved research gap;
- project/topic metadata.

Do not blindly embed every raw source fragment as “learning.”

Evidence retrieval and research memory retrieval may be related but should remain conceptually distinct.

Important:

> evidence is what supports a claim;
> memory is prior research experience that may help decide what to check.

---

# 10. WHAT SHOULD HAPPEN AFTER A PROOF

After a high-quality Proof, ATLAS should perform a separate learning step:

> **Did this research teach us anything genuinely new?**

There are two valid outputs.

## Output A — Nothing new

```text
No new reusable lesson.
Existing CORE / Research Memory already explains this case.
```

This is a good outcome.

Memory should **not** grow after every Proof.

Otherwise the system becomes polluted with duplicates.

## Output B — New reusable observation

Example:

```text
A buyback can be operational while its claimed revenue funding source remains unverified.
```

This becomes a **Lesson Candidate**, not a CORE rule.

The new item must preserve provenance:
- originating Proof;
- supporting evidence;
- verified date;
- project;
- mechanism;
- extracted reasoning;
- confidence / validation state.

---

# 11. LEARNING LIFECYCLE

A safe lifecycle can be:

```text
OBSERVATION
→ CANDIDATE
→ SUPPORTED
→ CORE PROPOSAL
→ HUMAN DECISION
→ CORE
```

The exact enum names can be proposed later.

The principle is more important than the labels.

---

# 12. HOW A LESSON IS EVALUATED

Do not use a simplistic rule such as:

```text
3 confirmations = truth
```

ATLAS should evaluate multiple dimensions.

## 12.1 Repeatability
How many independent Proofs support the lesson?

## 12.2 Diversity
Did the lesson work across genuinely different:
- projects;
- architectures;
- sectors;
- mechanism types;
- token states?

Three nearly identical projects are weaker evidence than three structurally different cases.

## 12.3 Counterexamples
Has ATLAS found a case where the rule fails?

A counterexample does not always mean the lesson must be deleted.

It may mean the lesson needs refinement.

Example:

Too strong:

```text
Utility ≠ Value Capture
```

More precise:

```text
Utility alone does not prove Value Capture.
```

The Learning Loop should make rules more accurate over time, not merely count confirmations.

## 12.4 Evidence Strength
Were the supporting cases based on:
- primary sources;
- current implementation evidence;
- strong mechanism tracing;
- weak secondary claims;
- assumptions?

Pattern confidence should reflect evidence quality.

## 12.5 Blind / Adversarial Validation
Before a lesson becomes CORE, ATLAS should attempt to break it.

Questions:
- Can we find a counterexample?
- Is this only true in one sector?
- Did we confuse correlation with mechanism?
- Is the wording too broad?
- Does the rule survive unseen cases?

---

# 13. POSSIBLE STARTING PROMOTION GUIDANCE

The following is only a V1 heuristic for discussion, not a hard law:

```text
1 strong case
→ Observation

2–3 independent cases
→ Candidate / early support

4–5 diverse cases
→ Supported Pattern

5+ strong diverse cases
+ no unresolved counterexample
+ blind/adversarial validation
→ CORE Proposal
```

Claude Code should not hard-code these numbers without review.

The important principle:

> **quality + diversity + evidence + counterexamples matter more than raw count.**

---

# 14. HUMAN CONTROL OF CORE

In the initial product, ATLAS may learn and propose, but it must not autonomously rewrite CORE.

ATLAS may automatically:
- extract a lesson;
- detect similarity to an existing pattern;
- store a candidate;
- count supporting Proofs;
- track diversity;
- search for counterexamples;
- estimate evidence strength;
- prepare a promotion proposal.

But final CORE promotion should initially require human approval.

A future CORE proposal UI should support four actions:

```text
APPROVE
NEEDS MORE DATA
REFINE RULE
REJECT
```

The reviewer should not receive only:

```text
"Add this rule?"
```

ATLAS should explain:

```text
Pattern
Supporting Proofs
Project / mechanism diversity
Evidence strength
Known counterexamples
Unresolved contradictions
Blind / adversarial validation result
Why the pattern matters
Recommended action
```

Example:

```text
CORE UPDATE PROPOSAL

Pattern:
Utility alone does not prove value capture.

Support:
6 Proofs
5 independent protocols
multiple mechanism classes

Counterexamples:
0 unresolved

Evidence:
Strong primary-source support

Observed impact:
This rule prevented false-positive reasoning in later research.

Recommendation:
PROMOTE TO CORE
```

---

# 15. PROTECTION AGAINST BAD LEARNING

This is critical.

## User input is not knowledge

If a user asks:

```text
"Did project X steal $100M?"
```

that statement is only a claim to investigate.

It must never become memory as a verified fact merely because the user wrote it.

## LLM output is not automatically knowledge

A model-generated lesson is not sufficient by itself.

The path to reusable knowledge must be grounded in research:

```text
Question
→ Sources
→ Evidence
→ Mechanism
→ Proof
→ Lesson Extraction
→ Validation
→ Memory
```

## Prevent self-reinforcing errors

The dangerous failure mode is:

```text
bad Proof
→ bad lesson
→ bad retrieval
→ worse future Proof
→ more support for the same bad lesson
```

The system must preserve provenance and validation state so any lesson can be inspected and challenged.

---

# 16. TEMPORAL / STALE KNOWLEDGE

ATLAS must separate durable research principles from time-sensitive project facts.

Example of durable principle:

```text
Proposal ≠ Live Mechanism
```

Example of time-sensitive fact:

```text
Mechanism X is currently active.
```

Time-sensitive knowledge should include:
- `verified_at`;
- source provenance;
- project;
- relevant mechanism;
- possibly `valid_as_of`;
- freshness requirements;
- revalidation policy.

ATLAS should not reuse an old project state as if it were automatically current.

A useful rule:

> **Old research may guide where to look, but current-state claims must be reverified when freshness matters.**

---

# 17. CORE EVOLUTION

CORE should evolve slowly.

Example:

```text
CORE v0.1
→ real Proofs
→ Research Memory grows
→ repeated lessons emerge
→ patterns are validated
→ human-approved CORE proposals
→ CORE v0.2
→ more research
→ CORE v0.3
```

CORE should become a **concentrate of thousands of real research experiences**, not a huge prompt containing every fact Atlas has ever seen.

---

# 18. LEARNING LOOP SHOULD IMPROVE RESEARCH PLANNING

Past experience should not merely be quoted in the final answer.

It should influence the research process itself.

Example:

New claim:

```text
"Users pay in fiat, so the native token is no longer needed."
```

Memory retrieves:

```text
Abstraction ≠ Removal
```

This should cause ARI to change the plan:

```text
Do not stop at the user-facing payment layer.
Inspect backend settlement / burn / reward / collateral paths.
```

This is the difference between:

```text
memory as reference material
```

and:

```text
memory as accumulated research intelligence
```

---

# 19. LEARNING LOOP + RESEARCH NARRATIVE

The internal Learning Loop and the user-facing Research Narrative are different layers.

Internally:

```text
Intent
→ Memory
→ Plan
→ Sources
→ Evidence
→ Mechanism
→ Gaps
→ Verdict
```

Externally, ATLAS should not show generic repetitive AI states such as:

```text
Searching...
Analyzing...
Generating...
```

Instead, the Research UI should eventually be able to tell the real investigation story:

```text
Atlas found the original source.
The mechanism is real.
One economic step is still missing.
Two sources conflict.
Execution is not yet proven.
That changes the Verdict.
```

No fake drama.

The story must come from actual research events.

---

# 20. FUTURE SPECIALIST AGENTS

This is a future architecture direction, not a current implementation mandate.

The likely first useful specialization is:

## Main ARI / Atlas
Responsibilities:
- understand user intent;
- plan the research;
- decide which specialist is needed;
- integrate results;
- decide whether evidence is sufficient;
- produce the final Proof;
- remain the only final research decision-maker.

## Research Agent
Narrow responsibility:
- find primary sources;
- collect evidence;
- verify source details;
- return structured findings.

It should not make the final Verdict.

## Mechanism Agent
Narrow responsibility:
- reconstruct actual mechanism;
- actor → action → value/token flow;
- identify missing links;
- separate user layer from infrastructure layer;
- inspect token state and mechanism state where relevant.

It should not invent missing evidence.

## Critic Agent
Narrow responsibility:
- attack the preliminary conclusion;
- find unsupported transitions;
- identify contradiction;
- find missing evidence;
- challenge overconfident verdicts.

It should not rewrite the entire research from scratch.

## Important agent principle

Do not create agents merely because multi-agent systems sound advanced.

Add specialization only when evaluation shows:

```text
specific role
→ fewer errors / better evidence / better research quality
```

Main ARI should remain the orchestrator.

The likely long-term logic is:

```text
User
→ Main ARI
→ selected specialist roles when needed
→ Main ARI
→ Proof
→ Learning Loop
```

Not every query needs every specialist.

---

# 21. FUTURE SPECIALIZATION SHOULD BE MEASURED

Possible evaluation:

```text
A: Main ARI only
B: Main ARI + Research specialist
C: + Mechanism specialist
D: + Critic
```

Measure:
- verdict accuracy;
- evidence quality;
- missing-link detection;
- unnecessary searches;
- latency;
- cost;
- consistency.

If a specialist adds cost but no measurable quality improvement, remove it.

---

# 22. DEVELOPMENT AGENTS ARE A DIFFERENT SYSTEM

Do not confuse future ARI agents with Claude Code subagents used to build ATLAS.

Current development workflow is separate:

```text
Main Claude
→ implementation
→ tests/build/lint
→ independent adversarial review at phase boundary
```

Later blind evaluators may test the Research Engine.

Those development agents are not the same thing as future Research / Mechanism / Critic roles inside ATLAS itself.

---

# 23. BUSINESS VALUE — ACCUMULATED RESEARCH INTELLIGENCE

Research Memory is not only a technical feature.

It can become a major product and business asset.

The value is not:

```text
"We have a lot of data."
```

The value is:

```text
"Atlas has already investigated similar mechanisms,
knows what failed before,
and can use verified prior experience in the next research."
```

This means the value of ATLAS can increase over time even if the UI changes very little.

Example:

Today:

```text
10 projects
50 Proofs
small set of patterns
```

Later:

```text
1,000 projects
100,000 verified Proofs
historical mechanism changes
large Research Memory
validated CORE
```

The same “Ask Atlas” action can become much more valuable because the intelligence behind it has accumulated experience.

---

# 24. SUBSCRIPTION POSITIONING

Important: current LOCKED V1 access logic should not be changed by this document without review.

Current planned public V1 may remain:

```text
DEMO
ARI • CORE
```

The following is business/product direction, not an instruction to change current pricing architecture immediately.

Accumulated Research Intelligence can become one of the strongest reasons to upgrade from DEMO to CORE.

User-facing idea:

> **Atlas doesn't start from zero.**

Potential CORE explanation:

```text
ATLAS CORE

Research that gets stronger with experience.

Atlas doesn't treat every question like the first one. CORE uses verified knowledge and experience from previous Proofs to recognize familiar mechanisms, avoid known research mistakes, and understand what needs to be checked next.

Every completed Proof adds to Atlas's research experience.

As the knowledge base grows, Atlas doesn't just know more — he researches better.
```

The important distinction:

Do not deliberately make DEMO “stupid.”

There should be one developing ARI.

Access tiers may differ in:
- number of Proofs;
- research depth;
- compute / research budget;
- advanced validation;
- monitoring;
- history / accumulated intelligence access;
- professional tooling.

But the learning architecture itself should remain coherent.

---

# 25. POSSIBLE FUTURE BUSINESS LEVELS

This is a future business direction only.

A possible long-term model could be:

```text
DEMO
→ try ATLAS

CORE
→ full Research Intelligence + deeper use of accumulated experience

PRO / INTELLIGENCE
→ higher research budgets, more advanced validation, monitoring, portfolio/project depth
```

Do not implement or lock a third tier solely because it appears in this document.

It is a future strategic option.

---

# 26. WHY THIS CAN IMPROVE UNIT ECONOMICS

Learning Loop can potentially reduce repeated research work.

If ATLAS already has a verified prior Proof on a mechanism, a future query may be able to:

```text
retrieve prior verified context
→ identify what changed
→ reverify current state
→ avoid unnecessary repeated discovery
```

That may reduce:
- redundant searches;
- repeated source discovery;
- unnecessary LLM context;
- repeated reasoning work.

The business effect can be:

```text
more accumulated knowledge
→ potentially lower marginal research cost
→ higher product value
```

But this must be measured, not assumed.

---

# 27. SUCCESS CRITERION

The strongest test of the Learning Loop is not:

```text
"Memory exists."
```

It is:

```text
"Research with relevant memory is measurably better than research without it."
```

ATLAS should eventually support controlled evaluation:

```text
A — ARI without Research Memory retrieval
B — ARI with relevant Research Memory retrieval
```

Measure whether B:
- finds the correct mechanism earlier;
- asks better research questions;
- performs fewer unnecessary searches;
- catches known failure modes more often;
- uses better evidence;
- produces fewer unsupported conclusions;
- reaches better-supported Verdicts;
- reduces repeated mistakes;
- improves latency / cost where possible.

If A and B perform the same, we built an archive, not intelligence.

---

# 28. EVALUATION OF CORE GROWTH

CORE itself should also be evaluated.

A proposed new CORE rule should be tested on:
- cases that originally produced it;
- new unseen projects;
- intentionally adversarial cases;
- counterexamples;
- nearby but different mechanism classes.

CORE growth should make ARI:
- more accurate;
- more disciplined;
- less likely to hallucinate;
- better at knowing what it does not know.

If adding a rule makes reasoning worse or overly rigid, the rule should be refined or removed.

---

# 29. FIRST IMPLEMENTATION SHOULD BE SMALL

Do not build the final grand system immediately.

A good V1 target is likely:

```text
Structured CORE v0.1
+
Proof Memory
+
Lesson Candidate
+
semantic / hybrid retrieval
+
provenance
+
human-controlled promotion
```

Potentially:

```text
simple post-Proof lesson extraction
```

before adding more sophisticated automation.

Avoid immediately building:
- custom neural-network training;
- automatic CORE promotion;
- complex knowledge graphs;
- large autonomous multi-agent memory systems;
- RL-style experience replay;
- heavy background “dreaming”;
- sophisticated confidence mathematics;
- many specialized agents.

Add those only if measured need appears.

---

# 30. FUTURE IMPROVEMENTS — ONLY IF NEEDED

Possible later additions:
- independent memory critic;
- automatic duplicate pattern detection;
- contradiction resolution;
- memory consolidation;
- background stale-memory review;
- ML-based retrieval ranking;
- knowledge graph;
- source reliability scoring;
- agent specialization;
- automatic promotion for very safe categories;
- forgetting / confidence decay;
- memory usefulness scoring;
- portfolio / project-specific intelligence views.

These are not V1 requirements.

---

# 31. IMPORTANT PRODUCT SAFETY RULES

The Learning Loop must preserve:
- provenance;
- uncertainty;
- time context;
- source distinction;
- claim vs fact distinction;
- mechanism state;
- token state;
- human approval for CORE in early versions.

ATLAS should be able to say:

```text
I saw this before,
but the current mechanism needs to be rechecked.
```

and:

```text
This is a candidate lesson, not a validated rule.
```

Unknown must remain a valid state.

---

# 32. WHAT CLAUDE CODE SHOULD DO NOW

Do not implement this whole document immediately.

First perform an architecture review against the current repository and canonical documents.

Return:

## A. What already exists

Identify which current components already support parts of this design.

Inspect, among others:
- `research_patterns`;
- `interpretations`;
- `research_jobs`;
- `proofs`;
- `sources`;
- `evidence`;
- `proof_gaps`;
- `projects`;
- existing worker / job infrastructure;
- current CORE / skill / methodology documents.

Explain what is reusable.

## B. What is missing

Identify the minimum missing pieces required for a real Learning Loop.

## C. Minimal Learning Loop V1

Propose the smallest useful version that allows:

```text
completed Proof
→ reusable structured experience
→ retrieval in a later question
→ research-plan influence
→ candidate lesson
→ human-controlled promotion path
```

## D. Data model

Propose:
- whether new tables are needed;
- whether existing tables should be extended;
- memory item types;
- lesson/pattern status;
- provenance links;
- timestamps;
- project/mechanism metadata;
- validation history.

Do not implement until approved.

## E. Embeddings / vector search

Evaluate:
- PostgreSQL + pgvector or alternative;
- what exactly to embed;
- when to generate embeddings;
- how many vectors per Proof;
- re-embedding rules;
- indexing;
- operational complexity.

## F. Retrieval pipeline

Propose a V1 retrieval flow using only necessary complexity.

Consider:
- semantic similarity;
- intent filter;
- project filter;
- mechanism type;
- validation status;
- freshness;
- Top-K;
- optional reranking.

## G. Bad-learning protection

Show explicitly how the architecture prevents:

```text
bad Proof
→ bad lesson
→ bad future research
```

## H. Temporal knowledge

Show how time-sensitive facts are distinguished from durable patterns.

## I. CORE proposal workflow

Show how later human approval can be added without redesigning the system.

Future actions:

```text
APPROVE
NEEDS MORE DATA
REFINE RULE
REJECT
```

## J. Evaluation

Propose how to test:

```text
memory OFF
vs
memory ON
```

and prove whether the mechanism really improves ARI.

## K. Implementation phase

Recommend:
- the correct future phase;
- prerequisites;
- what should be implemented together;
- what should be postponed.

Do not interrupt the currently approved phase unless there is a genuine architectural blocker.

---

# 33. REQUIRED CLAUDE RESPONSE FORMAT

Return a structured architecture review:

```text
1. What already exists
2. What is missing
3. Recommended Learning Loop V1
4. Proposed data flow
5. Proposed DB changes
6. Embeddings / retrieval design
7. Lesson lifecycle
8. Bad-learning protection
9. Temporal/stale knowledge handling
10. CORE proposal / human approval design
11. Integration with future Research Engine
12. Interaction with future specialist agents
13. Evaluation plan
14. Cost / latency considerations
15. Recommended implementation phase
16. What to postpone
17. STRATEGY REVIEW REQUIRED items
```

Do not write implementation code yet unless separately approved.

---

# 34. FINAL PRINCIPLE

ATLAS should not become “smarter” because it stores more text.

ATLAS should become smarter because it accumulates **verified experience that changes how it investigates the next question**.

The long-term goal is:

```text
Ask
→ Understand
→ Remember relevant experience
→ Investigate
→ Verify
→ Proof
→ Learn
→ Improve future research
```

And the user should experience all of that as something simple:

> **Atlas doesn't start from zero.**
