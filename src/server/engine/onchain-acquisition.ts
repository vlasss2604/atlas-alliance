import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, onchainArtifacts, sources } from "../db/schema";
import type { ConfirmedProjectIdentity } from "../domain/project-identity";
import type { EvidenceSourceClass } from "./providers/types";
import type { OnchainArtifact, OnchainIntent, OnchainIntentKind } from "./providers/onchain-types";
import { isOnchainArtifact } from "./providers/onchain-types";
import { validateOnchainBinding } from "./onchain-binding";
import { synthesizeOnchainFacts } from "./onchain-facts";
import { buildCanonicalOnchainUri, subjectKindOf } from "./onchain-uri";
import { reserveJobBudget } from "./budget-reservation";
import {
  persistDerivedOnchainSubjects,
} from "./onchain-subject-provenance";
import { persistObservedSignatures } from "./onchain-signature-provenance";
import {
  intentForPromotedSubject,
  MAX_PROMOTED_INTENTS_PER_ATTEMPT,
  promoteFromObservation,
  PROMOTION_ONLY_INTENTS,
} from "./onchain-subject-promotion";
import {
  onchainRetrievalAvailable,
  resolveOnchainRetriever,
  type OnchainRetriever,
} from "./providers/onchain-retriever";

// Structured on-chain acquisition — intent selection, eligibility,
// containment and persistence for the ONCHAIN_VERIFIABLE path.
//
// This module is the boundary where the owner amendments are enforced
// together. Nothing here is project-specific: every address comes from the
// project's confirmed identity or from an already-admitted locator.

// ---- AMENDMENT D: mechanism locators ---------------------------------
//
// A token mint identifies the PROJECT. It does not reveal which program,
// vault or wallet EXECUTES a mechanism, and assuming otherwise is how a
// research engine ends up reading an unrelated account and calling it
// execution evidence.
//
// A mechanism locator is therefore a separate concept with a strict
// provenance requirement: it may be used only when it came from an
// eligible admitted source or from an already-CONFIRMED on-chain artifact
// of this job. A model-extracted address is NEVER promoted automatically —
// a model naming an address is a claim, not a locator.
//
// When no locator exists, mechanism-execution research legitimately stays
// INSUFFICIENT_EVIDENCE. That is an honest outcome, not a gap to paper over.
export type MechanismLocatorOrigin =
  | "CONFIRMED_ONCHAIN_ARTIFACT"
  | "ADMITTED_EVIDENCE_SOURCE";

export interface MechanismLocator {
  address: string;
  origin: MechanismLocatorOrigin;
}

// Subjects this job may legitimately address, in priority order: the
// project's own confirmed identity first, then any locator that earned its
// place. Deliberately returns ONLY the anchor when no locator exists.
export function eligibleSubjects(
  identity: ConfirmedProjectIdentity,
  locators: readonly MechanismLocator[],
): { subject: string; isAnchor: boolean }[] {
  const out = [{ subject: identity.tokenAddress!, isAnchor: true }];
  for (const l of locators) {
    if (l.address && l.address !== identity.tokenAddress) {
      out.push({ subject: l.address, isAnchor: false });
    }
  }
  return out;
}

// ---- intent selection -------------------------------------------------
//
// Which intents could bear on a component, given the Pattern's own
// establishingClasses. Pure data, no project knowledge: a component that
// cannot be established by ONCHAIN_VERIFIABLE gets nothing.
// EVERY ACCOUNT-KIND CHAIN NOW STARTS AT ACCOUNT_INFO.
//
// A base intent is chosen before any observation exists, so a base intent
// can never depend on what an earlier one found. That made owner-discovery
// a question asked before the relationship that gives it meaning was
// established: a documentary locator that is itself a token account was
// asked which token accounts it owns — a question a token account cannot
// answer — and a token-program-owned account with an unresolvable mint was
// asked it too, despite the classifier having just refused to promote it.
//
// The fix is not a call-count optimisation. It is evidence-dependent
// planning: ACCOUNT_INFO establishes WHAT the subject is, and only then
// does promotion decide which downstream question is meaningful.
//
// TOKEN_ACCOUNT_BALANCE left the account-level maps for the same reason,
// and because it is now redundant where it was valid: ACCOUNT_INFO's parsed
// projection already carries amount and decimals for a token account, so
// the balance arrives with the classification instead of costing a second
// bounded read of an address that might not be a token account at all.
const INTENTS_BY_COMPONENT: Record<string, OnchainIntentKind[]> = {
  CURRENT_STATE: ["TOKEN_SUPPLY"],
  NET_EFFECT: ["TOKEN_SUPPLY"],
  // Where value LANDS. Classify the documented account first; promotion
  // then either discovers the token accounts it owns, or — when the
  // locator IS a token account for our mint — stops there, because the
  // holding has already been observed.
  DESTINATION: ["ACCOUNT_INFO"],
  RECIPIENT: ["ACCOUNT_INFO"],
  // Whether a mechanism actually RAN. Same start: a signature window is
  // worth having only on a subject bound to this project, and which
  // subject that is cannot be known before classification.
  EXECUTION_EVIDENCE: ["ACCOUNT_INFO"],
  SOURCE_OF_VALUE: ["TOKEN_SUPPLY"],
  // How value MOVES before it reaches anyone. Same start as the other
  // account-kind components: a raw window on an unclassified documentary
  // address is history that has not been shown to be about this project at
  // all, and the manual investigation established that a documented
  // operational wallet is exactly where such a window says least.
  FLOW_PATH: ["ACCOUNT_INFO"],
};

export function selectOnchainIntents(input: {
  component: string;
  establishingClasses: readonly EvidenceSourceClass[];
  identity: ConfirmedProjectIdentity | null;
  locators?: readonly MechanismLocator[];
  maxIntents: number;
}): OnchainIntent[] {
  // The Pattern decides admissibility; acquisition never overrides it.
  if (!input.establishingClasses.includes("ONCHAIN_VERIFIABLE")) return [];
  if (!input.identity?.tokenAddress) return [];
  if (input.identity.chain !== "solana") return []; // v1: Solana only
  const kinds = INTENTS_BY_COMPONENT[input.component] ?? [];
  if (kinds.length === 0) return [];

  const subjects = eligibleSubjects(input.identity, input.locators ?? []);
  const intents: OnchainIntent[] = [];
  for (const kind of kinds) {
    // STRUCTURAL GATE, not a convention. An intent that may only be
    // reached by promotion is skipped here even if a component map names
    // it, so re-adding one to a base map cannot silently reintroduce a
    // question asked before its prerequisite was established.
    if (PROMOTION_ONLY_INTENTS.has(kind)) continue;
    for (const s of subjects) {
      if (intents.length >= input.maxIntents) return intents;
      // A token-level read is only meaningful against the anchor itself;
      // account-level reads only against a locator-derived account.
      const wantsToken = subjectKindOf(kind) === "token";
      if (wantsToken !== s.isAnchor) continue;
      intents.push({
        kind,
        chain: "solana",
        network: "mainnet",
        projectAnchor: input.identity.tokenAddress,
        subjectKind: subjectKindOf(kind),
        subject: s.subject,
      });
    }
  }
  return intents;
}

// ---- AMENDMENT A: scoped structured containment ----------------------
//
// Normal fetched documents keep the existing containment rules unchanged.
// The structured exception applies ONLY to an artifact that came out of
// the registered retriever path, and only when every condition holds
// together. An arbitrary URL can never reach this function, and a
// look-alike canonical URI on a fetched document proves nothing — the
// decision is made from trusted artifact metadata, never from a string.
export type StructuredContainmentFailure =
  | "NOT_A_STRUCTURED_ARTIFACT"
  | "BINDING_NOT_CONFIRMED";

export type StructuredContainmentOutcome =
  | { contained: true }
  | { contained: false; reason: StructuredContainmentFailure };

export function evaluateStructuredContainment(
  artifact: unknown,
  identity: ConfirmedProjectIdentity | null,
): StructuredContainmentOutcome {
  // (1) produced internally by the retriever path, and (2) of the
  // structured on-chain artifact type. A plain object shaped like one does
  // not satisfy the branded type at compile time and fails this guard at
  // runtime.
  if (!isOnchainArtifact(artifact)) {
    return { contained: false, reason: "NOT_A_STRUCTURED_ARTIFACT" };
  }
  // (3) complete provenance, (4) chain/network match, (5) binding
  // CONFIRMED, (6) response passed the adapter schema — all of which
  // validateOnchainBinding checks together, from artifact fields rather
  // than from the URI (AMENDMENT C).
  const outcome = validateOnchainBinding(artifact, identity);
  if (outcome.binding !== "CONFIRMED") {
    return { contained: false, reason: "BINDING_NOT_CONFIRMED" };
  }
  return { contained: true };
}

// ---- bounded execution ------------------------------------------------
//
// BUDGET (owner-approved): one bounded RPC operation consumes ONE
// sourceOpens reservation, taken BEFORE the call, against the existing
// job ceiling. No new axis, no ceiling increase, and the same
// reservation-before-action contract as every other external action.
//
// Loop safety is structural: MAX_ONCHAIN_INTENTS_PER_ATTEMPT bounds how
// many operations one attempt may perform, the adapter caps page size, and
// every single call must win its own reservation — so a cheap RPC cannot
// outrun the budget even if a caller asked for more.
export const MAX_ONCHAIN_INTENTS_PER_ATTEMPT = 2;

export interface StructuredOnchainOutcome {
  evidenceIds: string[];
  sourceOpensSpent: number;
  observations: string[];
}

export interface RunStructuredOnchainDeps {
  db: Database | Transaction;
  jobId: string;
  attemptId: string | null;
  item: { step: number; component: string };
  plan: {
    establishingClasses: readonly EvidenceSourceClass[];
    confirmedIdentity: ConfirmedProjectIdentity | null;
  };
  maxSourceOpens: number;
  // Seams, so tests drive this without any network and without touching
  // the module-level resolver.
  retriever?: OnchainRetriever | null;
  reserve?: (axis: "sourceOpens", amount: number, max: number) => Promise<boolean>;
  recordTrace?: (event: OnchainTraceEvent) => Promise<void>;
  locators?: readonly MechanismLocator[];
}

export interface OnchainTraceEvent {
  operationType:
    | "FETCH_ATTEMPTED"
    | "FETCH_OK"
    | "FETCH_FAILED"
    | "CANDIDATE_SKIPPED_BUDGET"
    // Promotion decisions. An action the engine took, never a claim.
    | "SUBJECT_PROMOTED"
    | "SUBJECT_PROMOTION_REJECTED"
    | "SUBJECT_PROMOTION_BUDGET_EXHAUSTED"
    | "SUBJECT_PROMOTION_DEPTH_LIMIT"
    | "SUBJECT_PROMOTION_TERMINAL";
  targetRef: string;
  status: "OK" | "FAILED" | "SKIPPED";
  reasonCode?:
    | "NONE"
    | "PROVIDER_ERROR"
    | "SOURCE_OPEN_BUDGET_EXHAUSTED"
    | "PROMOTION_DEPTH_LIMIT"
    | "PROMOTION_NO_ELIGIBLE_SUBJECT"
    | "PROMOTION_BINDING_NOT_CONFIRMED"
    | "PROMOTION_INTENT_CAP_REACHED"
    | "PROMOTION_TERMINAL_OBSERVATION"
    | "PROMOTION_RELATIONSHIP_UNRESOLVED";
}

export async function runStructuredOnchainAcquisition(
  deps: RunStructuredOnchainDeps,
): Promise<StructuredOnchainOutcome> {
  const empty: StructuredOnchainOutcome = {
    evidenceIds: [],
    sourceOpensSpent: 0,
    observations: [],
  };

  const identity = deps.plan.confirmedIdentity;
  const intents = selectOnchainIntents({
    component: deps.item.component,
    establishingClasses: deps.plan.establishingClasses,
    identity,
    locators: deps.locators ?? [],
    maxIntents: MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  });
  if (intents.length === 0) return empty;

  // An unconfigured environment must not fail the attempt — it simply has
  // no structured capability, and the normal path continues.
  let retriever: OnchainRetriever;
  if (deps.retriever) retriever = deps.retriever;
  else if (onchainRetrievalAvailable()) retriever = resolveOnchainRetriever();
  else return { ...empty, observations: ["ONCHAIN_RETRIEVER_NOT_CONFIGURED"] };

  const reserve =
    deps.reserve ??
    ((axis, amount, max) => reserveJobBudget(deps.db, deps.jobId, axis, amount, max));
  const trace = deps.recordTrace ?? (async () => {});

  const evidenceIds: string[] = [];
  const observations: string[] = [];
  let sourceOpensSpent = 0;

  // STAGED EXPANSION, NOT RECURSION. A work list that starts with the base
  // intents and may gain AT MOST MAX_PROMOTED_INTENTS_PER_ATTEMPT more,
  // each one depth-stamped and each one refused past MAX_PROMOTION_DEPTH.
  // The loop cannot outlive those two counters, and every iteration must
  // still win its own budget reservation before it may call anything.
  const queue: { intent: OnchainIntent; depth: number; parent: string | null }[] = intents.map(
    (intent) => ({ intent, depth: 0, parent: null }),
  );
  // Every (kind, subject) this attempt has already addressed. A promoted
  // subject that would repeat one is refused, so a chain cannot loop back
  // on itself or re-read the same account twice.
  const visited = new Set<string>();
  let promotedIssued = 0;

  while (queue.length > 0) {
    const step = queue.shift()!;
    const intent = step.intent;
    if (!retriever.supports(intent.chain, intent.network, intent.kind)) continue;
    const visitKey = `${intent.kind}::${intent.subject}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const uri = buildCanonicalOnchainUri(intent);

    // Reservation BEFORE the call, always.
    const reserved = await reserve("sourceOpens", 1, deps.maxSourceOpens);
    if (!reserved) {
      await trace({
        operationType: step.depth === 0 ? "CANDIDATE_SKIPPED_BUDGET" : "SUBJECT_PROMOTION_BUDGET_EXHAUSTED",
        targetRef: uri,
        status: "SKIPPED",
        reasonCode: "SOURCE_OPEN_BUDGET_EXHAUSTED",
      });
      observations.push("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
      break;
    }
    sourceOpensSpent += 1;
    await trace({ operationType: "FETCH_ATTEMPTED", targetRef: uri, status: "OK" });

    let artifact: OnchainArtifact;
    try {
      artifact = await retriever.retrieve(intent);
    } catch {
      // Fail closed: a provider failure is never evidence about the chain,
      // and never a reason to try the same call again.
      await trace({
        operationType: "FETCH_FAILED",
        targetRef: uri,
        status: "FAILED",
        reasonCode: "PROVIDER_ERROR",
      });
      observations.push("ONCHAIN_RETRIEVAL_FAILED");
      continue;
    }

    const persisted = await persistOnchainArtifactAndFacts({
      db: deps.db,
      jobId: deps.jobId,
      artifact,
      identity,
      target: deps.item,
    });
    if (persisted.rejectedReason) {
      observations.push(`ONCHAIN_REJECTED:${persisted.rejectedReason}`);
      await trace({
        operationType: "FETCH_FAILED",
        targetRef: uri,
        status: "FAILED",
        reasonCode: "PROVIDER_ERROR",
      });
      continue;
    }
    await trace({ operationType: "FETCH_OK", targetRef: uri, status: "OK" });
    evidenceIds.push(...persisted.evidenceIds);

    // DURABLE PROVENANCE FOR WHAT THIS OBSERVATION DISCOVERED. The same
    // stores the owner scripts write, written by the normal path now, so a
    // promoted subject is not a value held in memory for the length of a
    // loop — it is a row anything can later re-check.
    const binding = validateOnchainBinding(artifact, identity);
    const bindingConfirmed = binding.binding === "CONFIRMED";
    if (persisted.artifactId && bindingConfirmed) {
      await persistDerivedOnchainSubjects({
        db: deps.db,
        artifactId: persisted.artifactId,
        artifact,
        binding,
      });
      await persistObservedSignatures({
        db: deps.db,
        artifactId: persisted.artifactId,
        artifact,
        binding,
      });
    }

    // PROMOTION. At most one step further, and only when a typed rule
    // says this observation earned it.
    const outcome = promoteFromObservation({
      artifact,
      bindingConfirmed,
      depth: step.depth,
      component: deps.item.component,
      visited,
    });
    if (outcome.promoted.length === 0) {
      // Not a failure. Most of these are the system declining to go
      // further, which is the behaviour the bounds exist to produce.
      if (outcome.refusal === "TERMINAL_OBSERVATION") {
        await trace({
          operationType: "SUBJECT_PROMOTION_TERMINAL",
          targetRef: uri,
          status: "OK",
          reasonCode: "PROMOTION_TERMINAL_OBSERVATION",
        });
      } else if (outcome.refusal === "DEPTH_LIMIT") {
        await trace({
          operationType: "SUBJECT_PROMOTION_DEPTH_LIMIT",
          targetRef: uri,
          status: "SKIPPED",
          reasonCode: "PROMOTION_DEPTH_LIMIT",
        });
      } else if (outcome.refusal === "BINDING_NOT_CONFIRMED") {
        await trace({
          operationType: "SUBJECT_PROMOTION_REJECTED",
          targetRef: uri,
          status: "SKIPPED",
          reasonCode: "PROMOTION_BINDING_NOT_CONFIRMED",
        });
      } else if (outcome.refusal === "RELATIONSHIP_UNRESOLVED") {
        // NOT the same as "no eligible subject". The account is known to be
        // a token account whose mint could not be established, so the
        // engine stopped rather than guessed — and a reader of the trace
        // must be able to tell that apart from an exhausted search.
        await trace({
          operationType: "SUBJECT_PROMOTION_REJECTED",
          targetRef: uri,
          status: "SKIPPED",
          reasonCode: "PROMOTION_RELATIONSHIP_UNRESOLVED",
        });
      } else if (outcome.refusal === "NO_ELIGIBLE_SUBJECT") {
        await trace({
          operationType: "SUBJECT_PROMOTION_REJECTED",
          targetRef: uri,
          status: "SKIPPED",
          reasonCode: "PROMOTION_NO_ELIGIBLE_SUBJECT",
        });
      }
      continue;
    }

    for (const promoted of outcome.promoted) {
      if (promotedIssued >= MAX_PROMOTED_INTENTS_PER_ATTEMPT) {
        await trace({
          operationType: "SUBJECT_PROMOTION_REJECTED",
          targetRef: uri,
          status: "SKIPPED",
          reasonCode: "PROMOTION_INTENT_CAP_REACHED",
        });
        break;
      }
      const nextIntent = intentForPromotedSubject(promoted);
      promotedIssued += 1;
      // The canonical URI of the NEXT read is the safe identifier for this
      // decision: addresses and signatures are public, and no endpoint,
      // credential or provider string can reach a trace row.
      await trace({
        operationType: "SUBJECT_PROMOTED",
        targetRef: buildCanonicalOnchainUri(nextIntent),
        status: "OK",
        reasonCode: "NONE",
      });
      queue.push({ intent: nextIntent, depth: promoted.depth, parent: promoted.parentSubject });
    }
  }

  return { evidenceIds, sourceOpensSpent, observations };
}

// ---- persistence ------------------------------------------------------

function hashUrl(url: string): string {
  return `sha256:${createHash("sha256").update(url).digest("hex")}`;
}

function extractionUnitKey(
  jobId: string,
  artifactHash: string,
  step: number,
  component: string,
  fragment: string,
): string {
  return `sha256:${createHash("sha256")
    .update([jobId, artifactHash, String(step), component, fragment].join(" "))
    .digest("hex")}`;
}

export interface PersistOnchainResult {
  artifactId: string | null;
  evidenceIds: string[];
  rejectedReason: StructuredContainmentFailure | null;
}

// Persists ONE retrieval artifact and the deterministic facts derived from
// it. The artifact row is written once; every fact references it.
//
// SOURCE CLASS SAFETY: sourceClass is set to ONCHAIN_VERIFIABLE here, by
// code, only AFTER containment/binding succeeded on trusted artifact
// metadata. resolveSourceClass is deliberately NOT consulted — it
// classifies by hostname, and a canonical URI has no meaningful host. No
// model and no document can reach this assignment.
export interface PersistArtifactResult {
  artifactId: string | null;
  sourceId: string | null;
  rejectedReason: StructuredContainmentFailure | null;
}

// Persists ONE retrieval artifact and its canonical-URI source row, and
// nothing else. Extracted from persistOnchainArtifactAndFacts so a caller
// that must NOT write Evidence — establishing durable subject provenance
// is such a caller — can reuse the identical containment check, source
// resolution and idempotent artifact insert instead of a second copy that
// could drift from it.
//
// Containment/binding is still checked here: an artifact that fails it is
// not persisted at all, so there is no path that stores an unbound
// observation and decides what to do about it afterwards.
// The two provenance modes a structured observation may be stored in.
// A discriminated union rather than an optional jobId, so a caller
// cannot omit the job by accident and land in the standalone mode: it
// has to name the mode it wants.
export type OnchainArtifactOrigin =
  | { kind: "RESEARCH_JOB"; jobId: string }
  | { kind: "STANDALONE_STRUCTURED_OBSERVATION" };

export async function persistOnchainArtifact(input: {
  db: Database | Transaction;
  origin: OnchainArtifactOrigin;
  artifact: OnchainArtifact;
  identity: ConfirmedProjectIdentity | null;
}): Promise<PersistArtifactResult> {
  const { db, origin, artifact, identity } = input;

  const containment = evaluateStructuredContainment(artifact, identity);
  if (!containment.contained) {
    return { artifactId: null, sourceId: null, rejectedReason: containment.reason };
  }

  const p = artifact.provenance;
  const jobId = origin.kind === "RESEARCH_JOB" ? origin.jobId : null;

  // The canonical URI's shared identity row — created ONLY for a
  // research-job artifact. A standalone observation has no document to
  // point at, and inventing a sources row to say otherwise is exactly the
  // false assertion this mode exists to avoid. sourceType ONCHAIN is
  // descriptive only; it grants no class by itself.
  let sourceId: string | null = null;
  if (origin.kind === "RESEARCH_JOB") {
    const urlHash = hashUrl(artifact.canonicalUri);
    const [existingSource] = await db.select().from(sources).where(eq(sources.urlHash, urlHash));
    sourceId = existingSource?.id ?? null;
    if (!sourceId) {
      const [created] = await db
        .insert(sources)
        .values({ url: artifact.canonicalUri, urlHash, sourceType: "ONCHAIN" })
        .onConflictDoNothing({ target: sources.urlHash })
        .returning({ id: sources.id });
      if (created) sourceId = created.id;
      else {
        const [afterRace] = await db.select().from(sources).where(eq(sources.urlHash, urlHash));
        sourceId = afterRace!.id;
      }
    }
  }

  // One retrieval, stored once. A replayed identical observation inside
  // one job resolves to the same row rather than duplicating provenance.
  const [insertedArtifact] = await db
    .insert(onchainArtifacts)
    .values({
      originKind: origin.kind,
      researchJobId: jobId,
      sourceId,
      canonicalUri: artifact.canonicalUri,
      chain: p.chain,
      network: p.network,
      projectAnchor: p.projectAnchor,
      subjectKind: p.subjectKind,
      subject: p.subject,
      intentKind: artifact.intent.kind,
      slot: p.slot,
      blockTime: p.blockTime === null ? null : new Date(p.blockTime * 1000),
      blockHash: p.blockHash,
      finality: p.finality,
      transactionSignature: p.transactionSignature,
      retrievalMethod: p.retrievalMethod,
      providerId: p.providerId,
      providerMethod: p.providerMethod,
      requestParams: p.requestParams,
      retrievedAt: p.retrievedAt,
      rawResponseHash: p.rawResponseHash,
      artifactHash: p.artifactHash,
      normalizedResult: JSON.parse(artifact.normalizedText),
    })
    // A standalone row's job id is NULL, and Postgres treats NULLs as
    // distinct — so the job-scoped arbiter constrains nothing there. The
    // partial unique index on artifact_hash is what makes a standalone
    // replay idempotent, and it is named explicitly for that mode.
    .onConflictDoNothing(
      origin.kind === "RESEARCH_JOB"
        ? { target: [onchainArtifacts.researchJobId, onchainArtifacts.artifactHash] }
        : {
            target: onchainArtifacts.artifactHash,
            where: sql`${onchainArtifacts.researchJobId} IS NULL`,
          },
    )
    .returning({ id: onchainArtifacts.id });

  let artifactId = insertedArtifact?.id;
  if (!artifactId) {
    // SCOPED to the same mode. Looking up by hash alone would let a
    // research-job insert that hit a conflict resolve to a STANDALONE
    // row with identical content — a different row, in a different mode,
    // silently returned as if it were this job's. The hash is a content
    // address, so identical content across modes is expected, not rare.
    const [existing] = await db
      .select({ id: onchainArtifacts.id })
      .from(onchainArtifacts)
      .where(
        and(
          eq(onchainArtifacts.artifactHash, p.artifactHash),
          jobId === null
            ? isNull(onchainArtifacts.researchJobId)
            : eq(onchainArtifacts.researchJobId, jobId),
        ),
      );
    artifactId = existing?.id;
  }
  if (!artifactId) return { artifactId: null, sourceId, rejectedReason: null };
  return { artifactId, sourceId, rejectedReason: null };
}

// Persists ONE retrieval artifact and the deterministic facts derived
// from it. The artifact row is written once; every fact references it.
//
// SOURCE CLASS SAFETY: sourceClass is set to ONCHAIN_VERIFIABLE here, by
// code, only AFTER containment/binding succeeded on trusted artifact
// metadata. resolveSourceClass is deliberately NOT consulted — it
// classifies by hostname, and a canonical URI has no meaningful host. No
// model and no document can reach this assignment.
export async function persistOnchainArtifactAndFacts(input: {
  db: Database | Transaction;
  jobId: string;
  artifact: OnchainArtifact;
  identity: ConfirmedProjectIdentity | null;
  target: { step: number; component: string };
}): Promise<PersistOnchainResult> {
  const { db, jobId, artifact, identity, target } = input;
  // Facts require a job — evidence.research_job_id is NOT NULL — so this
  // path is RESEARCH_JOB by construction. That is also why a standalone
  // artifact cannot become Evidence: there is no route from it to here.
  const stored = await persistOnchainArtifact({
    db,
    origin: { kind: "RESEARCH_JOB", jobId },
    artifact,
    identity,
  });
  if (stored.rejectedReason !== null) {
    return { artifactId: null, evidenceIds: [], rejectedReason: stored.rejectedReason };
  }
  const { artifactId, sourceId } = stored;
  if (!artifactId || !sourceId) return { artifactId: null, evidenceIds: [], rejectedReason: null };
  const p = artifact.provenance;

  // MANY facts, ONE artifact.
  const facts = synthesizeOnchainFacts(artifact, target);
  const evidenceIds: string[] = [];
  for (const fact of facts) {
    const [row] = await db
      .insert(evidence)
      .values({
        researchJobId: jobId,
        proofId: null,
        sourceId,
        onchainArtifactId: artifactId,
        // THE ONLY WRITER OF THIS COLUMN, ANYWHERE.
        //
        // `fact.onchainFactKind` exists only on SynthesizedFact, which only
        // deterministic chain synthesis produces. A model-extracted fact
        // has no such field to offer, so no document, prompt or classifier
        // can reach this value — the guarantee is structural, not a rule
        // this insert is trusted to follow.
        onchainFactKind: fact.onchainFactKind,
        patternStep: fact.step,
        component: fact.component,
        relationship: fact.relationship,
        directness: fact.directness,
        fragment: fact.supportFragment,
        summary: fact.statement,
        mechanismState: fact.mechanismState,
        sourceClass: "ONCHAIN_VERIFIABLE",
        // A canonical chain read is not a project's own published claim;
        // officiality is a separate axis and stays CLAIMED unless a
        // human-confirmed route says otherwise (D-074 untouched).
        officiality: "CLAIMED",
        entityBinding: "CONFIRMED",
        fetchedAt: p.retrievedAt,
        publishedAt: fact.publishedAt,
        doesNotProve: fact.doesNotProve,
        retrievedUrl: artifact.canonicalUri,
        contentHash: p.rawResponseHash,
        extractionUnitKey: extractionUnitKey(
          jobId,
          p.artifactHash,
          fact.step,
          fact.component,
          fact.supportFragment,
        ),
      })
      // Must mirror the partial index's own predicate
      // (uq_evidence_extraction_unit_key ... WHERE extraction_unit_key IS
      // NOT NULL) — Postgres cannot infer the arbiter index otherwise. The
      // unit key already includes the job id, so idempotency stays
      // job-scoped without narrowing the clause here.
      .onConflictDoNothing({
        target: evidence.extractionUnitKey,
        where: sql`${evidence.extractionUnitKey} IS NOT NULL`,
      })
      .returning({ id: evidence.id });
    if (row) evidenceIds.push(row.id);
  }

  return { artifactId, evidenceIds, rejectedReason: null };
}
