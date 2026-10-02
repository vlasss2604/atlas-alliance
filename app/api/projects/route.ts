import { inArray } from "drizzle-orm";

import { errorResponse, requireSession } from "@/src/server/auth/guards";
import { projects } from "@/src/server/db/schema";
import { resolveEntitlement } from "@/src/server/services/entitlement";
import { hasValidPrivateBetaGrant, privateBetaOpen, privateBetaProjectAllowed } from "@/src/server/services/private-beta";
import { getDb, getProductConfig } from "@/src/server/runtime";

// Roster — из БД по статусу, DEMO-доступность — из product_config (Scope ≠
// Entitlement). Locked-проекты видимы (ценность CORE), решает сервер.
export async function GET(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const config = await getProductConfig();
    const entitlement = await resolveEntitlement(db, session.userId, config);

    const rows = await db
      .select({
        slug: projects.slug,
        name: projects.name,
        ticker: projects.ticker,
        status: projects.status,
      })
      .from(projects)
      .where(inArray(projects.status, ["ACTIVE_CORE"]));

    const isCore = entitlement.snapshot.level === "ARI_CORE";
    // PRIVATE BETA (D-167) — while private beta is what admits this user
    // (public path closed, beta switch on, not the owner), "researchable"
    // means what startPrivateBetaResearch will actually admit: a valid
    // grant AND a project on the beta list and the live-spend allowlist.
    // The roster never offers a project the server would refuse.
    const beta = privateBetaOpen(config) && session.role !== "ADMIN";
    const granted = beta ? await hasValidPrivateBetaGrant(db, session.userId) : false;
    return Response.json({
      projects: rows.map((p) => ({
        slug: p.slug,
        name: p.name,
        ticker: p.ticker,
        researchable: beta
          ? granted && privateBetaProjectAllowed(config, p.slug)
          : isCore || config.demo_project_slugs.includes(p.slug),
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
