import { and, eq, inArray, sql } from "drizzle-orm";

import type { ProductConfig } from "../config/product";
import type { Database } from "../db/client";
import { ACTIVE_JOB_STATES, projects, researchJobs, topics, users } from "../db/schema";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../engine/live-executor";
import { resolveEntitlement, type EntitlementView } from "./entitlement";

// Scope ≠ Entitlement (канон atlas-intent). Две разные проверки,
// выполняются последовательно и не смешиваются:
//   Scope       — находится ли задача внутри исследовательской области ATLAS;
//   Entitlement — доступна ли она на текущем уровне пользователя.
export type ScopeGate = "SUPPORTED" | "OUT_OF_SCOPE";
export type EntitlementGate = "OK" | "CORE_REQUIRED";
// research === "AVAILABLE" означает ровно одно: startResearch сейчас
// пропустит запуск. Любая другая причина названа явно, чтобы превью не
// расходилось с enforcement (adversarial review, LOW-4).
export type ResearchGate =
  | "AVAILABLE"
  | "NOT_DEEP_RESEARCH"
  | "OUT_OF_SCOPE"
  | "CORE_REQUIRED"
  | "DISABLED"
  | "ACTIVE_JOB_EXISTS"
  | "DEMO_QUOTA_EXHAUSTED";

export interface GateSubject {
  userId: string;
  status: string;
  route: string | null;
  // ВСЕ сущности задачи. Доступна задача целиком или недоступна целиком.
  projectSlugs: string[];
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
  const rows = subject.projectSlugs.length
    ? await db
        .select()
        .from(projects)
        .where(inArray(projects.slug, subject.projectSlugs))
    : [];

  // Scope: тема активна И КАЖДАЯ названная сущность существует
  // в исследуемом статусе. Сущность потерялась — задача вне scope.
  const inScope =
    subject.status === "READY" &&
    !!topic &&
    subject.projectSlugs.length > 0 &&
    rows.length === subject.projectSlugs.length &&
    rows.every((p) => p.status === "ACTIVE_CORE");
  const scope: ScopeGate = inScope ? "SUPPORTED" : "OUT_OF_SCOPE";

  // Entitlement: проект может быть внутри scope ATLAS и при этом
  // недоступен DEMO — это замок, а не «вне области». Проверяется КАЖДАЯ
  // сущность: половина сравнения не выполняется (канон atlas-intent).
  const entitlement: EntitlementGate =
    inScope &&
    level === "DEMO" &&
    !subject.projectSlugs.every((s) => config.demo_project_slugs.includes(s))
      ? "CORE_REQUIRED"
      : "OK";

  // Owner Manual Alpha App Test (D-123) preview parity — the interpretation
  // preview must never promise more than the backend actually allows, and
  // must never grant less than it will. startOwnerManualAlphaResearch
  // (start-owner-alpha-research.ts) is reachable ONLY for role=ADMIN while
  // research_enabled=false, and its job only goes LIVE (as opposed to being
  // created and then refused at worker pickup) when internal_alpha_enabled
  // is true AND the resolved project is in INTERNAL_ALPHA_LIVE_PROJECT_SLUGS
  // (owner-alpha-routing.ts, re-checked independently at execution time —
  // this preview check does not replace that, it only decides what the
  // Proof button may show). Mirrors that same allowlist read-only (never a
  // second list) and only ever runs the extra role lookup while
  // research_enabled=false, so this is a strict no-op for every normal
  // request once research goes public. Neither entitlement nor DEMO quota
  // apply to this path — start-owner-alpha-research.ts checks neither (it
  // uses a fixed ARI_CORE/INTERNAL_ALPHA_V1 snapshot, never DEMO) — so
  // those two gates are the ones this eligibility is allowed to skip;
  // scope and "one active job" still apply exactly as for any other job.
  let ownerAlphaEligible = false;
  if (!config.research_enabled) {
    const [actor] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, subject.userId));
    ownerAlphaEligible =
      actor?.role === "ADMIN" &&
      config.internal_alpha_enabled &&
      scope === "SUPPORTED" &&
      subject.projectSlugs.length > 0 &&
      subject.projectSlugs.every((s) => INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(s));
  }

  // Порядок причин — от свойства самой задачи к состоянию системы:
  // маршрут и scope не зависят от рубильника research_enabled, иначе при
  // выключенном движке «объяснение» неотличимо от «исследование выключено».
  let research: ResearchGate = "AVAILABLE";
  if (subject.route !== "DEEP_RESEARCH") {
    research = "NOT_DEEP_RESEARCH";
  } else if (scope === "OUT_OF_SCOPE") {
    research = "OUT_OF_SCOPE";
  } else if (entitlement === "CORE_REQUIRED" && !ownerAlphaEligible) {
    research = "CORE_REQUIRED";
  } else if (!config.research_enabled && !ownerAlphaEligible) {
    research = "DISABLED";
  } else if (demo && demo.used >= demo.limit && !ownerAlphaEligible) {
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

  const primary = rows.find((p) => p.slug === subject.projectSlugs[0]);
  return {
    scope,
    entitlement,
    research,
    demo,
    topicId: topic?.id ?? null,
    projectId: primary?.id ?? null,
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
