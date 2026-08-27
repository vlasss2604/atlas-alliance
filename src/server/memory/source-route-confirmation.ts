import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { projectMemoryItems, projects } from "../db/schema";
import {
  isBareSharedPlatformBase,
  matchesPathPrefix,
  normalizePathPrefix,
  resolveSourceRoute,
  type ResolvedSourceRoute,
} from "../engine/source-authority";
import { promoteProjectMemoryItem } from "./lifecycle";

// CONFIRMING A SOURCE ROUTE — the owner decision, as code.
//
// D-021/D-055 already said a transition to ACTIVE happens only by a human
// through a controlled, auditable script. `promote-memory.ts` implements
// that for `research_memory`. Nothing implemented it for
// `project_memory_items`, so confirming a domain had no supported path at
// all: every owner entrypoint is explicitly BANNED from route management
// by its own boundary test, and the lifecycle function for project items
// had no caller anywhere. This module is that missing home.
//
// WHAT IT DELIBERATELY CANNOT DO. It cannot set a `routeClass`. Confirming
// that a domain belongs to a project ("this host is theirs") and deciding
// that a page carries documentation authority ("this is their
// documentation") are two different judgements, and the second one should
// follow reading the page, not precede it. There is no parameter for it —
// not a default, not a flag, not an override — so classification cannot be
// a side effect of confirmation. It stays a separate, later owner act.
//
// The result is therefore always: officiality CONFIRMED, routeClass null.
// That opens non-evidentiary inspection and nothing else. Evidentiary
// acquisition and both renderer-as-Evidence entry points all require a
// non-null routeClass and keep refusing.

export type RouteConfirmationRefusal =
  // --- input shape ---------------------------------------------------
  | "UNKNOWN_PROJECT"
  | "EMPTY_DOMAIN"
  | "DOMAIN_HAS_SCHEME"
  | "DOMAIN_HAS_USERINFO"
  | "DOMAIN_HAS_PORT"
  | "DOMAIN_HAS_PATH"
  | "DOMAIN_HAS_WILDCARD"
  | "DOMAIN_NOT_A_HOSTNAME"
  | "DOMAIN_IS_IP_LITERAL"
  | "DOMAIN_IS_SINGLE_LABEL"
  | "DOMAIN_IS_SHARED_PLATFORM_BASE"
  | "PREFIX_EMPTY"
  | "PREFIX_NOT_ABSOLUTE"
  | "PREFIX_HAS_SCHEME_OR_HOST"
  | "PREFIX_HAS_QUERY_OR_FRAGMENT"
  | "PREFIX_HAS_WILDCARD"
  | "PREFIX_HAS_TRAVERSAL"
  | "PREFIX_HAS_WHITESPACE"
  // --- existing state --------------------------------------------------
  | "DUPLICATE_ACTIVE_ROUTE"
  | "OVERLAPPING_ACTIVE_PREFIX"
  | "WOULD_INHERIT_ROUTE_CLASS";

export interface RouteConfirmationInput {
  projectSlug: string;
  domain: string;
  pathPrefix: string;
}

export type RouteConfirmationResult =
  | { ok: false; refusal: RouteConfirmationRefusal; detail: string }
  | {
      ok: true;
      itemId: string;
      projectId: string;
      domain: string;
      pathPrefix: string;
      resolved: ResolvedSourceRoute;
    };

// ---- validation, pure -------------------------------------------------

// A hostname, and nothing that is secretly a URL. Every rejection below
// exists because the value would otherwise be stored and then silently
// never match: route resolution compares against `new URL(url).hostname`,
// which carries no scheme, no userinfo, no port and no path — so a domain
// containing any of them is not a stricter route, it is a dead one.
export function validateDomain(raw: string): { ok: true; domain: string } | { ok: false; refusal: RouteConfirmationRefusal; detail: string } {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, refusal: "EMPTY_DOMAIN", detail: "domain is empty" };
  if (/:\/\//.test(value)) {
    return { ok: false, refusal: "DOMAIN_HAS_SCHEME", detail: "give a bare hostname, not a URL" };
  }
  if (value.includes("@")) {
    return { ok: false, refusal: "DOMAIN_HAS_USERINFO", detail: "credentials are never part of a route" };
  }
  if (value.includes("/") || value.includes("?") || value.includes("#")) {
    return { ok: false, refusal: "DOMAIN_HAS_PATH", detail: "the path belongs in --prefix" };
  }
  if (value.includes("*")) {
    return { ok: false, refusal: "DOMAIN_HAS_WILDCARD", detail: "a route is confirmed for one exact host" };
  }
  if (value.includes(":")) {
    // Matching never sees a port, so a port here could only ever produce a
    // route that matches nothing.
    return { ok: false, refusal: "DOMAIN_HAS_PORT", detail: "route matching compares hostnames, which carry no port" };
  }
  // Normalized on BOTH sides at match time; store it the same way so the
  // stored value is the value that will be compared.
  const host = value.toLowerCase().replace(/^www\./, "");
  if (/\s/.test(host)) {
    return { ok: false, refusal: "DOMAIN_NOT_A_HOSTNAME", detail: "whitespace in hostname" };
  }
  // Label-by-label, so an empty label ("a..b") or a leading/trailing dot
  // is refused rather than normalized away.
  const labels = host.split(".");
  const labelOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  if (!labels.every((l) => labelOk.test(l))) {
    return { ok: false, refusal: "DOMAIN_NOT_A_HOSTNAME", detail: "not a valid hostname" };
  }
  if (/^\d+(\.\d+)*$/.test(host)) {
    return { ok: false, refusal: "DOMAIN_IS_IP_LITERAL", detail: "a project's confirmed domain is a name, not an address" };
  }
  if (labels.length < 2) {
    return { ok: false, refusal: "DOMAIN_IS_SINGLE_LABEL", detail: "a public hostname has at least two labels" };
  }
  // The SAME code-owned list the classifier uses. Confirming a shared
  // platform's base domain would make every tenant's page on it official
  // for this project.
  if (isBareSharedPlatformBase(host)) {
    return { ok: false, refusal: "DOMAIN_IS_SHARED_PLATFORM_BASE", detail: "that host identifies a platform, not this project" };
  }
  return { ok: true, domain: host };
}

// A path prefix, normalized by the authority's own rule so the stored
// value is exactly what matching will compare.
export function validatePathPrefix(raw: string): { ok: true; pathPrefix: string } | { ok: false; refusal: RouteConfirmationRefusal; detail: string } {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, refusal: "PREFIX_EMPTY", detail: "prefix is empty" };
  if (/\s/.test(value)) {
    return { ok: false, refusal: "PREFIX_HAS_WHITESPACE", detail: "whitespace in path prefix" };
  }
  if (/:\/\//.test(value)) {
    return { ok: false, refusal: "PREFIX_HAS_SCHEME_OR_HOST", detail: "give a path, not a URL" };
  }
  if (!value.startsWith("/")) {
    return { ok: false, refusal: "PREFIX_NOT_ABSOLUTE", detail: "a path prefix starts with /" };
  }
  if (value.includes("?") || value.includes("#")) {
    return { ok: false, refusal: "PREFIX_HAS_QUERY_OR_FRAGMENT", detail: "a route is scoped by path only" };
  }
  if (value.includes("*")) {
    return { ok: false, refusal: "PREFIX_HAS_WILDCARD", detail: "matching is segment-bounded already; a wildcard would only widen it" };
  }
  if (value.split("/").includes("..")) {
    return { ok: false, refusal: "PREFIX_HAS_TRAVERSAL", detail: "a traversal segment cannot scope anything" };
  }
  return { ok: true, pathPrefix: normalizePathPrefix(value) };
}

// ---- the confirmation itself ------------------------------------------

interface ReadRouteContent {
  domain: string | null;
  pathPrefix: string | null;
  routeClass: string | null;
}

// The stored jsonb, read defensively and normalized on the same axis the
// resolver normalizes: a row written by hand years ago is still input.
function readRouteContent(content: unknown): ReadRouteContent {
  const c = (content ?? {}) as { domain?: unknown; pathPrefix?: unknown; routeClass?: unknown };
  return {
    domain: typeof c.domain === "string" ? c.domain.toLowerCase().replace(/^www\./, "") : null,
    pathPrefix: typeof c.pathPrefix === "string" ? c.pathPrefix : null,
    routeClass: typeof c.routeClass === "string" ? c.routeClass : null,
  };
}

// TWO SILENT-BREAKAGE HAZARDS, both found by reading how the resolver
// actually combines rows, and both refused here rather than discovered
// later in a failed acquisition:
//
//   1. `matchedPathPrefix` is reported only when EXACTLY ONE path-scoped
//      row matched a url. A new row whose prefix co-matches an existing
//      ACTIVE row's therefore turns that field null for the overlapping
//      urls — silently disabling rendering and inspection for a route that
//      worked yesterday. Confirming a route must never break one.
//
//   2. `routeClass` is resolved from EVERY matching ACTIVE row, not just
//      the closest. An ACTIVE domain-wide row carrying a class would hand
//      that class to this url too, so a confirmation that promises
//      "routeClass null" would quietly grant documentation authority.
//
// Neither is hypothetical; both follow directly from resolveSourceRoute.
export async function confirmSourceRoute(
  db: Database,
  input: RouteConfirmationInput,
): Promise<RouteConfirmationResult> {
  const domainCheck = validateDomain(input.domain);
  if (!domainCheck.ok) return domainCheck;
  const prefixCheck = validatePathPrefix(input.pathPrefix);
  if (!prefixCheck.ok) return prefixCheck;
  const domain = domainCheck.domain;
  const pathPrefix = prefixCheck.pathPrefix;

  const [project] = await db.select().from(projects).where(eq(projects.slug, input.projectSlug));
  if (!project) {
    return { ok: false, refusal: "UNKNOWN_PROJECT", detail: `no project with slug "${input.projectSlug}"` };
  }

  const existing = await db
    .select()
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, project.id),
        eq(projectMemoryItems.kind, "SOURCE_ROUTE"),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );

  for (const row of existing) {
    const c = readRouteContent(row.content);
    if (c.domain !== domain) continue;

    if (c.pathPrefix !== null && normalizePathPrefix(c.pathPrefix) === pathPrefix) {
      return {
        ok: false,
        refusal: "DUPLICATE_ACTIVE_ROUTE",
        detail: `an ACTIVE route already confirms ${domain} at ${pathPrefix}`,
      };
    }
    // Hazard 2: a domain-wide ACTIVE row applies to every url on the host.
    if (c.pathPrefix === null && c.routeClass !== null) {
      return {
        ok: false,
        refusal: "WOULD_INHERIT_ROUTE_CLASS",
        detail: `an ACTIVE domain-wide route for ${domain} carries routeClass ${c.routeClass}, which this url would inherit`,
      };
    }
    // Hazard 1: prefixes that co-match any url, in either direction.
    if (
      c.pathPrefix !== null &&
      (matchesPathPrefix(pathPrefix, c.pathPrefix) || matchesPathPrefix(c.pathPrefix, pathPrefix))
    ) {
      return {
        ok: false,
        refusal: "OVERLAPPING_ACTIVE_PREFIX",
        detail: `an ACTIVE route at ${c.pathPrefix} overlaps ${pathPrefix}; adding this would null the matched prefix for urls both cover`,
      };
    }
  }

  // Inserted as OBSERVED because the database guard permits nothing else,
  // then walked to ACTIVE by the EXISTING lifecycle function — the
  // transitions are not re-implemented here.
  //
  // `content` carries exactly the three documented fields and no more, and
  // routeClass is ABSENT rather than explicitly null: the documented shape
  // treats absent and null identically, and writing the key would invite
  // someone to fill it in.
  const [row] = await db
    .insert(projectMemoryItems)
    .values({
      projectId: project.id,
      kind: "SOURCE_ROUTE",
      content: { domain, pathPrefix },
      lifecycleState: "OBSERVED",
    })
    .returning();

  await promoteProjectMemoryItem(db, row.id);

  // Verified against the real resolver, never assumed from what was
  // written. The url is built from the confirmed values themselves.
  const resolved = await resolveSourceRoute(db, project.id, `https://${domain}${pathPrefix}`);
  return {
    ok: true,
    itemId: row.id,
    projectId: project.id,
    domain,
    pathPrefix,
    resolved,
  };
}
