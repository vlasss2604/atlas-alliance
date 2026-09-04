import type { Database, Transaction } from "../db/client";
import { createS4WorkExecutor } from "./s4-executor";
import type { S4ExecutorDeps } from "./s4-executor";
import type { WorkExecutor } from "./controller";

// S10 (live-provider-enablement.md §10/§11, D-118) — the live-provider
// executor. Deliberately the SMALLEST possible wrapper: it supplies NONE
// of S4ExecutorDeps's optional provider/cost-profile overrides, so
// s4-executor.ts's own preflight() falls through to the REAL resolvers
// (resolveSearchGateway/resolveContentFetcher/resolveQueryProposer/
// resolveEvidenceExtractor) and the REAL production cost-profile
// catalogue (model-cost-profile.ts) — exactly the same code path a real
// product research job will use once research_enabled is ever set true.
// This file reimplements NO S4 logic; it only adds the ONE thing a live
// executor needs that a non-live/fixture executor must never have: the
// internal-alpha gate check.
//
// "Live provider construction must not exist as a silent default" (§10):
// this function THROWS unless `internalAlphaEnabled` is explicitly true —
// it never falls back to a fixture, and it is the ONLY function in this
// codebase that can hand back a WorkExecutor wired to real Brave/native-
// fetch/Anthropic providers. Nothing in worker.ts, research-jobs.ts, or
// any HTTP route imports this module — only scripts/alpha-run.ts's
// explicit `--mode=live` path does (see that script's own preflight,
// which checks internal_alpha_enabled itself before ever reaching here —
// this class is the second, independent backstop, not the only one).
export class InternalAlphaGateClosedError extends Error {
  constructor() {
    super("internal_alpha_enabled is false — live S10 executor construction refused (fail closed)");
    this.name = "InternalAlphaGateClosedError";
  }
}

export interface LiveExecutorDeps {
  db: Database | Transaction;
  project: S4ExecutorDeps["project"];
  internalAlphaEnabled: boolean;
}

export function createLiveS4WorkExecutor(deps: LiveExecutorDeps): WorkExecutor {
  if (!deps.internalAlphaEnabled) throw new InternalAlphaGateClosedError();
  return createS4WorkExecutor({ db: deps.db, project: deps.project });
}

// §12 (Internal Alpha Data Boundary, owner decision: YES) — the smallest
// safe boundary compatible with this repository's existing project
// storage: an explicit, code-owned allowlist of project slugs a LIVE
// alpha run may target, checked BEFORE any job is created. Not a
// redesign of project storage, not RBAC — a single set literal, the same
// discipline as source-authority.ts's domain lists and model-cost-
// profile.ts's catalogue (a reviewed code change, never a runtime/DB
// mutation). Distinct from demo_project_slugs (product.ts) — that gates
// what DEMO users may ask about; this gates what LIVE INTERNAL ALPHA
// TOOLING may spend real money researching. Fixture mode is NOT bound by
// this — it never resolves a live provider regardless of project.
export const INTERNAL_ALPHA_LIVE_PROJECT_SLUGS = new Set<string>([
  // §18 — the owner-approved first live target.
  "pump_fun",
  // Owner-approved 2026-08-28, the second live target. Membership here is
  // the ONLY place a project slug appears in live-execution control: the
  // engine itself branches on capability and authority, never on identity.
  "raydium",
]);
