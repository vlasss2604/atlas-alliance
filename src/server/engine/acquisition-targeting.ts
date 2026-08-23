import { classRequiresConfirmedRoute, targetDomainsForClass } from "./source-authority";
import type { EvidenceSourceClass } from "./providers/types";

// D-129 — component-aware source-class targeting (acquisition).
//
// The defect this closes: QueryProposer was told only the project, step
// name, component name and a hint. It was never told WHICH evidence
// classes the component can actually be established by, so it produced
// generic web queries, the search provider returned aggregator/blog
// pages, and S5 then correctly discarded 100% of the resulting evidence
// as CLASS_NOT_ADMISSIBLE. Five live runs collected 233 evidence rows and
// admitted zero.
//
// The fix is acquisition-side only. Nothing here changes what counts as
// evidence: S5's establishingClasses check, S7's support logic and the
// human-confirmed officiality axis (D-074) are all untouched. All this
// does is aim search at hosts that source-authority.ts ALREADY classifies
// into the classes the Pattern says this component admits, so admissible
// evidence has a chance to exist at all.
//
// Authority discipline (SOURCE != EVIDENCE != FACT):
//   - WHICH classes a component admits  -> the Pattern's componentRequirements
//   - WHICH domains belong to a class   -> source-authority.ts's code-owned lists
//   - WHICH domains are a project's own -> human-confirmed ACTIVE SOURCE_ROUTE
// The model proposes only the free-text topic of a query. It never
// contributes a domain, a class, or an authority judgement.

// Cap on how many of an attempt's queries may be class-targeted. At least
// one slot is always left for the model's own untargeted formulation so a
// component is never reduced to site-scoped search alone (which would
// hide a genuinely authoritative source living on an unlisted host).
export const MAX_TARGETED_QUERIES_PER_ATTEMPT = 2;

// Domains-per-class cap: one site: term per query, and we would rather
// spend the scarce searchQueries axis across DIFFERENT classes than
// enumerate every explorer for one class.
const MAX_DOMAINS_PER_CLASS = 2;

export interface TargetingInput {
  // The component's admissible classes, verbatim from the Pattern's
  // componentRequirements.establishingClasses. An empty array means the
  // component structurally cannot be established (a legal Pattern value)
  // — no targeting is produced for it.
  establishingClasses: readonly EvidenceSourceClass[];
  // Domains that resolveSourceRoute already reported as CONFIRMED for
  // THIS project, grouped by the routeClass the human set on them.
  confirmedRouteDomainsByClass?: Partial<Record<EvidenceSourceClass, readonly string[]>>;
  // The model's proposed free-text queries for this component.
  baseQueries: readonly string[];
  maxTargeted?: number;
}

export interface TargetingResult {
  // site:-scoped queries, ordered by the component's own class priority.
  targetedQueries: string[];
  // Classes this component admits that cannot be reached without a
  // human-confirmed SOURCE_ROUTE for the project (OFFICIAL_DOCS /
  // OFFICIAL_REPORT with no confirmed domain). Surfaced for observability
  // — never silently ignored, because it is the honest reason a component
  // may remain INSUFFICIENT_EVIDENCE no matter how much budget it gets.
  unreachableClasses: EvidenceSourceClass[];
}

// Builds site:-scoped variants of the model's own query text. The topic
// text is the model's; the site: term is always code-owned.
export function buildTargetedQueries(input: TargetingInput): TargetingResult {
  const maxTargeted = input.maxTargeted ?? MAX_TARGETED_QUERIES_PER_ATTEMPT;
  const base = input.baseQueries.find((q) => typeof q === "string" && q.trim().length > 0)?.trim();
  const unreachableClasses: EvidenceSourceClass[] = [];
  const targetedQueries: string[] = [];
  if (!base || maxTargeted <= 0) {
    // Still report unreachable classes even when there is nothing to
    // target with — the caller wants that signal regardless.
    for (const cls of input.establishingClasses) {
      const confirmed = input.confirmedRouteDomainsByClass?.[cls] ?? [];
      if (classRequiresConfirmedRoute(cls) && confirmed.length === 0) unreachableClasses.push(cls);
    }
    return { targetedQueries, unreachableClasses };
  }

  // Iterate the component's classes in the Pattern's own declared order —
  // the Pattern, not this module, decides which class matters most for a
  // component. Round-robin one domain per class before taking a second
  // from any class, so a component admitting several classes spends its
  // targeted slots across them rather than exhausting the first.
  const perClassDomains = new Map<EvidenceSourceClass, string[]>();
  for (const cls of input.establishingClasses) {
    const confirmed = input.confirmedRouteDomainsByClass?.[cls] ?? [];
    const domains = targetDomainsForClass(cls, confirmed).slice(0, MAX_DOMAINS_PER_CLASS);
    if (domains.length === 0) {
      if (classRequiresConfirmedRoute(cls) && confirmed.length === 0) unreachableClasses.push(cls);
      continue;
    }
    perClassDomains.set(cls, domains);
  }

  const seenDomains = new Set<string>();
  for (let round = 0; round < MAX_DOMAINS_PER_CLASS; round += 1) {
    for (const cls of input.establishingClasses) {
      if (targetedQueries.length >= maxTargeted) break;
      const domain = perClassDomains.get(cls)?.[round];
      if (!domain) continue;
      // C: the same domain reached via two classes/aliases must never
      // produce two queries — that would spend two search units and could
      // read downstream as two independent sources for one host.
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      targetedQueries.push(`site:${domain} ${base}`);
    }
    if (targetedQueries.length >= maxTargeted) break;
  }

  return { targetedQueries, unreachableClasses };
}

// Blends targeted and model queries into the attempt's final, budget-
// bounded query list. Targeted queries go FIRST (the scarce searchQueries
// axis should buy admissible-class coverage before generic coverage), and
// at least one model query is always preserved when room remains.
export function blendQueries(
  targeted: readonly string[],
  modelQueries: readonly string[],
  maxTotal: number,
): string[] {
  if (maxTotal <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || seen.has(trimmed) || out.length >= maxTotal) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  // Reserve one slot for the model's own untargeted query whenever the
  // budget allows more than a single query this attempt.
  const targetedBudget = maxTotal > 1 ? Math.min(targeted.length, maxTotal - 1) : 0;
  for (let i = 0; i < targetedBudget; i += 1) push(targeted[i]);
  for (const q of modelQueries) push(q);
  // If the model produced fewer queries than the remaining room, let any
  // leftover targeted queries use it rather than wasting the slot.
  for (const q of targeted) push(q);
  return out;
}
