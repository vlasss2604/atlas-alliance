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
// OWNERSHIP IS READ, NEVER INFERRED. A token account's owner comes from
// pre/post balance metadata, and only when the two agree. An account whose
// ownership cannot be resolved cannot bind a leg, and a flow that cannot bind
// both legs to the SAME counterparty is not derived at all.
//
// ONE ACCOUNT HAS NO BALANCE METADATA: the transient wrapper. A payer who
// spends SOL down a token-program path creates a token account, funds it,
// syncs it, spends it and closes it inside the one transaction — so it did not
// exist before and does not survive, and no pre or post balance mentions it.
// For that account, and only that account, ownership may come instead from a
// same-transaction instruction that ESTABLISHES ownership by protocol
// definition (initializeAccount*, ATA create/createIdempotent). The adapter
// already gates which instruction types may speak to this, so nothing here
// decides it. That is an attestation being read, not an owner being guessed.
//
// Balance metadata still wins where it exists, and disagreement between the
// two is fatal for that account rather than resolved in either direction.
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
  // Outbound native legs only, and only when the destination turned out to be
  // an account the PAYER owns rather than the counterparty's. Then the leg
  // above is literally true as far as it goes — those lamports went into that
  // account — and `via` carries the hop that actually reached the other party.
  // Absent for the direct shape.
  via?: RoutedVia;
}

export type OwnerSource = "BALANCE_METADATA" | "LIFECYCLE_ATTESTATION";

// Where the payer's own intermediate account sent the value on to. Every
// field is observed: no amount is carried across the hop, because the amount
// that arrived and the amount that left are different numbers and conflating
// them would invent a figure the chain never reported.
export interface OnwardHop {
  // Null when the instruction did not state one and the destination carries
  // no balance metadata to read it from. Never guessed.
  mint: string | null;
  amountRaw: string;
  to: string;
  toOwner: string;
}

export interface RoutedVia {
  // The intermediate token account the payer funded.
  account: string;
  // Its owner — equal to the payer, which is what makes this the routed
  // shape rather than a direct payment.
  accountOwner: string;
  ownerSource: OwnerSource;
  // Every instruction type that attested this ownership, deduplicated and
   // sorted. More than one agreeing is commonplace — an ATA creation and the
   // initialization it performs both say it — and reporting only the first
   // would under-state the basis. Empty when balance metadata already knew.
  attestedBy: string[];
  // Observed, not required: a wrapper that was never synced or never closed
  // is still a wrapper, and saying so is not the same as demanding it.
  syncedNative: boolean;
  closedInTransaction: boolean;
  onward: OnwardHop;
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
  "owned by another party — directly, or through an account the sender itself owns — and a transfer of the " +
  "project's token from an account owned by that other party into an account owned by the first. It does NOT " +
  "establish that either movement caused the other, that the two were exchanged for one another, that a " +
  "purchase, sale, swap or buyback occurred, what funded the native transfer, who controls either party, or " +
  "that any token was burned or any supply changed. Where the value passed through an intermediate account, " +
  "it does NOT establish that the amount which arrived is the amount that went on, nor what the remainder " +
  "was for. Two unrelated transfers batched into one transaction produce exactly this picture.";

interface ResolvedOwner {
  owner: string;
  source: OwnerSource;
  attestedBy: string[];
}

// Ownership as the RPC reported it, per token account.
//
// A pre and a post entry for the same account must agree. They always do in
// practice — ownership does not change mid-transaction — so a disagreement
// means something is being read wrong, and the safe answer is to resolve
// nothing for that account.
function balanceOwnership(result: TransactionDetailResult): Map<string, string> {
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

// Ownership as a same-transaction instruction ATTESTED it.
//
// The `owner` field on a decoded lifecycle instruction is already gated by the
// adapter to the types whose owner field is the token account's owner by
// protocol definition — adding a type to that set is a deliberate, visible act
// there. So this function does not decide which instructions may speak; it
// only collects what the ones already entitled to speak actually said.
//
// Two instructions naming different owners for one account is not a tie to
// break. It is a reading that cannot be trusted, and the account resolves to
// nothing — the same rule the balance map uses for the same reason.
function attestedOwnership(
  result: TransactionDetailResult,
): Map<string, { owner: string; types: string[] } | null> {
  const claims = new Map<string, { owner: string; types: string[] } | null>();
  for (const ix of result.lifecycleInstructions) {
    if (ix.account === null || ix.owner === null) continue;
    const seen = claims.get(ix.account);
    if (seen === undefined) {
      claims.set(ix.account, { owner: ix.owner, types: [ix.type] });
      continue;
    }
    if (seen === null) continue; // already contradicted; nothing restores it
    if (seen.owner !== ix.owner) {
      claims.set(ix.account, null); // contradiction
      continue;
    }
    if (!seen.types.includes(ix.type)) seen.types.push(ix.type);
  }
  for (const claim of claims.values()) if (claim !== null) claim.types.sort();
  return claims;
}

// The two sources, merged with balance metadata in front.
//
// AGREEMENT is required, not preferred. Where both speak and they disagree,
// the account resolves to nothing at all: preferring one would be choosing
// which reading to believe about the very thing being established, and there
// is no basis for that choice. Attestation therefore only ever FILLS a gap —
// it can never overrule, and it can never quietly correct.
function resolveOwnership(result: TransactionDetailResult): Map<string, ResolvedOwner> {
  const fromBalances = balanceOwnership(result);
  const attested = attestedOwnership(result);
  const out = new Map<string, ResolvedOwner>();
  for (const [account, owner] of fromBalances) {
    const a = attested.get(account);
    if (a === null) continue; // attestation self-contradicted: do not trust the pair
    if (a !== undefined && a.owner !== owner) continue; // sources disagree: fail closed
    out.set(account, { owner, source: "BALANCE_METADATA", attestedBy: [] });
  }
  for (const [account, a] of attested) {
    if (a === null || fromBalances.has(account)) continue;
    out.set(account, { owner: a.owner, source: "LIFECYCLE_ATTESTATION", attestedBy: a.types });
  }
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

// Where an account the payer owns sent value on to somebody else, one hop per
// recipient OWNER.
//
// AMBIGUITY IS PER OWNER, not per account. Several hops to the SAME owner
// cannot be reduced to one without choosing between them, so that owner is
// dropped. Several hops to DIFFERENT owners are not ambiguous at all — they
// are simply several recipients, and the caller decides which (if any) turns
// out to be the counterparty. That is what keeps a fee or a second output from
// destroying a flow it has nothing to do with.
//
// A hop back to the payer is not an onward hop: paying yourself reaches
// nobody.
function onwardHops(
  result: TransactionDetailResult,
  account: string,
  payer: string,
  owners: Map<string, ResolvedOwner>,
  mints: Map<string, string>,
): OnwardHop[] {
  const byOwner = new Map<string, OnwardHop | null>();
  for (const ix of result.tokenInstructions) {
    if (!TOKEN_TRANSFER_TYPES.has(ix.type)) continue;
    if (ix.account !== account) continue;
    if (ix.destination === null || ix.amountRaw === null) continue;
    const to = owners.get(ix.destination);
    if (to === undefined) continue;
    if (to.owner === payer) continue;
    const hop: OnwardHop = {
      mint: ix.mint ?? mints.get(ix.destination) ?? null,
      amountRaw: ix.amountRaw,
      to: ix.destination,
      toOwner: to.owner,
    };
    const seen = byOwner.get(to.owner);
    byOwner.set(to.owner, seen === undefined ? hop : null);
  }
  return [...byOwner.entries()]
    .filter((e): e is [string, OnwardHop] => e[1] !== null)
    .map((e) => e[1])
    .sort((a, b) => (a.toOwner < b.toOwner ? -1 : a.toOwner > b.toOwner ? 1 : a.to.localeCompare(b.to)));
}

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

  const owners = resolveOwnership(result);
  const mints = mintByAccount(result);

  // OUTBOUND: native lamports from an address to a token account whose owner
  // could be resolved. The destination being a token account is what makes the
  // counterparty knowable at all.
  //
  // TWO SHAPES, and which one applies is decided by the destination's owner
  // rather than by anything about the accounts themselves. If the destination
  // belongs to someone else, the payment reached the counterparty directly. If
  // it belongs to the PAYER, the payer funded its own account and whatever
  // reached anyone else left by a further hop — so the leg is emitted once per
  // party that hop reached, and each carries its own routing record.
  const outbound: AssetLeg[] = [];
  for (const ix of result.lifecycleInstructions) {
    if (ix.programId !== SYSTEM_PROGRAM_ID || ix.type !== "transfer") continue;
    if (ix.source === null || ix.destination === null || ix.lamports === null) continue;
    const dest = owners.get(ix.destination);
    if (dest === undefined) continue;
    const syncedNative = result.lifecycleInstructions.some(
      (s) => s.type === "syncNative" && s.account === ix.destination,
    );
    const leg: AssetLeg = {
      kind: "NATIVE_SOL",
      amountRaw: ix.lamports,
      mint: null,
      decimals: null,
      from: ix.source,
      to: ix.destination,
      fromOwner: null, // a native sender is an address, not a token account
      toOwner: dest.owner,
      destinationSyncedNative: syncedNative,
    };
    if (dest.owner !== ix.source) {
      outbound.push(leg);
      continue;
    }
    const closed = result.tokenInstructions.some(
      (t) => t.type === "closeAccount" && t.account === ix.destination,
    );
    for (const onward of onwardHops(result, ix.destination, ix.source, owners, mints)) {
      outbound.push({
        ...leg,
        via: {
          account: ix.destination,
          accountOwner: dest.owner,
          ownerSource: dest.source,
          attestedBy: dest.attestedBy,
          syncedNative,
          closedInTransaction: closed,
          onward,
        },
      });
    }
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
      fromOwner: fromOwner.owner,
      toOwner: toOwner.owner,
    });
  }

  // Pair them: the participant sent the native leg and received the token
  // leg; the counterparty owns the other end of both.
  const flows: ReciprocalAssetFlow[] = [];
  const seen = new Set<string>();
  for (const out of outbound) {
    for (const inn of inbound) {
      const participant = out.from;
      // Direct: the account the lamports landed in belongs to the other
      // party. Routed: it belongs to the payer, and the other party is
      // whoever the onward hop reached.
      const counterparty = out.via ? out.via.onward.toOwner : out.toOwner;
      if (counterparty === null) continue;
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
