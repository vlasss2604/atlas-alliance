import type {
  TokenBalanceRef,
  TransactionDetailResult,
} from "./providers/onchain-types";
import { formatTokenAmount } from "./onchain-facts";

// WHAT ONE OWNER'S TOKEN BALANCES DID IN ONE TRANSACTION.
//
// Derived strictly from the RPC's own pre/post token balances, which carry
// an `owner` field. Nothing here reads an instruction, so nothing here can
// be fooled by what an instruction appears to mean: this answers "the
// owner's balance of mint M went from A to B", and that is the entire
// claim.
//
// IT NAMES NO ECONOMIC EVENT. A wallet whose wSOL fell and whose PUMP rose
// in one transaction has had two balance changes. Calling that a swap, a
// purchase, a sale or a buyback requires knowing that the two legs were
// exchanged FOR each other — a fact about the program that executed them,
// not about the balances. Two unrelated transfers batched into one
// transaction produce the identical balance picture. So this module emits
// no label, and deliberately has no field one could be written into.
//
// AN OMITTED BALANCE IS NOT A ZERO BALANCE. The RPC lists a token balance
// only for accounts that had one at that point in execution. An account
// created during the transaction has no PRE entry; one closed during the
// transaction has no POST entry; an account both created and closed within
// a single transaction appears in NEITHER, and is invisible here no matter
// how much moved through it. Pairing state is therefore reported per entry
// and a delta exists ONLY for a PAIRED one — substituting zero for a
// missing side would manufacture a flow the data does not contain.
//
// AND SILENCE IS NOT ABSENCE. An owner with no entries had no balances the
// RPC reported; that is not evidence the owner moved nothing. Callers get
// this stated explicitly rather than having to remember it.

export type OwnerFlowDirection = "INFLOW" | "OUTFLOW" | "UNCHANGED";

// Whether both sides of a delta are actually present. Not a detail: it is
// the difference between a measured change and a guessed one.
export type OwnerFlowPairing = "PAIRED" | "PRE_ONLY" | "POST_ONLY";

export interface OwnerTokenFlowEntry {
  account: string;
  mint: string;
  decimals: number;
  // Raw integer strings, never numbers: a u64 token amount exceeds
  // Number.MAX_SAFE_INTEGER and would silently lose precision.
  preRaw: string | null;
  postRaw: string | null;
  // Present only when pairing === "PAIRED".
  deltaRaw: string | null;
  deltaFormatted: string | null;
  direction: OwnerFlowDirection | null;
  pairing: OwnerFlowPairing;
}

export interface OwnerNetFlow {
  mint: string;
  decimals: number;
  netRaw: string;
  netFormatted: string;
  direction: OwnerFlowDirection;
  // How many PAIRED accounts of this mint contributed. An owner may hold
  // several accounts for one mint, and the net is across all of them.
  accountsCounted: number;
}

export interface OwnerTokenFlowResult {
  owner: string;
  signature: string;
  slot: number;
  succeeded: boolean;
  entries: OwnerTokenFlowEntry[];
  // Net movement per mint, computed from PAIRED entries only. Mints are
  // never merged: a net is meaningless across two different assets.
  netByMint: OwnerNetFlow[];
  // Entries whose delta could not be measured because one side was absent.
  // A caller reading netByMint without reading this is reading a partial
  // picture as if it were complete.
  unpairedCount: number;
}

// The limit of what balance-derived flow can support, in the same shape as
// the adapter's other doesNotProve strings so a caller cannot hold the
// result without also holding its bounds.
export const OWNER_TOKEN_FLOW_DOES_NOT_PROVE =
  "This shows how one owner's reported token balances changed within one transaction. " +
  "It does not establish that any two balance changes were exchanged for each other, " +
  "what program moved anything, who decided it, what funded it, or what any of it was for. " +
  "Balances omitted by the RPC — accounts created or closed during the transaction — are " +
  "invisible here, so an owner showing no movement for a mint is not evidence that none occurred.";

function keyOf(b: TokenBalanceRef): string | null {
  // The token ACCOUNT is the identity. accountIndex is positional within
  // one transaction and mint alone cannot separate two accounts an owner
  // holds for the same mint.
  return b.account === null ? null : `${b.account}::${b.mint}`;
}

function indexByAccount(
  balances: readonly TokenBalanceRef[],
  owner: string,
): Map<string, TokenBalanceRef> {
  const out = new Map<string, TokenBalanceRef>();
  for (const b of balances) {
    // An entry with no owner cannot be attributed, and an entry owned by
    // someone else is another party's business. Both are excluded rather
    // than guessed at — this is the only thing standing between one
    // wallet's flow and every other account in the transaction.
    if (b.owner !== owner) continue;
    const k = keyOf(b);
    if (k === null) continue;
    out.set(k, b);
  }
  return out;
}

// Written as a call rather than the `0n` literal: the project targets
// ES2017, where BigInt literals do not compile.
const ZERO = BigInt(0);

function directionOf(delta: bigint): OwnerFlowDirection {
  if (delta > ZERO) return "INFLOW";
  if (delta < ZERO) return "OUTFLOW";
  return "UNCHANGED";
}

// Computes one owner's balance-derived token flow for one transaction.
//
// Takes the owner as a parameter and matches it exactly. There is no
// fuzzy matching, no case folding and no "related account" expansion: an
// address either owns a reported balance or it does not.
export function computeOwnerTokenFlow(
  result: TransactionDetailResult,
  owner: string,
): OwnerTokenFlowResult {
  const pre = indexByAccount(result.preTokenBalances, owner);
  const post = indexByAccount(result.postTokenBalances, owner);

  const entries: OwnerTokenFlowEntry[] = [];
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(key);
    const b = post.get(key);
    const ref = a ?? b;
    if (!ref || ref.account === null) continue;

    const base = {
      account: ref.account,
      mint: ref.mint,
      // Decimals come from the balance entry itself, so a mint's scale is
      // never assumed and never carried over from another mint.
      decimals: b?.decimals ?? a?.decimals ?? ref.decimals,
      preRaw: a?.amountRaw ?? null,
      postRaw: b?.amountRaw ?? null,
    };

    if (!a || !b) {
      entries.push({
        ...base,
        deltaRaw: null,
        deltaFormatted: null,
        direction: null,
        pairing: a ? "PRE_ONLY" : "POST_ONLY",
      });
      continue;
    }

    const delta = BigInt(b.amountRaw) - BigInt(a.amountRaw);
    const direction = directionOf(delta);
    entries.push({
      ...base,
      deltaRaw: delta.toString(),
      // Formatting takes the absolute value: the sign lives in direction,
      // and a formatted "-0.000001" invites reading the string instead.
      deltaFormatted: formatTokenAmount(
        (delta < ZERO ? -delta : delta).toString(),
        base.decimals,
      ),
      direction,
      pairing: "PAIRED",
    });
  }

  // Stable ordering so two runs over the same transaction are comparable.
  entries.sort((x, y) => (x.mint + x.account).localeCompare(y.mint + y.account));

  const nets = new Map<string, { decimals: number; total: bigint; accounts: number }>();
  for (const e of entries) {
    if (e.pairing !== "PAIRED" || e.deltaRaw === null) continue;
    const seen = nets.get(e.mint);
    if (seen) {
      seen.total += BigInt(e.deltaRaw);
      seen.accounts += 1;
    } else {
      nets.set(e.mint, { decimals: e.decimals, total: BigInt(e.deltaRaw), accounts: 1 });
    }
  }

  const netByMint: OwnerNetFlow[] = [...nets.entries()]
    .map(([mint, v]) => ({
      mint,
      decimals: v.decimals,
      netRaw: v.total.toString(),
      netFormatted: formatTokenAmount(
        (v.total < ZERO ? -v.total : v.total).toString(),
        v.decimals,
      ),
      direction: directionOf(v.total),
      accountsCounted: v.accounts,
    }))
    .sort((x, y) => x.mint.localeCompare(y.mint));

  return {
    owner,
    signature: result.signature,
    slot: result.slot,
    succeeded: result.succeeded,
    entries,
    netByMint,
    unpairedCount: entries.filter((e) => e.pairing !== "PAIRED").length,
  };
}

// Convenience for the common question "what did this owner's holding of
// ONE mint do?", with the same rules and the same silence-is-not-absence
// caveat. Returns null when the owner had no PAIRED balance for the mint —
// null meaning "not measurable here", never "nothing happened".
export function netFlowForMint(
  flow: OwnerTokenFlowResult,
  mint: string,
): OwnerNetFlow | null {
  return flow.netByMint.find((n) => n.mint === mint) ?? null;
}
