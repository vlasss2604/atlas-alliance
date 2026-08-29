# Current task

> Overwrite this file each round. Never append.

## NONE — the interpretation window is READY, with one structural caveat

Offline preparation. Nothing executed, no DB mutation, no code changed.

## The API contract, read from the route

- **`POST /api/interpretations`**
- **Body:** `{ "question": "<string>" }` — that is the *only* field read.
  Trimmed, non-empty, length-capped; anything else is ignored.
- **Auth:** `requireMutation` = allowed Origin **+ session cookie + CSRF
  token**. Per-user rate limit applies.
- **Gate:** `interpreter_enabled` must be true — **verified true**.
- **Response 201:** `{ interpretation: { id, status, attempt, route, … },
  gates: { … } }`. **The id you need is `interpretation.id`.**
- **The project slug is NOT supplied in the request.** The model proposes
  entities and the server resolves them (`resolveAllEntities` →
  `applyServerDecisions`), which also decides `status`. So project association
  is *earned* by the question naming the project recognisably — it cannot be
  forced through the API.
- `normalized_intent` and `route` live inside the persisted `result` jsonb,
  not in the request.

## Gates — all already correct, nothing to change

`interpreter_enabled = true` · `internal_alpha_enabled = true` ·
`research_enabled = false` (correct — enabling it would *close* the owner
path) · `interpreter_model = claude-haiku-4-5` · one ADMIN user exists.

## The question

```
Where does the revenue from Raydium's trading fees go, and what happens to the RAY that is bought back?
```

It names the project explicitly (so entity resolution can bind it), asks about
a mechanism the acquired document actually describes (12% of trading fees →
buyback → held at a documented address), and needs **no transaction history** —
it asks where value goes, not whether a particular transfer executed.

**Classification hypothesis only — the interpreter decides, and I have not
forced it:** most likely `PROTOCOL_REVENUE_TO_TOKEN`, plausibly
`VALUE_CAPTURE` or `TOKEN_UTILITY`. All three are in the existing vocabulary;
no new intent is needed.

## The structural caveat you should know BEFORE running

**A Stage B run establishes exactly ONE component** (`--component`, `--step`),
and S5→S8 are job-scoped, so one resumed job carries one component result.

Every research intent's REQUIRED set needs more than `DESTINATION` alone:

| intent | REQUIRED | reachable from one component? |
|---|---|---|
| `PROTOCOL_REVENUE_TO_TOKEN` | `SOURCE_OF_VALUE` + flow → `DESTINATION` | no — two |
| `USAGE_TO_TOKEN_LINKAGE` | same shape | no |
| `VALUE_CAPTURE` | those two **+ NET_EFFECT** | no — three |
| `BURN_OR_SUPPLY_EFFECT` | `NET_EFFECT_ESTABLISHED` | not established (held, not burned) |
| `MECHANISM_CURRENT_STATE` | lifecycle `CURRENT` | needs `CURRENT_STATE` |
| `TOKEN_UTILITY` | **`SOURCE_OF_VALUE` only** (its second requirement is OPTIONAL) | **yes** |

So: **a `SUPPORTED` verdict is not reachable from one Stage B run** unless the
classification lands on `TOKEN_UTILITY` *and* Stage B targets
`--component=SOURCE_OF_VALUE --step=1`.

For any other classification the honest expected outcome is
`PARTIALLY_SUPPORTED` or `INSUFFICIENT_EVIDENCE` **with named requirement gaps**
— which is still a large step past today's `INTENT_NOT_CLASSIFIED`: a claim
actually evaluated, with the missing bridge named. I am not proposing to bend
the question toward `TOKEN_UTILITY` to manufacture a green verdict; that would
be choosing the question to fit the answer.

## Live footprint of this one request

**1 interpreter model generation.** No `count_tokens` on this path, **0**
retries (a failure surfaces as an error), **0** search, **0** source fetches,
**0** RPC. Classification only — the request starts no research.

## MantaRay: **ON**

Anthropic requires it. This request touches **no Raydium host** — it reads only
the question text and the local DB — so the blocked-address problem is
irrelevant here. No VPN toggling inside the request.

## Success conditions, in real column names

Persisted row in `interpretations` with:
`status = 'READY'` · `result->>'normalized_intent'` ≠ `'UNKNOWN'` and present ·
`result->>'route' = 'DEEP_RESEARCH'` · `result->'project_slugs'` (or
`project_slug`) containing **`raydium`** · `result->>'research_task'` non-empty ·
`research_job_id IS NULL`.

Those are exactly what Stage B's new validation checks.

**One honest risk:** `status` and the project binding are decided by the server
from the model's output. If the question comes back `NEEDS_CLARIFICATION`, or
resolves to no project, the row is not usable and a second attempt (a second
model call) is needed. That is a genuine possibility, not a certainty — it
cannot be settled offline.

## Owner procedure — use the app, not a shell

`POST /api/interpretations` requires an **Origin check, a session cookie and a
CSRF token**. A bare PowerShell/curl call cannot reproduce those safely, and I
will not invent a token or a bypass. So:

**Ask the question in the Mini App**, signed in as the ADMIN user, with
MantaRay **ON**. That is the real supported route and the one a user takes.

Then read the id back — read-only:

```bash
psql "$env:DATABASE_URL" -c "SELECT id, status, result->>'normalized_intent' AS intent, result->>'route' AS route, result->'project_slugs' AS slugs, research_job_id FROM interpretations ORDER BY created_at DESC LIMIT 3;"
```

Use that `id` as `--interpretation-id` in Stage B.

## Full sequence to the next real Proof

1. **Interpretation** — app, ADMIN, MantaRay **ON**. 1 model call.
2. **Stage A** — `acquire-document.ts`, MantaRay **OFF** (the previous
   document is consumed, and ON reproducibly hits `BLOCKED_ADDRESS`).
3. **Stage B** — MantaRay **ON**, with both ids, choosing `--component` /
   `--step` to match the classified intent's requirements.

## READY

No blocker. Nothing in the repository needs to change. The caveat above is
about what verdict to *expect*, not about whether the run can proceed.

### Standing boundaries

- The interpreter classifies; never force or hardcode an intent.
- Do not choose the question to fit a desired verdict.
- No live call without a separate authorized window.
- Never weaken SSRF, and never toggle the VPN inside a running process.
