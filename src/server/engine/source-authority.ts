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

// `sourceType` mirrors the `sources` table's own enum
// (OFFICIAL_DOCS/GOVERNANCE/ONCHAIN/SECURITY/RESEARCH/NEWS/OTHER) — the
// "type" half of §7.2's "детерминирован, из URL и типа". It is populated
// deterministically by deriveSourceType() below, at the same URL-derived
// granularity as everything in this file.
//
// HIGH-B (S4 final re-review): OFFICIAL_DOCS and OFFICIAL_REPORT are
// structurally UNREACHABLE from this function on purpose. §7.2 describes
// them as "документация протокола" / "официальный дашборд/отчёт проекта"
// — inherently PROJECT-SPECIFIC concepts (every project has its own docs
// domain), and the only project-scoped signal this architecture currently
// has is `project_memory_items` SOURCE_ROUTE, whose `content` shape today
// carries only `{ domain }` — a human confirming "this domain belongs to
// project X" does NOT also tell us whether it is their docs site, their
// governance forum, or their transparency dashboard. Manufacturing that
// distinction here would be exactly the "random CONFIRMED project domain
// silently becomes another class through guesswork" defect the review
// explicitly prohibits. See the S4 final re-review report for the
// STRATEGY REVIEW REQUIRED note on the schema extension (an explicit,
// human-set `routeClass` on the confirmed SOURCE_ROUTE record) that would
// be needed to close this gap safely.
export function deriveSourceClass(
  url: string,
  sourceType: "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN" | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER",
): EvidenceSourceClass {
  const host = hostnameOf(url);
  if (sourceType === "ONCHAIN" || (host && ONCHAIN_EXPLORER_DOMAINS.has(host))) {
    return "ONCHAIN_VERIFIABLE";
  }
  if (host && SOCIAL_DOMAINS.has(host)) return "SOCIAL";
  if (host && DATA_PROVIDER_DOMAINS.has(host)) return "DATA_PROVIDER";
  if (sourceType === "GOVERNANCE" || (host && GOVERNANCE_PLATFORM_DOMAINS.has(host))) {
    return "GOVERNANCE";
  }
  if (sourceType === "RESEARCH" || sourceType === "NEWS" || (host && RESEARCH_MEDIA_DOMAINS.has(host))) {
    return "RESEARCH_MEDIA";
  }
  // SECURITY/OFFICIAL_DOCS/OTHER/unmapped — default to the weakest class,
  // never guess something stronger for an unrecognized domain. See the
  // doc comment above for why OFFICIAL_DOCS is intentionally not reachable
  // from `sourceType` here even though the Phase-1 `sources` enum has a
  // same-named value.
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

// project_memory_items.content is untyped jsonb at the DB layer (no
// existing producer writes SOURCE_ROUTE items yet) — this is the S4-
// introduced convention for its shape: { domain: "example.com" }.
interface SourceRouteContent {
  domain?: unknown;
}

// CONFIRMED iff an ACTIVE SOURCE_ROUTE item for THIS project names THIS
// exact domain (case-insensitive, "www." stripped the same way on both
// sides). Everything else — including a project without any SOURCE_ROUTE
// records, a job with no project, an inactive/DRAFT SOURCE_ROUTE, or a
// SOURCE_ROUTE belonging to a different project — is CLAIMED. There is no
// escalation path from CLAIMED to CONFIRMED that does not go through a
// human-approved ACTIVE row.
export async function resolveOfficiality(
  db: Database | Transaction,
  projectId: string | null,
  url: string,
): Promise<EvidenceOfficiality> {
  if (!projectId) return "CLAIMED";
  const host = hostnameOf(url);
  if (!host) return "CLAIMED";

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
    if (routeDomain === host) return "CONFIRMED";
  }
  return "CLAIMED";
}
