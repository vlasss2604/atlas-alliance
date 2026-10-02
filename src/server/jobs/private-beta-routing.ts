import type { Database, Transaction } from "../db/client";
import type { ProductConfig } from "../config/product";
import type { WorkExecutor } from "../engine/controller";
import type { ContentFetcher } from "../engine/providers/content-fetcher";
import type { QueryProposer } from "../engine/providers/query-proposer";
import type { SearchGateway } from "../engine/providers/search-gateway";
import { createS4WorkExecutor, type S4ExecutorDeps } from "../engine/s4-executor";
import { privateBetaProjectAllowed } from "../services/private-beta";
import { assertOwnerAlphaLive, evaluateOwnerAlphaLive, type OwnerAlphaLiveSubject } from "./owner-alpha-routing";

// PRIVATE BETA — LIVE EXECUTION GATE (Founder-approved, D-167).
//
// A PRIVATE_BETA job runs the SAME real pipeline as OWNER_MANUAL_ALPHA: the
// same planner, phases, executor, Pattern, reconciliation and Proof. There
// is no beta executor. What differs is only WHO ADMITTED the job, and that
// is recorded on the job (origin), never inferred from a caller.
//
// WHAT IS CHECKED AT EXECUTION, AND WHAT IS NOT.
//   checked, at every phase boundary:
//     - the job is origin = PRIVATE_BETA;
//     - private_beta_enabled is true (the emergency switch — its OWN
//       switch, never internal_alpha_enabled);
//     - the project is still on the beta list AND the live-spend allowlist.
//   NOT checked: the user's beta grant. Entitlement decides whether a NEW
//   Research may start; it was checked at admission. A grant that expires
//   or is revoked afterwards refuses future jobs and never terminates one
//   that was validly admitted (CLAUDE.md access rule; Founder decision 5).
//
// Fail closed, exactly as the owner-alpha gate: a refusal throws, and a
// caller never receives a non-live executor in place of a refused one.
export class PrivateBetaLiveRefusedError extends Error {
  constructor(public readonly reason: "NOT_PRIVATE_BETA" | "PRIVATE_BETA_DISABLED" | "PROJECT_NOT_IN_PRIVATE_BETA") {
    super(`private-beta live execution refused: ${reason}`);
    this.name = "PrivateBetaLiveRefusedError";
  }
}

// Pure: no database read, because nothing about the user is asked here.
export function evaluatePrivateBetaLive(
  subject: Pick<OwnerAlphaLiveSubject, "origin" | "projectSlug">,
  config: Pick<ProductConfig, "private_beta_enabled" | "private_beta_project_slugs">,
): PrivateBetaLiveRefusedError["reason"] | null {
  if (subject.origin !== "PRIVATE_BETA") return "NOT_PRIVATE_BETA";
  if (!config.private_beta_enabled) return "PRIVATE_BETA_DISABLED";
  if (!privateBetaProjectAllowed(config, subject.projectSlug)) return "PROJECT_NOT_IN_PRIVATE_BETA";
  return null;
}

// THE ONE QUESTION EVERY LIVE PHASE ASKS, for whichever admission class the
// job records. A PRIVATE_BETA job is answered by the gate above; every other
// origin is answered by the owner-alpha gate, byte for byte as before — so a
// PRODUCT job is still refused (NOT_OWNER_MANUAL_ALPHA) and an owner job
// still needs ADMIN + allowlist + internal_alpha_enabled.
export async function evaluateJobLiveAdmission(
  db: Database | Transaction,
  subject: OwnerAlphaLiveSubject,
  config: ProductConfig,
): Promise<string | null> {
  if (subject.origin === "PRIVATE_BETA") return evaluatePrivateBetaLive(subject, config);
  return evaluateOwnerAlphaLive(db, subject, config.internal_alpha_enabled);
}

export async function assertJobLiveAdmitted(
  db: Database | Transaction,
  subject: OwnerAlphaLiveSubject,
  config: ProductConfig,
): Promise<void> {
  if (subject.origin === "PRIVATE_BETA") {
    const refusal = evaluatePrivateBetaLive(subject, config);
    if (refusal !== null) throw new PrivateBetaLiveRefusedError(refusal);
    return;
  }
  await assertOwnerAlphaLive(db, subject, config.internal_alpha_enabled);
}

export interface ResolvePrivateBetaExecutorDeps {
  db: Database | Transaction;
  job: { userId: string; origin: string };
  project: S4ExecutorDeps["project"];
  config: ProductConfig;
}

function subjectOf(deps: ResolvePrivateBetaExecutorDeps): OwnerAlphaLiveSubject {
  return { origin: deps.job.origin, userId: deps.job.userId, projectSlug: deps.project.slug };
}

function assertPrivateBetaLive(deps: ResolvePrivateBetaExecutorDeps): void {
  const refusal = evaluatePrivateBetaLive(subjectOf(deps), deps.config);
  if (refusal !== null) throw new PrivateBetaLiveRefusedError(refusal);
}

// The single-process executor for a PRIVATE_BETA job: the REAL S4 executor
// with no provider override, i.e. exactly what createLiveS4WorkExecutor
// returns for an owner job. That wrapper's own backstop is the
// internal-alpha flag, which by Founder decision does not govern private
// beta — so the backstop here is the private-beta gate, asserted on the
// line above the construction, and live-executor.ts stays untouched.
export function resolvePrivateBetaWorkExecutor(deps: ResolvePrivateBetaExecutorDeps): WorkExecutor {
  assertPrivateBetaLive(deps);
  return createS4WorkExecutor({ db: deps.db, project: deps.project });
}

// The EXTRACTING phase's executor for a PRIVATE_BETA job: the same
// construction as resolveOwnerAlphaExtractionExecutor — replayed
// acquisition providers, the real extractor — behind the private-beta gate.
export function resolvePrivateBetaExtractionExecutor(
  deps: ResolvePrivateBetaExecutorDeps & {
    replay: { queryProposer: QueryProposer; searchGateway: SearchGateway; contentFetcher: ContentFetcher };
  },
): WorkExecutor {
  assertPrivateBetaLive(deps);
  return createS4WorkExecutor({
    db: deps.db,
    project: deps.project,
    queryProposer: deps.replay.queryProposer,
    searchGateway: deps.replay.searchGateway,
    contentFetcher: deps.replay.contentFetcher,
  });
}
