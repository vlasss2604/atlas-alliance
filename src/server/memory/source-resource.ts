import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { projectMemoryItems, projects } from "../db/schema";
import { resolveSourceRoute } from "../engine/source-authority";
import { promoteProjectMemoryItem } from "./lifecycle";

// D-148 — SOURCE_RESOURCE: THE EXACT URL A HUMAN APPROVED AS WORTH FETCHING.
//
// WHY THIS IS NOT A FIELD ON SOURCE_ROUTE. The two answer different
// questions, and the Raydium acceptance run showed what happens when only
// one of them exists:
//
//   SOURCE_ROUTE     "what authority does content under this PREFIX carry?"
//   SOURCE_RESOURCE  "which exact URL is worth spending an acquisition on?"
//
// A route prefix is not a document. This database already holds an ACTIVE
// classified `/docs` route — a whole documentation tree — and two ACTIVE
// route prefixes whose own urls demonstrably serve no document at all (one
// 404s, one never returns a readable page). Seeding acquisition from
// prefixes would therefore fetch directories and dead urls, and the only
// way to tell a prefix from a document by inspection is a path-shape
// heuristic (`.md`, an extension, path depth) that is wrong the first time
// a project publishes extensionless documents. So the distinction is
// recorded by a human instead of guessed by code.
//
// A RESOURCE GRANTS NO AUTHORITY. It never carries a routeClass and never
// reaches Evidence. Its only power is to put a url in front of the ordinary
// bounded acquisition path; what that url is worth is decided, every time,
// by resolveSourceRoute at acquisition. Registration checks authority ONCE
// so a human cannot register a url the project has no authority over — and
// that check is re-run at planning time, so an approval made months ago
// cannot outlive the route that justified it.

export const SOURCE_RESOURCE_KIND = "SOURCE_RESOURCE" as const;

// D-148 — at most three human-approved resources may be seeded into one
// Research. Deliberately small: seeds spend from the SAME maxSourceOpens
// as every other target, so an unbounded seed set would silently convert
// a project's curated sources into the whole acquisition budget. Three is
// enough to carry a mechanism question (a spec page, a destination page,
// a governance page) and small enough that search still does the work it
// is there to do.
export const MAX_SOURCE_RESOURCE_SEEDS = 3;

export type SourceResourceRefusal =
  | "UNKNOWN_PROJECT"
  | "INVALID_URL"
  | "URL_NOT_HTTPS"
  | "URL_HAS_CREDENTIALS"
  | "NO_AUTHORITATIVE_ROUTE"
  | "ROUTE_NOT_CLASSIFIED"
  | "EMPTY_COMPONENT_KEYS"
  | "UNKNOWN_COMPONENT_KEY"
  | "DUPLICATE_ACTIVE_RESOURCE";

export interface SourceResourceContent {
  canonicalUrl: string;
  componentKeys: string[];
}

export interface RegisterSourceResourceInput {
  projectSlug: string;
  url: string;
  componentKeys: string[];
}

export type RegisterSourceResourceResult =
  | {
      ok: true;
      itemId: string;
      projectId: string;
      canonicalUrl: string;
      componentKeys: string[];
      // The authority the route resolver reports for this url RIGHT NOW.
      // Recorded in the result for the operator to read; deliberately NOT
      // persisted on the resource, because it is a fact about the route
      // and it can change without this row changing.
      resolvedAtRegistration: Awaited<ReturnType<typeof resolveSourceRoute>>;
    }
  | { ok: false; refusal: SourceResourceRefusal; detail: string };

// One canonical form for a resource url, so that "the same url" means the
// same thing to registration, to dedup against search candidates, and to
// the planner. Deliberately conservative: it only lowercases the host and
// strips a trailing slash on a non-root path — it never rewrites the path
// itself, never adds or removes an extension, and never touches the query.
// `/foo` and `/foo.md` are different resources here for the same reason
// they are different routes.
export function canonicalizeResourceUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; refusal: SourceResourceRefusal; detail: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, refusal: "INVALID_URL", detail: "not a parseable absolute url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, refusal: "URL_NOT_HTTPS", detail: "a source resource must be https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      refusal: "URL_HAS_CREDENTIALS",
      detail: "credentials are never part of a source resource",
    };
  }
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return { ok: true, url: parsed.toString() };
}

// Read the stored jsonb defensively — a row written long ago is still input.
export function readSourceResourceContent(content: unknown): SourceResourceContent | null {
  const c = (content ?? {}) as { canonicalUrl?: unknown; componentKeys?: unknown };
  if (typeof c.canonicalUrl !== "string" || c.canonicalUrl.length === 0) return null;
  if (!Array.isArray(c.componentKeys)) return null;
  const keys = c.componentKeys.filter((k): k is string => typeof k === "string" && k.length > 0);
  if (keys.length === 0) return null;
  return { canonicalUrl: c.canonicalUrl, componentKeys: keys };
}

// REGISTRATION — a human act, following the same discipline as route
// confirmation: validate against the authoritative record, insert as
// OBSERVED, walk to ACTIVE through the existing lifecycle function.
//
// It performs no fetch. "Approved as worth attempting" is not "fetched
// successfully" and is certainly not "proves a claim"; whether the document
// exists, is readable, or supports anything at all stays entirely with
// acquisition, extraction and admission.
export async function registerSourceResource(
  db: Database,
  input: RegisterSourceResourceInput,
  validComponentKeys: ReadonlySet<string>,
): Promise<RegisterSourceResourceResult> {
  const urlCheck = canonicalizeResourceUrl(input.url);
  if (!urlCheck.ok) return urlCheck;
  const canonicalUrl = urlCheck.url;

  // Component coverage is human-approved and must speak the EXISTING
  // vocabulary — no new taxonomy, and no model input. An empty set would
  // make the resource relevant to nothing, which is not a registration.
  const componentKeys = [...new Set(input.componentKeys.map((k) => k.trim()).filter(Boolean))];
  if (componentKeys.length === 0) {
    return {
      ok: false,
      refusal: "EMPTY_COMPONENT_KEYS",
      detail: "a resource must declare at least one component it is expected to serve",
    };
  }
  for (const key of componentKeys) {
    if (!validComponentKeys.has(key)) {
      return {
        ok: false,
        refusal: "UNKNOWN_COMPONENT_KEY",
        detail: `"${key}" is not a component of the active pattern`,
      };
    }
  }

  const [project] = await db.select().from(projects).where(eq(projects.slug, input.projectSlug));
  if (!project) {
    return {
      ok: false,
      refusal: "UNKNOWN_PROJECT",
      detail: `no project with slug "${input.projectSlug}"`,
    };
  }

  // THE AUTHORITY GATE, asked of the real resolver rather than asserted.
  // A resource may only be registered where the project already holds
  // human-classified authority: the url must resolve, for THIS project, to
  // an ACTIVE route carrying a non-null routeClass. This is what makes
  // cross-project registration and unclassified-path registration
  // impossible rather than merely discouraged.
  const resolved = await resolveSourceRoute(db, project.id, canonicalUrl);
  if (resolved.officiality !== "CONFIRMED") {
    return {
      ok: false,
      refusal: "NO_AUTHORITATIVE_ROUTE",
      detail: `${canonicalUrl} does not resolve to a CONFIRMED route for ${input.projectSlug}`,
    };
  }
  if (resolved.routeClass === null) {
    return {
      ok: false,
      refusal: "ROUTE_NOT_CLASSIFIED",
      detail:
        `${canonicalUrl} is on a confirmed host but no ACTIVE route classifies its path. ` +
        "Classify the route first — a confirmed host is not documentation authority.",
    };
  }

  const existing = await db
    .select()
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, project.id),
        eq(projectMemoryItems.kind, SOURCE_RESOURCE_KIND),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );
  for (const row of existing) {
    const c = readSourceResourceContent(row.content);
    if (c && c.canonicalUrl === canonicalUrl) {
      return {
        ok: false,
        refusal: "DUPLICATE_ACTIVE_RESOURCE",
        detail: `an ACTIVE source resource already registers ${canonicalUrl}`,
      };
    }
  }

  // routeClass is deliberately NOT copied into the content. Authority is
  // the route's to state, and a copy here would be a second, stale answer
  // to a question the resolver already answers correctly.
  const [row] = await db
    .insert(projectMemoryItems)
    .values({
      projectId: project.id,
      kind: SOURCE_RESOURCE_KIND,
      content: { canonicalUrl, componentKeys } satisfies SourceResourceContent,
      lifecycleState: "OBSERVED",
    })
    .returning();

  await promoteProjectMemoryItem(db, row.id);

  return {
    ok: true,
    itemId: row.id,
    projectId: project.id,
    canonicalUrl,
    componentKeys,
    resolvedAtRegistration: resolved,
  };
}

// PLANNING-TIME ELIGIBILITY — every condition re-checked from current
// state, never trusted from the approval.
//
// A resource is eligible only when all of these hold now:
//   * the row belongs to THIS project and is ACTIVE (a SUPERSEDED approval
//     is history, not an instruction);
//   * its declared components intersect what this Research actually needs;
//   * its url STILL resolves, for this project, through an ACTIVE route
//     with a non-null routeClass.
//
// The last one is the reason this function talks to the resolver rather
// than reading a stored class: if the route that justified the approval was
// superseded, the resource loses its standing the moment that happens. An
// approval cannot outlive its authority, and it can never borrow authority
// from some other path.
// D-150 — the same eligibility decision, returning the approved coverage
// alongside the url. The planner needs both: the url to acquire, and the
// components the human approved it for, so it can persist WHY this run
// selected it. Nothing else changes — coverage is read from the same row
// that was already being filtered on.
export async function loadEligibleSourceResourcesWithCoverage(
  db: Database | Transaction,
  projectId: string,
  neededComponents: ReadonlySet<string>,
  limit: number = MAX_SOURCE_RESOURCE_SEEDS,
): Promise<SourceResourceContent[]> {
  if (limit <= 0 || neededComponents.size === 0) return [];

  const rows = await db
    .select()
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, projectId),
        eq(projectMemoryItems.kind, SOURCE_RESOURCE_KIND),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );

  const ordered = [...rows].sort((a, b) => {
    const at = a.createdAt?.getTime() ?? 0;
    const bt = b.createdAt?.getTime() ?? 0;
    return at === bt ? a.id.localeCompare(b.id) : at - bt;
  });

  const out: SourceResourceContent[] = [];
  for (const row of ordered) {
    if (out.length >= limit) break;
    const content = readSourceResourceContent(row.content);
    if (!content) continue;
    if (!content.componentKeys.some((k) => neededComponents.has(k))) continue;

    const resolved = await resolveSourceRoute(db, projectId, content.canonicalUrl);
    if (resolved.officiality !== "CONFIRMED" || resolved.routeClass === null) continue;

    out.push(content);
  }
  return out;
}

export async function loadEligibleSourceResources(
  db: Database | Transaction,
  projectId: string,
  neededComponents: ReadonlySet<string>,
  limit: number = MAX_SOURCE_RESOURCE_SEEDS,
): Promise<string[]> {
  // Urls only, for callers that do not need coverage. One eligibility
  // implementation, so the two can never disagree about what is seedable.
  const eligible = await loadEligibleSourceResourcesWithCoverage(db, projectId, neededComponents, limit);
  return eligible.map((r) => r.canonicalUrl);
}
