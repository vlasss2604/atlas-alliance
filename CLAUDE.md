@AGENTS.md

# ATLAS PROOF

ATLAS PROOF is Research Intelligence for Digital Assets, delivered as a Telegram Mini App.

The research intelligence inside the product is called **ARI** (Atlas Research Intelligence).
The current paid level is **ARI • CORE**. The free entry level is **DEMO**.

---

## Product rules

- CORE is **not** a fixed catalog of projects. CORE is cumulative Research Intelligence.
- The initial trained domain is **Token Value Capture**. Do not expand supported domains without explicit approval.
- User-facing answers start simple. Internal research complexity must not leak into the first answer.
- ATLAS is not a generic "ask anything" chatbot.
- Concept defines the screen. Visual references define style direction only.
- A UI element appearing in a generated mockup is **not** automatically a product requirement.
- Do not silently change product strategy.

## Access rules

- **Entitlement determines whether a NEW operation may start.**
  A later entitlement change must never retroactively destroy legitimate Proofs or terminate an already-authorized Research Job.
- Entitlement is enforced **server-side**. A hidden button in the UI is not access control.
- Scope and Entitlement are different concepts. A project can be inside ATLAS research scope while being unavailable to DEMO.
- Proof is **private by default**. No public Proof URLs in v1.

## Research rules

- Research Memory guides. Fresh Evidence verifies.
- Retrieval first: consult verified prior knowledge before launching fresh research.
- Do not hard-code token-specific conclusions. Derive them: actor → mechanism → source → path → outcome.
- Absence of a mechanism is a valid finding. Do not force a conclusion.
- Insufficient evidence is a valid verdict. Do not guess.
- Stop when the question is answered. Do not over-research.
- Only VERIFIED research outcomes become durable reusable memory. User activity produces signals, not truth.

## Development rules

- Audit before major migration.
- Preserve working architecture where possible. Do not rewrite what already works.
- Run regression tests after changing CORE behavior.
- A ResearchJob is a persistent entity, not a blocking API call. If the UI says the user can come back later, the server must guarantee it.
- Never fake research progress stages that are not actually occurring.
- If a change requires altering the locked product concept:
  output **STRATEGY REVIEW REQUIRED** and stop.

## Before major changes

1. Inspect.
2. Explain current behavior.
3. Identify gaps.
4. Produce implementation plan.
5. Wait for approval when product behavior changes.
6. Implement.
7. Test.

## Memory discipline

- Important architecture → `CLAUDE.md` / Skills.
- Small working observations (how tests run, local patterns) → agent memory.
- Strategy must never originate in auto-memory.
