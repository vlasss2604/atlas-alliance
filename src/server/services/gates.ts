import { and, eq, inArray, sql } from "drizzle-orm";

import type { ProductConfig } from "../config/product";
import type { Database } from "../db/client";
import { ACTIVE_JOB_STATES, projects, researchJobs, topics } from "../db/schema";
import { resolveEntitlement, type EntitlementView } from "./entitlement";

// Scope ≠ Entitlement (канон atlas-intent). Две разные проверки,
// выполняются последовательно и не смешиваются:
//   Scope       — находится ли задача внутри исследовательской области ATLAS;
//   Entitlement — доступна ли она на текущем уровне пользователя.
export type ScopeGate = "SUPPORTED" | "OUT_OF_SCOPE";
export type EntitlementGate = "OK" | "CORE_REQUIRED";
export type ResearchGate =
  | "AVAILABLE"
  | "DISABLED"
  | "NOT_DEEP_RESEARCH"
  | "ACTIVE_JOB_EXISTS"
  | "DEMO_QUOTA_EXHAUSTED";

export interface GateSubject {
  userId: string;
  status: string;
  route: string | null;
  projectSlug: string | null;
}

export interface GateDecision {
  scope: ScopeGate;
  entitlement: EntitlementGate;
  research: ResearchGate;
  demo: { used: number; limit: number } | null;
  topicId: string | null;
  projectId: string | null;
  entitlementView: EntitlementView;
}

// ОДНА функция для превью (ответ Interpreter) и для enforcement
// (startResearch): превью не может разойтись с реальным решением.
// Квота и «один активный job» в превью — справочные: настоящую атомарную
// проверку делает createResearchJob под FOR UPDATE.
export async function evaluateGates(
  db: Database,
  config: ProductConfig,
  subject: GateSubject,
): Promise<GateDecision> {
  const entitlementView = await resolveEntitlement(db, subject.userId, config);
  const level = entitlementView.snapshot.level;
  const demo =
    level === "DEMO"
      ? { used: entitlementView.demoUsed, limit: entitlementView.demoLimit }
      : null;

  const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
  const [project] = subject.projectSlug
    ? await db.select().from(projects).where(eq(projects.slug, subject.projectSlug))
    : [];

  // Scope: тема активна И проект существует в исследуемом статусе.
  const inScope =
    subject.status === "READY" &&
    !!topic &&
    !!project &&
    project.status === "ACTIVE_CORE";
  const scope: ScopeGate = inScope ? "SUPPORTED" : "OUT_OF_SCOPE";

  // Entitlement: проект может быть внутри scope ATLAS и при этом
  // недоступен DEMO — это замок, а не «вне области».
  const entitlement: EntitlementGate =
    inScope && level === "DEMO" && !config.demo_project_slugs.includes(project.slug)
      ? "CORE_REQUIRED"
      : "OK";

  let research: ResearchGate = "AVAILABLE";
  if (!config.research_enabled) {
    research = "DISABLED";
  } else if (subject.route !== "DEEP_RESEARCH") {
    // QUICK_EXPLANATION / NO_RESEARCH_NEEDED не превращаются в Proof.
    research = "NOT_DEEP_RESEARCH";
  } else if (demo && demo.used >= demo.limit) {
    research = "DEMO_QUOTA_EXHAUSTED";
  } else {
    const active = await db
      .select({ id: researchJobs.id })
      .from(researchJobs)
      .where(
        and(
          eq(researchJobs.userId, subject.userId),
          inArray(researchJobs.state, [...ACTIVE_JOB_STATES]),
        ),
      )
      .limit(1);
    if (active.length > 0) research = "ACTIVE_JOB_EXISTS";
  }

  return {
    scope,
    entitlement,
    research,
    demo,
    topicId: topic?.id ?? null,
    projectId: project?.id ?? null,
    entitlementView,
  };
}

// Нормализация свободного текста для сопоставления с каталогом:
// «Pump.fun», «pump fun», «PUMP_FUN» → один ключ. Детерминированно,
// без участия модели (phase-4-plan §2.6).
export const LOOSE_KEY_SQL = (col: string) =>
  sql.raw(`regexp_replace(lower(${col}), '[^a-z0-9]', '', 'g')`);

export function looseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
