# Current task

> Overwrite this file each round. Never append.

## UI/UX V4 — VISUAL REWORK: PALETTE, SHELL, HOME, RESULT (awaiting Founder visual review)

A presentation round only. Acquisition, search, recovery, budgets,
Evidence/admissibility, verdict and confidence semantics, the surface
model (`result-surface.ts`), Pattern data: untouched. $0, no live Research.
What changed is `app/globals.css`, the shell, Home, the composer's JSX, the
result component, and type sizes on history / audit / analytics / the dev
fixture pages.

### Direction chosen — "Graphite Navy"

- **Why this palette.** The V1 language was near-black + neon cyan + glows
  + a violet/cyan field + a grid. Every one of those competes with text.
  V4 keeps the identity (the AP mark, the cyan wordmark, a cyan accent)
  and removes everything that glowed: one graphite-navy ground with a
  single quiet top light, three solid surfaces, white hairlines, a
  four-step text scale, one accent used only for the active item, the
  primary action and the mark. State colours now mean one thing each and
  read intuitively: green confirmed, amber partial, slate unknown, red
  contradicted (partial was violet and unknown was amber — a warning
  colour for "not enough evidence", which is not a warning).
- **Why the hierarchy is better.** Every screen now has one large
  headline, one body size, one muted size, and nothing that matters
  below 0.85rem; uppercase micro-labels became sentence-case headings;
  pills are readable words with a dot, not stamps.
- **Why the result surface solves the pain.** The panel answers in
  order: which project → what was asked (h1) → the state (one badge) →
  the answer with its first sentence in strong type → when. Beneath it a
  count strip ("1 confirmed · 6 partly · 2 unclear") says how much of
  the story is settled before a single row is read; each row is the
  question in strong type, the fact, and one quiet meta line. Status
  words left the visible rows (spine colour + screen-reader text), so
  nothing repeats "confirmed / not established" down the page.

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

Brand hero (mark 64px, wordmark, "Crypto Verification") → the composer
(centred: headline, input pill, three example chips) → three "how it
works" tiles (Ask / ATLAS checks / You get proof) → Recent research rows.
The composer's research-start flow is byte-for-byte the same code path
(interpret → clarify → gate → startResearch); only its JSX changed.

### Verified ($0)

- `npx tsc --noEmit` clean; `npm run lint` 0 errors.
- Presentation + projection-safety + Round 9/12/13 set, including the
  seven DB-backed suites: 27 files, **585 passing**. One pin re-pointed
  (`result-projection-claim-scope`: the empty source state reads "No
  qualifying source" instead of "No admitted source" — same invariant).
- Screenshots at 390×844 and 1120×900 of Home, Research, fixture states
  1/2/4/8, the fixture audit and the persisted Aave result: every page
  renders; the only console notes are the pre-existing hydration warning
  and the first unauthenticated API call.
- Two V4 bugs found by screenshot and fixed before review: the mark's
  SVG gradient ids blanked every mark once the first instance was hidden
  (solid fills now); `.profile-link`'s display rule outranked `hidden`
  on handsets (media rule in `globals.css` now).
- NOT run: Playwright e2e (`e2e/shell.spec.ts` resets the dev user); its
  dock ids still exist.

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
