# ATLAS PROOF — Plan, audit and time estimates

**For:** Claude Code, working in `/home/user/src/atlas-proof` from `claude/phase-5-research-memory`.
**Order set by the Founder (2026-10-12):** 1 design (with motion) → 2 engine → 3 five projects → 4 demo mode → 5 screenshots, ad video, launch.
**Rule:** read everything, run the audit (§1), report; write code only after the Founder says go for a phase. One step per commit, tests green, no push without permission, `stash@{0}` untouched, D-179 uncommitted work untouched.

All durations below are **estimates by the designer, not measurements**. They count focused Claude Code working days (a day ≈ 4–6 h of sessions) and assume the Founder reviews each step within a day. Calendar time is longer: add Founder review time and the real research runs in Phase 3. Claude Code's own audit (§1) must replace these numbers with its own before Phase 1 starts.

---

## 0. Summary table

| Phase | What | Estimate (working days) | Depends on |
|---|---|---|---|
| 1 | **App design** — all screens in V7, with motion | **7–10** | nothing (UI only) |
| 1b | Subscription (Stars) + entitlements, no "beta" wording — **postponed until the Founder approves the price** | **2–3** | D14, D15 |
| 2 | **Engine completion** (D-179 Research Quality V1 and whatever the audit finds) | **not estimable from the design side** — the audit gives the number | Founder + engine audit |
| 3 | **Five projects** — run, quality-review, publish; Explore + published route live | **2–3 eng days + 5 real runs + Founder review per Proof** | Phase 2 state, D16, D19 |
| 4 | **Demo mode** (ad link, replay, notice, Pulse demo, end sheet, promo codes, metrics) | **4–6** | Phase 3 (needs ≥1 published Proof) |
| 5 | Screenshots, ad video, launch messages, Stars live, launch | **2–4** (video is Founder/tooling-dependent) | Phase 4 |

**Main app** (Phases 1 + 1b + 3, without engine work): **≈ 11–16 working days**.
**Demo mode** (Phase 4 alone): **≈ 4–6 working days**.
**Launch materials** (Phase 5): **≈ 2–4 working days**.
Engine (Phase 2) is on top and comes from the audit.

---

## 1. Read-only audit — do this first, change nothing

Produce one report (`docs/design/v7/AUDIT_REPORT.md`, plain language) answering:

**A. Repo state**
- Branch, last commit, `git status` (uncommitted D-179 work listed, not touched), `stash list`.
- Does typecheck / lint / test pass right now? Which tests fail and why (before any change).

**B. UI inventory vs the mockups** — for every screen in `HANDOFF.md` §4: the file(s) that render it today, which `data-testid`s exist, which i18n keys exist, what is missing (new key, new component, new data). One table.

**C. Data available for each new block**
- Explore: is there any list of completed jobs by project with verdict + date that can back `published_proofs`? Does a "publish" flag exist?
- Published Proof: can `ResearchResult` render a job for a user who does not own it? What personal data does the result route touch?
- Replay: what does the persisted job carry — stage timestamps? per-stage events? action lines? source events? (This decides how rich the replay can be; HANDOFF D4/D10.)
- Pulse: fixture shape; where a `verifyQuestion` field would go; `verifyPathForPulse`.
- Profile: the real `profile/page.tsx` blocks; where `me.privateBeta.*` is produced.
- Subscription: is any Stars / payment code present (even disabled)? Any entitlement model?
- Bot: where the bot lives (same repo? separate?), how start parameters reach the Mini App today, whether the bot can send a message to a user by id.

**D. Engine (Phase 2 scope)** — list what is unfinished in D-179 / Research Quality V1 and anything the audit finds broken, with an estimate per item. Do not fix.

**E. Risks** — anything that would make a Phase take longer than the table above, in one line each.

**F. Your own estimates** — redo the table in §0 with your numbers and reasons.

Estimated audit time: **0.5–1 day**.

---

## 2. Phase 1 — App design (7–10 days)

Steps as in `HANDOFF.md` §3. Per step: implement → typecheck → lint → tests → screenshot 390×844 next to the reference → short report.

| Step | Estimate | Notes |
|---|---|---|
| 1 Tokens + shell (background, header lockup on every screen, dock) | 0.5–1 | `globals.css`, `app-chrome`, `atlas-header` |
| 2 Verify + Explore strip + from-Pulse state | 1–1.5 | Explore reads a list; until `published_proofs` exists use a dev fixture with Raydium only |
| 3 Research in progress (all 9 states) | 1–1.5 | stages only (D4); grey for failed/cancelled/budget |
| 4 Proof / result (ring, path strip, checks, evidence rows, unclear block) | 1.5–2 | the approved reference; semantic constraints in §4.3 |
| 5 Published mode of the result | 0.5 | banner, date note, own-CTA, hidden audit |
| 6 Source snapshot | 0.5 | |
| 7 Proofs library (+ filter tiles D7) | 0.5–1 | |
| 8 Pulse claim-led cards | 0.5–1 | fixture gets `verifyQuestion` EN/RU |
| 9 Profile (Free / Subscription) + subscription sheet UI | 0.5–1 | sheet without payment wiring |
| 10 Motion + QA pass on a mid-range Android in Telegram | 1 | §4.9 rules, reduced-motion |

**Done when:** `HANDOFF.md` §8.

### Phase 1b — Subscription and the end of "beta" (2–3 days) — postponed
The price is not approved yet. Do not start this phase until the Founder approves the price and says go.
- Rename beta keys/fields (D14), remove the word from UI, keep capacity/paused logic.
- Stars invoice for $49 (D15), webhook → entitlement with expiry (no auto-renew), `me.subscription` in the session payload, gating: free users → subscription sheet from composer, Pulse Verify, published-Proof CTA.
- Discounted tariff for unused promo codes (the code table comes in Phase 4; the sheet just reads `me.promo`).
- Tests for gating. No real payments in dev: Stars test mode or a stub behind a flag.

---

## 3. Phase 2 — Engine completion

Out of the design brief. Inputs: the audit §1.D, D-179 state, the Founder's priorities. Constraints that the UI relies on and must survive:
- `PROOF_PATH_ORDER`, `ResultStatus`, `boundaryOf(...).kind`, `SOURCE_CLASS_CAVEATS`, `excludedEvidence` + `exclusionLabel`, `deriveProgress`.
- Semantic rules: BUYBACK ≠ BURN, BURN ≠ net deflation, REVENUE ≠ value capture, DOCUMENTED ≠ EXECUTING, NOT_ESTABLISHED ≠ CONTRADICTED, incomplete coverage ≠ absence. A found source is not evidence. An unfinished check is not an absent mechanism.
- Optional, only if cheap: persist per-stage timestamps and action/source events on the job. This is what makes the replay (Phase 4) and D4/D10 richer. If it is not cheap, skip it; the replay shows stages only.

Estimate: from the audit.

---

## 4. Phase 3 — Five projects (2–3 eng days + runs + review)

1. **Publishing mechanism** (1 day): `published_proofs` table (slug, question, research_id, verdict, checked_at, published_at, published_by), an admin command (bot or script) that the Founder runs to publish/unpublish a job (D16), a read-only route for a published job, Explore reads the list. No automation.
2. **Runs**: for each of Raydium, Pump.fun, Lido, Jupiter, Jito (Aave reserve) run the showcase question with the real engine (minutes each, repeat if the run fails or stops at budget). The Founder reviews each Proof against the semantic rules and publishes or sends it back. Projects that cannot be verified in scope stay "In quality review" (D19).
3. **Proof review tooling** (0.5–1 day, optional): a dev page listing candidate jobs with their verdict, boundary kinds and excluded counts, to speed the Founder's review.
4. **Verification** (0.5 day): Explore shows exactly the published set; published route renders each; RU copy checked.

Calendar: depends on how many runs need repeating and on the Founder's review time; plan **a week** for the five.

---

## 5. Phase 4 — Demo mode (4–6 days)

Spec: `DEMO_MODE_SPEC.md`.

| Step | Estimate |
|---|---|
| `demo` flag from `start_param`, `useDemo()`, bot "Try ATLAS Demo" button with campaign suffix | 0.5 |
| Welcome / Pick / Question routes | 0.5–1 |
| Replay mode of the progress component (timeline from the persisted job, 900 ms steps, no Stop, Open the Proof) | 1 |
| Demo notice on the published Proof (4 s, in-app overlay) → Pulse demo | 0.5 |
| Pulse demo: notice, NEW / Proof-read chips, gate sheet, end sheets (ask / join / done / bye) with the 12 s timer | 1 |
| Promo code API + table + bot message on claim; discounted tariff hook; launch-day broadcast command; "still preparing" command | 1–1.5 |
| Analytics rows + the three metric queries | 0.5 |
| QA on a real device through the real ad link | 0.5 |

Must-never list: `DEMO_MODE_SPEC.md` §4. Demo mode needs at least one published Proof (Phase 3) to be meaningful; it can be built against the Raydium Proof while the other four are in review.

---

## 6. Phase 5 — Screenshots, ad video, launch (2–4 days)

- **Screenshots**: the real app at 390×844 on a device — the same states as `screenshots/` (Welcome, Pick, Replay mid, Proof, unclear open, Pulse with NEW, end sheet). For the X Ads creative and the bot message.
- **Ad video** (Founder decides tooling): a 15–20 s screen recording of the demo path — Pick → replay (sped up) → Proof → notice → Pulse → "Get my discount". No price, no invented numbers in the video. Captions: "Real research. Real sources. What remains unclear — stated." Estimate 1–2 days with a screen recorder and a simple editor; more if a motion designer is involved.
- **Launch checklist**: Stars live with the real amount; `launch_at` set; promo broadcast tested on one account; published set final; `demo` link in the ad; bot messages (welcome, code, launch day, still preparing) approved by the Founder; a rollback switch to disable demo mode (flag) without a deploy.
- **Public launch**: planned for November (Founder). Code holders get one message on launch day; codes valid 30 days after it.

---

## 7. What is deliberately not in this plan

- No private beta, no waitlist, no early-access forms.
- No influencer outreach.
- No auto-publishing of user Proofs, no auto-linking of Pulse claims to private Proofs.
- No price in demo mode.
- No new engine architecture; no change to Proof semantics.
