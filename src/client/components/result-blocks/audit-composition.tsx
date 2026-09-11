"use client";

import type { AuditBoundaryItem, AuditCheck, AuditComposition, AuditContradiction } from "../../audit-composition";
import { CONFIDENCE_LABELS, componentPhrase, verdictLabel } from "../../research-model";
import { ProofMapBlock } from "./proof-map";
import { compactAmount, FACT_KIND_LABEL, SelectedBlocks } from "./selected-blocks";
import { PROOF_STATE, type ProofState } from "./types";

// VERIFICATION V1 — WHAT FROM THIS CLAIM ACTUALLY SURVIVED VERIFICATION.
//
// (The file keeps its historical name; the user-facing mode is VERIFICATION.)
//
// The first screen is meant to be understood in ten seconds: the result,
// what stood up, the main gaps, whether there is a real contradiction, and
// where the evidence stops. Then only the visuals that help explain those
// findings, the evidence tied to them, and one collapsed trail holding every
// check. The main page lists no check twice and lists most checks not at
// all.
//
// Nothing here decides a state. The verdict is the Proof's; the summary is
// the research screen's own lead sentence; every row state is a persisted
// component status; the boundary is chosen by the short answer's own
// priority; the chain and the analytical blocks are the selector's plan.
// Every short form keeps its full sentence in the DOM.

// SHORT FORMS, KEYED ON THE ENGINE'S OWN CODES. A closed map of the same
// vocabulary REASON_CODE_EXPLANATIONS covers, each entry a compression of
// its sentence there and never a stronger claim than it. Each describes the
// RECORD — what was and was not found — and none says the project did or
// did not do anything.
export const SHORT_REASON: Record<string, string> = {
  NO_EVIDENCE_FOUND: "Nothing found in checked sources",
  ALL_EVIDENCE_EXCLUDED: "Discussed · no admissible source",
  MISSING_EXECUTION_EVIDENCE: "Described · not seen running",
  MISSING_CURRENT_STATE: "Current state not stated",
  STALE_CURRENT_STATE: "Only dated sources",
  INSUFFICIENT_AUTHORITY: "Only in sources that cannot settle it",
  MECHANICAL_PROVENANCE_NOT_ESTABLISHED: "Documented · on-chain link missing",
  INDIRECT_ONLY: "Only indirect references",
  STATE_NOT_FULLY_LIVE: "Preparation · not fully live",
  CONFLICTING_STATE: "Sources disagree on state",
  TOKEN_STATE_UNQUALIFIED: "Token state imprecise",
  SUPPLY_REDUCTION_NOT_ESTABLISHED: "No burn seen in checked sources",
  NET_SUPPLY_CHANGE_NOT_ESTABLISHED: "Burn seen · net change unmeasured",
  NET_SUPPLY_CHANGE_NOT_ATTRIBUTED: "Supply fell · cause not attributed",
  NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL: "Supply not lower over interval",
  CONFLICTING_SUPPLY_DELTA: "Supply measurements disagree",
};

function shortReason(codes: readonly string[]): string | null {
  for (const c of codes) if (SHORT_REASON[c]) return SHORT_REASON[c];
  return null;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// WHAT ATLAS FOUND, IN A FEW WORDS. For a check that stood, the subject of
// the check; for one that did not, the short form of its persisted reason;
// for one that could not be checked, that fact. Where none exists, the
// state's own label — never a phrase written here.
function shortFound(c: Pick<AuditCheck, "component" | "state" | "reasonCodes" | "blocked">): string {
  if (c.blocked) return "Sources could not be opened";
  const short = shortReason(c.reasonCodes);
  if (c.state === "ESTABLISHED") {
    const phrase = componentPhrase(c.component);
    return phrase ? capitalise(phrase) : PROOF_STATE.ESTABLISHED.label;
  }
  return short ?? PROOF_STATE[c.state].label;
}

// A BLOCKED CHECK IS CHIPPED "NOT CHECKED", never "not established": the
// sources could not be opened, which is a fact about the run. Same colour
// as not established — amber, never red — different words.
function StateChip({ state, blocked = false }: { state: ProofState; blocked?: boolean }) {
  const s = PROOF_STATE[state];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.05em]"
      style={{ color: s.color, background: s.dim }}
      data-state={state}
      data-blocked={blocked ? "true" : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden />
      {blocked ? "Not checked" : s.label}
    </span>
  );
}

export function AuditCompositionView({
  audit,
  input,
  asOf,
}: {
  audit: AuditComposition;
  input: Parameters<typeof SelectedBlocks>[0]["input"];
  asOf: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:gap-4" data-testid="audit-composition" data-mode="verification">
      {/* 1 — VERIFICATION RESULT. The verdict, the confidence, one sentence,
          the coverage counts. Readable without scrolling on a handset. */}
      <section className="panel panel-raised p-4 sm:p-5 lg:p-6" data-testid="block-audit-verdict">
        <VerificationResult audit={audit} asOf={asOf} />
      </section>

      {/* 2 — WHAT STOOD UP beside MAIN GAPS. Two columns from `lg`; the
          gaps are the main area. A single neutral line closes the gaps
          column when the record holds no contradiction. */}
      <section className="panel p-4 sm:p-5" data-testid="block-findings">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-x-8">
          <StoodUp audit={audit} />
          <div className="flex flex-col gap-3 lg:border-l lg:border-[var(--hairline)] lg:pl-8">
            <MainGaps audit={audit} />
            {audit.contradictions.length === 0 && (
              <p className="text-[0.7rem] text-[var(--atlas-text-dim)]" data-testid="block-contradictions">
                <span data-testid="contradictions-none">No contradiction established.</span>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* 3 — CONTRADICTION, only when the record positively holds one.
          Visually distinct from a gap: a gap is the record saying nothing,
          a contradiction is the record saying otherwise. */}
      {audit.contradictions.length > 0 && <Contradictions audit={audit} />}

      {/* 4 — HOW THE CLAIM HOLDS UP: the selector's chain, when it touches a
          finding on this page. Each stage has its own state; the link into
          a stage is drawn solid only where the evidence carried. */}
      {audit.chain && (
        <div data-testid="block-claim-chain">
          <SelectedBlocks
            plan={{ ...audit.plan, orderedBlocks: [audit.chain] }}
            input={input}
            include={["FLOW"]}
            answer={{ short: "", paragraphs: [] }}
            asOf={asOf}
            flowTitle="How the claim holds up"
            flowIntro="Each stage is a separate claim with its own state. The link into a stage is drawn only as far as the evidence carried — the chain shows where the claim stops being proven."
          />
        </div>
      )}

      {/* 5 — analytical signals that bear on a gap or a contradiction, and
          only those; a measure that explains no exception is not shown. */}
      {audit.analytical.length > 0 && (
        <div className="flex flex-col gap-3 sm:gap-4" data-testid="audit-analytical">
          <Analytical audit={audit} input={input} asOf={asOf} include={["METRIC"]} />
          <Analytical audit={audit} input={input} asOf={asOf} include={["TABLE"]} />
          {has(audit, "CHART") && has(audit, "TIMELINE") ? (
            <div className="grid gap-3 sm:gap-4 lg:grid-cols-12">
              <div className="[&>div>section]:h-full lg:col-span-7">
                <Analytical audit={audit} input={input} asOf={asOf} include={["CHART"]} />
              </div>
              <div className="[&>div>section]:h-full lg:col-span-5">
                <Analytical audit={audit} input={input} asOf={asOf} include={["TIMELINE"]} />
              </div>
            </div>
          ) : (
            <Analytical audit={audit} input={input} asOf={asOf} include={["CHART", "TIMELINE"]} />
          )}
        </div>
      )}

      {/* 6 — WHERE VERIFICATION STOPS: one boundary, the one the short
          answer already calls its main limitation. */}
      {audit.gap && <WhereVerificationStops audit={audit} />}

      {/* 7 — evidence tied to the selected findings */}
      {audit.evidence && (
        <SelectedBlocks
          plan={{ ...audit.plan, orderedBlocks: audit.plan.orderedBlocks.map((b) => (b.type === "EVIDENCE_SNAPSHOT" ? audit.evidence! : b)) }}
          input={input}
          include={["EVIDENCE_SNAPSHOT"]}
          answer={{ short: "", paragraphs: [] }}
          asOf={asOf}
          evidenceTitle="Key evidence"
          evidenceClaims
        />
      )}

      {/* 8 — full verification: every check, the coverage shape, the
          handover — collapsed. The one place the whole list lives. */}
      <FullVerification audit={audit} />
    </div>
  );
}

function has(audit: AuditComposition, type: AuditComposition["analytical"][number]["type"]): boolean {
  return audit.analytical.some((b) => b.type === type);
}

// One or two of the kept analytical blocks, through the same renderer the
// research view uses. The plan is narrowed to the blocks verification kept,
// so the renderer cannot show a block that was set aside.
function Analytical({
  audit,
  input,
  asOf,
  include,
}: {
  audit: AuditComposition;
  input: Parameters<typeof SelectedBlocks>[0]["input"];
  asOf: string;
  include: AuditComposition["analytical"][number]["type"][];
}) {
  if (!include.some((t) => has(audit, t))) return null;
  const kept = new Set(audit.analytical);
  const plan = { ...audit.plan, orderedBlocks: audit.plan.orderedBlocks.filter((b) => kept.has(b)) };
  return <SelectedBlocks plan={plan} input={input} include={include} answer={{ short: "", paragraphs: [] }} asOf={asOf} />;
}

function checkLabel(audit: AuditComposition, component: string): string {
  return audit.checks.find((c) => c.component === component)?.check ?? component;
}

/* ----------------------- 1. VERIFICATION RESULT --------------------- */

function VerificationResult({ audit, asOf }: { audit: AuditComposition; asOf: string }) {
  const tone = audit.verdict ? verdictColor(audit.verdict) : "var(--atlas-text-dim)";
  return (
    <div className="grid gap-4 lg:grid-cols-[21rem_minmax(0,1fr)] lg:gap-x-8" data-testid="audit-masthead">
      <div className="flex min-w-0 flex-col">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow eyebrow-violet">Verification result</p>
          <p className="text-[0.64rem] text-[var(--atlas-text-dim)]">{asOf}</p>
        </div>
        <p
          className="mt-1.5 text-[1.7rem] font-semibold leading-none tracking-tight sm:text-[2rem]"
          style={{ color: tone }}
          data-testid="audit-verdict-label"
        >
          {verdictLabel(audit.verdict)}
        </p>
        <p className="mt-1.5 text-[0.7rem] text-[var(--atlas-text-dim)]">
          {audit.confidenceBand ? `${CONFIDENCE_LABELS[audit.confidenceBand] ?? audit.confidenceBand} confidence` : "No confidence band"}
          <span className="opacity-70"> · {audit.checks.length} checks made</span>
        </p>
      </div>
      <div className="flex min-w-0 flex-col justify-center lg:border-l lg:border-[var(--hairline)] lg:pl-8">
        {audit.summary && (
          <p className="text-[0.92rem] leading-snug" data-testid="audit-summary">
            {audit.summary}
          </p>
        )}
        <Counts audit={audit} />
        <p className="mt-2 line-clamp-2 text-[0.66rem] leading-snug text-[var(--atlas-text-dim)]">{audit.question}</p>
      </div>
    </div>
  );
}

// COVERAGE COUNTS, AS A ROW OF WORDS. One entry per state the record
// actually holds, each with its colour and its count — an index of the
// record's shape. No total, no fraction, no bar: nothing here can be read
// as a score.
function Counts({ audit }: { audit: AuditComposition }) {
  const c = audit.counts;
  const all: { n: number; label: string; state: ProofState }[] = [
    { n: c.established, label: "established", state: "ESTABLISHED" },
    { n: c.partlyEstablished, label: "partly established", state: "PARTLY_ESTABLISHED" },
    { n: c.contradicted, label: "contradicted", state: "CONTRADICTED" },
    { n: c.notEstablished, label: "not established", state: "NOT_ESTABLISHED" },
    { n: c.notChecked, label: "not checked", state: "NOT_ESTABLISHED" },
  ];
  const entries = all.filter((e) => e.n > 0);
  return (
    <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1" data-testid="verification-counts">
      {entries.map((e) => (
        <li key={e.label} className="flex items-center gap-1.5 text-[0.7rem]" data-count={e.label}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: PROOF_STATE[e.state].color }} aria-hidden />
          <span className="font-semibold tabular-nums">{e.n}</span>
          <span className="text-[var(--atlas-text-dim)]">{e.label}</span>
        </li>
      ))}
    </ul>
  );
}

function verdictColor(verdict: string): string {
  switch (verdict) {
    case "SUPPORTED":
      return PROOF_STATE.ESTABLISHED.color;
    case "PARTIALLY_SUPPORTED":
      return PROOF_STATE.PARTLY_ESTABLISHED.color;
    case "NOT_SUPPORTED":
      return PROOF_STATE.CONTRADICTED.color;
    default:
      return PROOF_STATE.NOT_ESTABLISHED.color;
  }
}

/* ------------------------- 2. WHAT STOOD UP ------------------------ */

// COMPACT TILES: the claim, the chip, and the row's own sentence for what
// the evidence established. Never a paragraph.
function StoodUp({ audit }: { audit: AuditComposition }) {
  return (
    <div data-testid="block-stood-up">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>What stood up</p>
      {audit.stoodUp.length === 0 ? (
        <p className="mt-1.5 text-[0.76rem] text-[var(--atlas-text-dim)]" data-testid="stood-up-none">
          Nothing was established or partly established.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {audit.stoodUp.map((c) => {
            const s = PROOF_STATE[c.state];
            return (
              <li
                key={c.component}
                className="flex flex-col rounded-lg border-l-2 px-3 py-2"
                style={{ borderColor: s.color, background: s.dim }}
                data-testid="stood-up-item"
                data-state={c.state}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-[0.8rem] font-semibold leading-tight">{c.check}</p>
                  <StateChip state={c.state} />
                </div>
                <p className="mt-1 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="stood-up-detail">
                  {c.established}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* --------------------------- 3. MAIN GAPS -------------------------- */

const GAP_CHIP: Record<AuditBoundaryItem["kind"], { state: ProofState; blocked: boolean }> = {
  COULD_NOT_CHECK: { state: "NOT_ESTABLISHED", blocked: true },
  NOT_ESTABLISHED: { state: "NOT_ESTABLISHED", blocked: false },
  PARTLY_ESTABLISHED: { state: "PARTLY_ESTABLISHED", blocked: false },
};

// THE CORE OF THE PAGE. Two to four open checks: the label, the chip, the
// short form of the persisted reason, and the row's own sentence beneath.
function MainGaps({ audit }: { audit: AuditComposition }) {
  // Counted over what is OPEN, not over the whole boundary: a check shown
  // under WHAT STOOD UP is never also "one more in full verification".
  const others = audit.open.length - audit.gaps.length;
  return (
    <div data-testid="block-main-gaps">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Main gaps</p>
        <p className="text-[0.64rem] text-[var(--atlas-text-dim)]">
          {audit.gaps.length} shown{others > 0 ? ` · ${others} more in full verification` : ""}
        </p>
      </div>
      {audit.gaps.length === 0 ? (
        <p className="mt-1.5 text-[0.76rem] text-[var(--atlas-text-dim)]" data-testid="gaps-none">
          {/* Nothing open is not the same as everything established: the
              partly-established checks may all be standing in above. */}
          {audit.boundary.length === 0
            ? "Every check the research made was established."
            : "No open check beyond what stood up, part of the way, above."}
        </p>
      ) : (
        <ol className="mt-2 grid gap-2 sm:grid-cols-2">
          {audit.gaps.map((g) => {
            const chip = GAP_CHIP[g.kind];
            const s = PROOF_STATE[chip.state];
            // A blocked check's reason code describes the record it could not
            // reach; the fact that matters is that it could not reach it.
            const short = g.kind === "COULD_NOT_CHECK" ? "Sources could not be opened" : shortReason(g.reasonCodes);
            return (
              <li key={g.component} className="flex flex-col rounded-lg border-l-2 px-3 py-2.5" style={{ borderColor: s.color, background: s.dim }} data-testid="gap-item" data-kind={g.kind}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-[0.8rem] font-semibold leading-tight">{g.label}</p>
                  <StateChip state={chip.state} blocked={chip.blocked} />
                </div>
                {short && <p className="mt-1.5 text-[0.76rem] leading-snug">{short}</p>}
                <p className="mt-1 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="gap-detail">{g.detail}</p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ------------------------ 4. CONTRADICTIONS ------------------------ */

// SEPARATE FROM THE GAPS, ALWAYS, AND ONLY WHEN REAL. Three columns: the
// claim that was checked, what was measured (the selector's own metric,
// where the reconciler tied one to the contradiction), and the conclusion
// in the persisted state's own words. A contradiction is never
// manufactured from missing evidence — this block is absent unless a
// persisted state says CONTRADICTED.
function Contradictions({ audit }: { audit: AuditComposition }) {
  const s = PROOF_STATE.CONTRADICTED;
  return (
    <section className="panel p-4 sm:p-5" data-testid="block-contradictions">
      <p className="eyebrow" style={{ color: s.color }}>Contradiction</p>
      <ul className="mt-2 flex flex-col gap-2">
        {audit.contradictions.map((c) => (
          <ContradictionRow key={c.component} c={c} />
        ))}
      </ul>
    </section>
  );
}

function ContradictionRow({ c }: { c: AuditContradiction }) {
  const s = PROOF_STATE.CONTRADICTED;
  const cols = c.measured.length > 0 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <li className={`grid gap-3 rounded-lg border-l-2 px-3 py-3 ${cols}`} style={{ borderColor: s.color, background: s.dim }} data-testid="contradiction-item">
      <div className="min-w-0">
        <p className="text-[0.58rem] font-semibold uppercase tracking-[0.1em] text-[var(--atlas-text-dim)]">Claim checked</p>
        <p className="mt-1 text-[0.84rem] font-semibold leading-tight">{c.check}</p>
        <p className="mt-1 text-[0.72rem] leading-snug">{shortReason(c.reasonCodes) ?? s.label}</p>
      </div>
      {c.measured.length > 0 && (
        <div className="min-w-0" data-testid="contradiction-measured">
          <p className="text-[0.58rem] font-semibold uppercase tracking-[0.1em] text-[var(--atlas-text-dim)]">Measured</p>
          {c.measured.map((m) => (
            <p key={m.evidenceId} className="mt-1 leading-tight">
              <span className="text-[1.15rem] font-semibold tabular-nums tracking-tight">
                {compactAmount(m.amountRaw, m.decimals, m.factKind === "TOTAL_SUPPLY_DELTA")}
              </span>
              <span className="ml-1 text-[0.7rem] text-[var(--atlas-text-dim)]">tokens</span>
              <span className="block text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">
                {FACT_KIND_LABEL[m.factKind] ?? m.factKind}
                {m.coverage ? ` · ${m.coverage.observed} of ${m.coverage.expected} periods` : ""}
              </span>
            </p>
          ))}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-[0.58rem] font-semibold uppercase tracking-[0.1em] text-[var(--atlas-text-dim)]">Conclusion</p>
        <div className="mt-1">
          <StateChip state="CONTRADICTED" />
        </div>
        <p className="mt-1.5 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]">
          {c.established} <span className="opacity-70">· {c.sources} src</span>
        </p>
      </div>
    </li>
  );
}

/* ------------------- 6. WHERE VERIFICATION STOPS ------------------- */

// ONE BOUNDARY, STATED ONCE. The check the short answer already calls its
// main limitation, with the row's own sentence — a product expression of
// "reality stops where the evidence stops". Every other open check is in
// full verification, and the line beneath says how many.
function WhereVerificationStops({ audit }: { audit: AuditComposition }) {
  const g = audit.gap!;
  const chip = GAP_CHIP[g.kind];
  const s = PROOF_STATE[chip.state];
  // The rest of what is OPEN — `gap` is one of `open`, so this can never
  // count a check that stood up.
  const others = audit.open.length - 1;
  return (
    <section className="panel p-4 sm:p-5" data-testid="block-verification-stops">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Where verification stops</p>
      <div className="mt-2 rounded-lg border-l-2 px-3 py-2.5" style={{ borderColor: s.color, background: s.dim }}>
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-[0.84rem] font-semibold leading-tight">{g.label}</p>
          <StateChip state={chip.state} blocked={chip.blocked} />
        </div>
        <p className="mt-1.5 text-[0.8rem] leading-snug" data-testid="verification-stops-detail">{g.detail}</p>
      </div>
      {others > 0 && (
        <p className="mt-2 text-[0.66rem] text-[var(--atlas-text-dim)]">
          {others} further open {others === 1 ? "check is" : "checks are"} listed in full verification.
        </p>
      )}
    </section>
  );
}

/* ----------------------- 8. FULL VERIFICATION ---------------------- */

// EVERY CHECK, ONCE, COLLAPSED. The coverage shape, then each check with
// what ATLAS found, its state and its sources, then the handover to the
// full research record. The main page above lists none of this twice.
function FullVerification({ audit }: { audit: AuditComposition }) {
  return (
    <details className="panel px-4 py-3.5 sm:px-5 sm:py-4" data-testid="block-audit-trail">
      <summary className="flex cursor-pointer items-baseline justify-between gap-3">
        <span className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>Full verification</span>
        <span className="text-[0.64rem] text-[var(--atlas-text-dim)]">all {audit.checks.length} checks</span>
      </summary>

      <div className="mt-3" data-testid="block-audit-map">
        <ProofMapBlock compact cells={audit.coverage.map((c) => ({ label: checkLabel(audit, c.component), state: c.state }))} />
      </div>

      <div className="mt-3 hidden grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto] gap-x-4 border-b border-[var(--hairline-strong)] pb-1.5 text-[0.58rem] font-semibold uppercase tracking-[0.06em] text-[var(--atlas-text-dim)] lg:grid">
        <span>Check</span>
        <span>What ATLAS found</span>
        <span className="text-right">State</span>
      </div>
      <ul className="mt-1 flex flex-col">
        {audit.checks.map((c) => (
          <li
            key={c.component}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-[var(--hairline)] py-2 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto] lg:items-center lg:gap-x-4"
            data-testid="audit-row"
            data-state={c.state}
            data-blocked={c.blocked ? "true" : undefined}
          >
            <p className="min-w-0 text-[0.78rem] font-medium leading-tight">{c.check}</p>
            <div className="col-start-2 row-start-1 flex justify-end lg:col-start-3">
              <StateChip state={c.state} blocked={c.blocked} />
            </div>
            <p className="col-span-2 min-w-0 text-[0.72rem] leading-snug text-[var(--atlas-text-dim)] lg:col-span-1 lg:col-start-2 lg:row-start-1" data-testid="audit-found" title={c.established}>
              {shortFound(c)}
              <span className="ml-1.5 text-[0.6rem] tabular-nums opacity-70">{c.sources} src</span>
            </p>
          </li>
        ))}
      </ul>
      <ul className="mt-2 flex flex-col gap-1 border-t border-[var(--hairline)] pt-2 text-[0.7rem] leading-snug" data-testid="audit-full">
        {audit.checks.map((c) => (
          <li key={c.component}>
            <span className="font-medium">{c.check}</span>
            <span className="text-[var(--atlas-text-dim)]"> — {c.established}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[0.62rem] leading-snug text-[var(--atlas-text-dim)]">
        The state grades the check and nothing else. A check the sources did not establish is not a check that failed; a
        check that could not be opened is a limit of the run, not a finding about the project.
      </p>
      <p className="mt-3 border-t border-[var(--hairline)] pt-3 text-[0.75rem] text-[var(--atlas-text-dim)]">Full research audit →</p>
    </details>
  );
}
