import type { TransactionDetailResult } from "./providers/onchain-types";

// TWO ASSETS MOVING OPPOSITE WAYS IN ONE TRANSACTION.
//
// A transaction where address A sends native SOL toward an account owned by
// C, while an account owned by C sends the project's token into an account
// owned by A, is a real structural fact about the chain. It is also exactly
// the shape an economic reading wants to jump on, so the shape is derived
// here and named nothing.
//
// WHAT THIS IS NOT ALLOWED TO CONCLUDE. Not a swap, not a purchase, not a
// buyback, not revenue-funded, not a market buy, and not a burn. Those are
// claims about intent, funding and program semantics; this module reads
// only decoded instructions and the RPC's own ownership metadata. Two
// unrelated transfers batched into one transaction produce the identical
// picture, and nothing here can tell them apart from a genuine exchange.
//
// CO-OCCURRENCE IS NOT CAUSALITY. The legs are stated as being in the same
// transaction, never as being "in exchange for" one another. That the
// second happened BECAUSE of the first is not something the chain records.
//
// OWNERSHIP COMES FROM THE RPC, NOT FROM INFERENCE. A token account's owner
// is read from pre/post balance metadata, and only when the two agree. An
// account whose ownership cannot be resolved cannot bind a leg, and a flow
// that cannot bind both legs to the SAME counterparty is not derived at all.
//
// NATIVE SOL AND WRAPPED SOL ARE NOT COLLAPSED. The outbound leg records a
// NATIVE lamport transfer whose destination happens to be a token account;
// whether that account was synced into wrapped SOL is recorded separately,
// as observed, so the conversion path stays visible rather than being
// assumed away.

export type AssetKind = "NATIVE_SOL" | "TOKEN";

export interface AssetLeg {
  kind: AssetKind;
  // Raw integer string throughout: a u64 does not survive a double.
  amountRaw: string;
  // Null for a native transfer — lamports have no mint and no decimals
  // field in the instruction.
  mint: string | null;
  decimals: number | null;
  // For a native leg this is the sending ADDRESS; for a token leg it is the
  // sending TOKEN ACCOUNT. They are different kinds of thing and are never
  // merged.
  from: string;
  to: string;
  // Resolved from balance metadata where the endpoint is a token account.
  // Null means "not established", never "none".
  fromOwner: string | null;
  toOwner: string | null;
  // Outbound native legs only: a syncNative was observed on the destination
  // token account in this same transaction, which is what converts the
  // delivered lamports into a wrapped-SOL balance. Recorded as observed,
  // never assumed.
  destinationSyncedNative?: boolean;
}

export interface ReciprocalAssetFlow {
  signature: string;
  slot: number;
  // The address that sent the consideration and received the target token.
  participant: string;
  // The single owner on the other side of BOTH legs.
  counterparty: string;
  outbound: AssetLeg;
  inbound: AssetLeg;
}

export const RECIPROCAL_FLOW_DOES_NOT_PROVE =
  "This shows that one successful transaction contains a native transfer from an address toward an account " +
  "owned by another party, and a transfer of the project's token from an account owned by that same party " +
  "into an account owned by the first. It does NOT establish that either movement caused the other, that the " +
  "two were exchanged for one another, that a purchase, sale, swap or buyback occurred, what funded the " +
  "native transfer, who controls either party, or that any token was burned or any supply changed. Two " +
  "unrelated transfers batched into one transaction produce exactly this picture.";

// Ownership as the RPC reported it, per token account.
//
// A pre and a post entry for the same account must agree. They always do in
// practice — ownership does not change mid-transaction — so a disagreement
// means something is being read wrong, and the safe answer is to resolve
// nothing for that account.
function ownershipByAccount(result: TransactionDetailResult): Map<string, string> {
  const claims = new Map<string, string | null>();
  for (const b of [...result.preTokenBalances, ...result.postTokenBalances]) {
    if (b.account === null || b.owner === null) continue;
    const seen = claims.get(b.account);
    if (seen === undefined) claims.set(b.account, b.owner);
    else if (seen !== b.owner) claims.set(b.account, null); // contradiction
  }
  const out = new Map<string, string>();
  for (const [account, owner] of claims) if (owner !== null) out.set(account, owner);
  return out;
}

function mintByAccount(result: TransactionDetailResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of [...result.preTokenBalances, ...result.postTokenBalances]) {
    if (b.account !== null) out.set(b.account, b.mint);
  }
  return out;
}

// The instruction types that move a token balance. `closeAccount` moves
// lamports and `burn` destroys — neither is a transfer between parties.
const TOKEN_TRANSFER_TYPES = new Set(["transfer", "transferChecked"]);

// Derives every unambiguous reciprocal flow this transaction contains.
//
// AMBIGUITY FAILS CLOSED. If one (participant, counterparty) pair has more
// than one candidate leg on either side, the pair is skipped rather than
// resolved by picking one — a transaction moving the same assets several
// ways is not one exchange, and guessing which leg pairs with which would
// be inventing structure.
export function deriveReciprocalAssetFlows(
  result: TransactionDetailResult,
  targetMint: string,
): ReciprocalAssetFlow[] {
  // A failed transaction executed nothing.
  if (!result.succeeded) return [];

  const owners = ownershipByAccount(result);
  const mints = mintByAccount(result);

  // OUTBOUND: native lamports from an address to a token account whose
  // owner the RPC resolved. The destination being a token account is what
  // makes the counterparty knowable at all.
  const outbound: AssetLeg[] = [];
  for (const ix of result.lifecycleInstructions) {
    if (ix.programId !== SYSTEM_PROGRAM_ID || ix.type !== "transfer") continue;
    if (ix.source === null || ix.destination === null || ix.lamports === null) continue;
    const toOwner = owners.get(ix.destination);
    if (toOwner === undefined) continue;
    outbound.push({
      kind: "NATIVE_SOL",
      amountRaw: ix.lamports,
      mint: null,
      decimals: null,
      from: ix.source,
      to: ix.destination,
      fromOwner: null, // a native sender is an address, not a token account
      toOwner,
      destinationSyncedNative: result.lifecycleInstructions.some(
        (s) => s.type === "syncNative" && s.account === ix.destination,
      ),
    });
  }

  // INBOUND: the TARGET mint only. A different mint is a different asset
  // and cannot make this a flow about this project's token.
  const inbound: AssetLeg[] = [];
  for (const ix of result.tokenInstructions) {
    if (!TOKEN_TRANSFER_TYPES.has(ix.type)) continue;
    if (ix.account === null || ix.destination === null || ix.amountRaw === null) continue;
    // The mint is taken from the instruction when it states one
    // (transferChecked) and otherwise from the account's balance metadata.
    const mint = ix.mint ?? mints.get(ix.account) ?? null;
    if (mint !== targetMint) continue;
    const fromOwner = owners.get(ix.account);
    const toOwner = owners.get(ix.destination);
    if (fromOwner === undefined || toOwner === undefined) continue;
    inbound.push({
      kind: "TOKEN",
      amountRaw: ix.amountRaw,
      mint,
      decimals: ix.decimals,
      from: ix.account,
      to: ix.destination,
      fromOwner,
      toOwner,
    });
  }

  // Pair them: the participant sent the native leg and received the token
  // leg; the counterparty owns the other end of both.
  const flows: ReciprocalAssetFlow[] = [];
  const seen = new Set<string>();
  for (const out of outbound) {
    for (const inn of inbound) {
      const participant = out.from;
      const counterparty = out.toOwner!;
      // Both legs must face the SAME counterparty, and the token must land
      // with the participant. A counterparty sending to itself, or a
      // participant paying itself, is not a reciprocal flow.
      if (inn.fromOwner !== counterparty) continue;
      if (inn.toOwner !== participant) continue;
      if (participant === counterparty) continue;

      const key = `${participant}|${counterparty}`;
      if (seen.has(key)) {
        // A second candidate for the same pair. Ambiguous — drop the pair
        // entirely rather than choosing between them.
        flows.splice(
          flows.findIndex((f) => `${f.participant}|${f.counterparty}` === key),
          1,
        );
        continue;
      }
      seen.add(key);
      flows.push({
        signature: result.signature,
        slot: result.slot,
        participant,
        counterparty,
        outbound: out,
        inbound: inn,
      });
    }
  }

  // Deterministic order, independent of instruction arrival.
  flows.sort((a, b) =>
    `${a.participant}${a.counterparty}`.localeCompare(`${b.participant}${b.counterparty}`),
  );
  return flows;
}

// Chain infrastructure constant, as elsewhere: the same value for every
// project on Solana.
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
