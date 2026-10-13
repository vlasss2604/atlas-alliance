import { pathWithinPrefix } from "./rendered-docs-policy";
import type { ResolvedSourceRoute } from "./source-authority";

// OWNER DOCS INSPECTION eligibility — reading a page that ALREADY holds
// documentation authority, without running a research job.
//
// There are now three gates over the same renderer, and they are three
// different questions:
//
//   evaluateInspectionEligibility (inspection-eligibility.ts)
//     "may the owner READ an UNDECIDED confirmed page, so they can decide
//      whether it deserves documentation authority?"  routeClass === null.
//
//   evaluateRenderEligibility (rendered-docs-policy.ts)
//     "may a RESEARCH JOB spend a render on this page?"  Adds the
//      operational conditions a job must satisfy: the renderer is enabled,
//      and the cheap static path demonstrably fell short.
//
//   this one
//     "may the owner READ a page that already HAS documentation
//      authority?"  Same authority conditions as the render gate, none of
//      its operational ones — the owner is not spending a research budget
//      and there is no static fetch to fall short first.
//
// The authority conditions are deliberately IDENTICAL to the render
// gate's, never looser: https, human-CONFIRMED domain, routeClass
// OFFICIAL_DOCS, a path-scoped prefix, and the requested url inside that
// prefix. So this cannot reach any page the evidentiary path could not
// already reach — it only reaches it without a job. That relationship is
// pinned by a property test rather than by this comment.
//
// This is an AUTHORIZATION gate only. That the owner path writes nothing,
// calls no model and touches no chain is a property of the entrypoint's
// import graph, not of this predicate.

export type DocsInspectionDenialReason =
  | "NOT_HTTPS"
  | "NOT_CONFIRMED"
  | "NOT_OFFICIAL_DOCS"
  | "NO_PATH_PREFIX"
  | "URL_OUTSIDE_PREFIX";

export type DocsInspectionEligibility =
  | { eligible: true; confirmedHost: string; matchedPathPrefix: string }
  | { eligible: false; reason: DocsInspectionDenialReason };

export function evaluateDocsInspectionEligibility(
  url: string,
  route: ResolvedSourceRoute,
): DocsInspectionEligibility {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { eligible: false, reason: "NOT_HTTPS" };
  }
  if (parsed.protocol !== "https:") return { eligible: false, reason: "NOT_HTTPS" };

  // A human must have confirmed the domain belongs to this project.
  if (route.officiality !== "CONFIRMED") {
    return { eligible: false, reason: "NOT_CONFIRMED" };
  }
  // And must have granted THIS path documentation authority. Governance or
  // report authority is a different class and is not inspectable here — a
  // narrower gate is the point, not a shared one.
  if (route.routeClass !== "OFFICIAL_DOCS") {
    return { eligible: false, reason: "NOT_OFFICIAL_DOCS" };
  }
  // The authority must be path-scoped. A bare domain-wide confirmation
  // does not authorize reading arbitrary pages across the whole site.
  const prefix = route.matchedPathPrefix;
  if (typeof prefix !== "string" || prefix.length === 0) {
    return { eligible: false, reason: "NO_PATH_PREFIX" };
  }
  // And the requested url must actually sit inside it — segment-bounded,
  // so "/doc" never matches "/documentation". Reuses the render gate's own
  // matcher so the two cannot drift apart.
  if (!pathWithinPrefix(parsed.pathname, prefix)) {
    return { eligible: false, reason: "URL_OUTSIDE_PREFIX" };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host.length === 0) return { eligible: false, reason: "NOT_HTTPS" };
  return { eligible: true, confirmedHost: host, matchedPathPrefix: prefix };
}
