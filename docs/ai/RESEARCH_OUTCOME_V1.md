# ATLAS Research Outcome — V1

Product-quality specification. This document freezes what a high-quality ATLAS
research outcome must achieve. It is not an implementation backlog, it proposes
no code, and it changes no verdict semantics. Where it names a component,
status or module, that is to anchor the standard in what exists — never to
schedule work.

## The principle

**ATLAS does not summarise research. It completes the evidence work.**

The difference is what the user has left to do afterwards. A summary leaves the
user with verification: open the sources, check the claim, find the transaction,
confirm the destination. A completed research outcome leaves the user with
**judgment** — what this means for their position, their conviction, their
portfolio — because the verification has already been done and is shown.

Research broadly enough to be correct. Answer narrowly enough to be useful.
Prove on demand.

## One research truth, several reader depths

There is exactly one canonical research result per Proof. The normal user, the
analyst and the fund or risk user all read the same truth; they differ only in
how far they choose to expand it.

- **Normal user** — the concise conclusion.
- **Analyst** — the conclusion, plus the evidence behind each link, expanded on
  demand.
- **Fund / risk user** — all of that, plus full provenance and the Audit.

There are **no separate retail and fund research semantics**. A Proof does not
say one thing to one reader and another thing to another. It says one thing, at
the depth the reader asks for.

---

## The canonical outcome

Every high-quality Proof achieves the following six, in this order of
importance. The first four are always present. The fifth is always present. The
sixth is present only where the verified evidence supports it.

### 1. ANSWER

A direct, human-language answer to the **exact question asked**.

- It comes first. No research tutorial precedes it, no explanation of method,
  no description of what ATLAS checked.
- It is not a status code. `PARTIALLY_SUPPORTED` is a canonical verdict and
  remains stored and visible; it is never the primary conclusion a reader is
  handed. The conclusion is a sentence about the token.
- It answers the question that was asked, not a neighbouring one the research
  found easier. If the user asked whether burning reduces supply, the answer is
  about supply, not about whether burns occur.
- It leads with what is established before what is not. "Burn was confirmed,
  but total supply did not decrease over the measured period" — the positive
  fact, then the limit on it.

### 2. CURRENT STATE

Where the relevant mechanism stands **now**, stated from the evidence actually
established.

The states a mechanism can be in are, conceptually: documented → approved →
activated → executing → value held / burned → net effect established. These
are a ladder, and the ladder is climbed only on evidence:

- **Never infer a later state from an earlier one.** Documented does not imply
  approved. Approved does not imply executing. Executing does not imply the
  value went where the documentation says. A burn does not imply the supply
  fell.
- State the highest rung the evidence reaches, and stop there.
- Where the question has a time dimension, the state is the state at the
  research cutoff, and says so.

### 3. PROOF OR BLOCKER

The single strongest piece of evidence that establishes the current state — or,
where the next state is not established, the **concrete condition or blocker**
that explains why.

What a proof looks like, conceptually: an observed execution transaction; a
current metric set beside the stated activation threshold; the destination
account the value reached; a supply observation at a chain position.

What a blocker looks like: the activation threshold the metric has not reached;
the absence of any observed execution in the window checked; the destination
that could not be resolved; the interval over which supply could not be
measured.

The hard rule: **absence of found evidence is never converted into evidence of
absence.** "ATLAS did not observe an execution" and "no execution occurred" are
different sentences, and only the first may ever be written from a silent
record.

### 4. HOLDER IMPACT

One concise clause, where applicable, saying what the established state
actually means for the token or the holder.

This is where ATLAS's invariants earn their keep, because each one is a
misreading a holder would otherwise make:

| Invariant | The misreading it prevents |
| --- | --- |
| BUYBACK ≠ BURN | "they bought tokens, so supply fell" |
| BURN ≠ NET DEFLATION | "they burned tokens, so the token is deflationary" |
| HELD TOKENS ≠ SUPPLY REDUCTION | "the treasury holds them, so they are out of circulation for good" |
| REVENUE ≠ TOKEN VALUE CAPTURE | "the protocol earns money, so I benefit" |
| POINT-IN-TIME SUPPLY ≠ SUPPLY CHANGE | "supply is X today, so it fell / rose" |

Holder impact never asserts causality that was not established, never uses
market language (bullish, bearish, undervalued), and never gives advice. It
says what the verified state does and does not mean for the holder — no more.

### 5. EVIDENCE BOUNDARY + CUTOFF

Explicitly, every time:

- **what was not established** — named, not implied;
- **the research cutoff** — the moment the evidence speaks for.

And the distinction that must never blur: **a technical acquisition failure is
not a fact about the project.** A source that could not be opened, a provider
that was unavailable, a budget that ran out — each is a limit of the run and is
reported as one. It is never allowed to read as "the project lacks this".

### 6. WHAT WOULD CHANGE THE CONCLUSION

Where — and only where — the verified evidence naturally supports it, the
observable condition or evidence that would move the conclusion.

Conceptually: the activation threshold being reached; a first attributable
execution appearing; the destination changing; a later supply observation that
establishes a measurable delta.

This section is **not** a requirement of every Proof. A condition is stated only
when the evidence already in hand makes it concrete and observable. Hypothetical
conditions invented to fill the space are worse than silence, because they
imply the research knows what the next fact would be when it does not. Note in
particular that a documentary statement alone cannot serve as a closing
condition for an on-chain question — a document cannot establish what did or did
not happen on chain.

---

## Reader hierarchy

The same Proof, read at three speeds. Nothing is removed at any speed; the
reader simply stops earlier.

| Time | What the reader has |
| --- | --- |
| **First 10 seconds** | ANSWER + CURRENT STATE |
| **First 60 seconds** | + PROOF / BLOCKER + HOLDER IMPACT + BOUNDARY / CUTOFF |
| **On demand** | full evidence chain, sources, timestamps, transactions, alternative interpretation, Audit |

**A deeper answer is not a longer answer.** Depth means ATLAS verified more
critical causal links before reaching the conclusion — not that it wrote more
sentences about them. The ten-second layer of a deep Proof and of a shallow one
are the same length. What differs is how much of the chain behind them is
established rather than assumed.

---

## Boundaries with the rest of the product

**The Scenario Matrix is an internal capability map.** It records which
evidence questions ATLAS can attempt. It must never cause a Proof to answer all
scenario families when the user asked one question. A user who asks about
supply is answered about supply; the other eleven families are not their
concern in that moment, however well ATLAS could address them.

**Insight is separate and second-order.** An Insight may not repeat the ANSWER,
the CURRENT STATE, the PROOF / BLOCKER or the BOUNDARY. It appears only when the
already-verified research supports a genuinely second meaning — one the reader
would miss from the six elements above. When no such meaning exists, there is
no Insight, and nothing marks its absence.

---

## Long-term quality target

ATLAS should make the evidence and research work **substantially complete**, so
that a professional user mainly applies judgment, portfolio context and
conviction afterward — not verification.

The test of a Proof, for an analyst, is what they do next. If they open the
sources to check the claims, the Proof did not finish its work. If they read the
conclusion, expand two links to confirm the shape, and move on to deciding what
it means for their book, it did.

### Quality priority for ATLAS-versus-human evaluation

When ATLAS is eventually measured against competent human research on the same
question, the axes are ranked. A higher axis is never traded for a lower one.

1. **Correctness** — the key distinction is right; no invariant is conflated.
2. **Depth / critical relationships found** — the causal links that decide the
   answer were verified, including the ones a summary would skip.
3. **Evidence completeness / provenance** — every claim resolves to a source the
   reader can open; on-chain claims resolve to chain positions.
4. **Clarity of final conclusion** — a non-specialist reads the ten-second
   layer once and understands it.
5. **Speed** — how long the research took.
6. **Cost** — what it cost to produce.

Speed and cost are real and are measured. They are last because a fast, cheap,
wrong Proof is worth less than nothing: it borrows the authority of the ones
that were right.

---

## What this document is not

It is not a backlog and it does not schedule work. It does not redefine
`SUPPORTED`, `PARTIALLY_SUPPORTED`, `CONTRADICTED` or `INSUFFICIENT_EVIDENCE`,
which remain the canonical verdicts and remain visible. It does not describe
screens. It states the standard a Proof is held to, so that when a Proof falls
short, the shortfall can be named in these terms rather than argued about.
