import { existsSync, readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import PulsePage from "../app/(app)/pulse/page";
import { DictScope } from "../src/client/app-context";
import { projectInitials } from "../src/client/components/project-avatar";
import { PulseCard } from "../src/client/components/pulse-card";
import { setDisplayLanguage } from "../src/client/display-language";
import { en, type Dict } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import {
  PULSE_FRESH_HOURS,
  PULSE_MAX_EARLIER,
  PULSE_MAX_FRESH,
  pulseItemById,
  pulseItems,
  pulsePublishedAt,
  splitPulseFeed,
} from "../src/client/pulse-fixtures";
import { pulseIdFromSearch, pulseIdOf, verifyPathForPulse } from "../src/client/pulse-launch";
import { researchJobs } from "../src/server/db/schema";
import { __resetRuntime } from "../src/server/runtime";
import { countPrivateBetaAdmissions } from "../src/server/services/private-beta";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

// D-172 — PHASE A: PULSE OFFLINE PROTOTYPE AND THE NEW NAVIGATION.
//
// Pulse — [Verify] — Proofs. Verify is the existing Home screen; Proofs is
// the existing Research Library; Pulse is new, fed by local deterministic
// fixtures. A Pulse card is discovery input only: tapping Verify prefills
// the existing Home input with the source text, verbatim and editable, and
// creates, spends and calls nothing. Everything below is offline.

const CHROME = "src/client/components/app-chrome.tsx";
const HOME = "app/(app)/home/page.tsx";
const COMPOSER = "src/client/components/research-composer.tsx";
const FIXTURES = "src/client/pulse-fixtures.ts";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

const visible = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const renderPulse = (dict: Dict) => renderToStaticMarkup(createElement(DictScope, { dict }, createElement(PulsePage)));

// No render may leave the process: fetch is replaced for the duration.
function withNoNetwork<T>(fn: () => T): T {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("network call from Pulse");
  }) as typeof fetch;
  try {
    const out = fn();
    expect(calls).toBe(0);
    return out;
  } finally {
    globalThis.fetch = real;
  }
}

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  setDisplayLanguage("EN");
  await __resetRuntime();
  await ctx.close();
});

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

describe("navigation: Pulse — Verify — Proofs, Profile top-right", () => {
  it("the dock has exactly Pulse, Verify and Proofs; Verify is the central AP shield and links to /home", () => {
    const chrome = codeOf(CHROME);
    const dock = chrome.slice(chrome.indexOf("export function AtlasDock"));
    // The two side places render through `item(key)` → data-testid="dock-<key>".
    expect(dock).toContain("data-testid={`dock-${key}`}");
    expect(dock).toContain('item("pulse"');
    expect(dock).toContain('item("proofs"');
    expect(dock).toContain('data-testid="dock-verify"');
    expect(dock).not.toMatch(/"profile"|"home"|"ask"|"research"|"analytics"|dock-spacer/);
    // The shield sits between Pulse and Proofs, raised from the centre.
    expect(dock.indexOf('item("pulse"')).toBeLessThan(dock.indexOf("dock-verify"));
    expect(dock.indexOf("dock-verify")).toBeLessThan(dock.indexOf('item("proofs"'));
    expect(dock).toContain("<AtlasMark size={56} />");
    expect(dock).toContain('className={`dock-home ${pathname === VERIFY_HREF ? "home-orb-active" : ""}`}');
    expect(chrome).toContain('const VERIFY_HREF = "/home";');
    expect(chrome).toContain('pulse: { href: "/pulse" }');
    expect(chrome).toContain('proofs: { href: "/research" }');
    expect(readFileSync("app/globals.css", "utf8")).toMatch(/\.dock \{[^}]*grid-template-columns: repeat\(3, 1fr\)/);
  });

  it("Profile is absent from the dock and present at the top-right of the header on every width", () => {
    const chrome = codeOf(CHROME);
    const header = chrome.slice(chrome.indexOf("export function AppHeader"), chrome.indexOf("export function AtlasDock"));
    expect(header).toContain('data-testid="nav-profile"');
    expect(chrome).toContain('const PROFILE_HREF = "/profile";');
    // Rendered on a handset too: no `hidden` on the link itself, only on its word.
    expect(header).toMatch(/className=\{`profile-link ml-auto sm:ml-0/);
    expect(header).toContain('<span className="hidden sm:inline">{dict.nav.profile}</span>');
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/\.profile-link \{\s*display: inline-flex;/);
    expect(existsSync("app/(app)/profile/page.tsx")).toBe(true);
  });

  it("the header carries the same three places: Pulse · shield (→ /home) · Proofs", () => {
    const chrome = codeOf(CHROME);
    const header = chrome.slice(chrome.indexOf("export function AppHeader"), chrome.indexOf("export function AtlasDock"));
    expect(header).toContain('data-testid="nav-verify"');
    expect(header).toContain("{item(\"pulse\", <PulseIcon size={16} />)}");
    expect(header).toContain("{item(\"proofs\", <ResearchIcon size={16} />");
    expect(header).not.toMatch(/"home"|"ask"|"research"|AnalyticsIcon/);
  });

  it("a Result stays contextual under Proofs: /research/[id] lights the Proofs place, no dock item points at a Result", () => {
    const chrome = codeOf(CHROME);
    expect(chrome).toContain("return pathname === href || pathname.startsWith(`${href}/`);");
    expect(chrome).not.toMatch(/\/research\/\$\{|\/research\/\[/);
    expect(existsSync("app/(app)/research/[id]/page.tsx")).toBe(true);
    expect(existsSync("app/(app)/research/page.tsx")).toBe(true);
    expect(existsSync("app/(app)/pulse/page.tsx")).toBe(true);
  });

  it("the labels come from both dictionaries", () => {
    for (const d of [en, ru]) {
      expect(d.nav.pulse).toBeTruthy();
      expect(d.nav.verify).toBeTruthy();
      expect(d.nav.proofs).toBeTruthy();
    }
    expect(en.nav).toMatchObject({ pulse: "Pulse", verify: "Verify", proofs: "Proofs" });
    expect(ru.nav.verify).toBe("Проверить");
  });
});

/* ------------------------------------------------------------------ */
/* Pulse                                                               */
/* ------------------------------------------------------------------ */

describe("Pulse: a deterministic offline feed, honest about what it is", () => {
  it("fixtures have a valid deterministic shape, X only, no fabricated provenance", () => {
    const items = pulseItems();
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items.length).toBeLessThanOrEqual(8);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const i of items) {
      expect(i.id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
      expect(i.project.name).toBeTruthy();
      expect(i.source.displayName).toBeTruthy();
      expect(i.source.handle).toMatch(/^@[A-Za-z0-9_]{1,15}$/);
      expect(["OFFICIAL_PROJECT", "RESEARCH_DATA"]).toContain(i.source.type);
      expect(i.text.trim().length).toBeGreaterThan(20);
      expect(i.text.length).toBeLessThanOrEqual(2000);
      expect(i.ageHours).toBeGreaterThan(0);
      // No invented post id, status URL or link of any kind.
      expect(i.sourceUrl).toBeNull();
      expect(i.text).not.toMatch(/https?:\/\/|x\.com|twitter\.com|\/status\//i);
    }
    // Scanned over the CODE: the file's own comment names the thing it bans.
    expect(codeOf(FIXTURES)).not.toMatch(/x\.com|twitter\.com|\/status\//i);
    // Deterministic: the same instant gives the same instants.
    expect(items.map((i) => pulsePublishedAt(i, NOW))).toEqual(items.map((i) => pulsePublishedAt(i, NOW)));
    expect(pulseItemById(items[0].id)).toEqual(items[0]);
    expect(pulseItemById("no-such-item")).toBeNull();
  });

  it("newest first; fresh (≤48 h) and Earlier never mix; 8–12 is a cap, not a minimum", () => {
    const { fresh, earlier } = splitPulseFeed(pulseItems());
    expect(PULSE_FRESH_HOURS).toBe(48);
    expect(fresh.every((i) => i.ageHours <= 48)).toBe(true);
    expect(earlier.every((i) => i.ageHours > 48)).toBe(true);
    for (const list of [fresh, earlier]) {
      for (let k = 1; k < list.length; k++) expect(list[k - 1].ageHours).toBeLessThanOrEqual(list[k].ageHours);
    }
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    expect(fresh.length).toBeLessThanOrEqual(PULSE_MAX_FRESH);
    expect(earlier.length).toBeLessThanOrEqual(PULSE_MAX_EARLIER);
    // A thin day stays thin: the cap never pads the feed.
    const thin = splitPulseFeed(pulseItems().slice(0, 2));
    expect(thin.fresh).toHaveLength(2);
    expect(thin.earlier).toHaveLength(0);
    expect(splitPulseFeed([])).toEqual({ fresh: [], earlier: [] });
  });

  it("/pulse renders every fixture verbatim, says it is sample data and discovery only, and never a fake X link", () => {
    setDisplayLanguage("EN");
    const html = withNoNetwork(() => renderPulse(en));
    const text = visible(html);
    for (const i of pulseItems()) {
      expect(text).toContain(i.text);
      expect(text).toContain(i.source.handle);
      expect(text).toContain(i.source.displayName);
    }
    expect(html).toContain('data-testid="pulse-sample-notice"');
    expect(text).toContain(en.pulse.sampleTitle);
    expect(en.pulse.sampleTitle).toBe("Sample data · prototype");
    expect(text).toContain(en.pulse.note);
    expect(html).toContain('data-testid="pulse-fresh"');
    expect(html).toContain('data-testid="pulse-earlier"');
    expect(html).not.toContain('data-testid="pulse-open-source"');
    expect(html).not.toMatch(/x\.com|twitter\.com/);
    // Every card's Verify goes to the existing Home with only the id.
    const links = [...html.matchAll(/href="\/home\?pulse=([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(links.sort()).toEqual(pulseItems().map((i) => i.id).sort());
    expect(html).not.toMatch(/pulse=[^"&]*%20|pulse=[^"&]*\+/);
  });

  it("Russian: every ATLAS-owned word is Russian; the source text, handles and names stay as written", () => {
    setDisplayLanguage("RU");
    const text = visible(renderPulse(ru));
    // The record's own words, longest first so "@LidoFinance" goes before
    // "Lido"; the avatar shows the ticker's initials.
    const record = pulseItems()
      .flatMap((i) => [i.text, i.source.handle, i.source.displayName, i.project.name, i.project.ticker ?? "", projectInitials(i.project.name, i.project.ticker)])
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    let t = text;
    for (const r of record) t = t.split(r).join(" ");
    // The sample notice is ATLAS's own copy, so it must be Russian here too.
    expect(text).toContain(ru.pulse.sampleTitle);
    expect(text).not.toContain(en.pulse.sampleTitle);
    const latin = [...t.matchAll(/[A-Za-z][A-Za-z'’]*/g)].map((m) => m[0]).filter((w) => !["ATLAS", "X", "Pulse"].includes(w));
    expect(latin).toEqual([]);
    expect(text).toContain(ru.pulse.fresh);
    expect(text).toContain(ru.pulse.earlier);
    expect(text).toContain(ru.pulse.verify);
    // Ages follow the display language.
    const card = visible(renderToStaticMarkup(createElement(DictScope, { dict: ru }, createElement("ul", null, createElement(PulseCard, { item: pulseItems()[0], now: NOW })))));
    expect(card).toMatch(/назад/);
    setDisplayLanguage("EN");
  });

  it("the Pulse screen and card carry no hard-coded English, and the dictionaries stay in parity", () => {
    const keys = (o: unknown, p = ""): string[] =>
      o === null || typeof o !== "object" || Array.isArray(o) ? [p] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k));
    expect(keys(ru.pulse).sort()).toEqual(keys(en.pulse).sort());
    const offenders: string[] = [];
    for (const file of ["app/(app)/pulse/page.tsx", "src/client/components/pulse-card.tsx", CHROME]) {
      for (const m of codeOf(file).matchAll(/(?<!=)>\s*([A-Za-z][A-Za-z ,.'’!?:-]{2,})\s*</g)) {
        if (!/^(ATLAS|PROOF|ATLAS PROOF)$/.test(m[1].trim())) offenders.push(`${file}: "${m[1].trim()}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sample cards exist only outside a production build (the showcases' own guard)", () => {
    const src = readFileSync(FIXTURES, "utf8");
    expect(src).toContain('if (process.env.NODE_ENV === "production") return [];');
    expect(readFileSync("app/(app)/pulse/page.tsx", "utf8")).toContain("pulseItems()");
  });
});


/* ------------------------------------------------------------------ */
/* handoff                                                             */
/* ------------------------------------------------------------------ */

describe("Pulse → Verify: a prefill of the existing Home input, nothing more", () => {
  it("only the id travels; a bad id is refused honestly", () => {
    const item = pulseItems()[0];
    expect(verifyPathForPulse(item.id)).toBe(`/home?pulse=${item.id}`);
    expect(pulseIdFromSearch(`?pulse=${item.id}`)).toBe(item.id);
    expect(pulseIdFromSearch("?pulse=../etc")).toBeNull();
    expect(pulseIdFromSearch("?pulse=")).toBeNull();
    expect(pulseIdFromSearch("")).toBeNull();
    expect(pulseIdOf("A".repeat(80))).toBeNull();
    expect(pulseItemById(pulseIdFromSearch("?pulse=does-not-exist")!)).toBeNull();
  });

  it("Home reads ?pulse=<id>, prefills the EXISTING composer with the exact text, keeps it editable, and names the source", () => {
    const home = codeOf(HOME);
    expect(home).toContain("pulseIdFromSearch(window.location.search)");
    expect(home).toContain("pulseItemById(id)");
    expect(home).toContain('setPulse(item ? { kind: "open", item } : { kind: "unavailable" })');
    expect(home).toContain('initialQuestion={pulse.kind === "open" ? pulse.item.text : ""}');
    expect(home).toContain('key={pulse.kind === "open" ? pulse.item.id : "plain"}');
    expect(home).toContain("dict.pulse.fromPulse(pulse.item.source.handle)");
    expect(home).toContain("dict.pulse.unavailable");
    // The composer takes the text into its own editable state and nothing else changed:
    // the same interpret → gate → startResearch flow, the same idempotency key.
    const composer = codeOf(COMPOSER);
    expect(composer).toContain("const [question, setQuestion] = useState(initialQuestion);");
    expect(composer).toContain("setResult(await api.interpret(question));");
    expect(composer).toContain("await api.startResearch(interp.id, crypto.randomUUID());");
    // (`pulse-dot` is the composer's existing spinner class, not Pulse.)
    expect(composer).not.toMatch(/pulse(?!-dot)|intake/i);
    // No Telegram intake, no second entry flow, no text in a URL.
    expect(home).not.toMatch(/getIntake|intakeId|ResearchIntake/);
    expect(codeOf("src/client/pulse-launch.ts")).not.toMatch(/text|encodeURIComponent/);
  });

  it("opening Pulse and preparing a Verify handoff creates no job, spends nothing and calls nothing", async () => {
    const ledger = async () => ({
      jobs: (await ctx.db.select({ id: researchJobs.id }).from(researchJobs)).length,
      beta: await countPrivateBetaAdmissions(ctx.db),
      queued: ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created','active','retry')`)).rows[0] as { n: number }).n,
    });
    const before = await ledger();
    const item = pulseItems()[0];
    withNoNetwork(() => {
      renderPulse(en);
      const id = pulseIdFromSearch(`?pulse=${item.id}`)!;
      const found = pulseItemById(id)!;
      expect(found.text).toBe(item.text);
    });
    expect(await ledger()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* regression                                                          */
/* ------------------------------------------------------------------ */

describe("what Phase A must not have touched", () => {
  it("the Home research flow, the Library and the Result routes are structurally unchanged", () => {
    const home = readFileSync(HOME, "utf8");
    expect(home).toMatch(/\{block \? \(\s*<BetaStatusNotice \/>\s*\) : \(\s*<section[^>]*home-composer/);
    expect(home).toContain('<Link href="/research"');
    expect(home).toContain("<RecentProofCard key={job.id} job={job}");
    expect(existsSync("app/(app)/ask/page.tsx")).toBe(true);
    expect(readFileSync("app/(app)/research/page.tsx", "utf8")).toContain("<ResearchGroupCard key={group.key} group={group} />");
    expect(readFileSync("src/client/components/research-group-card.tsx", "utf8")).toContain("href={`/research/${");
    // Nothing under src/server knows Pulse exists.
    expect(existsSync("src/server/pulse")).toBe(false);
    expect(readFileSync("src/server/db/schema/index.ts", "utf8")).not.toMatch(/pulse/i);
    expect(existsSync("src/server/db/migrations/0066_pulse.sql")).toBe(false);
  });
});
