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

// D-131 — TEST NETWORK explorer hosts. A live run admitted
// sepolia.etherscan.io as ONCHAIN_VERIFIABLE and used it to
// PARTIALLY_SUPPORT a NET_EFFECT claim about token supply. A testnet
// carries no production economic reality: its balances and supplies are
// free to mint and prove nothing about a real asset.
// matchesPlatformDomain deliberately treats any subdomain of a
// recognized explorer as that explorer (m.x.com, old.reddit.com) — right
// for social/media hosts, wrong here, because it silently promoted every
// testnet to production-grade on-chain authority.
//
// Project-independent and code-owned, exactly like the lists above:
// these are network names, never a project's or a chain's business.
const TESTNET_HOST_LABELS = new Set([
  "sepolia",
  "goerli",
  "ropsten",
  "rinkeby",
  "kovan",
  "holesky",
  "mumbai",
  "amoy",
  "testnet",
  "devnet",
  "fuji",
]);

// True when any dot-separated LABEL of the host is a known test network.
// Label-by-label rather than substring, so "sepolia.etherscan.io" and
// "testnet.bscscan.com" are caught while an unrelated host that merely
// contains the text inside a longer label is not.
export function isTestNetworkHost(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return host.split(".").some((label) => TESTNET_HOST_LABELS.has(label));
}

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
// EXPORTED so the owner confirmation tool refuses these from the SAME
// code-owned list, rather than growing its own opinion about which hosts
// are shared platforms.
export function isBareSharedPlatformBase(host: string): boolean {
  return SHARED_MULTI_TENANT_PLATFORM_BASE_DOMAINS.has(host);
}

// D-129 — the SAME code-owned lists above, read back out as "which
// domains does THIS module classify into THIS class". Acquisition
// (s4-executor) uses this to steer search toward hosts whose class the
// classifier can already recognize, instead of issuing generic queries
// and discarding whatever comes back.
//
// This is deliberately a READ of the existing classification authority,
// never a second, parallel notion of authority: every domain returned
// here is one resolveSourceClass() above would independently classify
// into the requested class from the URL alone. Nothing a model or a
// search provider says can add a domain to these sets.
//
// OFFICIAL_DOCS / OFFICIAL_REPORT are ABSENT on purpose — they have no
// code-owned domain list anywhere in this file, because per D-074 they
// are reachable only through a human-confirmed ACTIVE SOURCE_ROUTE for
// the specific project. Targeting for those two classes therefore comes
// exclusively from that human-confirmed record (see
// targetDomainsForClass's `confirmedRouteDomains` parameter) — the engine
// can never invent an "official" domain for a project on its own.
const CLASS_OWNED_DOMAINS: Partial<Record<EvidenceSourceClass, ReadonlySet<string>>> = {
  ONCHAIN_VERIFIABLE: ONCHAIN_EXPLORER_DOMAINS,
  GOVERNANCE: GOVERNANCE_PLATFORM_DOMAINS,
  DATA_PROVIDER: DATA_PROVIDER_DOMAINS,
  RESEARCH_MEDIA: RESEARCH_MEDIA_DOMAINS,
  SOCIAL: SOCIAL_DOMAINS,
};

// Domains worth STEERING SEARCH AT for a given admissible class.
//
// `confirmedRouteDomains` must contain only domains that already resolved
// to CONFIRMED officiality for THIS project with a routeClass equal to
// `sourceClass` (i.e. read from resolveSourceRoute's own output, which
// only ever reflects a human-approved ACTIVE SOURCE_ROUTE row). They are
// returned first because a project's own confirmed domain is a stronger
// acquisition target than a shared multi-tenant platform.
export function targetDomainsForClass(
  sourceClass: EvidenceSourceClass,
  confirmedRouteDomains: readonly string[] = [],
): string[] {
  const owned = CLASS_OWNED_DOMAINS[sourceClass];
  const platform = owned ? [...owned] : [];
  // Confirmed project domains first, then the code-owned platforms, with
  // duplicates removed so one domain can never be targeted twice (and so
  // it can never look like two independent sources — see D-129 note in
  // s4-executor about alias/domain duplication).
  return [...new Set([...confirmedRouteDomains, ...platform])];
}

// True when the class has NO code-owned domain list, i.e. it can only be
// reached through a human-confirmed SOURCE_ROUTE. Callers use this to
// report honestly that a component's required class is unreachable for a
// project with no confirmed routes, rather than silently searching for
// something that can never be classified into it.
export function classRequiresConfirmedRoute(sourceClass: EvidenceSourceClass): boolean {
  return CLASS_OWNED_DOMAINS[sourceClass] === undefined;
}

// D-089's three project-specific classes — reachable ONLY via an explicit
// human-set `routeClass` on the exact ACTIVE SOURCE_ROUTE that also
// produced CONFIRMED for this project/domain (see resolveSourceRoute
// below). Never inferred from the URL, the page, the model, or the search
// provider.
export type RouteClass = "OFFICIAL_DOCS" | "GOVERNANCE" | "OFFICIAL_REPORT";
// EXPORTED so the owner classification tool validates against THIS list
// rather than growing a second opinion about what a route class is.
export const VALID_ROUTE_CLASSES: readonly RouteClass[] = ["OFFICIAL_DOCS", "GOVERNANCE", "OFFICIAL_REPORT"];

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
  // 0. D-131 — a TEST network explorer is never production on-chain
  // authority. Falls through to the weakest class (SOCIAL) like any other
  // unrecognized host, so it can still be recorded and read as context
  // but can never establish a component whose Pattern requires
  // ONCHAIN_VERIFIABLE. Checked FIRST so it cannot be rescued by the
  // sourceType==="ONCHAIN" branch either.
  if (isTestNetworkHost(url)) return "SOCIAL";
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
// (D-089) extends the S4-introduced `{ domain }` convention with two
// OPTIONAL fields — no migration required, existing `{ domain }` rows stay
// fully valid and simply carry no project-specific class:
//   { domain: string, routeClass?: RouteClass, pathPrefix?: string }
//
// D-135 — pathPrefix is what separates "this domain is CONFIRMED as the
// project's own" (officiality, domain-wide — a human really does own the
// whole domain) from "this SPECIFIC path is documentation/governance/a
// report" (routeClass, which must not silently spread across an entire
// official domain just because one page on it was confirmed). Without
// this, confirming pump.fun/docs as OFFICIAL_DOCS made pump.fun/anything
// classify as OFFICIAL_DOCS too — too broad, and not what "confirmed
// docs live at /docs" actually means.
//
// Omitting pathPrefix keeps the pre-D-135 domain-wide behaviour exactly —
// existing routes with no pathPrefix are unaffected.
interface SourceRouteContent {
  domain?: unknown;
  routeClass?: unknown;
  pathPrefix?: unknown;
}

// Safe prefix match with a segment boundary, same discipline as
// matchesPlatformDomain's dot-boundary check: "/doc" must not match
// "/documentation". "/docs" matches "/docs" and "/docs/x", never
// "/docsomething".
// EXPORTED so a route being CONFIRMED is normalized by the same rule that
// will later match it. A second copy of this would be a second notion of
// authority, which is the one thing this module must not have.
export function normalizePathPrefix(p: string): string {
  const withLeadingSlash = p.startsWith("/") ? p : `/${p}`;
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

// EXPORTED for the same reason: the owner confirmation tool has to know
// whether a proposed prefix would co-match an existing ACTIVE row's, and
// it must ask THIS rule rather than approximate it.
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  const normalizedPrefix = normalizePathPrefix(prefix);
  const normalizedPath = normalizePathPrefix(pathname);
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
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
  // Stage 0 (embedded docs payload recovery) — the pathPrefix that
  // actually matched this url, when the routeClass came from a
  // path-scoped row. NULL when the class came from a bare domain-wide row
  // (or when there is no class at all).
  //
  // Needed because routeClass === "OFFICIAL_DOCS" alone does not
  // distinguish "this SPECIFIC path is confirmed documentation" from "the
  // whole domain was confirmed as docs" — and the Stage 0 capability is
  // deliberately granted only to the former. Purely informational: no
  // existing decision reads it, and officiality/routeClass are unchanged.
  matchedPathPrefix: string | null;
}

// EXPORTED for the same reason: one predicate, used by the resolver that
// reads a stored class and by the tool that writes one.
export function isValidRouteClass(value: unknown): value is RouteClass {
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
  const notFound: ResolvedSourceRoute = { officiality: "CLAIMED", routeClass: null, observation: null, matchedPathPrefix: null };
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

  // D-135: officiality is decided by domain match alone (a human really
  // does own the whole domain), but routeClass is decided only among rows
  // whose pathPrefix — if any — the REQUESTED url's path actually matches.
  // A row with no pathPrefix still applies domain-wide, unchanged from
  // before D-135; this is purely additive.
  const requestedPath = pathnameOf(url);

  // MEDIUM-2: collect EVERY matching row for this exact domain — never
  // return on the first hit, which is exactly what makes a resolver
  // row-order-dependent.
  const matchingRouteClasses: (RouteClass | null)[] = [];
  // Prefixes of rows whose routeClass applied to THIS url (path-scoped only).
  const matchedPathPrefixes: string[] = [];
  let anyMatch = false;
  let sawInvalidRouteClass = false;
  for (const row of rows) {
    const content = row.content as SourceRouteContent;
    if (typeof content?.domain !== "string") continue;
    const routeDomain = content.domain.toLowerCase().replace(/^www\./, "");
    if (routeDomain !== host) continue;
    // Officiality (domain ownership) is confirmed by this match
    // regardless of path — a human confirmed the DOMAIN is theirs.
    anyMatch = true;

    const pathPrefix = typeof content.pathPrefix === "string" ? content.pathPrefix : null;
    if (pathPrefix !== null && !matchesPathPrefix(requestedPath, pathPrefix)) {
      // This row's routeClass does not apply to THIS url's path — it
      // contributes to officiality above and nothing else for this call.
      continue;
    }

    if (pathPrefix !== null) matchedPathPrefixes.push(pathPrefix);
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
    return { officiality: "CONFIRMED", routeClass: null, observation: "SOURCE_ROUTE_CONFLICT", matchedPathPrefix: null };
  }
  const resolvedRouteClass = distinctNonNullRouteClasses.size === 1 ? [...distinctNonNullRouteClasses][0] : null;
  if (resolvedRouteClass === null && sawInvalidRouteClass) {
    return { officiality: "CONFIRMED", routeClass: null, observation: "INVALID_ROUTE_CLASS", matchedPathPrefix: null };
  }
  return {
    officiality: "CONFIRMED",
    routeClass: resolvedRouteClass,
    observation: null,
    // Reported whenever exactly one PATH-SCOPED row matched this url,
    // INDEPENDENT of whether that row carried a routeClass. A confirmed
    // route may legitimately grant officiality without granting
    // documentation authority, and a caller needs to distinguish "a
    // path-scoped row matched but conferred no class" from "no path-scoped
    // row matched at all". Both existing consumers additionally require
    // routeClass === "OFFICIAL_DOCS", so widening this cannot change what
    // they admit.
    matchedPathPrefix: matchedPathPrefixes.length === 1 ? matchedPathPrefixes[0] : null,
  };
}
