# Current task

> Overwrite this file each round. Never append.

## BLIND LIVE ACCEPTANCE BATCH — PREPARED, AWAITING FOUNDER AUTHORIZATION

Preparation only; nothing run. The frozen batch — candidate pool, five
projects plus one optional boundary test, one verbatim question each, the
run order, prerequisites, cost and time estimates from persisted traces,
the failure / reset policy and the pre-flight status — is
`docs/ai/BLIND_BATCH_V1.md`. LIVE CALLS MADE: 0. SPEND: $0.

Before any live call the Founder decides: the batch and its cap
(recommended $5.00 including one restart), the per-project prerequisites
(catalog rows, allowlist lines, known-asset lines, owner-confirmed
identities, route confirmation + classification), and whether GOVERNANCE
routes are confirmed for Uniswap / Jito.

Accepted and frozen beneath it: Research Reliability V1 (offline), Result
UI/UX V5/V6, Evidence / Snapshot interactions, human-language copy — HEAD
`6b4f836` before this preparation.

---

## FINAL COPY ROUND — HUMAN LANGUAGE, EXACT TRUTH (awaiting Founder review)

Copy only, on the frozen UI. Layout, palette, navigation, interactions,
the surface model's derivations, verdict / confidence logic, Evidence
semantics and every research semantic: untouched. $0, no live Research.
Files: `result-surface.ts` (copy constants and the answer sentences),
`research-result.tsx` / `research-audit.tsx` (the state words, "Also
confirmed", the limit sentence, the path node "Where it goes"),
`audit-model.ts` (technical-record outcome words), `research-model.ts`
(the non-verdict answer's sentences), tests.

### Phrases changed, by category

- **Executive answer** — "ATLAS established X, Y and Z." → "The sources
  confirm X, Y and Z."; "It found evidence X, but could not fully confirm
  it — <reason>" → "There is evidence X, but it is not fully confirmed.
  <persisted reason>"; "It could not establish X or Y: the research
  reached its configured limit…" → "The available evidence does not show
  X or Y. The research limit was reached before all relevant sources
  could be checked."; configuration → "… ATLAS currently lacks a source
  route that can independently verify this for <project>."; substantive →
  "The available evidence does not show X or Y." Contradiction unchanged:
  "On X, the evidence points the other way."
- **Findings rows** — fallbacks only (a confirmed row already leads with
  the persisted fact): "The checked evidence establishes X." → "The
  sources confirm X."; "The evidence goes part of the way." → "The
  sources cover part of this."; technical → "The research limit was
  reached before this could be checked."; configuration → "ATLAS
  currently lacks a source route that can independently verify this
  point."; substantive fallback → "The available evidence does not settle
  this." "Also established:" → "Also confirmed:". The row's tooltip now
  carries the state sentence, not the canonical label.
- **State words** — one exported set, `RESULT_STATE_WORDS` (Verified /
  Partly verified / Unresolved / Contradicted), used by the result rows,
  the research path (title and screen-reader text) and the audit's
  research points. The canonical labels (`RESULT_STATUS_LABELS`,
  `COMPONENT_STATUS_LABELS`) stay as the record's vocabulary for the
  technical record and the deep layers, and no longer reach visible text
  on the result or the audit's research points.
- **Uncertainty section** — `BOUNDARY_COPY`: technical "The research
  limit was reached before all relevant sources could be checked.";
  configuration "ATLAS currently lacks a source route that can
  independently verify this point."; substantive "The available evidence
  does not settle this."; the counted form "The research limit was
  reached before N known relevant sources could be checked." The
  never-read-as notes keep their meaning ("not a finding about the
  project" / "not a finding that the mechanism is not executing" / "not
  proof that the thing is absent").
- **Technical record (audit)** — outcome words "Partially confirmed" →
  "Partly confirmed", "Not established" → "Not confirmed", "Not
  established — research limit" → "Not confirmed — research limit
  reached".
- **Non-verdict answer** (failed / cancelled / stopped) — "it established
  nothing about" → "it confirmed nothing about"; "Before it failed it
  established …" → "Before it failed the sources confirmed …"; "partly
  established" → "partly confirmed"; "Not established: X or Y." → "The
  available evidence does not show X or Y."
- **Research path** — node "Destination" → "Where it goes".
- **Forbidden on the surface** — `FORBIDDEN_SURFACE_TOKENS` gained
  "ATLAS established", "could not establish", "Partially established",
  "partially established", "mechanism established", "Current state",
  "Destination".
- Untouched: dates, source names, freshness, evidence sentences (the
  persisted readings), "Does not prove", the legacy briefing / ladder
  layers no current surface renders (their own wording and pins stand).

### Tests

- New `tests/ui-copy-human-language.test.ts` (10 cases): no engine phrase
  and no forbidden token in the visible text of the result or the
  audit's research points on all eight fixtures; the shared state words;
  the non-verdict answer speaks of the evidence; the confirmed sentence
  lists exactly the confirmed checks (never a partial or open one); a
  partly verified check is never a bare "partial" and carries its
  persisted reason; "does not show" never becomes absence or
  contradiction; contradiction stays its own explicit sentence; the three
  boundary sentences are distinct and land on the right fixtures; the
  rows and the unclear section say the same boundary.
- Pins re-pointed to the new wording (invariants unchanged):
  `ui-result-surface-v1` (boundary copy, the answer's boundary
  sentences), `research-audit` (technical-record word),
  `ui-result-language` / `ui-v2-answer-first` / `ui-v1-home-research`
  (the non-verdict sentences). The one guard that a technical or
  configuration boundary never contains "does not" is kept — which is
  why the capability sentence reads "currently lacks", not "does not
  support".
- Presentation + snapshot + projection-safety + Round 12/13 (incl. DB
  variants): 27 files, **605 passing**; `tsc` clean; lint 0 errors.
  Screenshots of states 2, 4 and 5 confirm the sentences on the
  unchanged layout.

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
