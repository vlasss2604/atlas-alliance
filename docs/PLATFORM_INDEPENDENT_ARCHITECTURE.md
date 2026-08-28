# PLATFORM-INDEPENDENT ARCHITECTURE

**Status: ACTIVE ARCHITECTURAL CONSTRAINT — binding on all current development.**

> **ATLAS IS THE PRODUCT. TELEGRAM IS ONLY THE FIRST INTERFACE.**
> Equivalently: **Telegram is a client, not the platform.**

Unlike `PROJECT_ASSESSMENT_PRODUCT_SPEC.md` (a recorded *future* vision, D-124),
this document is **not** a future idea. It is an active constraint on the code
being written now: current development must not create Telegram dependency
inside the ATLAS Core. What stays deferred is the *implementation* of other
clients — Web, iOS, Android, React Native, Flutter, Apple/Google billing,
Teams, partner APIs are **not** authorized by this document.

Owner decision registered as **D-125** in `docs/DECISIONS.md`.

---

## 1. The dependency invariant

Required direction:

```
CLIENT  (Telegram Mini App today; others later)
  ↓
APPLICATION / SERVICE LAYER  (API routes, services, auth adapters)
  ↓
ATLAS DOMAIN / CORE  (engine, domain, memory, persistence)
```

Forbidden direction:

```
ATLAS DOMAIN → TELEGRAM
```

**The ATLAS domain must not need to know Telegram exists.** Telegram-specific
concerns — authentication bootstrap, the WebApp SDK, navigation, deep links,
payment integration, presentation — live at the system edge and never become
Proof-domain concepts.

The **removal test** is the primary design-review rule for every future
feature:

> *"If Telegram disappeared tomorrow, could this feature still operate through
> another client against the same ATLAS backend?"*

If the answer is NO, platform-specific code has leaked into Core. This is a
design-review rule today, not an automated test.

## 2. What belongs to Core (platform-independent, always)

Proof Engine · Claims · Evidence · Sources · Components · Reconciliation ·
Pattern · Mechanism State · Memory · Projects · future Promises · future Risks
· future Project Assessment · Research Trace · Watch/monitoring state ·
user/account state · usage policy · entitlements.

**A client displays these results. A client does not establish their truth.**

## 3. What the Telegram client may own — and may not decide

May own: UI rendering, user input, navigation, Telegram auth bootstrap,
Telegram SDK integration, Telegram-specific payment integration, deep links,
Telegram-specific presentation.

Must NOT independently decide: Verdict, Evidence state, component
reconciliation, Promise assessment, Risk state, project mechanism state,
entitlement truth, usage eligibility.

Conceptual flow:

```
Telegram UI
→ platform-independent application/service boundary
→ ATLAS Core
→ persisted structured result
→ Telegram presentation
```

## 4. Mapping onto the REAL repository (verified 2026-08-28)

The current codebase was inspected before this document was written. The
constraint is largely **already implemented** — this section records where each
concern canonically lives, so no future work invents a duplicate.

### 4.1 User identity — internal and canonical (ALREADY SATISFIED)

- **Canonical identity**: `users.id` (uuid), `src/server/db/schema/identity.ts`.
  The row is platform-neutral: role, language, onboarding — no Telegram field.
- **External identities attach** via `user_identities`
  (`provider` + `provider_user_id`, unique together). Telegram is a *provider
  value* (`'TELEGRAM'`; dev bypass uses `'TELEGRAM_DEV'`), not a schema
  concept. Apple/Google/email would be new provider values in the same table —
  **no new identity table is needed, and none may be created**.
- **Sessions** (`sessions`) are internal token-hash sessions referencing
  `users.id`. Every domain row — `research_jobs`, `proofs`, `evidence`
  ownership, `subscriptions`, quota — references the internal uuid, never a
  Telegram id. **A Telegram user ID is not, and must not become, the canonical
  ATLAS identity.**

### 4.2 Telegram auth is an edge adapter (ALREADY SATISFIED)

`app/api/auth/telegram/route.ts` → `src/server/auth/authenticate.ts` →
`initdata.ts` (HMAC validation of Mini App initData). The chain validates the
platform assertion at the edge, resolves/creates the internal user through
`user_identities`, and issues an internal session. The Telegram user id never
travels past the identity-attachment table. The rate limiter's `tg:` bucket
(`auth_rate_limits`) applies only to signature-verified ids and is an auth-edge
concern.

### 4.3 Client platform isolation (ALREADY SATISFIED)

`src/client/platform.ts` is the **ClientPlatformAdapter**: all
`window.Telegram` access lives behind a `PlatformAdapter` interface with
`kind: "telegram" | "web"` — a web fallback adapter already exists, and the
frontend core does not know `window.Telegram` exists (its own stated contract,
canonical v3 §2A). The Telegram SDK is one external `<script>` in
`app/layout.tsx`, used only inside the adapter. **`package.json` carries no
Telegram SDK dependency at all.**

### 4.4 Application boundary (ALREADY SATISFIED)

All client access goes through API routes (`app/api/*`) into services
(`src/server/services/`: `entitlement.ts`, `gates.ts`, `start-research.ts`,
`start-owner-alpha-research.ts`). Verified: **no file under `app/` (outside
`app/api`) or `src/client/` imports `src/server/engine`** — the frontend calls
routes, never Proof internals, and reimplements no domain logic.

### 4.5 Entitlement ≠ payment provider (PARTIALLY SATISFIED)

- Entitlement is **computed, not stored** (`resolveEntitlement`,
  `src/server/services/entitlement.ts`): an entitling subscription is
  `status IN (ACTIVE, CANCEL_AT_PERIOD_END) AND now() < valid_until`. The
  question asked is *"does this user hold the required entitlement?"* — never
  *"did Telegram Stars succeed?"*.
- `subscriptions` references the internal user and carries a **provider-
  agnostic** `billing_provider` text column (default `'TELEGRAM_STARS'`) plus
  `provider_subscription_ref`. Verified: **nothing in the codebase reads
  `billingProvider`** — no domain logic branches on the payment provider.
- **No payment-processing code exists yet.** Telegram Stars, Apple, Google and
  Web billing are all *future payment adapters* that would write subscription
  rows; the entitlement resolver stays unchanged.
- The honest gap: `price_stars_at_purchase` denominates the price snapshot in
  Stars at the column level, and `ari_core_price_stars` is the config price. A
  future non-Stars adapter needs a denomination-neutral price record. This is
  a naming/denomination residue in the *billing record*, not a dependency-
  direction violation — recorded here so it is fixed when a second billing
  adapter is actually built, not before.

### 4.6 Usage limits are backend-authoritative (ALREADY SATISFIED)

`evaluateGates` (`src/server/services/gates.ts`) is **one function for preview
and enforcement** — the preview cannot diverge from the real decision. Scope ≠
Entitlement is already canonical there. The DEMO lifetime quota is owned by
`demo_quota_reservations` (RESERVED/CONSUMED, atomic under `FOR UPDATE` in
`createResearchJob`); research budgets (`budget_demo`, `budget_core`,
`INTERNAL_ALPHA_V1`) are enforced server-side via budget reservation. The
client displays usage; it is authoritative for nothing. Conceptual admission
flow, as implemented: request → internal user → entitlement → usage/budget →
allow/refuse → run Core.

### 4.7 Structured results (PARTIALLY SATISFIED — by construction, not by gap)

- Domain truth is persisted structured, server-side: `research_jobs`,
  `evidence` (+ locators), `research_component_results`,
  `research_mechanism_assembly`, `research_claim_support`, `research_memory`,
  `proofs` (verdict, confidence 0–100, locked 7-layer `layers` jsonb),
  `proof_gaps`.
- The live structured read path is `GET /api/research-jobs/[id]`: S7 claim
  support, S6 assembly, admitted evidence with source provenance — structured
  fields, session-authed, platform-independent. It deliberately **never**
  returns `research_attempts` or `research_trace_events` (operational
  internals; TRACE ≠ EVIDENCE holds at the API boundary too).
- **Nothing anywhere exists only as Telegram-formatted Markdown** — no such
  format exists in the repository.
- The gap is not platform coupling: the production **Proof writer (S8/S9) is
  not built yet** (only tests insert `proofs`). When it is built, it must
  populate the structured contract that already exists — claim, verdict,
  summary, components, evidence references, metadata — and never a single
  text blob.

### 4.8 Research Trace is projectable (ALREADY SATISFIED at rest)

`research_component_results` persists, per (job, step, component): status,
closed reason codes, supporting/contradicting/excluded evidence ids. S6/S7 are
replay-idempotent projections. The future client-facing Research Trace
(conceptually: order, component, question, state, explanation, evidence refs,
source refs) **must project from these persisted relations — never duplicate
truth**. `research_trace_events` remains operational trace and is never the
user-facing Research Trace.

### 4.9 Persistence (ALREADY SATISFIED)

All domain truth lives in shared backend Postgres. Verified: no schema column
carries a Telegram chat id, message id, or Telegram user id outside
`user_identities`' generic provider fields. Client-side state is UI
convenience only; Telegram/local client state is canonical for nothing —
Proofs, Projects, Evidence, Claims, component results, Memory, future
Promises/Risks/Assessments, usage/subscription state all live server-side.

## 5. Conceptual application operations

Future clients must be able to invoke these through the platform-independent
boundary. Transport is secondary; HTTP route names are **not frozen** here.
Where a current route exists it is noted; absence means future work, not a
route freeze:

| Operation | Today |
|---|---|
| Create Proof | `POST /api/research-jobs` (admission via `evaluateGates`) |
| Get Proof | `GET /api/research-jobs/[id]` (structured result read); Proof-proper read follows S8/S9 |
| Get Research Trace | projects from `research_component_results` etc. — future Phase B exposure |
| Get Project | `GET /api/projects` |
| Get Project Assessment / Promises / Risks | future (D-124) |
| Get User | `GET /api/me` |
| Get Usage / Get Entitlements | inside `GET /api/me` today (`resolveEntitlement` view) |

The requirement is not the route list — it is that **the frontend never calls
Proof internals directly and never reimplements domain logic**.

## 6. Forbidden couplings (with the preferred form)

| Forbidden | Preferred |
|---|---|
| Proof → Telegram user ID | Proof → canonical ATLAS account / project |
| Risk → Telegram message ID | Risk → Project |
| Promise → Telegram UI state | Promise → Project |
| Subscription → Telegram Stars only | Subscription/entitlement → canonical ATLAS account; provider is adapter data |
| Project → Telegram chat | Project is platform-free |

Telegram message/chat IDs may exist only as external presentation or delivery
references — never as domain keys.

## 7. Notification abstraction (future boundary only)

Future events (Risk / Promise / Watch change) flow through a notification
service to one or more delivery adapters — Telegram, iOS push, Android push,
email, in-app. **Nothing of this exists or is authorized now.** The recorded
invariant is only: **a domain event must not equal a Telegram message.**

## 8. Acceptance matrix (honest, repository-grounded, 2026-08-28)

Architectural targets — classifications reflect repository evidence, not
aspiration:

| # | Target | Status |
|---|---|---|
| 1 | Proof initiated without Telegram-specific domain code | **ALREADY SATISFIED** — admission keys on internal session userId |
| 2 | Proof persisted in backend state | **PARTIALLY** — all upstream truth persisted server-side; production Proof writer (S8/S9) not built |
| 3 | Proof retrievable through platform-independent boundary | **PARTIALLY** — structured job-result read live; Proof-proper read follows S8/S9 |
| 4 | Canonical user identity internal to ATLAS | **ALREADY SATISFIED** |
| 5 | Telegram identity external (attached) | **ALREADY SATISFIED** |
| 6 | Payment provider ≠ entitlement | **PARTIALLY** — separation is structural and nothing reads the provider; Stars-denominated price columns remain |
| 7 | Usage limits backend-authoritative | **ALREADY SATISFIED** |
| 8 | Proof output structured | **PARTIALLY** — structured everywhere it exists; final Proof writer pending |
| 9 | Research Trace structured/projectable | **ALREADY SATISFIED** at rest; client exposure is future Phase B |
| 10 | Future Project Assessment structured | **NOT YET IMPLEMENTED** (recorded only, D-124) |
| 11 | Core imports no Telegram SDK | **ALREADY SATISFIED** — no SDK dependency exists at all; the engine's only "telegram" string is `t.me`/`telegram.me` in `SOCIAL_DOMAINS`, which is source-classification data about the external web |
| 12 | New clients need no Proof Engine changes | **PARTIALLY** — structurally satisfied (adapter + web fallback + dev bypass prove a non-Telegram path); unproven until a second real client exists |
| 13 | New billing adapters need no Proof-domain changes | **ALREADY SATISFIED** structurally — adapters write subscription rows; entitlement resolver is provider-blind (with the #6 caveat) |
| 14 | Removing Telegram does not destroy domain state | **ALREADY SATISFIED** — Telegram exists only in `user_identities` rows and the auth/client edge |

## 9. Telegram coupling audit (2026-08-28, report only)

Scan of production code (`src/`, `app/`, `scripts/`, `package.json`) for
telegram / WebApp / initData / Stars / chatId / bot concepts:

**Class A — edge/client/adapter, acceptable:**
`app/api/auth/telegram/route.ts`, `src/server/auth/initdata.ts`,
`src/server/auth/authenticate.ts`, `src/server/auth/dev-bypass.ts`,
`src/server/auth/rate-limit.ts` (`tg:` bucket for verified ids),
`src/client/platform.ts` (the adapter itself), `src/client/api.ts` (calls the
auth route), `app/layout.tsx` (SDK script tag, used only inside the adapter).

**Class B — application layer behind an adapter:** none beyond the auth
chain above, which *is* the adapter.

**Class C — domain / Proof Core dependency: NONE FOUND.** No file under
`src/server/engine`, `src/server/domain`, `src/server/memory`,
`src/server/jobs` or the schema imports or branches on anything
Telegram-specific. The single string match in `src/server/engine/`
(`source-authority.ts:118–119`) is `t.me`/`telegram.me` inside the code-owned
`SOCIAL_DOMAINS` evidence-classification list — data about the web, present in
any research engine, passing the removal test.

**Informational:** `subscriptions.billing_provider` default
`'TELEGRAM_STARS'`, `price_stars_at_purchase`, `ari_core_price_stars` — billing
*data*, read by nothing today; the denomination residue is recorded in §4.5.

**No violations to fix. Nothing was changed in production code by this task.**

## 10. What this document does NOT authorize

No Web/iOS/Android/React Native/Flutter client, no Apple/Google auth or
billing, no notification entities or services, no account or identity
migrations, no new subscription tables, no speculative Proof Core refactor, no
change to current Raydium research behaviour, no change to the Project
Assessment spec. Each of those is its own future owner decision.
