import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { projectMemoryItems, projects } from "../db/schema";
import { loadAcquisitionPlan } from "../engine/acquisition-plan";
import { isCommunityHost, resolveSourceRoute, type RouteClass } from "../engine/source-authority";
import {
  candidateDomainOf,
  candidateProvenanceOf,
  parentConfirmedDomainOf,
  proposedPrefixOf,
} from "../engine/source-route-candidates";

// OWNER ROUTE-CANDIDATE REVIEW (Source Authority Strategy V1, P0).
//
// The engine OBSERVES route candidates (source-route-candidates.ts): hosts
// nobody has an opinion about, project-owned subdomains of a confirmed
// host, and paths on a confirmed host outside every confirmed prefix. Until
// now the owner could only see them per job (alpha-inspect). This module is
// the per-PROJECT queue: every OBSERVED candidate, ranked so the decisions
// that matter most come first, with the facts a human needs to decide.
//
// DISCOVERY != AUTHORITY. Everything here is READ-ONLY except one act —
// rejecting a candidate (OBSERVED -> DEPRECATED) — and nothing here
// confirms a host, writes a prefix or assigns a class. The ranking and the
// class hint are ADVICE for the human: no mutation path in the codebase
// reads them (a structural test pins that), so a hint can never become a
// class by any route other than the owner typing it.

export type OwnershipSignal =
  // A path on a host a human already CONFIRMED (the candidate carries a
  // proposedPrefix). Ownership is the human's existing decision; only the
  // prefix and its class are open.
  | "PATH_ON_CONFIRMED_HOST"
  // A strict subdomain of a host that resolves CONFIRMED now (dot-boundary,
  // exact parent host — never a registrable-domain guess). Whoever controls
  // the parent's DNS controls this host; that is a SIGNAL, not a confirmation.
  | "SUBDOMAIN_OF_CONFIRMED_HOST";

export interface RouteClassHint {
  routeClass: RouteClass;
  // The exact word the hint came from, so the owner sees how thin it is.
  basis: string;
}

export interface RouteCandidateReviewItem {
  id: string;
  domain: string;
  proposedPrefix: string | null;
  firstJobId: string | null;
  evidenceCount: number;
  components: string[];
  // The subset of `components` that were critical in the job that first
  // observed the candidate (that job's intent, Pattern data).
  criticalComponents: string[];
  representativeUrls: string[];
  signals: OwnershipSignal[];
  parentConfirmedDomain: string | null;
  communityHost: boolean;
  // NON-BINDING. Never read by any owner mutation; the owner must name the
  // class explicitly.
  classHint: RouteClassHint | null;
  createdAt: Date;
}

export interface RouteCandidateReview {
  projectId: string;
  // OBSERVED candidates still waiting for an owner decision, best first.
  pending: RouteCandidateReviewItem[];
  // OBSERVED candidates an ACTIVE route has since covered (the owner
  // confirmed the host, or a prefix covering the proposal). Nothing to do.
  covered: RouteCandidateReviewItem[];
}

export const MAX_REVIEW_URLS = 3;

// Words in a subdomain label or proposed path segment, and the class they
// SUGGEST. Deliberately small and literal. Two different suggestions, or
// none, yield no hint at all — the hint never guesses.
const HINT_WORDS: Readonly<Record<string, RouteClass>> = {
  docs: "OFFICIAL_DOCS",
  doc: "OFFICIAL_DOCS",
  documentation: "OFFICIAL_DOCS",
  developers: "OFFICIAL_DOCS",
  whitepaper: "OFFICIAL_DOCS",
  litepaper: "OFFICIAL_DOCS",
  governance: "GOVERNANCE",
  gov: "GOVERNANCE",
  proposals: "GOVERNANCE",
  proposal: "GOVERNANCE",
  dao: "GOVERNANCE",
  vote: "GOVERNANCE",
  voting: "GOVERNANCE",
  reports: "OFFICIAL_REPORT",
  report: "OFFICIAL_REPORT",
  transparency: "OFFICIAL_REPORT",
};

export function suggestRouteClassHint(domain: string, proposedPrefix: string | null): RouteClassHint | null {
  // Subdomain labels only: every label but the last two, which name the
  // site itself and say nothing about the section.
  const words: { word: string; where: "host" | "path" }[] = [
    ...domain.toLowerCase().split(".").slice(0, -2).map((word) => ({ word, where: "host" as const })),
    ...(proposedPrefix ?? "")
      .toLowerCase()
      .split("/")
      .filter((s) => s.length > 0)
      .map((word) => ({ word, where: "path" as const })),
  ];
  const matches = new Map<RouteClass, string>();
  for (const { word, where } of words) {
    const cls = HINT_WORDS[word];
    if (cls && !matches.has(cls)) matches.set(cls, `the word "${word}" in the ${where}`);
  }
  if (matches.size !== 1) return null;
  const [[routeClass, basis]] = [...matches];
  return { routeClass, basis };
}

// Best first: an ownership signal (path on a confirmed host, then a
// subdomain of one, then none), then how many CRITICAL components read it,
// then how much it yielded, then how many components read it, then first
// seen, then the host itself — total and deterministic.
const SIGNAL_TIER = (signals: readonly OwnershipSignal[]): number =>
  signals.includes("PATH_ON_CONFIRMED_HOST") ? 0 : signals.includes("SUBDOMAIN_OF_CONFIRMED_HOST") ? 1 : 2;

export function rankRouteCandidates(items: readonly RouteCandidateReviewItem[]): RouteCandidateReviewItem[] {
  return [...items].sort(
    (a, b) =>
      SIGNAL_TIER(a.signals) - SIGNAL_TIER(b.signals) ||
      b.criticalComponents.length - a.criticalComponents.length ||
      b.evidenceCount - a.evidenceCount ||
      b.components.length - a.components.length ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.domain.localeCompare(b.domain) ||
      (a.proposedPrefix ?? "").localeCompare(b.proposedPrefix ?? ""),
  );
}

async function criticalComponentsOfJob(
  db: Database | Transaction,
  jobId: string,
  projectId: string,
  anyComponent: string,
): Promise<ReadonlySet<string>> {
  try {
    return (await loadAcquisitionPlan(db, jobId, anyComponent, projectId)).criticalComponents;
  } catch {
    // The job is gone or was never planned: no critical weighting, the rest
    // of the ranking still stands.
    return new Set<string>();
  }
}

export async function loadRouteCandidateReview(db: Database | Transaction, projectId: string): Promise<RouteCandidateReview> {
  const rows = await db
    .select({
      id: projectMemoryItems.id,
      content: projectMemoryItems.content,
      lifecycleState: projectMemoryItems.lifecycleState,
      createdAt: projectMemoryItems.createdAt,
    })
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, projectId), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));

  const criticalByJob = new Map<string, ReadonlySet<string>>();
  const pending: RouteCandidateReviewItem[] = [];
  const covered: RouteCandidateReviewItem[] = [];

  for (const row of rows) {
    if (row.lifecycleState !== "OBSERVED") continue;
    const domain = candidateDomainOf(row.content);
    const observed = candidateProvenanceOf(row.content);
    if (!domain || !observed) continue;
    const proposedPrefix = proposedPrefixOf(row.content);

    const hostRoute = await resolveSourceRoute(db, projectId, `https://${domain}/`);
    const signals: OwnershipSignal[] = [];
    let parentConfirmedDomain: string | null = null;
    if (proposedPrefix !== null && hostRoute.officiality === "CONFIRMED") signals.push("PATH_ON_CONFIRMED_HOST");
    if (proposedPrefix === null) {
      // Recomputed by the observer's own rule, so a candidate recorded
      // before the field existed carries the signal too.
      parentConfirmedDomain = observed.parentConfirmedDomain ?? (await parentConfirmedDomainOf(db, projectId, domain, rows));
      if (parentConfirmedDomain) signals.push("SUBDOMAIN_OF_CONFIRMED_HOST");
    }

    let critical: ReadonlySet<string> = new Set<string>();
    if (observed.jobId && observed.components.length > 0) {
      if (!criticalByJob.has(observed.jobId)) {
        criticalByJob.set(observed.jobId, await criticalComponentsOfJob(db, observed.jobId, projectId, observed.components[0]));
      }
      critical = criticalByJob.get(observed.jobId)!;
    }

    const item: RouteCandidateReviewItem = {
      id: row.id,
      domain,
      proposedPrefix,
      firstJobId: observed.jobId || null,
      evidenceCount: observed.evidenceCount,
      components: [...observed.components].sort(),
      criticalComponents: observed.components.filter((c) => critical.has(c)).sort(),
      representativeUrls: observed.urls.slice(0, MAX_REVIEW_URLS),
      signals,
      parentConfirmedDomain,
      communityHost: isCommunityHost(domain),
      classHint: suggestRouteClassHint(domain, proposedPrefix),
      createdAt: row.createdAt,
    };

    // Covered: a host candidate whose host is now CONFIRMED, or a path
    // proposal now under a human-confirmed prefix. Asked of the resolver.
    const isCovered =
      proposedPrefix === null
        ? hostRoute.officiality === "CONFIRMED"
        : (await resolveSourceRoute(db, projectId, `https://${domain}${proposedPrefix}`)).matchedPathPrefix !== null;
    (isCovered ? covered : pending).push(item);
  }

  return { projectId, pending: rankRouteCandidates(pending), covered: rankRouteCandidates(covered) };
}

// ---- the one owner act here: REJECT ---------------------------------------

export type RouteCandidateRejectionRefusal =
  | "UNKNOWN_PROJECT"
  | "CANDIDATE_NOT_FOUND"
  | "NOT_A_SOURCE_ROUTE"
  | "WRONG_PROJECT"
  | "NOT_OBSERVED"
  | "NOT_AN_ENGINE_CANDIDATE";

export type RouteCandidateRejectionResult =
  | { ok: false; refusal: RouteCandidateRejectionRefusal; detail: string }
  | { ok: true; candidateId: string; domain: string; proposedPrefix: string | null };

// OBSERVED -> DEPRECATED, the transition the lifecycle guard already allows
// for an observation nobody promoted. Effect: the observer stops proposing
// this exact host (or this exact host + prefix) for the project. It grants
// nothing and removes nothing a human confirmed: resolveSourceRoute reads
// ACTIVE rows only, and a DEPRECATED row is not one.
export async function rejectRouteCandidate(
  db: Database,
  input: { projectSlug: string; candidateId: string },
): Promise<RouteCandidateRejectionResult> {
  const [project] = await db.select().from(projects).where(eq(projects.slug, input.projectSlug));
  if (!project) return { ok: false, refusal: "UNKNOWN_PROJECT", detail: `no project with slug "${input.projectSlug}"` };

  return db.transaction(async (tx) => {
    // Serialized on the project row, like every other owner route act.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, project.id)).for("update");
    const [row] = await tx.select().from(projectMemoryItems).where(eq(projectMemoryItems.id, input.candidateId));
    if (!row) return { ok: false, refusal: "CANDIDATE_NOT_FOUND", detail: `no memory item ${input.candidateId}` } as const;
    if (row.kind !== "SOURCE_ROUTE") {
      return { ok: false, refusal: "NOT_A_SOURCE_ROUTE", detail: `item is kind ${row.kind}` } as const;
    }
    if (row.projectId !== project.id) {
      return { ok: false, refusal: "WRONG_PROJECT", detail: `item does not belong to ${input.projectSlug}` } as const;
    }
    if (row.lifecycleState !== "OBSERVED") {
      return {
        ok: false,
        refusal: "NOT_OBSERVED",
        detail: `item is ${row.lifecycleState}; only an OBSERVED candidate can be rejected here`,
      } as const;
    }
    const domain = candidateDomainOf(row.content);
    if (!domain || !candidateProvenanceOf(row.content)) {
      return { ok: false, refusal: "NOT_AN_ENGINE_CANDIDATE", detail: "item carries no observation provenance" } as const;
    }
    await tx
      .update(projectMemoryItems)
      .set({ lifecycleState: "DEPRECATED" })
      .where(and(eq(projectMemoryItems.id, row.id), eq(projectMemoryItems.lifecycleState, "OBSERVED")));
    return { ok: true, candidateId: row.id, domain, proposedPrefix: proposedPrefixOf(row.content) } as const;
  });
}
