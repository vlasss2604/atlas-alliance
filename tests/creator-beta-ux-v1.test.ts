import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PATCH as languagePATCH } from "../app/api/me/language/route";
import { GET as meGET } from "../app/api/me/route";
import type { ResearchJobDetail, ResearchJobListItem } from "../src/client/api";
import { DictScope } from "../src/client/app-context";
import { AUDIT_OUTCOME_LABELS, buildAuditContent, COVERAGE_LABELS } from "../src/client/audit-model";
import { betaBlockOf } from "../src/client/beta-status";
import { RecentProofCard } from "../src/client/components/recent-proof-card";
import { ResearchAudit } from "../src/client/components/research-audit";
import { ResearchProgress } from "../src/client/components/research-progress";
import { ResearchResult } from "../src/client/components/research-result";
import { setDisplayLanguage } from "../src/client/display-language";
import { en, type Dict } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import {
  RU_AUDIT,
  RU_COMPONENT_LABELS,
  RU_COMPONENT_PHRASES,
  RU_EXCLUSION_LABELS,
  RU_REASON_CODE_EXPLANATIONS,
  RU_SOURCE_CLASS_CAVEATS,
  RU_TYPED_VALUE_ABSENT_LIMIT,
  ruQuestionLabel,
} from "../src/client/i18n/result-ru";
import { TYPED_VALUE_ABSENT_LIMIT } from "../src/client/mechanism-typed-value";
import { buildResultSurface, mechanismNounOf, PROOF_PATH_ORDER } from "../src/client/result-surface";
import { RESULT_FIXTURES, resultFixture } from "../src/client/result-surface-fixtures";
import {
  COMPONENT_LABELS,
  EXCLUSION_LABELS,
  REASON_CODE_EXPLANATIONS,
  researchAnswer,
  retrievedOn,
  SOURCE_CLASS_CAVEATS,
} from "../src/client/research-model";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { createSession } from "../src/server/auth/session";
import { INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { productConfig, proofs, researchJobs, subscriptions, topics, userIdentities, users } from "../src/server/db/schema";
import { transitionJobState } from "../src/server/jobs/research-jobs";
import { __resetRuntime } from "../src/server/runtime";
import { countPrivateBetaAdmissions, countPrivateBetaJobs, grantPrivateBetaAccess, setPrivateBetaConfig } from "../src/server/services/private-beta";
import type { OutboundMessage, SendResult } from "../src/server/telegram/bot-api";
import { handleTelegramUpdate } from "../src/server/telegram/webhook";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-171 — CREATOR BETA UX CLEANUP, offline.
//
// Two complete user-facing languages, English by default and Russian only
// on the user's explicit choice (users.language, the existing preference);
// every creator-beta surface reads its words from the dictionaries; the
// blocked states (paused, at capacity, allowance used up) are told truthfully
// and point to the Research Library; no unavailable offer on Profile; no
// dead-end bot flow. Presentation only: nothing here changes an
// entitlement, an allowance, a job, a Proof or the evidence.

const ORIGIN = "https://app.atlas.test";
const PROJECT = "raydium";
let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.MODEL_GATEWAY = "fake";
  ctx = await setupTestDatabase();
  await openBeta();
});

afterAll(async () => {
  setDisplayLanguage("EN");
  await __resetRuntime();
  await ctx.close();
});

afterEach(async () => {
  setDisplayLanguage("EN");
  await openBeta();
});

async function setResearchEnabled(value: boolean) {
  await ctx.db.insert(productConfig).values({ key: "research_enabled", value }).onConflictDoUpdate({ target: productConfig.key, set: { value } });
}
async function openBeta(patch: { enabled?: boolean; globalResearchLimit?: number; researchLimit?: number } = {}) {
  await setPrivateBetaConfig(ctx.db, {
    enabled: patch.enabled ?? true,
    projectSlugs: [PROJECT],
    researchLimit: patch.researchLimit ?? 3,
    globalResearchLimit: patch.globalResearchLimit ?? 10_000,
    creatorUserLimit: 10_000,
  });
  await setResearchEnabled(false);
  await __resetRuntime();
}

interface Authed {
  cookie: string;
  csrf: string;
  userId: string;
}
async function authedUser(role: "USER" | "ADMIN" = "USER"): Promise<Authed> {
  const [u] = await ctx.db.insert(users).values({ role }).returning();
  const { rawToken } = await createSession(ctx.db, u.id);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { cookie: `atlas_session=${rawToken}`, csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!), userId: u.id };
}
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
async function betaUser(): Promise<Authed> {
  const c = await authedUser();
  await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(30) });
  return c;
}
const get = (path: string, c: Authed) => new Request(`http://localhost${path}`, { method: "GET", headers: { cookie: c.cookie, origin: ORIGIN } });
const patch = (path: string, c: Authed, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: c.cookie, origin: ORIGIN, "x-atlas-csrf": c.csrf },
    body: JSON.stringify(body),
  });
type Me = {
  language: string;
  entitlement: { level: string };
  privateBeta: { used: number; limit: number; remaining: number; capacityReached: boolean } | null;
  betaPaused: boolean;
  demoAvailable: boolean;
};
const me = async (c: Authed) => (await (await meGET(get("/api/me", c))).json()) as Me;

async function admittedJob(userId: string, state: "SUCCEEDED" | "FAILED" = "SUCCEEDED"): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [job] = await ctx.db
    .insert(researchJobs)
    .values({
      userId,
      topicId: topic.id,
      originalQuestion: "Does Raydium buy back RAY?",
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlementAtStart: "ARI_CORE",
      capabilityAtStart: "FRESH_RESEARCH",
      budgetAtStart: INTERNAL_ALPHA_V1,
      origin: "PRIVATE_BETA",
    })
    .returning();
  await transitionJobState(ctx.db, job.id, "RUNNING", "test");
  await transitionJobState(ctx.db, job.id, state, "test");
  if (state === "SUCCEEDED") {
    const [project] = (await ctx.db.execute(sql`SELECT id FROM projects WHERE slug = ${PROJECT}`)).rows as { id: string }[];
    await ctx.db.insert(proofs).values({ researchJobId: job.id, ownerUserId: userId, projectId: project.id, topicId: topic.id, verdict: "SUPPORTED", confidence: 70, layers: {} });
  }
  return job.id;
}

/* ------------------------------------------------------------------ */
/* language                                                            */
/* ------------------------------------------------------------------ */

describe("language: English by default, Russian only by explicit choice, presentation only", () => {
  it("a new user starts in EN; EN → RU → EN through the existing preference persists across sessions", async () => {
    const c = await authedUser();
    expect((await me(c)).language).toBe("EN");
    expect((await languagePATCH(patch("/api/me/language", c, { language: "RU" }))).status).toBe(200);
    expect((await me(c)).language).toBe("RU");
    // A new session (reopening the Mini App signs in again and replaces the
    // old session) reads the same saved choice.
    const { rawToken } = await createSession(ctx.db, c.userId);
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const reopened: Authed = { userId: c.userId, cookie: `atlas_session=${rawToken}`, csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!) };
    expect((await me(reopened)).language).toBe("RU");
    expect((await languagePATCH(patch("/api/me/language", reopened, { language: "EN" }))).status).toBe(200);
    expect((await me(reopened)).language).toBe("EN");
  });

  it("switching language changes nothing canonical: entitlement, allowance, jobs, Proofs, grant", async () => {
    const c = await betaUser();
    await admittedJob(c.userId);
    const snapshot = async () => ({
      me: await me(c).then((m) => ({ ...m, language: "ignored" })),
      jobs: (await ctx.db.select().from(researchJobs).where(eq(researchJobs.userId, c.userId))).map((j) => [j.id, j.state, j.origin]),
      proofs: (await ctx.db.select().from(proofs).where(eq(proofs.ownerUserId, c.userId))).map((p) => [p.id, p.verdict]),
      subs: (await ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, c.userId))).map((s) => [s.id, s.status, s.validUntil.toISOString()]),
      personal: await countPrivateBetaJobs(ctx.db, c.userId),
      global: await countPrivateBetaAdmissions(ctx.db),
    });
    const before = await snapshot();
    await languagePATCH(patch("/api/me/language", c, { language: "RU" }));
    expect(await snapshot()).toEqual(before);
  });

  it("nothing guesses a locale: onboarding starts in English with an explicit EN | RU switch; the app reads only the saved choice", () => {
    const onboarding = readFileSync("app/onboarding/page.tsx", "utf8");
    expect(onboarding).not.toContain("navigator.language");
    expect(onboarding).toContain('useState<"EN" | "RU">("EN")');
    expect(onboarding).toContain("api.setLanguage(next)");
    const appContext = readFileSync("src/client/app-context.tsx", "utf8");
    expect(appContext).toContain('const language = me?.language === "RU" ? "RU" : "EN";');
    for (const file of ["src/client/app-context.tsx", "src/server/auth/authenticate.ts", "app/api/auth/telegram/route.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/language_code|navigator\.language|Intl\.DateTimeFormat\(\)\.resolvedOptions/);
    }
    // The Profile switch stays the existing users.language PATCH.
    expect(readFileSync("app/(app)/profile/page.tsx", "utf8")).toContain("api.setLanguage(language)");
  });
});

/* ------------------------------------------------------------------ */
/* RU rendering, dictionary parity, no hard-coded English              */
/* ------------------------------------------------------------------ */

function keysOf(o: unknown, prefix = ""): string[] {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k));
}
const visible = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Russian is complete on the creator-beta surfaces", () => {
  it("every dictionary key exists in both languages", () => {
    expect(keysOf(ru).sort()).toEqual(keysOf(en).sort());
  });

  it("the beta, capacity, allowance, invite, refusal, pause and feedback messages exist in both languages, and Russian never mixes in English product terms", () => {
    const pick = (d: Dict) => [
      d.home.betaLabel,
      d.home.betaRemaining(2),
      d.home.betaAtCapacity,
      d.home.betaPaused,
      d.home.betaExhausted(3),
      d.home.betaInviteUnavailable,
      d.home.betaAccessFull,
      d.home.openLibrary,
      d.ask.globalBetaCapacity,
      d.ask.betaResearchLimitReached,
      d.ask.betaProjectNotAvailable,
      d.ask.betaAccessRequired,
      d.ask.disabledNote,
      d.ask.continue,
      d.feedback.title,
      d.feedback.requiredHint,
      d.feedback.banner,
      d.feedback.thanks,
      d.profile.noAccess,
    ];
    const enCopy = pick(en);
    const ruCopy = pick(ru);
    ruCopy.forEach((r, i) => {
      expect(r, enCopy[i]).toBeTruthy();
      expect(r, enCopy[i]).not.toBe(enCopy[i]);
      expect(r).not.toMatch(/\bResearch\b|private beta|Private Beta|Research Library/);
    });
    expect(ru.home.betaRemaining(1)).toBe("Осталось 1 исследование");
    expect(ru.home.betaRemaining(3)).toBe("Осталось 3 исследования");
    expect(ru.home.betaRemaining(0)).toBe("Осталось 0 исследований");
    expect(`${ru.home.betaLabel} · ${ru.home.betaRemaining(3)}`).toBe("Закрытая бета · Осталось 3 исследования");
  });

  it("Result, progress and history render in Russian: no English interface words, dates in Russian", () => {
    setDisplayLanguage("RU");
    const { detail } = resultFixture("4");
    const result = visible(renderToStaticMarkup(createElement(DictScope, { dict: ru }, createElement(ResearchResult, { detail, jobId: detail.job.id }))));
    for (const word of [ru.result.label, ru.result.checkedTitle, ru.result.unclearTitle, ru.result.openAudit, ru.result.unclearHeadings.TECHNICAL]) {
      expect(result).toContain(word);
    }
    for (const english of ["Research result", "What ATLAS checked", "What remains unclear", "Open full audit", "Hide evidence", "View excerpt", "Not every source could be checked", "confidence", "Checked ", "behind the answer"]) {
      expect(result).not.toContain(english);
    }
    const progress = visible(
      renderToStaticMarkup(createElement(DictScope, { dict: ru }, createElement(ResearchProgress, { job: { state: "RUNNING", progressStage: 2, acquisitionPhase: null } }))),
    );
    expect(progress).toContain("Ход исследования");
    expect(progress).toContain("Планирую исследование");
    expect(progress).not.toMatch(/Research process|Understanding|Planning|Searching/);
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      state: "SUCCEEDED",
      verdict: "SUPPORTED",
      projectName: null,
      projectTicker: null,
      projectSlug: null,
      originalQuestion: "Выкупает ли Raydium RAY?",
      unread: false,
      finishedAt: "2026-10-04T10:00:00.000Z",
      createdAt: "2026-10-04T09:00:00.000Z",
      progressStage: 5,
      acquisitionPhase: null,
    } as unknown as ResearchJobListItem;
    const card = visible(renderToStaticMarkup(createElement(DictScope, { dict: ru }, createElement(RecentProofCard, { job }))));
    expect(card).toContain("Подтверждено");
    expect(card).toContain("Проект не определён");
    expect(card).toContain("Проверено");
    expect(card).not.toMatch(/Supported|Unresolved project|Checked/);
    expect(retrievedOn("2026-10-04T10:00:00.000Z")).toMatch(/окт/);
    setDisplayLanguage("EN");
    expect(retrievedOn("2026-10-04T10:00:00.000Z")).toBe("4 Oct 2026");
  });

  it("no creator-beta surface carries hard-coded English interface text", () => {
    const files = [
      "app/(app)/home/page.tsx",
      "app/(app)/ask/page.tsx",
      "app/(app)/research/page.tsx",
      "app/(app)/research/[id]/page.tsx",
      "app/(app)/profile/page.tsx",
      "app/onboarding/page.tsx",
      "src/client/components/research-composer.tsx",
      "src/client/components/research-result.tsx",
      "src/client/components/research-progress.tsx",
      "src/client/components/recent-proof-card.tsx",
      "src/client/components/research-group-card.tsx",
      "src/client/components/verdict-badge.tsx",
      "src/client/components/beta-status-notice.tsx",
      "src/client/components/beta-feedback-prompt.tsx",
      "src/client/components/app-chrome.tsx",
      // The rest of the Proof journey: the full audit and the source snapshot.
      "src/client/components/research-audit.tsx",
      "app/(app)/research/[id]/audit/page.tsx",
      "app/(app)/research/[id]/source/[evidenceId]/page.tsx",
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // `(?<!=)` skips TypeScript arrows (`=> Promise<…>`), which are not text.
      for (const m of src.matchAll(/(?<!=)>\s*([A-Za-z][A-Za-z ,.'’!?:-]{2,})\s*</g)) {
        if (!/^(ATLAS|PROOF|EN|RU|ATLAS PROOF)$/.test(m[1].trim())) offenders.push(`${file}: "${m[1].trim()}"`);
      }
      for (const m of src.matchAll(/(?:aria-label|title|placeholder)="([^"]*[A-Za-z]{3,}[^"]*)"/g)) offenders.push(`${file}: attr "${m[1]}"`);
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* the Russian Result / Proof journey                                  */
/* ------------------------------------------------------------------ */

// Everything the record or a source wrote — shown as written in any
// language: the question, the project, projection labels, evidence
// summaries and excerpts, source titles, v1 / chain caveats, URLs. A
// sentence of one of them is still its words.
function recordTexts(detail: ResearchJobDetail): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s && s.trim()) out.push(s.trim());
  };
  add(detail.job.originalQuestion);
  add(detail.job.projectName);
  add(detail.job.projectTicker);
  for (const f of detail.questionFindings ?? []) add(f.label);
  for (const e of detail.evidence) {
    add(e.summary);
    add(e.fragment);
    add(e.sourceTitle);
    add(e.doesNotProve);
    add(e.retrievedUrl);
    // The host of the source's own locator (a domain, or a chain's name).
    try {
      add(new URL(e.retrievedUrl).hostname);
    } catch {
      // not a URL — nothing to add
    }
  }
  const pieces = [...out, ...out.flatMap((s) => s.split(/(?<=[.!?])\s+/))].map((s) => s.trim()).filter(Boolean);
  return [...new Set(pieces)].sort((a, b) => b.length - a.length);
}

// Latin-script words left after the record's own words are removed. The
// product names stay untranslated (D-171 vocabulary); a chain's name is a
// proper name read from its locator.
const LATIN_ALLOWED = new Set(["ATLAS", "PROOF", "Proof", "ARI", "CORE", "HTTP", "Ethereum", "Solana"]);
function englishLeftovers(text: string, record: readonly string[]): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  let t = norm(text);
  for (const r of record) t = t.split(norm(r)).join(" ");
  t = t.replace(/atlas-onchain:\/\/\S+|https?:\/\/\S+/g, " ").replace(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, " ");
  return [...t.matchAll(/[A-Za-z][A-Za-z'’]*/g)].map((m) => m[0]).filter((w) => !LATIN_ALLOWED.has(w));
}

// The audit's Developer details are the engine's own codes, behind an
// explicit disclosure, in every language; and the technical record names
// a raw stored status beside its sentence. Both are engine vocabulary by
// design, not interface copy.
const withoutEngineCodes = (html: string) =>
  html.replace(/<dl class="mt-1\.5 ml-4 font-mono[\s\S]*?<\/dl>/g, " ").replace(/Сохранённый статус компонента: [A-Z_]+\./g, " ");

describe("the Russian Result and Proof journey: ATLAS's own sentences in Russian, the record in its own words", () => {
  it("the Russian phrasebook mirrors the English one, code for code", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(RU_REASON_CODE_EXPLANATIONS)).toEqual(keys(REASON_CODE_EXPLANATIONS));
    expect(keys(RU_SOURCE_CLASS_CAVEATS)).toEqual(keys(SOURCE_CLASS_CAVEATS));
    expect(keys(RU_EXCLUSION_LABELS)).toEqual(keys(EXCLUSION_LABELS));
    expect(keys(RU_COMPONENT_LABELS)).toEqual(keys(COMPONENT_LABELS));
    expect(keys(RU_TYPED_VALUE_ABSENT_LIMIT)).toEqual(keys(TYPED_VALUE_ABSENT_LIMIT));
    expect(keys(RU_AUDIT.outcomeLabels)).toEqual(keys(AUDIT_OUTCOME_LABELS));
    expect(keys(RU_AUDIT.coverageLabels)).toEqual(keys(COVERAGE_LABELS));
    for (const c of PROOF_PATH_ORDER) {
      expect(RU_COMPONENT_PHRASES[c], c).toBeTruthy();
      expect(ruQuestionLabel(c, "the buyback"), c).toBeTruthy();
    }
    // Every Russian entry is Russian: no English words beyond the product names.
    const all = [
      ...Object.values(RU_REASON_CODE_EXPLANATIONS),
      ...Object.values(RU_SOURCE_CLASS_CAVEATS).flatMap((c) => [c.from, c.can, c.cannot]),
      ...Object.values(RU_EXCLUSION_LABELS),
      ...Object.values(RU_COMPONENT_LABELS),
      ...Object.values(RU_COMPONENT_PHRASES),
      ...Object.values(RU_TYPED_VALUE_ABSENT_LIMIT),
      ...Object.values(RU_AUDIT.outcomeLabels),
      ...Object.values(RU_AUDIT.coverageLabels),
    ];
    for (const s of all) expect(englishLeftovers(s, []), s).toEqual([]);
  });

  it.each(RESULT_FIXTURES.map((f) => [f.key, f.title, f.detail] as const))(
    "state %s (%s): the Result, its evidence and the full audit carry no English sentence written by ATLAS",
    (key, _title, detail) => {
      setDisplayLanguage("RU");
      const record = recordTexts(detail);
      const s = buildResultSurface(detail);
      const surfaceText = [
        ...s.answer.sentences,
        ...s.table.flatMap((r) => [r.label, r.established, ...r.restsOn.map((d) => d.phrase)]),
        ...s.boundary.flatMap((g) => [g.copy, g.never, g.sharedDetail ?? "", ...g.items.flatMap((i) => [i.label, i.detail ?? ""])]),
        ...s.table
          .flatMap((r) => r.evidence)
          .flatMap((c) => [c.sourceName, c.proves, c.doesNotProve ?? "", c.onchain?.observation ?? "", c.sourceDomain]),
      ].join("\n");
      const content = buildAuditContent(detail.components, detail.evidence, null, detail.mechanism?.flows ?? null);
      const auditModelText = [
        ...content.scope.flatMap((i) => [i.label, i.outcomeLabel, i.coverageLabel, (i.reason ?? "").replace(/Сохранённый статус компонента: [A-Z_]+\./, "")]),
        ...content.openItems.flatMap((i) => [i.label, i.detail, i.needed]),
        ...content.evidenceMap.flatMap((g) => [
          g.label,
          g.outcomeLabel,
          ...[...g.admitted, ...g.excluded].flatMap((l) => [l.canEstablish ?? "", l.cannotEstablish ?? "", l.doesNotProve ?? "", ...l.exclusionReasons]),
        ]),
        ...[...content.register.used, ...content.register.checkedNotUsed].flatMap((e) => [
          ...e.notUsedReasons,
          e.suitability?.can ?? "",
          e.suitability?.cannot ?? "",
          ...e.contributedTo.map((x) => x.label),
        ]),
      ].join("\n");
      const result = visible(renderToStaticMarkup(createElement(DictScope, { dict: ru }, createElement(ResearchResult, { detail, jobId: detail.job.id }))));
      const audit = visible(
        withoutEngineCodes(
          renderToStaticMarkup(createElement(DictScope, { dict: ru }, createElement(ResearchAudit, { detail, jobId: detail.job.id, projection: null }))),
        ),
      );
      for (const [where, text] of [
        ["surface model", surfaceText],
        ["audit model", auditModelText],
        ["rendered Result", result],
        ["rendered full audit", audit],
      ] as const) {
        expect(englishLeftovers(text, record), `state ${key}: ${where}`).toEqual([]);
      }
    },
  );

  it("the scan is not vacuous: the same Result and audit rendered in English are full of ATLAS's own English", () => {
    setDisplayLanguage("EN");
    const { detail } = resultFixture("4");
    const record = recordTexts(detail);
    const result = visible(renderToStaticMarkup(createElement(DictScope, { dict: en }, createElement(ResearchResult, { detail, jobId: detail.job.id }))));
    const audit = visible(
      withoutEngineCodes(
        renderToStaticMarkup(createElement(DictScope, { dict: en }, createElement(ResearchAudit, { detail, jobId: detail.job.id, projection: null }))),
      ),
    );
    expect(englishLeftovers(result, record).length).toBeGreaterThan(20);
    expect(englishLeftovers(audit, record).length).toBeGreaterThan(20);
  });

  it("the record keeps its own words in Russian: evidence text, quotes, source titles and v1 claims are never translated", () => {
    setDisplayLanguage("RU");
    const { detail } = resultFixture("2");
    const s = buildResultSurface(detail);
    const cards = s.table.flatMap((r) => r.evidence);
    const documentary = cards.find((c) => !c.onchain && c.doesNotProve?.startsWith("Не устанавливает: "));
    expect(documentary).toBeTruthy();
    const row = detail.evidence.find((e) => e.id === documentary!.id)!;
    // The summary, the excerpt, the title and the claim are the record's, verbatim.
    expect(documentary!.proves).toBe(row.summary);
    expect(documentary!.excerpt).toBe(row.fragment);
    expect(documentary!.doesNotProve).toBe(`Не устанавливает: ${row.doesNotProve}`);
    if (row.sourceTitle) expect(documentary!.sourceName).toBe(row.sourceTitle);
    // The projection's own question labels stay as the model wrote them.
    const primary = s.table.filter((r) => r.kind === "PRIMARY").map((r) => r.label);
    expect(primary.some((label) => (detail.questionFindings ?? []).some((f) => f.label === label))).toBe(true);
    // And the same record in English reads as it always did.
    setDisplayLanguage("EN");
    const enCards = buildResultSurface(detail).table.flatMap((r) => r.evidence);
    expect(enCards.find((c) => c.id === documentary!.id)!.doesNotProve).toBe(`Does not establish: ${row.doesNotProve}`);
  });

  it("English stays the default and is unchanged; Russian follows the saved choice only", () => {
    const { detail } = resultFixture("4");
    setDisplayLanguage("EN");
    const enSurface = buildResultSurface(detail);
    expect(enSurface.table.some((r) => r.established === "The research limit was reached before this could be checked.")).toBe(true);
    expect(enSurface.answer.sentences.join(" ")).toContain("The research limit was reached before all relevant sources could be checked.");
    setDisplayLanguage("RU");
    const ruSurface = buildResultSurface(detail);
    expect(ruSurface.table.some((r) => r.established === "Исследование остановилось раньше, чем удалось проверить этот пункт.")).toBe(true);
    // Presentation only: the same rows, statuses, boundaries and evidence in both languages.
    const shape = (x: typeof enSurface) =>
      x.table.map((r) => [r.component, r.status, r.kind, r.boundary?.kind ?? null, r.evidence.map((c) => [c.id, c.relation])]);
    expect(shape(ruSurface)).toEqual(shape(enSurface));
    expect(ruSurface.verdict).toBe(enSurface.verdict);
    expect(ruSurface.outcomeKind).toBe(enSurface.outcomeKind);
    expect(ruSurface.boundary.map((g) => [g.kind, g.items.map((i) => i.component)])).toEqual(
      enSurface.boundary.map((g) => [g.kind, g.items.map((i) => i.component)]),
    );
  });

  it("a question asked in Russian names its mechanism; a run without a verdict is told in Russian", () => {
    expect(mechanismNounOf(["Выкупает ли Raydium токен RAY за счёт торговых комиссий?"])).toBe("the buyback");
    expect(mechanismNounOf(["Сжигает ли Pump.fun токены?"])).toBe("the burn");
    expect(mechanismNounOf(["Куда идут награды стейкинга Lido?"])).toBe("the reward");
    expect(ruQuestionLabel("EXECUTION_EVIDENCE", "the burn")).toBe("Было ли сжигание фактически исполнено?");
    expect(ruQuestionLabel("EXECUTION_EVIDENCE", "the buyback")).toBe("Был ли выкуп фактически исполнен?");
    setDisplayLanguage("RU");
    for (const outcomeKind of ["FAILED", "CANCELLED", "STOPPED_AT_LIMIT", "NO_CONCLUSION", "IN_PROGRESS"] as const) {
      const sentences = researchAnswer({
        verdict: null,
        outcomeKind,
        projectName: "Raydium",
        components: [
          { component: "MECHANISM_SPEC", status: "SUPPORTED" },
          { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE" },
        ],
      });
      expect(sentences.length, outcomeKind).toBeGreaterThan(0);
      expect(englishLeftovers(sentences.join(" "), ["Raydium"]), outcomeKind).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* truthful beta states                                                */
/* ------------------------------------------------------------------ */

describe("the screens tell the canonical beta state truthfully", () => {
  it("betaBlockOf: paused, at capacity, allowance used up — or nothing", () => {
    const base = { privateBeta: { used: 0, limit: 3, remaining: 3, capacityReached: false }, betaPaused: false };
    expect(betaBlockOf(null)).toBeNull();
    expect(betaBlockOf(base)).toBeNull();
    expect(betaBlockOf({ ...base, betaPaused: true })).toBe("PAUSED");
    expect(betaBlockOf({ ...base, privateBeta: { ...base.privateBeta, capacityReached: true } })).toBe("CAPACITY");
    expect(betaBlockOf({ ...base, privateBeta: { ...base.privateBeta, used: 3, remaining: 0 } })).toBe("EXHAUSTED");
    expect(betaBlockOf({ privateBeta: null, betaPaused: false })).toBeNull();
  });

  it("/api/me: capacity reached, the beta paused, and DEMO available only when a DEMO Research could start", async () => {
    const c = await betaUser();
    expect((await me(c)).privateBeta).toMatchObject({ remaining: 3, capacityReached: false });
    expect((await me(c)).demoAvailable).toBe(false); // beta in force
    await openBeta({ globalResearchLimit: 0 });
    expect((await me(c)).privateBeta).toMatchObject({ remaining: 3, capacityReached: true });
    // Emergency stop: beta off, public research off.
    await openBeta({ enabled: false });
    const paused = await me(c);
    expect(paused.betaPaused).toBe(true);
    expect(paused.privateBeta).toBeNull();
    expect(paused.entitlement.level).toBe("ARI_CORE"); // storage level — the screens show "paused" instead
    expect(paused.demoAvailable).toBe(false);
    // A plain user with both switches off has no access and no DEMO offer.
    const plain = await authedUser();
    expect(await me(plain)).toMatchObject({ betaPaused: false, privateBeta: null, demoAvailable: false });
    // The owner is never shown as paused.
    expect((await me(await authedUser("ADMIN"))).betaPaused).toBe(false);
    await setResearchEnabled(true);
    await __resetRuntime();
    expect((await me(plain)).demoAvailable).toBe(true);
  });

  it("Profile shows no unavailable offer: no price, no DEMO counter unless usable, never ARI • CORE for a beta holder", () => {
    const profile = readFileSync("app/(app)/profile/page.tsx", "utf8");
    expect(profile).not.toContain("priceNote");
    expect(profile).not.toContain("priceStars");
    const line = profile.slice(profile.indexOf("const accessLine"), profile.indexOf("// Двойное подтверждение"));
    expect(line.indexOf("me.betaPaused")).toBeLessThan(line.indexOf('"ARI • CORE"'));
    expect(line.indexOf("me.privateBeta")).toBeLessThan(line.indexOf('"ARI • CORE"'));
    expect(line).toContain("if (me.demoAvailable)");
    expect(line).toContain("return dict.profile.noAccess;");
  });

  it("Home and Ask stop offering a new Research when blocked and point to the Library; Ask's first step says Continue", () => {
    const home = readFileSync("app/(app)/home/page.tsx", "utf8");
    expect(home).toMatch(/\{block \? \(\s*<BetaStatusNotice \/>\s*\) : \(\s*<section[^>]*home-composer/);
    expect(home).toContain("me?.privateBeta && !block");
    const ask = readFileSync("app/(app)/ask/page.tsx", "utf8");
    expect(ask).toContain('{phase === "input" && !block && (');
    expect(ask).toContain("{block && phase === \"input\" && <BetaStatusNotice />}");
    expect(ask).toContain("{dict.ask.continue}");
    const notice = readFileSync("src/client/components/beta-status-notice.tsx", "utf8");
    expect(notice).toContain('href="/research"');
    expect(en.ask.continue).toBe("Continue");
    expect(en.ask.submit).toBe("Start Proof");
    expect(en.home.betaPaused).toBe("Private beta is temporarily paused. Your previous Research is still available in your Research Library.");
    expect(en.ask.disabledNote).toBe(en.home.betaPaused);
    expect(en.home.betaExhausted(3)).toBe("You've used your 3 private-beta Research. Your completed Research remains available in Research Library.");
    expect(en.home.betaInviteUnavailable).toBe("This private beta invite is no longer available.");
    expect(en.ask.betaProjectNotAvailable).toContain("Raydium, Pump.fun and Lido");
    for (const copy of [en.ask.disabledNote, en.ask.betaResearchLimitReached]) expect(copy).not.toMatch(/being connected|upcoming update|research runs/);
  });

  it("every invite refusal but 'full' is one generic notice, never naming invalid / expired / disabled / revoked", () => {
    const appContext = readFileSync("src/client/app-context.tsx", "utf8");
    expect(appContext).toContain('(e.code === "INVITE_INVALID" || e.code === "INVITE_NOT_APPLICABLE")) setInviteNotice("UNAVAILABLE")');
    for (const d of [en, ru]) expect(d.home.betaInviteUnavailable).not.toMatch(/expired|revoked|disabled|invalid|истек|отозван|отключ|недействит/i);
  });

  it("Analytics is not in the navigation; its page still exists; the dock stays five cells", () => {
    const chrome = readFileSync("src/client/components/app-chrome.tsx", "utf8");
    expect(chrome).not.toMatch(/item\("analytics"|href: "\/analytics"|AnalyticsIcon/);
    expect(chrome).toContain('data-testid="dock-spacer"');
    expect(existsSync("app/(app)/analytics/page.tsx")).toBe(true);
  });

  it("the Result's boundary wording is plain and its canonical kind is unchanged", () => {
    const { detail } = resultFixture("4");
    const html = visible(renderToStaticMarkup(createElement(ResearchResult, { detail, jobId: detail.job.id })));
    expect(html).toContain("Not every source could be checked");
    expect(html).not.toContain("Research limit reached");
    expect(html).not.toContain("No supported source route yet");
    expect(renderToStaticMarkup(createElement(ResearchResult, { detail, jobId: detail.job.id }))).toContain('data-kind="TECHNICAL"');
  });

  it("feedback: announced at the top of the finished Result, the reason Send is disabled is shown; eligibility unchanged", () => {
    const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf8");
    expect(page).toContain('href="#beta-feedback"');
    expect(page.indexOf("beta-feedback-banner")).toBeLessThan(page.indexOf("<ResearchResult"));
    expect(page).toContain("{finished && detail.proof && me?.feedbackDue && <BetaFeedbackPrompt />}");
    const prompt = readFileSync("src/client/components/beta-feedback-prompt.tsx", "utf8");
    expect(prompt).toContain('id="beta-feedback"');
    expect(prompt).toContain("{keepUsing === null && (");
    expect(prompt).toContain("disabled={keepUsing === null || state === \"sending\"}");
  });
});

/* ------------------------------------------------------------------ */
/* bot                                                                 */
/* ------------------------------------------------------------------ */

describe("the bot never leads into a dead-end Verify flow", () => {
  let seq = 9_100_000;
  async function forwarder(opts: { grant: boolean; language?: "EN" | "RU" }) {
    const [u] = await ctx.db.insert(users).values({ role: "USER", language: opts.language ?? "EN" }).returning();
    seq += 1;
    await ctx.db.insert(userIdentities).values({ userId: u.id, provider: "TELEGRAM", providerUserId: String(seq) });
    if (opts.grant) await grantPrivateBetaAccess(ctx.db, { userId: u.id, validUntil: inDays(30) });
    return { userId: u.id, tgId: seq };
  }
  const updateFor = (tgId: number, text: string) => ({
    update_id: seq * 10 + Math.floor(Math.random() * 1000),
    message: { message_id: 1, chat: { id: tgId, type: "private" }, from: { id: tgId, is_bot: false }, text },
  });
  async function forward(tgId: number, text: string) {
    const sentMessages: OutboundMessage[] = [];
    const send = async (m: OutboundMessage): Promise<SendResult> => (sentMessages.push(m), { sent: true });
    const outcome = await handleTelegramUpdate(ctx.db, await loadProductConfig(ctx.db), updateFor(tgId, text), send);
    return { outcome, sent: sentMessages };
  }

  it("global capacity reached and personal allowance used up: an honest reply, no intake, no button", async () => {
    const full = await forwarder({ grant: true });
    await openBeta({ globalResearchLimit: 0 });
    const a = await forward(full.tgId, "Raydium buys back RAY");
    expect(a.outcome).toMatchObject({ action: "NO_RESEARCH_ACCESS", intakeId: null });
    expect(a.sent[0].text).toBe("Private beta is at capacity for now. Your previous Research is still available in your Research Library.");
    expect(a.sent[0].buttons).toBeUndefined();

    await openBeta({ researchLimit: 1 });
    const spent = await forwarder({ grant: true, language: "RU" });
    await admittedJob(spent.userId);
    const b = await forward(spent.tgId, "Raydium buys back RAY");
    expect(b.outcome).toMatchObject({ action: "NO_RESEARCH_ACCESS" });
    expect(b.sent[0].text).toBe("Вы использовали все исследования закрытой беты. Завершённые исследования остаются в Библиотеке исследований.");
  });

  it("a beta user with Research left still gets Verify with ATLAS, and nothing is granted to anyone", async () => {
    const ok = await forwarder({ grant: true });
    const r = await forward(ok.tgId, "Raydium buys back RAY with fees");
    expect(r.outcome).toMatchObject({ action: "VERIFY" });
    const stranger = await forwarder({ grant: false });
    const s = await forward(stranger.tgId, "Raydium buys back RAY");
    expect(s.outcome).toMatchObject({ action: "NO_RESEARCH_ACCESS" });
    const subs = await ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, stranger.userId));
    expect(subs).toHaveLength(0);
  });
});
