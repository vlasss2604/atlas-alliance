# ATLAS PROOF — Demo mode (ad link) · specification

**Status:** Founder-approved flow, 2026-10-12. Visual reference: `screenshots/10-demo-*.png`, source in `source/V2-Free*.dc.html` and `source/V2-PulseDemo.dc.html`.
**Read after** `HANDOFF.md`. Everything in HANDOFF §1 (ground rules) applies here too.

Demo mode is **not a separate app**. It is the same Mini App with a `demo` flag switched on for a session that came from an ad link. It shows only things that exist: a published read-only Proof, a replay of the research that produced it, and sample Pulse cards that are already labelled as samples.

---

## 1. Entry

| Step | What happens | Notes |
|---|---|---|
| X Ads → bot | The ad opens the bot with a start parameter, e.g. `t.me/<bot>?start=demo_x1` | The suffix identifies the campaign. |
| Bot reply | One message with a button **"Try ATLAS Demo"** that opens the Mini App with `startapp=demo_x1` | Copy for the bot message: Founder decides (not in the mockups). |
| App start | The client reads `initDataUnsafe.start_param`. If it starts with `demo`, the session is **demo**: `demo = true`, `campaign = <suffix>` | Persist the flag for the session only (memory / sessionStorage). Reopening the app without the parameter = normal free tier. |
| First screen | `10-demo-1-welcome` instead of Home | Dock and header stay; Home/Proofs/Pulse in the dock behave as in the free tier. |

The **price is never shown in demo mode**. The subscription sheet in demo says "comes with a subscription at the public launch" and offers the discount code; it does not name $49.

---

## 2. The path (what the user sees)

1. **Welcome** (`10-demo-1-welcome`): chip "Free · no sign-up", the three steps (pick → watch → read), CTA "Choose a project". Note: "Reading a published Proof never starts a Research."
2. **Pick a project** (`10-demo-2-pick-project`): the five showcase projects with their one question each. Only projects with a **published** Proof are tappable (`Proof published` + date). Others show "In quality review · coming soon" and are not tappable. In the mockup only Raydium is published.
3. **The question** (`10-demo-3-question`): the project, the researched question, the three "what ATLAS checks" lines that come from the Proof's component list, and a **REPLAY** notice: "This replays a research ATLAS completed on {date}. Nothing runs live and no Research is used." Two buttons: **Watch the research** / **Skip to the Proof**.
4. **Replay** (`10-demo-4-replay-*`): the research-progress screen in replay form. Differences from the live screen:
   - banner chip **REPLAY**, kicker "Research completed {date} · not a live run · no Research used";
   - the status pill reads "Replay", not "In progress";
   - **no Stop button**, no "what happens next" panel;
   - the stages advance on a fixed timer (about 900 ms per step, ~10 s total) and end with **Open the Proof** → the published Proof.
   - The stages shown are the stages of the real job (`deriveProgress` of the persisted job). Action lines and sources around the scanner are shown **only if the engine persisted those events** for that job (same gap as HANDOFF D4/D10). Never invent lines for the replay.
5. **Published Proof** (`09-public-proof`): the real read-only Proof (see HANDOFF §4.8). After ~4 s an **in-app notice styled like a push** slides in from the top (`09-public-proof-push`): "PULSE · DEMO · just now — New claim from pump.fun on X — {claim text} — Verify it". Tapping it opens the Pulse demo. It is an in-app overlay; the Mini App cannot receive a real push while open. (Optional: the bot may also send one message — Founder decision D17.)
6. **Pulse demo** (`10-demo-5-pulse`): the Pulse screen with
   - a notice "Pulse demo · sample claims — In the free version Pulse is part of the subscription. These sample cards show what it carries; they are not real posts.";
   - the Raydium card marked **Proof read ✓** (the Proof the user just read);
   - the pump.fun card marked **NEW** (the one from the notice);
   - **Verify with ATLAS** on any card → the **subscription sheet** (`10-demo-6-gate-subscription`): "Verify your own claims with ATLAS — Pulse and your own Research come with a subscription at the public launch." → **Get the launch discount** / Maybe later. No price.
7. **End sheet** (`10-demo-7-end-ask`), shown ~12 s after the Pulse demo opened, unless a sheet is already open: "Like what you saw? Grab a discount for the public launch" · chip "−20% at launch" · **Get my discount** / **No, thanks**.
   - **Get my discount** → `10-demo-8-end-join`: "Your −20% promo code — No payment now. Launch is planned for November; the bot sends the code to this chat and reminds you on launch day." → **Get the code**.
   - → `10-demo-9-end-done`: "Your code is ready" + the code (copy button) + "Sent to you in the bot chat as well. Public launch is planned for November — the bot messages you on launch day, and the code is valid for 30 days after it. Nothing is charged until you subscribe." → **Back to the Proofs**.
   - **No, thanks** → `10-demo-10-end-bye`: "Thanks for looking — The five published Proofs stay free to read whenever you want."

Everything after step 7 is the normal free tier.

---

## 3. Promo code — bot mechanics

The code is created **only when the user taps "Get the code"**. Nothing is pre-generated.

```
POST /api/promo/claim          (from the Mini App, authenticated with initData)
  → if user already has a code: return it
  → else: code = "ATLAS-" + 6 random base32 chars (no 0/O/1/I), unique
          store { code, telegram_user_id, campaign, created_at, used_at: null }
          bot.sendMessage(user, <code + November note>)
  → return { code, created_at }
```

Storage: one table `promo_codes (code PK, user_id unique, campaign, created_at, used_at, launch_notified_at)`.

Launch day:
- the bot sends one message to every code holder ("ATLAS PROOF is live — your −20% code {code} is valid until {date}");
- the subscription sheet (main app) shows the discounted tariff when the user has an unused code and `now < launch_at + 30 days`;
- on successful Stars payment the code is marked `used_at`.
- If launch slips: **one** "still preparing" message, not a stream of reminders (Founder's instruction).

Metrics (one query each): codes issued per campaign; codes used; holders who opened the subscription sheet but did not pay. These three numbers are the result of the ad test.

What the mockup does not decide: the exact code format (mock shows `ATLAS-20`), the bot message texts, the `launch_at` date. See decisions D15–D18 in HANDOFF §7.

---

## 4. What demo mode must never do

- Start a real Research or call the engine. Replay reads a persisted job; nothing runs.
- Show a verdict for a project that has no approved published Proof.
- Show "In progress" / Stop / ETA / percentages in the replay.
- Show the price.
- Send any bot message before the user taps "Get the code".
- Hide that the Pulse cards are samples.

---

## 5. Implementation shape (for the audit)

- `demo` flag: one context value read from `start_param`; a `useDemo()` hook. No duplicated pages: Welcome/Pick/Question are three new routes under `/demo/*`; Replay reuses the progress component with `mode="replay"`; Public Proof is the same read-only Proof route as the free tier with `?demo=1` to enable the notice timer; Pulse demo is the Pulse page with the demo notice + NEW/Proof-read chips + gate/end sheets rendered only when `demo`.
- Timers: replay step 900 ms; notice at 4 s on the Proof; end sheet at 12 s on Pulse. All three are plain `setTimeout`s cleared on unmount. They are the only JS-driven state changes allowed (HANDOFF §4.9 forbids JS animation loops; these are not loops).
- i18n keys: `demo.*`, `pulseDemo.*`, `promo.*` — EN/RU copy is in HANDOFF §5b.
- Analytics: log `demo_open`, `demo_pick`, `demo_replay_start|skip`, `demo_proof_open`, `demo_notice_tap`, `demo_gate_open`, `demo_end_yes|no`, `promo_issued` with the campaign. Plain server-side log rows are enough.
