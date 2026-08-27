import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { projectMemoryItems } from "../db/schema";
import {
  VALID_ROUTE_CLASSES,
  isValidRouteClass,
  normalizePathPrefix,
  resolveSourceRoute,
  type ResolvedSourceRoute,
  type RouteClass,
} from "../engine/source-authority";
import { promoteProjectMemoryItem, supersedeProjectMemoryItem } from "./lifecycle";

// CLASSIFYING A CONFIRMED ROUTE — the owner's SECOND decision.
//
// Confirming that a host belongs to a project and deciding that a page
// carries documentary authority are different judgements, and the second
// should follow reading the page. `confirm-source-route.ts` performs the
// first and deliberately assigns no class; this performs the second, and
// deliberately cannot perform the first.
//
// It acts ONLY on an exact, already-ACTIVE, currently-unclassified route
// the owner names by id. It creates no host, confirms nothing, widens
// nothing, discovers nothing and reads nothing — no fetch, no renderer,
// no model. A domain that "looks official" is not an input.
//
// REPLACEMENT, NOT MUTATION. An ACTIVE project-memory row is an
// authoritative statement a human made, and the lifecycle graph exists to
// model records being replaced rather than edited. The database precedent
// is the same: when `/pump-token` was classified, a new ACTIVE record was
// created and the previous one moved to SUPERSEDED with `supersededBy`
// pointing at its replacement. Note also that the lifecycle trigger fires
// only on `lifecycle_state`, so editing content in place would be an
// UNGUARDED mutation of an authoritative row — precisely what the graph
// exists to prevent.
//
// ATOMIC, because the intermediate state is dangerous. Between inserting
// the replacement and superseding the original there are momentarily two
// co-matching ACTIVE rows, and `resolveSourceRoute` reports
// `matchedPathPrefix` only when EXACTLY ONE path-scoped row matched — so a
// reader in that window sees the prefix vanish, and a crash there would
// leave it vanished for good. The whole transition is one transaction.

export type RouteClassificationRefusal =
  | "ROUTE_NOT_FOUND"
  | "NOT_A_SOURCE_ROUTE"
  | "ROUTE_NOT_ACTIVE"
  | "ALREADY_CLASSIFIED"
  | "MALFORMED_ROUTE_CONTENT"
  | "UNSUPPORTED_ROUTE_CLASS"
  // The swap was performed and then checked against the real resolver, and
  // something other than this route's own class moved. Rolled back.
  | "RESOLUTION_WOULD_CHANGE";

export interface RouteClassificationInput {
  routeId: string;
  routeClass: string;
}

export type RouteClassificationResult =
  | { ok: false; refusal: RouteClassificationRefusal; detail: string }
  | {
      ok: true;
      supersededItemId: string;
      newItemId: string;
      projectId: string;
      domain: string;
      pathPrefix: string | null;
      routeClass: RouteClass;
      before: ResolvedSourceRoute;
      after: ResolvedSourceRoute;
    };

interface RouteContent {
  domain: string;
  pathPrefix: string | null;
  routeClass: string | null;
}

function readRouteContent(content: unknown): RouteContent | null {
  const c = (content ?? {}) as { domain?: unknown; pathPrefix?: unknown; routeClass?: unknown };
  if (typeof c.domain !== "string" || c.domain.trim().length === 0) return null;
  if (c.pathPrefix !== undefined && typeof c.pathPrefix !== "string") return null;
  if (c.routeClass !== undefined && c.routeClass !== null && typeof c.routeClass !== "string") {
    return null;
  }
  return {
    domain: c.domain,
    pathPrefix: typeof c.pathPrefix === "string" ? c.pathPrefix : null,
    routeClass: typeof c.routeClass === "string" ? c.routeClass : null,
  };
}

// A url that lies inside a row's own grant, used to ask the resolver what
// that row currently produces. A prefix-less row is asked about the root.
function representativeUrl(domain: string, pathPrefix: string | null): string {
  return `https://${domain}${pathPrefix === null ? "/" : normalizePathPrefix(pathPrefix)}`;
}

function sameResolution(a: ResolvedSourceRoute, b: ResolvedSourceRoute): boolean {
  return (
    a.officiality === b.officiality &&
    a.routeClass === b.routeClass &&
    a.matchedPathPrefix === b.matchedPathPrefix &&
    a.observation === b.observation
  );
}

export async function classifySourceRoute(
  db: Database,
  input: RouteClassificationInput,
): Promise<RouteClassificationResult> {
  if (!isValidRouteClass(input.routeClass)) {
    return {
      ok: false,
      refusal: "UNSUPPORTED_ROUTE_CLASS",
      detail: `class must be one of: ${VALID_ROUTE_CLASSES.join(", ")}`,
    };
  }
  const routeClass: RouteClass = input.routeClass;

  const [row] = await db
    .select()
    .from(projectMemoryItems)
    .where(eq(projectMemoryItems.id, input.routeId));
  if (!row) {
    return { ok: false, refusal: "ROUTE_NOT_FOUND", detail: `no memory item ${input.routeId}` };
  }
  if (row.kind !== "SOURCE_ROUTE") {
    return {
      ok: false,
      refusal: "NOT_A_SOURCE_ROUTE",
      detail: `item ${input.routeId} is kind ${row.kind}`,
    };
  }
  if (row.lifecycleState !== "ACTIVE") {
    return {
      ok: false,
      refusal: "ROUTE_NOT_ACTIVE",
      detail: `route is ${row.lifecycleState}; only an ACTIVE route may be classified`,
    };
  }
  const content = readRouteContent(row.content);
  if (content === null) {
    return {
      ok: false,
      refusal: "MALFORMED_ROUTE_CONTENT",
      detail: "the stored route content does not satisfy the SOURCE_ROUTE shape",
    };
  }
  if (content.routeClass !== null) {
    return {
      ok: false,
      refusal: "ALREADY_CLASSIFIED",
      detail: `route already carries routeClass ${content.routeClass}; re-classification is a different decision`,
    };
  }

  // Every ACTIVE route of this project, so the check below can prove that
  // NONE of the others moved — not merely that the target one did.
  const siblings = await db
    .select()
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, row.projectId),
        eq(projectMemoryItems.kind, "SOURCE_ROUTE"),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );
  const probeUrls = new Set<string>([representativeUrl(content.domain, content.pathPrefix)]);
  for (const s of siblings) {
    const c = readRouteContent(s.content);
    if (c) probeUrls.add(representativeUrl(c.domain, c.pathPrefix));
  }
  const targetUrl = representativeUrl(content.domain, content.pathPrefix);

  let outcome: RouteClassificationResult | null = null;

  await db.transaction(async (tx) => {
    const before = new Map<string, ResolvedSourceRoute>();
    for (const url of probeUrls) {
      before.set(url, await resolveSourceRoute(tx, row.projectId, url));
    }

    // The replacement carries the SAME domain and the SAME prefix,
    // verbatim — copied from the stored values rather than re-derived, so
    // the route's identity cannot drift and its scope cannot widen. The
    // only difference is the class.
    const nextContent: Record<string, unknown> = { domain: content.domain, routeClass };
    if (content.pathPrefix !== null) nextContent.pathPrefix = content.pathPrefix;

    const [created] = await tx
      .insert(projectMemoryItems)
      .values({
        projectId: row.projectId,
        kind: "SOURCE_ROUTE",
        content: nextContent,
        lifecycleState: "OBSERVED",
      })
      .returning();

    await promoteProjectMemoryItem(tx, created.id);
    // The original steps aside IN THE SAME TRANSACTION, so no reader ever
    // sees two co-matching ACTIVE rows and no crash can leave them.
    await supersedeProjectMemoryItem(tx, row.id, created.id);

    const after = new Map<string, ResolvedSourceRoute>();
    for (const url of probeUrls) {
      after.set(url, await resolveSourceRoute(tx, row.projectId, url));
    }

    // VERIFIED AGAINST THE REAL RESOLVER, not argued for. The target url
    // must differ in exactly one field; every other route's url must be
    // byte-identical. Anything else rolls the whole thing back.
    const b = before.get(targetUrl)!;
    const a = after.get(targetUrl)!;
    const targetChangedOnlyClass =
      a.routeClass === routeClass &&
      b.routeClass === null &&
      a.officiality === b.officiality &&
      a.matchedPathPrefix === b.matchedPathPrefix &&
      a.observation === b.observation;
    if (!targetChangedOnlyClass) {
      outcome = {
        ok: false,
        refusal: "RESOLUTION_WOULD_CHANGE",
        detail:
          `classifying this route would not leave it identically scoped ` +
          `(before: class=${String(b.routeClass)} prefix=${String(b.matchedPathPrefix)}; ` +
          `after: class=${String(a.routeClass)} prefix=${String(a.matchedPathPrefix)})`,
      };
      throw new RollbackClassification();
    }
    for (const url of probeUrls) {
      if (url === targetUrl) continue;
      if (!sameResolution(before.get(url)!, after.get(url)!)) {
        outcome = {
          ok: false,
          refusal: "RESOLUTION_WOULD_CHANGE",
          detail: "classifying this route would change how another confirmed route resolves",
        };
        throw new RollbackClassification();
      }
    }

    outcome = {
      ok: true,
      supersededItemId: row.id,
      newItemId: created.id,
      projectId: row.projectId,
      domain: content.domain,
      pathPrefix: content.pathPrefix,
      routeClass,
      before: b,
      after: a,
    };
  }).catch((e: unknown) => {
    // A deliberate rollback already produced its own refusal; anything
    // else is a real failure and must not be reported as a refusal.
    if (!(e instanceof RollbackClassification)) throw e;
  });

  return (
    outcome ?? {
      ok: false,
      refusal: "RESOLUTION_WOULD_CHANGE",
      detail: "the classification transaction produced no result",
    }
  );
}

// Thrown only to roll the transaction back after a refusal has been
// recorded. Never surfaced.
class RollbackClassification extends Error {
  constructor() {
    super("classification rolled back");
    this.name = "RollbackClassification";
  }
}
