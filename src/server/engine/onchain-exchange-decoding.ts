import { createHash } from "node:crypto";

import { resolveOwnership, type ResolvedOwner } from "./onchain-transaction-flow";
import type { TransactionDetailResult } from "./providers/onchain-types";

// READING A PRESERVED BLOB, WITHOUT TRUSTING A REMEMBERED LAYOUT.
//
// Two opposing token movements inside one program invocation are not an
// exchange — a program can batch unrelated transfers and produce the same
// picture. What turns the structure into an exchange is the instruction
// itself saying so, and that is what this module reads.
//
// EVERY CONSTANT HERE IS DERIVED, NOT RECALLED. An Anchor instruction is
// dispatched on sha256("global:<method>")[0..8], so a method NAME is a
// hypothesis that either reproduces an observed 8-byte value exactly or is
// wrong. That check is computed below at module load rather than pasted in
// as a magic number, so the derivation is visible and a typo cannot
// silently widen what matches. An 8-byte agreement is not a guess that
// survived; it is the program's own method name.
//
// ACCOUNT ROLES ARE NEVER READ FROM POSITION. The ordering contract of a
// third-party program is not available here, and assuming "index 5 is the
// input vault" is exactly the kind of remembered layout that fails
// silently and wrongly. Roles are established instead from the mints and
// amounts the instruction and its event state, corroborated against the
// transaction's own decoded transfers and balance metadata. Direction —
// who paid and who received — comes from those transfers, never from a
// flag byte.
//
// WHAT THIS ESTABLISHES AND WHERE IT STOPS. That an asset exchange
// executed. Not that it was a buyback, not what funded it, not that it
// implements any published policy, not that it was a market-wide purchase.
// Those are separate bridges and this module cannot see them.

function discriminator(preimage: string): Buffer {
  return createHash("sha256").update(preimage).digest().subarray(0, 8);
}

// The venue instruction this module can read. Program-specific by
// necessity — a discriminator only means anything under the program that
// defines it — and protocol-generic within that: nothing here knows or
// cares which mints a project uses.
//
// The program id is a code-owned constant and the match is exact. A
// different program emitting the same 8 bytes is a different instruction
// and is not decoded.
const CONCENTRATED_LIQUIDITY_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const SWAP_V2 = discriminator("global:swap_v2");
// 8 discriminator + u64 + u64 + u128 + 1 flag. The tiling is forced by the
// length, and the only field read is the first u64 — the one an observed
// transfer can corroborate. The rest is validated as present and left
// unnamed, because naming a field this module cannot check would be
// inventing a contract.
const SWAP_V2_DATA_BYTES = 41;
const SWAP_V2_AMOUNT_OFFSET = 8;

// The aggregator program whose event CPI carries the exchange record.
const AGGREGATOR_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// Anchor's event-CPI marker. Emitted big-endian relative to the digest, so
// the reversal is part of the derivation rather than a fudge.
const EVENT_CPI_MARKER = Buffer.from([...discriminator("anchor:event")].reverse());
// 8 marker + 8 event discriminator + 4 + (32 mint + 8 amount) x2 + 32.
// Exact, or not read at all.
const EVENT_BYTES = 132;

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeBase58(value: string): Buffer | null {
  if (value.length === 0) return null;
  const FIFTY_EIGHT = BigInt(58);
  const BYTE_MASK = BigInt(255);
  const EIGHT = BigInt(8);
  const ZERO = BigInt(0);
  let n = ZERO;
  for (const ch of value) {
    const i = B58_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * FIFTY_EIGHT + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > ZERO) {
    bytes.unshift(Number(n & BYTE_MASK));
    n >>= EIGHT;
  }
  for (const ch of value) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Buffer.from(bytes);
}

function encodeBase58(buf: Buffer): string {
  const FIFTY_EIGHT = BigInt(58);
  const ZERO = BigInt(0);
  let n = ZERO;
  for (const b of buf) n = n * BigInt(256) + BigInt(b);
  let s = "";
  while (n > ZERO) {
    s = B58_ALPHABET[Number(n % FIFTY_EIGHT)] + s;
    n /= FIFTY_EIGHT;
  }
  for (const b of buf) {
    if (b === 0) s = `1${s}`;
    else break;
  }
  return s;
}

// One (mint, amount) the event states. Deliberately NOT called input or
// output: the payload's field names are not established, and direction is
// decided from observed transfers instead.
export interface StatedAsset {
  mint: string;
  amountRaw: string;
}

export interface ExchangeLeg {
  mint: string;
  amountRaw: string;
  fromAccount: string;
  fromOwner: string;
  toAccount: string;
  toOwner: string;
}

export interface DecodedExchange {
  signature: string;
  slot: number;
  // The outer instruction both the venue call and the event belong to.
  invocationIndex: number;
  // The party that paid one asset and received the other.
  participant: string;
  counterparty: string;
  paid: ExchangeLeg;
  received: ExchangeLeg;
  // How the reading was reached, so a reader can audit it rather than
  // trust it.
  basis: {
    venueProgramId: string;
    venueMethod: "swap_v2";
    venueAmountRaw: string;
    eventProgramId: string;
    // The event's own discriminator, reported as bytes because its NAME is
    // not established. Naming it would be inventing one.
    eventDiscriminatorHex: string;
    statedAssets: StatedAsset[];
  };
}

export const EXCHANGE_DOES_NOT_PROVE =
  "This is a decoded asset exchange: an instruction whose own method is swap_v2, invoked inside one outer " +
  "instruction, together with an event emitted in that same invocation stating both assets and both amounts, " +
  "each corroborated against a transfer this transaction independently records. It establishes that an " +
  "exchange executed and what was given and received. It does NOT establish that the exchange was a buyback, " +
  "what funded the asset that was paid, that any published policy or mechanism was being carried out, that " +
  "the price was a market price, or that anything comparable happens routinely. It is one exchange, and who " +
  "arranged it and why are not recorded on the chain.";

// The venue instruction, if this raw instruction is one.
export function decodeVenueSwap(ix: {
  programId: string;
  data: string;
  accounts: string[];
  parentIndex?: number | null;
  inner?: boolean;
}): { amountRaw: string; parentIndex: number | null } | null {
  if (ix.programId !== CONCENTRATED_LIQUIDITY_PROGRAM_ID) return null;
  const buf = decodeBase58(ix.data);
  if (buf === null || buf.length !== SWAP_V2_DATA_BYTES) return null;
  if (!buf.subarray(0, 8).equals(SWAP_V2)) return null;
  // An instruction that reaches neither mint of an exchange cannot be one.
  if (ix.accounts.length === 0) return null;
  return {
    amountRaw: buf.readBigUInt64LE(SWAP_V2_AMOUNT_OFFSET).toString(),
    parentIndex: ix.parentIndex ?? null,
  };
}

// The event CPI, if this raw instruction is one. Read purely as a tiling
// that the total length forces: marker, event discriminator, four bytes,
// then two (mint, amount) pairs and a trailing pubkey.
export function decodeExchangeEvent(ix: {
  programId: string;
  data: string;
  parentIndex?: number | null;
}): { discriminatorHex: string; assets: StatedAsset[]; trailing: string; parentIndex: number | null } | null {
  if (ix.programId !== AGGREGATOR_PROGRAM_ID) return null;
  const buf = decodeBase58(ix.data);
  if (buf === null || buf.length !== EVENT_BYTES) return null;
  if (!buf.subarray(0, 8).equals(EVENT_CPI_MARKER)) return null;
  const assets: StatedAsset[] = [];
  for (const offset of [20, 60]) {
    assets.push({
      mint: encodeBase58(buf.subarray(offset, offset + 32)),
      amountRaw: buf.readBigUInt64LE(offset + 32).toString(),
    });
  }
  return {
    discriminatorHex: buf.subarray(8, 16).toString("hex"),
    assets,
    trailing: encodeBase58(buf.subarray(100, 132)),
    parentIndex: ix.parentIndex ?? null,
  };
}

// OWNERSHIP COMES FROM THE ONE IMPLEMENTATION OF THE RULE, not a second
// copy of it. Balance metadata first; a same-transaction instruction that
// establishes ownership by protocol definition may fill a gap; the two
// must agree or the account resolves to nothing. That matters here in
// particular: the account that PAYS is often a wrapper created and closed
// inside the transaction, which by construction appears in no balance
// metadata at all.

const TRANSFER_TYPES = new Set(["transfer", "transferChecked"]);

// The transfer this transaction records for a stated (mint, amount), if
// exactly one matches. More than one is ambiguous and resolves to nothing.
function corroborate(
  result: TransactionDetailResult,
  asset: StatedAsset,
  owners: Map<string, ResolvedOwner>,
  mintOf: Map<string, string>,
): ExchangeLeg | null {
  const matches: ExchangeLeg[] = [];
  for (const ix of result.tokenInstructions) {
    if (!TRANSFER_TYPES.has(ix.type)) continue;
    if (ix.account === null || ix.destination === null) continue;
    if (ix.amountRaw !== asset.amountRaw) continue;
    const mint = ix.mint ?? mintOf.get(ix.account) ?? mintOf.get(ix.destination) ?? null;
    if (mint !== asset.mint) continue;
    const fromOwner = owners.get(ix.account);
    const toOwner = owners.get(ix.destination);
    if (fromOwner === undefined || toOwner === undefined) continue;
    matches.push({
      mint: asset.mint,
      amountRaw: asset.amountRaw,
      fromAccount: ix.account,
      fromOwner: fromOwner.owner,
      toAccount: ix.destination,
      toOwner: toOwner.owner,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

// Derives the exchange this transaction executed, when every check holds.
//
// FAIL CLOSED AT EVERY STEP. No venue instruction, no event, the two in
// different invocations, an event that does not name the target mint, an
// amount no transfer corroborates, an ambiguous corroboration, or legs
// that do not run in opposite directions between the same two owners —
// each returns nothing. There is no partial answer and no fallback.
export function deriveDecodedExchange(
  result: TransactionDetailResult,
  targetMint: string,
): DecodedExchange | null {
  if (!result.succeeded) return null;
  const raws = result.rawInstructions;
  // Absent is not empty: an artifact stored before preservation existed
  // cannot be read this way, and must not be treated as carrying nothing.
  if (raws === undefined) return null;

  const venues = raws.map(decodeVenueSwap).filter((v): v is NonNullable<typeof v> => v !== null);
  const events = raws.map(decodeExchangeEvent).filter((e): e is NonNullable<typeof e> => e !== null);
  if (venues.length !== 1 || events.length !== 1) return null;
  const venue = venues[0];
  const event = events[0];
  // Both must belong to the SAME outer instruction. Two unrelated
  // invocations in one transaction are not one exchange.
  if (venue.parentIndex === null || venue.parentIndex !== event.parentIndex) return null;

  if (event.assets.length !== 2) return null;
  const [first, second] = event.assets;
  if (first.mint === second.mint) return null;
  if (first.mint !== targetMint && second.mint !== targetMint) return null;

  // The venue instruction's own amount must be one of the two the event
  // states. If the instruction and its event disagree, nothing is read.
  if (venue.amountRaw !== first.amountRaw && venue.amountRaw !== second.amountRaw) return null;

  const owners = resolveOwnership(result);
  const mintOf = new Map<string, string>();
  for (const b of [...result.preTokenBalances, ...result.postTokenBalances]) {
    if (b.account !== null) mintOf.set(b.account, b.mint);
  }

  const legA = corroborate(result, first, owners, mintOf);
  const legB = corroborate(result, second, owners, mintOf);
  if (legA === null || legB === null) return null;

  // Opposite directions between the same two owners, and neither side
  // paying itself.
  const participant = legA.fromOwner;
  const counterparty = legA.toOwner;
  if (participant === counterparty) return null;
  if (legB.fromOwner !== counterparty || legB.toOwner !== participant) return null;

  return {
    signature: result.signature,
    slot: result.slot,
    invocationIndex: venue.parentIndex,
    participant,
    counterparty,
    paid: legA,
    received: legB,
    basis: {
      venueProgramId: CONCENTRATED_LIQUIDITY_PROGRAM_ID,
      venueMethod: "swap_v2",
      venueAmountRaw: venue.amountRaw,
      eventProgramId: AGGREGATOR_PROGRAM_ID,
      eventDiscriminatorHex: event.discriminatorHex,
      statedAssets: event.assets,
    },
  };
}

// Exposed so a test can prove the constants are derived rather than pasted.
export const __derivation = {
  swapV2Discriminator: SWAP_V2.toString("hex"),
  eventCpiMarker: EVENT_CPI_MARKER.toString("hex"),
  discriminator,
  encodeBase58,
};
