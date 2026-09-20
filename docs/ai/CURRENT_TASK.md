# Current task

> Overwrite this file each round. Never append.

## UI/UX V5 — RICH INFORMATION, CLEAR STRUCTURE, PREMIUM HIERARCHY (awaiting Founder visual review)

A presentation round only, correcting V4's over-minimalism without
rolling back its wins. Acquisition, search, recovery, budgets,
Evidence/admissibility, verdict and confidence semantics, the surface
model (`result-surface.ts`), Pattern data: untouched. $0, no live
Research. What changed: `app/globals.css` (depth tokens, stats, research
path, findings grid, evidence cards), `research-result.tsx`, Home and
the composer's JSX, the recent-row outcome pill, one test pin.

### What V5 adds on top of V4

- **Executive answer** — the accent-tinted surface now carries project ·
  "Research result", the question, the outcome badge with its confidence
  word, the answer (first sentence strong), and four figures for the
  work: checks · sources · evidence items · verified. Every figure is
  counted from the persisted rows (distinct sources by canonical
  document key); nothing is estimated.
- **Research path** — a compact strip of one-word nodes in proof-path
  order (Revenue → Flow → Buyback → Approval → Active now → Execution →
  Destination → Recipient → Supply impact), each a glyph in its state
  colour. It makes the logic visible and never repeats a row's text;
  pinned in `ui-result-surface-v1` (one node per check, no row text).
- **Findings as analytical rows** — one bordered section, two columns
  on a desk: question | fact, then a state line that answers "answer ·
  confidence · source" at a glance: `✓ Verified from official docs ·
  Fixture Protocol documentation · 2 Aug 2026`. Status words are
  Verified / Partly verified / Unresolved / Contradicted; the canonical
  label stays on the row as its title. Not a card per finding.
- **Evidence as objects** — 3–5 cards two-up on a desk (odd last card
  spans), stacked on a handset: kind chip, date, source, what it
  establishes, View excerpt / Open original / Snapshot; a contradicting
  card has a red edge.
- **One uncertainty surface** — amber-edged, one block per boundary
  kind with the affected checks listed one per line (and a persisted
  detail where one exists), the "never read as" note once. Still
  boundary-only: a substantive gap is explained on its own row and is
  never repeated here (pinned).
- **Home with character** — brand + one line on what ATLAS checks, the
  composer as one large raised surface with "Try asking" chips, recent
  research rows with outcome pills. No marketing cards.
- **Depth** — blue-tinted ground gradient, an accent-tinted hero surface,
  bordered section surfaces, a quiet indigo secondary accent for
  structure, an active pill on the bottom bar. No neon, no glow.

### Verified ($0)

- `npx tsc --noEmit` clean; `npm run lint` 0 errors.
- Presentation + projection-safety + Round 9/12/13 set: 21 files,
  **549 passing**. Pins re-pointed: `ui-result-surface-v1` (the path is
  one node per check, never a row's text — replaces "no proof map").
- Screenshots at 390×844 and 1120×900 of Home, states 1/2/4/8, the
  fixture audit and the persisted Aave result: every page renders, no
  console errors beyond the pre-existing hydration note and the first
  unauthenticated API call. Fixed before review: the path overflowed the
  desk column (it now fits; a handset scrolls with a fade), and the count
  strip counted only shown rows while the figures counted every check
  (both now count every check).
- NOT run: Playwright e2e (resets the dev user); its dock ids still exist.

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

- `/home` — brand hero, composer, steps, recent rows
- `/research` — history
- `/dev/result-states?state=1` (strong), `=2` (mixed), `=4` (technical
  boundary), `=8` (evidence-heavy); `=3, 5, 6, 7` also exist
- `/dev/result-states/audit?state=8` — the Full Audit from the fixture
- `/research/cbe59f48-edbd-4153-b5e6-dc2082c9e105` and its `/audit` —
  the persisted Aave result

Left for a copy round, deliberately not done here because every sentence
is a tested derivation in `result-surface.ts`: the answer paragraph still
says "ATLAS established … / It could not establish …"; the row answers
still use "established" for a substantive gap. The visual layer no longer
repeats those words, but the sentences themselves are unchanged.

STOP here until the Founder approves the experience. No live batch before.
