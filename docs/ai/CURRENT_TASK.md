# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The two-statement mechanism-binding question was answered offline.
**Decision: B — materially strengthens the case, still requires an explicit
address-level statement.** No code changed; no defect found.

### The join, and why it is refused

Two official statements were offered: a first-party thread saying **two**
"buyback & burn wallets" carry out the buybacks, and held OFFICIAL_DOCS listing
exactly **two** "Burn addresses".

**Cardinality does not establish identity.** |X| = 2 and |Y| = 2 does not entail
X = Y. The thread itself names a separate class of **intermediary wallets**, so
the design demonstrably has more than one wallet class — and an architecture of
buyback wallets feeding distinct burn addresses fits both documents exactly as
well. Counts also drift between dates.

**Shared mechanism context does not establish it either.** Both texts describe
one mechanism, which is precisely the setting where a wrong identity join is most
tempting and least detectable. This is locator co-occurrence in a better
disguise.

**Chain behaviour cannot decide it.** Not circular — the observation is
independent — but affirming the consequent, and a category error: a role is an
institutional fact, and just as a documentary label is never a chain fact, chain
behaviour is never a role assignment. It does legitimately rule out a passive,
receive-only reading of `99mRw3…`, which acquires and burns under its own
authority. That is plausibility, not identity.

The circularity to avoid later: using the documents to decide the chain activity
*is* the buyback, then citing the chain as confirmation of the role.

### Nothing to fix

Checked rather than assumed. The join is refused by construction in two
independent places: documentary locators admit an identifier only when it appears
literally in the document, and S6 slot identity is structural only, with no
classifier ever reaching identity (D-101, mutation-verified). Decision C does not
apply.

### The actionable outcome

**Acquiring the thread would not change the verdict** — `twitter.com` is not
`pump.fun`, and SOCIAL establishes nothing however official the account (D-074).
Its value is as a pointer.

**`fees.pump.fun` is now the highest-value target in the case.** Named by
Pump.fun's own thread as where buybacks and burns are tracked, and a `pump.fun`
subdomain, so it could carry OFFICIAL_DOCS authority if its route were confirmed.
An address-level assignment of the acquisition role would plausibly live here and
nowhere else. Reaching it needs an authorized live window.

**Read it against the right standard.** An endpoint named `buybacks` is not a
statement. Records that merely contain the addresses are locator co-occurrence
again — the same error with a fresher source. The payload must assign the role.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
