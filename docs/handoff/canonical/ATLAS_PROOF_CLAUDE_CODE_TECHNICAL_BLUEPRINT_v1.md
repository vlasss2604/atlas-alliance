# ATLAS PROOF — CLAUDE CODE TECHNICAL BLUEPRINT v1

**Status:** PRELIMINARY APPROVED TECHNICAL HANDOFF  
**Date:** 2026-08-15  
**Target:** START / Telegram Mini App  
**Active research Topic:** Token Value Capture  
**Primary rule:** **Simple outside. Precise inside.**  
**Research rule:** **Research Memory guides. Fresh Evidence verifies.**  
**Development rule:** **Do not rebuild the core. Add intelligence layers.**

---

# 0. HOW CLAUDE CODE MUST USE THIS DOCUMENT

This document converts the approved ATLAS PROOF product concept into an implementation blueprint.

Claude Code must NOT treat it as an invitation to redesign the product.

Before coding:

1. Read `ATLAS_PROOF_MASTER_CONTEXT_CURRENT.md`.
2. Read this document fully.
3. Inspect the existing repository.
4. Identify what already exists, what is missing, and what conflicts with the canonical concept.
5. Prefer extending existing modules over duplicating them.
6. Produce a phased plan BEFORE making large changes.
7. Implement one phase at a time.
8. Add tests with every phase.
9. Never weaken Proof integrity to gain speed.
10. If an implementation detail is ambiguous, choose the smallest design that preserves the approved learning mechanic.

If an old document says that Telegram START uses Solana/USDC checkout, that payment rail is stale. Current START direction is:

`Telegram Stars (XTR) → internal Links → paid research action`

The old Solana document remains useful only for the internal accounting principles: ledger, holds, idempotency, capture/release, atomicity.

---

# 1. WHAT ATLAS PROOF ACTUALLY IS

ATLAS PROOF is not a generic chatbot and not a generic "search + summarize" application.

It is a cumulative evidence-driven research system.

The user sees:

```text
Paste a claim
→ ATLAS researches
→ Proof
→ simple explanation
```

Internally the system performs:

```text
Claim
→ understand scope
→ resolve Project
→ confirm supported Topic
→ retrieve Research Pattern
→ retrieve Topic Memory
→ retrieve Project Memory
→ build adaptive Research Plan
→ search fresh information
→ triage sources
→ open/fetch selected sources
→ extract structured Evidence
→ reconcile Evidence
→ apply freshness
→ create structured Proof
→ generate presentation
→ run Research Review
→ detect Issues / Learning Candidates
→ human-controlled learning
→ future Proof becomes better
```

The key product advantage is not simply "AI can search the web."

The advantage must become:

```text
First research:
ATLAS knows the Topic Pattern
but knows little about the new Project
→ more discovery

Later research:
ATLAS knows the Topic Pattern
+ Project sources
+ terminology
+ useful queries
+ dead ends
+ freshness lessons
→ less blind research
→ faster evidence
→ lower cost
→ same or better quality
```

This improvement MUST be observable in telemetry.

---

# 2. IMPORTANT: WHAT "LEARNING" MEANS TECHNICALLY

For START, "ATLAS learns" does NOT mean online training or changing foundation-model weights.

Do NOT implement:
- self-fine-tuning;
- online gradient updates;
- model-weight mutation;
- autonomous prompt rewriting;
- unreviewed self-modifying code;
- raw LLM output automatically becoming permanent truth.

START learning is **application-level cumulative intelligence**:

```text
Verified research experience
→ structured persistent memory
→ retrieval
→ adaptive planning
→ better research behavior
```

The foundation model can remain stateless.

ATLAS becomes cumulative because the application persists:
- Research Pattern;
- Topic Memory;
- Project Memory;
- Source Registry;
- Research Attempts;
- Evidence;
- Proof history;
- Research Reviews;
- approved Live Changes;
- Issue history;
- measured outcomes.

This distinction is mandatory.

---

# 3. START SCOPE — KEEP IT NARROW

START supports one active Topic:

```text
Token Value Capture
```

START learns new Projects inside this Topic.

Do NOT build public arbitrary Topic creation.

Do NOT build:
- cross-topic intelligence;
- automatic Topic creation;
- Connection Graph intelligence;
- portfolio scoring;
- price prediction;
- investment recommendations;
- trading;
- TEAM collaboration;
- autonomous multi-agent orchestration;
- Neo4j;
- a microservice fleet.

Architect the core so those layers can be added later, but do not implement their business logic now.

Future capability ladder:

```text
START
→ learn Projects inside one Topic

PLUS
→ learn new Topics

PRO
→ qualify and use useful Project/Topic Connections
→ identify knowledge gaps

TEAM
→ shared team memory + controlled collaborative learning
```

The learning loop stays the same. Only its allowed scope expands.

---

# 4. SEED INTELLIGENCE — NON-NEGOTIABLE STARTING STATE

Token Value Capture begins with five manually VERIFIED benchmark Proofs:

1. Pump.fun
2. Hyperliquid
3. Aave
4. Ethena
5. Pendle

These serve two roles:

## A. Seed knowledge

They establish:
- initial Topic Memory;
- initial Project Memory;
- Token Value Capture Research Pattern v1.

## B. Permanent Regression Benchmark

After material changes to Research Intelligence, run all five again.

A change fails if it is cheaper/faster but loses an important lesson.

Examples of mandatory benchmark behavior:

### Pump.fun
Must not collapse:
`revenue → buyback → burn`
into a simplistic "burn = bullish" result.
Must consider unlocks/emissions for net effect.

### Hyperliquid
Must understand that a token destination can be effectively inaccessible without a classic burn transaction.

### Aave
Must distinguish historical mechanism existence from current ACTIVE status.
Missing PAUSED status is a benchmark failure.

### Ethena
Must distinguish Protocol Revenue from active token value capture.

### Pendle
Must distinguish buyback from burn and recognize redistribution to sPENDLE holders.

Do NOT fabricate missing seed Evidence or URLs.
If the repository does not contain the canonical Evidence dataset, create import/seed plumbing and flag the missing data for the human rather than inventing it.

---

# 5. TOKEN VALUE CAPTURE RESEARCH PATTERN v1

Pattern v1 has eight conceptual steps.

```text
1. Economic Source
2. Revenue Waterfall
3. Allocation Mechanism
4. Actual Execution
5. Current Status + Freshness
6. Token Destination + Recipient
7. Net Token Effect
8. Durability
```

The Pattern is not a hardcoded linear checklist.

It is an adaptive research policy.

Each step needs:
- objective;
- applicability condition;
- expected evidence types;
- materiality;
- stop condition;
- possible branches;
- skip reason.

Example:

```text
Allocation Mechanism = NONE
→ do not waste calls searching for burn execution
→ investigate whether there is a pending activation / governance path
→ mark downstream token-destination branch as NOT_APPLICABLE where appropriate
```

Example:

```text
Historical buyback program found
but current status unknown
→ prioritize current status / governance / execution evidence
→ do not infer ACTIVE from historical evidence
```

Pattern v1 is protected in START.
Serious Pattern changes go to `NEXT_RELEASE`, not free-form live editing.

---

# 6. RECOMMENDED SYSTEM SHAPE

Prefer a **modular monolith + asynchronous research worker(s)**.

Logical topology:

```text
Telegram Mini App
        |
        v
ATLAS Application API
        |
        +---------------------+
        |                     |
        v                     v
PostgreSQL               Job Queue
                              |
                              v
                       Research Worker
                              |
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
     Model Gateway       Search Gateway       Data/Chain Adapters
          |                   |                   |
          +-------------------+-------------------+
                              |
                              v
                       Evidence / Proof
                              |
                              v
                       Research Review
                              |
                              v
                         Admin Issues
```

Do not create microservices only because modules are logically separate.

If the current repository already has a queue and background worker system, use it.

If greenfield, choose the simplest reliable queue compatible with the existing deployment. A Postgres-backed queue is acceptable if it avoids unnecessary infrastructure. Redis is not required merely because queues exist.

---

# 7. FRONTEND / BACKEND BOUNDARY

The frontend is untrusted.

The backend is authoritative for:
- Telegram authentication;
- user identity;
- entitlement;
- Links balance;
- research pricing;
- research job state;
- Proof data;
- Evidence provenance;
- Live Change application;
- admin actions;
- payment crediting;
- authorization.

The frontend may:
- submit claim text;
- display progress;
- request a Deep Check;
- initiate purchase UI;
- display Proofs;
- submit admin human decisions for authorized admins.

The frontend must NOT:
- mark Proof VERIFIED;
- credit Links;
- define research price;
- approve Learning Candidate;
- change Research Memory directly;
- change Issue severity/owner without an authenticated admin action;
- write source reliability as trusted data.

---

# 8. AUTHENTICATION / USER IDENTITY

START uses Telegram Mini App authentication.

Flow:

```text
Telegram Mini App opens
→ frontend sends Telegram initData to backend
→ backend validates signature
→ backend validates auth_date freshness
→ backend extracts Telegram user
→ resolve/create internal ATLAS User UUID
→ resolve/create Telegram identity relation
→ establish app session
```

Never trust `initDataUnsafe` for authentication.

Identity model:

```text
Telegram user id
= external identity

ATLAS user UUID
= permanent internal domain identity
```

Future providers can attach to the same ATLAS user.

Never use Telegram ID as the universal primary key across the product.

---

# 9. RESEARCH JOB — ASYNCHRONOUS STATE MACHINE

Research is a long-running task. Never perform the whole Proof inside a blocking HTTP request.

Recommended states:

```text
QUEUED
↓
UNDERSTANDING_CLAIM
↓
RESOLVING_SCOPE
↓
RETRIEVING_MEMORY
↓
BUILDING_PLAN
↓
RESEARCHING
↓
EXTRACTING_EVIDENCE
↓
RECONCILING
↓
GENERATING_PROOF
↓
GENERATING_PRESENTATION
↓
SELF_REVIEW
↓
COMPLETED
```

Optional non-terminal state:

```text
AWAITING_USER_CLARIFICATION
```

Terminal/error states:

```text
FAILED
CANCELLED
BUDGET_LIMIT_REACHED
```

Every transition should persist:
- from_state;
- to_state;
- timestamp;
- attempt number;
- optional reason;
- structured telemetry.

Do not rely only on in-memory state.

## Job idempotency

Research job creation must support a client request/idempotency key where useful.

Worker retries must not:
- create duplicate Proof versions;
- double-capture Links;
- duplicate final Evidence records without detection;
- reapply Live Changes.

---

# 10. CLAIM UNDERSTANDING CONTRACT

The Claim Understanding stage should produce structured validated output.

Conceptual schema:

```ts
type TopicScope =
  | "SUPPORTED_TOPIC"
  | "PARTIALLY_SUPPORTED_TOPIC"
  | "UNSUPPORTED_TOPIC";

interface ClaimUnderstanding {
  originalClaim: string;
  normalizedClaim: string;

  detectedProject?: {
    canonicalName?: string;
    aliases?: string[];
    confidence: "HIGH" | "MEDIUM" | "LOW";
  };

  detectedTopic: "TOKEN_VALUE_CAPTURE" | "UNKNOWN";
  topicScope: TopicScope;

  subclaims: Array<{
    id: string;
    text: string;
    supportedByStart: boolean;
    material: boolean;
  }>;

  ambiguity: {
    needsClarification: boolean;
    question?: string;
    reason?: string;
  };

  temporalIntent:
    | "CURRENT"
    | "HISTORICAL"
    | "TIME_BOUND"
    | "UNSPECIFIED";

  timeReference?: string;

  claimType?: string;
}
```

Rules:

1. Compound claims must be decomposed into subclaims.
2. Unsupported subclaims must not be forced into Token Value Capture.
3. If the claim is materially ambiguous, ask the user.
4. Ordinary user clarification goes to the user, not Admin.
5. Do not create a new Topic automatically.

Example:

```text
"PUMP is undervalued because burns exceed unlocks and revenue will keep growing."
```

Possible START treatment:

```text
burns vs unlocks → supported / partially supported
future revenue growth → may be outside factual current scope
undervalued → unsupported valuation conclusion
```

The Proof must clearly state what START checked.

---

# 11. PROJECT RESOLUTION

A project resolver should map aliases to one canonical Project record.

Recommended data:
- project id UUID;
- canonical name;
- slug;
- aliases;
- website/domain hints;
- token symbol(s);
- chain hints;
- qualification status.

Do not create a permanent Project simply because an arbitrary string appeared once.

Unknown project flow:

```text
claim mentions Project X
→ resolve aliases
→ if no match:
   create DISCOVERED candidate record
   research is still allowed
   permanent knowledge status remains limited
```

Project lifecycle:

```text
DISCOVERED
→ CANDIDATE
→ APPROVED
→ ACTIVE_KNOWLEDGE
```

Additional decisions:
- RESEARCH_ONLY
- PRIORITY_LEARNING

User demand is a signal, not an automatic promotion rule.

---

# 12. MEMORY ARCHITECTURE

Keep three concepts separate.

## 12.1 Research Pattern

Answers:

> HOW should this Topic be researched?

It is versioned.

## 12.2 Topic Memory

Answers:

> What reusable lessons have been verified across Projects?

Examples:
- Buyback ≠ Burn
- Protocol Revenue ≠ Token Value Capture
- Announcement ≠ Execution
- Historical mechanism ≠ current mechanism
- recipient/destination matters

## 12.3 Project Memory

Answers:

> WHERE and WITH WHAT should this Project be researched?

Contains:
- official source map;
- governance links;
- dashboards;
- chain addresses/contracts;
- terminology;
- known metrics;
- query lessons;
- dead ends;
- source lessons;
- freshness rules;
- last verified timestamps.

Do not put project-specific facts into a universal Topic rule without cross-project evidence.

---

# 13. MEMORY STATUS MODEL

START needs explicit memory trust states.

Recommended:

```text
OBSERVED
CANDIDATE
ACTIVE
QUESTIONABLE
REVERIFY
DEPRECATED
```

Meaning:

### OBSERVED
Captured from a research run but not yet trusted as durable knowledge.

### CANDIDATE
Potentially useful learning awaiting review or additional evidence.

### ACTIVE
Approved knowledge available for normal retrieval.

### QUESTIONABLE
Previously useful item appears unreliable/stale.

### REVERIFY
Do not rely on it without fresh confirmation.

### DEPRECATED
Retained for audit/history but not used for current planning.

Important:
- a low-risk project URL discovered during research may be auto-stored as OBSERVED;
- knowledge that can materially change future conclusions should require human approval before becoming ACTIVE;
- deleting history is worse than deprecating it.

---

# 14. RESEARCH MEMORY DATA CONTRACT

Conceptual model:

```ts
type ResearchMemoryKind =
  | "topic_rule"
  | "project_rule"
  | "query_lesson"
  | "source_lesson"
  | "metric_semantics"
  | "dead_end"
  | "freshness_rule"
  | "pattern_candidate";

interface ResearchMemory {
  id: string;
  topicId: string;
  projectId?: string;

  kind: ResearchMemoryKind;
  statement: string;
  structuredValue?: unknown;

  status:
    | "OBSERVED"
    | "CANDIDATE"
    | "ACTIVE"
    | "QUESTIONABLE"
    | "REVERIFY"
    | "DEPRECATED";

  confidence: "HIGH" | "MEDIUM" | "LOW";

  evidenceProofIds: string[];
  evidenceCount: number;

  reusable: boolean;

  successCount: number;
  failureCount: number;

  lastVerifiedAt?: Date;
  refreshAfter?: Date;

  createdAt: Date;
  updatedAt: Date;
}
```

Do not treat `confidence=HIGH` as permission to skip fresh verification of dynamic claims.

---

# 15. PROJECT MEMORY CONTRACT

Prefer granular items rather than one giant mutable JSON blob.

Conceptual aggregate:

```ts
interface ProjectMemory {
  projectId: string;
  topicId: string;

  sourceMap: SourceMapEntry[];
  metrics: MetricSemantic[];
  addresses: KnownAddress[];
  dashboards: KnownDashboard[];
  queryLessons: QueryLesson[];
  freshnessRules: FreshnessRule[];
  projectLessons: ProjectLesson[];

  lastVerifiedAt?: Date;
}
```

Source map entry:

```ts
interface SourceMapEntry {
  purpose:
    | "economic_source"
    | "revenue_waterfall"
    | "allocation"
    | "execution"
    | "status"
    | "destination"
    | "supply"
    | "unlocks"
    | "governance"
    | "durability"
    | "other";

  sourceId: string;
  relevance: "HIGH" | "MEDIUM" | "LOW";
  status: "ACTIVE" | "QUESTIONABLE" | "REVERIFY" | "DEPRECATED";
  notes?: string;
  lastCheckedAt?: Date;
}
```

---

# 16. MEMORY RETRIEVAL

Memory retrieval is mandatory before fresh research.

Retrieval input:

```text
Claim Understanding
+ Project
+ Topic
+ temporal intent
+ active Pattern version
```

Retrieval output should be structured and logged:

```ts
interface RetrievedMemoryBundle {
  pattern: ResearchPatternVersion;

  topicMemory: Array<{
    memoryId: string;
    relevanceReason: string;
    status: string;
  }>;

  projectMemory: Array<{
    memoryId: string;
    relevanceReason: string;
    status: string;
  }>;

  staleOrReverifyItems: string[];
}
```

START does not require a vector database.

Recommended progression:

1. exact Topic filtering;
2. exact Project filtering;
3. memory kind filtering;
4. status/freshness filtering;
5. simple lexical/structured relevance;
6. only introduce embeddings/vector retrieval if real BETA data proves it is needed.

Do not add infrastructure because it sounds "AI-like."

## Retrieval invariant

A BETA test must be able to prove:

```text
Memory existed
→ ATLAS retrieved it
→ Research Plan referenced it
```

"Memory displayed in UI" is not enough.

---

# 17. ADAPTIVE RESEARCH PLAN

The planner consumes:

```text
Claim Understanding
+ Topic Pattern
+ Topic Memory
+ Project Memory
+ freshness state
+ budget
```

It produces:

```ts
interface ResearchPlan {
  id: string;
  researchJobId: string;
  topicId: string;
  patternVersionId: string;

  planVersion: number;

  steps: ResearchPlanStep[];

  rationaleSummary: string; // concise, not hidden chain-of-thought
  budget: ResearchBudget;

  createdAt: Date;
}
```

Step:

```ts
interface ResearchPlanStep {
  id: string;

  patternStepKey: string;
  title: string;
  objective: string;

  materiality: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

  state:
    | "PENDING"
    | "ACTIVE"
    | "SUFFICIENT"
    | "GAP"
    | "CONFLICT"
    | "SKIPPED"
    | "FAILED";

  applicable: boolean;
  skipReason?: string;

  knownMemoryIds: string[];

  researchQuestions: string[];
  preferredSourceTypes: string[];

  stopCondition: {
    minimumStrongEvidence?: number;
    requiresPrimary?: boolean;
    requiresFreshCurrentStatus?: boolean;
    noMaterialConflict?: boolean;
  };
}
```

The plan may adapt during research.

Every adaptation should create a new plan version or a logged change record.
Do not silently mutate history.

---

# 18. RESEARCH BUDGET

Every job receives a budget.

Conceptual:

```ts
interface ResearchBudget {
  maxSearchQueries: number;
  maxSourceOpens: number;
  maxModelCostMinor: bigint | null;
  maxTotalCostMinor: bigint | null;
  maxRetries: number;
  maxWallClockSeconds: number;
}
```

Do not hardcode product pricing into the Research Engine.

Budget exhaustion must produce explicit gaps rather than fabricated certainty.

```text
Budget exhausted
→ save existing Evidence
→ mark unresolved steps
→ Proof may be NOT_ENOUGH_EVIDENCE / MISSING_CONTEXT / etc.
```

---

# 19. PROVIDER ABSTRACTION

The Research Engine should not be tightly coupled to one model/search vendor.

Logical interfaces:

```ts
interface ModelGateway {
  runStructuredTask<T>(
    task: ModelTask,
    input: unknown,
    schema: RuntimeSchema<T>,
    options: ModelCallOptions
  ): Promise<T>;
}

interface SearchGateway {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

interface ContentFetcher {
  fetch(url: string, options: FetchOptions): Promise<FetchedDocument>;
}

interface ChainDataGateway {
  query(request: ChainDataRequest): Promise<ChainDataResult>;
}
```

ATLAS roles can be routed to different model tiers:

```text
cheap/fast model:
- classification
- extraction
- triage
- duplicate detection

strong reasoning model:
- reconciliation
- material contradictions
- verdict
- research review

expensive escalation:
- only genuinely difficult/conflicting cases
```

Provider/model names must be configuration-driven.

---

# 20. MODEL OUTPUT SAFETY

Internal model outputs should be schema-constrained.

Use runtime validation.

If structured output fails validation:
- retry within retry budget;
- use a repair prompt if appropriate;
- if still invalid, create technical failure telemetry;
- do not parse critical state from arbitrary prose.

Never store or expose hidden chain-of-thought.

Store only:
- structured decisions;
- concise rationale summaries;
- Evidence links;
- confidence factors;
- issue diagnosis fields.

---

# 21. SEARCH STRATEGY

Research search should follow:

```text
Known Project Memory sources
→ targeted official search
→ targeted specialized search
→ broad search only when necessary
```

NOT:

```text
broad search from zero every Proof
```

For each research question:

1. Check active Project Memory.
2. If relevant known source is fresh enough, open/verify it.
3. If stale/current status matters, refresh it.
4. If evidence is missing, run targeted queries.
5. Triage results before opening.
6. Deduplicate by canonical URL/content identity.
7. Stop when strong evidence is sufficient.
8. Continue only for a material gap/conflict.

Store every search attempt outcome.

---

# 22. RESEARCH ATTEMPTS

Research Attempts are part of learning.

Conceptual model:

```ts
type ResearchAttemptOutcome =
  | "USEFUL"
  | "PARTIAL"
  | "DUPLICATE"
  | "DEAD_END"
  | "LOW_QUALITY"
  | "BLOCKED"
  | "STALE"
  | "IRRELEVANT"
  | "ERROR";

interface ResearchAttempt {
  id: string;
  researchJobId: string;
  researchStepId: string;

  query?: string;
  sourceId?: string;

  outcome: ResearchAttemptOutcome;
  reason?: string;

  startedAt: Date;
  completedAt?: Date;

  costMinor?: bigint;
  latencyMs?: number;
}
```

This enables:
- dead-end reduction;
- duplicate-search reduction;
- query learning;
- cost analysis.

---

# 23. SOURCE TRIAGE

Do not open everything returned by search.

Pipeline:

```text
Search result
→ Source Triage
→ Worth opening?
→ Fetch
→ Evidence extraction
```

Triage considers:
- source type;
- publisher/owner;
- domain;
- primary vs secondary;
- relevance to the exact research question;
- likely freshness;
- duplicate status;
- previous Project Memory;
- known source problems.

Priority:

```text
on-chain / protocol-native
official docs / official reports
governance
official dashboard
quality data provider
strong independent research
reliable media
social/community as lead
```

Low-quality sources can point ATLAS toward better sources but should not automatically support strong conclusions.

---

# 24. SOURCE REGISTRY

Conceptual fields:

```text
id
canonical_url
domain
title
publisher
source_type
primary_or_secondary
authority_level
status
first_seen_at
last_checked_at
last_successful_fetch_at
default_freshness_class
content_fingerprint
metadata_json
```

Possible source types:

```text
official_docs
official_statement
official_report
governance
official_dashboard
onchain_explorer
smart_contract
system_address
data_provider
independent_research
news
social_post
community_source
other
```

Source status:

```text
ACTIVE
QUESTIONABLE
REVERIFY
BLOCKED
DEPRECATED
```

Do not equate "official" with automatically current.

---

# 25. SAFE URL FETCHING

If the backend fetches arbitrary URLs, implement SSRF protection.

Minimum:
- allow only http/https;
- resolve DNS and block private/local/reserved networks;
- validate redirects, not only initial URL;
- impose response size limits;
- impose timeout;
- content-type allowlist;
- sanitize HTML;
- do not execute remote scripts;
- rate-limit by host;
- user agent identification where appropriate;
- store only necessary content/snapshots.

This is a technical security issue and belongs to Claude Code / Next Release if discovered broken.

---

# 26. EVIDENCE MODEL

Evidence is the factual core.

Conceptual:

```ts
type EvidenceRelation =
  | "SUPPORTS"
  | "CONTRADICTS"
  | "CONTEXT"
  | "LIMITS";

interface Evidence {
  id: string;
  researchJobId: string;
  researchStepId: string;

  sourceId: string;

  fact: string;
  relation: EvidenceRelation;

  directness: "DIRECT" | "DERIVED" | "INDIRECT";
  authority: "PRIMARY" | "STRONG_SECONDARY" | "SECONDARY" | "LOW";

  observedAt: Date;
  dataAsOf?: Date;

  freshnessClass:
    | "REALTIME"
    | "CURRENT"
    | "RECENT"
    | "HISTORICAL"
    | "UNKNOWN";

  confidence: "HIGH" | "MEDIUM" | "LOW";

  evidenceFragment?: string;
  locator?: string; // page/section/tx/block/etc.

  limitations?: string[];
  metadata?: unknown;

  createdAt: Date;
}
```

Every material Proof conclusion must trace back to Evidence.

Core provenance:

```text
Claim/Subclaim
→ Research Plan Step
→ Evidence
→ Source
→ Reconciliation
→ Proof conclusion
```

---

# 27. FRESHNESS ENGINE

Freshness is part of truth.

Dynamic facts include:
- current mechanism status;
- current fee allocation;
- current buyback execution;
- current unlock state;
- circulating supply;
- revenue rate;
- active governance parameters.

Store:
- observed_at;
- data_as_of;
- freshness_class;
- refresh_after;
- source last checked.

Do not use a single universal TTL.

Freshness can vary by memory kind and source purpose.

Example conceptual classes:

```text
REALTIME
CURRENT
RECENT
HISTORICAL
UNKNOWN
```

Rules:
- historical facts can remain historically valid;
- current-status claims need current evidence;
- old correct evidence must not be silently used as a current answer;
- memory marked REVERIFY should guide WHERE to check, not be accepted as current proof.

---

# 28. EVIDENCE EXTRACTION

Evidence extraction should:
1. extract only facts relevant to a Research Plan step;
2. preserve source provenance;
3. preserve time context;
4. distinguish statement from execution;
5. distinguish metric semantics;
6. preserve uncertainty;
7. avoid upgrading a secondary paraphrase into a primary fact.

The extractor must not decide the final verdict.

It creates evidence records.

---

# 29. EVIDENCE RECONCILIATION

Reconciliation is where evidence is compared.

Inputs:
- subclaims;
- research plan;
- Evidence records;
- gaps;
- conflicts;
- freshness requirements;
- Topic rules.

Outputs:

```ts
interface ReconciliationResult {
  subclaimResults: Array<{
    subclaimId: string;
    status:
      | "SUPPORTED"
      | "PARTIALLY_SUPPORTED"
      | "NOT_ENOUGH_EVIDENCE"
      | "MISSING_CONTEXT"
      | "CONFLICTING_EVIDENCE";

    supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[];
    gapIds: string[];
    summary: string;
  }>;

  materialConflicts: Array<{
    description: string;
    evidenceIds: string[];
    resolved: boolean;
    resolution?: string;
  }>;

  globalGaps: string[];

  recommendedVerdict: string;
  recommendedConfidence: "HIGH" | "MEDIUM" | "LOW";
}
```

Do not choose HIGH confidence merely because many sources repeat the same claim.

Confidence factors:
- authority;
- directness;
- agreement;
- execution evidence;
- freshness;
- material gaps.

Hard guard examples:
- current-status claim + no fresh evidence → HIGH not allowed;
- unresolved material contradiction → do not output clean SUPPORTED/HIGH;
- insufficient execution evidence where execution is material → expose gap.

---

# 30. VERDICT SEMANTICS

Approved verdicts:

```text
SUPPORTED
PARTIALLY_SUPPORTED
NOT_ENOUGH_EVIDENCE
MISSING_CONTEXT
CONFLICTING_EVIDENCE
```

Suggested use:

### SUPPORTED
Material claim is supported by adequate evidence.

### PARTIALLY_SUPPORTED
Compound claim has both supported and unsupported/incorrect material parts.

### NOT_ENOUGH_EVIDENCE
Research did not find sufficient evidence to determine the claim.

### MISSING_CONTEXT
The claim may contain a technically true component but omits context that materially changes interpretation.

### CONFLICTING_EVIDENCE
Strong evidence materially conflicts and cannot be reliably reconciled.

Token impact is separate:

```text
POSITIVE
NEGATIVE
MIXED
NEUTRAL
UNCLEAR
```

Token impact is not investment advice and is not the factual verdict.

---

# 31. STOP CONDITIONS

ATLAS must not research forever.

A branch can stop when:

```text
authoritative evidence is sufficient
+
current status requirement is satisfied
+
material contradictions are resolved
+
remaining gap cannot materially alter the verdict
```

If a critical contradiction remains:
- continue targeted research if budget allows;
- otherwise return explicit CONFLICTING_EVIDENCE/gap.

If evidence is sufficient:
- stop collecting repetitive articles;
- move to another unresolved material step;
- do not spend calls "just in case."

This is simultaneously:
- a quality rule;
- a latency rule;
- a cost rule;
- a learning signal.

---

# 32. STRUCTURED PROOF CORE

Do not make the Proof a free-form LLM essay.

Persist a structured factual core.

Conceptual:

```ts
interface ProofCore {
  proofId: string;
  claimId: string;
  topicId: string;
  projectId?: string;

  verdict:
    | "SUPPORTED"
    | "PARTIALLY_SUPPORTED"
    | "NOT_ENOUGH_EVIDENCE"
    | "MISSING_CONTEXT"
    | "CONFLICTING_EVIDENCE";

  confidence: "HIGH" | "MEDIUM" | "LOW";

  tokenImpact:
    | "POSITIVE"
    | "NEGATIVE"
    | "MIXED"
    | "NEUTRAL"
    | "UNCLEAR";

  subclaimResults: unknown[];

  evidenceIds: string[];
  strongestEvidenceIds: string[];

  gaps: Array<{
    id: string;
    description: string;
    materiality: string;
    canDeepCheck: boolean;
  }>;

  conflicts: unknown[];

  dataAsOf?: Date;
  freshnessSummary: string;

  factualSummary: string;
  mainNuance: string;

  patternVersionId: string;
  memoryIdsUsed: string[];
}
```

The Proof Core is the source for all presentation views.

---

# 33. PROOF LIFECYCLE / VERSIONING

Internal lifecycle:

```text
DRAFT
→ IN_REVIEW
→ VERIFIED
```

Do not label every normal user result VERIFIED as if a human audited it.

Use a separate internal verification status.

Historical VERIFIED Proofs are immutable.

If facts change:
- mark old Proof `STALE` or `SUPERSEDED`;
- create a new Proof version.

Never silently rewrite history.

A Deep Check that materially changes verdict/confidence should create a new Proof version linked to the prior version.

---

# 34. PRESENTATION GENERATOR

Research once. Verify once. Explain twice.

From the same Proof Core generate:

1. Professional Summary
2. In Simple Words
3. Why It Matters
4. Main Nuance / Risk
5. Evidence presentation
6. Sources
7. Gaps
8. Freshness

Presentation Generator must NOT:
- run fresh research;
- add facts absent from the Proof Core;
- change the verdict;
- create unsupported market predictions.

---

# 35. DEEP CHECK

Deep Check is targeted research on one material gap.

It must:

```text
reuse parent Proof
+ reuse relevant memory
+ reuse existing evidence
+ research one explicit gap
```

It must NOT rerun the entire Proof by default.

Data link:

```text
parent_proof_id
parent_proof_version_id
gap_id
child_research_job_id
```

If the Deep Check changes the factual conclusion:
- create a new Proof version;
- preserve the old one.

---

# 36. LINKS — INTERNAL ECONOMY

Links are internal application units.

They are NOT:
- blockchain token;
- withdrawable;
- user-transferable;
- tradable.

Use integer units.

Core tables:
- links_accounts
- links_ledger
- links_holds
- links_packages
- research_action_prices

Ledger is append-only.

Do not directly overwrite balances without an auditable ledger operation.

Account:

```ts
interface LinksAccount {
  userId: string;
  availableBalance: bigint;
  reservedBalance: bigint;
  version: bigint;
}
```

Hold:

```text
ACTIVE
CAPTURED
RELEASED
EXPIRED
```

Paid research:

```text
request paid action
→ backend determines cost
→ atomic reserve
→ enqueue research
→ success: capture
→ technical failure: release
```

`NOT_ENOUGH_EVIDENCE` can still be a valid completed paid research result if real work was performed.

---

# 37. TELEGRAM STARS → LINKS

Current in-Telegram direction:

```text
Telegram Stars (XTR)
→ verified payment event
→ Links credit
```

Do not build Solana checkout inside Telegram START from stale documents.

Payment logic should use a provider/adaptor boundary so a future independent web surface can add another checkout method without touching the Links ledger core.

Conceptual:

```ts
interface PaymentProvider {
  createPurchase(...): Promise<ProviderPurchase>;
  verifyPayment(...): Promise<VerifiedProviderPayment>;
}
```

The internal invariant remains:

```text
one verified payment
→ at most one purchase credit
```

Frontend cannot self-report a successful payment as authoritative.

Payment data and Links ledger credit must be idempotent.

---

# 38. RESEARCH COST OBSERVABILITY

Track per Proof:

```text
search_queries_attempted
search_queries_useful
failed_queries
duplicate_queries
sources_opened
duplicate_sources
dead_ends
time_to_first_strong_evidence_ms
time_to_final_proof_ms
memory_hits
project_memory_hits
topic_memory_hits
pattern_steps_reused
model_calls
model_input_tokens
model_output_tokens
estimated_model_cost
search_cost
external_data_cost
total_variable_cost
retry_count
```

Core learning comparison:

```text
First Proof on Project X
vs
Later Proof on Project X
```

Expected:
- fewer dead ends;
- fewer duplicate searches;
- faster evidence;
- lower cost;
- equal/better Proof quality.

Do not assume this happens. Measure it.

---

# 39. SELF REVIEW AFTER EVERY PROOF

After every completed Proof, run a lightweight internal Research Review.

This is not user-facing.

Input:
- claim understanding;
- memory retrieved;
- plan versions;
- search attempts;
- opened sources;
- evidence;
- final Proof;
- timing/cost.

Output:

```ts
interface ResearchReview {
  researchJobId: string;
  proofId: string;

  evidenceAdequate: boolean;
  freshnessAdequate: boolean;

  memoryWasUsed: boolean;
  usefulMemoryIds: string[];
  staleOrHarmfulMemoryIds: string[];

  duplicateSearchCount: number;
  deadEndCount: number;
  weakSourceCount: number;

  stoppedTooEarly: boolean;
  researchedTooLong: boolean;

  newProjectMemoryCandidates: string[];
  learningCandidateIds: string[];

  issueCandidateIds: string[];

  metricsSnapshot: unknown;

  createdAt: Date;
}
```

The self-review should be short and structured.

Do NOT ask a model to produce an unconstrained philosophical essay about its own performance.

---

# 40. ERROR / FAILURE TAXONOMY

Root causes should be categorized separately from routing owner.

Recommended taxonomy:

```text
KNOWLEDGE_GAP
MEMORY_RETRIEVAL_FAILURE
PLANNING_FAILURE
SEARCH_FAILURE
SOURCE_FAILURE
INTERPRETATION_ERROR
REASONING_ERROR
TECHNICAL_ERROR

DUPLICATE_ERROR
FRESHNESS_ERROR
EVIDENCE_GAP
OVERGENERALIZATION
RESEARCH_WASTE
PREMATURE_STOP
```

Meaning examples:

### KNOWLEDGE_GAP
The necessary reusable knowledge did not exist.

### MEMORY_RETRIEVAL_FAILURE
Correct memory existed but was not retrieved.

### PLANNING_FAILURE
Correct memory was retrieved but the plan did not use it correctly.

### SEARCH_FAILURE
Plan was reasonable, queries/source discovery were poor.

### SOURCE_FAILURE
Weak/stale source was trusted or stronger source ignored.

### INTERPRETATION_ERROR
Evidence was found but its meaning was misunderstood.

### REASONING_ERROR
Evidence was correctly understood but final conclusion was wrong.

### TECHNICAL_ERROR
Parser/API/DB/state/timestamp/queue/UI/etc.

Important:
If ATLAS violates a rule already stored in ACTIVE memory, do not add another duplicate memory rule.
Diagnose why the existing rule failed to affect behavior.

---

# 41. ISSUE ROUTING: GROK / GPT / CLAUDE

Routing owner answers:

> Who should the human use to analyze this problem?

It does NOT automatically invoke that AI.

## GROK — Information

Use for:
- missing fresh public information;
- missing official source;
- unresolved external fact;
- X/social context needed;
- source discovery problem;
- current external status unknown.

Question to Grok:

> What information/source are we missing?

## GPT — Intelligence / Learning

Use for:
- interpretation;
- reasoning;
- Project Qualification;
- Learning Candidate quality;
- recurring research logic problem;
- whether an observed pattern deserves learning;
- whether the system is overgeneralizing.

Question to GPT:

> What does this experience mean for ATLAS's research intelligence, and what should change, if anything?

## CLAUDE — Technical

Use for:
- code bug;
- retrieval implementation;
- planner implementation;
- parser;
- DB;
- queue;
- API;
- UI;
- payment;
- concurrency;
- performance;
- security;
- system-wide technical behavior.

Question to Claude Code:

> What technical implementation must change to match the approved behavior?

---

# 42. ROUTING IS BASED ON ROOT CAUSE, NOT SYMPTOM

Example:

```text
ATLAS missed current status
```

Possible roots:

### Case A
No fresh source was found.
→ GROK

### Case B
Fresh source was found, ATLAS misunderstood "paused."
→ GPT

### Case C
Project Memory already contained the fresh source, but retrieval code never returned it.
→ CLAUDE

### Case D
Correct memory was retrieved, but planner prompt/logic ignored the required freshness branch.
If this is an approved research-logic defect:
→ GPT diagnoses desired behavior
→ then CLAUDE implements the approved change
```

One Issue can pass through multiple owners.

---

# 43. NO AUTOMATIC GROK/GPT/CLAUDE API CHAIN IN START

This is deliberate.

Admin does NOT need direct integration with Grok, GPT, or Claude Code for START.

Flow:

```text
ATLAS creates Issue
→ Admin creates copy-ready packet
→ human copies packet into relevant AI
→ human receives analysis
→ human pastes analysis into Issue
→ human decides next step
```

This allows us to:
- inspect every important mistake;
- understand the real learning process;
- avoid API complexity;
- avoid uncontrolled self-modification;
- discover which workflows are worth automating later.

The ATLAS Research Engine itself may still use model/search/data APIs for research.
The "no API" rule applies to the **Admin diagnostic AI handoff**, not to fresh research itself.

---

# 44. TWO ISSUE COMPLEXITY LEVELS

Every Issue also receives a complexity class.

## LIVE / ADMIN

Can be corrected by changing approved data/state without core-code change.

Examples:
- Project Memory source;
- source freshness/status;
- query lesson;
- dead end;
- metric semantics;
- project-specific terminology;
- Project Qualification;
- memory status REVERIFY/DEPRECATED;
- approved project-specific lesson.

## NEXT_RELEASE

Requires changing product mechanism/code.

Examples:
- Research Planner behavior;
- retrieval algorithm;
- parser;
- evidence reconciliation;
- verdict logic;
- global source-ranking algorithm;
- backend architecture;
- UI architecture;
- system cost optimization;
- new major feature.

## CRITICAL

Requires urgent technical handling if it threatens:
- security;
- money;
- user data;
- widespread Proof integrity.

---

# 45. START LIVE CHANGE WHITELIST

Keep LIVE changes explicit and whitelist-based.

Allowed in START:

```text
PROJECT_MEMORY_ADD_SOURCE
PROJECT_MEMORY_UPDATE_SOURCE_PURPOSE
PROJECT_MEMORY_MARK_SOURCE_REVERIFY
PROJECT_MEMORY_DEPRECATE_SOURCE

PROJECT_MEMORY_ADD_QUERY_LESSON
PROJECT_MEMORY_ADD_DEAD_END
PROJECT_MEMORY_ADD_METRIC_SEMANTIC
PROJECT_MEMORY_ADD_TERMINOLOGY
PROJECT_MEMORY_ADD_FRESHNESS_NOTE

PROJECT_QUALIFICATION_SET_RESEARCH_ONLY
PROJECT_QUALIFICATION_SET_CANDIDATE
PROJECT_QUALIFICATION_SET_APPROVED
PROJECT_QUALIFICATION_SET_PRIORITY_LEARNING

MEMORY_PROMOTE_OBSERVED_TO_ACTIVE
MEMORY_MARK_QUESTIONABLE
MEMORY_MARK_REVERIFY
MEMORY_DEPRECATE
```

Not LIVE in START:

```text
EDIT_ACTIVE_RESEARCH_PATTERN
CHANGE_VERDICT_LOGIC
CHANGE_CONFIDENCE_POLICY
CHANGE_GLOBAL_PLANNER_ALGORITHM
CHANGE_RETRIEVAL_ALGORITHM
CHANGE_GLOBAL_SOURCE_PRIORITY
CHANGE_CORE_MODEL_ROUTING_POLICY
CHANGE_PAYMENT_ACCOUNTING_INVARIANTS
```

Those go to NEXT_RELEASE.

This whitelist keeps the first Admin safe and simple.

---

# 46. LIVE CHANGE LIFECYCLE

Every Live Change is its own auditable object.

```text
DRAFT
→ APPROVED
→ APPLIED
→ OBSERVING
→ VALIDATED
```

Alternative outcomes:

```text
ROLLED_BACK
NO_IMPROVEMENT
WORSE
REJECTED
```

Conceptual:

```ts
interface LiveChange {
  id: string;
  issueId: string;

  type: string;
  targetType: string;
  targetId: string;

  beforeSnapshot: unknown;
  proposedAfterSnapshot: unknown;

  proposedBy: "ATLAS" | "HUMAN";
  approvedByUserId?: string;

  status: string;

  appliedAt?: Date;
  observationStartedAt?: Date;
  validationResult?: "IMPROVED" | "NO_IMPROVEMENT" | "WORSE";

  rollbackSnapshot?: unknown;
}
```

Applying a Live Change must be transactional.

---

# 47. HUMAN APPROVAL

Critical rule:

```text
ATLAS proposes
→ AI helps analyze
→ human approves/rejects
```

In BETA/START, require human approval for:
- promotion of knowledge that can change future conclusions;
- Project Qualification with long-term effect;
- Learning Candidates;
- serious Issue resolution;
- any future Topic/Connection/Pattern proposal.

No silent permanent intelligence mutation.

---

# 48. ISSUE LIFECYCLE

Recommended:

```text
DETECTED
→ CLASSIFIED
→ OPEN
→ IN_AI_REVIEW
→ WAITING_HUMAN
```

Then either:

```text
APPROVED_LIVE
→ APPLIED
→ OBSERVING
→ RESOLVED
```

or:

```text
MOVED_NEXT_RELEASE
→ GROUPED / READY_FOR_RELEASE
```

or:

```text
REJECTED
CLOSED_NO_CHANGE
HOTFIX_REQUIRED
```

Issue fields:

```ts
interface Issue {
  id: string;

  projectId?: string;
  claimId?: string;
  proofId?: string;
  researchJobId?: string;

  title: string;
  description: string;
  whyItMatters: string;

  rootCauseType?: string;

  owner: "GROK" | "GPT" | "CLAUDE";
  complexity: "LIVE" | "NEXT_RELEASE" | "CRITICAL";
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

  status: string;

  suspectedCause?: string;

  evidenceIds: string[];
  sourceIds: string[];
  memoryIds: string[];

  copyPacket: string;

  humanDecision?: string;
  resolutionSummary?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

---

# 49. COPY-READY AI PACKETS

Admin should generate concise packets.

## GROK packet

```text
ATLAS PROOF — INFORMATION REVIEW

Project:
Claim:
Data/time context:

Problem:
What ATLAS could not verify:

Sources already checked:
- ...

Known evidence:
- ...

What we need:
Find the strongest fresh public/official information that resolves this exact point.

Return:
1. strongest source(s)
2. date/data_as_of
3. exact factual finding
4. conflicts/limitations
5. whether information is sufficient
```

## GPT packet

```text
ATLAS PROOF — INTELLIGENCE / LEARNING REVIEW

Project:
Topic:
Claim:
Verdict:
Confidence:

Relevant Evidence:
- ...

Research Memory used:
- ...

Research Plan summary:
- ...

Observed problem:
- ...

Grok result, if any:
- ...

Please diagnose:
1. root cause category
2. whether existing memory was sufficient
3. whether this is interpretation/reasoning/planning/knowledge problem
4. whether ATLAS should learn anything permanent
5. LIVE change vs NEXT RELEASE
6. smallest recommended change
7. how to verify improvement
```

## Claude Code packet

```text
ATLAS PROOF — TECHNICAL ISSUE

Issue:
Priority:
Affected flow:

Expected behavior:
...

Actual behavior:
...

Approved product/research rule:
...

Reproduction / Proof examples:
...

Relevant logs/ids:
...

Human/GPT conclusion:
...

Required change:
...

Acceptance criteria:
...

Regression cases:
...

Do not redesign product behavior beyond this approved requirement.
```

---

# 50. NEXT RELEASE QUEUE

Next Release is not a flat bug list.

Similar Issues should be grouped into:

```text
System Problem Candidate
```

Example:

```text
7 independent freshness failures
→ System Problem Candidate:
"Freshness handling is systematically weak"
```

Conceptual model:

```ts
interface SystemProblemCandidate {
  id: string;
  title: string;
  rootCauseHypothesis: string;

  issueIds: string[];

  frequency: number;
  severitySummary: string;
  userImpactSummary: string;

  expectedBehavior: string;
  proposedTechnicalDirection?: string;

  status:
    | "CANDIDATE"
    | "CONFIRMED"
    | "READY_FOR_RELEASE"
    | "IMPLEMENTED"
    | "REJECTED";

  createdAt: Date;
  updatedAt: Date;
}
```

Before new version:
- GPT + human review grouped problems;
- select proven improvements;
- generate consolidated Claude Code tasks.

---

# 51. OBSERVATION: DID THE FIX HELP?

Do not resolve an Issue because a field was edited.

After change:

```text
APPLIED
→ OBSERVING
→ IMPROVED / NO_IMPROVEMENT / WORSE
```

Observation metrics depend on Issue.

Examples:

```text
duplicate searches:
before 4/proof
after 0/proof

ACTIVE/PAUSED errors:
before 3 of 10
after 0 of next 15

time to strong evidence:
before 70s
after 35s

cost:
before 0.80
after 0.45
while quality benchmark remains pass
```

Do not create false precision from tiny samples.
START can use simple before/after windows and human review.

---

# 52. LEARNING CANDIDATES

A Self Review may create a candidate.

It does NOT create ACTIVE permanent knowledge directly.

Conceptual:

```ts
interface LearningCandidate {
  id: string;

  topicId: string;
  projectId?: string;

  type:
    | "PROJECT_MEMORY"
    | "TOPIC_MEMORY"
    | "PATTERN"
    | "SOURCE_LESSON"
    | "QUERY_LESSON"
    | "FRESHNESS_RULE";

  statement: string;

  supportingProofIds: string[];
  supportingEvidenceIds: string[];

  recurrenceCount: number;
  materiality: string;

  status:
    | "OBSERVED"
    | "CANDIDATE"
    | "APPROVED"
    | "REJECTED"
    | "NEEDS_MORE_EVIDENCE";

  recommendedAction?: string;
}
```

START focuses primarily on Project Memory candidates.

Topic-level candidates can be stored for future review, but should not automatically mutate Pattern v1.

---

# 53. PROJECT QUALIFICATION

Permanent knowledge is curated.

Qualification should consider:
- unique real project?
- duplicate/alias?
- source quality?
- fits current Topic?
- new mechanism?
- closes knowledge gap?
- user interest?
- learning value?
- similarity to known Projects?

START does not need a sophisticated ML scoring algorithm.

Use structured factors + human decision.

Conceptual:

```ts
interface ProjectQualification {
  projectId: string;

  uniqueness: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  sourceQuality: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  topicFit: "HIGH" | "MEDIUM" | "LOW";
  novelty: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  learningValue: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  userDemandSignal?: number;

  recommendation:
    | "RESEARCH_ONLY"
    | "CANDIDATE"
    | "APPROVE"
    | "PRIORITY_LEARNING";

  humanDecision?: string;
}
```

Do not implement "N requests = auto approve."

---

# 54. SOURCE / MEMORY HEALTH

Track:

```text
success_count
failure_count
last_verified_at
last_used_at
last_successful_use_at
last_failed_use_at
```

A once-useful route can degrade:

```text
ACTIVE
→ QUESTIONABLE
→ REVERIFY
→ DEPRECATED
```

This is how ATLAS learns to stop trusting stale routes.

---

# 55. DEEP LEARNING REVIEW — BETA

Do not build a huge analytics dashboard.

During early BETA, after roughly every 5 VERIFIED Proofs in the current learning batch, generate a simple internal review.

Measures:
- Quality;
- Efficiency;
- Cost;
- Speed;
- Memory Benefit;
- Human Review Rate;
- primary evidence coverage;
- freshness compliance;
- memory hit rate;
- recurring errors.

As the system matures, cadence can change.

For START implementation, a report generator / DB query is enough.
Do not build a complex BI platform.

---

# 56. DATABASE — CORE TABLE SET

Use PostgreSQL unless the existing repository has a compelling approved alternative.

Recommended tables:

```text
users
user_identities
sessions

topics
projects
project_aliases
project_qualifications

claims
claim_subclaims

research_patterns
research_pattern_steps

research_memory
project_memory_items

sources
source_project_links
source_fetches

research_jobs
research_job_transitions
research_plans
research_plan_steps
research_plan_revisions
research_attempts

evidence
evidence_links

proofs
proof_versions
proof_evidence
proof_gaps
proof_conflicts

research_reviews
learning_candidates

issues
issue_ai_reviews
live_changes
system_problem_candidates
system_problem_issue_links

regression_cases
regression_runs
regression_case_results

links_accounts
links_ledger
links_holds
links_packages
research_action_prices

payment_orders
payments

model_calls
search_calls
cost_events

audit_log
```

Not every table needs a UI.

---

# 57. DATABASE — KEY FIELDS / INDEXES

## users

```text
id UUID PK
intelligence_level enum/string
status
created_at
updated_at
```

Index:
- status

## user_identities

```text
id UUID PK
user_id FK
provider
provider_user_id
provider_username nullable
created_at
last_seen_at
```

Unique:
- `(provider, provider_user_id)`

## topics

```text
id UUID PK
slug unique
name
status
active_pattern_id nullable
created_at
```

START seed:
`token-value-capture`

## projects

```text
id UUID PK
slug unique
canonical_name
status
qualification_status
created_at
updated_at
```

## project_aliases

```text
id
project_id
alias_normalized
alias_display
```

Unique:
- alias_normalized where safe.

## claims

```text
id UUID PK
user_id
raw_text
normalized_text
topic_scope
project_id nullable
temporal_intent
created_at
```

## research_jobs

```text
id UUID PK
user_id
claim_id
parent_job_id nullable
job_type BASE_PROOF | DEEP_CHECK | REGRESSION
state
attempt
idempotency_key nullable
budget_json
started_at
completed_at
failure_code nullable
created_at
updated_at
```

Indexes:
- user_id, created_at desc
- state
- claim_id
- parent_job_id

## research_memory

Index:
- topic_id
- project_id
- kind
- status
- last_verified_at

## sources

Unique:
- canonical_url where possible.

Indexes:
- domain
- publisher
- source_type
- status

## evidence

Indexes:
- research_job_id
- research_step_id
- source_id
- data_as_of
- relation

## proofs

```text
id UUID PK
claim_id
project_id nullable
topic_id
latest_version_id
internal_verification_status
created_at
```

## proof_versions

```text
id UUID PK
proof_id
version_number
verdict
confidence
token_impact
pattern_version_id
data_as_of
status
core_json
created_at
```

Unique:
- `(proof_id, version_number)`

## issues

Indexes:
- status
- owner
- complexity
- priority
- project_id
- created_at desc

## links_ledger

Append-only.
Index:
- user_id, created_at
- reference_type/reference_id
- idempotency_key unique where applicable

---

# 58. JSONB VS RELATIONAL

Use relational columns for:
- identity;
- ownership;
- status;
- timestamps;
- verdict;
- confidence;
- foreign keys;
- searchable lifecycle fields;
- money/Links.

Use JSONB for:
- flexible provider metadata;
- Pattern definition details;
- plan snapshots;
- model structured metadata;
- change snapshots;
- Proof Core presentation-independent structure where appropriate.

Do not put the entire database into opaque JSON blobs.

---

# 59. AUDIT LOG

Any important intelligence/admin mutation should produce an audit entry.

Fields:

```text
id
actor_type HUMAN | SYSTEM
actor_user_id nullable
action
target_type
target_id
before_snapshot
after_snapshot
reason
issue_id nullable
created_at
```

Required for:
- Live Change approval/application;
- rollback;
- memory status change;
- Project Qualification decision;
- admin Links adjustment;
- Pattern activation in future.

---

# 60. EVENT / OUTBOX STRATEGY

Do not require Kafka.

A simple DB outbox or reliable queue integration is enough.

Useful internal events:

```text
ResearchJobCreated
ResearchJobStateChanged
MemoryRetrieved
ResearchPlanBuilt
EvidenceAdded
ProofCreated
ProofVersionCreated
ResearchReviewCompleted
IssueDetected
LiveChangeApproved
LiveChangeApplied
IssueMovedToNextRelease
LinksHoldCreated
LinksHoldCaptured
LinksHoldReleased
PaymentVerified
```

Events should be for reliability/decoupling, not for premature distributed architecture.

---

# 61. API — USER-FACING CONTRACTS

Exact URL naming may adapt to repository conventions.

Suggested logical endpoints:

## Auth

```text
POST /api/auth/telegram
GET  /api/me
```

## Claim / Research

```text
POST /api/claims
POST /api/research-jobs
GET  /api/research-jobs/:id
GET  /api/research-jobs/:id/events
POST /api/research-jobs/:id/cancel
```

Use SSE/WebSocket/polling based on current stack.
SSE is often sufficient for one-way progress.

## Proof

```text
GET  /api/proofs/:id
GET  /api/proofs/:id/versions
POST /api/proofs/:id/deep-check
```

## Projects

```text
GET /api/projects/researched
GET /api/projects/:id
```

## Links

```text
GET /api/links/account
GET /api/links/ledger
GET /api/links/packages
```

## Payment
Use Telegram Stars provider-specific routes according to final Telegram integration implementation.

Keep payment provider behind backend.

---

# 62. API — ADMIN CONTRACTS

Admin authentication/authorization is mandatory.

Suggested:

```text
GET  /api/admin/issues
GET  /api/admin/issues/:id
PATCH /api/admin/issues/:id/classification

POST /api/admin/issues/:id/ai-reviews
POST /api/admin/issues/:id/approve-live
POST /api/admin/issues/:id/more-review
POST /api/admin/issues/:id/move-next-release
POST /api/admin/issues/:id/close

GET  /api/admin/live-changes
GET  /api/admin/live-changes/:id
POST /api/admin/live-changes/:id/apply
POST /api/admin/live-changes/:id/rollback

GET  /api/admin/next-release
POST /api/admin/system-problems
POST /api/admin/system-problems/:id/link-issue

GET  /api/admin/regression-runs
POST /api/admin/regression-runs

GET  /api/admin/research-jobs/:id/details
```

Do not make a huge admin API surface before UI proves the need.

---

# 63. ADMIN v1 UI

START Admin has only three main views.

## Issues

Shows:
- counts;
- owner filter GROK/GPT/CLAUDE;
- complexity LIVE/NEXT_RELEASE/CRITICAL;
- priority;
- short status.

## Live Changes

Shows:
- approved/pending/applied changes;
- before/after;
- issue;
- observation status;
- rollback.

## Next Release

Shows:
- serious Issues;
- grouped systemic problems;
- frequency;
- impact;
- ready/not-ready for Claude Code.

Do not build separate giant dashboards for:
- Topics;
- Connections;
- Knowledge Graph;
- Pattern laboratory;
- complex analytics.

Detailed Research Job is a drilldown only when investigating.

---

# 64. RESEARCH JOB DRILLDOWN

For debugging, admin can open a job and inspect:

```text
Claim Understanding
Topic/Project resolution
Memory retrieved
Pattern version
Plan + revisions
Queries
Search results selected/rejected
Sources opened
Evidence
Freshness decisions
Reconciliation
Proof Core
Model calls
Search calls
Cost
Time
Self Review
Issues generated
```

This is investigation depth, not the default admin landing page.

---

# 65. BETA "SHADOW LEARNING" MODE

Recommended rollout:

At first, Self Review can create:
- OBSERVED memory candidates;
- Issue candidates;
- metrics;

but NOT automatically change active behavior.

Human reviews the output.

After we trust specific low-risk actions, enable only those Live Change types from the whitelist.

This staged rollout prevents a broken self-review prompt from corrupting memory.

---

# 66. REGRESSION HARNESS

Implement benchmark cases as fixtures.

Each Regression Case should contain:
- claim;
- expected supported Topic;
- expected Project;
- required lessons/invariants;
- prohibited errors;
- minimum evidence expectations where data is available.

Example Aave invariant:

```text
Must not claim current buyback mechanism ACTIVE
without fresh evidence that execution resumed.
```

Example Ethena invariant:

```text
Must not infer token value capture solely from protocol revenue.
```

Case result:

```ts
interface RegressionCaseResult {
  runId: string;
  caseId: string;
  passed: boolean;

  verdictMatch?: boolean;
  requiredInvariantsPassed: string[];
  failedInvariants: string[];

  qualityNotes?: string;
  cost?: number;
  durationMs?: number;
}
```

Regression should evaluate both:
- factual quality;
- efficiency metrics.

Efficiency improvements cannot compensate for factual regression.

---

# 67. TEST PYRAMID

## Unit tests

Test:
- state transitions;
- freshness;
- URL canonicalization;
- source scoring helpers;
- memory filtering;
- Links ledger math;
- hold capture/release;
- verdict guardrails;
- issue routing;
- Live Change whitelist.

## Integration tests

Test:
- Telegram identity resolution;
- DB + queue lifecycle;
- job retry;
- memory retrieval;
- plan persistence;
- Evidence provenance;
- Proof versioning;
- admin change application;
- Links atomicity;
- payment idempotency.

## Contract tests

Mock external:
- model gateway;
- search gateway;
- fetcher;
- chain/data provider;
- Telegram payment provider.

## Regression tests

Five benchmark Projects.

## End-to-end

Telegram-like frontend flow:
- paste claim;
- progress;
- result;
- evidence;
- Deep Check;
- admin issue review.

---

# 68. DETERMINISTIC TESTING OF MODEL-BASED COMPONENTS

Avoid brittle tests that assert exact generated wording.

Assert:
- schema validity;
- state transitions;
- required fields;
- Evidence IDs used;
- prohibited claims;
- verdict constraints;
- freshness constraints;
- issue routing;
- benchmark invariants.

Use recorded fixtures for external responses.

For a small curated evaluation set, allow model evaluation/human evaluation, but do not make all CI depend on live expensive model calls.

---

# 69. IDEMPOTENCY / CONCURRENCY

Critical areas:

## Research jobs
- retry does not create duplicate final Proof version.

## Links
- balance cannot go negative;
- reserve is atomic;
- capture/release exactly once.

## Payments
- one provider payment maps to at most one purchase credit.

## Live Changes
- same Change application cannot apply twice.

## Admin
- approving already-approved mutation should be safe/rejected.

Prefer database constraints + transactions over purely application-level assumptions.

---

# 70. TRANSACTIONS

Use DB transactions for:
- user + identity creation where needed;
- Links reserve/capture/release;
- payment verification record + Links credit;
- Live Change application + audit log;
- Proof latest-version pointer update;
- memory promotion + audit entry.

Do not hold a DB transaction open during external web/model calls.

---

# 71. FAILURE HANDLING

Every external call needs:
- timeout;
- retry policy;
- max retries;
- failure classification;
- cost logging.

Do not retry blindly on:
- invalid request;
- deterministic parser/schema issue;
- authorization failure;
- permanent 404 without new strategy.

Research worker should be resumable from persisted state where practical.

---

# 72. CACHING

Cache only when safe.

Good candidates:
- static official docs snapshots;
- canonical URL metadata;
- recent non-dynamic source content;
- project alias resolution.

Be careful caching:
- current mechanism status;
- current supply;
- current revenue;
- governance changes.

Freshness policy overrides generic cache TTL.

---

# 73. OBSERVABILITY

Need structured logs with:
- request_id;
- user_id (internal, avoid leaking sensitive external IDs);
- research_job_id;
- proof_id;
- project_id;
- state;
- provider call id;
- latency;
- error code.

Metrics:
- jobs by state;
- success/failure;
- p50/p95 completion time;
- cost/proof;
- search calls/proof;
- model calls/proof;
- memory hit rate;
- duplicate rate;
- dead-end rate;
- primary evidence coverage;
- issue rate;
- human review rate;
- Links hold failures;
- payment verification failures.

Alerts:
- error spike;
- queue backlog;
- cost spike;
- payment mismatch;
- critical issue generated;
- regression failure.

---

# 74. PRIVACY / LOGGING

Do not log:
- full Telegram initData secrets;
- payment secrets;
- auth tokens;
- private keys;
- hidden model chain-of-thought.

User claim text may contain sensitive information. Treat it as application data with appropriate access controls.

Admin must require authorization.

---

# 75. SECURITY BASELINE

Minimum:
- server-side Telegram auth validation;
- CSRF strategy appropriate to auth model;
- secure session cookies/tokens;
- authorization on every user-owned resource;
- admin role separation;
- rate limits;
- SSRF-safe fetcher;
- SQL injection prevention via parameterized ORM/query builder;
- XSS-safe rendering of fetched/source text;
- secrets in environment/secret manager;
- no treasury/private payment keys stored unless explicitly required by future provider;
- dependency scanning;
- database backups;
- migration rollback plan.

---

# 76. FEATURE FLAGS / CONFIG

Prefer small configuration layer:

```text
RESEARCH_ENABLED
DEEP_CHECK_ENABLED
SELF_REVIEW_ENABLED
LIVE_LEARNING_ENABLED
ADMIN_ENABLED
LINKS_ENABLED
STARS_PURCHASES_ENABLED
GLOBAL_RESEARCH_PAUSED
```

And budgets/prices in configuration/database.

Feature flags are operational safety, not a new product UI.

---

# 77. PROGRESS UI MAPPING

User-facing progress remains simple.

Internal states map to four understandable messages:

```text
UNDERSTANDING_CLAIM / RESOLVING_SCOPE
→ Understanding claim

RETRIEVING_MEMORY / BUILDING_PLAN
→ Using Research Memory

RESEARCHING / EXTRACTING_EVIDENCE / RECONCILING
→ Searching fresh evidence

GENERATING_PROOF / GENERATING_PRESENTATION / SELF_REVIEW
→ Building Proof
```

Do not expose:
- raw model calls;
- tokens;
- provider names;
- internal prompts;
- full logs.

---

# 78. FIVE START SCREENS — TECHNICAL DATA REQUIREMENTS

## Screen 1 — Home

Needs:
- me/intelligence level;
- Links balance;
- claim input;
- researched Projects list.

## Screen 2 — Research Progress

Needs:
- job id;
- coarse progress state;
- memory-used boolean;
- optional short status text.

## Screen 3 — Proof Result

Needs:
- original Claim;
- verdict;
- confidence;
- summary;
- simple explanation;
- why it matters;
- nuance/risk;
- Deep Check suggestion/cost.

## Screen 4 — Proof Map

Needs normalized graph-ish payload:

```ts
interface ProofMapPayload {
  claimNode: unknown;
  sourceNodes: unknown[];
  evidenceNodes: unknown[];
  gapNodes: unknown[];
  riskNodes: unknown[];
  conflictNodes: unknown[];
  edges: unknown[];
}
```

This is visualization derived from relational Proof/Evidence data.
Do not make the visual graph the source of truth.

## Screen 5 — Links

Needs:
- balance;
- packages;
- payment initiation;
- transaction/order status.

---

# 79. PROOF MAP PERFORMANCE

Keep the rich visual identity but make it lightweight.

Do not render hundreds of React DOM nodes if unnecessary.

Prefer:
- static or pre-rendered network texture/background;
- limited foreground nodes;
- Canvas/SVG/WebGL only where beneficial;
- reduced motion mode;
- device performance fallback.

The evidence data remains accurate even if the visualization is simplified.

---

# 80. SEARCH / MODEL COST ROUTING

Implement task-based routing.

Config concept:

```ts
interface ModelRouteConfig {
  task:
    | "claim_understanding"
    | "source_triage"
    | "evidence_extraction"
    | "reconciliation"
    | "proof_generation"
    | "presentation"
    | "self_review";

  provider: string;
  model: string;

  maxInputTokens?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
  maxRetries: number;
}
```

Escalation:
- cheap model first where safe;
- strong model for reasoning;
- expensive reasoning only when conflict/uncertainty justifies it.

Do not let a presentation task consume the same budget as reconciliation.

---

# 81. CONTEXT CONSTRUCTION

Every model call should receive only relevant context.

Bad:

```text
send entire database + full prior chats + all sources
```

Good:

```text
task
+ exact subclaim
+ relevant Pattern step
+ top relevant memory
+ selected Evidence/source text
+ strict output schema
```

Track prompt/context sizes.

This is necessary for both quality and cost.

---

# 82. MEMORY BENEFIT TELEMETRY

For each retrieved memory item record:

```text
retrieved_at
used_in_plan boolean
used_in_query boolean
used_in_reconciliation boolean
helpful outcome optional
harmful/stale outcome optional
```

This enables:
- memory hit rate;
- useful memory rate;
- stale memory detection.

Do not count "retrieved" as "useful."

---

# 83. LEARNING ROI

We need a simple measurable concept.

Compare:
- new Project first Proof;
- repeated Project Proofs.

Optional later controlled benchmark:
- with useful memory;
- without project-specific memory.

Metrics:
- cost;
- time;
- searches;
- dead ends;
- source quality;
- verdict quality;
- human corrections.

Goal:
memory makes research more efficient without degrading quality.

---

# 84. MANUAL ADMIN WORKFLOW EXAMPLE

Example: Aave current status error.

```text
Proof completed
→ Self Review notices:
  current status may rely on stale evidence
→ Issue:
  owner=GROK
  complexity=LIVE initially
  priority=HIGH
```

Human copies GROK packet.

Grok returns fresh official evidence confirming PAUSED.

Human pastes result.

Now review finds:
- the fresh source already existed in Project Memory
- retrieval failed to use it

Issue is reclassified:

```text
owner=CLAUDE
complexity=NEXT_RELEASE
root=MEMORY_RETRIEVAL_FAILURE
```

Human moves it to Next Release.

If similar cases accumulate:
- group into System Problem Candidate.

Before release:
- GPT + human define expected behavior.
- Claude Code gets one consolidated technical task.
- implement;
- run 5/5 regression;
- observe future Proofs.

This is the intended development loop.

---

# 85. LIVE LEARNING EXAMPLE

Example: new Project has a high-quality official governance page.

```text
Proof completes
→ Self Review captures source as OBSERVED
→ Issue/Learning Candidate says:
  this source is consistently useful for current-status checks
→ human reviews
→ Approve Live
→ Project Memory source entry becomes ACTIVE
→ next Proof checks it earlier
```

No code release needed.

Later metrics should show whether that source actually reduced blind search.

---

# 86. WHAT ADMIN MUST NOT DO

Admin must not:
- execute arbitrary SQL;
- edit arbitrary JSON blobs;
- upload a free-form "truth" into memory without type/status;
- rewrite VERIFIED Proof history;
- change core verdict logic live;
- change Pattern v1 freely;
- auto-call external AI systems in START;
- auto-deploy code;
- silently mutate prompts;
- grant itself payment credits without audit.

Every live action is typed and audited.

---

# 87. BETA IMPLEMENTATION PHASES — REQUIRED ORDER

Do not implement the entire system at once.

## PHASE 0 — Repository Audit + Canonical Lock

Tasks:
- read Master Context + this blueprint;
- inspect repo;
- inventory current stack/modules;
- identify stale Solana payment assumptions;
- identify conflicting old FREE/FOUNDING naming;
- identify missing migrations/tests;
- create implementation plan.

Deliverable:
`docs/implementation/phase-plan.md`

No major code change yet.

Definition of Done:
- no unresolved canonical conflict silently ignored.

---

## PHASE 1 — Domain Foundation + Database

Implement:
- users / identities;
- topics;
- projects / aliases / qualification;
- claims / subclaims;
- patterns;
- memory;
- sources;
- research jobs;
- evidence;
- Proof/version tables;
- reviews/issues/live changes;
- Links core tables;
- audit log.

Seed:
- Token Value Capture Topic;
- Pattern v1 structure;
- five benchmark Project records.

Do not fabricate Evidence seed data.

Definition of Done:
- migrations run from empty DB;
- rollback strategy known;
- seed is deterministic;
- core repository/domain services have tests.

---

## PHASE 2 — Telegram Identity + App Shell

Implement:
- initData verification;
- internal UUID;
- session;
- START entitlement/intelligence level;
- basic five-screen shell using approved visual system.

Definition of Done:
- same Telegram user resolves to same ATLAS user;
- no email/password;
- UI mobile usable;
- no real research yet required.

---

## PHASE 3 — Research Job Infrastructure

Implement:
- async job creation;
- queue/worker;
- state transitions;
- progress API;
- retries/idempotency;
- cost/latency skeleton.

Definition of Done:
- demo job can transition through states and survive worker restart/retry.

---

## PHASE 4 — Claim Understanding + Topic Guard + Project Resolution

Implement:
- structured Claim Understanding;
- subclaims;
- START topic scope;
- ambiguity handling;
- project alias resolution;
- unknown Project discovery.

Definition of Done:
- unsupported claim is not silently researched as Token Value Capture;
- compound claim scope is explicit;
- ambiguous material claim can ask user.

---

## PHASE 5 — Pattern + Memory Retrieval + Planner

Implement:
- Pattern v1 retrieval;
- Topic Memory retrieval;
- Project Memory retrieval;
- freshness-aware memory filtering;
- adaptive plan;
- plan versions;
- memory-use telemetry.

Definition of Done:
- new Project + known Topic uses Pattern v1;
- known Project uses Project Memory;
- planner can skip irrelevant downstream steps;
- retrieved memory is visible in internal job trace.

This phase proves ATLAS does not start from zero.

---

## PHASE 6 — Research Execution + Sources + Evidence

Implement:
- provider interfaces;
- search;
- triage;
- fetch;
- dedupe;
- Research Attempts;
- Evidence extraction;
- provenance;
- freshness;
- stop conditions;
- budget guards.

Definition of Done:
- every strong fact links to Evidence + Source;
- dead ends/duplicates are logged;
- sufficient evidence stops redundant search;
- budget exhaustion becomes explicit gap.

---

## PHASE 7 — Reconciliation + Proof + Presentation

Implement:
- Evidence reconciliation;
- conflicts/gaps;
- verdict/confidence guardrails;
- structured Proof Core;
- Proof versions;
- presentation from Proof Core;
- Proof Map payload.

Definition of Done:
- presentation adds no new factual research;
- old Proof versions remain;
- gaps are visible;
- current claims require freshness.

---

## PHASE 8 — Self Review + Project Learning

Implement:
- Research Review after Proof;
- candidate Project Memory;
- error taxonomy;
- Issue generation;
- metric snapshots.

Initially:
- new learning = OBSERVED only;
- no automatic ACTIVE mutation.

Definition of Done:
- second Proof can retrieve approved memory originating from first Proof;
- self-review can distinguish a duplicate/dead-end/freshness problem.

---

## PHASE 9 — Admin v1

Implement exactly:
- Issues;
- Live Changes;
- Next Release.

Implement:
- GROK/GPT/CLAUDE routing labels;
- LIVE/NEXT_RELEASE/CRITICAL;
- copy-ready packets;
- manual AI Review paste;
- human decision;
- typed Live Change whitelist;
- audit log;
- observation state;
- Next Release grouping.

No direct AI API integrations.

Definition of Done:
- human can take one Issue through full workflow without developer DB editing.

---

## PHASE 10 — Regression + Learning Measurement

Implement:
- 5 benchmark regression fixtures;
- regression run/case result;
- cost/time/search/memory metrics;
- before/after observation;
- simple 5-Proof learning review report.

Definition of Done:
- 5/5 regression runnable;
- regression blocks a material quality regression;
- project learning efficiency can be measured.

---

## PHASE 11 — Links Core + Deep Check

Implement:
- Links account;
- ledger;
- holds;
- pricing config;
- Deep Check child jobs;
- capture/release;
- retry safety.

Use admin/test credits first.

Definition of Done:
- paid-targeted research can be simulated safely;
- technical failure releases hold;
- valid no-evidence result captures if work completed.

---

## PHASE 12 — Telegram Stars Payment

Implement:
- Stars purchase provider;
- verified payment record;
- idempotent Links credit;
- package configuration;
- simple Links UI.

Definition of Done:
- verified purchase credits once;
- duplicate callback cannot double credit;
- frontend cannot credit itself.

---

## PHASE 13 — Hardening / BETA

Implement/test:
- security;
- SSRF;
- rate limits;
- budgets;
- queue backpressure;
- backups;
- alerts;
- admin auth;
- cost ceilings;
- global research pause;
- failure recovery.

Run real BETA claims.

Definition of Done:
- quality gate passes, not merely UI.

---

# 88. START GO / NO-GO QUALITY GATE

Do not launch START because the UI is complete.

Required:

```text
[ ] Telegram identity stable
[ ] START Topic guard works
[ ] Token Value Capture Pattern v1 works in code
[ ] Project Memory actually affects Research Plan
[ ] Fresh Evidence remains mandatory
[ ] current-status freshness works
[ ] Evidence traceability works
[ ] Proof versioning works
[ ] user-facing uncertainty is honest
[ ] Self Review runs after Proof
[ ] Issues are correctly classified often enough to be useful
[ ] Live Changes are human-controlled and auditable
[ ] Next Release queue works
[ ] 5/5 benchmark regression passes
[ ] cost/proof is measured
[ ] dead ends/duplicates are measured
[ ] Links accounting is atomic
[ ] Deep Check is targeted
[ ] Telegram Stars payment is idempotent if enabled
[ ] budget guardrails exist
[ ] admin is protected
[ ] mobile UI remains simple
```

---

# 89. BETA TEST MATRIX

At minimum test:

```text
Known Project + known Topic + fresh memory
Known Project + known Topic + stale memory
New Project + known Topic
Compound claim partially inside scope
Unsupported claim
Ambiguous claim
Conflicting strong sources
Historical vs current mechanism
Announcement but no execution
Revenue but no token bridge
Buyback to treasury
Buyback to redistribution
Burn + larger unlocks
Search dead end
Duplicate search results
Blocked source
Budget exhaustion
Model structured-output failure
Worker retry
Deep Check gap
Live Change
Rollback
Next Release classification
Critical issue classification
```

---

# 90. ACCEPTANCE TEST: PROJECT LEARNING

This is a central BETA proof.

Test:

```text
Project X first Proof
→ ATLAS discovers official docs/governance/dashboard
→ selected items approved into Project Memory

Project X second similar Proof
→ ATLAS retrieves those items
→ checks targeted known sources first
→ performs fewer blind searches
```

Pass only if:
- memory retrieval is logged;
- plan references retrieved memory;
- fewer searches/dead ends are observed or at least behavior is demonstrably more targeted;
- quality does not regress.

---

# 91. ACCEPTANCE TEST: MEMORY FAILURE DIAGNOSIS

Setup:
- ACTIVE memory rule exists;
- relevant to claim.

Failure case:
- final Proof violates it.

Self Review must not simply create the same rule again.

Expected:

```text
existing rule found?
yes
→ was it retrieved?
  no → MEMORY_RETRIEVAL_FAILURE / likely CLAUDE
  yes → was it used in plan?
    no → PLANNING_FAILURE
    yes → was correct evidence found?
      no → SEARCH/SOURCE issue
      yes → interpretation/reasoning issue
```

This diagnostic tree is important.

---

# 92. ACCEPTANCE TEST: LIVE VS NEXT RELEASE

Example 1:

```text
known official source URL is obsolete
→ new official URL confirmed
```

Expected:
- LIVE;
- update Project Memory;
- no code deployment.

Example 2:

```text
system consistently ignores refresh_after
even though values are correct in DB
```

Expected:
- NEXT_RELEASE;
- Claude Code task;
- no attempt to "fix" by duplicating memory.

---

# 93. ACCEPTANCE TEST: AAVE BENCHMARK

The exact source dataset comes from canonical benchmark Evidence.

Behavioral invariant:

```text
Do not present historical buyback existence as proof that mechanism is ACTIVE now.
```

If current execution cannot be verified:
- expose status uncertainty/gap;
- do not fabricate ACTIVE.

This test protects the Freshness principle.

---

# 94. ACCEPTANCE TEST: ETHENA BENCHMARK

Invariant:

```text
Protocol Revenue
does not imply
active ENA Token Value Capture
```

Planner/reconciliation must require bridge/allocation/activation evidence.

---

# 95. ACCEPTANCE TEST: PENDLE BENCHMARK

Invariant:

```text
Buyback
does not imply
Burn
```

Destination/recipient must be represented.

---

# 96. ACCEPTANCE TEST: HYPERLIQUID BENCHMARK

Invariant:

```text
Permanent/effective removal
can exist without a classic burn label,
but it needs direct support for destination/inaccessibility semantics.
```

---

# 97. ACCEPTANCE TEST: PUMP.FUN BENCHMARK

Invariant:

```text
Burn evidence does not end the analysis.
Net token effect must consider incoming supply/unlocks/emissions where material.
```

---

# 98. WHAT TO STORE FROM MODEL CALLS

Store:
- task;
- provider/model;
- schema version;
- prompt template version;
- input size metrics;
- output structured object;
- latency;
- token counts;
- estimated cost;
- error code;
- retry count.

Do not store hidden chain-of-thought.

Prompt text may be versioned, but avoid logging sensitive full source/user content unnecessarily.

---

# 99. PROMPT VERSIONING

Model behavior is part of implementation.

Each core prompt should have a version identifier:
- claim understanding;
- source triage;
- extraction;
- reconciliation;
- proof generation;
- presentation;
- self review.

When a prompt change materially affects research behavior:
- treat it like code;
- test benchmark cases;
- include in release notes.

Do not allow arbitrary prompt editing LIVE in START.

---

# 100. MIGRATIONS / SEEDS

Migrations:
- deterministic;
- reversible where possible;
- production-safe;
- no destructive rename without migration path.

Seed:
- Token Value Capture Topic;
- Pattern v1;
- five Projects;
- known Topic Memory rules only from approved canonical materials.

Evidence/Proof benchmark import should use a structured seed file if available.

Do not invent source evidence to make seeds "complete."

---

# 101. BACKUPS / RECOVERY

Before real BETA:
- scheduled PostgreSQL backups;
- restore procedure tested;
- audit/live-change history backed up;
- payment/ledger data protected;
- secrets separate from backups.

A backup that has never been restored is not proven.

---

# 102. DEPLOYMENT STRATEGY

Prefer:
- migrations first;
- backward-compatible app deploy;
- feature flag activation;
- smoke test;
- regression subset;
- full benchmark when intelligence behavior changed.

For risky Research Intelligence changes:
- deploy disabled;
- run shadow/regression;
- activate after pass.

---

# 103. GLOBAL EMERGENCY CONTROLS

Need server-side controls:

```text
GLOBAL_RESEARCH_PAUSED
NEW_PAID_ACTIONS_PAUSED
STARS_PURCHASES_PAUSED
LIVE_CHANGES_PAUSED
```

If costs/security/quality fail, operator can stop dangerous behavior without redeploy.

---

# 104. DO NOT CONFUSE PRODUCT AI ROLES

There are two separate concepts:

## A. ATLAS internal research model/provider
Used inside Research Engine.

## B. Human diagnostic workflow
- Grok = information review
- GPT = intelligence/learning review
- Claude Code = technical implementation review

START does not need to map internal Research Engine models to Grok/GPT/Claude labels.

Keep these concerns separate.

---

# 105. FUTURE PLUS — ONLY EXTENSION POINTS NOW

START architecture should allow:
- multiple Topic rows;
- Pattern per Topic;
- Topic Memory per Topic;
- topic qualification later.

Do NOT implement Topic learning automation now.

Later PLUS process:

```text
Possible Topic
→ Candidate
→ ~5 deliberately diverse Projects
with EMPTY Topic Pattern
→ discover repeated research structure
→ human review
→ Topic Pattern v1
```

Do not copy Token Value Capture Pattern into a new Topic.

---

# 106. FUTURE PRO — ONLY EXTENSION POINTS NOW

Later:
- Project ↔ Project relations;
- Topic ↔ Topic relations;
- verified Connection Candidates;
- cross-Proof analysis.

Do not build graph DB now.

If future graph relations are needed, PostgreSQL relation tables are enough initially.

A connection only matters if it improves research/understanding.

---

# 107. FUTURE TEAM — ONLY EXTENSION POINTS NOW

Later:
- team-scoped memory;
- roles;
- reviewer/approver;
- shared knowledge.

Do not add team schemas/workflows unless they are trivial extension points required to avoid a hard rewrite.

Current User ID design must not block future team membership.

---

# 108. TECHNICAL DESIGN PRINCIPLES

1. **Evidence-first**
2. **Freshness-first for dynamic facts**
3. **Memory guides, never replaces verification**
4. **Structured internal state**
5. **Immutable history**
6. **Version important behavior**
7. **Human-controlled permanent learning**
8. **Measure learning**
9. **Typed Live Changes**
10. **Core mechanics by release**
11. **Simple user-facing UX**
12. **Do not build future complexity early**

---

# 109. ANTI-PATTERNS — REJECT THESE IMPLEMENTATIONS

## Bad: "Learning" = append every LLM output to vector DB
Reject.

## Bad: use the latest Proof text as memory without provenance
Reject.

## Bad: every Project automatically becomes permanent knowledge
Reject.

## Bad: run 20 searches for every claim regardless of memory
Reject.

## Bad: high confidence because 12 articles say the same thing
Reject.

## Bad: a historical official post proves current status
Reject.

## Bad: broad "agent" can arbitrarily rewrite Pattern
Reject.

## Bad: admin has a textbox "edit ATLAS brain"
Reject.

## Bad: a Live Change can mutate any JSON path
Reject.

## Bad: one giant JSON column for every domain object
Reject.

## Bad: Graph DB before we have qualified connections
Reject.

## Bad: microservices before one modular app proves scale need
Reject.

## Bad: direct AI API orchestration in Admin START
Reject.

---

# 110. CLAUDE CODE WORKING METHOD

For each phase:

1. Explain current repository state.
2. List files/modules to modify.
3. List migrations.
4. List API changes.
5. List state-machine changes.
6. List tests.
7. Implement smallest complete slice.
8. Run:
   - format;
   - lint;
   - typecheck;
   - unit tests;
   - integration tests.
9. Report:
   - what changed;
   - what remains;
   - known risks;
   - any conflict with canonical concept.
10. Do not silently continue into the next phase if current Definition of Done fails.

---

# 111. RECOMMENDED REPO BOUNDARIES

Adapt to existing architecture.

Conceptually:

```text
src/
  auth/
    telegram/

  users/
  entitlements/

  claims/
    understanding/
    scope/

  topics/
  projects/

  intelligence/
    patterns/
    memory/
    project-memory/
    freshness/
    qualification/

  research/
    jobs/
    planner/
    execution/
    attempts/
    sources/
    evidence/
    reconciliation/
    proof/
    presentation/
    self-review/
    deep-check/

  providers/
    models/
    search/
    fetch/
    chain-data/
    payments/

  links/
    accounts/
    ledger/
    holds/
    pricing/

  admin/
    issues/
    live-changes/
    next-release/
    regression/

  observability/
  security/
  audit/
```

Do not force this exact folder structure if the repository already has equivalent boundaries.

---

# 112. DOMAIN SERVICE BOUNDARIES

Conceptual services:

```text
TelegramAuthService
UserService

ClaimUnderstandingService
ProjectResolutionService
TopicGuardService

ResearchPatternService
ResearchMemoryService
ProjectMemoryService
FreshnessService

ResearchJobService
ResearchPlannerService
ResearchExecutionService
SourceTriageService
EvidenceExtractionService
EvidenceReconciliationService
ProofService
PresentationService
ResearchReviewService

IssueService
LiveChangeService
NextReleaseService
RegressionService

EntitlementService
LinksService
LinksLedgerService
PaymentService

CostGuardService
AuditService
```

Keep service interfaces domain-driven, not provider-driven.

---

# 113. INTERNAL COMMANDS / USE CASES

Useful application commands:

```text
StartProof
ClarifyClaim
ResumeResearchJob

RunResearchStep
AddEvidence
CompleteResearchPlan

BuildProof
RunDeepCheck

RunResearchReview
CreateIssue
ClassifyIssue
AddManualAIReview

ApproveLiveChange
ApplyLiveChange
RollbackLiveChange

MoveIssueToNextRelease
GroupSystemProblem

RunRegression

ReserveLinks
CaptureLinks
ReleaseLinks
CreditPurchasedLinks
```

These can be service methods rather than a formal CQRS framework.

Do not add CQRS/event sourcing framework unless current codebase already uses one.

---

# 114. ADMIN AUTHORIZATION

For START, one owner/admin role may be sufficient.

Do not build complex RBAC.

But code should still distinguish:
- normal user;
- admin.

Every `/admin` backend endpoint must verify admin role server-side.

Future TEAM roles are separate and should not be conflated with platform admin.

---

# 115. DATABASE ENFORCEMENT EXAMPLES

Use DB constraints where possible.

Examples:

```text
links_accounts.available_balance >= 0
links_accounts.reserved_balance >= 0
```

Use transaction-level enforcement for movements.

Unique:
```text
user_identities(provider, provider_user_id)
proof_versions(proof_id, version_number)
payment provider transaction id
ledger idempotency key
live_changes(issue_id, deterministic_action_key) where appropriate
```

Foreign keys should protect provenance.

---

# 116. ERROR CODES

Prefer stable machine-readable errors:

```text
AUTH_INVALID_TELEGRAM_INIT_DATA
AUTH_EXPIRED_TELEGRAM_INIT_DATA

CLAIM_UNSUPPORTED_TOPIC
CLAIM_NEEDS_CLARIFICATION

RESEARCH_BUDGET_EXCEEDED
RESEARCH_PROVIDER_TIMEOUT
RESEARCH_STRUCTURED_OUTPUT_INVALID
RESEARCH_SOURCE_FETCH_FAILED

INSUFFICIENT_LINKS
LINKS_HOLD_CONFLICT

PAYMENT_NOT_VERIFIED
PAYMENT_ALREADY_CREDITED

ADMIN_LIVE_CHANGE_NOT_ALLOWED
ADMIN_LIVE_CHANGE_ALREADY_APPLIED

REGRESSION_FAILED
```

User-facing messages should remain simple.

---

# 117. QUALITY VS SPEED

Do not prematurely optimize latency by:
- skipping fresh verification;
- removing Evidence extraction;
- using memory as truth;
- collapsing all research steps into one opaque model call.

Optimize:
- better memory retrieval;
- better source targeting;
- fewer duplicates;
- stop conditions;
- task-specific models;
- smaller context;
- caching where fresh-safe;
- parallel independent research branches where budget allows.

---

# 118. SAFE PARALLELISM

Parallelize only independent steps.

Example:
- current revenue source and unlock schedule may be researched in parallel.

Do not parallelize blindly if one step determines whether another is applicable.

Planner can encode dependencies:

```ts
dependsOnStepIds: string[]
```

Avoid duplicate searches across parallel branches using a shared job-level dedupe registry.

---

# 119. JOB-LEVEL DEDUPE

Maintain normalized sets for:
- query fingerprint;
- canonical URL;
- content fingerprint;
- source id.

Before new search/open:
- check existing attempts;
- check Project Memory;
- check current job registry.

Log deduped attempts so Research Review can measure them.

---

# 120. CONTENT SNAPSHOT / PROVENANCE

For reproducibility, where legally/technically appropriate, store:
- fetched_at;
- content fingerprint/hash;
- extracted evidence fragment;
- source URL/title;
- locator.

You do not need to store entire copyrighted pages indefinitely.

The Proof should be reproducible from provenance metadata and evidence fragments within allowed limits.

---

# 121. TIME HANDLING

Store server timestamps in UTC.

Preserve:
- source-provided date/time;
- data_as_of;
- observed_at;
- fetched_at.

Never compare "current" using frontend device time as authoritative.

---

# 122. MONEY / UNIT HANDLING

Use integers:
- Links = bigint/int;
- Stars/payment amounts = integer provider units;
- estimated costs = integer minor units or decimal-safe type.

Never use floating-point for balances/payment accounting.

---

# 123. CONFIGURATION OWNERSHIP

Business configuration:
- Links packages;
- research action cost;
- hidden BETA limits;
- model routes;
- provider credentials;
- global pause.

Do not scatter hardcoded values through Research Engine.

But not every config needs an Admin screen in v1.
Database/config file/env can be enough until real need appears.

---

# 124. DOCUMENTATION CLAUDE MUST KEEP UPDATED

Inside repo keep:

```text
/docs/canonical/ATLAS_PROOF_MASTER_CONTEXT_CURRENT.md
/docs/architecture/research-loop.md
/docs/architecture/data-model.md
/docs/architecture/admin-learning.md
/docs/architecture/links-payments.md
/docs/testing/regression-benchmark.md
/docs/operations/runbook.md
/docs/implementation/current-phase.md
```

Update architecture docs when implementation materially diverges for a validated reason.

---

# 125. FINAL IMPLEMENTATION MENTAL MODEL

If Claude Code remembers only one internal model, use this:

```text
USER CLAIM
   |
   v
UNDERSTAND / SCOPE
   |
   v
TOPIC + PROJECT
   |
   v
PATTERN
+ TOPIC MEMORY
+ PROJECT MEMORY
   |
   v
ADAPTIVE PLAN
   |
   v
FRESH RESEARCH
   |
   v
SOURCE TRIAGE
   |
   v
EVIDENCE
   |
   v
FRESHNESS + RECONCILIATION
   |
   v
PROOF CORE
   |
   +----------------------+
   |                      |
   v                      v
USER PRESENTATION     RESEARCH REVIEW
                          |
                          v
                     ISSUE / LEARNING
                          |
                 +--------+---------+
                 |                  |
                 v                  v
             LIVE ADMIN        NEXT RELEASE
                 |                  |
                 v                  v
             HUMAN APPROVAL     CLAUDE TASK
                 |                  |
                 +--------+---------+
                          |
                          v
                    FUTURE PROOFS
                    SHOULD IMPROVE
```

This is ATLAS PROOF.

The system is not complete when it can answer one claim.

The core concept is proven when it can:
1. research a claim correctly;
2. retain useful verified research experience;
3. use that experience in a later Proof;
4. detect its own research problems;
5. let a human safely improve knowledge live;
6. separate deeper system problems for the next release;
7. demonstrate measurable improvement without losing quality.

---

# FINAL CLAUDE CODE RULE

> **Build the smallest system that genuinely closes the learning loop. Do not build the biggest system that can be imagined.**

And:

> **Knowledge can evolve live. Core mechanics evolve by release.**

And:

> **ATLAS proposes. AI helps analyze. Human approves. Fresh Evidence verifies.**
