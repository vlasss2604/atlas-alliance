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

// A small, fixed, code-owned domain list — not a place for fuzzy/semantic
// matching. Unknown/unmapped domains deliberately fall through to the
// WEAKEST class (SOCIAL) rather than guessing something stronger: a
// classifier that defaults upward would be exactly the "model becomes
// authoritative" defect this fix closes, just moved into a lookup table
// instead of a prompt.
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

// `sourceType` mirrors the `sources` table's own enum
// (OFFICIAL_DOCS/GOVERNANCE/ONCHAIN/SECURITY/RESEARCH/NEWS/OTHER) — the
// "type" half of §7.2's "детерминирован, из URL и типа".
export function deriveSourceClass(
  url: string,
  sourceType: "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN" | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER",
): EvidenceSourceClass {
  const host = hostnameOf(url);
  if (sourceType === "ONCHAIN" || (host && ONCHAIN_EXPLORER_DOMAINS.has(host))) {
    return "ONCHAIN_VERIFIABLE";
  }
  if (host && SOCIAL_DOMAINS.has(host)) return "SOCIAL";
  if (sourceType === "GOVERNANCE") return "GOVERNANCE";
  if (sourceType === "OFFICIAL_DOCS") return "OFFICIAL_DOCS";
  if (sourceType === "RESEARCH" || sourceType === "NEWS") return "RESEARCH_MEDIA";
  // SECURITY/OTHER/unmapped — default to the weakest class, never guess
  // something stronger for an unrecognized domain.
  return "SOCIAL";
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
