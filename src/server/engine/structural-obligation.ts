import type {
  ConfirmedProgram,
  ConfirmedProjectIdentity,
} from "../domain/project-identity";
import type { EvidenceProvenanceMetadata } from "./onchain-invocation-provenance";
import {
  isInstructionRegistryChain,
  proofApprovalForMethod,
  resolveValueRecipients,
} from "./onchain-instruction-registry";

// D-158 PHASE 2 — A COMPONENT MAY REQUIRE MORE THAN ADMISSIBLE ROWS.
//
// THE DEFECT THIS CLOSES. The reducer's rule was: one admissible
// SUPPORTS/DIRECT row of an establishing class, no downgrade reason, and
// the component is SUPPORTED. For a component whose proposition is CAUSAL
// — "this economic activity produces the value" — that is satisfiable by a
// documentary row asserting something adjacent, because class, polarity
// and directness cannot tell an origin claim from an allocation claim. The
// live PUMP job did exactly that, from four allocation sentences.
//
// THE SHAPE. A component's contract may name zero or more REQUIRED
// structural obligations. Each is a predicate over the component's own
// Evidence rows plus code-owned context. A component naming none behaves
// EXACTLY as before — the evaluation is skipped, not defaulted.
//
// WHY OBLIGATIONS READ ONLY MACHINE-OWNED FIELDS. This is the whole trust
// boundary. An obligation may read a row's source class, officiality,
// entity binding, on-chain fact kind and machine-owned provenance — all
// written by code from the URL, the confirmed route, the confirmed
// identity or the RPC. It may NOT read `statement`, `summary`,
// `relationship` prose or any other model-authored text. A model that
// mislabels a fragment can therefore place a row in a component's pool and
// mark it SUPPORTS/DIRECT, and still cannot make it satisfy an obligation
// whose required shape that row does not have.
//
// DELIBERATELY SMALL. One vocabulary, one evaluator, instantiated for one
// component. Not a DSL, not a general framework, and no other component is
// migrated in this phase.

export const STRUCTURAL_OBLIGATION_IDS = ["SOV.MECHANICAL_PROVENANCE"] as const;

export type StructuralObligationId = (typeof STRUCTURAL_OBLIGATION_IDS)[number];

export function isStructuralObligationId(v: unknown): v is StructuralObligationId {
  return typeof v === "string" && (STRUCTURAL_OBLIGATION_IDS as readonly string[]).includes(v);
}

// WHICH ROWS AN OBLIGATION SEES — THE OTHER HALF OF THE TRUST BOUNDARY.
//
// A structural obligation is a REQUIRED MACHINE-OWNED CONDITION OVER THE
// PERSISTED EVIDENCE POOL. It is not an ordinary establishing relationship,
// and it must not be filtered as though it were.
//
// Ordinary component support stays governed by exactly what governed it
// before — relationship, directness, admissible source class, entity
// binding, freshness, authority — and this phase changes none of them. But
// those rules answer "may this row SPEAK FOR the component", which is a
// different question from "does the machine-owned record show the required
// structural condition". A deterministic chain observation is emitted as
// CONTEXT precisely because movement is not a mechanism; that correct
// judgement about its VOICE says nothing about the metadata it carries.
//
// So the pool is every row of this component that survived the hard
// scope exclusions (right job, right component), and the obligation's own
// conditions are the only further filter. A row that satisfies an
// obligation gains nothing by doing so: it does not become SUPPORTS, does
// not join the establishing set, does not become the component's best
// establishing row, and cannot raise or lower authority. It supplies a
// condition; the ordinary rows still supply the support.
//
// The subset of an Evidence row an obligation may see. Naming it as its own
// type is the enforcement: a field absent here cannot be read by any
// obligation, and every field present here is code-authored.
export interface ObligationEvidenceView {
  sourceClass: string | null;
  officiality: "CONFIRMED" | "CLAIMED" | null;
  entityBinding: "CONFIRMED" | "UNVERIFIED" | null;
  onchainProvenance: EvidenceProvenanceMetadata | null;
  // The reducer's OWN ordinary verdict for this row, computed by the rules
  // that have always governed support. Passed in rather than recomputed so
  // an obligation can never disagree with the reducer about what is
  // establishing, and can never make something establishing.
  establishesComponent: boolean;
  // THE ONE FIELD HERE A MODEL TOUCHED, AND THE LIMIT ON IT.
  //
  // This is the LITERAL RETRIEVED TEXT of the row — the passage as it
  // stands in the document — not `statement`, not `summary`, and not any
  // prose the model wrote ABOUT the passage. Those remain unreachable.
  //
  // A model chooses WHICH passage to quote. It cannot choose what the
  // passage says. Code searches the passage for names a human confirmed,
  // and that is the entire use: no interpretation, no synonyms, no
  // inference. A model that writes "PumpSwap generated revenue" into a
  // summary changes nothing, because the summary is not read.
  supportFragment: string | null;
}

export interface ObligationContext {
  // The project's human-confirmed identity, or null when none is confirmed.
  // Null makes every identity-dependent obligation unmet — an unconfirmed
  // project cannot have its activities matched to programs.
  confirmedIdentity: ConfirmedProjectIdentity | null;
}

// D-158 PHASE 2 CORRECTION — SAME PROJECT IS NOT SAME ACTIVITY.
//
// THE HOLE THIS CLOSES. Documentary support said "bonding curve revenue is
// a source of protocol revenue"; machine provenance proved a fee inflow
// caused by the PumpSwap program. Both true, both about this project, both
// admitted — and between them they proved NOTHING, because they are about
// two different activities. Two facts about two activities do not compose
// into one causal proposition.
//
//   SAME COMPONENT != SAME ACTIVITY != SAME CAUSAL PROPOSITION
//
// THE JOIN KEY IS THE ONE ALREADY IN THE CONTRACT. A confirmed identity
// already maps activity -> programId, entered by a human. That mapping is
// the join: the documentary side must literally name an activity, and the
// mechanical side must be caused by exactly that activity's confirmed
// program. No new ontology, no entity linker, no model-assigned label.

// Normalised for LITERAL comparison only. Case is folded and every run of
// non-alphanumeric characters becomes one space, so "Bonding-Curve",
// "bonding curve" and "Bonding  Curve" are the same three tokens.
//
// THAT IS THE WHOLE TRANSFORMATION. No stemming, no plural handling, no
// synonyms, no edit distance. "bonding curves" does not match "bonding
// curve", and it should not: if a project's documents say it that way, a
// human adds it as an alias. Fuzzy matching here would be the model-free
// version of exactly the guessing this architecture rejects.
function normalizeForLiteralMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A name too short to be evidence of anything. Two characters occur inside
// ordinary words constantly, and a bindable name must be specific enough
// that its literal presence means something.
const MIN_BINDABLE_NAME_LENGTH = 3;

// Every human-confirmed name for one activity: its label plus its
// human-confirmed aliases. Nothing else is a name for it.
function confirmedNamesOf(program: ConfirmedProgram): string[] {
  return [program.activity, ...(program.aliases ?? [])];
}

// Does this passage LITERALLY contain this name, at token boundaries?
//
// Boundary-anchored so "curve" does not match inside "curvature", and
// substring-based rather than regex-based so a name containing regex
// metacharacters is compared as text rather than compiled as a pattern.
function fragmentNamesActivity(fragment: string, name: string): boolean {
  const needle = normalizeForLiteralMatch(name);
  if (needle.length < MIN_BINDABLE_NAME_LENGTH) return false;
  return ` ${normalizeForLiteralMatch(fragment)} `.includes(` ${needle} `);
}

export type ObligationOutcome =
  | { met: true }
  // Closed and code-authored, so a refusal never carries free text.
  | { met: false; reason: "MECHANICAL_PROVENANCE_NOT_ESTABLISHED" };

// SOV.MECHANICAL_PROVENANCE — all conditions required, all read from
// code-owned fields:
//
//   ordinary establishing support whose LITERAL passage names a
//   human-confirmed activity X (or a human-confirmed alias of X) ->
//   confirmed activity X -> confirmed program P -> deterministically
//   decoded method M -> registry approves M as PROTOCOL_VALUE_INFLOW ->
//   registry deterministically identifies the protocol-value recipient R
//   -> an attributable transfer in that SAME invocation -> its destination
//   IS R -> the asset is external, not the project's own mint -> the
//   required entity binding is satisfied.
//
// AND NOTHING BROADER. Met, this establishes the MECHANICS of one value
// arrival, FOR THE ACTIVITY THE SUPPORT NAMED: that this program, by this
// method, moved this external asset into the account its own interface
// designates as the protocol's. It does not establish that the amount is
// revenue net of anything, that this is all of the protocol's income, that
// demand was genuine, that the project's OTHER activities produce value,
// or that the activity is durable.
//
// EVERY FAILURE IS UNMET, NEVER INFERRED AROUND. Absence of a qualifying
// row is not evidence that no such transaction exists; it is only absence
// of proof, which is what unmet means.
function evaluateMechanicalProvenance(
  rows: readonly ObligationEvidenceView[],
  ctx: ObligationContext,
): ObligationOutcome {
  const identity = ctx.confirmedIdentity;
  // (2,3) Without a confirmed identity there is no activity->program
  // mapping, so nothing can be matched.
  const programs = identity?.programs ?? [];
  if (identity === null || programs.length === 0) {
    return { met: false, reason: "MECHANICAL_PROVENANCE_NOT_ESTABLISHED" };
  }
  // The approval registry is consulted for the identity's OWN chain. A
  // chain the registry does not decode has no approvals, so the obligation
  // is unmet there — it is never answered from another chain's registry.
  const registryChain = identity.chain;
  if (!isInstructionRegistryChain(registryChain)) {
    return { met: false, reason: "MECHANICAL_PROVENANCE_NOT_ESTABLISHED" };
  }
  const projectMint = identity.tokenAddress;

  // STEP 1 — WHICH ACTIVITY IS THE ORDINARY SUPPORT ACTUALLY ABOUT?
  //
  // Only rows the reducer already accepted as establishing may bind: the
  // proposition side of the join has to be the same evidence that carries
  // the component, not some other row that happens to be in the pool.
  //
  // A row binds to an activity when its LITERAL passage contains a name a
  // human confirmed for that activity. A row naming none binds to nothing,
  // and a project's other activities are not inferred from it.
  const boundProgramIds = new Set<string>();
  for (const row of rows) {
    if (!row.establishesComponent) continue;
    const fragment = row.supportFragment;
    if (fragment === null || fragment.length === 0) continue;
    for (const program of programs) {
      if (confirmedNamesOf(program).some((name) => fragmentNamesActivity(fragment, name))) {
        boundProgramIds.add(program.programId);
      }
    }
  }
  // FAIL CLOSED. Support that names no confirmed activity states a
  // proposition this obligation cannot locate on chain, however good the
  // provenance elsewhere in the pool is.
  if (boundProgramIds.size === 0) {
    return { met: false, reason: "MECHANICAL_PROVENANCE_NOT_ESTABLISHED" };
  }

  // STEP 2 — IS THERE MECHANICAL PROVENANCE FOR THAT SAME ACTIVITY?
  const qualifies = rows.some((row) => {
    // Machine-owned provenance is the only admissible basis. A documentary
    // or model-extracted row has none, and null is never permissive.
    const p = row.onchainProvenance;
    if (p === null) return false;
    // (8) The row must be a deterministic chain observation bound to THIS
    // project, by the axis ATLAS already uses.
    if (row.sourceClass !== "ONCHAIN_VERIFIABLE") return false;
    if (row.entityBinding !== "CONFIRMED") return false;
    // (1,6) Attribution proven, and proven by invocation structure — the
    // derivation refuses co-presence, and a refusal is recorded rather
    // than silently absent.
    if (p.refusal !== null) return false;
    if (p.callerProgramId === null) return false;
    // (2,3) The invoking program is the confirmed program for an activity
    // the ordinary support LITERALLY NAMED. Being some confirmed program
    // of this project is no longer enough — that was the cross-activity
    // hole, and this set is exactly the subset that closes it.
    if (!boundProgramIds.has(p.callerProgramId)) return false;
    // (4) The method is deterministically decoded by the registry.
    if (p.callerMethod === null) return false;
    // (5) That exact (program, method) carries the approved role, AND the
    // registry can name which of the invocation's accounts receives
    // protocol value. Resolved HERE from the code-owned registry rather
    // than read off the row, so a change of approval never depends on
    // rewriting stored Evidence.
    const approval = proofApprovalForMethod(registryChain, p.callerProgramId, p.callerMethod);
    if (approval === null || approval.role !== "PROTOCOL_VALUE_INFLOW") return false;
    // (5b) SAME QUALIFYING METHOD IS NOT THE SAME ECONOMIC LEG.
    //
    // One invocation of a fee collection moves value to the protocol's own
    // vault AND, routinely, to a referrer or a rebate account. Those legs
    // share the program, the method, the invocation and the asset — every
    // condition above — and only one of them is protocol value receipt.
    //
    // The registry names the receiving position in the invoking
    // instruction's own account list; this transfer must have landed
    // exactly there. An unresolvable leg (accounts not recorded, list too
    // short for the declared index) is UNKNOWN, and unknown is unmet.
    const recipients = resolveValueRecipients(approval.valueRecipient, p.callerAccounts);
    if (recipients === null) return false;
    if (p.destination === null) return false;
    if (!recipients.includes(p.destination)) return false;
    // (7) External value only. A movement of the project's OWN token is
    // not value arriving from outside it — this is what stops a buyback or
    // a burn from reading as revenue origin.
    if (p.assetKind === "TOKEN" && projectMint !== null && p.mint === projectMint) return false;
    return true;
  });

  return qualifies ? { met: true } : { met: false, reason: "MECHANICAL_PROVENANCE_NOT_ESTABLISHED" };
}

const EVALUATORS: Record<
  StructuralObligationId,
  (rows: readonly ObligationEvidenceView[], ctx: ObligationContext) => ObligationOutcome
> = {
  "SOV.MECHANICAL_PROVENANCE": evaluateMechanicalProvenance,
};

export interface UnmetObligation {
  id: StructuralObligationId;
  reason: "MECHANICAL_PROVENANCE_NOT_ESTABLISHED";
}

// Evaluates every REQUIRED obligation a component declares. An empty or
// absent list returns no unmet obligations and therefore changes nothing:
// that is the backward-compatibility guarantee, expressed as the ordinary
// behaviour of the loop rather than as a special case.
export function evaluateStructuralObligations(
  obligationIds: readonly string[] | undefined,
  rows: readonly ObligationEvidenceView[],
  ctx: ObligationContext,
): UnmetObligation[] {
  if (obligationIds === undefined || obligationIds.length === 0) return [];
  const unmet: UnmetObligation[] = [];
  for (const id of obligationIds) {
    // An id the code does not implement is NOT silently satisfied. A
    // Pattern naming an unknown obligation is a configuration error whose
    // safe reading is "this cannot be shown", so it stays unmet.
    if (!isStructuralObligationId(id)) {
      unmet.push({ id: "SOV.MECHANICAL_PROVENANCE", reason: "MECHANICAL_PROVENANCE_NOT_ESTABLISHED" });
      continue;
    }
    const outcome = EVALUATORS[id](rows, ctx);
    if (!outcome.met) unmet.push({ id, reason: outcome.reason });
  }
  return unmet;
}

// WHAT A MET OBLIGATION PROVES, stated in code so a consumer reading only
// this module still meets the boundary.
export const MECHANICAL_PROVENANCE_PROVES =
  "For an activity this project's own supporting document literally names, and which a human confirmed " +
  "maps to this exact program: that program invoked, by a method code has " +
  "approved as a protocol value inflow, a transfer of an asset other than the project's own token, into " +
  "the exact account that method's own interface designates as the protocol's, in the stated transaction " +
  "and slot. It does NOT prove that the demand was genuine, " +
  "that no wash activity occurred, that the amount is net of rebates or referrals, that this is all of the " +
  "protocol's revenue, that revenue on other chains or off-chain is accounted for, or that the arrangement " +
  "will persist.";
