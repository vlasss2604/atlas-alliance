import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ComponentStatusCard } from "../src/client/components/component-status-card";
import { DeveloperDetails } from "../src/client/components/developer-details";
import { EvidenceCard } from "../src/client/components/evidence-card";
import { GapCard } from "../src/client/components/gap-card";
import { RealityCheck } from "../src/client/components/reality-check";
import { RecentProofCard } from "../src/client/components/recent-proof-card";
import { ResearchProgress } from "../src/client/components/research-progress";
import { VerdictBadge } from "../src/client/components/verdict-badge";
import {
  deriveProgress,
  deriveRealityCheck,
  plainAnswer,
  verdictTone,
} from "../src/client/research-model";

// UI V1 — the screens are a PROJECTION of persisted research truth.
//
// These tests exist to pin the properties that make that claim true: the live
// stage comes from the engine's own phase, a missing result never becomes a
// negative finding, excluded material never appears as support, and no screen
// carries a conclusion about a named project.
//
// Rendering is done with react-dom/server, which the app already depends on —
// no DOM environment and no test-only UI framework was added for this.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

/* ------------------------------------------------------------------ */
/* 1. HOME RENDERS EXISTING COMPLETED PROOFS                           */
/* ------------------------------------------------------------------ */

const completedJob = {
  id: "11111111-1111-1111-1111-111111111111",
  state: "SUCCEEDED",
  progressStage: 5,
  memoryStatus: "NOT_USED",
  acquisitionPhase: "EXTRACTING" as const,
  acquisitionPhaseAt: "2026-08-31T17:30:00.000Z",
  terminationReason: "WORK_QUEUE_EXHAUSTED",
  originalQuestion: "Where do the trading fees go?",
  unread: false,
  createdAt: "2026-08-31T17:00:00.000Z",
  finishedAt: "2026-08-31T17:31:00.000Z",
  projectName: "Fixture Project",
  projectSlug: "fixture",
  projectTicker: "FIX",
  verdict: "PARTIALLY_SUPPORTED",
};

describe("UI V1 — Home", () => {
  it("TEST 1: renders a real completed Proof record, with its persisted verdict", () => {
    const html = render(createElement(RecentProofCard, { job: completedJob }));
    expect(html).toContain("Fixture Project");
    expect(html).toContain("Where do the trading fees go?");
    expect(html).toContain('data-verdict="PARTIALLY_SUPPORTED"');
    // The row links to the Research screen for that job — one screen serves
    // both the running job and the finished Proof.
    expect(html).toContain(`href="/research/${completedJob.id}"`);
  });

  it("TEST 1b: a job with no Proof is never given a verdict", () => {
    const html = render(
      createElement(RecentProofCard, {
        job: { ...completedJob, verdict: null },
      }),
    );
    expect(html).toContain("No proof");
    expect(html).not.toContain("data-verdict=\"SUPPORTED\"");
    expect(html).not.toContain("data-verdict=\"NOT_SUPPORTED\"");
  });

  it("TEST 2: starting research uses the EXISTING interpret → gate → start flow", () => {
    const src = readFileSync("src/client/components/research-composer.tsx", "utf-8");
    // The same three server calls /ask has always made, in the same order,
    // with the same gate as the authority on whether a Proof may begin.
    expect(src).toContain("api.interpret(");
    expect(src).toContain("api.clarify(");
    expect(src).toContain("api.startResearch(");
    expect(src).toContain("canStartProof");
    expect(src).toContain("proofBlockReason");
    // One idempotency key per click: a double press cannot create two jobs.
    expect(src).toContain("crypto.randomUUID()");
    // No new research endpoint was invented for the UI.
    expect(src).not.toMatch(/fetch\(\s*["'`]\/api\//);
  });
});

/* ------------------------------------------------------------------ */
/* 3-5. LIVE PROGRESS COMES FROM THE ENGINE'S OWN PHASE                */
/* ------------------------------------------------------------------ */

describe("UI V1 — live research state", () => {
  // The exact failure this replaces: progressStage stops at the memory step,
  // so a UI reading only the counter said "checking previous research" while
  // the engine was already fetching or extracting.
  const stalePhaseCounter = 2;

  it("TEST 3: a FETCHING job shows the read-evidence stage, not memory", () => {
    const view = deriveProgress({
      state: "RUNNING",
      progressStage: stalePhaseCounter,
      acquisitionPhase: "FETCHING",
    });
    expect(view.source).toBe("ACQUISITION_PHASE");
    expect(view.stages[view.activeIndex].key).toBe("FETCH");
    expect(view.stages[view.activeIndex].label).toBe("Reading evidence");
    expect(view.stages[1].state).toBe("DONE"); // memory step is behind us
    expect(view.stages[1].state).not.toBe("ACTIVE");

    const html = render(
      createElement(ResearchProgress, {
        job: { state: "RUNNING", progressStage: stalePhaseCounter, acquisitionPhase: "FETCHING" },
      }),
    );
    expect(html).toContain('data-stage="FETCH" data-state="ACTIVE"');
    expect(html).toContain('data-stage="MEMORY" data-state="DONE"');
  });

  it("TEST 4: an EXTRACTING job shows the verification stage", () => {
    const view = deriveProgress({
      state: "RUNNING",
      progressStage: stalePhaseCounter,
      acquisitionPhase: "EXTRACTING",
    });
    expect(view.source).toBe("ACQUISITION_PHASE");
    expect(view.stages[view.activeIndex].key).toBe("EXTRACT");
    expect(view.stages[view.activeIndex].label).toBe("Verifying the mechanism");

    const html = render(
      createElement(ResearchProgress, {
        job: { state: "RUNNING", progressStage: stalePhaseCounter, acquisitionPhase: "EXTRACTING" },
      }),
    );
    expect(html).toContain('data-stage="EXTRACT" data-state="ACTIVE"');
  });

  it("TEST 4b: the stage counter is used ONLY before acquisition begins", () => {
    const early = deriveProgress({
      state: "RUNNING",
      progressStage: 2,
      acquisitionPhase: null,
    });
    expect(early.source).toBe("PROGRESS_STAGE");
    expect(early.stages[early.activeIndex].key).toBe("MEMORY");

    const searching = deriveProgress({
      state: "RUNNING",
      progressStage: 2,
      acquisitionPhase: "SEARCHING",
    });
    expect(searching.stages[searching.activeIndex].key).toBe("SEARCH");
  });

  it("TEST 5: a completed job renders the completed state, not a live one", () => {
    const view = deriveProgress({
      state: "SUCCEEDED",
      progressStage: 2,
      // A finished job may still carry its last phase. It is history, and it
      // must not make a finished research look like a running one.
      acquisitionPhase: "EXTRACTING",
    });
    expect(view.source).toBe("TERMINAL");
    expect(view.running).toBe(false);
    expect(view.stages.every((s) => s.state === "DONE")).toBe(true);

    const html = render(
      createElement(ResearchProgress, {
        job: { state: "SUCCEEDED", progressStage: 2, acquisitionPhase: "EXTRACTING" },
      }),
    );
    expect(html).not.toContain('data-state="ACTIVE"');
  });
});

/* ------------------------------------------------------------------ */
/* 6. VERDICT MAPPING                                                  */
/* ------------------------------------------------------------------ */

describe("UI V1 — verdicts", () => {
  it("TEST 6: verdict badges map to their tone, and only NOT_SUPPORTED is red", () => {
    expect(verdictTone("SUPPORTED")).toBe("supported");
    expect(verdictTone("PARTIALLY_SUPPORTED")).toBe("partial");
    expect(verdictTone("INSUFFICIENT_EVIDENCE")).toBe("insufficient");
    expect(verdictTone("NOT_SUPPORTED")).toBe("negative");
    expect(verdictTone(null)).toBe("neutral");

    expect(render(createElement(VerdictBadge, { verdict: "SUPPORTED" }))).toContain(
      "tone-supported",
    );
    expect(
      render(createElement(VerdictBadge, { verdict: "PARTIALLY_SUPPORTED" })),
    ).toContain("tone-partial");
    const insufficient = render(
      createElement(VerdictBadge, { verdict: "INSUFFICIENT_EVIDENCE" }),
    );
    expect(insufficient).toContain("tone-insufficient");
    // Missing evidence is amber, never the red reserved for a positively
    // established negative.
    expect(insufficient).not.toContain("tone-negative");
    expect(render(createElement(VerdictBadge, { verdict: "NOT_SUPPORTED" }))).toContain(
      "tone-negative",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 7. MISSING EVIDENCE IS NEVER NEGATIVE PROOF                         */
/* ------------------------------------------------------------------ */

describe("UI V1 — absence of evidence is not evidence of absence", () => {
  it("TEST 7: an unverified or unassessed rung is never shown as disproven", () => {
    const view = deriveRealityCheck([
      { component: "MECHANISM_SPEC", status: "SUPPORTED" },
      { component: "GOVERNANCE_BASIS", status: "INSUFFICIENT_EVIDENCE" },
      // CURRENT_STATE has no row at all.
    ]);
    const byKey = Object.fromEntries(view.rungs.map((r) => [r.key, r.state]));
    expect(byKey.DOCUMENTED).toBe("VERIFIED");
    expect(byKey.APPROVED).toBe("UNRESOLVED");
    expect(byKey.ACTIVATED).toBe("NOT_ASSESSED");
    // Only a positively CONTRADICTED component may ever say "not happening".
    expect(view.rungs.some((r) => r.state === "NOT_HAPPENING")).toBe(false);

    const contradicted = deriveRealityCheck([
      { component: "NET_EFFECT", status: "CONTRADICTED" },
    ]);
    expect(contradicted.rungs.find((r) => r.key === "NET_EFFECT")?.state).toBe(
      "NOT_HAPPENING",
    );
  });

  it('TEST 7b: "Reality stops here" is drawn only where it is derivable', () => {
    // Nothing verified — the marker would imply a rung was tested and failed.
    const nothing = deriveRealityCheck([
      { component: "MECHANISM_SPEC", status: "INSUFFICIENT_EVIDENCE" },
    ]);
    expect(nothing.stopsAtIndex).toBeNull();
    expect(render(createElement(RealityCheck, { components: [] }))).not.toContain(
      "Reality stops here",
    );

    // An established chain that ends — the marker sits at the first rung that
    // is not verified.
    const chain = deriveRealityCheck([
      { component: "MECHANISM_SPEC", status: "SUPPORTED" },
      { component: "GOVERNANCE_BASIS", status: "SUPPORTED" },
      { component: "CURRENT_STATE", status: "INSUFFICIENT_EVIDENCE" },
    ]);
    expect(chain.stopsAtIndex).toBe(2);
    const html = render(
      createElement(RealityCheck, {
        components: [
          { component: "MECHANISM_SPEC", status: "SUPPORTED" },
          { component: "GOVERNANCE_BASIS", status: "SUPPORTED" },
          { component: "CURRENT_STATE", status: "INSUFFICIENT_EVIDENCE" },
        ],
      }),
    );
    expect(html).toContain("Reality stops here");
  });

  it("TEST 7c: gaps read as research findings, never as errors or monitoring", () => {
    const html = render(createElement(GapCard, { component: "NET_EFFECT" }));
    expect(html).toContain("could not verify");
    expect(html.toLowerCase()).not.toContain("error");
    expect(html.toLowerCase()).not.toContain("failed");
    // The product does not watch anything; the UI must not say it does.
    expect(html.toLowerCase()).not.toContain("monitor");

    // The same discipline in the written answer.
    const sentences = plainAnswer({
      verdict: "INSUFFICIENT_EVIDENCE",
      confidenceBand: "LOW",
      projectName: "Fixture Project",
      components: [{ component: "NET_EFFECT", status: "INSUFFICIENT_EVIDENCE" }],
      terminationReason: null,
    });
    const text = sentences.join(" ").toLowerCase();
    expect(text).toContain("could not");
    expect(text).not.toContain("does not happen");
    expect(text).not.toContain("no buyback");
  });
});

/* ------------------------------------------------------------------ */
/* 8. EXCLUDED / SOCIAL MATERIAL IS NEVER SUPPORT                      */
/* ------------------------------------------------------------------ */

const socialEvidence = {
  id: "ev-social",
  component: "MECHANISM_SPEC",
  summary: "A blog post describes a buyback.",
  fragment: "raw fragment",
  doesNotProve: null,
  sourceClass: "SOCIAL",
  officiality: "CLAIMED",
  retrievedUrl: "https://example.test/post",
  sourceTitle: "Example Post",
  exclusionReason: "CLASS_NOT_ADMISSIBLE",
};

describe("UI V1 — evidence rendering", () => {
  it("TEST 8: an excluded source is labelled excluded and never as support", () => {
    const html = render(
      createElement(EvidenceCard, { evidence: socialEvidence, role: "EXCLUDED" }),
    );
    expect(html).toContain('data-role="EXCLUDED"');
    expect(html).toContain('data-source-class="SOCIAL"');
    expect(html).toContain("Excluded");
    expect(html).not.toContain(">Supporting<");
    expect(html).not.toContain(">Used<");
  });

  it("TEST 8b: the screen assigns roles from persisted links, never from text", () => {
    const src = readFileSync("app/(app)/research/[id]/page.tsx", "utf-8");
    // Support comes from S8's citations and S5's supporting set only.
    expect(src).toContain("proof?.citations");
    expect(src).toContain("detail.finding.supporting");
    expect(src).toContain("detail.finding.excluded");
    // An excluded link wins over any other role for the same row.
    expect(src).toContain('e.links.find((l) => l.role === "EXCLUDED")');
    // Excluded rows are rendered in their own section, under their own
    // heading — never merged into the supporting grid.
    expect(src).toContain("Considered but excluded");
  });

  it("TEST 8c: a component with no admissible evidence says so plainly", () => {
    const html = render(
      createElement(ComponentStatusCard, {
        component: "NET_EFFECT",
        status: "INSUFFICIENT_EVIDENCE",
        evidenceCount: 0,
      }),
    );
    expect(html).toContain("Could not verify");
    expect(html).toContain("No admissible evidence");
  });
});

/* ------------------------------------------------------------------ */
/* 9. DEVELOPER DETAILS                                                */
/* ------------------------------------------------------------------ */

const detailFixture = {
  job: {
    id: "22222222-2222-2222-2222-222222222222",
    state: "SUCCEEDED",
    progressStage: 5,
    memoryStatus: "NOT_USED",
    acquisitionPhase: "EXTRACTING" as const,
    acquisitionPhaseAt: null,
    projectName: "Fixture Project",
    projectSlug: "fixture",
    projectTicker: "FIX",
    originalQuestion: "q",
    terminationReason: "WORK_QUEUE_EXHAUSTED",
    errorCode: null,
    origin: "PRODUCT",
    createdAt: "2026-08-31T17:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-08-31T17:31:00.000Z",
  },
  proof: null,
  claimSupport: null,
  mechanism: null,
  execution: {
    attemptedSteps: 8,
    attemptedComponents: 10,
    succeededComponents: 2,
    establishedComponents: 0,
  },
  finding: { componentKeys: [], supporting: [], contradicting: [], excluded: [] },
  components: [
    {
      patternStep: 3,
      component: "MECHANISM_SPEC",
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["ALL_EVIDENCE_EXCLUDED"],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
    },
  ],
  evidence: [],
};

describe("UI V1 — developer details", () => {
  it("TEST 9: engine internals are present but collapsed by default", () => {
    const html = render(createElement(DeveloperDetails, { detail: detailFixture }));
    expect(html).toContain("Developer details");
    // A <details> without the `open` attribute is closed.
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // The reason code lives HERE, and not in the product surface.
    expect(html).toContain("ALL_EVIDENCE_EXCLUDED");
    expect(html).toContain("EXTRACTING");
  });

  it("TEST 9b: reason codes never appear in the user-facing component card", () => {
    const html = render(
      createElement(ComponentStatusCard, {
        component: "MECHANISM_SPEC",
        status: "INSUFFICIENT_EVIDENCE",
        evidenceCount: 0,
      }),
    );
    expect(html).not.toContain("ALL_EVIDENCE_EXCLUDED");
    expect(html).not.toContain("NO_EVIDENCE_FOUND");
  });
});

/* ------------------------------------------------------------------ */
/* 10. NO PROJECT-SPECIFIC CONCLUSION                                  */
/* ------------------------------------------------------------------ */

function uiSourceFiles(): string[] {
  const roots = ["src/client", "app/(app)"];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

// The invariant is about CODE, not prose. A comment may legitimately name
// the run that exposed a bug ("the live Raydium runs showed…"); what must
// never exist is a code path that knows a project. Stripping comments first
// keeps the assertion aimed at the thing it is actually protecting.
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

describe("UI V1 — no project-specific conclusion", () => {
  it("TEST 10: no UI file names a project outside the example QUESTIONS", () => {
    // The composer's example chips legitimately name projects — they are
    // questions a user might ask, not answers. Everything else in the UI must
    // be project-agnostic: a screen that knew "Raydium" would be a screen
    // that could be made to assert something about Raydium.
    const projectNames = /pump|raydium|hyperliquid|\bhype\b|jito|solana/i;
    const offenders: string[] = [];
    for (const file of uiSourceFiles()) {
      let src = readFileSync(file, "utf-8");
      if (file.endsWith("research-composer.tsx")) {
        src = src.replace(/const EXAMPLES = \[[\s\S]*?\] as const;/, "");
      }
      if (projectNames.test(codeOf(src))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("TEST 10b: no verdict, confidence or component status is hardcoded in a screen", () => {
    // Every one of these values must arrive from persisted state. A literal
    // assignment in a screen would be a conclusion the engine never reached.
    for (const file of uiSourceFiles()) {
      if (file.includes("research-model")) continue; // the label maps live here
      const src = codeOf(readFileSync(file, "utf-8"));
      // The negative lookahead for "|" keeps a TYPE union of the closed
      // verdict vocabulary from being read as an assigned conclusion.
      expect(src, file).not.toMatch(
        /verdict\s*[:=]\s*["'](SUPPORTED|NOT_SUPPORTED)["'](?!\s*\|)/,
      );
      expect(src, file).not.toMatch(/status\s*[:=]\s*["']SUPPORTED["'](?!\s*\|)/);
    }
  });

  it("TEST 10c: confidence is never rendered as a percentage or probability", () => {
    for (const file of uiSourceFiles()) {
      const src = codeOf(readFileSync(file, "utf-8"));
      expect(src, file).not.toMatch(/confidence[^\n]*%/i);
      expect(src, file).not.toMatch(/probability/i);
    }
  });
});
