# Current task

> Overwrite this file each round. Never append.

## RESULT + APP UX V3 — THE USER READS THE PROJECT, NOT THE ENGINE (awaiting Founder visual review)

Acquisition, search, recovery, budgets, Evidence/admissibility, verdict and
confidence semantics, Pattern data: untouched. $0, no live Research. This
round was recovered from disk after an emergency reboot: every V3 stage
(surface model, result component, app shell, Home, history, typography,
Full Audit) had survived; the only file cut mid-edit was the audit's Limit
block, which referenced two fields the boundary type never had.

### The completed result (`src/client/components/research-result.tsx`)

1. Question + answer — project as a quiet label, the question as the h1,
   two to four typed sentences in project language ("ATLAS established
   what pays for the buyback and who approved it. It found evidence that
   the buyback is happening now, but could not fully confirm it — <the
   persisted reason>. It could not establish where the bought tokens go:
   the research reached its configured limit…"); beneath, one line:
   checked-on date, newest source date, the verdict badge.
2. What ATLAS found — question · answer · source · as-of rows. The label
   is the projection's own words for the rows it named, otherwise a
   question in the reader's words (`questionLabelFor`: "What pays for the
   buyback?", "Who approved it?", "Is the buyback happening now?", "Where
   do the bought tokens go?", "Does total supply actually decrease?"); a
   projection label the semantic-envelope guard refused falls back to the
   question, never to the Pattern's claim label. The answer cell is the
   fact, then — for a partial — exactly what could not be confirmed; a
   not-established row says why (persisted reason) or which limit. The
   status is a dot with a title, never the sentence. Confirmed supporting
   checks fold under the row that leans on them ("Also established: …");
   a contradicted, blocked or uncertain supporting check is promoted to
   its own row. Evidence opens inline (`Evidence · N`).
3. Sources — at most five, one sentence each on what the source tells us,
   excerpt / original / snapshot one tap away.
4. What remains unclear — only TECHNICAL and CONFIGURATION groups, once
   each, with the checks they apply to and what they must never be read
   as. A substantive gap is never repeated here.
→  Open full audit.

Removed from the user surface: proof map, key findings, verification
result, main gaps, proof ladder, research process, the "Full evidence and
audit" disclosure, `?view=` state. The components still exist for the dev
showcases.

### The Full Audit (`research-audit.tsx`, `/research/[id]/audit`)

The same rows in the same words, one level deeper: Question → Answer →
status word → Evidence (every admitted card with what it tells and what it
does not prove) → Limit (technical / configuration only). Beneath, closed:
**Technical record ▸** — summary counts, coverage, evidence map, source
register with exclusion reasons, on-chain observations (raw), open items,
trace. Outcome labels unified with the Result ("Not established",
"Not established — research limit"). No type below 0.82rem.

### App shell (`app-chrome.tsx`, `app/(app)/layout.tsx`)

Header: ATLAS PROOF / Crypto Verification (left) · Research — AP orb (Home)
— Analytics (centre, ≥640px) · Profile (right). Handset: the same three
anchors as a bottom dock with the orb rising from its centre; Profile stays
in the header. `/analytics` is a real page with an honest empty state (no
Compare / Watchlist built). The old floating dock and `atlas-navigation.tsx`
are gone. Home is the composer as hero + Recent research rows; Research
history is rows with hairlines. `section-label` replaces the coloured
eyebrows; nothing that matters below 0.8rem.

### Verified ($0)

- Presentation + projection-safety + Round 9/12/13 output-safety set
  (`tests/ui-*`, `question-projection`, `research-audit`, round9 output
  boundary, round12/13 non-DB): 20 files, 540 passing. `npx tsc --noEmit`
  clean; lint 0 errors. Forty-two stale pins in twelve suites re-pointed at
  the V3 surface without weakening an invariant; one new pin (refused
  projection label → reader's question).
- Screenshots (390×844 and 1120 wide) of Home, Research, Analytics, fixture
  states 1/2/4/8, the fixture audit and the persisted Aave route: every
  page renders, no console errors beyond the pre-existing Telegram
  hydration note and the API calls that need the database.
- NOT verified: the DB-backed projection suites and the persisted Aave
  result. Postgres on localhost:5432 did not come back after the reboot
  (no local binary, Docker not reachable from this WSL distro); the Aave
  route renders "This research could not be loaded." until it is up.

### Founder review — open these (dev server on :3000, dev auth bypass)

- http://localhost:3000/home
- http://localhost:3000/research
- http://localhost:3000/analytics
- http://localhost:3000/dev/result-states?state=1 (strong), =2 (mixed),
  =4 (technical boundary), =8 (evidence-heavy); =3, =5, =6, =7 also exist.
- http://localhost:3000/dev/result-states/audit?state=8 — the Full Audit
  from the fixture (also =1…7).
- http://localhost:3000/research/cbe59f48-edbd-4153-b5e6-dc2082c9e105 and
  its `/audit` — the persisted Aave result, once Postgres is running.

STOP here until the Founder approves the experience. No live batch before.
