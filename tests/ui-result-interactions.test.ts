import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResearchJobListItem } from "../src/client/api";
import { projectHue, projectInitials, ProjectAvatar } from "../src/client/components/project-avatar";
import { RecentProofCard } from "../src/client/components/recent-proof-card";
import { EvidenceCardView, FindingRow, ResearchResult } from "../src/client/components/research-result";
import { buildResultSurface, tableRows } from "../src/client/result-surface";
import { resultFixture } from "../src/client/result-surface-fixtures";

// THE USER-FACING EVIDENCE INTERACTIONS — WHAT A TAP MUST VISIBLY DO.
//
// The Founder reported "Evidence · N", "View excerpt" and "Open original"
// as appearing to do nothing. Driven in a real browser they all worked;
// what they lacked was an unmistakable change of state and, inside
// Telegram, a platform-honoured way to open a link. These pins hold the
// contract: the open state renders the proof in place, the closed state
// renders none of it, an action exists only where it leads somewhere, and
// the source is what opens.

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (h: string, id: string) => h.match(new RegExp(`data-testid="${id}"`, "g"))?.length ?? 0;
const textOf = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const RESULT = "src/client/components/research-result.tsx";
const AUDIT = "src/client/components/research-audit.tsx";
const PLATFORM = "src/client/platform.ts";

function rowWithEvidence() {
  const { detail } = resultFixture("8");
  const row = tableRows(buildResultSurface(detail).table).find((r) => r.evidence.length >= 2);
  if (!row) throw new Error("fixture 8 must carry a row with two or more admitted evidence items");
  return { detail, row };
}

/* ------------------------------------------------------------------ */
/* 1. EVIDENCE · N — opens the proof beneath THAT finding               */
/* ------------------------------------------------------------------ */

describe("Evidence · N", () => {
  it("closed: the control says how many, is not expanded, and no evidence block renders", () => {
    const { row } = rowWithEvidence();
    const html = render(createElement(FindingRow, { row, jobId: null }));
    expect(html).toContain(`Evidence · ${row.evidence.length}`);
    expect(html).toContain('aria-expanded="false"');
    expect(count(html, "row-evidence")).toBe(0);
    expect(count(html, "evidence-card")).toBe(0);
  });

  it("open: the control reads Hide evidence, is expanded, and the block beneath carries every admitted source with its excerpt already open", () => {
    const { row } = rowWithEvidence();
    const html = render(createElement(FindingRow, { row, jobId: null, defaultOpen: true }));
    expect(html).toContain("Hide evidence");
    expect(html).toContain('aria-expanded="true"');
    expect(count(html, "row-evidence")).toBe(1);
    expect(count(html, "evidence-card")).toBe(row.evidence.length);
    const block = html.slice(html.indexOf('data-testid="row-evidence"'));
    expect(textOf(block)).toContain("Evidence behind this answer");
    for (const c of row.evidence) expect(block).toContain(c.sourceName);
    // The excerpt of every documentary card is open on arrival — the
    // reader tapped for the proof, not for another control.
    const documentary = row.evidence.filter((c) => !c.onchain);
    expect(count(block, "evidence-details")).toBe(documentary.length);
  });

  it("the block sits inside the finding's own row, right after its state line — never a separate page", () => {
    const code = readFileSync(RESULT, "utf-8");
    const stateLine = code.indexOf('className="state-line');
    const block = code.indexOf('data-testid="row-evidence"');
    const rowEnd = code.indexOf("</li>", stateLine);
    expect(stateLine).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(stateLine);
    expect(block).toBeLessThan(rowEnd);
    // One state, flipped by the control, opening the block: no router push,
    // no second route.
    expect(code).toContain("onClick={() => setOpen((v) => !v)}");
    expect(code).toContain("{open && (");
    expect(code).not.toContain("router.push(`/research/${jobId}/evidence");
    // The open block has its own surface so the change is unmistakable.
    expect(code).toContain('className="row-evidence expand-enter"');
    expect(readFileSync("app/globals.css", "utf-8")).toMatch(/\.row-evidence\s*\{[^}]*border: 1px solid rgba\(30, 197, 245/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. VIEW EXCERPT — reveals the source's own words, in the card         */
/* ------------------------------------------------------------------ */

describe("View excerpt", () => {
  const documentaryCard = () => {
    const { row } = rowWithEvidence();
    const card = row.evidence.find((c) => !c.onchain && c.excerpt.length > 0);
    if (!card) throw new Error("fixture 8 must carry a documentary card with an excerpt");
    return card;
  };

  it("closed: the control offers the excerpt and none of it renders", () => {
    const html = render(createElement(EvidenceCardView, { card: documentaryCard(), jobId: null }));
    expect(html).toContain("View excerpt");
    expect(html).toContain('aria-expanded="false"');
    expect(count(html, "evidence-details")).toBe(0);
    expect(count(html, "evidence-excerpt")).toBe(0);
  });

  it("open: the exact persisted excerpt renders as a quotation, with what it does not prove, and the control offers to hide it", () => {
    const card = documentaryCard();
    const html = render(createElement(EvidenceCardView, { card, jobId: null, open: true }));
    expect(html).toContain("Hide excerpt");
    expect(html).toContain('aria-expanded="true"');
    expect(count(html, "evidence-excerpt")).toBe(1);
    expect(textOf(html)).toContain(card.excerpt);
    if (card.doesNotProve) expect(textOf(html)).toContain(`Does not prove: ${card.doesNotProve}`);
    // Human text, never the record's shape.
    expect(html).not.toContain("amountRaw");
    expect(html).not.toMatch(/"fragment"\s*:/);
  });

  it("a chain reading has no excerpt control at all — its observation is already the whole card", () => {
    const { row } = rowWithEvidence();
    const chain = row.evidence.find((c) => c.onchain) ?? tableRows(buildResultSurface(resultFixture("8").detail).table).flatMap((r) => r.evidence).find((c) => c.onchain);
    if (!chain) throw new Error("fixture 8 must carry a chain reading");
    const html = render(createElement(EvidenceCardView, { card: chain, jobId: null }));
    expect(count(html, "evidence-details-toggle")).toBe(0);
    expect(textOf(html)).toContain(chain.onchain!.observation);
  });
});

/* ------------------------------------------------------------------ */
/* 3. OPEN ORIGINAL — a real page opens; no page, no control              */
/* ------------------------------------------------------------------ */

describe("Open original", () => {
  it("a documentary source with an http(s) URL renders an active link to that URL, in a new tab, with safe rel", () => {
    const { row } = rowWithEvidence();
    const card = row.evidence.find((c) => c.openable);
    if (!card) throw new Error("fixture 8 must carry an openable card");
    const html = render(createElement(EvidenceCardView, { card, jobId: null }));
    expect(count(html, "evidence-open-original")).toBe(1);
    const a = /<a[^>]*data-testid="evidence-open-original"[^>]*>/.exec(html)?.[0] ?? "";
    expect(a).toContain(`href="${card.url}"`);
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
    expect(card.url).toMatch(/^https?:\/\//);
  });

  it("a chain locator is not a page: no Open original renders for it", () => {
    const cards = tableRows(buildResultSurface(resultFixture("8").detail).table).flatMap((r) => r.evidence);
    const chain = cards.find((c) => c.onchain);
    if (!chain) throw new Error("fixture 8 must carry a chain reading");
    expect(chain.openable).toBe(false);
    expect(chain.url).toMatch(/^atlas-onchain:\/\//);
    expect(count(render(createElement(EvidenceCardView, { card: chain, jobId: null })), "evidence-open-original")).toBe(0);
  });

  it("inside Telegram the Mini App API opens the link; on the web the anchor does; the URL is never rewritten", () => {
    const platform = readFileSync(PLATFORM, "utf-8");
    expect(platform).toContain("openExternal(url: string): boolean");
    expect(platform).toContain("tg.openLink(url)");
    expect(platform).toContain("openExternal: () => false");
    for (const file of [RESULT, AUDIT]) {
      const code = readFileSync(file, "utf-8");
      expect(code, file).toContain("if (getPlatform().openExternal(card.url)) e.preventDefault();");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. NO DEAD SOURCE ACTIONS, ACROSS A WHOLE RESULT                       */
/* ------------------------------------------------------------------ */

describe("no dead source actions on a rendered result", () => {
  it("every Open original points at an http(s) URL, and every Snapshot at this job's own source route", () => {
    for (const f of ["1", "2", "7", "8"]) {
      const { detail } = resultFixture(f);
      const html = render(createElement(ResearchResult, { detail, jobId: detail.job.id }));
      for (const m of html.matchAll(/<a[^>]*data-testid="evidence-open-original"[^>]*href="([^"]+)"/g)) {
        expect(m[1], f).toMatch(/^https?:\/\//);
      }
      for (const m of html.matchAll(/<a[^>]*data-testid="evidence-snapshot"[^>]*href="([^"]+)"/g)) {
        expect(m[1], f).toMatch(new RegExp(`^/research/${detail.job.id}/source/`));
      }
    }
  });

  it("on a design fixture no Snapshot renders at all (no route can serve it)", () => {
    const { detail } = resultFixture("8");
    expect(count(render(createElement(ResearchResult, { detail, jobId: null })), "evidence-snapshot")).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. HOME — PREVIOUSLY RESEARCHED PROJECTS, SUGGESTED QUESTIONS          */
/* ------------------------------------------------------------------ */

function job(over: Partial<ResearchJobListItem> = {}): ResearchJobListItem {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    state: "SUCCEEDED",
    progressStage: 5,
    memoryStatus: "NOT_USED",
    acquisitionPhase: null,
    acquisitionPhaseAt: null,
    terminationReason: null,
    originalQuestion: "Does protocol revenue fund AAVE buybacks?",
    unread: false,
    createdAt: "2026-09-19T20:56:32.000Z",
    finishedAt: "2026-09-20T13:11:42.000Z",
    projectName: "Aave",
    projectSlug: "aave",
    projectTicker: "AAVE",
    verdict: "INSUFFICIENT_EVIDENCE",
    ...over,
  };
}

describe("Home — previously researched projects", () => {
  it("a row is project-first: avatar initials, name, the question, when it was checked, the persisted outcome", () => {
    const html = render(createElement(RecentProofCard, { job: job() }));
    expect(count(html, "project-avatar")).toBe(1);
    expect(textOf(html)).toContain("AAVE");
    expect(html).toContain("Aave");
    expect(html).toContain("Does protocol revenue fund AAVE buybacks?");
    expect(textOf(html)).toMatch(/Checked \d{1,2} \w+ 2026/);
    expect(html).toContain('data-verdict="INSUFFICIENT_EVIDENCE"');
    expect(html).toContain('href="/research/11111111-1111-1111-1111-111111111111"');
  });

  it("the avatar invents nothing: initials from the ticker or the name, one deterministic hue from the stable key", () => {
    expect(projectInitials("Aave", "AAVE")).toBe("AAV");
    expect(projectInitials("Lido", null)).toBe("LI");
    expect(projectInitials("Pump Fun", null)).toBe("PF");
    expect(projectInitials(null, null)).toBe("?");
    expect(projectHue("aave")).toBe(projectHue("aave"));
    expect(projectHue("aave")).not.toBe(projectHue("lido"));
    const html = render(createElement(ProjectAvatar, { name: "Lido", ticker: "LDO", slug: "lido" }));
    expect(html).toContain("LDO");
    expect(html).toContain("--hue:");
    // No image, no fetch, no icon service.
    expect(html).not.toContain("<img");
    expect(readFileSync("src/client/components/project-avatar.tsx", "utf-8")).not.toMatch(/fetch\(|https?:\/\//);
  });

  it("a live job shows its stage, never a verdict, and no 'Checked' date", () => {
    const html = render(createElement(RecentProofCard, { job: job({ state: "RUNNING", finishedAt: null, verdict: null }) }));
    expect(count(html, "history-outcome")).toBe(0);
    expect(textOf(html)).not.toContain("Checked ");
  });

  it("Home has no marketing paragraph, a loading skeleton and an honest empty state", () => {
    const page = readFileSync("app/(app)/home/page.tsx", "utf-8");
    expect(page).not.toContain("ATLAS checks what a token actually earns");
    expect(page).toContain('data-testid="recent-loading"');
    expect(page).toContain("Nothing researched yet");
    expect(page).toContain("Previously researched");
    expect(page).not.toContain("Recent research");
  });
});

describe("Home — suggested questions", () => {
  it("four research examples in the product's domain, each a chip that fills the input through the existing flow", () => {
    const code = readFileSync("src/client/components/research-composer.tsx", "utf-8");
    const examples = code.slice(code.indexOf("const EXAMPLES"), code.indexOf("] as const;"));
    expect((examples.match(/text: "/g) ?? []).length).toBe(4);
    expect(examples).toContain("Does PUMP buyback actually reduce supply?");
    expect(examples).toContain("Where do Raydium trading fees go?");
    expect(examples).toContain("Does HYPE revenue actually reach token holders?");
    expect(examples).toContain("Are bought-back tokens burned or held?");
    // A tap fills the input; sending goes through interpret → gate → start
    // exactly as a typed question does. No new backend path.
    expect(code).toContain('onClick={() => setQuestion(ex.text)} className="chip" data-testid="composer-example"');
    expect(code).toContain("api.interpret(");
    expect(code).not.toMatch(/api\.startResearch\(ex\./);
  });
});
