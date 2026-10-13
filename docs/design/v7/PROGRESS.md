# V7 design transfer — progress

State of the V7 UI work (HANDOFF.md, PLAN_AND_ESTIMATES.md Phase 1) for the
next session. Decisions here are the owner's (2026-10-12 … 2026-10-13).

## Where the work lives

- **Worktree:** `/home/user/src/atlas-proof-v7` (WSL). Not the main checkout.
- **Branch:** `claude/v7-design`, created from `2f01c90` of
  `claude/phase-5-research-memory`. Unpushed.
- **Last code commit:** `d4743ab` (step 8 review).
- The main checkout `/home/user/src/atlas-proof` belongs to the engine chat
  (D-179). Never switch, reset, stash, clean, merge or pull it.
- `node_modules` in the worktree is a hardlinked copy of the main repo's
  (gitignored). A Turbopack dev server cannot follow a symlink out of the
  project root.

## Done — Phase 1, steps 1–8

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
| 6 | Source snapshot as one hero panel: eyebrow, domain bar with kind chip (wraps under a long RU chip, the domain is never cut), capture date and note, Captured content article, footer Open original · Technical details (native `<details>`, rows below both cells); truncation note grey, not amber | `39e40f5` |
| 6 | Review: the Relevant excerpt leads every snapshot; the whole capture is behind Show full captured text (`toggle-full-capture`); Show exact captured text once a structured document is open | `1cc7853` |
| 7 | Research Library: lit title, keep note with shield; overview panel (real count, latest-verdict bar, All / Supported / Partially / Insufficient tiles, D7) counted by `library-filter.ts` from what each pill shows; one panel of divided rows (48px avatar with outcome dot, pill, runs · questions, last researched); In progress first; bar settles by 0.4s | `49f0a3b` |
| 7 | Review: a row leads with the project's last finished verdict; an unfinished newest run adds a grey "Last run didn't finish"; never finished → grey "No verdict yet"; tiles and bar count the same | `c0910e1` |
| 8 | Pulse, claim-led: title with a static heartbeat, info note, grey dashed sample notice; cards with source, X chip, tinted type, age, Claimed + claim verbatim, boxed verify question (new fixture field `verifyQuestion` EN/RU, the designer's `Q`), Verify with ATLAS; copy from §5a (Fresh, Project claim, Claimed, Verify with ATLAS) | `05faead` |
| 8 | Review: Pulse → Verify prefills the card's verify question in the display language (`pulsePrefill`; the claim text when a card has none); the From Pulse pill shows the claim as context, folded to two lines (Show all / Show less) | `d4743ab` |

Per step: typecheck, lint (0 errors) and every DB-free test green; last run
512/512 in 21 files.

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
- **Source snapshot:** every capture leads with the Relevant excerpt; the
  document (markdown) or text (HTML) follows behind "Show full captured
  text" — the same order for every kind of capture.
- **PROGRESS.md:** updated after every step, in its own small commit.
- **Library row and filter (D7, step 7 review):** a row leads with the
  project's most recent FINISHED verdict. If the newest run failed, was
  cancelled or stopped at the budget limit, the row keeps that verdict and
  adds a grey "Last run didn't finish" / «Последний запуск не удался»; with
  no finished verdict ever, a grey "No verdict yet" / «Пока нет вердикта».
  A verdict persisted on a budget-stopped run is not a finished verdict.
  Tiles and bar count this same headline (`rowHeadline`); a NOT_SUPPORTED
  headline draws a red bar part (no tile). A tile with 0 is disabled.
- **Library rows** keep opening to their questions and runs (D-169).
- **RU filter labels** «Все · Подтверждено · Частично · Недостаточно» —
  approved.
- **Pulse → Verify prefill (step 8 review):** the field gets the card's
  verify question in the display language; the claim text is shown above
  it in the From Pulse pill as context, folded to two lines. A card without
  a verify question prefills its claim text. The 07 mockup (claim in the
  field) was a designer error. Research still starts only by the button.
- **Pulse heartbeat:** static — confirmed.
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
- Library rows open to their questions and runs instead of linking
  straight to the latest result (owner decision).
- Pulse: the `lockedNote` for Free users waits for 1b.
- RU composer placeholder is clipped at the edge (no ellipsis); Pump.fun's
  avatar shows "PUM" (3-letter ticker rule); dates use the browser's
  format ("1 окт. 2026 г.").

## Deferred

- **Step 10 (motion and QA pass):** RU "подтверждено" under the ring is a
  little wider than the disc; the existing `atlas-shimmer` skeleton and
  `atlas-pulse` dot to be checked against HANDOFF §4.9.
- **`pulse-phase-a-v1`** (DB suite): its Home handoff assertions were
  updated to the verify-question prefill in step 8 review; not run yet.
- **Tests with the `atlas_test` database:** only with the owner's explicit
  permission, at a time the engine chat is not running tests. Not run yet
  for: `pulse-phase-a-v1` (its dock assertion was updated in step 1),
  `does-not-prove-contract-v1`, `ui-finding-micro-answer`,
  `ui-result-language`, `ui-source-provenance`, `ui-top-result-composition`,
  `creator-beta-ux-v1`, `creator-beta-guardrails-v1`,
  `research-library-read-access-v1`, `research-audit`.
- **Engine question — source class:** the HTML capture of
  `docs.raydium.io/ray/ray-buybacks` (the Raydium job `fd1252ef…`) carries
  `source_class = SOCIAL`, while the markdown capture of the same docs is
  `OFFICIAL_DOCS`. The class drives the "What this establishes / does not
  establish" caveats, so it matters. The UI shows it as stored; not touched.
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

**Step 9 — Profile + subscription sheet UI** (`app/(app)/profile/page.tsx`,
references `08-profile*`, sheet visual `10-demo-6-gate-subscription`), no
price and no payment (Phase 1b). Then 10 motion and QA.
