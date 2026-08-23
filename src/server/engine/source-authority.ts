import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { projectMemoryItems } from "../db/schema";
import type { EvidenceOfficiality, EvidenceSourceClass } from "./providers/types";

// Phase 6, S4 review fix (BLOCKER-1, D-074, phase-6-plan.md §7.2) —
// source authority is a CODE decision, never a model decision.
//
// §7.2 "Модель авторитета — две независимые оси":
//   Axis A (sourceClass) — deterministic, from the URL and the source's
//   own type. Axis B (officiality) — CONFIRMED only when a human
//   confirmed the domain belongs to the project
//   (project_memory_items.kind='SOURCE_ROUTE', lifecycleState='ACTIVE');
//   everything else is CLAIMED, regardless of how confidently a search
//   result or a model asserts otherwise. D-074: "Класс источника
//   (детерминированный) и официальность домена (подтверждённая
//   человеком) — независимые оси."
//
// EvidenceExtractor (the model role) is deliberately NOT asked for
// either of these two fields (see providers/types.ts, ExtractedFact) —
// there is nothing for a compromised/wrong model output to raise, because
// the fields don't exist in its output contract. This module is the only
// place that computes them, always from source properties already on
// record (URL, sources.sourceType) and from the project's own confirmed
// route records — never from anything the model or the search provider
// said about itself.

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// MEDIUM-3 (S4 final acceptance fix): safe hostname matching for a
// recognized platform base domain — the platform's own bare domain OR any
// of its subdomains (m.x.com, old.reddit.com, support.discord.com, ...)
// still count as that platform. `endsWith` alone is UNSAFE:
// "example.com.evil.com".endsWith("example.com") is true. The dot-boundary
// check is what makes this safe.
function matchesPlatformDomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function hostMatchesAnyPlatform(host: string, domains: ReadonlySet<string>): boolean {
  for (const base of domains) {
    if (matchesPlatformDomain(host, base)) return true;
  }
  return false;
}

// Small, fixed, code-owned domain lists — not a place for fuzzy/semantic
// matching. Unknown/unmapped domains deliberately fall through to the
// WEAKEST class (SOCIAL) rather than guessing something stronger: a
// classifier that defaults upward would be exactly the "model becomes
// authoritative" defect this fix closes, just moved into a lookup table
// instead of a prompt.
//
// HIGH-B/MEDIUM-3: every list below is deliberately project-INDEPENDENT —
// a shared, multi-tenant platform recognizable from its own domain (base
// domain OR subdomain — matchesPlatformDomain) alone, regardless of which
// project's job is running. OFFICIAL_DOCS and OFFICIAL_REPORT are NOT in
// this file — see the comment on resolveSourceClass below.
const ONCHAIN_EXPLORER_DOMAINS = new Set([
  "etherscan.io",
  "bscscan.com",
  "polygonscan.com",
  "arbiscan.io",
  "basescan.org",
  "solscan.io",
  "solana.fm",
  "snowtrace.io",
  "optimistic.etherscan.io",
]);

const SOCIAL_DOMAINS = new Set([
  "twitter.com",
  "x.com",
  "reddit.com",
  "t.me",
  "telegram.me",
  "discord.com",
  "discord.gg",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "warpcast.com",
]);

// Shared, multi-tenant governance/voting platforms — "форум/портал
// голосований" (§7.2) that is not any one project's own domain, so it is
// safe to recognize globally the same way an explorer is.
const GOVERNANCE_PLATFORM_DOMAINS = new Set([
  "snapshot.org",
  "snapshot.box",
  "commonwealth.im",
  "tally.xyz",
  "boardroom.io",
]);

// Independent data/analytics providers — "независимый провайдер
// данных/аналитики" (§7.2). Bounded, well-known, project-independent.
const DATA_PROVIDER_DOMAINS = new Set([
  "dune.com",
  "defillama.com",
  "tokenterminal.com",
  "messari.io",
  "coingecko.com",
  "nansen.ai",
]);

// Independent crypto research/media outlets — "независимое исследование,
// качественные медиа" (§7.2). Bounded, well-known, project-independent.
const RESEARCH_MEDIA_DOMAINS = new Set([
  "theblock.co",
  "coindesk.com",
  "decrypt.co",
  "cointelegraph.com",
  "blockworks.co",
  "thedefiant.io",
  "bankless.com",
]);

// Item 9 (S4 final acceptance fix): general-purpose, multi-tenant hosting
// platforms that are NOT in any class-specific list above (so they are not
// otherwise "publicly recognized" and would reach step 6), but where a
// bare, domain-only SOURCE_ROUTE must still NOT be trusted to elevate the
// entire shared platform to a project-specific strong class. A human who
// registers "github.com" (or "medium.com", "notion.site", ...) as their
// project's confirmed domain has confirmed nothing about which tenant on
// that shared host is theirs — SOURCE_ROUTE only stores a domain, never a
// path, so S4 has no safe way to know "github.com/OurOrg/docs" is the
// project's without inventing path-level tenancy tracking, which is
// explicitly out of scope here. A genuinely project-specific SUBDOMAIN
// (project.gitbook.io) is a different, safe case — see
// isBareSharedPlatformBase below, which blocks ONLY the exact base domain,
// never a subdomain of it.
const SHARED_MULTI_TENANT_PLATFORM_BASE_DOMAINS = new Set([
  "github.com",
  "gitbook.io",
  "medium.com",
  "mirror.xyz",
  "notion.site",
  "substack.com",
  "readthedocs.io",
]);

// True only for an EXACT shared-platform base domain (github.com), never
// for a subdomain of it (project.gitbook.io stays eligible for routeClass
// — it is a specific host, not the whole shared platform).
function isBareSharedPlatformBase(host: string): boolean {
  return SHARED_MULTI_TENANT_PLATFORM_BASE_DOMAINS.has(host);
}

// D-089's three project-specific classes — reachable ONLY via an explicit
// human-set `routeClass` on the exact ACTIVE SOURCE_ROUTE that also
// produced CONFIRMED for this project/domain (see resolveSourceRoute
// below). Never inferred from the URL, the page, the model, or the search
// provider.
export type RouteClass = "OFFICIAL_DOCS" | "GOVERNANCE" | "OFFICIAL_REPORT";
const VALID_ROUTE_CLASSES: readonly RouteClass[] = ["OFFICIAL_DOCS", "GOVERNANCE", "OFFICIAL_REPORT"];

// `sourceType` mirrors the `sources` table's own enum
// (OFFICIAL_DOCS/GOVERNANCE/ONCHAIN/SECURITY/RESEARCH/NEWS/OTHER) — the
// "type" half of §7.2's "детерминирован, из URL и типа". It is populated
// deterministically by deriveSourceType() below, at the same URL-derived
// granularity as everything in this file.
//
// D-089/§7.2a — exact locked precedence. `activeRouteClass` (read from the
// SAME ACTIVE SOURCE_ROUTE row that produced this project's CONFIRMED,
// never any other row — see resolveSourceRoute) is consulted ONLY at step
// 6, after every public/project-independent class has had a chance to
// positively recognize the domain, AND only when the domain is not itself
// a known shared multi-tenant hosting platform (item 9 above). This
// ordering is the whole point of D-089: a `routeClass` set on a shared,
// multi-tenant platform (snapshot.org, dune.com, github.com) or a social
// domain must NOT be able to lift SOCIAL/DATA_PROVIDER/GOVERNANCE — or an
// otherwise-unclassified shared host — into a strong project-specific
// class and walk around D-074's "SOCIAL never supports a conclusion".
export function resolveSourceClass(
  url: string,
  sourceType: "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN" | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER",
  activeRouteClass: RouteClass | null,
): EvidenceSourceClass {
  const host = hostnameOf(url);
  // 1. ONCHAIN / explorer
  if (sourceType === "ONCHAIN" || (host && hostMatchesAnyPlatform(host, ONCHAIN_EXPLORER_DOMAINS))) {
    return "ONCHAIN_VERIFIABLE";
  }
  // 2. recognised social domain
  if (host && hostMatchesAnyPlatform(host, SOCIAL_DOMAINS)) return "SOCIAL";
  // 3. recognised independent data provider
  if (host && hostMatchesAnyPlatform(host, DATA_PROVIDER_DOMAINS)) return "DATA_PROVIDER";
  // 4. recognised public governance platform
  if (sourceType === "GOVERNANCE" || (host && hostMatchesAnyPlatform(host, GOVERNANCE_PLATFORM_DOMAINS))) {
    return "GOVERNANCE";
  }
  // 5. recognised research/media source
  if (sourceType === "RESEARCH" || sourceType === "NEWS" || (host && hostMatchesAnyPlatform(host, RESEARCH_MEDIA_DOMAINS))) {
    return "RESEARCH_MEDIA";
  }
  // 6. otherwise unknown/unclassified domain — the ONLY point where a
  // project-specific routeClass may supply a strong class, and only if
  // the domain is not itself the bare base domain of a known shared,
  // multi-tenant hosting platform (item 9).
  if (activeRouteClass && !(host && isBareSharedPlatformBase(host))) {
    return activeRouteClass;
  }
  // Weakest class — never guess something stronger for an unrecognized
  // domain with no eligible human-confirmed project-specific class either.
  return "SOCIAL";
}

// Populates `sources.sourceType` deterministically FROM THE URL ALONE —
// project-independent, same discipline as resolveSourceClass. This is
// what closes "sources.sourceType is effectively always OTHER":
// findOrCreateSource calls this at insert time instead of leaving every
// row at the column's bare default. Its output is later consumed by
// resolveSourceClass above (steps 1/4/5 check `sourceType`), so a wrong
// or stale sourceType would directly change classification — this is
// verified end-to-end via the actual `sources` row, not just this
// function in isolation (see phase6-s4-executor.test.ts's HIGH-B suite).
export function deriveSourceType(
  url: string,
): "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN" | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER" {
  const host = hostnameOf(url);
  if (host && hostMatchesAnyPlatform(host, ONCHAIN_EXPLORER_DOMAINS)) return "ONCHAIN";
  if (host && hostMatchesAnyPlatform(host, GOVERNANCE_PLATFORM_DOMAINS)) return "GOVERNANCE";
  if (host && hostMatchesAnyPlatform(host, RESEARCH_MEDIA_DOMAINS)) return "RESEARCH";
  return "OTHER";
}

// project_memory_items.content is untyped jsonb at the DB layer. §7.2a
// (D-089) extends the S4-introduced `{ domain }` convention with one
// OPTIONAL field — no migration required, existing `{ domain }` rows stay
// fully valid and simply carry no project-specific class:
//   { domain: string, routeClass?: "OFFICIAL_DOCS" | "GOVERNANCE" | "OFFICIAL_REPORT" }
interface SourceRouteContent {
  domain?: unknown;
  routeClass?: unknown;
}

export interface ResolvedSourceRoute {
  officiality: EvidenceOfficiality;
  // Non-null ONLY when officiality is CONFIRMED and exactly one distinct
  // routeClass value was found across every matching ACTIVE row for this
  // project/domain (§7.2a rule 1, MEDIUM-2 conflict handling below).
  routeClass: RouteClass | null;
  // A short, bounded, safe-to-persist code identifying why routeClass
  // ended up null/ignored despite a matching CONFIRMED row — never a raw
  // dump of arbitrary jsonb (item 13). Absent when there was nothing to
  // observe (no match, or a clean single-row result).
  observation: "INVALID_ROUTE_CLASS" | "SOURCE_ROUTE_CONFLICT" | null;
}

function isValidRouteClass(value: unknown): value is RouteClass {
  return typeof value === "string" && (VALID_ROUTE_CLASSES as readonly string[]).includes(value);
}

// The single source of truth for BOTH axes' project-specific inputs. Reads
// EVERY ACTIVE SOURCE_ROUTE row that names this exact project+domain (not
// just the first one found) so the result never depends on PostgreSQL row/
// heap order — MEDIUM-2 (S4 final acceptance fix).
//
// CONFIRMED iff at least one ACTIVE SOURCE_ROUTE item for THIS project
// names THIS exact domain (case-insensitive, "www." stripped the same way
// on both sides). Everything else — including a project without any
// SOURCE_ROUTE records, a job with no project, an inactive/DRAFT
// SOURCE_ROUTE, or a SOURCE_ROUTE belonging to a different project — is
// CLAIMED (and routeClass is always null in that case). There is no
// escalation path from CLAIMED to CONFIRMED that does not go through a
// human-approved ACTIVE row, and no way for routeClass to leak from a row
// that did NOT match this exact project+domain.
export async function resolveSourceRoute(
  db: Database | Transaction,
  projectId: string | null,
  url: string,
): Promise<ResolvedSourceRoute> {
  const notFound: ResolvedSourceRoute = { officiality: "CLAIMED", routeClass: null, observation: null };
  if (!projectId) return notFound;
  const host = hostnameOf(url);
  if (!host) return notFound;

  const rows = await db
    .select({ content: projectMemoryItems.content })
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, projectId),
        eq(projectMemoryItems.kind, "SOURCE_ROUTE"),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );

  // MEDIUM-2: collect EVERY matching row for this exact domain — never
  // return on the first hit, which is exactly what makes a resolver
  // row-order-dependent.
  const matchingRouteClasses: (RouteClass | null)[] = [];
  let anyMatch = false;
  let sawInvalidRouteClass = false;
  for (const row of rows) {
    const content = row.content as SourceRouteContent;
    if (typeof content?.domain !== "string") continue;
    const routeDomain = content.domain.toLowerCase().replace(/^www\./, "");
    if (routeDomain !== host) continue;
    anyMatch = true;
    if (content.routeClass === undefined || content.routeClass === null) {
      matchingRouteClasses.push(null);
    } else if (isValidRouteClass(content.routeClass)) {
      matchingRouteClasses.push(content.routeClass);
    } else {
      // §7.2a rule 2: invalid value ignored as absent, not a job failure.
      sawInvalidRouteClass = true;
      matchingRouteClasses.push(null);
    }
  }
  if (!anyMatch) return notFound;

  // Domain ownership is unambiguous the moment ANY matching ACTIVE row
  // exists — every matching row agrees the domain belongs to this
  // project, so CONFIRMED is safe regardless of routeClass disagreement.
  const distinctNonNullRouteClasses = new Set(matchingRouteClasses.filter((c): c is RouteClass => c !== null));
  if (distinctNonNullRouteClasses.size > 1) {
    // MEDIUM-2: conflicting routeClass values across multiple ACTIVE rows
    // for the same project+domain — never choose an arbitrary winner.
    // routeClass becomes absent; officiality (domain ownership) is
    // preserved since that part is not in conflict.
    return { officiality: "CONFIRMED", routeClass: null, observation: "SOURCE_ROUTE_CONFLICT" };
  }
  const resolvedRouteClass = distinctNonNullRouteClasses.size === 1 ? [...distinctNonNullRouteClasses][0] : null;
  if (resolvedRouteClass === null && sawInvalidRouteClass) {
    return { officiality: "CONFIRMED", routeClass: null, observation: "INVALID_ROUTE_CLASS" };
  }
  return { officiality: "CONFIRMED", routeClass: resolvedRouteClass, observation: null };
}
