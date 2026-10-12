import { eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { projects } from "../db/schema";
import {
  VALID_ROUTE_CLASSES,
  isValidRouteClass,
  matchesPathPrefix,
  resolveSourceRoute,
  type ResolvedSourceRoute,
  type RouteClass,
} from "../engine/source-authority";
import { loadRouteCandidateReview, type RouteCandidateReviewItem } from "./source-route-candidate-review";
import { classifySourceRoute, communityBroadScopeRefusal, type RouteClassificationRefusal } from "./source-route-classification";
import { confirmSourceRoute, validateDomain, validatePathPrefix, type RouteConfirmationRefusal } from "./source-route-confirmation";

// THE COMBINED OWNER ROUTE DECISION (Source Authority Strategy V1; founder
// decision 2026-10-11, P1-4 accepted into P0).
//
// One owner workflow, TWO explicit logical decisions:
//   1. OWNERSHIP — "this host, at this prefix, is the project's"
//      (confirmSourceRoute, unchanged);
//   2. CLASS — "what sits under that prefix is <CLASS>"
//      (classifySourceRoute, unchanged, including its hard refusals).
// Both run inside ONE transaction, in that order, and leave the same two
// lifecycle records the separate tools leave (the confirmed row, then its
// classified replacement with the confirmed row SUPERSEDED) — so the audit
// trail still shows two decisions. Either refusal rolls back both.
//
// EVERY INPUT IS EXPLICIT. The host, the prefix and the class are the
// owner's typed values. Nothing is inferred or defaulted from a host label,
// a path name, a model, a candidate's class hint, a parent domain or a
// link: the preview SHOWS the hint and the candidate provenance so the
// owner can read them, and this module never passes either to a mutation.
//
// PREVIEW FIRST. previewOwnerRouteDecision is read-only and is what the
// entrypoint prints; decideOwnerRoute mutates and is only reached when the
// owner re-runs with an explicit confirmation.

export type OwnerRouteDecisionRefusal =
  | RouteConfirmationRefusal
  | RouteClassificationRefusal
  | "UNSUPPORTED_ROUTE_CLASS";

export interface OwnerRouteDecisionInput {
  projectSlug: string;
  domain: string;
  pathPrefix: string;
  routeClass: string;
}

export interface OwnerRouteDecisionPreview {
  ok: true;
  projectId: string;
  domain: string;
  pathPrefix: string;
  routeClass: RouteClass;
  // What the real resolver says today for https://<domain><prefix>.
  current: ResolvedSourceRoute;
  // The engine's OBSERVED candidates this decision concerns: the host
  // candidate for the domain and every path proposal the prefix overlaps.
  candidates: RouteCandidateReviewItem[];
}

export type OwnerRouteDecisionPreviewResult =
  | { ok: false; refusal: OwnerRouteDecisionRefusal; detail: string }
  | OwnerRouteDecisionPreview;

export type OwnerRouteDecisionResult =
  | { ok: false; refusal: OwnerRouteDecisionRefusal; detail: string }
  | {
      ok: true;
      confirmedItemId: string;
      classifiedItemId: string;
      domain: string;
      pathPrefix: string;
      routeClass: RouteClass;
      before: ResolvedSourceRoute;
      after: ResolvedSourceRoute;
    };

export async function previewOwnerRouteDecision(
  db: Database,
  input: OwnerRouteDecisionInput,
): Promise<OwnerRouteDecisionPreviewResult> {
  const domainCheck = validateDomain(input.domain);
  if (!domainCheck.ok) return domainCheck;
  const prefixCheck = validatePathPrefix(input.pathPrefix);
  if (!prefixCheck.ok) return prefixCheck;
  if (!isValidRouteClass(input.routeClass)) {
    return { ok: false, refusal: "UNSUPPORTED_ROUTE_CLASS", detail: `class must be one of: ${VALID_ROUTE_CLASSES.join(", ")}` };
  }
  const domain = domainCheck.domain;
  const pathPrefix = prefixCheck.pathPrefix;
  const routeClass: RouteClass = input.routeClass;

  // The SAME hard refusal the classification enforces, surfaced before
  // anything is shown as possible.
  const community = communityBroadScopeRefusal(domain, pathPrefix, routeClass);
  if (community) return { ok: false, ...community };

  const [project] = await db.select().from(projects).where(eq(projects.slug, input.projectSlug));
  if (!project) return { ok: false, refusal: "UNKNOWN_PROJECT", detail: `no project with slug "${input.projectSlug}"` };

  const review = await loadRouteCandidateReview(db, project.id);
  const candidates = [...review.pending, ...review.covered].filter(
    (c) =>
      c.domain === domain &&
      (c.proposedPrefix === null ||
        matchesPathPrefix(c.proposedPrefix, pathPrefix) ||
        matchesPathPrefix(pathPrefix, c.proposedPrefix)),
  );
  const current = await resolveSourceRoute(db, project.id, `https://${domain}${pathPrefix}`);
  return { ok: true, projectId: project.id, domain, pathPrefix, routeClass, current, candidates };
}

export async function decideOwnerRoute(db: Database, input: OwnerRouteDecisionInput): Promise<OwnerRouteDecisionResult> {
  const preview = await previewOwnerRouteDecision(db, input);
  if (!preview.ok) return preview;
  const { domain, pathPrefix, routeClass } = preview;
  const url = `https://${domain}${pathPrefix}`;

  let outcome: OwnerRouteDecisionResult | null = null;
  await db
    .transaction(async (tx) => {
      const before = await resolveSourceRoute(tx, preview.projectId, url);

      // Decision 1 — ownership, by the unchanged confirmation.
      const confirmed = await confirmSourceRoute(tx, { projectSlug: input.projectSlug, domain, pathPrefix });
      if (!confirmed.ok) {
        outcome = confirmed;
        throw new RollbackOwnerDecision();
      }
      // Decision 2 — class, by the unchanged classification, on exactly
      // the row decision 1 just created.
      const classified = await classifySourceRoute(tx, { routeId: confirmed.itemId, routeClass });
      if (!classified.ok) {
        outcome = classified;
        throw new RollbackOwnerDecision();
      }
      outcome = {
        ok: true,
        confirmedItemId: confirmed.itemId,
        classifiedItemId: classified.newItemId,
        domain,
        pathPrefix,
        routeClass,
        before,
        after: await resolveSourceRoute(tx, preview.projectId, url),
      };
    })
    .catch((e: unknown) => {
      if (!(e instanceof RollbackOwnerDecision)) throw e;
    });

  return outcome ?? { ok: false, refusal: "RESOLUTION_WOULD_CHANGE", detail: "the owner decision produced no result" };
}

// Thrown only to roll both decisions back after a refusal was recorded.
class RollbackOwnerDecision extends Error {
  constructor() {
    super("owner route decision rolled back");
    this.name = "RollbackOwnerDecision";
  }
}
