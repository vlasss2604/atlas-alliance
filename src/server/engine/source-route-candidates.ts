import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { projectMemoryItems } from "../db/schema";
import { hostnameOf, isUnrecognizedDomain, normalizePathPrefix, resolveSourceRoute, type ResolvedSourceRoute } from "./source-authority";

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
  // RESEARCH QUALITY V1 (D-176) — the project's CONFIRMED domain this host
  // is a subdomain of, when there is one (forum.<confirmed>). Provenance
  // for the human who reads the candidate: a project-owned governance or
  // community surface usually lives exactly there. It confers nothing —
  // authority does not flow from a parent host (CORE_RULES), so
  // resolveSourceRoute never reads it; it only makes the owner's decision
  // better informed and faster.
  parentConfirmedDomain?: string;
}

export interface RouteCandidateContent {
  domain: string;
  // RESEARCH QUALITY V1 (D-176) — PRESENT ONLY ON A PATH CANDIDATE: a page
  // on a domain a human already CONFIRMED, outside every confirmed path
  // prefix, that produced admitted Evidence. Measured on the second Jito
  // benchmark: jito.network/jto/ sat outside the confirmed /docs prefix,
  // classified SOCIAL by construction, and 21 Evidence rows from it
  // counted for nothing while the owner tooling never learned the path
  // existed. The candidate names the first path segment so the existing
  // workflow (confirm-source-route.ts --prefix, then classify) can add a
  // second classified row for it after reading the page.
  //
  // DELIBERATELY NOT the route's own `pathPrefix` property: that field is
  // what resolveSourceRoute reads, and only a human may write it (the
  // structural guard in tests/unseen-route-candidates pins exactly that).
  // This is provenance — a proposal for the human to read — and has no
  // reader in the authority layer.
  proposedPrefix?: string;
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
  | "MALFORMED_URL"
  // A confirmed-domain page at the site root has no path to propose.
  | "NO_PATH_PREFIX";

function candidateDomainOf(content: unknown): string | null {
  const c = content as { domain?: unknown } | null;
  return typeof c?.domain === "string" ? c.domain.toLowerCase().replace(/^www\./, "") : null;
}

// The prefix a HUMAN row carries (read only — never written here).
function routePrefixOf(content: unknown): string | null {
  const c = content as { pathPrefix?: unknown } | null;
  return typeof c?.pathPrefix === "string" ? c.pathPrefix : null;
}

// The prefix an OBSERVED path candidate proposes.
function proposedPrefixOf(content: unknown): string | null {
  const c = content as { proposedPrefix?: unknown } | null;
  return typeof c?.proposedPrefix === "string" ? c.proposedPrefix : null;
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
    ...(typeof o.parentConfirmedDomain === "string" ? { parentConfirmedDomain: o.parentConfirmedDomain } : {}),
  };
}

// The first path segment of a url, as a prefix the owner tooling accepts
// ("/jto" for https://host/jto/anything); null at the site root.
export function firstPathSegment(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split("/").filter((s) => s.length > 0)[0];
    return segment ? `/${segment}` : null;
  } catch {
    return null;
  }
}

// The project's CONFIRMED domain that `host` is a strict subdomain of, when
// there is one; null otherwise. Dot-boundary match only, never a
// substring — and "confirmed" is asked of the one authority resolver, so
// this module holds no opinion of its own about lifecycle states.
async function parentConfirmedDomainOf(
  tx: Database | Transaction,
  projectId: string,
  host: string,
  rows: readonly { content: unknown; lifecycleState: string }[],
): Promise<string | null> {
  const parents = new Set<string>();
  for (const r of rows) {
    if (r.lifecycleState === "OBSERVED") continue;
    const d = candidateDomainOf(r.content);
    if (d && host !== d && host.endsWith(`.${d}`)) parents.add(d);
  }
  for (const d of [...parents].sort()) {
    const route = await resolveSourceRoute(tx, projectId, `https://${d}/`);
    if (route.officiality === "CONFIRMED") return d;
  }
  return null;
}

export async function observeSourceRouteCandidate(
  db: Database | Transaction,
  input: ObserveRouteCandidateInput,
): Promise<RouteCandidateOutcome> {
  const domain = hostnameOf(input.finalUrl);
  if (!domain) return { outcome: "SKIPPED", reason: "MALFORMED_URL", domain: null };
  if (input.evidenceCount <= 0) return { outcome: "SKIPPED", reason: "NO_EVIDENCE", domain };
  // RESEARCH QUALITY V1 — TWO SHAPES OF CANDIDATE. A host nobody has an
  // opinion about (the original, unchanged), and a PATH on a domain a
  // human already confirmed that sits outside every classified prefix. A
  // confirmed, CLASSIFIED page is the owner's finished decision: nothing
  // to observe.
  // `matchedPathPrefix === null`: the url sits under NO human-confirmed
  // prefix. A page under a confirmed-but-unclassified prefix is already in
  // the owner's hands (officiality AND the path are theirs); only its
  // classification is pending, and that is not ours to propose.
  const pathCandidate = input.route.officiality === "CONFIRMED" && input.route.routeClass === null && input.route.matchedPathPrefix === null;
  if (input.route.officiality === "CONFIRMED" && !pathCandidate) return { outcome: "SKIPPED", reason: "ROUTE_CONFIRMED", domain };
  if (!pathCandidate && !isUnrecognizedDomain(input.finalUrl)) return { outcome: "SKIPPED", reason: "RECOGNIZED_DOMAIN", domain };
  const pathPrefix = pathCandidate ? firstPathSegment(input.finalUrl) : null;
  if (pathCandidate && pathPrefix === null) return { outcome: "SKIPPED", reason: "NO_PATH_PREFIX", domain };

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
    if (pathCandidate) {
      // A human row for this domain WITHOUT a prefix, or confirmed at "/",
      // covers the whole domain: classifying it is already theirs to do,
      // and a path proposal would only repeat the question.
      const domainWide = (r: { content: unknown }) => {
        const p = routePrefixOf(r.content);
        return p === null || normalizePathPrefix(p) === "/";
      };
      if (sameHost.some((r) => r.lifecycleState !== "OBSERVED" && domainWide(r))) {
        return { outcome: "SKIPPED", reason: "EXISTING_ROUTE_ROW", domain };
      }
    } else if (sameHost.some((r) => r.lifecycleState !== "OBSERVED")) {
      return { outcome: "SKIPPED", reason: "EXISTING_ROUTE_ROW", domain };
    }
    const parentConfirmedDomain = pathCandidate ? null : await parentConfirmedDomainOf(tx, input.projectId, domain, rows);

    // The row this observation merges into: for a host candidate the one
    // OBSERVED row of the host; for a path candidate the OBSERVED row of
    // the same host AND the same proposed prefix.
    const existing = sameHost
      .filter((r) => r.lifecycleState === "OBSERVED" && proposedPrefixOf(r.content) === pathPrefix)
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
        ...(pathPrefix ? { proposedPrefix: pathPrefix } : {}),
        observed: {
          jobId: prior.jobId,
          urls,
          evidenceCount: prior.evidenceCount + input.evidenceCount,
          components,
          ...(prior.parentConfirmedDomain ?? parentConfirmedDomain ? { parentConfirmedDomain: prior.parentConfirmedDomain ?? parentConfirmedDomain! } : {}),
        },
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
      ...(pathPrefix ? { proposedPrefix: pathPrefix } : {}),
      observed: {
        jobId: input.jobId,
        urls: [input.finalUrl],
        evidenceCount: input.evidenceCount,
        components: [input.component],
        ...(parentConfirmedDomain ? { parentConfirmedDomain } : {}),
      },
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
