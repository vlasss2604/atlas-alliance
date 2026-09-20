# Current task

> Overwrite this file each round. Never append.

## UI/UX V6 — VISUAL BRAND POLISH FROM THE AP MARK + SNAPSHOT FIX (awaiting Founder visual review)

A visual / brand / interaction pass on the accepted V5 structure. The
result's information hierarchy, question/answer logic, findings and
evidence structure, the surface model and every research semantic are
untouched. $0, no live Research. What changed: `app/globals.css` (V6
tokens and treatments), `atlas-header.tsx` (the mark), `atlas-field.tsx`
(new: the constellation ground), `icons.tsx` (new: the icon family),
`app-chrome.tsx` (icons), `research-result.tsx` / `research-audit.tsx` /
`research-composer.tsx` (icons, action controls, evidence identity, the
snapshot guard), Home's hero mark, three test pins, one new test block.

### The brand, translated (reference: the Founder's AP logo)

- **Mark** — the logo's disc, thin double cyan ring, four cardinal ticks,
  cyan "A", silver "P", drawn in an inline SVG with per-instance gradient
  ids; the halo is a stylesheet decision (`.orb-hero` on Home, `.orb-sm`
  in the header, the raised disc in the bottom bar). The mark is the
  brightest object on every screen.
- **Ground** — one radial cyan light at the top, a vignette, and a faint
  static constellation of 42 nodes and links (one SVG, no filter, no
  animation) that fades out before the first result.
- **Surfaces** — navy glass; ONE cyan-lit hero (executive answer, Home
  composer) with edge-light, top highlight, soft glow and a faint ring
  motif; bordered section surfaces for findings and uncertainty.
- **Cyan has meaning** — active item, verified state, primary action,
  in-place actions. Silver for the wordmark. Indigo for governance.
- **Evidence identity** — every source kind has an icon and one of four
  accent families (docs cyan · governance indigo · chain teal · data
  silver) on the card's left edge and kind badge, on the result and in
  the audit.
- **Controls** — cyan-gradient primary with one glow; outlined secondary
  that lights its edge; small cyan-edged action pills (Evidence · N,
  View excerpt); icon+text links (Open original, Snapshot); chips that
  light on hover; one keyboard focus ring; 140–200 ms transitions;
  reduced-motion honoured.
- **Path and rows** — verified nodes glow in their state colour over a
  gradient connector; rows have a luminous state rail and a cyan-tinted
  hover; evidence expands with a 200 ms fade.

### Snapshot — investigated and fixed

Cause: the surface builds `snapshotHref` from the detail payload's own
job id. On the design fixtures that job exists in no database, so the
result rendered a Snapshot link that landed on a 404 — a dead action.
Real captures were never broken: verified end-to-end on the Lido job
`58952f45…` (API 200, page renders the extracted text). Fix: the result
renders the action only as `card.snapshotHref && jobId` (the route's
job), exactly as the audit already did — a truthful absence on a
fixture, the working link on a real result. Test: three cases in
`tests/ui-source-snapshot.test.ts`.

### Verified ($0)

- `npx tsc --noEmit` clean; `npm run lint` 0 errors.
- Presentation + snapshot + projection-safety + Round 12/13 (incl. DB
  variants): 25 files, **579 passing**. Pins re-pointed:
  `ui-result-briefing`, `ui-verification-tab` (the two section calls now
  carry `jobId`; order invariant unchanged).
- Screenshots at 390×844 and 1120×900 of Home, states 1/2/8, the fixture
  audit, the persisted Aave result, the real Lido result with Snapshot
  actions and the Snapshot page itself: every page renders, no console
  errors beyond the pre-existing hydration note and the first
  unauthenticated call. Fixed before review: the Home hero mark carried
  the small halo; the handset placeholder was clipped.
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

- `/home` — brand hero, composer, recent rows
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
