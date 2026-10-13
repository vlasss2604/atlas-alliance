import type { ResolvedSourceRoute } from "./source-authority";

// OWNER INSPECTION eligibility — deliberately the INVERSE of the
// renderer's documentation gate.
//
// evaluateRenderEligibility serves pages that already hold documentation
// authority (routeClass === "OFFICIAL_DOCS"). This serves the opposite
// case: a page a human has confirmed is the project's own, which has NOT
// been granted documentation authority, so the owner can read it before
// deciding whether it deserves any.
//
// The two gates are mutually exclusive by construction. A page cannot be
// eligible for both, so inspection can never become a second, looser route
// into the evidentiary renderer.
//
// This is an AUTHORIZATION gate only. Nothing downstream of it may write
// evidence, call a model, or assign a routeClass — those guarantees live
// in the inspection entrypoint's import graph, not in this predicate.

export type InspectionDenialReason =
  | "NOT_CONFIRMED"
  | "NO_PATH_PREFIX"
  | "ALREADY_CLASSIFIED";

export type InspectionEligibility =
  | { eligible: true; confirmedHost: string; matchedPathPrefix: string }
  | { eligible: false; reason: InspectionDenialReason };

export function evaluateInspectionEligibility(
  url: string,
  route: ResolvedSourceRoute,
): InspectionEligibility {
  // A human must have confirmed the domain belongs to this project.
  if (route.officiality !== "CONFIRMED") {
    return { eligible: false, reason: "NOT_CONFIRMED" };
  }
  // And confirmed it at a SPECIFIC path — a bare domain confirmation does
  // not authorize inspecting arbitrary pages across the whole site.
  const prefix = route.matchedPathPrefix;
  if (typeof prefix !== "string" || prefix.length === 0) {
    return { eligible: false, reason: "NO_PATH_PREFIX" };
  }
  // A page that ALREADY has documentation authority is not an inspection
  // subject: it goes through the ordinary evidentiary path. Inspection
  // exists only for the undecided case.
  if (route.routeClass !== null) {
    return { eligible: false, reason: "ALREADY_CLASSIFIED" };
  }
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return { eligible: false, reason: "NOT_CONFIRMED" };
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { eligible: false, reason: "NOT_CONFIRMED" };
  }
  return { eligible: true, confirmedHost: host, matchedPathPrefix: prefix };
}
