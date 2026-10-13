import type { ResolvedSourceRoute } from "./source-authority";

// Stage 0 eligibility — who may receive embedded-payload recovery.
//
// The capability is deliberately narrow. Recovering text from a page's
// embedded JSON is safe (parse-only, no execution), but it is still a
// stronger reading of a document than the visible-HTML path, and it must
// not become a general web capability that every search candidate
// silently inherits.
//
// ALL of the following must hold:
//
//   1. officiality === "CONFIRMED"  — a human confirmed this domain
//      belongs to THIS project.
//   2. routeClass === "OFFICIAL_DOCS" — and that confirmation designated
//      it documentation, not merely a domain the project owns.
//   3. matchedPathPrefix !== null — the class came from a PATH-SCOPED
//      row that this url actually matched. A bare domain-wide docs
//      confirmation is NOT sufficient: D-135 exists precisely because
//      "the project owns this domain" and "this specific path is
//      documentation" are different claims, and granting a deeper reading
//      to an entire domain is the over-broad behaviour that decision
//      removed.
//
// Anything else — a search result, an explorer page, a CLAIMED domain, a
// GOVERNANCE route, a confirmed domain outside its docs prefix — gets the
// ordinary static path, unchanged.
export function docsPayloadRecoveryEligible(route: ResolvedSourceRoute): boolean {
  return (
    route.officiality === "CONFIRMED" &&
    route.routeClass === "OFFICIAL_DOCS" &&
    typeof route.matchedPathPrefix === "string" &&
    route.matchedPathPrefix.length > 0
  );
}
