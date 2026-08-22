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

// Small, fixed, code-owned domain lists — not a place for fuzzy/semantic
// matching. Unknown/unmapped domains deliberately fall through to the
// WEAKEST class (SOCIAL) rather than guessing something stronger: a
// classifier that defaults upward would be exactly the "model becomes
// authoritative" defect this fix closes, just moved into a lookup table
// instead of a prompt.
//
// HIGH-B (S4 final re-review): every list below is deliberately
// project-INDEPENDENT — a shared, multi-tenant platform recognizable from
// its own domain alone, regardless of which project's job is running.
// OFFICIAL_DOCS and OFFICIAL_REPORT are NOT in this file (see the comment
// on deriveSourceClass below) — "documentation of THE protocol" and
// "official report of THE project" are inherently project-specific and
// cannot be derived from a global domain list without either guessing or
// silently promoting an unrelated CONFIRMED domain to a stronger class
// than officiality alone establishes (exactly what the review prohibits).
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
// positively recognize the domain. This ordering is the whole point of
// D-089: a `routeClass` set on a shared, multi-tenant platform (snapshot.org,
// dune.com) or a social domain must NOT be able to lift SOCIAL/DATA_PROVIDER/
// GOVERNANCE into a stronger project-specific class and walk around D-074's
// "SOCIAL never supports a conclusion" — confirming "this domain belongs to
// project X" is simply the wrong granularity for a whole shared domain.
export function resolveSourceClass(
  url: string,
  sourceType: "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN" | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER",
  activeRouteClass: RouteClass | null,
): EvidenceSourceClass {
  const host = hostnameOf(url);
  // 1. ONCHAIN / explorer
  if (sourceType === "ONCHAIN" || (host && ONCHAIN_EXPLORER_DOMAINS.has(host))) {
    return "ONCHAIN_VERIFIABLE";
  }
  // 2. recognised social domain
  if (host && SOCIAL_DOMAINS.has(host)) return "SOCIAL";
  // 3. recognised independent data provider
  if (host && DATA_PROVIDER_DOMAINS.has(host)) return "DATA_PROVIDER";
  // 4. recognised public governance platform
  if (sourceType === "GOVERNANCE" || (host && GOVERNANCE_PLATFORM_DOMAINS.has(host))) {
    return "GOVERNANCE";
  }
  // 5. recognised research/media source
  if (sourceType === "RESEARCH" || sourceType === "NEWS" || (host && RESEARCH_MEDIA_DOMAINS.has(host))) {
    return "RESEARCH_MEDIA";
  }
  // 6. otherwise unknown/unclassified domain — the ONLY point where a
  // project-specific routeClass may supply a strong class.
  if (activeRouteClass) return activeRouteClass;
  // Weakest class — never guess something stronger for an unrecognized
  // domain with no human-confirmed project-specific class either.
  return "SOCIAL";
}

// Populates `sources.sourceType` deterministically FROM THE URL ALONE —
// project-independent, same discipline as deriveSourceClass. This is what
// closes "sources.sourceType is effectively always OTHER": findOrCreateSource
// now calls this at insert time instead of leaving every row at the
// column's bare default.
export function deriveSourceType(
  url: string,
): "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN" | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER" {
  const host = hostnameOf(url);
  if (host && ONCHAIN_EXPLORER_DOMAINS.has(host)) return "ONCHAIN";
  if (host && GOVERNANCE_PLATFORM_DOMAINS.has(host)) return "GOVERNANCE";
  if (host && RESEARCH_MEDIA_DOMAINS.has(host)) return "RESEARCH";
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
  // Non-null ONLY when officiality is CONFIRMED and the SAME row also
  // carries a syntactically valid routeClass (§7.2a rule 1: "routeClass
  // авторитетен только когда сработала та же самая ACTIVE SOURCE_ROUTE-
  // запись, что дала officiality = CONFIRMED"). Precedence over the public
  // classifier is enforced by resolveSourceClass, not here — this function
  // only reports what the confirmed row actually said.
  routeClass: RouteClass | null;
  // Set when the matching ACTIVE row carried a routeClass value outside
  // the three valid ones — a human typo in free-form jsonb, per §7.2a rule
  // 2 ("значение вне разрешённого множества — игнорируется как
  // отсутствующее... факт игнорирования попадает в research_attempts как
  // наблюдение"). The job must NOT fail for this; the caller folds this
  // into the attempt's existing `reason` observation channel.
  invalidRouteClassObserved: string | null;
}

function isValidRouteClass(value: unknown): value is RouteClass {
  return typeof value === "string" && (VALID_ROUTE_CLASSES as readonly string[]).includes(value);
}

// The single source of truth for BOTH axes' project-specific inputs,
// resolved together from the SAME matching row — officiality and
// routeClass must never be read from two different SOURCE_ROUTE rows.
//
// CONFIRMED iff an ACTIVE SOURCE_ROUTE item for THIS project names THIS
// exact domain (case-insensitive, "www." stripped the same way on both
// sides). Everything else — including a project without any SOURCE_ROUTE
// records, a job with no project, an inactive/DRAFT SOURCE_ROUTE, or a
// SOURCE_ROUTE belonging to a different project — is CLAIMED (and
// routeClass is always null in that case: §7.2a rule 1). There is no
// escalation path from CLAIMED to CONFIRMED that does not go through a
// human-approved ACTIVE row, and no way for routeClass to leak from a row
// that did NOT match this exact project+domain.
export async function resolveSourceRoute(
  db: Database | Transaction,
  projectId: string | null,
  url: string,
): Promise<ResolvedSourceRoute> {
  const notFound: ResolvedSourceRoute = { officiality: "CLAIMED", routeClass: null, invalidRouteClassObserved: null };
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

  for (const row of rows) {
    const content = row.content as SourceRouteContent;
    if (typeof content?.domain !== "string") continue;
    const routeDomain = content.domain.toLowerCase().replace(/^www\./, "");
    if (routeDomain !== host) continue;
    // Exact matching ACTIVE row found — officiality is CONFIRMED
    // regardless of what routeClass (if anything) it carries.
    if (content.routeClass === undefined || content.routeClass === null) {
      return { officiality: "CONFIRMED", routeClass: null, invalidRouteClassObserved: null };
    }
    if (isValidRouteClass(content.routeClass)) {
      return { officiality: "CONFIRMED", routeClass: content.routeClass, invalidRouteClassObserved: null };
    }
    // §7.2a rule 2: invalid value ignored as absent, not a job failure —
    // observed for audit instead.
    return {
      officiality: "CONFIRMED",
      routeClass: null,
      invalidRouteClassObserved: String(content.routeClass),
    };
  }
  return notFound;
}
