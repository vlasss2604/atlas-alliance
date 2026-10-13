// BOUNDED SITE-LOCAL EXPANSION (Research Reliability V1, B1).
//
// External search decides what ATLAS discovers. When a page inside an
// already-confirmed official route exists but the search engine never
// ranks it, the Research concludes "not established" against a document
// two clicks away from one it already read. This module closes exactly
// that gap, and nothing wider:
//
//   * ONLY links already harvested from documents this job fetched;
//   * ONLY the same CONFIRMED, CLASSIFIED route (domain equal, path under
//     the confirmed prefix) — never a subdomain, never a redirect target
//     on another host, never an external site;
//   * ranked by deterministic lexical overlap — FIRST per served
//     component against that component's own vocabulary (its name and its
//     evidence goal, weighted by how specific each term is to it): every
//     pending component takes its ONE most relevant page when the match
//     is worth at least one term unique to it (MIN_SPECIFIC_FOR_PICK);
//     THEN, up to MAX_SITE_LOCAL_PER_ROUTE per route, by overlap with the
//     research task. A nav link that shares no term with any of them is
//     never admitted. Component picks are bounded by the work queue, not
//     by the route cap, so the admitted set is the same whether the
//     selection runs before the walk (the phased FETCH phase, every page
//     search found already known) or in the middle of it (an unphased
//     attempt, later components' pages still unknown and competing):
//     where in the walk the index was read does not decide which page a
//     later component gets;
//   * at most MAX_SITE_LOCAL_PER_ROUTE task-overlap candidates per
//     confirmed route;
//   * admitted as ORDINARY candidates: the same ledger, ordering, opens
//     cap, admissibility and extraction as any search result. Nothing is
//     followed recursively; a page admitted here is not itself harvested
//     for more.
//
// Not a crawler: no fetch happens in this module; it selects and records.
// The existing SSRF, egress and host restrictions apply unchanged to
// whatever opens these candidates.

import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { projectMemoryItems } from "../db/schema";
import { loadAcquisitionLedger } from "./acquisition-ledger";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { loadJobContractView } from "./job-contract-view";
import type { EvidenceSourceClass } from "./providers/types";
import { canonicalTargetRef, recordTraceEvent } from "./trace-store";

export const MAX_SITE_LOCAL_PER_ROUTE = 4;
// A page is a component's pick only when its overlap with that
// component's vocabulary is worth at least one term unique to the
// component (weight 1): a term every component shares ("mechanism") never
// makes a page one component's.
export const MIN_SPECIFIC_FOR_PICK = 1;
export const SITE_LOCAL_PROVIDER = "site-local-expansion";

// Route classes an expansion may walk: the owner-confirmed documentary
// authorities. Never explorers, never data providers, never social.
const EXPANDABLE_CLASSES: ReadonlySet<string> = new Set(["OFFICIAL_DOCS", "GOVERNANCE", "OFFICIAL_REPORT"]);

// Anything the fetcher cannot read as a document, or that is not a page.
const NON_DOCUMENT_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|zip|gz|tar|mp4|mp3|pdf)$/i;

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "does", "did", "has", "have",
  "how", "what", "where", "when", "which", "who", "whether", "any", "all", "not", "its", "their", "than", "then",
  "also", "about", "over", "under", "per", "via", "use", "used", "uses", "using", "docs", "doc", "documentation",
  "page", "index", "html", "www", "http", "https", "com", "org", "net", "actually", "currently", "rather", "being",
  "goes", "going", "back", "there", "here", "such", "some", "more", "most", "very", "just", "only", "out",
]);

export interface ConfirmedRoute {
  domain: string;
  pathPrefix: string;
  routeClass: string;
}

export interface HarvestedDocument {
  url: string;
  links: readonly { href: string; text: string }[];
}

export interface SiteLocalCandidate {
  url: string;
  domain: string;
  pathPrefix: string;
  routeClass: string;
  // Overlap with the research task's terms.
  score: number;
  // Per component key (`step:component`), this page's relevance to it.
  relevance?: Record<string, Relevance>;
}

export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// The vocabulary a candidate is scored against: the research task and
// the evidence goals of the components that matter. Deterministic.
export function expansionTerms(parts: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const p of parts) for (const t of tokenize(p)) out.add(t);
  return out;
}

// COMPONENT-SPECIFIC VOCABULARY — one rule, shared by the site-local
// expansion and the targeted second pass (targeted-recovery.ts). Every
// component's Pattern definition (its name and its evidenceGoal) is CORE
// data; a term that appears in many components' definitions ("mechanism",
// "evidence") says nothing about WHICH component a page answers, a term
// that appears in one ("destination", "specification") says a lot.
export function componentVocabulary(component: string, evidenceGoal: string | null | undefined): Set<string> {
  return expansionTerms([component.replace(/_/g, " "), evidenceGoal]);
}

// Weight of a term = 1 / number of vocabularies that carry it. Deterministic.
export function specificityWeights(vocabularies: readonly ReadonlySet<string>[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const vocab of vocabularies) for (const t of vocab) frequency.set(t, (frequency.get(t) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const [t, n] of frequency) out.set(t, 1 / Math.max(1, n));
  return out;
}

export interface Relevance {
  // Weighted overlap with ONE component's vocabulary: a url path token
  // counts twice (a slug names what a page is about), a text token once.
  specific: number;
  // Plain overlap with the research task's terms.
  task: number;
}

export function relevanceOf(input: {
  pathTokens: ReadonlySet<string>;
  textTokens: ReadonlySet<string>;
  vocabulary: ReadonlySet<string>;
  weights: ReadonlyMap<string, number>;
  taskTerms: ReadonlySet<string>;
}): Relevance {
  const weightOf = (t: string) => input.weights.get(t) ?? 1;
  let specific = 0;
  for (const t of input.pathTokens) if (input.vocabulary.has(t)) specific += 2 * weightOf(t);
  for (const t of input.textTokens) if (input.vocabulary.has(t)) specific += weightOf(t);
  let task = 0;
  for (const t of new Set([...input.pathTokens, ...input.textTokens])) if (input.taskTerms.has(t)) task += 1;
  return { specific, task };
}

// A component the selection serves, in PRIORITY order (the caller's:
// pending critical components first, then pending, then the rest).
export interface SelectionComponent {
  key: string;
  vocabulary: ReadonlySet<string>;
}

export function selectSiteLocalExpansion(input: {
  documents: readonly HarvestedDocument[];
  routes: readonly ConfirmedRoute[];
  terms: ReadonlySet<string>;
  known: ReadonlySet<string>;
  maxPerRoute?: number;
  // When given, every component in turn takes its ONE most relevant
  // unpicked link whose specific overlap reaches MIN_SPECIFIC_FOR_PICK;
  // the route cap then bounds the task-overlap fill. Absent: task overlap
  // alone, under the cap.
  components?: readonly SelectionComponent[];
}): SiteLocalCandidate[] {
  const maxPerRoute = input.maxPerRoute ?? MAX_SITE_LOCAL_PER_ROUTE;
  const routes = input.routes.filter((r) => EXPANDABLE_CLASSES.has(r.routeClass));
  const components = input.components ?? [];
  if (routes.length === 0 || (input.terms.size === 0 && components.length === 0)) return [];
  const weights = specificityWeights(components.map((c) => c.vocabulary));
  const seen = new Set<string>(input.known);
  interface Scored extends SiteLocalCandidate {
    order: number;
    relevance: Record<string, Relevance>;
  }
  const scored: Scored[] = [];
  let order = 0;
  for (const doc of input.documents) {
    seen.add(canonicalTargetRef(doc.url));
    for (const link of doc.links) {
      order += 1;
      let resolved: URL;
      try {
        resolved = new URL(link.href, doc.url);
      } catch {
        continue;
      }
      if (resolved.protocol !== "https:") continue;
      resolved.hash = "";
      // One page, one candidate: a trailing slash is not a different page.
      if (resolved.pathname.length > 1 && resolved.pathname.endsWith("/")) resolved.pathname = resolved.pathname.replace(/\/+$/, "");
      if (NON_DOCUMENT_EXTENSIONS.test(resolved.pathname)) continue;
      const host = resolved.hostname.toLowerCase();
      const route = routes.find((r) => r.domain.toLowerCase() === host && resolved.pathname.startsWith(r.pathPrefix));
      if (!route) continue;
      const url = resolved.toString();
      const canonical = canonicalTargetRef(url);
      if (seen.has(canonical)) continue;
      // Score the part of the path BELOW the confirmed prefix and the
      // anchor text — never the prefix or the host, which every link on
      // the route shares and which would make a nav link "relevant".
      const below = resolved.pathname.slice(route.pathPrefix.length);
      const pathTokens = new Set(tokenize(below));
      const textTokens = new Set(tokenize(link.text));
      const relevance: Record<string, Relevance> = {};
      let any = false;
      for (const c of components) {
        const r = relevanceOf({ pathTokens, textTokens, vocabulary: c.vocabulary, weights, taskTerms: input.terms });
        relevance[c.key] = r;
        if (r.specific >= MIN_SPECIFIC_FOR_PICK) any = true;
      }
      let score = 0;
      for (const t of new Set([...pathTokens, ...textTokens])) if (input.terms.has(t)) score += 1;
      if (score === 0 && !any) continue;
      seen.add(canonical);
      scored.push({ url, domain: route.domain, pathPrefix: route.pathPrefix, routeClass: route.routeClass, score, relevance, order });
    }
  }
  const byRoute = new Map<string, Scored[]>();
  for (const c of scored) {
    const key = `${c.domain}${c.pathPrefix}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), c]);
  }
  const out: SiteLocalCandidate[] = [];
  const emit = (c: Scored) => out.push({ url: c.url, domain: c.domain, pathPrefix: c.pathPrefix, routeClass: c.routeClass, score: c.score, relevance: c.relevance });
  for (const links of byRoute.values()) {
    const picked = new Set<Scored>();
    // ONE round of component picks, in priority order: each component's
    // best unpicked link whose specific overlap reaches the floor. Bounded
    // by the components served, never by the route cap.
    for (const c of components) {
      const best = links
        .filter((l) => !picked.has(l) && l.relevance[c.key].specific >= MIN_SPECIFIC_FOR_PICK)
        .sort((a, b) => b.relevance[c.key].specific - a.relevance[c.key].specific || b.relevance[c.key].task - a.relevance[c.key].task || a.order - b.order)[0];
      if (!best) continue;
      picked.add(best);
      emit(best);
    }
    // Under the route cap: task overlap, then discovery order — the
    // original rule.
    const rest = links.filter((l) => !picked.has(l) && l.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
    for (const c of rest) {
      if (picked.size >= maxPerRoute) break;
      picked.add(c);
      emit(c);
    }
  }
  return out;
}

// The candidates in ONE component's relevance order: its specific overlap,
// then task overlap, then the selection's own order. This is the order the
// component's CANDIDATE_RETURNED rows are recorded in, and the order an
// unphased attempt appends them for its own continuation.
export function orderExpansionForComponent(candidates: readonly SiteLocalCandidate[], key: string): SiteLocalCandidate[] {
  return candidates
    .map((c, index) => ({ c, index, r: c.relevance?.[key] ?? { specific: 0, task: c.score } }))
    .sort((a, b) => b.r.specific - a.r.specific || b.r.task - a.r.task || a.index - b.index)
    .map((x) => x.c);
}

// The project's CONFIRMED, CLASSIFIED routes — the only places an
// expansion may walk.
export async function loadConfirmedClassifiedRoutes(db: Database | Transaction, projectId: string | null): Promise<ConfirmedRoute[]> {
  if (!projectId) return [];
  const rows = await db
    .select({ content: projectMemoryItems.content })
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, projectId), eq(projectMemoryItems.kind, "SOURCE_ROUTE"), eq(projectMemoryItems.lifecycleState, "ACTIVE")));
  const out: ConfirmedRoute[] = [];
  for (const row of rows) {
    const c = row.content as { domain?: unknown; pathPrefix?: unknown; routeClass?: unknown };
    if (typeof c.domain !== "string" || typeof c.pathPrefix !== "string" || typeof c.routeClass !== "string") continue;
    if (!EXPANDABLE_CLASSES.has(c.routeClass)) continue;
    out.push({ domain: c.domain, pathPrefix: c.pathPrefix, routeClass: c.routeClass });
  }
  return out;
}

export interface ExpansionComponent {
  step: number;
  component: string;
  establishingClasses: readonly EvidenceSourceClass[];
  // The component's Pattern evidence goal — its vocabulary with its name.
  evidenceGoal?: string | null;
  // Whether the intent's critical proof path (pattern.ts B3) names it.
  critical?: boolean;
}

export function expansionComponentKey(c: { step: number; component: string }): string {
  return `${c.step}:${c.component}`;
}

// SELECT AND RECORD. Reads the job's ledger (so nothing already known,
// fetched or dead is admitted), the confirmed routes, the task and the
// critical components' evidence goals; selects the bounded set; writes it
// into the job's own trace as candidates — one synthetic SEARCH_EXECUTED
// row per route (spending nothing) followed by one CANDIDATE_RETURNED row
// per (admitting component, url), exactly the shape a search result
// leaves, so the ledger, the phased replay and the targeted second pass
// all see these as ordinary discoveries attributed to the components
// whose classes the route establishes. Returns the admitted candidates.
export async function planSiteLocalExpansion(
  db: Database | Transaction,
  jobId: string,
  projectId: string | null,
  documents: readonly HarvestedDocument[],
  opts: {
    components?: readonly ExpansionComponent[];
    terms?: readonly (string | null | undefined)[];
    // The components still to be walked (names), current one first. The
    // selection serves them first — pending critical, then pending, then
    // the rest. Absent (the phased FETCH phase, before any walk): every
    // component is pending.
    pendingComponents?: readonly string[];
    // Return the candidates in THIS component's relevance order (an
    // unphased attempt appending them for its own continuation). Absent:
    // the selection's own order.
    forComponent?: { step: number; component: string };
  } = {},
): Promise<SiteLocalCandidate[]> {
  if (documents.length === 0) return [];
  const routes = await loadConfirmedClassifiedRoutes(db, projectId);
  if (routes.length === 0) return [];
  let components = opts.components ?? null;
  let termParts: (string | null | undefined)[] = [...(opts.terms ?? [])];
  if (!components) {
    const { view } = await loadJobContractView(db, jobId);
    const loaded: ExpansionComponent[] = [];
    for (const item of view.workQueue) {
      const plan = await loadAcquisitionPlan(db, jobId, item.component, projectId);
      loaded.push({
        step: item.step,
        component: item.component,
        establishingClasses: plan.establishingClasses,
        evidenceGoal: plan.evidenceGoal,
        critical: plan.criticalComponents.has(item.component),
      });
      if (termParts.length === 0 || termParts.every((t) => !t)) termParts = [plan.researchTask];
      if (plan.criticalComponents.has(item.component)) termParts.push(plan.evidenceGoal);
    }
    components = loaded;
  }
  const terms = expansionTerms(termParts);
  const pending = opts.pendingComponents ? new Set(opts.pendingComponents) : null;
  const isPending = (c: ExpansionComponent) => pending === null || pending.has(c.component);
  const priority = (c: ExpansionComponent) => (isPending(c) ? (c.critical ? 0 : 1) : 2);
  const served: SelectionComponent[] = [...components]
    .sort((a, b) => priority(a) - priority(b) || a.step - b.step || a.component.localeCompare(b.component))
    .map((c) => ({ key: expansionComponentKey(c), vocabulary: componentVocabulary(c.component, c.evidenceGoal) }));
  if (terms.size === 0 && served.every((c) => c.vocabulary.size === 0)) return [];
  const ledger = await loadAcquisitionLedger(db, jobId);
  const known = new Set<string>();
  for (const urls of ledger.candidatesByQuery.values()) for (const url of urls) known.add(canonicalTargetRef(url));
  for (const url of ledger.fetchedUrls) known.add(url);
  for (const url of ledger.deadUrls) known.add(url);
  const selected = selectSiteLocalExpansion({ documents, routes, terms, known, components: served });
  if (selected.length === 0) return [];
  const byRoute = new Map<string, SiteLocalCandidate[]>();
  for (const c of selected) {
    const key = `route:${c.domain}${c.pathPrefix}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), c]);
  }
  for (const [query, candidates] of byRoute) {
    const routeClass = candidates[0].routeClass as EvidenceSourceClass;
    const admitting = components.filter((c) => c.establishingClasses.includes(routeClass));
    if (admitting.length === 0) continue;
    await recordTraceEvent(db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      providerKind: "SEARCH",
      providerName: SITE_LOCAL_PROVIDER,
      targetRef: query,
      status: "OK",
      reasonCode: "NONE",
    });
    for (const component of admitting) {
      // Recorded in THIS component's relevance order: the ledger keeps the
      // order per (component, query), and a later attempt adopts it.
      for (const c of orderExpansionForComponent(candidates, expansionComponentKey(component))) {
        await recordTraceEvent(db, {
          researchJobId: jobId,
          operationType: "CANDIDATE_RETURNED",
          providerKind: "SEARCH",
          providerName: SITE_LOCAL_PROVIDER,
          patternStep: component.step,
          component: component.component,
          targetRef: c.url,
          status: "OK",
        });
      }
    }
  }
  return opts.forComponent ? orderExpansionForComponent(selected, expansionComponentKey(opts.forComponent)) : selected;
}
