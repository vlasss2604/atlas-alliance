// TARGETED SECOND PASS (Research Reliability V1, B2).
//
// After the first acquisition walk a Research knows, per component, what
// it established and what it did not. For a CRITICAL component (the
// intent's declared proof path, pattern.ts B3) that is still unresolved,
// this module answers ONE question from persisted state only:
//
//   does a KNOWN, ADMISSIBLE acquisition path remain that the first pass
//   did not consume?
//
// Three kinds of path are recognised, each read from the job's own
// ledger and trace, never inferred:
//
//   SEALED_UNEXTRACTED  a document this job sealed that was never
//                       extracted FOR THIS COMPONENT — the component's own
//                       candidate, or a confirmed-route document another
//                       component surfaced, on a route class this
//                       component admits;
//   UNOPENED_CANDIDATE  a candidate discovered for this component (or on a
//                       confirmed admissible route) that was never opened
//                       and is not known dead;
//   ROUTE_UNEXPLORED    a CONFIRMED route for a class this component admits
//                       on which no candidate for this component was ever
//                       discovered.
//
// If any path remains, the controller runs ONE bounded recovery attempt
// for the component (TARGETED_RECOVERY_BOUNDS), and never a third. The
// plan is deterministic and persistable, so the phased runtime can carry
// it across a second SEARCH → FETCH → EXTRACT cycle
// (`research_jobs.acquisition_scope`, migration 0056).
//
// WHAT THIS IS NOT: not a planner, not a crawler, not a second engine.
// It selects components and paths; the same executor, the same
// admissibility rules and the same budget reservation do the work.

import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts, researchComponentResults, researchTraceEvents } from "../db/schema";
import { loadAcquisitionLedger } from "./acquisition-ledger";
import { loadAcquisitionPlan } from "./acquisition-plan";
import { sealedDocumentsForJob } from "./acquired-documents";
import type { ComponentWorkItem } from "./contract-view";
import type { EvidenceSourceClass } from "./providers/types";
import { componentVocabulary, expansionTerms, relevanceOf, specificityWeights, tokenize } from "./site-local-expansion";
import { resolveSourceRoute } from "./source-authority";
import { canonicalTargetRef } from "./trace-store";

// Hard bounds per critical component for the single recovery attempt.
export const TARGETED_RECOVERY_BOUNDS = { searches: 2, opens: 3, extractions: 3 } as const;

// What the FIRST pass holds back so a recovery attempt can still search
// and open: the budget's own recovery reservation (reservedRecoverySteps)
// expressed on the two scarce axes. The envelope is unchanged; a part of
// it is spent second instead of first.
export function recoveryReserve(reservedRecoverySteps: number): { searchQueries: number; sourceOpens: number } {
  const steps = Math.max(0, Math.floor(reservedRecoverySteps));
  return {
    searchQueries: steps * TARGETED_RECOVERY_BOUNDS.searches,
    sourceOpens: steps * TARGETED_RECOVERY_BOUNDS.opens,
  };
}

export type KnownPathKind = "SEALED_UNEXTRACTED" | "UNOPENED_CANDIDATE" | "ROUTE_UNEXPLORED";

export interface KnownPath {
  kind: KnownPathKind;
  url?: string;
  domain?: string;
  routeClass?: string;
}

export interface TargetedRecoveryItem {
  step: number;
  component: string;
  // The S5 reason codes the component closed on — recorded so the second
  // pass can be audited against what the first pass said.
  reasonCodes: string[];
  paths: KnownPath[];
  needsSearch: boolean;
  needsOpen: boolean;
}

export interface TargetedRecoveryPlan {
  version: 1;
  round: 2;
  items: TargetedRecoveryItem[];
  bounds: { searches: number; opens: number; extractions: number };
}

// S5 statuses that count as unresolved for the purpose of a second pass.
// PARTIALLY_SUPPORTED is deliberately NOT included: evidence exists and
// was judged; a second pass is for components the first pass never
// established at all.
const UNRESOLVED_STATUSES: ReadonlySet<string> = new Set(["INSUFFICIENT_EVIDENCE"]);

function componentPrefix(step: number, component: string): string {
  return `${step}:${component}:`;
}

export async function planTargetedRecovery(
  db: Database | Transaction,
  jobId: string,
  projectId: string | null,
  workQueue: readonly ComponentWorkItem[],
  // MEASUREMENT ONLY (Reliability Audit C2): `audit` lifts the
  // one-recovery-per-component gate so a finished job can be asked, after
  // the fact, whether a known admissible path was still unexplored for an
  // unresolved critical component. Nothing runs on an audit plan; the
  // runtime never passes it.
  opts: { audit?: boolean } = {},
): Promise<TargetedRecoveryPlan | null> {
  if (workQueue.length === 0) return null;
  const items: TargetedRecoveryItem[] = [];
  const results = await db
    .select({ step: researchComponentResults.patternStep, component: researchComponentResults.component, status: researchComponentResults.status, reasonCodes: researchComponentResults.reasonCodes })
    .from(researchComponentResults)
    .where(eq(researchComponentResults.researchJobId, jobId));
  const attempts = await db
    .select({ step: researchAttempts.patternStep, component: researchAttempts.component, attemptNumber: researchAttempts.attemptNumber })
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, jobId));
  const maxAttempt = new Map<string, number>();
  for (const a of attempts) {
    const k = `${a.step}:${a.component}`;
    maxAttempt.set(k, Math.max(maxAttempt.get(k) ?? 0, a.attemptNumber));
  }
  const extracted = await db
    .select({ step: researchTraceEvents.patternStep, component: researchTraceEvents.component, targetRef: researchTraceEvents.targetRef })
    .from(researchTraceEvents)
    .where(and(eq(researchTraceEvents.researchJobId, jobId), eq(researchTraceEvents.operationType, "EXTRACT_ATTEMPTED")));
  const extractedByComponent = new Map<string, Set<string>>();
  for (const e of extracted) {
    if (e.step === null || e.component === null || !e.targetRef) continue;
    const k = `${e.step}:${e.component}`;
    const set = extractedByComponent.get(k) ?? new Set<string>();
    set.add(canonicalTargetRef(e.targetRef));
    extractedByComponent.set(k, set);
  }
  const ledger = await loadAcquisitionLedger(db, jobId);
  const sealed = await sealedDocumentsForJob(db, jobId);
  const routeCache = new Map<string, Awaited<ReturnType<typeof resolveSourceRoute>>>();
  const routeOf = async (url: string) => {
    const key = canonicalTargetRef(url);
    const cached = routeCache.get(key);
    if (cached) return cached;
    const r = await resolveSourceRoute(db, projectId, url);
    routeCache.set(key, r);
    return r;
  };

  // COMPONENT-SPECIFIC VOCABULARY — the rule shared with the site-local
  // expansion (site-local-expansion.ts): each component's name and
  // evidenceGoal, a term weighted by 1 / the number of work-queue
  // components whose vocabulary carries it. Deterministic.
  const plans = new Map<string, Awaited<ReturnType<typeof loadAcquisitionPlan>>>();
  const vocabulary = new Map<string, Set<string>>();
  for (const item of workQueue) {
    const key = `${item.step}:${item.component}`;
    const plan = await loadAcquisitionPlan(db, jobId, item.component, projectId);
    plans.set(key, plan);
    vocabulary.set(key, componentVocabulary(item.component, plan.evidenceGoal));
  }
  const weights = specificityWeights([...vocabulary.values()]);

  for (const item of workQueue) {
    const row = results.find((r) => r.step === item.step && r.component === item.component);
    if (!row || !UNRESOLVED_STATUSES.has(row.status)) continue;
    // One recovery per component, ever: a component already on its second
    // attempt is never planned again.
    if (!opts.audit && (maxAttempt.get(`${item.step}:${item.component}`) ?? 0) !== 1) continue;
    const plan = plans.get(`${item.step}:${item.component}`) ?? (await loadAcquisitionPlan(db, jobId, item.component, projectId));
    if (!plan.criticalComponents.has(item.component)) continue;
    const admits = new Set<EvidenceSourceClass>(plan.establishingClasses);
    const key = `${item.step}:${item.component}`;
    const extractedHere = extractedByComponent.get(key) ?? new Set<string>();
    const prefix = componentPrefix(item.step, item.component);
    const ownCandidates = new Set<string>();
    for (const [k, urls] of ledger.candidatesByQueryComponent) {
      if (!k.startsWith(prefix)) continue;
      for (const url of urls) ownCandidates.add(url);
    }
    const paths: KnownPath[] = [];
    const seen = new Set<string>();
    const consider = async (url: string, discoveredHere: boolean) => {
      const canonical = canonicalTargetRef(url);
      if (seen.has(canonical)) return;
      if (ledger.deadUrls.has(canonical)) return;
      const route = await routeOf(url);
      const onAdmissibleRoute = route.officiality === "CONFIRMED" && route.routeClass !== null && admits.has(route.routeClass as EvidenceSourceClass);
      if (!discoveredHere && !onAdmissibleRoute) return;
      seen.add(canonical);
      if (sealed.byUrl.has(canonical)) {
        if (!extractedHere.has(canonical)) paths.push({ kind: "SEALED_UNEXTRACTED", url, domain: route.officiality === "CONFIRMED" ? new URL(url).hostname : undefined, routeClass: route.routeClass ?? undefined });
        return;
      }
      if (!ledger.fetchedUrls.has(canonical)) {
        paths.push({ kind: "UNOPENED_CANDIDATE", url, domain: route.officiality === "CONFIRMED" ? new URL(url).hostname : undefined, routeClass: route.routeClass ?? undefined });
      }
    };
    for (const url of ownCandidates) await consider(url, true);
    for (const urls of ledger.candidatesByQuery.values()) for (const url of urls) await consider(url, false);
    // Confirmed routes for an admitted class with no candidate of this
    // component on them: never explored for this component.
    const domainsSeen = new Set<string>();
    for (const url of ownCandidates) {
      try {
        domainsSeen.add(new URL(url).hostname.toLowerCase());
      } catch {
        // not a url — nothing to record
      }
    }
    for (const [cls, domains] of Object.entries(plan.confirmedRouteDomainsByClass)) {
      if (!admits.has(cls as EvidenceSourceClass)) continue;
      for (const domain of domains ?? []) {
        if (domainsSeen.has(domain.toLowerCase())) continue;
        paths.push({ kind: "ROUTE_UNEXPLORED", domain, routeClass: cls });
      }
    }
    if (paths.length === 0) continue;
    // RANK THE DOCUMENT PATHS BY RELEVANCE TO THIS COMPONENT. A recovery
    // attempt opens at most TARGETED_RECOVERY_BOUNDS.opens of them, so the
    // order decides what it reads. Primary key: overlap of the url's path
    // (counted twice — a slug names what a page is about) and the sealed
    // document's own words with this component's vocabulary, each term
    // weighted by how specific it is to this component (above). Secondary:
    // overlap with the research task. Ties keep discovery order.
    const ownVocabulary = vocabulary.get(key) ?? componentVocabulary(item.component, plan.evidenceGoal);
    const taskTerms = expansionTerms([plan.researchTask]);
    const scoreOf = (url: string): { specific: number; task: number } => {
      let path = "";
      try {
        path = new URL(url).pathname;
      } catch {
        path = url;
      }
      const canonical = canonicalTargetRef(url);
      const doc = sealed.byUrl.get(canonical);
      return relevanceOf({
        pathTokens: new Set(tokenize(path)),
        textTokens: new Set(tokenize(doc ? doc.normalizedText.slice(0, 2000) : "")),
        vocabulary: ownVocabulary,
        weights,
        taskTerms,
      });
    };
    const ranked = paths
      .map((p, order) => ({ p, order, ...(p.url ? scoreOf(p.url) : { specific: -1, task: -1 }) }))
      .sort((a, b) => b.specific - a.specific || b.task - a.task || a.order - b.order)
      .map((x) => x.p);
    paths.length = 0;
    paths.push(...ranked);
    const needsSearch = paths.some((p) => p.kind === "ROUTE_UNEXPLORED");
    const needsOpen = needsSearch || paths.some((p) => p.kind === "UNOPENED_CANDIDATE");
    items.push({
      step: item.step,
      component: item.component,
      reasonCodes: Array.isArray(row.reasonCodes) ? (row.reasonCodes as unknown[]).filter((c): c is string => typeof c === "string") : [],
      paths,
      needsSearch,
      needsOpen,
    });
  }
  if (items.length === 0) return null;
  return { version: 1, round: 2, items, bounds: { ...TARGETED_RECOVERY_BOUNDS } };
}

// The work-queue items a plan names, in queue order.
export function scopedWorkItems(plan: TargetedRecoveryPlan, workQueue: readonly ComponentWorkItem[]): ComponentWorkItem[] {
  const keys = new Set(plan.items.map((i) => `${i.step}:${i.component}`));
  return workQueue.filter((w) => keys.has(`${w.step}:${w.component}`));
}

export function planItemFor(plan: TargetedRecoveryPlan | null | undefined, step: number, component: string): TargetedRecoveryItem | null {
  if (!plan) return null;
  return plan.items.find((i) => i.step === step && i.component === component) ?? null;
}
