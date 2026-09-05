import { and, desc, eq } from "drizzle-orm";

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
import {
  explorerLocatorsForIdentity,
  resolveConfirmedIdentity,
  type ConfirmedProjectIdentity,
} from "../domain/project-identity";
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
  // D-133 — `site:<explorer> <tokenAddress>` locators derived from the
  // project's human-confirmed on-chain identity. Empty when no ACTIVE
  // PROJECT_IDENTITY record with a token address exists, which is the
  // safe default: an explorer is never searched by project name.
  onchainLocators: string[];
  // D-134 — the parsed identity itself, reused by s4-executor.ts at
  // evidence-persist time for entity binding (RISK 2), so this is the
  // single DB read for both purposes.
  confirmedIdentity: ConfirmedProjectIdentity | null;
  intentRequired: ReadonlySet<string>;
  intent: string;
  // ACQUISITION MINIMUM SAFE V1 (A) — context that tells the provider
  // roles WHAT would resolve this component, not merely which project it
  // belongs to. evidenceGoal is the Pattern's own human-authored
  // proposition for this component (CORE data); researchTask is the job's
  // normalized task. Both are null when unavailable — this module's
  // degrade-never-throw contract applies to them exactly as to targeting.
  evidenceGoal: string | null;
  researchTask: string | null;
}

const EMPTY_PLAN: AcquisitionPlan = {
  establishingClasses: [],
  confirmedRouteDomainsByClass: {},
  onchainLocators: [],
  confirmedIdentity: null,
  intentRequired: new Set<string>(),
  intent: "UNKNOWN",
  evidenceGoal: null,
  researchTask: null,
};

// The job's normalized task text, when the Interpreter produced one.
// normalized_task is untyped jsonb; only a non-empty string `task` field
// is used, never a guessed shape.
function normalizedTaskText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const task = (raw as { task?: unknown }).task;
  return typeof task === "string" && task.trim().length > 0 ? task.trim() : null;
}

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
      and(
        eq(projectMemoryItems.projectId, projectId),
        eq(projectMemoryItems.kind, "SOURCE_ROUTE"),
        // Human confirmation is the ACTIVE row and nothing else — an
        // OBSERVED/CANDIDATE/DEPRECATED/SUPERSEDED route confers no
        // authority, exactly as D-074 requires.
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
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

// D-133 — the project's confirmed on-chain identity, if a human has
// ACTIVEd one. Only the identity's own chain bounds which explorers may
// be addressed, and only its token address is used as the query text, so
// neither a project name nor another chain's explorer can leak in.
function onchainLocatorsFor(identity: ConfirmedProjectIdentity | null): string[] {
  return identity ? explorerLocatorsForIdentity(identity) : [];
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
    let evidenceGoal: string | null = null;
    try {
      const requirements = componentRequirementsFor(pattern, component);
      establishingClasses = requirements.establishingClasses;
      evidenceGoal = requirements.evidenceGoal ?? null;
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

    const confirmedIdentity = await resolveConfirmedIdentity(db, projectId);
    return {
      establishingClasses,
      confirmedRouteDomainsByClass: await loadConfirmedRouteDomains(db, projectId),
      onchainLocators: onchainLocatorsFor(confirmedIdentity),
      confirmedIdentity,
      intentRequired: intentRequiredComponents(requirementSet),
      intent,
      evidenceGoal,
      researchTask: normalizedTaskText(job.normalizedTask),
    };
  } catch {
    return EMPTY_PLAN;
  }
}

// D-156 — WHICH OF THESE COMPONENTS COULD THIS SOURCE CLASS ESTABLISH?
//
// The defect this closes: a human-approved resource was routed ONLY to the
// componentKeys a human typed at registration. Those keys are a curation
// hint, not an authority statement, and nothing checked them against the
// Pattern. A CONFIRMED OFFICIAL_DOCS page was therefore bound to
// EXECUTION_EVIDENCE — a component whose establishingClasses do not admit
// OFFICIAL_DOCS at all, so every row extracted for it was excluded as
// CLASS_NOT_ADMISSIBLE — while the components that DO admit OFFICIAL_DOCS,
// and whose evidenceGoal the same document answers, were never shown it.
//
// ROUTING IS NOT ESTABLISHMENT. This answers only "may this component be
// SHOWN this document", so the document reaches each component's own
// extraction with that component's own evidenceGoal. Whether anything
// extracted then ESTABLISHES the component stays entirely with S5's
// establishingClasses check, which is untouched and is asked again there
// per Evidence row. A component that cannot be established by this class
// still cannot be, however it was routed.
//
// It reads the SAME Pattern data S5 reads, through the same
// componentRequirementsFor accessor, so the two cannot drift into
// disagreeing about which classes a component admits.
//
// Degrade-never-throw, like everything else in this module: an unreadable
// pattern, an unconfigured component or a missing topic yields no
// expansion rather than failing a job that would otherwise have run.
export async function componentsAdmittingClass(
  db: Database | Transaction,
  jobId: string,
  sourceClass: EvidenceSourceClass,
  candidates: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    if (!job?.topicId) return [];
    const version = await loadActivePatternVersion(db, job.topicId);
    if (version === null) return [];
    const [patternRow] = await db
      .select({ content: researchPatterns.content })
      .from(researchPatterns)
      .where(eq(researchPatterns.topicId, job.topicId))
      .orderBy(desc(researchPatterns.version))
      .limit(1);
    if (!patternRow) return [];
    const parsed = patternContentSchema.safeParse(patternRow.content);
    if (!parsed.success) return [];

    const out: string[] = [];
    for (const component of candidates) {
      let admits = false;
      try {
        admits = componentRequirementsFor(parsed.data, component).establishingClasses.includes(
          sourceClass,
        );
      } catch {
        // Component not configured in this Pattern — not expanded into.
        admits = false;
      }
      if (admits && !out.includes(component)) out.push(component);
    }
    return out;
  } catch {
    return [];
  }
}
