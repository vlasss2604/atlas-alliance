import { createHash } from "node:crypto";

// THE CANONICAL IDENTITY OF ONE EXTRACTED UNIT OF EVIDENCE.
//
// One (job, source, step, component, normalized support fragment) is ONE
// unit, whatever path wrote it: a fresh model extraction over a fetched
// document (s4-executor.ts) or the adoption of a verified Research Memory
// observation that was originally extracted from that same source fragment
// (memory-evidence-adoption.ts). The same unit must land on the same
// `evidence.extraction_unit_key`, because that key is what the ordinary
// machinery reads as identity: the unique index makes a replayed unit a
// no-op rather than a second row, the S5 reducer deduplicates on it, and
// the S6 assembler partitions a component's support into structural
// lineage slots by it. Keying an adopted row on anything else (its memory
// row id, its own row id, the adoption event) made the same observation
// count twice once fresh work re-acquired it — two slots, a fork, and
// BRANCH_ATTRIBUTION_UNRESOLVED on every downstream component that a
// control job never had.
//
// FAIL CLOSED BY CONSTRUCTION. Two rows collapse only when every input is
// byte-identical after the same whitespace/case normalization fresh
// extraction has always applied: another source row (another url, a
// redirect elsewhere), another step or component, or a fragment that
// differs by one word is a different unit and keeps its own slot. Nothing
// here matches text approximately, and nothing here reads a row id.
export function normalizeForContainment(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function extractionUnitKey(
  jobId: string,
  sourceId: string,
  step: number,
  component: string,
  supportFragment: string,
): string {
  return createHash("sha256")
    .update(`${jobId}|${sourceId}|${step}|${component}|${normalizeForContainment(supportFragment)}`)
    .digest("hex");
}

// THE JOB-INDEPENDENT CORE OF THAT IDENTITY — what a verified observation
// IS across Research jobs: the same source row, step, component and
// normalized passage. Research Memory keys an OBSERVED candidate on it
// (research_memory.observation_key), so a second VERIFIED Research that
// establishes the same passage from the same source adds no second logical
// observation, while a different passage is a different observation. It
// deliberately omits the job: the unit key above is per job by design
// (replay within one job), this one names the observation itself. The two
// are related, never interchangeable: adopting a memory row into a later
// job recomputes `extractionUnitKey(thatJob, source, step, component,
// fragment)` from the copied provenance, which is exactly the key a fresh
// extraction of the same passage in that job would compute.
export function observationKey(
  sourceId: string,
  step: number,
  component: string,
  supportFragment: string,
): string {
  return createHash("sha256")
    .update(`observation|${sourceId}|${step}|${component}|${normalizeForContainment(supportFragment)}`)
    .digest("hex");
}
