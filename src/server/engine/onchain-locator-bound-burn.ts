import type { AdmittedLocator } from "./documentary-locator-store";
import { MAX_PROMOTION_DEPTH } from "./onchain-subject-promotion";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  TransactionDetailResult,
} from "./providers/onchain-types";

// LOCATOR-BOUND BURN — a structural association, derived and nothing more.
//
// WHAT THIS ANSWERS. A deterministic BURN names the token account it
// destroyed tokens from. Separately, this job's own provenance records how
// subjects were derived from one another. Put together, exactly one
// question can be answered without inventing anything:
//
//   "Is the account this burn destroyed tokens FROM reachable, through the
//    persisted derivation path, from an on-chain identifier that a document
//    admitted in THIS job states?"
//
// THE NAME WAS CORRECTED, AND THE CORRECTION IS THE POINT. This module was
// first written as DESTINATION_BOUND_BURN, and before that a diagnostic
// proposed ATTRIBUTED. Both overclaimed, for two different reasons, and
// tracing the admission path settled it:
//
//   * ATTRIBUTED asserts cause. Structural reachability does not show that
//     the burned tokens were acquired by any mechanism, or that a mechanism
//     caused the burn.
//   * DESTINATION asserts a ROLE. Nothing in the admission path establishes
//     one. The extractor is asked for "one concrete on-chain address,
//     account, program or transaction signature" — deliberately
//     role-agnostic; `evidence_documentary_locators` has columns for value,
//     shape, literal presence and validation result and NO role column;
//     `AdmittedLocator` carries value, shape, evidence, source and job and
//     no role; and `admittedLocatorsForJob` filters on admissibility alone,
//     with no component predicate at all. A locator may equally be a
//     treasury, a program, the mint, an authority, a fee account or an
//     address of no particular significance, and the same address may be
//     admitted by Evidence that has nothing to do with any destination.
//
// So the bound claim is LOCATOR, and only LOCATOR: an identifier a document
// of this job states, and which this job's own derivation steps connect to
// the burning account. Calling that a destination would be reading a role
// out of prose, which is exactly what the typed layers refuse to do.
//
// ON AUTHORITY, PRECISELY. Admission requires `officiality = CONFIRMED` —
// a human ACTIVEd a SOURCE_ROUTE naming this project and this domain — plus
// a documentary source class. That is a real and checked bar, and it is NOT
// the same as "the project wrote this": OFFICIAL_REPORT is admissible and a
// report published on a project's own domain may be authored by someone
// else. This module therefore says "a document admitted in this job", never
// "a first-party document"; whichever layer establishes authorship is the
// layer entitled to name it.
//
// WHY THE PATH IS THE PROOF. No sentence is generated, no text is matched and
// no model is consulted. The result carries the ordered derivation steps that
// were actually traversed; anyone can re-walk them against the same rows and
// get the same answer or none. A structural claim whose evidence is a
// paragraph is not a structural claim.
//
// PURE. No database access, no query, no row loading. The caller supplies
// already-loaded canonical rows, exactly as `reconcileComponent` is handed
// its Evidence rows rather than fetching them. Nothing persists this result,
// no Evidence row is written, no on-chain fact kind exists for it, and no
// reconciliation path can see it.

// ---- inputs ----------------------------------------------------------

// A narrow projection of one `onchain_derived_subjects` row, following the
// precedent `EvidenceRow` sets in component-reconciler.ts: the pure rule
// declares the fields it actually uses, so it neither imports the schema
// nor silently depends on columns it never reads.
//
// `researchJobId` is NOT a column on that table. It is reached by the
// caller through `onchain_artifact_id -> onchain_artifacts.research_job_id`,
// which is nullable — a standalone owner-script observation has no job. Null
// therefore means "outside any job's provenance boundary" and can never
// satisfy the same-job requirement below.
export interface DerivationEdge {
  parentSubject: string;
  subject: string;
  subjectKind: string;
  derivationMethod: string;
  chain: string;
  network: string;
  projectAnchor: string;
  bindingStatus: string;
  onchainArtifactId: string;
  researchJobId: string | null;
  observedSlot: number;
}

// MUST MATCH `ALLOWED_DERIVATION_METHODS` in onchain-subject-provenance.ts.
//
// Restated rather than imported because that module reaches the database at
// runtime and this one must not. The repository already accepts exactly this
// shape of duplication for exactly this reason — the database enum and the
// code allowlist are two independent places, "so adding a derivation method
// is a reviewed change in both" — and a test asserts the two sets are
// identical, so drift fails loudly rather than widening what a path may
// traverse.
const ALLOWED_PATH_DERIVATION_METHODS: ReadonlySet<string> = new Set([
  "TOKEN_ACCOUNTS_BY_OWNER",
]);

// The traversal bound, reused rather than chosen. `MAX_PROMOTION_DEPTH` is
// how many times acquisition may promote one subject into the next, so it is
// also the longest derivation chain this system is capable of having created.
// A stored path longer than that was not produced by the bounded acquisition
// path, and following it would be following something else.
export const MAX_DERIVATION_PATH_EDGES = MAX_PROMOTION_DEPTH;

export interface LocatorBoundBurnInput {
  // The TRANSACTION_DETAIL observation, branded, exactly as the retriever
  // produced it — so the burn's provenance is the artifact's own.
  artifact: OnchainArtifact;
  // Which decoded burn instruction in that transaction. A transaction may
  // carry several; the caller names one rather than this module choosing.
  burnIndex: number;
  // The job the artifact belongs to (`onchain_artifacts.research_job_id`).
  // Null is a standalone observation and is refused: it is in no job's
  // provenance boundary.
  researchJobId: string | null;
  // Persisted derivation rows available to the caller. Order is irrelevant;
  // only the edges actually traversed are examined.
  edges: readonly DerivationEdge[];
  // On-chain identifiers stated by documents admitted in THIS job.
  // `AdmittedLocator` is the c502112 type: current-job scoped by
  // construction, carrying the Evidence and source that admitted it — and
  // carrying NO role, which is why nothing below calls one a destination.
  // Imported as a TYPE only, so no database module enters this runtime graph.
  admittedLocators: readonly AdmittedLocator[];
}

// ---- outputs ---------------------------------------------------------

export interface DerivationPathStep {
  parentSubject: string;
  subject: string;
  subjectKind: string;
  derivationMethod: string;
  onchainArtifactId: string;
  observedSlot: number;
}

export interface LocatorBoundBurn {
  chain: string;
  network: string;
  projectAnchor: string;
  researchJobId: string;
  // What was destroyed, and from where.
  mint: string;
  sourceAccount: string;
  amountRaw: string;
  decimals: number | null;
  instructionType: BurnInstructionRef["instructionType"];
  authority: string | null;
  // The observation itself, re-verifiable.
  signature: string;
  slot: number;
  canonicalUri: string;
  artifactHash: string;
  rawResponseHash: string;
  // The document-side end of the association.
  root: {
    address: string;
    evidenceId: string;
    sourceId: string;
    researchJobId: string;
  };
  // ORDERED ROOT -> ... -> sourceAccount. This is the whole proof; a reader
  // re-walks it or disbelieves it. Empty means the burn source IS itself an
  // admitted locator — zero hops, which the promotion rules explicitly
  // allow when a documented address is itself a token account for the mint.
  // The wording stays generic on purpose: the burning token account itself
  // was the admitted documentary locator, and that says nothing about what
  // role the document gave it.
  path: readonly DerivationPathStep[];
  hops: number;
}

export type LocatorBoundBurnRefusal =
  // Not a transaction observation at all.
  | "WRONG_FACT_KIND"
  // No decoded burn at that index.
  | "MISSING_BURN_SOURCE"
  // The burn destroyed a different mint than this project's anchor.
  | "MINT_MISMATCH"
  // The observation is in no job's provenance boundary.
  | "NO_PROVENANCE_BOUNDARY"
  // No admitted locator for this job was supplied at all.
  | "ROOT_NOT_ADMITTED"
  // Traversal ran out of edges before reaching an admitted locator.
  | "NO_DERIVATION_PATH"
  // A traversed edge belongs to another research job, or to none.
  | "CROSS_JOB_PATH"
  // A traversed edge belongs to another project anchor.
  | "CROSS_PROJECT_PATH"
  | "CHAIN_MISMATCH"
  | "NETWORK_MISMATCH"
  // A traversed edge is not a shape this module may follow: an unlisted
  // derivation method, a binding that is not CONFIRMED, or an empty subject.
  | "MALFORMED_DERIVATION_EDGE"
  // More than one distinct parent, or more than one admitted locator,
  // could stand at the same position. Never silently resolved.
  | "AMBIGUOUS_ROOT"
  // The path revisits a subject.
  | "CYCLIC_PATH"
  // Still not at an admitted locator after the bounded traversal.
  | "PATH_DEPTH_EXCEEDED";

export type LocatorBoundBurnOutcome =
  | { bound: true; result: LocatorBoundBurn }
  | { bound: false; reason: LocatorBoundBurnRefusal };

function isTransactionDetail(
  artifact: OnchainArtifact,
): artifact is OnchainArtifact & { result: TransactionDetailResult } {
  return artifact.result.kind === "TRANSACTION_DETAIL";
}

// Whether one edge may be followed AT ALL, before it is followed. Checked in
// a fixed order so the reported reason is deterministic for a given input.
function edgeRefusal(
  edge: DerivationEdge,
  boundary: { chain: string; network: string; projectAnchor: string; researchJobId: string },
): LocatorBoundBurnRefusal | null {
  if (edge.chain !== boundary.chain) return "CHAIN_MISMATCH";
  if (edge.network !== boundary.network) return "NETWORK_MISMATCH";
  if (edge.projectAnchor !== boundary.projectAnchor) return "CROSS_PROJECT_PATH";
  if (edge.researchJobId !== boundary.researchJobId) return "CROSS_JOB_PATH";
  if (!ALLOWED_PATH_DERIVATION_METHODS.has(edge.derivationMethod)) {
    return "MALFORMED_DERIVATION_EDGE";
  }
  if (edge.bindingStatus !== "CONFIRMED") return "MALFORMED_DERIVATION_EDGE";
  if (typeof edge.subject !== "string" || edge.subject.length === 0) {
    return "MALFORMED_DERIVATION_EDGE";
  }
  if (typeof edge.parentSubject !== "string" || edge.parentSubject.length === 0) {
    return "MALFORMED_DERIVATION_EDGE";
  }
  if (edge.parentSubject === edge.subject) return "MALFORMED_DERIVATION_EDGE";
  return null;
}

export function deriveLocatorBoundBurn(
  input: LocatorBoundBurnInput,
): LocatorBoundBurnOutcome {
  const { artifact } = input;
  if (!isTransactionDetail(artifact)) return { bound: false, reason: "WRONG_FACT_KIND" };

  const burn: BurnInstructionRef | undefined = artifact.result.burns[input.burnIndex];
  if (!burn) return { bound: false, reason: "MISSING_BURN_SOURCE" };
  if (typeof burn.sourceAccount !== "string" || burn.sourceAccount.length === 0) {
    return { bound: false, reason: "MISSING_BURN_SOURCE" };
  }

  const p = artifact.provenance;
  // THE MINT IS THE ANCHOR, not a parameter. `projectAnchor` came from the
  // ACTIVE PROJECT_IDENTITY when the intent was built, so comparing against
  // it needs no identity lookup here and cannot be pointed elsewhere by a
  // caller. A burn of some other mint is not this project's supply event.
  if (burn.mint !== p.projectAnchor) return { bound: false, reason: "MINT_MISMATCH" };

  if (input.researchJobId === null) return { bound: false, reason: "NO_PROVENANCE_BOUNDARY" };
  const boundary = {
    chain: p.chain as string,
    network: p.network as string,
    projectAnchor: p.projectAnchor,
    researchJobId: input.researchJobId,
  };

  // Locators of THIS job only. An AdmittedLocator carries its own job id
  // (c502112), and one that belongs to another job is not something this
  // burn could be bound to — it is a different run's conclusion.
  const admittedByValue = new Map<string, AdmittedLocator[]>();
  for (const d of input.admittedLocators) {
    if (d.researchJobId !== boundary.researchJobId) continue;
    const existing = admittedByValue.get(d.value);
    if (existing) existing.push(d);
    else admittedByValue.set(d.value, [d]);
  }
  if (admittedByValue.size === 0) return { bound: false, reason: "ROOT_NOT_ADMITTED" };

  // Index child -> the edges that derive it, so traversal is a lookup rather
  // than a scan. Identical rows collapse; genuinely different parents do not.
  const bySubject = new Map<string, DerivationEdge[]>();
  for (const e of input.edges) {
    if (typeof e.subject !== "string" || e.subject.length === 0) continue;
    const existing = bySubject.get(e.subject);
    if (existing) existing.push(e);
    else bySubject.set(e.subject, [e]);
  }

  // WALK CHILD -> PARENT, never the other way. Direction is what makes this
  // a derivation rather than a coincidence: an edge whose addresses are the
  // right pair in the wrong order simply never matches, so a reversed graph
  // yields no path instead of a false one.
  let current = burn.sourceAccount;
  const visited = new Set<string>([current]);
  const reversedPath: DerivationPathStep[] = [];

  for (let hop = 0; hop <= MAX_DERIVATION_PATH_EDGES; hop++) {
    const admitted = admittedByValue.get(current);
    const parents = bySubject.get(current) ?? [];
    const usableParents: DerivationEdge[] = [];
    for (const edge of parents) {
      const refusal = edgeRefusal(edge, boundary);
      // A malformed or out-of-boundary edge ON THE PATH is a refusal, never
      // something to step around in search of a friendlier one.
      if (refusal !== null) return { bound: false, reason: refusal };
      usableParents.push(edge);
    }
    const distinctParents = new Set(usableParents.map((e) => e.parentSubject));

    if (admitted) {
      // Two ways to be ambiguous here, and neither may be resolved silently:
      // the same address admitted by two different Evidence rows, or an
      // address that is BOTH an admitted locator and itself derived from
      // another one. In each case the association is real but its root is
      // not determined, and reporting a determined root would be a claim the
      // data does not make.
      const distinctEvidence = new Set(admitted.map((d) => d.evidenceId));
      if (distinctEvidence.size > 1) return { bound: false, reason: "AMBIGUOUS_ROOT" };
      if (distinctParents.size > 0) return { bound: false, reason: "AMBIGUOUS_ROOT" };
      const root = admitted[0];
      return {
        bound: true,
        result: {
          chain: boundary.chain,
          network: boundary.network,
          projectAnchor: boundary.projectAnchor,
          researchJobId: boundary.researchJobId,
          mint: burn.mint,
          sourceAccount: burn.sourceAccount,
          amountRaw: burn.amountRaw,
          decimals: burn.decimals,
          instructionType: burn.instructionType,
          authority: burn.authority,
          signature: artifact.result.signature,
          slot: p.slot,
          canonicalUri: artifact.canonicalUri,
          artifactHash: p.artifactHash,
          rawResponseHash: p.rawResponseHash,
          root: {
            address: root.value,
            evidenceId: root.evidenceId,
            sourceId: root.sourceId,
            researchJobId: root.researchJobId,
          },
          // Reversed on the way out: stored child -> parent, reported
          // root -> ... -> source, which is the order a reader follows.
          path: [...reversedPath].reverse(),
          hops: reversedPath.length,
        },
      };
    }

    if (hop === MAX_DERIVATION_PATH_EDGES) break;
    if (usableParents.length === 0) return { bound: false, reason: "NO_DERIVATION_PATH" };
    if (distinctParents.size > 1) return { bound: false, reason: "AMBIGUOUS_ROOT" };

    const step = usableParents[0];
    if (visited.has(step.parentSubject)) return { bound: false, reason: "CYCLIC_PATH" };
    visited.add(step.parentSubject);
    reversedPath.push({
      parentSubject: step.parentSubject,
      subject: step.subject,
      subjectKind: step.subjectKind,
      derivationMethod: step.derivationMethod,
      onchainArtifactId: step.onchainArtifactId,
      observedSlot: step.observedSlot,
    });
    current = step.parentSubject;
  }

  // The bound was reached with an unadmitted subject still in hand. Whether
  // a longer path exists is unknown and stays unknown: guessing past the
  // bound is the one thing an unbounded search would add.
  return { bound: false, reason: "PATH_DEPTH_EXCEEDED" };
}

// WHAT A BOUND BURN ESTABLISHES, AND WHERE IT STOPS.
//
// The maximum claim, in full: a deterministic BURN occurred from token
// account S, and S is structurally reachable through this Research job's
// CONFIRMED on-chain derivation path from documentary locator L admitted in
// this same job. Every word beyond that belongs to a layer that does not
// exist yet.
//
// Stated beside the derivation so no consumer can take the association
// without the boundary. Deliberately NOT added to `ONCHAIN_DOES_NOT_PROVE` —
// that structure belongs to persisted fact kinds, and nothing here persists.
export const LOCATOR_BOUND_BURN_DOES_NOT_PROVE =
  "This shows only that the token account a deterministic burn destroyed tokens from is reachable, " +
  "through this job's own recorded derivation steps, from an on-chain identifier stated by a document " +
  "admitted in this job. It does NOT establish what ROLE that identifier plays — it may be a treasury, " +
  "a program, the mint, an authority, a fee account or an address of no particular significance, and " +
  "nothing here makes it a mechanism destination. It does NOT establish that the document was authored " +
  "by the project. It does NOT establish that the burned tokens were purchased by any buyback; it does " +
  "NOT establish that protocol revenue funded them; it does NOT establish when or how the tokens were " +
  "acquired; it does NOT establish that the mechanism caused the burn; and it does NOT establish net " +
  "deflation, any change in total or circulating supply, or holder value accrual.";
