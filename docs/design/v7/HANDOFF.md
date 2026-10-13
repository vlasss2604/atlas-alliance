# ATLAS PROOF — V7 design handoff (UI only)

**Task:** bring the app's screens to the approved V7 mockups in this folder.
**Approved by:** the owner (Founder), 2026-10-12, as the visual direction for the Telegram Mini App.
**Scope:** presentation only — layout, styling, motion and the new UI strings listed in §5. The free tier, the subscription sheet and the demo mode add a few small server pieces (published Proofs, promo codes); they are listed separately in `PLAN_AND_ESTIMATES.md` and `DEMO_MODE_SPEC.md` and are **not** part of the design steps.
**Repo / branch:** `/home/user/src/atlas-proof`, start from `claude/phase-5-research-memory`. The old Windows folder `atlas-proof-s10` is obsolete; do not use it.

Read `CLAUDE.md` first and follow its working style (one scoped step at a time, plain-language reports, fail closed). This document replaces nothing in `docs/ai/`; it is the design brief for this task.

**Start implementing only when the Founder explicitly says go.** Until then, read and plan only. Where this brief conflicts with the Founder's canonical product context of 2026-10-12 (*ATLAS PROOF — Master context for Claude Design*), the canonical context wins.

---

## 1. Ground rules (non-negotiable)

1. **Do not touch research or proof logic.** No changes to the Research Engine, workers, API, DB, `result-surface.ts` derivations, `deriveProgress`, reconciliation or evidence semantics. If a screen needs data that does not exist, stop and list it (§7). Do not fake it.
2. **Nothing on screen is invented.** Every number and sentence comes from the existing record, `i18n/en.ts` + `ru.ts`, or the existing Pulse fixtures. The mockups contain sample values (§6). They are placeholders, never constants to hardcode.
3. **Keep every `data-testid`** and the behaviour tests rely on. If markup structure must change, update tests to the new structure without weakening assertions.
4. **EN/RU parity.** Every new string gets a key in `en.ts` and `ru.ts`. Russian copy is given in §5 where the mockups have it. Where not, write it and mark it for owner review.
5. **Colour meaning is fixed.**
   - Green, amber, red and slate are only for result statuses and verdicts.
   - Failed, cancelled and budget-limit states are grey: they are not findings about the project.
   - Cyan means active, primary or verified-path only.
6. **Motion is calm, CSS only, and follows §4.9.** This is a serious financial-research product, not a game. Only things that change move; nothing loops for decoration. Everything stops under `prefers-reduced-motion` (already present in `globals.css`). There are no "live" indicators on things that are not live (for example Pulse).
7. **Offline.** No live HTTP/RPC calls. Use the existing dev fixtures (`/dev/result-states`, Pulse phase-A fixtures).
9. **Keep the real journey.** Verify → Ask/Continue (the existing ask page: review, edit, clarify) → **explicit Start Research** → progress → Result/Proof. Only explicit Start Research creates a ResearchJob. Typing, forwarding or opening a Pulse card never starts one. The prototype jumps from the composer arrow straight to progress **only as a shortcut**; keep the Ask step.
10. **Product structure (Founder decision 2026-10-12 — replaces the "private beta" wording of the canonical context §9):**
   - There is **no private beta**. The app launches as **Free + Subscription**.
   - **Free:** the five showcase projects (Raydium, Pump.fun, Lido, Jupiter, Jito; Aave as reserve) with **one published read-only Proof each**, opened from "Explore ATLAS Proofs" on Home. Reading a published Proof never starts a Research. Own Research and Pulse are locked and lead to the subscription sheet.
   - **Subscription:** opens own Research and Pulse, paid via Telegram Stars. **The price is not approved yet** ($49 / month is a working figure only) and **payments are postponed** — do not build the payment flow or show any price until the Founder approves it (Phase 1b, separate go). The price will appear only on the subscription sheet of the main app — never in demo mode, never in the profile card.
   - **Demo mode:** the same app with a `demo` flag, entered only from the ad link. Spec: `DEMO_MODE_SPEC.md`.
   - A verdict is shown **only** where an approved published Proof exists. Projects whose Proof has not passed quality review show "In quality review · coming soon" and no verdict. Jupiter and Jito are listed, but if their question cannot be verified in the current scope they stay in review — never present an unsupported check as done.
   - Existing capacity / paused / limit copy (`home.*`) keeps its logic; only the word "beta" leaves the UI (see D14).
   - Mockup examples with other projects (Jito on the state screens; Aave, Morpho, Hyperliquid in the library) are illustration only.
11. **Git.**
   - Work on a new branch from `claude/phase-5-research-memory` (suggested: `claude/v7-design`).
   - Do not touch `stash@{0}` ("WIP: parity suite items 10/11").
   - Make one commit per step with tests green.
   - Do **not** push or merge without the owner's explicit OK.

---

## 2. What is in this folder

| Path | What it is |
|---|---|
| `screenshots/*.png` | Each state at 390×844 @2x. `*-full.png` shows the whole scroll height. **This is the visual reference.** |
| `screens/*.html` | Static renders of the same states. Open in a browser to inspect exact CSS. Links between screens work. |
| `source/*.dc.html` | The design source of each artboard, with its logic: the `renderVals()` script at the bottom holds the data and states the mockup uses. Styles are inline. |
| `tokens/atlas-v7.css` | Colours, radii, shadows, type scale and every `@keyframes` used. Names are mapped onto the existing `globals.css` variables. |
| `assets/` | AP shield and project logos (same files as `public/brand` and `public/projects`). |
| `motion/*.png` | Frame strips of the entrance timing (time runs left → right): the research screen and the Proof screen settle in about 0.4s. |
| `DEMO_MODE_SPEC.md` | The ad-link demo: entry, path, promo-code mechanics, what demo must never do. |
| `PLAN_AND_ESTIMATES.md` | The order of work (design → engine → five Proofs → demo → launch), the read-only audit to run first, and time estimates — main app and demo mode separately. |
| `source/canvas.json` | Board positions and the designer's notes on the canvas. |

Typography is **Inter**, as in the accepted UI V7. The mockups and screenshots use Inter.

Colour values in `tokens/` are close to, but not always identical with, the accepted UI V7 code baseline (commit `d0dafcc`). Where they differ, keep the baseline values.

---

## 3. Suggested order

Each step: implement → typecheck → lint → focused tests → screenshot at 390×844 next to the matching `screenshots/` file → short report to the owner (what changed, what differs, what's blocked).

This is **Phase 1** of `PLAN_AND_ESTIMATES.md` (design first, as fast and faithfully as possible, with motion). Phases 2–5 (engine, five Proofs, demo mode, launch) follow and are not started here.

1. **Tokens + app shell** (`app/globals.css`, `src/client/components/app-chrome.tsx`, `atlas-header.tsx`)
2. **Verify** (`app/(app)/home/page.tsx`, `research-composer.tsx`, `recent-proof-card.tsx`), including "Explore ATLAS Proofs" (§4.1a) and the "opened from Pulse" state
3. **Research in progress** (`app/(app)/research/[id]/page.tsx`, `research-progress.tsx`)
4. **Proof / result** (`research-result.tsx`, `result-blocks/proof-map.tsx`, `verdict-badge.tsx`). Check against `/dev/result-states`.
5. **Published Proof, read-only** (§4.8) — the same result component in `published` mode
6. **Source snapshot** (`app/(app)/research/[id]/source/[evidenceId]/page.tsx`)
7. **Proofs / Research Library** (`app/(app)/research/page.tsx`, `research-group-card.tsx`)
8. **Pulse** (`app/(app)/pulse/page.tsx`, `pulse-card.tsx`) — claim-led cards (§4.6)
9. **Profile + subscription sheet** (`app/(app)/profile/page.tsx`) — Free / Subscription states (§4.7)
10. **Motion pass** (§4.9): check every screen against the motion rules. Remove anything that loops, bounces or animates layout.

Demo-mode screens (§4.10) are built in Phase 4, after the five Proofs exist; their visual reference is in this folder already.

---

## 4. Screen by screen

### 4.0 App shell — every screen
Reference: any screenshot (header and dock).

- **Background:** `--page-gradient` (bluer navy than V6). Add two large, static, blurred radial glows (cyan top-left, violet bottom-right) and the faint static evidence-network SVG (from any `source/V2-*.dc.html`, the `.ap-net` layer). Add a dark fade above the dock (`linear-gradient(180deg, transparent, #041627)`, 140px).
- **Header (76px):**
  - Left: AP shield 44×47, then a two-line lockup.
  - Line 1: "ATLAS PROOF" 17px/800, with "PROOF" in cyan.
  - Line 2: tagline, 9px/600, tracking .08em, uppercase.
  - Right: profile button, a 40px circle (`#061B30` with a cyan edge and soft glow). It links to `/profile`. On `/profile` it is lit: cyan gradient fill with `--on-cyan` icon.
  - **The owner requires the shield and wordmark on every screen, including Verify.** The current code hides the lockup on Verify on handsets (`brand-lockup-home`); change that.
- **Dock (handset):**
  - Floating bar: 10px from the left, right and bottom edges; height 70px; radius 22px; background `#061B30`; border `rgba(30,197,245,.35)`; glow.
  - Three equal columns: Pulse · Verify · Proofs.
  - Verify has the AP shield, 64×68, raised 46px above the bar.
  - Labels are 11px (Verify 13px). Inactive items are `#C9D5E2`.
  - The active item is white and bold with `--glow-active`.
  - **Lit rules (existing `isActive`):**
    - `/pulse` → Pulse
    - `/home` → Verify
    - `/research` and everything under it (progress, result, source, audit) → Proofs
    - `/profile` → nothing in the dock (the profile icon is lit instead)
  - Keep the unread dot on Proofs (`me.unreadCount`). It is not drawn in the mockups: use a 7px cyan dot with a glow.
- **Wide screens:** the same three items in the header, as today. The mockups are handset-only.

### 4.1 Verify — `01-verify`, `07-verify-from-pulse`
- **H1:** `composer.title`. The last word ("verify?") is cyan with a soft text-shadow. 36px/1.02/800.
- **Subtitle:** `composer.subtitle`, 15px, `--atlas-text-dim`.
- **Composer:**
  - 64px tall, radius 20, gradient `#04182C→#03111F`, 1.5px cyan border.
  - It has a static soft cyan glow. It does not pulse.
  - Search icon, then the textarea (`composer.placeholder`), then a 48px square cyan send button (radius 15) with an arrow.
  - It grows with multi-line text; see `07-verify-from-pulse`.
- **"Try asking":** `composer.tryAsking` (uppercase label), then chips from `dict.ask.examples`. **Keep current behaviour:** a tap prefills the question. (In the mockup it jumps straight to research only as a prototype shortcut.)
- **"Previously researched":** `home.previouslyResearched` + `home.viewAll` → `/research`. It is a horizontal snap carousel of `RecentProofCard`: avatar, project, verdict tick, question, gradient card.
- **Decorative ring:** a static, faint 8-segment ring behind the top-right corner. It does not rotate.
- **Allowance pill** (`home.betaRemaining` → rename, D14): shown only for subscribers with a quota. Free users see no counter; the composer send button opens the subscription sheet (§4.7) instead of the Ask step.

### 4.1a Explore ATLAS Proofs — `01-verify`, `01-verify-ru`
Reference: the horizontal card strip under the composer. Mock values in `source/V2-Home.dc.html` (`P` list).

- Header row: `explore.title` ("Explore ATLAS Proofs") with a small chip `explore.free` ("Free to read"); subtitle `explore.sub`.
- A horizontal snap carousel, one card per showcase project (five), 250px wide, question-led:
  - avatar (`ProjectAvatar`) + name + ticker, a short topic line;
  - the **question** in large text (the one researched question of that project);
  - **if an approved published Proof exists:** the verdict pill (`verdict.*`, tone colour) and "Checked {date}" underneath, button `explore.read` ("Read the Proof") → the published Proof route (§4.8);
  - **otherwise:** a grey chip `explore.inReview` ("In quality review · coming soon"), no verdict, no button. The card is not a link.
- Footer note `explore.note` ("Checked on a date means what the evidence showed then, not that it holds now.").
- Data: a small server list of published Proofs (`published_proofs`: project slug, question, verdict, checked date, research id). The client never derives a verdict itself. Mock: only Raydium is published.
- Order in the strip: published first, then in-review, in the Founder's project order.
- **Opened from Pulse** (`?pulse=<id>`):
  - Above the H1, show a notice pill: cyan text `pulse.fromPulse(handle)`, then ` · `, then `pulse.fromPulseEditable`.
  - The card text sits in the textarea, editable. Everything else is unchanged.

### 4.2 Research in progress — `02-research-1…9`
This is the running state of `/research/[id]`. All states come from `research_job_state` plus `deriveProgress()`.

- **Top:**
  - Back link (`detailPage.back`).
  - Project avatar (`ProjectAvatar`). The mockup shows "JI" for Jito; the real component gives "JTO" with its hue.
  - Status kicker with a dot: `detailPage.researching` / state words.
  - Project name in large text, then the question.
- **Hero "scanner" panel** (the one hero surface):
  - A 176px scanner: a static dotted outer ring, a cyan arc spinner (**the only rotating element**, 2.4s, 4s while queued), and the AP shield in a static disc.
  - Below it: the status pill `detailPage.inProgress` (only while live), the active **stage name** as the 23px title, and `detailPage.leaveNote`.
  - The Stop button uses the `research.cancel` label and the existing cancel flow.
- **State variants** (badge on the scanner, ring style, colour):
  - Running, queued: cyan, spinner. Queued has a slower spin and the title `research.states.QUEUED`.
  - Awaiting clarification (`02-research-6`):
    - Cyan, static arc, "?" badge.
    - Title `ask.clarifyTitle`. The question box uses the clarify question from the record, falling back to `ask.clarifyProjectFallback`.
    - Input `ask.clarifyPlaceholder` and `ask.clarifySubmit`.
  - Succeeded (`02-research-4`): ring draws closed once (`ap-draw`, 0.5s), check badge, title `research.states.SUCCEEDED`. See D3 for the "Open Proof" button.
  - Budget limit (`02-research-7`): **grey**, gauge badge, title `outcome.STOPPED_AT_LIMIT`, sub text `research.states.BUDGET_LIMIT_REACHED`.
  - Failed (`02-research-8`):
    - **Grey**, "!" badge, title from the failed copy.
    - Green-outlined note "Your attempt wasn't spent". The text exists inside `research.states.FAILED`; split it into its own key.
    - CTA `ask.newQuestion`.
  - Cancelled (`02-research-5`): **grey**, stop badge, title `research.states.CANCELLED`, CTA `ask.newQuestion`.
- **"Research process" panel** (`progress.title`):
  - A vertical rail with the stages from `deriveProgress` (`progress.stages.*`).
  - Done: green-tinted check circle with a green connector.
  - Active: cyan circle with a spinning arc, the label in white bold, and a small "now" tag.
  - Pending: grey number, faint label.
  - A boxed list of **action lines** under each stage, with "found, not verified" source chips. **The engine does not emit these yet (D4).** Until it does, render stages only, with no action lines. Do not fabricate lines.
  - Under the rail, while live: an info note (new copy, §5) saying a found source isn't evidence yet.
- **Reopening / refreshing a running job:** show a short loading state, then the job's current state. Never replay stage animations, and never show a stage as done unless the persisted job says so.
- **Real runs take minutes** (one benchmark: ~3.5 min). There is no ETA and no percentage. `detailPage.leaveNote` ("You can leave this screen…") is the key message.
- **"What happens next" panel** (only while running): four rows (ready / clarification / budget / failure), new copy in §5. Icons and colours follow the state rule: cyan for ready and clarify, grey for budget and failure.

### 4.3 Proof / result — `03-proof`, `03-proof-evidence-open`
Everything already exists in `ResearchResult`. This is a re-skin plus two new presentations of existing data (D6).

- **Top:** Back. Project avatar (32px tile) + name + `result.label`. The question as H1 (24px/800).
- **Answer panel** (hero):
  - Left: a **ring of N segments**, one per checked component, in `PROOF_PATH_ORDER`. Colours: green for CONFIRMED, amber for PARTIAL, slate (outlined) for NOT_ESTABLISHED, red for CONTRADICTED.
  - Centre of the ring: "{confirmed}/{total}" and `result.figures.verified`.
  - Right: verdict pill (`verdict.*`, sentence case with a dot, tone colour, static soft glow), confidence bar + `result.confidence(word)`, and a legend from `result.counts`.
  - Below: a 4-cell figures row (`result.figures`: checks, sources, evidence items, verified).
  - Then the answer sentences with their headings (`result.answerHeadings`). Each has a 26px status glyph: ✓, a half-filled disc for partial (CSS, not the ◐ character), ?, or ✕.
- **"What the research followed"** (`result.pathTitle`):
  - A horizontal, scrollable strip of the same N components in `PROOF_PATH_ORDER`.
  - Each node is a 34px mark (filled for confirmed and partial, outlined for unresolved). Below the mark: the path word (`result.pathWords`, or the question noun in EN as today) and the state word (`result.stateWords`).
  - Connectors between filled nodes are tinted; nothing travels along them. The right edge fades out.
  - A header link on the right ("{n} checks") scrolls to the next section.
- **"What ATLAS checked"** (`result.checkedTitle`):
  - An N-segment bar plus the legend.
  - Full cards for confirmed and partial rows, using the existing card content:
    - Question label, then the finding.
    - State chip (`result.stateFrom`), source domain, date.
    - The "Evidence · n" toggle (`result.evidenceCount` / `result.hideEvidence`).
  - Expanded: `result.evidenceBehind` · `result.sourcesCount`, a source-kind chip, and the excerpt with a static highlighter mark. Then two stacked rows — **approved, keep as is:** green "What this establishes" = `sourceClassCaveat(class).can`, grey "What this does not establish" = `sourceClassCaveat(class).cannot`, and the `.from` line beneath. When the card carries `doesNotProve` (the v1 contract line), show it in the grey row instead of the class caveat. Then `result.snapshot` → source route and `result.openOriginal`.
  - Unresolved rows are compact: "?" glyph, question, and "Unresolved · {reason}" (`result.stateWith`).
- **"What remains unclear"** (`result.unclearTitle`) — **approved visual reference, Founder-accepted 2026-10-12. Do not redesign.** Reference: `03-proof-unclear-*.png`, `source/V2-Result.dc.html`. A dashed-border panel with one expandable card per unresolved component (`NOT_ESTABLISHED` rows), in `PROOF_PATH_ORDER`. Collapsed: the row's question and a boundary chip. Expanded (one at a time): a one-line boundary hint → **Not established** (what) → **Why** → **What could help** (cyan box with a note) → a secondary toggle "N sources found, not admitted" listing excluded evidence with its exclusion label. The `unclearNever` line closes the panel.
  - **Boundary chip = `boundaryOf(...).kind`, nothing else:**
    - `SUBSTANTIVE` → "Checked, not established" / «Проверено, не установлено». Never "not found", never "no evidence".
    - `TECHNICAL` → "Not fully checked" / «Проверено не полностью». **Only** when the boundary record or reason codes carry a technical code (`SEARCH_BUDGET_EXHAUSTED`, `KNOWN_PATHS_UNEXPLORED`, …). The **Why** line is the real reason (`result.unclearCopy.TECHNICAL`, `technicalRemaining(n)` when `remainingPaths` exists). Never used as a softer wording for "not established".
    - `CONFIGURATION` (`NO_ADMISSIBLE_ROUTE`) → "No supported verification route" / «Нет пути проверки». This states a **limit of what ATLAS can verify today**, never that the fact cannot be established at all. Copy: `result.unclearCopy.CONFIGURATION` + `unclearNever.CONFIGURATION`. The word "blocked" does not appear in the UI.
  - **What could help** is a direction for further checking, never a promise that a source type establishes the mechanism. Until the Founder approves generated wording, use one template per boundary kind from §5; do not compose source-specific promises.
  - **Excluded sources** list only evidence the engine actually excluded for that component (`excludedEvidence` with its `exclusionLabel`). Sources that were merely insufficient for a conclusion, or never admitted at all, are **not** shown here. Hide the toggle when the list is empty.
  - The mockup's five cards are sample values (§6): rows, chips, reasons and excluded lists all come from the persisted Proof.
- **Button:** `result.openAudit` → audit route.

### 4.4 Source snapshot — `04-source`, `04-source-technical`
All copy is in `snapshot.*`.

- Back link ("Back to result").
- **Hero panel:**
  - Eyebrow `snapshot.eyebrow` with a shield icon.
  - Domain bar: lock icon + domain + source-kind chip.
  - Camera icon, `snapshot.captured(date)` and `snapshot.representation[...]`.
- **Inner "Captured content" article:** headings and text from the capture, then the `snapshot.relevantExcerpt` label and the quote with a static highlighter mark.
- **Footer:**
  - Two cells: `result.openOriginal` (a link only when a genuine URL exists) and `snapshot.technical`.
  - The technical toggle opens the key/value rows (`snapshot.rows`). In the mockup these values are bracketed placeholders; use the real values.

### 4.5 Proofs / Research Library — `05-proofs-library`
- **H1:** `research.title`, with the second word cyan. Then `research.subtitle` and `research.keepNote` (shield icon).
- **Overview hero panel:**
  - Large count of `groups.length` + `research.projectsResearched`.
  - A segmented bar by latest verdict per group.
  - Four filter tiles: All / Supported / Partially / Insufficient, each with a count. **Filter tiles are new UI (D7).**
- **List panel:** one row per `ResearchGroupCard`.
  - 48px avatar with a verdict dot.
  - Name, then the verdict pill.
  - `history.runs` · `history.questions`, then `history.lastResearched(relativeAge)`.
  - A chevron. The row links to the latest result.
- Keep the existing **"In progress"** section (`research.inProgress`) above the list. It is not drawn in the mockup; reuse the list row style with a cyan "in progress" pill.

### 4.6 Pulse — `06-pulse`, `06-pulse-ru`
The structure is already in `pulse/page.tsx`. The cards become **claim-led** (Founder's Pulse decision): a claim is a thing worth verifying, not news. Pulse stays Phase A (offline fixtures), with no auto-linking to other users' private Proofs and no automatic public verdicts.

- **H1** `pulse.title` with a static heartbeat line beside it (not animated: Pulse is not live).
- `pulse.subtitle`, then `pulse.note` with an info icon.
- **Sample notice** (`pulse.sampleTitle` / `pulse.sampleBody`): a dashed grey panel with a grey pill. The app currently uses amber for the title; the mockups use grey, because amber is a result colour.
- **"Last 48 hours"** (`pulse.fresh`) and **"Earlier"** (`pulse.earlier`, list at 80% opacity), exactly as `splitPulseFeed`.
- **Card** (`PulseCard`):
  - 40px `ProjectAvatar`.
  - `source.displayName` (bold), then `source.handle`.
  - Meta row: an "X" chip with the social icon, `pulse.sourceTypes[type]`, ` · `, `relativeAge`. Tint the type: Official `#8EE6FF`, Research & data `#B9C4FF`.
  - A small `pulse.claimed` ("Claimed") label, then the claim text verbatim, 15/22.
  - A boxed **verify question** under the claim (`item.verifyQuestion`, new fixture field, EN/RU — see `Q` in `source/V2-Pulse.dc.html`): the question a Research would answer, e.g. "Does the documented mechanism match actual execution?". This is what the Verify CTA prefills.
  - One cyan pill CTA `pulse.verify` ("Verify with ATLAS") → `verifyPathForPulse(id)` (**every** card). For free users the CTA opens the subscription sheet.
  - `pulse.openOnX` only when `sourceUrl` exists.
- Empty state `pulse.empty`: keep.
- Free tier: Pulse is part of the subscription. The free app shows the same screen with the sample cards and the notice `pulse.lockedNote`; the Verify CTA opens the subscription sheet. (The demo variant is §4.10.)

### 4.7 Profile — `08-profile*`
The profile page file was not in the designer's copy. The mockup is built from `dict.profile.*`; align it with the existing `profile/page.tsx` and keep its logic.

- **Hero:** 60px profile orb with a static dotted ring, then H1 `profile.title`. There is **no user name or photo**: not in the current data (D9).
- **Access level hero panel** (`profile.level`) — two states, no "beta" anywhere:
  - **Free** (`08-profile`): grey chip `profile.freeLabel` ("Free"), text `profile.freeNote` ("Five showcase Proofs are free to read. Your own Research and Pulse open with a subscription."), outlined button `profile.freeCta` ("See subscription") → the subscription sheet. Panel edge grey.
  - **Subscription** (`08-profile-subscription`): cyan chip `profile.proLabel` ("Subscription · active"), then — only if the plan has a quota (D14) — a large number and the rest of `home.betaRemaining(n)` (renamed). In RU the word order differs: "Осталось **3** исследования". Then `profile.proNote` ("Your own Research and Pulse are open."). Panel edge cyan.
- **Subscription sheet** (not drawn as a separate board; use the gate sheet of `10-demo-6-gate-subscription` as the visual): title, one line on what opens (own Research + Pulse), the price `$49 / month` in the **main app only**, the discounted tariff when the user holds an unused promo code (`DEMO_MODE_SPEC.md` §3), a Stars pay button, `profile.priceNote`. In demo mode the same sheet has no price and offers the launch discount instead.
- **Language** (`profile.language`): a segmented EN | RU control with a sliding cyan thumb, wired to the existing display-language setting.
- **List panel:** `profile.privacy` + `profile.privacyNote`, then `profile.help` (row with a chevron, keep the current target).
- **Delete account** (`profile.deleteAccount`):
  - A grey row, never red: it is not a verdict.
  - It opens the existing two-step confirmation (`deleteConfirm1` → `deleteConfirm2`). Keep whatever confirm mechanism the page uses today (Telegram/system confirm). The mockup shows a styled dialog with Cancel/OK only to suggest the look.
  - Then the toast `profile.deleted`.
- `profile.priceNote` (Stars) belongs on the subscription sheet.

### 4.8 Published Proof, read-only — `09-public-proof`, `09-public-proof-push`, `09-public-proof-ru`
The same `ResearchResult` component in **published** mode. It is what free users and demo users read. Nothing in it is new data: it is a real completed job that the Founder approved for publishing.

- **Top:** instead of "Back", the project avatar + name and the label `published.label` ("Published Proof · read-only").
- **Banner** (cyan, shield icon): `published.bannerTitle` ("Published by ATLAS · free to read") + `published.bannerText` ("A real research run, reviewed before publishing. Reading it does not use a Research.").
- Then the full Proof exactly as §4.3 (answer panel, path strip, checks, evidence, "What remains unclear").
- **Date note** under the answer panel: `published.dateNote(date)` ("Checked {date}. The verdict describes the evidence on that date, not the state today.").
- **Bottom CTA:** `published.ownCta` ("Run your own verification") + `published.ownNote` ("Starts a new Research and uses one of your attempts — only after you confirm."). Free users → subscription sheet; subscribers → the Ask step prefilled with the question. Never auto-starts a job.
- Hidden in published mode: the audit button, anything personal (this Proof belongs to ATLAS, not the reader), the "stop" affordances.
- The **in-app notice styled like a push** (`09-public-proof-push`) appears **only in demo mode** (see `DEMO_MODE_SPEC.md` §2.5). In the free tier nothing slides in.
- Route: `/proofs/published/[slug]` (or the result route with a `published` guard — Claude Code decides and reports). Read-only for everyone; no login-specific data.

### 4.10 Demo mode — `10-demo-*`
Built in Phase 4. The visual reference is in this folder; the behaviour is in `DEMO_MODE_SPEC.md`. Screens: Welcome → Pick a project → The question (REPLAY) → Replay → Published Proof with the demo notice → Pulse demo (NEW / Proof read chips, subscription gate) → End sheet (ask → join → done, or bye).

### 4.9 Motion — calm, serious-product rules
Reference: `motion/*.png` (the research and Proof screens settling) and `tokens/atlas-v7.css`, which now holds only the keyframes still allowed.

**Allowed:**
- **Entrances, once per screen:** opacity + `translateY(8px)` → none (`ap-rise`, 0.2–0.32s, ease-out). Stagger at most ~40ms per item; everything on screen settles by ~0.4s.
- **One "working" indicator while a job is QUEUED/RUNNING:** the scanner arc rotating (`ap-spin`, 2.4s; 4s queued), the active stage's small spinner, and a slow status-dot blink (`ap-blink`, 2.4s). They stop when the job ends.
- **State changes:**
  - The succeeded ring closes once (`ap-draw`, 0.5s).
  - Proof ring segments draw once in `PROOF_PATH_ORDER` (`ap-seg`, 0.35s, 45ms step).
  - Bars grow once (`ap-grow`, ≤0.4s).
  - The verdict fades in (`ap-fade-in`, 0.3s).
  - Marks and badges appear without overshoot (`ap-pop`: scale .94 → 1, 0.24s).
- **Feedback:** press scale 0.97; evidence expand, language thumb and dialogs at 0.2–0.3s.
- **Sources around the scanner (only with D10):** state is shown by style, not motion. A dashed slate line means *found* (a found source is not evidence); a dashed cyan line means *being read*; a solid cyan line means *read*. Use a 0.3–0.5s colour transition, with no travelling pulses or flowing dashes.

**Not allowed:**
- Decorative loops: drifting glows, twinkling or moving backgrounds, shimmer or sheen, breathing glows, halos, rotating decorative rings, orbiting dots, sonar pings, flowing dots.
- Screen-to-screen morphs and parallax.
- JS animation loops: count-ups, timers that re-render.
- Animating layout or paint-heavy properties (width/height/top/left, box-shadow, filter, background-position). Animate only `transform` and `opacity`. The one exception is the one-time stroke draws on the two small SVG rings (`ap-draw`, `ap-seg`).
- Overshoot or bounce easing.

**Numbers are never animated.** Figures, counts and "N/total" render at their real values immediately.

---

## 5. New UI copy (needs keys in `en.ts` + `ru.ts`)

Everything not listed here already exists in i18n or comes from the record. Composite strings like "2 verified", "Evidence · 8", "3 hours ago" and "From Pulse · @handle" are built by existing i18n functions.

| Where | EN | RU |
|---|---|---|
| Header tagline (D1, decided in EN) | CRYPTO VERIFICATION · ECONOMICS | needs owner wording (the mockup used ПРОВЕРКА КРИПТОАКТИВОВ) |
| Progress, under the rail | A found source isn't evidence yet. ATLAS reads it first and checks what it actually supports. | Найденный источник — ещё не доказательство. ATLAS сначала читает его и проверяет, что он действительно подтверждает. |
| Progress, panel title | What happens next | Что будет дальше |
| Next · ready | Proof is ready — The result opens right on this screen. | Proof готов — Результат откроется на этом экране. |
| Next · clarification | Needs a clarification — ARI asks one question — the research continues after your answer. | Нужно уточнение — ARI задаст один вопрос — после ответа исследование продолжится. |
| Next · budget | Budget limit — You get an honest result: what it managed to check. | Предел бюджета — Покажу честный результат: то, что успел проверить. |
| Next · failure | Failure — Your attempt isn't spent. An unfinished check doesn't mean the mechanism is missing. | Сбой — Попытка не потрачена. Незавершённая проверка не означает, что механизма нет. |
| Progress · done sub | Your Proof has the verdict, confidence, evidence, sources and honest gaps. | В Proof — вердикт, уверенность, доказательства, источники и честные пробелы. |
| Progress · failed sub | This is a failure of the run, not a finding about the project. | Это сбой проверки, а не вывод о проекте. |
| Progress · cancelled sub | The research stopped before an answer. This is not a finding about the project. | Исследование прервано до ответа. Это не вывод о проекте. |
| Progress · failed chip | Your attempt wasn't spent | Попытка не потрачена |
| Stage tags | now · waiting for you · stopped here · stopped by you | сейчас · ждёт ответа · остановлено здесь · остановлено вами |
| Source chip state (only with D4) | found, not verified | найден, не проверен |
| Progress CTA (only with D3) | Open Proof | Открыть Proof |
| Source node states (only with D10) | found · reading · read | найден · читаю · прочитан |
| Unclear panel subtitle | Open a link to see what is missing and what would help. | Откройте звено, чтобы увидеть, чего не хватает и что помогло бы. |
| Unclear card labels | Not established · Why · What could help | Не установлено · Почему · Что могло бы помочь |
| Boundary chips | Checked, not established · Not fully checked · No supported verification route | Проверено, не установлено · Проверено не полностью · Нет пути проверки |
| Boundary hints | Sources were read; none establishes this. · The run stopped before every relevant source was checked. · ATLAS has no supported route to verify this yet. | Источники прочитаны; ни один этого не устанавливает. · Исследование остановилось раньше, чем были проверены все релевантные источники. · У ATLAS пока нет поддерживаемого пути, чтобы это проверить. |
| What could help · template SUBSTANTIVE | Evidence that carries this specific point for this mechanism; any such source would be read and weighed like the others — no source type guarantees the outcome. | Доказательство, которое несёт именно этот пункт для этого механизма; любой такой источник будет прочитан и взвешен, как остальные — ни один тип источника не гарантирует результат. |
| What could help · template TECHNICAL | A re-run when budget allows: known relevant sources were not read yet. This is a limit of the research run, not a finding about the project. | Повторная проверка, когда появится бюджет: известные релевантные источники ещё не прочитаны. Это ограничение данного исследования, а не вывод о проекте. |
| What could help · template CONFIGURATION | A supported verification route for this point. This is a limit of what ATLAS can verify today, not a finding about the project; the link stays unverified, not disproved. | Поддерживаемый путь проверки этого пункта. Это ограничение того, что ATLAS может проверить сейчас, а не вывод о проекте; звено остаётся непроверенным, не опровергнутым. |
| Excluded toggle | N sources found, not admitted · Hide | N источников найдено, не приняты · Скрыть |
| Evidence rows | What this establishes · What this does not establish | Что это подтверждает · Чего это не подтверждает |
| Unclear closing line | These describe the evidence checked, not proof that the thing is absent. What would help is a direction for further checking, not a guarantee. | Это описание проверенных доказательств, а не доказательство того, что чего-то нет. «Что помогло бы» — направление дальнейшей проверки, а не гарантия. |

### 5a. Free tier copy (Explore, published Proof, Pulse, Profile)

| Key | EN | RU |
|---|---|---|
| explore.title | Explore ATLAS Proofs | Готовые Proof ATLAS |
| explore.free | Free to read | Бесплатно |
| explore.sub | Real research you can open before running your own. Reading a Proof never uses a Research. | Настоящие исследования, которые можно открыть до своего. Чтение Proof не тратит исследование. |
| explore.checked | Checked | Проверено |
| explore.read | Read the Proof | Открыть Proof |
| explore.inReview | In quality review · coming soon | На проверке качества · скоро |
| explore.note | Checked on a date means what the evidence showed then, not that it holds now. | «Проверено» на дату — это то, что показывали доказательства тогда, а не то, что верно сейчас. |
| published.label | Published Proof · read-only | Proof · только чтение |
| published.bannerTitle | Published by ATLAS · free to read | Опубликовано ATLAS · читать бесплатно |
| published.bannerText | A real research run, reviewed before publishing. Reading it does not use a Research. | Настоящее исследование, проверенное перед публикацией. Чтение не тратит исследование. |
| published.dateNote(date) | Checked {date}. The verdict describes the evidence on that date, not the state today. | Проверено {date}. Вердикт описывает доказательства на ту дату, а не состояние сегодня. |
| published.ownCta | Run your own verification | Запустить свою проверку |
| published.ownNote | Starts a new Research and uses one of your attempts — only after you confirm. | Запускает новое исследование и тратит одну попытку — только после вашего подтверждения. |
| pulse.subtitle (new wording) | Fresh crypto claims worth verifying, selected from X. | Свежие крипто-утверждения, которые стоит проверить, — отобраны из X. |
| pulse.note (new wording) | Pulse is for discovery only. Nothing here is verified until you run a Research. | Pulse — только для поиска тем. Ничто здесь не проверено, пока вы не запустите исследование. |
| pulse.claimed | Claimed | Заявлено |
| pulse.verify (new wording) | Verify with ATLAS | Проверить в ATLAS |
| pulse.fresh / pulse.earlier | Fresh / Earlier | Свежие / Ранее |
| pulse.sourceTypes | Project claim · Research & data | Заявление проекта · Исследования и данные |
| pulse.lockedNote | Pulse is part of the subscription. These sample cards show what it carries. | Pulse входит в подписку. Эти примеры показывают, что он содержит. |
| profile.freeLabel | Free | Бесплатно |
| profile.freeNote | Five showcase Proofs are free to read. Your own Research and Pulse open with a subscription. | Пять опубликованных Proof доступны бесплатно. Свои исследования и Pulse открываются по подписке. |
| profile.freeCta | See subscription | Подписка |
| profile.proLabel | Subscription · active | Подписка · активна |
| profile.proNote | Your own Research and Pulse are open. | Свои исследования и Pulse открыты. |
| subscription.title | Verify your own claims with ATLAS | Проверяйте свои утверждения в ATLAS |
| subscription.text | Own Research and Pulse open with a subscription. | Свои исследования и Pulse открываются по подписке. |
| subscription.price | (price not approved — do not ship) | (цена не утверждена) |

Pulse verify questions per fixture item (EN/RU) are in `source/V2-Pulse.dc.html` (`Q`). They are fixture data, not i18n.

### 5b. Demo mode copy

| Key | EN | RU |
|---|---|---|
| demo.welcome.chip | Free · no sign-up | Бесплатно · без регистрации |
| demo.welcome.title | See how ATLAS verifies a crypto claim | Посмотрите, как ATLAS проверяет крипто-утверждение |
| demo.welcome.sub | Five real research runs, published read-only. Pick a project and watch the Proof unfold. | Пять настоящих исследований, опубликованных только для чтения. Выберите проект и посмотрите, как складывается Proof. |
| demo.welcome.steps | Pick a project — Five showcase projects, each with one verified question. · Watch the check — A short replay of the research ATLAS already ran — not a live run. · Read the Proof — Verdict, evidence chain, sources and what remains unclear. | Выберите проект — Пять проектов-витрин, у каждого один проверенный вопрос. · Посмотрите проверку — Короткий повтор исследования, которое ATLAS уже провёл, — не живой запуск. · Прочитайте Proof — Вердикт, цепочка доказательств, источники и что остаётся неясным. |
| demo.welcome.cta | Choose a project | Выбрать проект |
| demo.welcome.note | Reading a published Proof never starts a Research. Your own questions come with a subscription later. | Чтение опубликованного Proof не запускает исследование. Свои вопросы — по подписке позже. |
| demo.pick.title / sub | Pick a project / Each one has a question ATLAS already researched. | Выберите проект / У каждого есть вопрос, который ATLAS уже исследовал. |
| demo.pick.ready / review | Proof published / In quality review · coming soon | Proof опубликован / На проверке качества · скоро |
| demo.ask.label | The question ATLAS researched | Вопрос, который исследовал ATLAS |
| demo.ask.chip | REPLAY | ПОВТОР |
| demo.ask.text(date) | This replays a research ATLAS completed on {date}. Nothing runs live and no Research is used. | Это повтор исследования, которое ATLAS завершил {date}. Ничего не запускается вживую, исследование не тратится. |
| demo.ask.cta / skip | Watch the research / Skip to the Proof | Посмотреть проверку / Сразу к Proof |
| demo.replay.kicker(date) | Research completed {date} · not a live run · no Research used | Исследование завершено {date} · не живой запуск · исследование не тратится |
| demo.replay.pill | Replay | Повтор |
| demo.replay.sub | Replaying the stages ATLAS went through for this question. | Повтор этапов, которые ATLAS прошёл для этого вопроса. |
| demo.replay.cta | Open the Proof | Открыть Proof |
| demo.notice.tag / age | PULSE · DEMO / just now | PULSE · ДЕМО / только что |
| demo.notice.title | New claim from pump.fun on X | Новое заявление pump.fun в X |
| demo.notice.cta | Verify it | Проверить |
| pulseDemo.title / body | Pulse demo · sample claims / In the free version Pulse is part of the subscription. These sample cards show what it carries; they are not real posts. | Pulse-демо · примеры заявлений / В бесплатной версии Pulse входит в подписку. Эти примеры показывают, что он содержит; это не настоящие посты. |
| pulseDemo.proofRead / new | Proof read / NEW | Proof прочитан / НОВОЕ |
| pulseDemo.gate.chip / title | Subscription / Verify your own claims with ATLAS | Подписка / Проверяйте свои утверждения в ATLAS |
| pulseDemo.gate.text | Pulse and your own Research come with a subscription at the public launch. | Pulse и свои исследования будут по подписке на публичном запуске. |
| pulseDemo.gate.cta / later | Get the launch discount / Maybe later | Получить скидку к запуску / Позже |
| pulseDemo.gate.note | Getting a code means the bot may message you about the launch. You can leave at any time. No payment is taken now. | Получив код, вы разрешаете боту написать о запуске. Отписаться можно в любой момент. Платить сейчас не нужно. |
| promo.end.kicker / title | Before you go / Like what you saw? Grab a discount for the public launch | Перед уходом / Понравилось? Заберите скидку на подписку к запуску |
| promo.end.offer | −20% at launch | −20% при запуске |
| promo.end.text | Pulse and your own Research come with a subscription at the public launch. Get a personal promo code now and use it on launch day. | Pulse и свои исследования будут по подписке на публичном запуске. Получите личный промокод сейчас и используйте в день запуска. |
| promo.end.yes / no | Get my discount / No, thanks | Получить скидку / Нет, спасибо |
| promo.join.chip / title | Launch discount / Your −20% promo code | Скидка на старте / Ваш промокод на −20% |
| promo.join.text | No payment now. Launch is planned for November; the bot sends the code to this chat and reminds you on launch day. | Платить сейчас не нужно. Запуск планируется в ноябре; бот отправит код в этот чат и напомнит в день запуска. |
| promo.join.cta | Get the code | Получить код |
| promo.done.title / label | Your code is ready / Promo code | Ваш код готов / Промокод |
| promo.done.text | Sent to you in the bot chat as well. Public launch is planned for November — the bot messages you on launch day, and the code is valid for 30 days after it. Nothing is charged until you subscribe. | Код также отправлен в чат с ботом. Публичный запуск планируется в ноябре — бот напишет в день запуска, код действует 30 дней после него. Ничего не списывается, пока вы не оформите подписку. |
| promo.done.copy / cta | Copy / Back to the Proofs | Скопировать / К Proof |
| promo.bye.title / text | Thanks for looking / The five published Proofs stay free to read whenever you want. | Спасибо, что посмотрели / Пять опубликованных Proof остаются бесплатными в любое время. |

RU wording is the designer's; mark it for Founder review in the first report.

---

## 6. Sample values in the mockups — do NOT hardcode

- The Raydium result: 8 checks, 2 sources, 27 evidence items, 2 verified, its sentences, dates, excerpt and domain. These come from the record.
- Library rows: "15 runs · 11 questions", "6 days ago", "4 projects", verdict counts.
- Home "Previously researched" cards.
- Progress action lines (Raydium/Jito wording), and the Jito example on the state screens.
- Profile "3 Research remaining" (subscription state only). This comes from the server count (`me.privateBeta.remaining` today — rename with D14).
- Explore cards: only Raydium is published with "Partially supported · Checked 1 Oct 2026"; the other four are in review. The real list comes from `published_proofs`.
- Demo: the replay timeline, the pump.fun claim in the notice, the promo code `ATLAS-20`, the November launch note. Replay = the persisted job; the code = generated per user; the launch month = a config value.
- Source technical rows in brackets (`[n bytes]`, `[sha256…]`, `[final URL]`).
- Pulse cards: these are the existing phase-A fixtures, already labelled as sample data in the app.

---

## 7. Open decisions — ask the owner, do not decide silently

- **D1 · Tagline — decided.** The product identity is "ATLAS PROOF / CRYPTO VERIFICATION / ECONOMICS", so the header line is "CRYPTO VERIFICATION · ECONOMICS". Only the RU wording still needs owner approval.
- **D2 · Font — decided:** Inter (accepted UI V7). Do not switch fonts.
- **D3 · "Open Proof" button.** The mockup shows it on the succeeded state. Today the page switches to the result by itself. Keep the auto-switch unless the owner wants the button.
- **D4 · Action lines on the progress screen.** These need new engine events (what is being searched, read or compared). This is **out of scope** for a UI task: ship stages only, and list it as a follow-up.
- **D5 · Where a failed or cancelled run stopped.** `deriveProgress` marks every stage done for any terminal job. The mockups show the stop point ("stopped here", "stopped by you"). This needs a logic change, so it is out of scope: ask.
- **D6 · Proof ring and horizontal path strip.** These are new presentations of existing statuses (the proof map already reads in `PROOF_PATH_ORDER`). The visual is approved; confirm they replace the current proof-map block rather than being added next to it.
- **D7 · Library filter tiles and verdict bar.** Derived client-side from each group's latest verdict, so there are no new data. The filter itself is new interaction; confirm.
- **D8 · Profile layout.** Align with the real `profile/page.tsx` (not seen by the designer). Report any block that exists in code but not in the mockup, or the reverse.
- **D9 · User identity in profile.** There is no name or photo in the mockup because none is in the profile data. Adding the Telegram name is a product decision.
- **D13 · "What could help" wording.** The approved mockup uses per-link sample sentences. The app ships the per-kind templates from §5 unless the Founder approves richer wording; never generate a promise that a given source type will establish the mechanism.
- **D11 · Coverage wording.** Research Quality V1 (D-179) introduces coverage concepts: checked and not established, incomplete coverage, blocked, not applicable. These are not approved end-user terms yet. Keep the existing `result.unclearHeadings` copy until the Founder approves new wording.
- **D12 · Pulse lifecycle.** The direction is to highlight fresh claims for 24h and keep up to 7 days; the code today has a 48h window plus "Earlier". Follow the code, and do not fake timestamps.
- **D10 · Source nodes around the scanner.** These need per-source live events (found, read, being compared) from the engine; this is the same gap as D4. Out of scope for the UI task: build the visual behind a flag, or skip it until the events exist.
- **D14 · "Beta" leaves the UI.** `home.betaLabel`, `home.betaRemaining`, `profile.noAccess`, `me.privateBeta.*` and the "paused beta" copy: rename to free/subscription terms. Whether a subscription carries a Research quota (and the counter is shown) is a Founder decision; the mockup shows "3 Research remaining" as an example only.
- **D15 · Subscription sheet and price — postponed.** The price is not approved ($49 / month is a working figure). Build nothing for payments until the Founder approves the price. Then: Telegram Stars (no auto-renew; Stars → monthly entitlement with an expiry). The discounted tariff for promo-code holders. Confirm the Stars amount and the entitlement rule before building payments.
- **D16 · Published Proofs.** Which completed jobs become the five published Proofs is the Founder's quality-review decision, one by one. The publish action is a flag on a job plus an entry in `published_proofs`; it is set by the Founder (admin command), never automatically.
- **D17 · Demo notice vs real bot message.** The "push" on the published Proof is an in-app overlay. Whether the bot also sends a real message at that moment is a Founder decision; the mockup does not require it.
- **D18 · Promo code details.** Code format, bot message texts, `launch_at`, and the "still preparing" message if launch slips. The mockup shows `ATLAS-20` and "November" as examples.
- **D19 · Jupiter / Jito scope.** If their showcase question cannot be verified with the current source routes, they stay "In quality review" at launch; do not substitute a weaker question to force a verdict.

---

## 8. Done when

- [ ] Every screen at 390×844 matches its `screenshots/` reference in layout, colour, type scale and motion (allowing for real data).
- [ ] The dock lit rules and the header lockup follow §4.0 on every route.
- [ ] No new hardcoded numbers or sentences. New strings exist in both `en.ts` and `ru.ts`.
- [ ] Every `data-testid` is preserved. Typecheck, lint and the test suite are green.
- [ ] `prefers-reduced-motion` disables all animation.
- [ ] Motion follows §4.9: nothing loops except the research "working" indicator; every screen settles within ~0.4s.
- [ ] Scrolling and entrances stay smooth on a mid-range Android in Telegram, with no jank.
- [ ] Engine, API and result-surface files are unchanged in Phase 1 (`git diff --stat` shows only UI, CSS, i18n and tests). The small server pieces (published Proofs, subscription, promo codes) are separate phases with their own commits.
- [ ] The word "beta" does not appear in the UI. Free users never see a price outside the subscription sheet; demo users never see a price.
- [ ] A verdict appears only for a published Proof; in-review projects show no verdict.
- [ ] Report to the owner per step, with before and after screenshots and the open-decision list updated.
