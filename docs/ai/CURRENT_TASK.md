# Current task

> Overwrite this file each round. Never append.

## UI V7 — THE APPROVED FIGMA DIRECTION, APPLIED — IMPLEMENTED, NOT COMMITTED

Founder-approved 2026-10-11 (plan and two defaults: the compact header
replaces the large centred Verify brand; the Verify field is multi-line).
LIVE CALLS MADE BY THIS TASK: 0. No migration, no route, no API field, no
dependency, no provider / model / X call. D-172 Phase A is committed as
`77fc923`; this round sits on top of it, uncommitted, awaiting the
Founder's visual review and explicit commit approval.

Done on this tree (presentation only; every value still comes from the
persisted record):

- `globals.css`: V7 surfaces — faint cyan edge and soft glow on every raised
  surface, larger radii, outlined state pills (`--tone`; meanings unchanged),
  rounded-square project tiles, card list rows (`.history-row` grid,
  `.history-list`), finding cards inside the section, answer blocks, a
  growing pill field, the composer emblem, the dock's lit top edge.
- Verify (`/home`): the large centred brand is gone — the compact lockup in
  the app header now shows on every screen; the composer leads with the
  search emblem, the title's last word lit (`AccentTitle`, EN and RU from
  the dictionary's own title), a textarea that grows with its text
  (Enter still submits; `composer-input` unchanged), the solid cyan send
  disc, the examples as a column of chips.
- List rows (Verify, Proofs): one card per row — avatar tile, name with the
  outcome pill beside it, the question on its own full-width line, the
  date. Fixes the 390 px Russian defect where a long pill squeezed the
  question into one word per line; a long pill now wraps inside the card.
- Proofs: "Research Library" / "Библиотека исследований" with the last
  word lit; group cards carry the avatar and the latest outcome as a pill.
- Result: the answer's sentences render under headings — confirmed /
  partly confirmed / still unclear / contradicted — keyed by the branch
  that wrote each sentence (`SurfaceAnswer.parts`, `AnswerKind`, recorded
  by `say(kind, …)` in `surfaceAnswer`; `sentences` unchanged for every
  consumer). Sentence text byte-identical in EN and RU; a non-verdict
  answer carries no heading. Findings are cards with their state rail.
- Dictionaries: `result.answerHeadings` in EN and RU (key parity test).
- Polish pass (Founder, 2026-10-11): the one approved ATLAS PROOF shield
  (`public/brand/atlas-shield.png`, from the design export) is the mark in
  the header lockup and the raised Verify action — `AtlasMark` renders that
  file, no drawn variant; approved project logos from the same export
  (`public/projects/{raydium,hyperliquid,lido,aave,morpho}.png`, listed in
  `src/client/project-assets.json` — data, not code that knows a project)
  replace initials where they exist, initials stay the fallback; the
  reading column reserves dock room (`.app-column`: 8.5rem + safe area on a
  handset) so the last card on every screen scrolls clear of the dock
  (measured at 390×844: last content ≥ 41 px above the shield on Verify,
  Proofs and Result, EN and RU); Result rows read one step larger on a
  phone (size/line-height only). Known limit: the export's assets are
  small rasters (shield 70×65, logos 26–50 px) — a vector or 2× export
  would sharpen the dock shield and the tiles.
- Pinned: `tests/ui-redesign-v7.test.ts` (routes and dock unchanged;
  composer field grows and the flow is the same; row structure; answer
  kinds come only from the writing branch; EN/RU headings; state words
  and the four figures unchanged).

Deliberately not done: any new metric or figure, any change to
`RESULT_STATE_WORDS`, the research path's words or order, the evidence
cards' data, routes, the dock's three places, the Pulse → Verify handoff.

Captures (390×844@2x EN and RU, 1280×900 desktop): before in
`/tmp/atlas-ui-screenshots/figma-before`, after in
`/tmp/atlas-ui-screenshots/figma-after`.

Next steps, each needing Founder approval:
- Founder visual review of the captures and the running app; then commit on
  `claude/phase-5-research-memory`; no push, no deploy;
- a check on a real phone inside Telegram (safe areas, the dock, the
  growing field with the keyboard open).

STOP here until the Founder reviews.
