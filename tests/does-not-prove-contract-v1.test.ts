import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResearchJobDetail } from "../src/client/api";
import { buildAuditContent } from "../src/client/audit-model";
import { EvidenceCardView } from "../src/client/components/research-result";
import { inputFromResearchJobDetail } from "../src/client/output-plan";
import {
  legacyExtractorNote,
  passageLimit,
  passageLimitLine,
  SOURCE_CLASS_CAVEATS,
  STRUCTURED_DOES_NOT_PROVE_RULE_VERSION,
} from "../src/client/research-model";
import { buildResultSurface, evidenceCard, type EvidenceCard } from "../src/client/result-surface";
import { resultFixture } from "../src/client/result-surface-fixtures";
import {
  conformsToDoesNotProveContract,
  DOES_NOT_PROVE_RULE_VERSION,
  doesNotProveRuleVersionFor,
} from "../src/server/domain/does-not-prove-contract";
import { EVIDENCE_EXTRACTOR_SYSTEM_PROMPT } from "../src/server/engine/providers/evidence-extractor-anthropic";

// The does_not_prove CONTRACT (Founder-approved). A model-written caveat is
// kept verbatim; a persisted marker says whether it was written as a CLAIM
// ("that …", "whether …", a noun phrase). Only a marked caveat — or a chain
// row's code-written one — is ever shown as a boundary on a primary Result.

// Verbatim from Wave 1A, evidence 41838267 (job fd1252ef).
const WAVE_1A = "The mechanism is not yet LIVE, or that buybacks are actually executed (rather than accumulated)";

const row = (over: Partial<Parameters<typeof evidenceCard>[0]> = {}): Parameters<typeof evidenceCard>[0] => ({
  id: "ev-1",
  component: "SOURCE_OF_VALUE",
  summary: "12% of trading fees fund RAY buybacks",
  fragment: "12% of Raydium trading fees are used to buy back RAY.",
  doesNotProve: null,
  doesNotProveRuleVersion: null,
  onchainFactKind: null,
  sourceClass: "OFFICIAL_DOCS",
  officiality: "CONFIRMED",
  retrievedUrl: "https://docs.example.org/ray/buybacks.md",
  sourceTitle: "Buybacks",
  ...over,
});
const v1 = (doesNotProve: string) => row({ doesNotProve, doesNotProveRuleVersion: DOES_NOT_PROVE_RULE_VERSION });
const cardOf = (r: ReturnType<typeof row>) => evidenceCard(r, "SUPPORTS", { jobId: null, quantity: null, ticker: null });
const renderOpen = (card: EvidenceCard) => renderToStaticMarkup(createElement(EvidenceCardView, { card, jobId: null, open: true }));
const textOf = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const nonCode = (src: string) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("1. the extraction contract accepts claims and refuses self-framing — it never edits", () => {
  it("the Founder's GOOD forms are v1, including genuinely negative claims", () => {
    for (const good of [
      "that the mechanism is currently LIVE",
      "that the mechanism is LIVE",
      "that the mechanism is not LIVE",
      "whether buybacks are actually executing",
      "net supply reduction",
      "that value does not reach token holders",
      "that burns were not offset by issuance",
      "that the mechanism is LIVE, or that buybacks are actually executed",
    ]) {
      expect(conformsToDoesNotProveContract(good), good).toBe(true);
      expect(doesNotProveRuleVersionFor(good), good).toBe(DOES_NOT_PROVE_RULE_VERSION);
    }
  });

  it("the Founder's BAD forms, the Wave 1A phrase and every real flip found by the audit get no marker", () => {
    for (const bad of [
      WAVE_1A,
      "The mechanism is not yet LIVE",
      "The document does not state the authorising proposal",
      "This excerpt does not prove that buybacks occur",
      "This statement does not prove the sustainability of the program.",
      // The audit's real polarity flips across persisted jobs, verbatim.
      "The exact mechanism of permanent removal (burn versus indefinite holding) is not specified",
      "Future buybacks beyond April 29, 2026 are not guaranteed; the disclaimer states this commitment is only deterministically programmed prior to April 29, 2026.",
      "The authorising decision or charter for this vote escrow mechanism is not stated in the document",
      "The claim cannot be falsified from this document alone; there is no visible on-chain transaction pathway, contract code, or technical verification mechanism described.",
      "This projection may not reflect actual future annualized revenue due to market volatility",
      // Several sentences are a description, not a claim.
      "that buybacks occur. This only shows the allocation.",
      "",
      "   ",
    ]) {
      expect(conformsToDoesNotProveContract(bad), bad).toBe(false);
      expect(doesNotProveRuleVersionFor(bad), bad).toBeNull();
    }
    expect(doesNotProveRuleVersionFor(null)).toBeNull();
  });

  it("the executor stores the model's words verbatim and only records the marker beside them", () => {
    const src = nonCode(readFileSync("src/server/engine/s4-executor.ts", "utf-8"));
    expect(src).toContain("doesNotProve: fact.doesNotProve,");
    expect(src).toContain("doesNotProveRuleVersion: doesNotProveRuleVersionFor(fact.doesNotProve),");
    // The contract module returns a marker, never a rewritten string.
    const contract = nonCode(readFileSync("src/server/domain/does-not-prove-contract.ts", "utf-8"));
    expect(contract).not.toMatch(/\.replace\(/);
  });

  it("the extractor is told the contract — forms, polarity, and what never to write", () => {
    const p = EVIDENCE_EXTRACTOR_SYSTEM_PROMPT;
    expect(p).toContain("WHAT IT DOES NOT PROVE.");
    expect(p).toContain('"that the mechanism is currently LIVE"');
    expect(p).toContain('"that value does not reach token holders"');
    expect(p).toContain('"whether buybacks are actually executing"');
    expect(p).toContain('"net supply reduction"');
    expect(p).toContain("State the claim with its own polarity.");
    expect(p).toContain("never write the\nopposite of the claim you mean");
    const schemaSrc = readFileSync("src/server/engine/providers/evidence-extractor-anthropic.ts", "utf-8");
    expect(schemaSrc).toMatch(/doesNotProve: z\s*\.string\(\)\s*\.min\(1\)\s*\.describe\(/);
  });
});

describe("2. polarity is preserved exactly — nothing strips, adds or inverts a negation", () => {
  it("'that the mechanism is not LIVE' keeps its negation", () => {
    const limit = passageLimit(v1("that the mechanism is not LIVE"))!;
    expect(limit).toEqual({ text: "that the mechanism is not LIVE", form: "CLAIM", origin: "EXTRACTOR_V1" });
    expect(passageLimitLine(limit)).toBe("Does not establish: that the mechanism is not LIVE");
  });

  it("'that the mechanism is LIVE' renders as itself, with no negation added", () => {
    const line = passageLimitLine(passageLimit(v1("that the mechanism is LIVE"))!);
    expect(line).toBe("Does not establish: that the mechanism is LIVE");
    // The claim after the label carries no negation the model did not write.
    expect(line.slice("Does not establish: ".length)).not.toMatch(/\bnot\b/);
  });

  it("a genuine negative claim is not inverted", () => {
    const html = textOf(renderOpen(cardOf(v1("that value does not reach token holders"))));
    expect(html).toContain("Does not establish: that value does not reach token holders");
  });
});

describe("3. presentation is decided by the marker, never by the text", () => {
  it("a v1 row renders its structured boundary on the primary Result card", () => {
    const card = cardOf(v1("that the mechanism is currently LIVE"));
    expect(card.doesNotProve).toBe("Does not establish: that the mechanism is currently LIVE");
    const html = textOf(renderOpen(card));
    expect(html).toContain("Does not establish: that the mechanism is currently LIVE");
    expect(html).not.toContain("Does not prove:");
  });

  it("the Wave 1A phrase can no longer reach the primary Result: the code-owned source-class limit stands in", () => {
    const legacy = row({ doesNotProve: WAVE_1A, doesNotProveRuleVersion: null });
    const card = cardOf(legacy);
    expect(card.doesNotProve).toBe(SOURCE_CLASS_CAVEATS.OFFICIAL_DOCS.cannot);
    const html = textOf(renderOpen(card));
    expect(html).not.toContain("not yet LIVE");
    expect(html).not.toContain("Does not prove: The mechanism is not yet LIVE");
    expect(html).not.toContain("Does not prove:");
    expect(html).toContain(SOURCE_CLASS_CAVEATS.OFFICIAL_DOCS.cannot);
  });

  it("an out-of-contract caveat is legacy even if it came from today's extractor (no marker)", () => {
    expect(passageLimit(row({ doesNotProve: "This excerpt does not prove that buybacks occur" }))?.origin).toBe("SOURCE_CLASS");
  });

  it("a chain row's code-written caveat is shown as written; a legacy row without a class shows nothing", () => {
    const chain = row({
      sourceClass: "ONCHAIN_VERIFIABLE",
      onchainFactKind: "ACCOUNT_INFO",
      doesNotProve: "This shows that the account exists on-chain. It does not establish who controls it.",
    });
    expect(passageLimit(chain)).toEqual({ text: chain.doesNotProve, form: "STATEMENT", origin: "CHAIN" });
    expect(passageLimit(row({ doesNotProve: WAVE_1A, sourceClass: null }))).toBeNull();
  });

  it("on a whole Result, legacy caveats never surface — every card, every block input", () => {
    const base = resultFixture("7").detail;
    const detail: ResearchJobDetail = {
      ...base,
      evidence: base.evidence.map((e) =>
        e.sourceClass === "ONCHAIN_VERIFIABLE" ? e : { ...e, doesNotProve: WAVE_1A, doesNotProveRuleVersion: null },
      ),
    };
    const surface = buildResultSurface(detail);
    const cards = [...surface.keyEvidence, ...surface.table.flatMap((r) => r.evidence)];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.doesNotProve ?? "").not.toContain("not yet LIVE");
      expect(textOf(renderOpen(card))).not.toContain("not yet LIVE");
    }
    for (const e of inputFromResearchJobDetail(detail).evidence) {
      expect(e.doesNotProve ?? "").not.toContain("not yet LIVE");
    }
  });
});

describe("4. the raw legacy text is preserved and auditable, under its own label", () => {
  it("the API projects the persisted caveat and its marker unchanged", () => {
    const src = nonCode(readFileSync("app/api/research-jobs/[id]/route.ts", "utf-8"));
    expect(src).toContain("doesNotProve: evidence.doesNotProve,");
    expect(src).toContain("doesNotProveRuleVersion: evidence.doesNotProveRuleVersion,");
  });

  it("the audit carries a legacy caveat as a 'Legacy extractor note', never as a boundary", () => {
    expect(legacyExtractorNote(row({ doesNotProve: WAVE_1A }))).toBe(WAVE_1A);
    expect(legacyExtractorNote(v1("that the mechanism is LIVE"))).toBeNull();
    expect(legacyExtractorNote(row({ onchainFactKind: "ACCOUNT_INFO", doesNotProve: "This shows …" }))).toBeNull();

    const base = resultFixture("7").detail;
    const target = base.evidence.find((e) => e.sourceClass === "OFFICIAL_DOCS")!;
    const evidence = base.evidence.map((e) => (e.id === target.id ? { ...e, doesNotProve: WAVE_1A, doesNotProveRuleVersion: null } : e));
    const content = buildAuditContent(base.components, evidence, null);
    const links = content.evidenceMap.flatMap((g) => [...g.admitted, ...g.excluded]).filter((l) => l.evidenceIds.includes(target.id));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.legacyExtractorNote).toBe(WAVE_1A);
      expect(l.doesNotProve).toBeNull();
    }
    const audit = readFileSync("src/client/components/research-audit.tsx", "utf-8");
    expect(audit).toContain("Legacy extractor note: </span>");
  });

  it("a v1 caveat reaches the audit as a framed boundary, with no legacy note", () => {
    const base = resultFixture("7").detail;
    const target = base.evidence.find((e) => e.sourceClass === "OFFICIAL_DOCS")!;
    const evidence = base.evidence.map((e) =>
      e.id === target.id ? { ...e, doesNotProve: "that the mechanism is LIVE", doesNotProveRuleVersion: 1 } : e,
    );
    const links = buildAuditContent(base.components, evidence, null)
      .evidenceMap.flatMap((g) => [...g.admitted, ...g.excluded])
      .filter((l) => l.evidenceIds.includes(target.id) && l.evidenceCount === 1);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.doesNotProve).toBe("Does not establish: that the mechanism is LIVE");
      expect(l.legacyExtractorNote).toBeNull();
    }
  });
});

describe("5. Memory copies the marker exactly (proved end to end in research-memory-observed-candidates-v1)", () => {
  it("adoption copies the origin's marker, never re-derives it", () => {
    const src = nonCode(readFileSync("src/server/engine/memory-evidence-adoption.ts", "utf-8"));
    expect(src).toContain("doesNotProveRuleVersion: origin.doesNotProveRuleVersion,");
    expect(src).not.toContain("doesNotProveRuleVersionFor");
  });
});

describe("6. presentation only — no verdict, component, confidence, source-authority or Memory rule reads it", () => {
  it("no decision module mentions the caveat or its marker", () => {
    for (const f of [
      "src/server/engine/component-reconciler.ts",
      "src/server/engine/component-reconciliation-store.ts",
      "src/server/engine/claim-evaluator.ts",
      "src/server/engine/claim-support-store.ts",
      "src/server/engine/mechanism-assembler.ts",
      "src/server/engine/mechanism-assembly-store.ts",
      "src/server/engine/proof-builder.ts",
      "src/server/engine/research-boundary.ts",
      "src/server/engine/targeted-recovery.ts",
      "src/server/engine/source-authority.ts",
      "src/server/memory/observed-candidates.ts",
    ]) {
      const src = nonCode(readFileSync(f, "utf-8"));
      expect(src, f).not.toMatch(/doesNotProve|does_not_prove/);
    }
  });

  it("the same Result with v1 or legacy markers has identical statuses, answer and confidence", () => {
    const base = resultFixture("7").detail;
    const mark = (version: number | null): ResearchJobDetail => ({
      ...base,
      evidence: base.evidence.map((e) => ({ ...e, doesNotProveRuleVersion: version })),
    });
    const a = buildResultSurface(mark(STRUCTURED_DOES_NOT_PROVE_RULE_VERSION));
    const b = buildResultSurface(mark(null));
    expect(b.verdict).toBe(a.verdict);
    expect(b.outcomeKind).toBe(a.outcomeKind);
    expect(b.answer).toEqual(a.answer);
    expect(b.table.map((r) => [r.component, r.status])).toEqual(a.table.map((r) => [r.component, r.status]));
    expect(b.boundary).toEqual(a.boundary);
  });

  it("the migration only adds a nullable column — no default, no backfill, no rewrite", () => {
    const sql = readFileSync("src/server/db/migrations/0060_does_not_prove_rule_version.sql", "utf-8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim().length > 0);
    expect(statements).toEqual(['ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "does_not_prove_rule_version" smallint;']);
    const journal = JSON.parse(readFileSync("src/server/db/migrations/meta/_journal.json", "utf-8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 60)).toMatchObject({ idx: 60, tag: "0060_does_not_prove_rule_version" });
  });
});
