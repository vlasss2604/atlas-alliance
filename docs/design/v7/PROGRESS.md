# V7 design transfer — progress

State of the V7 UI work (HANDOFF.md, PLAN_AND_ESTIMATES.md Phase 1) for the
next session. Decisions here are the owner's (2026-10-12 … 2026-10-13).

## Where the work lives

- **Worktree:** `/home/user/src/atlas-proof-v7` (WSL). Not the main checkout.
- **Branch:** `claude/v7-design`, created from `2f01c90` of
  `claude/phase-5-research-memory`. Unpushed.
- **Last code commit before this file:** `7df985b`.
- The main checkout `/home/user/src/atlas-proof` belongs to the engine chat
  (D-179). Never switch, reset, stash, clean, merge or pull it.
- `node_modules` in the worktree is a hardlinked copy of the main repo's
  (gitignored). A Turbopack dev server cannot follow a symlink out of the
  project root.

## Done — Phase 1, steps 1–5

| Step | What | Commits |
|---|---|---|
| 0 | Audit (`AUDIT_REPORT.md`), handoff added | `11ca2dd` |
| — | Design handoff update (RU replay screens, price not approved) | `904d23c` |
| 1 | Tokens and app shell: bluer ground, static glows and network, dock fade, 76px header with bare shield and bilingual tagline, 40px profile circle, floating 70px dock with raised 64×68 shield | `26437ff` |
| 1 | Inter (Latin + Cyrillic, 400–800) and Geist Mono served from `app/fonts` via `next/font/local` — no Google Fonts at build | `d22e7da` |
| 2 | Verify: title, 64px input box, example chips, static ring, Previously researched carousel; Explore ATLAS Proofs; From Pulse pill | `3dda823` |
| 3 | Research screen in every state: scanner hero, process rail (stages only), What happens next, Stop (existing cancel flow), dev route `/dev/progress-states` | `36f704b` |
| 3 | Review: budget Open Proof, approved Stop copy, question fades in with the name | `dee52a3` |
| 4 | Proof: ring of N segments, verdict, confidence bar, figures, headed answer; path strip; checks bar; check cards with evidence in place; key evidence kept; What remains unclear as one card per unresolved link | `f6bda70` |
| 4 | Review: unresolved cards equal the legend's unresolved count; PARTIAL never a card | `5381674` |
| 5 | Published read-only Proof: banner, label, date note, Run your own verification (`/home?proof=<slug>`), fail-closed `/proofs/published/[slug]`, dev preview `/dev/published-proof` | `8ed8b22` |
| 5 | Review: a published Proof lights Verify; "not published yet" copy approved | `7df985b` |

Per step: typecheck, lint (0 errors) and every DB-free test green; last run
468/468 in 19 files.

## Owner decisions

- **Tagline:** EN "Crypto Verification · Economics", RU "Криптопроверка ·
  Экономика" (`nav.tagline`, shown uppercase). It fits at 390px.
- **Font:** Inter, from files in the repo (no Google Fonts).
- **Succeeded run:** no "Open Proof" button; the existing auto-switch stays
  (the ring closes once, ~0.7s, then the result).
- **Budget limit:** status screen with "Open Proof" when a Proof exists
  (02-research-7); without a Proof, no button.
- **Failed and cancelled:** status screen (grey) with "Ask another question";
  their result follows below only if a Proof exists.
- **Stop confirmation:** EN "Stop the research? It will end now, before an
  answer." / RU "Остановить исследование? Оно завершится сейчас, до ответа."
- **Explore ATLAS Proofs:** a development fixture only (designer sample,
  Raydium published); a production build serves an empty list and hides the
  section until `published_proofs` exists (Phase 3).
- **Profile "Help" row:** not added.
- **D6:** the ring and the path strip replace the old proof map.
- **D7:** library filter tiles — yes (step 7).
- **What remains unclear:** one card per link whose surface status is
  `NOT_ESTABLISHED` — the count equals the legend's "unresolved"; a PARTIAL
  link is never a card; the chip is `boundaryOf(...).kind` alone.
- **Key-evidence section:** kept, restyled to V7 (not in the mockup).
- **Aave ceiling:** the result-surface ceiling (a persisted
  PARTIALLY_SUPPORTED shown as Unresolved, e.g. a single supply reading) is
  honest engine logic and stays; any question about it goes to the engine
  phase.
- **Published Proof:** lights Verify in the dock; "Run your own
  verification" opens Verify for everyone until Phase 1b; "not published
  yet" copy approved (EN "This Proof isn't published yet" / "It is still in
  quality review. Nothing is shown until an approved Proof exists."; RU
  «Этот Proof ещё не опубликован» / «Он ещё на проверке качества. Пока нет
  утверждённого Proof, здесь ничего не показывается.»).
- **Payment:** postponed; the price is **not approved** ($49 is a working
  figure). No payment flow, no price anywhere. Phase 1b waits for the owner.

## Accepted differences from the mockups

- Text and state colours stay at the accepted V7 code baseline; only the
  ground and surfaces moved to the V7 tokens.
- No per-stage action lines and no sources around the scanner (D4, D10):
  the engine does not emit them.
- A finished run shows no process rail (D5): `deriveProgress` cannot say
  where a stopped run stopped.
- The clarification state has no answer field: a job has no answer route.
- Confidence bar has 4 cells (four confidence bands), not 3.
- The technical "never" line is not repeated: the technical help template
  already says it; configuration cards keep their never line.
- The engine-phrase scan allows one exception: the approved field label
  "Not established" on an unresolved card.
- RU composer placeholder is clipped at the edge (no ellipsis); Pump.fun's
  avatar shows "PUM" (3-letter ticker rule); dates use the browser's
  format ("1 окт. 2026 г.").

## Deferred

- **Step 10 (motion and QA pass):** RU "подтверждено" under the ring is a
  little wider than the disc; the existing `atlas-shimmer` skeleton and
  `atlas-pulse` dot to be checked against HANDOFF §4.9.
- **Tests with the `atlas_test` database:** only with the owner's explicit
  permission, at a time the engine chat is not running tests. Not run yet
  for: `pulse-phase-a-v1` (its dock assertion was updated in step 1),
  `does-not-prove-contract-v1`, `ui-finding-micro-answer`,
  `ui-result-language`, `ui-source-provenance`, `ui-top-result-composition`,
  `creator-beta-ux-v1`, `creator-beta-guardrails-v1`,
  `research-library-read-access-v1`, `research-audit`.
- **D4 / D5 / D10:** engine events for action lines, the stop point of a
  stopped run, and per-source events.
- **Phase 1b** (subscription, Stars, "beta" wording) — postponed, price not
  approved.

## Working rules

- Do not change the Research Engine, workers, API, DB, `result-surface.ts`,
  `deriveProgress`, reconciliation or evidence semantics. UI, CSS, i18n and
  tests only.
- Do not touch `stash@{0}` or the uncommitted / D-179 work in the main
  checkout.
- One step at a time; per step: typecheck, lint, DB-free tests, commit,
  390×844 screenshots next to the `screenshots/` reference, short report.
- No commit beyond the step, no push and no merge without the owner's
  permission. No live HTTP/RPC/provider/model calls.
- The local dev server for screenshots runs offline on port 3200 (no
  provider keys, `MODEL_GATEWAY=fake`, dev auth bypass); screenshots are
  taken with the project's Playwright and the bundled Chromium.

## Next

**Step 6 — Source snapshot** (`app/(app)/research/[id]/source/[evidenceId]/page.tsx`,
references `04-source`, `04-source-technical`). Then 7 Library (with D7
filter tiles), 8 Pulse, 9 Profile + subscription sheet UI (no price), 10
motion and QA.
