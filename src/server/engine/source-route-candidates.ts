import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { projectMemoryItems } from "../db/schema";
import { hostnameOf, isUnrecognizedDomain, type ResolvedSourceRoute } from "./source-authority";

// UNSEEN PROJECT AUTHORITY BOOTSTRAP V1 — the engine OBSERVES a route
// candidate; only a human can ever make it a route.
//
// THE GAP THIS CLOSES. The first unseen validation (Morpho, job a34375ba)
// fetched the project's own documentation host 22 times, extracted 26
// Evidence rows from it, and — correctly, per D-074/D-089 — classified
// every one SOCIAL / CLAIMED, because no ACTIVE SOURCE_ROUTE existed for a
// project nobody had pre-researched. S5 then excluded all of it as
// CLASS_NOT_ADMISSIBLE. Every step was right. What was missing is that the
// run recorded WHICH host it kept finding nowhere the owner tooling reads:
// the only creator of CONFIRMED (confirm-source-route.ts) needs a domain as
// INPUT, and the loop produced none. The lifecycle model — OBSERVED, then a
// human, then ACTIVE (D-021, D-075: "creation of records — OBSERVED only")
// — was designed for exactly this observation; SOURCE_ROUTE simply had no
// OBSERVED producer. This module is that producer, and nothing more.
//
// DISCOVERY != AUTHORITY. An OBSERVED row written here confers nothing:
//   - resolveSourceRoute reads lifecycleState = 'ACTIVE' only, so
//     officiality stays CLAIMED and routeClass stays null;
//   - loadConfirmedRouteDomains (acquisition targeting) reads ACTIVE only;
//   - SOURCE_RESOURCE seeds require a classified ACTIVE route;
//   - S5 never reads project memory at all.
// The only edge out of OBSERVED is the existing owner workflow
// (confirm-source-route.ts, then classify-source-route.ts), which inserts
// and promotes ITS OWN row after a human read the page. Nothing here calls
// the lifecycle functions, sets a routeClass, or writes a pathPrefix — the
// prefix is the human's decision after reading, never the engine's.
//
// STRICT ELIGIBILITY (founder decision 2026-09-12), all checked here:
//   1-3. the document passed project containment and at least one Evidence
//        row was actually persisted from it — the caller only invokes this
//        after those facts are true, and evidenceCount is what it wrote;
//   4-5. resolveSourceRoute on the SAME finalUrl still says CLAIMED, and no
//        SOURCE_ROUTE row in any state already names this host — a host a
//        human has confirmed, classified, deprecated or superseded is theirs
//        to manage, not ours to re-observe;
//   6-7. the host is one no code-owned platform list recognizes and is not
//        a bare shared hosting base (isUnrecognizedDomain);
//   8.   finalUrl, never the pre-redirect url — the same rule the Evidence
//        row itself follows.
// Nothing is inferred from search rank, url wording, the project's name in
// the hostname, self-description, links, redirects, registrable-domain or
// subdomain relationships. A lookalike host that passes containment will
// be observed like any other; observation is neutral, and the human is
// the filter.
//
// BOUNDED. One row per (project, exact host). A host seen again — same
// job or a later one — merges bounded operational provenance into the
// existing OBSERVED row (urls capped, components as a set, a count) and
// never creates a second. At most MAX_ROUTE_CANDIDATES_PER_JOB new rows
// per Research job. Provenance carries job id, urls, count, components
// and the sources row — no user data of any kind.

export const MAX_ROUTE_CANDIDATES_PER_JOB = 8;
export const MAX_ROUTE_CANDIDATE_URLS = 5;

export interface RouteCandidateProvenance {
  // The job that FIRST observed this host. Later observations merge into
  // the row without changing it — it is also what the per-job cap counts.
  jobId: string;
  urls: string[];
  evidenceCount: number;
  components: string[];
}

export interface RouteCandidateContent {
  domain: string;
  observed: RouteCandidateProvenance;
}

export interface ObserveRouteCandidateInput {
  projectId: string;
  jobId: string;
  sourceId: string;
  finalUrl: string;
  component: string;
  evidenceCount: number;
  route: ResolvedSourceRoute;
}

export type RouteCandidateOutcome =
  | { outcome: "OBSERVED"; domain: string; itemId: string }
  | { outcome: "UPDATED"; domain: string; itemId: string }
  | { outcome: "SKIPPED"; reason: RouteCandidateSkipReason; domain: string | null };

export type RouteCandidateSkipReason =
  | "NO_EVIDENCE"
  | "ROUTE_CONFIRMED"
  | "RECOGNIZED_DOMAIN"
  | "EXISTING_ROUTE_ROW"
  | "CAP_REACHED"
  | "MALFORMED_URL";

function candidateDomainOf(content: unknown): string | null {
  const c = content as { domain?: unknown } | null;
  return typeof c?.domain === "string" ? c.domain.toLowerCase().replace(/^www\./, "") : null;
}

function candidateProvenanceOf(content: unknown): RouteCandidateProvenance | null {
  const c = content as { observed?: Partial<RouteCandidateProvenance> } | null;
  const o = c?.observed;
  if (!o || typeof o.jobId !== "string") return null;
  return {
    jobId: o.jobId,
    urls: Array.isArray(o.urls) ? o.urls.filter((u): u is string => typeof u === "string") : [],
    evidenceCount: typeof o.evidenceCount === "number" ? o.evidenceCount : 0,
    components: Array.isArray(o.components) ? o.components.filter((k): k is string => typeof k === "string") : [],
  };
}

export async function observeSourceRouteCandidate(
  db: Database | Transaction,
  input: ObserveRouteCandidateInput,
): Promise<RouteCandidateOutcome> {
  const domain = hostnameOf(input.finalUrl);
  if (!domain) return { outcome: "SKIPPED", reason: "MALFORMED_URL", domain: null };
  if (input.evidenceCount <= 0) return { outcome: "SKIPPED", reason: "NO_EVIDENCE", domain };
  if (input.route.officiality !== "CLAIMED") return { outcome: "SKIPPED", reason: "ROUTE_CONFIRMED", domain };
  if (!isUnrecognizedDomain(input.finalUrl)) return { outcome: "SKIPPED", reason: "RECOGNIZED_DOMAIN", domain };

  return db.transaction(async (tx) => {
    // Every SOURCE_ROUTE row this project has, in every lifecycle state:
    // the dedup decision and the per-job cap are both taken from one read
    // inside one transaction, so two documents from the same host in the
    // same attempt cannot each conclude "no row yet".
    const rows = await tx
      .select({
        id: projectMemoryItems.id,
        content: projectMemoryItems.content,
        lifecycleState: projectMemoryItems.lifecycleState,
        createdAt: projectMemoryItems.createdAt,
      })
      .from(projectMemoryItems)
      .where(and(eq(projectMemoryItems.projectId, input.projectId), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));

    const sameHost = rows.filter((r) => candidateDomainOf(r.content) === domain);
    if (sameHost.some((r) => r.lifecycleState !== "OBSERVED")) {
      return { outcome: "SKIPPED", reason: "EXISTING_ROUTE_ROW", domain };
    }

    const existing = sameHost
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (existing) {
      const prior = candidateProvenanceOf(existing.content) ?? {
        jobId: input.jobId,
        urls: [],
        evidenceCount: 0,
        components: [],
      };
      const urls = prior.urls.includes(input.finalUrl)
        ? prior.urls
        : [...prior.urls, input.finalUrl].slice(0, MAX_ROUTE_CANDIDATE_URLS);
      const components = [...new Set([...prior.components, input.component])].sort();
      const content: RouteCandidateContent = {
        domain,
        observed: { jobId: prior.jobId, urls, evidenceCount: prior.evidenceCount + input.evidenceCount, components },
      };
      // Guarded on lifecycle_state so a row a human moved on in the
      // meantime is never touched: an OBSERVED candidate is operational
      // bookkeeping, anything else is a human statement.
      const updated = await tx
        .update(projectMemoryItems)
        .set({ content })
        .where(and(eq(projectMemoryItems.id, existing.id), eq(projectMemoryItems.lifecycleState, "OBSERVED")))
        .returning({ id: projectMemoryItems.id });
      if (updated.length === 0) return { outcome: "SKIPPED", reason: "EXISTING_ROUTE_ROW", domain };
      return { outcome: "UPDATED", domain, itemId: existing.id };
    }

    const createdByThisJob = rows.filter(
      (r) => r.lifecycleState === "OBSERVED" && candidateProvenanceOf(r.content)?.jobId === input.jobId,
    ).length;
    if (createdByThisJob >= MAX_ROUTE_CANDIDATES_PER_JOB) {
      return { outcome: "SKIPPED", reason: "CAP_REACHED", domain };
    }

    const content: RouteCandidateContent = {
      domain,
      observed: { jobId: input.jobId, urls: [input.finalUrl], evidenceCount: input.evidenceCount, components: [input.component] },
    };
    // OBSERVED is the only state the database guard admits on insert, and
    // the only state this module ever writes.
    const [inserted] = await tx
      .insert(projectMemoryItems)
      .values({
        projectId: input.projectId,
        kind: "SOURCE_ROUTE",
        content,
        sourceId: input.sourceId,
        lifecycleState: "OBSERVED",
      })
      .returning({ id: projectMemoryItems.id });
    return { outcome: "OBSERVED", domain, itemId: inserted.id };
  });
}
