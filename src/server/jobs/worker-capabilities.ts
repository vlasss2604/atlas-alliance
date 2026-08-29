// D-136 — WHAT A WORKER PROCESS IS ALLOWED TO DO, and nothing about
// where it sits.
//
// The environment cannot give one process every external capability at
// once: the model provider and the search provider are reachable from one
// network position, direct first-party document fetch from another. That
// is a DEPLOYMENT fact. This module is the whole of what the domain is
// permitted to know about it: a closed set of capability names, an
// explicit configuration string that a human sets per process, and the
// map from phase to the capability it requires.
//
// Deliberately absent, and asserted absent by a boundary test: the name of
// any network product or vendor, any location, any route, and any
// INFERENCE of capability from the environment — no DNS probe, no address
// check, no reachability test, no "try it and see". A process that has not
// been told what it may do may do nothing phased at all. Capability is
// declared, never discovered.

export const ACQUISITION_PHASES = ["SEARCHING", "FETCHING", "EXTRACTING"] as const;
export type AcquisitionPhase = (typeof ACQUISITION_PHASES)[number];

// Two capabilities, not three: the phase that searches and the phase that
// extracts need the same external reach (model + search), so they are one
// role. FETCH is the separate role because direct document fetch is the
// one capability that role cannot have at the same time.
export const PHASE_CAPABILITIES = ["SEARCH_EXTRACT", "FETCH"] as const;
export type PhaseCapability = (typeof PHASE_CAPABILITIES)[number];

// Exhaustive by type: a new phase does not compile until it is told which
// capability it requires.
export const PHASE_REQUIRED_CAPABILITY: Record<AcquisitionPhase, PhaseCapability> = {
  SEARCHING: "SEARCH_EXTRACT",
  FETCHING: "FETCH",
  EXTRACTING: "SEARCH_EXTRACT",
};

// The env var a deployment sets, e.g. ATLAS_WORKER_CAPABILITIES="SEARCH_EXTRACT"
// or "FETCH", or both for a single-process development box. Named for the
// capability, never for the network that happens to provide it.
export const WORKER_CAPABILITIES_ENV = "ATLAS_WORKER_CAPABILITIES";

export function isPhaseCapability(value: string): value is PhaseCapability {
  return (PHASE_CAPABILITIES as readonly string[]).includes(value);
}

export function isAcquisitionPhase(value: string): value is AcquisitionPhase {
  return (ACQUISITION_PHASES as readonly string[]).includes(value);
}

// Fail closed in every direction: unset, empty, whitespace and unknown
// names all yield NO capability rather than a permissive default. An
// unknown name is dropped rather than throwing, so a typo cannot take a
// worker process down — but it also never silently grants anything, and
// the caller can see exactly what was accepted.
export function parseWorkerCapabilities(raw: string | undefined | null): Set<PhaseCapability> {
  const out = new Set<PhaseCapability>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const name = part.trim().toUpperCase();
    if (name && isPhaseCapability(name)) out.add(name);
  }
  return out;
}

export function loadWorkerCapabilities(env: NodeJS.ProcessEnv = process.env): Set<PhaseCapability> {
  return parseWorkerCapabilities(env[WORKER_CAPABILITIES_ENV]);
}

export function workerServesPhase(
  capabilities: ReadonlySet<PhaseCapability>,
  phase: AcquisitionPhase,
): boolean {
  return capabilities.has(PHASE_REQUIRED_CAPABILITY[phase]);
}

// The queues a process with these capabilities may subscribe to is
// derived from the capabilities alone — never from what it can reach.
export function phasesServedBy(
  capabilities: ReadonlySet<PhaseCapability>,
): AcquisitionPhase[] {
  return ACQUISITION_PHASES.filter((phase) => workerServesPhase(capabilities, phase));
}
