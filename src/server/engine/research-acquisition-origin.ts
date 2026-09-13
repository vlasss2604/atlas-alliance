// WHICH JOB ORIGINS ARE RESEARCH ACQUISITIONS.
//
// An on-chain observation may serve as the historical t0 of a LATER Research
// only if it was acquired by a real Research job. That is a property of the
// PRODUCING JOB, and this is the one place it is stated: a positive allowlist
// of research_jobs.origin values. Anything not listed — an operator's
// bounded observation today, any origin added tomorrow — fails closed until
// a reviewed change admits it. Deliberately not `origin !== OWNER_OBSERVATION`:
// an exclusion list admits every future value by default, which is the
// opposite of what a provenance gate is for.
//
//   PRODUCT             the normal product path, and the alpha-run harness
//                       that drives the full Research handler inline
//   OWNER_MANUAL_ALPHA  the admin manual-admission path (D-123); a full
//                       Research executed by the worker, live when allowed
//
//   OWNER_OBSERVATION   NOT listed. One bounded owner-script read or
//                       document, persisted so it can be inspected and
//                       reconciled within its own job, never reused.

// The same vocabulary research_jobs.origin carries (schema/enums.ts).
export type ResearchJobOrigin = "PRODUCT" | "OWNER_MANUAL_ALPHA" | "OWNER_OBSERVATION";

export const REAL_RESEARCH_ACQUISITION_ORIGINS: ReadonlySet<ResearchJobOrigin> = new Set<ResearchJobOrigin>([
  "PRODUCT",
  "OWNER_MANUAL_ALPHA",
]);

export function isResearchAcquisitionOrigin(origin: string): origin is ResearchJobOrigin {
  return (REAL_RESEARCH_ACQUISITION_ORIGINS as ReadonlySet<string>).has(origin);
}
