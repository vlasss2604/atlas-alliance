import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

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
const INTENTS_BY_COMPONENT: Record<string, OnchainIntentKind[]> = {
  CURRENT_STATE: ["TOKEN_SUPPLY"],
  NET_EFFECT: ["TOKEN_SUPPLY"],
  DESTINATION: ["ACCOUNT_INFO", "TOKEN_ACCOUNT_BALANCE"],
  RECIPIENT: ["ACCOUNT_INFO", "TOKEN_ACCOUNT_BALANCE"],
  EXECUTION_EVIDENCE: ["SIGNATURES_FOR_ADDRESS"],
  SOURCE_OF_VALUE: ["TOKEN_SUPPLY"],
  FLOW_PATH: ["SIGNATURES_FOR_ADDRESS"],
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
  operationType: "FETCH_ATTEMPTED" | "FETCH_OK" | "FETCH_FAILED" | "CANDIDATE_SKIPPED_BUDGET";
  targetRef: string;
  status: "OK" | "FAILED" | "SKIPPED";
  reasonCode?: "NONE" | "PROVIDER_ERROR" | "SOURCE_OPEN_BUDGET_EXHAUSTED";
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

  for (const intent of intents) {
    if (!retriever.supports(intent.chain, intent.network, intent.kind)) continue;
    const uri = buildCanonicalOnchainUri(intent);

    // Reservation BEFORE the call, always.
    const reserved = await reserve("sourceOpens", 1, deps.maxSourceOpens);
    if (!reserved) {
      await trace({
        operationType: "CANDIDATE_SKIPPED_BUDGET",
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
      // Fail closed: a provider failure is never evidence about the chain.
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
export async function persistOnchainArtifactAndFacts(input: {
  db: Database | Transaction;
  jobId: string;
  artifact: OnchainArtifact;
  identity: ConfirmedProjectIdentity | null;
  target: { step: number; component: string };
}): Promise<PersistOnchainResult> {
  const { db, jobId, artifact, identity, target } = input;

  const containment = evaluateStructuredContainment(artifact, identity);
  if (!containment.contained) {
    return { artifactId: null, evidenceIds: [], rejectedReason: containment.reason };
  }

  const p = artifact.provenance;

  // The canonical URI's shared identity row. sourceType ONCHAIN is
  // descriptive only; it grants no class by itself.
  const urlHash = hashUrl(artifact.canonicalUri);
  const [existingSource] = await db.select().from(sources).where(eq(sources.urlHash, urlHash));
  let sourceId = existingSource?.id;
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

  // One retrieval, stored once. A replayed identical observation inside
  // one job resolves to the same row rather than duplicating provenance.
  const [insertedArtifact] = await db
    .insert(onchainArtifacts)
    .values({
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
    .onConflictDoNothing({
      target: [onchainArtifacts.researchJobId, onchainArtifacts.artifactHash],
    })
    .returning({ id: onchainArtifacts.id });

  let artifactId = insertedArtifact?.id;
  if (!artifactId) {
    const [existing] = await db
      .select({ id: onchainArtifacts.id })
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.artifactHash, p.artifactHash));
    artifactId = existing?.id;
  }
  if (!artifactId) return { artifactId: null, evidenceIds: [], rejectedReason: null };

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
