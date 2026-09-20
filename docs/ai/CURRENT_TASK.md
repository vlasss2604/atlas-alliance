# Current task

> Overwrite this file each round. Never append.

## FINAL UI CLEANUP BEFORE LIVE ACCEPTANCE — HOME + EVIDENCE INTERACTIONS (awaiting Founder review)

Two goals only, on the accepted V5/V6 result: finish Home; make the
Evidence / View excerpt / Open original / Snapshot interactions visibly
work. Result structure, palette, navigation, surface model and every
research semantic: untouched. $0, no live Research.

### Home — exact changes (`app/(app)/home/page.tsx`, composer, recent row)

- Brand area: AP mark (hero halo), `ATLAS PROOF` wordmark larger (1.25 /
  1.45 rem), `CRYPTO VERIFICATION` as a small tracked tagline with a
  hairline either side (`.tagline`). The explanatory paragraph is gone;
  nothing replaces it.
- Composer: same headline and input, tighter spacing (smaller panel
  padding, 50 px send disc, no text size reduced), placed directly under
  the brand.
- Suggested questions: four, in the product's domain — "Does PUMP buyback
  actually reduce supply?", "Where do Raydium trading fees go?", "Does
  HYPE revenue actually reach token holders?", "Are bought-back tokens
  burned or held?" — as cyan-lit chips; a tap fills the input and sending
  goes through the existing interpret → gate → start flow (the fourth
  names no project on purpose: the interpreter asks which).
- Previously researched: real history, project-first rows — a
  deterministic initials avatar (`project-avatar.tsx`: ticker or name
  initials, one hue from the project's stable key; no asset fetching, no
  icon service), project name, the question, "Checked <date>" for a
  finished run (relative age while live), the persisted outcome as a
  pill. Loading is a three-row skeleton; the empty state is one sentence.

### Evidence interactions — investigated, then fixed

Driven in a real browser on the persisted Lido result before any change:
Evidence · N toggled `aria-expanded` and rendered the block; View
excerpt toggled the quotation; Open original opened a new tab with the
lido.fi URL (`_blank`, `noopener noreferrer`); Snapshot linked to this
job's source route. So the mechanics were sound; what was wrong:

- **Evidence · N** — the opened state was too quiet. It now opens a
  tinted, cyan-edged block directly beneath the finding, titled
  "Evidence behind this answer · N sources", one card per admitted source
  with the excerpt already open, 200 ms fade. `FindingRow` takes a
  presentation-only `defaultOpen` so the open state is unit-testable.
- **View excerpt** — unchanged mechanics; the control is the cyan action
  pill, expanded state styled; the persisted excerpt renders as a
  quotation with "Does not prove" beneath.
- **Open original** — rendered only for a real http(s) URL (a chain
  locator has no page). Inside Telegram a `_blank` anchor is not honoured
  by every client, so the platform adapter gained `openExternal(url)`:
  Telegram → `WebApp.openLink`, web → the anchor. The URL is never
  rewritten. (On the design fixtures the URLs are fixture domains — that
  is data, and those pages do not exist.)
- **Snapshot** — verified from the real Lido result: the action opens
  `/research/58952f45…/source/f5266d4b…`, which renders the captured
  extracted text (API 200). No snapshot → no button; fixture → no link.

### Tests

- New `tests/ui-result-interactions.test.ts` (18 cases): Evidence closed /
  open (count, `aria-expanded`, the block inside the row with every
  source), View excerpt closed / open (the exact persisted excerpt, no
  raw record), chain readings have no excerpt control, Open original
  only for http(s) with `_blank` + safe rel, no dead source action across
  four fixtures, the Telegram/web link contract, Home rows (avatar
  initials, "Checked", outcome, live-job stage), the avatar invents
  nothing, Home has no marketing paragraph and has skeleton + empty
  states, the four suggested questions and their flow.
- `tests/ui-source-snapshot.test.ts` keeps the three snapshot cases.
- New `e2e/result-interactions.spec.ts` clicks the whole sequence on the
  fixture page; NOT run here — `playwright.config.ts` pins a Chromium
  binary this machine does not have. The same clicks were driven with
  Playwright's own Chromium in a scratch script (Evidence, excerpt, Open
  original popup, Snapshot href) on the real Lido result.
- Presentation + snapshot + projection-safety + Round 12/13 (incl. DB
  variants): 26 files, **595 passing**; `tsc` clean; lint 0 errors.
- Screenshots at 390 and 1120: Home, the real Lido result with the
  evidence block open, the fixture open on a handset — no horizontal
  overflow, bottom bar unobstructed, no console errors beyond the
  pre-existing Telegram `--tg-viewport-height` hydration note and the
  first unauthenticated call.

### The shell (`app-chrome.tsx`)

Five places: Ask · Research · **Home** · Analytics · Profile. Handset: a
five-column bottom bar, Home as the raised AP disc in the centre, the
brand centred alone in the header. Desktop: lockup left, Ask · Research ·
Home disc · Analytics centre, Profile right. Test ids `dock-*` / `nav-*`
kept; `dock-ask` and `dock-profile` added.

Note for the concept register: `atlas-product-ui` documents the centre
button as the ARI "start a new research" action and a Projects tab; the
Founder's V4 brief specifies Home in the centre and Analytics as the
fourth item. Implemented as briefed; the skill text has not been
rewritten — that is the Founder's call.

### Home (`app/(app)/home/page.tsx`)

Brand hero (mark 64px, wordmark, "Crypto Verification", one line) → the
composer as one `panel-hero` (headline, input, "Try asking" chips) →
Recent research rows with outcome pills. The composer's research-start
flow is byte-for-byte the same code path (interpret → clarify → gate →
startResearch); only its JSX changed.

### Founder review — open these (dev server on :3000, dev auth bypass)

Until WSL localhost forwarding is reset, use the Ubuntu address instead
of localhost (see the recovery report): `http://172.23.202.170:3000/…`.

- `/home` — brand, compact composer, suggested questions, previously researched projects
- `/research` — history
- `/dev/result-states?state=1` (strong), `=2` (mixed), `=4` (technical
  boundary), `=8` (evidence-heavy); `=3, 5, 6, 7` also exist
- `/dev/result-states/audit?state=8` — the Full Audit from the fixture
- `/research/cbe59f48-edbd-4153-b5e6-dc2082c9e105` and its `/audit` —
  the persisted Aave result
- `/research/58952f45-cf21-48b2-8ca9-71c963aae08c` — the real Lido
  result whose evidence cards carry working Snapshot actions; the
  Snapshot page is
  `/research/58952f45-cf21-48b2-8ca9-71c963aae08c/source/f5266d4b-61c9-45d5-9af1-ab953b18c34e`

Left for a copy round, deliberately not done here because every sentence
is a tested derivation in `result-surface.ts`: the answer paragraph still
says "ATLAS established … / It could not establish …"; the row answers
still use "established" for a substantive gap. The visual layer no longer
repeats those words, but the sentences themselves are unchanged.

STOP here until the Founder approves the experience. No live batch before.
