@AGENTS.md

# ATLAS PROOF

ATLAS PROOF is Research Intelligence for Digital Assets, delivered as a Telegram
Mini App. The research intelligence inside the product is called **ARI** (Atlas
Research Intelligence). The current paid level is **ARI • CORE**; the free entry
level is **DEMO**.

The product proves things about tokens from evidence. **Evidence over opinions.**

---

## Read this first, and read little else

Start every session by reading exactly two files:

1. `docs/ai/CURRENT_STATE.md` — where the system actually is right now
2. `docs/ai/CURRENT_TASK.md` — the one scoped task you are here to do

Then read **only** what that task needs. `docs/ai/INDEX.md` says which document
answers which kind of question, and — just as importantly — when not to open one.
Do not preload the whole `docs/ai/` set. Selective loading is the point.

**History lives in git, not in documents.** For how something came to be the way
it is, use `git log --oneline`, `git show <commit>`, `git blame`, the tests, and
the source. The AI documents describe current semantics; they never narrate
development rounds.

## Owner working style

The owner is not a professional programmer. Be precise, explain findings in plain
terms, and do not assume low-level knowledge.

- One scoped task at a time. Do not expand into a broad audit without authorization.
- Single-agent work. No dynamic subagent swarms, no parallel implementation.
- Preferred mode for correctness-critical work: Opus 5, High, single-agent.

Working order: inspect only the relevant surface → identify the exact gap → make
the smallest **generic** correction → add regression tests → run focused tests →
typecheck and lint → report exactly what changed → commit → leave git clean.

**Never write a project-specific patch when a generic research rule solves it.**
`if (project === "pump_fun")` is always the wrong answer. A new failure mode
becomes a generic rule plus a regression test, so every future project inherits
the fix.

## Fail closed

When entity binding, source authority or evidence is insufficient, **stop and say
what is missing** — never guess, never explore an arbitrary branch. Insufficient
evidence is a valid, successful outcome when the missing bridge is named
correctly. Absence of a mechanism is a valid finding. Do not force a verdict.

The durable research invariants (source ≠ evidence ≠ fact ≠ proof claim, transfer
≠ buyback, buyback ≠ burn, proposal ≠ execution, same transaction ≠ causality,
and the rest) live in `docs/ai/CORE_RULES.md`. Read it before touching research
logic, evidence semantics or reconciliation.

## Live calls

Development is offline by default. A live HTTP or RPC call requires **explicit
per-task authorization** from the owner, is bounded and prepared in advance, and
is executed with zero retries. Never weaken SSRF protection, never whitelist a
reserved IP range, never special-case a domain to make a local network work. The
operational procedure for live validation is in `docs/ai/PUMP_CASE.md`.

## Reporting discipline

Every exact number you state — slot, signature, hash, amount, artifact id, row
count, timestamp — must come from something you actually observed: code output, a
test, the local DB, a persisted artifact. A previous report fabricated a slot
number in prose while the code provenance was correct. If a value is not
verified, write **"not verified"** rather than inventing one.

## Product rules

- CORE is not a fixed catalog of projects. CORE is cumulative Research Intelligence.
- The initial trained domain is **Token Value Capture**. Do not expand supported
  domains without explicit approval.
- User-facing answers start simple. Internal research complexity must not leak
  into the first answer. ATLAS is not a generic "ask anything" chatbot.
- Concept defines the screen. A UI element in a generated mockup is not
  automatically a requirement.
- Do not silently change product strategy. If a change requires altering the
  locked concept, output **STRATEGY REVIEW REQUIRED** and stop.

## Access rules

- Entitlement determines whether a **new** operation may start. A later
  entitlement change must never destroy legitimate Proofs or terminate an
  already-authorized Research Job.
- Entitlement is enforced **server-side**. A hidden button is not access control.
- Scope and Entitlement are different. A project can be in research scope while
  being unavailable to DEMO.
- Proof is private by default. No public Proof URLs in v1.

## Research rules

- Research Memory guides. Fresh Evidence verifies. Retrieval first.
- Derive conclusions: actor → mechanism → source → path → outcome. Never hard-code
  a token-specific conclusion.
- Stop when the question is answered. Do not over-research.
- Only VERIFIED research outcomes become durable memory. User activity produces
  signals, not truth.

## Development rules

- Audit before major migration. Preserve working architecture; do not rewrite
  what already works.
- Run regression tests after changing CORE behavior.
- A ResearchJob is a persistent entity, not a blocking API call. If the UI says
  the user can come back later, the server must guarantee it.
- Never fake research progress stages that are not actually occurring.

## Reference documents (read on demand only)

- `docs/ai/INDEX.md` — navigation for the AI memory set
- `docs/PRODUCT_QUALITY_DIRECTIVE.md` — powerful intelligence inside, radically
  simple experience outside. Priority: correctness → reliability → performance →
  simplicity → visual polish.
- `docs/ARI_LEARNING_LOOP.md` — how ARI is meant to evolve (no LLM weight changes)
- `docs/DEVELOPMENT_WORKFLOW.md` — the approved phase cycle
- `docs/DECISIONS.md` — the numbered D-### decision register
- `docs/handoff/` — the original bootstrap package (historical)

## Memory discipline

Durable architecture → `CLAUDE.md` / `docs/ai/` / Skills. Small working
observations → agent memory. **Strategy must never originate in auto-memory.**
No AI document may grow into a chat transcript.
