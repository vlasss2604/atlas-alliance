import { decodeKnownMethod } from "./onchain-instruction-registry";
import type {
  RawInstructionRef,
  TokenInstructionRef,
  TransactionDetailResult,
} from "./providers/onchain-types";

// D-158 PHASE 1 — WHICH PROGRAM ACTUALLY INVOKED THIS TRANSFER.
//
// WHY THIS EXISTS. A transaction lists the programs it touched and the
// transfers that occurred, and until now a synthesized transfer fact
// carried neither the program that executed it nor the invocation it sat
// in. So the only available reading of "program P and a transfer into A
// appear in transaction T" was CO-OCCURRENCE — which onchain-transaction-
// flow.ts already refuses to treat as causality, and rightly: a program
// can batch unrelated transfers, and an aggregator can invoke three venues
// in one transaction. Co-occurrence is what this module exists to stop
// being the best answer available.
//
// WHAT IT ESTABLISHES. That an instruction was invoked BY a specific
// program, derived from the CPI structure the node reported and nothing
// else. Where the structure does not prove it, the answer is UNKNOWN and
// no program is named.
//
// WHAT IT STILL DOES NOT ESTABLISH, and cannot. Why the program moved the
// value; whether the movement was a fee, a refund, a withdrawal or a
// payout; whether the amount is revenue; whether the counterparty is
// genuine. A decoded method name says which instruction of a program ran,
// never what it economically meant. Those are separate bridges and this
// module cannot see them.
//
// NOT A FACT, NOT A CONCLUSION. Nothing here is written into Evidence, no
// component reads it, and no research status can change because it exists.
// It is a machine-owned observation about transaction structure, available
// to a later phase that decides what — if anything — may be built on it.
//
// THE MODEL CANNOT REACH ANY OF IT. Every input is a field the RPC
// adapter wrote (programId, inner, instructionIndex, parentIndex,
// stackHeight, base58 data) or a code-owned registry constant. There is no
// path from extraction output, a document, or a prompt into this
// derivation, and no field here appears on the model's ExtractedFact type.

// Why a caller could not be named. Closed, so an unattributable transfer
// says which structural fact was missing rather than going silent.
export type CallerAttributionRefusal =
  // The node did not report a CPI depth for this instruction. An inner
  // instruction without one could sit at any level of its group, so its
  // caller is not recoverable. This is what a historical artifact looks
  // like, and it must read as unknown rather than as depth 2.
  | "NO_STACK_HEIGHT"
  // Depth 2 means "invoked by the outer instruction of this group", and
  // the node did not report which outer instruction that was.
  | "NO_PARENT_INDEX"
  // The outer instruction the group names is not present, or carries no
  // program id. Nothing to attribute to.
  | "PARENT_NOT_FOUND"
  // Depth ≥ 3: the invoking instruction is the nearest preceding sibling
  // at depth-1 in the same group, and no such sibling was reported.
  | "NO_ENCLOSING_INVOCATION"
  // A depth the structure cannot support (≤ 0, or ≥ 2 on an instruction
  // the node also called top-level). Refused rather than reconciled.
  | "INCONSISTENT_DEPTH";

export interface CallerAttribution {
  // The program that INVOKED this instruction. Null for a top-level
  // instruction: the signer wrote it, and no program invoked it.
  callerProgramId: string | null;
  // The program that EXECUTED this instruction — its own program id. For
  // an SPL transfer this is the Token program, which is exactly why it is
  // reported separately from the caller and is never a substitute for it.
  executingProgramId: string;
  // Ordinal of the top-level instruction whose execution this sat inside.
  // Its own index for a top-level instruction.
  invocationIndex: number;
  stackHeight: number;
  // True only for a top-level instruction.
  topLevel: boolean;
}

export type CallerAttributionOutcome =
  | { attributed: true; attribution: CallerAttribution }
  | { attributed: false; refusal: CallerAttributionRefusal };

// The positional fields every decoded instruction ref carries. Structural
// typing keeps this usable for token, lifecycle, burn and raw refs without
// a union that would have to grow with each new ref kind.
export interface PositionedInstruction {
  programId: string;
  inner: boolean;
  instructionIndex?: number;
  parentIndex?: number | null;
  stackHeight?: number | null;
}

function allPositioned(result: TransactionDetailResult): PositionedInstruction[] {
  // Every decoded and preserved instruction, in one list. The same
  // instruction never appears twice: the adapter routes each raw entry to
  // exactly one decoder, and rawInstructions holds only what no decoder
  // read. `burns` is deliberately excluded — a burn is also reported as a
  // token instruction, and counting it twice would let a sibling search
  // find a phantom neighbour.
  return [
    ...result.tokenInstructions,
    ...result.lifecycleInstructions,
    ...(result.rawInstructions ?? []),
  ];
}

// THE ATTRIBUTION RULE, and the whole of it.
//
//   depth 1 (top-level)  — no program invoked it; the signer did. The
//                          executing program is its own, and the caller is
//                          null. Named, not refused: "no caller" is a fact
//                          about a top-level instruction, not a gap.
//
//   depth 2              — invoked by the OUTER instruction of its group.
//                          parentIndex names that instruction directly.
//
//   depth >= 3           — invoked by the nearest PRECEDING instruction in
//                          the same group at depth-1. Solana lists a
//                          group's inner instructions in execution order,
//                          so the most recent shallower instruction is the
//                          one still executing when this one ran.
//
//   no depth             — UNKNOWN. Never assumed to be 2, because an
//                          inner instruction with no reported depth is
//                          exactly the historical-artifact case and
//                          assuming would manufacture a caller.
export function attributeCaller(
  result: TransactionDetailResult,
  target: PositionedInstruction,
): CallerAttributionOutcome {
  const depth = target.stackHeight ?? null;

  if (!target.inner) {
    // A top-level instruction is depth 1 by definition. A node value that
    // disagrees is a contradiction, not something to average out.
    if (depth !== null && depth !== 1) {
      return { attributed: false, refusal: "INCONSISTENT_DEPTH" };
    }
    if (target.instructionIndex === undefined) {
      return { attributed: false, refusal: "NO_PARENT_INDEX" };
    }
    return {
      attributed: true,
      attribution: {
        callerProgramId: null,
        executingProgramId: target.programId,
        invocationIndex: target.instructionIndex,
        stackHeight: 1,
        topLevel: true,
      },
    };
  }

  if (depth === null) return { attributed: false, refusal: "NO_STACK_HEIGHT" };
  if (depth < 2) return { attributed: false, refusal: "INCONSISTENT_DEPTH" };

  const parentIndex = target.parentIndex ?? null;
  if (parentIndex === null) return { attributed: false, refusal: "NO_PARENT_INDEX" };

  if (depth === 2) {
    const outer = allPositioned(result).find(
      (i) => !i.inner && i.instructionIndex === parentIndex,
    );
    if (outer === undefined) return { attributed: false, refusal: "PARENT_NOT_FOUND" };
    return {
      attributed: true,
      attribution: {
        callerProgramId: outer.programId,
        executingProgramId: target.programId,
        invocationIndex: parentIndex,
        stackHeight: depth,
        topLevel: false,
      },
    };
  }

  // depth >= 3 — the enclosing invocation is the nearest preceding sibling
  // one level shallower. Requires this instruction's own ordinal to know
  // what "preceding" means.
  if (target.instructionIndex === undefined) {
    return { attributed: false, refusal: "NO_ENCLOSING_INVOCATION" };
  }
  const siblings = allPositioned(result).filter(
    (i) =>
      i.inner &&
      (i.parentIndex ?? null) === parentIndex &&
      i.instructionIndex !== undefined &&
      i.instructionIndex < target.instructionIndex! &&
      (i.stackHeight ?? null) === depth - 1,
  );
  if (siblings.length === 0) {
    return { attributed: false, refusal: "NO_ENCLOSING_INVOCATION" };
  }
  const enclosing = siblings.reduce((best, cur) =>
    (cur.instructionIndex ?? -1) > (best.instructionIndex ?? -1) ? cur : best,
  );
  return {
    attributed: true,
    attribution: {
      callerProgramId: enclosing.programId,
      executingProgramId: target.programId,
      invocationIndex: parentIndex,
      stackHeight: depth,
      topLevel: false,
    },
  };
}

// ---- transfer provenance ---------------------------------------------

export type TransferAsset =
  | { kind: "TOKEN"; mint: string | null; decimals: number | null }
  | { kind: "NATIVE_SOL" };

export interface TransferProvenance {
  signature: string;
  slot: number;
  // Where the value went and came from, exactly as the instruction named
  // them. These are ACCOUNTS, not owners: resolving an owner is
  // onchain-transaction-flow.ts's job and is deliberately not repeated.
  source: string | null;
  destination: string | null;
  asset: TransferAsset;
  amountRaw: string | null;
  // Null whenever the structure did not prove a caller; `refusal` then
  // says which structural fact was missing.
  attribution: CallerAttribution | null;
  refusal: CallerAttributionRefusal | null;
  // The registry's answer for the INVOKING instruction, when that
  // instruction was preserved raw and its program has an entry. Null
  // otherwise, and null is never evidence that no known method ran.
  //
  // SAME-INVOCATION BY CONSTRUCTION: this is read off the very instruction
  // attribution named as the caller, not off any instruction that happens
  // to share the transaction. A method that ran elsewhere in the
  // transaction cannot reach this field.
  callerMethod: string | null;
  // The INVOKING instruction's own account list, in the order the program
  // was handed it. Read off the same instruction as callerMethod, so the
  // two always describe one invocation.
  //
  // WHY IT IS KEPT. A method name says which routine ran; it does not say
  // which of the routine's accounts received value. That ordinal is the
  // only deterministic, program-owned way to tell a protocol's own vault
  // from a referral account paid by the same instruction. Order is never
  // sorted or normalised — the position IS the meaning.
  //
  // Null when the invoking instruction was not preserved raw, and null is
  // never permissive: an unknown leg is an unmet obligation.
  callerAccounts: string[] | null;
}

function tokenTransferAsset(ix: TokenInstructionRef): TransferAsset {
  return { kind: "TOKEN", mint: ix.mint, decimals: ix.decimals };
}

// The two instruction shapes that move value: SPL token transfers, and
// System native transfers (which the adapter files under lifecycle).
// Nothing else is treated as a movement — a burn destroys rather than
// moves, and is left to its own typed fact.
function movements(result: TransactionDetailResult): {
  positioned: PositionedInstruction;
  source: string | null;
  destination: string | null;
  asset: TransferAsset;
  amountRaw: string | null;
}[] {
  const out: ReturnType<typeof movements> = [];
  for (const ix of result.tokenInstructions) {
    if (ix.type !== "transfer" && ix.type !== "transferChecked") continue;
    out.push({
      positioned: ix,
      source: ix.account,
      destination: ix.destination,
      asset: tokenTransferAsset(ix),
      amountRaw: ix.amountRaw,
    });
  }
  for (const ix of result.lifecycleInstructions) {
    if (ix.type !== "transfer") continue;
    out.push({
      positioned: ix,
      source: ix.source,
      destination: ix.destination,
      asset: { kind: "NATIVE_SOL" },
      amountRaw: ix.lamports,
    });
  }
  return out;
}

// The invoking instruction's own bytes, when it was preserved raw. A
// parsed instruction carries no data to decode, which is why a decoded
// method is available only for programs the node did not itself parse —
// precisely the third-party programs a registry entry is for.
// ONE lookup, so the decoded method and the account list can never come
// from two different instructions.
function callerInstruction(
  result: TransactionDetailResult,
  attribution: CallerAttribution,
): RawInstructionRef | null {
  if (attribution.callerProgramId === null) return null;
  const raws = result.rawInstructions ?? [];
  const caller = raws.find((r: RawInstructionRef) => {
    if (r.programId !== attribution.callerProgramId) return false;
    if (attribution.stackHeight === 2) {
      return !r.inner && r.instructionIndex === attribution.invocationIndex;
    }
    return (
      r.inner &&
      (r.parentIndex ?? null) === attribution.invocationIndex &&
      (r.stackHeight ?? null) === attribution.stackHeight - 1
    );
  });
  return caller ?? null;
}

// Every value movement in the transaction, each with whatever provenance
// the structure actually proves. A movement whose caller cannot be
// established is still listed — with a null attribution and a named
// refusal — because dropping it would hide the gap rather than report it.
export function deriveTransferProvenance(
  result: TransactionDetailResult,
): TransferProvenance[] {
  return movements(result).map((m) => {
    const outcome = attributeCaller(result, m.positioned);
    const attribution = outcome.attributed ? outcome.attribution : null;
    const caller = attribution === null ? null : callerInstruction(result, attribution);
    return {
      signature: result.signature,
      slot: result.slot,
      source: m.source,
      destination: m.destination,
      asset: m.asset,
      amountRaw: m.amountRaw,
      attribution,
      refusal: outcome.attributed ? null : outcome.refusal,
      callerMethod:
        caller === null
          ? null
          : decodeKnownMethod({
              chain: "solana",
              programId: caller.programId,
              data: caller.data,
            }),
      callerAccounts: caller === null ? null : [...caller.accounts],
    };
  });
}

// Convenience for the phase that will consume this: value arriving at one
// account, attributed. Filtering only — it grants nothing the derivation
// did not already prove, and an unattributed inflow stays unattributed.
export function inflowsTo(
  result: TransactionDetailResult,
  account: string,
): TransferProvenance[] {
  return deriveTransferProvenance(result).filter((t) => t.destination === account);
}

// D-158 PHASE 2 — THE MINIMUM SHAPE AN OBLIGATION EVALUATOR NEEDS.
//
// Persisted alongside a synthesized on-chain Evidence row, so the reducer
// evaluates a proof obligation over EVIDENCE and never reaches back into
// raw RPC artifacts. A second proof path beside Evidence would be a hidden
// one, and Evidence is where provenance must be auditable.
//
// EVERY FIELD IS MACHINE-OWNED. Each is copied from an attribution this
// module derived from node-reported CPI structure, or from the decoded
// instruction itself. The human-readable statement is NOT the authority
// here — this metadata is.
//
// WRITTEN BY EXACTLY ONE PATH: the deterministic on-chain synthesis. It is
// absent on every documentary, data-provider and model-extracted row, and
// no extraction output can produce one.
export interface EvidenceProvenanceMetadata {
  // Null when a caller could not be proven; `refusal` then says why. An
  // obligation must treat null as unmet, never as permissive.
  callerProgramId: string | null;
  // The registry's decoded method for the invoking instruction, or null.
  // The ROLE this method may play is deliberately NOT stored: it is
  // resolved at evaluation time from the code-owned registry, so a change
  // of approval never requires rewriting historical Evidence.
  callerMethod: string | null;
  // The invoking instruction's account list, in program order. Stored
  // because it is an OBSERVATION — what the chain reported — while which
  // POSITION means "protocol value receipt" is a code-owned registry
  // decision resolved at evaluation time, exactly like the role.
  callerAccounts: string[] | null;
  executingProgramId: string | null;
  invocationIndex: number | null;
  stackHeight: number | null;
  refusal: CallerAttributionRefusal | null;
  // The movement itself.
  destination: string | null;
  assetKind: "TOKEN" | "NATIVE_SOL";
  mint: string | null;
  amountRaw: string | null;
  signature: string;
  slot: number;
}

// Projects a derived TransferProvenance into the persisted shape. Copying
// rather than storing the object whole keeps the persisted contract
// explicit and stops an internal field from leaking into Evidence by
// accident.
export function toEvidenceProvenance(t: TransferProvenance): EvidenceProvenanceMetadata {
  return {
    callerProgramId: t.attribution?.callerProgramId ?? null,
    callerMethod: t.callerMethod,
    callerAccounts: t.callerAccounts === null ? null : [...t.callerAccounts],
    executingProgramId: t.attribution?.executingProgramId ?? null,
    invocationIndex: t.attribution?.invocationIndex ?? null,
    stackHeight: t.attribution?.stackHeight ?? null,
    refusal: t.refusal,
    destination: t.destination,
    assetKind: t.asset.kind,
    mint: t.asset.kind === "TOKEN" ? t.asset.mint : null,
    amountRaw: t.amountRaw,
    signature: t.signature,
    slot: t.slot,
  };
}

// WHAT AN ATTRIBUTED TRANSFER DOES NOT PROVE. Stated once, in code, so a
// consumer reading only this module's exports still meets the boundary.
export const INVOCATION_PROVENANCE_DOES_NOT_PROVE =
  "This establishes that a specific program invoked the instruction that moved the stated amount into " +
  "the stated account, as reported by the node's own CPI structure. It does NOT establish why the " +
  "program moved it, that the movement was a fee, revenue, a refund, a withdrawal or a payout, that " +
  "the amount is net of anything, that the counterparty is independent of the project, or that this " +
  "transfer is representative of any other transfer. A decoded method name identifies which instruction " +
  "of a program ran; it does not state what that instruction economically means. Linking an attributed " +
  "inflow to a project's documented activity requires separate confirmed identity and separate admitted " +
  "evidence.";
