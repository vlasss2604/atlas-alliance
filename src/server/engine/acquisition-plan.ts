import { desc, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { interpretations, projectMemoryItems, researchJobs } from "../db/schema";
import {
  componentRequirementsFor,
  intentRequirementsFor,
  patternContentSchema,
  type IntentRequirementSet,
} from "../domain/pattern";
import { loadActivePatternVersion } from "./active-pattern";
import { intentRequiredComponents } from "./budget-fairness";
import type { EvidenceSourceClass } from "./providers/types";
import { researchPatterns } from "../db/schema";

// D-129/D-130 — everything acquisition needs to know about a job, loaded
// ONCE per attempt from authoritative records only:
//
//   establishingClasses            <- Pattern componentRequirements
//   confirmedRouteDomainsByClass   <- human-confirmed ACTIVE SOURCE_ROUTE
//   intentRequired components      <- Pattern intentRequirements + the
//                                     job's own normalized_intent
//
// Nothing here consults a model, a search provider, or page content. A
// failure to resolve any part degrades to "no targeting / not intent-
// required" rather than throwing: acquisition steering is an
// optimisation, and it must never be able to fail a research job that
// would otherwise have run.

export interface AcquisitionPlan {
  establishingClasses: readonly EvidenceSourceClass[];
  confirmedRouteDomainsByClass: Partial<Record<EvidenceSourceClass, string[]>>;
  intentRequired: ReadonlySet<string>;
  intent: string;
}

const EMPTY_PLAN: AcquisitionPlan = {
  establishingClasses: [],
  confirmedRouteDomainsByClass: {},
  intentRequired: new Set<string>(),
  intent: "UNKNOWN",
};

async function loadIntent(db: Database | Transaction, jobId: string): Promise<string> {
  const [row] = await db
    .select({ result: interpretations.result })
    .from(interpretations)
    .where(eq(interpretations.researchJobId, jobId))
    .orderBy(desc(interpretations.createdAt))
    .limit(1);
  if (!row?.result || typeof row.result !== "object") return "UNKNOWN";
  const result = row.result as { normalized_intent?: unknown };
  return typeof result.normalized_intent === "string" ? result.normalized_intent : "UNKNOWN";
}

// Human-confirmed ACTIVE SOURCE_ROUTE domains for this project, grouped by
// the routeClass the human set. Rows without a routeClass confirm domain
// OWNERSHIP only (officiality), never a class, so they are not usable as
// class targets and are skipped here — consistent with D-074's two
// independent axes.
async function loadConfirmedRouteDomains(
  db: Database | Transaction,
  projectId: string | null,
): Promise<Partial<Record<EvidenceSourceClass, string[]>>> {
  const byClass: Partial<Record<EvidenceSourceClass, string[]>> = {};
  if (!projectId) return byClass;
  const rows = await db
    .select({ content: projectMemoryItems.content })
    .from(projectMemoryItems)
    .where(
      eq(projectMemoryItems.projectId, projectId),
    );
  for (const row of rows) {
    const content = row.content as { domain?: unknown; routeClass?: unknown } | null;
    if (!content || typeof content.domain !== "string") continue;
    if (typeof content.routeClass !== "string") continue;
    const cls = content.routeClass as EvidenceSourceClass;
    const domain = content.domain.toLowerCase().replace(/^www\./, "");
    (byClass[cls] ??= []).push(domain);
  }
  return byClass;
}

export async function loadAcquisitionPlan(
  db: Database | Transaction,
  jobId: string,
  component: string,
  projectId: string | null,
): Promise<AcquisitionPlan> {
  try {
    const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    if (!job?.topicId) return EMPTY_PLAN;
    const version = await loadActivePatternVersion(db, job.topicId);
    if (version === null) return EMPTY_PLAN;
    const [patternRow] = await db
      .select({ content: researchPatterns.content })
      .from(researchPatterns)
      .where(eq(researchPatterns.topicId, job.topicId))
      .orderBy(desc(researchPatterns.version))
      .limit(1);
    if (!patternRow) return EMPTY_PLAN;
    const parsed = patternContentSchema.safeParse(patternRow.content);
    if (!parsed.success) return EMPTY_PLAN;
    const pattern = parsed.data;

    let establishingClasses: readonly EvidenceSourceClass[] = [];
    try {
      establishingClasses = componentRequirementsFor(pattern, component).establishingClasses;
    } catch {
      // Component not configured in CORE for targeting purposes — S5 will
      // surface that as its own configuration failure at reconciliation
      // time; acquisition simply does not steer.
      establishingClasses = [];
    }

    const intent = await loadIntent(db, jobId);
    let requirementSet: IntentRequirementSet | null = null;
    try {
      requirementSet = intentRequirementsFor(pattern, intent);
    } catch {
      // UNKNOWN / out-of-scope intents legitimately have no CORE entry
      // (D-106) — no component is intent-required in that case.
      requirementSet = null;
    }

    return {
      establishingClasses,
      confirmedRouteDomainsByClass: await loadConfirmedRouteDomains(db, projectId),
      intentRequired: intentRequiredComponents(requirementSet),
      intent,
    };
  } catch {
    return EMPTY_PLAN;
  }
}
